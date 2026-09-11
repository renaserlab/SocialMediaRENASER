"""La cola de entregas: un aviso que falla no se pierde.

ANTES DE ESTO, un envío que fallaba se registraba en el log y desaparecía.
Servía mientras los avisos eran «a alguien le gustó tu foto»; no sirve cuando el
aviso dice que se confirmó una devolución.

QUÉ GARANTIZA Y QUÉ NO:

  * una entrega por suceso de negocio, y lo impone un índice único;
  * reintentos con tope y con espera creciente;
  * el último error, saneado y acotado;
  * `sent` solo después de que el envío termine bien;
  * un fallo aquí NO deshace lo que provocó el aviso.

Lo que NO hace: enviar por su cuenta. Quien vacía la cola es un endpoint
administrativo idempotente que invoca un planificador EXTERNO. Dentro de la API
no hay temporizador, porque hay varias réplicas y cada una dispararía el suyo.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.notifications import textos
from app.modules.notifications.models import NotificationDelivery

PENDIENTE = "pending"
ENVIADA = "sent"
FALLIDA = "failed"

#: Cuánto se espera antes de cada reintento. La lista ES el tope: cuando se
#: acaba, la entrega queda `failed` y nadie la vuelve a tocar sola.
#:
#: Crece a propósito. Reintentar cada segundo contra un servicio caído es
#: insistir, no reintentar.
ESPERAS = (timedelta(minutes=1), timedelta(minutes=5), timedelta(minutes=30),
           timedelta(hours=2), timedelta(hours=12))

#: Cuánto del error se guarda. Lo justo para investigar; no el cuerpo de la
#: respuesta, que puede traer cualquier cosa.
LARGO_DEL_ERROR = 500


def ahora() -> datetime:
    return datetime.now(timezone.utc)


def _saneado(error: str | None) -> str | None:
    """El error sin saltos y acotado. Nunca un token ni un cuerpo entero."""
    if not error:
        return None
    return " ".join(str(error).split())[:LARGO_DEL_ERROR] or None


async def encolar(
    db: AsyncSession,
    *,
    usuario_id: str,
    tipo: str,
    locale: str | None = None,
    notificacion_id: str | None = None,
    correlacion: str | None = None,
    entidad_id: str | None = None,
    momento: datetime | None = None,
) -> NotificationDelivery | None:
    """Deja una entrega pendiente. Devuelve `None` si ese suceso ya estaba.

    NO ENVÍA. Y no hace `commit`: la entrega vive o muere con el hecho que la
    provocó, que es justo lo que impide anunciar algo que no llegó a pasar.
    """
    momento = momento or ahora()
    clave = textos.clave_de_suceso(tipo, entidad_id=entidad_id, usuario_id=usuario_id)

    fila = NotificationDelivery(
        notification_id=notificacion_id,
        user_id=usuario_id,
        type=tipo,
        locale=textos.idioma_valido(locale),
        status=PENDIENTE,
        attempts=0,
        max_attempts=len(ESPERAS),
        next_attempt_at=momento,
        correlation_id=(correlacion or None),
        dedupe_key=clave,
        created_at=momento,
        updated_at=momento,
    )
    try:
        # EN SU PROPIO SAVEPOINT. Esto se llama desde dentro de operaciones que
        # ya están en curso —un webhook, una transición— y un choque de clave
        # no puede deshacerles nada.
        async with db.begin_nested():
            db.add(fila)
            await db.flush()
    except IntegrityError:
        if fila in db:
            db.expunge(fila)
        return None
    return fila


async def pendientes(
    db: AsyncSession, *, limite: int = 50, momento: datetime | None = None
) -> list[NotificationDelivery]:
    """Las que toca intentar ahora. Acotado y con orden estable."""
    momento = momento or ahora()
    return list(
        await db.scalars(
            select(NotificationDelivery)
            .where(
                NotificationDelivery.status == PENDIENTE,
                NotificationDelivery.next_attempt_at <= momento,
            )
            .order_by(
                NotificationDelivery.next_attempt_at, NotificationDelivery.id
            )
            .limit(max(1, min(int(limite), 500)))
        )
    )


async def tomar(
    db: AsyncSession, *, entrega_id: str, momento: datetime | None = None
) -> bool:
    """Reserva una entrega para intentarla. UPDATE CONDICIONAL.

    Dos procesos vaciando la cola a la vez: uno cambia una fila y el otro cero.
    Sin esto, el mismo aviso se enviaría dos veces.
    """
    momento = momento or ahora()
    hechas = await db.execute(
        update(NotificationDelivery)
        .where(
            NotificationDelivery.id == entrega_id,
            NotificationDelivery.status == PENDIENTE,
            NotificationDelivery.next_attempt_at <= momento,
        )
        .values(
            attempts=NotificationDelivery.attempts + 1,
            # Se aparta lo bastante para que otro proceso no la coja mientras
            # esta la intenta. Si el envío sale bien se marca `sent` enseguida.
            next_attempt_at=momento + ESPERAS[0],
            updated_at=momento,
        )
    )
    return (hechas.rowcount or 0) == 1


async def marcar_enviada(
    db: AsyncSession, *, entrega_id: str, momento: datetime | None = None
) -> None:
    """Enviada, y solo DESPUÉS de que el envío haya terminado bien."""
    momento = momento or ahora()
    await db.execute(
        update(NotificationDelivery)
        .where(NotificationDelivery.id == entrega_id)
        .values(status=ENVIADA, sent_at=momento, last_error=None, updated_at=momento)
    )


async def marcar_fallo(
    db: AsyncSession,
    *,
    entrega_id: str,
    error: str | None,
    momento: datetime | None = None,
) -> str:
    """Anota el fallo y decide si queda otro intento.

    Devuelve el estado en el que queda. Cuando se acaban los intentos pasa a
    `failed` y ahí se queda: seguir reintentando para siempre no arregla un
    token que ya no existe, y esconde el problema en vez de enseñarlo.
    """
    momento = momento or ahora()
    fila = await db.get(NotificationDelivery, entrega_id)
    if fila is None:
        return FALLIDA

    intentos = int(fila.attempts or 0)
    if intentos >= int(fila.max_attempts or len(ESPERAS)):
        await db.execute(
            update(NotificationDelivery)
            .where(NotificationDelivery.id == entrega_id)
            .values(
                status=FALLIDA,
                next_attempt_at=None,
                last_error=_saneado(error),
                updated_at=momento,
            )
        )
        return FALLIDA

    espera = ESPERAS[min(intentos, len(ESPERAS) - 1)]
    await db.execute(
        update(NotificationDelivery)
        .where(NotificationDelivery.id == entrega_id)
        .values(
            status=PENDIENTE,
            next_attempt_at=momento + espera,
            last_error=_saneado(error),
            updated_at=momento,
        )
    )
    return PENDIENTE


async def procesar(
    db: AsyncSession,
    *,
    enviar,
    limite: int = 50,
    momento: datetime | None = None,
) -> dict[str, int]:
    """Vacía lo que toca ahora. Idempotente y acotado.

    `enviar` se recibe como argumento —no se importa— para que esto se pueda
    probar sin Expo y sin red: la cola es lógica, el transporte no.

    UNA POR UNA, y cada una con su propio `commit`. Si la tercera revienta, las
    dos anteriores ya están marcadas: reprocesar no las repite.
    """
    momento = momento or ahora()
    cuenta = {"intentadas": 0, "enviadas": 0, "reintentables": 0, "fallidas": 0}

    for fila in await pendientes(db, limite=limite, momento=momento):
        identificador = fila.id
        usuario = fila.user_id
        tipo = fila.type
        idioma = fila.locale
        if not await tomar(db, entrega_id=identificador, momento=momento):
            # Otro proceso la cogió. No es un fallo.
            continue
        await db.commit()
        cuenta["intentadas"] += 1

        try:
            await enviar(db, usuario_id=usuario, tipo=tipo, locale=idioma)
        except Exception as error:  # noqa: BLE001
            estado = await marcar_fallo(
                db, entrega_id=identificador, error=str(error), momento=momento
            )
            await db.commit()
            cuenta["fallidas" if estado == FALLIDA else "reintentables"] += 1
            continue

        await marcar_enviada(db, entrega_id=identificador, momento=momento)
        await db.commit()
        cuenta["enviadas"] += 1

    return cuenta


async def resumen(db: AsyncSession) -> dict[str, int]:
    """Cuántas hay en cada estado. Para el panel de operación."""
    from sqlalchemy import func

    filas = (
        await db.execute(
            select(NotificationDelivery.status, func.count()).group_by(
                NotificationDelivery.status
            )
        )
    ).all()
    return {estado: int(cuantas) for estado, cuantas in filas}


__all__ = [
    "ENVIADA",
    "ESPERAS",
    "FALLIDA",
    "PENDIENTE",
    "encolar",
    "marcar_enviada",
    "marcar_fallo",
    "pendientes",
    "procesar",
    "resumen",
    "tomar",
]
