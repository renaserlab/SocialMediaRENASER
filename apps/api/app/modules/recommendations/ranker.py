"""En que orden, y por que.

El ranker convierte los rasgos en UN numero y en una lista de motivos. No
consulta nada y no conoce ni FastAPI ni la base de datos: se le dan rasgos, y
devuelve puntuacion. Por eso se puede escribir un escenario completo en un test
—«Ana quiere aprender carpinteria; Carlos la ensena; Lucia hace marketing»— y
comprobar el orden sin crear una sola fila en ninguna parte.

DOS SALIDAS, NO UNA. El score ordena; los motivos explican. El score no sale
nunca a pantalla: «0.8734261» no significa nada para quien lo lee y aparenta
una precision que no existe. Los motivos si, convertidos en una frase por la
interfaz. Y el desglose completo se puede pedir en desarrollo para saber por
que alguien salio primero.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.modules.recommendations.config import PESOS_DE_PERSONAS, PesosDePersonas
from app.modules.recommendations.features import Rasgos

# --------------------------------------------------------------------------- #
# Motivos
# --------------------------------------------------------------------------- #
#: Coincide en temas que la persona quiere aprender. Lleva los temas dentro.
MOTIVO_TEMA = "TOPIC_MATCH"
#: El candidato declara que puede ayudar / ensena / tiene experiencia.
MOTIVO_PUEDE_AYUDAR = "CAN_HELP"
MOTIVO_ENSENA = "TEACHES"
MOTIVO_EXPERIENCIA = "EXPERIENCED"
#: Es el tipo de conexion que se pidio.
MOTIVO_INTENCION = "INTENT_MATCH"
#: Ofrece sesiones 1 a 1 y la persona las prefiere.
MOTIVO_SESIONES = "PREFERRED_1_TO_1"
#: Publica en el formato que la persona prefiere.
MOTIVO_FORMATO = "PREFERRED_FORMAT"
#: Publica y atiende de verdad.
MOTIVO_ACTIVO = "ACTIVE_CREATOR"
#: Comparten intereses. NUNCA lleva temas: nombrarlos revelaria lo que la otra
#: persona busca, que no es informacion publica (ver migracion 0026).
MOTIVO_INTERES_COMUN = "SIMILAR_INTERESTS"
#: El propio usuario ya mostro interes por esta persona o su contenido.
MOTIVO_YA_INTERACTUADO = "YOU_ENGAGED_BEFORE"
#: Aparece por exploracion: todavia sin senales a su favor. Se dice en voz alta
#: en vez de disfrazarlo de coincidencia.
MOTIVO_VOZ_NUEVA = "NEW_VOICE"

#: A partir de que valor un rasgo se considera digno de mencion. Por debajo,
#: mencionarlo seria adornar: «te lo recomendamos porque publica algo de vez
#: en cuando» no ayuda a nadie a decidir.
UMBRAL_PARA_MENCIONAR = 0.35

#: Cuantos temas se nombran como mucho en un motivo. Una frase con siete temas
#: deja de leerse.
MAX_TEMAS_EN_MOTIVO = 3

#: Cuantos motivos se devuelven. Mas de tres y la tarjeta se convierte en un
#: informe.
MAX_MOTIVOS = 3

_MOTIVO_POR_RELACION = {
    "teach": MOTIVO_ENSENA,
    "can_help": MOTIVO_PUEDE_AYUDAR,
    "experienced": MOTIVO_EXPERIENCIA,
}


@dataclass(frozen=True)
class Motivo:
    code: str
    #: Ids de tema. Solo se rellenan con temas del lado PUBLICO del candidato.
    topics: tuple[str, ...] = ()


@dataclass(frozen=True)
class Puntuacion:
    score: float
    #: Aportacion de cada componente al score final. Se inspecciona en
    #: desarrollo y en los tests; no viaja a produccion.
    desglose: dict[str, float]
    motivos: tuple[Motivo, ...]


def puntuar(rasgos: Rasgos, pesos: PesosDePersonas = PESOS_DE_PERSONAS) -> Puntuacion:
    """Score en 0..1 y los motivos que lo justifican.

    El reparto solo cuenta los componentes que APLICAN. Si alguien no dijo que
    formatos prefiere, el peso del formato no se reparte entre los demas ni se
    cuenta como un cero: sale del denominador. Asi el score de dos personas con
    respuestas distintas sigue siendo comparable, y apagar un componente
    (peso 0) no hunde todos los numeros.
    """
    componentes: list[tuple[str, float, float | None]] = [
        ("tema", pesos.tema, rasgos.tema),
        ("intencion", pesos.intencion, rasgos.intencion),
        ("formato", pesos.formato, rasgos.formato),
        ("actividad", pesos.actividad, rasgos.actividad),
        ("comportamiento", pesos.comportamiento, rasgos.comportamiento),
        ("reputacion", pesos.reputacion, rasgos.reputacion),
        ("exploracion", pesos.exploracion, rasgos.exploracion),
    ]

    total_peso = 0.0
    acumulado = 0.0
    desglose: dict[str, float] = {}
    for nombre, peso, valor in componentes:
        if valor is None or peso <= 0:
            continue
        aporte = peso * valor
        desglose[nombre] = round(aporte, 6)
        acumulado += aporte
        total_peso += peso

    score = acumulado / total_peso if total_peso > 0 else 0.0
    desglose["final"] = round(score, 6)
    return Puntuacion(score=score, desglose=desglose, motivos=_motivos(rasgos))


def _motivos(rasgos: Rasgos) -> tuple[Motivo, ...]:
    """Los motivos, del mas informativo al menos.

    El orden no es cosmetico: la interfaz pinta el primero y guarda el resto
    para «por que aparece». Que «coincide en carpinteria» vaya antes que
    «publica a menudo» es lo que hace que la frase explique algo.
    """
    salida: list[Motivo] = []
    temas = rasgos.temas_coincidentes[:MAX_TEMAS_EN_MOTIVO]

    if rasgos.tema is not None and rasgos.tema > 0 and temas:
        salida.append(Motivo(MOTIVO_TEMA, temas))

    # Que ofrece exactamente sobre esos temas. Sale de la interseccion, no de
    # una etiqueta suelta: es la diferencia entre «ensena algo» y «ensena
    # justo lo que tu buscas».
    for relacion in rasgos.relaciones_coincidentes:
        motivo = _MOTIVO_POR_RELACION.get(relacion)
        if motivo:
            salida.append(Motivo(motivo, temas))
    if not rasgos.relaciones_coincidentes and rasgos.intencion:
        salida.append(Motivo(MOTIVO_INTENCION))

    if "sesion_1a1" in rasgos.formatos_coincidentes:
        salida.append(Motivo(MOTIVO_SESIONES))
    elif rasgos.formato is not None and rasgos.formato >= UMBRAL_PARA_MENCIONAR:
        salida.append(Motivo(MOTIVO_FORMATO))

    if rasgos.comportamiento is not None and rasgos.comportamiento >= UMBRAL_PARA_MENCIONAR:
        salida.append(Motivo(MOTIVO_YA_INTERACTUADO))

    if rasgos.interes_comun:
        salida.append(Motivo(MOTIVO_INTERES_COMUN))

    if rasgos.activo and rasgos.actividad >= UMBRAL_PARA_MENCIONAR:
        salida.append(Motivo(MOTIVO_ACTIVO))

    # Sin nada que contar, se dice la verdad: aparece para darle una
    # oportunidad. Es preferible a inventarse una coincidencia.
    if not salida:
        salida.append(Motivo(MOTIVO_VOZ_NUEVA))

    # Sin repetidos y conservando el orden.
    vistos: set[str] = set()
    unicos: list[Motivo] = []
    for motivo in salida:
        if motivo.code in vistos:
            continue
        vistos.add(motivo.code)
        unicos.append(motivo)
    return tuple(unicos[:MAX_MOTIVOS])
