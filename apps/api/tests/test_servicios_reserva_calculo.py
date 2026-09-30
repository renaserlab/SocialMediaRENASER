"""Lo ya ocupado en el cálculo de horarios (Incremento 5), sin base de datos.

`agenda_calculo` sigue siendo la ÚNICA autoridad de qué horario se ofrece: lo
público, la retención y la confirmación lo leen de aquí. Con lo ocupado dentro:

  * un horario desaparece si su bloque ENTERO (preparación + atención +
    descanso) toca otra SESIÓN, con la separación que esa sesión tenía al
    retenerse;
  * en su propia sesión, cuentan las plazas: con capacidad para tres y dos
    tomadas, sigue; con tres, no.

Es la misma regla que impone la 0093 (dos sesiones distintas no se pisan; una
plaza no se da dos veces): lo que aquí se ofrece es lo que la base dejará
retener. Cada prueba dice qué horarios espera.
"""

from __future__ import annotations

import random
from dataclasses import replace
from datetime import datetime, timedelta

from app.modules.services import agenda_calculo as calc
from tests.test_servicios_agenda_calculo import ANTES, JUEVES, LIBRE, LIMA, _datos, _horas, _regla


def _en(hora: str, fecha=JUEVES) -> datetime:
    return calc.instante(fecha, calc.minuto_de(hora, admite_24=True), LIMA)


def _ocupa(inicio: str, *, minutos: int = 60, antes: int = 0, despues: int = 0, plazas: int = 1,
           fecha=JUEVES) -> calc.Ocupacion:
    i = _en(inicio, fecha)
    return calc.Ocupacion(i, i - timedelta(minutes=antes), i + timedelta(minutes=minutos + despues), plazas)


def _con(datos: calc.Datos, *ocupaciones: calc.Ocupacion) -> calc.Datos:
    return replace(datos, ocupaciones=tuple(ocupaciones))


def test_sin_nada_ocupado_todo_sigue_como_en_el_incremento_4() -> None:
    datos = _datos(despues=15, reglas=[_regla(4, "09:00", "12:00")])
    assert _horas(datos, JUEVES) == ["09:00", "10:15"]
    assert _horas(_con(datos), JUEVES) == ["09:00", "10:15"]


def test_una_sesion_llena_desaparece_y_las_demas_siguen() -> None:
    datos = _datos(despues=15, reglas=[_regla(4, "09:00", "12:00")])
    assert _horas(_con(datos, _ocupa("09:00", despues=15)), JUEVES) == ["10:15"]
    assert _horas(_con(datos, _ocupa("10:15", despues=15)), JUEVES) == ["09:00"]


def test_con_inicios_alternativos_lo_que_toca_la_sesion_desaparece() -> None:
    # 60 minutos cada 15: 09:00, 09:15 … 11:00. Una sesión a las 09:30 (hasta
    # las 10:30) quita todo lo que empieza antes de las 10:30 y acabaría después
    # de las 09:30: de 08:45… a 10:15. Queda de 10:30 en adelante.
    datos = _datos(intervalo=15, reglas=[_regla(4, "09:00", "12:00")])
    assert _horas(datos, JUEVES)[:3] == ["09:00", "09:15", "09:30"]
    assert _horas(_con(datos, _ocupa("09:30")), JUEVES) == ["10:30", "10:45", "11:00"]


def test_la_separacion_de_la_sesion_ocupada_tambien_ocupa() -> None:
    # La sesión de las 09:00 se retuvo con 30 minutos de descanso (hasta las
    # 10:30). Aunque hoy el descanso sea 0, la de las 10:00 se pisa con él.
    datos = _datos(intervalo=30, reglas=[_regla(4, "09:00", "12:00")])
    assert "10:00" in _horas(datos, JUEVES)
    horas = _horas(_con(datos, _ocupa("09:00", despues=30)), JUEVES)
    assert horas == ["10:30", "11:00"]
    # Y la preparación: una sesión a las 11:00 con 60 de preparación empieza a
    # ocupar a las 10:00.
    horas = _horas(_con(datos, _ocupa("11:00", antes=60)), JUEVES)
    assert horas == ["09:00"]


def test_la_separacion_de_quien_llega_tampoco_puede_tocar_otra_sesion() -> None:
    # Con 15 de preparación, el horario de las 10:15 empieza a ocupar a las
    # 10:00: toca una sesión que ocupa de 09:00 a 10:05.
    datos = _datos(antes=15, intervalo=15, reglas=[_regla(4, "09:00", "12:00")])
    ocupada = calc.Ocupacion(_en("09:00"), _en("08:50"), _en("10:05"), 1)
    horas = _horas(_con(datos, ocupada), JUEVES)
    assert "10:15" not in horas and "10:30" in horas


def test_una_sesion_de_grupo_ofrece_sus_plazas_libres_y_ni_una_mas() -> None:
    datos = _datos(capacidad=3, reglas=[_regla(4, "09:00", "12:00", capacidad=3)])
    desde, hasta = calc.ventana(ANTES, LIBRE)

    def de_las_diez(*ocupaciones):
        todos = calc.horarios_del_dia(JUEVES, _con(datos, *ocupaciones), modalidad="virtual", desde=desde, hasta=hasta)
        return [h for h in todos if h.inicio == _en("10:00")]

    (libre,) = de_las_diez()
    assert (libre.capacidad, libre.ocupadas) == (3, 0)
    (casi,) = de_las_diez(_ocupa("10:00", plazas=1), _ocupa("10:00", plazas=1))
    assert (casi.capacidad, casi.ocupadas) == (3, 2)
    assert de_las_diez(_ocupa("10:00", plazas=2), _ocupa("10:00", plazas=1)) == []
    # Las otras sesiones de ese día, intactas: la sesión de grupo es una.
    assert _horas(_con(datos, _ocupa("10:00", plazas=3)), JUEVES) == ["09:00", "11:00"]


def test_lo_de_otro_dia_no_toca_este() -> None:
    datos = _datos(reglas=[_regla(4, "09:00", "12:00")])
    ayer = JUEVES - timedelta(days=1)
    assert _horas(_con(datos, _ocupa("09:00", fecha=ayer)), JUEVES) == ["09:00", "10:00", "11:00"]


def test_nunca_se_ofrece_un_horario_que_la_base_rechazaria() -> None:
    """300 agendas al azar con sesiones ya tomadas (sacadas de sus propios
    horarios, como haría la API): ningún horario ofrecido toca otra sesión, y
    los de una sesión ocupada nunca pasan de su capacidad."""
    azar = random.Random(51)
    desde, hasta = calc.ventana(ANTES, LIBRE)
    for _ in range(300):
        capacidad = azar.choice([1, 1, 2, 3])
        datos = _datos(
            duracion=azar.choice([15, 30, 45, 60, 90]),
            antes=azar.choice([0, 0, 5, 15]),
            despues=azar.choice([0, 10, 15, 30]),
            intervalo=azar.choice([None, None, 5, 15, 30]),
            capacidad=capacidad,
            reglas=[_regla(4, "08:00", "18:00", capacidad=capacidad)],
        )
        c = datos.configuracion
        ocupaciones: list[calc.Ocupacion] = []
        for _ in range(azar.randint(1, 6)):
            libres = calc.horarios_del_dia(JUEVES, _con(datos, *ocupaciones), modalidad="virtual", desde=desde, hasta=hasta)
            if not libres:
                break
            h = azar.choice(libres)
            ocupaciones.append(calc.Ocupacion(
                h.inicio, h.inicio - timedelta(minutes=c.preparacion), h.fin + timedelta(minutes=c.descanso), 1
            ))
        # Lo ofrecido, contra lo ocupado.
        sesiones: dict[datetime, list[calc.Ocupacion]] = {}
        for o in ocupaciones:
            sesiones.setdefault(o.inicio, []).append(o)
        for h in calc.horarios_del_dia(JUEVES, _con(datos, *ocupaciones), modalidad="virtual", desde=desde, hasta=hasta):
            ini, fin = h.inicio - timedelta(minutes=c.preparacion), h.fin + timedelta(minutes=c.descanso)
            for inicio, lista in sesiones.items():
                if inicio == h.inicio:
                    assert h.ocupadas == len(lista) < h.capacidad
                else:
                    assert all(o.hasta <= ini or o.desde >= fin for o in lista), (h, lista)
        # Y las sesiones tomadas entre sí nunca se pisan (como exige la base).
        orden = sorted(((min(o.desde for o in v), max(o.hasta for o in v)) for v in sesiones.values()))
        assert all(a[1] <= b[0] for a, b in zip(orden, orden[1:]))
