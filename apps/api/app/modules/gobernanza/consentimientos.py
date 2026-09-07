"""Registrar que alguien aceptó un texto, y sellar para qué se usó.

TRES INVARIANTES, Y LAS TRES LAS SOSTIENE LA BASE, no un `if`:

1. **Un doble toque no crea dos aceptaciones.** El «mira si existe y si no
   inserta» de Python lo pasan dos peticiones simultáneas: leen las dos antes de
   que escriba ninguna. Aquí se inserta y se deja que colisione el índice
   `consent_records_pendiente_unico`.
2. **Una aceptación no se consume por dos órdenes.** El sello va en la propia
   fila y el índice `consent_records_consumo_unico` impide además que dos
   aceptaciones apunten a la misma orden.
3. **Nada se reescribe.** Lo impiden los disparadores de la 0050, no la RLS: la
   API entra con la clave de servicio y la RLS se la salta.

LA FECHA ES LA DEL SERVIDOR y el hash lo calcula el servidor. El cliente no
manda ni una cosa ni la otra: una aceptación con fecha del teléfono y huella del
teléfono no demuestra nada.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.gobernanza import esquema, politicas
from app.modules.gobernanza.contexto import OrigenDeLaPeticion
from app.modules.gobernanza.models import ConsentRecord


class ConsentimientoYaConsumido(RuntimeError):
    """Se intentó sellar una aceptación que ya servía para otra cosa."""


async def registrar(
    db: AsyncSession,
    *,
    subject_id: str,
    policy_type: str,
    texto_mostrado: str,
    scope_kind: str = "global",
    scope_id: str | None = None,
    jurisdiction: str = "PE",
    locale: str = "es",
    origen: OrigenDeLaPeticion | None = None,
    channel: str | None = None,
) -> ConsentRecord | None:
    """Guarda una aceptación pendiente de consumir.

    `texto_mostrado` es el texto YA MONTADO, con sus huecos rellenados: es de
    eso de lo que se guarda la huella. La huella de la plantilla no serviría —lo
    que la persona leyó llevaba una fecha dentro—.

    Devuelve `None` si la 0050 no está aplicada; devuelve la que ya había si se
    pulsó dos veces. No hace `commit`.
    """
    if not await esquema.hay_gobernanza(db):
        return None

    politica = await politicas.exigir_vigente(
        db, policy_type=policy_type, jurisdiction=jurisdiction, locale=locale
    )

    fila = ConsentRecord(
        subject_id=subject_id,
        policy_version_id=politica.id,
        policy_type=politica.policy_type,
        policy_version=politica.version,
        policy_hash=politicas.huella(texto_mostrado),
        scope_kind=scope_kind,
        scope_id=scope_id,
        request_id=origen.request_id if origen else None,
        ip_hash=origen.ip_hash if origen else None,
        ip_prefix=origen.ip_prefix if origen else None,
        user_agent_family=origen.user_agent_family if origen else None,
        channel=channel,
    )
    try:
        # SAVEPOINT, Y EL `add` VA DENTRO. Una colisión de índice único aborta
        # la transacción en PostgreSQL, y con ella se caería lo que ya se
        # hubiera hecho en esta petición.
        #
        # EL `add` TIENE QUE ESTAR DENTRO DEL BLOQUE. Fuera, el objeto pertenece
        # a la transacción exterior: deshacer el savepoint no lo saca de la
        # sesión, el fallo marca la transacción raíz como «hay que deshacerla», y
        # la siguiente consulta —la de aquí abajo— revienta con
        # `PendingRollbackError` en vez de devolver la aceptación que ya existía.
        async with db.begin_nested():
            db.add(fila)
            await db.flush()
    except IntegrityError:
        # Doble toque. La que ya está es la buena.
        return await pendiente(
            db,
            subject_id=subject_id,
            policy_type=policy_type,
            scope_kind=scope_kind,
            scope_id=scope_id,
        )
    return fila


async def pendiente(
    db: AsyncSession,
    *,
    subject_id: str,
    policy_type: str,
    scope_kind: str = "global",
    scope_id: str | None = None,
) -> ConsentRecord | None:
    """La aceptación de esta persona que todavía no se ha usado."""
    if not await esquema.hay_gobernanza(db):
        return None
    consulta = select(ConsentRecord).where(
        ConsentRecord.subject_id == subject_id,
        ConsentRecord.policy_type == policy_type,
        ConsentRecord.scope_kind == scope_kind,
        ConsentRecord.consumed_at.is_(None),
    )
    consulta = (
        consulta.where(ConsentRecord.scope_id == scope_id)
        if scope_id is not None
        else consulta.where(ConsentRecord.scope_id.is_(None))
    )
    return await db.scalar(consulta.order_by(ConsentRecord.accepted_at.desc()).limit(1))


async def consumir(
    db: AsyncSession,
    consentimiento: ConsentRecord,
    *,
    kind: str,
    identificador: str,
) -> bool:
    """Sella para qué se usó. Una sola vez, y lo garantiza la base.

    Devuelve si esta llamada fue la que lo selló. `False` significa que ya
    estaba sellado o que otra orden llegó antes, y quien llama tiene que
    tratarlo como un conflicto, no como un éxito.
    """
    from app.modules.gobernanza.politicas import ahora

    if consentimiento.consumed_at is not None:
        return False
    consentimiento.consumed_by_kind = kind
    consentimiento.consumed_by_id = identificador
    consentimiento.consumed_at = ahora()
    try:
        async with db.begin_nested():
            await db.flush()
    except IntegrityError:
        # Ya había otra aceptación sellada contra esta misma orden. La base lo
        # impide con `consent_records_consumo_unico`; antes esto se resolvía con
        # un `order_by … limit 1` en Python que dos peticiones se saltan.
        return False
    return True
