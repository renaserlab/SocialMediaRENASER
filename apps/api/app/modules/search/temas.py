"""De la consulta a los temas REALES de la base, sin depender del recomendador.

LA REGLA DE ESTE FICHERO, y es la que pidio el encargo: la busqueda tiene que
seguir funcionando aunque el recomendador este caido o degradado.

QUE SE REUSA Y QUE NO. Se reusa la TABLA `topics` —el modelo ORM de
`recommendations.models`— porque la taxonomia es una sola y duplicarla seria
tener dos listas de temas que se separan al primer cambio. NO se llama a
`recommendations.service` ni a `recommendations.repository`: ahi vive el
ranking, la generacion de candidatos y la cache, y todo eso puede fallar sin
que buscar tenga por que dejar de funcionar. Importar una tabla es compartir el
esquema; llamar a un servicio es heredar su disponibilidad, y no es lo mismo.

Y POR SI ACASO, la deteccion entera va envuelta: si consultar `topics` falla
—porque la 0026 no estuviera, porque la conexion se cayo a mitad, por lo que
sea— se devuelve una lista vacia y la busqueda sigue siendo lexica. Se
encuentra menos, pero se encuentra: media busqueda es infinitamente mejor que
un 500 que el navegador ademas confundira con un fallo de red.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.recommendations.models import Topic
from app.modules.search import normalizacion, vocabulario

logger = logging.getLogger("renaser.search")

#: Cuantos temas puede activar una consulta. Sin tope, una frase larga podria
#: encender media taxonomia y entonces «coincide por tema» dejaria de
#: distinguir nada: todo coincidiria con todo.
MAX_TEMAS = 4


@dataclass(frozen=True)
class TemaDetectado:
    """Un tema de la taxonomia que la consulta menciona, directa o por alias."""

    id: str
    slug: str
    name: str


async def detectar(db: AsyncSession, consulta: str) -> list[TemaDetectado]:
    """Los temas de los que habla la consulta. Nunca lanza.

    Dos vias, y las dos hacen falta:

    1. EL NOMBRE DEL TEMA. «carpinteria» encuentra «Carpintería» porque los dos
       se pliegan igual. Esto funciona para cualquier tema que exista en la
       base, incluidos los que siembre una migracion futura sin que nadie haya
       escrito alias para ellos.
    2. EL VOCABULARIO. «muebles» encuentra «Carpintería» porque alguien escribio
       esa equivalencia en `vocabulario.py`. Es lo que hace que una frase en
       lenguaje normal llegue a un tema.
    """
    try:
        filas = (
            await db.execute(
                select(Topic.id, Topic.slug, Topic.name)
                .where(Topic.active.is_(True))
                .order_by(Topic.position, Topic.name)
            )
        ).all()
    except Exception:  # noqa: BLE001 - ver el docstring del modulo.
        logger.warning(
            "No se pudieron leer los temas: la busqueda sigue, solo por texto.",
            exc_info=True,
        )
        return []

    por_alias = vocabulario.slugs_de(consulta)
    palabras = set()
    for termino in normalizacion.terminos(consulta):
        palabras.update(normalizacion.raices(termino))
    texto = normalizacion.frase(consulta)

    encontrados: list[TemaDetectado] = []
    for topic_id, slug, nombre in filas:
        # El slug lleva guiones («carrera-profesional»); el nombre lleva tildes
        # y espacios. Se pliegan los dos para compararlos con lo que se escribio.
        slug_plano = normalizacion.frase((slug or "").replace("-", " "))
        nombre_plano = normalizacion.frase(nombre or "")
        if slug in por_alias or _coincide(nombre_plano, palabras, texto) or _coincide(
            slug_plano, palabras, texto
        ):
            encontrados.append(TemaDetectado(id=topic_id, slug=slug, name=nombre))

    return encontrados[:MAX_TEMAS]


def _coincide(nombre: str, palabras: set[str], texto: str) -> bool:
    """Si el nombre plegado de un tema esta en la consulta.

    Un nombre de VARIAS palabras («inteligencia artificial») se busca entero
    dentro de la frase; uno de una sola, palabra a palabra. La diferencia no es
    cosmetica: buscar «arte» como subcadena lo encontraria dentro de
    «compartes», y entonces cualquier frase con esa palabra saldria clasificada
    como Arte.
    """
    if not nombre:
        return False
    if " " in nombre:
        return nombre in texto
    return nombre in palabras
