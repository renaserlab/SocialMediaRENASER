"""Las políticas operativas del piloto gratuito de Z Servicios (02/10/2026).

Lo que la primera versión deja fijado, comprobado contra el código y no solo
escrito: los valores de fábrica, que el piloto no mueve dinero, que nadie
resuelve su propia actuación, y que los procesos que todavía no tienen
planificador se pueden ejecutar a mano sin riesgo.

Son políticas técnicas y operativas PROVISIONALES, no un dictamen legal
(`docs/Z_REQUISITOS_Y_DECISIONES.md`).
"""

from __future__ import annotations

import pytest

from app.core.config import Settings, get_settings
from app.modules.services import reserva as reserva_dominio
from app.modules.services import reserva_politica as limites
from app.modules.services.reserva_models import CONTRATABLES, ESTADOS_DE_PAGO, PASARELAS
from tests.test_baja_de_cuenta_postgres import SIN_POSTGRES, _filas, _persona, _sembrar, _uno
from tests.test_servicios_agenda_api import _codigo, _dia, _pedir
from tests.test_servicios_atencion_api import (  # noqa: F401 - montajes compartidos
    TAREAS,
    _con_caso,
    _llevar,
    _resolver,
    _sucesos,
    atencion,
)
from tests.test_servicios_catalogo_api import BANDEJA, CONTENIDO, MIOS, _accion, _categoria, _crear, _editar, _imagen
from tests.test_servicios_descubrimiento_api import base_aplicada, entorno, mundo  # noqa: F401 - montajes compartidos
from tests.test_servicios_reserva_api import (  # noqa: F401 - montajes compartidos
    ADMIN_SERVICIOS,
    _condiciones,
    _dinero,
    _horarios,
    _reservado,
    _retener,
    _servicio,
    _vencer_ya,
    reservas,
)

pytestmark = pytest.mark.asyncio

DE_FABRICA = {nombre: campo.default for nombre, campo in Settings.model_fields.items()}
BARRIDO = f"{ADMIN_SERVICIOS}/holds/expire"


# =========================================================================== #
# 1. Los valores de la primera versión son los de fábrica
# =========================================================================== #
async def test_los_valores_de_la_primera_version_son_los_de_fabrica() -> None:
    """Un servidor al que nadie le configuró nada aplica ESTA política. Cambiar
    uno de estos valores es cambiar la política: se decide, se documenta y, si
    lo dicen las condiciones, se publican unas nuevas."""
    assert {
        # El alcance: virtual y presencial, en soles, sin «a domicilio».
        "services_catalog_modalities": "virtual,in_person",
        "services_booking_instant_modalities": "virtual,in_person",
        "services_catalog_currencies": "PEN",
        # El dinero: ninguna ficha con importe y ningún cobro.
        "services_catalog_price_models": "free,on_request",
        "feature_service_payments": False,
        "service_payments_provider": "none",
        # El piloto: cerrado, y vacío mientras nadie lo autorice.
        "feature_services": False,
        "feature_service_booking": False,
        "services_public_access": False,
        "services_pilot_profile_ids": "",
        # La agenda y la retención del horario.
        "services_booking_hold_minutes": 10,
        "services_booking_max_active_holds": 3,
        "services_agenda_notice_minutes": 120,
        "services_agenda_horizon_days": 60,
        # Cambiar de horario.
        "services_booking_reschedule_max": 1,
        "services_booking_reschedule_min_hours": 24,
        # La atención.
        "services_attention_checkin_minutes": 15,
        "services_attention_tolerance_minutes": 15,
        "services_attention_confirmation_hours": 24,
        "services_booking_reminder_hours": 24,
        # La posventa.
        "services_incident_window_hours": 48,
        "services_incident_appeals_max": 1,
        "services_incident_appeal_days": 5,
        "services_review_window_days": 30,
        "services_reviews_premoderation": True,
    } == {clave: DE_FABRICA[clave] for clave in (
        "services_catalog_modalities", "services_booking_instant_modalities", "services_catalog_currencies",
        "services_catalog_price_models", "feature_service_payments", "service_payments_provider",
        "feature_services", "feature_service_booking", "services_public_access", "services_pilot_profile_ids",
        "services_booking_hold_minutes", "services_booking_max_active_holds", "services_agenda_notice_minutes",
        "services_agenda_horizon_days", "services_booking_reschedule_max", "services_booking_reschedule_min_hours",
        "services_attention_checkin_minutes", "services_attention_tolerance_minutes",
        "services_attention_confirmation_hours", "services_booking_reminder_hours",
        "services_incident_window_hours", "services_incident_appeals_max", "services_incident_appeal_days",
        "services_review_window_days", "services_reviews_premoderation",
    )}


async def test_el_piloto_no_tiene_ningun_camino_de_dinero() -> None:
    """Solo lo gratuito se contrata, sin cobro y sin pasarela; y con la
    configuración de fábrica el cobro no está disponible."""
    assert CONTRATABLES == ("free",)
    assert ESTADOS_DE_PAGO == ("not_required",) and PASARELAS == ("none",)
    assert limites.cobro_disponible() is False


# =========================================================================== #
# 2. El piloto es gratuito, por la API real
# =========================================================================== #
@SIN_POSTGRES
async def test_de_fabrica_una_ficha_con_importe_no_se_envia_y_a_consultar_no_se_reserva(reservas, monkeypatch) -> None:  # noqa: F811
    app, motor, _ = reservas
    monkeypatch.setattr(get_settings(), "services_catalog_price_models", DE_FABRICA["services_catalog_price_models"])
    perfil, _servicio_id, jefa, _moderador = await _servicio(app, motor)
    antes = await _dinero(motor)
    for modelo in ("fixed", "from"):
        r = await _crear(app, perfil, (await _categoria(app, jefa))["id"])
        assert r.status_code == 201, r.text
        ficha = r.json()["id"]
        assert (await _editar(app, perfil, ficha, **{**CONTENIDO, "price_model": modelo})).status_code == 200
        assert (await _imagen(app, perfil, ficha)).status_code == 201
        r = await _accion(app, perfil, f"{MIOS}/{ficha}/draft/submit")
        assert r.status_code == 422 and _codigo(r) == "service_catalog_incomplete", (modelo, r.text)
        assert r.json()["error"]["details"]["missing"] == ["price_model_not_allowed"], r.text
    # «A consultar» se publica y se ve, y NO se reserva en Z: es solo información.
    _otro, a_consultar, _j, _m = await _servicio(
        app, motor, jefa=jefa, moderador=_moderador, price_model="on_request", price_minor=None, currency=None)
    cliente = await _persona(motor)
    inicio = (await _horarios(app, a_consultar, _dia(7)))[0]["starts_at"]
    r = await _retener(app, cliente, a_consultar, inicio)
    assert r.status_code == 409 and _codigo(r) == "service_booking_quote_required", r.text
    assert await _dinero(motor) == antes


# =========================================================================== #
# 3. Nadie resuelve su propia actuación
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.parametrize("parte", ["cliente", "perfil"])
async def test_quien_es_parte_de_la_reserva_no_resuelve_su_caso_aunque_administre(atencion, parte) -> None:  # noqa: F811
    """Ni quien contrató ni quien prestó, con el rol de administración."""
    app, motor, _ = atencion
    h = await _con_caso(app, motor)
    await _sembrar(motor, "update public.profiles set role = 'admin' where id = cast(:u as uuid)", u=h[parte])
    r = await _resolver(app, h[parte], h["caso"])
    assert r.status_code == 409 and _codigo(r) == "service_incident_resolver_conflict", r.text
    assert r.json()["error"]["details"] == {"reason": "party"}
    assert await _uno(motor, "select status from public.service_incidents where id = cast(:c as uuid)", c=h["caso"]) == "open"
    await _sembrar(motor, "update public.profiles set role = 'user' where id = cast(:u as uuid)", u=h[parte])
    # Otra persona de administración, sí.
    assert (await _resolver(app, h["jefa"], h["caso"], attention_effect="completed")).status_code == 200


@SIN_POSTGRES
async def test_quien_administra_no_aprueba_ni_publica_su_propio_servicio(reservas) -> None:  # noqa: F811
    """Cada paso de la revisión, no solo el primero: una administradora que
    además presta no revisa, no aprueba y no publica lo suyo."""
    app, motor, _ = reservas
    jefa, otra_jefa = await _persona(motor, "admin"), await _persona(motor, "admin")
    await _sembrar(
        motor,
        "insert into public.service_providers (profile_id, provider_type, display_name, country_code, status, "
        "activated_at) values (cast(:u as uuid), 'individual', 'Jefa', 'PE', 'active', now())", u=jefa,
    )
    r = await _crear(app, jefa, (await _categoria(app, otra_jefa))["id"])
    assert r.status_code == 201, r.text
    ficha = r.json()["id"]
    assert (await _editar(app, jefa, ficha, **{**CONTENIDO, "price_model": "free", "price_minor": None,
                                              "currency": None})).status_code == 200
    assert (await _imagen(app, jefa, ficha)).status_code == 201
    enviado = await _accion(app, jefa, f"{MIOS}/{ficha}/draft/submit")
    assert enviado.status_code == 200, enviado.text
    base = f"{BANDEJA}/{ficha}/versions/{enviado.json()['open_version']['id']}"

    async def _lo_suyo(paso: str) -> None:
        r = await _accion(app, jefa, f"{base}/{paso}")
        assert r.status_code == 403 and _codigo(r) == "service_self_review_forbidden", (paso, r.text)

    await _lo_suyo("start-review")
    assert (await _accion(app, otra_jefa, f"{base}/start-review")).status_code == 200
    await _lo_suyo("approve")
    assert (await _accion(app, otra_jefa, f"{base}/approve")).status_code == 200
    await _lo_suyo("publish")
    assert await _uno(motor, "select status from public.services where id = cast(:s as uuid)", s=ficha) == "draft"
    assert (await _accion(app, otra_jefa, f"{base}/publish")).status_code == 200


# =========================================================================== #
# 4. Los procesos sin planificador: a mano, por lotes, y sin tumbarse
# =========================================================================== #
@SIN_POSTGRES
async def test_una_retencion_que_falla_no_tumba_el_barrido_y_se_reintenta(reservas, monkeypatch) -> None:  # noqa: F811
    """El barrido de retenciones vence fila a fila: si una falla, se deshace
    ELLA SOLA (sigue activa y sin su línea), las demás se vencen, y la
    siguiente pasada la reintenta. Antes era una sola sentencia para el lote:
    un fallo en una fila deshacía todas y la ruta contestaba 500."""
    app, motor, _ = reservas
    _perfil, servicio, jefa, _moderador = await _servicio(app, motor)
    await _pedir(app, "POST", BARRIDO, jefa)  # lo que dejaron otras pruebas
    antes = await _dinero(motor)
    retenciones = []
    for dias in (7, 8, 9):
        inicio = (await _horarios(app, servicio, _dia(dias)))[0]["starts_at"]
        retenciones.append((await _retener(app, await _persona(motor), servicio, inicio)).json()["id"])
    for retencion in retenciones:
        await _vencer_ya(motor, retencion)
    rota = retenciones[1]
    original = reserva_dominio._anotar

    async def con_una_rota(db, **datos):
        if datos.get("retencion_id") == rota:
            raise RuntimeError("fallo a mitad, con la retención ya vencida en esta transacción")
        return await original(db, **datos)

    monkeypatch.setattr(reserva_dominio, "_anotar", con_una_rota)
    r = await _pedir(app, "POST", BARRIDO, jefa)
    assert r.status_code == 200 and r.json() == {"expired": 2}, r.text
    estados = dict(await _filas(motor, "select id::text, status from public.service_holds where id::text = any(:ids)",
                                ids=retenciones))
    assert estados == {retenciones[0]: "expired", rota: "active", retenciones[2]: "expired"}
    # La que falló NO quedó a medias: ni vencida ni con su línea en el historial.
    assert await _uno(motor, "select count(*) from public.service_booking_events where hold_id = cast(:h as uuid) "
                             "and action = 'hold_expired'", h=rota) == 0
    monkeypatch.setattr(reserva_dominio, "_anotar", original)
    assert (await _pedir(app, "POST", BARRIDO, jefa)).json() == {"expired": 1}
    assert (await _pedir(app, "POST", BARRIDO, jefa)).json() == {"expired": 0}
    assert await _uno(motor, "select count(*) from public.service_booking_events where hold_id = cast(:h as uuid) "
                             "and action = 'hold_expired'", h=rota) == 1
    # Ni un movimiento de dinero, y el lote tiene tope.
    assert await _dinero(motor) == antes
    assert (await _pedir(app, "POST", BARRIDO, jefa, batch=limites.LOTE_MAXIMO_DEL_BARRIDO + 1)).status_code == 422


@SIN_POSTGRES
async def test_un_recordatorio_que_falla_no_tumba_las_tareas_y_no_mueve_dinero(atencion, monkeypatch) -> None:  # noqa: F811
    """Lo mismo para los recordatorios: fila a fila, la que falla se cuenta en
    `skipped`, no deja su línea ni sus avisos, y la siguiente pasada la hace."""
    from app.modules.services import atencion as dominio

    app, motor, _ = atencion
    primera = await _reservado(app, motor)
    jefa = primera["jefa"]
    segunda = await _reservado(app, motor, jefa=jefa, moderador=primera["moderador"])
    await _pedir(app, "POST", TAREAS, jefa)
    antes = await _dinero(motor)
    for h in (primera, segunda):
        await _llevar(motor, h["reserva"]["id"], minutos=10 * 60)
    original = dominio._recordar

    async def con_una_rota(db, reserva_id, **kw):
        hecho = await original(db, reserva_id, **kw)
        if reserva_id == primera["reserva"]["id"]:
            raise RuntimeError("fallo a mitad, con el recordatorio ya escrito en esta transacción")
        return hecho

    monkeypatch.setattr(dominio, "_recordar", con_una_rota)
    r = await _pedir(app, "POST", TAREAS, jefa)
    assert r.status_code == 200 and (r.json()["reminded"], r.json()["skipped"]) == (1, 1), r.text
    assert "booking_reminded" not in await _sucesos(motor, primera["reserva"]["id"])
    assert (await _sucesos(motor, segunda["reserva"]["id"])).count("booking_reminded") == 1
    assert await _uno(motor, "select count(*) from public.notifications where entity_id = cast(:b as uuid) "
                             "and type like 'service_booking_reminder%'", b=primera["reserva"]["id"]) == 0
    monkeypatch.setattr(dominio, "_recordar", original)
    r = await _pedir(app, "POST", TAREAS, jefa)
    assert (r.json()["reminded"], r.json()["skipped"]) == (1, 0), r.text
    assert (await _pedir(app, "POST", TAREAS, jefa)).json()["reminded"] == 0
    for h in (primera, segunda):
        assert (await _sucesos(motor, h["reserva"]["id"])).count("booking_reminded") == 1
    assert await _dinero(motor) == antes
    # Solo administración las ejecuta, y el lote tiene tope.
    assert (await _pedir(app, "POST", TAREAS, primera["cliente"])).status_code == 403
    assert (await _pedir(app, "POST", TAREAS, jefa, batch=limites.LOTE_MAXIMO_DE_TAREAS + 1)).status_code == 422
