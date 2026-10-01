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


def olvidar_guardados() -> None:
    """Que la próxima petición vuelva a mirar la 0091 (la tabla falló al leerse)."""
    _cache.pop("guardados", None)


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


# --------------------------------------------------------------------------- #
# Los guardados (Incremento 3, migración 0091)
# --------------------------------------------------------------------------- #
#: LO QUE LA 0091 IMPONE Y EL CÓDIGO DA POR HECHO, por DEFINICIÓN y no por
#: nombre: la clave (perfil, servicio) que hace que guardar dos veces sea
#: guardar una; las dos claves ajenas en cascada (una a cada tabla); cada
#: columna con su tipo, NOT NULL y, en `created_at`, `now()` (guardar no la
#: manda: sin ese valor sería un 500); el título entre 1 y 300; los dos índices
#: con sus columnas y su orden, válidos, listos y sin condición; RLS sin
#: políticas; y nadie de fuera con permisos: ni `anon` ni `authenticated`
#: (tampoco por PUBLIC), en la tabla o en una columna. Una lista ajena
#: legible por PostgREST sería una fuga, no un detalle. No el número de la
#: migración.
_LO_QUE_NECESITAN_LOS_GUARDADOS = text(
    r"""
    select
      exists (
        select 1 from pg_catalog.pg_index i
         where i.indexrelid = to_regclass('public.saved_services_pkey')
           and i.indrelid = to_regclass('public.saved_services')
           and i.indisprimary and i.indisunique and i.indisvalid and i.indnatts = 2
           and (select array_agg(a.attname::text order by k.ord)
                  from unnest(i.indkey) with ordinality k(attnum, ord)
                  join pg_catalog.pg_attribute a
                    on a.attrelid = i.indrelid and a.attnum = k.attnum)
               = array['profile_id', 'service_id']
      )
      and (
        select count(*) = 2 and count(distinct c.confrelid) = 2
          from pg_catalog.pg_constraint c
         where c.conrelid = to_regclass('public.saved_services')
           and c.contype = 'f' and c.confdeltype = 'c' and c.convalidated
           and c.confrelid in (to_regclass('public.profiles'), to_regclass('public.services'))
      )
      and (
        select count(*) from pg_catalog.pg_attribute a
          left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
         where a.attrelid = to_regclass('public.saved_services') and a.attnum > 0 and not a.attisdropped
           and a.attnotnull
           and (a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod),
                coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '')) in (
             ('profile_id', 'uuid', ''), ('service_id', 'uuid', ''), ('title_at_save', 'text', ''),
             ('created_at', 'timestamp with time zone', 'now()')
           )
      ) = 4
      and exists (
        select 1 from pg_catalog.pg_constraint c
         where c.conrelid = to_regclass('public.saved_services')
           and c.conname = 'saved_services_titulo' and c.contype = 'c'
           -- Sin espacios ni paréntesis: lo que cambie de una versión a otra
           -- de PostgreSQL al escribirla, no lo que dice. Una sin validar no
           -- coincide: su definición termina en «NOT VALID».
           and regexp_replace(pg_catalog.pg_get_constraintdef(c.oid), '[\s()]', '', 'g')
               = 'CHECKlengthTRIMBOTHFROMtitle_at_save>=1ANDlengthTRIMBOTHFROMtitle_at_save<=300'
      )
      and (
        select count(*) from pg_catalog.pg_index i
          join pg_catalog.pg_class x on x.oid = i.indexrelid
          join pg_catalog.pg_am m on m.oid = x.relam
         where i.indrelid = to_regclass('public.saved_services')
           and m.amname = 'btree' and not i.indisunique
           and i.indisvalid and i.indisready and i.indislive
           and i.indpred is null and i.indexprs is null
           and (x.relname, (select array_agg(a.attname::text
                                  || case when i.indoption[k.ord - 1] & 1 = 1 then ' desc' else '' end
                                  order by k.ord)
                              from unnest(i.indkey) with ordinality k(attnum, ord)
                              join pg_catalog.pg_attribute a
                                on a.attrelid = i.indrelid and a.attnum = k.attnum)) in (
             ('saved_services_mios', array['profile_id', 'created_at desc', 'service_id desc']),
             ('saved_services_del_servicio', array['service_id'])
           )
      ) = 2
      and coalesce(
        (select c.relrowsecurity from pg_catalog.pg_class c
          where c.oid = to_regclass('public.saved_services')),
        false
      )
      and not exists (
        select 1 from pg_catalog.pg_policy p where p.polrelid = to_regclass('public.saved_services')
      )
      -- Permisos EFECTIVOS: cubren también lo concedido a PUBLIC (todo rol
      -- tiene lo de PUBLIC).
      and not exists (
        select 1 from pg_catalog.pg_roles r
         where r.rolname in ('anon', 'authenticated')
           and (pg_catalog.has_table_privilege(
                  r.oid, to_regclass('public.saved_services'),
                  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                or pg_catalog.has_any_column_privilege(
                  r.oid, to_regclass('public.saved_services'), 'SELECT, INSERT, UPDATE, REFERENCES'))
      )
    """
)


def _columnas_de_los_guardados(sync) -> bool:  # noqa: ANN001
    from app.modules.services import descubrimiento_models

    inspector = inspect(sync)
    if not inspector.has_table("saved_services"):
        return False
    hay = {c["name"] for c in inspector.get_columns("saved_services")}
    tabla = descubrimiento_models.Base.metadata.tables["saved_services"]
    return {c.name for c in tabla.columns} <= hay


async def hay_guardados(db: AsyncSession) -> bool:
    """¿Tiene la base la 0091 COMPLETA? Ante la duda, no. Como el catálogo:
    el «sí» y el «no» se recuerdan hasta reiniciar; un error al mirar, no."""
    if "guardados" not in _cache:
        try:
            conexion = await db.connection()
            completa = await conexion.run_sync(_columnas_de_los_guardados)
            if completa and conexion.dialect.name == "postgresql":
                completa = bool(await db.scalar(_LO_QUE_NECESITAN_LOS_GUARDADOS))
        except Exception:  # noqa: BLE001 - cerrada ante cualquier fallo al mirar
            logger.warning("Servicios: no se pudo comprobar la 0091; los guardados contestan 503.", exc_info=True)
            return False
        _cache["guardados"] = completa
        if not completa:
            logger.warning("Servicios: falta la 0091 completa. Guardar contesta 503.")
    return _cache["guardados"]


async def exigir_guardados(db: AsyncSession) -> None:
    """El catálogo y, además, la 0091."""
    await exigir_catalogo(db)
    if not await hay_guardados(db):
        raise ServiciosSinMigracion()


# --------------------------------------------------------------------------- #
# La agenda (Incremento 4, migración 0092)
# --------------------------------------------------------------------------- #
TABLAS_DE_LA_AGENDA = (
    "service_schedules",
    "service_schedule_rules",
    "service_schedule_exceptions",
    "service_schedule_blocks",
    "service_schedule_events",
)

#: LO QUE LA 0092 IMPONE Y EL CÓDIGO DA POR HECHO, por DEFINICIÓN:
#:
#:  * cada columna con su tipo y su NOT NULL, y NINGUNA MÁS (una columna
#:    obligatoria de sobra haría que cada alta fuera un 500);
#:  * las claves primarias y las cinco ajenas en cascada, validadas;
#:  * las RESTRICCIONES DE EXCLUSIÓN escritas tal cual: SON la autoridad de los
#:    cruces, y el código no vuelve a comprobarlos. Sin ellas, dos franjas
#:    cruzadas se guardarían en silencio. Y los dieciocho CHECK, validados y
#:    por su definición (una huella de todos juntos);
#:  * los índices con su definición (el único de la `Idempotency-Key`,
#:    parcial), y TODOS los de las cinco tablas (también los de las claves
#:    primarias y las exclusiones) válidos, listos y vivos;
#:  * los cuatro disparadores activos, con su función, su forma, sus
#:    argumentos y sus columnas, y la función de la zona sin SECURITY DEFINER,
#:    con su `search_path` y su cuerpo;
#:  * `btree_gist`, RLS sin políticas, y nadie de fuera con permisos: ni `anon`
#:    ni `authenticated` (tampoco por PUBLIC), en una tabla, en una columna ni
#:    en la función.
#:
#: No el número de la migración.
_LO_QUE_NECESITA_LA_AGENDA = text(
    r"""
    with
    tablas(t) as (
      select to_regclass('public.' || n)
        from (values ('service_schedules'), ('service_schedule_rules'), ('service_schedule_exceptions'),
                     ('service_schedule_blocks'), ('service_schedule_events')) v(n)
    ),
    columnas(tabla, columna, tipo, obligatoria) as (values
      ('service_schedules', 'service_id', 'uuid', true),
      ('service_schedules', 'timezone', 'text', true),
      ('service_schedules', 'status', 'text', true),
      ('service_schedules', 'buffer_before_minutes', 'integer', true),
      ('service_schedules', 'buffer_after_minutes', 'integer', true),
      ('service_schedules', 'slot_interval_minutes', 'integer', false),
      ('service_schedules', 'created_by', 'uuid', false),
      ('service_schedules', 'created_at', 'timestamp with time zone', true),
      ('service_schedules', 'updated_at', 'timestamp with time zone', true),
      ('service_schedule_rules', 'id', 'uuid', true),
      ('service_schedule_rules', 'service_id', 'uuid', true),
      ('service_schedule_rules', 'weekday', 'smallint', true),
      ('service_schedule_rules', 'start_minute', 'integer', true),
      ('service_schedule_rules', 'end_minute', 'integer', true),
      ('service_schedule_rules', 'modality', 'text', true),
      ('service_schedule_rules', 'capacity', 'integer', true),
      ('service_schedule_rules', 'active', 'boolean', true),
      ('service_schedule_rules', 'created_at', 'timestamp with time zone', true),
      ('service_schedule_rules', 'updated_at', 'timestamp with time zone', true),
      ('service_schedule_exceptions', 'id', 'uuid', true),
      ('service_schedule_exceptions', 'service_id', 'uuid', true),
      ('service_schedule_exceptions', 'on_date', 'date', true),
      ('service_schedule_exceptions', 'kind', 'text', true),
      ('service_schedule_exceptions', 'start_minute', 'integer', false),
      ('service_schedule_exceptions', 'end_minute', 'integer', false),
      ('service_schedule_exceptions', 'modality', 'text', false),
      ('service_schedule_exceptions', 'capacity', 'integer', false),
      ('service_schedule_exceptions', 'created_at', 'timestamp with time zone', true),
      ('service_schedule_exceptions', 'updated_at', 'timestamp with time zone', true),
      ('service_schedule_blocks', 'id', 'uuid', true),
      ('service_schedule_blocks', 'service_id', 'uuid', true),
      ('service_schedule_blocks', 'starts_at', 'timestamp with time zone', true),
      ('service_schedule_blocks', 'ends_at', 'timestamp with time zone', true),
      ('service_schedule_blocks', 'reason', 'text', false),
      ('service_schedule_blocks', 'created_at', 'timestamp with time zone', true),
      ('service_schedule_events', 'id', 'uuid', true),
      ('service_schedule_events', 'service_id', 'uuid', true),
      ('service_schedule_events', 'action', 'text', true),
      ('service_schedule_events', 'actor_id', 'uuid', false),
      ('service_schedule_events', 'actor_role', 'text', true),
      ('service_schedule_events', 'details', 'jsonb', true),
      ('service_schedule_events', 'idempotency_key', 'text', false),
      ('service_schedule_events', 'created_at', 'timestamp with time zone', true)
    ),
    primarias(tabla, columna) as (values
      ('service_schedules', 'service_id'), ('service_schedule_rules', 'id'),
      ('service_schedule_exceptions', 'id'), ('service_schedule_blocks', 'id'),
      ('service_schedule_events', 'id')
    ),
    claves(tabla, columna, madre, columna_madre) as (values
      ('service_schedules', 'service_id', 'services', 'id'),
      ('service_schedule_rules', 'service_id', 'service_schedules', 'service_id'),
      ('service_schedule_exceptions', 'service_id', 'service_schedules', 'service_id'),
      ('service_schedule_blocks', 'service_id', 'service_schedules', 'service_id'),
      ('service_schedule_events', 'service_id', 'services', 'id')
    ),
    exclusiones(tabla, nombre, definicion) as (values
      ('service_schedule_rules', 'service_schedule_rules_sin_cruces',
       'EXCLUDE USING gist (service_id WITH =, weekday WITH =, '
       'int4range(start_minute, end_minute) WITH &&) WHERE (active)'),
      ('service_schedule_exceptions', 'service_schedule_exceptions_sin_cruces',
       'EXCLUDE USING gist (service_id WITH =, on_date WITH =, '
       'int4range(COALESCE(start_minute, 0), COALESCE(end_minute, 1440)) WITH &&)')
    ),
    disparadores(tabla, nombre, funcion, tipo, argumentos, columnas) as (values
      ('service_schedules', 'service_schedules_zona_valida', 'servicios_agenda_zona_valida()', 23,
       '', 'timezone'),
      ('service_schedules', 'service_schedules_solo_en_cascada', 'servicios_borrado_solo_en_cascada()', 11,
       'services\000service_id\000', ''),
      ('service_schedule_events', 'service_schedule_events_inmutables',
       'servicios_catalogo_historial_inmutable()', 19, '', ''),
      ('service_schedule_events', 'service_schedule_events_solo_en_cascada',
       'servicios_borrado_solo_en_cascada()', 11, 'services\000service_id\000', '')
    )
    select
      -- Cada columna con su tipo y su NOT NULL, y ni una más.
      (select count(*) from columnas e
         join pg_catalog.pg_attribute a
           on a.attrelid = to_regclass('public.' || e.tabla) and a.attname = e.columna
          and a.attnum > 0 and not a.attisdropped
        where pg_catalog.format_type(a.atttypid, a.atttypmod) = e.tipo and a.attnotnull = e.obligatoria
      ) = 43
      and (select count(*) from pg_catalog.pg_attribute a
            where a.attrelid in (select t from tablas) and a.attnum > 0 and not a.attisdropped) = 43
      and (select count(*) from primarias e
             join pg_catalog.pg_index i on i.indrelid = to_regclass('public.' || e.tabla)
             join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
            where i.indisprimary and i.indisvalid and i.indnatts = 1 and a.attname = e.columna) = 5
      and (select count(*) from claves e
             join pg_catalog.pg_constraint c
               on c.conrelid = to_regclass('public.' || e.tabla)
              and c.confrelid = to_regclass('public.' || e.madre)
             join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
             join pg_catalog.pg_attribute m on m.attrelid = c.confrelid and m.attnum = c.confkey[1]
            where c.contype = 'f' and c.confdeltype = 'c' and c.convalidated
              and cardinality(c.conkey) = 1 and a.attname = e.columna and m.attname = e.columna_madre) = 5
      -- LAS EXCLUSIONES, TAL CUAL: son la autoridad de los cruces.
      and (select count(*) from exclusiones e
             join pg_catalog.pg_constraint c
               on c.conrelid = to_regclass('public.' || e.tabla) and c.conname = e.nombre
            where c.contype = 'x' and c.convalidated
              and pg_catalog.pg_get_constraintdef(c.oid) = e.definicion) = 2
      and (select count(*) from pg_catalog.pg_constraint c
            where c.contype = 'c' and c.convalidated and c.conrelid in (select t from tablas)
              and c.conname in (
                'service_schedules_zona', 'service_schedules_estado', 'service_schedules_preparacion',
                'service_schedules_descanso', 'service_schedules_intervalo',
                'service_schedule_rules_dia', 'service_schedule_rules_franja',
                'service_schedule_rules_modalidad', 'service_schedule_rules_capacidad',
                'service_schedule_exceptions_tipo', 'service_schedule_exceptions_franja',
                'service_schedule_exceptions_abrir_con_franja', 'service_schedule_exceptions_lo_que_abre',
                'service_schedule_blocks_orden', 'service_schedule_blocks_motivo',
                'service_schedule_events_accion', 'service_schedule_events_rol',
                'service_schedule_events_clave'
              )) = 18
      -- Y POR SU DEFINICIÓN: los dieciocho juntos, sin espacios de más, con la
      -- huella de la 0092. Uno aflojado con el mismo nombre no pasa.
      and (select md5(string_agg(c.conname || ':' || regexp_replace(pg_catalog.pg_get_constraintdef(c.oid), '\s+', ' ', 'g'),
                                 '|' order by c.conname))
             from pg_catalog.pg_constraint c
            where c.contype = 'c' and c.conrelid in (select t from tablas))
          = 'a01cc1bfaa992194f415ea0611b67642'
      -- `pg_get_indexdef` siempre nombra la tabla con su esquema.
      and (select count(*) from pg_catalog.pg_index i
            where i.indrelid in (select t from tablas)
              and i.indisvalid and i.indisready and i.indislive
              and pg_catalog.pg_get_indexdef(i.indexrelid) in (
                'CREATE INDEX service_schedule_rules_de_la_agenda ON public.service_schedule_rules '
                'USING btree (service_id, weekday, start_minute)',
                'CREATE INDEX service_schedule_exceptions_de_la_agenda ON public.service_schedule_exceptions '
                'USING btree (service_id, on_date)',
                'CREATE INDEX service_schedule_blocks_de_la_agenda ON public.service_schedule_blocks '
                'USING btree (service_id, ends_at)',
                'CREATE UNIQUE INDEX service_schedule_events_una_por_clave ON public.service_schedule_events '
                'USING btree (service_id, idempotency_key) WHERE (idempotency_key IS NOT NULL)',
                'CREATE INDEX service_schedule_events_del_servicio ON public.service_schedule_events '
                'USING btree (service_id, created_at DESC, id DESC)'
              )) = 5
      -- Y TODOS los índices de las cinco tablas, también los de las claves
      -- primarias y los de las exclusiones, válidos, listos y vivos: una
      -- exclusión con su índice a medias no impide los cruces.
      and not exists (select 1 from pg_catalog.pg_index i
                       where i.indrelid in (select t from tablas)
                         and not (i.indisvalid and i.indisready and i.indislive))
      and (select count(*) from disparadores e
             join pg_catalog.pg_trigger g
               on g.tgrelid = to_regclass('public.' || e.tabla) and g.tgname = e.nombre
            where not g.tgisinternal and g.tgenabled in ('O', 'A')
              and g.tgfoid = to_regprocedure('public.' || e.funcion) and g.tgtype = e.tipo
              -- Con sus argumentos (de qué madre cuelga) y sus columnas
              -- (`update of timezone`).
              and pg_catalog.encode(g.tgargs, 'escape') = e.argumentos
              and coalesce((select string_agg(a.attname::text, ',' order by k.n)
                              from unnest(g.tgattr::int2[]) as k(n)
                              join pg_catalog.pg_attribute a on a.attrelid = g.tgrelid and a.attnum = k.n), '')
                  = e.columnas) = 4
      and exists (
        select 1 from pg_catalog.pg_proc p
         where p.oid = to_regprocedure('public.servicios_agenda_zona_valida()')
           and not p.prosecdef
           and p.proconfig = array['search_path=public, pg_temp']
           -- Sin retornos de carro: el editor de Supabase puede traerlos.
           and md5(replace(p.prosrc, E'\r', '')) = 'e672312f003eab63d98616d3d2673c06'
      )
      and exists (select 1 from pg_catalog.pg_extension x where x.extname = 'btree_gist')
      and (select count(*) from pg_catalog.pg_class c
            where c.oid in (select t from tablas) and c.relrowsecurity) = 5
      and not exists (select 1 from pg_catalog.pg_policy p where p.polrelid in (select t from tablas))
      -- Permisos EFECTIVOS: cubren también lo concedido a PUBLIC.
      and not exists (
        select 1 from pg_catalog.pg_roles r, tablas
         where r.rolname in ('anon', 'authenticated')
           and (pg_catalog.has_table_privilege(
                  r.oid, tablas.t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                or pg_catalog.has_any_column_privilege(r.oid, tablas.t, 'SELECT, INSERT, UPDATE, REFERENCES'))
      )
      and not exists (
        select 1 from pg_catalog.pg_roles r
         where r.rolname in ('anon', 'authenticated')
           and pg_catalog.has_function_privilege(
                 r.oid, to_regprocedure('public.servicios_agenda_zona_valida()'), 'EXECUTE')
      )
    """
)


def _columnas_de_la_agenda(sync) -> bool:  # noqa: ANN001
    from app.modules.services import agenda_models

    tablas = agenda_models.Base.metadata.tables
    inspector = inspect(sync)
    for tabla in TABLAS_DE_LA_AGENDA:
        if not inspector.has_table(tabla):
            return False
        hay = {c["name"] for c in inspector.get_columns(tabla)}
        if not {c.name for c in tablas[tabla].columns} <= hay:
            return False
    return True


async def hay_agenda(db: AsyncSession) -> bool:
    """¿Tiene la base la 0092 COMPLETA? Ante la duda, no. Como el resto: el
    «sí» y el «no» se recuerdan hasta reiniciar; un error al mirar, no."""
    if "agenda" not in _cache:
        try:
            conexion = await db.connection()
            completa = await conexion.run_sync(_columnas_de_la_agenda)
            if completa and conexion.dialect.name == "postgresql":
                completa = bool(await db.scalar(_LO_QUE_NECESITA_LA_AGENDA))
        except Exception:  # noqa: BLE001 - cerrada ante cualquier fallo al mirar
            logger.warning("Servicios: no se pudo comprobar la 0092; la agenda contesta 503.", exc_info=True)
            return False
        _cache["agenda"] = completa
        if not completa:
            logger.warning("Servicios: falta la 0092 completa. La agenda contesta 503.")
    return _cache["agenda"]


async def exigir_agenda(db: AsyncSession) -> None:
    """El catálogo y, además, la 0092."""
    await exigir_catalogo(db)
    if not await hay_agenda(db):
        raise ServiciosSinMigracion()


# --------------------------------------------------------------------------- #
# La reserva (Incremento 5, migración 0093)
# --------------------------------------------------------------------------- #
TABLAS_DE_LA_RESERVA = (
    "service_holds",
    "service_orders",
    "service_bookings",
    "service_booking_intakes",
    "service_booking_acceptances",
    "service_booking_events",
)


class ReservaApagada(ServiceUnavailableError):
    code = "service_booking_disabled"
    message = "La contratación de servicios todavía no está disponible."


def reserva_encendida() -> bool:
    """La bandera de Servicios Y la de la contratación (arquitectura §17)."""
    ajustes = get_settings()
    return bool(ajustes.feature_services and ajustes.feature_service_booking)


#: LO QUE LA 0093 IMPONE Y EL CÓDIGO DA POR HECHO, por DEFINICIÓN:
#:
#:  * cada columna con su tipo y su NOT NULL, y NINGUNA MÁS;
#:  * las claves primarias, las veintiuna ajenas con su acción al borrar, y
#:    las únicas (el código de la reserva, un pedido y una retención por
#:    reserva, una aceptación de cada tipo por pedido);
#:  * LA EXCLUSIÓN escrita tal cual: ES la autoridad de la doble reserva, y el
#:    código no vuelve a comprobarla. Y los cuarenta y dos CHECK, validados y
#:    por su definición (una huella de todos juntos);
#:  * los índices con su definición (los tres únicos y parciales de las
#:    plazas y la retención activa, y el de la `Idempotency-Key`), y TODOS los
#:    de las seis tablas válidos, listos y vivos;
#:  * los quince disparadores activos con su función, su forma y sus
#:    argumentos (los tres que comprueban al CONFIRMAR, diferidos), y las
#:    siete funciones sin SECURITY DEFINER, con su `search_path` y su cuerpo;
#:  * el tipo `booking_terms` en `service_policies`;
#:  * RLS sin políticas, y nadie de fuera con permisos: ni `anon` ni
#:    `authenticated` (tampoco por PUBLIC), en una tabla, una columna o una
#:    función.
#:
#: No el número de la migración.
_SQL_DE_LA_RESERVA = (
    r"""
    with
    tablas(t) as (
      select to_regclass('public.' || n)
        from (values ('service_holds'), ('service_orders'), ('service_bookings'),
                     ('service_booking_intakes'), ('service_booking_acceptances'),
                     ('service_booking_events')) v(n)
    ),
    columnas(tabla, columna, tipo, obligatoria) as (values
      ('service_holds', 'id', 'uuid', true),
      ('service_holds', 'service_id', 'uuid', true),
      ('service_holds', 'version_id', 'uuid', true),
      ('service_holds', 'client_id', 'uuid', false),
      ('service_holds', 'status', 'text', true),
      ('service_holds', 'starts_at', 'timestamp with time zone', true),
      ('service_holds', 'ends_at', 'timestamp with time zone', true),
      ('service_holds', 'occupied_from', 'timestamp with time zone', true),
      ('service_holds', 'occupied_until', 'timestamp with time zone', true),
      ('service_holds', 'timezone', 'text', true),
      ('service_holds', 'local_date', 'date', true),
      ('service_holds', 'modality', 'text', true),
      ('service_holds', 'capacity', 'integer', true),
      ('service_holds', 'seat', 'integer', true),
      ('service_holds', 'expires_at', 'timestamp with time zone', true),
      ('service_holds', 'created_at', 'timestamp with time zone', true),
      ('service_holds', 'updated_at', 'timestamp with time zone', true),
      ('service_holds', 'consumed_at', 'timestamp with time zone', false),
      ('service_holds', 'released_at', 'timestamp with time zone', false),
      ('service_holds', 'expired_at', 'timestamp with time zone', false),
      ('service_orders', 'id', 'uuid', true),
      ('service_orders', 'service_id', 'uuid', true),
      ('service_orders', 'version_id', 'uuid', true),
      ('service_orders', 'provider_id', 'uuid', true),
      ('service_orders', 'client_id', 'uuid', false),
      ('service_orders', 'status', 'text', true),
      ('service_orders', 'payment_status', 'text', true),
      ('service_orders', 'payment_provider', 'text', true),
      ('service_orders', 'environment', 'text', true),
      ('service_orders', 'price_model', 'text', true),
      ('service_orders', 'price_minor', 'bigint', false),
      ('service_orders', 'currency', 'character(3)', false),
      ('service_orders', 'total_minor', 'bigint', true),
      ('service_orders', 'title_snapshot', 'text', true),
      ('service_orders', 'provider_name_snapshot', 'text', true),
      ('service_orders', 'created_at', 'timestamp with time zone', true),
      ('service_orders', 'confirmed_at', 'timestamp with time zone', true),
      ('service_bookings', 'id', 'uuid', true),
      ('service_bookings', 'booking_code', 'text', true),
      ('service_bookings', 'order_id', 'uuid', true),
      ('service_bookings', 'hold_id', 'uuid', true),
      ('service_bookings', 'service_id', 'uuid', true),
      ('service_bookings', 'version_id', 'uuid', true),
      ('service_bookings', 'provider_id', 'uuid', true),
      ('service_bookings', 'client_id', 'uuid', false),
      ('service_bookings', 'status', 'text', true),
      ('service_bookings', 'starts_at', 'timestamp with time zone', true),
      ('service_bookings', 'ends_at', 'timestamp with time zone', true),
      ('service_bookings', 'occupied_from', 'timestamp with time zone', true),
      ('service_bookings', 'occupied_until', 'timestamp with time zone', true),
      ('service_bookings', 'timezone', 'text', true),
      ('service_bookings', 'local_date', 'date', true),
      ('service_bookings', 'modality', 'text', true),
      ('service_bookings', 'duration_minutes', 'integer', true),
      ('service_bookings', 'buffer_before_minutes', 'integer', true),
      ('service_bookings', 'buffer_after_minutes', 'integer', true),
      ('service_bookings', 'capacity', 'integer', true),
      ('service_bookings', 'seat', 'integer', true),
      ('service_bookings', 'title_snapshot', 'text', true),
      ('service_bookings', 'provider_name_snapshot', 'text', true),
      ('service_bookings', 'location_area_snapshot', 'text', false),
      ('service_bookings', 'created_at', 'timestamp with time zone', true),
      ('service_bookings', 'confirmed_at', 'timestamp with time zone', true),
      ('service_booking_intakes', 'booking_id', 'uuid', true),
      ('service_booking_intakes', 'client_id', 'uuid', true),
      ('service_booking_intakes', 'note', 'text', false),
      ('service_booking_intakes', 'district', 'text', false),
      ('service_booking_intakes', 'address_line', 'text', false),
      ('service_booking_intakes', 'address_reference', 'text', false),
      ('service_booking_intakes', 'created_at', 'timestamp with time zone', true),
      ('service_booking_acceptances', 'id', 'uuid', true),
      ('service_booking_acceptances', 'order_id', 'uuid', true),
      ('service_booking_acceptances', 'kind', 'text', true),
      ('service_booking_acceptances', 'policy_id', 'uuid', false),
      ('service_booking_acceptances', 'policy_version', 'integer', false),
      ('service_booking_acceptances', 'version_id', 'uuid', false),
      ('service_booking_acceptances', 'sha256', 'text', true),
      ('service_booking_acceptances', 'accepted_by', 'uuid', false),
      ('service_booking_acceptances', 'accepted_at', 'timestamp with time zone', true),
      ('service_booking_events', 'id', 'uuid', true),
      ('service_booking_events', 'service_id', 'uuid', true),
      ('service_booking_events', 'hold_id', 'uuid', false),
      ('service_booking_events', 'booking_id', 'uuid', false),
      ('service_booking_events', 'action', 'text', true),
      ('service_booking_events', 'from_status', 'text', false),
      ('service_booking_events', 'to_status', 'text', true),
      ('service_booking_events', 'actor_id', 'uuid', false),
      ('service_booking_events', 'actor_role', 'text', true),
      ('service_booking_events', 'idempotency_key', 'text', false),
      ('service_booking_events', 'details', 'jsonb', true),
      ('service_booking_events', 'created_at', 'timestamp with time zone', true)
    ),
    primarias(tabla, columna) as (values
      ('service_holds', 'id'), ('service_orders', 'id'), ('service_bookings', 'id'),
      ('service_booking_intakes', 'booking_id'), ('service_booking_acceptances', 'id'),
      ('service_booking_events', 'id')
    ),
    claves(tabla, columna, madre, columna_madre, al_borrar) as (values
      ('service_booking_acceptances', 'order_id', 'service_orders', 'id', 'c'),
      ('service_booking_acceptances', 'policy_id', 'service_policies', 'id', 'r'),
      ('service_booking_acceptances', 'version_id', 'service_versions', 'id', 'c'),
      ('service_booking_events', 'booking_id', 'service_bookings', 'id', 'c'),
      ('service_booking_events', 'hold_id', 'service_holds', 'id', 'c'),
      ('service_booking_events', 'service_id', 'services', 'id', 'c'),
      ('service_booking_intakes', 'booking_id', 'service_bookings', 'id', 'c'),
      ('service_booking_intakes', 'client_id', 'profiles', 'id', 'c'),
      ('service_bookings', 'client_id', 'profiles', 'id', 'n'),
      ('service_bookings', 'hold_id', 'service_holds', 'id', 'c'),
      ('service_bookings', 'order_id', 'service_orders', 'id', 'c'),
      ('service_bookings', 'provider_id', 'service_providers', 'id', 'a'),
      ('service_bookings', 'service_id', 'services', 'id', 'c'),
      ('service_bookings', 'version_id', 'service_versions', 'id', 'c'),
      ('service_holds', 'client_id', 'profiles', 'id', 'n'),
      ('service_holds', 'service_id', 'services', 'id', 'c'),
      ('service_holds', 'version_id', 'service_versions', 'id', 'c'),
      ('service_orders', 'client_id', 'profiles', 'id', 'n'),
      ('service_orders', 'provider_id', 'service_providers', 'id', 'a'),
      ('service_orders', 'service_id', 'services', 'id', 'c'),
      ('service_orders', 'version_id', 'service_versions', 'id', 'c')
    ),
    unicas(tabla, nombre, definicion) as (values
      ('service_bookings', 'service_bookings_codigo_unico', 'UNIQUE (booking_code)'),
      ('service_bookings', 'service_bookings_un_pedido', 'UNIQUE (order_id)'),
      ('service_bookings', 'service_bookings_una_retencion', 'UNIQUE (hold_id)'),
      ('service_booking_acceptances', 'service_booking_acceptances_una', 'UNIQUE (order_id, kind)')
    ),
    disparadores(tabla, nombre, funcion, tipo, argumentos, diferido) as (values
      ('service_booking_acceptances', 'service_booking_acceptances_inmutables',
       'servicios_catalogo_historial_inmutable()', 19, '', false),
      ('service_booking_acceptances', 'service_booking_acceptances_solo_en_cascada',
       'servicios_borrado_solo_en_cascada()', 11, 'service_orders\000order_id\000', false),
      ('service_booking_events', 'service_booking_events_inmutables',
       'servicios_catalogo_historial_inmutable()', 19, '', false),
      ('service_booking_events', 'service_booking_events_solo_en_cascada',
       'servicios_borrado_solo_en_cascada()', 11, 'services\000service_id\000', false),
      ('service_booking_intakes', 'service_booking_intakes_inmutables',
       'servicios_catalogo_historial_inmutable()', 19, '', false),
      ('service_bookings', 'service_bookings_coherentes', 'servicios_reserva_coherente()', 5, '', true),
      ('service_bookings', 'service_bookings_inmutables', 'servicios_reserva_inmutable()', 19, '', false),
      ('service_bookings', 'service_bookings_por_venir', 'servicios_reserva_por_venir()', 11, '', false),
      ('service_bookings', 'service_bookings_solo_en_cascada',
       'servicios_borrado_solo_en_cascada()', 11, 'services\000service_id\000', false),
      ('service_holds', 'service_holds_con_reserva', 'servicios_retencion_con_reserva()', 21, '', true),
      ('service_holds', 'service_holds_salto_valido', 'servicios_retencion_salto_valido()', 19, '', false),
      ('service_holds', 'service_holds_solo_en_cascada',
       'servicios_borrado_solo_en_cascada()', 11, 'services\000service_id\000', false),
      ('service_orders', 'service_orders_completos', 'servicios_pedido_completo()', 5, '', true),
      ('service_orders', 'service_orders_inmutables', 'servicios_pedido_inmutable()', 19, '', false),
      ('service_orders', 'service_orders_solo_en_cascada',
       'servicios_borrado_solo_en_cascada()', 11, 'services\000service_id\000', false)
    ),
    funciones(firma, huella) as (values
      ('servicios_retencion_salto_valido()', 'c6e5fc3f207d179c3cfaf83a5eec674d'),
      ('servicios_reserva_inmutable()', 'ee4296a90773dc6c6ed5d8b4b4888c30'),
      ('servicios_reserva_por_venir()', '04866976d50afaba1f4d3cf619f757c9'),
      ('servicios_pedido_inmutable()', '5cf2314427c599c56e03f65b2cde390c'),
      ('servicios_reserva_coherente()', 'e0e28efb6dc74ef022088d8d35316452'),
      ('servicios_pedido_completo()', 'cc9c226e1db6ce82b07111e5b1c86286'),
      ('servicios_retencion_con_reserva()', '300e468e16528fa1d0b95b149148b95a')
    )
    select
      -- Cada columna con su tipo y su NOT NULL, y ni una más.
      (select count(*) from columnas e
         join pg_catalog.pg_attribute a
           on a.attrelid = to_regclass('public.' || e.tabla) and a.attname = e.columna
          and a.attnum > 0 and not a.attisdropped
        where pg_catalog.format_type(a.atttypid, a.atttypmod) = e.tipo and a.attnotnull = e.obligatoria
      ) = 91
      and (select count(*) from pg_catalog.pg_attribute a
            where a.attrelid in (select t from tablas) and a.attnum > 0 and not a.attisdropped) = 91
      and (select count(*) from primarias e
             join pg_catalog.pg_index i on i.indrelid = to_regclass('public.' || e.tabla)
             join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
            where i.indisprimary and i.indnatts = 1 and a.attname = e.columna) = 6
      -- Las ajenas con su acción al borrar, validadas, y ninguna más.
      and (select count(*) from claves e
             join pg_catalog.pg_constraint c
               on c.conrelid = to_regclass('public.' || e.tabla)
              and c.confrelid = to_regclass('public.' || e.madre)
             join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
             join pg_catalog.pg_attribute m on m.attrelid = c.confrelid and m.attnum = c.confkey[1]
            where c.contype = 'f' and c.confdeltype = e.al_borrar and c.convalidated
              and cardinality(c.conkey) = 1 and a.attname = e.columna and m.attname = e.columna_madre) = 21
      and (select count(*) from pg_catalog.pg_constraint c
            where c.contype = 'f' and c.conrelid in (select t from tablas)) = 21
      -- DIFERIDAS, solo las dos que apuntan al prestador: su baja llega a
      -- pedidos y reservas por UN camino, el del servicio.
      and (select count(*) from pg_catalog.pg_constraint c
            where c.contype = 'f' and c.conrelid in (select t from tablas) and c.condeferrable
              and c.condeferred and c.confrelid = to_regclass('public.service_providers')) = 2
      and (select count(*) from pg_catalog.pg_constraint c
            where c.contype = 'f' and c.conrelid in (select t from tablas) and c.condeferrable) = 2
      and (select count(*) from unicas e
             join pg_catalog.pg_constraint c
               on c.conrelid = to_regclass('public.' || e.tabla) and c.conname = e.nombre
            where c.contype = 'u' and pg_catalog.pg_get_constraintdef(c.oid) = e.definicion) = 4
      -- LA EXCLUSIÓN, TAL CUAL: es la autoridad de la doble reserva.
      and exists (
        select 1 from pg_catalog.pg_constraint c
         where c.conrelid = to_regclass('public.service_holds') and c.conname = 'service_holds_sin_cruces'
           and c.contype = 'x' and c.convalidated
           and pg_catalog.pg_get_constraintdef(c.oid) =
               'EXCLUDE USING gist (service_id WITH =, tstzrange(occupied_from, occupied_until, ''[)''::text) '
               'WITH &&, starts_at WITH <>) WHERE ((status = ANY (ARRAY[''active''::text, ''consumed''::text])))'
      )
      -- Los CHECK, validados y POR SU DEFINICIÓN (la huella de los 42).
      and (select count(*) from pg_catalog.pg_constraint c
            where c.contype = 'c' and c.convalidated and c.conrelid in (select t from tablas)) = 42
      and (select md5(string_agg(c.conname || ':' || regexp_replace(pg_catalog.pg_get_constraintdef(c.oid), '\s+', ' ', 'g'),
                                 '|' order by c.conname))
             from pg_catalog.pg_constraint c
            where c.contype = 'c' and c.conrelid in (select t from tablas))
          = '6c4de3c313d93485fa1dd96dd23ea773'
      -- Los índices por su definición, y TODOS válidos, listos y vivos.
      and (select count(*) from pg_catalog.pg_index i
            where i.indrelid in (select t from tablas)
              and pg_catalog.pg_get_indexdef(i.indexrelid) in (
                'CREATE INDEX service_booking_events_de_la_reserva ON public.service_booking_events '
                'USING btree (booking_id, created_at, id)',
                'CREATE INDEX service_booking_events_de_la_retencion ON public.service_booking_events '
                'USING btree (hold_id, created_at, id)',
                'CREATE INDEX service_bookings_de_la_persona ON public.service_bookings '
                'USING btree (client_id, starts_at, id)',
                'CREATE INDEX service_bookings_del_prestador ON public.service_bookings '
                'USING btree (provider_id, starts_at, id)',
                'CREATE INDEX service_bookings_del_servicio ON public.service_bookings '
                'USING btree (service_id, starts_at)',
                'CREATE INDEX service_holds_de_la_persona ON public.service_holds USING btree (client_id, status)',
                'CREATE INDEX service_holds_ocupan ON public.service_holds USING btree (service_id, occupied_until) '
                'WHERE (status = ANY (ARRAY[''active''::text, ''consumed''::text]))',
                'CREATE INDEX service_holds_por_vencer ON public.service_holds USING btree (expires_at) '
                'WHERE (status = ''active''::text)',
                'CREATE INDEX service_orders_de_la_persona ON public.service_orders '
                'USING btree (client_id, created_at DESC, id DESC)',
                'CREATE INDEX service_orders_del_prestador ON public.service_orders '
                'USING btree (provider_id, created_at DESC, id DESC)',
                'CREATE UNIQUE INDEX service_booking_events_una_por_clave ON public.service_booking_events '
                'USING btree (actor_id, idempotency_key) WHERE (idempotency_key IS NOT NULL)',
                'CREATE UNIQUE INDEX service_holds_una_activa ON public.service_holds '
                'USING btree (service_id, client_id) WHERE (status = ''active''::text)',
                'CREATE UNIQUE INDEX service_holds_una_plaza ON public.service_holds '
                'USING btree (service_id, starts_at, seat) '
                'WHERE (status = ANY (ARRAY[''active''::text, ''consumed''::text]))',
                'CREATE UNIQUE INDEX service_holds_una_por_persona ON public.service_holds '
                'USING btree (service_id, starts_at, client_id) '
                'WHERE (status = ANY (ARRAY[''active''::text, ''consumed''::text]))'
              )) = 14
      and (select count(*) from pg_catalog.pg_index i where i.indrelid in (select t from tablas)) = 25
      and not exists (select 1 from pg_catalog.pg_index i
                       where i.indrelid in (select t from tablas)
                         and not (i.indisvalid and i.indisready and i.indislive))
      -- Los disparadores con su función, su forma y sus argumentos; los tres
      -- que comprueban al confirmar, DIFERIDOS.
      and (select count(*) from disparadores e
             join pg_catalog.pg_trigger g
               on g.tgrelid = to_regclass('public.' || e.tabla) and g.tgname = e.nombre
            where not g.tgisinternal and g.tgenabled in ('O', 'A')
              and g.tgfoid = to_regprocedure('public.' || e.funcion) and g.tgtype = e.tipo
              and pg_catalog.encode(g.tgargs, 'escape') = e.argumentos
              and g.tgdeferrable = e.diferido and g.tginitdeferred = e.diferido) = 15
      and (select count(*) from pg_catalog.pg_trigger g
            where not g.tgisinternal and g.tgrelid in (select t from tablas)) = 15
      and (select count(*) from funciones e
             join pg_catalog.pg_proc p on p.oid = to_regprocedure('public.' || e.firma)
            where not p.prosecdef and p.proconfig = array['search_path=public, pg_temp']
              and md5(replace(p.prosrc, E'\r', '')) = e.huella) = 7
      -- Las condiciones de contratación, un tipo más de las políticas.
      and exists (
        select 1 from pg_catalog.pg_constraint c
         where c.conrelid = to_regclass('public.service_policies') and c.conname = 'service_policies_tipo'
           and c.convalidated
           and pg_catalog.pg_get_constraintdef(c.oid) =
               'CHECK ((kind = ANY (ARRAY[''provider_terms''::text, ''booking_terms''::text])))'
      )
      and exists (select 1 from pg_catalog.pg_extension x where x.extname = 'btree_gist')
      and (select count(*) from pg_catalog.pg_class c
            where c.oid in (select t from tablas) and c.relrowsecurity) = 6
      and not exists (select 1 from pg_catalog.pg_policy p where p.polrelid in (select t from tablas))
      -- Permisos EFECTIVOS: cubren también lo concedido a PUBLIC.
      and not exists (
        select 1 from pg_catalog.pg_roles r, tablas
         where r.rolname in ('anon', 'authenticated')
           and (pg_catalog.has_table_privilege(
                  r.oid, tablas.t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                or pg_catalog.has_any_column_privilege(r.oid, tablas.t, 'SELECT, INSERT, UPDATE, REFERENCES'))
      )
      and not exists (
        select 1 from pg_catalog.pg_roles r, funciones e
         where r.rolname in ('anon', 'authenticated')
           and pg_catalog.has_function_privilege(r.oid, to_regprocedure('public.' || e.firma), 'EXECUTE')
      )
    """
)

#: LA 0093 TAL COMO LA DEJA LA 0094 (Incremento 6): las mismas tablas y
#: columnas (la 0094 no añade ninguna), y SOLO esto distinto:
#:   * los 42 CHECK con otra huella (la reserva admite `cancelled`; el
#:     historial, las acciones y los roles de la atención);
#:   * dos funciones con otro cuerpo (la reserva se cancela y se reprograma;
#:     una retención consumida se libera) y una más;
#:   * un disparador diferido más en `service_bookings`.
#: La reserva vale con una forma O con la otra, y con ninguna más.
_DE_LA_0093_A_LA_0094 = (
    ("'6c4de3c313d93485fa1dd96dd23ea773'", "'c625385d331ce267a4a07e3427201512'"),
    ("('servicios_retencion_salto_valido()', 'c6e5fc3f207d179c3cfaf83a5eec674d'),",
     "('servicios_retencion_salto_valido()', '5a37ab4150365ae451e791626751e46c'),"),
    ("('servicios_reserva_inmutable()', 'ee4296a90773dc6c6ed5d8b4b4888c30'),",
     "('servicios_reserva_inmutable()', 'fe2816a52e615d924e794dd28cff8661'),\n"
     "      ('servicios_reserva_coherente_al_cambiar()', '8b2b9f2986c5bcdc5431de08e43c6ea5'),"),
    ("md5(replace(p.prosrc, E'\\r', '')) = e.huella) = 7", "md5(replace(p.prosrc, E'\\r', '')) = e.huella) = 8"),
    ("      ('service_bookings', 'service_bookings_inmutables', 'servicios_reserva_inmutable()', 19, '', false),",
     "      ('service_bookings', 'service_bookings_coherentes_al_cambiar',\n"
     "       'servicios_reserva_coherente_al_cambiar()', 17, '', true),\n"
     "      ('service_bookings', 'service_bookings_inmutables', 'servicios_reserva_inmutable()', 19, '', false),"),
    ("g.tgdeferrable = e.diferido and g.tginitdeferred = e.diferido) = 15",
     "g.tgdeferrable = e.diferido and g.tginitdeferred = e.diferido) = 16"),
    ("where not g.tgisinternal and g.tgrelid in (select t from tablas)) = 15",
     "where not g.tgisinternal and g.tgrelid in (select t from tablas)) = 16"),
)


def _con_la_0094(sql: str) -> str:
    for de, a in _DE_LA_0093_A_LA_0094:
        if sql.count(de) != 1:  # pragma: no cover - lo vigila la batería de la puerta
            raise RuntimeError(f"La puerta de la reserva cambió y la de la 0094 no la sigue: {de[:60]}")
        sql = sql.replace(de, a)
    return sql


_LO_QUE_NECESITA_LA_RESERVA = text(_SQL_DE_LA_RESERVA)
_LA_RESERVA_CON_LA_0094 = text(_con_la_0094(_SQL_DE_LA_RESERVA))


def _columnas_de_la_reserva(sync) -> bool:  # noqa: ANN001
    from app.modules.services import reserva_models

    tablas = reserva_models.Base.metadata.tables
    inspector = inspect(sync)
    for tabla in TABLAS_DE_LA_RESERVA:
        if not inspector.has_table(tabla):
            return False
        hay = {c["name"] for c in inspector.get_columns(tabla)}
        if not {c.name for c in tablas[tabla].columns} <= hay:
            return False
    return True


async def hay_reservas(db: AsyncSession) -> bool:
    """¿Tiene la base la 0093 COMPLETA? Ante la duda, no. Como el resto: el
    «sí» y el «no» se recuerdan hasta reiniciar; un error al mirar, no."""
    if "reserva" not in _cache:
        try:
            conexion = await db.connection()
            completa = await conexion.run_sync(_columnas_de_la_reserva)
            if completa and conexion.dialect.name == "postgresql":
                # La 0093 tal cual, o tal como la deja la 0094. Ninguna más.
                completa = bool(await db.scalar(_LO_QUE_NECESITA_LA_RESERVA)) or bool(
                    await db.scalar(_LA_RESERVA_CON_LA_0094)
                )
        except Exception:  # noqa: BLE001 - cerrada ante cualquier fallo al mirar
            logger.warning("Servicios: no se pudo comprobar la 0093; la reserva contesta 503.", exc_info=True)
            return False
        _cache["reserva"] = completa
        if not completa:
            logger.warning("Servicios: falta la 0093 completa. La reserva contesta 503.")
    return _cache["reserva"]


async def exigir_reservas(db: AsyncSession) -> None:
    """La agenda (y con ella el catálogo y la admisión), la bandera de la
    contratación y, además, la 0093. Las banderas, sin tocar la base."""
    if not encendido():
        raise ServiciosApagados()
    if not reserva_encendida():
        raise ReservaApagada()
    await exigir_agenda(db)
    if not await hay_reservas(db):
        raise ServiciosSinMigracion()


async def exigir_condiciones_de_contratacion(db: AsyncSession) -> None:
    """Escribir las condiciones de CONTRATACIÓN: Servicios y la 0093 completa
    (es la que amplía el tipo de `service_policies`; sin ella, el borrador
    chocaría con la restricción de la 0086 y sería un 500). NO depende de la
    bandera de la contratación: la empresa puede preparar el texto antes."""
    await exigir_agenda(db)
    if not await hay_reservas(db):
        raise ServiciosSinMigracion()


# --------------------------------------------------------------------------- #
# La atención y la posventa (Incremento 6, migración 0094)
# --------------------------------------------------------------------------- #
TABLAS_DE_LA_ATENCION = (
    "service_attendances",
    "service_incidents",
    "service_incident_entries",
    "service_reviews",
)

#: LO QUE LA 0094 IMPONE Y EL CÓDIGO DA POR HECHO, por DEFINICIÓN. Lo que
#: cambia de la 0093 lo comprueba `_LA_RESERVA_CON_LA_0094`; aquí, lo nuevo:
#:
#:  * cada columna con su tipo, su NOT NULL y su valor predeterminado, y
#:    NINGUNA MÁS;
#:  * las cuatro claves primarias, las seis ajenas con su acción al borrar
#:    (la de la reseña al servicio, sin acción y DIFERIDA: la reseña se va por
#:    un solo camino) y la única (una reseña por reserva);
#:  * los treinta y siete CHECK, validados y por su definición: entre ellos,
#:    que el efecto económico de un caso NO admite un estado «ejecutado»;
#:  * los índices con su definición, y todos válidos, listos y vivos: entre
#:    ellos el ÚNICO PARCIAL que deja un caso por reserva sin contar los
#:    retirados (el código abre un caso nuevo tras uno retirado);
#:  * los ocho disparadores activos con su función, su forma y sus
#:    argumentos, y las tres funciones sin SECURITY DEFINER, con su
#:    `search_path` y su cuerpo (los saltos de la atención y del caso, y la
#:    reseña que solo se guarda con su atención cerrada);
#:  * RLS sin políticas, y nadie de fuera con permisos en una tabla, una
#:    columna o una función (tampoco en `servicios_borrado_solo_en_cascada`);
#:  * el depósito PRIVADO de las evidencias.
_LO_QUE_NECESITA_LA_ATENCION = text(
    r"""
    with
    tablas(t) as (
      select to_regclass('public.' || n)
        from (values ('service_attendances'), ('service_incidents'),
                     ('service_incident_entries'), ('service_reviews')) v(n)
    ),
    columnas(tabla, columna, tipo, obligatoria, defecto) as (values
      ('service_attendances', 'booking_id', 'uuid', true, ''),
      ('service_attendances', 'status', 'text', true, ''),
      ('service_attendances', 'checkin_code', 'text', false, ''),
      ('service_attendances', 'checkin_attempts', 'integer', true, '0'),
      ('service_attendances', 'started_at', 'timestamp with time zone', false, ''),
      ('service_attendances', 'started_with_code', 'boolean', true, 'false'),
      ('service_attendances', 'completed_at', 'timestamp with time zone', false, ''),
      ('service_attendances', 'confirmed_at', 'timestamp with time zone', false, ''),
      ('service_attendances', 'closed_at', 'timestamp with time zone', false, ''),
      ('service_attendances', 'closed_by', 'text', false, ''),
      ('service_attendances', 'no_show_reported_at', 'timestamp with time zone', false, ''),
      ('service_attendances', 'created_at', 'timestamp with time zone', true, 'now()'),
      ('service_attendances', 'updated_at', 'timestamp with time zone', true, 'now()'),
      ('service_incidents', 'id', 'uuid', true, 'gen_random_uuid()'),
      ('service_incidents', 'booking_id', 'uuid', true, ''),
      ('service_incidents', 'opened_by', 'uuid', false, ''),
      ('service_incidents', 'reason', 'text', true, ''),
      ('service_incidents', 'description', 'text', true, ''),
      ('service_incidents', 'status', 'text', true, '''open''::text'),
      ('service_incidents', 'outcome', 'text', false, ''),
      ('service_incidents', 'attention_effect', 'text', false, ''),
      ('service_incidents', 'financial_effect', 'text', false, ''),
      ('service_incidents', 'financial_effect_status', 'text', false, ''),
      ('service_incidents', 'resolved_by', 'uuid', false, ''),
      ('service_incidents', 'resolved_at', 'timestamp with time zone', false, ''),
      ('service_incidents', 'resolutions', 'integer', true, '0'),
      ('service_incidents', 'appealed_by', 'text', false, ''),
      ('service_incidents', 'appealed_at', 'timestamp with time zone', false, ''),
      ('service_incidents', 'created_at', 'timestamp with time zone', true, 'now()'),
      ('service_incidents', 'updated_at', 'timestamp with time zone', true, 'now()'),
      ('service_incident_entries', 'id', 'uuid', true, 'gen_random_uuid()'),
      ('service_incident_entries', 'incident_id', 'uuid', true, ''),
      ('service_incident_entries', 'author_id', 'uuid', false, ''),
      ('service_incident_entries', 'author_role', 'text', true, ''),
      ('service_incident_entries', 'kind', 'text', true, ''),
      ('service_incident_entries', 'body', 'text', false, ''),
      ('service_incident_entries', 'storage_path', 'text', false, ''),
      ('service_incident_entries', 'content_type', 'text', false, ''),
      ('service_incident_entries', 'byte_size', 'integer', false, ''),
      ('service_incident_entries', 'sha256', 'text', false, ''),
      ('service_incident_entries', 'created_at', 'timestamp with time zone', true, 'now()'),
      ('service_reviews', 'id', 'uuid', true, 'gen_random_uuid()'),
      ('service_reviews', 'booking_id', 'uuid', true, ''),
      ('service_reviews', 'service_id', 'uuid', true, ''),
      ('service_reviews', 'author_id', 'uuid', false, ''),
      ('service_reviews', 'rating', 'integer', true, ''),
      ('service_reviews', 'fulfillment', 'integer', false, ''),
      ('service_reviews', 'quality', 'integer', false, ''),
      ('service_reviews', 'punctuality', 'integer', false, ''),
      ('service_reviews', 'clarity', 'integer', false, ''),
      ('service_reviews', 'recommends', 'boolean', true, ''),
      ('service_reviews', 'comment', 'text', true, ''),
      ('service_reviews', 'status', 'text', true, ''),
      ('service_reviews', 'reply', 'text', false, ''),
      ('service_reviews', 'replied_at', 'timestamp with time zone', false, ''),
      ('service_reviews', 'created_at', 'timestamp with time zone', true, 'now()'),
      ('service_reviews', 'updated_at', 'timestamp with time zone', true, 'now()')
    ),
    primarias(tabla, columna) as (values
      ('service_attendances', 'booking_id'), ('service_incidents', 'id'),
      ('service_incident_entries', 'id'), ('service_reviews', 'id')
    ),
    claves(tabla, columna, madre, columna_madre, al_borrar, diferida) as (values
      ('service_attendances', 'booking_id', 'service_bookings', 'id', 'c', false),
      ('service_incidents', 'booking_id', 'service_bookings', 'id', 'c', false),
      ('service_incident_entries', 'incident_id', 'service_incidents', 'id', 'c', false),
      ('service_reviews', 'booking_id', 'service_bookings', 'id', 'c', false),
      ('service_reviews', 'service_id', 'services', 'id', 'a', true),
      ('service_reviews', 'author_id', 'profiles', 'id', 'n', false)
    ),
    unicas(tabla, nombre, definicion) as (values
      ('service_reviews', 'service_reviews_una_por_reserva', 'UNIQUE (booking_id)')
    ),
    disparadores(tabla, nombre, funcion, tipo, argumentos) as (values
      ('service_attendances', 'service_attendances_salto_valido', 'servicios_atencion_salto_valido()', 23, ''),
      ('service_attendances', 'service_attendances_solo_en_cascada',
       'servicios_borrado_solo_en_cascada()', 11, 'service_bookings\000booking_id\000'),
      ('service_incident_entries', 'service_incident_entries_inmutables',
       'servicios_catalogo_historial_inmutable()', 19, ''),
      ('service_incident_entries', 'service_incident_entries_solo_en_cascada',
       'servicios_borrado_solo_en_cascada()', 11, 'service_incidents\000incident_id\000'),
      ('service_incidents', 'service_incidents_salto_valido', 'servicios_incidencia_salto_valido()', 19, ''),
      ('service_incidents', 'service_incidents_solo_en_cascada',
       'servicios_borrado_solo_en_cascada()', 11, 'service_bookings\000booking_id\000'),
      ('service_reviews', 'service_reviews_solo_en_cascada',
       'servicios_borrado_solo_en_cascada()', 11, 'service_bookings\000booking_id\000'),
      ('service_reviews', 'service_reviews_verificadas', 'servicios_resena_verificada()', 23, '')
    ),
    funciones(firma, huella) as (values
      ('servicios_atencion_salto_valido()', 'd21eff4e294599b209d516de4fa39c66'),
      ('servicios_incidencia_salto_valido()', 'aa7f3182efb3a5bd656277725a7f434f'),
      ('servicios_resena_verificada()', '605602c41e62f176e8ee9a58e930aa9a')
    )
    select
      -- Cada columna con su tipo, su NOT NULL y su predeterminado, y ni una más.
      (select count(*) from columnas e
         join pg_catalog.pg_attribute a
           on a.attrelid = to_regclass('public.' || e.tabla) and a.attname = e.columna
          and a.attnum > 0 and not a.attisdropped
         left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where pg_catalog.format_type(a.atttypid, a.atttypmod) = e.tipo and a.attnotnull = e.obligatoria
          and coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '') = e.defecto
      ) = 57
      and (select count(*) from pg_catalog.pg_attribute a
            where a.attrelid in (select t from tablas) and a.attnum > 0 and not a.attisdropped) = 57
      and (select count(*) from primarias e
             join pg_catalog.pg_index i on i.indrelid = to_regclass('public.' || e.tabla)
             join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
            where i.indisprimary and i.indnatts = 1 and a.attname = e.columna) = 4
      -- Las ajenas con su acción al borrar y su aplazamiento, y ninguna más.
      and (select count(*) from claves e
             join pg_catalog.pg_constraint c
               on c.conrelid = to_regclass('public.' || e.tabla)
              and c.confrelid = to_regclass('public.' || e.madre)
             join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
             join pg_catalog.pg_attribute m on m.attrelid = c.confrelid and m.attnum = c.confkey[1]
            where c.contype = 'f' and c.confdeltype = e.al_borrar and c.convalidated
              and c.condeferrable = e.diferida and c.condeferred = e.diferida
              and cardinality(c.conkey) = 1 and a.attname = e.columna and m.attname = e.columna_madre) = 6
      and (select count(*) from pg_catalog.pg_constraint c
            where c.contype = 'f' and c.conrelid in (select t from tablas)) = 6
      and (select count(*) from unicas e
             join pg_catalog.pg_constraint c
               on c.conrelid = to_regclass('public.' || e.tabla) and c.conname = e.nombre
            where c.contype = 'u' and pg_catalog.pg_get_constraintdef(c.oid) = e.definicion) = 1
      and (select count(*) from pg_catalog.pg_constraint c
            where c.contype = 'u' and c.conrelid in (select t from tablas)) = 1
      -- Los CHECK, validados y POR SU DEFINICIÓN (la huella de los 37).
      and (select count(*) from pg_catalog.pg_constraint c
            where c.contype = 'c' and c.convalidated and c.conrelid in (select t from tablas)) = 37
      and (select md5(string_agg(c.conname || ':' || regexp_replace(pg_catalog.pg_get_constraintdef(c.oid), '\s+', ' ', 'g'),
                                 '|' order by c.conname))
             from pg_catalog.pg_constraint c
            where c.contype = 'c' and c.conrelid in (select t from tablas))
          = 'c541cf0a1729dd5c75881a23cf677fcf'
      -- Los índices por su definición, y TODOS válidos, listos y vivos.
      and (select count(*) from pg_catalog.pg_index i
            where i.indrelid in (select t from tablas)
              and pg_catalog.pg_get_indexdef(i.indexrelid) in (
                'CREATE INDEX service_attendances_por_cerrar ON public.service_attendances '
                'USING btree (completed_at) WHERE (status = ''completed''::text)',
                'CREATE INDEX service_incident_entries_del_caso ON public.service_incident_entries '
                'USING btree (incident_id, created_at, id)',
                'CREATE INDEX service_incidents_por_estado ON public.service_incidents '
                'USING btree (status, created_at DESC, id DESC)',
                'CREATE INDEX service_incidents_de_la_reserva ON public.service_incidents '
                'USING btree (booking_id, created_at DESC, id DESC)',
                'CREATE UNIQUE INDEX service_incidents_una_por_reserva ON public.service_incidents '
                'USING btree (booking_id) WHERE (status <> ''withdrawn''::text)',
                'CREATE INDEX service_reviews_del_servicio ON public.service_reviews '
                'USING btree (service_id, status, created_at DESC, id DESC)',
                'CREATE UNIQUE INDEX service_incident_entries_un_archivo ON public.service_incident_entries '
                'USING btree (incident_id, sha256) WHERE (sha256 IS NOT NULL)'
              )) = 7
      and (select count(*) from pg_catalog.pg_index i where i.indrelid in (select t from tablas)) = 12
      and not exists (select 1 from pg_catalog.pg_index i
                       where i.indrelid in (select t from tablas)
                         and not (i.indisvalid and i.indisready and i.indislive))
      -- Los disparadores con su función, su forma y sus argumentos.
      and (select count(*) from disparadores e
             join pg_catalog.pg_trigger g
               on g.tgrelid = to_regclass('public.' || e.tabla) and g.tgname = e.nombre
            where not g.tgisinternal and g.tgenabled in ('O', 'A')
              and g.tgfoid = to_regprocedure('public.' || e.funcion) and g.tgtype = e.tipo
              and pg_catalog.encode(g.tgargs, 'escape') = e.argumentos
              and not g.tgdeferrable) = 8
      and (select count(*) from pg_catalog.pg_trigger g
            where not g.tgisinternal and g.tgrelid in (select t from tablas)) = 8
      and (select count(*) from funciones e
             join pg_catalog.pg_proc p on p.oid = to_regprocedure('public.' || e.firma)
            where not p.prosecdef and p.proconfig = array['search_path=public, pg_temp']
              and md5(replace(p.prosrc, E'\r', '')) = e.huella) = 3
      and (select count(*) from pg_catalog.pg_class c
            where c.oid in (select t from tablas) and c.relrowsecurity) = 4
      and not exists (select 1 from pg_catalog.pg_policy p where p.polrelid in (select t from tablas))
      -- Permisos EFECTIVOS: cubren también lo concedido a PUBLIC.
      and not exists (
        select 1 from pg_catalog.pg_roles r, tablas
         where r.rolname in ('anon', 'authenticated')
           and (pg_catalog.has_table_privilege(
                  r.oid, tablas.t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                or pg_catalog.has_any_column_privilege(r.oid, tablas.t, 'SELECT, INSERT, UPDATE, REFERENCES'))
      )
      and not exists (
        select 1 from pg_catalog.pg_roles r,
               (select firma from funciones
                 union all select 'servicios_reserva_coherente_al_cambiar()'
                 union all select 'servicios_borrado_solo_en_cascada()') e
         where r.rolname in ('anon', 'authenticated')
           and pg_catalog.has_function_privilege(r.oid, to_regprocedure('public.' || e.firma), 'EXECUTE')
      )
      -- El depósito PRIVADO de las evidencias.
      and exists (select 1 from storage.buckets b where b.id = 'service-incident-evidence' and not b.public)
    """
)


def _columnas_de_la_atencion(sync) -> bool:  # noqa: ANN001
    from app.modules.services import atencion_models

    tablas = atencion_models.Base.metadata.tables
    inspector = inspect(sync)
    for tabla in TABLAS_DE_LA_ATENCION:
        if not inspector.has_table(tabla):
            return False
        hay = {c["name"] for c in inspector.get_columns(tabla)}
        if not {c.name for c in tablas[tabla].columns} <= hay:
            return False
    return True


async def hay_atencion(db: AsyncSession) -> bool:
    """¿Tiene la base la 0094 COMPLETA? Lo nuevo, y la 0093 tal como la 0094 la
    deja. Ante la duda, no. Como el resto: el «sí» y el «no» se recuerdan
    hasta reiniciar; un error al mirar, no."""
    if "atencion" not in _cache:
        try:
            conexion = await db.connection()
            completa = await conexion.run_sync(_columnas_de_la_atencion)
            if completa and conexion.dialect.name == "postgresql":
                completa = bool(await db.scalar(_LA_RESERVA_CON_LA_0094)) and bool(
                    await db.scalar(_LO_QUE_NECESITA_LA_ATENCION)
                )
        except Exception:  # noqa: BLE001 - cerrada ante cualquier fallo al mirar
            logger.warning("Servicios: no se pudo comprobar la 0094; la atención contesta 503.", exc_info=True)
            return False
        _cache["atencion"] = completa
        if not completa:
            logger.warning("Servicios: falta la 0094 completa. La atención contesta 503.")
    return _cache["atencion"]


async def exigir_atencion(db: AsyncSession) -> None:
    """La reserva (sus banderas y la 0093) y, además, la 0094."""
    await exigir_reservas(db)
    if not await hay_atencion(db):
        raise ServiciosSinMigracion()


__all__ = [
    "COLUMNAS_DE_LA_0088",
    "ReservaApagada",
    "ServiciosApagados",
    "ServiciosSinMigracion",
    "TABLAS_DEL_CATALOGO",
    "TABLAS_DE_ADMISION",
    "TABLAS_DE_LA_AGENDA",
    "TABLAS_DE_LA_ATENCION",
    "TABLAS_DE_LA_RESERVA",
    "encendido",
    "exigir_agenda",
    "exigir_atencion",
    "exigir_condiciones_de_contratacion",
    "exigir_catalogo",
    "exigir_guardados",
    "exigir_reservas",
    "exigir_servicios",
    "hay_admision",
    "hay_agenda",
    "hay_atencion",
    "hay_catalogo",
    "hay_guardados",
    "hay_reservas",
    "olvidar",
    "olvidar_guardados",
    "reserva_encendida",
]
