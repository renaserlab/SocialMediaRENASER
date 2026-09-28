"""La puerta de Servicios: bandera encendida Y migración 0086 aplicada.

DOS COSAS DISTINTAS, DOS CÓDIGOS:

  * `FEATURE_SERVICES` APAGADA (lo de fábrica): cada ruta contesta 503
    `services_disabled`. No es un 404 —la ruta existe y está bien escrita— ni un
    500 —nada se rompió—. Con la bandera apagada no se consulta la base: la
    aplicación actual no paga nada por tener Servicios dentro.
  * BANDERA ENCENDIDA SIN LA 0086 (una base local, una de pruebas): 503
    `services_not_ready`. Desplegar código no puede exigir que la migración ya
    esté puesta, igual que en Eventos y Productos.

EN LAS RUTAS DE ADMINISTRACIÓN EL ROL SE COMPRUEBA ANTES QUE ESTA PUERTA: si
fuera al revés, una cuenta sin permisos distinguiría un 503 de un 403 y
averiguaría cómo está configurado el servidor.

LA RESPUESTA SE GUARDA EN LA MEMORIA DEL PROCESO, también el «no». Al aplicar
la 0086 hay que reiniciar la API.
"""

from __future__ import annotations

import logging

from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.exceptions import ServiceUnavailableError

logger = logging.getLogger("renaser.services")

#: Las seis de la 0086. Se comprueban TODAS: una base con la postulación pero
#: sin su historial sería una migración aplicada a medias.
TABLAS_DE_ADMISION = (
    "service_policies",
    "service_providers",
    "service_provider_applications",
    "service_provider_documents",
    "service_provider_credentials",
    "service_provider_application_events",
)

_cache: dict[str, bool] = {}


class ServiciosApagados(ServiceUnavailableError):
    code = "services_disabled"
    message = "Servicios todavía no está disponible."


class ServiciosSinMigracion(ServiceUnavailableError):
    code = "services_not_ready"
    message = "Servicios todavía no está preparado en este servidor."


def encendido() -> bool:
    return bool(get_settings().feature_services)


def olvidar() -> None:
    """Para las pruebas: cada una monta su propia base."""
    _cache.clear()


async def hay_admision(db: AsyncSession) -> bool:
    if "admision" not in _cache:
        conexion = await db.connection()

        def _mirar(sync) -> bool:  # noqa: ANN001
            inspector = inspect(sync)
            return all(inspector.has_table(t) for t in TABLAS_DE_ADMISION)

        _cache["admision"] = await conexion.run_sync(_mirar)
        if not _cache["admision"]:
            logger.warning(
                "Servicios: falta la migración 0086. Las rutas contestan 503."
            )
    return _cache["admision"]


async def exigir_servicios(db: AsyncSession) -> None:
    """La bandera primero —sin tocar la base— y después el esquema."""
    if not encendido():
        raise ServiciosApagados()
    if not await hay_admision(db):
        raise ServiciosSinMigracion()


__all__ = [
    "ServiciosApagados",
    "ServiciosSinMigracion",
    "TABLAS_DE_ADMISION",
    "encendido",
    "exigir_servicios",
    "hay_admision",
    "olvidar",
]
