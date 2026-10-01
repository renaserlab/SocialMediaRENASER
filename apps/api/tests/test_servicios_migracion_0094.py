"""La migración 0094: la atención, la posventa y el cierre operativo (Incremento 6).

1. ESTÁTICA: es la última y sigue a la 0093; una sola transacción que
   comprueba lo anterior antes de crear nada; no concede permisos; de la 0093
   solo amplía tres CHECK (ninguna columna nueva en sus tablas); no trae
   pasarela ni dinero, y el efecto económico no admite un estado «ejecutado»;
   sus límites son los de `reserva_politica`.
2. CONTRA POSTGRESQL: cerrada (RLS, cero políticas, cero privilegios, también
   de columna y de función), IGUAL AL MODELO POR DEFINICIÓN, el depósito
   privado, los saltos de la atención y de un caso, CANCELAR (libera el
   horario, y no queda a medias), REPROGRAMAR (el mismo contrato, y ni el
   horario nuevo sin ocupar ni el anterior ocupado), LA RESEÑA VERIFICADA (sin
   una atención cerrada de quien contrató, no entra), lo que no se reescribe
   ni se borra suelto y LA BAJA DE UNA CUENTA de quien contrata y de quien
   presta, en los dos órdenes de los disparadores.
3. LA APLICACIÓN: sobre la 0093 con reservas no toca nada, se puede
   reejecutar, un fallo a mitad no deja nada, se niega a terminar incompleta,
   sin cada una de sus dependencias no empieza, su ROLLBACK funciona (y se
   niega con datos) y LA 0093 YA NO SE REEJECUTA ENCIMA: se niega, sin cambiar
   nada.
"""

from __future__ import annotations

import re
import uuid

import pytest

from app.modules.services import reserva_politica as limites
from tests.test_migraciones_reales import MIGRACIONES
from tests.test_servicios_migracion_0090 import (
    SIN_POSTGRES,
    URL,
    _falla,
    _falla_al_confirmar,
    _foto,
    _hacer,
    _montar,
    _persona,
    _todas,
    _uno,
    pg,  # noqa: F401 - el montaje de la base, compartido
)
from tests.test_servicios_migracion_0093 import TABLAS as TABLAS_DE_LA_0093
from tests.test_servicios_migracion_0093 import _contratar, _huellas, _mundo, _retencion

ARCHIVO = MIGRACIONES / "0094_servicios_atencion_y_cierre.sql"
TEXTO = ARCHIVO.read_text(encoding="utf-8").replace("\r\n", "\n")
SQL = re.sub(r"--[^\n]*", "", TEXTO)
LA_0093 = (MIGRACIONES / "0093_servicios_reserva_y_contratacion.sql").read_text(encoding="utf-8")

TABLAS = ("service_attendances", "service_incidents", "service_incident_entries", "service_reviews")
FUNCIONES = (
    "servicios_reserva_coherente_al_cambiar",
    "servicios_atencion_salto_valido",
    "servicios_incidencia_salto_valido",
    "servicios_resena_verificada",
)
#: Las dos de la 0093 cuyo cuerpo sustituye, y la de la 0086 que cierra.
TOCADAS = ("servicios_reserva_inmutable", "servicios_retencion_salto_valido", "servicios_borrado_solo_en_cascada")
DEPOSITO = "service-incident-evidence"
PASADO = "2021-03-03 15:00+00"
FUTURO = "2031-03-03 15:00+00"
OTRO_DIA = "2031-03-04 15:00+00"
DESCRIPCION = "No vino nadie a la hora acordada y esperé media hora."
COMENTARIO = "Muy clara y puntual, resolvió todas mis dudas."


# =========================================================================== #
# 1. Estática
# =========================================================================== #
def test_es_la_ultima_y_sigue_a_la_0093() -> None:
    nombres = sorted(p.name for p in MIGRACIONES.glob("*.sql"))
    assert nombres[-1] == ARCHIVO.name
    assert nombres[-2].startswith("0093_")


def test_es_una_unica_transaccion_que_comprueba_antes_de_crear() -> None:
    sentencias = [s.strip() for s in SQL.split(";") if s.strip()]
    assert sentencias[0] == "begin" and sentencias[-1] == "commit"
    assert SQL.count("\nbegin;") == 1 and SQL.count("\ncommit;") == 1
    assert SQL.index("raise exception 'La 0094 requiere") < SQL.index("alter table")
    assert SQL.index("raise exception 'La 0094 requiere") < SQL.index("create table")


def test_no_concede_y_de_la_0093_solo_amplia_tres_check() -> None:
    minusculas = SQL.lower()
    assert " grant " not in f" {minusculas} "
    assert "drop table" not in minusculas and "truncate" not in minusculas and "drop column" not in minusculas
    # NINGUNA COLUMNA NUEVA en una tabla ya aplicada: la 0093 sigue valiendo sola.
    assert "add column" not in minusculas
    alterada = set(re.findall(r"alter table (?:if exists )?public\.(\w+)", minusculas))
    assert alterada == {"service_bookings", "service_booking_events"} | set(TABLAS)
    assert sorted(re.findall(r"drop constraint if exists (\w+)", minusculas)) == [
        "service_booking_events_accion", "service_booking_events_rol", "service_bookings_estado",
    ]
    # De lo anterior sustituye DOS funciones (y crea las suyas).
    assert sorted(re.findall(r"create or replace function public\.(\w+)\(", minusculas)) == sorted(
        FUNCIONES + TOCADAS[:2]
    )
    # No borra datos de nadie.
    assert "delete from" not in minusculas


def test_no_trae_pasarela_ni_dinero_ni_un_efecto_ejecutado() -> None:
    minusculas = SQL.lower()
    for palabra in ("stripe", "payment_intent", "external_payment_id", "transfer", "balance", "commission",
                    "payout", "amount_minor"):
        assert palabra not in minusculas, palabra
    # Lo único que se parece a dinero: el efecto SOLICITADO y su estado.
    assert "check (financial_effect is null or financial_effect in ('none', 'full_refund', 'partial_refund'))" in minusculas
    estado = re.search(r"constraint service_incidents_estado_del_efecto\s+check \(([^;]*?)\),\n", minusculas).group(1)
    assert re.findall(r"'(\w+)'", estado) == ["not_applicable", "pending", "blocked"]
    for palabra in ("executed", "refunded", "paid", "done", "completed"):
        assert palabra not in estado, palabra


def test_sus_limites_y_su_vocabulario_son_los_de_la_api() -> None:
    from app.modules.services import atencion_models as modelos
    from app.modules.services import posventa, reserva_models

    minimo, maximo = limites.DESCRIPCION_DEL_CASO
    assert f"check (length(trim(description)) between {minimo} and {maximo})" in SQL
    assert f"check (body is null or length(trim(body)) between 1 and {limites.ENTRADA_MAXIMA})" in SQL
    minimo, maximo = limites.COMENTARIO_DE_RESENA
    assert f"check (length(trim(comment)) between {minimo} and {maximo})" in SQL
    assert f"check (reply is null or length(trim(reply)) between 1 and {limites.RESPUESTA_MAXIMA})" in SQL
    assert f"length(checkin_code) = {limites.CODIGO_DE_ASISTENCIA_CIFRAS}" in SQL
    assert f"check (checkin_attempts between 0 and {limites.INTENTOS_DEL_CODIGO})" in SQL
    assert f"values ('{posventa.DEPOSITO}', '{posventa.DEPOSITO}', false)" in SQL

    def _lista(restriccion: str) -> tuple[str, ...]:
        cuerpo = re.search(rf"constraint {restriccion}\s+check \((.*?)\)\)?[,;]?\n", SQL, re.S).group(1)
        return tuple(re.findall(r"'(\w+)'", cuerpo))

    assert _lista("service_bookings_estado") == reserva_models.ESTADOS_DE_RESERVA
    assert _lista("service_booking_events_accion") == reserva_models.ACCIONES
    assert _lista("service_booking_events_rol") == reserva_models.ROLES
    assert _lista("service_attendances_estado") == modelos.ESTADOS_DE_ATENCION
    assert _lista("service_incidents_motivo") == modelos.MOTIVOS
    assert _lista("service_incidents_estado") == modelos.ESTADOS_DE_CASO
    assert _lista("service_incidents_resultado") == modelos.RESULTADOS
    assert _lista("service_incidents_efecto_en_la_atencion") == modelos.EFECTOS_EN_LA_ATENCION
    assert _lista("service_incidents_efecto_economico") == modelos.EFECTOS_ECONOMICOS
    assert _lista("service_incidents_estado_del_efecto") == modelos.ESTADOS_DEL_EFECTO
    assert _lista("service_incident_entries_tipo") == modelos.TIPOS_DE_ENTRADA
    assert _lista("service_incident_entries_rol") == modelos.ROLES_DE_ENTRADA
    assert _lista("service_reviews_estado") == modelos.ESTADOS_DE_RESENA
    assert modelos.TABLAS == TABLAS


# =========================================================================== #
# 2. Contra PostgreSQL
# =========================================================================== #
def _reservada(pg, m: dict, *, inicio: str = FUTURO, cliente: str | None = None) -> dict:  # noqa: F811
    """Una reserva confirmada: `{retencion, pedido, reserva}`."""
    cliente = cliente or m["cliente"]
    h = _retencion(pg, m["servicio"], m["version"], cliente, inicio=inicio)
    pedido, reserva = _contratar(pg, m["servicio"], m["version"], m["prestador"], cliente, m["politica"], h)
    return {"retencion": h, "pedido": pedido, "reserva": reserva, "cliente": cliente}


_ATENCION = {
    "code_issued": "checkin_code = '123456'",
    "in_progress": "started_at = now()",
    "completed": "started_at = now(), completed_at = now()",
    "closed": "started_at = now(), completed_at = now(), closed_at = now(), closed_by = 'client'",
    "no_show_client": "no_show_reported_at = now()",
    "no_show_provider": "no_show_reported_at = now()",
}


def _atender(pg, reserva: str, estado: str = "closed") -> None:  # noqa: F811
    columnas = [c.split(" = ") for c in _ATENCION[estado].split(", ")]
    _hacer(
        pg,
        f"insert into public.service_attendances (booking_id, status, {', '.join(c for c, _ in columnas)}) "
        f"values (%s, %s, {', '.join(v for _, v in columnas)})",
        reserva, estado,
    )


def _pasar(pg, reserva: str, estado: str) -> None:  # noqa: F811
    _hacer(pg, f"update public.service_attendances set status = %s, {_ATENCION[estado]} where booking_id = %s",
           estado, reserva)


def _caso(pg, reserva: str, quien: str, *, motivo: str = "provider_absent") -> str:  # noqa: F811
    return str(_uno(
        pg, "insert into public.service_incidents (booking_id, opened_by, reason, description) "
            "values (%s, %s, %s, %s) returning id", reserva, quien, motivo, DESCRIPCION,
    ))


RESOLVER = (
    "update public.service_incidents set status = %s, outcome = 'upheld', attention_effect = 'none', "
    "financial_effect = %s, financial_effect_status = %s, resolved_by = %s, resolved_at = now(), "
    "resolutions = resolutions + 1 where id = %s"
)


def _resena(pg, r: dict, m: dict, *, autor: str | None = None, estado: str = "published") -> str:  # noqa: F811
    return str(_uno(
        pg, "insert into public.service_reviews (booking_id, service_id, author_id, rating, recommends, comment, "
            "status) values (%s, %s, %s, 5, true, %s, %s) returning id",
        r["reserva"], m["servicio"], autor or r["cliente"], COMENTARIO, estado,
    ))


CANCELAR = "update public.service_bookings set status = 'cancelled' where id = %s"
LIBERAR = ("update public.service_holds set status = 'released', consumed_at = null, released_at = now(), "
           "updated_at = now() where id = %s")
CONSUMIR = "update public.service_holds set status = 'consumed', consumed_at = now(), updated_at = now() where id = %s"
MOVER = (
    "update public.service_bookings b set hold_id = h.id, starts_at = h.starts_at, ends_at = h.ends_at, "
    "occupied_from = h.occupied_from, occupied_until = h.occupied_until, timezone = h.timezone, "
    "local_date = h.local_date, capacity = h.capacity, seat = h.seat "
    "from public.service_holds h where h.id = %s and b.id = %s"
)


def _cancelar(pg, r: dict) -> None:  # noqa: F811
    with pg.transaction():
        _hacer(pg, CANCELAR, r["reserva"])
        _hacer(pg, LIBERAR, r["retencion"])


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
    for funcion in FUNCIONES + TOCADAS:
        for rol in ("anon", "authenticated", "public"):
            assert not _uno(pg, "select has_function_privilege(%s, %s, 'execute')", rol, f"public.{funcion}()"), (
                funcion, rol)
        assert not _uno(pg, "select prosecdef from pg_proc where oid = %s::regprocedure", f"public.{funcion}()")
    # EL DEPÓSITO: privado, 10 MB, PDF y fotos, y sin ninguna política que lo alcance.
    assert _todas(pg, "select public, file_size_limit, allowed_mime_types from storage.buckets where id = %s",
                  DEPOSITO) == [(False, 10 * 1024 * 1024, ["application/pdf", "image/jpeg", "image/png", "image/webp"])]
    if _uno(pg, "select to_regclass('storage.objects')") is not None:
        assert _uno(pg, "select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' "
                        "and (coalesce(qual, '') || coalesce(with_check, '')) like %s", f"%{DEPOSITO}%") == 0


@SIN_POSTGRES
def test_es_igual_al_modelo_por_definicion(pg) -> None:  # noqa: F811
    """El ORM, creado de verdad en PostgreSQL en un esquema aparte, tiene las
    mismas columnas (tipo y nulabilidad), CHECK (por definición), índices,
    claves y únicas que la migración. Los disparadores son lo único que solo
    declara la base."""
    from sqlalchemy import Column, MetaData, Table, Uuid, create_engine

    from app.modules.services import atencion_models

    _montar(pg)
    _hacer(pg, "drop schema if exists orm_0094 cascade")
    _hacer(pg, "create schema orm_0094")
    copia = MetaData(schema="orm_0094")
    for madre in ("service_bookings", "services", "profiles"):
        Table(madre, copia, Column("id", Uuid(as_uuid=False), primary_key=True))
    for nombre in TABLAS:
        atencion_models.Base.metadata.tables[nombre].to_metadata(copia, schema="orm_0094")
    motor = create_engine(URL.replace("postgresql://", "postgresql+psycopg://"))
    try:
        with motor.begin() as conexion:
            copia.create_all(conexion)
    finally:
        motor.dispose()

    def _limpia(definicion: str) -> str:
        return re.sub(r"\s+", " ", definicion.replace("orm_0094.", "").replace("public.", "")).strip()

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
                        "and not i.indisprimary",
                        relacion,
                    )
                ),
            }

        migracion, modelo = _de("public"), _de("orm_0094")
        assert migracion == modelo, tabla
    _hacer(pg, "drop schema orm_0094 cascade")


@SIN_POSTGRES
def test_el_historial_admite_lo_de_este_incremento_y_nada_mas(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    r = _reservada(pg, m)
    evento = ("insert into public.service_booking_events (service_id, booking_id, action, to_status, actor_id, "
              "actor_role) values (%s, %s, %s, 'x', %s, %s)")
    _hacer(pg, evento, m["servicio"], r["reserva"], "attendance_started", m["perfil"], "provider")
    _hacer(pg, evento, m["servicio"], r["reserva"], "incident_resolved", m["admin"], "admin")
    assert "service_booking_events_accion" in _falla(
        pg, evento, m["servicio"], r["reserva"], "refund_executed", m["admin"], "admin")
    assert "service_booking_events_rol" in _falla(
        pg, evento, m["servicio"], r["reserva"], "attendance_started", m["perfil"], "finance")


# --- La atención ------------------------------------------------------------ #
@SIN_POSTGRES
def test_la_atencion_nace_de_una_reserva_confirmada_y_solo_da_sus_saltos(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    r = _reservada(pg, m)
    _atender(pg, r["reserva"], "code_issued")
    # Una por reserva (es su clave).
    assert "service_attendances_pkey" in _falla(
        pg, "insert into public.service_attendances (booking_id, status, checkin_code) values (%s, 'code_issued', '000000')",
        r["reserva"])
    # El código: seis cifras; los intentos: hasta cinco.
    assert "service_attendances_codigo" in _falla(
        pg, "update public.service_attendances set checkin_code = '12a456' where booking_id = %s", r["reserva"])
    assert "service_attendances_intentos" in _falla(
        pg, "update public.service_attendances set checkin_attempts = 6 where booking_id = %s", r["reserva"])
    # Lo que cada estado exige.
    assert "service_attendances_inicio" in _falla(
        pg, "update public.service_attendances set status = 'in_progress' where booking_id = %s", r["reserva"])
    assert "service_attendances_ausencia" in _falla(
        pg, "update public.service_attendances set status = 'no_show_client' where booking_id = %s", r["reserva"])
    assert "service_attendances_cierre" in _falla(
        pg, "update public.service_attendances set status = 'closed' where booking_id = %s", r["reserva"])
    # Los saltos: no se termina lo que no empezó, ni se vuelve atrás.
    assert "Salto de atención no permitido: code_issued → completed" in _falla(
        pg, "update public.service_attendances set status = 'completed', started_at = now(), completed_at = now() "
            "where booking_id = %s", r["reserva"])
    _pasar(pg, r["reserva"], "in_progress")
    assert "Salto de atención no permitido: in_progress → code_issued" in _falla(
        pg, "update public.service_attendances set status = 'code_issued' where booking_id = %s", r["reserva"])
    _pasar(pg, r["reserva"], "completed")
    _pasar(pg, r["reserva"], "closed")
    # CERRADA ES FINAL.
    for estado in ("completed", "in_progress", "no_show_client", "no_show_provider", "code_issued"):
        assert "Salto de atención no permitido: closed" in _falla(
            pg, "update public.service_attendances set status = %s, closed_at = null, closed_by = null, "
                "no_show_reported_at = now() where booking_id = %s", estado, r["reserva"]), estado
    assert "La atención no cambia de reserva" in _falla(
        pg, "update public.service_attendances set created_at = now() - interval '1 day' where booking_id = %s",
        r["reserva"])
    # Y de una reserva cancelada no nace ninguna.
    otra = _reservada(pg, m, inicio=OTRO_DIA, cliente=_persona(pg))
    _cancelar(pg, otra)
    assert "La atención es de una reserva confirmada" in _falla(
        pg, "insert into public.service_attendances (booking_id, status, checkin_code) values (%s, 'code_issued', '111111')",
        otra["reserva"])


@SIN_POSTGRES
def test_una_inasistencia_se_puede_corregir_y_cerrar_pero_no_reabrir(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    r = _reservada(pg, m)
    _atender(pg, r["reserva"], "no_show_provider")
    # Administración, al resolver un caso, puede decir que fue al revés, o que sí se hizo.
    _pasar(pg, r["reserva"], "no_show_client")
    assert "Salto de atención no permitido: no_show_client → in_progress" in _falla(
        pg, "update public.service_attendances set status = 'in_progress', started_at = now() where booking_id = %s",
        r["reserva"])
    _hacer(pg, "update public.service_attendances set status = 'closed', closed_at = now(), closed_by = 'admin' "
               "where booking_id = %s", r["reserva"])
    assert "service_attendances_cierre_de" in _falla(
        pg, "update public.service_attendances set closed_by = 'provider' where booking_id = %s", r["reserva"])


# --- Cancelar --------------------------------------------------------------- #
@SIN_POSTGRES
def test_cancelar_libera_el_horario_y_no_queda_a_medias(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    r = _reservada(pg, m)
    otra = _persona(pg)
    # Mientras está confirmada, su horario es suyo.
    assert "service_holds_" in _falla(
        pg, "insert into public.service_holds (service_id, version_id, client_id, starts_at, ends_at, occupied_from, "
            "occupied_until, timezone, local_date, modality, capacity, seat, expires_at) select service_id, version_id, "
            "%s, starts_at, ends_at, occupied_from, occupied_until, timezone, local_date, modality, capacity, seat, "
            "now() + interval '10 minutes' from public.service_holds where id = %s", otra, r["retencion"])
    # A MEDIAS NO: cancelada y ocupando su horario, la base no lo confirma.
    assert "Una reserva cancelada no sigue ocupando su horario" in _falla(pg, CANCELAR, r["reserva"])
    # Ni al revés: el horario no se libera con su reserva confirmada.
    assert "Una retención con su reserva confirmada no se libera" in _falla(pg, LIBERAR, r["retencion"])
    assert _uno(pg, "select status from public.service_bookings where id = %s", r["reserva"]) == "confirmed"
    # CANCELAR cambia el estado Y NADA MÁS.
    assert "Una reserva no se reescribe" in _falla(
        pg, "update public.service_bookings set status = 'cancelled', title_snapshot = 'Otra' where id = %s",
        r["reserva"])
    # ENTERO: la reserva cancelada, su retención liberada, y el horario vuelve.
    _cancelar(pg, r)
    assert _uno(pg, "select status from public.service_bookings where id = %s", r["reserva"]) == "cancelled"
    assert _todas(pg, "select status, consumed_at is null, released_at is not null from public.service_holds "
                      "where id = %s", r["retencion"]) == [("released", True, True)]
    nueva = _retencion(pg, m["servicio"], m["version"], otra, inicio=FUTURO)
    assert nueva
    # El pedido y lo aceptado SE QUEDAN: cancelar no borra el contrato.
    assert _uno(pg, "select count(*) from public.service_orders where id = %s", r["pedido"]) == 1
    assert _uno(pg, "select count(*) from public.service_booking_acceptances where order_id = %s", r["pedido"]) == 1
    # UNA CANCELADA NO VUELVE, ni se cancela otra vez, ni se mueve.
    assert "Una reserva no se reescribe" in _falla(
        pg, "update public.service_bookings set status = 'confirmed' where id = %s", r["reserva"])
    assert "Una reserva no se reescribe" in _falla(
        pg, "update public.service_bookings set hold_id = %s where id = %s", nueva, r["reserva"])
    # Y una retención liberada ya no cambia.
    assert "ya no cambia" in _falla(pg, CONSUMIR, r["retencion"])


@SIN_POSTGRES
def test_lo_que_ya_empezo_no_se_cancela_ni_se_reprograma(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    for estado in ("in_progress", "completed", "closed", "no_show_client", "no_show_provider"):
        r = _reservada(pg, m, inicio=f"2031-04-0{1 + list(_ATENCION).index(estado)} 15:00+00", cliente=_persona(pg))
        _atender(pg, r["reserva"], estado)
        assert "Una atención que ya empezó no se cancela ni se reprograma" in _falla_al_confirmar(
            pg, (CANCELAR, r["reserva"]), (LIBERAR, r["retencion"])), estado
        nueva = _retencion(pg, m["servicio"], m["version"], r["cliente"], inicio="2031-05-05 15:00+00")
        assert "Una atención que ya empezó no se cancela ni se reprograma" in _falla_al_confirmar(
            pg, (CONSUMIR, nueva), (MOVER, nueva, r["reserva"]), (LIBERAR, r["retencion"])), estado
        _hacer(pg, "update public.service_holds set status = 'released', released_at = now(), updated_at = now() "
                   "where id = %s", nueva)
    # CON EL CÓDIGO PEDIDO Y NADA MÁS, todavía se puede.
    r = _reservada(pg, m, inicio="2031-04-20 15:00+00", cliente=_persona(pg))
    _atender(pg, r["reserva"], "code_issued")
    _cancelar(pg, r)


# --- Reprogramar ------------------------------------------------------------ #
@SIN_POSTGRES
def test_reprogramar_mueve_la_reserva_entera_o_no_la_mueve(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    r = _reservada(pg, m)
    antes = _todas(pg, "select order_id, version_id, title_snapshot, duration_minutes, booking_code, confirmed_at "
                       "from public.service_bookings where id = %s", r["reserva"])
    nueva = _retencion(pg, m["servicio"], m["version"], m["cliente"], inicio=OTRO_DIA)

    # SIN OCUPAR EL NUEVO: la reserva no casa con su retención.
    assert "Una reserva confirmada casa con su retención consumida" in _falla_al_confirmar(
        pg, (MOVER, nueva, r["reserva"]), (LIBERAR, r["retencion"]))
    # SIN LIBERAR EL ANTERIOR: quedarían dos horarios ocupados.
    assert "Al reprogramar, el horario anterior se libera" in _falla_al_confirmar(
        pg, (CONSUMIR, nueva), (MOVER, nueva, r["reserva"]))
    # OCUPAR EL NUEVO SIN MOVER LA RESERVA: una retención consumida sin reserva (0093).
    assert _falla_al_confirmar(pg, (CONSUMIR, nueva))
    # CON OTRO HORARIO QUE EL DE SU RETENCIÓN.
    assert "Una reserva confirmada casa con su retención consumida" in _falla_al_confirmar(
        pg, (CONSUMIR, nueva),
        ("update public.service_bookings set hold_id = %s where id = %s", nueva, r["reserva"]),
        (LIBERAR, r["retencion"]))
    # EL CONTRATO NO CAMBIA: ni la versión, ni el pedido, ni la duración.
    for cambio in ("version_id = gen_random_uuid()", "order_id = gen_random_uuid()", "title_snapshot = 'Otro'",
                   "duration_minutes = 30", "client_id = gen_random_uuid()", "modality = 'in_person'"):
        assert "Una reserva no se reescribe" in _falla(
            pg, f"update public.service_bookings set hold_id = %s, {cambio} where id = %s", nueva, r["reserva"]), cambio
    # Nada de eso dejó rastro: sigue donde estaba.
    assert _uno(pg, "select hold_id::text from public.service_bookings where id = %s", r["reserva"]) == r["retencion"]
    assert _uno(pg, "select status from public.service_holds where id = %s", nueva) == "active"

    # ENTERA: el nuevo ocupado, la reserva movida, el anterior libre.
    with pg.transaction():
        _hacer(pg, CONSUMIR, nueva)
        _hacer(pg, MOVER, nueva, r["reserva"])
        _hacer(pg, LIBERAR, r["retencion"])
    assert _todas(pg, "select hold_id::text, status, starts_at = %s::timestamptz from public.service_bookings "
                      "where id = %s", OTRO_DIA, r["reserva"]) == [(nueva, "confirmed", True)]
    assert _uno(pg, "select status from public.service_holds where id = %s", r["retencion"]) == "released"
    assert _todas(pg, "select order_id, version_id, title_snapshot, duration_minutes, booking_code, confirmed_at "
                      "from public.service_bookings where id = %s", r["reserva"]) == antes
    # El horario anterior vuelve a estar libre, y el nuevo es suyo.
    assert _retencion(pg, m["servicio"], m["version"], _persona(pg), inicio=FUTURO)
    assert "service_holds_" in _falla(
        pg, "insert into public.service_holds (service_id, version_id, client_id, starts_at, ends_at, occupied_from, "
            "occupied_until, timezone, local_date, modality, capacity, seat, expires_at) select service_id, version_id, "
            "%s, starts_at, ends_at, occupied_from, occupied_until, timezone, local_date, modality, capacity, seat, "
            "now() + interval '10 minutes' from public.service_holds where id = %s", _persona(pg), nueva)
    # LA DURACIÓN ES LA DEL CONTRATO: a un horario de otra duración no se mueve.
    corta = _retencion(pg, m["servicio"], m["version"], m["cliente"], inicio="2031-03-06 15:00+00", minutos=30)
    assert "Una reserva no se reescribe" in _falla_al_confirmar(
        pg, (CONSUMIR, corta), (MOVER, corta, r["reserva"]), (LIBERAR, nueva))
    # Y la retención de OTRA persona no sirve.
    ajena = _retencion(pg, m["servicio"], m["version"], _persona(pg), inicio="2031-03-07 15:00+00")
    assert "Una reserva confirmada casa con su retención consumida" in _falla_al_confirmar(
        pg, (CONSUMIR, ajena), (MOVER, ajena, r["reserva"]), (LIBERAR, nueva))


# --- El caso ---------------------------------------------------------------- #
@SIN_POSTGRES
def test_un_caso_por_reserva_y_solo_sus_saltos(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    r = _reservada(pg, m)
    caso = _caso(pg, r["reserva"], m["cliente"])
    assert "service_incidents_una_por_reserva" in _falla(
        pg, "insert into public.service_incidents (booking_id, opened_by, reason, description) values (%s, %s, "
            "'quality', %s)", r["reserva"], m["perfil"], DESCRIPCION)
    assert "service_incidents_motivo" in _falla(
        pg, "insert into public.service_incidents (booking_id, opened_by, reason, description) values (%s, %s, "
            "'refund_me', %s)", _reservada(pg, m, inicio=OTRO_DIA, cliente=_persona(pg))["reserva"], m["cliente"],
        DESCRIPCION)
    # LO QUE LO ABRIÓ NO SE REESCRIBE.
    for cambio in ("reason = 'quality'", "description = repeat('x', 40)", "opened_by = gen_random_uuid()"):
        assert "Lo que abrió el caso no se reescribe" in _falla(
            pg, f"update public.service_incidents set {cambio} where id = %s", caso), cambio
    # RESUELTO ES RESUELTO DEL TODO: sin resultado, efectos y momento, no.
    assert "service_incidents_" in _falla(
        pg, "update public.service_incidents set status = 'resolved' where id = %s", caso)
    assert "service_incidents_resuelta" in _falla(
        pg, "update public.service_incidents set status = 'resolved', resolutions = 1, outcome = 'upheld' "
            "where id = %s", caso)
    # No se apela lo que nadie resolvió, ni se cierra de golpe.
    assert "Salto de caso no permitido: open → appealed" in _falla(
        pg, "update public.service_incidents set status = 'appealed', appealed_by = 'client', appealed_at = now() "
            "where id = %s", caso)
    assert "Salto de caso no permitido: open → closed" in _falla(pg, RESOLVER, "closed", "none", "not_applicable",
                                                                  m["admin"], caso)
    _hacer(pg, RESOLVER, "resolved", "none", "not_applicable", m["admin"], caso)
    assert "Una resolución no se borra" in _falla(
        pg, "update public.service_incidents set resolutions = 0, outcome = null, attention_effect = null, "
            "financial_effect = null, financial_effect_status = null, resolved_at = null where id = %s", caso)
    assert "Salto de caso no permitido: resolved → open" in _falla(
        pg, "update public.service_incidents set status = 'open' where id = %s", caso)
    # La apelación: de una parte, con su momento.
    assert "service_incidents_apelacion" in _falla(
        pg, "update public.service_incidents set status = 'appealed' where id = %s", caso)
    assert "service_incidents_apela" in _falla(
        pg, "update public.service_incidents set status = 'appealed', appealed_by = 'admin', appealed_at = now() "
            "where id = %s", caso)
    _hacer(pg, "update public.service_incidents set status = 'appealed', appealed_by = 'provider', "
               "appealed_at = now() where id = %s", caso)
    # Apelado → cerrado, con su SEGUNDA resolución.
    assert "service_incidents_estado_y_resoluciones" in _falla(
        pg, "update public.service_incidents set status = 'closed' where id = %s", caso)
    _hacer(pg, RESOLVER, "closed", "none", "not_applicable", m["admin"], caso)
    # CERRADO ES FINAL: ni otra apelación ni otra resolución.
    for estado in ("open", "resolved", "appealed", "withdrawn"):
        assert "Salto de caso no permitido: closed" in _falla(
            pg, "update public.service_incidents set status = %s where id = %s", estado, caso), estado
    assert "service_incidents_" in _falla(
        pg, "update public.service_incidents set resolutions = 3 where id = %s", caso)
    # Y uno retirado tampoco se resuelve.
    otro = _caso(pg, _reservada(pg, m, inicio="2031-03-08 15:00+00", cliente=_persona(pg))["reserva"], m["perfil"],
                 motivo="client_absent")
    _hacer(pg, "update public.service_incidents set status = 'withdrawn' where id = %s", otro)
    assert "Salto de caso no permitido: withdrawn → resolved" in _falla(
        pg, RESOLVER, "resolved", "none", "not_applicable", m["admin"], otro)


@SIN_POSTGRES
def test_el_efecto_economico_es_una_solicitud_y_nunca_dice_que_se_ejecuto(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    caso = _caso(pg, _reservada(pg, m)["reserva"], m["cliente"])
    for estado in ("executed", "refunded", "paid", "completed", "done", "succeeded"):
        assert "service_incidents_estado_del_efecto" in _falla(
            pg, RESOLVER, "resolved", "full_refund", estado, m["admin"], caso), estado
    assert "service_incidents_efecto_economico" in _falla(
        pg, RESOLVER, "resolved", "transfer_to_provider", "pending", m["admin"], caso)
    # SIN EFECTO SOLICITADO NO HAY NADA PENDIENTE.
    for estado in ("pending", "blocked"):
        assert "service_incidents_sin_efecto" in _falla(pg, RESOLVER, "resolved", "none", estado, m["admin"], caso)
    # Solicitado y bloqueado (o pendiente): se puede escribir, y es lo que queda.
    _hacer(pg, RESOLVER, "resolved", "full_refund", "blocked", m["admin"], caso)
    assert _todas(pg, "select financial_effect, financial_effect_status from public.service_incidents where id = %s",
                  caso) == [("full_refund", "blocked")]
    # Ninguna columna de las cuatro tablas guarda un importe ni un identificador de pasarela.
    columnas = [c for (c,) in _todas(
        pg, "select column_name from information_schema.columns where table_schema = 'public' "
            "and table_name = any(%s)", list(TABLAS))]
    assert not [c for c in columnas if re.search(r"amount|minor|currency|payment|stripe|refund_id|transfer|payout", c)]


@SIN_POSTGRES
def test_el_expediente_solo_se_anade(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    caso = _caso(pg, _reservada(pg, m)["reserva"], m["cliente"])
    entrada = ("insert into public.service_incident_entries (incident_id, author_id, author_role, kind, body, "
               "storage_path, content_type, byte_size, sha256) values (%s, %s, %s, %s, %s, %s, %s, %s, %s) returning id")
    mensaje = _uno(pg, entrada, caso, m["cliente"], "client", "message", "Adjunto la conversación.", None, None, None,
                   None)
    ruta = f"{m['cliente']}/{caso}/{uuid.uuid4()}.png"
    _uno(pg, entrada, caso, m["cliente"], "client", "evidence", None, ruta, "image/png", 10, "a" * 64)
    # La forma: una evidencia lleva su archivo entero; un mensaje, su texto.
    assert "service_incident_entries_forma" in _falla(
        pg, entrada, caso, m["cliente"], "client", "evidence", "sin archivo", None, None, None, None)
    assert "service_incident_entries_forma" in _falla(
        pg, entrada, caso, m["cliente"], "client", "message", None, None, None, None, None)
    assert "service_incident_entries_forma" in _falla(
        pg, entrada, caso, m["cliente"], "client", "message", "con archivo", ruta, "image/png", 10, "b" * 64)
    assert "service_incident_entries_peso" in _falla(
        pg, entrada, caso, m["cliente"], "client", "evidence", None, ruta, "image/png", 10 * 1024 * 1024 + 1, "c" * 64)
    assert "service_incident_entries_huella" in _falla(
        pg, entrada, caso, m["cliente"], "client", "evidence", None, ruta, "image/png", 10, "Z" * 64)
    # EL MISMO ARCHIVO no entra dos veces en un caso.
    assert "service_incident_entries_un_archivo" in _falla(
        pg, entrada, caso, m["perfil"], "provider", "evidence", None, ruta + "x", "image/png", 10, "a" * 64)
    # QUIÉN ESCRIBE QUÉ: la nota interna y la resolución, administración; la apelación, una parte.
    for tipo, rol in (("internal_note", "client"), ("resolution", "provider"), ("appeal", "admin")):
        assert "service_incident_entries_quien" in _falla(
            pg, entrada, caso, m["cliente"], rol, tipo, "No me toca.", None, None, None, None), tipo
    assert "service_incident_entries_rol" in _falla(
        pg, entrada, caso, m["cliente"], "system", "message", "Hola.", None, None, None, None)
    # NO SE REESCRIBE NI SE BORRA SUELTO.
    assert _falla(pg, "update public.service_incident_entries set body = 'Otra cosa.' where id = %s", mensaje)
    assert _falla(pg, "delete from public.service_incident_entries where id = %s", mensaje)
    assert _uno(pg, "select body from public.service_incident_entries where id = %s", mensaje) == "Adjunto la conversación."


# --- La reseña verificada --------------------------------------------------- #
@SIN_POSTGRES
def test_una_resena_es_de_una_atencion_cerrada_de_quien_la_contrato(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    r = _reservada(pg, m)
    verificada = "Una reseña es de una atención cerrada, de quien la contrató"
    # SIN ATENCIÓN, y con la atención en cada estado que no es «cerrada».
    assert verificada in _falla(pg, "insert into public.service_reviews (booking_id, service_id, author_id, rating, "
                                    "recommends, comment, status) values (%s, %s, %s, 5, true, %s, 'published')",
                                r["reserva"], m["servicio"], m["cliente"], COMENTARIO)
    _atender(pg, r["reserva"], "code_issued")
    anterior = "code_issued"
    for estado in ("in_progress", "completed", "no_show_provider"):
        _pasar(pg, r["reserva"], estado)
        assert verificada in _falla(
            pg, "insert into public.service_reviews (booking_id, service_id, author_id, rating, recommends, comment, "
                "status) values (%s, %s, %s, 5, true, %s, 'published')",
            r["reserva"], m["servicio"], m["cliente"], COMENTARIO), (anterior, estado)
        anterior = estado
    _hacer(pg, "update public.service_attendances set status = 'closed', closed_at = now(), closed_by = 'admin' "
               "where booking_id = %s", r["reserva"])
    # CERRADA, pero de OTRA persona, del prestador, de otro servicio, sin autor, o ya escondida o respondida.
    for autor, servicio, estado, respuesta in (
        (_persona(pg), m["servicio"], "published", None),
        (m["perfil"], m["servicio"], "published", None),
        (None, m["servicio"], "published", None),
        (m["cliente"], m["servicio"], "hidden", None),
        (m["cliente"], m["servicio"], "published", "Gracias."),
    ):
        assert verificada in _falla(
            pg, "insert into public.service_reviews (booking_id, service_id, author_id, rating, recommends, comment, "
                "status, reply, replied_at) values (%s, %s, %s, 5, true, %s, %s, %s, case when %s::text is null "
                "then null else now() end)",
            r["reserva"], servicio, autor, COMENTARIO, estado, respuesta, respuesta), (autor, estado, respuesta)
    assert "service_reviews_calificacion" in _falla(
        pg, "insert into public.service_reviews (booking_id, service_id, author_id, rating, recommends, comment, "
            "status) values (%s, %s, %s, 6, true, %s, 'published')", r["reserva"], m["servicio"], m["cliente"],
        COMENTARIO)
    resena = _resena(pg, r, m, estado="pending")
    # UNA POR RESERVA.
    assert "service_reviews_una_por_reserva" in _falla(
        pg, "insert into public.service_reviews (booking_id, service_id, author_id, rating, recommends, comment, "
            "status) values (%s, %s, %s, 1, false, %s, 'published')", r["reserva"], m["servicio"], m["cliente"],
        COMENTARIO)
    # NO SE REESCRIBE: ni la nota, ni el comentario, ni su autor, ni su reserva.
    for cambio in ("rating = 1", "comment = repeat('y', 30)", "recommends = false", "quality = 1",
                   "author_id = gen_random_uuid()", "created_at = now() - interval '1 day'"):
        assert "Una reseña no se reescribe" in _falla(
            pg, f"update public.service_reviews set {cambio} where id = %s", resena), cambio
    # LO QUE SÍ CAMBIA: su estado (moderación) y la respuesta del prestador, UNA vez.
    _hacer(pg, "update public.service_reviews set status = 'published', updated_at = now() where id = %s", resena)
    assert "service_reviews_respondida" in _falla(
        pg, "update public.service_reviews set reply = 'Gracias.' where id = %s", resena)
    _hacer(pg, "update public.service_reviews set reply = 'Gracias por venir.', replied_at = now() where id = %s",
           resena)
    assert "La respuesta a una reseña se escribe una vez" in _falla(
        pg, "update public.service_reviews set reply = 'Otra respuesta.' where id = %s", resena)
    assert "La respuesta a una reseña se escribe una vez" in _falla(
        pg, "update public.service_reviews set reply = null, replied_at = null where id = %s", resena)
    _hacer(pg, "update public.service_reviews set status = 'hidden' where id = %s", resena)
    assert "service_reviews_estado" in _falla(
        pg, "update public.service_reviews set status = 'deleted' where id = %s", resena)


# --- Lo que no se borra suelto, y la baja de una cuenta ----------------------- #
def _con_todo(pg, m: dict, *, inicio: str = PASADO) -> dict:  # noqa: F811
    """Una reserva YA PASADA con su atención cerrada, su caso con expediente y
    su reseña respondida."""
    r = _reservada(pg, m, inicio=inicio)
    _atender(pg, r["reserva"], "closed")
    r["caso"] = _caso(pg, r["reserva"], m["cliente"], motivo="quality")
    _hacer(pg, "insert into public.service_incident_entries (incident_id, author_id, author_role, kind, body) "
               "values (%s, %s, 'client', 'message', 'No era lo acordado.')", r["caso"], m["cliente"])
    _hacer(pg, "insert into public.service_incident_entries (incident_id, author_id, author_role, kind, "
               "storage_path, content_type, byte_size, sha256) values (%s, %s, 'client', 'evidence', %s, "
               "'image/png', 10, repeat('a', 64))", r["caso"], m["cliente"], f"{m['cliente']}/{r['caso']}/a.png")
    _hacer(pg, RESOLVER, "resolved", "none", "not_applicable", m["admin"], r["caso"])
    r["resena"] = _resena(pg, r, m)
    _hacer(pg, "update public.service_reviews set reply = 'Gracias.', replied_at = now() where id = %s", r["resena"])
    return r


def _cuentas(pg, r: dict) -> dict:  # noqa: F811
    return {
        "service_attendances": _uno(pg, "select count(*) from public.service_attendances where booking_id = %s",
                                    r["reserva"]),
        "service_incidents": _uno(pg, "select count(*) from public.service_incidents where booking_id = %s",
                                  r["reserva"]),
        "service_incident_entries": _uno(pg, "select count(*) from public.service_incident_entries "
                                             "where incident_id = %s", r["caso"]),
        "service_reviews": _uno(pg, "select count(*) from public.service_reviews where booking_id = %s",
                                r["reserva"]),
    }


@SIN_POSTGRES
def test_nada_se_borra_suelto(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    r = _con_todo(pg, m)
    antes = _cuentas(pg, r)
    assert antes == {"service_attendances": 1, "service_incidents": 1, "service_incident_entries": 2,
                     "service_reviews": 1}
    assert _falla(pg, "delete from public.service_attendances where booking_id = %s", r["reserva"])
    assert _falla(pg, "delete from public.service_incidents where id = %s", r["caso"])
    assert _falla(pg, "delete from public.service_incident_entries where incident_id = %s", r["caso"])
    assert _falla(pg, "delete from public.service_reviews where id = %s", r["resena"])
    assert _falla(pg, "delete from public.service_bookings where id = %s", r["reserva"])
    assert _cuentas(pg, r) == antes
    # Tampoco con `truncate`, que se salta los disparadores de fila pero no las claves.
    assert _falla(pg, "truncate public.service_incidents")


@SIN_POSTGRES
def test_la_baja_de_quien_contrata_conserva_el_caso_y_la_resena_sin_su_nombre(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    r = _con_todo(pg, m)
    antes = _cuentas(pg, r)
    _hacer(pg, "delete from auth.users where id = %s", m["cliente"])
    # LA RESERVA Y SU POSVENTA SE QUEDAN (son también del prestador), sin la cuenta.
    assert _uno(pg, "select client_id from public.service_bookings where id = %s", r["reserva"]) is None
    assert _cuentas(pg, r) == antes
    assert _todas(pg, "select author_id, rating, reply, status from public.service_reviews where id = %s",
                  r["resena"]) == [(None, 5, "Gracias.", "published")]
    # Quién abrió el caso y quién escribió queda como identificador sin cuenta (0086, S10).
    assert str(_uno(pg, "select opened_by from public.service_incidents where id = %s", r["caso"])) == m["cliente"]
    assert _uno(pg, "select count(*) from public.profiles where id = %s", m["cliente"]) == 0
    # Y después sigue sin poder reescribirse.
    assert "Una reseña no se reescribe" in _falla(
        pg, "update public.service_reviews set rating = 1 where id = %s", r["resena"])


@SIN_POSTGRES
def test_con_una_atencion_por_venir_la_cuenta_de_quien_contrata_no_se_borra(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    r = _reservada(pg, m)
    _atender(pg, r["reserva"], "code_issued")
    assert "Hay una reserva de Servicios por venir" in _falla(pg, "delete from auth.users where id = %s", m["cliente"])
    # CANCELADA, ya no la retiene.
    _cancelar(pg, r)
    _hacer(pg, "delete from auth.users where id = %s", m["cliente"])
    assert _uno(pg, "select count(*) from public.service_bookings where id = %s and client_id is null",
                r["reserva"]) == 1


@SIN_POSTGRES
@pytest.mark.parametrize("ultima", [None, "service_bookings", "service_reviews", "services"])
def test_la_baja_de_quien_presta_se_lleva_todo_en_cualquier_orden(pg, ultima) -> None:  # noqa: F811
    """Del prestador cuelga el servicio; del servicio, la reserva; de la
    reserva, la atención, el caso (y su expediente) y la reseña. La reseña
    apunta ADEMÁS al servicio, sin borrar nada y comprobado al confirmar: un
    solo camino de borrado. Aquí se recrea cada clave para que su disparador
    sea el último (PostgreSQL los dispara por el orden de su nombre) y se
    comprueba que la baja no depende de eso."""
    _montar(pg)
    m = _mundo(pg)
    r = _con_todo(pg, m)
    if ultima is not None:
        hija, madre = {
            "service_bookings": ("service_bookings", "services"),
            "service_reviews": ("service_reviews", "services"),
            "services": ("services", "service_providers"),
        }[ultima]
        nombre = _uno(pg, "select conname from pg_catalog.pg_constraint where conrelid = %s::regclass "
                          "and contype = 'f' and confrelid = %s::regclass", f"public.{hija}", f"public.{madre}")
        definicion = _uno(pg, "select pg_get_constraintdef(oid) from pg_catalog.pg_constraint "
                              "where conrelid = %s::regclass and conname = %s", f"public.{hija}", nombre)
        with pg.transaction():
            _hacer(pg, f'alter table public.{hija} drop constraint "{nombre}"')
            _hacer(pg, f'alter table public.{hija} add constraint "{nombre}" {definicion}')
    _hacer(pg, "delete from auth.users where id = %s", m["perfil"])
    assert _uno(pg, "select count(*) from public.services where id = %s", m["servicio"]) == 0
    assert _uno(pg, "select count(*) from public.service_bookings where id = %s", r["reserva"]) == 0
    assert _cuentas(pg, r) == {t: 0 for t in TABLAS}
    # La cuenta de quien contrató sigue entera.
    assert _uno(pg, "select count(*) from public.profiles where id = %s", m["cliente"]) == 1


@SIN_POSTGRES
def test_la_resena_apunta_al_servicio_de_su_reserva_sin_borrar_nada(pg) -> None:  # noqa: F811
    """La clave al servicio NO BORRA (un solo camino de borrado: la reserva) y
    se comprueba al confirmar; y el servicio de la reseña es el de su reserva."""
    _montar(pg)
    m = _mundo(pg)
    r = _reservada(pg, m, inicio=PASADO)
    _atender(pg, r["reserva"], "closed")
    assert _todas(
        pg, "select confdeltype::text, condeferrable, condeferred, convalidated from pg_constraint "
            "where conrelid = 'public.service_reviews'::regclass and confrelid = 'public.services'::regclass"
    ) == [("a", True, True, True)]
    assert _falla(pg, "insert into public.service_reviews (booking_id, service_id, author_id, rating, recommends, "
                      "comment, status) values (%s, %s, %s, 5, true, %s, 'published')",
                  r["reserva"], str(uuid.uuid4()), m["cliente"], COMENTARIO)
    assert _uno(pg, "select count(*) from public.service_reviews") == 0


# =========================================================================== #
# 3. La aplicación
# =========================================================================== #
def _de_la_0093(pg) -> dict:  # noqa: F811
    """Lo que la 0094 cambia de la 0093: tres CHECK, dos funciones y un disparador."""
    return {
        "check": _todas(pg, "select conname, pg_get_constraintdef(oid) from pg_constraint where conname in "
                            "('service_bookings_estado', 'service_booking_events_accion', "
                            "'service_booking_events_rol') order by 1"),
        "funciones": _todas(pg, "select proname, md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace "
                                "and proname in ('servicios_reserva_inmutable', 'servicios_retencion_salto_valido') "
                                "order by 1"),
        "disparadores": _uno(pg, "select count(*) from pg_trigger where not tgisinternal "
                                 "and tgrelid = 'public.service_bookings'::regclass"),
    }


def _nada_de_la_0094(pg, antes: dict) -> None:  # noqa: F811
    for tabla in TABLAS:
        assert _uno(pg, "select to_regclass(%s)", f"public.{tabla}") is None, tabla
    for funcion in FUNCIONES:
        assert _uno(pg, "select to_regprocedure(%s)", f"public.{funcion}()") is None, funcion
    assert _uno(pg, "select count(*) from storage.buckets where id = %s", DEPOSITO) == 0
    assert _de_la_0093(pg) == antes


@SIN_POSTGRES
def test_sobre_la_0093_con_reservas_no_toca_nada_y_despues_se_pueden_atender(pg) -> None:  # noqa: F811
    _montar(pg, hasta="0093")
    m = _mundo(pg)
    r = _reservada(pg, m)
    pasada = _reservada(pg, m, inicio=PASADO, cliente=_persona(pg))
    _retencion(pg, m["servicio"], m["version"], _persona(pg), inicio=OTRO_DIA)
    tablas = TABLAS_DE_LA_0093 + ("profiles", "service_providers", "services", "service_versions",
                                 "service_policies", "service_events")
    antes = _huellas(pg, tablas)
    # ANTES de la 0094, una reserva no se cancela.
    assert _falla(pg, CANCELAR, r["reserva"])
    _hacer(pg, TEXTO)
    assert _huellas(pg, tablas) == antes
    for tabla in TABLAS:
        assert _uno(pg, f"select count(*) from public.{tabla}") == 0
    # Y LO QUE YA ESTABA se atiende, se cancela y se reseña con las reglas nuevas.
    _cancelar(pg, r)
    _atender(pg, pasada["reserva"], "closed")
    assert _resena(pg, pasada, m)


@SIN_POSTGRES
def test_reejecutarla_deja_exactamente_lo_mismo_tambien_con_datos(pg) -> None:  # noqa: F811
    _montar(pg)
    m = _mundo(pg)
    r = _con_todo(pg, m)
    cancelada = _reservada(pg, m, cliente=_persona(pg))
    _cancelar(pg, cancelada)
    foto, datos = _foto(pg), _huellas(pg, TABLAS + TABLAS_DE_LA_0093)
    permisos = _todas(pg, "select proname, proacl::text from pg_proc where pronamespace = 'public'::regnamespace "
                          "and proname like 'servicios_%%' order by 1")
    deposito = _todas(pg, "select * from storage.buckets where id = %s", DEPOSITO)
    _hacer(pg, TEXTO)
    _hacer(pg, TEXTO)
    assert _foto(pg) == foto
    assert _huellas(pg, TABLAS + TABLAS_DE_LA_0093) == datos
    assert _todas(pg, "select proname, proacl::text from pg_proc where pronamespace = 'public'::regnamespace "
                      "and proname like 'servicios_%%' order by 1") == permisos
    assert _todas(pg, "select * from storage.buckets where id = %s", DEPOSITO) == deposito
    assert _cuentas(pg, r) == {"service_attendances": 1, "service_incidents": 1, "service_incident_entries": 2,
                               "service_reviews": 1}


@SIN_POSTGRES
def test_un_fallo_a_mitad_no_deja_nada(pg) -> None:  # noqa: F811
    import psycopg

    _montar(pg, hasta="0093")
    antes = _de_la_0093(pg)
    foto = _foto(pg)
    for marca in ("-- 8. El depósito privado de las evidencias de un caso.", "-- 10. Lo que tiene que quedar, o nada."):
        corte = TEXTO.index(marca)
        with pytest.raises(psycopg.Error):
            _hacer(pg, TEXTO[:corte] + "\nselect 1 / 0;\ncommit;\n")
        _hacer(pg, "rollback")
        _nada_de_la_0094(pg, antes)
        assert _foto(pg) == foto


@SIN_POSTGRES
def test_se_niega_a_terminar_incompleta(pg) -> None:  # noqa: F811
    import psycopg

    _montar(pg, hasta="0093")
    antes = _de_la_0093(pg)
    for viciada, mensaje in (
        (TEXTO.replace("alter table public.service_reviews enable row level security;", ""), "sin RLS"),
        (TEXTO.replace("revoke all on public.service_incidents from anon, authenticated;",
                       "grant select on public.service_incidents to authenticated;"), "permisos sueltos"),
        (TEXTO.replace("  after update on public.service_bookings\n  deferrable initially deferred",
                       "  after update on public.service_bookings\n  deferrable initially immediate"),
         "al confirmar de la reserva"),
        (TEXTO.replace("  check (status in ('confirmed', 'cancelled'));", "  check (status in ('confirmed'));"),
         "no amplió los CHECK"),
        (TEXTO.replace("financial_effect_status in ('not_applicable', 'pending', 'blocked')",
                       "financial_effect_status in ('not_applicable', 'pending', 'blocked', 'executed')"),
         "estado ejecutado"),
        (TEXTO.replace("create trigger service_reviews_verificadas\n  before insert or update on public.service_reviews\n"
                       "  for each row\n  execute function public.servicios_resena_verificada();", ""),
         "no dejó sus disparadores"),
        (TEXTO.replace("  service_id uuid not null\n    references public.services(id) deferrable initially deferred,",
                       "  service_id uuid not null,"), "claves ajenas"),
        (TEXTO.replace("set\n  public = false,", "set\n  public = true,"), "depósito privado"),
        (TEXTO.replace("revoke all on function public.servicios_resena_verificada() from public, anon, authenticated;",
                       "grant execute on function public.servicios_resena_verificada() to anon;"),
         "ejecutable desde fuera"),
    ):
        assert viciada != TEXTO, mensaje
        with pytest.raises(psycopg.Error) as error:
            _hacer(pg, viciada)
        assert mensaje in str(error.value), (mensaje, str(error.value))
        _hacer(pg, "rollback")
        _nada_de_la_0094(pg, antes)


@SIN_POSTGRES
def test_sin_cada_dependencia_se_niega_y_no_crea_nada(pg) -> None:  # noqa: F811
    import psycopg

    for preparar, mensaje in (
        (lambda: _montar(pg, hasta="0092"), "0086–0093"),
        (lambda: (_montar(pg, hasta="0093"),
                  _hacer(pg, "drop function public.es_anonimizacion_por_baja(jsonb, jsonb, text[])")), "funciones"),
        (lambda: (_montar(pg, hasta="0093"),
                  _hacer(pg, "drop function public.servicios_catalogo_historial_inmutable() cascade")), "funciones"),
        (lambda: (_montar(pg, hasta="0093"),
                  _hacer(pg, "alter table public.service_bookings drop constraint service_bookings_estado")),
         "CHECK de la 0093"),
        (lambda: (_montar(pg, hasta="0093"),
                  _hacer(pg, "alter table public.service_booking_events drop constraint service_booking_events_rol")),
         "CHECK de la 0093"),
        (lambda: (_montar(pg, hasta="0093"), _hacer(pg, "drop table storage.buckets cascade")), "storage.buckets"),
    ):
        preparar()
        with pytest.raises(psycopg.Error) as error:
            _hacer(pg, TEXTO)
        assert mensaje in str(error.value), (mensaje, str(error.value))
        _hacer(pg, "rollback")
        for tabla in TABLAS:
            assert _uno(pg, "select to_regclass(%s)", f"public.{tabla}") is None, (mensaje, tabla)


@SIN_POSTGRES
def test_la_0093_ya_no_se_reejecuta_encima_y_al_negarse_no_cambia_nada(pg) -> None:  # noqa: F811
    """DELIBERADO. Reejecutar la 0093 sobre una base con la 0094 devolvería a
    dos funciones su cuerpo anterior (y cancelar y reprogramar dejarían de
    funcionar). Su verificación final cuenta sus disparadores, ve uno más y
    aborta: la transacción entera se deshace."""
    import psycopg

    _montar(pg)
    m = _mundo(pg)
    r = _reservada(pg, m)
    foto = _foto(pg)
    with pytest.raises(psycopg.Error):
        _hacer(pg, LA_0093)
    _hacer(pg, "rollback")
    assert _foto(pg) == foto
    # Y cancelar sigue funcionando.
    _cancelar(pg, r)


def _deshacer_segun_la_cabecera() -> str:
    """El ROLLBACK tal como lo documenta la cabecera de la 0094."""
    inicio = TEXTO.index("-- ROLLBACK")
    fin = TEXTO.index("-- Y DESPUÉS, reejecutar la 0093 entera", inicio)
    return "\n".join(linea[2:] for linea in TEXTO[inicio:fin].splitlines() if linea.startswith("--   "))


@SIN_POSTGRES
def test_el_rollback_de_la_cabecera_devuelve_la_0093_y_se_niega_con_datos(pg) -> None:  # noqa: F811
    import psycopg

    deshacer = _deshacer_segun_la_cabecera()
    assert deshacer.strip().startswith("begin;") and deshacer.strip().endswith("commit;"), deshacer

    _montar(pg, hasta="0093")
    de_la_0093, foto_de_la_0093 = _de_la_0093(pg), _foto(pg)
    m = _mundo(pg)
    r = _reservada(pg, m)
    datos = _huellas(pg, TABLAS_DE_LA_0093)
    _hacer(pg, TEXTO)

    # SIN DATOS de la atención: se deshace, y con la 0093 reejecutada queda como antes.
    _hacer(pg, deshacer)
    _hacer(pg, LA_0093)
    assert _de_la_0093(pg) == de_la_0093
    assert _foto(pg) == foto_de_la_0093
    assert _huellas(pg, TABLAS_DE_LA_0093) == datos
    for tabla in TABLAS:
        assert _uno(pg, "select to_regclass(%s)", f"public.{tabla}") is None, tabla
    assert _uno(pg, "select count(*) from storage.buckets where id = %s", DEPOSITO) == 0
    # Y la 0094 se puede volver a aplicar encima.
    _hacer(pg, TEXTO)

    # CON DATOS, se niega y no borra nada: una atención, un caso, una cancelada o una línea del historial.
    def _se_niega() -> None:
        with pytest.raises(psycopg.Error) as error:
            _hacer(pg, deshacer)
        assert "Hay datos de la atención" in str(error.value)
        _hacer(pg, "rollback")
        for tabla in TABLAS:
            assert _uno(pg, "select to_regclass(%s)", f"public.{tabla}") is not None, tabla

    _hacer(pg, "insert into public.service_booking_events (service_id, booking_id, action, to_status, actor_id, "
               "actor_role) values (%s, %s, 'booking_reminded', 'confirmed', null, 'system')",
           m["servicio"], r["reserva"])
    _se_niega()
    _atender(pg, r["reserva"], "code_issued")
    _se_niega()
    _cancelar(pg, r)
    _se_niega()
