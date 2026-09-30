"""La migración 0092: la disponibilidad y la agenda del prestador (Incremento 4).

1. ESTÁTICA: es la última y sigue a la 0091, una sola transacción que
   comprueba lo anterior antes de crear nada, no concede permisos ni toca otra
   tabla, la única extensión es `btree_gist`, sus límites son los de
   `agenda_politica`, y no trae nada de reservas, retenciones ni dinero.
2. CONTRA POSTGRESQL: cerrada (RLS, cero políticas, cero privilegios), IGUAL AL
   MODELO POR DEFINICIÓN (las restricciones del ORM, creadas en un esquema
   aparte, dicen lo mismo que las de la migración), los cruces imposibles (en
   serie y con dos conexiones a la vez), los datos imposibles, la zona que no
   existe, el historial que no se reescribe y el borrado en cascada.
3. LA APLICACIÓN: sobre la 0091 con datos no toca nada, se puede reejecutar, un
   fallo a mitad no deja nada, se niega a terminar incompleta y sin la 0091 no
   empieza.
"""

from __future__ import annotations

import re
import threading
import time

import pytest

from app.modules.services import agenda_politica as limites
from tests.test_migraciones_reales import MIGRACIONES
from tests.test_servicios_migracion_0090 import (
    SIN_POSTGRES,
    _falla,
    _foto,
    _hacer,
    _montar,
    _persona,
    _publicada,
    _servicio,
    _todas,
    _uno,
    URL,
    pg,  # noqa: F401 - el montaje de la base, compartido
)

ARCHIVO = MIGRACIONES / "0092_servicios_disponibilidad_y_agenda.sql"
TEXTO = ARCHIVO.read_text(encoding="utf-8").replace("\r\n", "\n")
SQL = re.sub(r"--[^\n]*", "", TEXTO)

TABLAS = (
    "service_schedules",
    "service_schedule_rules",
    "service_schedule_exceptions",
    "service_schedule_blocks",
    "service_schedule_events",
)


# =========================================================================== #
# 1. Estática
# =========================================================================== #
def test_es_la_ultima_y_sigue_a_la_0091() -> None:
    nombres = sorted(p.name for p in MIGRACIONES.glob("*.sql"))
    assert nombres[-1] == ARCHIVO.name
    assert nombres[-2].startswith("0091_")


def test_es_una_unica_transaccion_que_comprueba_antes_de_crear() -> None:
    sentencias = [s.strip() for s in SQL.split(";") if s.strip()]
    assert sentencias[0] == "begin" and sentencias[-1] == "commit"
    assert len(re.findall(r"^\s*begin\s*;", SQL, flags=re.M)) == 1
    assert len(re.findall(r"^\s*commit\s*;", SQL, flags=re.M)) == 1
    assert SQL.index("La 0092 requiere la 0086") < SQL.index("create extension") < SQL.index("create table")


def test_no_concede_ni_borra_ni_toca_lo_anterior() -> None:
    codigo = SQL.lower()
    for prohibido in (
        r"\bgrant\b", r"drop\s+table", r"drop\s+column", r"delete\s+from", r"\bupdate\s+public\.",
        r"\btruncate\b", r"disable\s+row\s+level\s+security", r"security\s+definer", r"create\s+policy",
        r"disable\s+trigger", r"session_replication_role", r"insert\s+into",
    ):
        assert not re.search(prohibido, codigo), prohibido
    assert set(re.findall(r"alter\s+table\s+public\.([a-z_]+)", codigo)) == set(TABLAS)
    assert re.findall(r"create\s+table\s+if\s+not\s+exists\s+public\.([a-z_]+)", codigo) == list(TABLAS)
    # La única extensión: la que necesitan las restricciones de exclusión.
    assert re.findall(r"create\s+extension[^;]*", codigo) == [
        "create extension if not exists btree_gist with schema extensions"
    ]
    # Las funciones que usa de antes, sin tocarlas: solo crea la de la zona.
    assert re.findall(r"create\s+or\s+replace\s+function\s+public\.([a-z_]+)", codigo) == [
        "servicios_agenda_zona_valida"
    ]


def test_no_trae_reservas_retenciones_ni_dinero() -> None:
    codigo = SQL.lower()
    for palabra in (
        "booking", "reserv", "hold", "held", "payment", "stripe", "price", "amount", "fee", "order_",
        "checkout", "balance", "refund", "review", "attendee",
    ):
        assert palabra not in codigo, palabra


def test_sus_limites_son_los_de_la_politica() -> None:
    assert f"between 0 and {limites.SEPARACION_MAXIMA}" in SQL
    assert f"% {limites.REJILLA_MINUTOS} = 0" in SQL
    assert f"between {limites.INTERVALO_MINIMO} and {limites.INTERVALO_MAXIMO}" in SQL
    assert f"between 1 and {limites.CAPACIDAD_MAXIMA}" in SQL
    assert f"between 1 and {limites.MOTIVO_MAXIMO}" in SQL
    assert f"between 3 and {limites.ZONA_MAXIMA}" in SQL
    assert f"end_minute between 5 and {limites.MINUTOS_DEL_DIA}" in SQL


# =========================================================================== #
# 2. Contra PostgreSQL
# =========================================================================== #
def _sin_btree_gist(pg) -> None:
    """`_montar` no borra el esquema `extensions`: una prueba anterior pudo
    dejar la extensión. Estas miran que la 0092 la crea y que un fallo no."""
    _hacer(pg, "drop extension if exists btree_gist")


def _agenda(pg, *, zona: str = "America/Lima") -> str:
    """Un servicio con su agenda. Devuelve el servicio."""
    _, _, servicio, _ = _servicio(pg)
    _hacer(pg, "insert into public.service_schedules (service_id, timezone) values (%s, %s)", servicio, zona)
    return servicio


def _regla(pg, servicio: str, dia: int, inicio: int, fin: int, *, activa: bool = True, modalidad: str = "virtual"):
    _hacer(
        pg,
        "insert into public.service_schedule_rules (service_id, weekday, start_minute, end_minute, modality, active) "
        "values (%s, %s, %s, %s, %s, %s)",
        servicio, dia, inicio, fin, modalidad, activa,
    )


def _excepcion(pg, servicio: str, fecha: str, tipo: str, inicio=None, fin=None):
    abre = tipo != "closed"
    _hacer(
        pg,
        "insert into public.service_schedule_exceptions (service_id, on_date, kind, start_minute, end_minute, "
        "modality, capacity) values (%s, %s, %s, %s, %s, %s, %s)",
        servicio, fecha, tipo, inicio, fin, "virtual" if abre else None, 1 if abre else None,
    )


@SIN_POSTGRES
def test_desde_cero_queda_cerrada(pg) -> None:  # noqa: F811
    _montar(pg)
    for tabla in TABLAS:
        assert _uno(pg, "select relrowsecurity from pg_class where oid = %s::regclass", f"public.{tabla}"), tabla
        assert _uno(pg, "select count(*) from pg_policies where schemaname = 'public' and tablename = %s", tabla) == 0
        for rol in ("anon", "authenticated"):
            for privilegio in ("select", "insert", "update", "delete", "truncate", "references", "trigger"):
                assert not _uno(pg, "select has_table_privilege(%s, %s, %s)", rol, f"public.{tabla}", privilegio)
            assert not _uno(pg, "select has_any_column_privilege(%s, %s, 'select, insert, update')", rol, f"public.{tabla}")
    for rol in ("anon", "authenticated"):
        assert not _uno(pg, "select has_function_privilege(%s, 'public.servicios_agenda_zona_valida()', 'execute')", rol)
    assert _uno(pg, "select extnamespace::regnamespace::text from pg_extension where extname = 'btree_gist'") == "extensions"
    assert _uno(pg, "select prosecdef from pg_proc where oid = 'public.servicios_agenda_zona_valida()'::regprocedure") is False


@SIN_POSTGRES
def test_es_igual_al_modelo_por_definicion(pg) -> None:  # noqa: F811
    """El ORM, creado de verdad en PostgreSQL en un esquema aparte, tiene las
    mismas columnas, nulabilidad, CHECK (por definición, no por nombre) e
    índices que la migración. Lo que solo declara la base (las exclusiones y
    los disparadores) es lo único que falta en el ORM."""
    from sqlalchemy import Column, MetaData, Table, Uuid, create_engine

    from app.modules.services import agenda_models

    _montar(pg)
    _hacer(pg, "drop schema if exists orm_0092 cascade")
    _hacer(pg, "create schema orm_0092")
    copia = MetaData(schema="orm_0092")
    # `services` solo como madre de las claves (la de verdad es de la 0090).
    Table("services", copia, Column("id", Uuid(as_uuid=False), primary_key=True))
    for nombre in TABLAS:
        agenda_models.Base.metadata.tables[nombre].to_metadata(copia, schema="orm_0092")
    motor = create_engine(URL.replace("postgresql://", "postgresql+psycopg://"))
    try:
        with motor.begin() as conexion:
            copia.create_all(conexion)
    finally:
        motor.dispose()

    def _limpia(definicion: str) -> str:
        return re.sub(r"\s+", " ", definicion.replace("orm_0092.", "").replace("public.", "")).strip()

    for tabla in TABLAS:
        def _de(esquema: str) -> dict:
            return {
                "columnas": _todas(
                    pg,
                    "select column_name, data_type, is_nullable from information_schema.columns "
                    "where table_schema = %s and table_name = %s order by column_name",
                    esquema, tabla,
                ),
                "checks": sorted(
                    (n, _limpia(d)) for n, d in _todas(
                        pg,
                        "select conname, pg_get_constraintdef(oid) from pg_constraint "
                        "where contype = 'c' and conrelid = %s::regclass",
                        f"{esquema}.{tabla}",
                    )
                ),
                "indices": sorted(
                    _limpia(d).replace(" ON ", " ON ") for (d,) in _todas(
                        pg,
                        "select indexdef from pg_indexes where schemaname = %s and tablename = %s "
                        "and indexname not like '%%pkey' and indexname not like '%%sin_cruces'",
                        esquema, tabla,
                    )
                ),
                "claves": sorted(
                    _limpia(d) for (d,) in _todas(
                        pg,
                        "select pg_get_constraintdef(oid) from pg_constraint where contype in ('f', 'p') "
                        "and conrelid = %s::regclass",
                        f"{esquema}.{tabla}",
                    )
                ),
            }

        migracion, modelo = _de("public"), _de("orm_0092")
        assert migracion["checks"], tabla
        assert migracion == modelo, tabla
    _hacer(pg, "drop schema orm_0092 cascade")


# --- Los cruces -------------------------------------------------------------- #
@SIN_POSTGRES
def test_dos_reglas_activas_no_se_cruzan_el_mismo_dia(pg) -> None:  # noqa: F811
    _montar(pg)
    servicio = _agenda(pg)
    _regla(pg, servicio, 1, 540, 720)                 # lunes 09:00–12:00
    _regla(pg, servicio, 1, 720, 900)                 # 12:00–15:00: se toca, no se cruza
    _regla(pg, servicio, 2, 540, 720)                 # otro día
    _regla(pg, servicio, 1, 600, 660, activa=False)   # inactiva: no cuenta
    for inicio, fin, modalidad in ((600, 660, "virtual"), (540, 720, "virtual"), (700, 740, "in_person")):
        assert "sin_cruces" in _falla(
            pg,
            "insert into public.service_schedule_rules (service_id, weekday, start_minute, end_minute, modality) "
            "values (%s, 1, %s, %s, %s)",
            servicio, inicio, fin, modalidad,
        )
    # Activar la inactiva, que se cruza, tampoco.
    assert "sin_cruces" in _falla(
        pg, "update public.service_schedule_rules set active = true where service_id = %s and not active", servicio
    )
    # Otro servicio sí puede usar la misma franja.
    _regla(pg, _agenda(pg), 1, 540, 720)


@SIN_POSTGRES
def test_dos_excepciones_no_dejan_la_fecha_ambigua(pg) -> None:  # noqa: F811
    _montar(pg)
    servicio = _agenda(pg)
    _excepcion(pg, servicio, "2026-10-08", "closed")
    for tipo, inicio, fin in (("extra", 600, 660), ("closed", 600, 660), ("replace", 0, 1440), ("closed", None, None)):
        assert "sin_cruces" in _falla(
            pg,
            "insert into public.service_schedule_exceptions (service_id, on_date, kind, start_minute, end_minute, "
            "modality, capacity) values (%s, '2026-10-08', %s, %s, %s, %s, %s)",
            servicio, tipo, inicio, fin, None if tipo == "closed" else "virtual", None if tipo == "closed" else 1,
        )
    # Otra fecha: dos franjas que no se pisan, sí; una que las pisa, no.
    _excepcion(pg, servicio, "2026-10-09", "replace", 540, 720)
    _excepcion(pg, servicio, "2026-10-09", "closed", 720, 780)
    assert "sin_cruces" in _falla(
        pg,
        "insert into public.service_schedule_exceptions (service_id, on_date, kind) values (%s, '2026-10-09', 'closed')",
        servicio,
    )


@SIN_POSTGRES
def test_dos_conexiones_a_la_vez_no_dejan_dos_reglas_cruzadas(pg) -> None:  # noqa: F811
    """La exclusión no depende de un cerrojo del código: dos inserciones
    cruzadas a la vez nunca dejan las dos. PostgreSQL rechaza una, como
    violación de la exclusión o, si las dos llegaron a comprobarse la una a la
    otra, como interbloqueo (40P01). Por eso la API, antes de escribir, bloquea
    la fila del servicio: así la segunda recibe un 409 limpio (se prueba en
    `test_servicios_agenda_api.py`)."""
    import psycopg

    _montar(pg)
    servicio = _agenda(pg)
    errores: list[str] = []
    listos = threading.Barrier(2)

    def _insertar(inicio: int, fin: int) -> None:
        with psycopg.connect(URL) as conexion:
            try:
                with conexion.transaction():
                    listos.wait()
                    conexion.execute(
                        "insert into public.service_schedule_rules (service_id, weekday, start_minute, end_minute, "
                        "modality) values (%s, 3, %s, %s, 'virtual')",
                        (servicio, inicio, fin),
                    )
                    time.sleep(0.3)
            except psycopg.Error as error:
                errores.append(str(error))

    hilos = [threading.Thread(target=_insertar, args=a) for a in ((540, 720), (600, 780))]
    for h in hilos:
        h.start()
    for h in hilos:
        h.join()
    assert len(errores) == 1, errores
    assert "sin_cruces" in errores[0] or "deadlock detected" in errores[0], errores
    assert _uno(pg, "select count(*) from public.service_schedule_rules where service_id = %s", servicio) == 1


# --- Datos imposibles ------------------------------------------------------ #
@SIN_POSTGRES
def test_no_admite_datos_imposibles(pg) -> None:  # noqa: F811
    _montar(pg)
    servicio = _agenda(pg)
    reglas = "insert into public.service_schedule_rules (service_id, weekday, start_minute, end_minute, modality, capacity) values "
    for valores, nombre in (
        ("(%s, 1, 600, 600, 'virtual', 1)", "franja"),     # vacía
        ("(%s, 1, 660, 600, 'virtual', 1)", "franja"),     # al revés
        ("(%s, 1, 601, 660, 'virtual', 1)", "franja"),     # fuera de la rejilla
        ("(%s, 1, 600, 1445, 'virtual', 1)", "franja"),    # después de las 24:00
        ("(%s, 0, 600, 660, 'virtual', 1)", "dia"),
        ("(%s, 8, 600, 660, 'virtual', 1)", "dia"),
        ("(%s, 1, 600, 660, 'telefono', 1)", "modalidad"),
        ("(%s, 1, 600, 660, 'virtual', 0)", "capacidad"),
        ("(%s, 1, 600, 660, 'virtual', 1001)", "capacidad"),
    ):
        assert nombre in _falla(pg, reglas + valores, servicio), valores
    excepciones = "insert into public.service_schedule_exceptions (service_id, on_date, kind, start_minute, end_minute, modality, capacity) values "
    for valores, nombre in (
        ("(%s, '2026-10-08', 'closed', 600, null, null, null)", "franja"),
        ("(%s, '2026-10-08', 'extra', null, null, 'virtual', 1)", "abrir_con_franja"),
        ("(%s, '2026-10-08', 'closed', 600, 660, 'virtual', null)", "lo_que_abre"),
        ("(%s, '2026-10-08', 'extra', 600, 660, null, 1)", "lo_que_abre"),
        ("(%s, '2026-10-08', 'replace', 600, 660, 'virtual', 0)", "lo_que_abre"),
        ("(%s, '2026-10-08', 'open', 600, 660, 'virtual', 1)", "tipo"),
    ):
        assert nombre in _falla(pg, excepciones + valores, servicio), valores
    bloqueos = "insert into public.service_schedule_blocks (service_id, starts_at, ends_at, reason) values "
    assert "orden" in _falla(pg, bloqueos + "(%s, '2026-10-08 10:00Z', '2026-10-08 10:00Z', null)", servicio)
    assert "motivo" in _falla(pg, bloqueos + "(%s, '2026-10-08 10:00Z', '2026-10-08 11:00Z', %s)", servicio, "x" * 201)
    assert "motivo" in _falla(pg, bloqueos + "(%s, '2026-10-08 10:00Z', '2026-10-08 11:00Z', '   ')", servicio)
    agenda = "update public.service_schedules set {} where service_id = %s"
    for cambio, nombre in (
        ("buffer_before_minutes = 245", "preparacion"),
        ("buffer_after_minutes = 7", "descanso"),
        ("slot_interval_minutes = 0", "intervalo"),
        ("slot_interval_minutes = 32", "intervalo"),
        ("status = 'closed'", "estado"),
    ):
        assert nombre in _falla(pg, agenda.format(cambio), servicio), cambio


@SIN_POSTGRES
def test_la_zona_es_iana_con_lugar_y_existe(pg) -> None:  # noqa: F811
    _montar(pg)
    servicio = _agenda(pg, zona="America/New_York")
    for zona in ("UTC-5", "UTC", "Etc/GMT+5", "america/lima", "-05:00", "EST5EDT"):
        assert "zona" in _falla(pg, "update public.service_schedules set timezone = %s where service_id = %s", zona, servicio)
    # Tiene forma de zona pero no existe: lo dice el disparador.
    assert "no existe" in _falla(
        pg, "update public.service_schedules set timezone = 'America/Atlantida' where service_id = %s", servicio
    )
    _hacer(pg, "update public.service_schedules set timezone = 'Europe/Madrid' where service_id = %s", servicio)


# --- Historial y borrado ------------------------------------------------------ #
@SIN_POSTGRES
def test_el_historial_no_se_reescribe_y_todo_se_va_con_la_cuenta(pg) -> None:  # noqa: F811
    _montar(pg)
    admin = _persona(pg, "admin")
    perfil, _, servicio, _ = _publicada(pg, admin)
    _hacer(pg, "insert into public.service_schedules (service_id, timezone) values (%s, 'America/Lima')", servicio)
    _regla(pg, servicio, 1, 540, 720)
    _excepcion(pg, servicio, "2026-10-08", "closed")
    _hacer(pg, "insert into public.service_schedule_blocks (service_id, starts_at, ends_at, reason) values "
               "(%s, '2026-10-08 15:00Z', '2026-10-08 16:00Z', 'Dentista')", servicio)
    _hacer(pg, "insert into public.service_schedule_events (service_id, action, actor_id, actor_role, details) "
               "values (%s, 'rule_created', %s, 'provider', '{}')", servicio, perfil)
    assert "solo se añade" in _falla(pg, "update public.service_schedule_events set details = '{\"x\": 1}'")
    assert "no se borra" in _falla(pg, "delete from public.service_schedule_events where service_id = %s", servicio)
    assert "no se borra" in _falla(pg, "delete from public.service_schedules where service_id = %s", servicio)
    # Reglas, excepciones y bloqueos sí los retira el prestador.
    _hacer(pg, "delete from public.service_schedule_blocks where service_id = %s", servicio)
    # La cuenta del prestador se lleva su servicio y, con él, la agenda entera.
    _hacer(pg, "delete from auth.users where id = %s", perfil)
    for tabla in TABLAS:
        assert _uno(pg, f"select count(*) from public.{tabla} where service_id = %s", servicio) == 0, tabla


# =========================================================================== #
# 3. La aplicación
# =========================================================================== #
@SIN_POSTGRES
def test_sobre_la_0091_con_datos_no_toca_nada(pg) -> None:  # noqa: F811
    _montar(pg, hasta="0091")
    admin = _persona(pg, "admin")
    _, _, servicio, _ = _publicada(pg, admin)
    _hacer(pg, "insert into public.saved_services (profile_id, service_id, title_at_save) values (%s, %s, 'A')",
           _persona(pg), servicio)
    tablas = ("profiles", "service_providers", "services", "service_versions", "service_events", "saved_services")
    antes = {
        t: _uno(pg, f"select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.{t} t")
        for t in tablas
    }
    _hacer(pg, TEXTO)
    assert antes == {
        t: _uno(pg, f"select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.{t} t")
        for t in tablas
    }
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

    _montar(pg, hasta="0091")
    _sin_btree_gist(pg)
    corte = TEXTO.index("-- 9. Lo que tiene que quedar, o nada.")
    with pytest.raises(psycopg.Error):
        _hacer(pg, TEXTO[:corte] + "\nselect 1 / 0;\ncommit;\n")
    _hacer(pg, "rollback")
    for tabla in TABLAS:
        assert _uno(pg, "select to_regclass(%s)", f"public.{tabla}") is None, tabla
    assert _uno(pg, "select to_regprocedure('public.servicios_agenda_zona_valida()')") is None
    assert _uno(pg, "select count(*) from pg_extension where extname = 'btree_gist'") == 0


@SIN_POSTGRES
def test_se_niega_a_terminar_incompleta(pg) -> None:  # noqa: F811
    import psycopg

    for viciada, mensaje in (
        (TEXTO.replace("alter table public.service_schedule_blocks enable row level security;", ""), "sin RLS"),
        (re.sub(r"  constraint service_schedule_rules_sin_cruces\n    exclude using gist \([^;]*?\) where \(active\)",
                "  constraint service_schedule_rules_sin_cruces check (true)", TEXTO), "exclusión"),
        (TEXTO.replace("references public.service_schedules(service_id) on delete cascade,\n  starts_at",
                       "references public.service_schedules(service_id) on delete restrict,\n  starts_at"), "cascada"),
        (TEXTO.replace("create trigger service_schedules_zona_valida\n  before insert or update of timezone",
                       "create trigger service_schedules_zona_valida\n  after insert or update of timezone"),
         "disparadores"),
    ):
        assert viciada != TEXTO, mensaje
        _montar(pg, hasta="0091")
        with pytest.raises(psycopg.Error) as error:
            _hacer(pg, viciada)
        assert mensaje in str(error.value), mensaje
        _hacer(pg, "rollback")
        assert _uno(pg, "select to_regclass('public.service_schedules')") is None


@SIN_POSTGRES
def test_sin_la_0091_se_niega_y_no_crea_nada(pg) -> None:  # noqa: F811
    import psycopg

    _montar(pg, hasta="0090")
    _sin_btree_gist(pg)
    with pytest.raises(psycopg.Error) as error:
        _hacer(pg, TEXTO)
    assert "requiere" in str(error.value)
    _hacer(pg, "rollback")
    assert _uno(pg, "select to_regclass('public.service_schedules')") is None
    assert _uno(pg, "select count(*) from pg_extension where extname = 'btree_gist'") == 0
