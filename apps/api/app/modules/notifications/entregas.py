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

#: CUÁNTO DURA EL TURNO de quien coge una entrega. No es una espera de
#: reintento: es el tiempo que esa fila queda apartada de la cola mientras se
#: intenta enviarla.
#:
#: Apartarla solo `ESPERAS[0]` —un minuto— no bastaba. El envío llama a Expo en
#: lotes de cien con diez segundos de margen cada uno, así que pasar del minuto
#: es normal; al minuto y un segundo otra réplica cogía la misma fila y el
#: teléfono sonaba dos veces. El índice único de la clave de suceso no protege
#: de esto: protege el ENCOLADO, no el ENVÍO.
ARRENDAMIENTO = timedelta(minutes=15)

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
) -> int | None:
    """Coge el turno de una entrega. UPDATE CONDICIONAL.

    Devuelve EL NÚMERO DE INTENTO que acaba de escribir, o `None` si otro
    proceso se la llevó. Ese número es la prenda del turno: `marcar_enviada` y
    `marcar_fallo` solo escriben si la fila sigue en él, así que una réplica
    lenta no puede pisar el resultado de la que la relevó.

    La fila queda apartada `ARRENDAMIENTO`, y no una espera de reintento.
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
            next_attempt_at=momento + ARRENDAMIENTO,
            updated_at=momento,
        )
    )
    if (hechas.rowcount or 0) != 1:
        return None
    return int(
        await db.scalar(
            select(NotificationDelivery.attempts).where(
                NotificationDelivery.id == entrega_id
            )
        )
        or 0
    )


async def marcar_enviada(
    db: AsyncSession,
    *,
    entrega_id: str,
    intento: int | None = None,
    momento: datetime | None = None,
) -> bool:
    """Enviada, y solo DESPUÉS de que el envío haya terminado bien.

    CONDICIONAL AL TURNO. Sin el `intento` que devolvió `tomar`, un proceso que
    tardó más que el arrendamiento reescribía el resultado del que lo relevó:
    una entrega ya `failed` volvía a `sent`, o al revés —y al revés viola el
    CHECK de la base, porque `failed` con fecha de envío no existe—.
    """
    momento = momento or ahora()
    condiciones = [
        NotificationDelivery.id == entrega_id,
        NotificationDelivery.status == PENDIENTE,
    ]
    if intento is not None:
        condiciones.append(NotificationDelivery.attempts == int(intento))
    hechas = await db.execute(
        update(NotificationDelivery)
        .where(*condiciones)
        .values(status=ENVIADA, sent_at=momento, last_error=None, updated_at=momento)
    )
    return (hechas.rowcount or 0) == 1


async def marcar_fallo(
    db: AsyncSession,
    *,
    entrega_id: str,
    error: str | None,
    intento: int | None = None,
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
    # EL MISMO TURNO que en `marcar_enviada`: la fila tiene que seguir en el
    # intento que se cogió, y tiene que seguir pendiente.
    condiciones = [
        NotificationDelivery.id == entrega_id,
        NotificationDelivery.status == PENDIENTE,
    ]
    if intento is not None:
        condiciones.append(NotificationDelivery.attempts == int(intento))

    if intentos >= int(fila.max_attempts or len(ESPERAS)):
        await db.execute(
            update(NotificationDelivery)
            .where(*condiciones)
            .values(
                status=FALLIDA,
                next_attempt_at=None,
                # SE LIMPIA LA FECHA DE ENVÍO. «Fallida con fecha de envío» no
                # existe, y la base lo impone con un CHECK.
                sent_at=None,
                last_error=_saneado(error),
                updated_at=momento,
            )
        )
        return FALLIDA

    espera = ESPERAS[min(intentos, len(ESPERAS) - 1)]
    await db.execute(
        update(NotificationDelivery)
        .where(*condiciones)
        .values(
            status=PENDIENTE,
            next_attempt_at=momento + espera,
            sent_at=None,
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
    cuenta = {
        "intentadas": 0,
        "enviadas": 0,
        "sin_destino": 0,
        "reintentables": 0,
        "fallidas": 0,
    }

    for fila in await pendientes(db, limite=limite, momento=momento):
        identificador = fila.id
        usuario = fila.user_id
        tipo = fila.type
        idioma = fila.locale
        intento = await tomar(db, entrega_id=identificador, momento=momento)
        if intento is None:
            # Otro proceso la cogió. No es un fallo.
            continue
        await db.commit()
        cuenta["intentadas"] += 1

        try:
            salio = await enviar(db, usuario_id=usuario, tipo=tipo, locale=idioma)
        except Exception as error:  # noqa: BLE001
            estado = await marcar_fallo(
                db,
                entrega_id=identificador,
                error=str(error),
                intento=intento,
                momento=momento,
            )
            await db.commit()
            cuenta["fallidas" if estado == FALLIDA else "reintentables"] += 1
            continue

        await marcar_enviada(
            db, entrega_id=identificador, intento=intento, momento=momento
        )
        await db.commit()
        # SALIÓ, O NO HABÍA A DÓNDE. Las dos cierran la entrega —reintentar no
        # hace aparecer un teléfono— pero contarlas juntas hacía que el panel
        # dijera «enviadas» de avisos que no salieron de aquí.
        cuenta["enviadas" if salio is not False else "sin_destino"] += 1

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
    "ARRENDAMIENTO",
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
