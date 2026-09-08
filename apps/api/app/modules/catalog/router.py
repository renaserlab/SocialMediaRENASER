"""Endpoints del catálogo: eventos (con reservas) y cursos (lista)."""

from datetime import datetime

from fastapi import APIRouter, Depends, Header, Query, Request, Response, status
from sqlalchemy import delete, func, literal, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    ConflictError,
    NotFoundError,
    ServiceUnavailableError,
    ValidationAppError,
)
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.catalog import contenido, cursos_v2, esquema, eventos, versiones
from app.modules.catalog.models import Course, Event, EventRegistration, SavedCourse
from app.modules.commerce import esquema as esquema_comercio
from app.modules.commerce.service import _insert as _insert_de_comercio
from app.modules.catalog.schemas import (
    IDIOMA,
    NIVEL,
    CoursePublishResult,
    CourseCreate,
    CourseLessonCreate,
    CourseLessonRead,
    CourseLessonUpdate,
    CourseModuleCreate,
    CourseModuleRead,
    CourseModuleUpdate,
    CourseOrder,
    CourseRead,
    CourseRequirements,
    CourseReviewDecision,
    CourseSubmitResult,
    CourseUpdate,
    EventCreate,
    EventRead,
    EventUpdate,
)
from app.modules.learning.models import CourseLesson, CourseModule
from app.modules.gobernanza import auditoria
from app.modules.gobernanza.schemas import VersionDeCurso
from app.modules.gobernanza.contexto import leer_origen
from app.modules.recommendations import cache as memoria_del_recomendador
from app.modules.recommendations import temas_de_curso
from app.modules.recommendations.models import CourseTopic
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.pagination import Page, pagination_params
from app.shared.permissions import require_admin, require_owner_or_admin

router = APIRouter(prefix="/catalog", tags=["catalog"])


@router.post("/events", response_model=EventRead, status_code=status.HTTP_201_CREATED)
async def create_event(
    payload: EventCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EventRead:
    """Publica un evento o una cita. Queda a nombre de quien lo organiza.

    Lo que protege esto de verdad es el servidor, no la interfaz: que la app
    oculte un boton no impide llamar al endpoint a mano. Por eso editar sigue
    comprobandose aqui contra el organizador.
    """
    event = Event(
        organizer_id=current_user.id,
        title=payload.title,
        description=payload.description,
        starts_at=payload.starts_at,
        ends_at=payload.ends_at,
        location=payload.location,
        cover_path=payload.cover_path,
        whatsapp_url=payload.whatsapp_url,
        event_type=payload.event_type,
        status="published",
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    return _to_event_read(event, 0, 0)


@router.patch("/events/{event_id}", response_model=EventRead)
async def update_event(
    event_id: str,
    payload: EventUpdate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EventRead:
    ensure_uuid(event_id, "Evento no encontrado.")
    event = await db.get(Event, event_id)
    if event is None:
        raise NotFoundError("Evento no encontrado.")
    await require_owner_or_admin(
        db, event.organizer_id, current_user, "No puedes editar este evento."
    )
    # `exclude_unset` distingue "no enviado" de "enviado vacio", igual que en
    # el perfil: sin ello, editar el titulo borraria el resto de campos.
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(event, field, value)
    await db.commit()
    await db.refresh(event)
    return _to_event_read(event, 0, 0)


@router.patch("/courses/{course_id}", response_model=CourseRead)
async def update_course(
    course_id: str,
    payload: CourseUpdate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CourseRead:
    ensure_uuid(course_id, "Curso no encontrado.")
    course = await db.get(Course, course_id)
    if course is None:
        raise NotFoundError("Curso no encontrado.")
    await require_owner_or_admin(
        db, course.author_id, current_user, "No puedes editar este curso."
    )
    data = payload.model_dump(exclude_unset=True)

    # El precio se resuelve aparte porque llega por dos nombres: `price_minor`
    # (el bueno) y `price` (el viejo, en unidad mayor). Si vienen los dos manda
    # el primero. Si no viene ninguno, no se toca.
    centavos = payload.centavos()
    data.pop("price_minor", None)
    data.pop("price", None)
    if centavos is not None:
        course.price_minor = centavos

    temas = data.pop("topic_ids", None)
    ficha = {k: data.pop(k) for k in cursos_v2.CAMPOS_EDITABLES if k in data}
    if "highlights" in data:
        # `highlights` SI esta mapeada en el ORM (existe desde la 0013), asi que
        # se guarda por el camino de siempre. Va aparte solo para limpiarla.
        data["highlights"] = _frases(data["highlights"])

    # La categoria principal se lee de la ficha ACTUAL cuando el cliente no la
    # menciona: hace falta para saber cual de las filas de `course_topics` era
    # la suya y no confundirla con un tema mas del autor.
    anterior = (await cursos_v2.leer_una(db, course.id)).primary_topic_id
    toca_la_categoria = "primary_topic_id" in ficha
    principal = (
        await _tema_principal_valido(db, ficha) if toca_la_categoria else anterior
    )

    for field, value in data.items():
        setattr(course, field, value)

    if temas is not None or toca_la_categoria:
        await _guardar_temas(
            db,
            course_id=course.id,
            autor_id=course.author_id,
            principal=principal,
            principal_anterior=anterior,
            elegidos=temas,
        )
    if ficha:
        await cursos_v2.guardar(db, course.id, _ficha_limpia(ficha))

    await db.commit()
    await db.refresh(course)
    return await _leer_curso(db, course)


@router.post("/courses", response_model=CourseRead, status_code=status.HTTP_201_CREATED)
async def create_course(
    payload: CourseCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CourseRead:
    """Crea la ficha de un curso. Nace como BORRADOR, a nombre de quien lo crea.

    POR QUE BORRADOR Y NO PUBLICADO. Antes esta llamada escribia
    `status='published'` directamente, asi que rellenar el titulo y el precio
    publicaba en el catalogo un curso sin un solo modulo. Quien lo creo no habia
    dicho «ya esta»: habia dicho «voy a empezar». Publicar es una decision
    aparte y tiene su propio endpoint, con validaciones que corren en el
    servidor.

    El autor ve su borrador desde el primer segundo en `/catalog/courses/mine`;
    el resto del mundo no lo ve en ningun sitio, ni en el catalogo ni en las
    recomendaciones. Eso ya lo garantiza tambien la RLS (`courses_read`, 0001).
    """
    ficha = {
        campo: getattr(payload, campo)
        for campo in cursos_v2.CAMPOS_EDITABLES
        if getattr(payload, campo) is not None
    }
    principal = await _tema_principal_valido(db, ficha)

    course = Course(
        author_id=current_user.id,
        title=payload.title,
        description=payload.description,
        cover_path=payload.cover_path,
        price_minor=payload.centavos(0) or 0,
        currency=payload.currency,
        status="draft",
        highlights=_frases(payload.highlights or []),
    )
    db.add(course)
    await db.flush()
    if payload.topic_ids or principal:
        await _guardar_temas(
            db,
            course_id=course.id,
            autor_id=current_user.id,
            principal=principal,
            principal_anterior=None,
            elegidos=payload.topic_ids,
        )
    if ficha:
        await cursos_v2.guardar(db, course.id, _ficha_limpia(ficha))
    await db.commit()
    await db.refresh(course)
    return await _leer_curso(db, course)


def _frases(valores: list[str] | None) -> list[str]:
    """Deja las frases que dicen algo, sin espacios sueltos ni duplicados.

    Un punto vacio en «lo que aprenderas» se pinta como una vineta sin texto y
    parece un fallo de la aplicacion. Se limpia al escribir y no al leer,
    porque lo que se guarda es lo que despues se ensena.
    """
    limpias = [v.strip() for v in (valores or []) if v and v.strip()]
    return list(dict.fromkeys(limpias))


def _ficha_limpia(ficha: dict) -> dict:
    """Las listas de la ficha, ya limpias. El resto pasa tal cual."""
    salida = dict(ficha)
    for campo in ("target_audience", "prerequisites"):
        if campo in salida:
            salida[campo] = _frases(salida[campo])
    return salida


async def _tema_principal_valido(db: AsyncSession, ficha: dict) -> str | None:
    """Comprueba que la categoria principal existe y sigue activa.

    Se valida ANTES de escribir nada: aceptar un id inventado dejaria una clave
    foranea rota a mitad de la transaccion, y en PostgreSQL eso se lleva por
    delante la edicion entera del curso.
    """
    principal = ficha.get("primary_topic_id")
    if not principal:
        return None
    await temas_de_curso.validar(db, [principal])
    return principal


async def _guardar_temas(
    db: AsyncSession,
    *,
    course_id: str,
    autor_id: str,
    principal: str | None,
    principal_anterior: str | None,
    elegidos: list[str] | None,
) -> None:
    """Deja el curso con su categoria principal MAS los temas que eligio su autor.

    POR QUE LA PRINCIPAL TAMBIEN SE ESCRIBE EN `course_topics`. Esa tabla (0028)
    es lo que lee el recomendador; si la categoria principal viviera solo en
    `primary_topic_id`, un curso quedaria clasificado en todo MENOS en lo que de
    verdad trata. La tabla dice DE QUE trata y la columna cual de esos temas
    manda.

    POR QUE NO DESCUENTA DEL TOPE. Son 1 + 5, no 5 en total: la principal es la
    categoria y los cinco son «el resto». Haciendola contar, elegir categoria
    dejaba al autor con cuatro huecos en vez de cinco, y ademas sin poder saber
    por que se le habia encogido la lista.

    POR QUE SE ESCRIBE ESA FILA AQUI Y NO EN `temas_de_curso.fijar`. Porque
    `fijar` aplica `MAX_TEMAS_POR_CURSO` a TODO lo que recibe, y ese modulo es
    del recomendador. Los cinco del autor pasan por el —con su validacion y su
    tope intactos— y la principal, que ya se valido aparte, se anade despues.
    El dia que `fijar` sepa de categorias principales, esto son dos lineas menos.

    QUE SE TOCA Y QUE NO. `elegidos = None` significa «el cliente no habla de
    temas»: se conservan los que ya tenia (sin la principal ANTERIOR, que se
    escribe aparte) y solo se cambia la categoria. Sin eso, elegir categoria en
    el asistente vaciaba la clasificacion del curso sin que nadie lo pidiera.
    """
    if not await temas_de_curso.disponible(db):
        # Sin la 0028 no hay donde guardarlos. El curso se crea y se edita
        # igual: que no se pueda clasificar no puede impedir editar el titulo.
        return

    if elegidos is None:
        actuales = (await temas_de_curso.leer(db, [course_id])).get(course_id, [])
        elegidos = [t for t in actuales if t != principal_anterior]

    # Los del autor pasan por la validacion de siempre: existen, siguen activos
    # y no son mas de cinco. La principal no viaja en esta lista.
    del_autor = [t for t in elegidos if t != principal]
    await temas_de_curso.fijar(db, course_id, del_autor, autor_id=autor_id)

    if principal is not None:
        # `fijar` acaba de dejar la tabla con EXACTAMENTE los del autor, asi que
        # esta fila no puede chocar con ninguna: la principal se excluyo arriba.
        db.add(CourseTopic(course_id=course_id, topic_id=principal, source="manual"))


def _to_event_read(
    event: Event, count: int, reserved: int, momento: datetime | None = None
) -> EventRead:
    return EventRead(
        id=event.id,
        organizer_id=event.organizer_id,
        title=event.title,
        description=event.description,
        starts_at=event.starts_at,
        ends_at=event.ends_at,
        location=event.location,
        cover_path=event.cover_path,
        whatsapp_url=event.whatsapp_url,
        event_type=event.event_type,
        status=event.status,
        capacity=event.capacity,
        registrations_count=count or 0,
        reserved_by_me=(reserved or 0) > 0,
        # Se calcula al responder, no al guardar: un evento pasa de próximo a
        # anterior sin que nadie lo edite, y una columna guardada se quedaría
        # mintiendo hasta que alguien la refrescara.
        time_state=eventos.estado_de(event, momento or eventos.ahora()),
    )


async def _registrations_count(db: AsyncSession, event_id: str) -> int:
    value = await db.scalar(
        select(func.count())
        .select_from(EventRegistration)
        .where(EventRegistration.event_id == event_id)
    )
    return value or 0


@router.get("/events", response_model=list[EventRead])
async def list_events(
    when: str = Query(default=eventos.TODOS, pattern=eventos.CUANDO),
    page: Page = Depends(pagination_params),
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> list[EventRead]:
    """Los eventos publicados, separando los que están por llegar de los que ya
    pasaron.

    QUÉ ESTABA MAL. Este listado devolvía cualquier evento publicado ordenado
    por `starts_at` ascendente, así que uno de agosto salía ANTES que uno de
    octubre y las dos pantallas que lo consumen —Explorar y Eventos— lo
    enseñaban bajo el título «Próximos eventos». No era un fallo de redacción:
    el orden ponía primero, y con más presencia, justo lo que ya no se puede
    reservar.

    QUÉ SE DEVUELVE AHORA. `when` elige el grupo (`upcoming`, `past`,
    `undated`) y cada evento llega con su `time_state`. El valor por omisión es
    `all` PORQUE NO SE ESCONDE NADA: los eventos pasados siguen siendo
    consultables, y las versiones ya instaladas de la aplicación —que no envían
    `when`— siguen recibiendo la lista entera. Lo que cambia para ellas es el
    ORDEN: lo vigente primero, lo anterior al final. Ese cambio solo puede
    mejorar una pantalla que se titula «Próximos eventos».

    Los eventos SIN FECHA no se cuelan en ninguno de los otros dos grupos. Ver
    `catalog/eventos.py`.
    """
    uid = current_user.id if current_user else None
    # Un solo instante para toda la respuesta: filtrar, ordenar y etiquetar con
    # tres relojes distintos puede dejar una fila filtrada como próxima y
    # etiquetada como pasada si la petición cae justo en el segundo del cambio.
    momento = eventos.ahora()
    count_sq = (
        select(func.count())
        .select_from(EventRegistration)
        .where(EventRegistration.event_id == Event.id)
        .scalar_subquery()
    )
    reserved_sq = (
        (
            select(func.count())
            .select_from(EventRegistration)
            .where(
                EventRegistration.event_id == Event.id,
                EventRegistration.user_id == uid,
            )
            .scalar_subquery()
        )
        if uid
        else literal(0)
    )
    consulta = select(Event, count_sq, reserved_sq).where(Event.status == "published")
    grupo = eventos.condicion(when, momento)
    if grupo is not None:
        consulta = consulta.where(grupo)
    rows = (
        await db.execute(
            consulta.order_by(*eventos.orden(momento))
            .limit(page.limit)
            .offset(page.offset)
        )
    ).all()
    return [_to_event_read(*row, momento=momento) for row in rows]


@router.post("/events/{event_id}/reserve", response_model=EventRead)
async def reserve_event(
    event_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EventRead:
    event = await db.get(Event, event_id)
    if event is None or event.status != "published":
        raise NotFoundError("Evento no encontrado.")

    existing = await db.get(
        EventRegistration, {"event_id": event_id, "user_id": current_user.id}
    )
    if existing is None:
        # NO SE RESERVA ALGO QUE YA TERMINO. La interfaz dejo de ofrecerlo al
        # separar los eventos por fecha, pero la interfaz no es la proteccion:
        # una peticion directa —o un binario viejo, que sigue enseñando el boton
        # porque no sabe distinguir— apuntaba a este endpoint y se apuntaba a un
        # evento del mes pasado.
        #
        # Se comprueba SOLO al crear la reserva. Quien ya la tenia recibe la
        # misma respuesta de siempre: el evento paso, pero su reserva existio y
        # negarla ahora seria reescribir el pasado.
        if eventos.estado_de(event, eventos.ahora()) == eventos.ANTERIOR:
            raise ConflictError("Ese evento ya terminó.")
        if event.capacity is not None:
            count = await _registrations_count(db, event_id)
            if count >= event.capacity:
                raise ConflictError("El evento alcanzó su capacidad máxima.")
        db.add(EventRegistration(event_id=event_id, user_id=current_user.id))
        await db.commit()

    count = await _registrations_count(db, event_id)
    return _to_event_read(event, count, 1)


@router.delete("/events/{event_id}/reserve", response_model=EventRead)
async def cancel_reservation(
    event_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EventRead:
    event = await db.get(Event, event_id)
    if event is None:
        raise NotFoundError("Evento no encontrado.")
    existing = await db.get(
        EventRegistration, {"event_id": event_id, "user_id": current_user.id}
    )
    if existing is not None:
        await db.delete(existing)
        await db.commit()
    count = await _registrations_count(db, event_id)
    return _to_event_read(event, count, 0)


def _patron_de_busqueda(texto: str) -> str:
    """El texto buscado, convertido en un patron de `LIKE` que no muerde.

    `%` y `_` SON COMODINES EN SQL. Sin escaparlos, buscar «%» devuelve el
    catalogo entero y «a_a» encuentra «ana», «ala» y «aja»: quien busca no sabe
    que ha escrito un comodin y la lista le miente sin avisar. La barra
    invertida se escapa primero, porque si no la que se anade despues se
    duplicaria.

    Es la misma regla que `messaging/router.py` aplica a la bandeja. Se repite y
    no se comparte a proposito: sacarla a `shared/` es tocar dos modulos mas
    para ahorrar una linea.
    """
    limpio = texto.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{limpio}%"


async def _exigir_guardados(db: AsyncSession) -> None:
    if not await esquema.hay_guardados(db):
        raise ServiceUnavailableError(
            "Guardar cursos todavía no está disponible.",
            code="saved_courses_not_available",
        )


@router.get("/courses/saved", response_model=list[CourseRead])
async def cursos_guardados(
    page: Page = Depends(pagination_params),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[CourseRead]:
    """Los cursos que esta persona guardó, del más reciente al más antiguo."""
    await _exigir_guardados(db)
    cursos = list(
        await db.scalars(
            select(Course)
            .join(SavedCourse, SavedCourse.course_id == Course.id)
            .where(SavedCourse.user_id == current_user.id)
            # Orden determinista: sin el desempate por id, dos guardados del
            # mismo instante pueden salir en distinto orden en cada página.
            .order_by(SavedCourse.created_at.desc(), Course.id.desc())
            .limit(page.limit)
            .offset(page.offset)
        )
    )
    return await _leer_cursos(db, cursos)


@router.put("/courses/{course_id}/saved", status_code=status.HTTP_204_NO_CONTENT)
async def guardar_curso(
    course_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Guarda el curso. Llamarlo dos veces deja el mismo resultado."""
    await _exigir_guardados(db)
    cid = ensure_uuid(course_id, "Curso no encontrado.")
    curso = await db.get(Course, cid)
    if curso is None or curso.status != "published":
        # Guardar un borrador ajeno diría que existe.
        raise NotFoundError("Curso no encontrado.")

    # La clave primaria compuesta es la que impide el duplicado; el
    # `on conflict do nothing` recoge la carrera sin romper la transacción.
    await db.execute(
        _insert_de_comercio(db)(SavedCourse.__table__)
        .values(user_id=current_user.id, course_id=cid)
        .on_conflict_do_nothing()
    )
    await db.commit()


@router.delete("/courses/{course_id}/saved", status_code=status.HTTP_204_NO_CONTENT)
async def quitar_curso_guardado(
    course_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Lo quita. Quitar algo que no estaba tampoco es un error."""
    await _exigir_guardados(db)
    cid = ensure_uuid(course_id, "Curso no encontrado.")
    await db.execute(
        delete(SavedCourse).where(
            SavedCourse.user_id == current_user.id, SavedCourse.course_id == cid
        )
    )
    await db.commit()


@router.get("/courses", response_model=list[CourseRead])
async def list_courses(
    q: str | None = Query(default=None, max_length=120),
    level: str | None = Query(default=None, pattern=NIVEL),
    language: str | None = Query(default=None, pattern=IDIOMA),
    page: Page = Depends(pagination_params),
    db: AsyncSession = Depends(get_db),
) -> list[CourseRead]:
    """El catalogo publico. SOLO publicados, y sigue siendo asi a proposito.

    Los borradores del autor se piden en `/catalog/courses/mine`. Meterlos aqui
    con un parametro convertiria el listado publico en un endpoint que devuelve
    cosas distintas segun quien pregunte, que es como se cuela un borrador en la
    pantalla de otra persona.

    LOS FILTROS SE APLICAN ANTES DE PAGINAR, y ese es todo el punto. Filtrando
    en el movil sobre la pagina que llega, pedir «avanzado» devuelve los cursos
    avanzados QUE HUBIERA en los veinte primeros: la pantalla ensena tres
    resultados y jura que no hay mas. Aqui la base filtra y despues corta.

    SIN NINGUN PARAMETRO, LA CONSULTA ES LA DE SIEMPRE. Ni un `where` de mas: lo
    que devuelve hoy el catalogo tiene que seguir devolviendo exactamente lo
    mismo, o el filtro habria cambiado la pantalla de inicio de todo el mundo.
    """
    consulta = select(Course).where(Course.status == "published")

    texto = (q or "").strip()
    if texto:
        patron = _patron_de_busqueda(texto)
        # Titulo Y descripcion: buscar solo en el titulo deja fuera el curso que
        # se llama «Fundamentos» y explica en la descripcion que es de cocina.
        consulta = consulta.where(
            or_(
                Course.title.ilike(patron, escape="\\"),
                Course.description.ilike(patron, escape="\\"),
            )
        )

    if level is not None or language is not None:
        # 503 Y NO UNA LISTA VACIA NI EL CATALOGO ENTERO. Sin la 0034 esas
        # columnas no existen: devolver todo seria mentir —el filtro no se
        # aplico— y devolver vacio haria pensar que no hay cursos de ese nivel.
        # La funcion existe, todavia no esta montada, y eso es un 503; es lo
        # mismo que ya responde la revision de cursos.
        if not await esquema.hay_cursos_v2(db):
            raise ServiceUnavailableError(
                "Filtrar por nivel o idioma todavía no está disponible.",
                code="course_filters_not_available",
            )
        consulta = consulta.where(
            Course.id.in_(cursos_v2.ids_de_cursos_con(level=level, language=language))
        )

    cursos = list(
        await db.scalars(
            consulta.order_by(Course.created_at.desc())
            .limit(page.limit)
            .offset(page.offset)
        )
    )
    return await _leer_cursos(db, cursos)


@router.get("/courses/mine", response_model=list[CourseRead])
async def list_my_courses(
    page: Page = Depends(pagination_params),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[CourseRead]:
    """Los cursos de quien pregunta, en cualquier estado menos borrado.

    Es la contraparte de que crear ya no publique: sin este listado, un curso
    recien creado no aparecia en ninguna pantalla y parecia que no se habia
    guardado.
    """
    cursos = list(
        await db.scalars(
            select(Course)
            .where(Course.author_id == current_user.id, Course.status != "deleted")
            .order_by(Course.created_at.desc())
            .limit(page.limit)
            .offset(page.offset)
        )
    )
    return await _leer_cursos(db, cursos, con_revision=True)


async def _requisitos_que_faltan(db: AsyncSession, course: Course) -> list[str]:
    """Lo que le falta a este curso para poder publicarse, en frases.

    Se devuelven TODAS de una vez y no la primera: corregir de una en una,
    guardando y volviendo a intentarlo, es la forma mas rapida de que alguien
    abandone a medias.

    ESTO CORRE EN EL SERVIDOR Y NO ES NEGOCIABLE. Esconder el boton de publicar
    en la aplicacion es comodidad para quien la usa; lo que impide que un curso
    a medias entre en el catalogo es esta funcion, porque la URL se puede llamar
    a mano.

    Cada requisito se pide SOLO si esta base sabe guardarlo. Exigir un nivel
    contra una base sin la 0034 seria pedir algo imposible y dejar el catalogo
    congelado hasta que alguien apruebe una migracion.
    """
    faltan: list[str] = []
    hay_v2 = await esquema.hay_cursos_v2(db)
    ficha = await cursos_v2.leer_una(db, course.id)

    if not (course.title or "").strip():
        faltan.append("Ponle un título al curso.")
    if len((course.description or "").strip()) < 30:
        faltan.append(
            "Escribe una descripción de al menos 30 caracteres: es lo que lee "
            "quien decide si empezarlo."
        )

    if hay_v2:
        # «Lo que aprenderas» vive en `highlights` desde la 0013, asi que la
        # columna existe hoy. La EXIGENCIA, en cambio, entra con la 0034: la
        # lista de requisitos de la ficha nueva se estrena entera o no se
        # estrena, para que nadie se encuentre un curso que ayer podia publicar
        # y hoy no, sin que haya cambiado nada en su curso.
        if not [h for h in (course.highlights or []) if (h or "").strip()]:
            faltan.append(
                "Escribe al menos un resultado de aprendizaje: qué sabrá hacer "
                "alguien al terminarlo."
            )
        if not ficha.primary_topic_id:
            faltan.append(
                "Elige la categoría principal: es donde se encuentra el curso."
            )
        if not ficha.level:
            faltan.append("Indica el nivel: inicial, intermedio o avanzado.")
        if not (ficha.language or "").strip():
            faltan.append("Indica el idioma en que se imparte.")
    elif await temas_de_curso.disponible(db):
        # Sin la 0034 no hay categoria principal, asi que la regla de siempre
        # sigue en pie: al menos un tema. Con la 0034 la categoria principal ya
        # es ese tema y pedir los dos seria pedir lo mismo dos veces.
        if not await temas_de_curso.tiene_alguno(db, course.id):
            faltan.append("Elige al menos un tema: es lo que permite recomendarlo.")

    modulos = list(
        await db.scalars(
            select(CourseModule.id).where(CourseModule.course_id == course.id)
        )
    )
    hay_lecciones = False
    if not modulos:
        faltan.append("Añade al menos un módulo.")
    else:
        # `in_(modulos)` con la lista NO vacia: `in_(lista or [""])` cuela en
        # SQLite y PostgreSQL rechaza la cadena vacia contra una columna uuid.
        lecciones = await db.scalar(
            select(func.count())
            .select_from(CourseLesson)
            .where(CourseLesson.module_id.in_(modulos))
        )
        hay_lecciones = bool(lecciones)
        if not hay_lecciones:
            faltan.append("Añade al menos una lección dentro de un módulo.")

    faltan.extend(await _requisitos_de_cobro(db, course, hay_lecciones=hay_lecciones))
    return faltan


async def _requisitos_de_cobro(
    db: AsyncSession, course: Course, *, hay_lecciones: bool
) -> list[str]:
    """Lo que le falta a un curso para poder COBRARSE.

    UNA COMPRA TIENE QUE DESBLOQUEAR ALGO REAL. Un curso de pago en el que todas
    las lecciones son muestra se puede ver entero sin pagar: quien compre habra
    pagado por nada, y quien no compre no notara la diferencia. Y al reves, un
    curso gratuito con lecciones marcadas como muestra tiene una configuracion
    que no significa nada, porque en un curso gratuito ya se abren todas.
    """
    faltan: list[str] = []
    de_pago = (course.price_minor or 0) > 0

    if de_pago:
        if course.price_minor <= 0:  # pragma: no cover - lo impide el esquema
            faltan.append("Ponle un precio mayor que cero.")
        if hay_lecciones and not await cursos_v2.tiene_leccion_de_pago(db, course.id):
            faltan.append(
                "Deja al menos una lección fuera de la muestra: quien compre "
                "tiene que desbloquear algo que no podía ver antes."
            )
    elif await cursos_v2.tiene_muestra(db, course.id):
        faltan.append(
            "Ponle precio al curso o quita las muestras: en un curso gratuito "
            "todas las lecciones ya se abren."
        )

    return faltan


@router.post("/courses/{course_id}/publish", response_model=CoursePublishResult)
async def publish_course(
    course_id: str,
    request: Request,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CoursePublishResult:
    """Publica un curso, si esta terminado.

    LA VALIDACION CORRE AQUI, no en la aplicacion. Un boton escondido no impide
    llamar a esta URL a mano, y lo que hay al otro lado es el catalogo que ve
    todo el mundo.

    No lanza error cuando falta algo: devuelve `published: false` y la lista de
    lo que falta. Un 4xx obligaria al movil a adivinar el motivo a partir de un
    mensaje suelto, y aqui el motivo es lo unico util.
    """
    course = await _curso_gestionable(db, course_id, current_user, "publicar")
    ficha = await cursos_v2.leer_una(db, course.id)

    faltan = await _requisitos_que_faltan(db, course)
    # Con la 0034 puesta, publicar exige que alguien de la casa lo haya mirado.
    # No es mezclar los dos ejes: `status` sigue significando visibilidad y
    # `review_status` sigue significando revision. Lo que se dice aqui es que
    # uno es condicion del otro, que es la regla del producto.
    if await esquema.hay_cursos_v2(db) and ficha.review_status != cursos_v2.APROBADO:
        # `.get` con respaldo: un valor raro en la columna —escrito a mano, o de
        # una version futura— no puede tumbar la peticion con un KeyError. Se
        # dice que falta la revision, que es cierto en cualquier caso.
        faltan.append(
            _QUE_FALTA_DE_REVISION.get(
                ficha.review_status,
                "Envía el curso a revisión: aún no está aprobado.",
            )
        )

    if faltan:
        return CoursePublishResult(
            id=course.id, status=course.status, published=False, missing=faltan
        )

    anterior = course.status
    course.status = "published"

    # LA VERSIÓN Y EL CAMBIO DE ESTADO, EN LA MISMA TRANSACCIÓN. Publicar deja
    # de ser solo mover una columna: congela lo que el curso ofrece en ese
    # momento, y esa fotografía es lo que la orden de mañana va a señalar. Si se
    # confirmara el estado sin la versión, habría un curso publicado del que no
    # se puede decir qué ofrecía. Con la 0050 sin aplicar devuelve `None` y todo
    # sigue exactamente como antes.
    version = await versiones.asegurar_version(db, course, publicada_por=current_user.id)
    await auditoria.anotar(
        db,
        action="course.published",
        entity_type="course",
        entity_id=course.id,
        actor_id=current_user.id,
        actor_role="user",
        previous_state=anterior,
        new_state="published",
        payload={"version": version.version if version else None},
        origen=leer_origen(request),
    )
    await db.commit()
    # El curso acaba de ENTRAR en el universo de candidatos del recomendador, y
    # eso no es un cambio de esta persona: es un cambio del catalogo. La memoria
    # corta de los rankings de cursos es POR QUIEN MIRA, asi que invalidar solo
    # al autor —lo unico que se hacia, desde `temas_de_curso.fijar`— dejaba el
    # curso sin poder recomendarse a NADIE MAS hasta que la entrada de cada cual
    # caducara sola: hasta un minuto de «lo he publicado y no aparece», justo en
    # el minuto en que el autor va a mirar si funciono.
    #
    # Se borra lo que ha dejado de ser cierto en el momento en que deja de
    # serlo. No se acorta la vigencia ni se anade un refresco en el movil: eso
    # taparia el sintoma y ademas costaria en todas las demas peticiones.
    memoria_del_recomendador.invalidar_tipo("cursos")
    return CoursePublishResult(id=course.id, status="published", published=True)


#: Que decirle a quien intenta publicar segun donde este su revision. Se
#: escribe una vez y en un sitio: repartir estas frases por la aplicacion es
#: como acaban diciendo cosas distintas.
_QUE_FALTA_DE_REVISION = {
    cursos_v2.BORRADOR: "Envía el curso a revisión: aún no lo ha visto nadie.",
    cursos_v2.EN_REVISION: "Tu curso está en revisión. Te avisaremos al resolverla.",
    cursos_v2.RECHAZADO: (
        "La revisión anterior se rechazó. Corrige lo indicado y vuelve a enviarlo."
    ),
}


async def _curso_gestionable(
    db: AsyncSession, course_id: str, current_user: AuthUser, accion: str
) -> Course:
    """El curso, si quien pregunta puede gestionarlo. Su autor o administracion."""
    ensure_uuid(course_id, "Curso no encontrado.")
    course = await db.get(Course, course_id)
    if course is None or course.status == "deleted":
        raise NotFoundError("Curso no encontrado.")
    await require_owner_or_admin(
        db, course.author_id, current_user, f"No puedes {accion} este curso."
    )
    return course


async def _exigir_revision_disponible(db: AsyncSession) -> None:
    """503 —no 404 ni 500— mientras la 0034 no este aplicada.

    404 haria pensar que la ruta esta mal escrita y 500 que algo se ha roto. La
    funcion existe; lo que falta es la migracion, y eso es un 503.
    """
    if not await esquema.hay_cursos_v2(db):
        raise ServiceUnavailableError(
            "La revisión de cursos todavía no está disponible.",
            code="course_review_not_available",
        )


@router.get("/courses/{course_id}/requirements", response_model=CourseRequirements)
async def course_requirements(
    course_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CourseRequirements:
    """Que le falta al curso, SIN cambiar nada.

    Lo pide el paso «revisar y enviar» del asistente para pintar la lista antes
    de que alguien pulse. Las reglas salen de `_requisitos_que_faltan`, la misma
    funcion que decide de verdad: si un dia se anade un requisito, la pantalla
    lo ensena sola.
    """
    course = await _curso_gestionable(db, course_id, current_user, "revisar")
    ficha = await cursos_v2.leer_una(db, course.id)
    faltan = await _requisitos_que_faltan(db, course)
    return CourseRequirements(
        id=course.id,
        status=course.status,
        review_status=ficha.review_status,
        ready=not faltan,
        missing=faltan,
        review_available=await esquema.hay_cursos_v2(db),
    )


@router.post("/courses/{course_id}/submit", response_model=CourseSubmitResult)
async def submit_course_for_review(
    course_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CourseSubmitResult:
    """Pide que administracion mire el curso.

    Se valida lo MISMO que al publicar. Mandar a revision un curso sin lecciones
    solo sirve para que alguien pierda el tiempo mirandolo y lo devuelva.

    Como en `/publish`, cuando falta algo NO se lanza un error: se responde
    `submitted: false` y la lista entera de lo que falta, que es lo unico util.
    """
    # Primero QUIEN, despues QUE hay disponible: quien no puede tocar este curso
    # recibe un 403 y no un informe sobre el estado del despliegue.
    course = await _curso_gestionable(db, course_id, current_user, "enviar a revisión")
    await _exigir_revision_disponible(db)
    ficha = await cursos_v2.leer_una(db, course.id)

    if ficha.review_status == cursos_v2.EN_REVISION:
        # Insistir no adelanta la cola, y reescribir `submitted_at` mandaria al
        # final a quien ya llevaba esperando. Se responde que ya esta enviado.
        return CourseSubmitResult(
            id=course.id, review_status=ficha.review_status, submitted=True
        )

    faltan = await _requisitos_que_faltan(db, course)
    if faltan:
        return CourseSubmitResult(
            id=course.id,
            review_status=ficha.review_status,
            submitted=False,
            missing=faltan,
        )

    await cursos_v2.enviar_a_revision(db, course.id)
    await db.commit()
    return CourseSubmitResult(
        id=course.id, review_status=cursos_v2.EN_REVISION, submitted=True
    )


@router.get("/courses/review-queue", response_model=list[CourseRead])
async def review_queue(
    page: Page = Depends(pagination_params),
    _: AuthUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[CourseRead]:
    """La bandeja de administracion: los cursos esperando revision.

    Solo administracion, y lo impone el servidor (`require_admin` contra
    `profiles.role`, NUNCA contra el token: en el JWT de Supabase `role` vale
    siempre «authenticated»).
    """
    await _exigir_revision_disponible(db)
    ids = await cursos_v2.en_revision(db, page.limit, page.offset)
    if not ids:
        return []
    cursos = list(await db.scalars(select(Course).where(Course.id.in_(ids))))
    # El orden lo decide la cola (quien lleva mas esperando), no la base.
    por_id = {c.id: c for c in cursos}
    return await _leer_cursos(
        db, [por_id[i] for i in ids if i in por_id], con_revision=True
    )


@router.post("/courses/{course_id}/review", response_model=CourseRead)
async def review_course(
    course_id: str,
    payload: CourseReviewDecision,
    current_user: AuthUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> CourseRead:
    """Aprueba o rechaza un curso. Solo administracion.

    APROBAR NO PUBLICA. Son dos ejes distintos y los dos tienen dueno: la
    revision es de administracion, la decision de estar en el catalogo sigue
    siendo de quien lo creo. Aprobar y publicar de golpe le quitaria a su autor
    la ultima palabra sobre cuando se estrena su curso.

    RECHAZAR SIN MOTIVO NO SE PUEDE. Un «no» sin explicacion no se puede
    corregir: quien lo recibe vuelve a enviar lo mismo y la cola no avanza.
    """
    await _exigir_revision_disponible(db)
    ensure_uuid(course_id, "Curso no encontrado.")
    course = await db.get(Course, course_id)
    if course is None or course.status == "deleted":
        raise NotFoundError("Curso no encontrado.")

    aprobado = payload.decision == "approve"
    motivo = (payload.reason or "").strip()
    if not aprobado and len(motivo) < 10:
        raise ValidationAppError(
            "Explica por qué se rechaza: quien lo recibe necesita saber qué corregir."
        )

    await cursos_v2.resolver_revision(
        db,
        course.id,
        aprobado=aprobado,
        revisor_id=current_user.id,
        motivo=motivo or None,
    )
    await db.commit()
    await db.refresh(course)
    return await _leer_curso(db, course)


@router.post("/courses/{course_id}/unpublish", response_model=CourseRead)
async def unpublish_course(
    course_id: str,
    request: Request,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CourseRead:
    """Retira un curso del catalogo SIN borrar nada.

    Pasa a `hidden` y no a `draft` a proposito: `draft` significa «todavia no ha
    estado publicado nunca», y perder esa diferencia borraria la unica pista de
    que este curso ya estuvo a la vista de alguien. Sus modulos, lecciones,
    videos y el progreso de quien lo empezo siguen intactos, y volver a
    publicarlo es otra llamada.
    """
    ensure_uuid(course_id, "Curso no encontrado.")
    course = await db.get(Course, course_id)
    if course is None or course.status == "deleted":
        raise NotFoundError("Curso no encontrado.")
    await require_owner_or_admin(
        db, course.author_id, current_user, "No puedes retirar este curso."
    )
    anterior = course.status
    course.status = "hidden"
    # La versión deja de ser la vigente. NO SE BORRA: es lo que alguien compró,
    # y borrarla dejaría órdenes apuntando a nada. Pasa a historial.
    await versiones.retirar_vigente(db, course.id)
    await auditoria.anotar(
        db,
        action="course.unpublished",
        entity_type="course",
        entity_id=course.id,
        actor_id=current_user.id,
        actor_role="user",
        previous_state=anterior,
        new_state="hidden",
        origen=leer_origen(request),
    )
    await db.commit()
    await db.refresh(course)
    # La otra mitad de lo mismo: retirarlo lo saca del universo de candidatos.
    # Seguir recomendando durante un minuto algo que su autor acaba de esconder
    # manda a la gente a una puerta cerrada.
    memoria_del_recomendador.invalidar_tipo("cursos")
    return await _leer_curso(db, course)


@router.delete("/courses/{course_id}", status_code=status.HTTP_204_NO_CONTENT)
async def borrar_curso(
    course_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Borra un curso, y solo si nadie lo compró.

    El móvil lo borraba directamente contra PostgREST: sin comprobar
    compradores, sin auditoría y sin transacción. La RLS se lo permitía al
    autor, así que un curso vendido podía desaparecer con su contenido.
    """
    course = await _curso_gestionable(db, course_id, current_user, "borrar")

    if await _tiene_compradores(db, course.id):
        raise ConflictError(
            "Este curso ya tiene alumnos: no se puede borrar. Retíralo del "
            "catálogo si no quieres que se siga vendiendo.",
            code="course_has_buyers",
        )

    await auditoria.anotar(
        db,
        actor_id=current_user.id,
        action="course.deleted",
        entity_type="course",
        entity_id=course.id,
        reason="borrado por su autor, sin compradores",
        payload={"course_status": course.status},
    )
    await db.delete(course)
    await db.commit()


async def _tiene_compradores(db: AsyncSession, course_id: str) -> bool:
    """Si alguien pagó o tiene acceso concedido a este curso.

    Mira las tres vías que conceden acceso —la tabla heredada, el comercio y las
    matrículas— porque conviven mientras dura el trasvase de la 0036.
    """
    from app.modules.learning.models import Purchase

    if await db.scalar(
        select(Purchase.id).where(Purchase.course_id == course_id).limit(1)
    ):
        return True

    if not await esquema_comercio.hay_comercio(db):
        return False

    from app.modules.commerce.models import CommerceProduct, Entitlement, Order

    producto = await db.scalar(
        select(CommerceProduct.id).where(CommerceProduct.course_id == course_id)
    )
    if producto is None:
        return False
    if await db.scalar(
        select(Order.id)
        .where(Order.commerce_product_id == producto, Order.status == "paid")
        .limit(1)
    ):
        return True
    return bool(
        await db.scalar(
            select(Entitlement.id)
            .where(
                Entitlement.commerce_product_id == producto,
                Entitlement.status == "active",
            )
            .limit(1)
        )
    )


@router.get("/courses/{course_id}/version", response_model=VersionDeCurso)
async def version_publicada(
    course_id: str,
    db: AsyncSession = Depends(get_db),
) -> VersionDeCurso:
    """Qué ofrece hoy este curso, congelado.

    NO PIDE SESIÓN: es la ficha de un curso publicado, lo mismo que ya devuelve
    el catálogo. Lo que aporta es que esto NO CAMBIA cuando el autor edita: es
    la fotografía que la orden de mañana va a señalar.

    404 cuando el curso no tiene versión todavía, que es el caso de todos los
    que no se han republicado desde la 0050. No se inventa una al vuelo: sería
    afirmar que eso es lo que se publicó.
    """
    ensure_uuid(course_id, "Curso no encontrado.")
    version = await versiones.vigente(db, course_id)
    if version is None:
        raise NotFoundError(
            "Este curso todavía no tiene una versión publicada.",
            code="course_version_not_available",
        )
    return VersionDeCurso(
        id=version.id,
        course_id=version.course_id,
        version=version.version,
        status=version.status,
        published_at=version.published_at,
        content_hash=version.content_hash,
        # LA DISTINCIÓN QUE NO SE PUEDE PERDER: una versión reconstruida por el
        # backfill dice lo que el curso ES hoy, no lo que se vendió.
        reconstruida=version.origin == "backfill",
        snapshot=dict(version.snapshot or {}),
    )


# --------------------------------------------------------------------------- #
# EL TEMARIO: modulos y lecciones.
#
# POR QUE EXISTE ESTE BLOQUE. El editor del movil escribia `course_modules` y
# `course_lessons` directamente contra PostgREST porque la API no ofrecia otro
# camino. La RLS decidia quien podia escribir, asi que no era un agujero de
# permisos; era un agujero de RASTRO: un autor reescribia el temario de un curso
# ya vendido y no quedaba ni una linea diciendo que habia pasado.
#
# QUE NO HACE ESTE BLOQUE, y es igual de importante: NO crea versiones. Una
# version nace al PUBLICAR (`versiones.asegurar_version`) y la vigente es
# INMUTABLE —la 0050 lo impone con un disparador, no con un comentario—. Editar
# el temario de un curso publicado deja el rastro y no toca la fotografia; lo
# que el alumno compro sigue diciendo lo que decia.
# --------------------------------------------------------------------------- #


def _titulo(valor: str) -> str:
    """El titulo sin espacios sueltos, y nunca vacio.

    `min_length=1` deja pasar «   », y un modulo titulado con espacios se pinta
    como una fila en blanco que parece un fallo de la aplicacion. Se limpia al
    escribir y no al leer, porque lo que se guarda es lo que despues se ensena.
    """
    limpio = valor.strip()
    if not limpio:
        raise ValidationAppError("El título no puede estar vacío.")
    return limpio


async def _modulo_del_curso(
    db: AsyncSession, course: Course, module_id: str
) -> CourseModule:
    """El modulo, si de verdad es de ESTE curso.

    Comprobar solo que el modulo existe dejaria editar el de otro curso pasando
    su id por la URL: el permiso se valido sobre el curso de la ruta, no sobre
    el dueno del modulo. Es la misma clase de fallo que arreglar un `where` de
    menos en una consulta.
    """
    ensure_uuid(module_id, "Módulo no encontrado.")
    modulo = await db.get(CourseModule, module_id)
    if modulo is None or modulo.course_id != course.id:
        raise NotFoundError("Módulo no encontrado.")
    return modulo


async def _leccion_del_modulo(
    db: AsyncSession, modulo: CourseModule, lesson_id: str
) -> CourseLesson:
    """La leccion, si de verdad es de ESE modulo. Mismo motivo que arriba."""
    ensure_uuid(lesson_id, "Lección no encontrada.")
    leccion = await db.get(CourseLesson, lesson_id)
    if leccion is None or leccion.module_id != modulo.id:
        raise NotFoundError("Lección no encontrada.")
    return leccion


async def _leer_modulo(db: AsyncSession, modulo: CourseModule) -> CourseModuleRead:
    descripciones = await cursos_v2.descripciones_de_modulos(db, [modulo.id])
    return CourseModuleRead(
        id=modulo.id,
        course_id=modulo.course_id,
        title=modulo.title,
        description=descripciones.get(modulo.id, ""),
        sort_order=modulo.sort_order,
    )


async def _leer_leccion(db: AsyncSession, leccion: CourseLesson) -> CourseLessonRead:
    tipo, muestra = (await cursos_v2.tipos_de_lecciones(db, [leccion.id])).get(
        leccion.id, ("video", False)
    )
    return CourseLessonRead(
        id=leccion.id,
        module_id=leccion.module_id,
        title=leccion.title,
        body=leccion.body or "",
        media_path=leccion.media_path,
        duration_seconds=leccion.duration_seconds,
        sort_order=leccion.sort_order,
        kind=tipo,
        is_preview=muestra,
    )


@router.post(
    "/courses/{course_id}/modules",
    response_model=CourseModuleRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_course_module(
    course_id: str,
    payload: CourseModuleCreate,
    request: Request,
    idempotency_key: str | None = Header(
        default=None, alias="Idempotency-Key", max_length=200
    ),
    if_match: str | None = Header(default=None, alias="If-Match", max_length=200),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CourseModuleRead:
    """Anade un modulo AL FINAL del temario.

    UN DOBLE TOQUE NO CREA DOS MODULOS si el cliente manda `Idempotency-Key`. Y
    no porque se mire antes si existe —eso lo pasan dos peticiones a la vez—
    sino porque el id de la fila se deriva de la clave: la segunda insercion
    choca contra la clave primaria y se devuelve el modulo que ya estaba, con el
    mismo 201 que la primera vez.

    LA POSICION NO LA ELIGE EL CLIENTE. Ver `contenido.siguiente_posicion`.
    """
    course = await _curso_gestionable(db, course_id, current_user, "editar")
    version = await contenido.exigir_version_esperada(db, course.id, if_match)
    propuesto = contenido.id_idempotente(course.id, current_user.id, idempotency_key)

    if propuesto is not None:
        repetido = await db.scalar(
            select(CourseModule).where(
                CourseModule.id == propuesto, CourseModule.course_id == course.id
            )
        )
        if repetido is not None:
            return await _leer_modulo(db, repetido)

    modulo = CourseModule(
        course_id=course.id,
        title=_titulo(payload.title),
        sort_order=await contenido.siguiente_posicion(
            db, CourseModule.sort_order, CourseModule.course_id == course.id
        ),
    )
    if propuesto is not None:
        modulo.id = propuesto
    try:
        # DENTRO DEL SAVEPOINT, igual que en `versiones.asegurar_version`: con el
        # `add` fuera, el objeto pertenece a la transaccion exterior y deshacer
        # el savepoint no lo saca, asi que el commit de despues lo escribiria
        # igualmente.
        async with db.begin_nested():
            db.add(modulo)
            await db.flush()
    except IntegrityError:
        # Otra peticion con la misma clave llego antes. La suya es la buena.
        repetido = await db.scalar(
            select(CourseModule).where(
                CourseModule.id == propuesto, CourseModule.course_id == course.id
            )
        )
        if repetido is None:
            # No fue la idempotencia: es un fallo de verdad y quien llama tiene
            # que enterarse en vez de recibir un 201 sin modulo detras.
            raise
        return await _leer_modulo(db, repetido)

    await cursos_v2.guardar_modulo(db, modulo.id, {"description": payload.description})
    await auditoria.anotar(
        db,
        action="course.module_created",
        entity_type="course",
        entity_id=course.id,
        actor_id=current_user.id,
        actor_role="user",
        payload={"module_id": modulo.id, **contenido.nota_de_contexto(course, version)},
        origen=leer_origen(request),
    )
    await db.commit()
    return await _leer_modulo(db, modulo)


@router.patch(
    "/courses/{course_id}/modules/{module_id}", response_model=CourseModuleRead
)
async def update_course_module(
    course_id: str,
    module_id: str,
    payload: CourseModuleUpdate,
    request: Request,
    if_match: str | None = Header(default=None, alias="If-Match", max_length=200),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CourseModuleRead:
    """Edita un modulo. RENOMBRAR ES ESTO con `title` y nada mas.

    No hay un endpoint aparte para renombrar: seria la misma escritura, el mismo
    permiso y el mismo rastro con otro nombre, y el dia que uno cambie el otro
    se queda atras.
    """
    course = await _curso_gestionable(db, course_id, current_user, "editar")
    version = await contenido.exigir_version_esperada(db, course.id, if_match)
    modulo = await _modulo_del_curso(db, course, module_id)

    # `exclude_unset` distingue «no enviado» de «enviado vacio»: sin ello,
    # cambiar el titulo borraria la descripcion.
    cambios = payload.model_dump(exclude_unset=True)
    if not cambios:
        # Un PATCH vacio no es una edicion. Anotarlo llenaria el rastro de ruido
        # justo donde hace falta poder leerlo.
        return await _leer_modulo(db, modulo)

    if "title" in cambios:
        modulo.title = _titulo(cambios["title"])
    if "description" in cambios:
        await cursos_v2.guardar_modulo(
            db, modulo.id, {"description": cambios["description"]}
        )

    await auditoria.anotar(
        db,
        action="course.module_updated",
        entity_type="course",
        entity_id=course.id,
        actor_id=current_user.id,
        actor_role="user",
        # LOS NOMBRES DE LOS CAMPOS, NO SU CONTENIDO. El rastro sirve para saber
        # que se toco; archivar el texto convertiria `audit_events` en una copia
        # del curso, y ese payload se sirve por `GET /admin/audit-events`.
        payload={
            "module_id": modulo.id,
            "fields": sorted(cambios),
            **contenido.nota_de_contexto(course, version),
        },
        origen=leer_origen(request),
    )
    await db.commit()
    return await _leer_modulo(db, modulo)


@router.post(
    "/courses/{course_id}/modules/reorder", response_model=list[CourseModuleRead]
)
async def reorder_course_modules(
    course_id: str,
    payload: CourseOrder,
    request: Request,
    if_match: str | None = Header(default=None, alias="If-Match", max_length=200),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[CourseModuleRead]:
    """Deja los modulos EN ESTE orden. `ids` es la lista completa y definitiva.

    Se reescribe la posicion de TODOS y no solo la del que se movio: dos
    `sort_order` empatados dejan el temario a merced de como devuelva las filas
    la base, que es lo mismo que no tener orden.
    """
    course = await _curso_gestionable(db, course_id, current_user, "editar")
    version = await contenido.exigir_version_esperada(db, course.id, if_match)

    modulos = {
        m.id: m
        for m in await db.scalars(
            select(CourseModule).where(CourseModule.course_id == course.id)
        )
    }
    contenido.exigir_orden_completo(list(modulos), payload.ids)

    for posicion, ident in enumerate(payload.ids):
        modulos[ident].sort_order = posicion

    await auditoria.anotar(
        db,
        action="course.modules_reordered",
        entity_type="course",
        entity_id=course.id,
        actor_id=current_user.id,
        actor_role="user",
        payload={
            "total": len(payload.ids),
            **contenido.nota_de_contexto(course, version),
        },
        origen=leer_origen(request),
    )
    await db.commit()
    return [await _leer_modulo(db, modulos[ident]) for ident in payload.ids]


@router.delete(
    "/courses/{course_id}/modules/{module_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_course_module(
    course_id: str,
    module_id: str,
    request: Request,
    if_match: str | None = Header(default=None, alias="If-Match", max_length=200),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Borra un modulo y las lecciones que colgaban de el.

    LAS LECCIONES SE BORRAN A MANO Y NO SE DEJA SOLO EN LA CASCADA. No es
    desconfianza de la clave foranea: es que hay que CONTARLAS para poder
    anotarlas. «Se borro un modulo» y «se borraron un modulo y siete lecciones
    de un curso publicado» no son el mismo hecho, y el segundo es el que alguien
    va a querer reconstruir dentro de seis meses.
    """
    course = await _curso_gestionable(db, course_id, current_user, "editar")
    version = await contenido.exigir_version_esperada(db, course.id, if_match)
    modulo = await _modulo_del_curso(db, course, module_id)

    cuantas = (
        await db.scalar(
            select(func.count())
            .select_from(CourseLesson)
            .where(CourseLesson.module_id == modulo.id)
        )
    ) or 0
    await db.execute(delete(CourseLesson).where(CourseLesson.module_id == modulo.id))
    await db.delete(modulo)

    await auditoria.anotar(
        db,
        action="course.module_deleted",
        entity_type="course",
        entity_id=course.id,
        actor_id=current_user.id,
        actor_role="user",
        payload={
            "module_id": modulo.id,
            "lessons": cuantas,
            **contenido.nota_de_contexto(course, version),
        },
        origen=leer_origen(request),
    )
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/courses/{course_id}/modules/{module_id}/lessons",
    response_model=CourseLessonRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_course_lesson(
    course_id: str,
    module_id: str,
    payload: CourseLessonCreate,
    request: Request,
    idempotency_key: str | None = Header(
        default=None, alias="Idempotency-Key", max_length=200
    ),
    if_match: str | None = Header(default=None, alias="If-Match", max_length=200),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CourseLessonRead:
    """Anade una leccion AL FINAL del modulo. Misma idempotencia que el modulo.

    `kind` e `is_preview` se guardan en una sentencia aparte porque no estan en
    el ORM (ver `cursos_v2`); van en la MISMA transaccion, asi que o entra la
    leccion con su tipo o no entra nada.
    """
    course = await _curso_gestionable(db, course_id, current_user, "editar")
    version = await contenido.exigir_version_esperada(db, course.id, if_match)
    modulo = await _modulo_del_curso(db, course, module_id)
    propuesto = contenido.id_idempotente(modulo.id, current_user.id, idempotency_key)

    if propuesto is not None:
        repetida = await db.scalar(
            select(CourseLesson).where(
                CourseLesson.id == propuesto, CourseLesson.module_id == modulo.id
            )
        )
        if repetida is not None:
            return await _leer_leccion(db, repetida)

    leccion = CourseLesson(
        module_id=modulo.id,
        title=_titulo(payload.title),
        body=payload.body,
        media_path=payload.media_path,
        duration_seconds=payload.duration_seconds,
        sort_order=await contenido.siguiente_posicion(
            db, CourseLesson.sort_order, CourseLesson.module_id == modulo.id
        ),
    )
    if propuesto is not None:
        leccion.id = propuesto
    try:
        async with db.begin_nested():
            db.add(leccion)
            await db.flush()
    except IntegrityError:
        repetida = await db.scalar(
            select(CourseLesson).where(
                CourseLesson.id == propuesto, CourseLesson.module_id == modulo.id
            )
        )
        if repetida is None:
            raise
        return await _leer_leccion(db, repetida)

    await cursos_v2.guardar_leccion(
        db, leccion.id, {"kind": payload.kind, "is_preview": payload.is_preview}
    )
    await auditoria.anotar(
        db,
        action="course.lesson_created",
        entity_type="course",
        entity_id=course.id,
        actor_id=current_user.id,
        actor_role="user",
        payload={
            "module_id": modulo.id,
            "lesson_id": leccion.id,
            **contenido.nota_de_contexto(course, version),
        },
        origen=leer_origen(request),
    )
    await db.commit()
    return await _leer_leccion(db, leccion)


@router.patch(
    "/courses/{course_id}/modules/{module_id}/lessons/{lesson_id}",
    response_model=CourseLessonRead,
)
async def update_course_lesson(
    course_id: str,
    module_id: str,
    lesson_id: str,
    payload: CourseLessonUpdate,
    request: Request,
    if_match: str | None = Header(default=None, alias="If-Match", max_length=200),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CourseLessonRead:
    """Edita una leccion.

    `media_path` en `null` SI borra la ruta: es la unica forma de quitar un
    video. Por eso se mira lo ENVIADO y no lo que vale distinto de `None`.
    """
    course = await _curso_gestionable(db, course_id, current_user, "editar")
    version = await contenido.exigir_version_esperada(db, course.id, if_match)
    modulo = await _modulo_del_curso(db, course, module_id)
    leccion = await _leccion_del_modulo(db, modulo, lesson_id)

    cambios = payload.model_dump(exclude_unset=True)
    if not cambios:
        return await _leer_leccion(db, leccion)

    if "title" in cambios:
        leccion.title = _titulo(cambios["title"])
    for campo in ("body", "media_path", "duration_seconds"):
        if campo in cambios:
            setattr(leccion, campo, cambios[campo])
    ficha = {
        k: v
        for k, v in cambios.items()
        if k in cursos_v2.CAMPOS_EDITABLES_DE_LECCION
    }
    if ficha:
        await cursos_v2.guardar_leccion(db, leccion.id, ficha)

    await auditoria.anotar(
        db,
        action="course.lesson_updated",
        entity_type="course",
        entity_id=course.id,
        actor_id=current_user.id,
        actor_role="user",
        payload={
            "module_id": modulo.id,
            "lesson_id": leccion.id,
            "fields": sorted(cambios),
            **contenido.nota_de_contexto(course, version),
        },
        origen=leer_origen(request),
    )
    await db.commit()
    return await _leer_leccion(db, leccion)


@router.post(
    "/courses/{course_id}/modules/{module_id}/lessons/reorder",
    response_model=list[CourseLessonRead],
)
async def reorder_course_lessons(
    course_id: str,
    module_id: str,
    payload: CourseOrder,
    request: Request,
    if_match: str | None = Header(default=None, alias="If-Match", max_length=200),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[CourseLessonRead]:
    """Deja las lecciones DE ESE MODULO en este orden. Lista completa, como arriba.

    El orden se reescribe dentro de un modulo y no en todo el curso: mover una
    leccion de modulo es otra operacion, y mezclarlas dejaria que una
    reordenacion cambiara a que bloque pertenece cada cosa sin decirlo.
    """
    course = await _curso_gestionable(db, course_id, current_user, "editar")
    version = await contenido.exigir_version_esperada(db, course.id, if_match)
    modulo = await _modulo_del_curso(db, course, module_id)

    lecciones = {
        x.id: x
        for x in await db.scalars(
            select(CourseLesson).where(CourseLesson.module_id == modulo.id)
        )
    }
    contenido.exigir_orden_completo(list(lecciones), payload.ids)

    for posicion, ident in enumerate(payload.ids):
        lecciones[ident].sort_order = posicion

    await auditoria.anotar(
        db,
        action="course.lessons_reordered",
        entity_type="course",
        entity_id=course.id,
        actor_id=current_user.id,
        actor_role="user",
        payload={
            "module_id": modulo.id,
            "total": len(payload.ids),
            **contenido.nota_de_contexto(course, version),
        },
        origen=leer_origen(request),
    )
    await db.commit()
    return [await _leer_leccion(db, lecciones[ident]) for ident in payload.ids]


@router.delete(
    "/courses/{course_id}/modules/{module_id}/lessons/{lesson_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_course_lesson(
    course_id: str,
    module_id: str,
    lesson_id: str,
    request: Request,
    if_match: str | None = Header(default=None, alias="If-Match", max_length=200),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Borra una leccion. El progreso de quien la estaba viendo cae con ella.

    Lo hace la cascada de `lesson_progress` en la base, no este codigo: es un
    dato de OTRO modulo y borrarlo desde aqui seria el catalogo escribiendo en
    las tablas de aprendizaje.
    """
    course = await _curso_gestionable(db, course_id, current_user, "editar")
    version = await contenido.exigir_version_esperada(db, course.id, if_match)
    modulo = await _modulo_del_curso(db, course, module_id)
    leccion = await _leccion_del_modulo(db, modulo, lesson_id)

    await db.delete(leccion)
    await auditoria.anotar(
        db,
        action="course.lesson_deleted",
        entity_type="course",
        entity_id=course.id,
        actor_id=current_user.id,
        actor_role="user",
        payload={
            "module_id": modulo.id,
            "lesson_id": lesson_id,
            **contenido.nota_de_contexto(course, version),
        },
        origen=leer_origen(request),
    )
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


async def _leer_curso(db: AsyncSession, course: Course) -> CourseRead:
    # Todos los que llegan aqui son del autor o de administracion: crear,
    # editar, revisar y retirar. Por eso si va el expediente.
    return (await _leer_cursos(db, [course], con_revision=True))[0]


async def _leer_cursos(
    db: AsyncSession, cursos: list[Course], *, con_revision: bool = False
) -> list[CourseRead]:
    """Los cursos con sus temas y su ficha, en UNA consulta de cada cosa.

    Una por curso convertiria el catalogo en veinte viajes para pintar unas
    etiquetas. Con la ficha de la 0034 el riesgo es el mismo, asi que se lee en
    lote igual que los temas.

    `con_revision` DECIDE SI SE MANDA EL EXPEDIENTE DE REVISION, y viene apagado
    a proposito. `rejection_reason` lo escribe administracion en texto libre
    —«contenido copiado de X, el autor no acredita...»— y estaba saliendo en
    `GET /catalog/courses`, que no pide sesion: bastaba con que un curso
    publicado se reenviara a revision y se rechazara para que cualquiera leyera
    el motivo. Las fechas de envio y revision van con el porque describen la
    misma gestion interna.

    El detalle de `learning` ya lo trataba asi; esto solo pone de acuerdo al
    listado con el. Apagado por defecto para que anadir un endpoint nuevo no
    vuelva a abrirlo por descuido: quien lo necesite lo pide.
    """
    ids = [c.id for c in cursos]
    temas = await temas_de_curso.leer(db, ids)
    fichas = await cursos_v2.leer(db, ids)
    salida: list[CourseRead] = []
    for curso in cursos:
        leido = CourseRead.model_validate(curso)
        leido.topic_ids = temas.get(curso.id, [])
        # Sin la 0034 la ficha sale vacia: subtitulo nulo, nivel nulo, idioma
        # `es` y revision en borrador. Es la verdad, no un error.
        ficha = fichas.get(curso.id, cursos_v2.FICHA_VACIA)
        leido.subtitle = ficha.subtitle
        leido.promo_video_path = ficha.promo_video_path
        leido.primary_topic_id = ficha.primary_topic_id
        leido.language = ficha.language
        leido.level = ficha.level
        leido.target_audience = ficha.target_audience
        leido.prerequisites = ficha.prerequisites
        leido.review_status = ficha.review_status
        if con_revision:
            leido.submitted_at = ficha.submitted_at
            leido.reviewed_at = ficha.reviewed_at
            leido.rejection_reason = ficha.rejection_reason
        salida.append(leido)
    return salida
