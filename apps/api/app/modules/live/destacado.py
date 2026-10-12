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
"""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime, timezone

from sqlalchemy import select, update
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
    db: AsyncSession, *, sesion: LiveSession, por: str, texto: str, estilo: str
) -> LiveSpotlight:
    """Pone o cambia el rótulo. `texto` llega ya limpio y validado."""
    _exigir_en_directo(sesion)
    destacado = await _fila_para_escribir(db, sesion)
    destacado.banner_text = texto
    destacado.banner_style = estilo if estilo in ESTILOS else ESTILO_POR_OMISION
    destacado.banner_by = por
    destacado.banner_at = _ahora()
    destacado.updated_at = _ahora()
    return destacado


async def quitar_rotulo(db: AsyncSession, *, sesion: LiveSession) -> bool:
    """Quita el rótulo. Devuelve si había alguno."""
    destacado = await db.get(LiveSpotlight, sesion.id)
    if destacado is None or destacado.banner_text is None:
        return False
    destacado.banner_text = None
    destacado.banner_by = None
    destacado.banner_at = None
    destacado.updated_at = _ahora()
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
