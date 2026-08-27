"""El endpoint de la busqueda global. `GET /api/v1/search`.

Este fichero solo traduce HTTP: valida la entrada, saca la identidad del token
y llama al repositorio. Ninguna regla de producto vive aqui.

TRES DECISIONES QUE ATRAVIESAN EL FICHERO:

1. LA IDENTIDAD SALE DEL TOKEN, NUNCA DE UN PARAMETRO. El resultado depende de
   quien pregunta —bloqueos, publicaciones de a quien sigue, sus propios
   borradores no—, asi que aceptar un `viewer_id` del cliente seria dejar
   buscar «como si fuera otra persona». La sesion es OPCIONAL: sin ella se
   busca en lo publico, igual que el muro se ve sin cuenta desde la 0018.

2. UN GRUPO QUE FALLA NO TUMBA LA BUSQUEDA. Cada seccion se pide dentro de su
   propia red: si los cursos revientan, salen las personas y las publicaciones
   y la seccion de cursos viene vacia. Es la misma leccion que ya esta escrita
   en `recommendations/router.py`: un 500 de Starlette NO lleva cabeceras CORS,
   asi que en la web se lee como «sin conexion» y se busca el fallo donde no
   esta.

3. LA DETECCION DE TEMAS TAMBIEN VA ENVUELTA. Los temas son la taxonomia del
   recomendador (`topics`, 0026), y ESA ES LA UNICA DEPENDENCIA que la busqueda
   tiene con ese modulo: una tabla, no un servicio. Si leerla falla, la busqueda
   sigue siendo lexica: se encuentra menos y se encuentra. Buscar no puede
   depender de que el recomendador este sano.

PAGINAR EXIGE `type`. Sin `type` se devuelve la PRIMERA pagina de cada grupo, y
`next_offset` dice cuales tienen mas; para seguir leyendo uno se vuelve a pedir
con `type=posts&offset=10`. La alternativa —un `offset` que avanzara los cinco
grupos a la vez— haria que pedir la pagina 2 de publicaciones se saltara
personas que nadie habia visto todavia.
"""

from __future__ import annotations

import logging
from typing import Awaitable, Callable, TypeVar

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import AuthUser, get_optional_user
from app.modules.search import normalizacion, repositorio, temas
from app.modules.search.schemas import TIPOS, SearchResults, TopicHit
from app.shared.database import get_db

logger = logging.getLogger("renaser.search")

router = APIRouter(tags=["search"])

#: Cuantos resultados trae cada grupo por defecto. Diez llenan una pantalla de
#: movil sin llenar la respuesta: quien busca casi siempre pulsa en los tres
#: primeros o vuelve a escribir.
LIMITE_POR_DEFECTO = 10

#: El techo. No es una cifra magica: cinco grupos por cincuenta filas ya es una
#: respuesta grande, y nadie mira el resultado cuarenta de una busqueda.
LIMITE_MAXIMO = 50

#: Mas largo que esto no es una busqueda, es un texto pegado. Cortarlo aqui
#: evita que `LIKE` reciba patrones absurdos (`normalizacion` se queda con seis
#: palabras de todas formas).
MAX_LONGITUD_CONSULTA = 120

#: El `type` admitido, construido a partir de la MISMA tupla que usan los
#: esquemas. Escrito a mano en dos sitios, el dia que se anada un grupo se
#: anadiria en uno solo.
PATRON_DE_TIPO = "^(" + "|".join(TIPOS) + ")$"

T = TypeVar("T")


async def _a_salvo(nombre: str, tarea: Callable[[], Awaitable[T]], vacio: T) -> T:
    """Ejecuta un grupo de la busqueda sin que su fallo se lleve los demas.

    Recibe una FUNCION y no una corutina ya creada: crearla y no esperarla
    —cuando el grupo ni siquiera se pide— deja un aviso de corutina huerfana en
    los logs por cada busqueda.
    """
    try:
        return await tarea()
    except Exception:  # noqa: BLE001 - degradar es el objetivo. Ver el modulo.
        logger.exception("[busqueda] el grupo «%s» fallo", nombre)
        return vacio


@router.get("/search", response_model=SearchResults)
async def buscar(
    q: str = Query(min_length=1, max_length=MAX_LONGITUD_CONSULTA),
    type: str | None = Query(default=None, pattern=PATRON_DE_TIPO),
    limit: int = Query(default=LIMITE_POR_DEFECTO, ge=1, le=LIMITE_MAXIMO),
    offset: int = Query(default=0, ge=0),
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> SearchResults:
    """Personas, publicaciones, etiquetas, cursos y eventos para una consulta.

    QUE ARREGLA ESTO. Hasta ahora la pantalla de buscar filtraba `state.posts`
    —las veinte publicaciones que el telefono ya se habia descargado, asi que
    una publicacion de hace tres meses era inencontrable— y se descargaba el
    CATALOGO ENTERO de cursos para filtrarlo con un `includes`. Las dos cosas
    pasan a resolverse en la base, que es donde estan todas las filas.

    QUE TIENE DE «INTELIGENTE», dicho sin adornos: «quiero aprender a fabricar
    muebles» encuentra carpinteria porque «muebles» esta escrito a mano en
    `vocabulario.py` y lleva al tema `carpinteria`, que es un id que se cruza
    contra `post_topics`, `course_topics` y `user_topic_relations`. NO hay
    semantica, ni embeddings, ni modelo: hay un diccionario de sinonimos sobre
    la taxonomia que el producto ya tenia. Falla de forma predecible y se
    corrige anadiendo una palabra.

    LO QUE NUNCA SALE DE AQUI: lo que una persona declara QUERER APRENDER. Ver
    `repositorio._oferta_publica` y `schemas.PersonHit`.

    `type` acota la respuesta a un solo grupo y es lo que permite paginar; sin
    el se devuelve la primera pagina de todos.
    """
    viewer_id = current_user.id if current_user else None

    detectados = await _a_salvo("temas", lambda: temas.detectar(db, q), [])
    consulta = repositorio.Consulta(
        texto=normalizacion.frase(q),
        terminos=tuple(normalizacion.terminos(q)),
        temas=tuple(t.id for t in detectados),
    )

    salida = SearchResults(
        query=q,
        topics=[TopicHit(id=t.id, slug=t.slug, name=t.name) for t in detectados],
    )
    if not consulta.hay_algo:
        # Ni una palabra util ni un tema: no hay nada que preguntarle a la base.
        # Se responde vacio y no 400 —quien escribio «de la» no cometio ningun
        # error— y sobre todo se ahorran cinco recorridos de tabla por tecla.
        return salida

    # El `offset` avanza el grupo PEDIDO. Sin `type` siempre es la primera
    # pagina: ver el docstring del modulo.
    salto = offset if type else 0
    pedido = {
        grupo: (type is None or type == grupo)
        for grupo in TIPOS
    }

    if pedido["people"]:
        salida.people, salida.next_offset["people"] = await _a_salvo(
            "people",
            lambda: repositorio.personas(
                db, consulta, viewer_id=viewer_id, limite=limit, salto=salto
            ),
            ([], None),
        )
    if pedido["posts"]:
        salida.posts, salida.next_offset["posts"] = await _a_salvo(
            "posts",
            lambda: repositorio.publicaciones(
                db, consulta, viewer_id=viewer_id, limite=limit, salto=salto
            ),
            ([], None),
        )
    if pedido["hashtags"]:
        salida.hashtags, salida.next_offset["hashtags"] = await _a_salvo(
            "hashtags",
            lambda: repositorio.etiquetas_sociales(
                db, consulta, limite=limit, salto=salto
            ),
            ([], None),
        )
    if pedido["courses"]:
        salida.courses, salida.next_offset["courses"] = await _a_salvo(
            "courses",
            lambda: repositorio.cursos(
                db, consulta, viewer_id=viewer_id, limite=limit, salto=salto
            ),
            ([], None),
        )
    if pedido["events"]:
        salida.events, salida.next_offset["events"] = await _a_salvo(
            "events",
            lambda: repositorio.eventos(db, consulta, limite=limit, salto=salto),
            ([], None),
        )

    return salida
