"""La migración 0093: la reserva y la contratación protegida (Incremento 5).

1. ESTÁTICA: es la última y sigue a la 0092; una sola transacción que
   comprueba lo anterior antes de crear nada; no concede permisos; de lo ya
   aplicado solo amplía el tipo de `service_policies`; no trae pasarela ni
   dinero; sus límites son los de `reserva_politica`.
2. CONTRA POSTGRESQL: cerrada (RLS, cero políticas, cero privilegios, también
   de columna y de función), IGUAL AL MODELO POR DEFINICIÓN (el ORM creado en
   un esquema aparte), LA DOBLE RESERVA IMPOSIBLE (en serie y con dos
   conexiones a la vez: sesiones que se pisan con su separación, plazas,
   capacidad, una persona por sesión, una retención activa por servicio), los
   saltos de una retención, NINGÚN ESTADO A MEDIAS al confirmar (pedido sin
   reserva, reserva sin pedido o sin su retención, retención consumida sin
   reserva, pedido sin las condiciones aceptadas), un pedido sin dinero, lo
   que no se reescribe ni se borra suelto, y LA BAJA DE UNA CUENTA con
   reservas por venir y pasadas.
3. LA APLICACIÓN: sobre la 0092 con datos no toca nada, se puede reejecutar,
   un fallo a mitad no deja nada, se niega a terminar incompleta y sin cada
   una de sus dependencias no empieza.
"""

from __future__ import annotations

import re
import threading
import time
import uuid

import pytest

from app.modules.services import reserva_politica as limites
from tests.test_migraciones_reales import MIGRACIONES
from tests.test_servicios_migracion_0090 import (
    SIN_POSTGRES,
    URL,
    _falla,
    _foto,
    _hacer,
    _montar,
    _persona,
    _publicada,
    _todas,
    _uno,
    pg,  # noqa: F401 - el montaje de la base, compartido
)

ARCHIVO = MIGRACIONES / "0093_servicios_reserva_y_contratacion.sql"
TEXTO = ARCHIVO.read_text(encoding="utf-8").replace("\r\n", "\n")
SQL = re.sub(r"--[^\n]*", "", TEXTO)

TABLAS = (
    "service_holds",
    "service_orders",
    "service_bookings",
    "service_booking_intakes",
    "service_booking_acceptances",
    "service_booking_events",
)
FUNCIONES = (
    "servicios_retencion_salto_valido",
    "servicios_reserva_inmutable",
    "servicios_reserva_por_venir",
    "servicios_pedido_inmutable",
    "servicios_reserva_coherente",
    "servicios_pedido_completo",
    "servicios_retencion_con_reserva",
)
FUTURO = "2031-03-03 15:00+00"


# =========================================================================== #
# 1. Estática
# =========================================================================== #
def test_es_la_ultima_y_sigue_a_la_0092() -> None:
    nombres = sorted(p.name for p in MIGRACIONES.glob("*.sql"))
    assert nombres[-1] == ARCHIVO.name
    assert nombres[-2].startswith("0092_")


def test_es_una_unica_transaccion_que_comprueba_antes_de_crear() -> None:
    sentencias = [s.strip() for s in SQL.split(";") if s.strip()]
    assert sentencias[0] == "begin" and sentencias[-1] == "commit"
    assert SQL.index("raise exception 'La 0093 requiere") < SQL.index("create table")
    assert SQL.index("raise exception 'La 0093 requiere") < SQL.index("alter table public.service_policies")


def test_no_concede_ni_toca_lo_aplicado_mas_que_el_tipo_de_las_politicas() -> None:
    minusculas = SQL.lower()
    assert " grant " not in f" {minusculas} "
    assert "drop table" not in minusculas and "truncate" not in minusculas
    # De lo ya aplicado, UNA cosa: el CHECK del tipo de `service_policies`.
    alterada = set(re.findall(r"alter table (?:if exists )?public\.(\w+)", minusculas))
    assert alterada == {"service_policies"} | set(TABLAS)
    assert re.findall(r"alter table public\.service_policies[^;]*;", minusculas) == [
        "alter table public.service_policies drop constraint if exists service_policies_tipo;",
        "alter table public.service_policies\n  add constraint service_policies_tipo\n"
        "  check (kind in ('provider_terms', 'booking_terms'));",
    ]
    assert "insert into public.service_policies" not in minusculas  # no publica nada


def test_no_trae_pasarela_ni_dinero() -> None:
    minusculas = SQL.lower()
    for palabra in ("stripe", "payment_intent", "external_payment_id", "refund", "transfer", "balance"):
        assert palabra not in minusculas, palabra
    assert "check (price_model in ('free'))" in minusculas
    assert "check (payment_status in ('not_required'))" in minusculas
    assert "check (payment_provider in ('none'))" in minusculas
    assert "price_minor is null and currency is null and total_minor = 0" in minusculas


def test_sus_limites_son_los_de_la_politica() -> None:
    assert f"length(trim(note)) between 1 and {limites.NOTA_MAXIMA}" in SQL
    assert f"length(trim(district)) between 1 and {limites.DISTRITO_MAXIMO}" in SQL
    assert f"length(trim(address_line)) between 1 and {limites.DIRECCION_MAXIMA}" in SQL
    assert f"length(trim(address_reference)) between 1 and {limites.REFERENCIA_MAXIMA}" in SQL
    assert f"'{limites.ALFABETO_DEL_CODIGO}'" in SQL


# =========================================================================== #
# 2. Contra PostgreSQL
# =========================================================================== #
def _politica(pg, admin: str, *, pais: str = "PE") -> str:
    texto = "Condiciones de contratación de Z para probar la reserva y su aceptación versionada."
    return str(_uno(
        pg,
        "insert into public.service_policies (kind, country_code, version, status, title, body, body_sha256, "
        "effective_at, published_at, published_by) values ('booking_terms', %s, "
        "coalesce((select max(version) from public.service_policies where kind = 'booking_terms' "
        "and country_code = %s), 0) + 1, 'published', 'Condiciones', %s, repeat('a', 64), now(), now(), %s) "
        "returning id",
        pais, pais, texto, admin,
    ))


def _retencion(pg, servicio: str, version: str, cliente: str | None, *, inicio: str = FUTURO, minutos: int = 60,
               antes: int = 0, despues: int = 0, plaza: int = 1, capacidad: int = 1, estado: str = "active") -> str:
    return str(_uno(
        pg,
        "insert into public.service_holds (service_id, version_id, client_id, status, starts_at, ends_at, "
        "occupied_from, occupied_until, timezone, local_date, modality, capacity, seat, expires_at, "
        "released_at, expired_at) values (%s, %s, %s, %s, %s::timestamptz, %s::timestamptz + make_interval(mins => %s), "
        "%s::timestamptz - make_interval(mins => %s), %s::timestamptz + make_interval(mins => %s + %s), "
        "'America/Lima', (%s::timestamptz at time zone 'America/Lima')::date, 'virtual', %s, %s, now() + interval '10 minutes', "
        "case when %s = 'released' then now() end, case when %s = 'expired' then now() end) returning id",
        servicio, version, cliente, estado, inicio, inicio, minutos, inicio, antes, inicio, minutos, despues, inicio,
        capacidad, plaza, estado, estado,
    ))


def _contratar(pg, servicio: str, version: str, prestador: str, cliente: str, politica: str, retencion: str, *,
               nota: str | None = "Traigo mis facturas.") -> tuple[str, str]:
    """Lo que hace la API al confirmar, en una transacción: `(pedido, reserva)`."""
    with pg.transaction():
        pedido = str(_uno(
            pg,
            "insert into public.service_orders (service_id, version_id, provider_id, client_id, environment, "
            "price_model, title_snapshot, provider_name_snapshot, confirmed_at) values (%s, %s, %s, %s, 'sandbox', "
            "'free', 'Asesoría', 'Ana', now()) returning id",
            servicio, version, prestador, cliente,
        ))
        reserva = str(_uno(
            pg,
            "insert into public.service_bookings (booking_code, order_id, hold_id, service_id, version_id, "
            "provider_id, client_id, starts_at, ends_at, occupied_from, occupied_until, timezone, local_date, "
            "modality, duration_minutes, buffer_before_minutes, buffer_after_minutes, capacity, seat, "
            "title_snapshot, provider_name_snapshot, confirmed_at) "
            "select %s, %s, h.id, h.service_id, h.version_id, %s, h.client_id, h.starts_at, h.ends_at, "
            "h.occupied_from, h.occupied_until, h.timezone, h.local_date, h.modality, "
            "(extract(epoch from h.ends_at - h.starts_at) / 60)::int, "
            "(extract(epoch from h.starts_at - h.occupied_from) / 60)::int, "
            "(extract(epoch from h.occupied_until - h.ends_at) / 60)::int, h.capacity, h.seat, 'Asesoría', 'Ana', now() "
            "from public.service_holds h where h.id = %s returning id",
            _codigo(), pedido, prestador, retencion,
        ))
        if nota:
            _hacer(pg, "insert into public.service_booking_intakes (booking_id, client_id, note) values (%s, %s, %s)",
                   reserva, cliente, nota)
        _hacer(pg, "insert into public.service_booking_acceptances (order_id, kind, policy_id, policy_version, sha256, "
                   "accepted_by, accepted_at) values (%s, 'booking_terms', %s, 1, repeat('a', 64), %s, now())",
               pedido, politica, cliente)
        _hacer(pg, "update public.service_holds set status = 'consumed', consumed_at = now(), updated_at = now() "
                   "where id = %s", retencion)
        _hacer(pg, "insert into public.service_booking_events (service_id, hold_id, booking_id, action, from_status, "
                   "to_status, actor_id, actor_role, idempotency_key) values (%s, %s, %s, 'booking_confirmed', "
                   "'active', 'confirmed', %s, 'client', %s)", servicio, retencion, reserva, cliente,
               f"clave-{uuid.uuid4().hex}")
    return pedido, reserva


def _codigo() -> str:
    import secrets

    letras = "".join(secrets.choice(limites.ALFABETO_DEL_CODIGO) for _ in range(8))
    return f"{letras[:4]}-{letras[4:]}"


def _mundo(pg) -> dict:
    """Un servicio publicado, su prestador, una persona y las condiciones de
    contratación publicadas."""
    admin = _persona(pg, "admin")
    perfil, prestador, servicio, version = _publicada(pg, admin)
    return {
        "admin": admin, "perfil": perfil, "prestador": prestador, "servicio": servicio, "version": version,
        "cliente": _persona(pg), "politica": _politica(pg, admin),
    }


def _hueco(pg, sql: str, *args) -> str:
    """Lo que la base rechaza al CONFIRMAR la transacción."""
    import psycopg

    with pytest.raises(psycopg.Error) as error:
        with pg.transaction():
            _hacer(pg, sql, *args)
    return str(error.value)


@SIN_POSTGRES
def test_desde_cero_queda_cerrada(pg) -> None:  # noqa: F811
    _montar(pg)
    for tabla in TABLAS:
        assert _uno(pg, "select relrowsecurity from pg_class where oid = %s::regclass", f"public.{tabla}"), tabla
        assert _uno(pg, "select count(*) from pg_policies where schemaname = 'public' and tablename = %s", tabla) == 0
        for rol in ("anon", "authenticated", "public"):
            for privilegio in ("select", "insert", "update", "delete", "truncate", "references", "trigger"):
                assert not _uno(pg, "select has_table_privilege(%s, %s, %s)", rol, f"public.{tabla}", privilegio), (
                    tabla, rol, privilegio)
            for privilegio in ("select", "insert", "update", "references"):
                assert not _uno(pg, "select has_any_column_privilege(%s, %s, %s)", rol, f"public.{tabla}",
                                privilegio), (tabla, rol, privilegio)
    for funcion in FUNCIONES:
        for rol in ("anon", "authenticated", "public"):
            assert not _uno(pg, "select has_function_privilege(%s, %s, 'execute')", rol, f"public.{funcion}()"), (
                funcion, rol)
        assert not _uno(pg, "select prosecdef from pg_proc where oid = %s::regprocedure", f"public.{funcion}()")


@SIN_POSTGRES
def test_es_igual_al_modelo_por_definicion(pg) -> None:  # noqa: F811
    """El ORM, creado de verdad en PostgreSQL en un esquema aparte, tiene las
    mismas columnas (tipo y nulabilidad), CHECK (por definición), índices,
    claves y únicas que la migración. Lo que solo declara la base (la
    exclusión, los disparadores) es lo único que falta en el ORM."""
    from sqlalchemy import Column, MetaData, Table, Uuid, create_engine

    from app.modules.services import reserva_models

    _montar(pg)
    _hacer(pg, "drop schema if exists orm_0093 cascade")
    _hacer(pg, "create schema orm_0093")
    copia = MetaData(schema="orm_0093")
    for madre in ("services", "service_versions", "service_providers", "profiles", "service_policies"):
        Table(madre, copia, Column("id", Uuid(as_uuid=False), primary_key=True))
    for nombre in TABLAS:
        reserva_models.Base.metadata.tables[nombre].to_metadata(copia, schema="orm_0093")
    motor = create_engine(URL.replace("postgresql://", "postgresql+psycopg://"))
    try:
        with motor.begin() as conexion:
            copia.create_all(conexion)
    finally:
        motor.dispose()

    def _limpia(definicion: str) -> str:
        return re.sub(r"\s+", " ", definicion.replace("orm_0093.", "").replace("public.", "")).strip()

    for tabla in TABLAS:
        def _de(esquema: str) -> dict:
            relacion = f"{esquema}.{tabla}"
            return {
                "columnas": _todas(
                    pg,
                    "select a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull from pg_attribute a "
                    "where a.attrelid = %s::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum",
                    relacion,
                ),
                "restricciones": sorted(
                    (n, t, _limpia(d)) for n, t, d in _todas(
                        pg,
                        "select conname, contype::text, pg_get_constraintdef(oid) from pg_constraint "
                        "where contype in ('c', 'f', 'p', 'u') and conrelid = %s::regclass",
                        relacion,
                    )
                ),
                "indices": sorted(
                    _limpia(d) for (d,) in _todas(
                        pg,
                        "select pg_get_indexdef(i.indexrelid) from pg_index i where i.indrelid = %s::regclass "
                        "and not i.indisprimary and not i.indisexclusion",
                        relacion,
                    )
                ),
            }

        migracion, modelo = _de("public"), _de("orm_0093")
        assert migracion == modelo, tabla
    _hacer(pg, "drop schema orm_0093 cascade")


# --- La doble reserva ------------------------------------------------------- #
@SIN_POSTGRES
def test_dos_sesiones_que_se_pisan_no_caben_ni_con_la_separacion(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    s, v = m["servicio"], m["version"]
    otra = _persona(pg)
    # 15:00–16:00 con 15 de descanso ocupa hasta las 16:15.
    _retencion(pg, s, v, m["cliente"], inicio="2031-03-03 15:00+00", despues=15)
    # Tocarse no es pisarse: la de las 16:15 cabe.
    _retencion(pg, s, v, otra, inicio="2031-03-03 16:15+00")
    # La de las 16:00 se pisa con el descanso de la primera: la exclusión la rechaza.
    tercera = _persona(pg)
    assert "service_holds_sin_cruces" in _falla(pg, _insertar_retencion_sql(s, v, tercera, "2031-03-03 16:00+00"))
    # Y con la preparación: 17:30 con 90 de preparación empieza a ocupar a las 16:00.
    assert "service_holds_sin_cruces" in _falla(
        pg, _insertar_retencion_sql(s, v, tercera, "2031-03-03 17:30+00", antes=90)
    )


def _insertar_retencion_sql(servicio: str, version: str, cliente: str, inicio: str, *, antes: int = 0,
                            plaza: int = 1, capacidad: int = 1) -> str:
    return (
        "insert into public.service_holds (service_id, version_id, client_id, starts_at, ends_at, occupied_from, "
        "occupied_until, timezone, local_date, modality, capacity, seat, expires_at) values "
        f"('{servicio}', '{version}', '{cliente}', '{inicio}'::timestamptz, '{inicio}'::timestamptz + interval '60 minutes', "
        f"'{inicio}'::timestamptz - interval '{antes} minutes', '{inicio}'::timestamptz + interval '60 minutes', "
        f"'America/Lima', '2031-03-03', 'virtual', {capacidad}, {plaza}, now() + interval '10 minutes')"
    )


@SIN_POSTGRES
def test_una_sesion_tiene_sus_plazas_y_ni_una_mas(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    s, v = m["servicio"], m["version"]
    a, b, c = _persona(pg), _persona(pg), _persona(pg)
    _retencion(pg, s, v, a, plaza=1, capacidad=2)
    _retencion(pg, s, v, b, plaza=2, capacidad=2)
    # La misma plaza, no.
    assert "service_holds_una_plaza" in _falla(pg, _insertar_retencion_sql(s, v, c, FUTURO, plaza=2, capacidad=2))
    # Una plaza más allá de la capacidad, tampoco.
    assert "service_holds_plaza" in _falla(pg, _insertar_retencion_sql(s, v, c, FUTURO, plaza=3, capacidad=2))
    # La misma persona no ocupa dos plazas de la misma sesión.
    assert "service_holds_una_por_persona" in _falla(pg, _insertar_retencion_sql(s, v, a, FUTURO, plaza=3, capacidad=3))


@SIN_POSTGRES
def test_una_retencion_activa_por_servicio_y_lo_soltado_ya_no_ocupa(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    s, v, cliente = m["servicio"], m["version"], m["cliente"]
    primera = _retencion(pg, s, v, cliente)
    assert "service_holds_una_activa" in _falla(
        pg, _insertar_retencion_sql(s, v, cliente, "2031-03-04 15:00+00")
    )
    _hacer(pg, "update public.service_holds set status = 'released', released_at = now(), updated_at = now() "
               "where id = %s", primera)
    # Soltada, ni ocupa ni cuenta como activa: el mismo horario vuelve a caber.
    _retencion(pg, s, v, cliente)
    otra = _persona(pg)
    _hacer(pg, "update public.service_holds set status = 'expired', expired_at = now(), updated_at = now() "
               "where client_id = %s and status = 'active'", cliente)
    _retencion(pg, s, v, otra)


@SIN_POSTGRES
def test_dos_conexiones_a_la_vez_no_dejan_dos_sesiones_que_se_pisan(pg) -> None:  # noqa: F811
    """SIN el cerrojo de la API: la base sola. Una gana; la otra se rechaza
    (exclusión, o interbloqueo si las dos llegan a comprobar a la vez)."""
    import psycopg

    _montar(pg)
    m = _mundo(pg)
    s, v = m["servicio"], m["version"]
    personas = [_persona(pg), _persona(pg)]
    errores: list[str] = []
    hechas: list[int] = []
    barrera = threading.Barrier(2)

    def intentar(i: int) -> None:
        with psycopg.connect(URL, autocommit=False) as cn, cn.cursor() as cur:
            try:
                barrera.wait()
                cur.execute(_insertar_retencion_sql(s, v, personas[i], f"2031-03-03 15:{i * 30:02d}+00"))
                time.sleep(0.3)
                cn.commit()
                hechas.append(i)
            except psycopg.Error as error:
                cn.rollback()
                errores.append(getattr(error, "sqlstate", "") or "")

    hilos = [threading.Thread(target=intentar, args=(i,)) for i in range(2)]
    for h in hilos:
        h.start()
    for h in hilos:
        h.join()
    assert len(hechas) == 1 and len(errores) == 1, (hechas, errores)
    assert errores[0] in ("23P01", "40P01")
    assert _uno(pg, "select count(*) from public.service_holds where service_id = %s", s) == 1


# --- Los saltos y los estados a medias -------------------------------------- #
@SIN_POSTGRES
def test_los_saltos_de_una_retencion(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    s, v, cliente = m["servicio"], m["version"], m["cliente"]
    h = _retencion(pg, s, v, cliente)
    # Sin cambiar de estado no hay nada que actualizar.
    assert "no permitido" in _falla(pg, "update public.service_holds set updated_at = now() where id = %s", h)
    # Y la fotografía no se reescribe, ni aprovechando un salto.
    assert "no se reescribe" in _falla(pg, "update public.service_holds set status = 'released', released_at = now(), "
                                          "starts_at = starts_at + interval '5 minutes' where id = %s", h)
    # Un estado final sin su momento, no.
    assert "service_holds_momentos" in _falla(pg, "update public.service_holds set status = 'released' where id = %s", h)
    _hacer(pg, "update public.service_holds set status = 'released', released_at = now(), updated_at = now() "
               "where id = %s", h)
    # De un estado final no se vuelve.
    assert "ya no cambia" in _falla(pg, "update public.service_holds set status = 'active', released_at = null "
                                       "where id = %s", h)
    assert "ya no cambia" in _falla(pg, "update public.service_holds set status = 'expired', released_at = null, "
                                       "expired_at = now() where id = %s", h)


@SIN_POSTGRES
def test_ningun_estado_a_medias_al_confirmar(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    s, v, p, cliente = m["servicio"], m["version"], m["prestador"], m["cliente"]
    h = _retencion(pg, s, v, cliente)
    # Una retención consumida SIN su reserva.
    assert "tiene su reserva" in _hueco(
        pg, "update public.service_holds set status = 'consumed', consumed_at = now(), updated_at = now() "
            "where id = %s", h)
    # Un pedido SIN su reserva.
    assert "sin su reserva" in _hueco(
        pg, "insert into public.service_orders (service_id, version_id, provider_id, client_id, environment, "
            "price_model, title_snapshot, provider_name_snapshot, confirmed_at) values (%s, %s, %s, %s, 'sandbox', "
            "'free', 'A', 'B', now())", s, v, p, cliente)
    # Una reserva cuya retención sigue ACTIVA (no nace de una consumida).
    import psycopg

    with pytest.raises(psycopg.Error) as error:
        with pg.transaction():
            pedido = _uno(
                pg, "insert into public.service_orders (service_id, version_id, provider_id, client_id, environment, "
                    "price_model, title_snapshot, provider_name_snapshot, confirmed_at) values (%s, %s, %s, %s, "
                    "'sandbox', 'free', 'A', 'B', now()) returning id", s, v, p, cliente)
            _hacer(pg, "insert into public.service_booking_acceptances (order_id, kind, policy_id, policy_version, "
                       "sha256, accepted_at) values (%s, 'booking_terms', %s, 1, repeat('a', 64), now())",
                   pedido, m["politica"])
            _hacer(pg, "insert into public.service_bookings (booking_code, order_id, hold_id, service_id, version_id, "
                       "provider_id, client_id, starts_at, ends_at, occupied_from, occupied_until, timezone, "
                       "local_date, modality, duration_minutes, buffer_before_minutes, buffer_after_minutes, capacity, "
                       "seat, title_snapshot, provider_name_snapshot, confirmed_at) select %s, %s, id, service_id, "
                       "version_id, %s, client_id, starts_at, ends_at, occupied_from, occupied_until, timezone, "
                       "local_date, modality, 60, 0, 0, capacity, seat, 'A', 'B', now() from public.service_holds "
                       "where id = %s", _codigo(), pedido, p, h)
    assert "retención consumida" in str(error.value)
    # Un pedido sin las condiciones aceptadas: sin la fila de `booking_terms`.
    with pytest.raises(psycopg.Error) as error:
        with pg.transaction():
            _contratar_sin_condiciones(pg, m, h)
    assert "condiciones aceptadas" in str(error.value)
    # Y completo, sí.
    pedido, reserva = _contratar(pg, s, v, p, cliente, m["politica"], h)
    assert _uno(pg, "select status from public.service_holds where id = %s", h) == "consumed"
    assert _uno(pg, "select order_id::text from public.service_bookings where id = %s", reserva) == pedido


def _contratar_sin_condiciones(pg, m: dict, retencion: str) -> None:
    pedido = _uno(
        pg, "insert into public.service_orders (service_id, version_id, provider_id, client_id, environment, "
            "price_model, title_snapshot, provider_name_snapshot, confirmed_at) values (%s, %s, %s, %s, 'sandbox', "
            "'free', 'A', 'B', now()) returning id", m["servicio"], m["version"], m["prestador"], m["cliente"])
    _hacer(pg, "insert into public.service_bookings (booking_code, order_id, hold_id, service_id, version_id, "
               "provider_id, client_id, starts_at, ends_at, occupied_from, occupied_until, timezone, local_date, "
               "modality, duration_minutes, buffer_before_minutes, buffer_after_minutes, capacity, seat, "
               "title_snapshot, provider_name_snapshot, confirmed_at) select %s, %s, id, service_id, version_id, %s, "
               "client_id, starts_at, ends_at, occupied_from, occupied_until, timezone, local_date, modality, 60, 0, 0, "
               "capacity, seat, 'A', 'B', now() from public.service_holds where id = %s",
           _codigo(), pedido, m["prestador"], retencion)
    _hacer(pg, "update public.service_holds set status = 'consumed', consumed_at = now(), updated_at = now() "
               "where id = %s", retencion)


@SIN_POSTGRES
def test_un_pedido_no_tiene_dinero_ni_pasarela(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    base = ("insert into public.service_orders (service_id, version_id, provider_id, client_id, environment, "
            "price_model, price_minor, currency, total_minor, payment_status, payment_provider, status, "
            "title_snapshot, provider_name_snapshot, confirmed_at) values (%s, %s, %s, %s, 'sandbox', {}, now())")
    ids = (m["servicio"], m["version"], m["prestador"], m["cliente"])
    for valores, restriccion in (
        ("'fixed', null, null, 0, 'not_required', 'none', 'confirmed', 'A', 'B'", "service_orders_modelo"),
        ("'free', 15000, 'PEN', 15000, 'not_required', 'none', 'confirmed', 'A', 'B'", "service_orders_sin_dinero"),
        ("'free', null, null, 0, 'paid', 'none', 'confirmed', 'A', 'B'", "service_orders_pago"),
        ("'free', null, null, 0, 'not_required', 'stripe', 'confirmed', 'A', 'B'", "service_orders_pasarela"),
        ("'free', null, null, 0, 'not_required', 'none', 'pending_payment', 'A', 'B'", "service_orders_estado"),
    ):
        assert restriccion in _falla(pg, base.format(valores), *ids), restriccion


@SIN_POSTGRES
def test_lo_contratado_no_se_reescribe_ni_se_borra_suelto(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    h = _retencion(pg, m["servicio"], m["version"], m["cliente"])
    pedido, reserva = _contratar(pg, m["servicio"], m["version"], m["prestador"], m["cliente"], m["politica"], h)
    assert "no se reescribe" in _falla(pg, "update public.service_bookings set title_snapshot = 'Otro' where id = %s",
                                       reserva)
    assert "no se reescribe" in _falla(pg, "update public.service_orders set title_snapshot = 'Otro' where id = %s",
                                       pedido)
    for tabla in ("service_booking_acceptances", "service_booking_events", "service_booking_intakes"):
        assert "solo se añade" in _falla(pg, f"update public.{tabla} set created_at = now()"
                                         if tabla == "service_booking_intakes" else
                                         f"update public.{tabla} set accepted_at = now()"
                                         if tabla == "service_booking_acceptances" else
                                         f"update public.{tabla} set details = '{{}}'"), tabla
    assert "por venir" in _falla(pg, "delete from public.service_bookings where id = %s", reserva)
    for tabla in ("service_holds", "service_orders", "service_booking_events"):
        assert "no se borra" in _falla(pg, f"delete from public.{tabla} where service_id = %s", m["servicio"]), tabla
    # Una política aceptada no se borra (publicada, y con aceptaciones).
    _falla(pg, "delete from public.service_policies where id = %s", m["politica"])
    assert _uno(pg, "select count(*) from public.service_policies where id = %s", m["politica"]) == 1


# --- La baja de una cuenta --------------------------------------------------- #
@SIN_POSTGRES
def test_la_baja_espera_mientras_haya_una_reserva_por_venir(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    h = _retencion(pg, m["servicio"], m["version"], m["cliente"])
    _contratar(pg, m["servicio"], m["version"], m["prestador"], m["cliente"], m["politica"], h)
    # Ni la de quien contrata…
    assert "por venir" in _falla(pg, "delete from auth.users where id = %s", m["cliente"])
    # …ni la de quien presta.
    assert "por venir" in _falla(pg, "delete from auth.users where id = %s", m["perfil"])
    assert _uno(pg, "select count(*) from public.profiles where id in (%s, %s)", m["cliente"], m["perfil"]) == 2


@SIN_POSTGRES
def test_la_baja_con_reservas_pasadas_anonimiza_y_se_lleva_lo_privado(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    h = _retencion(pg, m["servicio"], m["version"], m["cliente"], inicio="2021-03-03 15:00+00")
    pedido, reserva = _contratar(pg, m["servicio"], m["version"], m["prestador"], m["cliente"], m["politica"], h,
                                 nota="Mi dirección y mis datos")
    _hacer(pg, "delete from auth.users where id = %s", m["cliente"])
    # La reserva y el pedido se quedan, SIN la persona; su nota se fue con ella.
    assert _uno(pg, "select client_id from public.service_bookings where id = %s", reserva) is None
    assert _uno(pg, "select client_id from public.service_orders where id = %s", pedido) is None
    assert _uno(pg, "select client_id from public.service_holds where id = %s", h) is None
    assert _uno(pg, "select count(*) from public.service_booking_intakes where booking_id = %s", reserva) == 0
    # Lo aceptado y el historial se quedan (quién actuó no tiene clave ajena).
    assert _uno(pg, "select count(*) from public.service_booking_acceptances where order_id = %s", pedido) == 1
    assert _uno(pg, "select count(*) from public.service_booking_events where booking_id = %s", reserva) == 1
    # Y la cuenta del prestador, sin reservas por venir, se lleva su servicio entero.
    _hacer(pg, "delete from auth.users where id = %s", m["perfil"])
    for tabla in ("service_holds", "service_orders", "service_bookings", "service_booking_events"):
        assert _uno(pg, f"select count(*) from public.{tabla} where service_id = %s", m["servicio"]) == 0, tabla


@SIN_POSTGRES
def test_la_baja_de_quien_presta_no_depende_del_orden_de_los_disparadores(pg) -> None:  # noqa: F811
    """Hallazgo de la revisión del 30/09. Del prestador salían DOS caminos de
    borrado hacia sus pedidos y reservas: por el servicio (0090) y directo por
    `provider_id`. PostgreSQL dispara los disparadores de las claves ajenas por
    el orden de su nombre (su OID): con el directo antes, el pedido se borraba
    con su servicio vivo y `solo_en_cascada` lo impedía. Aquí se fuerza ese
    orden recreando la clave del servicio (su disparador pasa a ser el
    último)."""
    _montar(pg)
    m = _mundo(pg)
    h = _retencion(pg, m["servicio"], m["version"], m["cliente"], inicio="2021-03-03 15:00+00")
    pedido, reserva = _contratar(pg, m["servicio"], m["version"], m["prestador"], m["cliente"], m["politica"], h)
    nombre = _uno(pg, "select conname from pg_catalog.pg_constraint where conrelid = 'public.services'::regclass "
                      "and contype = 'f' and confrelid = 'public.service_providers'::regclass")
    definicion = _uno(pg, "select pg_get_constraintdef(oid) from pg_catalog.pg_constraint "
                          "where conrelid = 'public.services'::regclass and conname = %s", nombre)
    with pg.transaction():
        _hacer(pg, f'alter table public.services drop constraint "{nombre}"')
        _hacer(pg, f'alter table public.services add constraint "{nombre}" {definicion}')
    orden = [t for (t,) in _todas(
        pg,
        "select c.conrelid::regclass::text from pg_catalog.pg_trigger t "
        "join pg_catalog.pg_constraint c on c.oid = t.tgconstraint "
        "where t.tgrelid = 'public.service_providers'::regclass and c.contype = 'f' "
        "and c.conrelid in ('public.services'::regclass, 'public.service_orders'::regclass, "
        "'public.service_bookings'::regclass) and t.tgtype & 8 = 8 order by t.tgname collate \"C\"",
    )]
    assert orden[-1] == "services", orden
    _hacer(pg, "delete from auth.users where id = %s", m["perfil"])
    assert _uno(pg, "select count(*) from public.services where id = %s", m["servicio"]) == 0
    for tabla in ("service_holds", "service_orders", "service_bookings", "service_booking_events"):
        assert _uno(pg, f"select count(*) from public.{tabla} where service_id = %s", m["servicio"]) == 0, tabla
    assert _uno(pg, "select count(*) from public.service_booking_acceptances where order_id = %s", pedido) == 0
    assert reserva


@SIN_POSTGRES
def test_las_claves_al_prestador_no_borran_y_se_comprueban_al_confirmar(pg) -> None:  # noqa: F811
    """Un pedido o una reserva de un prestador que ya no existe no se guarda:
    la clave se comprueba, aunque sea al confirmar la transacción."""
    import psycopg

    _montar(pg)
    m = _mundo(pg)
    h = _retencion(pg, m["servicio"], m["version"], m["cliente"])
    with pytest.raises(psycopg.Error) as error:
        _contratar(pg, m["servicio"], m["version"], str(uuid.uuid4()), m["cliente"], m["politica"], h)
    assert "_provider_id_fkey" in str(error.value), str(error.value)
    for tabla in ("service_orders", "service_bookings"):
        assert _uno(pg, f"select count(*) from public.{tabla}") == 0, tabla


@SIN_POSTGRES
def test_las_politicas_admiten_las_condiciones_de_contratacion_y_nada_mas(pg) -> None:  # noqa: F811
    _montar(pg)
    admin = _persona(pg, "admin")
    assert _politica(pg, admin)
    assert "service_policies_tipo" in _falla(
        pg, "insert into public.service_policies (kind, country_code, version, title, body, body_sha256) values "
            "('cancellation', 'PE', 1, 'X', repeat('x', 60), repeat('a', 64))")


# =========================================================================== #
# 3. La aplicación
# =========================================================================== #
def _huellas(pg, tablas: tuple[str, ...]) -> dict:
    return {
        t: _uno(pg, f"select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.{t} t")
        for t in tablas
    }


@SIN_POSTGRES
def test_sobre_la_0092_con_datos_no_toca_nada(pg) -> None:  # noqa: F811
    _montar(pg, hasta="0092")
    admin = _persona(pg, "admin")
    perfil, _, servicio, _ = _publicada(pg, admin)
    _hacer(pg, "insert into public.service_schedules (service_id, timezone) values (%s, 'America/Lima')", servicio)
    _hacer(pg, "insert into public.service_schedule_rules (service_id, weekday, start_minute, end_minute, modality) "
               "values (%s, 1, 540, 720, 'virtual')", servicio)
    _hacer(pg, "insert into public.saved_services (profile_id, service_id, title_at_save) values (%s, %s, 'A')",
           _persona(pg), servicio)
    tablas = ("profiles", "service_providers", "services", "service_versions", "service_events", "saved_services",
              "service_schedules", "service_schedule_rules", "service_policies")
    antes = _huellas(pg, tablas)
    _hacer(pg, TEXTO)
    assert _huellas(pg, tablas) == antes
    for tabla in TABLAS:
        assert _uno(pg, f"select count(*) from public.{tabla}") == 0


@SIN_POSTGRES
def test_reejecutarla_deja_exactamente_lo_mismo(pg) -> None:  # noqa: F811
    _montar(pg)
    antes = _foto(pg)
    _hacer(pg, TEXTO)
    assert _foto(pg) == antes


@SIN_POSTGRES
def test_un_fallo_a_mitad_no_deja_nada(pg) -> None:  # noqa: F811
    import psycopg

    _montar(pg, hasta="0092")
    tipo_antes = _uno(pg, "select pg_get_constraintdef(oid) from pg_constraint where conname = 'service_policies_tipo'")
    corte = TEXTO.index("-- 11. Lo que tiene que quedar, o nada.")
    with pytest.raises(psycopg.Error):
        _hacer(pg, TEXTO[:corte] + "\nselect 1 / 0;\ncommit;\n")
    _hacer(pg, "rollback")
    for tabla in TABLAS:
        assert _uno(pg, "select to_regclass(%s)", f"public.{tabla}") is None, tabla
    for funcion in FUNCIONES:
        assert _uno(pg, "select to_regprocedure(%s)", f"public.{funcion}()") is None, funcion
    assert _uno(pg, "select pg_get_constraintdef(oid) from pg_constraint "
                    "where conname = 'service_policies_tipo'") == tipo_antes


def _deshacer_segun_la_cabecera() -> str:
    """El ROLLBACK tal como lo documenta la cabecera de la 0093."""
    inicio = TEXTO.index("-- ROLLBACK")
    fin = TEXTO.index("-- Las condiciones de contratación YA PUBLICADAS", inicio)
    return "\n".join(linea[2:] for linea in TEXTO[inicio:fin].splitlines() if linea.startswith("--   "))


@SIN_POSTGRES
def test_el_rollback_de_la_cabecera_funciona_con_condiciones_publicadas(pg) -> None:  # noqa: F811
    """Hallazgo de la revisión del 30/09. El procedimiento borraba las
    condiciones de contratación, y la 0086 no deja borrar una política
    publicada: fallaba justo cuando haría falta (publicarlas es obligatorio
    antes de encender la reserva). Ahora deja las publicadas, borra los
    borradores y solo estrecha el tipo si no queda ninguna."""
    _montar(pg, hasta="0092")
    tipo_de_la_0086 = _uno(pg, "select pg_get_constraintdef(oid) from pg_catalog.pg_constraint "
                               "where conname = 'service_policies_tipo'")
    deshacer = _deshacer_segun_la_cabecera()
    assert deshacer.strip().startswith("begin;") and deshacer.strip().endswith("commit;"), deshacer

    # CON condiciones publicadas, una reserva y un borrador.
    _hacer(pg, TEXTO)
    m = _mundo(pg)
    h = _retencion(pg, m["servicio"], m["version"], m["cliente"], inicio="2021-03-03 15:00+00")
    _contratar(pg, m["servicio"], m["version"], m["prestador"], m["cliente"], m["politica"], h)
    _hacer(pg, "insert into public.service_policies (kind, country_code, version, title, body, body_sha256) values "
               "('booking_terms', 'CL', 1, 'Borrador', repeat('x', 60), repeat('b', 64))")
    _hacer(pg, deshacer)
    for tabla in TABLAS:
        assert _uno(pg, "select to_regclass(%s)", f"public.{tabla}") is None, tabla
    for funcion in FUNCIONES:
        assert _uno(pg, "select to_regprocedure(%s)", f"public.{funcion}()") is None, funcion
    assert _todas(pg, "select status, count(*) from public.service_policies where kind = 'booking_terms' "
                      "group by status") == [("published", 1)]
    assert "booking_terms" in _uno(pg, "select pg_get_constraintdef(oid) from pg_catalog.pg_constraint "
                                       "where conname = 'service_policies_tipo'")
    # Y la 0093 se puede volver a aplicar encima.
    _hacer(pg, TEXTO)
    for tabla in TABLAS:
        assert _uno(pg, "select to_regclass(%s)", f"public.{tabla}") is not None, tabla

    # SIN condiciones de contratación, el tipo vuelve a ser el de la 0086.
    _montar(pg)
    _hacer(pg, deshacer)
    assert _uno(pg, "select pg_get_constraintdef(oid) from pg_catalog.pg_constraint "
                    "where conname = 'service_policies_tipo'") == tipo_de_la_0086


@SIN_POSTGRES
def test_se_niega_a_terminar_incompleta(pg) -> None:  # noqa: F811
    import psycopg

    for viciada, mensaje in (
        (TEXTO.replace("alter table public.service_bookings enable row level security;", ""), "sin RLS"),
        (re.sub(r"  constraint service_holds_sin_cruces\n    exclude using gist \([^;]*?\) where \(status in "
                r"\('active', 'consumed'\)\)", "  constraint service_holds_sin_cruces check (true)", TEXTO),
         "doble reserva"),
        (TEXTO.replace("create constraint trigger service_orders_completos\n  after insert on public.service_orders\n"
                       "  deferrable initially deferred",
                       "create constraint trigger service_orders_completos\n  after insert on public.service_orders\n"
                       "  deferrable initially immediate"), "al confirmar"),
        (TEXTO.replace("create unique index if not exists service_holds_una_plaza",
                       "create index if not exists service_holds_una_plaza"), "plazas"),
        (TEXTO.replace("  add constraint service_policies_tipo\n  check (kind in ('provider_terms', 'booking_terms'));",
                       "  add constraint service_policies_tipo\n  check (kind in ('provider_terms'));"),
         "tipo de las políticas"),
    ):
        assert viciada != TEXTO, mensaje
        _montar(pg, hasta="0092")
        with pytest.raises(psycopg.Error) as error:
            _hacer(pg, viciada)
        assert mensaje in str(error.value), mensaje
        _hacer(pg, "rollback")
        assert _uno(pg, "select to_regclass('public.service_holds')") is None


@SIN_POSTGRES
def test_sin_cada_dependencia_se_niega_y_no_crea_nada(pg) -> None:  # noqa: F811
    import psycopg

    for preparar, mensaje in (
        (lambda: _montar(pg, hasta="0091"), "0086–0092"),
        (lambda: (_montar(pg, hasta="0092"),
                  _hacer(pg, "drop function public.es_anonimizacion_por_baja(jsonb, jsonb, text[]) cascade")), "0089"),
        (lambda: (_montar(pg, hasta="0092"),
                  _hacer(pg, "drop extension btree_gist cascade")), "btree_gist"),
        (lambda: (_montar(pg, hasta="0092"),
                  _hacer(pg, "drop function public.servicios_catalogo_historial_inmutable() cascade")), "funciones"),
        (lambda: (_montar(pg, hasta="0092"),
                  _hacer(pg, "alter table public.service_versions drop column conditions")), "columnas"),
    ):
        preparar()
        with pytest.raises(psycopg.Error) as error:
            _hacer(pg, TEXTO)
        assert mensaje in str(error.value), mensaje
        _hacer(pg, "rollback")
        assert _uno(pg, "select to_regclass('public.service_holds')") is None, mensaje
