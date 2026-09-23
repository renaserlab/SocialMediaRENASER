"""¿Está la 0050 aplicada? Se pregunta, no se supone.

MISMO PATRÓN QUE `refunds/esquema.py` Y `catalog/esquema.py`, y por el mismo
motivo: las migraciones se aplican A MANO, así que el código se despliega antes
o después que ellas y tiene que sobrevivir a las dos situaciones. Sin esto, un
despliegue con la 0050 pendiente convertiría publicar un curso en un 500.

SE CACHEA POR PROCESO. La respuesta no cambia mientras la aplicación vive: una
migración no se aplica sola. Preguntarlo en cada petición sería un viaje a la
base por cada publicación.
"""

from __future__ import annotations

from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import AsyncSession

#: `None` = todavía no se ha mirado.
_hay_versiones: bool | None = None
_hay_gobernanza: bool | None = None


async def _existen(db: AsyncSession, tablas: tuple[str, ...]) -> bool:
    def _mirar(conexion) -> bool:
        inspector = inspect(conexion)
        return all(inspector.has_table(t) for t in tablas)

    return bool(await (await db.connection()).run_sync(_mirar))


async def hay_versiones_de_curso(db: AsyncSession) -> bool:
    """Si se puede versionar. Sin la tabla, publicar sigue funcionando como antes."""
    global _hay_versiones
    if _hay_versiones is None:
        _hay_versiones = await _existen(db, ("course_versions",))
    return _hay_versiones


async def hay_gobernanza(db: AsyncSession) -> bool:
    """Si hay políticas, consentimientos y auditoría.

    LAS TRES JUNTAS y no una a una: la auditoría de una aceptación de política
    no tiene sentido si solo existe una de las dos tablas, y comprobarlo por
    separado dejaría escribir media operación.
    """
    global _hay_gobernanza
    if _hay_gobernanza is None:
        _hay_gobernanza = await _existen(
            db, ("policy_versions", "consent_records", "audit_events")
        )
    return _hay_gobernanza


def olvidar() -> None:
    """Solo para las pruebas: vuelve a preguntar la próxima vez.

    Existe porque el caché es de proceso y una prueba que monte un esquema sin
    estas tablas contaminaría a la siguiente, que sí las tiene.
    """
    global _hay_versiones, _hay_gobernanza
    _hay_versiones = None
    _hay_gobernanza = None
