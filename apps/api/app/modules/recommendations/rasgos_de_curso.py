"""Medir un curso frente a lo que una persona necesita.

Funciones PURAS: entra lo que se sabe, sale un numero por componente. No hay
base de datos, ni FastAPI, ni reloj propio. Por eso un escenario completo
—«Ana quiere aprender IA; el curso A es de IA; el B es de marketing»— se puede
escribir en una prueba sin crear una sola fila.

`None` NO ES CERO, y es la distincion que sostiene todo el reparto. `None`
significa «este componente no aplica a esta persona»: quien no dijo que
formatos prefiere no tiene una preferencia de formato del cero por ciento, es
que no hay nada que medir. El ranker saca del denominador lo que no aplica, asi
que dos personas con respuestas distintas siguen teniendo scores comparables.

LO QUE DELIBERADAMENTE NO SE MIDE: el precio. Ni caro ni gratis significan
mejor; es metadato de acceso. Y la reputacion, porque no existen resenas
verificadas y unas estrellas inventadas serian peor que ninguna.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

from app.modules.recommendations.config import (
    DIAS_DE_NOVEDAD_DE_CURSO,
    FORMATO_DE_CURSO,
    INTENSIDAD_DE_DEMANDA,
    MAX_TEMAS_POR_CURSO,
    MINIMO_PARA_POPULARIDAD,
    OBJETIVOS_QUE_PIDEN_CURSOS,
    SATURACION_DE_POPULARIDAD,
)
from app.modules.recommendations.features import PerfilDeDemanda, exploracion_de


@dataclass(frozen=True)
class CursoCandidato:
    """Lo que se sabe de un curso que podria servirle a alguien."""

    id: str
    author_id: str
    #: Sus temas declarados (`course_topics`). Vacio = nadie dijo de que trata.
    temas: frozenset[str] = frozenset()
    creado: datetime | None = None
    #: Cuanta gente tiene acceso. Es lo unico parecido a popularidad que hay, y
    #: pesa poco a proposito.
    inscritos: int = 0
    #: Senal acumulada de la persona hacia el AUTOR (perfiles abiertos, su
    #: contenido consumido...), ya con decaimiento aplicado.
    senal_del_autor: float = 0.0
    ya_sigue_al_autor: bool = False


@dataclass(frozen=True)
class RasgosDeCurso:
    """El curso medido. `None` = no aplica."""

    tema: float | None
    intencion: float | None
    formato: float | None
    autor: float | None
    comportamiento: float | None
    popularidad: float | None
    exploracion: float

    #: Pruebas de lo anterior, para poder explicarlo despues sin adivinar.
    temas_coincidentes: tuple[str, ...] = ()
    #: Por que via coincidieron: `learn`, `seek_guidance` o `interest`.
    relaciones_coincidentes: tuple[str, ...] = ()
    sigue_al_autor: bool = False
    #: Sin tema declarado NO se puede explicar por el tema, aunque encaje por
    #: otras vias. Se guarda para que el motivo diga la verdad.
    tiene_temas: bool = False
    reciente: bool = False
    objetivos_coincidentes: tuple[str, ...] = field(default=())


def _saturar(valor: float, techo: float) -> float:
    if techo <= 0:
        return 0.0
    return min(1.0, max(0.0, valor) / techo)


def _rasgo_de_tema(
    demanda: PerfilDeDemanda, curso: CursoCandidato
) -> tuple[float | None, tuple[str, ...], tuple[str, ...]]:
    """Cuanto encaja el curso con lo que la persona quiere aprender.

    UN CURSO NO NECESITA DECLARAR QUE ENSENA: enseñar es lo que es. Por eso
    aqui no hay matriz de compatibilidad como en personas —donde hacia falta
    distinguir a quien ensena de quien solo se interesa— sino la INTENSIDAD de
    la demanda: querer aprender algo pide un curso de eso con mucha mas fuerza
    que simplemente interesarse por ello.

    Coincidir en tres temas no hace un curso tres veces mejor: con uno ya es
    relevante y los siguientes suman menos.
    """
    if not demanda.tiene_demanda:
        return None, (), ()
    if not curso.temas:
        # Nadie dijo de que trata. NO se hereda el tema del autor, como si se
        # hace con las publicaciones: un curso es una obra deliberada y quien
        # lo publica elige sus temas al publicarlo. Suponerlos aqui pondria
        # cursos de cocina delante de quien pidio carpinteria solo porque los
        # firma la misma persona.
        return 0.0, (), ()

    mejor_por_tema: dict[str, float] = {}
    relaciones: set[str] = set()
    for relacion, buscados in demanda.por_relacion.items():
        intensidad = INTENSIDAD_DE_DEMANDA.get(relacion, 0.0)
        if intensidad <= 0:
            continue
        for tema in curso.temas & buscados:
            if intensidad > mejor_por_tema.get(tema, 0.0):
                mejor_por_tema[tema] = intensidad
            relaciones.add(relacion)

    if not mejor_por_tema:
        return 0.0, (), ()

    # El castigo por «no me interesa» resta relevancia sin borrar el tema: la
    # persona cambia, y un sistema que no la deja volver deja de servirle.
    castigo = max(
        (demanda.penalizacion_por_tema.get(t, 0.0) for t in mejor_por_tema), default=0.0
    )
    intensidad_maxima = max(mejor_por_tema.values())
    cobertura = min(1.0, len(mejor_por_tema) / MAX_TEMAS_POR_CURSO + 0.55)
    valor = intensidad_maxima * cobertura * max(0.0, 1.0 - castigo)

    # Se nombran los que MAS fuerte coinciden primero, y con orden estable para
    # que la misma coincidencia produzca siempre la misma frase.
    ordenados = sorted(mejor_por_tema.items(), key=lambda par: (-par[1], par[0]))
    return valor, tuple(t for t, _ in ordenados), tuple(sorted(relaciones))


def _rasgo_de_intencion(
    demanda: PerfilDeDemanda, objetivos: frozenset[str]
) -> tuple[float | None, tuple[str, ...]]:
    """Si esta persona vino buscando formacion.

    EMPUJA, NO FILTRA. Quien respondio «conectar con personas afines» tambien
    puede querer un curso; convertir esto en un filtro dejaria sin cursos a
    media aplicacion por una respuesta de una sola pregunta.
    """
    if not objetivos:
        return None, ()
    coincidentes = objetivos & OBJETIVOS_QUE_PIDEN_CURSOS
    if not coincidentes:
        # Respondio, y lo que respondio no pide formacion. Eso es informacion:
        # cero, no «no aplica».
        return 0.0, ()
    return 1.0, tuple(sorted(coincidentes))


def _rasgo_de_formato(demanda: PerfilDeDemanda) -> float | None:
    """Si prefiere aprender en formato curso."""
    if not demanda.formatos:
        return None
    return 1.0 if FORMATO_DE_CURSO in demanda.formatos else 0.0


def _rasgo_de_autor(
    demanda: PerfilDeDemanda, curso: CursoCandidato
) -> tuple[float | None, bool]:
    """Cuanto le importa a esta persona quien firma el curso.

    MODERADO A PROPOSITO. Seguir a alguien dice que su contenido interesa, no
    que su curso sea el que hace falta. Con el peso de este componente (0.15)
    frente al del tema (0.45), un seguido con tema flojo no puede adelantar a
    un desconocido que ensena justo lo que se busca. Hay una prueba que lo fija.
    """
    if not demanda.tiene_senales and not curso.ya_sigue_al_autor:
        return None, False
    # Seguir es una decision explicita y vale mas que unas cuantas visitas;
    # ninguna de las dos llega sola al maximo.
    por_senales = _saturar(curso.senal_del_autor, 3.0) * 0.6
    por_seguir = 0.55 if curso.ya_sigue_al_autor else 0.0
    return min(1.0, por_senales + por_seguir), curso.ya_sigue_al_autor


def _rasgo_de_comportamiento(
    demanda: PerfilDeDemanda, curso: CursoCandidato
) -> float | None:
    """Interes reciente por los temas de este curso, medido por lo que hace.

    Es el bucle de aprendizaje: quien empieza en negocios y acaba abriendo
    contenido de programacion ve subir los cursos de programacion sin haber
    tocado sus preferencias. El decaimiento ya viene aplicado desde el
    repositorio: lo de ayer pesa mas que lo de hace mes y medio.
    """
    if not demanda.tiene_senales:
        return None
    if not curso.temas:
        return 0.0
    acumulado = max(
        (demanda.afinidad_por_tema.get(tema, 0.0) for tema in curso.temas), default=0.0
    )
    return _saturar(acumulado, 4.0)


def _rasgo_de_popularidad(curso: CursoCandidato) -> float | None:
    """Que a otra gente le haya servido.

    NO APLICA por debajo de `MINIMO_PARA_POPULARIDAD`. Con tres inscritos, la
    diferencia entre dos cursos es ruido con aspecto de metrica, y meterla en
    el reparto como un cero castigaria a todo curso nuevo por serlo.
    """
    if curso.inscritos < MINIMO_PARA_POPULARIDAD:
        return None
    return _saturar(float(curso.inscritos), float(SATURACION_DE_POPULARIDAD))


def _es_reciente(curso: CursoCandidato, ahora: datetime) -> bool:
    if curso.creado is None:
        return False
    creado = curso.creado
    if creado.tzinfo is None:
        creado = creado.replace(tzinfo=timezone.utc)
    dias = (ahora - creado).total_seconds() / 86400.0
    return 0 <= dias <= DIAS_DE_NOVEDAD_DE_CURSO


def construir(
    demanda: PerfilDeDemanda,
    curso: CursoCandidato,
    *,
    objetivos: frozenset[str],
    semilla: str,
    ahora: datetime,
) -> RasgosDeCurso:
    """Todo lo medible de un curso para esta persona, de una vez."""
    tema, temas_coincidentes, relaciones = _rasgo_de_tema(demanda, curso)
    intencion, objetivos_coincidentes = _rasgo_de_intencion(demanda, objetivos)
    autor, sigue = _rasgo_de_autor(demanda, curso)
    return RasgosDeCurso(
        tema=tema,
        intencion=intencion,
        formato=_rasgo_de_formato(demanda),
        autor=autor,
        comportamiento=_rasgo_de_comportamiento(demanda, curso),
        popularidad=_rasgo_de_popularidad(curso),
        # Determinista: la misma persona ve el mismo orden dentro de la misma
        # ventana. Con azar de verdad, pasar a la pagina 2 repetiria cursos y
        # ninguna prueba podria comprobar un orden.
        exploracion=exploracion_de(demanda.usuario_id, curso.id, semilla),
        temas_coincidentes=temas_coincidentes,
        relaciones_coincidentes=relaciones,
        sigue_al_autor=sigue,
        tiene_temas=bool(curso.temas),
        reciente=_es_reciente(curso, ahora),
        objetivos_coincidentes=objetivos_coincidentes,
    )
