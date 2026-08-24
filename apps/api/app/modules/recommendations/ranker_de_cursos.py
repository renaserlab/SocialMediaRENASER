"""En que orden salen los cursos, y por que.

Convierte rasgos en UN numero y en una lista de motivos. No consulta nada.

DOS SALIDAS, NO UNA. El score ordena; los motivos explican. El score NO sale a
pantalla: «0.8734261» no significa nada para quien lo lee y aparenta una
precision que no existe. Los motivos si, convertidos en una frase por la
interfaz: «Te lo recomendamos porque quieres aprender Inteligencia Artificial».

LA REGLA QUE NO SE PUEDE ROMPER: un motivo tiene que ser VERDAD. Si un curso
sale primero por afinidad con su autor, el motivo dice eso y no se inventa una
coincidencia tematica que no existe. Un sistema que explica mal es peor que uno
que no explica, porque ensena a desconfiar de lo que dice.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.modules.recommendations.config import PESOS_DE_CURSOS, PesosDeCursos
from app.modules.recommendations.rasgos_de_curso import RasgosDeCurso

# --------------------------------------------------------------------------- #
# Motivos
# --------------------------------------------------------------------------- #
#: Trata de algo que la persona quiere aprender. Lleva los temas dentro.
MOTIVO_TEMA = "COURSE_TOPIC_MATCH"
#: Encaja con lo que dijo que venia a hacer (aprender, buscar cursos).
MOTIVO_OBJETIVO = "LEARNING_GOAL_MATCH"
#: Prefiere aprender en formato curso.
MOTIVO_FORMATO = "PREFERRED_COURSE_FORMAT"
#: De alguien a quien sigue o cuyo contenido consume.
MOTIVO_AUTOR = "CREATOR_AFFINITY"
#: Por lo que ha estado mirando ultimamente.
MOTIVO_INTERES_RECIENTE = "RECENT_INTEREST"
#: Publicado hace poco.
MOTIVO_NUEVO = "NEW_COURSE"
#: Aparece por exploracion, sin nada a su favor todavia. Se dice en voz alta
#: en vez de disfrazarlo de coincidencia.
MOTIVO_POR_DESCUBRIR = "WORTH_A_LOOK"

#: A partir de que valor un rasgo merece mencionarse. Por debajo, mencionarlo
#: seria adornar.
UMBRAL_PARA_MENCIONAR = 0.35

#: Cuantos temas se nombran como mucho. Una frase con cinco temas no se lee.
MAX_TEMAS_EN_MOTIVO = 3

#: Cuantos motivos se devuelven. Mas de tres y la tarjeta es un informe.
MAX_MOTIVOS = 3


@dataclass(frozen=True)
class MotivoDeCurso:
    code: str
    #: Ids de tema. Solo del propio curso, que son publicos: los temas del
    #: curso los declara quien lo publica, al contrario que la demanda de una
    #: persona, que es privada.
    topics: tuple[str, ...] = ()


@dataclass(frozen=True)
class PuntuacionDeCurso:
    score: float
    #: Aportacion de cada componente. Se inspecciona en desarrollo y en las
    #: pruebas; no viaja a produccion.
    desglose: dict[str, float]
    motivos: tuple[MotivoDeCurso, ...]


def puntuar(
    rasgos: RasgosDeCurso, pesos: PesosDeCursos = PESOS_DE_CURSOS
) -> PuntuacionDeCurso:
    """Score en 0..1 y los motivos que lo justifican.

    El reparto solo cuenta los componentes que APLICAN. Un curso nuevo, con
    menos inscritos de los que hacen falta para que la popularidad signifique
    algo, no arrastra un cero: ese componente sale del denominador. Sin eso,
    ser nuevo seria un castigo automatico y ningun curso podria despegar.
    """
    componentes: list[tuple[str, float, float | None]] = [
        ("tema", pesos.tema, rasgos.tema),
        ("intencion", pesos.intencion, rasgos.intencion),
        ("formato", pesos.formato, rasgos.formato),
        ("autor", pesos.autor, rasgos.autor),
        ("comportamiento", pesos.comportamiento, rasgos.comportamiento),
        ("popularidad", pesos.popularidad, rasgos.popularidad),
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
    return PuntuacionDeCurso(score=score, desglose=desglose, motivos=_motivos(rasgos))


def _motivos(rasgos: RasgosDeCurso) -> tuple[MotivoDeCurso, ...]:
    """Los motivos, del mas informativo al menos.

    El orden no es cosmetico: la interfaz pinta el primero y guarda el resto
    para «por que aparece». Que «trata de Inteligencia Artificial, que quieres
    aprender» vaya antes que «es nuevo» es lo que hace que la frase explique
    algo en lugar de rellenar.
    """
    salida: list[MotivoDeCurso] = []
    temas = rasgos.temas_coincidentes[:MAX_TEMAS_EN_MOTIVO]

    # 1. La coincidencia tematica, que es la razon de ser de esta seccion.
    if rasgos.tema is not None and rasgos.tema > 0 and temas:
        salida.append(MotivoDeCurso(MOTIVO_TEMA, temas))

    # 2. Lo que la persona dijo que venia a hacer. Solo si NO se explico ya por
    #    el tema: «quieres aprender IA y esto es IA» y «venias a aprender» son
    #    la misma frase dicha dos veces.
    if not salida and rasgos.intencion is not None and rasgos.intencion > 0:
        salida.append(MotivoDeCurso(MOTIVO_OBJETIVO))

    # 3. Quien lo firma.
    if rasgos.autor is not None and rasgos.autor >= UMBRAL_PARA_MENCIONAR:
        salida.append(MotivoDeCurso(MOTIVO_AUTOR))

    # 4. Lo que ha estado mirando. Se menciona con temas SOLO si los hay: sin
    #    ellos seria «por lo que miras» sin poder decir el que.
    if (
        rasgos.comportamiento is not None
        and rasgos.comportamiento >= UMBRAL_PARA_MENCIONAR
        and not temas
    ):
        salida.append(MotivoDeCurso(MOTIVO_INTERES_RECIENTE))

    if rasgos.formato is not None and rasgos.formato > 0 and len(salida) < MAX_MOTIVOS:
        salida.append(MotivoDeCurso(MOTIVO_FORMATO))

    if rasgos.reciente and len(salida) < MAX_MOTIVOS:
        salida.append(MotivoDeCurso(MOTIVO_NUEVO))

    # Sin nada que contar se dice la verdad: aparece para darle una
    # oportunidad. Es preferible a inventarse una coincidencia.
    if not salida:
        salida.append(MotivoDeCurso(MOTIVO_POR_DESCUBRIR))

    vistos: set[str] = set()
    unicos: list[MotivoDeCurso] = []
    for motivo in salida:
        if motivo.code in vistos:
            continue
        vistos.add(motivo.code)
        unicos.append(motivo)
    return tuple(unicos[:MAX_MOTIVOS])
