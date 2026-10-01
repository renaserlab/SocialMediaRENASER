"""La atención y la posventa de Servicios por la API real, contra PostgreSQL
(Incremento 6).

Con la base 0001–0094 desechable, el Storage en memoria y `FEATURE_SERVICES`
y `FEATURE_SERVICE_BOOKING` encendidas SOLO aquí. Cada reserva se contrata por
el flujo real del Incremento 5; el tiempo se mueve llevando LA RESERVA (no el
reloj del servidor) a donde hace falta.

LO QUE SE COMPRUEBA: el recorrido gratuito entero (código, inicio, fin,
confirmación, reseña, respuesta); cancelar y reprogramar; las ventanas; la
señal fuerte y la débil; los barridos; la inasistencia; el caso, su expediente
privado, la resolución y la apelación; el efecto económico que nunca se
ejecuta; la reseña verificada y su moderación; quién puede qué; la
idempotencia; las banderas y la puerta de la 0094; que nada mueve dinero; la
baja de una cuenta; y LAS CARRERAS con PostgreSQL de verdad.
"""

from __future__ import annotations

import asyncio
import json
import re
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.modules.services import esquema, posventa
from app.shared.database import get_db
from tests.test_baja_de_cuenta_postgres import API, SIN_POSTGRES, _borrar_cuenta, _cliente, _filas, _persona, _sembrar, _uno
from tests.test_migraciones_reales import MIGRACIONES
from tests.test_servicios_admision_api import PDF, PNG
from tests.test_servicios_agenda_api import _agenda, _codigo, _dia, _pedir
from tests.test_servicios_descubrimiento_api import (  # noqa: F401 - montajes compartidos
    CATALOGO,
    base_aplicada,
    entorno,
    mundo,
)
from tests.test_servicios_reserva_api import (  # noqa: F401 - montajes compartidos
    ADMIN_SERVICIOS,
    DEL_PRESTADOR,
    MIS_RESERVAS,
    RETENCIONES,
    _clave,
    _condiciones,
    _confirmar,
    _dinero,
    _horarios,
    _reservado,
    _retener,
    _siempre,
    reservas,
)

pytestmark = [SIN_POSTGRES, pytest.mark.asyncio]

CASOS = f"{ADMIN_SERVICIOS}/incidents"
RESENAS = f"{ADMIN_SERVICIOS}/reviews"
TAREAS = f"{ADMIN_SERVICIOS}/tasks/run"
DESCRIPCION = "Llegué a la hora y no había nadie; esperé media hora."
COMENTARIO = "Muy clara y puntual, resolvió todas mis dudas."
RESENA = {"rating": 5, "recommends": True, "comment": COMENTARIO, "punctuality": 4}
#: Lo que nunca sale en un aviso ni en una respuesta a quien no le toca.
PRIVADO = (DESCRIPCION, "Nota solo para el equipo", "service-incident-evidence", "storage_path")


@pytest.fixture()
def atencion(reservas, monkeypatch):  # noqa: F811
    """La contratación encendida y la reseña SIN moderación previa (la
    moderación previa tiene sus propias pruebas)."""
    monkeypatch.setattr(get_settings(), "services_reviews_premoderation", False)
    return reservas


# --------------------------------------------------------------------------- #
# Ayudas
# --------------------------------------------------------------------------- #
def _de(rol: str, h: dict) -> tuple[str, str]:
    """`(ruta de esa reserva, quién)` para una de las dos partes."""
    if rol == "client":
        return f"{MIS_RESERVAS}/{h['reserva']['id']}", h["cliente"]
    return f"{DEL_PRESTADOR}/{h['reserva']['id']}", h["perfil"]


async def _hacer(app, rol: str, h: dict, accion: str, cuerpo: dict | None = None, *, clave: str | None = None,
                 quien: str | None = None):
    ruta, uid = _de(rol, h)
    return await _pedir(app, "POST", f"{ruta}/{accion}", quien or uid, cuerpo, clave or _clave())


async def _ver(app, rol: str, h: dict) -> dict:
    ruta, uid = _de(rol, h)
    r = await _pedir(app, "GET", ruta, uid)
    assert r.status_code == 200, r.text
    return r.json()


async def _acciones(app, rol: str, h: dict) -> list[str]:
    return sorted((await _ver(app, rol, h))["care"]["available_actions"])


async def _llevar(motor, reserva_id: str, *, minutos: int) -> None:
    """Lleva UNA reserva (y su retención) a empezar dentro de `minutos`
    (negativo: empezó hace tanto). Sin sus disparadores, solo en la prueba."""
    mover = (
        "starts_at = starts_at + d.delta, ends_at = ends_at + d.delta, occupied_from = occupied_from + d.delta, "
        "occupied_until = occupied_until + d.delta, local_date = ((starts_at + d.delta) at time zone timezone)::date"
    )
    async with motor.begin() as conexion:
        await conexion.execute(text("set local session_replication_role = replica"))
        delta = "(select (now() + make_interval(mins => :m)) - starts_at as delta from public.service_bookings " \
                "where id = cast(:b as uuid)) d"
        await conexion.execute(text(
            f"update public.service_holds h set {mover} from {delta} "
            "where h.id = (select hold_id from public.service_bookings where id = cast(:b as uuid))"
        ), {"b": reserva_id, "m": minutos})
        await conexion.execute(text(
            f"update public.service_bookings b set {mover} from {delta} where b.id = cast(:b as uuid)"
        ), {"b": reserva_id, "m": minutos})


async def _retrasar(motor, tabla: str, columna: str, donde: str, ident: str, *, horas: float) -> None:
    """Como si eso hubiera pasado hace `horas`."""
    await _sembrar(motor, f"update public.{tabla} set {columna} = now() - make_interval(secs => :s) "
                          f"where {donde} = cast(:i as uuid)", s=horas * 3600, i=ident)


async def _atendida(app, motor, *, con_codigo: bool = True, hasta: str = "closed", **extra) -> dict:
    """Una reserva gratuita llevada hasta `hasta`: `code_issued`,
    `in_progress`, `completed` o `closed` (confirmada por quien contrata)."""
    h = await _reservado(app, motor, **extra)
    await _llevar(motor, h["reserva"]["id"], minutos=5)
    codigo = None
    if con_codigo:
        r = await _hacer(app, "client", h, "check-in-code")
        assert r.status_code == 200, r.text
        codigo = r.json()["checkin_code"]
        h["codigo"] = codigo
    if hasta == "code_issued":
        return h
    r = await _hacer(app, "provider", h, "start", {"code": codigo} if codigo else {})
    assert r.status_code == 200, r.text
    if hasta == "in_progress":
        return h
    r = await _hacer(app, "provider", h, "complete")
    assert r.status_code == 200, r.text
    if hasta == "completed":
        return h
    r = await _hacer(app, "client", h, "confirm")
    assert r.status_code == 200, r.text
    return h


async def _con_caso(app, motor, *, rol: str = "client", motivo: str = "quality", **extra) -> dict:
    """Una atención en curso con su caso abierto por `rol`."""
    h = await _atendida(app, motor, hasta="in_progress", **extra)
    await _llevar(motor, h["reserva"]["id"], minutos=-20)
    r = await _hacer(app, rol, h, "incident", {"reason": motivo, "description": DESCRIPCION})
    assert r.status_code == 201, r.text
    h["caso"] = r.json()["id"]
    return h


async def _resolver(app, admin: str, caso: str, *, clave: str | None = None, **cuerpo):
    datos = {"outcome": "upheld", "resolution": "Revisamos lo aportado por las dos partes.", **cuerpo}
    return await _pedir(app, "POST", f"{CASOS}/{caso}/resolve", admin, datos, clave or _clave())


async def _avisos(motor, reserva: str, caso: str | None = None) -> list[tuple]:
    return sorted(await _filas(
        motor, "select user_id::text, type, entity_type, payload::text from public.notifications "
               "where entity_id = cast(:b as uuid) or entity_id = cast(:c as uuid)", b=reserva, c=caso or reserva))


async def _en_la_ficha(app, servicio: str) -> tuple[dict, dict]:
    """Lo que dicen de las reseñas la ficha pública y el perfil del prestador."""
    ficha = (await _pedir(app, "GET", f"{CATALOGO}/{servicio}", None)).json()
    perfil = (await _pedir(app, "GET", f"{API}/services/providers/{ficha['provider']['id']}", None)).json()
    return ficha["reviews"], perfil["reviews"]


async def _sucesos(motor, reserva: str) -> list[str]:
    return [f[0] for f in await _filas(
        motor, "select action from public.service_booking_events where booking_id = cast(:b as uuid) "
               "order by created_at, id", b=reserva)]


# =========================================================================== #
# 1. El recorrido entero
# =========================================================================== #
async def test_una_atencion_gratuita_de_punta_a_punta(atencion) -> None:
    app, motor, _ = atencion
    antes = await _dinero(motor)
    h = await _reservado(app, motor)
    reserva, perfil, cliente, jefa = h["reserva"]["id"], h["perfil"], h["cliente"], h["jefa"]
    pedido = await _filas(motor, "select o.status, o.payment_status, o.total_minor from public.service_orders o "
                                 "join public.service_bookings b on b.order_id = o.id where b.id = cast(:b as uuid)",
                          b=reserva)

    # A UNA SEMANA: se puede cancelar o cambiar de horario, y nada más.
    assert await _acciones(app, "client", h) == ["cancel", "reschedule"]
    assert await _acciones(app, "provider", h) == ["cancel"]
    plazos = (await _ver(app, "client", h))["care"]["deadlines"]
    assert plazos["reschedules_left"] == 1 and plazos["cancellation_financial_effect"] == "not_applicable"
    assert plazos["review_until"] is None and plazos["appeal_until"] is None
    # Lo que todavía no toca, el servidor lo rechaza (no solo lo esconde).
    r = await _hacer(app, "client", h, "check-in-code")
    assert r.status_code == 409 and _codigo(r) == "service_attention_not_in_window"
    r = await _hacer(app, "provider", h, "start", {})
    assert r.status_code == 409 and _codigo(r) == "service_attention_not_in_window"
    for rol, accion in (("provider", "complete"), ("client", "confirm"), ("client", "no-show")):
        r = await _hacer(app, rol, h, accion)
        assert r.status_code == 409, (accion, r.text)
    r = await _hacer(app, "client", h, "review", RESENA)
    assert r.status_code == 409 and _codigo(r) == "service_review_not_allowed"

    # A CINCO MINUTOS: se abre la llegada.
    await _llevar(motor, reserva, minutos=5)
    assert await _acciones(app, "client", h) == ["cancel", "issue_code"]
    assert await _acciones(app, "provider", h) == ["cancel", "start"]
    r = await _hacer(app, "client", h, "check-in-code")
    assert r.status_code == 200, r.text
    codigo = r.json()["checkin_code"]
    assert re.fullmatch(r"\d{6}", codigo)
    # Pedirlo otra vez es el mismo; quien contrata lo ve en su reserva, el prestador NO.
    assert (await _hacer(app, "client", h, "check-in-code")).json()["checkin_code"] == codigo
    assert (await _ver(app, "client", h))["care"]["attendance"]["checkin_code"] == codigo
    del_prestador = await _ver(app, "provider", h)
    assert codigo not in json.dumps(del_prestador) and del_prestador["care"]["attendance"]["code_attempts_left"] == 5

    # EL PRESTADOR EMPIEZA. Un código equivocado cuenta, y no empieza nada.
    otro = "000000" if codigo != "000000" else "111111"
    r = await _hacer(app, "provider", h, "start", {"code": otro})
    assert r.status_code == 409 and _codigo(r) == "service_attention_code_invalid", r.text
    assert r.json()["error"]["details"]["attempts_left"] == 4
    assert (await _ver(app, "provider", h))["care"]["attendance"]["code_attempts_left"] == 4
    clave = _clave()
    r = await _hacer(app, "provider", h, "start", {"code": codigo}, clave=clave)
    assert r.status_code == 200, r.text
    atendiendo = r.json()["care"]["attendance"]
    assert atendiendo["status"] == "in_progress" and atendiendo["with_code"] is True
    assert (await _hacer(app, "provider", h, "start", {"code": codigo}, clave=clave)).status_code == 200
    r = await _hacer(app, "provider", h, "start", {"code": codigo})
    assert r.status_code == 409 and _codigo(r) == "service_booking_action_not_available"
    # Empezada, YA NO SE CANCELA NI SE MUEVE.
    assert await _acciones(app, "provider", h) == ["complete"]
    assert await _acciones(app, "client", h) == ["confirm"]
    r = await _hacer(app, "client", h, "cancel", {})
    assert r.status_code == 409 and _codigo(r) == "service_booking_action_not_available"

    # TERMINA, y quien contrata lo confirma: cerrada y verificada.
    r = await _hacer(app, "provider", h, "complete")
    assert r.status_code == 200 and r.json()["care"]["attendance"]["status"] == "completed"
    assert await _acciones(app, "provider", h) == [] and await _acciones(app, "client", h) == ["confirm"]
    clave = _clave()
    r = await _hacer(app, "client", h, "confirm", clave=clave)
    assert r.status_code == 200, r.text
    cerrada = r.json()["care"]["attendance"]
    assert (cerrada["status"], cerrada["closed_by"], cerrada["checkin_code"]) == ("closed", "client", None)
    assert (await _hacer(app, "client", h, "confirm", clave=clave)).status_code == 200
    assert await _acciones(app, "client", h) == ["review"]
    assert (await _ver(app, "client", h))["care"]["deadlines"]["review_until"] is not None

    # LA RESEÑA VERIFICADA, la ficha pública y la respuesta del prestador.
    vacia = (await _pedir(app, "GET", f"{CATALOGO}/{h['servicio']}/reviews", None)).json()
    assert vacia == {"available": True, "items": [], "next_cursor": None,
                     "summary": {"total": 0, "average": None, "recommend_bps": None,
                                 "by_axis": {"fulfillment": None, "quality": None, "punctuality": None,
                                             "clarity": None}}}
    assert await _en_la_ficha(app, h["servicio"]) == ({"count": 0, "average": None}, {"count": 0, "average": None})
    clave = _clave()
    r = await _hacer(app, "client", h, "review", RESENA, clave=clave)
    assert r.status_code == 201, r.text
    assert await _en_la_ficha(app, h["servicio"]) == ({"count": 1, "average": 5.0}, {"count": 1, "average": 5.0})
    mia = r.json()["care"]["review"]
    assert (mia["rating"], mia["status"], mia["verified"], mia["reply"]) == (5, "published", True, None)
    assert (await _hacer(app, "client", h, "review", RESENA, clave=clave)).json()["care"]["review"]["id"] == mia["id"]
    r = await _hacer(app, "client", h, "review", {**RESENA, "rating": 1})
    assert r.status_code == 409 and _codigo(r) == "service_review_exists"
    publicas = (await _pedir(app, "GET", f"{CATALOGO}/{h['servicio']}/reviews", None)).json()
    assert [x["id"] for x in publicas["items"]] == [mia["id"]] and publicas["items"][0]["status"] is None
    assert publicas["summary"] == {"total": 1, "average": 5.0, "recommend_bps": 10000,
                                   "by_axis": {"fulfillment": None, "quality": None, "punctuality": 4.0,
                                               "clarity": None}}
    assert await _acciones(app, "provider", h) == ["reply_review"]
    r = await _hacer(app, "provider", h, "review/reply", {"reply": "Gracias por venir."})
    assert r.status_code == 200 and r.json()["care"]["review"]["reply"] == "Gracias por venir."
    r = await _hacer(app, "provider", h, "review/reply", {"reply": "Otra cosa."})
    assert r.status_code == 409 and _codigo(r) == "service_review_already_replied"
    assert await _acciones(app, "provider", h) == [] and await _acciones(app, "client", h) == []

    # EL HISTORIAL entero en la base; a las partes no se les enseña lo interno.
    assert await _sucesos(motor, reserva) == [
        "booking_confirmed", "attendance_code_issued", "attendance_started", "attendance_completed",
        "attendance_confirmed", "review_created", "review_replied",
    ]
    assert "attendance_code_issued" not in [e["action"] for e in (await _ver(app, "client", h))["history"]]
    # LOS AVISOS: a la otra parte, y sin nada privado.
    avisos = await _avisos(motor, reserva)
    assert [(a[0], a[1]) for a in avisos if a[1] not in ("service_booking_confirmed", "service_booking_received")] == sorted([
        (cliente, "service_attention_completed_client"), (perfil, "service_review_received_provider"),
        (cliente, "service_review_replied_client"),
    ])
    assert all(a[2] == "service_booking" and a[3] in ("{}", "null") for a in avisos)
    # NI UN MOVIMIENTO DE DINERO, y el pedido como estaba.
    assert await _dinero(motor) == antes
    assert await _filas(motor, "select o.status, o.payment_status, o.total_minor from public.service_orders o "
                               "join public.service_bookings b on b.order_id = o.id where b.id = cast(:b as uuid)",
                        b=reserva) == pedido
    assert jefa


# =========================================================================== #
# 2. Cancelar
# =========================================================================== #
async def test_quien_contrata_cancela_y_el_horario_vuelve(atencion) -> None:
    app, motor, _ = atencion
    antes = await _dinero(motor)
    h = await _reservado(app, motor)
    reserva = h["reserva"]["id"]
    assert h["inicio"] not in [x["starts_at"] for x in await _horarios(app, h["servicio"], h["fecha"])]
    # Sin clave, no. Con un motivo que no existe, tampoco.
    ruta, uid = _de("client", h)
    r = await _pedir(app, "POST", f"{ruta}/cancel", uid, {})
    assert r.status_code == 422 and _codigo(r) == "idempotency_key_required"
    r = await _hacer(app, "client", h, "cancel", {"reason": "porque_si"})
    assert r.status_code == 422 and _codigo(r) == "service_booking_reason_required"
    r = await _hacer(app, "client", h, "cancel", {"sorpresa": 1})
    assert r.status_code == 422

    clave = _clave()
    r = await _hacer(app, "client", h, "cancel", {"reason": "change_of_plans"}, clave=clave)
    assert r.status_code == 200, r.text
    detalle = r.json()
    assert detalle["status"] == "cancelled" and detalle["care"]["available_actions"] == []
    cancelacion = detalle["care"]["cancellation"]
    assert (cancelacion["by"], cancelacion["reason"], cancelacion["financial_effect_status"]) == (
        "client", "change_of_plans", "not_applicable")
    # La misma clave, lo mismo; con otro contenido, 409; con otra clave, ya estaba cancelada.
    assert (await _hacer(app, "client", h, "cancel", {"reason": "change_of_plans"}, clave=clave)).status_code == 200
    r = await _hacer(app, "client", h, "cancel", {"reason": "other"}, clave=clave)
    assert r.status_code == 409 and _codigo(r) == "idempotency_key_reused"
    r = await _hacer(app, "client", h, "cancel", {})
    assert r.status_code == 409 and _codigo(r) == "service_booking_already_cancelled"
    assert (await _sucesos(motor, reserva)).count("booking_cancelled") == 1

    # EL HORARIO VUELVE a la agenda pública, y otra persona lo reserva.
    assert h["inicio"] in [x["starts_at"] for x in await _horarios(app, h["servicio"], h["fecha"])]
    assert await _uno(motor, "select status from public.service_holds where id = cast(:h as uuid)",
                      h=h["retencion"]) == "released"
    otra = await _persona(motor)
    r = await _retener(app, otra, h["servicio"], h["inicio"])
    assert r.status_code == 201, r.text
    assert (await _confirmar(app, otra, r.json()["id"])).status_code == 201
    # EL PEDIDO Y LO ACEPTADO se quedan; el dinero no se mueve.
    assert len(detalle["acceptances"]) == 1 and await _dinero(motor) == antes
    # Deja de estar entre las que vienen: está en las pasadas, cancelada.
    assert [b["id"] for b in (await _pedir(app, "GET", MIS_RESERVAS, h["cliente"])).json()["items"]] == []
    pasadas = (await _pedir(app, "GET", MIS_RESERVAS, h["cliente"], scope="past")).json()["items"]
    assert [(b["id"], b["status"]) for b in pasadas] == [(reserva, "cancelled")]
    # El prestador se entera, sin nada privado. Y ya nada más se puede hacer con ella.
    assert (h["perfil"], "service_booking_cancelled_provider", "service_booking", "{}") in await _avisos(motor, reserva)
    for rol, accion, cuerpo in (("client", "check-in-code", None), ("provider", "start", {}),
                                ("client", "no-show", None),
                                ("client", "incident", {"reason": "quality", "description": DESCRIPCION})):
        r = await _hacer(app, rol, h, accion, cuerpo)
        assert r.status_code == 409, (accion, r.text)


async def test_el_prestador_cancela_explicando_por_que(atencion) -> None:
    app, motor, _ = atencion
    h = await _reservado(app, motor)
    r = await _hacer(app, "provider", h, "cancel", {"reason": "unavailable"})
    assert r.status_code == 422 and _codigo(r) == "service_booking_reason_required"
    assert r.json()["error"]["details"]["field"] == "note"
    r = await _hacer(app, "provider", h, "cancel", {"reason": "unavailable", "note": "Me operan ese día."})
    assert r.status_code == 200 and r.json()["status"] == "cancelled", r.text
    vista = (await _ver(app, "client", h))["care"]["cancellation"]
    assert (vista["by"], vista["note"]) == ("provider", "Me operan ese día.")
    avisos = await _avisos(motor, h["reserva"]["id"])
    assert (h["cliente"], "service_booking_cancelled_client", "service_booking", "{}") in avisos
    assert "Me operan" not in json.dumps(avisos)


async def test_no_se_cancela_lo_que_ya_empezo_ni_lo_ajeno(atencion) -> None:
    app, motor, _ = atencion
    h = await _reservado(app, motor)
    # Una tercera persona, otro prestador y administración: 404, sin decir si existe.
    extrano = await _persona(motor)
    for rol in ("client", "provider"):
        for quien in (extrano, h["jefa"], h["perfil"] if rol == "client" else h["cliente"]):
            r = await _hacer(app, rol, h, "cancel", {"note": "No es mía."}, quien=quien)
            assert r.status_code == 404 and _codigo(r) == "service_booking_not_found", (rol, r.text)
    r = await _pedir(app, "POST", f"{MIS_RESERVAS}/{uuid.uuid4()}/cancel", h["cliente"], {}, _clave())
    assert r.status_code == 404
    r = await _pedir(app, "POST", f"{MIS_RESERVAS}/no-es-un-uuid/cancel", h["cliente"], {}, _clave())
    assert r.status_code == 404
    # Pasada la hora de inicio, ya no se cancela (aunque nadie haya empezado).
    await _llevar(motor, h["reserva"]["id"], minutos=-1)
    for rol in ("client", "provider"):
        r = await _hacer(app, rol, h, "cancel", {"note": "Tarde."})
        assert r.status_code == 409 and _codigo(r) == "service_booking_action_not_available", r.text
    assert (await _ver(app, "client", h))["status"] == "confirmed"


# =========================================================================== #
# 3. Reprogramar
# =========================================================================== #
async def _otro_horario(app, h: dict, *, dias: int = 9) -> tuple[str, str]:
    """`(retención, inicio)`: quien contrata aparta otro horario del mismo servicio."""
    inicio = (await _horarios(app, h["servicio"], _dia(dias)))[0]["starts_at"]
    r = await _retener(app, h["cliente"], h["servicio"], inicio)
    assert r.status_code == 201, r.text
    return r.json()["id"], inicio


async def test_reprogramar_mueve_la_reserva_sin_cambiar_el_contrato(atencion) -> None:
    app, motor, _ = atencion
    antes_dinero = await _dinero(motor)
    h = await _reservado(app, motor)
    reserva = h["reserva"]["id"]
    antes = await _ver(app, "client", h)
    nueva, inicio = await _otro_horario(app, h)
    clave = _clave()
    r = await _hacer(app, "client", h, "reschedule", {"hold_id": nueva}, clave=clave)
    assert r.status_code == 200, r.text
    despues = r.json()
    assert despues["id"] == reserva and despues["status"] == "confirmed" and despues["starts_at"] != antes["starts_at"]
    assert despues["code"] == antes["code"] and despues["acceptances"] == antes["acceptances"]
    assert despues["price"] == antes["price"] and despues["duration_minutes"] == antes["duration_minutes"]
    cambio = despues["care"]["reschedules"]
    assert len(cambio) == 1 and despues["care"]["deadlines"]["reschedules_left"] == 0
    assert "reschedule" not in despues["care"]["available_actions"]
    # La misma clave, la misma reserva; y NO HAY SEGUNDA (la política, provisional, es una).
    assert (await _hacer(app, "client", h, "reschedule", {"hold_id": nueva}, clave=clave)).status_code == 200
    # EL HORARIO ANTERIOR vuelve; el nuevo es suyo.
    assert h["inicio"] in [x["starts_at"] for x in await _horarios(app, h["servicio"], h["fecha"])]
    assert inicio not in [x["starts_at"] for x in await _horarios(app, h["servicio"], _dia(9))]
    assert await _filas(motor, "select status from public.service_holds where id in (cast(:a as uuid), "
                               "cast(:b as uuid)) order by status", a=h["retencion"], b=nueva) == [
        ("consumed",), ("released",)]
    # UN pedido, UNA reserva, las mismas aceptaciones; el prestador se entera; nada de dinero.
    for tabla in ("service_orders", "service_bookings"):
        assert await _uno(motor, f"select count(*) from public.{tabla} where service_id = cast(:s as uuid)",
                          s=h["servicio"]) == 1
    assert (h["perfil"], "service_booking_rescheduled_provider", "service_booking", "{}") in await _avisos(motor, reserva)
    assert await _dinero(motor) == antes_dinero
    tercera, _ = await _otro_horario(app, h, dias=10)
    r = await _hacer(app, "client", h, "reschedule", {"hold_id": tercera})
    assert r.status_code == 409 and _codigo(r) == "service_booking_reschedule_limit"
    assert (await _ver(app, "client", h))["starts_at"] == despues["starts_at"]


async def test_si_reprogramar_falla_la_reserva_original_sigue_en_pie(atencion, monkeypatch) -> None:
    app, motor, _ = atencion
    h = await _reservado(app, motor)
    original = await _ver(app, "client", h)

    async def _intacta() -> None:
        ahora = await _ver(app, "client", h)
        assert (ahora["starts_at"], ahora["status"]) == (original["starts_at"], "confirmed")
        assert await _uno(motor, "select status from public.service_holds where id = cast(:h as uuid)",
                          h=h["retencion"]) == "consumed"
        assert h["inicio"] not in [x["starts_at"] for x in await _horarios(app, h["servicio"], h["fecha"])]

    # Sin retención, con una que no existe, con la suya de siempre o con la de otra persona.
    r = await _hacer(app, "client", h, "reschedule", {})
    assert r.status_code == 422
    for retencion in (str(uuid.uuid4()), "no-es-un-uuid", h["retencion"]):
        r = await _hacer(app, "client", h, "reschedule", {"hold_id": retencion})
        assert r.status_code == 404 and _codigo(r) == "service_hold_not_found", r.text
    otra_persona = await _persona(motor)
    ajena = (await _retener(app, otra_persona, h["servicio"],
                            (await _horarios(app, h["servicio"], _dia(8)))[0]["starts_at"])).json()["id"]
    r = await _hacer(app, "client", h, "reschedule", {"hold_id": ajena})
    assert r.status_code == 404 and _codigo(r) == "service_hold_not_found"
    # El prestador no reprograma (no existe esa ruta para él).
    r = await _hacer(app, "provider", h, "reschedule", {"hold_id": ajena})
    assert r.status_code in (404, 405)
    await _intacta()

    # UNA RETENCIÓN VENCIDA o ya soltada.
    nueva, _ = await _otro_horario(app, h)
    await _sembrar(motor, "update public.service_holds set created_at = now() - interval '20 minutes', "
                          "expires_at = now() - interval '1 second' where id = cast(:h as uuid)", h=nueva)
    r = await _hacer(app, "client", h, "reschedule", {"hold_id": nueva})
    assert r.status_code == 409 and _codigo(r) == "service_hold_expired", r.text
    await _pedir(app, "POST", f"{ADMIN_SERVICIOS}/holds/expire", h["jefa"])
    r = await _hacer(app, "client", h, "reschedule", {"hold_id": nueva})
    assert r.status_code == 409 and _codigo(r) == "service_hold_not_active", r.text
    await _intacta()

    # EL PRESTADOR BLOQUEA ese horario mientras estaba apartado: la agenda de hoy manda.
    nueva, inicio = await _otro_horario(app, h, dias=10)
    r = await _pedir(app, "POST", f"{_agenda(h['servicio'])}/exceptions", h["perfil"],
                     {"date": _dia(10), "kind": "closed"})
    assert r.status_code == 201, r.text
    r = await _hacer(app, "client", h, "reschedule", {"hold_id": nueva})
    assert r.status_code == 409 and _codigo(r) == "service_slot_not_available", r.text
    await _intacta()
    assert inicio

    # DEMASIADO TARDE (la antelación, provisional, es de 24 horas).
    nueva, _ = await _otro_horario(app, h, dias=11)
    await _llevar(motor, h["reserva"]["id"], minutos=23 * 60)
    r = await _hacer(app, "client", h, "reschedule", {"hold_id": nueva})
    assert r.status_code == 409 and _codigo(r) == "service_booking_reschedule_too_late", r.text
    assert "reschedule" not in await _acciones(app, "client", h)
    # Con otra política (es configurable), sí.
    monkeypatch.setattr(get_settings(), "services_booking_reschedule_min_hours", 2)
    assert "reschedule" in await _acciones(app, "client", h)
    r = await _hacer(app, "client", h, "reschedule", {"hold_id": nueva})
    assert r.status_code == 200, r.text


async def test_no_se_reprograma_a_otra_version_del_servicio(atencion) -> None:
    """EL CONTRATO NO CAMBIA: si el prestador publicó otra versión, mover la
    reserva sería contratar otra cosa con las condiciones de antes."""
    from tests.test_servicios_reserva_api import _publicar_otra_version

    app, motor, _ = atencion
    h = await _reservado(app, motor)
    nueva, _ = await _otro_horario(app, h)
    await _publicar_otra_version(app, h["perfil"], h["jefa"], h["moderador"], h["servicio"],
                                 title="Asesoría con otro título")
    r = await _hacer(app, "client", h, "reschedule", {"hold_id": nueva})
    assert r.status_code == 409 and _codigo(r) == "service_booking_version_changed", r.text
    assert "reschedule" not in await _acciones(app, "client", h)
    # Cancelar sí se puede: no cambia el contrato.
    assert (await _hacer(app, "client", h, "cancel", {})).status_code == 200


# =========================================================================== #
# 4. La asistencia: la señal fuerte, la débil y los barridos
# =========================================================================== #
async def test_sin_el_codigo_la_atencion_no_se_cierra_sola(atencion) -> None:
    app, motor, _ = atencion
    h = await _atendida(app, motor, con_codigo=False, hasta="completed")
    reserva = h["reserva"]["id"]
    await _pedir(app, "POST", TAREAS, h["jefa"])  # lo que dejaron otras pruebas
    atendiendo = (await _ver(app, "client", h))["care"]["attendance"]
    assert atendiendo["status"] == "completed" and atendiendo["with_code"] is False
    # Pasado el plazo de confirmación, EL BARRIDO NO LA CIERRA: la cuenta y espera.
    await _retrasar(motor, "service_attendances", "completed_at", "booking_id", reserva, horas=30)
    r = await _pedir(app, "POST", TAREAS, h["jefa"])
    assert r.status_code == 200 and (r.json()["closed"], r.json()["unverified"]) == (0, 1), r.text
    assert (await _ver(app, "client", h))["care"]["attendance"]["status"] == "completed"
    r = await _hacer(app, "client", h, "review", RESENA)
    assert r.status_code == 409 and _codigo(r) == "service_review_not_allowed"
    # Quien contrata sí puede confirmarla.
    r = await _hacer(app, "client", h, "confirm")
    assert r.status_code == 200 and r.json()["care"]["attendance"]["closed_by"] == "client"


async def test_con_el_codigo_y_sin_caso_el_barrido_la_cierra_una_vez(atencion) -> None:
    app, motor, _ = atencion
    antes = await _dinero(motor)
    h = await _atendida(app, motor, hasta="completed")
    reserva = h["reserva"]["id"]
    # Antes de su plazo, no.
    r = await _pedir(app, "POST", TAREAS, h["jefa"])
    assert r.status_code == 200, r.text
    assert (await _ver(app, "client", h))["care"]["attendance"]["status"] == "completed"
    await _retrasar(motor, "service_attendances", "completed_at", "booking_id", reserva, horas=30)
    r = await _pedir(app, "POST", TAREAS, h["jefa"])
    assert r.status_code == 200 and r.json()["closed"] == 1, r.text
    cerrada = (await _ver(app, "client", h))["care"]
    assert (cerrada["attendance"]["status"], cerrada["attendance"]["closed_by"]) == ("closed", "system")
    assert cerrada["available_actions"] == ["review"]
    # REPETIRLO no hace nada: ni otro cierre, ni otro aviso.
    r = await _pedir(app, "POST", TAREAS, h["jefa"])
    assert r.json()["closed"] == 0
    assert (await _sucesos(motor, reserva)).count("attendance_closed") == 1
    avisos = [a for a in await _avisos(motor, reserva) if a[1] == "service_review_available_client"]
    assert avisos == [(h["cliente"], "service_review_available_client", "service_booking", "{}")]
    assert await _dinero(motor) == antes
    # Solo administración lo lanza.
    for quien in (h["cliente"], h["perfil"], h["moderador"]):
        assert (await _pedir(app, "POST", TAREAS, quien)).status_code == 403


async def test_con_un_caso_abierto_la_atencion_no_se_cierra_ni_se_confirma(atencion) -> None:
    app, motor, _ = atencion
    h = await _atendida(app, motor, hasta="completed")
    reserva = h["reserva"]["id"]
    await _llevar(motor, reserva, minutos=-90)
    r = await _hacer(app, "client", h, "incident", {"reason": "incomplete", "description": DESCRIPCION})
    assert r.status_code == 201, r.text
    await _retrasar(motor, "service_attendances", "completed_at", "booking_id", reserva, horas=30)
    r = await _pedir(app, "POST", TAREAS, h["jefa"])
    assert r.json()["closed"] == 0
    assert "confirm" not in await _acciones(app, "client", h)
    r = await _hacer(app, "client", h, "confirm")
    assert r.status_code == 409 and _codigo(r) == "service_attention_incident_open"
    # Retirado el caso, sí.
    assert (await _hacer(app, "client", h, "incident/withdraw")).status_code == 200
    r = await _pedir(app, "POST", TAREAS, h["jefa"])
    assert r.json()["closed"] == 1


async def test_el_codigo_se_bloquea_y_un_prestador_suspendido_no_empieza(atencion) -> None:
    app, motor, _ = atencion
    h = await _atendida(app, motor, hasta="code_issued")
    malo = "000000" if h["codigo"] != "000000" else "111111"
    for quedan in (4, 3, 2, 1, 0):
        r = await _hacer(app, "provider", h, "start", {"code": malo})
        assert r.status_code == 409 and r.json()["error"]["details"]["attempts_left"] == quedan, r.text
    # Agotados, ni con el bueno: ya no es una señal fuerte.
    r = await _hacer(app, "provider", h, "start", {"code": h["codigo"]})
    assert r.status_code == 409 and _codigo(r) == "service_attention_code_blocked"
    for cuerpo in ({"code": "12"}, {"code": "x" * 13}):
        assert (await _hacer(app, "provider", h, "start", cuerpo)).status_code in (409, 422)
    # SUSPENDIDO, no empieza (ni lo ve entre sus acciones).
    await _sembrar(motor, "update public.service_providers set status = 'suspended', suspended_at = now() "
                          "where profile_id = cast(:p as uuid)", p=h["perfil"])
    assert "start" not in await _acciones(app, "provider", h)
    r = await _hacer(app, "provider", h, "start", {})
    assert r.status_code == 409 and _codigo(r) == "service_attention_provider_not_active", r.text
    await _sembrar(motor, "update public.service_providers set status = 'active', suspended_at = null "
                          "where profile_id = cast(:p as uuid)", p=h["perfil"])
    # Sin código empieza, como una declaración suya.
    r = await _hacer(app, "provider", h, "start", {})
    assert r.status_code == 200 and r.json()["care"]["attendance"]["with_code"] is False
    # Quien contrata no empieza ni termina; el prestador no confirma ni pide el código.
    for rol, accion in (("client", "start"), ("client", "complete"), ("provider", "confirm"),
                        ("provider", "check-in-code"), ("provider", "review")):
        r = await _hacer(app, rol, h, accion, {})
        assert r.status_code in (404, 405), (rol, accion, r.text)


async def test_los_recordatorios_salen_una_vez(atencion) -> None:
    app, motor, _ = atencion
    h = await _reservado(app, motor)
    reserva = h["reserva"]["id"]
    # Los barridos son de TODA la base: primero, lo que dejaron otras pruebas.
    await _pedir(app, "POST", TAREAS, h["jefa"])
    assert (await _pedir(app, "POST", TAREAS, h["jefa"])).json()["reminded"] == 0
    assert "booking_reminded" not in await _sucesos(motor, reserva)
    await _llevar(motor, reserva, minutos=10 * 60)
    r = await _pedir(app, "POST", TAREAS, h["jefa"])
    assert r.status_code == 200 and r.json()["reminded"] == 1, r.text
    assert (await _pedir(app, "POST", TAREAS, h["jefa"])).json()["reminded"] == 0
    assert (await _sucesos(motor, reserva)).count("booking_reminded") == 1
    recordatorios = [(a[0], a[1], a[3]) for a in await _avisos(motor, reserva) if "reminder" in a[1]]
    assert recordatorios == sorted([(h["cliente"], "service_booking_reminder_client", "{}"),
                                    (h["perfil"], "service_booking_reminder_provider", "{}")])
    # A las partes no se les enseña en su historial; una cancelada no se recuerda.
    assert "booking_reminded" in await _sucesos(motor, reserva)
    otra = await _reservado(app, motor)
    assert (await _hacer(app, "client", otra, "cancel", {})).status_code == 200
    await _llevar(motor, otra["reserva"]["id"], minutos=120)
    assert (await _pedir(app, "POST", TAREAS, h["jefa"])).json()["reminded"] == 0
    assert "booking_reminded" not in await _sucesos(motor, otra["reserva"]["id"])


# =========================================================================== #
# 5. La inasistencia
# =========================================================================== #
async def test_la_inasistencia_se_declara_pasada_la_tolerancia_y_se_puede_discutir(atencion) -> None:
    app, motor, _ = atencion
    antes = await _dinero(motor)
    h = await _reservado(app, motor)
    reserva = h["reserva"]["id"]
    # Antes de la tolerancia (provisional: 15 minutos), no.
    await _llevar(motor, reserva, minutos=-5)
    assert "report_absence" not in await _acciones(app, "client", h)
    r = await _hacer(app, "client", h, "no-show")
    assert r.status_code == 409 and _codigo(r) == "service_attention_not_in_window", r.text
    await _llevar(motor, reserva, minutos=-20)
    assert "report_absence" in await _acciones(app, "client", h)
    assert "report_absence" in await _acciones(app, "provider", h)
    clave = _clave()
    r = await _hacer(app, "client", h, "no-show", clave=clave)
    assert r.status_code == 200 and r.json()["care"]["attendance"]["status"] == "no_show_provider", r.text
    assert (await _hacer(app, "client", h, "no-show", clave=clave)).status_code == 200
    # Declarada, ya no empieza, ni se declara otra vez, ni se reseña.
    r = await _hacer(app, "provider", h, "start", {})
    assert r.status_code == 409 and _codigo(r) == "service_booking_action_not_available"
    assert (await _hacer(app, "provider", h, "no-show")).status_code == 409
    assert (await _hacer(app, "client", h, "review", RESENA)).status_code == 409
    # Es una DECLARACIÓN sin efecto económico; el prestador se entera y puede discutirla.
    suceso = await _filas(motor, "select details::text from public.service_booking_events where booking_id = "
                                 "cast(:b as uuid) and action = 'no_show_reported'", b=reserva)
    assert json.loads(suceso[0][0]) == {"absent": "provider", "financial_effect_status": "not_applicable"}
    assert (h["perfil"], "service_attention_absent_provider", "service_booking", "{}") in await _avisos(motor, reserva)
    assert "open_incident" in await _acciones(app, "provider", h)
    r = await _hacer(app, "provider", h, "incident", {"reason": "client_absent", "description": DESCRIPCION})
    assert r.status_code == 201, r.text
    caso = r.json()["id"]
    # Administración decide que fue al revés: la atención lo refleja, y sigue sin haber dinero.
    r = await _resolver(app, h["jefa"], caso, attention_effect="client_no_show")
    assert r.status_code == 200, r.text
    assert (await _ver(app, "client", h))["care"]["attendance"]["status"] == "no_show_client"
    assert r.json()["financial_effect_status"] == "not_applicable" and await _dinero(motor) == antes


# =========================================================================== #
# 6. El caso, su expediente y la resolución
# =========================================================================== #
async def test_un_caso_con_su_expediente_privado(atencion) -> None:
    app, motor, almacen = atencion
    h = await _atendida(app, motor, hasta="in_progress")
    reserva, cliente, perfil, jefa = h["reserva"]["id"], h["cliente"], h["perfil"], h["jefa"]
    # Antes de la hora de inicio no hay de qué quejarse.
    r = await _hacer(app, "client", h, "incident", {"reason": "quality", "description": DESCRIPCION})
    assert r.status_code == 409 and _codigo(r) == "service_booking_action_not_available", r.text
    await _llevar(motor, reserva, minutos=-20)
    # Los motivos son de cada parte, y la descripción no puede ser un monosílabo.
    for rol, cuerpo in (("client", {"reason": "client_absent", "description": DESCRIPCION}),
                        ("provider", {"reason": "quality", "description": DESCRIPCION}),
                        ("client", {"reason": "quiero_mi_dinero", "description": DESCRIPCION}),
                        ("client", {"reason": "quality", "description": "Mal."})):
        r = await _hacer(app, rol, h, "incident", cuerpo)
        assert r.status_code == 422 and _codigo(r) == "service_incident_invalid", (cuerpo, r.text)
    ruta, _ = _de("client", h)
    assert (await _pedir(app, "GET", f"{ruta}/incident", cliente)).status_code == 404

    clave = _clave()
    r = await _hacer(app, "client", h, "incident", {"reason": "quality", "description": DESCRIPCION}, clave=clave)
    assert r.status_code == 201, r.text
    caso = r.json()
    assert (caso["status"], caso["opened_by_me"], caso["outcome"], caso["financial_effect"]) == (
        "open", True, None, None)
    assert sorted(caso["available_actions"]) == ["add_incident_entry", "withdraw_incident"]
    r = await _hacer(app, "client", h, "incident", {"reason": "quality", "description": DESCRIPCION}, clave=clave)
    assert r.json()["id"] == caso["id"]
    # UNO POR RESERVA, lo abra quien lo abra.
    for rol, motivo in (("client", "incomplete"), ("provider", "technical")):
        r = await _hacer(app, rol, h, "incident", {"reason": motivo, "description": DESCRIPCION})
        assert r.status_code == 409 and _codigo(r) == "service_incident_exists", r.text

    # EL EXPEDIENTE: mensajes de las dos partes y de administración; evidencias privadas.
    r = await _hacer(app, "provider", h, "incident/entries", {"body": "La sesión se hizo entera."})
    assert r.status_code == 201, r.text
    assert sorted(r.json()["available_actions"]) == ["add_incident_entry"] and r.json()["opened_by_me"] is False
    async with _cliente(app, cliente) as http:
        r = await http.post(f"{ruta}/incident/evidence", files={"file": ("captura.png", PNG, "image/png")},
                            headers={"Idempotency-Key": _clave()})
        assert r.status_code == 201, r.text
        evidencia = [e for e in r.json()["entries"] if e["kind"] == "evidence"][0]
        assert (evidencia["content_type"], evidencia["byte_size"], evidencia["mine"]) == ("image/png", len(PNG), True)
        # El mismo archivo otra vez es el mismo (200), y no deja otro en el depósito.
        r = await http.post(f"{ruta}/incident/evidence", files={"file": ("otra.png", PNG, "image/png")},
                            headers={"Idempotency-Key": _clave()})
        assert r.status_code == 200, r.text
        # Lo que no es un PDF o una foto, por sus BYTES, no entra.
        r = await http.post(f"{ruta}/incident/evidence", files={"file": ("x.png", b"<html>hola</html>", "image/png")},
                            headers={"Idempotency-Key": _clave()})
        assert r.status_code == 422, r.text
        r = await http.post(f"{ruta}/incident/evidence", files={"file": ("x.pdf", PDF, "application/pdf")})
        assert r.status_code == 422 and _codigo(r) == "idempotency_key_required"
    guardados = almacen.de(posventa.DEPOSITO, cliente)
    assert len(guardados) == 1 and guardados[0].startswith(f"{cliente}/{caso['id']}/") and guardados[0].endswith(".png")
    # SE MIRA CON UN ENLACE QUE CADUCA, y lo piden las dos partes y administración; nadie más.
    for rol in ("client", "provider"):
        base, quien = _de(rol, h)
        r = await _pedir(app, "GET", f"{base}/incident/entries/{evidencia['id']}/file", quien)
        assert r.status_code == 200 and r.json()["expires_in"] == 120, r.text
        assert f"/object/sign/{posventa.DEPOSITO}/{guardados[0]}?token=" in r.json()["url"]
    r = await _pedir(app, "GET", f"{CASOS}/{caso['id']}/entries/{evidencia['id']}/file", jefa)
    assert r.status_code == 200, r.text
    extrano = await _persona(motor)
    for metodo, sufijo in (("GET", "incident"), ("GET", f"incident/entries/{evidencia['id']}/file")):
        assert (await _pedir(app, metodo, f"{ruta}/{sufijo}", extrano)).status_code == 404
    assert (await _pedir(app, "GET", f"{CASOS}/{caso['id']}", extrano)).status_code == 403
    assert (await _pedir(app, "GET", f"{CASOS}/{caso['id']}", h["moderador"])).status_code == 403

    # ADMINISTRACIÓN pide información (lo ven las partes) y deja una NOTA INTERNA (no la ve nadie más).
    r = await _pedir(app, "POST", f"{CASOS}/{caso['id']}/entries", jefa, {"body": "¿Tienen la grabación?"}, _clave())
    assert r.status_code == 201, r.text
    r = await _pedir(app, "POST", f"{CASOS}/{caso['id']}/entries", jefa,
                     {"body": "Nota solo para el equipo", "internal": True}, _clave())
    assert r.status_code == 201, r.text
    nota = [e for e in r.json()["entries"] if e["kind"] == "internal_note"][0]
    for rol in ("client", "provider"):
        base, quien = _de(rol, h)
        visto = (await _pedir(app, "GET", f"{base}/incident", quien)).json()
        assert [e["kind"] for e in visto["entries"]] == ["message", "evidence", "message"]
        assert "Nota solo para el equipo" not in json.dumps(visto, ensure_ascii=False)
        assert "storage_path" not in json.dumps(visto) and posventa.DEPOSITO not in json.dumps(visto)
        assert (await _pedir(app, "GET", f"{base}/incident/entries/{nota['id']}/file", quien)).status_code == 404
    # La bandeja de administración, sin nada privado de las partes.
    bandeja = (await _pedir(app, "GET", CASOS, jefa, status="open")).json()
    mio = [c for c in bandeja["items"] if c["id"] == caso["id"]]
    assert len(mio) == 1 and mio[0]["booking_code"] == h["reserva"]["code"]
    assert DESCRIPCION not in json.dumps(bandeja, ensure_ascii=False)
    # LOS AVISOS: a la otra parte y al equipo, con la entidad y nada más.
    avisos = await _avisos(motor, reserva, caso["id"])
    tipos = [(a[0], a[1], a[2]) for a in avisos if "incident" in a[1]]
    assert (perfil, "service_incident_opened_provider", "service_booking") in tipos
    assert (jefa, "service_incident_opened_team", "service_incident") in tipos
    assert (cliente, "service_incident_opened_client", "service_booking") not in tipos
    assert (cliente, "service_incident_updated_client", "service_booking") in tipos
    crudo = json.dumps(avisos, ensure_ascii=False)
    assert not [p for p in PRIVADO if p in crudo] and all(a[3] in ("{}", "null") for a in avisos)

    # RETIRARLO: solo quien lo abrió. Retirado, no admite nada más.
    r = await _hacer(app, "provider", h, "incident/withdraw")
    assert r.status_code == 409 and _codigo(r) == "service_incident_not_open", r.text
    r = await _hacer(app, "client", h, "incident/withdraw")
    assert r.status_code == 200 and r.json()["status"] == "withdrawn" and r.json()["available_actions"] == []
    r = await _hacer(app, "client", h, "incident/entries", {"body": "Una cosa más."})
    assert r.status_code == 409 and _codigo(r) == "service_incident_not_open"
    r = await _resolver(app, jefa, caso["id"])
    assert r.status_code == 409 and _codigo(r) == "service_incident_not_open"


async def test_el_plazo_para_abrir_un_caso_y_la_excepcion_de_seguridad(atencion) -> None:
    app, motor, _ = atencion
    h = await _atendida(app, motor)
    # Tres días después de terminar (el plazo, provisional, es de 48 horas).
    await _llevar(motor, h["reserva"]["id"], minutos=-3 * 24 * 60)
    await _retrasar(motor, "service_attendances", "completed_at", "booking_id", h["reserva"]["id"], horas=71)
    assert "open_incident" in await _acciones(app, "client", h)  # se ofrece: el de seguridad sigue abierto
    r = await _hacer(app, "client", h, "incident", {"reason": "quality", "description": DESCRIPCION})
    assert r.status_code == 409 and _codigo(r) == "service_incident_window_closed", r.text
    r = await _hacer(app, "client", h, "incident", {"reason": "safety", "description": DESCRIPCION})
    assert r.status_code == 201, r.text


async def test_resolver_no_es_devolver_dinero(atencion) -> None:
    app, motor, _ = atencion
    antes = await _dinero(motor)
    h = await _con_caso(app, motor)
    caso, jefa = h["caso"], h["jefa"]
    for cuerpo in ({"outcome": "ganó"}, {"attention_effect": "borrar"}, {"financial_effect": "transfer"},
                   {"resolution": " "}):
        r = await _resolver(app, jefa, caso, **cuerpo)
        assert r.status_code == 422 and _codigo(r) == "service_incident_invalid", (cuerpo, r.text)
    assert (await _resolver(app, jefa, caso, financial_effect_status="executed")).status_code == 422
    # Solo administración; y nunca quien es parte.
    for quien in (h["cliente"], h["perfil"], h["moderador"]):
        assert (await _resolver(app, quien, caso)).status_code == 403
    await _sembrar(motor, "update public.profiles set role = 'admin' where id = cast(:u as uuid)", u=h["perfil"])
    r = await _resolver(app, h["perfil"], caso)
    assert r.status_code == 409 and _codigo(r) == "service_incident_resolver_conflict", r.text
    await _sembrar(motor, "update public.profiles set role = 'user' where id = cast(:u as uuid)", u=h["perfil"])

    # SE PIDE UNA DEVOLUCIÓN TOTAL de algo gratuito: queda solicitada y «no aplica». Nada se ejecuta.
    clave = _clave()
    r = await _resolver(app, jefa, caso, clave=clave, attention_effect="none", financial_effect="full_refund",
                        internal_note="Nota solo para el equipo")
    assert r.status_code == 200, r.text
    resuelto = r.json()
    assert (resuelto["status"], resuelto["outcome"], resuelto["financial_effect"],
            resuelto["financial_effect_status"], resuelto["resolutions"]) == (
        "resolved", "upheld", "full_refund", "not_applicable", 1)
    assert (await _resolver(app, jefa, caso, clave=clave, attention_effect="none", financial_effect="full_refund",
                            internal_note="Nota solo para el equipo")).status_code == 200
    r = await _resolver(app, jefa, caso)
    assert r.status_code == 409 and _codigo(r) == "service_incident_not_open"
    assert await _dinero(motor) == antes
    assert await _uno(motor, "select count(*) from public.service_booking_events where booking_id = cast(:b as uuid) "
                             "and action = 'incident_resolved'", b=h["reserva"]["id"]) == 1
    # Las partes ven la resolución y el estado del efecto; no la nota interna.
    for rol in ("client", "provider"):
        base, quien = _de(rol, h)
        visto = (await _pedir(app, "GET", f"{base}/incident", quien)).json()
        assert visto["financial_effect_status"] == "not_applicable" and visto["appeal_until"] is not None
        assert visto["entries"][-1]["kind"] == "resolution" and visto["available_actions"] == ["appeal_incident"]
        assert "Nota solo para el equipo" not in json.dumps(visto, ensure_ascii=False)
    avisos = [(a[0], a[1]) for a in await _avisos(motor, h["reserva"]["id"], caso) if "resolved" in a[1]]
    assert avisos == sorted([(h["cliente"], "service_incident_resolved_client"),
                             (h["perfil"], "service_incident_resolved_provider")])
    # LA VISTA DE EFECTOS SOLICITADOS es de lectura y lo trae.
    pedidos = (await _pedir(app, "GET", CASOS, jefa, with_financial_effect="true")).json()["items"]
    assert [(c["id"], c["financial_effect"], c["financial_effect_status"]) for c in pedidos if c["id"] == caso] == [
        (caso, "full_refund", "not_applicable")]
    sin = await _con_caso(app, motor, jefa=jefa, moderador=h["moderador"])
    assert (await _resolver(app, jefa, sin["caso"])).status_code == 200
    pedidos = (await _pedir(app, "GET", CASOS, jefa, with_financial_effect="true")).json()["items"]
    assert sin["caso"] not in [c["id"] for c in pedidos]


async def test_una_apelacion_por_caso_y_la_resuelve_otra_persona(atencion) -> None:
    app, motor, _ = atencion
    h = await _con_caso(app, motor)
    caso, jefa = h["caso"], h["jefa"]
    otra_jefa = await _persona(motor, "admin")
    # No se apela lo que nadie resolvió.
    r = await _hacer(app, "provider", h, "incident/appeal", {"body": "No estoy de acuerdo con la decisión tomada."})
    assert r.status_code == 409 and _codigo(r) == "service_incident_appeal_not_allowed", r.text
    assert (await _resolver(app, jefa, caso, attention_effect="completed")).status_code == 200
    # La resolución CERRÓ la atención (verificada por administración): se puede reseñar.
    cuidado = (await _ver(app, "client", h))["care"]
    assert (cuidado["attendance"]["status"], cuidado["attendance"]["closed_by"]) == ("closed", "admin")
    assert "review" in cuidado["available_actions"]
    # La apelación necesita decir por qué.
    r = await _hacer(app, "provider", h, "incident/appeal", {"body": "No."})
    assert r.status_code == 422 and _codigo(r) == "service_incident_invalid"
    clave = _clave()
    cuerpo = {"body": "No estoy de acuerdo: la sesión se dio completa y hay grabación."}
    r = await _hacer(app, "provider", h, "incident/appeal", cuerpo, clave=clave)
    assert r.status_code == 200, r.text
    assert (r.json()["status"], r.json()["appealed_by"]) == ("appealed", "provider")
    assert (await _hacer(app, "provider", h, "incident/appeal", cuerpo, clave=clave)).status_code == 200
    # UNA: ni la otra parte apela ahora.
    r = await _hacer(app, "client", h, "incident/appeal", cuerpo)
    assert r.status_code == 409 and _codigo(r) == "service_incident_appeal_not_allowed"
    tipos = [(a[0], a[1]) for a in await _avisos(motor, h["reserva"]["id"], caso)]
    assert (otra_jefa, "service_incident_appealed_team") in tipos and (jefa, "service_incident_appealed_team") in tipos
    # QUIEN RESOLVIÓ NO RESUELVE SU APELACIÓN.
    r = await _resolver(app, jefa, caso, outcome="rejected")
    assert r.status_code == 409 and _codigo(r) == "service_incident_resolver_conflict", r.text
    # Una atención ya cerrada no se desmiente con una resolución.
    r = await _resolver(app, otra_jefa, caso, outcome="rejected", attention_effect="provider_no_show")
    assert r.status_code == 409 and _codigo(r) == "service_incident_effect_not_allowed", r.text
    r = await _resolver(app, otra_jefa, caso, outcome="rejected")
    assert r.status_code == 200, r.text
    assert (r.json()["status"], r.json()["outcome"], r.json()["resolutions"]) == ("closed", "rejected", 2)
    # CERRADO ES FINAL.
    for rol in ("client", "provider"):
        r = await _hacer(app, rol, h, "incident/appeal", cuerpo)
        assert r.status_code == 409 and _codigo(r) == "service_incident_appeal_not_allowed"
        base, quien = _de(rol, h)
        assert (await _pedir(app, "GET", f"{base}/incident", quien)).json()["available_actions"] == []
    assert (await _resolver(app, await _persona(motor, "admin"), caso)).status_code == 409


async def test_pasado_su_plazo_ya_no_se_apela(atencion) -> None:
    app, motor, _ = atencion
    h = await _con_caso(app, motor)
    assert (await _resolver(app, h["jefa"], h["caso"])).status_code == 200
    await _retrasar(motor, "service_incidents", "resolved_at", "id", h["caso"], horas=6 * 24)
    base, quien = _de("client", h)
    assert (await _pedir(app, "GET", f"{base}/incident", quien)).json()["available_actions"] == []
    r = await _hacer(app, "client", h, "incident/appeal", {"body": "No estoy de acuerdo con la decisión tomada."})
    assert r.status_code == 409 and _codigo(r) == "service_incident_appeal_not_allowed", r.text


# =========================================================================== #
# 7. La reseña verificada y su moderación
# =========================================================================== #
async def test_una_resena_solo_de_una_atencion_cerrada_y_dentro_de_su_plazo(atencion) -> None:
    app, motor, _ = atencion
    h = await _atendida(app, motor, hasta="completed")
    r = await _hacer(app, "client", h, "review", RESENA)
    assert r.status_code == 409 and _codigo(r) == "service_review_not_allowed"
    assert (await _hacer(app, "client", h, "confirm")).status_code == 200
    for cuerpo in ({**RESENA, "rating": 6}, {**RESENA, "rating": 0}, {**RESENA, "quality": 9},
                   {**RESENA, "comment": "Bien."}, {**RESENA, "comment": "x" * 2001}):
        r = await _hacer(app, "client", h, "review", cuerpo)
        assert r.status_code == 422 and _codigo(r) == "service_review_invalid", (cuerpo, r.text)
    for cuerpo in ({"rating": 5, "comment": COMENTARIO}, {**RESENA, "verified": True}, {**RESENA, "status": "published"}):
        assert (await _hacer(app, "client", h, "review", cuerpo)).status_code == 422
    # El prestador no se reseña a sí mismo, ni un tercero reseña lo ajeno.
    assert (await _hacer(app, "client", h, "review", RESENA, quien=h["perfil"])).status_code == 404
    assert (await _hacer(app, "client", h, "review", RESENA, quien=await _persona(motor))).status_code == 404
    # Pasado su plazo (provisional: 30 días), ya no.
    await _retrasar(motor, "service_attendances", "closed_at", "booking_id", h["reserva"]["id"], horas=31 * 24)
    assert "review" not in await _acciones(app, "client", h)
    r = await _hacer(app, "client", h, "review", RESENA)
    assert r.status_code == 409 and _codigo(r) == "service_review_not_allowed"
    assert await _uno(motor, "select count(*) from public.service_reviews") is not None
    # Una reserva cancelada o con una inasistencia declarada no se reseña.
    cancelada = await _reservado(app, motor, jefa=h["jefa"], moderador=h["moderador"])
    assert (await _hacer(app, "client", cancelada, "cancel", {})).status_code == 200
    assert (await _hacer(app, "client", cancelada, "review", RESENA)).status_code == 409


async def test_con_moderacion_previa_no_se_ve_hasta_que_se_publica(reservas, monkeypatch) -> None:  # noqa: F811
    app, motor, _ = reservas
    monkeypatch.setattr(get_settings(), "services_reviews_premoderation", True)
    h = await _atendida(app, motor)
    jefa, servicio = h["jefa"], h["servicio"]
    r = await _hacer(app, "client", h, "review", {**RESENA, "rating": 2, "recommends": False})
    assert r.status_code == 201 and r.json()["care"]["review"]["status"] == "pending", r.text
    resena = r.json()["care"]["review"]["id"]
    # NADIE MÁS LA VE: ni la ficha, ni el prestador (ni se le avisa, ni puede responder).
    publicas = (await _pedir(app, "GET", f"{CATALOGO}/{servicio}/reviews", None)).json()
    assert publicas["items"] == [] and publicas["summary"]["total"] == 0 and publicas["summary"]["average"] is None
    assert await _en_la_ficha(app, servicio) == ({"count": 0, "average": None}, {"count": 0, "average": None})
    assert (await _ver(app, "provider", h))["care"]["review"] is None
    assert "reply_review" not in await _acciones(app, "provider", h)
    r = await _hacer(app, "provider", h, "review/reply", {"reply": "Gracias."})
    assert r.status_code == 404 and _codigo(r) == "service_review_not_found"
    assert "service_review_received_provider" not in [a[1] for a in await _avisos(motor, h["reserva"]["id"])]

    # LA BANDEJA: solo administración.
    for quien in (h["cliente"], h["perfil"], h["moderador"]):
        assert (await _pedir(app, "GET", RESENAS, quien)).status_code == 403
    pendientes = (await _pedir(app, "GET", RESENAS, jefa, status="pending")).json()["items"]
    assert resena in [x["id"] for x in pendientes]
    ruta = f"{RESENAS}/{resena}/moderate"
    for cuerpo in ({"action": "delete"}, {"action": "hide"}, {"action": "hide", "reason": "es_negativa"},
                   {"action": "publish", "comment": "Reescrita"}):
        r = await _pedir(app, "POST", ruta, jefa, cuerpo, _clave())
        assert r.status_code == 422, (cuerpo, r.text)
    # Quien es parte de esa reserva no la modera.
    await _sembrar(motor, "update public.profiles set role = 'admin' where id = cast(:u as uuid)", u=h["perfil"])
    r = await _pedir(app, "POST", ruta, h["perfil"], {"action": "hide", "reason": "off_topic"}, _clave())
    assert r.status_code == 409 and _codigo(r) == "service_incident_resolver_conflict", r.text
    await _sembrar(motor, "update public.profiles set role = 'user' where id = cast(:u as uuid)", u=h["perfil"])

    clave = _clave()
    r = await _pedir(app, "POST", ruta, jefa, {"action": "publish"}, clave)
    assert r.status_code == 200 and r.json()["status"] == "published", r.text
    assert (await _pedir(app, "POST", ruta, jefa, {"action": "publish"}, clave)).status_code == 200
    r = await _pedir(app, "POST", ruta, jefa, {"action": "publish"}, _clave())
    assert r.status_code == 409 and _codigo(r) == "service_review_moderation_not_allowed"
    # PUBLICADA TAL CUAL (una negativa no se toca), y el prestador se entera y responde.
    publicas = (await _pedir(app, "GET", f"{CATALOGO}/{servicio}/reviews", None)).json()
    assert [(x["id"], x["rating"], x["comment"]) for x in publicas["items"]] == [(resena, 2, COMENTARIO)]
    assert publicas["summary"]["average"] == 2.0 and publicas["summary"]["recommend_bps"] == 0
    assert await _en_la_ficha(app, servicio) == ({"count": 1, "average": 2.0}, {"count": 1, "average": 2.0})
    assert (h["perfil"], "service_review_received_provider") in [(a[0], a[1]) for a in await _avisos(motor, h["reserva"]["id"])]
    assert (await _hacer(app, "provider", h, "review/reply", {"reply": "Lamento que no fuera lo esperado."})).status_code == 200
    # ESCONDERLA exige un motivo de la lista; deja de verse y de contar, y NO se borra.
    r = await _pedir(app, "POST", ruta, jefa, {"action": "hide", "reason": "personal_data"}, _clave())
    assert r.status_code == 200 and r.json()["status"] == "hidden", r.text
    publicas = (await _pedir(app, "GET", f"{CATALOGO}/{servicio}/reviews", None)).json()
    assert publicas["items"] == [] and publicas["summary"] == {
        "total": 0, "average": None, "recommend_bps": None,
        "by_axis": {"fulfillment": None, "quality": None, "punctuality": None, "clarity": None}}
    assert await _en_la_ficha(app, servicio) == ({"count": 0, "average": None}, {"count": 0, "average": None})
    assert await _uno(motor, "select comment from public.service_reviews where id = cast(:r as uuid)", r=resena) == COMENTARIO
    assert (await _ver(app, "client", h))["care"]["review"]["status"] == "hidden"
    assert (await _sucesos(motor, h["reserva"]["id"])).count("review_moderated") == 2
    assert "review_moderated" not in [e["action"] for e in (await _ver(app, "client", h))["history"]]
    assert (await _pedir(app, "POST", f"{RESENAS}/{uuid.uuid4()}/moderate", jefa, {"action": "publish"},
                         _clave())).status_code == 404


async def test_las_resenas_de_un_servicio_que_no_es_publico_no_se_ven(atencion) -> None:
    app, motor, _ = atencion
    h = await _atendida(app, motor)
    assert (await _hacer(app, "client", h, "review", RESENA)).status_code == 201
    ruta = f"{CATALOGO}/{h['servicio']}/reviews"
    assert len((await _pedir(app, "GET", ruta, None)).json()["items"]) == 1
    assert (await _pedir(app, "GET", f"{CATALOGO}/{uuid.uuid4()}/reviews", None)).status_code == 404
    await _sembrar(motor, "update public.service_providers set status = 'suspended', suspended_at = now() "
                          "where profile_id = cast(:p as uuid)", p=h["perfil"])
    assert (await _pedir(app, "GET", ruta, None)).status_code == 404
    await _sembrar(motor, "update public.service_providers set status = 'active', suspended_at = null "
                          "where profile_id = cast(:p as uuid)", p=h["perfil"])
    assert (await _pedir(app, "GET", ruta, None, cursor="no-es-un-cursor")).status_code in (400, 422)


# =========================================================================== #
# 8. Sesión, banderas y la puerta de la 0094
# =========================================================================== #
def _todas_las_rutas(h: dict) -> list[tuple[str, str, str | None]]:
    """`(método, ruta, quién)` de TODAS las rutas del incremento."""
    mia, cliente = _de("client", h)
    suya, perfil = _de("provider", h)
    caso, entrada, resena = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    rutas: list[tuple[str, str, str | None]] = []
    for base, quien in ((mia, cliente), (suya, perfil)):
        rutas += [("POST", f"{base}/{a}", quien) for a in (
            "cancel", "no-show", "incident", "incident/entries", "incident/evidence", "incident/withdraw",
            "incident/appeal")]
        rutas += [("GET", f"{base}/incident", quien), ("GET", f"{base}/incident/entries/{entrada}/file", quien)]
    rutas += [("POST", f"{mia}/{a}", cliente) for a in ("reschedule", "check-in-code", "confirm", "review")]
    rutas += [("POST", f"{suya}/{a}", perfil) for a in ("start", "complete", "review/reply")]
    rutas += [
        ("GET", CASOS, h["jefa"]), ("GET", f"{CASOS}/{caso}", h["jefa"]), ("POST", f"{CASOS}/{caso}/entries", h["jefa"]),
        ("GET", f"{CASOS}/{caso}/entries/{entrada}/file", h["jefa"]), ("POST", f"{CASOS}/{caso}/resolve", h["jefa"]),
        ("GET", RESENAS, h["jefa"]), ("POST", f"{RESENAS}/{resena}/moderate", h["jefa"]), ("POST", TAREAS, h["jefa"]),
    ]
    return rutas


async def _llamar(app, metodo: str, ruta: str, quien: str | None):
    """Con clave y con un cuerpo cualquiera: las puertas van antes que el cuerpo."""
    return await _pedir(app, metodo, ruta, quien, {} if metodo == "POST" else None,
                        _clave() if metodo == "POST" else None)


async def test_sin_sesion_401_y_con_las_banderas_apagadas_503(atencion, monkeypatch) -> None:
    app, motor, _ = atencion
    h = await _reservado(app, motor)
    rutas = _todas_las_rutas(h)
    assert len(rutas) == 33
    for metodo, ruta, _ in rutas:
        r = await _llamar(app, metodo, ruta, None)
        assert r.status_code == 401, (metodo, ruta, r.text)
    # En administración, EL ROL va antes que las puertas.
    for metodo, ruta, _ in rutas[-8:]:
        assert (await _llamar(app, metodo, ruta, h["cliente"])).status_code == 403, ruta
    for bandera, codigo in (("feature_service_booking", "service_booking_disabled"),
                            ("feature_services", "services_disabled")):
        monkeypatch.setattr(get_settings(), bandera, False)
        esquema.olvidar()
        for metodo, ruta, quien in rutas:
            r = await _llamar(app, metodo, ruta, quien)
            assert r.status_code == 503 and _codigo(r) == codigo, (bandera, metodo, ruta, r.text)
    # Lo público: con Servicios apagado, 503; con la contratación apagada, no hay reseñas que enseñar.
    resenas = f"{CATALOGO}/{h['servicio']}/reviews"
    assert (await _pedir(app, "GET", resenas, None)).status_code == 503
    monkeypatch.setattr(get_settings(), "feature_services", True)
    esquema.olvidar()
    assert (await _pedir(app, "GET", resenas, None)).json() == {
        "available": False, "items": [], "next_cursor": None, "summary": None}


async def _puerta_de_la_atencion(motor, *cambios: str) -> bool:
    esquema.olvidar()
    async with motor.connect() as conexion:
        transaccion = await conexion.begin()
        try:
            for sql in cambios:
                await conexion.execute(text(sql))
            sesion = AsyncSession(bind=conexion)
            try:
                return await esquema.hay_atencion(sesion)
            finally:
                await sesion.close()
        finally:
            await transaccion.rollback()
            esquema.olvidar()


_A, _I, _E, _R = ("public.service_attendances", "public.service_incidents", "public.service_incident_entries",
                  "public.service_reviews")
_B = "public.service_bookings"

#: CADA FORMA de que la 0094 falte, esté a medias o esté aflojada.
ALTERACIONES_DE_LA_0094 = (
    (f"drop table {_R}",),
    (f"drop table {_E}",),
    (f"alter table {_A} drop column started_with_code",),
    (f"alter table {_I} add column refund_minor integer",),
    (f"alter table {_A} alter column checkin_attempts type bigint",),
    (f"alter table {_R} alter column recommends drop not null",),
    (f"alter table {_A} alter column started_with_code set default true",),
    # El efecto económico, con un estado «ejecutado».
    (f"alter table {_I} drop constraint service_incidents_estado_del_efecto",
     f"alter table {_I} add constraint service_incidents_estado_del_efecto check (financial_effect_status is null "
     "or financial_effect_status in ('not_applicable', 'pending', 'blocked', 'executed'))"),
    (f"alter table {_I} drop constraint service_incidents_sin_efecto",),
    (f"alter table {_I} drop constraint service_incidents_una_por_reserva",),
    (f"alter table {_R} drop constraint service_reviews_una_por_reserva",),
    (f"alter table {_A} drop constraint service_attendances_cierre",
     f"alter table {_A} add constraint service_attendances_cierre check (true) not valid"),
    # Una reseña que borra con su servicio (dos caminos), o sin diferir, o que borra a su autor.
    (f"alter table {_R} drop constraint service_reviews_service_id_fkey",
     f"alter table {_R} add constraint service_reviews_service_id_fkey foreign key (service_id) "
     "references public.services(id) on delete cascade"),
    (f"alter table {_R} drop constraint service_reviews_service_id_fkey",
     f"alter table {_R} add constraint service_reviews_service_id_fkey foreign key (service_id) "
     "references public.services(id)"),
    (f"alter table {_R} drop constraint service_reviews_author_id_fkey",
     f"alter table {_R} add constraint service_reviews_author_id_fkey foreign key (author_id) "
     "references public.profiles(id) on delete cascade"),
    ("drop index public.service_incident_entries_un_archivo",),
    ("drop index public.service_incident_entries_un_archivo",
     f"create index service_incident_entries_un_archivo on {_E} (incident_id, sha256) where sha256 is not null"),
    ("update pg_catalog.pg_index set indisvalid = false "
     "where indexrelid = 'public.service_reviews_una_por_reserva'::regclass",),
    # Los disparadores: sin el de la reseña verificada, apagado, o con otro cuerpo.
    (f"drop trigger service_reviews_verificadas on {_R}",),
    (f"alter table {_A} disable trigger service_attendances_salto_valido",),
    (f"drop trigger service_incident_entries_inmutables on {_E}",),
    (f"drop trigger service_incidents_solo_en_cascada on {_I}",),
    ("create or replace function public.servicios_resena_verificada() returns trigger language plpgsql "
     "set search_path = public, pg_temp as $$ begin return new; end; $$",),
    ("alter function public.servicios_atencion_salto_valido() security definer",),
    # Lo que la 0094 cambia de la reserva: sin su comprobación al confirmar, o sin diferir, o con el cuerpo de la 0093.
    (f"drop trigger service_bookings_coherentes_al_cambiar on {_B}",),
    (f"drop trigger service_bookings_coherentes_al_cambiar on {_B}",
     f"create constraint trigger service_bookings_coherentes_al_cambiar after update on {_B} "
     "deferrable initially immediate for each row execute function public.servicios_reserva_coherente_al_cambiar()"),
    ("create or replace function public.servicios_reserva_coherente_al_cambiar() returns trigger language plpgsql "
     "set search_path = public, pg_temp as $$ begin return null; end; $$",),
    (f"alter table {_B} drop constraint service_bookings_estado",
     f"alter table {_B} add constraint service_bookings_estado check (status in ('confirmed')) not valid"),
    (f"alter table {_B} drop constraint service_bookings_estado",
     f"alter table {_B} add constraint service_bookings_estado check (status in ('confirmed', 'cancelled')) not valid"),
    ("alter table public.service_booking_events drop constraint service_booking_events_rol",
     "alter table public.service_booking_events add constraint service_booking_events_rol "
     "check (actor_role in ('client', 'system', 'provider', 'admin', 'finance'))"),
    # Cerrada: RLS, políticas, permisos (también de columna y de función) y el depósito.
    (f"alter table {_I} disable row level security",),
    (f"create policy abierta on {_R} for select to anon using (true)",),
    (f"grant select on {_E} to authenticated",),
    (f"grant select (checkin_code) on {_A} to authenticated",),
    (f"grant insert on {_R} to public",),
    ("grant execute on function public.servicios_resena_verificada() to authenticated",),
    ("grant execute on function public.servicios_borrado_solo_en_cascada() to public",),
    ("update storage.buckets set public = true where id = 'service-incident-evidence'",),
    ("delete from storage.buckets where id = 'service-incident-evidence'",),
)


async def test_la_puerta_de_la_atencion_mira_lo_que_hace_falta(atencion) -> None:
    _, motor, _ = atencion
    assert await _puerta_de_la_atencion(motor) is True
    abiertas = [c for c in ALTERACIONES_DE_LA_0094 if await _puerta_de_la_atencion(motor, *c) is not False]
    assert abiertas == []
    assert await _puerta_de_la_atencion(motor, f"grant all on {_R} to service_role") is True


async def test_con_la_0094_alterada_lo_nuevo_contesta_503_y_nunca_500(atencion) -> None:
    app, motor, _ = atencion
    h = await _reservado(app, motor)
    rutas = _todas_las_rutas(h)
    normal = app.dependency_overrides[get_db]
    try:
        for cambios in ALTERACIONES_DE_LA_0094[::4]:
            esquema.olvidar()
            async with motor.connect() as conexion:
                transaccion = await conexion.begin()
                sesion = AsyncSession(bind=conexion, expire_on_commit=False)
                app.dependency_overrides[get_db] = _siempre(sesion)
                try:
                    for sql in cambios:
                        await conexion.execute(text(sql))
                    for metodo, ruta, quien in rutas:
                        r = await _llamar(app, metodo, ruta, quien)
                        assert (r.status_code, _codigo(r)) == (503, "services_not_ready"), (cambios, ruta, r.text)
                    r = await _pedir(app, "GET", f"{CATALOGO}/{h['servicio']}/reviews", None)
                    assert r.status_code in (200, 503) and (r.status_code == 503 or r.json()["available"] is False)
                finally:
                    app.dependency_overrides[get_db] = normal
                    await sesion.close()
                    await transaccion.rollback()
                    esquema.olvidar()
    finally:
        app.dependency_overrides[get_db] = normal
    assert (await _acciones(app, "client", h)) == ["cancel", "reschedule"]


def _sin_transaccion(sql: str) -> str:
    return re.sub(r"(?m)^\s*(begin|commit);\s*$", "", sql)


async def test_sobre_una_base_solo_con_la_0093_la_reserva_sigue_y_la_atencion_espera(atencion) -> None:
    """LA SITUACIÓN DE PRODUCCIÓN HOY: la 0093 aplicada y la 0094 no. La
    reserva del Incremento 5 funciona entera; el detalle no trae `care` (la app
    no ofrece ninguna acción) y lo nuevo contesta 503, nunca 500. Se llega ahí
    DESHACIENDO la 0094 con el procedimiento de su cabecera, dentro de una
    transacción que no se confirma."""
    app, motor, _ = atencion
    h = await _reservado(app, motor)
    migracion = (MIGRACIONES / "0094_servicios_atencion_y_cierre.sql").read_text(encoding="utf-8").replace("\r\n", "\n")
    la_0093 = (MIGRACIONES / "0093_servicios_reserva_y_contratacion.sql").read_text(encoding="utf-8")
    inicio = migracion.index("-- ROLLBACK")
    fin = migracion.index("-- Y DESPUÉS, reejecutar la 0093 entera", inicio)
    deshacer = "\n".join(l[2:] for l in migracion[inicio:fin].splitlines() if l.startswith("--   "))
    deshacer = deshacer[deshacer.index("drop trigger service_bookings_coherentes_al_cambiar"):]
    normal = app.dependency_overrides[get_db]
    esquema.olvidar()
    try:
        async with motor.connect() as conexion:
            transaccion = await conexion.begin()
            sesion = AsyncSession(bind=conexion, expire_on_commit=False)
            app.dependency_overrides[get_db] = _siempre(sesion)
            try:
                # Lo que otras pruebas dejaron de este incremento, fuera (no se confirma).
                await conexion.execute(text("set local session_replication_role = replica"))
                await conexion.execute(text(
                    "delete from public.service_booking_events where action not in ('hold_created', "
                    "'hold_released', 'hold_expired', 'booking_confirmed') or actor_role not in ('client', 'system')"))
                await conexion.execute(text("update public.service_bookings set status = 'confirmed' "
                                            "where status <> 'confirmed'"))
                await conexion.execute(text("set local session_replication_role = origin"))
                raw = await conexion.get_raw_connection()
                await raw.driver_connection.execute(_sin_transaccion(deshacer))
                await raw.driver_connection.execute(_sin_transaccion(la_0093))
                assert await esquema.hay_reservas(sesion) is True
                assert await esquema.hay_atencion(sesion) is False
                esquema.olvidar()
                # LA RESERVA SIGUE: la lista, el detalle (sin `care`) y la bandeja del prestador.
                assert (await _pedir(app, "GET", MIS_RESERVAS, h["cliente"])).status_code == 200
                detalle = await _pedir(app, "GET", f"{MIS_RESERVAS}/{h['reserva']['id']}", h["cliente"])
                assert detalle.status_code == 200 and detalle.json()["care"] is None, detalle.text
                suya = await _pedir(app, "GET", f"{DEL_PRESTADOR}/{h['reserva']['id']}", h["perfil"])
                assert suya.status_code == 200 and suya.json()["care"] is None
                # LO NUEVO ESPERA.
                for metodo, ruta, quien in _todas_las_rutas(h):
                    r = await _llamar(app, metodo, ruta, quien)
                    assert (r.status_code, _codigo(r)) == (503, "services_not_ready"), (ruta, r.text)
                r = await _pedir(app, "GET", f"{CATALOGO}/{h['servicio']}/reviews", None)
                assert r.status_code == 200 and r.json()["available"] is False
                assert await _en_la_ficha(app, h["servicio"]) == (
                    {"count": 0, "average": None}, {"count": 0, "average": None})
            finally:
                app.dependency_overrides[get_db] = normal
                await sesion.close()
                await transaccion.rollback()
                esquema.olvidar()
    finally:
        app.dependency_overrides[get_db] = normal
    assert await _puerta_de_la_atencion(motor) is True
    assert (await _acciones(app, "client", h)) == ["cancel", "reschedule"]


async def test_un_error_al_mirar_la_0094_es_503_y_no_se_recuerda(atencion, monkeypatch) -> None:
    app, motor, _ = atencion
    h = await _reservado(app, motor)
    esquema.olvidar()
    buena = esquema._LO_QUE_NECESITA_LA_ATENCION
    monkeypatch.setattr(esquema, "_LO_QUE_NECESITA_LA_ATENCION", text("select 1 / 0 = 1"))
    r = await _hacer(app, "client", h, "cancel", {})
    assert r.status_code == 503 and _codigo(r) == "services_not_ready", r.text
    assert "atencion" not in esquema._cache
    monkeypatch.setattr(esquema, "_LO_QUE_NECESITA_LA_ATENCION", buena)
    assert (await _hacer(app, "client", h, "cancel", {})).status_code == 200


# =========================================================================== #
# 9. La baja de una cuenta
# =========================================================================== #
async def test_la_baja_de_quien_contrato_se_lleva_sus_evidencias_y_deja_la_resena_sin_nombre(atencion) -> None:
    app, motor, almacen = atencion
    h = await _con_caso(app, motor)
    cliente, reserva, caso = h["cliente"], h["reserva"]["id"], h["caso"]
    ruta, _ = _de("client", h)
    async with _cliente(app, cliente) as http:
        r = await http.post(f"{ruta}/incident/evidence", files={"file": ("a.pdf", PDF, "application/pdf")},
                            headers={"Idempotency-Key": _clave()})
        assert r.status_code == 201, r.text
    assert (await _resolver(app, h["jefa"], caso, attention_effect="completed")).status_code == 200
    assert (await _hacer(app, "client", h, "review", RESENA)).status_code == 201
    assert len(almacen.de(posventa.DEPOSITO, cliente)) == 1
    # La reserva ya pasó (el caso se abrió con la atención empezada): la cuenta se puede borrar.
    await _llevar(motor, reserva, minutos=-3 * 60)
    r = await _borrar_cuenta(app, cliente)
    assert r.status_code in (200, 204), r.text
    # SUS ARCHIVOS se van del depósito; la reseña y el caso se quedan, sin su cuenta.
    assert almacen.de(posventa.DEPOSITO, cliente) == []
    assert await _filas(motor, "select author_id, rating, status from public.service_reviews "
                               "where booking_id = cast(:b as uuid)", b=reserva) == [(None, 5, "published")]
    assert await _uno(motor, "select count(*) from public.service_incidents where booking_id = cast(:b as uuid)",
                      b=reserva) == 1
    publicas = (await _pedir(app, "GET", f"{CATALOGO}/{h['servicio']}/reviews", None)).json()
    assert [x["author_id"] for x in publicas["items"]] == [None]
    # El prestador sigue viendo su reserva y el expediente; la evidencia ya no está, y no es un 500.
    suya, perfil = _de("provider", h)
    visto = await _pedir(app, "GET", f"{suya}/incident", perfil)
    assert visto.status_code == 200, visto.text
    evidencia = [e for e in visto.json()["entries"] if e["kind"] == "evidence"][0]
    r = await _pedir(app, "GET", f"{suya}/incident/entries/{evidencia['id']}/file", perfil)
    assert r.status_code == 502 and _codigo(r) == "service_evidence_unavailable", r.text


# =========================================================================== #
# 10. Carreras, con PostgreSQL de verdad
# =========================================================================== #
async def _coherente(motor, h: dict) -> tuple[str, str | None]:
    """`(estado de la reserva, estado de la atención)`, tras comprobar que no
    hay nada a medias: ni una cancelada ocupando horario, ni una confirmada
    sin su retención, ni dos retenciones consumidas para una reserva."""
    reserva = h["reserva"]["id"]
    estado, retencion = (await _filas(motor, "select b.status, h.status from public.service_bookings b "
                                             "join public.service_holds h on h.id = b.hold_id "
                                             "where b.id = cast(:b as uuid)", b=reserva))[0]
    assert (estado, retencion) in (("confirmed", "consumed"), ("cancelled", "released")), (estado, retencion)
    consumidas = await _uno(motor, "select count(*) from public.service_holds where service_id = cast(:s as uuid) "
                                   "and client_id = cast(:c as uuid) and status = 'consumed'",
                            s=h["servicio"], c=h["cliente"])
    assert consumidas == (1 if estado == "confirmed" else 0)
    atendiendo = await _uno(motor, "select status from public.service_attendances where booking_id = cast(:b as uuid)",
                            b=reserva)
    assert not (estado == "cancelled" and atendiendo not in (None, "code_issued")), (estado, atendiendo)
    return estado, atendiendo


def _sin_500(*respuestas) -> None:
    assert all(r.status_code < 500 for r in respuestas), [(r.status_code, r.text) for r in respuestas]


async def test_cancelar_y_reprogramar_a_la_vez_no_dejan_nada_a_medias(atencion) -> None:
    app, motor, _ = atencion
    for _ in range(3):
        h = await _reservado(app, motor)
        nueva, _inicio = await _otro_horario(app, h)
        cancelar, mover = await asyncio.gather(_hacer(app, "client", h, "cancel", {}),
                                               _hacer(app, "client", h, "reschedule", {"hold_id": nueva}))
        _sin_500(cancelar, mover)
        assert cancelar.status_code in (200, 409) and mover.status_code in (200, 409)
        assert 200 in (cancelar.status_code, mover.status_code), (cancelar.text, mover.text)
        estado, _ = await _coherente(motor, h)
        # Si se canceló, se canceló del todo; y un horario ocupado por nadie no queda.
        assert estado == ("cancelled" if cancelar.status_code == 200 else "confirmed")
        assert (await _sucesos(motor, h["reserva"]["id"])).count("booking_cancelled") == (
            1 if cancelar.status_code == 200 else 0)


async def test_reprogramar_dos_veces_a_la_vez_mueve_una(atencion) -> None:
    app, motor, _ = atencion
    h = await _reservado(app, motor)
    nueva, _inicio = await _otro_horario(app, h)
    clave = _clave()
    respuestas = await asyncio.gather(
        *(_hacer(app, "client", h, "reschedule", {"hold_id": nueva}, clave=clave) for _ in range(3)),
        *(_hacer(app, "client", h, "reschedule", {"hold_id": nueva}) for _ in range(3)))
    _sin_500(*respuestas)
    assert sum(1 for r in respuestas if r.status_code == 200) >= 1, [r.text for r in respuestas]
    assert {r.status_code for r in respuestas} <= {200, 409}
    assert (await _sucesos(motor, h["reserva"]["id"])).count("booking_rescheduled") == 1
    assert await _coherente(motor, h) == ("confirmed", None)
    assert await _uno(motor, "select hold_id::text from public.service_bookings where id = cast(:b as uuid)",
                      b=h["reserva"]["id"]) == nueva


async def test_reprogramar_mientras_el_prestador_bloquea_ese_dia(atencion) -> None:
    app, motor, _ = atencion
    for _ in range(2):
        h = await _reservado(app, motor)
        nueva, _inicio = await _otro_horario(app, h)
        mover, bloquear = await asyncio.gather(
            _hacer(app, "client", h, "reschedule", {"hold_id": nueva}),
            _pedir(app, "POST", f"{_agenda(h['servicio'])}/exceptions", h["perfil"], {"date": _dia(9), "kind": "closed"}))
        _sin_500(mover, bloquear)
        assert mover.status_code in (200, 409), mover.text
        # O se movió (y está en el nuevo) o no (y sigue en el suyo): nunca en ninguno ni en los dos.
        assert (await _coherente(motor, h))[0] == "confirmed"
        actual = await _uno(motor, "select hold_id::text from public.service_bookings where id = cast(:b as uuid)",
                            b=h["reserva"]["id"])
        assert actual == (nueva if mover.status_code == 200 else h["retencion"])


async def test_empezar_y_cancelar_a_la_vez_gana_una(atencion) -> None:
    app, motor, _ = atencion
    for quien in ("client", "provider", "client"):
        h = await _atendida(app, motor, hasta="code_issued")
        empezar, cancelar = await asyncio.gather(
            _hacer(app, "provider", h, "start", {"code": h["codigo"]}),
            _hacer(app, quien, h, "cancel", {"note": "A última hora."}))
        _sin_500(empezar, cancelar)
        assert sorted((empezar.status_code, cancelar.status_code)) == [200, 409], (empezar.text, cancelar.text)
        estado, atendiendo = await _coherente(motor, h)
        assert (estado, atendiendo) == (("confirmed", "in_progress") if empezar.status_code == 200
                                         else ("cancelled", "code_issued"))


async def test_terminar_confirmar_y_abrir_un_caso_a_la_vez(atencion) -> None:
    app, motor, _ = atencion
    for _ in range(3):
        h = await _atendida(app, motor, hasta="in_progress")
        await _llevar(motor, h["reserva"]["id"], minutos=-20)
        terminar, confirmar, caso = await asyncio.gather(
            _hacer(app, "provider", h, "complete"), _hacer(app, "client", h, "confirm"),
            _hacer(app, "client", h, "incident", {"reason": "quality", "description": DESCRIPCION}))
        _sin_500(terminar, confirmar, caso)
        _, atendiendo = await _coherente(motor, h)
        vivo = await _uno(motor, "select count(*) from public.service_incidents where booking_id = cast(:b as uuid) "
                                 "and status in ('open', 'appealed')", b=h["reserva"]["id"])
        # CON UN CASO VIVO, la confirmación de DESPUÉS no la cierra; si se cerró antes, el caso se abre sobre lo cerrado.
        if confirmar.status_code == 409:
            assert _codigo(confirmar) in ("service_attention_incident_open", "service_booking_busy",
                                          "service_booking_action_not_available")
        assert atendiendo in ("in_progress", "completed", "closed")
        if atendiendo == "closed":
            assert confirmar.status_code == 200
        assert vivo == (1 if caso.status_code == 201 else 0)
        # Y el barrido, con un caso vivo, no la cierra.
        if vivo and atendiendo == "completed":
            await _retrasar(motor, "service_attendances", "completed_at", "booking_id", h["reserva"]["id"], horas=30)
            await _pedir(app, "POST", TAREAS, h["jefa"])
            assert (await _coherente(motor, h))[1] == "completed"


async def test_dos_resoluciones_a_la_vez_dejan_una(atencion) -> None:
    app, motor, _ = atencion
    h = await _con_caso(app, motor)
    otra_jefa = await _persona(motor, "admin")
    clave = _clave()
    respuestas = await asyncio.gather(
        _resolver(app, h["jefa"], h["caso"], outcome="upheld", clave=clave),
        _resolver(app, h["jefa"], h["caso"], outcome="upheld", clave=clave),
        _resolver(app, otra_jefa, h["caso"], outcome="rejected"),
        _resolver(app, otra_jefa, h["caso"], outcome="partially_upheld"),
    )
    _sin_500(*respuestas)
    assert {r.status_code for r in respuestas} <= {200, 409}
    fila = await _filas(motor, "select status, resolutions, outcome from public.service_incidents "
                               "where id = cast(:c as uuid)", c=h["caso"])
    assert fila[0][:2] == ("resolved", 1), fila
    assert await _uno(motor, "select count(*) from public.service_incident_entries where incident_id = cast(:c as uuid) "
                             "and kind = 'resolution'", c=h["caso"]) == 1
    assert (await _sucesos(motor, h["reserva"]["id"])).count("incident_resolved") == 1
    ganadoras = {r.json()["outcome"] for r in respuestas if r.status_code == 200}
    assert ganadoras == {fila[0][2]}


async def test_dos_resenas_y_dos_respuestas_a_la_vez_dejan_una(atencion) -> None:
    app, motor, _ = atencion
    h = await _atendida(app, motor)
    clave = _clave()
    respuestas = await asyncio.gather(
        *(_hacer(app, "client", h, "review", RESENA, clave=clave) for _ in range(3)),
        *(_hacer(app, "client", h, "review", {**RESENA, "rating": n}) for n in (1, 2, 3)))
    _sin_500(*respuestas)
    assert sum(1 for r in respuestas if r.status_code == 201) >= 1, [r.text for r in respuestas]
    assert {r.status_code for r in respuestas} <= {201, 409}
    assert await _uno(motor, "select count(*) from public.service_reviews where booking_id = cast(:b as uuid)",
                      b=h["reserva"]["id"]) == 1
    assert (await _sucesos(motor, h["reserva"]["id"])).count("review_created") == 1

    respuestas = await asyncio.gather(
        *(_hacer(app, "provider", h, "review/reply", {"reply": f"Gracias, respuesta {n}."}) for n in range(4)))
    _sin_500(*respuestas)
    assert sorted(r.status_code for r in respuestas) == [200, 409, 409, 409], [r.text for r in respuestas]
    ganadora = [r for r in respuestas if r.status_code == 200][0].json()["care"]["review"]["reply"]
    assert await _uno(motor, "select reply from public.service_reviews where booking_id = cast(:b as uuid)",
                      b=h["reserva"]["id"]) == ganadora
    assert (await _sucesos(motor, h["reserva"]["id"])).count("review_replied") == 1


async def test_barridos_a_la_vez_y_confirmando_cierran_una_sola_vez(atencion) -> None:
    app, motor, _ = atencion
    hechas = []
    jefa = moderador = None
    for _ in range(3):
        extra = {"jefa": jefa, "moderador": moderador} if jefa else {}
        h = await _atendida(app, motor, hasta="completed", **extra)
        jefa, moderador = h["jefa"], h["moderador"]
        await _retrasar(motor, "service_attendances", "completed_at", "booking_id", h["reserva"]["id"], horas=30)
        hechas.append(h)
    respuestas = await asyncio.gather(*(_pedir(app, "POST", TAREAS, jefa) for _ in range(4)),
                                      _hacer(app, "client", hechas[0], "confirm"))
    _sin_500(*respuestas)
    for h in hechas:
        assert (await _coherente(motor, h))[1] == "closed"
        sucesos = await _sucesos(motor, h["reserva"]["id"])
        assert sucesos.count("attendance_closed") + sucesos.count("attendance_confirmed") == 1, sucesos
    assert sum(r.json()["closed"] for r in respuestas[:4]) in (2, 3)


async def test_la_misma_clave_a_la_vez_es_una_sola_accion(atencion) -> None:
    app, motor, _ = atencion
    h = await _reservado(app, motor)
    clave = _clave()
    respuestas = await asyncio.gather(*(_hacer(app, "client", h, "cancel", {}, clave=clave) for _ in range(5)))
    _sin_500(*respuestas)
    assert [r.status_code for r in respuestas] == [200] * 5, [r.text for r in respuestas]
    assert (await _sucesos(motor, h["reserva"]["id"])).count("booking_cancelled") == 1
    avisos = [a for a in await _avisos(motor, h["reserva"]["id"]) if a[1] == "service_booking_cancelled_provider"]
    assert len(avisos) == 1
    # La misma clave para OTRA acción de la misma persona: 409, y no hace nada.
    otra = await _reservado(app, motor, jefa=h["jefa"], moderador=h["moderador"])
    otra["cliente"] = h["cliente"]
    r = await _hacer(app, "client", h, "check-in-code", clave=clave)
    assert r.status_code == 409 and _codigo(r) == "idempotency_key_reused", r.text
