"""Endpoints de las resenas entre personas: A opina de B, y sale en el perfil de B.

QUE ESTABA ROTO. La aplicacion ya tenia un boton «Agregar resena», pero escribia
en `testimonials`, que es la galeria de fotos y videos de UN autor: archivo
obligatorio, texto opcional y ninguna columna que diga sobre quien se opina.
Con esa forma, lo que A escribia salia en el perfil de A. Ademas la interfaz
daba los botones de editar y borrar a quien es dueno del perfil, de modo que el
dueno podia quitar lo que otro publicara ahi.

DONDE VIVE CADA REGLA. Todas estan DOS VECES: en la RLS de la 0030 y aqui.
No es duplicar por gusto:

  * La RLS es la que manda, porque la aplicacion movil escribe contra PostgREST
    para otras cosas y una comprobacion que solo viva en el servidor se salta.
  * El backend las repite para poder responder con un motivo legible —«no
    puedes reseñarte a ti mismo»— en vez de con un error de restriccion de la
    base, que en la pantalla se lee como un fallo tecnico.

LA REGLA QUE DA SENTIDO A TODO ESTO: quien recibe una resena NO puede borrarla.
Solo la borra quien la escribio, o la moderacion. Si a la persona resenada le
parece abusiva, la reporta (`/api/v1/reports`) y decide quien modera. Si el
opinado pudiera quitar lo que no le gusta, en cada perfil quedaria solo lo
favorable y leer las resenas no serviria para nada.

SIN LA MIGRACION 0030 ESTE MODULO NO REVIENTA: los listados responden vacio y
las escrituras responden 503 con `reviews_not_available`. Ver `esquema.py`: un
500 sale del servidor sin cabeceras CORS y en el navegador se disfraza de fallo
de red, que es horas buscando en el sitio equivocado.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    ConflictError,
    ForbiddenError,
    NotFoundError,
    ServiceUnavailableError,
    ValidationAppError,
)
from app.core.security import AuthUser, get_current_user
from app.modules.profiles.models import Profile
from app.modules.recommendations import esquema
from app.modules.reviews import verificacion
from app.modules.reviews.models import ProfileReview, ReviewMedia
from app.modules.reviews.schemas import (
    ReviewCreate,
    ReviewMediaRead,
    ReviewRead,
    ReviewsAvailability,
    ReviewUpdate,
)
from app.modules.social_graph.models import UserBlock
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.permissions import is_admin

router = APIRouter(prefix="/reviews", tags=["reviews"])


async def _exigir_esquema(db: AsyncSession) -> None:
    """Sin la 0030 no hay donde guardar una resena.

    503 y no 404: la funcion existe, lo que falta es que este montada. Un 404
    haria pensar que la ruta esta mal escrita y se buscaria en el cliente.
    Los listados NO llaman aqui: responden vacio, porque «todavia no hay
    resenas» es exactamente la verdad.
    """
    if not await esquema.hay_resenas_de_perfil(db):
        raise ServiceUnavailableError(
            "Las reseñas todavía no están disponibles.",
            code="reviews_not_available",
        )


async def _bloqueados(db: AsyncSession, user_id: str) -> set[str]:
    """A quien no se puede ver ni por quien se puede ser visto.

    El corte es SIMETRICO, igual que en el resto de Z: cortar un solo sentido
    dejaria que a quien te bloqueo le siguieran apareciendo tus resenas, o al
    reves, que las suyas siguieran en tu perfil.
    """
    filas = (
        await db.execute(
            select(UserBlock.blocker_id, UserBlock.blocked_id).where(
                or_(UserBlock.blocker_id == user_id, UserBlock.blocked_id == user_id)
            )
        )
    ).all()
    salida: set[str] = set()
    for blocker, blocked in filas:
        salida.add(blocked if blocker == user_id else blocker)
    return salida


def _exigir_ruta_propia(paths: list[str], uid: str) -> None:
    """Cada archivo tiene que colgar de la carpeta de quien lo sube.

    La politica de Storage del bucket `post-media` (migracion 0001) exige que
    la primera carpeta de la ruta sea el uid de quien escribe. Si aqui se
    aceptara `otra-persona/foto.jpg`, la fila quedaria guardada apuntando a un
    archivo que esa cuenta no subio —y que puede desaparecer o no existir—,
    dejando una resena con un hueco roto para siempre.

    Se comprueba ANTES de escribir nada: descubrirlo despues obligaria a
    deshacer una insercion ya hecha.
    """
    for path in paths:
        if not path.startswith(f"{uid}/"):
            raise ValidationAppError(
                "El archivo no está en tu carpeta de almacenamiento.",
                code="review_media_path_invalid",
            )


async def _leer(
    db: AsyncSession, resenas: list[ProfileReview], uid: str
) -> list[ReviewRead]:
    """Las resenas con su autor y sus archivos. Consultas CONSTANTES.

    Dos consultas para toda la lista, no dos por resena: en un perfil con
    treinta resenas la diferencia son sesenta viajes a la base por pantalla.
    """
    if not resenas:
        return []

    # OJO: nunca `columna_uuid.in_(lista or [""])`. La cadena vacia contra una
    # columna `uuid` cuela en SQLite y PostgreSQL la rechaza; el manejador de
    # DBAPIError lo convierte en un 404 silencioso, asi que el perfil respondia
    # «no encontrado» en vez de una lista. Si no hay resenas ya se ha salido
    # arriba, y aqui los conjuntos nunca estan vacios.
    autores = {
        p.id: p
        for p in (
            await db.scalars(
                select(Profile).where(Profile.id.in_({r.reviewer_id for r in resenas}))
            )
        ).all()
    }

    medios: dict[str, list[ReviewMedia]] = {}
    for medio in (
        await db.scalars(
            select(ReviewMedia)
            .where(ReviewMedia.review_id.in_({r.id for r in resenas}))
            .order_by(ReviewMedia.sort_order)
        )
    ).all():
        medios.setdefault(medio.review_id, []).append(medio)

    admin = await is_admin(db, uid)

    salida: list[ReviewRead] = []
    for resena in resenas:
        autor = autores.get(resena.reviewer_id)
        salida.append(
            ReviewRead(
                id=resena.id,
                reviewer_id=resena.reviewer_id,
                reviewed_user_id=resena.reviewed_user_id,
                reviewer_name=autor.full_name if autor else "",
                reviewer_username=autor.username if autor else None,
                reviewer_avatar_path=autor.avatar_path if autor else None,
                body=resena.body,
                status=resena.status,
                media=[
                    ReviewMediaRead(
                        id=m.id,
                        storage_path=m.storage_path,
                        media_type=m.media_type,
                        sort_order=m.sort_order,
                    )
                    for m in medios.get(resena.id, [])
                ],
                verified_source=resena.verified_source,
                created_at=resena.created_at,
                updated_at=resena.updated_at,
                # Quien la escribio y la moderacion. NUNCA la persona resenada:
                # es la regla entera de esta seccion.
                can_manage=admin or resena.reviewer_id == uid,
            )
        )
    return salida


async def _guardar_medios(
    db: AsyncSession, review_id: str, entradas: list, uid: str
) -> None:
    """Reemplaza los archivos de una resena por los que llegan.

    Se borran los anteriores y se escriben los nuevos en vez de intentar
    casarlos uno a uno: son como mucho tres, y una lista corta reescrita entera
    no puede quedar a medias con un orden inconsistente.

    Las filas de `review_media` se van; los ficheros del bucket NO. Borrarlos
    aqui dejaria a una resena sin su foto si la escritura fallara despues, y la
    limpieza de huerfanos ya tiene su sitio (`app/shared/storage.py`).
    """
    await db.execute(delete(ReviewMedia).where(ReviewMedia.review_id == review_id))
    _exigir_ruta_propia([e.storage_path for e in entradas], uid)
    for orden, entrada in enumerate(entradas):
        db.add(
            ReviewMedia(
                review_id=review_id,
                storage_path=entrada.storage_path,
                media_type=entrada.media_type,
                sort_order=orden,
            )
        )


async def _resena_gestionable(
    db: AsyncSession, review_id: str, uid: str
) -> ProfileReview:
    """La resena, si quien pide puede tocarla. 403 si no.

    AQUI ESTA LA REGLA QUE FALTABA EN `testimonials`: se compara con
    `reviewer_id`, NUNCA con `reviewed_user_id`. La persona de la que se opina
    no aparece en esta comprobacion, y esa ausencia es deliberada.
    """
    ensure_uuid(review_id, "Reseña no encontrada.")
    resena = await db.get(ProfileReview, review_id)
    if resena is None:
        raise NotFoundError("Reseña no encontrada.")
    if resena.reviewer_id == uid:
        return resena
    if await is_admin(db, uid):
        return resena
    if resena.reviewed_user_id == uid:
        # Mensaje propio: es la confusion mas probable de todas y merece una
        # explicacion, no un «no tienes permiso» seco. Cubre borrar Y editar,
        # porque editar es la otra forma de hacerla desaparecer: dejar el texto
        # en «genial» borra la opinion sin borrar la fila.
        raise ForbiddenError(
            "No puedes modificar ni borrar una reseña que han escrito sobre ti. "
            "Si crees que incumple las normas, repórtala.",
            code="review_not_yours_to_delete",
        )
    raise ForbiddenError("Esta reseña no es tuya.", code="review_not_yours")


# --------------------------------------------------------------------------- #
# Lectura
# --------------------------------------------------------------------------- #
@router.get("/availability", response_model=ReviewsAvailability)
async def disponibilidad(
    _: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ReviewsAvailability:
    """Si en ESTA base se pueden escribir resenas.

    Existe para que la aplicacion no ensene el boton «Escribir resena» mientras
    la 0030 espere aprobacion. Ofrecerlo y responder 503 al pulsarlo es la
    misma pantalla cargando de siempre, solo que con otro motivo.
    """
    return ReviewsAvailability(available=await esquema.hay_resenas_de_perfil(db))


@router.get("/received/{user_id}", response_model=list[ReviewRead])
async def recibidas(
    user_id: str,
    limit: int = Query(default=20, ge=1, le=50),
    offset: int = Query(default=0, ge=0),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ReviewRead]:
    """Lo que han escrito SOBRE esta persona. Es la seccion de su perfil.

    Sin la 0030 responde VACIO en vez de fallar: «todavia no le ha escrito
    nadie» es exactamente lo que significa una lista vacia, y es la verdad.
    """
    if not await esquema.hay_resenas_de_perfil(db):
        return []
    ensure_uuid(user_id, "Perfil no encontrado.")

    consulta = select(ProfileReview).where(ProfileReview.reviewed_user_id == user_id)

    # Lo escondido por moderacion no se entrega, salvo a quien lo escribio
    # —para que no le desaparezca sin explicacion— y a quien modera.
    if not await is_admin(db, current_user.id):
        consulta = consulta.where(
            or_(
                ProfileReview.status == "published",
                ProfileReview.reviewer_id == current_user.id,
            )
        )

    # Los bloqueos cortan en los dos sentidos, y sobre LAS DOS PERSONAS de la
    # resena. Filtrar solo por quien la escribio no bastaba: si Ana y Bruno se
    # bloquean, a Ana le seguia apareciendo en el perfil de Bruno la resena que
    # ella misma le escribio —su propio `reviewer_id` nunca esta en la lista de
    # bloqueados—. La RLS de la 0030 mira los dos extremos; esto hace lo mismo.
    #
    # La lista vacia NO se manda a la consulta: `in_([])` contra una columna
    # uuid es el 404 silencioso de la nota de arriba.
    bloqueados = await _bloqueados(db, current_user.id)
    if bloqueados:
        if user_id in bloqueados:
            # El perfil entero esta cortado: no hay nada que ensenar de el.
            return []
        consulta = consulta.where(ProfileReview.reviewer_id.not_in(list(bloqueados)))

    filas = list(
        await db.scalars(
            consulta.order_by(ProfileReview.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
    )
    return await _leer(db, filas, current_user.id)


@router.get("/mine", response_model=list[ReviewRead])
async def mias(
    limit: int = Query(default=20, ge=1, le=50),
    offset: int = Query(default=0, ge=0),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ReviewRead]:
    """Las que YO he escrito.

    Hace falta para poder editarlas o borrarlas sin tener que recordar en que
    perfil quedaron: es lo unico que una persona puede hacer con sus propias
    resenas una vez publicadas.
    """
    if not await esquema.hay_resenas_de_perfil(db):
        return []
    filas = list(
        await db.scalars(
            select(ProfileReview)
            .where(ProfileReview.reviewer_id == current_user.id)
            .order_by(ProfileReview.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
    )
    return await _leer(db, filas, current_user.id)


# --------------------------------------------------------------------------- #
# Escritura
# --------------------------------------------------------------------------- #
@router.post("", response_model=ReviewRead, status_code=status.HTTP_201_CREATED)
async def publicar(
    payload: ReviewCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ReviewRead:
    """Publica una resena sobre otra persona.

    QUIEN FIRMA NO SE ELIGE: sale del JWT (`current_user.id`), nunca del cuerpo
    de la peticion. Si viniera del cliente, cualquiera podria firmar una opinion
    con el nombre de otro, y en una seccion de resenas eso no es una travesura.
    """
    await _exigir_esquema(db)
    ensure_uuid(payload.reviewed_user_id, "Perfil no encontrado.")

    # AUTORESENA: fuera. Esta prohibida ademas por un CHECK en la base (0030);
    # aqui se corta antes para poder decir por que en vez de devolver un error
    # de restriccion que en la pantalla se lee como un fallo tecnico.
    if payload.reviewed_user_id == current_user.id:
        raise ValidationAppError(
            "No puedes escribir una reseña sobre ti mismo.",
            code="review_self_not_allowed",
        )

    resenado = await db.get(Profile, payload.reviewed_user_id)
    if resenado is None:
        raise NotFoundError("Perfil no encontrado.")

    # Bloqueo simetrico: ni se opina de quien te bloqueo, ni de quien bloqueaste.
    if payload.reviewed_user_id in await _bloqueados(db, current_user.id):
        raise ForbiddenError(
            "No puedes escribir una reseña sobre esta persona.",
            code="review_blocked",
        )

    # Una por pareja. Se comprueba antes para poder explicarlo; el indice unico
    # de la 0030 es el que lo garantiza de verdad cuando dos peticiones llegan
    # a la vez.
    existente = await db.scalar(
        select(ProfileReview.id).where(
            ProfileReview.reviewer_id == current_user.id,
            ProfileReview.reviewed_user_id == payload.reviewed_user_id,
        )
    )
    if existente is not None:
        raise ConflictError(
            "Ya has escrito una reseña sobre esta persona. Puedes editarla.",
            code="review_already_exists",
        )

    _exigir_ruta_propia([m.storage_path for m in payload.media], current_user.id)

    resena = ProfileReview(
        reviewer_id=current_user.id,
        reviewed_user_id=payload.reviewed_user_id,
        body=payload.body,
        status="published",
        # El sello NO llega del cliente: se calcula aqui contra las reservas y
        # las compras que ya hay en la base. Ver `verificacion.py`.
        verified_source=await verificacion.fuente_de_verificacion(
            db, current_user.id, payload.reviewed_user_id
        ),
    )
    db.add(resena)
    await db.flush()

    await _guardar_medios(db, resena.id, payload.media, current_user.id)
    await db.commit()
    await db.refresh(resena)
    return (await _leer(db, [resena], current_user.id))[0]


@router.patch("/{review_id}", response_model=ReviewRead)
async def editar(
    review_id: str,
    payload: ReviewUpdate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ReviewRead:
    """Cambia el texto o los archivos de una resena PROPIA.

    El sello de verificacion no se recalcula: describe el momento en que se
    escribio. Ver la nota de `verificacion.py`.
    """
    await _exigir_esquema(db)
    resena = await _resena_gestionable(db, review_id, current_user.id)

    if payload.body is not None:
        resena.body = payload.body
    if payload.media is not None:
        # `None` = no se tocan. Una lista vacia SI los quita todos, que es como
        # se borra una foto de la que uno se arrepiente.
        await _guardar_medios(db, resena.id, payload.media, resena.reviewer_id)

    await db.commit()
    await db.refresh(resena)
    return (await _leer(db, [resena], current_user.id))[0]


@router.delete("/{review_id}", status_code=status.HTTP_204_NO_CONTENT)
async def borrar(
    review_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Borra una resena PROPIA. La persona resenada no puede.

    Se borra de verdad y no se esconde: es la opinion de quien la escribio, y
    si se retracta no hay ningun registro que preservar. Distinto es esconder
    por moderacion, que si deja rastro (`status = 'hidden'`).

    Los archivos del bucket no se tocan aqui; la limpieza de huerfanos tiene su
    sitio en `app/shared/storage.py`.
    """
    await _exigir_esquema(db)
    resena = await _resena_gestionable(db, review_id, current_user.id)
    await db.delete(resena)
    await db.commit()


@router.post("/{review_id}/hide", response_model=ReviewRead)
async def esconder(
    review_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ReviewRead:
    """Esconde una resena. SOLO moderacion.

    Es la via de la persona resenada cuando algo le parece abusivo: no la borra
    ella, la reporta y modera quien modera. Se esconde y no se borra para que la
    decision quede registrada y se pueda revisar; quien la escribio la sigue
    viendo, para que no le desaparezca sin explicacion.
    """
    await _exigir_esquema(db)
    ensure_uuid(review_id, "Reseña no encontrada.")
    if not await is_admin(db, current_user.id):
        raise ForbiddenError(
            "Solo la moderación puede esconder una reseña.",
            code="review_moderation_only",
        )
    resena = await db.get(ProfileReview, review_id)
    if resena is None:
        raise NotFoundError("Reseña no encontrada.")
    resena.status = "hidden"
    await db.commit()
    await db.refresh(resena)
    return (await _leer(db, [resena], current_user.id))[0]
