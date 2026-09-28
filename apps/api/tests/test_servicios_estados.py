"""Z Servicios, Bloque 1A: la máquina de estados de la postulación.

Lógica pura, sin base: lo que se defiende aquí es el MAPA, que es lo que decide
quién entra a ofrecer servicios en Z.

  1. Son exactamente los ocho estados del bloque.
  2. Cada salto existe solo para quien le toca: aprobar, rechazar y suspender
     son de administración; curaduría revisa y pide correcciones; quien postula
     envía y reenvía, y nada más.
  3. Toda combinación fuera del mapa es imposible (409), aunque la pida un
     administrador.
  4. No hay callejones: todo estado se alcanza desde el borrador y todo estado
     no final tiene salida. `rejected` es el único final.
"""

from __future__ import annotations

from itertools import product

import pytest

from app.modules.services import states
from app.modules.services.states import (
    ADMINISTRACION,
    PRESTADOR,
    REVISOR,
    SISTEMA,
    EstadoDesconocido,
    SaltoInexistente,
    SaltoNoPermitido,
)


def test_son_exactamente_los_ocho_estados_del_bloque() -> None:
    assert {e.upper() for e in states.ESTADOS} == {
        "DRAFT",
        "SUBMITTED",
        "UNDER_REVIEW",
        "CHANGES_REQUESTED",
        "RESUBMITTED",
        "APPROVED",
        "REJECTED",
        "SUSPENDED",
    }
    assert len(states.ESTADOS) == len(set(states.ESTADOS)) == 8


def test_el_mapa_es_el_aprobado_salto_a_salto() -> None:
    """Si alguien añade o quita un salto, esta prueba lo dice por su nombre."""
    assert states.TRANSICIONES == {
        ("draft", "submitted"): {PRESTADOR},
        ("submitted", "under_review"): {REVISOR, ADMINISTRACION},
        ("under_review", "changes_requested"): {REVISOR, ADMINISTRACION},
        ("changes_requested", "resubmitted"): {PRESTADOR},
        ("resubmitted", "under_review"): {REVISOR, ADMINISTRACION},
        ("under_review", "approved"): {ADMINISTRACION},
        ("under_review", "rejected"): {ADMINISTRACION},
        ("approved", "suspended"): {ADMINISTRACION},
        ("suspended", "under_review"): {REVISOR, ADMINISTRACION},
    }


@pytest.mark.parametrize(("desde", "hasta"), sorted(states.TRANSICIONES))
def test_cada_salto_lo_da_quien_le_toca_y_nadie_mas(desde: str, hasta: str) -> None:
    for actor in states.ACTORES:
        if actor in states.quienes(desde, hasta):
            states.exigir(desde, hasta, actor)
        else:
            with pytest.raises(SaltoNoPermitido) as error:
                states.exigir(desde, hasta, actor)
            assert error.value.status_code == 403
            assert error.value.code == "service_application_transition_forbidden"


def test_toda_combinacion_fuera_del_mapa_es_imposible_incluso_para_administracion() -> None:
    fuera = [
        (d, h)
        for d, h in product(states.ESTADOS, states.ESTADOS)
        if (d, h) not in states.TRANSICIONES
    ]
    assert len(fuera) == 64 - len(states.TRANSICIONES)
    for desde, hasta in fuera:
        for actor in states.ACTORES:
            with pytest.raises(SaltoInexistente) as error:
                states.exigir(desde, hasta, actor)
            assert error.value.status_code == 409
            assert error.value.code == "service_application_transition_invalid"


@pytest.mark.parametrize(
    ("desde", "hasta"),
    [
        ("draft", "approved"),  # aprobar un borrador sin revisión
        ("submitted", "approved"),  # aprobar sin abrir revisión
        ("submitted", "rejected"),
        ("rejected", "under_review"),  # resucitar un rechazo
        ("rejected", "draft"),
        ("suspended", "approved"),  # salir de una suspensión sin investigar
        ("approved", "draft"),
        ("changes_requested", "under_review"),  # saltarse el reenvío
    ],
)
def test_los_atajos_peligrosos_no_existen(desde: str, hasta: str) -> None:
    assert not states.existe(desde, hasta)
    with pytest.raises(SaltoInexistente):
        states.exigir(desde, hasta, ADMINISTRACION)


def test_decidir_es_solo_de_administracion() -> None:
    for hasta in ("approved", "rejected"):
        assert states.quienes("under_review", hasta) == {ADMINISTRACION}
    assert states.quienes("approved", "suspended") == {ADMINISTRACION}
    # Curaduría revisa, pero no decide.
    for desde, hasta in states.TRANSICIONES:
        if hasta in ("approved", "rejected", "suspended"):
            assert REVISOR not in states.quienes(desde, hasta)


def test_quien_postula_solo_envia_y_reenvia() -> None:
    suyos = {k for k, v in states.TRANSICIONES.items() if PRESTADOR in v}
    assert suyos == {("draft", "submitted"), ("changes_requested", "resubmitted")}


def test_el_sistema_no_decide_nada_en_este_bloque() -> None:
    assert not any(SISTEMA in v for v in states.TRANSICIONES.values())


def test_un_salto_al_mismo_estado_no_existe() -> None:
    for estado in states.ESTADOS:
        with pytest.raises(SaltoInexistente):
            states.exigir(estado, estado, ADMINISTRACION)


def test_un_estado_mal_escrito_es_un_error_de_estado_no_de_permiso() -> None:
    with pytest.raises(EstadoDesconocido) as error:
        states.exigir("draft", "APPROVED", ADMINISTRACION)
    assert error.value.code == "service_application_status_unknown"
    with pytest.raises(EstadoDesconocido):
        states.exigir("borrador", "submitted", PRESTADOR)


def test_un_actor_desconocido_no_da_ningun_paso() -> None:
    with pytest.raises(SaltoNoPermitido):
        states.exigir("draft", "submitted", "superadmin")


def test_rechazada_es_el_unico_final() -> None:
    assert states.FINALES == {"rejected"}
    assert states.siguientes("rejected", ADMINISTRACION) == ()
    con_salida = {d for d, _ in states.TRANSICIONES}
    assert con_salida == set(states.ESTADOS) - states.FINALES


def test_todo_estado_se_alcanza_desde_el_borrador() -> None:
    alcanzados = {"draft"}
    frontera = ["draft"]
    while frontera:
        actual = frontera.pop()
        for d, h in states.TRANSICIONES:
            if d == actual and h not in alcanzados:
                alcanzados.add(h)
                frontera.append(h)
    assert alcanzados == set(states.ESTADOS)


def test_nadie_vuelve_al_borrador() -> None:
    """El borrador solo existe al nacer: corregir es `changes_requested`."""
    assert not any(h == "draft" for _, h in states.TRANSICIONES)


def test_solo_se_edita_en_borrador_y_al_corregir() -> None:
    assert states.EDITABLES == {"draft", "changes_requested"}
    for estado in states.ESTADOS:
        assert states.es_editable(estado) is (estado in {"draft", "changes_requested"})


def test_solo_el_rechazo_libera_el_hueco_de_la_postulacion_viva() -> None:
    assert states.VIVAS == set(states.ESTADOS) - {"rejected"}


def test_lo_que_espera_a_z() -> None:
    assert states.PENDIENTES_DE_Z == {"submitted", "under_review", "resubmitted"}


def test_siguientes_depende_de_quien_mira() -> None:
    assert states.siguientes("under_review", ADMINISTRACION) == (
        "approved",
        "changes_requested",
        "rejected",
    )
    assert states.siguientes("under_review", REVISOR) == ("changes_requested",)
    assert states.siguientes("under_review", PRESTADOR) == ()
    assert states.siguientes("draft", PRESTADOR) == ("submitted",)
