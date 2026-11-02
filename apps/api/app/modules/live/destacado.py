"""Lo destacado de una emisión: el mensaje fijado y el rótulo de quien emite.

LO QUE SE PIDIÓ (07/10/2026): que quien emite pueda fijar un mensaje del chat y
poner un texto propio sobre la imagen, a la vista de toda la audiencia.

UNA FILA POR EMISIÓN, con lo vigente (`live_spotlights`, migración 0099). No es
un historial: fijar otro mensaje sustituye al anterior.

LAS REGLAS, y por qué:

  * LO DECIDE EL SERVIDOR. Solo quien gestiona la emisión —quien emite o la
    administración— fija, suelta, pone o quita. Lo comprueba el router; aquí
    se comprueba QUÉ se puede destacar.
  * SOLO EN DIRECTO. Destacar algo en una emisión que no ha empezado o que ya
    terminó no tiene a quién enseñárselo.
  * SE FIJA UN MENSAJE DE ESTA SALA, Y VISIBLE. Uno de otra emisión no existe
    aquí; uno escondido por moderación no se puede subir a lo más visible de la
    pantalla. Y al revés: esconder el mensaje fijado lo suelta.
  * QUITAR SIEMPRE SE PUEDE, también con la emisión terminada: es retirar algo
    de la vista, y eso no necesita condiciones.
  * EL RÓTULO ES UNA LÍNEA. Se guarda limpio —sin saltos ni espacios de más— y
    con un tope corto: va encima de un vídeo, en un teléfono.
  * NADA DE ESTO TOCA LA EMISIÓN. Si la tabla no existe todavía, el router
    contesta 503 a lo de destacar y lo demás sigue igual.

EL RÓTULO SE MUEVE Y SE VISTE (02/11/2026, migración 0114). Quien gestiona la
emisión lo arrastra, lo gira, le cambia el tamaño y elige su color, su fondo y
su letra. Lo que se guarda es la PRESENTACIÓN (`Presentacion`):

  * DÓNDE, en fracciones de la pantalla (el centro del texto). Nulo = el sitio
    de siempre, debajo de la cabecera. Cada teléfono encaja ese punto en su
    propia zona libre: el servidor no sabe cuánto miden las pantallas, y no
    tiene por qué.
  * CUÁNTO MIDE (70–240 %, de cinco en cinco) y CUÁNTO GIRA (-180–180°).
  * CÓMO SE VE, por nombre: un color de una paleta cerrada, uno de tres fondos
    y una de tres letras. Qué color es «oro» lo decide la aplicación.

SIN LA 0114 NO SE ROMPE NADA. Las columnas no están en el modelo de la tabla
(`LiveSpotlight`) a propósito: leerlo pediría columnas que la base puede no
tener todavía, y se caería todo lo destacado. Se leen y escriben aparte
(`_presentaciones`), solo si `esquema.hay_rotulo_editable` dice que están. Sin
ellas el texto se pone y se quita como siempre y se pinta como siempre.

LA FECHA DEL RÓTULO (`banner_at`) ES LA DE SU TEXTO. Cambia cuando cambian el
texto o su movimiento, que es cuando la sala lo ve ENTRAR otra vez. Moverlo o
cambiarle el color no lo vuelve a presentar: no la toca.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import asdict, dataclass
from datetime import datetime, timezone

from sqlalchemy import (
    Column,
    Float,
    MetaData,
    SmallInteger,
    Table,
    Text,
    Uuid,
    select,
    update,
)
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError
from app.modules.live.models import LiveMessage, LiveSession, LiveSpotlight

#: Cómo se mueve el rótulo. Coincide con el CHECK de `live_spotlights`.
#:   · `slide`  — entra deslizándose y se queda quieto.
#:   · `pulse`  — entra y late un par de veces, para un aviso.
#:   · `ticker` — corre de lado, para un texto que no cabe a lo ancho.
ESTILOS = ("slide", "pulse", "ticker")
ESTILO_POR_OMISION = "slide"

#: Tope del rótulo. Coincide con el CHECK de la base.
MAXIMO_DE_ROTULO = 80

_UNIDOR = "\u200d"

#: Los colores del rótulo. NOMBRES, no colores: qué tinta es cada uno lo
#: deciden los tokens de la aplicación. Una paleta cerrada y no una rueda: los
#: ocho se leen sobre vídeo y siguen la marca. Coincide con el CHECK de la 0114.
COLORES = ("blanco", "negro", "esmeralda", "oro", "rojo", "azul", "amarillo", "rosa")
#: Lo que lleva detrás: nada (con sombra), un velo o un relleno del color.
FONDOS = ("ninguno", "velo", "solido")
#: La letra: la de la aplicación, una condensada y una de máquina de escribir.
LETRAS = ("clasica", "fuerte", "maquina")

COLOR_POR_OMISION = "blanco"
FONDO_POR_OMISION = "velo"
LETRA_POR_OMISION = "clasica"

#: El tamaño, en tanto por ciento del de siempre. Coincide con el CHECK.
TAMANO_MINIMO = 70
TAMANO_MAXIMO = 240
PASO_DE_TAMANO = 5
TAMANO_POR_OMISION = 100

#: El giro, en grados enteros.
GIRO_MAXIMO = 180
GIRO_POR_OMISION = 0

#: Con cuántos decimales se devuelve dónde está. Una diezmilésima de una
#: pantalla de mil puntos es una décima de punto: más no se ve, y la base
#: (`real`) devolvería 0.30000001 donde se guardó 0.3.
DECIMALES_DE_POSICION = 4


@dataclass(frozen=True)
class Presentacion:
    """Dónde está el rótulo, cuánto mide, cuánto gira y cómo se ve.

    Los valores por omisión son los del rótulo de antes de la 0114: es lo que
    se ve sin la migración y en las filas que nunca se movieron.
    """

    x: float | None = None
    y: float | None = None
    scale: int = TAMANO_POR_OMISION
    rotation: int = GIRO_POR_OMISION
    color: str = COLOR_POR_OMISION
    background: str = FONDO_POR_OMISION
    font: str = LETRA_POR_OMISION


PRESENTACION_POR_OMISION = Presentacion()

#: Campo de la API -> columna de la 0114.
COLUMNA_DE = {
    "x": "banner_x",
    "y": "banner_y",
    "scale": "banner_scale",
    "rotation": "banner_rotation",
    "color": "banner_color",
    "background": "banner_background",
    "font": "banner_font",
}

# Las columnas de la 0114, declaradas aparte y en su propio `MetaData`: así
# `LiveSpotlight` no las pide nunca —sin la migración, leerlo fallaría— y
# `create_all` no intenta crear la tabla dos veces.
_presentaciones = Table(
    "live_spotlights",
    MetaData(),
    Column("session_id", Uuid(as_uuid=False), primary_key=True),
    Column("banner_x", Float),
    Column("banner_y", Float),
    Column("banner_scale", SmallInteger),
    Column("banner_rotation", SmallInteger),
    Column("banner_color", Text),
    Column("banner_background", Text),
    Column("banner_font", Text),
)


def _fraccion(valor: object) -> float | None:
    if valor is None:
        return None
    return round(float(valor), DECIMALES_DE_POSICION)


def _de_la_lista(valor: object, permitidos: tuple[str, ...], omision: str) -> str:
    # La base no deja guardar otro, pero si un día se ampliara la lista allí
    # antes que aquí, lo desconocido se pinta como lo de siempre en vez de
    # devolver algo que esta versión no sabe pintar.
    return valor if isinstance(valor, str) and valor in permitidos else omision


async def leer_presentacion(db: AsyncSession, session_id: str) -> Presentacion:
    """La presentación guardada. Llamar solo con la 0114 aplicada."""
    fila = (
        await db.execute(
            select(_presentaciones).where(_presentaciones.c.session_id == session_id)
        )
    ).mappings().first()
    if fila is None:
        return PRESENTACION_POR_OMISION
    x, y = _fraccion(fila["banner_x"]), _fraccion(fila["banner_y"])
    if x is None or y is None:
        x = y = None
    return Presentacion(
        x=x,
        y=y,
        scale=int(fila["banner_scale"] if fila["banner_scale"] is not None else TAMANO_POR_OMISION),
        rotation=int(fila["banner_rotation"] if fila["banner_rotation"] is not None else GIRO_POR_OMISION),
        color=_de_la_lista(fila["banner_color"], COLORES, COLOR_POR_OMISION),
        background=_de_la_lista(fila["banner_background"], FONDOS, FONDO_POR_OMISION),
        font=_de_la_lista(fila["banner_font"], LETRAS, LETRA_POR_OMISION),
    )


async def _guardar_presentacion(
    db: AsyncSession, session_id: str, cambios: dict[str, object]
) -> None:
    """Escribe en las columnas de la 0114 lo que venga en `cambios`.

    La fila tiene que existir ya en la base: por eso se vacía antes lo que el
    ORM tenga pendiente (la fila recién creada de un primer rótulo).
    """
    if not cambios:
        return
    await db.flush()
    await db.execute(
        update(_presentaciones)
        .where(_presentaciones.c.session_id == session_id)
        .values({COLUMNA_DE[campo]: valor for campo, valor in cambios.items()})
    )


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


def limpiar_rotulo(texto: str) -> str:
    """El rótulo tal y como se guarda: una sola línea, sin relleno.

    Se quitan los caracteres de control y de formato invisible —un salto de
    línea parte el rótulo en dos; un «cero de ancho» o una marca de dirección
    lo dejan aparentemente vacío o lo dan la vuelta— y los espacios seguidos se
    quedan en uno. Lo que resulte puede ser la cadena vacía: quien llama decide
    que eso no vale.
    """
    visible = "".join(
        " " if unicodedata.category(c) in ("Zl", "Zp", "Zs", "Cc") else c
        for c in texto
        # El «unidor de ancho cero» se conserva: es lo que mantiene juntos los
        # emojis compuestos (una familia, una bandera arcoíris). Quitarlo los
        # rompería en sus piezas.
        if unicodedata.category(c) != "Cf" or c == _UNIDOR
    )
    return re.sub(r" +", " ", visible).strip()


def dice_algo(texto: str) -> bool:
    """Si hay al menos un carácter que se VE: letra, número, signo o símbolo.

    Un rótulo hecho solo de unidores y marcas combinantes mide más de cero y no
    pinta nada: ocuparía el sitio del rótulo con una franja vacía.
    """
    return any(unicodedata.category(c)[0] in ("L", "N", "P", "S") for c in texto)


async def fila(db: AsyncSession, session_id: str) -> LiveSpotlight | None:
    return await db.get(LiveSpotlight, session_id)


async def _fila_para_escribir(db: AsyncSession, sesion: LiveSession) -> LiveSpotlight:
    """La fila de esta emisión, creándola si es la primera vez.

    Se bloquea la EMISIÓN mientras se mira: dos peticiones a la vez —quien
    emite y una administradora— crearían cada una su fila y la segunda chocaría
    con la clave primaria. Es el mismo cerrojo que usa `escenario.invitar`.
    """
    await db.scalar(
        select(LiveSession.id).where(LiveSession.id == sesion.id).with_for_update()
    )
    destacado = await db.get(LiveSpotlight, sesion.id)
    if destacado is None:
        destacado = LiveSpotlight(session_id=sesion.id)
        db.add(destacado)
    return destacado


def _exigir_en_directo(sesion: LiveSession) -> None:
    if sesion.status != "live":
        raise ConflictError(
            "Solo se puede destacar algo mientras la transmisión está en vivo.",
            code="live_spotlight_closed",
        )


async def fijar(
    db: AsyncSession, *, sesion: LiveSession, por: str, message_id: str
) -> LiveSpotlight:
    """Fija un mensaje. Sustituye al que hubiera."""
    _exigir_en_directo(sesion)

    mensaje = await db.get(LiveMessage, message_id)
    # De otra sala es «no encontrado», no «prohibido»: desde esta emisión ese
    # mensaje no existe, y decir otra cosa confirmaría que el identificador es
    # de un mensaje real de otra parte.
    if mensaje is None or mensaje.session_id != sesion.id:
        raise NotFoundError("Mensaje no encontrado.")
    if mensaje.hidden_at is not None:
        raise ConflictError(
            "Ese mensaje está oculto y no se puede fijar.",
            code="live_message_hidden",
        )

    destacado = await _fila_para_escribir(db, sesion)
    destacado.pinned_message_id = mensaje.id
    destacado.pinned_by = por
    destacado.pinned_at = _ahora()
    destacado.updated_at = _ahora()
    return destacado


async def soltar(db: AsyncSession, *, sesion: LiveSession) -> bool:
    """Quita el mensaje fijado. Devuelve si había alguno."""
    destacado = await db.get(LiveSpotlight, sesion.id)
    if destacado is None or destacado.pinned_message_id is None:
        return False
    destacado.pinned_message_id = None
    destacado.pinned_by = None
    destacado.pinned_at = None
    destacado.updated_at = _ahora()
    return True


async def poner_rotulo(
    db: AsyncSession,
    *,
    sesion: LiveSession,
    por: str,
    texto: str,
    estilo: str,
    presentacion: dict[str, object] | None = None,
) -> LiveSpotlight:
    """Pone o cambia el rótulo. `texto` llega ya limpio y validado.

    `presentacion` son los campos de la 0114 que mandó quien escribe, ya
    validados; los que no vienen se quedan como estaban (o como por omisión si
    es un rótulo nuevo). Pasarlo solo con la 0114 aplicada: sin ella, quien
    llama lo deja en `None` y el texto se pone como siempre.
    """
    _exigir_en_directo(sesion)
    estilo = estilo if estilo in ESTILOS else ESTILO_POR_OMISION
    destacado = await _fila_para_escribir(db, sesion)
    # Un texto NUEVO —u otro movimiento— vuelve a entrar en la sala, y la sala
    # lo sabe por la fecha. El mismo texto con otro color no entra otra vez.
    es_otro = (
        destacado.banner_text is None
        or destacado.banner_text != texto
        or destacado.banner_style != estilo
    )
    destacado.banner_text = texto
    destacado.banner_style = estilo
    destacado.banner_by = por
    if es_otro or destacado.banner_at is None:
        destacado.banner_at = _ahora()
    destacado.updated_at = _ahora()
    if presentacion:
        await _guardar_presentacion(db, sesion.id, presentacion)
    return destacado


async def mover_rotulo(
    db: AsyncSession,
    *,
    sesion: LiveSession,
    x: float,
    y: float,
    scale: int,
    rotation: int,
) -> LiveSpotlight:
    """Lo que se manda al SOLTAR el texto: dónde queda, cuánto mide y cuánto gira.

    Solo con la 0114 aplicada (lo comprueba el router). No toca el texto ni su
    fecha: moverlo no lo vuelve a presentar.
    """
    _exigir_en_directo(sesion)
    # El mismo cerrojo que al poner: que quitarlo a la vez no deje una posición
    # guardada en un rótulo que ya no está.
    await db.scalar(
        select(LiveSession.id).where(LiveSession.id == sesion.id).with_for_update()
    )
    destacado = await db.get(LiveSpotlight, sesion.id)
    if destacado is None or destacado.banner_text is None:
        raise ConflictError(
            "No hay ningún texto en pantalla que mover.",
            code="live_spotlight_no_banner",
        )
    destacado.updated_at = _ahora()
    await _guardar_presentacion(
        db,
        sesion.id,
        {
            "x": round(x, DECIMALES_DE_POSICION),
            "y": round(y, DECIMALES_DE_POSICION),
            "scale": scale,
            "rotation": rotation,
        },
    )
    return destacado


async def quitar_rotulo(
    db: AsyncSession, *, sesion: LiveSession, con_presentacion: bool = False
) -> bool:
    """Quita el rótulo. Devuelve si había alguno.

    Con la 0114 (`con_presentacion`) también vuelve su presentación a la de por
    omisión: el próximo texto empieza donde empezaron siempre, no donde se dejó
    el anterior. «Deshacer» manda la presentación entera, así que no la pierde.
    """
    destacado = await db.get(LiveSpotlight, sesion.id)
    if destacado is None or destacado.banner_text is None:
        return False
    destacado.banner_text = None
    destacado.banner_by = None
    destacado.banner_at = None
    destacado.updated_at = _ahora()
    if con_presentacion:
        await _guardar_presentacion(db, sesion.id, asdict(PRESENTACION_POR_OMISION))
    return True


async def al_esconder(db: AsyncSession, message_id: str) -> bool:
    """Un mensaje que se esconde deja de estar fijado. Devuelve si lo estaba.

    Va en la misma transacción que el esconder: si no, durante un instante el
    mensaje estaría «oculto por moderación» y a la vez en lo más alto de la
    pantalla de todo el mundo.
    """
    resultado = await db.execute(
        update(LiveSpotlight)
        .where(LiveSpotlight.pinned_message_id == message_id)
        .values(
            pinned_message_id=None,
            pinned_by=None,
            pinned_at=None,
            updated_at=_ahora(),
        )
    )
    return bool(resultado.rowcount)
