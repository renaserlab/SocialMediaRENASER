"""El cálculo de horarios de la agenda (Incremento 4), sin base de datos.

`agenda_calculo` es la única autoridad para convertir zonas, decidir las
franjas de una fecha y generar los horarios. Aquí se prueba con relojes fijos:
Lima (sin horario de verano) y Nueva York (con él), medianoche, fin de mes y
de año, la separación entre atenciones, cada tipo de excepción, los bloqueos,
la antelación y el horizonte.

Ninguna prueba pasa sobre una lista vacía por accidente: cada una dice cuántos
horarios espera y cuáles.
"""

from __future__ import annotations

import random
from datetime import date, datetime, timedelta, timezone

import pytest

from app.modules.services import agenda_calculo as calc
from app.modules.services import agenda_politica as limites

UTC = timezone.utc
LIMA = calc.zona("America/Lima")
NY = calc.zona("America/New_York")
#: Una política sin antelación y con horizonte amplio, para aislar lo que se prueba.
LIBRE = limites.Politica(antelacion_minutos=0, horizonte_dias=365)
#: Mucho antes de todas las fechas de las pruebas.
ANTES = datetime(2026, 1, 1, tzinfo=UTC)


def _datos(
    *,
    zona=LIMA,
    duracion=60,
    antes=0,
    despues=0,
    intervalo=None,
    modalidad="virtual",
    capacidad=1,
    reglas=(),
    excepciones=(),
    bloqueos=(),
) -> calc.Datos:
    return calc.Datos(
        configuracion=calc.Configuracion(zona=zona, preparacion=antes, descanso=despues, intervalo=intervalo),
        servicio=calc.Servicio(duracion=duracion, modalidad=modalidad, capacidad=capacidad),
        reglas=tuple(reglas),
        excepciones=tuple(excepciones),
        bloqueos=tuple(bloqueos),
    )


def _regla(dia: int, inicio: str, fin: str, **extra) -> calc.Regla:
    return calc.Regla(
        dia=dia,
        inicio=calc.minuto_de(inicio, admite_24=False),
        fin=calc.minuto_de(fin, admite_24=True),
        modalidad=extra.get("modalidad", "virtual"),
        capacidad=extra.get("capacidad", 1),
        activa=extra.get("activa", True),
    )


def _excepcion(fecha: date, tipo: str, inicio: str | None = None, fin: str | None = None, **extra) -> calc.Excepcion:
    return calc.Excepcion(
        fecha=fecha,
        tipo=tipo,
        inicio=calc.minuto_de(inicio, admite_24=False) if inicio else None,
        fin=calc.minuto_de(fin, admite_24=True) if fin else None,
        modalidad=extra.get("modalidad", None if tipo == "closed" else "virtual"),
        capacidad=extra.get("capacidad", None if tipo == "closed" else 1),
    )


def _horas(datos: calc.Datos, fecha: date, *, ahora: datetime = ANTES, politica=LIBRE, modalidad="virtual") -> list[str]:
    desde, hasta = calc.ventana(ahora, politica)
    z = datos.configuracion.zona
    return [
        calc.reloj(h.inicio, z).strftime("%H:%M")
        for h in calc.horarios_del_dia(fecha, datos, modalidad=modalidad, desde=desde, hasta=hasta)
    ]


#: Un jueves.
JUEVES = date(2026, 10, 1)
assert JUEVES.isoweekday() == 4


# =========================================================================== #
# Zonas y horas
# =========================================================================== #
@pytest.mark.parametrize(
    "nombre", ["America/Lima", "America/New_York", "Europe/Madrid", "America/Argentina/Buenos_Aires"]
)
def test_una_zona_iana_con_lugar_vale(nombre) -> None:
    assert calc.zona(nombre) is not None


@pytest.mark.parametrize(
    "nombre",
    [
        "UTC-5", "UTC", "GMT", "Etc/GMT+5", "Etc/UTC", "EST5EDT", "america/lima", "Foo/Bar",
        "America/Lima/", "../etc/passwd", "America/Lima ", "", None, "A/" + "b" * 70, "-05:00",
    ],
)
def test_un_desplazamiento_fijo_o_una_zona_inventada_no_vale(nombre) -> None:
    assert calc.zona(nombre) is None


def test_las_horas_van_de_5_en_5_y_solo_el_fin_puede_ser_las_24() -> None:
    assert calc.minuto_de("09:30", admite_24=False) == 570
    assert calc.minuto_de("24:00", admite_24=True) == 1440
    assert calc.minuto_de("24:00", admite_24=False) is None
    for mala in ("9:30", "09:31", "25:00", "24:05", "09:60", "0930", "", None, "09:30:00"):
        assert calc.minuto_de(mala, admite_24=True) is None, mala
    assert calc.hora(0) == "00:00" and calc.hora(1440) == "24:00" and calc.hora(615) == "10:15"


def test_lima_es_utc_menos_cinco_todo_el_ano() -> None:
    assert calc.instante(date(2026, 1, 15), 9 * 60, LIMA) == datetime(2026, 1, 15, 14, 0, tzinfo=UTC)
    assert calc.instante(date(2026, 7, 15), 9 * 60, LIMA) == datetime(2026, 7, 15, 14, 0, tzinfo=UTC)
    # Las 24:00 son la medianoche del día SIGUIENTE.
    assert calc.instante(date(2026, 12, 31), 1440, LIMA) == datetime(2027, 1, 1, 5, 0, tzinfo=UTC)


def test_la_hora_que_no_existe_va_al_salto_y_la_que_se_repite_es_la_primera() -> None:
    # 8 de marzo de 2026, Nueva York: a las 02:00 el reloj salta a las 03:00.
    salto = date(2026, 3, 8)
    assert not calc.existe(salto, 2 * 60 + 30, NY)
    assert calc.instante(salto, 2 * 60 + 30, NY) == datetime(2026, 3, 8, 7, 0, tzinfo=UTC)  # 03:00 EDT
    # 1 de noviembre de 2026: de 01:00 a 02:00 pasa dos veces. La primera, EDT.
    vuelta = date(2026, 11, 1)
    assert calc.existe(vuelta, 90, NY)
    assert calc.instante(vuelta, 90, NY) == datetime(2026, 11, 1, 5, 30, tzinfo=UTC)


# =========================================================================== #
# Duración y separación
# =========================================================================== #
def test_el_ejemplo_del_incremento_no_ignora_los_15_minutos() -> None:
    """09:00–12:00, 60 minutos y 15 de descanso: 09:00 y 10:15. Nunca 11:00
    (se cruzaría con el descanso de las 10:15) ni 11:30 (acabaría fuera)."""
    datos = _datos(reglas=[_regla(4, "09:00", "12:00")], despues=15)
    assert _horas(datos, JUEVES) == ["09:00", "10:15"]


def test_la_preparacion_va_antes_y_tambien_cabe_en_la_franja() -> None:
    datos = _datos(reglas=[_regla(4, "09:00", "12:00")], antes=10, despues=10)
    # 09:10 ocupa 09:00–10:20; 10:30 ocupa 10:20–11:40; 11:50 acabaría a las 12:50.
    assert _horas(datos, JUEVES) == ["09:10", "10:30"]


def test_con_intervalo_propio_son_inicios_alternativos() -> None:
    datos = _datos(reglas=[_regla(4, "09:00", "12:00")], intervalo=30)
    assert _horas(datos, JUEVES) == ["09:00", "09:30", "10:00", "10:30", "11:00"]


def test_ningun_bloque_generado_termina_fuera_de_su_franja_ni_se_pisa_con_otro() -> None:
    """Con configuraciones al azar (y la semilla fija): el bloque entero de cada
    horario —preparación, atención y descanso— cabe en su franja, y sin
    intervalo propio ningún bloque se cruza con el siguiente."""
    azar = random.Random(20260930)
    comprobados = 0
    for _ in range(300):
        inicio = azar.randrange(0, 1400, 5)
        fin = azar.randrange(inicio + 5, 1441, 5)
        duracion = azar.choice([5, 15, 30, 45, 50, 60, 90, 120])
        antes, despues = azar.choice([0, 5, 10, 15]), azar.choice([0, 5, 10, 15, 30])
        datos = _datos(reglas=[_regla(4, calc.hora(inicio), calc.hora(fin))], duracion=duracion, antes=antes, despues=despues)
        desde, hasta = calc.ventana(ANTES, LIBRE)
        horarios = calc.horarios_del_dia(JUEVES, datos, modalidad="virtual", desde=desde, hasta=hasta)
        abre, cierra = calc.instante(JUEVES, inicio, LIMA), calc.instante(JUEVES, fin, LIMA)
        for h in horarios:
            assert h.inicio - timedelta(minutes=antes) >= abre
            assert h.fin + timedelta(minutes=despues) <= cierra
            assert h.fin - h.inicio == timedelta(minutes=duracion)
        for a, b in zip(horarios, horarios[1:]):
            assert a.fin + timedelta(minutes=despues) <= b.inicio - timedelta(minutes=antes)
        comprobados += len(horarios)
    assert comprobados > 1000


def test_la_capacidad_es_la_de_la_franja_sin_pasar_de_la_del_servicio() -> None:
    datos = _datos(reglas=[_regla(4, "09:00", "10:00", capacidad=8)], capacidad=5)
    desde, hasta = calc.ventana(ANTES, LIBRE)
    assert [h.capacidad for h in calc.horarios_del_dia(JUEVES, datos, modalidad="virtual", desde=desde, hasta=hasta)] == [5]


def test_otra_modalidad_no_tiene_horarios() -> None:
    datos = _datos(reglas=[_regla(4, "09:00", "12:00"), _regla(4, "14:00", "16:00", modalidad="in_person")])
    assert _horas(datos, JUEVES) == ["09:00", "10:00", "11:00"]
    # El servicio es virtual: pedir presencial no da nada aunque haya franja.
    assert _horas(datos, JUEVES, modalidad="in_person") == []


def test_una_regla_inactiva_no_cuenta_y_otro_dia_de_la_semana_tampoco() -> None:
    datos = _datos(reglas=[_regla(4, "09:00", "10:00", activa=False), _regla(5, "09:00", "10:00")])
    assert _horas(datos, JUEVES) == []
    assert _horas(datos, JUEVES + timedelta(days=1)) == ["09:00"]


# =========================================================================== #
# Excepciones, bloqueos y su precedencia
# =========================================================================== #
SEMANA = [_regla(4, "09:00", "12:00")]


def test_cerrar_la_fecha_entera_gana_a_todo() -> None:
    datos = _datos(reglas=SEMANA, excepciones=[_excepcion(JUEVES, "closed")])
    assert _horas(datos, JUEVES) == []
    # El jueves siguiente sigue igual.
    assert _horas(datos, JUEVES + timedelta(days=7)) == ["09:00", "10:00", "11:00"]


def test_cerrar_una_franja_quita_los_horarios_que_la_tocan() -> None:
    datos = _datos(reglas=SEMANA, excepciones=[_excepcion(JUEVES, "closed", "10:30", "11:00")])
    assert _horas(datos, JUEVES) == ["09:00", "11:00"]


def test_una_apertura_extra_solo_anade_lo_que_el_dia_no_tenia() -> None:
    datos = _datos(reglas=SEMANA, excepciones=[_excepcion(JUEVES, "extra", "11:00", "14:00")])
    # 09–12 de la semana y, de la extra, solo 12–14: se juntan en 09–14.
    assert _horas(datos, JUEVES) == ["09:00", "10:00", "11:00", "12:00", "13:00"]


def test_sustituir_la_semana_ese_dia_la_ignora() -> None:
    datos = _datos(reglas=SEMANA, excepciones=[_excepcion(JUEVES, "replace", "15:00", "17:00")])
    assert _horas(datos, JUEVES) == ["15:00", "16:00"]


def test_lo_que_cierra_gana_a_lo_que_abre_y_el_bloqueo_tambien() -> None:
    datos = _datos(
        reglas=SEMANA,
        excepciones=[
            _excepcion(JUEVES, "replace", "15:00", "18:00"),
            _excepcion(JUEVES, "closed", "16:00", "16:30"),
        ],
        bloqueos=[calc.Bloqueo(calc.instante(JUEVES, 17 * 60, LIMA), calc.instante(JUEVES, 17 * 60 + 5, LIMA))],
    )
    assert _horas(datos, JUEVES) == ["15:00"]


def test_un_bloqueo_tambien_choca_con_la_preparacion_y_el_descanso() -> None:
    bloqueo = calc.Bloqueo(calc.instante(JUEVES, 10 * 60, LIMA), calc.instante(JUEVES, 10 * 60 + 5, LIMA))
    datos = _datos(reglas=SEMANA, despues=5, bloqueos=[bloqueo])
    # 09:00 ocupa hasta las 10:05 (descanso incluido): choca con 10:00–10:05.
    # La rejilla no se mueve: el siguiente sigue siendo el de las 10:05.
    assert _horas(datos, JUEVES) == ["10:05"]


def test_un_bloqueo_que_cruza_la_medianoche_cierra_los_dos_dias() -> None:
    datos = _datos(reglas=[_regla(4, "22:00", "24:00"), _regla(5, "00:00", "02:00")])
    assert _horas(datos, JUEVES) == ["22:00", "23:00"]
    assert _horas(datos, JUEVES + timedelta(days=1)) == ["00:00", "01:00"]
    bloqueo = calc.Bloqueo(calc.instante(JUEVES, 23 * 60, LIMA), calc.instante(JUEVES + timedelta(days=1), 60, LIMA))
    datos = _datos(reglas=[_regla(4, "22:00", "24:00"), _regla(5, "00:00", "02:00")], bloqueos=[bloqueo])
    assert _horas(datos, JUEVES) == ["22:00"]
    assert _horas(datos, JUEVES + timedelta(days=1)) == ["01:00"]


def test_el_horario_de_las_23_acaba_a_medianoche_y_es_del_dia_en_que_empieza() -> None:
    datos = _datos(reglas=[_regla(4, "23:00", "24:00")])
    desde, hasta = calc.ventana(ANTES, LIBRE)
    (unico,) = calc.horarios_del_dia(JUEVES, datos, modalidad="virtual", desde=desde, hasta=hasta)
    assert unico.fecha == JUEVES
    assert calc.reloj(unico.fin, LIMA) == datetime(2026, 10, 2, 0, 0, tzinfo=LIMA)


# =========================================================================== #
# Antelación, horizonte, meses y años
# =========================================================================== #
def test_la_antelacion_quita_lo_que_empieza_demasiado_pronto() -> None:
    datos = _datos(reglas=SEMANA)
    ahora = calc.instante(JUEVES, 8 * 60, LIMA)
    dos_horas = limites.Politica(antelacion_minutos=120, horizonte_dias=60)
    assert _horas(datos, JUEVES, ahora=ahora, politica=dos_horas) == ["10:00", "11:00"]


def test_el_horizonte_corta_por_el_instante() -> None:
    datos = _datos(reglas=[_regla(d, "09:00", "12:00") for d in range(1, 8)])
    ahora = calc.instante(JUEVES, 10 * 60 + 30, LIMA)
    corto = limites.Politica(antelacion_minutos=0, horizonte_dias=2)
    assert calc.ultima_fecha(LIMA, ahora, corto) == JUEVES + timedelta(days=2)
    por_dia = calc.dias(datos, modalidad="virtual", desde_fecha=JUEVES, hasta_fecha=JUEVES + timedelta(days=5),
                        ahora=ahora, politica=corto)
    # Hoy desde las 11:00; mañana entero; pasado mañana hasta las 10:30.
    assert {f: len(h) for f, h in por_dia.items()} == {
        JUEVES: 1, JUEVES + timedelta(days=1): 3, JUEVES + timedelta(days=2): 2,
    }


def test_las_semanas_que_cruzan_el_mes_y_el_ano_caen_en_su_dia() -> None:
    lunes = _datos(reglas=[_regla(1, "09:00", "10:00")])
    diciembre = datetime(2026, 12, 1, tzinfo=UTC)
    por_dia = calc.dias(lunes, modalidad="virtual", desde_fecha=date(2026, 12, 26), hasta_fecha=date(2027, 1, 12),
                        ahora=diciembre, politica=LIBRE)
    assert sorted(por_dia) == [date(2026, 12, 28), date(2027, 1, 4), date(2027, 1, 11)]
    # Fin de mes: el 30 de septiembre es miércoles y el 1 de octubre, jueves.
    miercoles_y_jueves = _datos(reglas=[_regla(3, "09:00", "10:00"), _regla(4, "09:00", "10:00")])
    por_dia = calc.dias(miercoles_y_jueves, modalidad="virtual", desde_fecha=date(2026, 9, 30),
                        hasta_fecha=date(2026, 10, 1), ahora=ANTES, politica=LIBRE)
    assert sorted(por_dia) == [date(2026, 9, 30), date(2026, 10, 1)]


def test_el_proximo_es_el_primero_desde_hoy() -> None:
    datos = _datos(reglas=[_regla(1, "09:00", "10:00")])
    ahora = calc.instante(JUEVES, 12 * 60, LIMA)
    proximo = calc.proximo(datos, modalidad="virtual", ahora=ahora, politica=limites.Politica(120, 60))
    assert proximo is not None and proximo.fecha == date(2026, 10, 5)
    assert calc.proximo(_datos(), modalidad="virtual", ahora=ahora, politica=limites.Politica(120, 60)) is None


# =========================================================================== #
# Horario de verano (Perú no lo tiene; Nueva York sí)
# =========================================================================== #
def test_la_noche_en_que_se_adelanta_el_reloj() -> None:
    domingo = date(2026, 3, 8)
    datos = _datos(zona=NY, reglas=[_regla(7, "00:00", "04:00")])
    desde, hasta = calc.ventana(ANTES, LIBRE)
    horarios = calc.horarios_del_dia(domingo, datos, modalidad="virtual", desde=desde, hasta=hasta)
    # La franja dura TRES horas reales: 00:00, 01:00 y 03:00 (la de las 02:00 no existe).
    assert [calc.reloj(h.inicio, NY).strftime("%H:%M") for h in horarios] == ["00:00", "01:00", "03:00"]
    for a, b in zip(horarios, horarios[1:]):
        assert a.fin <= b.inicio


def test_la_noche_en_que_se_atrasa_el_reloj() -> None:
    domingo = date(2026, 11, 1)
    datos = _datos(zona=NY, reglas=[_regla(7, "00:00", "04:00")])
    desde, hasta = calc.ventana(ANTES, LIBRE)
    horarios = calc.horarios_del_dia(domingo, datos, modalidad="virtual", desde=desde, hasta=hasta)
    locales = [calc.reloj(h.inicio, NY) for h in horarios]
    # CINCO horas reales: la 01:00 sale dos veces, con su desplazamiento.
    assert [m.strftime("%H:%M") for m in locales] == ["00:00", "01:00", "01:00", "02:00", "03:00"]
    assert [calc.desplazamiento(m) for m in locales][1:3] == ["-04:00", "-05:00"]
    assert len({h.inicio for h in horarios}) == 5
    for a, b in zip(horarios, horarios[1:]):
        assert a.fin <= b.inicio


def test_una_regla_de_las_nueve_es_a_las_nueve_antes_y_despues_del_cambio() -> None:
    datos = _datos(zona=NY, reglas=[_regla(d, "09:00", "10:00") for d in range(1, 8)])
    antes = date(2026, 3, 6)
    despues = date(2026, 3, 10)
    assert _horas(datos, antes) == ["09:00"] and _horas(datos, despues) == ["09:00"]
    desde, hasta = calc.ventana(ANTES, LIBRE)
    (a,) = calc.horarios_del_dia(antes, datos, modalidad="virtual", desde=desde, hasta=hasta)
    (b,) = calc.horarios_del_dia(despues, datos, modalidad="virtual", desde=desde, hasta=hasta)
    # El mismo reloj local, distinto instante UTC: no se suma un desplazamiento a mano.
    assert (a.inicio.hour, b.inicio.hour) == (14, 13)
