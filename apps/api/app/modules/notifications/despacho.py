"""Quién vacía la cola de entregas, y cuándo.

EL HUECO QUE HABÍA (auditoría del 04/10/2026, pedido el 05/10). La cola
(`entregas.py`) guarda bien lo que hay que enviar, reintenta y no repite, pero
NO ENVIABA SOLA: lo hacía una ruta de administración que nadie llamaba. Los
avisos de Servicios, de la posventa de eventos y de los envíos de productos se
quedaban en la bandeja de la aplicación y nunca llegaban al teléfono con la
aplicación cerrada: «tienes una reserva nueva» lo veía quien abría Z por otro
motivo.

QUÉ SE HACE AHORA, por dos caminos que acaban en la misma pasada:

  * AL MOMENTO. La petición que deja una entrega en la cola lo anota en su
    sesión (`entregas.encolar`), y al terminar esa petición —ya confirmada la
    transacción— se programa una pasada (`tras_la_peticion`, que llama
    `shared.database.get_db`). El aviso sale segundos después del hecho.
  * Y EL PLANIFICADOR DE SERVICIOS, cada cinco minutos, programa otra
    (`services/procesos_router.py`): es quien recoge los REINTENTOS —la cola
    los espacia de un minuto a doce horas— y lo que hubiera quedado si el
    proceso se reinició entre guardar y enviar.

POR QUÉ ESTO NO ES EL TEMPORIZADOR QUE LA COLA DICE QUE NO PUEDE HABER. No hay
reloj dentro de la API: cada pasada la dispara un hecho, en la máquina que lo
atendió. Y que dos máquinas pasen a la vez no manda nada dos veces: cada
entrega se coge con un turno condicional (`entregas.tomar`) y quien llega
segundo la suelta.

TRES CUIDADOS:

  * UNA PASADA A LA VEZ POR PROCESO. Mientras habla con Expo, una pasada tiene
    cogida una conexión, y el pool son cinco más cinco (`shared/database.py`).
    Con una pasada por petición, diez reservas seguidas con Expo lento lo
    agotaban y se paraba la API entera —lo que ya pasó con los avisos directos
    (`push.py`)—. Si se pide otra mientras corre, corre UNA más al terminar.
  * NO HACE ESPERAR A NADIE NI LANZA. Se programa y se vuelve en el acto; lo
    que falle queda en el registro y en la cola, que lo reintenta.
  * APAGADO DE FÁBRICA. Solo despacha un proceso que está SIRVIENDO: lo
    enciende el arranque de la aplicación (`main.lifespan`). Importar estos
    módulos desde una prueba o desde un guion no lanza tareas por detrás.
"""

from __future__ import annotations

import asyncio
import logging

from app.modules.notifications.entregas import MARCA_DE_ENCOLADO
from app.shared import database

logger = logging.getLogger(__name__)

#: Cuántas entregas intenta una pasada. Si el lote sale lleno se da otra:
#: probablemente queda más.
LOTE = 50

_encendido = False
_en_curso = False
_otra_vez = False
#: Las tareas en vuelo. El bucle solo guarda una referencia débil: sin esto el
#: recolector puede llevarse una pasada a medias.
_tareas: set[asyncio.Task] = set()


def encender() -> None:
    """Este proceso sirve peticiones: a partir de ahora despacha."""
    global _encendido
    _encendido = True


def apagar() -> None:
    """Deja de programar pasadas. La que esté en vuelo termina o se cancela con
    el proceso; lo que tuviera cogido vuelve a la cola al vencer su turno."""
    global _encendido
    _encendido = False


def encendido() -> bool:
    return _encendido


async def _enviar(sesion, *, usuario_id: str, tipo: str, locale: str) -> bool:
    from app.modules.notifications import push

    # SE DEVUELVE LO QUE CONTESTA: `False` es «no había a dónde», y sin el
    # `return` todo se contaría como enviado (ver la ruta de administración).
    return await push.enviar_de_la_cola(sesion, usuario_id=usuario_id, tipo=tipo, locale=locale)


async def vaciar(limite: int = LOTE) -> dict[str, int] | None:
    """Una pasada por la cola, con sesión PROPIA. NUNCA LANZA.

    Devuelve las cuentas de `entregas.procesar`, o `None` si no hay cola (la
    migración 0066 sin aplicar) o no se pudo mirar.
    """
    from app.modules.notifications import entregas, esquema

    try:
        async with database.SessionLocal() as db:
            if not await esquema.hay_entregas(db):
                return None
            cuenta = await entregas.procesar(db, enviar=_enviar, limite=limite)
    except Exception:  # noqa: BLE001 - un aviso nunca tumba nada
        logger.warning("[avisos] no se pudo vaciar la cola de entregas", exc_info=True)
        return None
    if cuenta["intentadas"]:
        # Solo cuentas: ni a quién ni qué.
        logger.info(
            "[avisos] cola: intentadas=%s enviadas=%s sin_destino=%s reintentables=%s fallidas=%s",
            cuenta["intentadas"],
            cuenta["enviadas"],
            cuenta["sin_destino"],
            cuenta["reintentables"],
            cuenta["fallidas"],
        )
    return cuenta


async def _correr() -> None:
    global _en_curso, _otra_vez
    try:
        while True:
            _otra_vez = False
            cuenta = await vaciar()
            lleno = cuenta is not None and cuenta["intentadas"] >= LOTE
            if not (_otra_vez or lleno):
                return
    finally:
        _en_curso = False


def despachar() -> bool:
    """Programa una pasada y vuelve EN EL ACTO. Devuelve si la programó.

    Si ya hay una corriendo no lanza otra: le deja dicho que, al terminar, dé
    una vuelta más —lo que motivó esta llamada pudo guardarse después de que la
    pasada en curso mirase la cola—.
    """
    global _en_curso, _otra_vez
    if not _encendido:
        return False
    if _en_curso:
        _otra_vez = True
        return False
    try:
        bucle = asyncio.get_running_loop()
    except RuntimeError:
        # Sin bucle no hay dónde correr. Lo recogerá la siguiente pasada.
        return False
    _en_curso = True
    tarea = bucle.create_task(_correr())
    _tareas.add(tarea)
    tarea.add_done_callback(_tareas.discard)
    return True


def tras_la_peticion(sesion) -> None:
    """Al terminar una petición: si dejó entregas en la cola, se envían ahora.

    NUNCA LANZA: esto corre al cerrar la sesión de CUALQUIER petición, y un
    aviso no puede convertir en error una operación que ya terminó bien.
    """
    try:
        if sesion.info.pop(MARCA_DE_ENCOLADO, False):
            despachar()
    except Exception:  # noqa: BLE001
        logger.warning("[avisos] no se pudo programar el envío", exc_info=True)


__all__ = ["LOTE", "apagar", "despachar", "encender", "encendido", "tras_la_peticion", "vaciar"]
