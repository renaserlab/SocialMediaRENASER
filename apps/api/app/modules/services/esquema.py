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

from sqlalchemy import inspect, text
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


# --------------------------------------------------------------------------- #
# El catálogo (Incremento 2, migración 0090)
# --------------------------------------------------------------------------- #
#: Las tablas de la 0090. Sus COLUMNAS se comparan con las del ORM: una tabla a
#: medias haría que cualquier consulta reventara con un 500.
TABLAS_DEL_CATALOGO = (
    "service_categories",
    "services",
    "service_versions",
    "service_version_images",
    "service_events",
)

#: LO QUE LA 0090 IMPONE Y EL CÓDIGO DA POR HECHO, mirado en el catálogo de
#: PostgreSQL: cada disparador en su tabla, con su función, su forma y activo;
#: los índices únicos que impiden dos abiertas o dos publicadas; RLS en las
#: cinco tablas; y el depósito privado. No el número de la migración.
_LO_QUE_NECESITA_EL_CATALOGO = text(
    """
    select
      (
        select count(*)
          from (values
            ('public.service_categories', 'service_categories_dos_niveles',
             'public.service_categories_dos_niveles()', 31),
            ('public.services', 'services_saltos', 'public.services_salto_valido()', 23),
            ('public.services', 'services_coherente', 'public.servicios_catalogo_coherente()', 21),
            ('public.services', 'services_solo_en_cascada',
             'public.servicios_borrado_solo_en_cascada()', 11),
            ('public.service_versions', 'service_versions_saltos',
             'public.service_versions_salto_valido()', 23),
            ('public.service_versions', 'service_versions_ajena',
             'public.servicios_catalogo_nadie_se_publica()', 23),
            ('public.service_versions', 'service_versions_coherente',
             'public.servicios_catalogo_coherente()', 21),
            ('public.service_versions', 'service_versions_solo_en_cascada',
             'public.servicios_borrado_solo_en_cascada()', 11),
            ('public.service_version_images', 'service_version_images_solo_en_borrador',
             'public.service_version_images_solo_en_borrador()', 31),
            ('public.service_events', 'service_events_ajena',
             'public.servicios_catalogo_nadie_se_publica()', 7),
            ('public.service_events', 'service_events_inmutables',
             'public.servicios_catalogo_historial_inmutable()', 19),
            ('public.service_events', 'service_events_solo_en_cascada',
             'public.servicios_borrado_solo_en_cascada()', 11)
          ) as e(tabla, disparador, funcion, tipo)
         where exists (
           select 1 from pg_catalog.pg_trigger t
            where t.tgrelid = to_regclass(e.tabla)
              and t.tgname = e.disparador
              and t.tgfoid = to_regprocedure(e.funcion)
              and t.tgtype = e.tipo
              and t.tgenabled in ('O', 'A')
              and not t.tgisinternal
         )
      ) = 12
      and (
        select count(*)
          from pg_catalog.pg_index i
         where i.indisunique
           and i.indexrelid in (
             to_regclass('public.service_versions_una_abierta'),
             to_regclass('public.service_versions_una_publicada'),
             to_regclass('public.service_version_images_una_portada'),
             to_regclass('public.services_una_por_clave'),
             to_regclass('public.service_events_una_por_clave')
           )
      ) = 5
      and (
        select count(*) from pg_catalog.pg_class c
         where c.oid in (
           to_regclass('public.service_categories'), to_regclass('public.services'),
           to_regclass('public.service_versions'), to_regclass('public.service_version_images'),
           to_regclass('public.service_events')
         )
           and c.relrowsecurity
      ) = 5
      and exists (select 1 from storage.buckets b where b.id = 'service-media' and not b.public)
    """
)


def _columnas_completas(sync) -> bool:  # noqa: ANN001
    # Importarlo registra sus tablas en `Base.metadata`.
    from app.modules.services import catalogo_models

    tablas = catalogo_models.Base.metadata.tables
    inspector = inspect(sync)
    for tabla in TABLAS_DEL_CATALOGO:
        if not inspector.has_table(tabla):
            return False
        hay = {c["name"] for c in inspector.get_columns(tabla)}
        if not {c.name for c in tablas[tabla].columns} <= hay:
            return False
    return True


async def hay_catalogo(db: AsyncSession) -> bool:
    """¿Tiene la base la 0090 COMPLETA? Ante la duda, no.

    Como `hay_admision`, la respuesta se recuerda hasta reiniciar la API,
    también el «no». Un error al mirar NO se recuerda y cierra la puerta.
    """
    if "catalogo" not in _cache:
        try:
            conexion = await db.connection()
            completa = await conexion.run_sync(_columnas_completas)
            if completa and conexion.dialect.name == "postgresql":
                completa = bool(await db.scalar(_LO_QUE_NECESITA_EL_CATALOGO))
        except Exception:  # noqa: BLE001 - cerrada ante cualquier fallo al mirar
            logger.warning("Servicios: no se pudo comprobar la 0090; el catálogo contesta 503.", exc_info=True)
            return False
        _cache["catalogo"] = completa
        if not completa:
            logger.warning("Servicios: falta la 0090 completa. El catálogo contesta 503.")
    return _cache["catalogo"]


async def exigir_catalogo(db: AsyncSession) -> None:
    """La bandera, la admisión y el catálogo, en ese orden."""
    await exigir_servicios(db)
    if not await hay_catalogo(db):
        raise ServiciosSinMigracion()


__all__ = [
    "COLUMNAS_DE_LA_0088",
    "ServiciosApagados",
    "ServiciosSinMigracion",
    "TABLAS_DEL_CATALOGO",
    "TABLAS_DE_ADMISION",
    "encendido",
    "exigir_catalogo",
    "exigir_servicios",
    "hay_admision",
    "hay_catalogo",
    "olvidar",
]
