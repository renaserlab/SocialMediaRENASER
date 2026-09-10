"""Las políticas de posventa de eventos, como dato y no como código.

POR QUÉ NO ESTÁN EN EL CÓDIGO. Un plazo escrito en un `if` cambia cuando
alguien despliega, y cambia también para lo que ya se vendió. Aquí una política
se PUBLICA con sus parámetros y su huella, y lo publicado no se toca: se
supersede. Así un expediente puede decir con qué reglas exactas se resolvió.

Y POR QUÉ NO HAY VALORES POR DEFECTO. `0`, «siete días» o «aprobación
automática» son decisiones de la empresa tomadas por descuido, y ninguna prueba
las delata porque el resultado cuadra. Sin política publicada, la operación se
bloquea y lo dice.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppError, ServiceUnavailableError
from app.modules.events.posventa_models import (
    BORRADOR,
    PUBLICADA,
    SUPERADA,
    TIPOS_DE_POLITICA,
    EventPolicy,
)


class PoliticaAusente(AppError):
    """No hay ninguna política publicada para esta decisión.

    NO ES UN ERROR DEL SERVIDOR. Es una decisión que la empresa todavía no ha
    tomado, y decirlo con un 500 haría pensar que algo se rompió. 409 con un
    código estable: quien llama puede distinguirlo de cualquier otro fallo y la
    pantalla puede explicar por qué el botón está apagado.
    """

    status_code = 409
    code = "event_policy_not_configured"


def ahora() -> datetime:
    return datetime.now(timezone.utc)


def huella(params: dict[str, Any]) -> str:
    """El resumen de los parámetros publicados.

    CANÓNICO: claves ordenadas y sin espacios. Sin eso, el mismo contenido daría
    huellas distintas según cómo se escribiera, y la huella dejaría de servir
    para demostrar qué números se aplicaron.
    """
    crudo = json.dumps(params or {}, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(crudo.encode("utf-8")).hexdigest()


async def vigente(
    db: AsyncSession,
    *,
    tipo: str,
    evento_id: str | None = None,
    jurisdiccion: str = "PE",
    locale: str = "es",
) -> EventPolicy | None:
    """La política que rige ahora, o `None`.

    LA DEL EVENTO MANDA SOBRE LA GLOBAL. Un festival puede necesitar
    condiciones propias; si las tiene, son las suyas las que se aplican y la
    global no se mezcla.
    """
    if tipo not in TIPOS_DE_POLITICA:
        raise ValueError(f"Tipo de política desconocido: {tipo}")

    from app.modules.events import esquema

    if not await esquema.hay_posventa(db):
        return None

    if evento_id is not None:
        propia = await db.scalar(
            select(EventPolicy).where(
                EventPolicy.policy_type == tipo,
                EventPolicy.scope == "event",
                EventPolicy.event_id == evento_id,
                EventPolicy.jurisdiction == jurisdiccion,
                EventPolicy.locale == locale,
                EventPolicy.status == PUBLICADA,
                EventPolicy.effective_to.is_(None),
            )
        )
        if propia is not None:
            return propia

    return await db.scalar(
        select(EventPolicy).where(
            EventPolicy.policy_type == tipo,
            EventPolicy.scope == "global",
            EventPolicy.jurisdiction == jurisdiccion,
            EventPolicy.locale == locale,
            EventPolicy.status == PUBLICADA,
            EventPolicy.effective_to.is_(None),
        )
    )


async def exigir_vigente(
    db: AsyncSession,
    *,
    tipo: str,
    evento_id: str | None = None,
    jurisdiccion: str = "PE",
    locale: str = "es",
) -> EventPolicy:
    """La política, o se para. Nunca devuelve una inventada."""
    politica = await vigente(
        db, tipo=tipo, evento_id=evento_id, jurisdiccion=jurisdiccion, locale=locale
    )
    if politica is None:
        raise PoliticaAusente(
            "Esta decisión todavía no está configurada.",
            details={"policy_type": tipo},
        )
    return politica


async def publicar(
    db: AsyncSession,
    *,
    tipo: str,
    version: str,
    params: dict[str, Any],
    actor_id: str | None = None,
    evento_id: str | None = None,
    jurisdiccion: str = "PE",
    locale: str = "es",
    body: str | None = None,
) -> EventPolicy:
    """Cierra la anterior y abre la nueva, EN LA MISMA TRANSACCIÓN.

    El estado intermedio de «ninguna vigente» o «dos vigentes» no puede existir:
    en el primero se bloquearía una operación legítima y en el segundo el
    resultado dependería del orden de lectura. No hace `commit`: quien llama
    decide cuándo, para que la publicación viva o muera con lo que la rodea.

    IDEMPOTENTE: republicar la misma versión devuelve la que ya está.
    """
    if tipo not in TIPOS_DE_POLITICA:
        raise ValueError(f"Tipo de política desconocido: {tipo}")
    if not isinstance(params, dict):
        raise ValueError("Los parámetros de una política son un objeto.")

    alcance = "event" if evento_id is not None else "global"
    ya = await db.scalar(
        select(EventPolicy).where(
            EventPolicy.policy_type == tipo,
            EventPolicy.scope == alcance,
            EventPolicy.event_id == evento_id,
            EventPolicy.jurisdiction == jurisdiccion,
            EventPolicy.locale == locale,
            EventPolicy.version == version,
            EventPolicy.status == PUBLICADA,
            EventPolicy.effective_to.is_(None),
        )
    )
    if ya is not None:
        return ya

    momento = ahora()
    await db.execute(
        update(EventPolicy)
        .where(
            EventPolicy.policy_type == tipo,
            EventPolicy.scope == alcance,
            EventPolicy.event_id == evento_id,
            EventPolicy.jurisdiction == jurisdiccion,
            EventPolicy.locale == locale,
            EventPolicy.status == PUBLICADA,
            EventPolicy.effective_to.is_(None),
        )
        .values(status=SUPERADA, effective_to=momento)
    )

    nueva = EventPolicy(
        policy_type=tipo,
        scope=alcance,
        event_id=evento_id,
        jurisdiction=jurisdiccion,
        locale=locale,
        version=version,
        status=PUBLICADA,
        params=dict(params),
        params_sha256=huella(params),
        body=body,
        effective_from=momento,
        published_at=momento,
        published_by=actor_id,
        created_by=actor_id,
    )
    db.add(nueva)
    await db.flush()
    return nueva


def numero(politica: EventPolicy, clave: str) -> int | None:
    """Un parámetro numérico de la política, o `None` si no está.

    `None` NO SE SUSTITUYE POR CERO. Quien lo lea tiene que decidir qué hacer
    sin ese dato, y lo correcto casi siempre es pararse: un plazo ausente leído
    como cero cierra la ventana para todo el mundo, y un porcentaje ausente
    leído como cero regala el importe entero.
    """
    valor = (politica.params or {}).get(clave)
    if isinstance(valor, bool) or not isinstance(valor, (int, float)):
        return None
    return int(valor)


def bandera(politica: EventPolicy, clave: str) -> bool:
    """Un permiso de la política. Ausente es NO.

    Falla en cerrado a propósito: una política a la que se le olvidó decir que
    algo está permitido no lo permite.
    """
    return (politica.params or {}).get(clave) is True


__all__ = [
    "BORRADOR",
    "PUBLICADA",
    "SUPERADA",
    "PoliticaAusente",
    "bandera",
    "exigir_vigente",
    "huella",
    "numero",
    "publicar",
    "vigente",
]
