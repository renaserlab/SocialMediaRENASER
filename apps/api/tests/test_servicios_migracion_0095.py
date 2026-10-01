"""La migración 0095: la política operativa de una reserva, congelada (G18).

1. ESTÁTICA: es la última y sigue a la 0094; una sola transacción que
   comprueba lo anterior antes de cambiar nada; ADITIVA (tres columnas, cuatro
   CHECK, una función y un disparador, todo en `service_bookings`); no
   concede, no borra, no trae dinero; sus claves, sus cotas y su versión son
   las de `reserva_politica`; y todavía NO consta como aplicada.
2. CONTRA POSTGRESQL: cerrada; una reserva nueva nace con su fotografía o no
   nace; LA HUELLA QUE CALCULA LA API ES LA QUE EXIGE LA BASE; una fotografía
   corrupta, sin huella o de otra versión no entra; NO SE EDITA, NO SE VACÍA Y
   NO SE SUSTITUYE (ni sola ni al cancelar o reprogramar); una reserva
   anterior no la gana después; y la baja de una cuenta sigue igual.
3. LA APLICACIÓN: sobre la 0094 vacía y con reservas no toca nada (y dice
   cuántas quedan sin fotografía), se puede reejecutar, un fallo a mitad no
   deja nada, se niega a terminar incompleta, sin cada una de sus dependencias
   no empieza, y la 0094 se puede reejecutar encima.

Que el modelo es igual a la base POR DEFINICIÓN (también los dos CHECK que
solo existen en PostgreSQL) lo comprueba, con la cadena entera,
`test_servicios_migracion_0093.py::test_es_igual_al_modelo_por_definicion`.
"""

from __future__ import annotations

import json
import re

import pytest

from app.modules.services import reserva_models
from app.modules.services import reserva_politica as limites
from tests.test_migraciones_reales import MIGRACIONES
from tests.test_servicios_migracion_0090 import (
    APLICADAS,
    SIN_POSTGRES,
    _falla,
    _foto,
    _hacer,
    _montar,
    _persona,
    _todas,
    _uno,
    pg,  # noqa: F401 - el montaje de la base, compartido
)
from tests.test_servicios_migracion_0093 import TABLAS as TABLAS_DE_LA_0093
from tests.test_servicios_migracion_0093 import _codigo, _contratar, _huellas, _mundo, _retencion
from tests.test_servicios_migracion_0094 import (
    CANCELAR,
    CONSUMIR,
    FUTURO,
    LIBERAR,
    MOVER,
    OTRO_DIA,
    PASADO,
    _atender,
    _resena,
)
from tests.test_servicios_migracion_0094 import TABLAS as TABLAS_DE_LA_0094
from tests.test_servicios_migracion_0094 import TEXTO as LA_0094

ARCHIVO = MIGRACIONES / "0095_servicios_politica_operativa_congelada.sql"
TEXTO = ARCHIVO.read_text(encoding="utf-8").replace("\r\n", "\n")
SQL = re.sub(r"--[^\n]*", "", TEXTO)

COLUMNAS = ("operating_policy", "operating_policy_version", "operating_policy_sha256")
RESTRICCIONES = tuple(f"service_bookings_politica_{n}" for n in ("completa", "version", "forma", "huella"))
FUNCION = "servicios_reserva_con_politica"
DISPARADOR = "service_bookings_con_politica"
VERSION = limites.VERSION_DE_LA_FOTOGRAFIA
#: La de fábrica, tal como la guarda la API.
FOTO = limites.PoliticaDeAtencion.vigente().fotografia()
HUELLA = limites.huella_de_la_fotografia(VERSION, FOTO)


# =========================================================================== #
# 1. Estática
# =========================================================================== #
def test_es_la_ultima_y_sigue_a_la_0094() -> None:
    nombres = sorted(p.name for p in MIGRACIONES.glob("*.sql"))
    assert nombres[-1] == ARCHIVO.name
    assert nombres[-2].startswith("0094_")


def test_todavia_no_consta_como_aplicada() -> None:
    """Se registra en `APLICADAS` cuando se aplique en Supabase y se verifique,
    no antes: hasta entonces se puede corregir."""
    assert ARCHIVO.name not in APLICADAS
    assert "-- SIN APLICAR." in TEXTO


def test_es_una_unica_transaccion_que_comprueba_antes_de_cambiar() -> None:
    sentencias = [s.strip() for s in SQL.split(";") if s.strip()]
    assert sentencias[0] == "begin" and sentencias[-1] == "commit"
    assert SQL.count("\nbegin;") == 1 and SQL.count("\ncommit;") == 1
    assert SQL.index("raise exception 'La 0095 requiere") < SQL.index("alter table")
    assert SQL.index("raise exception 'La 0095 requiere") < SQL.index("create or replace function")


def test_es_aditiva_no_concede_y_solo_toca_la_reserva() -> None:
    minusculas = SQL.lower()
    for prohibido in (
        r"\bgrant\b", r"drop\s+table", r"drop\s+column", r"delete\s+from", r"\bupdate\s+public\.",
        r"\btruncate\s+(table\s+)?\w", r"create\s+table", r"create\s+policy", r"security\s+definer", r"disable\s+trigger",
        r"disable\s+row\s+level\s+security", r"session_replication_role", r"drop\s+function", r"insert\s+into",
    ):
        assert not re.search(prohibido, minusculas), prohibido
    assert set(re.findall(r"alter table (?:if exists )?public\.(\w+)", minusculas)) == {"service_bookings"}
    # Tres columnas, anulables y SIN valor predeterminado: lo que ya existe se queda como está.
    assert re.findall(r"add column if not exists (\w+) (\w+)([^,;]*)", minusculas) == [
        ("operating_policy", "jsonb", ""), ("operating_policy_version", "integer", ""),
        ("operating_policy_sha256", "text", ""),
    ]
    # Sus cuatro CHECK, y ninguno de los que ya había.
    assert sorted(re.findall(r"drop constraint if exists (\w+)", minusculas)) == sorted(RESTRICCIONES)
    assert sorted(re.findall(r"add constraint (\w+)", minusculas)) == sorted(RESTRICCIONES)
    assert "not valid" not in minusculas
    # Una función y un disparador, suyos: no sustituye el cuerpo de ninguna anterior.
    assert re.findall(r"create or replace function public\.(\w+)\(", minusculas) == [FUNCION]
    assert re.findall(r"create trigger (\w+)\s+before insert on public\.service_bookings", minusculas) == [DISPARADOR]
    assert re.findall(r"drop trigger if exists (\w+)", minusculas) == [DISPARADOR]


def test_no_trae_dinero_ni_pasarela() -> None:
    minusculas = SQL.lower()
    for palabra in ("stripe", "payment", "refund", "transfer", "balance", "commission", "payout", "amount", "price",
                    "currency", "fee"):
        assert palabra not in minusculas, palabra


def test_sus_claves_sus_cotas_y_su_version_son_las_de_la_api() -> None:
    """Lo que la base admite en una fotografía es lo que la API guarda: las
    mismas claves, con las mismas cotas, y la misma versión."""
    claves = sorted(limites.CAMPOS_CONGELADOS)
    assert len(claves) == 9
    lista = re.search(r"operating_policy - array\[(.*?)\]", SQL, re.S).group(1)
    assert re.findall(r"'(\w+)'", lista) == claves
    for clave, (_, (minimo, maximo)) in limites.CAMPOS_CONGELADOS.items():
        assert f"jsonb_typeof(operating_policy -> '{clave}') = 'number'" in SQL, clave
        assert f"(operating_policy ->> '{clave}') ~ '^[0-9]+$'" in SQL, clave
        assert f"(operating_policy -> '{clave}') between '{minimo}'::jsonb and '{maximo}'::jsonb" in SQL, clave
    assert f"check (operating_policy_version is null or operating_policy_version = {VERSION})" in SQL
    # La forma canónica de la huella nombra las mismas claves, en orden.
    canonica = SQL[SQL.index("constraint service_bookings_politica_huella"):SQL.index("create or replace function")]
    assert re.findall(r'"(\w+)":', canonica) == ["schema_version", "values", *claves]
    # LO QUE NO SE CONGELA no está: el aviso y la moderación no son de la reserva.
    for ajena in ("reminder", "premoderation", "hold_minutes", "instant", "notice_minutes", "horizon"):
        assert ajena not in SQL.lower(), ajena


def test_el_modelo_declara_las_mismas_columnas_y_restricciones() -> None:
    tabla = reserva_models.ServiceBooking.__table__
    assert tuple(c.name for c in tabla.columns)[-3:] == COLUMNAS
    assert all(tabla.columns[c].nullable and tabla.columns[c].server_default is None for c in COLUMNAS)
    assert {c.name for c in tabla.constraints if str(c.name).startswith("service_bookings_politica_")} == set(
        RESTRICCIONES)


# =========================================================================== #
# 2. Contra PostgreSQL
# =========================================================================== #
_INSERTAR = (
    "insert into public.service_bookings (booking_code, order_id, hold_id, service_id, version_id, provider_id, "
    "client_id, starts_at, ends_at, occupied_from, occupied_until, timezone, local_date, modality, "
    "duration_minutes, buffer_before_minutes, buffer_after_minutes, capacity, seat, title_snapshot, "
    "provider_name_snapshot, confirmed_at, operating_policy, operating_policy_version, operating_policy_sha256) "
    "select %s, %s, h.id, h.service_id, h.version_id, %s, h.client_id, h.starts_at, h.ends_at, h.occupied_from, "
    "h.occupied_until, h.timezone, h.local_date, h.modality, "
    "(extract(epoch from h.ends_at - h.starts_at) / 60)::int, 0, 0, h.capacity, h.seat, 'Asesoría', 'Ana', now(), "
    "%s::jsonb, %s, %s from public.service_holds h where h.id = %s returning id"
)
_PEDIDO = (
    "insert into public.service_orders (service_id, version_id, provider_id, client_id, environment, price_model, "
    "title_snapshot, provider_name_snapshot, confirmed_at) values (%s, %s, %s, %s, 'sandbox', 'free', 'Asesoría', "
    "'Ana', now()) returning id"
)
_SIN = object()


def _reservar(pg, m: dict, *, inicio: str = FUTURO, cliente: str | None = None, foto=_SIN,  # noqa: F811
              version=_SIN, huella=_SIN) -> dict:
    """Lo que hace la API al confirmar, en una transacción, CON la fotografía
    (o con la que se le diga: `None` es NULL)."""
    cliente = cliente or m["cliente"]
    foto = FOTO if foto is _SIN else foto
    version = VERSION if version is _SIN else version
    if huella is _SIN:
        huella = limites.huella_de_la_fotografia(version, foto) if isinstance(foto, dict) and version else HUELLA
    # La retención, dentro: si la base rechaza la reserva, no queda nada.
    with pg.transaction():
        retencion = _retencion(pg, m["servicio"], m["version"], cliente, inicio=inicio)
        pedido = str(_uno(pg, _PEDIDO, m["servicio"], m["version"], m["prestador"], cliente))
        reserva = str(_uno(pg, _INSERTAR, _codigo(), pedido, m["prestador"],
                           None if foto is None else json.dumps(foto), version, huella, retencion))
        _hacer(pg, "insert into public.service_booking_acceptances (order_id, kind, policy_id, policy_version, sha256, "
                   "accepted_by, accepted_at) values (%s, 'booking_terms', %s, 1, repeat('a', 64), %s, now())",
               pedido, m["politica"], cliente)
        _hacer(pg, CONSUMIR, retencion)
        _hacer(pg, "insert into public.service_booking_events (service_id, hold_id, booking_id, action, from_status, "
                   "to_status, actor_id, actor_role) values (%s, %s, %s, 'booking_confirmed', 'active', 'confirmed', "
                   "%s, 'client')", m["servicio"], retencion, reserva, cliente)
    return {"retencion": retencion, "pedido": pedido, "reserva": reserva, "cliente": cliente}


def _rechaza(pg, m: dict, **fotografia) -> str:  # noqa: F811
    """El mensaje con el que la base rechaza una reserva con ESA fotografía."""
    import psycopg

    antes = _uno(pg, "select count(*) from public.service_bookings")
    with pytest.raises(psycopg.Error) as error:
        _reservar(pg, m, cliente=_persona(pg), **fotografia)
    assert _uno(pg, "select count(*) from public.service_bookings") == antes
    return str(error.value)


def _guardada(pg, reserva: str) -> tuple:  # noqa: F811
    return _todas(pg, "select operating_policy, operating_policy_version, operating_policy_sha256 "
                      "from public.service_bookings where id = %s", reserva)[0]


@SIN_POSTGRES
def test_desde_cero_queda_cerrada(pg) -> None:  # noqa: F811
    _montar(pg)
    assert _todas(
        pg, "select a.attname::text, format_type(a.atttypid, a.atttypmod), a.attnotnull, "
            "(select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d where d.adrelid = a.attrelid "
            "and d.adnum = a.attnum) from pg_attribute a where a.attrelid = 'public.service_bookings'::regclass "
            "and a.attname like 'operating%%' order by a.attnum"
    ) == [("operating_policy", "jsonb", False, None), ("operating_policy_version", "integer", False, None),
          ("operating_policy_sha256", "text", False, None)]
    assert sorted(_todas(pg, "select conname::text, convalidated from pg_constraint where conrelid = "
                             "'public.service_bookings'::regclass and conname like 'service_bookings_politica%%'")
                  ) == sorted((r, True) for r in RESTRICCIONES)
    # La reserva sigue cerrada: RLS, cero políticas, nadie de fuera (tampoco por columna).
    assert _uno(pg, "select relrowsecurity from pg_class where oid = 'public.service_bookings'::regclass")
    assert _uno(pg, "select count(*) from pg_policies where schemaname = 'public' and tablename = 'service_bookings'") == 0
    for rol in ("anon", "authenticated", "public"):
        for privilegio in ("select", "insert", "update", "delete", "truncate", "references", "trigger"):
            assert not _uno(pg, "select has_table_privilege(%s, 'public.service_bookings', %s)", rol, privilegio)
        for privilegio in ("select", "insert", "update", "references"):
            assert not _uno(pg, "select has_any_column_privilege(%s, 'public.service_bookings', %s)", rol, privilegio)
        assert not _uno(pg, "select has_function_privilege(%s, %s, 'execute')", rol, f"public.{FUNCION}()")
    assert _todas(pg, "select prosecdef, proconfig from pg_proc where oid = %s::regprocedure",
                  f"public.{FUNCION}()") == [(False, ["search_path=public, pg_temp"])]
    # El disparador, activo y antes de insertar. Y el que impide reescribir la reserva, también.
    assert _todas(pg, "select tgname::text, tgtype, tgenabled::text from pg_trigger where tgrelid = "
                      "'public.service_bookings'::regclass and tgname in (%s, 'service_bookings_inmutables') "
                      "order by 1", DISPARADOR) == [(DISPARADOR, 7, "O"), ("service_bookings_inmutables", 19, "O")]


@SIN_POSTGRES
def test_una_reserva_nueva_nace_con_su_fotografia_o_no_nace(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    # Como se contrataba antes de la 0095: ya no entra.
    h = _retencion(pg, m["servicio"], m["version"], m["cliente"], inicio=OTRO_DIA)
    with pytest.raises(Exception) as error:  # noqa: PT011 - el mensaje se comprueba abajo
        _contratar(pg, m["servicio"], m["version"], m["prestador"], m["cliente"], m["politica"], h)
    assert "Una reserva nace con su política operativa congelada" in str(error.value)
    assert "política operativa congelada" in _rechaza(pg, m, foto=None, version=None, huella=None)
    assert _uno(pg, "select count(*) from public.service_bookings") == 0
    assert _uno(pg, "select count(*) from public.service_orders") == 0
    # Con ella, sí; y queda tal cual.
    r = _reservar(pg, m, cliente=_persona(pg))
    assert _guardada(pg, r["reserva"]) == (FOTO, VERSION, HUELLA)


@SIN_POSTGRES
def test_la_huella_que_calcula_la_api_es_la_que_exige_la_base(pg) -> None:  # noqa: F811
    """La API y la base calculan la huella por separado, y tienen que
    coincidir: en los valores de fábrica, en cada cota y en una mezcla."""
    _montar(pg)
    m = _mundo(pg)
    minimos = {c: cotas[0] for c, (_, cotas) in limites.CAMPOS_CONGELADOS.items()}
    maximos = {c: cotas[1] for c, (_, cotas) in limites.CAMPOS_CONGELADOS.items()}
    mezcla = {**FOTO, "booking_reschedule_min_hours": 2, "incident_appeals_max": 0, "review_window_days": 365}
    dias = iter(range(1, 20))
    for foto in (FOTO, minimos, maximos, mezcla):
        r = _reservar(pg, m, cliente=_persona(pg), foto=foto, inicio=f"2031-04-{next(dias):02d} 15:00+00")
        guardada, version, huella = _guardada(pg, r["reserva"])
        assert (guardada, version) == (foto, VERSION)
        assert huella == limites.huella_de_la_fotografia(VERSION, foto)
        # Y la API la lee de vuelta como la escribió.
        leida = limites.PoliticaDeAtencion.de_la_reserva(
            type("Fila", (), {"operating_policy": guardada, "operating_policy_version": version,
                              "operating_policy_sha256": huella})())
        assert leida.congelada and leida.fotografia() == foto
    assert len({limites.huella_de_la_fotografia(VERSION, f) for f in (FOTO, minimos, maximos, mezcla)}) == 4
    # UNA HUELLA QUE NO ES LA SUYA no entra: la de otra fotografía, otra cualquiera, en mayúsculas.
    for ajena in (limites.huella_de_la_fotografia(VERSION, mezcla), "a" * 64, HUELLA.upper(), HUELLA[:-1], ""):
        assert "service_bookings_politica_huella" in _rechaza(pg, m, huella=ajena), ajena


@SIN_POSTGRES
def test_una_fotografia_corrupta_sin_huella_o_de_otra_version_no_entra(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    clave = "attention_tolerance_minutes"
    sin_una = {c: v for c, v in FOTO.items() if c != clave}
    for foto in (
        sin_una,                                   # falta una clave
        {**FOTO, "cancellation_fee_percent": 50},  # sobra una
        {**FOTO, clave: "15"},                     # un texto
        {**FOTO, clave: 15.5},                     # no entero
        {**FOTO, clave: -1},                       # negativo
        {**FOTO, clave: 241},                      # fuera de su cota
        {**FOTO, "incident_appeals_max": 2},       # más apelaciones de las que admite un caso
        {**FOTO, "attention_confirmation_hours": 0},
        {**FOTO, clave: True},
        {**FOTO, clave: None},
        {**FOTO, clave: [15]},
        {},
    ):
        assert "service_bookings_politica_forma" in _rechaza(pg, m, foto=foto, huella=HUELLA), foto
    # Ni una lista ni un valor suelto: la base lo rechaza (por la forma o al evaluarla).
    for foto in ([], [FOTO], 15, "x"):
        assert _rechaza(pg, m, foto=foto, huella=HUELLA), foto
    # LA VERSIÓN: solo la que la base conoce.
    for version in (0, 2, -1):
        assert "service_bookings_politica_version" in _rechaza(
            pg, m, version=version, huella=limites.huella_de_la_fotografia(version, FOTO)), version
    # ENTERA O NINGUNA: sin huella, sin versión o sin la fotografía.
    assert "service_bookings_politica_completa" in _rechaza(pg, m, huella=None)
    assert "service_bookings_politica_completa" in _rechaza(pg, m, version=None, huella=HUELLA)
    assert _uno(pg, "select count(*) from public.service_bookings") == 0


@SIN_POSTGRES
def test_la_fotografia_no_se_edita_ni_se_vacia_ni_se_sustituye(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    r = _reservar(pg, m)
    otra = {**FOTO, "booking_reschedule_min_hours": 2}
    otra_huella = limites.huella_de_la_fotografia(VERSION, otra)
    donde = "where id = %s"
    for cambio, valores in (
        # Sustituirla por otra VÁLIDA (la de ahora, por ejemplo), con su huella.
        ("operating_policy = %s::jsonb, operating_policy_sha256 = %s", (json.dumps(otra), otra_huella)),
        # Vaciarla.
        ("operating_policy = null, operating_policy_version = null, operating_policy_sha256 = null", ()),
        # Tocar solo una de las tres (lo paran los CHECK o el disparador: no entra).
        ("operating_policy = %s::jsonb", (json.dumps(otra),)),
        ("operating_policy_sha256 = %s", (otra_huella,)),
        ("operating_policy_version = 2", ()),
    ):
        assert _falla(pg, f"update public.service_bookings set {cambio} {donde}", *valores, r["reserva"]), cambio
        assert _guardada(pg, r["reserva"]) == (FOTO, VERSION, HUELLA)
    assert "Una reserva no se reescribe" in _falla(
        pg, f"update public.service_bookings set operating_policy = %s::jsonb, operating_policy_sha256 = %s {donde}",
        json.dumps(otra), otra_huella, r["reserva"])
    # NI DE PASO, al cancelarla o al reprogramarla.
    assert "Una reserva no se reescribe" in _falla(
        pg, "update public.service_bookings set status = 'cancelled', operating_policy = %s::jsonb, "
            f"operating_policy_sha256 = %s {donde}", json.dumps(otra), otra_huella, r["reserva"])
    nueva = _retencion(pg, m["servicio"], m["version"], m["cliente"], inicio=OTRO_DIA, estado="released")
    assert _falla(pg, MOVER.replace("seat = h.seat", "seat = h.seat, operating_policy = %s::jsonb, "
                                                     "operating_policy_sha256 = %s"),
                  json.dumps(otra), otra_huella, nueva, r["reserva"])
    assert _guardada(pg, r["reserva"]) == (FOTO, VERSION, HUELLA)

    # CANCELAR Y REPROGRAMAR siguen funcionando, y la fotografía se queda.
    movida = _reservar(pg, m, cliente=_persona(pg), foto=otra, inicio="2031-05-05 15:00+00")
    destino = _retencion(pg, m["servicio"], m["version"], movida["cliente"], inicio="2031-05-06 15:00+00")
    with pg.transaction():
        _hacer(pg, CONSUMIR, destino)
        _hacer(pg, MOVER, destino, movida["reserva"])
        _hacer(pg, LIBERAR, movida["retencion"])
    assert _guardada(pg, movida["reserva"]) == (otra, VERSION, otra_huella)
    with pg.transaction():
        _hacer(pg, CANCELAR, r["reserva"])
        _hacer(pg, LIBERAR, r["retencion"])
    assert _guardada(pg, r["reserva"]) == (FOTO, VERSION, HUELLA)
    # Y CANCELADA, menos todavía.
    assert "Una reserva no se reescribe" in _falla(
        pg, f"update public.service_bookings set operating_policy = %s::jsonb, operating_policy_sha256 = %s {donde}",
        json.dumps(otra), otra_huella, r["reserva"])


@SIN_POSTGRES
def test_una_reserva_anterior_queda_sin_fotografia_y_no_la_gana_despues(pg) -> None:  # noqa: F811
    """LAS QUE YA EXISTÍAN no se tocan: sin fotografía (nadie guardó con qué
    política se confirmaron), y sin poder ganarla después. La migración dice
    cuántas son. Siguen pudiendo cancelarse."""
    _montar(pg, hasta="0094")
    m = _mundo(pg)
    h = _retencion(pg, m["servicio"], m["version"], m["cliente"])
    _, anterior = _contratar(pg, m["servicio"], m["version"], m["prestador"], m["cliente"], m["politica"], h)
    avisos: list[str] = []

    def _oir(aviso) -> None:  # noqa: ANN001 - un `Diagnostic` de psycopg
        avisos.append(aviso.message_primary)

    pg.add_notice_handler(_oir)
    try:
        _hacer(pg, TEXTO)
    finally:
        pg.remove_notice_handler(_oir)
    assert any("1 reserva(s) anteriores, sin fotografía" in a for a in avisos), avisos
    assert _guardada(pg, anterior) == (None, None, None)
    # NO SE LE INVENTA UNA DESPUÉS: ni la de fábrica ni ninguna.
    assert "Una reserva no se reescribe" in _falla(
        pg, "update public.service_bookings set operating_policy = %s::jsonb, operating_policy_version = %s, "
            "operating_policy_sha256 = %s where id = %s", json.dumps(FOTO), VERSION, HUELLA, anterior)
    assert _guardada(pg, anterior) == (None, None, None)
    # Y sigue pudiendo cancelarse (sus tres NULL pasan los CHECK).
    with pg.transaction():
        _hacer(pg, CANCELAR, anterior)
        _hacer(pg, LIBERAR, h)
    assert _uno(pg, "select status from public.service_bookings where id = %s", anterior) == "cancelled"
    # LAS NUEVAS, con la suya.
    nueva = _reservar(pg, m, cliente=_persona(pg), inicio=OTRO_DIA)
    assert _guardada(pg, nueva["reserva"]) == (FOTO, VERSION, HUELLA)
    assert _uno(pg, "select count(*) from public.service_bookings where operating_policy is null") == 1


@SIN_POSTGRES
def test_la_baja_de_una_cuenta_sigue_igual(pg) -> None:  # noqa: F811
    """La fotografía es parte de la fila: se queda con la reserva cuando quien
    contrató se va (sin su nombre), y se va con ella cuando se va quien
    presta. Y una reserva por venir sigue frenando la baja."""
    _montar(pg)
    m = _mundo(pg)
    por_venir = _reservar(pg, m)
    assert "Hay una reserva de Servicios por venir" in _falla(pg, "delete from auth.users where id = %s", m["cliente"])
    pasada = _reservar(pg, m, cliente=_persona(pg), inicio=PASADO)
    _hacer(pg, "delete from auth.users where id = %s", pasada["cliente"])
    assert _todas(pg, "select client_id, operating_policy, operating_policy_sha256 from public.service_bookings "
                      "where id = %s", pasada["reserva"]) == [(None, FOTO, HUELLA)]
    # Quien presta: mientras haya una por venir, no; cancelada, se lleva todo.
    assert _falla(pg, "delete from auth.users where id = %s", m["perfil"])
    with pg.transaction():
        _hacer(pg, CANCELAR, por_venir["reserva"])
        _hacer(pg, LIBERAR, por_venir["retencion"])
    _hacer(pg, "delete from auth.users where id = %s", m["perfil"])
    assert _uno(pg, "select count(*) from public.service_bookings") == 0


# =========================================================================== #
# 3. La aplicación
# =========================================================================== #
def _reservas_sin_lo_nuevo(pg) -> str:  # noqa: F811
    """La huella de las reservas SIN las tres columnas de la 0095."""
    return _uno(pg, "select md5(coalesce(string_agg((to_jsonb(b) - %s::text[])::text, '|' order by b.id), '')) "
                    "from public.service_bookings b", list(COLUMNAS))


def _nada_de_la_0095(pg) -> None:  # noqa: F811
    assert _uno(pg, "select count(*) from pg_attribute where attrelid = 'public.service_bookings'::regclass "
                    "and attname like 'operating%%' and not attisdropped") == 0
    assert _uno(pg, "select count(*) from pg_constraint where conname like 'service_bookings_politica%%'") == 0
    assert _uno(pg, "select to_regprocedure(%s)", f"public.{FUNCION}()") is None
    assert _uno(pg, "select count(*) from pg_trigger where tgname = %s", DISPARADOR) == 0


@SIN_POSTGRES
def test_sobre_la_0094_vacia_no_toca_nada(pg) -> None:  # noqa: F811
    _montar(pg, hasta="0094")
    antes = _foto(pg)
    _hacer(pg, TEXTO)
    despues = _foto(pg)
    # Lo único nuevo: sus cuatro CHECK, su disparador y su función.
    assert [r for r in despues["restricciones"] if r not in antes["restricciones"]] == [
        ("service_bookings", n, _uno(pg, "select pg_get_constraintdef(oid) from pg_constraint where conname = %s", n))
        for n in sorted(RESTRICCIONES)
    ]
    assert [d[:2] for d in despues["disparadores"] if d not in antes["disparadores"]] == [
        ("service_bookings", DISPARADOR)]
    assert [f[0] for f in despues["funciones"] if f not in antes["funciones"]] == [FUNCION]
    assert despues["tablas"] == antes["tablas"] and despues["indices"] == antes["indices"]
    for clave in ("restricciones", "disparadores", "funciones"):
        assert [x for x in antes[clave] if x not in despues[clave]] == [], clave
    assert _uno(pg, "select count(*) from public.service_bookings") == 0


@SIN_POSTGRES
def test_sobre_la_0094_con_reservas_no_toca_ninguna(pg) -> None:  # noqa: F811
    _montar(pg, hasta="0094")
    m = _mundo(pg)

    def _vieja(inicio: str) -> dict:
        cliente = _persona(pg)
        h = _retencion(pg, m["servicio"], m["version"], cliente, inicio=inicio)
        pedido, reserva = _contratar(pg, m["servicio"], m["version"], m["prestador"], cliente, m["politica"], h)
        return {"retencion": h, "pedido": pedido, "reserva": reserva, "cliente": cliente}

    por_venir, cancelada, atendida = _vieja(FUTURO), _vieja(OTRO_DIA), _vieja(PASADO)
    with pg.transaction():
        _hacer(pg, CANCELAR, cancelada["reserva"])
        _hacer(pg, LIBERAR, cancelada["retencion"])
    _atender(pg, atendida["reserva"], "closed")
    _resena(pg, atendida, m)
    otras = tuple(t for t in TABLAS_DE_LA_0093 if t != "service_bookings") + TABLAS_DE_LA_0094 + (
        "profiles", "service_providers", "services", "service_versions", "service_policies")
    antes, reservas = _huellas(pg, otras), _reservas_sin_lo_nuevo(pg)
    _hacer(pg, TEXTO)
    assert _huellas(pg, otras) == antes
    assert _reservas_sin_lo_nuevo(pg) == reservas
    assert _todas(pg, "select distinct operating_policy, operating_policy_version, operating_policy_sha256 "
                      "from public.service_bookings") == [(None, None, None)]
    # Y lo que ya estaba sigue su curso.
    with pg.transaction():
        _hacer(pg, CANCELAR, por_venir["reserva"])
        _hacer(pg, LIBERAR, por_venir["retencion"])


@SIN_POSTGRES
def test_reejecutarla_deja_exactamente_lo_mismo_tambien_con_datos(pg) -> None:  # noqa: F811
    _montar(pg, hasta="0094")
    m = _mundo(pg)
    h = _retencion(pg, m["servicio"], m["version"], m["cliente"])
    _contratar(pg, m["servicio"], m["version"], m["prestador"], m["cliente"], m["politica"], h)
    _hacer(pg, TEXTO)
    _reservar(pg, m, cliente=_persona(pg), inicio=OTRO_DIA)
    _reservar(pg, m, cliente=_persona(pg), inicio=PASADO, foto={**FOTO, "review_window_days": 7})
    tablas = TABLAS_DE_LA_0093 + TABLAS_DE_LA_0094
    foto, datos = _foto(pg), _huellas(pg, tablas)
    permisos = _todas(pg, "select proname, proacl::text from pg_proc where pronamespace = 'public'::regnamespace "
                          "and proname like 'servicios_%%' order by 1")
    _hacer(pg, TEXTO)
    _hacer(pg, TEXTO)
    assert _foto(pg) == foto
    assert _huellas(pg, tablas) == datos
    assert _todas(pg, "select proname, proacl::text from pg_proc where pronamespace = 'public'::regnamespace "
                      "and proname like 'servicios_%%' order by 1") == permisos
    # LA 0094 TAMBIÉN SE PUEDE REEJECUTAR ENCIMA: no toca nada de la 0095.
    _hacer(pg, LA_0094)
    assert _foto(pg) == foto and _huellas(pg, tablas) == datos


@SIN_POSTGRES
def test_un_fallo_a_mitad_no_deja_nada(pg) -> None:  # noqa: F811
    import psycopg

    _montar(pg, hasta="0094")
    m = _mundo(pg)
    h = _retencion(pg, m["servicio"], m["version"], m["cliente"])
    _contratar(pg, m["servicio"], m["version"], m["prestador"], m["cliente"], m["politica"], h)
    foto, datos = _foto(pg), _huellas(pg, TABLAS_DE_LA_0093)
    for marca in ("-- 3. Lo que una fotografía tiene que ser.", "-- 4. Una reserva NUEVA nace con su fotografía.",
                  "-- 6. Lo que tiene que quedar, o nada."):
        corte = TEXTO.index(marca)
        with pytest.raises(psycopg.Error):
            _hacer(pg, TEXTO[:corte] + "\nselect 1 / 0;\ncommit;\n")
        _hacer(pg, "rollback")
        _nada_de_la_0095(pg)
        assert _foto(pg) == foto and _huellas(pg, TABLAS_DE_LA_0093) == datos


@SIN_POSTGRES
def test_se_niega_a_terminar_incompleta(pg) -> None:  # noqa: F811
    import psycopg

    _montar(pg, hasta="0094")
    foto = _foto(pg)
    disparador = ("create trigger service_bookings_con_politica\n  before insert on public.service_bookings\n"
                  "  for each row\n  execute function public.servicios_reserva_con_politica();")
    revocar = "revoke all on function public.servicios_reserva_con_politica() from public, anon, authenticated;"
    for viciada, mensaje in (
        (TEXTO.replace("add column if not exists operating_policy jsonb,",
                       "add column if not exists operating_policy jsonb default '{}',"), "tres columnas"),
        (TEXTO.replace("add column if not exists operating_policy_version integer,",
                       "add column if not exists operating_policy_version bigint,"), "tres columnas"),
        (TEXTO.replace("  check (operating_policy_version is null or operating_policy_version = 1);",
                       "  check (operating_policy_version is null or operating_policy_version = 1) not valid;"),
         "cuatro CHECK"),
        (TEXTO.replace(disparador, ""), "disparador que exige la fotografía"),
        (TEXTO.replace(disparador, disparador + "\nalter table public.service_bookings disable trigger "
                                                "service_bookings_con_politica;"),
         "disparador que exige la fotografía"),
        (TEXTO.replace("  before insert on public.service_bookings", "  before insert or update on public.service_bookings"),
         "disparador que exige la fotografía"),
        (TEXTO.replace(revocar, "grant execute on function public.servicios_reserva_con_politica() to anon;"),
         "ejecutable desde fuera"),
        (TEXTO.replace(revocar, revocar + "\nalter table public.service_bookings disable row level security;"),
         "sin RLS"),
        (TEXTO.replace(revocar, revocar + "\ncreate policy abierta on public.service_bookings for select to anon "
                                          "using (true);"), "tiene políticas"),
        (TEXTO.replace(revocar, revocar + "\ngrant select (operating_policy) on public.service_bookings to "
                                          "authenticated;"), "permisos sueltos"),
    ):
        assert viciada != TEXTO, mensaje
        with pytest.raises(psycopg.Error) as error:
            _hacer(pg, viciada)
        assert mensaje in str(error.value), (mensaje, str(error.value))
        _hacer(pg, "rollback")
        _nada_de_la_0095(pg)
        assert _foto(pg) == foto


@SIN_POSTGRES
def test_sin_cada_dependencia_se_niega_diciendo_cual_y_no_cambia_nada(pg) -> None:  # noqa: F811
    import psycopg

    vacia = ("create or replace function public.servicios_reserva_inmutable() returns trigger language plpgsql "
             "set search_path = public, pg_temp as $$ begin return new; end; $$")
    for preparar, mensaje in (
        (lambda: _montar(pg, hasta="0093"), "faltan service_attendances, service_incidents"),
        (lambda: (_montar(pg, hasta="0094"), _hacer(pg, "drop table public.service_reviews")), "faltan service_reviews"),
        (lambda: (_montar(pg, hasta="0094"),
                  _hacer(pg, "drop function public.servicios_reserva_coherente_al_cambiar() cascade")),
         "faltan public.servicios_reserva_coherente_al_cambiar()"),
        # LA INMUTABILIDAD: sin el disparador de la reserva, apagado, o con otro cuerpo.
        (lambda: (_montar(pg, hasta="0094"),
                  _hacer(pg, "drop trigger service_bookings_inmutables on public.service_bookings")),
         "service_bookings_inmutables"),
        (lambda: (_montar(pg, hasta="0094"),
                  _hacer(pg, "alter table public.service_bookings disable trigger service_bookings_inmutables")),
         "service_bookings_inmutables"),
        (lambda: (_montar(pg, hasta="0094"), _hacer(pg, vacia)), "con el cuerpo de la 0094"),
    ):
        preparar()
        foto = _foto(pg)
        with pytest.raises(psycopg.Error) as error:
            _hacer(pg, TEXTO)
        assert "La 0095 requiere" in str(error.value) and mensaje in str(error.value), (mensaje, str(error.value))
        _hacer(pg, "rollback")
        _nada_de_la_0095(pg)
        assert _foto(pg) == foto
