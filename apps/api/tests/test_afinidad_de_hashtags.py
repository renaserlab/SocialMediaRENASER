"""Que las etiquetas muevan el feed sin poder secuestrarlo.

Un hashtag lo escribe quien publica, no un sistema. Es una senal util y barata
de falsificar a la vez, asi que casi todo lo que se prueba aqui es lo que NO
puede pasar: que rocie de almohadillas suba a cualquiera, que aplaste al tema,
o que le cambie el feed a alguien que acaba de llegar.
"""

from app.modules.recommendations.config import (
    PESOS_DE_CONTENIDO,
    SATURACION_DE_HASHTAG,
)
from app.modules.recommendations.service import _bonus_de_hashtag

PESOS = PESOS_DE_CONTENIDO


def test_sin_historial_no_mueve_nada():
    """El primer dia de alguien. Sin esto, el arranque en frio se rompe."""
    assert _bonus_de_hashtag({"h-python"}, {}, PESOS) == 0.0


def test_sin_etiquetas_no_mueve_nada():
    """Casi todo el contenido de Z no lleva etiquetas y no puede salir castigado."""
    assert _bonus_de_hashtag(None, {"h-python": 50.0}, PESOS) == 0.0
    assert _bonus_de_hashtag(set(), {"h-python": 50.0}, PESOS) == 0.0


def test_una_etiqueta_que_interesa_sube_la_publicacion():
    assert _bonus_de_hashtag({"h-python"}, {"h-python": 4.0}, PESOS) > 0.0


def test_una_etiqueta_que_no_interesa_no_sube_nada():
    """Coincidir en la almohadilla no basta: tiene que ser una que se haya tocado."""
    assert _bonus_de_hashtag({"h-cocina"}, {"h-python": 50.0}, PESOS) == 0.0


def test_llenar_la_publicacion_de_etiquetas_no_sirve_de_nada():
    """La trampa evidente, y la razon de quedarse con el maximo y no la suma.

    Si se sumara, bastaria con escribir quince almohadillas para aparecer en el
    feed de todo el mundo. Con el maximo, poner etiquetas de mas no aporta:
    solo cuenta la que de verdad interesa.
    """
    afinidad = {"h-python": 4.0, "h-ia": 3.0, "h-datos": 2.0}
    solo_la_buena = _bonus_de_hashtag({"h-python"}, afinidad, PESOS)
    rociado = _bonus_de_hashtag(
        {"h-python", "h-ia", "h-datos", "h-x", "h-y", "h-z"}, afinidad, PESOS
    )
    assert rociado == solo_la_buena


def test_el_bonus_nunca_puede_imponerse_al_tema():
    """El techo. El tema pesa 0,40 y esta respaldado por la taxonomia de Z;
    una etiqueta la escribe cualquiera. Aunque alguien acumule una obsesion,
    el empujon no puede acercarse a lo que decide de que trata algo."""
    obsesion = {"h-python": SATURACION_DE_HASHTAG * 1000}
    maximo = _bonus_de_hashtag({"h-python"}, obsesion, PESOS)
    assert maximo == PESOS.hashtag
    assert maximo < PESOS.tema


def test_mas_interes_nunca_puntua_menos_que_menos_interes():
    """Monotonia. Es la propiedad que se rompio una vez en el ranker de
    personas —una senal a favor bajaba la puntuacion— y que no puede volver a
    romperse por otro camino."""
    anterior = -1.0
    for acumulado in (0.0, 0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 1000.0):
        bonus = _bonus_de_hashtag({"h-python"}, {"h-python": acumulado}, PESOS)
        assert bonus >= anterior
        anterior = bonus


def test_el_hashtag_no_entra_en_el_divisor_de_la_media():
    """Si entrara, estrenar la primera etiqueta hundiria de golpe todo el
    contenido que no lleva ninguna, que hoy es casi todo el catalogo."""
    suma_de_componentes = (
        PESOS.tema
        + PESOS.autor
        + PESOS.recencia
        + PESOS.interaccion
        + PESOS.exploracion
    )
    assert PESOS.total() == suma_de_componentes
    assert PESOS.hashtag > 0
