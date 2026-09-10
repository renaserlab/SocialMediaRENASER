"""Editar un evento YA PUBLICADO, dejando constancia de qué cambió.

POR QUÉ EXISTE. Un evento publicado no se podía editar: había que enviarlo de
nuevo a revisión. Eso está bien para el contenido, y es terrible para lo
operativo —una sala que cambia el mismo día no espera a curaduría—. Lo que no
puede pasar es que ese cambio reescriba en silencio lo que la gente compró.

REGISTRAR NO ES CLASIFICAR. Aquí se guarda QUÉ cambió y QUÉ decía antes. Si ese
cambio es «esencial» —y por tanto si da derecho a algo— es una decisión de la
empresa: la fila nace en `pending`, que **no** es «no esencial».

Y NO SE TOCA NADA DE LO VENDIDO. Ni pedidos, ni entradas, ni credenciales. Este
módulo escribe una versión nueva y unas filas de cambio; nada más.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, ValidationAppError
from app.core.security import AuthUser
from app.modules.events import esquema, permissions, states
from app.modules.events.models import EventOperations, EventVersion
from app.modules.events.posventa_models import SIN_CLASIFICAR, EventChange

#: Los campos cuyo cambio puede alterar lo que alguien compró. NO se declara
#: cuáles son esenciales: se declara cuáles hay que MIRAR. La diferencia es
#: todo el punto de este módulo.
CAMPOS_VIGILADOS = (
    "starts_at",
    "ends_at",
    "timezone",
    "location",
    "event_type",
    "capacity",
    "title",
    "promise",
    "description",
    "category",
)

#: Cuánto se guarda de cada valor. La 0064 corta en 500; aquí se recorta antes
#: para no depender de que lo haga la base y para no archivar una descripción
#: entera en cada edición.
LARGO_DEL_VALOR = 500


def ahora() -> datetime:
    return datetime.now(timezone.utc)


def _texto(valor: Any) -> str | None:
    """El valor, como algo que una persona pueda leer y comparar.

    Recortado y sin saltos: esto es una pista de qué cambió, no una copia del
    evento.
    """
    if valor is None:
        return None
    if isinstance(valor, datetime):
        return valor.isoformat()
    crudo = str(valor).strip().replace("\r", " ").replace("\n", " ")
    return crudo[:LARGO_DEL_VALOR] or None


def diferencias(antes: dict[str, Any], despues: dict[str, Any]) -> list[tuple[str, str | None, str | None]]:
    """Qué campos vigilados cambiaron, con su antes y su después.

    Se comparan los TEXTOS ya normalizados, no los objetos: sin eso, una fecha
    con y sin zona horaria se leería como un cambio, y una edición que no
    cambia nada dejaría filas de cambio falsas.
    """
    salida: list[tuple[str, str | None, str | None]] = []
    for campo in CAMPOS_VIGILADOS:
        viejo = _texto(antes.get(campo))
        nuevo = _texto(despues.get(campo))
        if viejo != nuevo:
            salida.append((campo, viejo, nuevo))
    return salida


async def registrar(
    db: AsyncSession,
    *,
    evento_id: str,
    antes: dict[str, Any],
    despues: dict[str, Any],
    actor_id: str | None,
    momento: datetime | None = None,
) -> list[EventChange]:
    """Escribe una fila por diferencia. Sin clasificar ninguna.

    Devuelve lo escrito. NO hace `commit`: quien llama decide, para que la
    versión nueva y sus cambios vivan o mueran juntos.
    """
    if not await esquema.hay_posventa(db):
        # Sin la 0064 no hay dónde anotarlo. La edición NO se bloquea por eso:
        # bloquearla dejaría un evento sin poder corregir una sala por una
        # migración que falta. Se sigue, y la ausencia se nota en el rastro.
        return []

    momento = momento or ahora()
    escritas: list[EventChange] = []
    for campo, viejo, nuevo in diferencias(antes, despues):
        fila = EventChange(
            event_id=evento_id,
            field=campo,
            previous_value=viejo,
            new_value=nuevo,
            classification=SIN_CLASIFICAR,
            changed_by=actor_id,
            created_at=momento,
        )
        db.add(fila)
        escritas.append(fila)
    return escritas


async def actualizar_publicado(
    db: AsyncSession,
    *,
    evento_id: str,
    datos: dict[str, Any],
    usuario: AuthUser,
    motivo: str,
    version_esperada: int | None = None,
) -> tuple[EventVersion, list[EventChange]]:
    """Cambia un evento publicado, dejando versión nueva y constancia.

    TODO EN UNA TRANSACCIÓN. La versión nueva, las filas de cambio y el estado
    de la operación se confirman juntos: una versión sin sus cambios diría que
    algo se editó sin decir qué, que es peor que no tener versión.

    CONTROL DE CONCURRENCIA. Se toma la fila de operaciones —el mismo punto de
    serialización que usa todo el módulo— y, si quien edita traía un número de
    versión, se comprueba: dos organizadores editando a la vez, el segundo se
    entera en vez de pisar.

    NO NOTIFICA NINGÚN DERECHO. Registrar un cambio no es haber decidido que
    da derecho a devolución, y decírselo a alguien sería prometerlo.
    """
    from app.modules.events import service

    evento = await service._exigir_evento(db, evento_id)
    permissions.exigir_organizador(evento, usuario)
    operacion = await service._tomar_el_turno(db, evento_id)

    if not states.es_publico_de_verdad(operacion.workflow_status, evento.status):
        raise ConflictError(
            "Este evento no está publicado: se edita como borrador.",
            code="event_not_published",
        )
    if not (motivo or "").strip():
        raise ValidationAppError(
            "Un cambio sobre un evento publicado necesita un motivo.",
            code="event_change_needs_reason",
        )

    anterior = await service.ultima_version(db, evento_id)
    if version_esperada is not None and (
        anterior is None or anterior.version != version_esperada
    ):
        raise ConflictError(
            "Alguien cambió este evento mientras lo editabas. Vuelve a cargarlo.",
            code="event_version_stale",
            details={"current": anterior.version if anterior else None},
        )

    antes = service._foto(evento, operacion)

    for campo in ("promise", "category", "timezone"):
        if campo in datos:
            setattr(operacion, campo, datos.pop(campo))
    for campo, valor in datos.items():
        setattr(evento, campo, valor)
    operacion.updated_at = ahora()

    despues = service._foto(evento, operacion)
    cambios = await registrar(
        db, evento_id=evento_id, antes=antes, despues=despues, actor_id=usuario.id
    )

    if anterior is not None and anterior.status != "superseded":
        anterior.status = "superseded"
    numero = (anterior.version + 1) if anterior is not None else 1
    version = EventVersion(
        event_id=evento_id,
        version=numero,
        status="published",
        snapshot=despues,
        changed_fields=service.campos_cambiados(
            anterior.snapshot if anterior else None, despues
        ),
        reason=motivo.strip(),
        created_by=usuario.id,
    )
    db.add(version)
    operacion.current_version = numero

    from app.modules.gobernanza import auditoria

    await auditoria.anotar(
        db,
        actor_id=usuario.id,
        actor_role="user",
        action="event.published_updated",
        entity_type="event",
        entity_id=evento_id,
        previous_state=str(anterior.version) if anterior else None,
        new_state=str(numero),
        reason=motivo.strip()[:200],
        # LOS CAMPOS, NO SUS VALORES. La versión ya los guarda; repetirlos aquí
        # convertiría el rastro en una copia del evento.
        payload={"campos": sorted(c.field for c in cambios)},
    )
    await db.commit()
    return version, cambios


async def sin_clasificar(db: AsyncSession, *, evento_id: str) -> int:
    """Cuántos cambios de este evento esperan a que alguien los mire."""
    from sqlalchemy import func

    valor = await db.scalar(
        select(func.count())
        .select_from(EventChange)
        .where(
            EventChange.event_id == evento_id,
            EventChange.classification == SIN_CLASIFICAR,
        )
    )
    return valor or 0


__all__ = [
    "CAMPOS_VIGILADOS",
    "actualizar_publicado",
    "diferencias",
    "registrar",
    "sin_clasificar",
]
