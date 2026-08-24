"""Lo que la V1.1 tenia que arreglar, escrito como escenarios.

Cuatro cosas, y cada una protege una confusion concreta que rompe el producto:

  1. INTERES NO ES EXPERIENCIA. Que a alguien le guste la carpinteria no le
     convierte en quien puede ensenarla. Si esto se cae, Z recomienda
     compañeros de afición donde deberia recomendar quien sabe.

  2. UN AUTOR NO ES UN TEMA. Un carpintero tambien publica recetas. Heredarle
     «carpinteria» a todo lo que sube es lo que hacia que el feed mintiera.

  3. LO DE AYER MANDA SOBRE LO DEL MES PASADO, pero lo que la persona DIJO no
     caduca: una cosa es un rastro y otra una declaracion.

  4. RECHAZAR UN VIDEO NO ES RECHAZAR A UNA PERSONA.

Todo son funciones puras sobre datos escritos a mano: ni base de datos, ni
personas inventadas en ningun sitio.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.modules.recommendations.config import (
    COMPATIBILIDAD,
    INTENSIDAD_DE_DEMANDA,
    MAX_TEMAS_POR_PUBLICACION,
    MEDIA_VIDA_DE_SENAL_DIAS,
    PENALIZACION_MAXIMA_POR_TEMA,
    PENALIZACION_POR_RECHAZO,
    PESO_MINIMO_POR_ANTIGUEDAD,
    RELACIONES_DE_OFERTA,
    SUPERFICIES,
)
from app.modules.recommendations.features import Candidato, PerfilDeDemanda, construir
from app.modules.recommendations.ranker import (
    MOTIVO_ENSENA,
    MOTIVO_EXPERIENCIA,
    MOTIVO_INTERES_COMUN,
    MOTIVO_PUEDE_AYUDAR,
    puntuar,
)
from app.modules.recommendations.repository import ActividadDeAutor, peso_por_antiguedad
from app.modules.recommendations.service import _afinidad_tematica

AHORA = datetime(2026, 8, 24, 12, 0, 0, tzinfo=timezone.utc)
SEMILLA = "2026-08-24"

CARPINTERIA = "t-carpinteria"
COCINA = "t-cocina"
NEGOCIOS = "t-negocios"


def _candidato(uid: str, ofrece=None, **extra) -> Candidato:
    return Candidato(
        id=uid,
        oferta={k: frozenset(v) for k, v in (ofrece or {}).items()},
        intereses=frozenset(extra.pop("intereses", set())),
        actividad=extra.pop(
            "actividad",
            ActividadDeAutor(
                publicaciones=4,
                ultima_publicacion=AHORA - timedelta(days=2),
                formatos={"video"},
            ),
        ),
        afinidad=extra.pop("afinidad", 0.0),
    )


def _score(candidato: Candidato, demanda: PerfilDeDemanda) -> float:
    return puntuar(construir(candidato, demanda, ahora=AHORA, semilla=SEMILLA)).score


def _motivos(candidato: Candidato, demanda: PerfilDeDemanda) -> set[str]:
    rasgos = construir(candidato, demanda, ahora=AHORA, semilla=SEMILLA)
    return {m.code for m in puntuar(rasgos).motivos}


# --------------------------------------------------------------------------- #
# 1. Interes no es experiencia
# --------------------------------------------------------------------------- #
ANA_QUIERE_APRENDER = PerfilDeDemanda(
    usuario_id="ana", aprender=frozenset({CARPINTERIA})
)

#: A Carlos le INTERESA la carpinteria. No ha dicho que sepa nada de ella.
CARLOS_INTERESADO = _candidato("carlos", {}, intereses={CARPINTERIA})
#: Pedro dice que puede ayudar, que ensena y que tiene experiencia.
PEDRO_OFRECE = _candidato(
    "pedro",
    {
        "can_help": {CARPINTERIA},
        "teach": {CARPINTERIA},
        "experienced": {CARPINTERIA},
    },
)


def test_quien_ofrece_el_tema_gana_a_quien_solo_lo_tiene_como_interes():
    """El escenario del documento. Si esto se cae, esto no es un recomendador
    de conocimiento: es una lista de gente con aficiones parecidas."""
    assert _score(PEDRO_OFRECE, ANA_QUIERE_APRENDER) > _score(
        CARLOS_INTERESADO, ANA_QUIERE_APRENDER
    )


def test_un_interes_ajeno_no_puntua_como_coincidencia_de_tema():
    """Cero, no «un poco». El interes del otro se mide aparte, como afinidad."""
    rasgos = construir(CARLOS_INTERESADO, ANA_QUIERE_APRENDER, ahora=AHORA, semilla=SEMILLA)
    assert rasgos.tema == 0.0
    assert rasgos.temas_coincidentes == ()
    # Pero SI se reconoce que comparten interes, con otro nombre.
    assert rasgos.interes_comun is True


def test_a_quien_solo_comparte_interes_no_se_le_llama_profesor():
    """La explicacion tiene que ser verdadera aunque la persona aparezca."""
    motivos = _motivos(CARLOS_INTERESADO, ANA_QUIERE_APRENDER)
    assert MOTIVO_INTERES_COMUN in motivos
    assert MOTIVO_ENSENA not in motivos
    assert MOTIVO_PUEDE_AYUDAR not in motivos
    assert MOTIVO_EXPERIENCIA not in motivos


def test_quien_no_ha_declarado_nada_no_tiene_oferta():
    assert CARLOS_INTERESADO.tiene_oferta is False
    assert PEDRO_OFRECE.tiene_oferta is True


# --------------------------------------------------------------------------- #
# 1b. Cada necesidad busca la oferta que le corresponde
# --------------------------------------------------------------------------- #
def test_quien_quiere_aprender_prefiere_a_quien_ensena():
    """Aprender pide alguien que explique, no solo alguien que sepa."""
    profesor = _candidato("p", {"teach": {CARPINTERIA}})
    veterano = _candidato("v", {"experienced": {CARPINTERIA}})
    assert _score(profesor, ANA_QUIERE_APRENDER) > _score(veterano, ANA_QUIERE_APRENDER)


def test_quien_busca_orientacion_prefiere_a_quien_ya_lo_vivio():
    """Y al reves: para orientarse vale mas quien paso por ello que quien lo
    explica en abstracto. Es el mismo par de personas, otra necesidad, otro
    orden: la prueba de que el emparejamiento significa algo."""
    orientacion = PerfilDeDemanda(usuario_id="ana", orientacion=frozenset({CARPINTERIA}))
    profesor = _candidato("p", {"teach": {CARPINTERIA}})
    veterano = _candidato("v", {"experienced": {CARPINTERIA}})
    assert _score(veterano, orientacion) > _score(profesor, orientacion)


def test_una_peticion_pesa_mas_que_una_preferencia():
    """«Quiero aprender X» y «me interesa X» no valen lo mismo."""
    pide = PerfilDeDemanda(usuario_id="a", aprender=frozenset({CARPINTERIA}))
    prefiere = PerfilDeDemanda(usuario_id="a", intereses=frozenset({CARPINTERIA}))
    profesor = _candidato("p", {"teach": {CARPINTERIA}})
    assert _score(profesor, pide) > _score(profesor, prefiere)


def test_la_matriz_cubre_las_tres_necesidades_y_las_tres_ofertas():
    """Un hueco en la matriz seria una necesidad que nadie puede resolver."""
    assert set(COMPATIBILIDAD) == {"learn", "seek_guidance", "interest"}
    for necesidad, ofertas in COMPATIBILIDAD.items():
        assert set(ofertas) == set(RELACIONES_DE_OFERTA), necesidad
        assert all(0.0 < v <= 1.0 for v in ofertas.values())
    assert INTENSIDAD_DE_DEMANDA["interest"] < INTENSIDAD_DE_DEMANDA["learn"]


def test_los_motivos_dicen_exactamente_lo_que_la_persona_declaro():
    """Si solo declaro `experienced`, el motivo no puede decir «ensena»."""
    solo_experiencia = _candidato("v", {"experienced": {CARPINTERIA}})
    motivos = _motivos(solo_experiencia, ANA_QUIERE_APRENDER)
    assert MOTIVO_EXPERIENCIA in motivos
    assert MOTIVO_ENSENA not in motivos


# --------------------------------------------------------------------------- #
# 2. Un autor no es un tema
# --------------------------------------------------------------------------- #
DEMANDA_CARPINTERIA = PerfilDeDemanda(
    usuario_id="ana", aprender=frozenset({CARPINTERIA})
)


def test_manda_el_tema_propio_de_la_publicacion():
    """El caso del carpintero que publica una receta: el video de cocina NO
    puede puntuar como carpinteria solo porque lo subio un carpintero."""
    mesa, propio_mesa = _afinidad_tematica(
        DEMANDA_CARPINTERIA, {CARPINTERIA}, {CARPINTERIA}
    )
    receta, propio_receta = _afinidad_tematica(
        DEMANDA_CARPINTERIA, {COCINA}, {CARPINTERIA}
    )
    assert mesa > 0
    assert receta == 0.0
    assert propio_mesa is True and propio_receta is True


def test_sin_tema_propio_se_hereda_del_autor_pero_vale_menos():
    """Compatibilidad hacia atras: el contenido anterior a la 0027 sigue
    funcionando. Con descuento, porque es una pista y no un hecho."""
    con_tema, _ = _afinidad_tematica(DEMANDA_CARPINTERIA, {CARPINTERIA}, {CARPINTERIA})
    heredado, propio = _afinidad_tematica(DEMANDA_CARPINTERIA, None, {CARPINTERIA})
    assert 0 < heredado < con_tema
    assert propio is False


def test_sin_tema_propio_ni_del_autor_no_se_inventa_afinidad():
    assert _afinidad_tematica(DEMANDA_CARPINTERIA, None, None) == (0.0, False)


def test_una_publicacion_vieja_no_deja_de_puntuar_por_no_tener_temas():
    """Lo que romperia el feed el dia de la migracion: que lo ya publicado
    cayera a cero de golpe."""
    heredado, _ = _afinidad_tematica(DEMANDA_CARPINTERIA, None, {CARPINTERIA})
    assert heredado > 0


def test_sin_preferencias_no_hay_afinidad_tematica_que_calcular():
    sin_nada = PerfilDeDemanda(usuario_id="x")
    assert _afinidad_tematica(sin_nada, {CARPINTERIA}, {CARPINTERIA}) == (0.0, False)


def test_coincidir_en_tres_temas_no_hace_un_video_tres_veces_mejor():
    amplia = PerfilDeDemanda(
        usuario_id="ana", aprender=frozenset({CARPINTERIA, COCINA, NEGOCIOS})
    )
    uno, _ = _afinidad_tematica(amplia, {CARPINTERIA}, None)
    tres, _ = _afinidad_tematica(amplia, {CARPINTERIA, COCINA, NEGOCIOS}, None)
    assert uno > 0
    assert tres <= 1.0
    assert tres < uno * 3


def test_el_tope_de_temas_por_publicacion_es_pequeno_a_proposito():
    """Con mas, etiquetar deja de significar «de esto trata»."""
    assert 1 <= MAX_TEMAS_POR_PUBLICACION <= 5


# --------------------------------------------------------------------------- #
# 3. Decaimiento temporal
# --------------------------------------------------------------------------- #
def test_una_senal_de_hoy_vale_el_doble_que_una_de_hace_una_media_vida():
    hoy = peso_por_antiguedad(AHORA, AHORA)
    media_vida = peso_por_antiguedad(
        AHORA - timedelta(days=MEDIA_VIDA_DE_SENAL_DIAS), AHORA
    )
    assert hoy == pytest.approx(1.0)
    assert media_vida == pytest.approx(0.5, abs=1e-6)


@pytest.mark.parametrize(
    "dias,esperado", [(0, 1.0), (30, 0.5), (60, 0.25), (90, 0.125)]
)
def test_la_curva_es_la_documentada(dias, esperado):
    """Los numeros del documento tienen que ser los del codigo."""
    valor = peso_por_antiguedad(AHORA - timedelta(days=dias), AHORA)
    assert valor == pytest.approx(esperado, abs=1e-6)


def test_una_senal_antigua_conserva_algo_de_peso():
    """Pierde fuerza, no se convierte en mentira. Sin suelo habria un salto
    brusco entre «cuenta un poco» y «no existe»."""
    muy_vieja = peso_por_antiguedad(AHORA - timedelta(days=3650), AHORA)
    assert muy_vieja == pytest.approx(PESO_MINIMO_POR_ANTIGUEDAD)
    assert muy_vieja > 0


def test_una_fecha_futura_no_vale_mas_que_hoy():
    """Relojes desajustados entre cliente y servidor no pueden inflar nada."""
    assert peso_por_antiguedad(AHORA + timedelta(days=5), AHORA) == pytest.approx(1.0)


def test_una_fecha_sin_zona_horaria_no_revienta_el_calculo():
    sin_zona = (AHORA - timedelta(days=30)).replace(tzinfo=None)
    assert peso_por_antiguedad(sin_zona, AHORA) == pytest.approx(0.5, abs=1e-6)


def test_lo_que_la_persona_declaro_no_decae():
    """La prueba de la separacion: el decaimiento se aplica a `behavior_events`
    y a nada mas. Que alguien no entre en dos meses no le quita la carpinteria
    que sabe, ni borra lo que pidio aprender.

    Se comprueba por construccion: `PerfilDeDemanda` no tiene ninguna fecha, asi
    que no hay por donde envejecer una preferencia explicita.
    """
    campos = PerfilDeDemanda(usuario_id="ana").__dataclass_fields__
    assert "aprender" in campos and "orientacion" in campos and "intereses" in campos
    assert not any("fecha" in c or "creado" in c for c in campos)


# --------------------------------------------------------------------------- #
# 4. Rechazar un video no es rechazar a una persona
# --------------------------------------------------------------------------- #
def test_el_rechazo_enfria_el_tema_sin_borrarlo():
    limpio = PerfilDeDemanda(usuario_id="ana", aprender=frozenset({CARPINTERIA}))
    rechazado = PerfilDeDemanda(
        usuario_id="ana",
        aprender=frozenset({CARPINTERIA}),
        penalizacion_por_tema={CARPINTERIA: PENALIZACION_POR_RECHAZO},
    )
    profesor = _candidato("p", {"teach": {CARPINTERIA}})
    assert _score(profesor, rechazado) < _score(profesor, limpio)
    # Pero sigue apareciendo: un rechazo no es una sentencia.
    assert _score(profesor, rechazado) > 0


def test_un_solo_rechazo_apenas_mueve_la_aguja():
    """Puede que el video no gustara, que ya se hubiera visto o que llegara en
    mal momento. Hacen falta varios para que se note."""
    assert PENALIZACION_POR_RECHAZO <= 0.25


def test_el_castigo_acumulado_tiene_techo():
    """Un tema no puede desaparecer para siempre por una mala racha: la persona
    cambia, y un sistema que no le deja volver deja de servirle."""
    assert PENALIZACION_MAXIMA_POR_TEMA < 1.0
    muy_castigado = PerfilDeDemanda(
        usuario_id="ana",
        aprender=frozenset({CARPINTERIA}),
        penalizacion_por_tema={CARPINTERIA: PENALIZACION_MAXIMA_POR_TEMA},
    )
    profesor = _candidato("p", {"teach": {CARPINTERIA}})
    assert _score(profesor, muy_castigado) > 0


def test_el_castigo_del_tema_tambien_llega_al_contenido():
    limpio = PerfilDeDemanda(usuario_id="ana", aprender=frozenset({CARPINTERIA}))
    castigado = PerfilDeDemanda(
        usuario_id="ana",
        aprender=frozenset({CARPINTERIA}),
        penalizacion_por_tema={CARPINTERIA: 0.5},
    )
    sin_castigo, _ = _afinidad_tematica(limpio, {CARPINTERIA}, None)
    con_castigo, _ = _afinidad_tematica(castigado, {CARPINTERIA}, None)
    assert 0 < con_castigo < sin_castigo


# --------------------------------------------------------------------------- #
# 5. Superficies: el vocabulario de la atribucion
# --------------------------------------------------------------------------- #
def test_las_superficies_son_una_lista_cerrada():
    """Una superficie escrita a mano en dos sitios acaba siendo dos, y las
    metricas dejan de sumar."""
    assert "people_for_you" in SUPERFICIES
    assert "for_you_feed" in SUPERFICIES
    assert len(SUPERFICIES) == 5
