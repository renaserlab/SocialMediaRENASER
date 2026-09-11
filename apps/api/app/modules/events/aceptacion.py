"""Qué política aceptó cada compra, y cómo se la enseñamos antes de pagar.

POR QUÉ ESTO TIENE QUE EXISTIR. Sin un registro de aceptación, «las compras
anteriores conservan la versión que aceptaron» es una promesa sin respaldo:
publicar una versión nueva cambiaría en silencio las reglas de todo lo ya
vendido, y nadie podría demostrar después qué se prometió.

SE CONGELA EL IDENTIFICADOR Y LA HUELLA. Con el identificador se lee la política
entera; con la huella se demuestra que esos parámetros son los que eran, sin
depender de que nadie haya tocado la fila de al lado. La 0069 impide tocarla:
una aceptación no se modifica ni se borra, porque es un consentimiento.

NO SE INVENTA NINGUNA ACEPTACIÓN. Un pedido de antes de que existiera política
no tiene fila aquí, y eso es un hecho: a esa persona no se le enseñó nada
porque no había nada publicado.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.events import esquema, politicas
from app.modules.events.aceptacion_models import EventOrderPolicyAcceptance
from app.modules.events.posventa_models import (
    POLITICA_EFECTO_ENTRADA,
    POLITICA_ELEGIBILIDAD,
    EventPolicy,
)

#: LAS QUE SE LE ENSEÑAN A QUIEN COMPRA, antes de pagar. Son las condiciones de
#: venta: cuándo puede pedir un cambio o una devolución y qué pasa con su
#: entrada. Las de dinero de la plataforma no son cosa suya y no se le muestran.
TIPOS_QUE_SE_ACEPTAN = (POLITICA_ELEGIBILIDAD, POLITICA_EFECTO_ENTRADA)


def ahora() -> datetime:
    return datetime.now(timezone.utc)


async def aplicables(db: AsyncSession, *, evento_id: str) -> list[EventPolicy]:
    """Lo que rige para este evento AHORA, para enseñarlo antes de pagar.

    Usa `politicas.vigente`, que cae a la global cuando el evento no tiene la
    suya: para decidir y para mostrar, lo que manda es lo mismo.

    Lista vacía significa SIN POLÍTICA CONFIGURADA, que no es lo mismo que «no
    corresponde devolución». Quien lo lea tiene que decir la primera.
    """
    if not await esquema.hay_posventa(db):
        return []
    encontradas: list[EventPolicy] = []
    for tipo in TIPOS_QUE_SE_ACEPTAN:
        politica = await politicas.vigente(db, tipo=tipo, evento_id=evento_id)
        if politica is not None:
            encontradas.append(politica)
    return encontradas


async def registrar(
    db: AsyncSession,
    *,
    orden_id: str,
    evento_id: str,
    usuario_id: str,
    momento: datetime | None = None,
) -> list[EventOrderPolicyAcceptance]:
    """Congela en el pedido lo que rige al crearlo. Idempotente por tipo.

    NO HACE `commit`: vive o muere con el pedido. Un pedido que existe sin su
    aceptación sería exactamente el agujero que esto cierra.

    Sin políticas publicadas no escribe nada y no es un fallo: es que la empresa
    —o quien organiza— todavía no ha decidido.
    """
    momento = momento or ahora()
    if not await esquema.hay_aceptaciones(db):
        return []
    guardadas: list[EventOrderPolicyAcceptance] = []
    for politica in await aplicables(db, evento_id=evento_id):
        fila = EventOrderPolicyAcceptance(
            order_id=orden_id,
            policy_id=politica.id,
            policy_type=politica.policy_type,
            policy_version=politica.version,
            params_sha256=politica.params_sha256,
            accepted_at=momento,
            accepted_by=usuario_id,
        )
        try:
            # EN SU PROPIO SAVEPOINT: un reintento del mismo pedido no puede
            # deshacer la orden por un choque de clave.
            async with db.begin_nested():
                db.add(fila)
                await db.flush()
        except IntegrityError:
            if fila in db:
                db.expunge(fila)
            continue
        guardadas.append(fila)
    return guardadas


async def de_la_orden(
    db: AsyncSession, *, orden_id: str
) -> list[EventOrderPolicyAcceptance]:
    """Lo que aceptó esa compra. Vacío = no se le enseñó ninguna."""
    if not await esquema.hay_aceptaciones(db):
        return []
    return list(
        await db.scalars(
            select(EventOrderPolicyAcceptance)
            .where(EventOrderPolicyAcceptance.order_id == orden_id)
            .order_by(EventOrderPolicyAcceptance.policy_type)
        )
    )


async def la_que_rige(
    db: AsyncSession, *, orden_id: str, tipo: str
) -> EventPolicy | None:
    """La versión que ESA compra aceptó, no la vigente hoy.

    ES LA DIFERENCIA ENTRE CUMPLIR Y REESCRIBIR. Resolver un expediente con la
    política de hoy, cuando esa persona compró bajo otra, es cambiarle las
    reglas después de cobrarle.

    `None` cuando esa compra no aceptó ninguna de ese tipo. Quien lo lea NO debe
    caer a la vigente por su cuenta: eso es justo lo que esto evita.
    """
    if not await esquema.hay_aceptaciones(db):
        return None
    fila = await db.scalar(
        select(EventOrderPolicyAcceptance).where(
            EventOrderPolicyAcceptance.order_id == orden_id,
            EventOrderPolicyAcceptance.policy_type == tipo,
        )
    )
    if fila is None:
        return None
    return await db.get(EventPolicy, fila.policy_id)


__all__ = [
    "TIPOS_QUE_SE_ACEPTAN",
    "aplicables",
    "de_la_orden",
    "la_que_rige",
    "registrar",
]
