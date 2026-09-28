"""Las políticas versionadas de Servicios: cuál rige hoy y su huella.

SOLO LECTURA en este bloque. Publicar una política es una acción de
administración que llega con su propio contrato; aquí se responde a una sola
pregunta: ¿hay condiciones del prestador publicadas y en vigor para este país?

SIN POLÍTICA PUBLICADA NO SE PUEDE ENVIAR UNA POSTULACIÓN. No es una
preferencia: aceptar las condiciones es un requisito del alcance, y aceptar un
texto que la empresa no ha escrito sería aceptar nada. La 0086 lo impone
también: una postulación fuera de borrador exige una política aceptada.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.services.models import POLITICA_PUBLICADA, ServicePolicy


def huella(texto: str) -> str:
    """El SHA-256 del texto EXACTO que se enseña. Sin normalizar: un espacio
    distinto es otro texto, y la huella tiene que decirlo."""
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()


async def vigente(
    db: AsyncSession,
    *,
    tipo: str,
    pais: str,
    categoria: str | None = None,
    ahora: datetime | None = None,
) -> ServicePolicy | None:
    """La política publicada y en vigor, o `None`.

    LA DE LA CATEGORÍA GANA A LA GENERAL: si existe una para esa categoría, es
    la que rige; si no, la que vale para todas. Una publicada con fecha futura
    todavía no rige.
    """
    momento = ahora or datetime.now(timezone.utc)
    filtros = [
        ServicePolicy.kind == tipo,
        ServicePolicy.country_code == pais,
        ServicePolicy.status == POLITICA_PUBLICADA,
        ServicePolicy.effective_at <= momento,
    ]
    if categoria:
        filtros.append(
            or_(ServicePolicy.category == categoria, ServicePolicy.category.is_(None))
        )
    else:
        filtros.append(ServicePolicy.category.is_(None))

    candidatas = list(await db.scalars(select(ServicePolicy).where(*filtros)))
    if not candidatas:
        return None
    # La específica primero; entre iguales, la versión más alta.
    candidatas.sort(key=lambda p: (p.category is not None, p.version), reverse=True)
    return candidatas[0]


__all__ = ["huella", "vigente"]
