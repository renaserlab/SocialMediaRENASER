"""La puerta de Servicios: bandera encendida Y migraciones 0086–0088 aplicadas.

DOS COSAS DISTINTAS, DOS CÓDIGOS:

  * `FEATURE_SERVICES` APAGADA (lo de fábrica): cada ruta contesta 503
    `services_disabled`. No es un 404 —la ruta existe y está bien escrita— ni un
    500 —nada se rompió—. Con la bandera apagada no se consulta la base: la
    aplicación actual no paga nada por tener Servicios dentro.
  * BANDERA ENCENDIDA SIN LAS MIGRACIONES (una base local, una de pruebas, o
    producción antes de aplicar la 0088): 503 `services_not_ready`. Desplegar
    código no puede exigir que la migración ya esté puesta, igual que en
    Eventos y Productos. Y NUNCA UN 500: los modelos ya declaran las columnas
    de la 0088, así que sin ella cualquier consulta reventaría; por eso la
    puerta pregunta también por ellas.

EN LAS RUTAS DE ADMINISTRACIÓN EL ROL SE COMPRUEBA ANTES QUE ESTA PUERTA: si
fuera al revés, una cuenta sin permisos distinguiría un 503 de un 403 y
averiguaría cómo está configurado el servidor.

LA RESPUESTA SE GUARDA EN LA MEMORIA DEL PROCESO, también el «no». Al aplicar
una migración de Servicios hay que reiniciar la API.
"""

from __future__ import annotations

import logging

from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.exceptions import ServiceUnavailableError

logger = logging.getLogger("renaser.services")

#: Las seis de la 0086 y la de la 0088. Se comprueban TODAS: una base con la
#: postulación pero sin su historial sería una migración aplicada a medias.
TABLAS_DE_ADMISION = (
    "service_policies",
    "service_providers",
    "service_provider_applications",
    "service_provider_documents",
    "service_provider_credentials",
    "service_provider_application_events",
    "service_provider_application_submissions",
)

#: Las COLUMNAS que la 0088 añade a tablas que ya existían. Preguntar solo por
#: la tabla diría que sí sin que exista nada de lo que hace falta.
COLUMNAS_DE_LA_0088 = {
    "service_provider_documents": ("lifecycle", "lifecycle_changed_at", "replaced_by"),
    "service_provider_credentials": ("lifecycle", "lifecycle_changed_at", "observed_at"),
    "service_provider_application_events": ("details",),
}

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
            if not all(inspector.has_table(t) for t in TABLAS_DE_ADMISION):
                return False
            for tabla, columnas in COLUMNAS_DE_LA_0088.items():
                hay = {c["name"] for c in inspector.get_columns(tabla)}
                if not all(c in hay for c in columnas):
                    return False
            return True

        _cache["admision"] = await conexion.run_sync(_mirar)
        if not _cache["admision"]:
            logger.warning(
                "Servicios: faltan las migraciones 0086–0088. Las rutas contestan 503."
            )
    return _cache["admision"]


async def exigir_servicios(db: AsyncSession) -> None:
    """La bandera primero —sin tocar la base— y después el esquema."""
    if not encendido():
        raise ServiciosApagados()
    if not await hay_admision(db):
        raise ServiciosSinMigracion()


__all__ = [
    "COLUMNAS_DE_LA_0088",
    "ServiciosApagados",
    "ServiciosSinMigracion",
    "TABLAS_DE_ADMISION",
    "encendido",
    "exigir_servicios",
    "hay_admision",
    "olvidar",
]
