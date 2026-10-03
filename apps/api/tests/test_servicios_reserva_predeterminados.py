"""La reserva NO depende de ningún valor predeterminado de la base.

Cierre del Incremento 5. La puerta `hay_reservas` comprueba columnas, tipos,
`NOT NULL`, claves, CHECK, la exclusión, índices, disparadores, funciones, RLS
y permisos de la 0093, pero NO los valores predeterminados de sus columnas.
No le hace falta mientras el dominio envíe cada valor explícitamente (el
estado, las fechas, el total, los detalles, el identificador).

Aquí se demuestra, en vez de suponerlo: se quitan TODOS los predeterminados
de las seis tablas y los recorridos reales de la API (contratar lo gratuito,
lo que tiene precio, soltar, el barrido, a domicilio, las condiciones del
servicio, una sesión de grupo y reemplazar un horario) siguen funcionando.

Si algún día el código pasara a apoyarse en un predeterminado, esta prueba
falla: entonces la puerta tendrá que mirarlo también.
"""

from __future__ import annotations

from sqlalchemy import text

import tests.test_servicios_reserva_api as reserva_api
from tests.test_servicios_reserva_api import (  # noqa: F401 - montajes compartidos
    base_aplicada,
    entorno,
    mundo,
    reservas,
)

pytestmark = reserva_api.pytestmark

TABLAS = ["service_holds", "service_orders", "service_bookings", "service_booking_intakes",
          "service_booking_acceptances", "service_booking_events"]


async def _quitar_los_predeterminados(motor) -> list[str]:
    async with motor.begin() as conexion:
        filas = (await conexion.execute(text(
            "select c.relname, a.attname from pg_catalog.pg_attrdef d "
            "join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum "
            "join pg_catalog.pg_class c on c.oid = d.adrelid "
            "where c.relnamespace = 'public'::regnamespace and c.relname = any(:tablas)"), {"tablas": TABLAS})).all()
        for tabla, columna in filas:
            await conexion.execute(text(f'alter table public.{tabla} alter column "{columna}" drop default'))
    return sorted(f"{tabla}.{columna}" for tabla, columna in filas)


async def test_sin_ningun_valor_predeterminado_la_reserva_sigue_funcionando(reservas, monkeypatch) -> None:  # noqa: F811
    _, motor, _ = reservas
    quitados = await _quitar_los_predeterminados(motor)
    # Los que la 0093 declara: si cambian, que se vea aquí.
    assert len(quitados) == 18, quitados
    assert {"service_holds.status", "service_holds.created_at", "service_orders.total_minor",
            "service_booking_events.details", "service_bookings.id"} <= set(quitados)
    await reserva_api.test_contratar_un_servicio_gratuito_de_punta_a_punta(reservas)
    await reserva_api.test_un_servicio_con_precio_se_prepara_y_se_detiene_sin_dinero(reservas)
    await reserva_api.test_soltar_devuelve_el_horario_y_repetirlo_es_lo_mismo(reservas)
    await reserva_api.test_el_barrido_vence_por_lotes_y_repetirlo_no_hace_nada(reservas)
    await reserva_api.test_a_domicilio_si_se_configura_pide_la_direccion_y_solo_la_ve_el_prestador(
        reservas, monkeypatch)
    await reserva_api.test_las_condiciones_del_servicio_tambien_se_aceptan_por_su_huella(reservas)
    await reserva_api.test_una_sesion_de_grupo_da_sus_plazas_y_ni_una_mas(reservas)
    await reserva_api.test_otro_horario_del_mismo_servicio_reemplaza_y_el_mismo_no_se_renueva(reservas)
