"""La política operativa de una reserva se congela al confirmarla (0095, G18).

LO QUE SE COMPRUEBA, y no es que un JSON no cambie: que EL COMPORTAMIENTO de
una reserva ya hecha no cambia cuando cambia la configuración.

1. POR LA API REAL, contra PostgreSQL: la reserva nace con la fotografía (y no
   la enseña); quien contrata no puede enviarla; un reintento no vuelve a leer
   la configuración; si la fotografía falla no queda nada a medias; y, con la
   POLÍTICA A al reservar y la B después, la reserva vieja sigue con A y la
   nueva recibe B en reprogramar, llegar, la tolerancia, el cierre automático,
   el caso, la apelación y la reseña. Lo que NO es de la reserva (el aviso
   previo y la moderación) sigue siendo de ahora.
2. LAS CARRERAS, con PostgreSQL de verdad: confirmar, reprogramar y barrer
   mientras la configuración cambia.
3. LA PUERTA: con la 0095 ausente, a medias o aflojada (una fotografía que
   podría entrar corrupta, sin huella, de otra versión o editarse), la reserva
   y la atención contestan 503 y no se escribe nada.

La fotografía y su lector, sin base, están en `test_servicios_atencion_reglas.py`.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.modules.services import esquema
from app.modules.services import reserva_politica as limites
from app.shared.database import get_db
from tests.test_baja_de_cuenta_postgres import SIN_POSTGRES, _filas, _persona, _uno
from tests.test_servicios_agenda_api import _codigo, _dia, _pedir
from tests.test_servicios_atencion_reglas import A, B, FOTO_A, FOTO_B, HUELLA_A, HUELLA_B, VERSION, _poner
from tests.test_servicios_atencion_api import (  # noqa: F401 - montajes compartidos
    DESCRIPCION,
    RESENA,
    TAREAS,
    _acciones,
    _atendida,
    _con_caso,
    _de,
    _hacer,
    _llevar,
    _otro_horario,
    _resolver,
    _retrasar,
    _sin_500,
    _sucesos,
    _ver,
    atencion,
)
from tests.test_servicios_descubrimiento_api import base_aplicada, entorno, mundo  # noqa: F401
from tests.test_servicios_reserva_api import (  # noqa: F401 - montajes compartidos
    _aceptando,
    _clave,
    _condiciones,
    _confirmar,
    _dinero,
    _horarios,
    _reservado,
    _resumen,
    _retener,
    _servicio,
    _siempre,
    reservas,
)

pytestmark = [SIN_POSTGRES, pytest.mark.asyncio]


# =========================================================================== #
# 1. Por la API real
# =========================================================================== #

async def _guardada(motor, reserva: str) -> tuple[dict | None, int | None, str | None]:
    foto, version, huella = (await _filas(
        motor, "select operating_policy::text, operating_policy_version, operating_policy_sha256 "
               "from public.service_bookings where id = cast(:b as uuid)", b=reserva))[0]
    return (json.loads(foto) if foto is not None else None), version, huella


def _momento(texto: str) -> datetime:
    return datetime.fromisoformat(texto.replace("Z", "+00:00"))


async def _plazos(app, h: dict) -> dict:
    return (await _ver(app, "client", h))["care"]["deadlines"]


async def _por_reservar(app, motor) -> dict:
    """Un servicio con sus condiciones y una persona con una retención viva."""
    perfil, servicio, jefa, moderador = await _servicio(app, motor)
    await _condiciones(app, jefa)
    cliente = await _persona(motor)
    inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
    r = await _retener(app, cliente, servicio, inicio)
    assert r.status_code == 201, r.text
    retencion = r.json()["id"]
    return {"perfil": perfil, "servicio": servicio, "jefa": jefa, "moderador": moderador, "cliente": cliente,
            "retencion": retencion, "cuerpo": _aceptando(await _resumen(app, cliente, retencion))}


async def _de_este_servicio(motor, servicio: str) -> dict:
    return {t: await _uno(motor, f"select count(*) from public.{t} where service_id = cast(:s as uuid)", s=servicio)
            for t in ("service_orders", "service_bookings")}


async def test_la_reserva_nace_con_la_politica_vigente_y_no_la_ensena(atencion) -> None:
    app, motor, _ = atencion
    h = await _reservado(app, motor)
    assert await _guardada(motor, h["reserva"]["id"]) == (FOTO_A, VERSION, HUELLA_A)
    # LA API NO ENSEÑA LA FOTOGRAFÍA: ni el JSON, ni sus claves, ni su huella.
    # Lo que la app necesita son los momentos que resultan de ella.
    for rol in ("client", "provider"):
        cuerpo = json.dumps(await _ver(app, rol, h))
        assert "operating_policy" not in cuerpo and HUELLA_A not in cuerpo
        for clave in limites.CAMPOS_CONGELADOS:
            assert clave not in cuerpo, clave
    assert sorted((await _plazos(app, h))) == [
        "absence_from", "appeal_until", "cancel_until", "cancellation_financial_effect", "checkin_opens_at",
        "incident_until", "reschedule_until", "reschedules_left", "review_until",
    ]


async def test_quien_contrata_no_puede_enviar_ni_alterar_la_politica(atencion) -> None:
    app, motor, _ = atencion
    p = await _por_reservar(app, motor)
    for intruso in (
        {"operating_policy": FOTO_B},
        {"operating_policy": FOTO_B, "operating_policy_version": VERSION, "operating_policy_sha256": HUELLA_B},
        {"operating_policy_sha256": HUELLA_B},
        {"policy": FOTO_B},
        {"booking_reschedule_min_hours": 0},
    ):
        r = await _confirmar(app, p["cliente"], p["retencion"], {**p["cuerpo"], **intruso})
        assert r.status_code == 422, (intruso, r.text)
    assert await _de_este_servicio(motor, p["servicio"]) == {"service_orders": 0, "service_bookings": 0}
    # Sin intrusos se confirma, con la del servidor.
    r = await _confirmar(app, p["cliente"], p["retencion"], p["cuerpo"])
    assert r.status_code == 201, r.text
    assert await _guardada(motor, r.json()["id"]) == (FOTO_A, VERSION, HUELLA_A)


async def test_un_reintento_devuelve_la_misma_reserva_y_no_vuelve_a_leer_la_configuracion(atencion, monkeypatch) -> None:
    app, motor, _ = atencion
    p = await _por_reservar(app, motor)
    clave = _clave()
    primera = await _confirmar(app, p["cliente"], p["retencion"], p["cuerpo"], clave=clave)
    assert primera.status_code == 201, primera.text
    reserva = primera.json()["id"]
    _poner(monkeypatch, B)
    for _ in range(2):
        otra = await _confirmar(app, p["cliente"], p["retencion"], p["cuerpo"], clave=clave)
        assert otra.status_code == 200 and otra.json()["id"] == reserva, otra.text
        assert otra.json()["care"]["deadlines"] == primera.json()["care"]["deadlines"]
    assert await _guardada(motor, reserva) == (FOTO_A, VERSION, HUELLA_A)
    assert await _de_este_servicio(motor, p["servicio"]) == {"service_orders": 1, "service_bookings": 1}


async def test_si_la_fotografia_falla_no_queda_una_reserva_a_medias(atencion, monkeypatch) -> None:
    """La fotografía se escribe con la reserva: si no se puede construir, o la
    base no la admite, no hay pedido, ni reserva, ni aceptación, ni historial,
    y el horario sigue apartado para quien lo tenía."""
    app, motor, _ = atencion
    p = await _por_reservar(app, motor)

    def _no_se_construye(self):  # noqa: ANN001, ANN202
        raise RuntimeError("no se pudo construir la fotografía")

    for nombre, sustituto in (
        ("fotografia", (limites.PoliticaDeAtencion, "fotografia", _no_se_construye)),
        # Una huella que no es la de la fotografía: la base la rechaza.
        ("huella", (limites, "huella_de_la_fotografia", lambda version, valores: "0" * 64)),
        # Y una fotografía con una clave que la base no conoce.
        ("clave", (limites.PoliticaDeAtencion, "fotografia", lambda self: {**FOTO_A, "cancellation_fee_percent": 50})),
    ):
        with monkeypatch.context() as m:
            m.setattr(*sustituto)
            try:
                r = await _confirmar(app, p["cliente"], p["retencion"], p["cuerpo"])
            except Exception as error:  # noqa: BLE001 - el fallo, tal cual sale del servidor
                assert "fotograf" in str(error) or "service_bookings_politica" in str(error), (nombre, error)
            else:
                assert r.status_code >= 500, (nombre, r.text)
        assert await _de_este_servicio(motor, p["servicio"]) == {"service_orders": 0, "service_bookings": 0}, nombre
        assert await _uno(motor, "select status from public.service_holds where id = cast(:h as uuid)",
                          h=p["retencion"]) == "active", nombre
        assert await _uno(motor, "select count(*) from public.service_booking_events where hold_id = cast(:h as uuid) "
                                 "and action = 'booking_confirmed'", h=p["retencion"]) == 0, nombre
        assert await _uno(motor, "select count(*) from public.service_booking_acceptances a join public.service_orders "
                                 "o on o.id = a.order_id where o.service_id = cast(:s as uuid)", s=p["servicio"]) == 0
    # Y después se contrata con normalidad.
    r = await _confirmar(app, p["cliente"], p["retencion"], p["cuerpo"])
    assert r.status_code == 201, r.text
    assert await _guardada(motor, r.json()["id"]) == (FOTO_A, VERSION, HUELLA_A)


async def test_cambiar_la_configuracion_no_cambia_una_reserva_hecha(atencion, monkeypatch) -> None:
    """LA PRUEBA CENTRAL. Con la política A se confirma una reserva; la
    empresa pasa a la B; se confirma otra. Cada una se rige por la suya, con
    huellas distintas, y volver a A tampoco cambia a la segunda."""
    app, motor, _ = atencion
    antes = await _dinero(motor)
    vieja = await _reservado(app, motor)
    _poner(monkeypatch, B)
    nueva = await _reservado(app, motor)
    assert await _guardada(motor, vieja["reserva"]["id"]) == (FOTO_A, VERSION, HUELLA_A)
    assert await _guardada(motor, nueva["reserva"]["id"]) == (FOTO_B, VERSION, HUELLA_B)
    assert HUELLA_A != HUELLA_B

    async def _comprobar() -> None:
        for h, p in ((vieja, A), (nueva, B)):
            detalle = await _ver(app, "client", h)
            inicio, fin, plazos = _momento(detalle["starts_at"]), _momento(detalle["ends_at"]), detalle["care"]["deadlines"]
            assert _momento(plazos["reschedule_until"]) == inicio - timedelta(
                hours=p["services_booking_reschedule_min_hours"])
            assert plazos["reschedules_left"] == p["services_booking_reschedule_max"]
            assert _momento(plazos["checkin_opens_at"]) == inicio - timedelta(
                minutes=p["services_attention_checkin_minutes"])
            assert _momento(plazos["absence_from"]) == inicio + timedelta(
                minutes=p["services_attention_tolerance_minutes"])
            assert _momento(plazos["incident_until"]) == fin + timedelta(hours=p["services_incident_window_hours"])
            # Cancelar no tiene plazo configurable: hasta la hora, en las dos.
            assert _momento(plazos["cancel_until"]) == inicio
            assert plazos["cancellation_financial_effect"] == "not_applicable"
            # El prestador ve lo mismo.
            assert (await _ver(app, "provider", h))["care"]["deadlines"] == plazos

    await _comprobar()
    # Ni volviendo a A, ni con cualquier otra cosa.
    _poner(monkeypatch, A)
    await _comprobar()
    _poner(monkeypatch, {ajuste: 0 for ajuste in A})
    await _comprobar()
    assert await _guardada(motor, vieja["reserva"]["id"]) == (FOTO_A, VERSION, HUELLA_A)
    assert await _guardada(motor, nueva["reserva"]["id"]) == (FOTO_B, VERSION, HUELLA_B)
    # Y nada de esto movió dinero.
    assert await _dinero(motor) == antes


async def test_reprogramar_usa_la_antelacion_y_el_tope_de_la_reserva(atencion, monkeypatch) -> None:
    app, motor, _ = atencion
    # CONFIRMADA CON 24 HORAS Y UN CAMBIO: a 23 horas ya no se mueve, aunque después baste con 2.
    vieja = await _reservado(app, motor)
    _poner(monkeypatch, {**A, "services_booking_reschedule_min_hours": 2, "services_booking_reschedule_max": 2})
    nueva = await _reservado(app, motor)
    destino, _ = await _otro_horario(app, vieja)
    await _llevar(motor, vieja["reserva"]["id"], minutos=23 * 60)
    assert "reschedule" not in await _acciones(app, "client", vieja)
    r = await _hacer(app, "client", vieja, "reschedule", {"hold_id": destino})
    assert r.status_code == 409 and _codigo(r) == "service_booking_reschedule_too_late", r.text
    assert r.json()["error"]["details"] == {"hours": 24}

    # CONFIRMADA CON 2 HORAS Y DOS CAMBIOS: a 23 horas se mueve, y dos veces,
    # aunque la configuración vuelva a pedir 24 horas y a dejar uno.
    _poner(monkeypatch, A)
    await _llevar(motor, nueva["reserva"]["id"], minutos=23 * 60)
    for dias in (9, 10):
        assert "reschedule" in await _acciones(app, "client", nueva)
        destino, _ = await _otro_horario(app, nueva, dias=dias)
        r = await _hacer(app, "client", nueva, "reschedule", {"hold_id": destino})
        assert r.status_code == 200, r.text
    assert "reschedule" not in await _acciones(app, "client", nueva)
    destino, _ = await _otro_horario(app, nueva, dias=11)
    r = await _hacer(app, "client", nueva, "reschedule", {"hold_id": destino})
    assert r.status_code == 409 and _codigo(r) == "service_booking_reschedule_limit", r.text
    assert r.json()["error"]["details"] == {"max": 2}
    # Reprogramar no toca la fotografía.
    foto, _version, _huella = await _guardada(motor, nueva["reserva"]["id"])
    assert (foto["booking_reschedule_min_hours"], foto["booking_reschedule_max"]) == (2, 2)


async def test_la_llegada_y_la_tolerancia_son_las_de_la_reserva(atencion, monkeypatch) -> None:
    app, motor, _ = atencion
    vieja = await _reservado(app, motor)       # llegada 15 min antes, tolerancia 15
    _poner(monkeypatch, B)                      # ahora: llegada 120 antes, tolerancia 60
    nueva = await _reservado(app, motor)
    _poner(monkeypatch, A)
    # A 30 MINUTOS DE EMPEZAR: la vieja todavía no abre la llegada; la nueva, sí.
    for h in (vieja, nueva):
        await _llevar(motor, h["reserva"]["id"], minutos=30)
    _poner(monkeypatch, B)
    assert "issue_code" not in await _acciones(app, "client", vieja)
    assert "start" not in await _acciones(app, "provider", vieja)
    r = await _hacer(app, "client", vieja, "check-in-code")
    assert r.status_code == 409 and _codigo(r) == "service_attention_not_in_window", r.text
    r = await _hacer(app, "provider", vieja, "start", {})
    assert r.status_code == 409 and _codigo(r) == "service_attention_not_in_window", r.text
    _poner(monkeypatch, A)
    assert "issue_code" in await _acciones(app, "client", nueva)
    assert (await _hacer(app, "client", nueva, "check-in-code")).status_code == 200
    # A LOS 20 MINUTOS DE LA HORA: en la vieja ya se puede decir que no vino; en la nueva, todavía no.
    for h in (vieja, nueva):
        await _llevar(motor, h["reserva"]["id"], minutos=-20)
    _poner(monkeypatch, B)
    assert "report_absence" in await _acciones(app, "client", vieja)
    assert (await _hacer(app, "client", vieja, "no-show")).status_code == 200
    _poner(monkeypatch, A)
    assert "report_absence" not in await _acciones(app, "provider", nueva)
    r = await _hacer(app, "provider", nueva, "no-show")
    assert r.status_code == 409 and _codigo(r) == "service_attention_not_in_window", r.text


async def test_el_cierre_automatico_espera_el_plazo_de_cada_reserva(atencion, monkeypatch) -> None:
    app, motor, _ = atencion
    vieja = await _atendida(app, motor, hasta="completed")                       # 24 horas para confirmar
    equipo = {"jefa": vieja["jefa"], "moderador": vieja["moderador"]}
    vieja_sin_codigo = await _atendida(app, motor, con_codigo=False, hasta="completed", **equipo)
    _poner(monkeypatch, B)                                                        # ahora, 1 hora
    nueva = await _atendida(app, motor, hasta="completed", **equipo)
    nueva_sin_codigo = await _atendida(app, motor, con_codigo=False, hasta="completed", **equipo)
    sin_verificar = (await _pedir(app, "POST", TAREAS, vieja["jefa"])).json()["unverified"]
    # TODAS TERMINARON HACE DOS HORAS.
    for h in (vieja, vieja_sin_codigo, nueva, nueva_sin_codigo):
        await _retrasar(motor, "service_attendances", "completed_at", "booking_id", h["reserva"]["id"], horas=2)

    async def _estado(h: dict) -> tuple[str, str | None]:
        a = (await _ver(app, "client", h))["care"]["attendance"]
        return a["status"], a["closed_by"]

    # CON LA CONFIGURACIÓN EN 1 HORA: la nueva se cierra; la vieja espera sus 24.
    r = await _pedir(app, "POST", TAREAS, vieja["jefa"])
    assert r.status_code == 200, r.text
    assert await _estado(nueva) == ("closed", "system") and await _estado(vieja) == ("completed", None)
    # Sin la señal fuerte no se cierra ninguna; se cuenta la que ya venció POR SU PLAZO.
    assert r.json()["unverified"] == sin_verificar + 1
    # CON LA CONFIGURACIÓN EN 24 HORAS, lo mismo: nada depende de ella.
    _poner(monkeypatch, A)
    r = await _pedir(app, "POST", TAREAS, vieja["jefa"])
    assert await _estado(vieja) == ("completed", None) and r.json()["unverified"] == sin_verificar + 1
    # Y cuando pasan las 24 horas de la vieja, se cierra, esté como esté la configuración.
    _poner(monkeypatch, {**A, "services_attention_confirmation_hours": 720})
    for h in (vieja, vieja_sin_codigo):
        await _retrasar(motor, "service_attendances", "completed_at", "booking_id", h["reserva"]["id"], horas=25)
    r = await _pedir(app, "POST", TAREAS, vieja["jefa"])
    assert await _estado(vieja) == ("closed", "system")
    assert r.json()["unverified"] == sin_verificar + 2
    for h in (vieja, nueva):
        assert (await _sucesos(motor, h["reserva"]["id"])).count("attendance_closed") == 1


async def test_el_plazo_del_caso_es_el_de_la_reserva(atencion, monkeypatch) -> None:
    app, motor, _ = atencion
    vieja = await _atendida(app, motor, hasta="completed")      # 48 horas para abrir un caso
    _poner(monkeypatch, B)                                       # ahora, 1 hora
    nueva = await _atendida(app, motor, hasta="completed", jefa=vieja["jefa"], moderador=vieja["moderador"])
    # LAS DOS TERMINARON HACE TRES HORAS.
    for h in (vieja, nueva):
        await _llevar(motor, h["reserva"]["id"], minutos=-4 * 60)
        await _retrasar(motor, "service_attendances", "completed_at", "booking_id", h["reserva"]["id"], horas=3)
    cuerpo = {"reason": "quality", "description": DESCRIPCION}
    # La vieja sigue dentro de sus 48 horas, aunque ahora sea 1.
    assert "quality" in (await _ver(app, "client", vieja))["care"]["incident_reasons"]
    assert (await _hacer(app, "client", vieja, "incident", cuerpo)).status_code == 201
    # La nueva agotó su hora, aunque ahora vuelvan a ser 48: solo queda el motivo de seguridad.
    _poner(monkeypatch, A)
    assert (await _ver(app, "client", nueva))["care"]["incident_reasons"] == ["safety"]
    r = await _hacer(app, "client", nueva, "incident", cuerpo)
    assert r.status_code == 409 and _codigo(r) == "service_incident_window_closed", r.text


async def test_el_plazo_para_apelar_es_el_de_la_reserva(atencion, monkeypatch) -> None:
    app, motor, _ = atencion
    cuerpo = {"body": "No estoy de acuerdo con la decisión tomada."}
    vieja = await _con_caso(app, motor)                                           # cinco días para apelar
    await _persona(motor, "admin")
    _poner(monkeypatch, {**A, "services_incident_appeal_days": 1})                # ahora, uno
    nueva = await _con_caso(app, motor)
    for h in (vieja, nueva):
        assert (await _resolver(app, h["jefa"], h["caso"])).status_code == 200
        # RESUELTO HACE DOS DÍAS.
        await _retrasar(motor, "service_incidents", "resolved_at", "id", h["caso"], horas=48)
    resuelto = {h["caso"]: await _uno(motor, "select resolved_at from public.service_incidents "
                                             "where id = cast(:c as uuid)", c=h["caso"]) for h in (vieja, nueva)}

    async def _hasta(h: dict) -> datetime:
        ruta, quien = _de("client", h)
        return _momento((await _pedir(app, "GET", f"{ruta}/incident", quien)).json()["appeal_until"])

    # La vieja sigue dentro de sus cinco días, aunque ahora sea uno.
    assert await _hasta(vieja) == resuelto[vieja["caso"]] + timedelta(days=5)
    assert "appeal_incident" in await _acciones(app, "client", vieja)
    assert (await _hacer(app, "client", vieja, "incident/appeal", cuerpo)).status_code == 200
    # La nueva agotó su día, aunque ahora vuelvan a ser cinco.
    _poner(monkeypatch, A)
    assert await _hasta(nueva) == resuelto[nueva["caso"]] + timedelta(days=1)
    assert "appeal_incident" not in await _acciones(app, "client", nueva)
    r = await _hacer(app, "client", nueva, "incident/appeal", cuerpo)
    assert r.status_code == 409 and _codigo(r) == "service_incident_appeal_not_allowed", r.text


async def test_la_ventana_de_la_resena_es_la_de_la_reserva(atencion, monkeypatch) -> None:
    app, motor, _ = atencion
    vieja = await _atendida(app, motor)                         # 30 días para reseñar
    _poner(monkeypatch, B)                                       # ahora, uno
    nueva = await _atendida(app, motor, jefa=vieja["jefa"], moderador=vieja["moderador"])
    # LAS DOS SE CERRARON HACE DOS DÍAS.
    for h in (vieja, nueva):
        await _retrasar(motor, "service_attendances", "closed_at", "booking_id", h["reserva"]["id"], horas=48)
    assert "review" in await _acciones(app, "client", vieja)
    assert (await _hacer(app, "client", vieja, "review", RESENA)).status_code == 201
    _poner(monkeypatch, A)
    assert "review" not in await _acciones(app, "client", nueva)
    r = await _hacer(app, "client", nueva, "review", RESENA)
    assert r.status_code == 409 and _codigo(r) == "service_review_not_allowed", r.text


async def test_cancelar_no_depende_de_ningun_plazo_de_la_configuracion(atencion, monkeypatch) -> None:
    """Cancelar NO TIENE plazo configurable: se cancela hasta la hora de
    inicio, sin coste (no hay dinero). No hay nada que congelar, y por eso
    ninguna configuración lo cambia. Cuando la empresa decida plazos de
    cancelación, entrarán en la fotografía con otra versión."""
    app, motor, _ = atencion
    antes = await _dinero(motor)
    h = await _reservado(app, motor)
    for politica in (B, {ajuste: 0 for ajuste in A}, {ajuste: 10 ** 6 for ajuste in A}, A):
        _poner(monkeypatch, politica)
        await _llevar(motor, h["reserva"]["id"], minutos=2)
        assert "cancel" in await _acciones(app, "client", h)
        assert "cancel" in await _acciones(app, "provider", h)
        plazos = await _plazos(app, h)
        assert plazos["cancel_until"] == (await _ver(app, "client", h))["starts_at"]
        assert plazos["cancellation_financial_effect"] == "not_applicable"
    _poner(monkeypatch, B)
    r = await _hacer(app, "client", h, "cancel", {})
    assert r.status_code == 200 and r.json()["status"] == "cancelled", r.text
    assert await _guardada(motor, h["reserva"]["id"]) == (FOTO_A, VERSION, HUELLA_A)
    assert await _dinero(motor) == antes


async def test_lo_que_no_es_de_la_reserva_sigue_siendo_de_ahora(reservas, monkeypatch) -> None:  # noqa: F811
    """NO SE CONGELAN, a propósito: con cuánta antelación se recuerda (un
    aviso, no un plazo de nadie) y si una reseña nueva espera a moderación (es
    de la moderación de Z, y tiene que valer para toda reseña que se escribe)."""
    app, motor, _ = reservas
    monkeypatch.setattr(get_settings(), "services_reviews_premoderation", False)
    h = await _atendida(app, motor)
    por_venir = await _reservado(app, motor, jefa=h["jefa"], moderador=h["moderador"])
    await _llevar(motor, por_venir["reserva"]["id"], minutos=30 * 60)
    # Con el aviso a 24 horas, una reserva a 30 no se recuerda todavía; a 48, sí.
    await _pedir(app, "POST", TAREAS, h["jefa"])
    assert "booking_reminded" not in await _sucesos(motor, por_venir["reserva"]["id"])
    monkeypatch.setattr(get_settings(), "services_booking_reminder_hours", 48)
    await _pedir(app, "POST", TAREAS, h["jefa"])
    assert (await _sucesos(motor, por_venir["reserva"]["id"])).count("booking_reminded") == 1
    # La moderación previa, encendida DESPUÉS de reservar, vale para la reseña que se escribe ahora.
    monkeypatch.setattr(get_settings(), "services_reviews_premoderation", True)
    r = await _hacer(app, "client", h, "review", RESENA)
    assert r.status_code == 201 and r.json()["care"]["review"]["status"] == "pending", r.text
    # Y ninguna de las dos está en la fotografía.
    foto, _version, _huella = await _guardada(motor, h["reserva"]["id"])
    assert foto == FOTO_A


async def test_una_reserva_anterior_a_la_0095_se_trata_como_tal(atencion, monkeypatch) -> None:
    """Sin fotografía (así quedan las que existan al aplicar la 0095) la
    reserva se rige por la política vigente, como hasta ahora, y sigue
    funcionando. No se le inventa ni se le escribe una."""
    app, motor, _ = atencion
    h = await _reservado(app, motor)
    reserva = h["reserva"]["id"]
    async with motor.begin() as conexion:
        await conexion.execute(text("set local session_replication_role = replica"))
        await conexion.execute(text(
            "update public.service_bookings set operating_policy = null, operating_policy_version = null, "
            "operating_policy_sha256 = null where id = cast(:b as uuid)"), {"b": reserva})
    inicio = _momento((await _ver(app, "client", h))["starts_at"])
    assert _momento((await _plazos(app, h))["reschedule_until"]) == inicio - timedelta(hours=24)
    _poner(monkeypatch, B)
    plazos = await _plazos(app, h)
    assert _momento(plazos["reschedule_until"]) == inicio - timedelta(hours=2) and plazos["reschedules_left"] == 3
    # Sigue pudiendo reprogramarse y cancelarse; y sigue sin fotografía.
    destino, _ = await _otro_horario(app, h)
    assert (await _hacer(app, "client", h, "reschedule", {"hold_id": destino})).status_code == 200
    assert (await _hacer(app, "client", h, "cancel", {})).status_code == 200
    assert await _guardada(motor, reserva) == (None, None, None)

    # EL BARRIDO también la cierra con el plazo vigente: terminada hace dos
    # horas, con 24 no; con 1, sí.
    _poner(monkeypatch, A)
    atendida = await _atendida(app, motor, hasta="completed", jefa=h["jefa"], moderador=h["moderador"])
    async with motor.begin() as conexion:
        await conexion.execute(text("set local session_replication_role = replica"))
        await conexion.execute(text(
            "update public.service_bookings set operating_policy = null, operating_policy_version = null, "
            "operating_policy_sha256 = null where id = cast(:b as uuid)"), {"b": atendida["reserva"]["id"]})
    await _retrasar(motor, "service_attendances", "completed_at", "booking_id", atendida["reserva"]["id"], horas=2)
    await _pedir(app, "POST", TAREAS, h["jefa"])
    assert (await _ver(app, "client", atendida))["care"]["attendance"]["status"] == "completed"
    _poner(monkeypatch, B)
    assert (await _pedir(app, "POST", TAREAS, h["jefa"])).status_code == 200
    assert (await _ver(app, "client", atendida))["care"]["attendance"]["closed_by"] == "system"


async def test_con_la_fotografia_manipulada_no_se_hace_nada_ni_se_adopta_la_vigente(atencion, monkeypatch) -> None:
    """Una fotografía tocada no puede existir en una base con la 0095 (lo
    impiden sus CHECK y el disparador). Aquí se fabrica una, quitando esas
    protecciones dentro de una transacción que no se confirma, para ver qué
    hace la API: 409 en todo, sin escribir nada y sin pasar a la política de
    ahora. El barrido tampoco la cierra."""
    app, motor, _ = atencion
    h = await _atendida(app, motor, hasta="completed")
    reserva = h["reserva"]["id"]
    # Empezó hace dos horas y terminó hace treinta: nada que recordar, y vencida para cerrarse.
    await _llevar(motor, reserva, minutos=-120)
    await _retrasar(motor, "service_attendances", "completed_at", "booking_id", reserva, horas=30)
    assert (await _ver(app, "client", h))["care"]["available_actions"]  # las puertas ya dijeron que sí
    _poner(monkeypatch, B)
    normal = app.dependency_overrides[get_db]
    try:
        async with motor.connect() as conexion:
            transaccion = await conexion.begin()
            sesion = AsyncSession(bind=conexion, expire_on_commit=False, join_transaction_mode="create_savepoint")
            app.dependency_overrides[get_db] = _siempre(sesion)
            try:
                for sql in (
                    "alter table public.service_bookings drop constraint service_bookings_politica_huella",
                    "set local session_replication_role = replica",
                    "update public.service_bookings set operating_policy = jsonb_set(operating_policy, "
                    "'{attention_confirmation_hours}', '1') where id = cast(:b as uuid)",
                    "set local session_replication_role = origin",
                ):
                    await conexion.execute(text(sql), {"b": reserva} if ":b" in sql else {})
                sucesos = await _sucesos(motor, reserva)
                for rol in ("client", "provider"):
                    ruta, quien = _de(rol, h)
                    r = await _pedir(app, "GET", ruta, quien)
                    assert (r.status_code, _codigo(r)) == (409, "service_booking_action_not_available"), r.text
                    assert r.json()["error"]["details"] == {"reason": "operating_policy"}
                for rol, accion, cuerpo in (("client", "confirm", None), ("client", "incident",
                                                                         {"reason": "quality", "description": DESCRIPCION}),
                                            ("provider", "no-show", None)):
                    r = await _hacer(app, rol, h, accion, cuerpo)
                    assert (r.status_code, _codigo(r)) == (409, "service_booking_action_not_available"), (accion, r.text)
                # EL BARRIDO la salta (y lo dice), en vez de cerrarla con el plazo que alguien escribió.
                r = await _pedir(app, "POST", TAREAS, h["jefa"])
                assert r.status_code == 200 and r.json()["skipped"] >= 1, r.text
                estado = (await conexion.execute(text(
                    "select status from public.service_attendances where booking_id = cast(:b as uuid)"),
                    {"b": reserva})).scalar()
                assert estado == "completed"
                assert [f[0] for f in (await conexion.execute(text(
                    "select action from public.service_booking_events where booking_id = cast(:b as uuid) "
                    "order by created_at, id"), {"b": reserva})).all()] == sucesos
            finally:
                app.dependency_overrides[get_db] = normal
                await sesion.close()
                await transaccion.rollback()
                esquema.olvidar()
    finally:
        app.dependency_overrides[get_db] = normal
    # De vuelta a la base de verdad, la reserva sigue intacta y con la suya.
    assert await _guardada(motor, reserva) == (FOTO_A, VERSION, HUELLA_A)
    assert "confirm" in await _acciones(app, "client", h)


# =========================================================================== #
# 2. Las carreras: mientras la configuración cambia
# =========================================================================== #
async def _cambiando(veces: int = 400) -> None:
    """La empresa cambia la configuración, de A a B y vuelta, sin parar."""
    ajustes = get_settings()
    try:
        for vuelta in range(veces):
            for ajuste, valor in (B if vuelta % 2 == 0 else A).items():
                setattr(ajustes, ajuste, valor)
            await asyncio.sleep(0)
    finally:
        for ajuste, valor in A.items():
            setattr(ajustes, ajuste, valor)


def _entera(guardada: tuple) -> bool:
    """La fotografía es TODA la A o TODA la B: nunca una mezcla."""
    return guardada in ((FOTO_A, VERSION, HUELLA_A), (FOTO_B, VERSION, HUELLA_B))


async def test_confirmar_a_la_vez_y_con_la_misma_clave_deja_una_reserva_con_una_fotografia(atencion) -> None:
    app, motor, _ = atencion
    p = await _por_reservar(app, motor)
    clave = _clave()
    *respuestas, _ = await asyncio.gather(
        *(_confirmar(app, p["cliente"], p["retencion"], p["cuerpo"], clave=clave) for _ in range(4)),
        *(_confirmar(app, p["cliente"], p["retencion"], p["cuerpo"]) for _ in range(3)),
        _cambiando(),
    )
    _sin_500(*respuestas)
    assert sum(1 for r in respuestas if r.status_code == 201) == 1, [r.text for r in respuestas]
    buenas = [r for r in respuestas if r.status_code in (200, 201)]
    assert len({r.json()["id"] for r in buenas}) == 1
    # Las repeticiones devuelven LOS MISMOS plazos que la primera: no se recalcula nada.
    assert len({json.dumps(r.json()["care"]["deadlines"], sort_keys=True) for r in buenas}) == 1
    assert await _de_este_servicio(motor, p["servicio"]) == {"service_orders": 1, "service_bookings": 1}
    assert _entera(await _guardada(motor, buenas[0].json()["id"]))


async def test_confirmar_mientras_cambia_la_configuracion_no_mezcla_politicas(atencion) -> None:
    """Varias personas confirman a la vez mientras la configuración salta
    entre A y B. Cada reserva queda con UNA política entera, la que valía en
    su instante, y su huella es la de esa."""
    app, motor, _ = atencion
    _, servicio, jefa, _ = await _servicio(app, motor)
    await _condiciones(app, jefa)
    pendientes = []
    for dia in range(7, 13):
        cliente = await _persona(motor)
        inicio = (await _horarios(app, servicio, _dia(dia)))[0]["starts_at"]
        retencion = (await _retener(app, cliente, servicio, inicio)).json()["id"]
        pendientes.append((cliente, retencion, _aceptando(await _resumen(app, cliente, retencion))))
    *respuestas, _ = await asyncio.gather(
        *(_confirmar(app, cliente, retencion, cuerpo) for cliente, retencion, cuerpo in pendientes), _cambiando())
    assert [r.status_code for r in respuestas] == [201] * 6, [r.text for r in respuestas]
    guardadas = [await _guardada(motor, r.json()["id"]) for r in respuestas]
    assert all(_entera(g) for g in guardadas), guardadas
    # Y cada respuesta enseña los plazos de SU fotografía.
    for r, (foto, _version, _huella) in zip(respuestas, guardadas):
        cuerpo = r.json()
        assert _momento(cuerpo["care"]["deadlines"]["reschedule_until"]) == _momento(cuerpo["starts_at"]) - timedelta(
            hours=foto["booking_reschedule_min_hours"])
        assert cuerpo["care"]["deadlines"]["reschedules_left"] == foto["booking_reschedule_max"]


async def test_reprogramar_mientras_cambia_la_configuracion_decide_con_la_de_la_reserva(atencion, monkeypatch) -> None:
    app, motor, _ = atencion
    vieja = await _reservado(app, motor)                         # 24 horas de antelación
    _poner(monkeypatch, B)
    nueva = await _reservado(app, motor)                         # 2 horas
    _poner(monkeypatch, A)
    destino_vieja, _ = await _otro_horario(app, vieja)
    destino_nueva, _ = await _otro_horario(app, nueva)
    for h in (vieja, nueva):
        await _llevar(motor, h["reserva"]["id"], minutos=23 * 60)
    original = (await _ver(app, "client", vieja))["starts_at"]
    *respuestas, _ = await asyncio.gather(
        *(_hacer(app, "client", vieja, "reschedule", {"hold_id": destino_vieja}) for _ in range(3)),
        *(_hacer(app, "client", nueva, "reschedule", {"hold_id": destino_nueva}) for _ in range(3)),
        _cambiando(),
    )
    _sin_500(*respuestas)
    # LA VIEJA no se mueve en ningún instante: ni cuando la configuración decía 2 horas.
    assert [(r.status_code, _codigo(r)) for r in respuestas[:3]] == [
        (409, "service_booking_reschedule_too_late")] * 3, [r.text for r in respuestas[:3]]
    assert (await _ver(app, "client", vieja))["starts_at"] == original
    # LA NUEVA se mueve una vez: ni cuando la configuración decía 24.
    assert sum(1 for r in respuestas[3:] if r.status_code == 200) == 1, [r.text for r in respuestas[3:]]
    assert {_codigo(r) for r in respuestas[3:] if r.status_code != 200} <= {
        "service_hold_already_consumed", "service_hold_not_found"}, [r.text for r in respuestas[3:]]
    assert (await _sucesos(motor, nueva["reserva"]["id"])).count("booking_rescheduled") == 1
    assert await _guardada(motor, vieja["reserva"]["id"]) == (FOTO_A, VERSION, HUELLA_A)
    assert await _guardada(motor, nueva["reserva"]["id"]) == (FOTO_B, VERSION, HUELLA_B)


async def test_el_barrido_mientras_cambia_la_configuracion_cierra_solo_lo_que_toca(atencion, monkeypatch) -> None:
    app, motor, _ = atencion
    vieja = await _atendida(app, motor, hasta="completed")                       # 24 horas
    _poner(monkeypatch, B)
    nueva = await _atendida(app, motor, hasta="completed", jefa=vieja["jefa"], moderador=vieja["moderador"])  # 1 hora
    _poner(monkeypatch, A)
    for h in (vieja, nueva):
        await _retrasar(motor, "service_attendances", "completed_at", "booking_id", h["reserva"]["id"], horas=2)
    *respuestas, _ = await asyncio.gather(*(_pedir(app, "POST", TAREAS, vieja["jefa"]) for _ in range(4)), _cambiando())
    _sin_500(*respuestas)
    assert all(r.status_code == 200 for r in respuestas)
    estados = {}
    for nombre, h in (("vieja", vieja), ("nueva", nueva)):
        estados[nombre] = (await _ver(app, "client", h))["care"]["attendance"]["status"]
    assert estados == {"vieja": "completed", "nueva": "closed"}
    assert (await _sucesos(motor, nueva["reserva"]["id"])).count("attendance_closed") == 1
    assert "attendance_closed" not in await _sucesos(motor, vieja["reserva"]["id"])


# =========================================================================== #
# 3. La puerta: sin la 0095 entera, la reserva espera
# =========================================================================== #
_R = "public.service_bookings"
_VACIA = ("create or replace function public.{}() returns trigger language plpgsql "
          "set search_path = public, pg_temp as $$ begin return new; end; $$")

#: CADA FORMA de que la 0095 falte, esté a medias o esté aflojada.
ALTERACIONES_DE_LA_0095 = (
    # Sin la fotografía, sin su versión o SIN SU HUELLA.
    (f"alter table {_R} drop column operating_policy cascade",),
    (f"alter table {_R} drop column operating_policy_version cascade",),
    (f"alter table {_R} drop column operating_policy_sha256 cascade",),
    # Con otro tipo, con una columna de más o con un valor predeterminado (lo nuevo entraría sin traerla).
    (f"alter table {_R} alter column operating_policy_version type bigint",),
    (f"alter table {_R} add column operating_policy_note text",),
    (f"alter table {_R} alter column operating_policy set default '{{}}'::jsonb",),
    (f"alter table {_R} alter column operating_policy_version set default 1",),
    # UNA FOTOGRAFÍA CORRUPTA podría entrar: sin el CHECK de su forma, o aflojado.
    (f"alter table {_R} drop constraint service_bookings_politica_forma",),
    (f"alter table {_R} drop constraint service_bookings_politica_forma",
     f"alter table {_R} add constraint service_bookings_politica_forma "
     "check (operating_policy is null or jsonb_typeof(operating_policy) = 'object')"),
    # SIN COMPROBAR LA HUELLA, o solo su formato.
    (f"alter table {_R} drop constraint service_bookings_politica_huella",),
    (f"alter table {_R} drop constraint service_bookings_politica_huella",
     f"alter table {_R} add constraint service_bookings_politica_huella "
     "check (operating_policy_sha256 is null or length(operating_policy_sha256) = 64)"),
    # UNA VERSIÓN que el código no conoce, o sin validar.
    (f"alter table {_R} drop constraint service_bookings_politica_version",),
    (f"alter table {_R} drop constraint service_bookings_politica_version",
     f"alter table {_R} add constraint service_bookings_politica_version "
     "check (operating_policy_version is null or operating_policy_version in (1, 2))"),
    (f"alter table {_R} drop constraint service_bookings_politica_version",
     f"alter table {_R} add constraint service_bookings_politica_version "
     "check (operating_policy_version is null or operating_policy_version = 1) not valid"),
    # A medias.
    (f"alter table {_R} drop constraint service_bookings_politica_completa",),
    # LA FOTOGRAFÍA SE PODRÍA EDITAR: sin el disparador de la reserva, apagado o con otro cuerpo.
    (f"drop trigger service_bookings_inmutables on {_R}",),
    (f"alter table {_R} disable trigger service_bookings_inmutables",),
    (_VACIA.format("servicios_reserva_inmutable"),),
    # UNA RESERVA PODRÍA NACER SIN ELLA: sin su disparador, apagado, de otra forma o con otro cuerpo.
    (f"drop trigger service_bookings_con_politica on {_R}",),
    (f"alter table {_R} disable trigger service_bookings_con_politica",),
    (f"drop trigger service_bookings_con_politica on {_R}",
     f"create trigger service_bookings_con_politica before update on {_R} for each row "
     "execute function public.servicios_reserva_con_politica()"),
    (_VACIA.format("servicios_reserva_con_politica"),),
    ("alter function public.servicios_reserva_con_politica() security definer",),
    # Cerrada: nadie de fuera, tampoco por columna ni por la función.
    ("grant execute on function public.servicios_reserva_con_politica() to authenticated",),
    (f"grant select (operating_policy) on {_R} to authenticated",),
    (f"grant update (operating_policy) on {_R} to anon",),
)


async def _puertas(motor, *cambios: str) -> tuple[bool, bool]:
    """`(la reserva, la atención)` con esos cambios, sin confirmarlos."""
    esquema.olvidar()
    async with motor.connect() as conexion:
        transaccion = await conexion.begin()
        try:
            for sql in cambios:
                await conexion.execute(text(sql))
            sesion = AsyncSession(bind=conexion)
            try:
                return await esquema.hay_reservas(sesion), await esquema.hay_atencion(sesion)
            finally:
                await sesion.close()
        finally:
            await transaccion.rollback()
            esquema.olvidar()


async def test_la_puerta_mira_todo_lo_que_la_0095_tiene_que_dejar(atencion) -> None:
    _, motor, _ = atencion
    assert await _puertas(motor) == (True, True)
    abiertas = [c for c in ALTERACIONES_DE_LA_0095 if await _puertas(motor, *c) != (False, False)]
    assert abiertas == []
    # Lo que no afloja nada no la cierra.
    assert await _puertas(motor, f"grant all on {_R} to service_role") == (True, True)
    assert await _puertas(motor, f"comment on column {_R}.operating_policy is 'La política congelada'") == (True, True)


async def test_con_la_0095_alterada_todo_contesta_503_no_se_escribe_nada_y_no_se_recuerda(atencion) -> None:
    app, motor, _ = atencion
    h = await _reservado(app, motor)
    p = await _por_reservar(app, motor)
    ruta, quien = _de("client", h)
    cuentas = ("select (select count(*) from public.service_bookings), (select count(*) from public.service_orders), "
               "(select count(*) from public.service_booking_events)")
    normal = app.dependency_overrides[get_db]
    try:
        for cambios in ALTERACIONES_DE_LA_0095[::3]:
            esquema.olvidar()
            async with motor.connect() as conexion:
                transaccion = await conexion.begin()
                sesion = AsyncSession(bind=conexion, expire_on_commit=False)
                app.dependency_overrides[get_db] = _siempre(sesion)
                try:
                    for sql in cambios:
                        await conexion.execute(text(sql))
                    antes = (await conexion.execute(text(cuentas))).one()
                    for respuesta in (
                        await _confirmar(app, p["cliente"], p["retencion"], p["cuerpo"]),
                        await _pedir(app, "GET", ruta, quien),
                        await _hacer(app, "client", h, "cancel", {}),
                        await _pedir(app, "POST", TAREAS, h["jefa"]),
                    ):
                        assert (respuesta.status_code, _codigo(respuesta)) == (503, "services_not_ready"), (
                            cambios, respuesta.text)
                    assert (await conexion.execute(text(cuentas))).one() == antes
                finally:
                    app.dependency_overrides[get_db] = normal
                    await sesion.close()
                    await transaccion.rollback()
                    esquema.olvidar()
    finally:
        app.dependency_overrides[get_db] = normal
    # Con la base entera otra vez, la puerta vuelve a mirar y dice que sí.
    r = await _confirmar(app, p["cliente"], p["retencion"], p["cuerpo"])
    assert r.status_code == 201, r.text
    assert await _guardada(motor, r.json()["id"]) == (FOTO_A, VERSION, HUELLA_A)
    assert (await _acciones(app, "client", h)) == ["cancel", "reschedule"]
