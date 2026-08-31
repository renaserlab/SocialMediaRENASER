"""Recortar el video de una historia EN EL SERVIDOR, con el ffmpeg que ya hay.

===========================================================================
EL COMPROMISO, ESCRITO DONDE SE DECIDE: EL VIDEO SE SUBE ENTERO Y LUEGO SE
RECORTA.
===========================================================================

No es lo que hace WhatsApp. WhatsApp corta en el telefono y sube solo el tramo,
asi que un video de cinco minutos viaja como treinta segundos. Aqui viaja
entero: si alguien elige un tramo de 30 s de un video de 5 minutos, se suben los
5 minutos y despues el servidor se queda con los 30 s.

POR QUE, y no es pereza. En el telefono NO SE PUEDE cortar con lo que hay
instalado:

  - `react-native-compressor` 1.19.4 es el unico modulo nativo de media del
    proyecto y solo sabe RECOMPRIMIR el archivo entero: su contrato nativo no
    tiene `startTime`, ni `endTime`, ni `trim`.
  - No hay `expo-av`, ni `expo-video-thumbnails`, ni `ffmpeg-kit`.

Cortar en el dispositivo exige una dependencia nativa nueva, y con ella una
compilacion nueva (en Expo Go no cargaria). En el SERVIDOR, en cambio, ffmpeg
esta desde el 27/08/2026 (ver `apps/api/Dockerfile`) y este modulo lo unico que
hace es reutilizar la maquinaria de `content/media_processing.py`.

LO QUE CUESTA EL COMPROMISO, dicho claro para que nadie se lo encuentre de
sorpresa: los datos moviles de quien publica. Se sube todo el video aunque solo
se vaya a ver un tramo. Lo que lo hace soportable es que el movil YA comprime
antes de subir (~2.5 Mbps), asi que lo que viaja no es el original de camara.
El dia que haya un modulo nativo de recorte, se corta antes de subir y este
modulo se queda como respaldo para la web.

===========================================================================
EL ORDEN: SUBIR -> RECORTAR -> PUBLICAR
===========================================================================

Una historia con un video mas largo que el tope NO puede quedar publicada sin
recortar, ni un instante. Habia dos formas de conseguirlo:

  (a) publicar la fila enseguida en un estado «todavia no se muestra» y
      cambiarla cuando el derivado exista; o
  (b) no crear la fila hasta que el derivado exista.

Se elige (b), y por dos motivos concretos de ESTE repositorio:

  1. Las historias se LEEN directamente contra PostgREST desde el movil
     (`StoryRepository.list`), no por esta API. Un estado «oculto» dependeria de
     que cada lector se acuerde de filtrarlo —y de que la RLS lo filtre tambien—.
     El lector que se olvide enseña el video largo. Con (b) no hay nada que
     filtrar: la fila no existe hasta que el tramo existe.
  2. (a) pide una columna nueva en `stories`, y `select(Entidad)` de SQLAlchemy
     pide TODAS las columnas mapeadas: el modelo adelantandose a la migracion
     rompe produccion. (b) no necesita ninguna migracion.

El precio de (b) es que publicar tarda lo que tarde el recorte. Se acota con el
semaforo y con las esperas de aqui abajo.

===========================================================================
EL ORIGINAL NUNCA SE TOCA
===========================================================================

Es el principio que ya esta escrito en la cabecera de `media_processing.py` y
aqui vale igual: el recorte es un DERIVADO NUEVO en una ruta nueva dentro de la
carpeta de su dueño. El archivo original se queda donde estaba, byte por byte.
Lo que apunta a un sitio u otro es `stories.storage_path`, y volver atras es
cambiar esa referencia.

El original queda sin referenciar, y es a proposito: es el material del que
salio el tramo. Se borra con la cuenta, como todo lo demas
(`shared/storage.delete_user_files` barre por prefijo de usuario, y el derivado
vive bajo el mismo prefijo justamente para que tambien caiga).

===========================================================================
SI FFMPEG FALLA
===========================================================================

No se publica nada. Ni el original largo «como si estuviera recortado», ni una
historia a medias. El video subido se queda huerfano en el bucket —igual que
cuando alguien cancela una subida— y quien publicaba recibe un error que dice
que no se ha publicado. Es la unica degradacion honesta: la alternativa seria
enseñar cinco minutos donde se prometieron treinta segundos.
"""

from __future__ import annotations

import asyncio
import logging
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator, NamedTuple
from uuid import uuid4

import httpx

from app.core.exceptions import ServiceUnavailableError, ValidationAppError
from app.modules.content import media_processing as mp
from app.modules.stories.schemas import MAX_DURATION_MS, MIN_DURATION_MS

logger = logging.getLogger("renaser.stories")


class Tramo(NamedTuple):
    """El trozo que se queda, en milisegundos desde el principio del video."""

    inicio_ms: int
    fin_ms: int

    @property
    def duracion_ms(self) -> int:
        return self.fin_ms - self.inicio_ms


#: Margen al comparar duraciones medidas. La duracion que declara un contenedor
#: MP4 se redondea al centesimo, y un `-t 30` puede quedar en 30.02 s: rechazar
#: eso seria rechazar un recorte correcto por un error de medida.
TOLERANCIA_MS = 300

#: Cuanto se espera a que quede libre el semaforo de codificacion.
#:
#: El semaforo lo comparte con `process_media`, que puede estar generando una
#: escalera HLS de media hora. Esperar a eso dentro de una peticion HTTP seria
#: dejar a alguien mirando una pantalla de «publicando» hasta que se rinda el
#: telefono. Pasado este tiempo se responde «ahora no» y NO se publica nada, que
#: es peor que publicar rapido y mucho mejor que publicar sin recortar.
ESPERA_DE_TURNO_S = 25.0

#: Cuanto puede tardar el recorte en si. La salida son 30 s como mucho, asi que
#: dos minutos y medio son holgadisimos incluso en la t3.small con la CPU
#: ocupada; lo que corta de verdad es un archivo corrupto que dejaria ffmpeg
#: colgado para siempre.
#:
#: EL PRESUPUESTO ENTERO —turno mas recorte, 175 s— CABE DENTRO DE LO QUE ESPERA
#: EL MOVIL (180 s en `StoryRepository.create`), y eso no es casualidad. Si el
#: servidor pudiera tardar mas que el cliente, habria un hueco en el que la
#: persona ve un error y la historia aparece igual un minuto despues. Quien
#: mueva uno de los dos numeros tiene que mirar el otro.
ESPERA_DE_RECORTE_S = 150.0


# --------------------------------------------------------------------------- #
# 1. La decision, sin tocar disco ni red (por eso se puede probar sola)
# --------------------------------------------------------------------------- #
def revisar_tramo(inicio_ms: int, fin_ms: int, duracion_real_ms: int) -> Tramo:
    """El tramo pedido contra el archivo REAL. Devuelve el tramo ya saneado.

    `duracion_real_ms` es lo que ha medido ffprobe sobre el archivo subido, no
    lo que dice el cliente. Esa es la diferencia entre un limite y un ruego.

    El final se ajusta al final del archivo cuando se pasa por poco: el movil
    calcula el tramo con la duracion que le informa el reproductor, y esa cifra
    y la del contenedor se separan en unas centesimas. Rechazar por eso seria
    rechazar el tramo «hasta el final», que es justo el que mas se elige.
    """
    if inicio_ms < 0:
        raise ValidationAppError("El tramo no puede empezar antes del vídeo.")
    if inicio_ms >= duracion_real_ms:
        raise ValidationAppError(
            "El tramo empieza después de que el vídeo termine."
        )
    fin = min(fin_ms, duracion_real_ms)
    duracion = fin - inicio_ms
    if duracion < MIN_DURATION_MS:
        raise ValidationAppError(
            f"Un tramo tiene que durar al menos {MIN_DURATION_MS // 1000} segundo."
        )
    if duracion > MAX_DURATION_MS + TOLERANCIA_MS:
        raise ValidationAppError(
            f"El tramo dura {duracion / 1000:.1f} s y el máximo son "
            f"{MAX_DURATION_MS // 1000}."
        )
    return Tramo(inicio_ms, min(fin, inicio_ms + MAX_DURATION_MS))


def necesita_recorte(duracion_real_ms: int) -> bool:
    """Si este video NO se puede publicar tal cual."""
    return duracion_real_ms > MAX_DURATION_MS + TOLERANCIA_MS


# --------------------------------------------------------------------------- #
# 2. Medir el archivo subido
# --------------------------------------------------------------------------- #
async def duracion_del_original_ms(storage_path: str) -> int | None:
    """Lo que dura DE VERDAD el archivo recien subido, o None si no se sabe.

    `None` no es «dura cero»: es «este servidor no ha podido medirlo». Ocurre
    cuando no hay credenciales de Storage (desarrollo local, y toda la suite de
    pruebas) o cuando no hay ffprobe en el sistema. Quien llama decide que hacer
    con esa ignorancia; aqui no se inventa un numero.

    Se lee por rangos sobre una URL firmada, sin bajar el archivo: es lo mismo
    que hace `_extraer_poster` y por eso cuesta unos cientos de KB y no 100 MB.
    """
    if not mp.processing_configured() or not mp._ffprobe():
        return None
    try:
        async with httpx.AsyncClient(timeout=mp._TIMEOUT) as client:
            url = await mp._signed_url(client, storage_path)
        _ancho, _alto, duracion_s = await mp._probe_video(url)
    except Exception:  # noqa: BLE001 — medir es un intento, no un requisito
        logger.warning("No se pudo medir %s antes de recortar", storage_path, exc_info=True)
        return None
    if duracion_s is None or duracion_s <= 0:
        return None
    return int(round(duracion_s * 1000))


# --------------------------------------------------------------------------- #
# 3. El recorte
# --------------------------------------------------------------------------- #
@asynccontextmanager
async def _turno_acotado() -> AsyncIterator[None]:
    """El semaforo de video, pero sin esperar para siempre."""
    semaforo = mp._turno_de_video()
    try:
        await asyncio.wait_for(semaforo.acquire(), timeout=ESPERA_DE_TURNO_S)
    except asyncio.TimeoutError:
        raise ServiceUnavailableError(
            "El servidor está ocupado preparando otros vídeos. "
            "No hemos publicado nada: inténtalo en un momento."
        ) from None
    try:
        yield
    finally:
        semaforo.release()


async def _cortar(ffmpeg: str, entrada: str, tramo: Tramo, destino: Path) -> bool:
    """ffmpeg -ss ... -t ... con recodificacion. True si salio.

    RECODIFICA, no copia los paquetes. Con `-c copy` el corte salta al keyframe
    anterior y el principio se desplaza segundos enteros: el tramo elegido
    dejaria de ser el tramo publicado. Como la SALIDA son 30 s como mucho, el
    coste esta acotado por definicion, que es lo que hace que se pueda pagar
    dentro de una peticion.

    `-ss` va ANTES de `-i` a proposito: asi ffmpeg salta por rangos HTTP hasta
    el keyframe anterior al corte en vez de decodificar el video entero desde el
    principio, y aun asi el corte es exacto porque al recodificar descarta los
    fotogramas sobrantes.

    LA ROTACION NO SE TOCA, y esto es lo que se rompio hace poco y ya esta
    arreglado en `media_processing`: un movil graba en vertical guardando un
    cuadro apaisado mas una nota de giro. Al RECODIFICAR, ffmpeg aplica esa nota
    (`-autorotate`, activo por omision) y escribe los pixeles ya derechos, que
    es exactamente lo que hace `_transcodificar_mp4`. Por eso aqui no hay ningun
    `-vf transpose` ni ningun `-noautorotate`: añadir cualquiera de los dos es
    como volverian las franjas negras.

    Tampoco se reescala. Recortar es quedarse con un trozo, no cambiar de
    tamaño; lo que ya venia comprimido del telefono sigue viniendo comprimido.
    """
    codigo, _, stderr = await mp._run(
        [
            ffmpeg, "-v", "error", "-y",
            "-ss", f"{tramo.inicio_ms / 1000:.3f}",
            "-i", entrada,
            "-t", f"{tramo.duracion_ms / 1000:.3f}",
            "-c:v", "libx264", "-preset", mp.PRESET_X264, "-profile:v", "main",
            "-crf", "23", "-maxrate", "2600k", "-bufsize", "4800k",
            "-c:a", "aac", "-b:a", "128k",
            # El indice al principio: el visor arranca sin ir a buscarlo al
            # final del archivo.
            "-movflags", "+faststart",
            str(destino),
        ],
        timeout=ESPERA_DE_RECORTE_S,
    )
    if codigo != 0 or not destino.exists() or destino.stat().st_size == 0:
        logger.warning("El recorte de historia fallo: %s", stderr[-300:])
        return False
    return True


async def recortar(storage_path: str, tramo: Tramo, propietario: str) -> str:
    """Deja el tramo en una ruta NUEVA y la devuelve. El original no se toca.

    Si algo falla se levanta `ServiceUnavailableError` y quien llama NO publica.
    """
    ffmpeg = mp._ffmpeg()
    if not mp.processing_configured() or not ffmpeg:
        raise ServiceUnavailableError(
            "Este servidor no puede recortar vídeos ahora mismo. "
            "No hemos publicado nada."
        )

    try:
        destino_remoto = await _recortar_de_verdad(ffmpeg, storage_path, tramo, propietario)
    except ServiceUnavailableError:
        raise
    except Exception as fallo:  # noqa: BLE001
        # CUALQUIER otro fallo —Storage caido, la firma caducada, el disco
        # lleno— sale por aqui convertido en un error de la aplicacion.
        #
        # Dejarlo escapar seria un 500 SIN CABECERAS CORS: Starlette no las pone
        # en una respuesta que sale de una excepcion sin capturar, y entonces el
        # navegador lo cuenta como un fallo de red. Un fallo de ffmpeg
        # disfrazado de problema de conexion es exactamente el rato perdido que
        # ya se pago una vez en este repositorio.
        logger.exception("Fallo recortando %s", storage_path)
        raise ServiceUnavailableError(
            "No pudimos recortar el vídeo. No hemos publicado nada: "
            "vuelve a intentarlo."
        ) from fallo

    logger.info(
        "Historia recortada: %s [%d-%d ms] -> %s",
        storage_path,
        tramo.inicio_ms,
        tramo.fin_ms,
        destino_remoto,
    )
    return destino_remoto


async def _recortar_de_verdad(
    ffmpeg: str, storage_path: str, tramo: Tramo, propietario: str
) -> str:
    async with httpx.AsyncClient(timeout=mp._TIMEOUT) as client:
        url = await mp._signed_url(
            client, storage_path, expires=int(ESPERA_DE_RECORTE_S) + 600
        )
        async with _turno_acotado():
            with tempfile.TemporaryDirectory() as tmp:
                destino = Path(tmp) / "recorte.mp4"
                try:
                    salio = await _cortar(ffmpeg, url, tramo, destino)
                except asyncio.TimeoutError:
                    salio = False
                if not salio:
                    raise ServiceUnavailableError(
                        "No pudimos recortar el vídeo. No hemos publicado nada: "
                        "vuelve a intentarlo."
                    )

                # SE COMPRUEBA LO QUE HA SALIDO, no lo que se pidio. `-t` deberia
                # bastar, pero «deberia» no es una garantia: si por lo que sea el
                # archivo producido dura mas del tope, no se publica. Es la
                # ultima linea antes de que un video largo se cuele como corto.
                _a, _b, duro_s = await mp._probe_video(str(destino))
                if duro_s is not None and duro_s * 1000 > MAX_DURATION_MS + TOLERANCIA_MS:
                    logger.error(
                        "El recorte de %s salio de %.2f s: no se publica.",
                        storage_path,
                        duro_s,
                    )
                    raise ServiceUnavailableError(
                        "El recorte no salió como debía. No hemos publicado nada."
                    )

                # Bajo el prefijo del dueño, como los derivados de
                # `media_processing`: es lo que hace que el borrado de cuenta
                # (que barre por prefijo) tambien se lo lleve.
                destino_remoto = f"{propietario}/derived/historias/{uuid4().hex}.mp4"
                await mp._upload(
                    client, destino_remoto, destino.read_bytes(), "video/mp4"
                )
    return destino_remoto


# --------------------------------------------------------------------------- #
# 4. Lo que usa el endpoint
# --------------------------------------------------------------------------- #
async def preparar_video(
    storage_path: str,
    duracion_declarada_ms: int,
    tramo_pedido: Tramo | None,
    propietario: str,
) -> tuple[str, int]:
    """Que ruta y que duracion se guardan de verdad en la historia.

    Devuelve `(storage_path, duration_ms)`. Levanta si no hay forma honesta de
    publicar, y entonces no se escribe NADA en la base: el orden es
    subir -> recortar -> publicar, y esta funcion es el «recortar».
    """
    real_ms = await duracion_del_original_ms(storage_path)

    if real_ms is None:
        # No se ha podido medir. No se inventa: si se pedia un recorte, no se
        # publica; si no se pedia, se hace lo mismo que se hacia hasta hoy
        # (el tope de Pydantic sobre el numero que declara el cliente, mas el
        # CHECK de la base). Decirlo aqui es mejor que fingir una verificacion
        # que este servidor no puede hacer.
        if tramo_pedido is not None:
            raise ServiceUnavailableError(
                "Este servidor no puede recortar vídeos ahora mismo. "
                "No hemos publicado nada."
            )
        return storage_path, duracion_declarada_ms

    if tramo_pedido is None:
        if necesita_recorte(real_ms):
            # AQUI ESTA LA GARANTIA. El cliente puede decir lo que quiera en
            # `duration_ms`; el archivo dura lo que dura, y si pasa del tope sin
            # elegir tramo, no hay historia.
            raise ValidationAppError(
                f"Este vídeo dura {real_ms / 1000:.1f} s y las historias admiten "
                f"hasta {MAX_DURATION_MS // 1000}. Elige el tramo que quieres "
                "publicar."
            )
        # La duracion la manda la medida del servidor, no la del cliente: es la
        # unica de las dos que ha visto el archivo.
        return storage_path, max(MIN_DURATION_MS, min(real_ms, MAX_DURATION_MS))

    tramo = revisar_tramo(tramo_pedido.inicio_ms, tramo_pedido.fin_ms, real_ms)
    ruta = await recortar(storage_path, tramo, propietario)
    return ruta, max(MIN_DURATION_MS, tramo.duracion_ms)
