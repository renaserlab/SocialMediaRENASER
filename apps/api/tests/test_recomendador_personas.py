"""Que el orden signifique algo, y que se pueda explicar por que.

Estas pruebas son el escenario del producto escrito en codigo:

    Ana quiere aprender CARPINTERIA.
    Carlos puede ayudar en carpinteria.
    Lucia hace marketing.
    Andres domina React.

    Esperado: Carlos por delante de Lucia y de Andres.

No crean ni una fila en ninguna base de datos, y desde luego no crean personas
inventadas en produccion: el ranker es una funcion pura sobre rasgos, asi que
el escenario entero cabe en un objeto. Eso es lo que permite comprobar el
ALGORITMO, que es lo que se quiere comprobar, sin arrastrar infraestructura.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.modules.recommendations.config import PESOS_DE_PERSONAS, pesos_desde
from app.modules.recommendations.features import (
    Candidato,
    PerfilDeDemanda,
    construir,
    exploracion_de,
)
from app.modules.recommendations.ranker import (
    MOTIVO_ENSENA,
    MOTIVO_INTERES_COMUN,
    MOTIVO_PUEDE_AYUDAR,
    MOTIVO_SESIONES,
    MOTIVO_TEMA,
    MOTIVO_VOZ_NUEVA,
    puntuar,
)
from app.modules.recommendations.repository import ActividadDeAutor
from app.modules.recommendations.reranker import por_grupo, sin_rachas

AHORA = datetime(2026, 8, 24, 12, 0, 0, tzinfo=timezone.utc)
SEMILLA = "2026-08-24"

CARPINTERIA = "t-carpinteria"
MARKETING = "t-marketing"
REACT = "t-react"


def _actividad(dias_desde_ultima: int = 2, publicaciones: int = 4, **extra) -> ActividadDeAutor:
    return ActividadDeAutor(
        publicaciones=publicaciones,
        ultima_publicacion=AHORA - timedelta(days=dias_desde_ultima),
        formatos=extra.pop("formatos", {"video"}),
        reacciones=extra.pop("reacciones", 3),
        sesiones_dadas=extra.pop("sesiones_dadas", 0),
    )


def _candidato(uid: str, ofrece: dict[str, set[str]] | None = None, **extra) -> Candidato:
    return Candidato(
        id=uid,
        oferta={k: frozenset(v) for k, v in (ofrece or {}).items()},
        intereses=frozenset(extra.pop("intereses", set())),
        actividad=extra.pop("actividad", _actividad()),
        afinidad=extra.pop("afinidad", 0.0),
        ya_seguido=extra.pop("ya_seguido", False),
    )


def _score(candidato: Candidato, demanda: PerfilDeDemanda, pesos=PESOS_DE_PERSONAS) -> float:
    return puntuar(construir(candidato, demanda, ahora=AHORA, semilla=SEMILLA), pesos).score


def _motivos(candidato: Candidato, demanda: PerfilDeDemanda) -> list[str]:
    rasgos = construir(candidato, demanda, ahora=AHORA, semilla=SEMILLA)
    return [m.code for m in puntuar(rasgos).motivos]


# --------------------------------------------------------------------------- #
# Usuario A: quiere aprender carpinteria
# --------------------------------------------------------------------------- #
ANA = PerfilDeDemanda(
    usuario_id="ana",
    aprender=frozenset({CARPINTERIA}),
    intereses=frozenset({CARPINTERIA}),
    relaciones_buscadas=frozenset({"teach", "can_help"}),
    formatos=frozenset({"video"}),
)

CARLOS = _candidato("carlos", {"can_help": {CARPINTERIA}, "teach": {CARPINTERIA}})
LUCIA = _candidato("lucia", {"teach": {MARKETING}})
ANDRES = _candidato("andres", {"teach": {REACT}, "experienced": {REACT}})


def test_quien_ensena_lo_que_ana_quiere_aprender_va_primero():
    """El caso central del producto. Si esto falla, esto no recomienda nada."""
    assert _score(CARLOS, ANA) > _score(LUCIA, ANA)
    assert _score(CARLOS, ANA) > _score(ANDRES, ANA)


def test_dos_candidatos_de_otro_tema_no_se_ordenan_por_casualidad():
    """Lucia y Andres no cubren nada de Ana: los separa la exploracion, y esa
    es estable. Lo que NO puede pasar es que alguno supere a Carlos."""
    mejor_de_los_otros = max(_score(LUCIA, ANA), _score(ANDRES, ANA))
    assert _score(CARLOS, ANA) > mejor_de_los_otros


# --------------------------------------------------------------------------- #
# Usuario B: quiere React
# --------------------------------------------------------------------------- #
BRUNO = PerfilDeDemanda(
    usuario_id="bruno",
    aprender=frozenset({REACT}),
    intereses=frozenset({REACT}),
    relaciones_buscadas=frozenset({"teach"}),
)


def test_el_orden_depende_de_quien_pregunta():
    """La misma gente, otra persona mirando, otro primero.

    Es la prueba de que hay personalizacion y no una lista global disfrazada.
    """
    assert _score(ANDRES, BRUNO) > _score(CARLOS, BRUNO)
    assert _score(CARLOS, ANA) > _score(ANDRES, ANA)


# --------------------------------------------------------------------------- #
# Usuario C: sin preferencias
# --------------------------------------------------------------------------- #
SIN_PREFERENCIAS = PerfilDeDemanda(usuario_id="carmen")


def test_sin_preferencias_nadie_puntua_por_tema():
    """Arranque en frio: no se inventa una coincidencia que no existe."""
    rasgos = construir(CARLOS, SIN_PREFERENCIAS, ahora=AHORA, semilla=SEMILLA)
    assert rasgos.tema is None
    assert rasgos.intencion is None


def test_sin_preferencias_el_orden_sigue_siendo_estable_y_no_nulo():
    puntuaciones = [
        _score(c, SIN_PREFERENCIAS) for c in (CARLOS, LUCIA, ANDRES)
    ]
    assert all(0.0 < p <= 1.0 for p in puntuaciones)
    # Repetir la peticion no baraja la lista.
    assert puntuaciones == [_score(c, SIN_PREFERENCIAS) for c in (CARLOS, LUCIA, ANDRES)]


def test_sin_nada_que_contar_se_dice_que_es_una_voz_nueva():
    """Antes que inventar un motivo, se admite que es exploracion."""
    nuevo = _candidato(
        "nadie", {}, actividad=ActividadDeAutor(), intereses=set()
    )
    assert _motivos(nuevo, SIN_PREFERENCIAS) == [MOTIVO_VOZ_NUEVA]


# --------------------------------------------------------------------------- #
# Explicabilidad
# --------------------------------------------------------------------------- #
def test_se_puede_saber_por_que_alguien_salio_primero():
    """El desglose existe en desarrollo. Es lo que convierte «salio Carlos» en
    «salio Carlos porque coincide en tema y ademas ensena»."""
    rasgos = construir(CARLOS, ANA, ahora=AHORA, semilla=SEMILLA)
    desglose = puntuar(rasgos).desglose
    assert {"tema", "intencion", "actividad", "exploracion", "final"} <= set(desglose)
    assert desglose["tema"] > 0
    assert 0.0 < desglose["final"] <= 1.0


def test_los_motivos_nombran_el_tema_que_coincide():
    rasgos = construir(CARLOS, ANA, ahora=AHORA, semilla=SEMILLA)
    motivos = {m.code: m.topics for m in puntuar(rasgos).motivos}
    assert MOTIVO_TEMA in motivos
    assert motivos[MOTIVO_TEMA] == (CARPINTERIA,)
    assert MOTIVO_ENSENA in motivos or MOTIVO_PUEDE_AYUDAR in motivos


def test_el_motivo_de_intereses_comunes_no_nombra_ningun_tema():
    """Nombrarlo revelaria lo que la OTRA persona busca, que es privado."""
    afin = _candidato("afin", {}, intereses={CARPINTERIA})
    rasgos = construir(afin, ANA, ahora=AHORA, semilla=SEMILLA)
    motivos = {m.code: m.topics for m in puntuar(rasgos).motivos}
    assert MOTIVO_INTERES_COMUN in motivos
    assert motivos[MOTIVO_INTERES_COMUN] == ()


def test_ofrecer_sesiones_se_dice_cuando_es_lo_que_la_persona_prefiere():
    quiere_sesiones = PerfilDeDemanda(
        usuario_id="ana",
        aprender=frozenset({CARPINTERIA}),
        formatos=frozenset({"sesion_1a1"}),
    )
    mentor = _candidato(
        "mentor",
        {"teach": {CARPINTERIA}},
        actividad=_actividad(formatos={"video", "sesion_1a1"}, sesiones_dadas=2),
    )
    assert MOTIVO_SESIONES in _motivos(mentor, quiere_sesiones)


# --------------------------------------------------------------------------- #
# Popularidad != experiencia
# --------------------------------------------------------------------------- #
def test_una_cuenta_muy_seguida_no_gana_a_quien_si_ensena_el_tema():
    """El fallo que convertiria esto en un ranking de popularidad."""
    famoso = _candidato(
        "famoso",
        {"teach": {MARKETING}},
        actividad=_actividad(dias_desde_ultima=0, publicaciones=50, reacciones=5000),
    )
    modesto = _candidato(
        "modesto",
        {"can_help": {CARPINTERIA}, "teach": {CARPINTERIA}},
        actividad=_actividad(dias_desde_ultima=20, publicaciones=1, reacciones=0),
    )
    assert _score(modesto, ANA) > _score(famoso, ANA)


def test_alguien_nuevo_sin_senales_puede_aparecer():
    """La exploracion no es decorativa: sin ella, quien acaba de llegar no
    tendria forma de que le vieran nunca."""
    recien_llegado = _candidato(
        "nuevo", {"teach": {CARPINTERIA}}, actividad=ActividadDeAutor()
    )
    assert _score(recien_llegado, ANA) > 0


# --------------------------------------------------------------------------- #
# Reputacion: hoy neutra, a proposito
# --------------------------------------------------------------------------- #
def test_hoy_no_se_fabrica_reputacion():
    """No hay resenas verificadas, asi que la reputacion no puntua a nadie.

    Los testimonios que existen no son resenas verificables y usarlos como si
    lo fueran seria inventarse una confianza que nadie ha ganado.
    """
    rasgos = construir(CARLOS, ANA, ahora=AHORA, semilla=SEMILLA)
    assert rasgos.reputacion is None
    assert "reputacion" not in puntuar(rasgos).desglose


# --------------------------------------------------------------------------- #
# Los pesos son configuracion, no verdad
# --------------------------------------------------------------------------- #
def test_apagar_un_componente_lo_saca_del_reparto():
    apagado = pesos_desde({"tema": 0.0})
    rasgos = construir(CARLOS, ANA, ahora=AHORA, semilla=SEMILLA)
    assert "tema" not in puntuar(rasgos, apagado).desglose


def test_subir_el_peso_del_tema_agranda_la_distancia():
    normal = _score(CARLOS, ANA) - _score(LUCIA, ANA)
    con_mas_tema = _score(CARLOS, ANA, pesos_desde({"tema": 0.9})) - _score(
        LUCIA, ANA, pesos_desde({"tema": 0.9})
    )
    assert con_mas_tema > normal


def test_el_score_siempre_queda_entre_cero_y_uno():
    """Comparable entre versiones y entre personas con respuestas distintas."""
    for demanda in (ANA, BRUNO, SIN_PREFERENCIAS):
        for candidato in (CARLOS, LUCIA, ANDRES):
            assert 0.0 <= _score(candidato, demanda) <= 1.0


# --------------------------------------------------------------------------- #
# Comportamiento: el bucle de aprendizaje
# --------------------------------------------------------------------------- #
def test_lo_que_la_persona_ya_miro_sube_a_quien_miro():
    """Sin entrenar nada: la senal entra en el score la siguiente vez."""
    con_senales = PerfilDeDemanda(
        usuario_id="ana",
        aprender=frozenset({CARPINTERIA}),
        tiene_senales=True,
    )
    ignorado = _candidato("x", {"teach": {CARPINTERIA}})
    visitado = _candidato("y", {"teach": {CARPINTERIA}}, afinidad=5.0)
    assert _score(visitado, con_senales) > _score(ignorado, con_senales)


def test_el_interes_se_mueve_con_el_uso_aunque_no_se_toquen_las_preferencias():
    """Empieza en negocios, acaba abriendo programacion: tecnologia sube."""
    deriva = PerfilDeDemanda(
        usuario_id="ana",
        aprender=frozenset({MARKETING}),
        tiene_senales=True,
        afinidad_por_tema={REACT: 5.0},
    )
    solo_marketing = _candidato("m", {"teach": {MARKETING}})
    marketing_y_react = _candidato("mr", {"teach": {MARKETING, REACT}})
    assert _score(marketing_y_react, deriva) > _score(solo_marketing, deriva)


def test_sin_ninguna_senal_el_componente_no_aplica_en_vez_de_valer_cero():
    """Un cero para todo el mundo solo hundiria los numeros sin cambiar nada."""
    rasgos = construir(CARLOS, ANA, ahora=AHORA, semilla=SEMILLA)
    assert rasgos.comportamiento is None


# --------------------------------------------------------------------------- #
# Exploracion determinista
# --------------------------------------------------------------------------- #
def test_la_exploracion_no_cambia_entre_dos_peticiones_del_mismo_dia():
    """Si cambiara, la lista bailaria al desplazarse y al volver atras."""
    assert exploracion_de("ana", "carlos", SEMILLA) == exploracion_de(
        "ana", "carlos", SEMILLA
    )


def test_la_exploracion_gira_al_cambiar_de_dia():
    assert exploracion_de("ana", "carlos", "2026-08-24") != exploracion_de(
        "ana", "carlos", "2026-08-25"
    )


def test_cada_persona_explora_por_su_cuenta():
    assert exploracion_de("ana", "carlos", SEMILLA) != exploracion_de(
        "bruno", "carlos", SEMILLA
    )


def test_la_exploracion_esta_acotada():
    for uid in ("ana", "bruno", "carmen", "d", "e", "f"):
        assert 0.0 <= exploracion_de(uid, "carlos", SEMILLA) < 1.0


# --------------------------------------------------------------------------- #
# Diversidad
# --------------------------------------------------------------------------- #
def test_no_salen_diez_del_mismo_grupo_seguidos():
    elementos = [("a", i) for i in range(10)] + [("b", 0), ("c", 0)]
    elegidos = por_grupo(
        elementos, grupo_de=lambda e: e[0], maximo_por_grupo=3, limite=6
    )
    del elementos
    assert sum(1 for e in elegidos[:5] if e[0] == "a") <= 3
    assert {"b", "c"} <= {e[0] for e in elegidos}


def test_la_diversidad_no_deja_la_lista_a_medias():
    """Con poco catalogo, apartar es peor que repetir: se rellena con lo apartado."""
    solo_uno = [("a", i) for i in range(6)]
    elegidos = por_grupo(solo_uno, grupo_de=lambda e: e[0], maximo_por_grupo=2, limite=6)
    assert len(elegidos) == 6


def test_no_se_ven_tres_videos_seguidos_del_mismo_autor():
    posts = [("ana", 1), ("ana", 2), ("ana", 3), ("beto", 1), ("ana", 4)]
    orden = sin_rachas(posts, grupo_de=lambda p: p[0], maximo_seguidos=2)
    autores = [p[0] for p in orden]
    assert autores[:3] == ["ana", "ana", "beto"]
    assert len(orden) == len(posts)


def test_con_un_solo_creador_la_lista_sale_entera_igualmente():
    """No hay con quien intercalar; dejar huecos seria peor que repetir autor."""
    posts = [("ana", i) for i in range(5)]
    assert sin_rachas(posts, grupo_de=lambda p: p[0], maximo_seguidos=2) == posts


@pytest.mark.parametrize("maximo", [0, -1])
def test_desactivar_la_diversidad_devuelve_el_orden_tal_cual(maximo):
    posts = [("ana", 1), ("ana", 2), ("beto", 1)]
    assert sin_rachas(posts, grupo_de=lambda p: p[0], maximo_seguidos=maximo) == posts
