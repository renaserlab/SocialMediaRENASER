"""La forma normalizada de una etiqueta, que es de donde cuelga todo lo demas.

POR QUE ESTAS PRUEBAS SON PURAS Y NO TOCAN LA BASE. Lo que se comprueba aqui es
una decision de producto —«que dos textos son la misma etiqueta»— y no una
consulta. Escrita contra HTTP, cada caso costaria levantar un esquema entero
para acabar comprobando una cadena; asi caben treinta casos en un parpadeo y
cuando uno falla se lee exactamente que texto lo rompio.

Si esta regla se rompe, no se rompe una pantalla: se PARTE una etiqueta en dos,
cada mitad se queda con la mitad de las publicaciones, y ninguna de las dos
sirve para descubrir nada. Ademas es irreversible en la practica, porque para
entonces ya hay filas escritas con las dos formas.
"""

from __future__ import annotations

import pytest

from app.modules.content.hashtags import (
    MAX_HASHTAGS_POR_PUBLICACION,
    MAX_LONGITUD,
    extraer,
    normalizar,
)


# --------------------------------------------------------------------------- #
# Lo que pidio el encargo: #IA, #ia y #Ia son LA MISMA etiqueta
# --------------------------------------------------------------------------- #
def test_mayusculas_y_minusculas_son_la_misma_etiqueta():
    assert normalizar("IA") == normalizar("ia") == normalizar("Ia") == "ia"


def test_la_almohadilla_no_forma_parte_de_la_etiqueta():
    """Se guarda «ia», no «#ia»: la almohadilla es sintaxis, no contenido."""
    assert normalizar("#IA") == "ia"
    assert normalizar("ia") == "ia"


def test_los_espacios_de_alrededor_no_cuentan():
    assert normalizar("  #Python  ") == "python"


# --------------------------------------------------------------------------- #
# Tildes: se quitan. La eñe NO.
# --------------------------------------------------------------------------- #
def test_con_tilde_y_sin_tilde_son_la_misma_etiqueta():
    """En un teclado de movil se escribe sin tilde la mitad de las veces.

    Si fueran dos etiquetas, «#programación» y «#programacion» tendrian cada
    una la mitad de las publicaciones y ninguna serviria para descubrir nada.
    """
    assert normalizar("programación") == normalizar("programacion") == "programacion"


def test_la_dieresis_tambien_se_quita():
    """«ü» y «u» son la misma letra con una marca de pronunciacion."""
    assert normalizar("pingüino") == normalizar("pinguino") == "pinguino"


def test_la_ene_se_conserva_y_no_colapsa_con_la_ene_normal():
    """LA EXCEPCION QUE JUSTIFICA EL CODIGO RARO DE `normalizar`.

    La eñe no es una ene con un adorno: es otra letra del alfabeto. Colapsarla
    convertiria «#años» en «#anos», que ademas de ser otra palabra es una
    palabra desafortunada para que aparezca sola en una pantalla.
    """
    assert normalizar("años") == "años"
    assert normalizar("anos") == "anos"
    assert normalizar("años") != normalizar("anos")


def test_la_ene_mayuscula_tambien():
    assert normalizar("AÑOS") == "años"


# --------------------------------------------------------------------------- #
# Lo que NO llega a ser una etiqueta
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("texto", ["", "   ", "#", "###"])
def test_una_etiqueta_vacia_no_es_una_etiqueta(texto: str):
    assert normalizar(texto) is None


@pytest.mark.parametrize("texto", ["1", "2", "2024", "007"])
def test_solo_digitos_no_es_una_etiqueta(texto: str):
    """«Consejo #1, consejo #2» se escribe constantemente en castellano.

    Sin esta regla, cada lista numerada de la aplicacion crearia etiquetas
    basura que ademas mezclarian publicaciones que no tienen nada que ver.
    """
    assert normalizar(texto) is None


def test_un_numero_con_una_letra_si_vale():
    """El limite es «solo digitos», no «lleva digitos»: «#web3» es una etiqueta."""
    assert normalizar("web3") == "web3"


def test_mas_larga_que_el_tope_se_descarta():
    assert normalizar("a" * (MAX_LONGITUD + 1)) is None
    assert normalizar("a" * MAX_LONGITUD) == "a" * MAX_LONGITUD


def test_la_puntuacion_no_sobrevive():
    """Lo que llega por una URL escrita a mano se limpia igual."""
    assert normalizar("salud.mental") == "saludmental"


# --------------------------------------------------------------------------- #
# Extraer del texto: lo que de verdad hace el servidor al publicar
# --------------------------------------------------------------------------- #
def test_extrae_las_etiquetas_del_texto():
    encontradas = extraer("Hoy aprendi de #Python y de #IA")
    assert [clave for clave, _ in encontradas] == ["python", "ia"]


def test_conserva_como_se_escribio_para_poder_pintarla():
    """La forma normalizada manda para buscar; la escrita, para mostrar."""
    encontradas = extraer("Sobre #MiNegocio")
    assert encontradas == [("minegocio", "MiNegocio")]


def test_la_misma_etiqueta_repetida_cuenta_una_vez():
    """Escribir «#ia» tres veces es enfasis, no tres etiquetas.

    Sin esto, la cuenta de publicaciones de una etiqueta mentiria a favor de
    quien la repite, que es justo el incentivo que no se quiere crear.
    """
    encontradas = extraer("#ia #IA #Ia otra vez #iA")
    assert encontradas == [("ia", "ia")]


def test_manda_la_primera_forma_escrita():
    """La primera aparicion decide como se vera la etiqueta si es nueva."""
    assert extraer("#Python y #python") == [("python", "Python")]


def test_el_orden_es_el_del_texto():
    """No se reordena: quien publica decidio que va primero."""
    assert [c for c, _ in extraer("#zeta #alfa #media")] == ["zeta", "alfa", "media"]


def test_una_almohadilla_a_mitad_de_palabra_no_crea_etiqueta():
    """«C#» y «correo#interno» no son etiquetas de nadie."""
    assert extraer("Programo en C# desde 2010") == []
    assert extraer("escribe a correo#interno") == []


def test_la_numeracion_de_una_lista_no_crea_etiquetas():
    """El caso real que motivo la regla de «al menos un no-digito»."""
    assert extraer("Consejo #1, consejo #2 y consejo #3") == []


def test_se_corta_en_el_signo_de_puntuacion():
    """«#python.» es «#python»: el punto es el final de la frase."""
    assert extraer("Me gusta #python. Y ya.") == [("python", "python")]


def test_las_tildes_dentro_del_texto_tambien_se_normalizan():
    assert extraer("Sobre #Programación") == [("programacion", "Programación")]


def test_se_indexan_como_mucho_las_del_tope():
    """El patron de spam «#sigueme #like #f4f» no puede inundar la busqueda."""
    texto = " ".join(f"#etiqueta{i}" for i in range(MAX_HASHTAGS_POR_PUBLICACION + 15))
    assert len(extraer(texto)) == MAX_HASHTAGS_POR_PUBLICACION


def test_al_pasarse_del_tope_se_quedan_las_primeras():
    """Y no unas cualesquiera: las que se escribieron antes.

    Se recortan las ULTIMAS en vez de rechazar la publicacion entera, porque el
    texto se guarda tal cual —no se pierde nada de lo que la persona escribio—
    y negarse a publicar por una costumbre de formato seria mucho peor.
    """
    texto = " ".join(f"#e{i}" for i in range(MAX_HASHTAGS_POR_PUBLICACION + 5))
    claves = [clave for clave, _ in extraer(texto)]
    assert claves == [f"e{i}" for i in range(MAX_HASHTAGS_POR_PUBLICACION)]


def test_un_texto_sin_etiquetas_no_da_ninguna():
    assert extraer("Hoy fue un buen dia") == []


def test_un_texto_vacio_no_revienta():
    assert extraer("") == []
