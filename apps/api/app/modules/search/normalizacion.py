"""De lo que alguien escribe a lo que se puede buscar.

TODO ES TEXTO PURO. Ni base de datos, ni FastAPI, ni recomendador: se puede
importar desde un test y comprobar palabra por palabra. Es el sitio donde se
decide que «Carpintería», «carpinteria» y «CARPINTERIAS» son lo mismo, y esa
decision tiene que poder leerse de un vistazo.

EL PLEGADO DE TILDES NO SE REESCRIBE AQUI. Lo hace `content.hashtags.normalizar`
—minusculas, tildes fuera, eñe intacta— y esa funcion ya esta probada y es la
que decide como se indexan las etiquetas de todo el producto. Tener dos formas
de quitar una tilde en el mismo repositorio es como se acaba con «#años» y
«#anos» siendo etiquetas distintas segun quien las mire. Se importa; lo unico
que se anade es el caso que ella descarta a proposito (un termino de solo
digitos: «2024» no es una etiqueta, pero si es una busqueda legitima).

POR QUE NO SE USA EL BUSCADOR DE TEXTO COMPLETO DE POSTGRESQL. Se valoro y se
descarto por dos motivos concretos, no por gusto:

  1. `to_tsvector('spanish', ...)` no existe en SQLite, que es la base sobre la
     que corre la suite entera. Usarlo obligaria a escribir dos consultas
     distintas por cada busqueda —una para produccion y otra para las pruebas—
     y entonces lo que se prueba deja de ser lo que se despliega.
  2. La migracion 0040 puede tardar en aprobarse. El codigo tiene que funcionar
     SIN ella, y un `@@` contra una columna sin indice no es «mas lento»: es
     una consulta que ni siquiera se puede escribir sin la configuracion de
     diccionario aplicada.

Lo que hace falta de verdad del FTS —lematizar «muebles» a «mueble» y entender
que eso tiene que ver con carpinteria— NO lo resuelve el diccionario del
castellano: lo resuelve la taxonomia de temas. Ver `vocabulario.py`.
"""

from __future__ import annotations

import re

from app.modules.content.hashtags import normalizar as _plegar

#: Cuantas palabras de la consulta se miran. Una frase larga («quiero aprender
#: a fabricar muebles de madera para mi casa») no puede convertirse en catorce
#: `LIKE` encadenados: cada palabra de mas es otra pasada por la tabla y las
#: ultimas casi nunca aportan. Seis cubre cualquier frase que alguien escriba
#: de verdad en un buscador de movil.
MAX_TERMINOS = 6

#: Longitud minima para que una palabra cuente. Con una sola letra («a», «y»)
#: el `LIKE '%a%'` devolveria la tabla entera.
MIN_LONGITUD = 2

#: A partir de aqui se prueba tambien el patron sin vocales (ver `patrones`).
#: Por debajo, el esqueleto quedaria tan corto que engancharia cualquier cosa.
MIN_LONGITUD_ESQUELETO = 5

#: Palabras que no dicen nada sobre QUE se busca.
#:
#: Van los conectores de siempre y ademas los verbos de intencion —«quiero»,
#: «aprender», «busco»—, que son justo los que abren las busquedas escritas en
#: lenguaje natural. «Quiero aprender a fabricar muebles» sin ellos es
#: «fabricar muebles», que es lo unico que hay que buscar. Dejarlos dentro haria
#: que cualquier publicacion con la palabra «aprender» puntuara.
PALABRAS_VACIAS: frozenset[str] = frozenset(
    {
        # Articulos, preposiciones y conjunciones.
        "el", "la", "los", "las", "un", "una", "unos", "unas", "lo", "al", "del",
        "de", "en", "por", "para", "con", "sin", "sobre", "entre", "hacia",
        "desde", "hasta", "y", "o", "u", "e", "ni", "que", "qué", "como", "cual",
        "cuales", "donde", "cuando", "mas", "muy", "algo", "alguien", "algun",
        "alguna", "todo", "toda", "todos", "todas", "se", "su", "sus", "mi",
        "mis", "tu", "tus", "me", "te", "le", "les", "nos", "yo", "es", "son",
        "ser", "estar", "hay", "esta", "este", "esto", "esa", "ese", "eso",
        # Verbos de intencion: lo que la gente escribe ANTES de decir el tema.
        "quiero", "quisiera", "queria", "busco", "buscando", "buscar",
        "necesito", "necesitar", "aprender", "aprendiendo", "aprendo",
        "ensenar", "ensename", "saber", "conocer", "hacer", "haciendo",
        "ayuda", "ayudar", "ayudame", "quien", "quienes", "puede", "pueda",
        "gustaria", "empezar", "comenzar", "mejorar", "encontrar",
    }
)

#: Corta por cualquier cosa que no sea letra o digito. `\w` con Unicode deja
#: pasar las tildes y la eñe; de plegarlas ya se encarga `_plegar`.
_SEPARADOR = re.compile(r"[^\w]+", re.UNICODE)

#: Las vocales del castellano, con y sin tilde, mas la dieresis.
_VOCALES = "aeiouáéíóúàèìòùäëïöü"


def plegar(bruto: str) -> str:
    """Una palabra en su forma comparable: minusculas, sin tildes, con eñe.

    Delega en el normalizador de etiquetas y solo cubre lo que aquel descarta:
    un termino de solo digitos. «#2024» no es una etiqueta —seria numeracion—
    pero buscar «2024» dentro de «Contabilidad 2024» si tiene sentido.
    """
    limpio = (bruto or "").strip()
    if not limpio:
        return ""
    return _plegar(limpio) or limpio.lower()


def frase(consulta: str) -> str:
    """La consulta entera plegada, con las palabras separadas por un espacio.

    Hace falta para reconocer los alias de VARIAS palabras («energia solar»,
    «fabricar muebles»): un alias asi no se puede buscar en la lista de
    terminos sueltos porque ahi ya no estan juntos.
    """
    palabras = [plegar(t) for t in _SEPARADOR.split(consulta or "") if t]
    return " ".join(p for p in palabras if p)


def terminos(consulta: str) -> list[str]:
    """Las palabras con las que merece la pena buscar, sin repetir y en orden.

    Si al quitar las palabras vacias no queda NADA, se devuelven las que habia.
    Buscar «que es esto» tiene que dar algo —lo que sea— antes que dar una lista
    vacia: quien lo escribio no sabe que existe una lista de palabras vacias.
    """
    crudas: list[str] = []
    for trozo in _SEPARADOR.split(consulta or ""):
        if not trozo:
            continue
        palabra = plegar(trozo)
        if len(palabra) < MIN_LONGITUD:
            continue
        if palabra not in crudas:
            crudas.append(palabra)

    utiles = [p for p in crudas if p not in PALABRAS_VACIAS]
    elegidas = utiles or crudas
    return elegidas[:MAX_TERMINOS]


def raices(termino: str) -> set[str]:
    """El termino y sus formas cercanas, para que el plural no separe nada.

    «Muebles» y «mueble» son la misma palabra para cualquiera que busque. Esto
    NO es un lematizador y no pretende serlo: quita una «s» o un «es» finales,
    que es el 90% de los plurales del castellano, y anade la forma con «s» para
    el caso contrario («mueble» encontrando el alias «muebles»).

    El resto de la variacion morfologica —«carpintero», «carpinteria»— no se
    intenta adivinar: se escribe a mano en `vocabulario.py`, donde se lee.
    """
    formas = {termino}
    if termino.endswith("es") and len(termino) > 4:
        formas.add(termino[:-2])
    if termino.endswith("s") and len(termino) > 3:
        formas.add(termino[:-1])
    else:
        formas.add(termino + "s")
    return formas


def _esqueleto(termino: str) -> str:
    """El termino con las vocales cambiadas por el comodin de una letra.

    POR QUE EXISTE ESTO, que es el truco menos obvio del modulo. En la base de
    datos el texto esta escrito con tildes —«Carpintería», «Programación»— y en
    un teclado de movil se busca sin ellas. `LIKE '%carpinteria%'` NO encuentra
    «Carpintería», asi que sin esto media busqueda en castellano no funciona.

    La alternativa habitual es `unaccent()`, pero es una extension de PostgreSQL
    que no existe en SQLite y que ademas obligaria a que la migracion 0040
    estuviera aplicada para poder buscar. El comodin `_` de SQL vale en las dos
    bases y no necesita nada instalado: «carpinteria» pasa a `c_rp_nt_r__`, que
    encuentra tanto «carpinteria» como «carpintería».

    LO QUE CUESTA: el esqueleto es menos preciso (podria enganchar una palabra
    con las mismas consonantes) y un patron lleno de comodines no aprovecha el
    indice de trigramas de la 0040. Por eso solo se usa a partir de cinco
    letras, donde las consonantes ya son bastante firma, y siempre ADEMAS del
    patron exacto, nunca en su lugar.
    """
    return "".join("_" if c in _VOCALES else c for c in termino)


def patrones(termino: str) -> list[str]:
    """Los patrones `LIKE` con los que buscar ese termino dentro de un texto.

    Primero el exacto —que es el que puede usar el indice— y despues, si la
    palabra es larga, el que tolera las tildes. Sin repetir: en una palabra sin
    vocales los dos serian el mismo.
    """
    salida = [f"%{termino}%"]
    if len(termino) >= MIN_LONGITUD_ESQUELETO:
        tolerante = f"%{_esqueleto(termino)}%"
        if tolerante not in salida:
            salida.append(tolerante)
    return salida
