"""Endpoints de etiquetas: hashtags y candidatos a mencion.

POR QUE UN ROUTER APARTE Y NO DENTRO DE `content/router.py`. Aquel fichero pasa
de las novecientas lineas y es el que tocan todos los cambios de contenido a la
vez; meter aqui cuatro endpoints mas solo habria servido para que cualquier
trabajo sobre el feed y cualquier trabajo sobre las etiquetas chocaran en el
mismo sitio. Son del MISMO modulo —comparten modelos, esquemas y helpers— pero
no del mismo fichero.

Todo lo de aqui responde VACIO cuando las migraciones 0031/0032 no estan
aplicadas. No 404 ni 503: «no hay publicaciones con esta etiqueta» es
exactamente lo que significa una lista vacia, y es la verdad mientras la tabla
no exista.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.content import hashtags, menciones
from app.modules.content.schemas import AuthorSummary, HashtagRead, PostRead
from app.shared.database import get_db
from app.shared.pagination import Page, pagination_params

router = APIRouter(tags=["content"])


# --------------------------------------------------------------------------- #
# Hashtags
# --------------------------------------------------------------------------- #
#
# OJO CON EL ORDEN DE ESTAS RUTAS. `/hashtags/search` va ANTES que
# `/hashtags/{name}`: FastAPI prueba en orden de declaracion, asi que al reves
# buscar etiquetas devolveria la etiqueta llamada «search».


@router.get("/hashtags/search", response_model=list[HashtagRead])
async def buscar_hashtags(
    q: str = Query(min_length=1, max_length=80),
    limit: int = Query(default=10, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
) -> list[HashtagRead]:
    """Etiquetas que empiezan por `q`, las mas usadas primero.

    PUBLICO a proposito, sin sesion: el muro ya se ve sin cuenta desde la
    migracion 0018, y que «#python» existe no es informacion de nadie.

    Lo consume la pantalla de buscar (junto a personas, cursos y eventos) y
    tambien el editor de Crear, para sugerir mientras se escribe.
    """
    return [HashtagRead(**fila) for fila in await hashtags.buscar(db, q, limit)]


@router.get("/hashtags/{name}", response_model=HashtagRead)
async def ver_hashtag(
    name: str,
    db: AsyncSession = Depends(get_db),
) -> HashtagRead:
    """Una etiqueta y su cuenta REAL de publicaciones.

    Una etiqueta que nadie ha usado NO es un 404: se responde con cero
    publicaciones. Un 404 haria pensar que la ruta esta mal escrita, cuando lo
    que pasa es que todavia no ha escrito nadie sobre eso —y la pantalla sabe
    decirlo—. Es tambien lo que ocurre sin la migracion 0031, y por el mismo
    motivo se contesta igual.

    El nombre se devuelve NORMALIZADO: quien entre a `/hashtag/PYTHON` ve
    «#python», que es la etiqueta que de verdad existe.
    """
    encontrada = await hashtags.detalle(db, name)
    if encontrada is not None:
        return HashtagRead(**encontrada)
    normalizada = hashtags.normalizar(name)
    return HashtagRead(
        tag=normalizada or "",
        # Se conserva lo que la persona escribio en la URL para que la cabecera
        # no cambie de aspecto al cargar; si no era una etiqueta valida, queda
        # la forma normalizada (vacia) y la pantalla dice que no hay nada.
        display_tag=(name or "").lstrip("#")[: hashtags.MAX_LONGITUD] or (normalizada or ""),
        posts_count=0,
    )


@router.get("/hashtags/{name}/posts", response_model=list[PostRead])
async def publicaciones_de_hashtag(
    name: str,
    page: Page = Depends(pagination_params),
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> list[PostRead]:
    """Publicaciones de una etiqueta, de la mas nueva a la mas vieja.

    Se resuelve en dos pasos —primero los ids de la etiqueta, despues las
    publicaciones montadas— porque armar una tarjeta de feed (autor, medios,
    contadores, estado propio) ya lo sabe hacer `leer_posts_por_id`. Repetir
    esas cuatro consultas aqui seria pedir que se desincronicen el dia que el
    feed cambie.
    """
    ids = await hashtags.ids_de_publicaciones(
        db, name, limite=page.limit, desplazamiento=page.offset
    )
    if not ids:
        return []
    # Import diferido: `content/router.py` importa este modulo indirectamente a
    # traves de main.py, y hacerlo arriba cerraria el circulo.
    from app.modules.content.router import leer_posts_por_id

    return await leer_posts_por_id(
        db, ids, current_user.id if current_user else None
    )


# --------------------------------------------------------------------------- #
# Candidatos a mencion
# --------------------------------------------------------------------------- #
@router.get("/mentions/candidates", response_model=list[AuthorSummary])
async def candidatos_a_mencion(
    q: str = Query(min_length=1, max_length=80),
    limit: int = Query(default=20, ge=1, le=50),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[AuthorSummary]:
    """A quien puede etiquetar quien esta publicando, buscando por texto.

    EXIGE SESION, al contrario que la busqueda de etiquetas, y no por
    formalismo: el resultado DEPENDE DE QUIEN PREGUNTA —excluye a quien esta
    bloqueado en cualquiera de los dos sentidos— asi que sin identidad la
    respuesta no significa nada. Y la identidad sale del JWT, nunca de un
    parametro: si se pudiera pedir «los candidatos de otra persona», esta lista
    diria a quien tiene bloqueado.

    Es distinta de `/profiles/search`, que es un buscador general y no filtra
    bloqueos. Cambiar aquella habria alterado una pantalla que no tiene nada
    que ver con etiquetar.

    Funciona SIN la migracion 0032: buscar personas no depende de ella. Lo que
    no se puede sin la 0032 es guardar la mencion, y de eso ya avisa el propio
    guardado respondiendo que no etiqueto a nadie.
    """
    filas = await menciones.buscar_candidatos(db, current_user.id, q, limit)
    return [AuthorSummary(**fila) for fila in filas]
