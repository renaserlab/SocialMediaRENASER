"""La reserva de Servicios por la API real, contra PostgreSQL (Incremento 5).

Con la base 0001–0093 desechable, el Storage en memoria y `FEATURE_SERVICES`
y `FEATURE_SERVICE_BOOKING` encendidas SOLO aquí. Los servicios se publican
por el flujo real del Incremento 2; las condiciones de contratación, por las
rutas de administración.

LO QUE SE COMPRUEBA: el recorrido gratuito entero (retener, resumen,
confirmar, mis reservas, la bandeja del prestador); que lo que tiene precio se
prepara y se detiene sin dinero; que «a consultar» y «desde» no se contratan;
a domicilio y su dirección privada; las condiciones versionadas; el
vencimiento que decide la hora; soltar, reemplazar, la idempotencia y el tope
de retenciones; quién puede qué; lo que deja de ser público; la agenda y la
versión que cambian; la capacidad de un grupo; las banderas y la puerta de la
0093; que nada mueve dinero; la baja de una cuenta; y LAS CARRERAS con
PostgreSQL de verdad.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timedelta

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.modules.services import esquema
from app.modules.services import reserva as reserva_dominio
from app.shared.database import get_db
from tests.test_baja_de_cuenta_postgres import API, SIN_POSTGRES, _borrar_cuenta, _cliente, _filas, _persona, _sembrar, _uno
from tests.test_servicios_agenda_api import _agenda, _codigo, _configurada, _dia, _pedir, _publica
from tests.test_servicios_catalogo_api import ADMIN, BANDEJA, MIOS, _accion, _equipo, _prestador
from tests.test_servicios_descubrimiento_api import (  # noqa: F401 - montajes compartidos
    CATALOGO,
    _categoria,
    _hasta,
    base_aplicada,
    entorno,
    mundo,
)

pytestmark = [SIN_POSTGRES, pytest.mark.asyncio]

RETENCIONES = f"{API}/services/holds"
MIS_RESERVAS = f"{API}/services/me/bookings"
DEL_PRESTADOR = f"{API}/services/provider/bookings"
ADMIN_SERVICIOS = f"{API}/admin/services"
#: Donde se mueve dinero en la plataforma: la reserva de Servicios no toca ninguna.
DE_DINERO = (
    "orders", "entitlements", "payment_transactions", "payment_events", "owner_sale_balances",
    "owner_transfers", "owner_sale_reserves", "refund_requests", "product_orders", "product_refunds",
    "event_orders", "bookings",
)
#: Lo que nunca sale fuera de la reserva de quien contrata o del prestador.
PRIVADO = ("Calle Las Flores", "Miraflores 123", "Traigo mis facturas")
GRATIS = {"price_model": "free", "price_minor": None, "currency": None}


@pytest.fixture()
def reservas(mundo, monkeypatch):
    """El mundo de siempre, con la CONTRATACIÓN encendida (solo aquí)."""
    monkeypatch.setattr(get_settings(), "feature_service_booking", True)
    esquema.olvidar()
    return mundo


def _clave() -> str:
    return f"clave-{uuid.uuid4().hex}"


async def _condiciones(app, jefa: str, *, pais: str = "PE", texto: str | None = None) -> dict:
    """Las condiciones de contratación, escritas y publicadas por la empresa."""
    cuerpo = texto or f"Condiciones de contratación de Z, versión de prueba {uuid.uuid4().hex}. Cancelación: pendiente."
    async with _cliente(app, jefa) as http:
        r = await http.post(f"{ADMIN_SERVICIOS}/policies/booking-terms/draft",
                            json={"country_code": pais, "title": "Condiciones de contratación", "body": cuerpo})
        assert r.status_code in (200, 201), r.text
        borrador = r.json()
        if borrador["body"] != cuerpo:
            r = await http.patch(f"{ADMIN_SERVICIOS}/policies/{borrador['id']}", json={"body": cuerpo})
            assert r.status_code == 200, r.text
        r = await http.post(f"{ADMIN_SERVICIOS}/policies/{borrador['id']}/publish")
        assert r.status_code == 200, r.text
    return r.json()


async def _servicio(app, motor, *, jefa=None, moderador=None, capacidad: int = 1, despues: int = 15,
                    semana: bool = True, **contenido) -> tuple[str, str, str, str]:
    """`(perfil, servicio, jefa, moderador)`: publicado (gratis salvo que se
    diga otra cosa), 60 min, agenda de 09:00 a 12:00 todos los días."""
    if jefa is None:
        jefa, moderador = await _equipo(motor)
    categoria = (await _categoria(app, jefa))["id"]
    perfil = await _prestador(motor)
    datos = {**GRATIS, "duration_minutes": 60, **contenido}
    if capacidad > 1:
        datos["capacity"] = capacidad
    servicio = await _hasta(app, perfil, jefa, moderador, categoria, "published", **datos)
    r = await _pedir(app, "PUT", _agenda(servicio), perfil, {"timezone": "America/Lima", "buffer_after_minutes": despues})
    assert r.status_code == 201, r.text
    if semana:
        modalidad = contenido.get("modality", "virtual")
        for dia in range(1, 8):
            r = await _pedir(app, "POST", f"{_agenda(servicio)}/rules", perfil,
                             {"weekday": dia, "start": "09:00", "end": "12:00", "modality": modalidad,
                              **({"capacity": capacidad} if capacidad > 1 else {})})
            assert r.status_code == 201, r.text
    return perfil, servicio, jefa, moderador


async def _horarios(app, servicio: str, fecha: str, uid: str | None = None) -> list[dict]:
    r = await _pedir(app, "GET", f"{_publica(servicio)}/{fecha}", uid)
    assert r.status_code == 200, r.text
    return r.json()["items"]


async def _retener(app, cliente: str, servicio: str, inicio: str, *, clave: str | None = None, modalidad=None):
    return await _pedir(app, "POST", f"{CATALOGO}/{servicio}/holds", cliente,
                        {"starts_at": inicio, **({"modality": modalidad} if modalidad else {})}, clave or _clave())


async def _resumen(app, cliente: str, retencion: str) -> dict:
    r = await _pedir(app, "GET", f"{RETENCIONES}/{retencion}/checkout", cliente)
    assert r.status_code == 200, r.text
    return r.json()


def _aceptando(resumen: dict, **extra) -> dict:
    """Lo que la app manda al confirmar: las condiciones que enseñó, por su
    versión y su huella, y lo que se escribió."""
    cuerpo = {"terms_policy_id": resumen["terms"]["policy_id"], "terms_sha256": resumen["terms"]["sha256"]}
    if resumen.get("service_conditions"):
        cuerpo["service_conditions_sha256"] = resumen["service_conditions"]["sha256"]
    return {**cuerpo, **extra}


async def _confirmar(app, cliente: str, retencion: str, cuerpo: dict | None = None, *, clave: str | None = None):
    cuerpo = cuerpo if cuerpo is not None else _aceptando(await _resumen(app, cliente, retencion))
    return await _pedir(app, "POST", f"{RETENCIONES}/{retencion}/confirm", cliente, cuerpo, clave or _clave())


async def _reservado(app, motor, **extra) -> dict:
    """Un servicio gratuito, sus condiciones y una persona con su reserva de
    dentro de una semana a las 09:00."""
    perfil, servicio, jefa, moderador = await _servicio(app, motor, **extra)
    await _condiciones(app, jefa)
    cliente = await _persona(motor)
    fecha = _dia(7)
    inicio = (await _horarios(app, servicio, fecha))[0]["starts_at"]
    r = await _retener(app, cliente, servicio, inicio)
    assert r.status_code == 201, r.text
    retencion = r.json()["id"]
    r = await _confirmar(app, cliente, retencion)
    assert r.status_code == 201, r.text
    return {"perfil": perfil, "servicio": servicio, "jefa": jefa, "moderador": moderador, "cliente": cliente,
            "fecha": fecha, "inicio": inicio, "retencion": retencion, "reserva": r.json()}


async def _dinero(motor) -> dict:
    return {t: await _uno(motor, f"select count(*) from public.{t}") for t in DE_DINERO}


async def _vencer_ya(motor, retencion: str, *, dentro: str = "-1 second") -> None:
    """Adelanta el reloj de UNA retención (sin sus disparadores, solo en la
    prueba): como si hubieran pasado sus minutos."""
    async with motor.begin() as conexion:
        await conexion.execute(text("set local session_replication_role = replica"))
        await conexion.execute(
            text("update public.service_holds set created_at = now() - interval '20 minutes', "
                 f"expires_at = now() + interval '{dentro}' where id = cast(:h as uuid)"),
            {"h": retencion},
        )


# =========================================================================== #
# 1. El recorrido gratuito
# =========================================================================== #
async def test_contratar_un_servicio_gratuito_de_punta_a_punta(reservas) -> None:
    app, motor, _ = reservas
    antes = await _dinero(motor)
    perfil, servicio, jefa, _ = await _servicio(app, motor)
    condiciones = await _condiciones(app, jefa)
    cliente = await _persona(motor)
    fecha = _dia(7)
    horarios = await _horarios(app, servicio, fecha)
    assert [h["time"] for h in horarios] == ["09:00", "10:15"]
    calendario = (await _pedir(app, "GET", _publica(servicio), None)).json()
    assert calendario["booking_available"] is True

    # RETENER: 201, y la misma clave con lo mismo, la misma retención SIN alargarla.
    clave = _clave()
    r = await _retener(app, cliente, servicio, horarios[0]["starts_at"], clave=clave)
    assert r.status_code == 201, r.text
    retencion = r.json()
    assert retencion["status"] == "active" and retencion["time"] == "09:00" and retencion["utc_offset"] == "-05:00"
    assert 0 < retencion["seconds_left"] <= 600
    otra_vez = await _retener(app, cliente, servicio, horarios[0]["starts_at"], clave=clave)
    assert otra_vez.status_code == 200 and otra_vez.json()["id"] == retencion["id"]
    assert otra_vez.json()["expires_at"] == retencion["expires_at"]
    # Apartado para esta persona: nadie más lo ve.
    assert [h["time"] for h in await _horarios(app, servicio, fecha)] == ["10:15"]

    # EL RESUMEN: gratis, confirmable, con las condiciones de hoy.
    resumen = await _resumen(app, cliente, retencion["id"])
    assert resumen["contract"] == {
        "kind": "free", "confirmable": True, "payments_available": False, "provider_confirmation_required": False,
        "version_changed": False, "terms_available": True, "blockers": [],
    }
    assert resumen["service"]["price"] == {"model": "free", "amount_minor": None, "currency": None}
    assert resumen["terms"]["policy_id"] == condiciones["id"] and resumen["terms"]["sha256"] == condiciones["body_sha256"]
    assert resumen["requires_address"] is False

    # CONFIRMAR: 201, con la fotografía, el pedido gratuito y lo aceptado.
    clave = _clave()
    r = await _confirmar(app, cliente, retencion["id"], _aceptando(resumen, note="Traigo mis facturas"), clave=clave)
    assert r.status_code == 201, r.text
    reserva = r.json()
    assert _codigo_valido(reserva["code"]) and reserva["status"] == "confirmed"
    assert (reserva["time"], reserva["end_time"], reserva["duration_minutes"]) == ("09:00", "10:00", 60)
    assert reserva["price"] == {"model": "free", "amount_minor": None, "currency": None, "total_minor": 0,
                                "payment_status": "not_required"}
    assert [(a["kind"], a["version"], a["sha256"]) for a in reserva["acceptances"]] == [
        ("booking_terms", condiciones["version"], condiciones["body_sha256"])
    ]
    assert [e["action"] for e in reserva["history"]] == ["hold_created", "booking_confirmed"]
    assert reserva["intake"]["note"] == "Traigo mis facturas"
    # Repetir con la misma clave: la misma reserva. Con otra: ya está reservado.
    r = await _confirmar(app, cliente, retencion["id"], _aceptando(resumen, note="Traigo mis facturas"), clave=clave)
    assert r.status_code == 200 and r.json()["id"] == reserva["id"]
    r = await _confirmar(app, cliente, retencion["id"], _aceptando(resumen), clave=_clave())
    assert r.status_code == 409 and _codigo(r) == "service_hold_already_consumed"
    assert r.json()["error"]["details"]["booking_id"] == reserva["id"]
    ver = (await _pedir(app, "GET", f"{RETENCIONES}/{retencion['id']}", cliente)).json()
    assert ver["status"] == "consumed" and ver["booking_id"] == reserva["id"]

    # En la base: UN pedido, UNA reserva, lo aceptado, y ni un movimiento de dinero.
    assert await _uno(motor, "select count(*) from public.service_orders where service_id = cast(:s as uuid)",
                      s=servicio) == 1
    assert await _uno(motor, "select count(*) from public.service_bookings where service_id = cast(:s as uuid)",
                      s=servicio) == 1
    assert await _dinero(motor) == antes
    # Los avisos: a quien contrata y al prestador, sin nada privado.
    avisos = await _filas(motor, "select user_id::text, type, entity_type, entity_id::text, payload::text from "
                                 "public.notifications where entity_id = cast(:b as uuid)", b=reserva["id"])
    assert sorted((a[0], a[1]) for a in avisos) == sorted([(cliente, "service_booking_confirmed"),
                                                            (perfil, "service_booking_received")])
    assert all(a[2] == "service_booking" and a[4] in ("{}", "null") for a in avisos)

    # MIS RESERVAS y su detalle; la BANDEJA del prestador, con la identidad pública.
    mias = (await _pedir(app, "GET", MIS_RESERVAS, cliente)).json()
    assert [b["id"] for b in mias["items"]] == [reserva["id"]] and mias["next_cursor"] is None
    detalle = (await _pedir(app, "GET", f"{MIS_RESERVAS}/{reserva['id']}", cliente)).json()
    assert detalle["code"] == reserva["code"] and detalle["intake"]["note"] == "Traigo mis facturas"
    bandeja = (await _pedir(app, "GET", DEL_PRESTADOR, perfil)).json()
    assert [b["id"] for b in bandeja["items"]] == [reserva["id"]]
    del_prestador = (await _pedir(app, "GET", f"{DEL_PRESTADOR}/{reserva['id']}", perfil)).json()
    assert del_prestador["client"]["username"] and "email" not in json.dumps(del_prestador["client"])
    assert del_prestador["intake"]["note"] == "Traigo mis facturas"
    # Lo público nunca lo dice.
    crudo = json.dumps([calendario, await _horarios(app, servicio, fecha)], ensure_ascii=False)
    assert not [p for p in PRIVADO if p in crudo]


def _codigo_valido(codigo: str) -> bool:
    from app.modules.services import reserva_politica as limites

    return len(codigo) == 9 and codigo[4] == "-" and all(c in limites.ALFABETO_DEL_CODIGO for c in codigo.replace("-", ""))


# =========================================================================== #
# 2. Lo que tiene precio, «a consultar» y «desde»
# =========================================================================== #
async def test_un_servicio_con_precio_se_prepara_y_se_detiene_sin_dinero(reservas) -> None:
    app, motor, _ = reservas
    antes = await _dinero(motor)
    perfil, servicio, jefa, _ = await _servicio(app, motor, price_model="fixed", price_minor=15000, currency="PEN")
    await _condiciones(app, jefa)
    # Se ofrece continuar: la contratación se PREPARA y se detiene al final.
    assert (await _pedir(app, "GET", _publica(servicio), None)).json()["booking_available"] is True
    cliente = await _persona(motor)
    inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
    r = await _retener(app, cliente, servicio, inicio)
    assert r.status_code == 201, r.text
    retencion = r.json()["id"]
    resumen = await _resumen(app, cliente, retencion)
    assert resumen["contract"]["kind"] == "paid" and resumen["contract"]["confirmable"] is False
    assert resumen["contract"]["blockers"] == ["payments_not_configured"]
    assert resumen["service"]["price"] == {"model": "fixed", "amount_minor": 15000, "currency": "PEN"}
    r = await _confirmar(app, cliente, retencion, _aceptando(resumen))
    assert r.status_code == 503 and _codigo(r) == "service_booking_payments_not_configured"
    # Ni pedido, ni reserva, ni un «pagado»: la retención sigue, y se suelta.
    assert await _uno(motor, "select count(*) from public.service_orders where service_id = cast(:s as uuid)",
                      s=servicio) == 0
    assert (await _pedir(app, "GET", f"{RETENCIONES}/{retencion}", cliente)).json()["status"] == "active"
    r = await _pedir(app, "POST", f"{RETENCIONES}/{retencion}/release", cliente, None, _clave())
    assert r.status_code == 200 and r.json()["status"] == "released"
    assert await _dinero(motor) == antes


async def test_a_consultar_y_desde_no_apartan_un_horario(reservas) -> None:
    app, motor, _ = reservas
    jefa, moderador = await _equipo(motor)
    cliente = await _persona(motor)
    for contenido, codigo in (
        ({"price_model": "on_request", "price_minor": None, "currency": None}, "service_booking_quote_required"),
        ({"price_model": "from", "price_minor": 9000, "currency": "PEN"}, "service_booking_price_not_closed"),
    ):
        _, servicio, _, _ = await _servicio(app, motor, jefa=jefa, moderador=moderador, **contenido)
        assert (await _pedir(app, "GET", _publica(servicio), None)).json()["booking_available"] is False
        inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
        r = await _retener(app, cliente, servicio, inicio)
        assert r.status_code == 409 and _codigo(r) == codigo, r.text
        assert await _uno(motor, "select count(*) from public.service_holds where service_id = cast(:s as uuid)",
                          s=servicio) == 0


# =========================================================================== #
# 3. A domicilio
# =========================================================================== #
async def test_a_domicilio_lo_acepta_el_prestador_y_hoy_no_se_confirma(reservas, monkeypatch) -> None:
    app, motor, _ = reservas
    # «A domicilio» sigue en el modelo, pero no se ofrece en la primera versión
    # (P5): se enciende aquí para probar lo que el modelo conserva.
    monkeypatch.setattr(get_settings(), "services_catalog_modalities", "virtual,in_person,at_home")
    _, servicio, jefa, _ = await _servicio(app, motor, modality="at_home", location_area="Miraflores, Lima")
    await _condiciones(app, jefa)
    assert (await _pedir(app, "GET", _publica(servicio), None)).json()["booking_available"] is False
    inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
    r = await _retener(app, await _persona(motor), servicio, inicio)
    assert r.status_code == 409 and _codigo(r) == "service_booking_provider_confirmation_required"


async def test_a_domicilio_si_se_configura_pide_la_direccion_y_solo_la_ve_el_prestador(reservas, monkeypatch) -> None:
    app, motor, _ = reservas
    # «A domicilio» sigue en el modelo, pero no se ofrece en la primera versión
    # (P5): se enciende aquí para probar lo que el modelo conserva.
    monkeypatch.setattr(get_settings(), "services_catalog_modalities", "virtual,in_person,at_home")
    monkeypatch.setattr(get_settings(), "services_booking_instant_modalities", "virtual,in_person,at_home")
    perfil, servicio, jefa, _ = await _servicio(app, motor, modality="at_home", location_area="Miraflores, Lima")
    await _condiciones(app, jefa)
    cliente = await _persona(motor)
    inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
    retencion = (await _retener(app, cliente, servicio, inicio)).json()["id"]
    resumen = await _resumen(app, cliente, retencion)
    assert resumen["requires_address"] is True and resumen["service"]["location_area"] is None
    r = await _confirmar(app, cliente, retencion, _aceptando(resumen))
    assert r.status_code == 422 and _codigo(r) == "service_booking_data_invalid"
    assert r.json()["error"]["details"]["field"] == "district"
    r = await _confirmar(app, cliente, retencion, _aceptando(
        resumen, district="Miraflores", address_line="Calle Las Flores 123", address_reference="Puerta azul"))
    assert r.status_code == 201, r.text
    reserva = r.json()
    assert reserva["intake"]["address_line"] == "Calle Las Flores 123"
    detalle = (await _pedir(app, "GET", f"{DEL_PRESTADOR}/{reserva['id']}", perfil)).json()
    assert detalle["intake"]["district"] == "Miraflores"
    # Ni administración, ni el historial, ni los avisos, ni lo público.
    jefa_ve = (await _pedir(app, "GET", f"{ADMIN_SERVICIOS}/bookings", jefa)).json()
    historial = await _filas(motor, "select details::text from public.service_booking_events "
                                    "where service_id = cast(:s as uuid)", s=servicio)
    avisos = await _filas(motor, "select payload::text from public.notifications where entity_id = cast(:b as uuid)",
                          b=reserva["id"])
    crudo = json.dumps([jefa_ve, historial, avisos, await _horarios(app, servicio, _dia(7))], ensure_ascii=False)
    assert "Calle Las Flores" not in crudo and "Puerta azul" not in crudo


async def test_en_otra_modalidad_no_se_pide_ni_se_guarda_una_direccion(reservas) -> None:
    app, motor, _ = reservas
    _, servicio, jefa, _ = await _servicio(app, motor)
    await _condiciones(app, jefa)
    cliente = await _persona(motor)
    inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
    retencion = (await _retener(app, cliente, servicio, inicio)).json()["id"]
    r = await _confirmar(app, cliente, retencion, _aceptando(await _resumen(app, cliente, retencion),
                                                             district="Miraflores", address_line="Calle 1"))
    assert r.status_code == 422 and _codigo(r) == "service_booking_data_invalid"


# =========================================================================== #
# 4. Las condiciones
# =========================================================================== #
async def test_sin_condiciones_publicadas_no_se_confirma(reservas) -> None:
    app, motor, _ = reservas
    # Un país sin condiciones: el prestador de otro país.
    jefa, moderador = await _equipo(motor)
    categoria = (await _categoria(app, jefa))["id"]
    perfil = await _prestador(motor, pais="CL")
    servicio = await _hasta(app, perfil, jefa, moderador, categoria, "published", **GRATIS, duration_minutes=60)
    await _configurada(app, perfil, servicio)
    cliente = await _persona(motor)
    inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
    retencion = (await _retener(app, cliente, servicio, inicio)).json()["id"]
    resumen = await _resumen(app, cliente, retencion)
    assert resumen["terms"] is None and "terms_unavailable" in resumen["contract"]["blockers"]
    r = await _confirmar(app, cliente, retencion, {"terms_policy_id": str(uuid.uuid4()), "terms_sha256": "a" * 64})
    assert r.status_code == 409 and _codigo(r) == "service_booking_terms_unavailable"


async def test_las_condiciones_que_cambian_se_vuelven_a_aceptar(reservas) -> None:
    app, motor, _ = reservas
    _, servicio, jefa, _ = await _servicio(app, motor)
    await _condiciones(app, jefa)
    cliente = await _persona(motor)
    inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
    retencion = (await _retener(app, cliente, servicio, inicio)).json()["id"]
    leido = await _resumen(app, cliente, retencion)
    nuevas = await _condiciones(app, jefa)  # la empresa publica otra versión mientras se lee
    r = await _confirmar(app, cliente, retencion, _aceptando(leido))
    assert r.status_code == 409 and _codigo(r) == "service_booking_terms_changed"
    assert r.json()["error"]["details"]["policy_id"] == nuevas["id"]
    r = await _confirmar(app, cliente, retencion)
    assert r.status_code == 201, r.text
    assert r.json()["acceptances"][0]["version"] == nuevas["version"]
    # Y una reserva ANTERIOR sigue diciendo lo que aceptó entonces, no lo de hoy.
    anterior = (await _pedir(app, "GET", f"{MIS_RESERVAS}/{r.json()['id']}", cliente)).json()
    await _condiciones(app, jefa)
    ahora = (await _pedir(app, "GET", f"{MIS_RESERVAS}/{r.json()['id']}", cliente)).json()
    assert ahora["acceptances"] == anterior["acceptances"]


async def test_las_condiciones_del_servicio_tambien_se_aceptan_por_su_huella(reservas) -> None:
    app, motor, _ = reservas
    _, servicio, jefa, _ = await _servicio(app, motor, conditions="Llegar cinco minutos antes. Sin reembolsos aún.")
    await _condiciones(app, jefa)
    cliente = await _persona(motor)
    inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
    retencion = (await _retener(app, cliente, servicio, inicio)).json()["id"]
    resumen = await _resumen(app, cliente, retencion)
    assert resumen["service_conditions"]["text"].startswith("Llegar cinco minutos")
    sin = {k: v for k, v in _aceptando(resumen).items() if k != "service_conditions_sha256"}
    r = await _confirmar(app, cliente, retencion, sin)
    assert r.status_code == 409 and _codigo(r) == "service_booking_terms_changed"
    r = await _confirmar(app, cliente, retencion, _aceptando(resumen))
    assert r.status_code == 201, r.text
    assert sorted(a["kind"] for a in r.json()["acceptances"]) == ["booking_terms", "service_conditions"]


# =========================================================================== #
# 5. El vencimiento, soltar, reemplazar, la idempotencia y el tope
# =========================================================================== #
async def test_una_retencion_vencida_no_se_confirma_aunque_nadie_la_haya_barrido(reservas) -> None:
    app, motor, _ = reservas
    _, servicio, jefa, _ = await _servicio(app, motor)
    await _condiciones(app, jefa)
    cliente, otra = await _persona(motor), await _persona(motor)
    fecha = _dia(7)
    inicio = (await _horarios(app, servicio, fecha))[0]["starts_at"]
    retencion = (await _retener(app, cliente, servicio, inicio)).json()["id"]
    resumen = await _resumen(app, cliente, retencion)
    await _vencer_ya(motor, retencion)
    # En la base sigue `active`, pero vale la hora: vencida.
    assert await _uno(motor, "select status from public.service_holds where id = cast(:h as uuid)", h=retencion) == "active"
    ver = (await _pedir(app, "GET", f"{RETENCIONES}/{retencion}", cliente)).json()
    assert ver["status"] == "expired" and ver["seconds_left"] == 0
    r = await _confirmar(app, cliente, retencion, _aceptando(resumen))
    assert r.status_code == 409 and _codigo(r) == "service_hold_expired"
    # El horario vuelve a lo público y otra persona lo toma (la vencida se marca ahí).
    assert inicio in [h["starts_at"] for h in await _horarios(app, servicio, fecha)]
    r = await _retener(app, otra, servicio, inicio)
    assert r.status_code == 201, r.text
    assert await _uno(motor, "select status from public.service_holds where id = cast(:h as uuid)", h=retencion) == "expired"
    eventos = await _filas(motor, "select action, actor_role from public.service_booking_events "
                                  "where hold_id = cast(:h as uuid) order by created_at", h=retencion)
    assert eventos == [("hold_created", "client"), ("hold_expired", "system")]


async def test_no_se_confirma_una_sesion_que_ya_empezo(reservas, monkeypatch) -> None:
    """Hallazgo de la revisión del 30/09. La ventana del horario se mide desde
    que se RETUVO; con una antelación menor que los minutos de la retención
    (aquí, cero), una sesión apartada 5 minutos antes de empezar se podía
    confirmar ya empezada, con sus avisos."""
    app, motor, _ = reservas
    monkeypatch.setattr(get_settings(), "services_agenda_notice_minutes", 0)
    _, servicio, jefa, _ = await _servicio(app, motor)
    await _condiciones(app, jefa)
    cliente = await _persona(motor)
    inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
    retencion = (await _retener(app, cliente, servicio, inicio)).json()["id"]
    cuerpo = _aceptando(await _resumen(app, cliente, retencion))
    # Retenida 5 minutos antes de empezar, y apartada hasta 5 minutos después.
    async with motor.begin() as conexion:
        await conexion.execute(text("set local session_replication_role = replica"))
        await conexion.execute(
            text("update public.service_holds set created_at = starts_at - interval '5 minutes', "
                 "expires_at = starts_at + interval '5 minutes' where id = cast(:h as uuid)"),
            {"h": retencion},
        )
    empieza = datetime.fromisoformat(inicio.replace("Z", "+00:00"))
    monkeypatch.setattr(reserva_dominio, "_ahora", lambda: empieza + timedelta(minutes=1))
    r = await _confirmar(app, cliente, retencion, cuerpo)
    assert r.status_code == 409 and _codigo(r) == "service_slot_not_available", r.text
    assert await _uno(motor, "select count(*) from public.service_bookings where hold_id = cast(:h as uuid)",
                      h=retencion) == 0
    # Justo al empezar, tampoco; un minuto antes, sí.
    monkeypatch.setattr(reserva_dominio, "_ahora", lambda: empieza)
    r = await _confirmar(app, cliente, retencion, cuerpo)
    assert r.status_code == 409 and _codigo(r) == "service_slot_not_available", r.text
    monkeypatch.setattr(reserva_dominio, "_ahora", lambda: empieza - timedelta(minutes=1))
    r = await _confirmar(app, cliente, retencion, cuerpo)
    assert r.status_code == 201, r.text


async def test_el_barrido_vence_por_lotes_y_repetirlo_no_hace_nada(reservas) -> None:
    app, motor, _ = reservas
    _, servicio, jefa, _ = await _servicio(app, motor)
    retenciones = []
    for dias in (7, 8, 9):
        cliente = await _persona(motor)
        inicio = (await _horarios(app, servicio, _dia(dias)))[0]["starts_at"]
        retenciones.append((await _retener(app, cliente, servicio, inicio)).json()["id"])
    for r in retenciones:
        await _vencer_ya(motor, r)
    r = await _pedir(app, "POST", f"{ADMIN_SERVICIOS}/holds/expire", jefa, batch=2)
    assert r.status_code == 200 and r.json() == {"expired": 2}
    r = await _pedir(app, "POST", f"{ADMIN_SERVICIOS}/holds/expire", jefa)
    assert r.json()["expired"] >= 1
    r = await _pedir(app, "POST", f"{ADMIN_SERVICIOS}/holds/expire", jefa)
    assert r.json() == {"expired": 0}
    # Solo administración.
    r = await _pedir(app, "POST", f"{ADMIN_SERVICIOS}/holds/expire", await _persona(motor))
    assert r.status_code == 403


async def test_soltar_devuelve_el_horario_y_repetirlo_es_lo_mismo(reservas) -> None:
    app, motor, _ = reservas
    _, servicio, _, _ = await _servicio(app, motor)
    cliente = await _persona(motor)
    fecha = _dia(7)
    inicio = (await _horarios(app, servicio, fecha))[0]["starts_at"]
    retencion = (await _retener(app, cliente, servicio, inicio)).json()["id"]
    assert inicio not in [h["starts_at"] for h in await _horarios(app, servicio, fecha)]
    clave = _clave()
    r = await _pedir(app, "POST", f"{RETENCIONES}/{retencion}/release", cliente, None, clave)
    assert r.status_code == 200 and r.json()["status"] == "released"
    assert inicio in [h["starts_at"] for h in await _horarios(app, servicio, fecha)]
    for otra in (clave, _clave()):
        r = await _pedir(app, "POST", f"{RETENCIONES}/{retencion}/release", cliente, None, otra)
        assert r.status_code == 200 and r.json()["status"] == "released"
    # Sin clave, 422; la misma clave para otra cosa, 409.
    r = await _pedir(app, "POST", f"{RETENCIONES}/{retencion}/release", cliente)
    assert r.status_code == 422 and _codigo(r) == "idempotency_key_required"
    nueva = (await _retener(app, cliente, servicio, inicio)).json()["id"]
    r = await _pedir(app, "POST", f"{RETENCIONES}/{nueva}/release", cliente, None, clave)
    assert r.status_code == 409 and _codigo(r) == "idempotency_key_reused"


async def test_la_misma_clave_con_otro_horario_es_409_y_sin_clave_422(reservas) -> None:
    app, motor, _ = reservas
    _, servicio, _, _ = await _servicio(app, motor)
    cliente = await _persona(motor)
    horarios = await _horarios(app, servicio, _dia(7))
    clave = _clave()
    assert (await _retener(app, cliente, servicio, horarios[0]["starts_at"], clave=clave)).status_code == 201
    r = await _retener(app, cliente, servicio, horarios[1]["starts_at"], clave=clave)
    assert r.status_code == 409 and _codigo(r) == "idempotency_key_reused"
    r = await _pedir(app, "POST", f"{CATALOGO}/{servicio}/holds", cliente, {"starts_at": horarios[1]["starts_at"]})
    assert r.status_code == 422 and _codigo(r) == "idempotency_key_required"


async def test_otro_horario_del_mismo_servicio_reemplaza_y_el_mismo_no_se_renueva(reservas) -> None:
    app, motor, _ = reservas
    _, servicio, _, _ = await _servicio(app, motor)
    cliente = await _persona(motor)
    fecha = _dia(7)
    nueve, diez = [h["starts_at"] for h in await _horarios(app, servicio, fecha)]
    primera = (await _retener(app, cliente, servicio, nueve)).json()["id"]
    r = await _retener(app, cliente, servicio, nueve)
    assert r.status_code == 409 and _codigo(r) == "service_hold_already_active"
    assert r.json()["error"]["details"]["hold_id"] == primera
    segunda = await _retener(app, cliente, servicio, diez)
    assert segunda.status_code == 201, segunda.text
    assert (await _pedir(app, "GET", f"{RETENCIONES}/{primera}", cliente)).json()["status"] == "released"
    assert [h["starts_at"] for h in await _horarios(app, servicio, fecha)] == [nueve]


async def test_una_persona_no_acumula_retenciones(reservas) -> None:
    app, motor, _ = reservas
    jefa, moderador = await _equipo(motor)
    cliente = await _persona(motor)
    tope = get_settings().services_booking_max_active_holds
    servicios = [
        (await _servicio(app, motor, jefa=jefa, moderador=moderador))[1] for _ in range(tope + 1)
    ]
    for i, servicio in enumerate(servicios):
        inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
        r = await _retener(app, cliente, servicio, inicio)
        if i < tope:
            assert r.status_code == 201, r.text
        else:
            assert r.status_code == 409 and _codigo(r) == "service_hold_limit_reached"
            assert r.json()["error"]["details"]["max"] == tope


# =========================================================================== #
# 6. Quién puede qué, y lo que deja de ser público
# =========================================================================== #
async def test_lo_ajeno_es_404_y_sin_sesion_401(reservas) -> None:
    app, motor, _ = reservas
    hecho = await _reservado(app, motor)
    otra = await _persona(motor)
    otro_prestador = await _prestador(motor)
    for metodo, ruta, uid in (
        ("GET", f"{RETENCIONES}/{hecho['retencion']}", otra),
        ("GET", f"{RETENCIONES}/{hecho['retencion']}/checkout", otra),
        ("POST", f"{RETENCIONES}/{hecho['retencion']}/release", otra),
        ("POST", f"{RETENCIONES}/{hecho['retencion']}/confirm", otra),
        ("GET", f"{MIS_RESERVAS}/{hecho['reserva']['id']}", otra),
        ("GET", f"{MIS_RESERVAS}/{hecho['reserva']['id']}", hecho["perfil"]),
        ("GET", f"{DEL_PRESTADOR}/{hecho['reserva']['id']}", otro_prestador),
        ("GET", f"{DEL_PRESTADOR}/{hecho['reserva']['id']}", hecho["cliente"]),
        ("GET", f"{RETENCIONES}/no-es-un-id", otra),
    ):
        cuerpo = {"terms_policy_id": "x", "terms_sha256": "a" * 64} if ruta.endswith("confirm") else None
        r = await _pedir(app, metodo, ruta, uid, cuerpo, _clave() if metodo == "POST" else None)
        assert r.status_code == 404 and _codigo(r) in ("service_hold_not_found", "service_booking_not_found"), (
            metodo, ruta, r.text)
    assert (await _pedir(app, "GET", MIS_RESERVAS, otra)).json()["items"] == []
    assert (await _pedir(app, "GET", DEL_PRESTADOR, otro_prestador)).json()["items"] == []
    assert (await _pedir(app, "GET", DEL_PRESTADOR, otra)).json()["items"] == []
    for metodo, ruta in (("GET", MIS_RESERVAS), ("GET", DEL_PRESTADOR), ("GET", f"{RETENCIONES}/{hecho['retencion']}")):
        assert (await _pedir(app, metodo, ruta, None)).status_code == 401
    # Administración: solo `admin`, y sin nada privado.
    assert (await _pedir(app, "GET", f"{ADMIN_SERVICIOS}/bookings", otra)).status_code == 403
    assert (await _pedir(app, "GET", f"{ADMIN_SERVICIOS}/holds", hecho["moderador"])).status_code == 403
    jefa_ve = (await _pedir(app, "GET", f"{ADMIN_SERVICIOS}/bookings", hecho["jefa"])).json()
    assert hecho["reserva"]["id"] in [b["id"] for b in jefa_ve["items"]]
    assert "intake" not in json.dumps(jefa_ve) and "note" not in json.dumps(jefa_ve)


async def test_el_propio_servicio_no_se_contrata(reservas) -> None:
    app, motor, _ = reservas
    perfil, servicio, _, _ = await _servicio(app, motor)
    inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
    r = await _retener(app, perfil, servicio, inicio)
    assert r.status_code == 409 and _codigo(r) == "service_booking_own_service"


async def test_lo_que_deja_de_ser_publico_no_se_retiene_ni_se_confirma(reservas) -> None:
    app, motor, _ = reservas
    jefa, moderador = await _equipo(motor)
    for como in ("suspender", "retirar", "categoria", "prestador", "bloqueo"):
        perfil, servicio, _, _ = await _servicio(app, motor, jefa=jefa, moderador=moderador)
        await _condiciones(app, jefa)
        cliente = await _persona(motor)
        inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
        retencion = (await _retener(app, cliente, servicio, inicio)).json()["id"]
        resumen = await _resumen(app, cliente, retencion)
        if como == "suspender":
            assert (await _accion(app, jefa, f"{BANDEJA}/{servicio}/suspend", {"note": "Revisión."})).status_code == 200
        elif como == "retirar":
            assert (await _accion(app, jefa, f"{BANDEJA}/{servicio}/retire", {"note": "Fin."})).status_code == 200
        elif como == "categoria":
            await _sembrar(motor, "update public.service_categories set status = 'inactive' where id = "
                                  "(select category_id from public.services where id = cast(:s as uuid))", s=servicio)
        elif como == "prestador":
            await _sembrar(motor, "update public.service_providers set status = 'suspended', suspended_at = now() "
                                  "where profile_id = cast(:u as uuid)", u=perfil)
        else:
            await _sembrar(motor, "insert into public.user_blocks (blocker_id, blocked_id) values "
                                  "(cast(:a as uuid), cast(:b as uuid))", a=perfil, b=cliente)
        r = await _confirmar(app, cliente, retencion, _aceptando(resumen))
        assert r.status_code == 409 and _codigo(r) == "service_booking_service_unavailable", (como, r.text)
        r = await _retener(app, await _persona(motor) if como != "bloqueo" else cliente, servicio, inicio)
        assert r.status_code == 404 and _codigo(r) == "service_not_found", (como, r.text)


# =========================================================================== #
# 7. La agenda y la versión que cambian; la capacidad de un grupo
# =========================================================================== #
async def test_si_la_agenda_cambia_el_horario_retenido_se_vuelve_a_comprobar(reservas) -> None:
    app, motor, _ = reservas
    perfil, servicio, jefa, _ = await _servicio(app, motor)
    await _condiciones(app, jefa)
    fecha = _dia(7)
    casos = (
        ("bloqueo", {"start_date": fecha, "start_time": "09:30", "end_date": fecha, "end_time": "09:45"}),
        ("pausa", None),
        ("cerrado", {"date": fecha, "kind": "closed"}),
    )
    for como, cuerpo in casos:
        cliente = await _persona(motor)
        horarios = await _horarios(app, servicio, fecha)
        retencion = (await _retener(app, cliente, servicio, horarios[0]["starts_at"])).json()["id"]
        resumen = await _resumen(app, cliente, retencion)
        if como == "bloqueo":
            r = await _pedir(app, "POST", f"{_agenda(servicio)}/blocks", perfil, cuerpo)
        elif como == "pausa":
            r = await _pedir(app, "PUT", _agenda(servicio), perfil,
                             {"timezone": "America/Lima", "buffer_after_minutes": 15, "status": "paused"})
        else:
            r = await _pedir(app, "POST", f"{_agenda(servicio)}/exceptions", perfil, cuerpo)
        assert r.status_code in (200, 201), r.text
        r = await _confirmar(app, cliente, retencion, _aceptando(resumen))
        assert r.status_code == 409 and _codigo(r) == "service_slot_not_available", (como, r.text)
        # Se deshace para la siguiente.
        agenda = (await _pedir(app, "GET", _agenda(servicio), perfil)).json()
        if como == "bloqueo":
            await _pedir(app, "DELETE", f"{_agenda(servicio)}/blocks/{agenda['blocks'][0]['id']}", perfil)
        elif como == "pausa":
            await _pedir(app, "PUT", _agenda(servicio), perfil, {"timezone": "America/Lima", "buffer_after_minutes": 15})
        await _pedir(app, "POST", f"{RETENCIONES}/{retencion}/release", cliente, None, _clave())


async def test_si_se_publica_otra_version_hay_que_volver_a_elegir(reservas) -> None:
    app, motor, _ = reservas
    perfil, servicio, jefa, moderador = await _servicio(app, motor)
    await _condiciones(app, jefa)
    cliente = await _persona(motor)
    inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
    retencion = (await _retener(app, cliente, servicio, inicio)).json()["id"]
    resumen = await _resumen(app, cliente, retencion)
    await _publicar_otra_version(app, perfil, jefa, moderador, servicio, title="Asesoría con otro título")
    assert (await _resumen(app, cliente, retencion))["contract"]["version_changed"] is True
    r = await _confirmar(app, cliente, retencion, _aceptando(resumen))
    assert r.status_code == 409 and _codigo(r) == "service_booking_version_changed"


async def _publicar_otra_version(app, perfil, jefa, moderador, servicio, **cambios) -> None:
    from tests.test_servicios_catalogo_api import _editar, _imagen

    async with _cliente(app, perfil) as http:
        r = await http.post(f"{MIOS}/{servicio}/draft")
        assert r.status_code in (200, 201), r.text
    assert (await _editar(app, perfil, servicio, **cambios)).status_code == 200
    enviado = await _accion(app, perfil, f"{MIOS}/{servicio}/draft/submit")
    if enviado.status_code != 200:
        assert (await _imagen(app, perfil, servicio)).status_code == 201
        enviado = await _accion(app, perfil, f"{MIOS}/{servicio}/draft/submit")
    assert enviado.status_code == 200, enviado.text
    base = f"{BANDEJA}/{servicio}/versions/{enviado.json()['open_version']['id']}"
    assert (await _accion(app, moderador, f"{base}/start-review")).status_code == 200
    assert (await _accion(app, jefa, f"{base}/approve")).status_code == 200
    assert (await _accion(app, jefa, f"{base}/publish")).status_code == 200


async def test_una_reserva_anterior_no_cambia_con_la_version_nueva(reservas) -> None:
    app, motor, _ = reservas
    hecho = await _reservado(app, motor)
    await _publicar_otra_version(app, hecho["perfil"], hecho["jefa"], hecho["moderador"], hecho["servicio"],
                                 title="Título nuevo del servicio", duration_minutes=90)
    ahora = (await _pedir(app, "GET", f"{MIS_RESERVAS}/{hecho['reserva']['id']}", hecho["cliente"])).json()
    assert ahora["title"] == hecho["reserva"]["title"] and ahora["duration_minutes"] == 60
    assert (ahora["starts_at"], ahora["ends_at"]) == (hecho["reserva"]["starts_at"], hecho["reserva"]["ends_at"])


async def test_la_separacion_se_congela_al_retener_y_sigue_ocupando(reservas) -> None:
    """La preparación y el descanso se CONGELAN en la retención (y en la
    reserva): con inicios cada 15 minutos, la sesión de las 09:00 con 15 de
    descanso ocupa hasta las 10:15, y lo sigue haciendo aunque el prestador
    quite después el descanso."""
    app, motor, _ = reservas
    perfil, servicio, jefa, _ = await _servicio(app, motor)
    agenda = {"timezone": "America/Lima", "buffer_after_minutes": 15, "slot_interval_minutes": 15}
    r = await _pedir(app, "PUT", _agenda(servicio), perfil, agenda)
    assert r.status_code in (200, 201), r.text
    await _condiciones(app, jefa)
    fecha = _dia(7)
    horarios = await _horarios(app, servicio, fecha)
    assert [h["time"] for h in horarios][:3] == ["09:00", "09:15", "09:30"]
    cliente = await _persona(motor)
    retencion = (await _retener(app, cliente, servicio, horarios[0]["starts_at"])).json()["id"]
    horas = [h["time"] for h in await _horarios(app, servicio, fecha)]
    assert "10:00" not in horas and "10:15" in horas, horas
    separacion = ("select round(extract(epoch from starts_at - occupied_from) / 60)::int, "
                  "round(extract(epoch from occupied_until - ends_at) / 60)::int from public.{} where {} = cast(:h as uuid)")
    assert await _filas(motor, separacion.format("service_holds", "id"), h=retencion) == [(0, 15)]
    # El prestador quita el descanso: lo ya apartado sigue ocupando lo que congeló.
    r = await _pedir(app, "PUT", _agenda(servicio), perfil, {**agenda, "buffer_after_minutes": 0})
    assert r.status_code in (200, 201), r.text
    horas = [h["time"] for h in await _horarios(app, servicio, fecha)]
    assert "10:00" not in horas and "10:15" in horas, horas
    # Y la reserva guarda la separación con la que se apartó.
    assert (await _confirmar(app, cliente, retencion)).status_code == 201
    assert await _filas(motor, "select buffer_before_minutes, buffer_after_minutes from public.service_bookings "
                               "where hold_id = cast(:h as uuid)", h=retencion) == [(0, 15)]
    assert await _filas(motor, separacion.format("service_bookings", "hold_id"), h=retencion) == [(0, 15)]


async def test_una_sesion_de_grupo_da_sus_plazas_y_ni_una_mas(reservas) -> None:
    app, motor, _ = reservas
    _, servicio, jefa, _ = await _servicio(app, motor, capacidad=2)
    await _condiciones(app, jefa)
    fecha = _dia(7)
    inicio = (await _horarios(app, servicio, fecha))[0]["starts_at"]
    personas = [await _persona(motor) for _ in range(3)]
    primera = await _retener(app, personas[0], servicio, inicio)
    assert primera.status_code == 201, primera.text
    assert inicio in [h["starts_at"] for h in await _horarios(app, servicio, fecha)]  # queda una plaza
    assert (await _retener(app, personas[1], servicio, inicio)).status_code == 201
    assert inicio not in [h["starts_at"] for h in await _horarios(app, servicio, fecha)]
    r = await _retener(app, personas[2], servicio, inicio)
    assert r.status_code == 409 and _codigo(r) == "service_slot_not_available"
    plazas = await _filas(motor, "select seat from public.service_holds where service_id = cast(:s as uuid) "
                                 "order by seat", s=servicio)
    assert plazas == [(1,), (2,)]
    # Las dos se confirman.
    for fila in await _filas(motor, "select id::text, client_id::text from public.service_holds "
                                    "where service_id = cast(:s as uuid)", s=servicio):
        assert (await _confirmar(app, fila[1], fila[0])).status_code == 201


# =========================================================================== #
# 8. Las banderas, la puerta y lo que no se toca
# =========================================================================== #
async def test_con_las_banderas_apagadas_nada_de_la_reserva_responde(reservas, monkeypatch) -> None:
    app, motor, _ = reservas
    quien = await _persona(motor)
    ident = str(uuid.uuid4())
    rutas = (
        ("POST", f"{CATALOGO}/{ident}/holds"), ("GET", f"{RETENCIONES}/{ident}"),
        ("POST", f"{RETENCIONES}/{ident}/release"), ("GET", f"{RETENCIONES}/{ident}/checkout"),
        ("POST", f"{RETENCIONES}/{ident}/confirm"), ("GET", MIS_RESERVAS), ("GET", f"{MIS_RESERVAS}/{ident}"),
        ("GET", DEL_PRESTADOR), ("GET", f"{DEL_PRESTADOR}/{ident}"),
    )
    for bandera, codigo in (("feature_service_booking", "service_booking_disabled"),
                            ("feature_services", "services_disabled")):
        monkeypatch.setattr(get_settings(), bandera, False)
        esquema.olvidar()
        for metodo, ruta in rutas:
            async with _cliente(app, quien) as http:
                r = await http.request(metodo, ruta, json={})
            assert r.status_code == 503 and _codigo(r) == codigo, (bandera, metodo, ruta, r.text)
    # Y lo público dice que no se puede reservar.
    monkeypatch.setattr(get_settings(), "feature_services", True)
    monkeypatch.setattr(get_settings(), "feature_service_booking", False)
    _, servicio, _, _ = await _servicio(app, motor)
    assert (await _pedir(app, "GET", _publica(servicio), None)).json()["booking_available"] is False


async def _puerta_de_la_reserva(motor, *cambios: str) -> bool:
    esquema.olvidar()
    async with motor.connect() as conexion:
        transaccion = await conexion.begin()
        try:
            for sql in cambios:
                await conexion.execute(text(sql))
            sesion = AsyncSession(bind=conexion)
            try:
                return await esquema.hay_reservas(sesion)
            finally:
                await sesion.close()
        finally:
            await transaccion.rollback()
            esquema.olvidar()


_H, _B, _O = "public.service_holds", "public.service_bookings", "public.service_orders"

#: CADA FORMA de que la 0093 falte, esté a medias o esté aflojada.
ALTERACIONES_DE_LA_0093 = (
    (f"drop table public.service_booking_events",),
    (f"alter table {_B} drop column location_area_snapshot",),
    (f"alter table {_H} add column extra integer not null default 0",),
    (f"alter table {_H} alter column seat type bigint",),
    (f"alter table {_H} alter column timezone drop not null",),
    (f"alter table {_H} drop constraint service_holds_sin_cruces",),
    (f"alter table {_H} drop constraint service_holds_sin_cruces",
     f"alter table {_H} add constraint service_holds_sin_cruces exclude using gist (service_id with =, "
     "tstzrange(occupied_from, occupied_until, '[)') with &&, starts_at with <>) where (status = 'active')"),
    (f"alter table {_O} drop constraint service_orders_sin_dinero",),
    (f"alter table {_O} drop constraint service_orders_modelo",
     f"alter table {_O} add constraint service_orders_modelo check (price_model in ('free', 'fixed'))"),
    (f"alter table {_H} drop constraint service_holds_plaza",
     f"alter table {_H} add constraint service_holds_plaza check (seat between 1 and capacity) not valid"),
    (f"alter table {_B} drop constraint service_bookings_client_id_fkey",
     f"alter table {_B} add constraint service_bookings_client_id_fkey foreign key (client_id) "
     "references public.profiles(id) on delete cascade"),
    # La baja de quien presta, otra vez por DOS caminos, o sin diferir.
    (f"alter table {_O} drop constraint service_orders_provider_id_fkey",
     f"alter table {_O} add constraint service_orders_provider_id_fkey foreign key (provider_id) "
     "references public.service_providers(id) on delete cascade"),
    (f"alter table {_B} drop constraint service_bookings_provider_id_fkey",
     f"alter table {_B} add constraint service_bookings_provider_id_fkey foreign key (provider_id) "
     "references public.service_providers(id)"),
    ("drop index public.service_holds_una_plaza",),
    ("drop index public.service_holds_una_plaza",
     f"create index service_holds_una_plaza on {_H} (service_id, starts_at, seat) "
     "where status in ('active', 'consumed')"),
    ("update pg_catalog.pg_index set indisvalid = false "
     "where indexrelid = 'public.service_holds_sin_cruces'::regclass",),
    ("update pg_catalog.pg_index set indisready = false "
     "where indexrelid = 'public.service_bookings_un_pedido'::regclass",),
    (f"drop trigger service_holds_salto_valido on {_H}",),
    (f"alter table {_B} disable trigger service_bookings_por_venir",),
    (f"drop trigger service_orders_completos on {_O}",
     f"create constraint trigger service_orders_completos after insert on {_O} "
     "deferrable initially immediate for each row execute function public.servicios_pedido_completo()"),
    ("create or replace function public.servicios_reserva_coherente() returns trigger language plpgsql "
     "set search_path = public, pg_temp as $$ begin return null; end; $$",),
    ("alter function public.servicios_pedido_completo() security definer",),
    ("alter table public.service_policies drop constraint service_policies_tipo",
     "alter table public.service_policies add constraint service_policies_tipo "
     "check (kind in ('provider_terms')) not valid"),
    ("alter table public.service_policies drop constraint service_policies_tipo",
     "alter table public.service_policies add constraint service_policies_tipo "
     "check (kind in ('provider_terms', 'booking_terms')) not valid"),
    (f"alter table {_B} disable row level security",),
    (f"create policy abierta on {_B} for select to authenticated using (true)",),
    (f"grant select on {_B} to anon",),
    ("grant select (note) on public.service_booking_intakes to authenticated",),
    (f"grant select on {_O} to public",),
    ("grant execute on function public.servicios_reserva_inmutable() to authenticated",),
)


async def test_la_puerta_de_la_reserva_mira_lo_que_hace_falta(reservas) -> None:
    _, motor, _ = reservas
    assert await _puerta_de_la_reserva(motor) is True
    abiertas = [c for c in ALTERACIONES_DE_LA_0093 if await _puerta_de_la_reserva(motor, *c) is not False]
    assert abiertas == []
    # Con más permisos para `service_role`, sí: solo la API lo usa.
    assert await _puerta_de_la_reserva(motor, f"grant all on {_B} to service_role") is True


def _siempre(sesion: AsyncSession):  # noqa: ANN202
    async def _la_misma():  # noqa: ANN202
        yield sesion

    return _la_misma


async def test_con_la_0093_alterada_la_api_contesta_503_y_nunca_500(reservas) -> None:
    app, motor, _ = reservas
    hecho = await _reservado(app, motor)
    peticiones = (
        ("POST", f"{CATALOGO}/{hecho['servicio']}/holds", hecho["cliente"], {"starts_at": hecho["inicio"]}),
        ("GET", f"{RETENCIONES}/{hecho['retencion']}", hecho["cliente"], None),
        ("GET", MIS_RESERVAS, hecho["cliente"], None),
        ("GET", DEL_PRESTADOR, hecho["perfil"], None),
        # Las condiciones de CONTRATACIÓN solo caben con la 0093 (amplía el
        # tipo de `service_policies`): sin ella, 503, nunca un 500.
        ("POST", f"{ADMIN_SERVICIOS}/policies/booking-terms/draft", hecho["jefa"],
         {"country_code": "CL", "title": "Condiciones de contratación", "body": "Texto de prueba " * 10}),
    )
    normal = app.dependency_overrides[get_db]
    try:
        for cambios in ALTERACIONES_DE_LA_0093:
            esquema.olvidar()
            async with motor.connect() as conexion:
                transaccion = await conexion.begin()
                sesion = AsyncSession(bind=conexion, expire_on_commit=False)
                app.dependency_overrides[get_db] = _siempre(sesion)
                try:
                    for sql in cambios:
                        await conexion.execute(text(sql))
                    for metodo, ruta, uid, cuerpo in peticiones:
                        r = await _pedir(app, metodo, ruta, uid, cuerpo, _clave() if metodo == "POST" else None)
                        assert (r.status_code, _codigo(r)) == (503, "services_not_ready"), (cambios, ruta, r.text)
                finally:
                    app.dependency_overrides[get_db] = normal
                    await sesion.close()
                    await transaccion.rollback()
                    esquema.olvidar()
    finally:
        app.dependency_overrides[get_db] = normal
    assert (await _pedir(app, "GET", MIS_RESERVAS, hecho["cliente"])).status_code == 200


async def test_un_error_al_mirar_la_0093_es_503_y_no_se_recuerda(reservas, monkeypatch) -> None:
    app, motor, _ = reservas
    cliente = await _persona(motor)
    esquema.olvidar()
    buena = esquema._LO_QUE_NECESITA_LA_RESERVA
    monkeypatch.setattr(esquema, "_LO_QUE_NECESITA_LA_RESERVA", text("select 1 / 0 = 1"))
    r = await _pedir(app, "GET", MIS_RESERVAS, cliente)
    assert r.status_code == 503 and _codigo(r) == "services_not_ready"
    assert "reserva" not in esquema._cache
    monkeypatch.setattr(esquema, "_LO_QUE_NECESITA_LA_RESERVA", buena)
    assert (await _pedir(app, "GET", MIS_RESERVAS, cliente)).status_code == 200


async def test_la_baja_de_quien_tiene_una_reserva_por_venir_espera(reservas) -> None:
    app, motor, _ = reservas
    hecho = await _reservado(app, motor)
    r = await _borrar_cuenta(app, hecho["cliente"])
    assert r.status_code == 409 and _codigo(r) == "account_deletion_blocked", r.text
    assert await _uno(motor, "select count(*) from public.profiles where id = cast(:u as uuid)", u=hecho["cliente"]) == 1


async def _ultimo_en_disparar(conexion) -> str:
    """De las claves ajenas que borran al borrar un prestador (servicios,
    pedidos y reservas), la tabla cuyo disparador va el ÚLTIMO: PostgreSQL los
    dispara por el orden de su nombre, y el nombre sale de su OID."""
    filas = (await conexion.execute(text(
        "select c.conrelid::regclass::text from pg_catalog.pg_trigger t "
        "join pg_catalog.pg_constraint c on c.oid = t.tgconstraint "
        "where t.tgrelid = 'public.service_providers'::regclass and c.contype = 'f' "
        "and c.conrelid in ('public.services'::regclass, 'public.service_orders'::regclass, "
        "'public.service_bookings'::regclass) and t.tgtype & 8 = 8 "
        "order by t.tgname collate \"C\""
    ))).scalars().all()
    return filas[-1]


async def test_la_baja_de_quien_presta_no_depende_del_orden_de_los_disparadores(reservas) -> None:
    """Hallazgo de la revisión del 30/09. Del prestador salían DOS caminos de
    borrado hacia sus pedidos y reservas: por el servicio (0090) y directo por
    `provider_id` (0093). Los disparadores de las claves ajenas se disparan por
    el orden de su nombre (el OID): si el directo iba antes, el pedido se
    borraba con el servicio todavía vivo y `solo_en_cascada` lo impedía; la
    baja fallaba según los OID de cada base. Aquí se prueban LOS DOS órdenes:
    el de una base nueva y, recreando la clave del servicio, el contrario.
    Todo dentro de una transacción que se deshace."""
    app, motor, _ = reservas
    hecho = await _reservado(app, motor)
    servicio = hecho["servicio"]
    async with motor.connect() as conexion:
        transaccion = await conexion.begin()
        try:
            # La reserva, al pasado (una por venir impide la baja, y eso ya se prueba).
            await conexion.execute(text("set local session_replication_role = replica"))
            for tabla in ("service_holds", "service_bookings"):
                await conexion.execute(text(
                    f"update public.{tabla} set starts_at = starts_at - interval '60 days', "
                    "ends_at = ends_at - interval '60 days', occupied_from = occupied_from - interval '60 days', "
                    "occupied_until = occupied_until - interval '60 days', "
                    "local_date = local_date - 60 where service_id = cast(:s as uuid)"
                ), {"s": servicio})
            await conexion.execute(text("set local session_replication_role = origin"))
            for orden in ("el de una base nueva", "el servicio el último"):
                if orden == "el servicio el último":
                    nombre, definicion = (await conexion.execute(text(
                        "select conname, pg_get_constraintdef(oid) from pg_catalog.pg_constraint "
                        "where conrelid = 'public.services'::regclass and contype = 'f' "
                        "and confrelid = 'public.service_providers'::regclass"
                    ))).one()
                    await conexion.execute(text(f'alter table public.services drop constraint "{nombre}"'))
                    await conexion.execute(text(f'alter table public.services add constraint "{nombre}" {definicion}'))
                    assert await _ultimo_en_disparar(conexion) == "services", "no se logró el orden contrario"
                punto = await conexion.begin_nested()
                await conexion.execute(text("delete from auth.users where id = cast(:u as uuid)"), {"u": hecho["perfil"]})
                # Lo diferido, AHORA (la transacción no llega a confirmarse).
                await conexion.execute(text("set constraints all immediate"))
                for tabla in ("services", "service_orders", "service_bookings", "service_holds"):
                    columna = "id" if tabla == "services" else "service_id"
                    quedan = (await conexion.execute(text(
                        f"select count(*) from public.{tabla} where {columna} = cast(:s as uuid)"
                    ), {"s": servicio})).scalar()
                    assert quedan == 0, (orden, tabla, quedan)
                await punto.rollback()
        finally:
            await transaccion.rollback()
    # Nada de lo anterior quedó.
    assert await _uno(motor, "select count(*) from public.service_bookings where service_id = cast(:s as uuid)",
                      s=servicio) == 1


# =========================================================================== #
# 9. Carreras, con PostgreSQL de verdad
# =========================================================================== #
async def test_diez_personas_a_la_vez_por_el_mismo_horario_una_lo_consigue(reservas) -> None:
    app, motor, _ = reservas
    _, servicio, _, _ = await _servicio(app, motor)
    inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
    personas = [await _persona(motor) for _ in range(10)]
    respuestas = await asyncio.gather(*(_retener(app, p, servicio, inicio) for p in personas))
    codigos = sorted(r.status_code for r in respuestas)
    assert codigos.count(201) == 1 and all(c == 409 for c in codigos if c != 201), [r.text for r in respuestas]
    assert {_codigo(r) for r in respuestas if r.status_code == 409} <= {"service_slot_not_available", "service_booking_busy"}
    assert await _uno(motor, "select count(*) from public.service_holds where service_id = cast(:s as uuid)",
                      s=servicio) == 1


async def test_la_misma_clave_a_la_vez_una_sola_retencion_y_con_otro_contenido_409(reservas) -> None:
    app, motor, _ = reservas
    _, servicio, _, _ = await _servicio(app, motor)
    cliente = await _persona(motor)
    nueve, diez = [h["starts_at"] for h in await _horarios(app, servicio, _dia(7))]
    clave = _clave()
    respuestas = await asyncio.gather(*(_retener(app, cliente, servicio, nueve, clave=clave) for _ in range(5)))
    assert sorted(r.status_code for r in respuestas) == [200, 200, 200, 200, 201], [r.text for r in respuestas]
    assert len({r.json()["id"] for r in respuestas}) == 1
    # La MISMA clave, a la vez, para dos horarios distintos: una gana y la otra
    # es un 409 (nunca dos retenciones con una clave). Otra persona, sin nada
    # apartado: si no, según el orden, la segunda podría chocar antes con «ya
    # tienes ese horario apartado», que también es correcto.
    otra = _clave()
    nueva = await _persona(motor)
    uno, dos = [h["starts_at"] for h in await _horarios(app, servicio, _dia(8))]
    respuestas = await asyncio.gather(_retener(app, nueva, servicio, uno, clave=otra),
                                      _retener(app, nueva, servicio, dos, clave=otra))
    assert sorted(r.status_code for r in respuestas) == [201, 409], [r.text for r in respuestas]
    assert [_codigo(r) for r in respuestas if r.status_code == 409] == ["idempotency_key_reused"]


async def test_confirmar_dos_veces_a_la_vez_deja_una_reserva(reservas) -> None:
    app, motor, _ = reservas
    _, servicio, jefa, _ = await _servicio(app, motor)
    await _condiciones(app, jefa)
    cliente = await _persona(motor)
    inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
    retencion = (await _retener(app, cliente, servicio, inicio)).json()["id"]
    cuerpo = _aceptando(await _resumen(app, cliente, retencion))
    clave = _clave()
    respuestas = await asyncio.gather(*(_confirmar(app, cliente, retencion, cuerpo, clave=clave) for _ in range(3)),
                                      *(_confirmar(app, cliente, retencion, cuerpo) for _ in range(3)))
    buenas = [r for r in respuestas if r.status_code in (200, 201)]
    assert sum(1 for r in respuestas if r.status_code == 201) == 1, [r.text for r in respuestas]
    assert len({r.json()["id"] for r in buenas}) == 1
    assert {_codigo(r) for r in respuestas if r.status_code == 409} <= {"service_hold_already_consumed"}
    for tabla in ("service_orders", "service_bookings"):
        assert await _uno(motor, f"select count(*) from public.{tabla} where service_id = cast(:s as uuid)",
                          s=servicio) == 1


async def test_confirmar_mientras_vence_o_se_suelta_deja_un_resultado_valido(reservas) -> None:
    app, motor, _ = reservas
    _, servicio, jefa, _ = await _servicio(app, motor)
    await _condiciones(app, jefa)
    for carrera in ("barrido", "soltar"):
        cliente = await _persona(motor)
        inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
        retencion = (await _retener(app, cliente, servicio, inicio)).json()["id"]
        cuerpo = _aceptando(await _resumen(app, cliente, retencion))
        if carrera == "barrido":
            await _vencer_ya(motor, retencion, dentro="150 milliseconds")
            await asyncio.sleep(0.1)
            otra = _pedir(app, "POST", f"{ADMIN_SERVICIOS}/holds/expire", jefa)
        else:
            otra = _pedir(app, "POST", f"{RETENCIONES}/{retencion}/release", cliente, None, _clave())
        confirmacion, rival = await asyncio.gather(_confirmar(app, cliente, retencion, cuerpo), otra)
        assert confirmacion.status_code in (201, 409) and rival.status_code in (200, 409), (
            carrera, confirmacion.text, rival.text)
        estado = await _uno(motor, "select status from public.service_holds where id = cast(:h as uuid)", h=retencion)
        reservas_ = await _uno(motor, "select count(*) from public.service_bookings where hold_id = cast(:h as uuid)",
                               h=retencion)
        # O se reservó (y la retención quedó consumida) o no (y quedó vencida o soltada): nunca las dos.
        assert (estado, reservas_) in (("consumed", 1), ("expired", 0), ("released", 0), ("active", 0)), (
            carrera, estado, reservas_)
        assert (confirmacion.status_code == 201) == (reservas_ == 1)
        if reservas_ == 0 and estado == "active":  # el barrido llegó antes de vencer
            await _pedir(app, "POST", f"{RETENCIONES}/{retencion}/release", cliente, None, _clave())


async def _alguien_espera_un_cerrojo(motor, *, hasta: float = 8.0) -> None:
    """Hasta que una conexión de la API esté esperando un cerrojo."""
    reloj = asyncio.get_running_loop()
    fin = reloj.time() + hasta
    while reloj.time() < fin:
        if await _uno(motor, "select count(*) from pg_stat_activity where datname = current_database() "
                             "and wait_event_type = 'Lock' and pid <> pg_backend_pid()"):
            return
        await asyncio.sleep(0.02)
    raise AssertionError("nadie llegó a esperar el cerrojo")


@pytest.mark.parametrize("carrera", ["confirmar", "soltar", "retener"])
async def test_el_barrido_a_medias_no_se_interbloquea_con_quien_espera_su_retencion(reservas, carrera) -> None:
    """Hallazgo de la revisión del 30/09. El barrido bloquea una retención, la
    vence y DESPUÉS escribe su línea del historial, cuya clave ajena mira el
    servicio (FOR KEY SHARE). Si entretanto alguien puso en fila el servicio
    (FOR UPDATE) y espera por esa retención, son dos esperando al otro: 40P01,
    y la petición de la persona acababa en 500. Aquí, sin azar: la conexión
    del «barrido» hace lo mismo que `_vencer`, y escribe su línea solo cuando
    PostgreSQL enseña a la petición esperando."""
    app, motor, _ = reservas
    _, servicio, jefa, _ = await _servicio(app, motor)
    await _condiciones(app, jefa)
    cliente = await _persona(motor)
    otra_persona = await _persona(motor)
    inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
    retencion = (await _retener(app, cliente, servicio, inicio)).json()["id"]
    cuerpo = _aceptando(await _resumen(app, cliente, retencion))
    await _vencer_ya(motor, retencion)
    async with motor.connect() as barrido:
        transaccion = await barrido.begin()
        await barrido.execute(text("set local lock_timeout = '10s'"))
        await barrido.execute(text("select id from public.service_holds where id = cast(:h as uuid) "
                                   "for update skip locked"), {"h": retencion})
        await barrido.execute(text("update public.service_holds set status = 'expired', expired_at = now(), "
                                   "updated_at = now() where id = cast(:h as uuid)"), {"h": retencion})
        if carrera == "confirmar":
            peticion = _confirmar(app, cliente, retencion, cuerpo)
        elif carrera == "soltar":
            peticion = _pedir(app, "POST", f"{RETENCIONES}/{retencion}/release", cliente, None, _clave())
        else:
            peticion = _retener(app, otra_persona, servicio, inicio)
        tarea = asyncio.create_task(peticion)
        try:
            await _alguien_espera_un_cerrojo(motor)
            await barrido.execute(text(
                "insert into public.service_booking_events (service_id, hold_id, action, from_status, to_status, "
                "actor_role, details, created_at) values (cast(:s as uuid), cast(:h as uuid), 'hold_expired', "
                "'active', 'expired', 'system', '{}'::jsonb, now())"), {"s": servicio, "h": retencion})
            await transaccion.commit()
        finally:
            respuesta = await asyncio.wait_for(tarea, 20)
    esperado = {"confirmar": (409, "service_hold_expired"), "soltar": (200, None), "retener": (201, None)}[carrera]
    assert (respuesta.status_code, _codigo(respuesta) if respuesta.status_code >= 400 else None) == esperado, (
        respuesta.text)
    estado = await _uno(motor, "select status from public.service_holds where id = cast(:h as uuid)", h=retencion)
    assert estado == "expired"
    assert await _uno(motor, "select count(*) from public.service_bookings where service_id = cast(:s as uuid)",
                      s=servicio) == 0


@pytest.mark.parametrize("accion", ["confirm", "release"])
async def test_la_misma_clave_a_la_vez_en_dos_retenciones_es_409_y_nunca_500(reservas, monkeypatch, accion) -> None:
    """Hallazgo de la revisión del 30/09. La misma `Idempotency-Key`, A LA
    VEZ, para dos retenciones de servicios distintos: no comparten ningún
    cerrojo, las dos escribían su línea con la misma clave y la segunda
    chocaba con el índice único (23505): un 500. Tiene que ser un 409."""
    app, motor, _ = reservas
    _, uno, jefa, moderador = await _servicio(app, motor)
    _, dos, _, _ = await _servicio(app, motor, jefa=jefa, moderador=moderador)
    await _condiciones(app, jefa)
    cliente = await _persona(motor)
    retenciones = []
    for servicio in (uno, dos):
        inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
        r = await _retener(app, cliente, servicio, inicio)
        assert r.status_code == 201, r.text
        retenciones.append(r.json()["id"])
    cuerpos = [_aceptando(await _resumen(app, cliente, h)) for h in retenciones]
    # La primera sigue abierta un momento DESPUÉS de escribir su línea.
    original = reserva_dominio._anotar

    async def _lento(*args, **kwargs):
        evento = await original(*args, **kwargs)
        await asyncio.sleep(0.5)
        return evento

    monkeypatch.setattr(reserva_dominio, "_anotar", _lento)
    clave = _clave()
    if accion == "confirm":
        respuestas = await asyncio.gather(*(_confirmar(app, cliente, h, c, clave=clave)
                                            for h, c in zip(retenciones, cuerpos)))
        bien = 201
    else:
        respuestas = await asyncio.gather(*(_pedir(app, "POST", f"{RETENCIONES}/{h}/release", cliente, None, clave)
                                            for h in retenciones))
        bien = 200
    assert sorted(r.status_code for r in respuestas) == [bien, 409], [r.text for r in respuestas]
    assert [_codigo(r) for r in respuestas if r.status_code == 409] == ["idempotency_key_reused"]
    assert await _uno(motor, "select count(*) from public.service_booking_events where idempotency_key = :k",
                      k=clave) == 1


async def test_una_sesion_de_dos_plazas_con_seis_a_la_vez_da_dos(reservas) -> None:
    app, motor, _ = reservas
    _, servicio, _, _ = await _servicio(app, motor, capacidad=2)
    inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
    personas = [await _persona(motor) for _ in range(6)]
    respuestas = await asyncio.gather(*(_retener(app, p, servicio, inicio) for p in personas))
    assert sorted(r.status_code for r in respuestas).count(201) == 2, [r.text for r in respuestas]
    assert await _filas(motor, "select seat from public.service_holds where service_id = cast(:s as uuid) "
                               "order by seat", s=servicio) == [(1,), (2,)]


async def test_confirmar_mientras_el_prestador_bloquea_ese_horario(reservas) -> None:
    app, motor, _ = reservas
    perfil, servicio, jefa, _ = await _servicio(app, motor)
    await _condiciones(app, jefa)
    cliente = await _persona(motor)
    fecha = _dia(7)
    inicio = (await _horarios(app, servicio, fecha))[0]["starts_at"]
    retencion = (await _retener(app, cliente, servicio, inicio)).json()["id"]
    cuerpo = _aceptando(await _resumen(app, cliente, retencion))
    confirmacion, bloqueo = await asyncio.gather(
        _confirmar(app, cliente, retencion, cuerpo),
        _pedir(app, "POST", f"{_agenda(servicio)}/blocks", perfil,
               {"start_date": fecha, "start_time": "09:30", "end_date": fecha, "end_time": "09:45"}, _clave()),
    )
    assert bloqueo.status_code == 201, bloqueo.text
    assert confirmacion.status_code in (201, 409), confirmacion.text
    if confirmacion.status_code == 409:
        assert _codigo(confirmacion) == "service_slot_not_available"
    reservas_ = await _uno(motor, "select count(*) from public.service_bookings where hold_id = cast(:h as uuid)",
                           h=retencion)
    assert reservas_ == (1 if confirmacion.status_code == 201 else 0)


async def test_leer_mientras_se_retiene_y_se_vence_nunca_da_500(reservas) -> None:
    app, motor, _ = reservas
    _, servicio, jefa, _ = await _servicio(app, motor)
    trabajos = []
    for i in range(6):
        persona = await _persona(motor)
        fecha = _dia(8 + i)
        inicio = (await _horarios(app, servicio, fecha))[0]["starts_at"]
        trabajos += [
            _retener(app, persona, servicio, inicio),
            _pedir(app, "GET", _publica(servicio), None),
            _pedir(app, "GET", f"{_publica(servicio)}/{fecha}", None),
            _pedir(app, "POST", f"{ADMIN_SERVICIOS}/holds/expire", jefa),
            _pedir(app, "GET", f"{ADMIN_SERVICIOS}/holds", jefa),
        ]
    respuestas = await asyncio.gather(*trabajos)
    assert all(r.status_code < 500 for r in respuestas), [r.text for r in respuestas if r.status_code >= 500]


# =========================================================================== #
# 10. Listas, cursores y la hora del servidor
# =========================================================================== #
async def test_mis_reservas_se_paginan_sin_repetir_ni_saltar(reservas) -> None:
    app, motor, _ = reservas
    _, servicio, jefa, _ = await _servicio(app, motor)
    await _condiciones(app, jefa)
    cliente = await _persona(motor)
    creadas = []
    for dias in range(7, 12):
        for h in await _horarios(app, servicio, _dia(dias)):
            retencion = (await _retener(app, cliente, servicio, h["starts_at"])).json()["id"]
            r = await _confirmar(app, cliente, retencion)
            assert r.status_code == 201, r.text
            creadas.append(r.json()["id"])
    vistos, cursor = [], None
    for _ in range(20):
        pagina = (await _pedir(app, "GET", MIS_RESERVAS, cliente, limit=3, cursor=cursor)).json()
        vistos += [b["id"] for b in pagina["items"]]
        cursor = pagina["next_cursor"]
        if cursor is None:
            break
    assert vistos == creadas  # de la más próxima a la más lejana
    assert (await _pedir(app, "GET", MIS_RESERVAS, cliente, scope="past")).json()["items"] == []
    r = await _pedir(app, "GET", MIS_RESERVAS, cliente, cursor="ayer")
    assert r.status_code == 422 and _codigo(r) == "invalid_cursor"
    bandeja = (await _pedir(app, "GET", DEL_PRESTADOR, (await _filas(
        motor, "select p.profile_id::text from public.service_providers p join public.services s on "
               "s.provider_id = p.id where s.id = cast(:s as uuid)", s=servicio))[0][0], limit=50)).json()
    assert [b["id"] for b in bandeja["items"]] == creadas


async def test_la_cuenta_atras_es_la_del_servidor(reservas) -> None:
    app, motor, _ = reservas
    _, servicio, _, _ = await _servicio(app, motor)
    cliente = await _persona(motor)
    inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
    r = (await _retener(app, cliente, servicio, inicio)).json()
    from datetime import datetime

    vence = datetime.fromisoformat(r["expires_at"])
    ahora = datetime.fromisoformat(r["server_now"])
    minutos = get_settings().services_booking_hold_minutes
    assert timedelta(minutes=minutos) - timedelta(seconds=5) <= vence - ahora <= timedelta(minutes=minutos)
    assert abs(r["seconds_left"] - (vence - ahora).total_seconds()) <= 1
    # Un instante sin desplazamiento no se adivina.
    r = await _pedir(app, "POST", f"{CATALOGO}/{servicio}/holds", cliente, {"starts_at": inicio[:19]}, _clave())
    assert r.status_code == 422 and _codigo(r) == "service_hold_invalid"
    # Y un horario que la agenda no ofrece, 409.
    r = await _retener(app, cliente, servicio, inicio.replace(":00:00", ":05:00"))
    assert r.status_code == 409 and _codigo(r) == "service_slot_not_available"
