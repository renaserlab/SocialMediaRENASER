"""Qué partes del aprendizaje están aplicadas en ESTA base.

Mismo mecanismo que `refunds/esquema.py`: desplegar código no puede exigir que
una migración concreta ya esté puesta. Sin la 0057 la pestaña de notas no
aparece y sus endpoints responden «no disponible», en vez de reventar con un
500 a mitad de una lección.

Comparte el diccionario con `recommendations.esquema` a propósito: la memoria
vive en el PROCESO y el `conftest.py` ya llama a `olvidar()` antes de cada
prueba.
"""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.recommendations.esquema import (  # noqa: F401
    _cache,
    _hay_tabla,
    olvidar,
)

logger = logging.getLogger("renaser.learning")


async def hay_notas(db: AsyncSession) -> bool:
    """Si está `lesson_notes` (migración 0057)."""
    if "lesson_notes" not in _cache:
        hay = await _hay_tabla(db, "lesson_notes")
        _cache["lesson_notes"] = hay
        if not hay:
            logger.warning(
                "La migracion 0057 no esta aplicada: no hay notas privadas y "
                "la pestana no se ofrece."
            )
    return _cache["lesson_notes"]
