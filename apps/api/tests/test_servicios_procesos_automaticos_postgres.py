"""LOS PROCESOS AUTOMÁTICOS DE Z SERVICIOS, contra PostgreSQL.

Lo que la puerta deja pasar HACE lo mismo que las dos rutas de administración
que ya existían (`/admin/services/holds/expire` y `/admin/services/tasks/run`):
ni más, ni menos, ni distinto. Aquí se comprueba con retenciones de verdad.
"""

from __future__ import annotations

import pytest

from app.core.config import get_settings
from app.modules.services import procesos_router as procesos
from tests.test_baja_de_cuenta_postgres import API, SIN_POSTGRES, _persona, _uno
from tests.test_servicios_agenda_api import _dia
from tests.test_servicios_atencion_api import (  # noqa: F401 - montajes compartidos
    _atendida,
    _llevar,
    _reservado,
    _retrasar,
    _sucesos,
    _ver,
    atencion,
)
from tests.test_servicios_descubrimiento_api import _anonimo
from tests.test_servicios_reserva_api import (  # noqa: F401 - montajes compartidos
    ADMIN_SERVICIOS,
    _horarios,
    _pedir,
    _retener,
    _servicio,
    _vencer_ya,
    base_aplicada,
    entorno,
    mundo,
    reservas,
)

pytestmark = [SIN_POSTGRES, pytest.mark.asyncio]

RUTA = f"{API}/internal/services/tasks/run"
SECRETO = "5c0e" * 16


async def _correr(app, secreto: str | None = SECRETO):
    cabeceras = {} if secreto is None else {procesos.CABECERA: secreto}
    async with _anonimo(app) as http:
        return await http.post(RUTA, headers=cabeceras, json={})


async def test_el_planificador_vence_las_retenciones_sin_sesion_de_nadie(reservas, monkeypatch) -> None:
    app, motor, _ = reservas
    monkeypatch.setattr(get_settings(), "services_tasks_token", SECRETO)
    _, servicio, jefa, _ = await _servicio(app, motor)
    retenciones = []
    for dias in (7, 8, 9):
        cliente = await _persona(motor)
        inicio = (await _horarios(app, servicio, _dia(dias)))[0]["starts_at"]
        retenciones.append((await _retener(app, cliente, servicio, inicio)).json()["id"])
    vivas = "select count(*) from public.service_holds where status = 'active' and service_id = cast(:s as uuid)"
    assert await _uno(motor, vivas, s=servicio) == 3

    # Sin el secreto, nada se mueve (y se contesta como si estuviera apagado).
    r = await _correr(app, None)
    assert r.status_code == 503 and r.json()["error"]["code"] == "services_disabled", r.text
    for r_id in retenciones[:2]:
        await _vencer_ya(motor, r_id)
    assert await _uno(motor, vivas, s=servicio) == 3

    # Con él: vencen las dos que tocaban, y solo esas.
    r = await _correr(app)
    assert r.status_code == 200, r.text
    assert r.json() == {"expired": 2, "reminded": 0, "closed": 0, "unverified": 0, "skipped": 0}
    assert await _uno(motor, vivas, s=servicio) == 1

    # IDEMPOTENTE: la segunda pasada no encuentra nada.
    r = await _correr(app)
    assert r.status_code == 200 and r.json()["expired"] == 0, r.text
    assert await _uno(motor, vivas, s=servicio) == 1

    # Y la ruta de administración ve lo mismo: no hay dos verdades.
    r = await _pedir(app, "POST", f"{ADMIN_SERVICIOS}/holds/expire", jefa)
    assert r.status_code == 200 and r.json() == {"expired": 0}, r.text


async def test_con_la_contratacion_apagada_no_corre_aunque_el_secreto_sea_bueno(reservas, monkeypatch) -> None:
    app, motor, _ = reservas
    monkeypatch.setattr(get_settings(), "services_tasks_token", SECRETO)
    _, servicio, _, _ = await _servicio(app, motor)
    cliente = await _persona(motor)
    inicio = (await _horarios(app, servicio, _dia(7)))[0]["starts_at"]
    retencion = (await _retener(app, cliente, servicio, inicio)).json()["id"]
    await _vencer_ya(motor, retencion)

    monkeypatch.setattr(get_settings(), "feature_service_booking", False)
    r = await _correr(app)
    assert r.status_code == 503 and r.json()["error"]["code"] == "service_booking_disabled", r.text
    estado = "select status from public.service_holds where id = cast(:h as uuid)"
    assert await _uno(motor, estado, h=retencion) == "active"

    monkeypatch.setattr(get_settings(), "feature_service_booking", True)
    r = await _correr(app)
    assert r.status_code == 200 and r.json()["expired"] == 1, r.text
    assert await _uno(motor, estado, h=retencion) == "expired"


async def test_el_planificador_recuerda_y_cierra_lo_mismo_que_la_ruta_de_administracion(atencion, monkeypatch) -> None:
    """Los recordatorios y el cierre a las 24 horas —lo que prometen las
    condiciones— salen por la ruta del planificador, sin sesión de nadie."""
    app, motor, _ = atencion
    monkeypatch.setattr(get_settings(), "services_tasks_token", SECRETO)
    terminada = await _atendida(app, motor, hasta="completed")
    proxima = await _reservado(app, motor)
    # Los barridos son de TODA la base: primero, lo que dejaron otras pruebas.
    assert (await _correr(app)).status_code == 200
    assert "attendance_closed" not in await _sucesos(motor, terminada["reserva"]["id"])
    assert "booking_reminded" not in await _sucesos(motor, proxima["reserva"]["id"])

    # Pasa el plazo de confirmación de una, y la otra empieza dentro de diez horas.
    await _retrasar(motor, "service_attendances", "completed_at", "booking_id", terminada["reserva"]["id"], horas=30)
    await _llevar(motor, proxima["reserva"]["id"], minutos=10 * 60)
    r = await _correr(app)
    assert r.status_code == 200, r.text
    assert (r.json()["closed"], r.json()["reminded"]) == (1, 1), r.text
    cerrada = (await _ver(app, "client", terminada))["care"]["attendance"]
    assert (cerrada["status"], cerrada["closed_by"]) == ("closed", "system")
    assert (await _sucesos(motor, proxima["reserva"]["id"])).count("booking_reminded") == 1

    # IDEMPOTENTE: ni otro cierre ni otro recordatorio.
    r = await _correr(app)
    assert (r.json()["closed"], r.json()["reminded"]) == (0, 0), r.text
    assert (await _sucesos(motor, terminada["reserva"]["id"])).count("attendance_closed") == 1
    assert (await _sucesos(motor, proxima["reserva"]["id"])).count("booking_reminded") == 1
