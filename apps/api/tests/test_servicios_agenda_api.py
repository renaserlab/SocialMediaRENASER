"""La agenda de Servicios por la API real, contra PostgreSQL (Incremento 4).

Con la base 0001–0092 desechable, el Storage en memoria y `FEATURE_SERVICES`
encendida SOLO aquí. Los servicios se publican por el flujo real del
Incremento 2.

LO QUE SE COMPRUEBA: el recorrido del prestador (configurar, semana,
excepciones, bloqueos, vista previa), lo público (fechas, horarios, cursor,
límites, nada privado), quién puede qué (dueño, otro prestador, moderación,
administración, persona sin prestador, visitante), el cambio de zona, las
carreras con PostgreSQL de verdad, la puerta de la 0092, la bandera apagada y
que nada de esto crea una reserva, una retención ni un movimiento de dinero.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.modules.services import esquema
from app.shared.database import get_db
from tests.test_baja_de_cuenta_postgres import API, SIN_POSTGRES, _cliente, _filas, _persona, _sembrar, _uno
from tests.test_servicios_catalogo_api import ADMIN, BANDEJA, MIOS, _accion, _equipo, _prestador
from tests.test_servicios_descubrimiento_api import (  # noqa: F401 - montajes compartidos
    CATALOGO,
    _anonimo,
    _categoria,
    _hasta,
    base_aplicada,
    entorno,
    mundo,
)

pytestmark = [SIN_POSTGRES, pytest.mark.asyncio]

LIMA = ZoneInfo("America/Lima")
#: Lo que NUNCA puede salir en una respuesta pública de horarios.
PRIVADO = ("reason", "rules", "blocks", "exceptions", "rule_id", "block_id", "Dentista", "provider", "profile")
#: Las tablas de reservas, retenciones y dinero: la agenda no escribe en ninguna.
DE_DINERO_Y_RESERVAS = (
    "bookings", "orders", "entitlements", "event_orders", "event_ticket_holds", "event_ticket_hold_items",
    "product_orders", "payment_transactions", "payment_events", "owner_transfers", "owner_sale_reserves",
    "refund_requests", "product_refunds",
    # Las de la reserva de Servicios (0093): la agenda no escribe en ellas.
    "service_holds", "service_orders", "service_bookings",
)


def _agenda(servicio: str) -> str:
    return f"{MIOS}/{servicio}/schedule"


def _publica(servicio: str) -> str:
    return f"{CATALOGO}/{servicio}/availability"


def _hoy() -> date:
    return datetime.now(LIMA).date()


def _dia(dias: int) -> str:
    return (_hoy() + timedelta(days=dias)).isoformat()


async def _pedir(app, metodo: str, ruta: str, uid: str | None, cuerpo: dict | None = None, clave: str | None = None, **params):
    cabeceras = {"Idempotency-Key": clave} if clave else None
    async with (_cliente(app, uid) if uid else _anonimo(app)) as http:
        return await http.request(
            metodo, ruta, json=cuerpo, headers=cabeceras, params={k: v for k, v in params.items() if v is not None}
        )


def _codigo(r) -> str | None:
    try:
        return r.json()["error"]["code"]
    except Exception:  # noqa: BLE001
        return None


async def _configurada(app, perfil: str, servicio: str, *, despues: int = 15, semana: bool = True, **extra) -> dict:
    r = await _pedir(app, "PUT", _agenda(servicio), perfil, {"timezone": "America/Lima", "buffer_after_minutes": despues, **extra})
    assert r.status_code == 201, r.text
    if semana:
        for dia in range(1, 8):
            r = await _pedir(app, "POST", f"{_agenda(servicio)}/rules", perfil,
                             {"weekday": dia, "start": "09:00", "end": "12:00", "modality": "virtual"})
            assert r.status_code == 201, r.text
    return r.json()


async def _publicado_con_agenda(app, motor, **contenido) -> tuple[str, str, str, str]:
    """`(perfil, servicio, jefa, moderador)`: publicado, virtual, 60 minutos,
    con agenda de 09:00 a 12:00 todos los días y 15 minutos de descanso."""
    jefa, moderador = await _equipo(motor)
    categoria = (await _categoria(app, jefa))["id"]
    perfil = await _prestador(motor)
    servicio = await _hasta(app, perfil, jefa, moderador, categoria, "published", duration_minutes=60, **contenido)
    await _configurada(app, perfil, servicio)
    return perfil, servicio, jefa, moderador


async def _eventos(motor, servicio: str) -> list[tuple]:
    return await _filas(
        motor,
        "select action, details::text from public.service_schedule_events where service_id = cast(:s as uuid) "
        "order by created_at, id",
        s=servicio,
    )


async def _conteos(motor) -> dict:
    return {t: await _uno(motor, f"select count(*) from public.{t}") for t in DE_DINERO_Y_RESERVAS}


# =========================================================================== #
# 1. El prestador
# =========================================================================== #
async def test_un_borrador_prepara_su_agenda_y_el_publico_no_la_ve(mundo) -> None:
    app, motor, _ = mundo
    jefa, moderador = await _equipo(motor)
    categoria = (await _categoria(app, jefa))["id"]
    perfil = await _prestador(motor)
    servicio = await _hasta(app, perfil, jefa, moderador, categoria, "draft", duration_minutes=60)

    r = await _pedir(app, "GET", _agenda(servicio), perfil)
    assert r.status_code == 200, r.text
    vacia = r.json()
    assert vacia["configured"] is False and vacia["can_edit"] is True
    assert vacia["issues"] == ["service_not_public", "schedule_missing"]
    assert vacia["limits"]["notice_minutes"] == 120 and vacia["limits"]["horizon_days"] == 60
    assert vacia["service"]["offered_modalities"] == ["virtual"] and vacia["service"]["capacity"] == 1

    # Sin agenda no hay semana.
    r = await _pedir(app, "POST", f"{_agenda(servicio)}/rules", perfil,
                     {"weekday": 1, "start": "09:00", "end": "12:00", "modality": "virtual"})
    assert r.status_code == 409 and _codigo(r) == "service_schedule_missing"
    # Una zona que no es IANA con lugar, o que no existe: 422.
    for zona in ("UTC-5", "Etc/GMT+5", "America/Atlantida", "UTC"):
        r = await _pedir(app, "PUT", _agenda(servicio), perfil, {"timezone": zona})
        assert r.status_code == 422 and _codigo(r) == "service_schedule_timezone_invalid", zona
    for cuerpo in ({"buffer_after_minutes": 7}, {"slot_interval_minutes": 32}):
        r = await _pedir(app, "PUT", _agenda(servicio), perfil, {"timezone": "America/Lima", **cuerpo})
        assert r.status_code == 422 and _codigo(r) == "service_schedule_settings_invalid", cuerpo

    agenda = await _configurada(app, perfil, servicio)
    assert agenda["configured"] is True and agenda["timezone"] == "America/Lima"
    assert len(agenda["rules"]) == 7 and agenda["next_available"] is not None
    assert "service_not_public" in agenda["issues"] and "schedule_missing" not in agenda["issues"]

    # La vista previa enseña lo que vería una persona.
    previa = (await _pedir(app, "GET", f"{_agenda(servicio)}/preview", perfil)).json()
    assert previa["status"] == "active" and previa["days"] and "service_not_public" in previa["issues"]
    horarios = (await _pedir(app, "GET", f"{_agenda(servicio)}/preview/{_dia(7)}", perfil)).json()
    assert [h["time"] for h in horarios["items"]] == ["09:00", "10:15"]
    # El público, no: un borrador es el mismo 404 que lo que no existe.
    for ruta in (_publica(servicio), f"{_publica(servicio)}/{_dia(7)}"):
        r = await _pedir(app, "GET", ruta, None)
        assert r.status_code == 404 and _codigo(r) == "service_not_found"


async def test_la_semana_sin_cruces_ni_franjas_imposibles(mundo) -> None:
    app, motor, _ = mundo
    perfil, servicio, _, _ = await _publicado_con_agenda(app, motor)
    reglas = f"{_agenda(servicio)}/rules"
    for cuerpo, estado, codigo in (
        ({"weekday": 1, "start": "11:00", "end": "13:00", "modality": "virtual"}, 409, "service_schedule_overlap"),
        ({"weekday": 1, "start": "13:00", "end": "13:00", "modality": "virtual"}, 422, "service_schedule_time_invalid"),
        ({"weekday": 1, "start": "14:00", "end": "13:00", "modality": "virtual"}, 422, "service_schedule_time_invalid"),
        ({"weekday": 1, "start": "13:07", "end": "14:00", "modality": "virtual"}, 422, "service_schedule_time_invalid"),
        ({"weekday": 1, "start": "24:00", "end": "24:00", "modality": "virtual"}, 422, "service_schedule_time_invalid"),
        ({"weekday": 1, "start": "13:00", "end": "14:00", "modality": "in_person"}, 422, "service_schedule_modality_invalid"),
        ({"weekday": 1, "start": "13:00", "end": "14:00", "modality": "virtual", "capacity": 2}, 422,
         "service_schedule_capacity_invalid"),
    ):
        r = await _pedir(app, "POST", reglas, perfil, cuerpo)
        assert (r.status_code, _codigo(r)) == (estado, codigo), (cuerpo, r.text)
    # Tocarse no es cruzarse: 12:00–14:00 el lunes.
    r = await _pedir(app, "POST", reglas, perfil, {"weekday": 1, "start": "12:00", "end": "14:00", "modality": "virtual"})
    assert r.status_code == 201, r.text
    lunes = [x for x in r.json()["rules"] if x["weekday"] == 1]
    assert [(x["start"], x["end"]) for x in lunes] == [("09:00", "12:00"), ("12:00", "14:00")]
    # Desactivar deja espacio; reactivar lo que ya se cruza, no.
    manana = lunes[0]["id"]
    assert (await _pedir(app, "PATCH", f"{reglas}/{manana}", perfil, {"active": False})).status_code == 200
    r = await _pedir(app, "POST", reglas, perfil, {"weekday": 1, "start": "10:00", "end": "11:00", "modality": "virtual"})
    assert r.status_code == 201, r.text
    r = await _pedir(app, "PATCH", f"{reglas}/{manana}", perfil, {"active": True})
    assert r.status_code == 409 and _codigo(r) == "service_schedule_overlap"
    # Editar mueve la franja; borrar dos veces es un 404 la segunda.
    r = await _pedir(app, "PATCH", f"{reglas}/{manana}", perfil, {"start": "07:00", "end": "08:00", "active": True})
    assert r.status_code == 200, r.text
    assert (await _pedir(app, "DELETE", f"{reglas}/{manana}", perfil)).status_code == 200
    r = await _pedir(app, "DELETE", f"{reglas}/{manana}", perfil)
    assert r.status_code == 404 and _codigo(r) == "service_schedule_item_not_found"
    r = await _pedir(app, "PATCH", f"{reglas}/no-es-un-id", perfil, {"active": False})
    assert r.status_code == 404 and _codigo(r) == "service_schedule_item_not_found"


async def test_excepciones_de_fecha_y_su_precedencia(mundo) -> None:
    app, motor, _ = mundo
    perfil, servicio, _, _ = await _publicado_con_agenda(app, motor)
    excepciones = f"{_agenda(servicio)}/exceptions"
    horas = lambda fecha: _pedir(app, "GET", f"{_publica(servicio)}/{fecha}", None)  # noqa: E731

    assert [h["time"] for h in (await horas(_dia(8))).json()["items"]] == ["09:00", "10:15"]
    # Cerrar el día entero.
    r = await _pedir(app, "POST", excepciones, perfil, {"date": _dia(8), "kind": "closed"})
    assert r.status_code == 201, r.text
    assert (await horas(_dia(8))).json()["items"] == []
    # Otra excepción esa fecha: el día cerrado no admite nada más.
    r = await _pedir(app, "POST", excepciones, perfil,
                     {"date": _dia(8), "kind": "extra", "start": "15:00", "end": "16:00", "modality": "virtual"})
    assert r.status_code == 409 and _codigo(r) == "service_schedule_overlap"
    # Sustituir la semana otro día, y cerrar una franja de lo sustituido.
    r = await _pedir(app, "POST", excepciones, perfil,
                     {"date": _dia(9), "kind": "replace", "start": "15:00", "end": "18:00", "modality": "virtual"})
    assert r.status_code == 201, r.text
    assert [h["time"] for h in (await horas(_dia(9))).json()["items"]] == ["15:00", "16:15"]
    r = await _pedir(app, "POST", excepciones, perfil, {"date": _dia(9), "kind": "closed", "start": "16:00", "end": "16:30"})
    assert r.status_code == 409, r.text  # se pisa con la sustitución: la fecha quedaría ambigua
    # Añadir una franja extraordinaria a otro día.
    r = await _pedir(app, "POST", excepciones, perfil,
                     {"date": _dia(10), "kind": "extra", "start": "12:00", "end": "14:00", "modality": "virtual"})
    assert r.status_code == 201, r.text
    # Se junta con la semanal (09–12) en 09–14: la rejilla sigue de 75 en 75.
    assert [h["time"] for h in (await horas(_dia(10))).json()["items"]] == ["09:00", "10:15", "11:30", "12:45"]
    # Lo incoherente o lo pasado, 422.
    for cuerpo, codigo in (
        ({"date": _dia(-1), "kind": "closed"}, "service_schedule_date_invalid"),
        ({"date": _dia(400), "kind": "closed"}, "service_schedule_date_invalid"),
        ({"date": "2026-02-30", "kind": "closed"}, "service_schedule_date_invalid"),
        ({"date": _dia(11), "kind": "extra"}, "service_schedule_exception_invalid"),
        ({"date": _dia(11), "kind": "closed", "start": "09:00", "end": "10:00", "modality": "virtual"},
         "service_schedule_exception_invalid"),
        ({"date": _dia(11), "kind": "extra", "start": "09:00", "end": "10:00", "modality": "at_home"},
         "service_schedule_modality_invalid"),
    ):
        r = await _pedir(app, "POST", excepciones, perfil, cuerpo)
        assert r.status_code == 422 and _codigo(r) == codigo, (cuerpo, r.text)
    # Editar y retirar.
    agenda = (await _pedir(app, "GET", _agenda(servicio), perfil)).json()
    extra = next(e for e in agenda["exceptions"] if e["kind"] == "extra")
    r = await _pedir(app, "PATCH", f"{excepciones}/{extra['id']}", perfil, {"end": "13:00"})
    assert r.status_code == 200, r.text
    assert [h["time"] for h in (await horas(_dia(10))).json()["items"]] == ["09:00", "10:15", "11:30"]
    assert (await _pedir(app, "DELETE", f"{excepciones}/{extra['id']}", perfil)).status_code == 200
    assert (await _pedir(app, "DELETE", f"{excepciones}/{extra['id']}", perfil)).status_code == 404


async def test_un_bloqueo_es_privado_y_quita_lo_que_toca(mundo) -> None:
    app, motor, _ = mundo
    perfil, servicio, _, _ = await _publicado_con_agenda(app, motor)
    bloqueos = f"{_agenda(servicio)}/blocks"
    r = await _pedir(app, "POST", bloqueos, perfil, {
        "start_date": _dia(7), "start_time": "10:30", "end_date": _dia(7), "end_time": "10:35",
        "reason": "Dentista a las diez y media",
    })
    assert r.status_code == 201, r.text
    (bloqueo,) = r.json()["blocks"]
    assert bloqueo["reason"] == "Dentista a las diez y media"
    assert (bloqueo["start_time"], bloqueo["end_time"]) == ("10:30", "10:35")
    assert bloqueo["starts_at"].endswith("-05:00")
    # El horario de las 10:15 (con su descanso hasta las 11:30) desaparece.
    publica = await _pedir(app, "GET", f"{_publica(servicio)}/{_dia(7)}", None)
    assert [h["time"] for h in publica.json()["items"]] == ["09:00"]
    # Ni el calendario, ni el día, ni el historial dicen el motivo.
    for r in (publica, await _pedir(app, "GET", _publica(servicio), None)):
        crudo = json.dumps(r.json(), ensure_ascii=False)
        for prohibido in PRIVADO:
            assert prohibido not in crudo, prohibido
    assert all("Dentista" not in d for _, d in await _eventos(motor, servicio))
    # Lo imposible, 422.
    for cuerpo, codigo in (
        ({"start_date": _dia(7), "start_time": "11:00", "end_date": _dia(7), "end_time": "10:00"}, "service_schedule_block_invalid"),
        ({"start_date": _dia(-2), "start_time": "10:00", "end_date": _dia(-1), "end_time": "10:00"}, "service_schedule_block_invalid"),
        ({"start_date": _dia(1), "start_time": "10:00", "end_date": _dia(40), "end_time": "10:00"}, "service_schedule_block_invalid"),
        ({"start_date": _dia(1), "start_time": "10:03", "end_date": _dia(1), "end_time": "11:00"}, "service_schedule_time_invalid"),
    ):
        r = await _pedir(app, "POST", bloqueos, perfil, cuerpo)
        assert r.status_code == 422 and _codigo(r) == codigo, (cuerpo, r.text)
    r = await _pedir(app, "POST", bloqueos, perfil,
                     {"start_date": _dia(1), "start_time": "10:00", "end_date": _dia(1), "end_time": "11:00", "reason": "x" * 201})
    assert r.status_code == 422
    # Retirarlo devuelve el horario.
    assert (await _pedir(app, "DELETE", f"{bloqueos}/{bloqueo['id']}", perfil)).status_code == 200
    publica = await _pedir(app, "GET", f"{_publica(servicio)}/{_dia(7)}", None)
    assert [h["time"] for h in publica.json()["items"]] == ["09:00", "10:15"]
    assert [a for a, _ in await _eventos(motor, servicio)][-2:] == ["block_created", "block_deleted"]


async def test_repetir_con_la_misma_clave_no_duplica(mundo) -> None:
    app, motor, _ = mundo
    perfil, servicio, _, _ = await _publicado_con_agenda(app, motor)
    clave = f"clave-{uuid.uuid4().hex}"
    cuerpo = {"start_date": _dia(3), "start_time": "10:00", "end_date": _dia(3), "end_time": "11:00", "reason": "Viaje"}
    primero = await _pedir(app, "POST", f"{_agenda(servicio)}/blocks", perfil, cuerpo, clave)
    segundo = await _pedir(app, "POST", f"{_agenda(servicio)}/blocks", perfil, cuerpo, clave)
    assert (primero.status_code, segundo.status_code) == (201, 200)
    assert len(segundo.json()["blocks"]) == 1
    # La misma clave para otra acción es un error de quien llama.
    r = await _pedir(app, "POST", f"{_agenda(servicio)}/exceptions", perfil, {"date": _dia(5), "kind": "closed"}, clave)
    assert r.status_code == 409 and _codigo(r) == "idempotency_key_reused"
    # Configurar igual dos veces no deja dos eventos.
    antes = len(await _eventos(motor, servicio))
    r = await _pedir(app, "PUT", _agenda(servicio), perfil, {"timezone": "America/Lima", "buffer_after_minutes": 15})
    assert r.status_code == 200 and len(await _eventos(motor, servicio)) == antes


async def test_cambiar_la_zona_se_confirma_y_no_mueve_los_bloqueos(mundo) -> None:
    app, motor, _ = mundo
    perfil, servicio, _, _ = await _publicado_con_agenda(app, motor)
    r = await _pedir(app, "POST", f"{_agenda(servicio)}/blocks", perfil,
                     {"start_date": _dia(7), "start_time": "10:00", "end_date": _dia(7), "end_time": "11:00"})
    antes = r.json()["blocks"][0]
    r = await _pedir(app, "PUT", _agenda(servicio), perfil, {"timezone": "America/Bogota", "buffer_after_minutes": 15})
    assert r.status_code == 409 and _codigo(r) == "service_schedule_timezone_unconfirmed"
    assert r.json()["error"]["details"] == {"from": "America/Lima", "to": "America/Bogota"}
    r = await _pedir(app, "PUT", _agenda(servicio), perfil,
                     {"timezone": "America/New_York", "buffer_after_minutes": 15, "confirm_timezone_change": True})
    assert r.status_code == 200, r.text
    despues = r.json()["blocks"][0]
    # El mismo instante; otra hora local.
    assert datetime.fromisoformat(despues["starts_at"]) == datetime.fromisoformat(antes["starts_at"])
    assert despues["start_time"] != antes["start_time"]
    (evento,) = [d for a, d in await _eventos(motor, servicio) if a == "schedule_updated"]
    assert json.loads(evento)["changes"]["timezone"] == ["America/Lima", "America/New_York"]
    publica = (await _pedir(app, "GET", _publica(servicio), None)).json()
    assert publica["timezone"] == "America/New_York"


# =========================================================================== #
# 2. Lo público
# =========================================================================== #
async def test_lo_publico_solo_trae_horarios_y_respeta_el_horizonte(mundo) -> None:
    app, motor, _ = mundo
    _, servicio, _, _ = await _publicado_con_agenda(app, motor)
    r = await _pedir(app, "GET", _publica(servicio), None)
    assert r.status_code == 200, r.text
    calendario = r.json()
    assert set(calendario) == {
        "timezone", "status", "modality", "duration_minutes", "today", "last_date", "from_date", "to_date",
        "days", "next", "issues", "booking_available",
    }
    # La contratación (Incremento 5) tiene su propia bandera, apagada aquí.
    assert calendario["booking_available"] is False
    assert calendario["issues"] == [] and calendario["status"] == "active"
    assert calendario["timezone"] == "America/Lima" and calendario["modality"] == "virtual"
    assert calendario["from_date"] == _hoy().isoformat() and len(calendario["days"]) >= 29
    assert all(d["count"] in (1, 2) for d in calendario["days"])
    siguiente = calendario["next"]
    assert set(siguiente) == {"starts_at", "ends_at", "date", "time", "end_time", "utc_offset", "capacity"}
    assert siguiente["utc_offset"] == "-05:00" and siguiente["capacity"] == 1
    # Lo abusivo, un 422 estable.
    for params, codigo in (
        ({"from": _dia(0), "to": _dia(40)}, "service_availability_range_invalid"),
        ({"from": _dia(5), "to": _dia(2)}, "service_availability_range_invalid"),
        ({"from": "mañana"}, "service_availability_range_invalid"),
        ({"from": _dia(-1), "to": _dia(3)}, "service_availability_out_of_horizon"),
        ({"from": _dia(55), "to": _dia(70)}, "service_availability_out_of_horizon"),
        ({"modality": "in_person"}, "service_availability_modality_invalid"),
    ):
        r = await _pedir(app, "GET", _publica(servicio), None, **params)
        assert r.status_code == 422 and _codigo(r) == codigo, (params, r.text)
    for ruta, params, codigo in (
        (f"{_publica(servicio)}/{_dia(90)}", {}, "service_availability_out_of_horizon"),
        (f"{_publica(servicio)}/31-12-2026", {}, "service_availability_range_invalid"),
        (f"{_publica(servicio)}/{_dia(3)}", {"cursor": "ayer"}, "invalid_cursor"),
    ):
        r = await _pedir(app, "GET", ruta, None, **params)
        assert r.status_code == 422 and _codigo(r) == codigo, (ruta, r.text)
    r = await _pedir(app, "GET", f"{_publica(servicio)}/{_dia(3)}", None, limit=500)
    assert r.status_code == 422


async def test_los_horarios_de_un_dia_se_paginan_sin_repetir(mundo) -> None:
    app, motor, _ = mundo
    jefa, moderador = await _equipo(motor)
    categoria = (await _categoria(app, jefa))["id"]
    perfil = await _prestador(motor)
    servicio = await _hasta(app, perfil, jefa, moderador, categoria, "published", duration_minutes=15)
    await _configurada(app, perfil, servicio, despues=0, slot_interval_minutes=5)
    vistos: list[str] = []
    cursor = None
    for _ in range(10):
        r = await _pedir(app, "GET", f"{_publica(servicio)}/{_dia(4)}", None, limit=10, cursor=cursor)
        assert r.status_code == 200, r.text
        vistos += [h["starts_at"] for h in r.json()["items"]]
        cursor = r.json()["next_cursor"]
        if cursor is None:
            break
    # 09:00 … 11:45 de 5 en 5: 34 horarios, en orden y sin repetir.
    assert len(vistos) == 34 and vistos == sorted(set(vistos))


async def test_en_pausa_sin_configurar_o_no_publico_no_hay_horarios(mundo) -> None:
    app, motor, _ = mundo
    perfil, servicio, jefa, moderador = await _publicado_con_agenda(app, motor)
    # En pausa: el servicio sigue público, sin horarios.
    r = await _pedir(app, "PUT", _agenda(servicio), perfil, {"timezone": "America/Lima", "buffer_after_minutes": 15, "status": "paused"})
    assert r.status_code == 200 and "schedule_paused" in r.json()["issues"]
    calendario = (await _pedir(app, "GET", _publica(servicio), None)).json()
    assert (calendario["status"], calendario["days"], calendario["next"]) == ("paused", [], None)
    assert (await _pedir(app, "GET", f"{_publica(servicio)}/{_dia(3)}", None)).json()["items"] == []
    # Sin agenda.
    categoria = (await _categoria(app, jefa))["id"]
    sin = await _hasta(app, await _prestador(motor), jefa, moderador, categoria, "published")
    calendario = (await _pedir(app, "GET", _publica(sin), None)).json()
    assert (calendario["status"], calendario["days"], calendario["timezone"]) == ("not_configured", [], None)
    # Suspendido por Z: el mismo 404 que lo que no existe.
    r = await _accion(app, jefa, f"{BANDEJA}/{servicio}/suspend", {"note": "Revisión de la ficha."})
    assert r.status_code == 200, r.text
    for ruta in (_publica(servicio), f"{_publica(servicio)}/{_dia(3)}"):
        r = await _pedir(app, "GET", ruta, None)
        assert r.status_code == 404 and _codigo(r) == "service_not_found"
    # Un prestador suspendido, una categoría desactivada o alguien bloqueado, tampoco.
    otro_perfil, otro, _, _ = await _publicado_con_agenda(app, motor)
    quien = await _persona(motor)
    await _sembrar(motor, "insert into public.user_blocks (blocker_id, blocked_id) values (cast(:a as uuid), cast(:b as uuid))",
                   a=otro_perfil, b=quien)
    assert (await _pedir(app, "GET", _publica(otro), quien)).status_code == 404
    assert (await _pedir(app, "GET", _publica(otro), None)).status_code == 200
    await _sembrar(motor, "update public.service_providers set status = 'suspended', suspended_at = now() "
                          "where profile_id = cast(:u as uuid)", u=otro_perfil)
    assert (await _pedir(app, "GET", _publica(otro), None)).status_code == 404


# =========================================================================== #
# 3. Quién puede qué
# =========================================================================== #
async def test_lo_ajeno_es_404_y_sin_sesion_401(mundo) -> None:
    app, motor, _ = mundo
    perfil, servicio, jefa, moderador = await _publicado_con_agenda(app, motor)
    agenda = (await _pedir(app, "GET", _agenda(servicio), perfil)).json()
    regla = agenda["rules"][0]["id"]
    otro_prestador = await _prestador(motor)
    sin_prestador = await _persona(motor)
    rutas = (
        ("GET", _agenda(servicio), None),
        ("PUT", _agenda(servicio), {"timezone": "America/Lima"}),
        ("POST", f"{_agenda(servicio)}/rules", {"weekday": 1, "start": "13:00", "end": "14:00", "modality": "virtual"}),
        ("PATCH", f"{_agenda(servicio)}/rules/{regla}", {"active": False}),
        ("DELETE", f"{_agenda(servicio)}/rules/{regla}", None),
        ("POST", f"{_agenda(servicio)}/exceptions", {"date": _dia(5), "kind": "closed"}),
        ("POST", f"{_agenda(servicio)}/blocks",
         {"start_date": _dia(5), "start_time": "10:00", "end_date": _dia(5), "end_time": "11:00"}),
        ("GET", f"{_agenda(servicio)}/preview", None),
        ("GET", f"{_agenda(servicio)}/preview/{_dia(5)}", None),
    )
    for quien in (otro_prestador, sin_prestador, jefa, moderador):
        for metodo, ruta, cuerpo in rutas:
            r = await _pedir(app, metodo, ruta, quien, cuerpo)
            assert r.status_code == 404 and _codigo(r) == "service_not_found", (quien, metodo, ruta, r.text)
    for metodo, ruta, cuerpo in rutas:
        r = await _pedir(app, metodo, ruta, None, cuerpo)
        assert r.status_code == 401, (metodo, ruta)
    # Nada cambió.
    assert (await _pedir(app, "GET", _agenda(servicio), perfil)).json()["rules"] == agenda["rules"]


async def test_un_prestador_suspendido_ve_su_agenda_pero_no_la_toca(mundo) -> None:
    app, motor, _ = mundo
    perfil, servicio, jefa, _ = await _publicado_con_agenda(app, motor)
    privada = (await _pedir(app, "GET", f"{MIOS}/{servicio}", perfil)).json()
    assert privada["can_manage_schedule"] is True
    await _sembrar(motor, "update public.service_providers set status = 'suspended', suspended_at = now() "
                          "where profile_id = cast(:u as uuid)", u=perfil)
    r = await _pedir(app, "GET", _agenda(servicio), perfil)
    assert r.status_code == 200 and r.json()["can_edit"] is False
    assert (await _pedir(app, "GET", f"{MIOS}/{servicio}", perfil)).json()["can_manage_schedule"] is False
    r = await _pedir(app, "POST", f"{_agenda(servicio)}/exceptions", perfil, {"date": _dia(5), "kind": "closed"})
    assert r.status_code == 403 and _codigo(r) == "service_provider_not_active"
    # Retirado: tampoco se toca.
    await _sembrar(motor, "update public.service_providers set status = 'active', suspended_at = null "
                          "where profile_id = cast(:u as uuid)", u=perfil)
    r = await _accion(app, jefa, f"{BANDEJA}/{servicio}/retire", {"note": "Sale del catálogo."})
    assert r.status_code == 200, r.text
    r = await _pedir(app, "POST", f"{_agenda(servicio)}/exceptions", perfil, {"date": _dia(5), "kind": "closed"})
    assert r.status_code == 409 and _codigo(r) == "service_retired"
    assert (await _pedir(app, "GET", f"{MIOS}/{servicio}", perfil)).json()["can_manage_schedule"] is False


# =========================================================================== #
# 4. Carreras, con PostgreSQL de verdad
# =========================================================================== #
async def test_dos_reglas_cruzadas_a_la_vez_dejan_una_y_un_409(mundo) -> None:
    app, motor, _ = mundo
    perfil, servicio, _, _ = await _publicado_con_agenda(app, motor)
    reglas = f"{_agenda(servicio)}/rules"
    respuestas = await asyncio.gather(*(
        _pedir(app, "POST", reglas, perfil, {"weekday": 3, "start": inicio, "end": fin, "modality": "virtual"})
        for inicio, fin in (("13:00", "15:00"), ("14:00", "16:00"), ("13:30", "14:30"))
    ))
    assert sorted(r.status_code for r in respuestas) == [201, 409, 409], [r.text for r in respuestas]
    assert {_codigo(r) for r in respuestas if r.status_code == 409} == {"service_schedule_overlap"}
    miercoles = await _uno(
        motor, "select count(*) from public.service_schedule_rules where service_id = cast(:s as uuid) and weekday = 3",
        s=servicio,
    )
    assert miercoles == 2  # la de 09–12 y una de las tres


async def test_dos_excepciones_incompatibles_a_la_vez_no_dejan_la_fecha_ambigua(mundo) -> None:
    app, motor, _ = mundo
    perfil, servicio, _, _ = await _publicado_con_agenda(app, motor)
    ruta = f"{_agenda(servicio)}/exceptions"
    respuestas = await asyncio.gather(
        _pedir(app, "POST", ruta, perfil, {"date": _dia(12), "kind": "closed"}),
        _pedir(app, "POST", ruta, perfil, {"date": _dia(12), "kind": "replace", "start": "15:00", "end": "17:00",
                                           "modality": "virtual"}),
    )
    assert sorted(r.status_code for r in respuestas) == [201, 409], [r.text for r in respuestas]
    assert await _uno(
        motor, "select count(*) from public.service_schedule_exceptions where service_id = cast(:s as uuid)", s=servicio
    ) == 1


async def test_la_misma_clave_a_la_vez_crea_una_sola(mundo) -> None:
    app, motor, _ = mundo
    perfil, servicio, _, _ = await _publicado_con_agenda(app, motor)
    clave = f"clave-{uuid.uuid4().hex}"
    cuerpo = {"start_date": _dia(6), "start_time": "09:00", "end_date": _dia(6), "end_time": "09:30"}
    respuestas = await asyncio.gather(*(
        _pedir(app, "POST", f"{_agenda(servicio)}/blocks", perfil, cuerpo, clave) for _ in range(4)
    ))
    assert sorted(r.status_code for r in respuestas) == [200, 200, 200, 201], [r.text for r in respuestas]
    assert await _uno(
        motor, "select count(*) from public.service_schedule_blocks where service_id = cast(:s as uuid)", s=servicio
    ) == 1


async def test_crear_y_retirar_bloqueos_a_la_vez_deja_un_resultado_valido(mundo) -> None:
    app, motor, _ = mundo
    perfil, servicio, _, _ = await _publicado_con_agenda(app, motor)
    ruta = f"{_agenda(servicio)}/blocks"
    r = await _pedir(app, "POST", ruta, perfil, {"start_date": _dia(6), "start_time": "09:00", "end_date": _dia(6), "end_time": "09:30"})
    viejo = r.json()["blocks"][0]["id"]
    respuestas = await asyncio.gather(
        _pedir(app, "DELETE", f"{ruta}/{viejo}", perfil),
        _pedir(app, "DELETE", f"{ruta}/{viejo}", perfil),
        _pedir(app, "POST", ruta, perfil, {"start_date": _dia(6), "start_time": "10:00", "end_date": _dia(6), "end_time": "10:30"}),
    )
    assert sorted(r.status_code for r in respuestas[:2]) == [200, 404], [r.text for r in respuestas]
    assert respuestas[2].status_code == 201
    final = (await _pedir(app, "GET", _agenda(servicio), perfil)).json()["blocks"]
    assert [(b["start_time"], b["end_time"]) for b in final] == [("10:00", "10:30")]


async def test_consultar_mientras_se_edita_nunca_da_500(mundo) -> None:
    app, motor, _ = mundo
    perfil, servicio, _, _ = await _publicado_con_agenda(app, motor)
    trabajos = []
    for i in range(6):
        trabajos.append(_pedir(app, "POST", f"{_agenda(servicio)}/exceptions", perfil,
                               {"date": _dia(14 + i), "kind": "closed"}))
        trabajos.append(_pedir(app, "GET", _publica(servicio), None))
        trabajos.append(_pedir(app, "GET", f"{_publica(servicio)}/{_dia(14 + i)}", None))
        trabajos.append(_pedir(app, "PATCH", f"{_agenda(servicio)}/rules/{uuid.uuid4()}", perfil, {"active": False}))
    respuestas = await asyncio.gather(*trabajos)
    assert all(r.status_code < 500 for r in respuestas), [r.text for r in respuestas if r.status_code >= 500]
    assert {r.status_code for r in respuestas} <= {200, 201, 404}


# =========================================================================== #
# 5. Nada de reservas ni dinero
# =========================================================================== #
async def test_nada_de_esto_crea_una_reserva_ni_mueve_dinero(mundo) -> None:
    app, motor, _ = mundo
    antes = await _conteos(motor)
    perfil, servicio, _, _ = await _publicado_con_agenda(app, motor)
    await _pedir(app, "POST", f"{_agenda(servicio)}/exceptions", perfil, {"date": _dia(8), "kind": "closed"})
    await _pedir(app, "POST", f"{_agenda(servicio)}/blocks", perfil,
                 {"start_date": _dia(3), "start_time": "10:00", "end_date": _dia(3), "end_time": "11:00"})
    for quien in (None, await _persona(motor)):
        await _pedir(app, "GET", _publica(servicio), quien)
        await _pedir(app, "GET", f"{_publica(servicio)}/{_dia(7)}", quien)
    assert await _conteos(motor) == antes


# =========================================================================== #
# 6. La puerta de la 0092 y la bandera
# =========================================================================== #
async def _puerta_de_agenda(motor, *cambios: str) -> bool:
    esquema.olvidar()
    async with motor.connect() as conexion:
        transaccion = await conexion.begin()
        try:
            for sql in cambios:
                await conexion.execute(text(sql))
            sesion = AsyncSession(bind=conexion)
            try:
                return await esquema.hay_agenda(sesion)
            finally:
                await sesion.close()
        finally:
            await transaccion.rollback()
            esquema.olvidar()


_REGLAS, _EXCEPCIONES = "public.service_schedule_rules", "public.service_schedule_exceptions"
_BLOQUEOS, _EVENTOS = "public.service_schedule_blocks", "public.service_schedule_events"

#: CADA FORMA de que la 0092 falte, esté a medias o esté aflojada. La puerta
#: tiene que cerrarse ante TODAS, y la API contestar 503 `services_not_ready`,
#: nunca 500.
ALTERACIONES_DE_LA_0092 = (
    # Tablas y columnas: ausentes o de más.
    (f"drop table {_BLOQUEOS}",),
    (f"drop table {_EVENTOS}",),
    (f"alter table {_BLOQUEOS} drop column reason",),
    ("alter table public.service_schedules add column extra integer not null default 0",),
    # Tipo y nulabilidad.
    (f"alter table {_BLOQUEOS} alter column starts_at type timestamp",),
    (f"alter table {_REGLAS} alter column weekday type integer",),
    (f"alter table {_REGLAS} alter column modality drop not null",),
    (f"delete from {_BLOQUEOS}", f"alter table {_BLOQUEOS} alter column reason set not null"),
    # Las exclusiones, la autoridad de los cruces: ausente o distinta.
    (f"alter table {_REGLAS} drop constraint service_schedule_rules_sin_cruces",),
    (f"alter table {_REGLAS} drop constraint service_schedule_rules_sin_cruces",
     f"alter table {_REGLAS} add constraint service_schedule_rules_sin_cruces exclude using gist "
     "(service_id with =, weekday with =, int4range(start_minute, end_minute) with &&) where (false)"),
    (f"alter table {_EXCEPCIONES} drop constraint service_schedule_exceptions_sin_cruces",
     f"alter table {_EXCEPCIONES} add constraint service_schedule_exceptions_sin_cruces exclude using gist "
     "(service_id with =, on_date with =, int4range(start_minute, end_minute) with &&)"),
    # CHECK: ausente, distinto, o el MISMO sin validar.
    (f"alter table {_REGLAS} drop constraint service_schedule_rules_franja",),
    (f"alter table {_BLOQUEOS} drop constraint service_schedule_blocks_motivo",
     f"alter table {_BLOQUEOS} add constraint service_schedule_blocks_motivo check (reason is null) not valid"),
    (f"alter table {_BLOQUEOS} drop constraint service_schedule_blocks_orden",
     f"alter table {_BLOQUEOS} add constraint service_schedule_blocks_orden check (starts_at < ends_at) not valid"),
    # Claves ajenas: otra acción, o la misma sin validar.
    (f"alter table {_BLOQUEOS} drop constraint service_schedule_blocks_service_id_fkey",
     f"alter table {_BLOQUEOS} add constraint service_schedule_blocks_service_id_fkey "
     "foreign key (service_id) references public.service_schedules(service_id) on delete restrict"),
    (f"alter table {_BLOQUEOS} drop constraint service_schedule_blocks_service_id_fkey",
     f"alter table {_BLOQUEOS} add constraint service_schedule_blocks_service_id_fkey "
     "foreign key (service_id) references public.service_schedules(service_id) on delete cascade not valid"),
    # Índices: otro, inválido o a medias; también los de las claves primarias
    # y los de las exclusiones (sin él, la exclusión no protege).
    ("drop index public.service_schedule_events_una_por_clave",
     f"create index service_schedule_events_una_por_clave on {_EVENTOS} "
     "(service_id, idempotency_key) where idempotency_key is not null"),
    ("update pg_catalog.pg_index set indisvalid = false "
     "where indexrelid = 'public.service_schedule_blocks_de_la_agenda'::regclass",),
    ("update pg_catalog.pg_index set indisready = false "
     "where indexrelid = 'public.service_schedule_rules_de_la_agenda'::regclass",),
    ("update pg_catalog.pg_index set indisvalid = false "
     "where indexrelid = 'public.service_schedule_rules_sin_cruces'::regclass",),
    ("update pg_catalog.pg_index set indisready = false "
     "where indexrelid = 'public.service_schedule_exceptions_sin_cruces'::regclass",),
    ("update pg_catalog.pg_index set indisready = false "
     "where indexrelid = 'public.service_schedule_rules_pkey'::regclass",),
    # Disparadores: ausente, deshabilitado (también «solo en réplica») o con
    # otra forma (otro momento, otra función).
    ("drop trigger service_schedules_zona_valida on public.service_schedules",),
    (f"alter table {_EVENTOS} disable trigger service_schedule_events_inmutables",),
    ("alter table public.service_schedules enable replica trigger service_schedules_solo_en_cascada",),
    (f"drop trigger service_schedule_events_inmutables on {_EVENTOS}",
     f"create trigger service_schedule_events_inmutables after update on {_EVENTOS} "
     "for each row execute function public.servicios_catalogo_historial_inmutable()"),
    ("drop trigger service_schedules_zona_valida on public.service_schedules",
     "create trigger service_schedules_zona_valida before insert or update of timezone on public.service_schedules "
     "for each row execute function public.servicios_catalogo_historial_inmutable()"),
    # La función de la zona: otro cuerpo, SECURITY DEFINER u otro search_path.
    ("create or replace function public.servicios_agenda_zona_valida() returns trigger language plpgsql "
     "set search_path = public, pg_temp as $$ begin return new; end; $$",),
    ("alter function public.servicios_agenda_zona_valida() security definer",),
    ("alter function public.servicios_agenda_zona_valida() set search_path = public",),
    # La extensión.
    ("drop extension btree_gist cascade",),
    # RLS, políticas y permisos (de tabla, de columna y de la función; a
    # PUBLIC, anon o authenticated).
    (f"alter table {_BLOQUEOS} disable row level security",),
    (f"create policy abierta on {_BLOQUEOS} for select to authenticated using (true)",),
    (f"grant select on {_BLOQUEOS} to anon",),
    (f"grant select on {_EVENTOS} to public",),
    (f"grant insert on {_REGLAS} to authenticated",),
    (f"grant select (reason) on {_BLOQUEOS} to authenticated",),
    ("grant execute on function public.servicios_agenda_zona_valida() to authenticated",),
    ("grant execute on function public.servicios_agenda_zona_valida() to public",),
)


async def test_la_puerta_de_la_agenda_mira_lo_que_hace_falta(mundo) -> None:
    _, motor, _ = mundo
    assert await _puerta_de_agenda(motor) is True
    abiertas = [cambios for cambios in ALTERACIONES_DE_LA_0092 if await _puerta_de_agenda(motor, *cambios) is not False]
    assert abiertas == []
    assert await _puerta_de_agenda(motor, "grant all on public.service_schedule_blocks to service_role") is True
    # La consulta compara identificadores, no nombres escritos: no depende del
    # `search_path` de la conexión.
    async with motor.connect() as conexion:
        async with conexion.begin():
            await conexion.execute(text("set local search_path = pg_catalog"))
            assert await conexion.scalar(esquema._LO_QUE_NECESITA_LA_AGENDA) is True


def _siempre(sesion: AsyncSession):  # noqa: ANN202
    async def _la_misma():  # noqa: ANN202
        yield sesion

    return _la_misma


async def test_con_la_0092_alterada_la_api_contesta_503_y_nunca_500(mundo) -> None:
    """La misma lista, ahora por HTTP: con la base alterada (en una transacción
    que se deshace al terminar), el prestador y el público reciben 503
    `services_not_ready` y nada se escribe. Nunca un 500."""
    app, motor, _ = mundo
    perfil, servicio, _, _ = await _publicado_con_agenda(app, motor)
    peticiones = (
        ("GET", _agenda(servicio), perfil, None),
        ("POST", f"{_agenda(servicio)}/rules", perfil, {"weekday": 3, "start": "15:00", "end": "16:00", "modality": "virtual"}),
        ("GET", _publica(servicio), None, None),
        ("GET", f"{_publica(servicio)}/{_dia(1)}", None, None),
    )
    normal = app.dependency_overrides[get_db]
    respuestas = []
    try:
        for cambios in ALTERACIONES_DE_LA_0092:
            esquema.olvidar()
            async with motor.connect() as conexion:
                transaccion = await conexion.begin()
                sesion = AsyncSession(bind=conexion, expire_on_commit=False)
                app.dependency_overrides[get_db] = _siempre(sesion)
                try:
                    for sql in cambios:
                        await conexion.execute(text(sql))
                    for metodo, ruta, uid, cuerpo in peticiones:
                        r = await _pedir(app, metodo, ruta, uid, cuerpo, f"clave-{uuid.uuid4().hex}")
                        respuestas.append((r.status_code, _codigo(r)))
                        assert (r.status_code, _codigo(r)) == (503, "services_not_ready"), (cambios, metodo, ruta, r.text)
                finally:
                    app.dependency_overrides[get_db] = normal
                    await sesion.close()
                    await transaccion.rollback()
                    esquema.olvidar()
    finally:
        app.dependency_overrides[get_db] = normal
    assert len(respuestas) == len(ALTERACIONES_DE_LA_0092) * len(peticiones)
    # Deshecho lo alterado, la agenda responde y no quedó ninguna regla nueva.
    agenda = (await _pedir(app, "GET", _agenda(servicio), perfil)).json()
    assert agenda["configured"] is True and all(r["start"] != "15:00" for r in agenda["rules"])
    assert (await _pedir(app, "GET", _publica(servicio), None)).status_code == 200


async def test_un_error_al_mirar_la_0092_es_503_y_no_se_recuerda(mundo, monkeypatch) -> None:
    app, motor, _ = mundo
    perfil, servicio, _, _ = await _publicado_con_agenda(app, motor)
    esquema.olvidar()
    buena = esquema._LO_QUE_NECESITA_LA_AGENDA
    monkeypatch.setattr(esquema, "_LO_QUE_NECESITA_LA_AGENDA", text("select 1 / 0 = 1"))
    for metodo, ruta, uid in (("GET", _agenda(servicio), perfil), ("GET", _publica(servicio), None)):
        r = await _pedir(app, metodo, ruta, uid)
        assert r.status_code == 503 and _codigo(r) == "services_not_ready", (ruta, r.text)
    assert "agenda" not in esquema._cache
    # La ficha no depende de la 0092; el acceso a la agenda se esconde.
    assert (await _pedir(app, "GET", f"{CATALOGO}/{servicio}", None)).status_code == 200
    assert (await _pedir(app, "GET", f"{MIOS}/{servicio}", perfil)).json()["can_manage_schedule"] is False
    monkeypatch.setattr(esquema, "_LO_QUE_NECESITA_LA_AGENDA", buena)
    assert (await _pedir(app, "GET", _publica(servicio), None)).status_code == 200
    assert esquema._cache["agenda"] is True


async def test_sin_la_0092_la_agenda_contesta_503_y_el_resto_funciona(mundo) -> None:
    app, motor, _ = mundo
    perfil, servicio, _, _ = await _publicado_con_agenda(app, motor)
    await _sembrar(motor, "alter table public.service_schedule_blocks rename to service_schedule_blocks_apartada")
    esquema.olvidar()
    try:
        antes = await _uno(motor, "select count(*) from public.service_schedule_events")
        for metodo, ruta, uid, cuerpo in (
            ("GET", _agenda(servicio), perfil, None),
            ("POST", f"{_agenda(servicio)}/exceptions", perfil, {"date": _dia(5), "kind": "closed"}),
            ("GET", _publica(servicio), None, None),
        ):
            r = await _pedir(app, metodo, ruta, uid, cuerpo)
            assert r.status_code == 503 and _codigo(r) == "services_not_ready", (ruta, r.text)
        # Sin escrituras a medias.
        assert await _uno(motor, "select count(*) from public.service_schedule_events") == antes
        assert (await _pedir(app, "GET", f"{CATALOGO}/{servicio}", None)).status_code == 200
        assert (await _pedir(app, "GET", f"{MIOS}/{servicio}", perfil)).json()["can_manage_schedule"] is False
    finally:
        await _sembrar(motor, "alter table public.service_schedule_blocks_apartada rename to service_schedule_blocks")
        esquema.olvidar()


async def test_con_la_bandera_apagada_nada_de_la_agenda_responde(mundo, monkeypatch) -> None:
    app, motor, _ = mundo
    monkeypatch.setattr(get_settings(), "feature_services", False)
    esquema.olvidar()
    quien = await _persona(motor)
    ident = str(uuid.uuid4())
    agenda = f"{MIOS}/{ident}/schedule"
    for metodo, ruta in (
        ("GET", agenda), ("PUT", agenda), ("POST", f"{agenda}/rules"), ("PATCH", f"{agenda}/rules/{ident}"),
        ("DELETE", f"{agenda}/rules/{ident}"), ("POST", f"{agenda}/exceptions"),
        ("PATCH", f"{agenda}/exceptions/{ident}"), ("DELETE", f"{agenda}/exceptions/{ident}"),
        ("POST", f"{agenda}/blocks"), ("DELETE", f"{agenda}/blocks/{ident}"), ("GET", f"{agenda}/preview"),
        ("GET", f"{agenda}/preview/{_dia(1)}"), ("GET", _publica(ident)), ("GET", f"{_publica(ident)}/{_dia(1)}"),
    ):
        async with _cliente(app, quien) as http:
            r = await http.request(metodo, ruta, json={})
        assert r.status_code == 503 and _codigo(r) == "services_disabled", (metodo, ruta, r.text)


# =========================================================================== #
# 7. Lo que encontró la revisión independiente
# =========================================================================== #
async def test_fechas_extremas_son_422_y_nunca_500(mundo) -> None:
    app, motor, _ = mundo
    perfil, servicio, _, _ = await _publicado_con_agenda(app, motor)
    for ruta, uid in ((_publica(servicio), None), (f"{_agenda(servicio)}/preview", perfil)):
        for params in ({"from": "9999-12-31"}, {"from": "9999-12-02"}, {"from": _dia(0), "to": "9999-12-31"}):
            r = await _pedir(app, "GET", ruta, uid, **params)
            assert r.status_code == 422, (ruta, params, r.text)
    for cuerpo in (
        {"start_date": _dia(1), "start_time": "10:00", "end_date": "9999-12-31", "end_time": "24:00"},
        {"start_date": "0001-01-01", "start_time": "00:00", "end_date": _dia(1), "end_time": "10:00"},
    ):
        r = await _pedir(app, "POST", f"{_agenda(servicio)}/blocks", perfil, cuerpo)
        assert r.status_code == 422 and _codigo(r) == "service_schedule_date_invalid", (cuerpo, r.text)


async def test_una_zona_que_la_base_no_conoce_es_422(mundo, monkeypatch) -> None:
    """Python (tzdata) y PostgreSQL tienen cada uno su base de zonas. Si una
    zona existe en la primera y no en la segunda, el disparador la rechaza y
    la API lo dice con un 422, no con un 500."""
    from app.modules.services import agenda_calculo as calc

    app, motor, _ = mundo
    jefa, moderador = await _equipo(motor)
    categoria = (await _categoria(app, jefa))["id"]
    perfil = await _prestador(motor)
    servicio = await _hasta(app, perfil, jefa, moderador, categoria, "draft", duration_minutes=60)
    original = calc.zona
    monkeypatch.setattr(calc, "zona", lambda n: original("America/Lima") if n == "America/Atlantida" else original(n))
    for _ in range(2):  # al crear la agenda y al cambiarla
        r = await _pedir(app, "PUT", _agenda(servicio), perfil, {"timezone": "America/Atlantida", "confirm_timezone_change": True})
        assert r.status_code == 422 and _codigo(r) == "service_schedule_timezone_invalid", r.text
        assert (await _pedir(app, "PUT", _agenda(servicio), perfil, {"timezone": "America/Lima"})).status_code in (200, 201)


async def test_en_pausa_no_hay_proximo_horario(mundo) -> None:
    app, motor, _ = mundo
    perfil, servicio, _, _ = await _publicado_con_agenda(app, motor)
    assert (await _pedir(app, "GET", _agenda(servicio), perfil)).json()["next_available"] is not None
    r = await _pedir(app, "PUT", _agenda(servicio), perfil, {"timezone": "America/Lima", "buffer_after_minutes": 15, "status": "paused"})
    assert r.json()["next_available"] is None and "schedule_paused" in r.json()["issues"]


async def test_la_misma_clave_con_otro_contenido_es_409(mundo) -> None:
    app, motor, _ = mundo
    perfil, servicio, _, _ = await _publicado_con_agenda(app, motor)
    for ruta, a, b in (
        ("rules", {"weekday": 2, "start": "13:00", "end": "14:00", "modality": "virtual"},
         {"weekday": 2, "start": "15:00", "end": "16:00", "modality": "virtual"}),
        ("exceptions", {"date": _dia(20), "kind": "closed"}, {"date": _dia(21), "kind": "closed"}),
        ("blocks", {"start_date": _dia(3), "start_time": "10:00", "end_date": _dia(3), "end_time": "11:00"},
         {"start_date": _dia(3), "start_time": "12:00", "end_date": _dia(3), "end_time": "13:00"}),
    ):
        clave = f"clave-{uuid.uuid4().hex}"
        assert (await _pedir(app, "POST", f"{_agenda(servicio)}/{ruta}", perfil, a, clave)).status_code == 201
        r = await _pedir(app, "POST", f"{_agenda(servicio)}/{ruta}", perfil, b, clave)
        assert r.status_code == 409 and _codigo(r) == "idempotency_key_reused", (ruta, r.text)
        assert (await _pedir(app, "POST", f"{_agenda(servicio)}/{ruta}", perfil, a, clave)).status_code == 200
    # El motivo es privado y no está en el historial: con los mismos instantes,
    # repetir con otro motivo es repetir (y no crea otro bloqueo).
    clave = f"clave-{uuid.uuid4().hex}"
    cuerpo = {"start_date": _dia(4), "start_time": "10:00", "end_date": _dia(4), "end_time": "11:00", "reason": "Uno"}
    assert (await _pedir(app, "POST", f"{_agenda(servicio)}/blocks", perfil, cuerpo, clave)).status_code == 201
    r = await _pedir(app, "POST", f"{_agenda(servicio)}/blocks", perfil, {**cuerpo, "reason": "Otro"}, clave)
    assert r.status_code == 200 and [b["reason"] for b in r.json()["blocks"] if b["start_date"] == _dia(4)] == ["Uno"]


async def test_un_patch_solo_cambia_lo_que_llega(mundo) -> None:
    app, motor, _ = mundo
    perfil, servicio, _, _ = await _publicado_con_agenda(app, motor)
    regla = (await _pedir(app, "GET", _agenda(servicio), perfil)).json()["rules"][0]["id"]
    r = await _pedir(app, "PATCH", f"{_agenda(servicio)}/rules/{regla}", perfil, {"capacity": None})
    assert r.status_code == 422 and _codigo(r) == "service_schedule_capacity_invalid", r.text
    r = await _pedir(app, "POST", f"{_agenda(servicio)}/exceptions", perfil,
                     {"date": _dia(15), "kind": "extra", "start": "15:00", "end": "16:00", "modality": "virtual"})
    extra = next(e for e in r.json()["exceptions"] if e["kind"] == "extra")
    r = await _pedir(app, "PATCH", f"{_agenda(servicio)}/exceptions/{extra['id']}", perfil, {"kind": "closed"})
    assert r.status_code == 200, r.text
    cerrada = next(e for e in r.json()["exceptions"] if e["id"] == extra["id"])
    assert (cerrada["kind"], cerrada["start"], cerrada["end"], cerrada["modality"], cerrada["capacity"]) == (
        "closed", "15:00", "16:00", None, None,
    )


async def test_la_puerta_mira_la_definicion_de_los_check_y_los_disparadores(mundo) -> None:
    _, motor, _ = mundo
    for cambios in (
        # Un CHECK aflojado con el MISMO nombre.
        ("alter table public.service_schedule_blocks drop constraint service_schedule_blocks_motivo",
         "alter table public.service_schedule_blocks add constraint service_schedule_blocks_motivo "
         "check (reason is null or length(trim(reason)) between 1 and 2000)"),
        # El disparador de la zona, sin su `update of timezone`.
        ("drop trigger service_schedules_zona_valida on public.service_schedules",
         "create trigger service_schedules_zona_valida before insert or update on public.service_schedules "
         "for each row execute function public.servicios_agenda_zona_valida()"),
        # El de la cascada, colgando de otra madre.
        ("drop trigger service_schedule_events_solo_en_cascada on public.service_schedule_events",
         "create trigger service_schedule_events_solo_en_cascada before delete on public.service_schedule_events "
         "for each row execute function public.servicios_borrado_solo_en_cascada('service_versions', 'service_id')"),
    ):
        assert await _puerta_de_agenda(motor, *cambios) is False, cambios
    assert await _puerta_de_agenda(motor) is True
