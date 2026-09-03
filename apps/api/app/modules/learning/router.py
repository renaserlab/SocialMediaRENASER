"""Endpoints de aprendizaje: detalle del curso, acceso, progreso y biblioteca.

QUIEN DECIDE EL ACCESO. La verdad vive en la base de datos, en
`public.has_course_access()` (migracion 0016): es la que protege los ARCHIVOS,
y funciona aunque alguien llame al almacenamiento saltandose esta aplicacion.
Lo que hay aqui es la misma regla escrita para que la interfaz sepa que ensenar,
mas las comprobaciones de escritura, que si tienen que estar en el servidor.

Las dos tienen que decir lo mismo. `tests/test_muro_de_pago.py` las compara.
"""

import logging

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.exceptions import ForbiddenError, NotFoundError, ValidationAppError
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.catalog import cursos_v2
from app.modules.catalog.models import Course
from app.modules.commerce import esquema as esquema_comercio
from app.modules.commerce import service as comercio_service
from app.modules.learning import progreso
from app.modules.learning.models import (
    CourseLesson,
    CourseModule,
    LessonProgress,
    Purchase,
)
from app.modules.learning.schemas import (
    CourseDetailRead,
    CourseStudentRead,
    LessonDetailRead,
    LessonProgressInput,
    LessonProgressRead,
    LessonRead,
    ModuleRead,
    MyCourseRead,
)
from app.modules.profiles.models import Profile
from app.modules.recommendations import temas_de_curso
from app.modules.recommendations.signals import registrar_senal
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.pagination import Page, pagination_params
from app.shared.permissions import is_admin

router = APIRouter(prefix="/learning", tags=["learning"])

logger = logging.getLogger("renaser.learning")


async def _is_enrolled(db: AsyncSession, uid: str, course_id: str) -> bool:
    value = await db.scalar(
        select(func.count())
        .select_from(Purchase)
        .where(
            Purchase.user_id == uid,
            Purchase.course_id == course_id,
            Purchase.status == "paid",
        )
    )
    return (value or 0) > 0


async def _tiene_acceso(db: AsyncSession, uid: str | None, course: Course) -> bool:
    """Las mismas cinco vias que `has_course_access()` en la base de datos.

    Gratuito, autor, administracion, DERECHO ACTIVO o compra PAGADA. `pending`
    no cuenta: un cobro iniciado y no completado no es un cobro.

    LA CUARTA VIA SE DELEGA, y no es un detalle de estilo. Desde la 0035/0036 el
    acceso lo concede `entitlements`, y una compra por Stripe o por las tiendas
    NO escribe en `purchases`. Mirar solo la tabla vieja aqui significaba que
    quien pagaba veia `has_access: false` y se quedaba sin la ruta de su video,
    mientras `/payments/courses/{id}/access` y la RLS del almacenamiento le
    decian que si. Dos respuestas a la misma pregunta, que es justo el fallo que
    corrigio la 0016; se pregunta al comercio para que solo haya una.

    Sin la 0035 aplicada, `hay_comercio` es False y esto se comporta
    EXACTAMENTE como antes: desplegar no puede exigir la migracion.
    """
    if course.price_minor <= 0:
        return True
    if uid is None:
        return False
    if course.author_id == uid:
        return True
    if await is_admin(db, uid):
        return True
    if await esquema_comercio.hay_comercio(db):
        # `es_admin=False` porque ya se ha comprobado arriba: pasarlo evita
        # repetir la consulta a `profiles`.
        acceso = await comercio_service.resolver_acceso_al_curso(
            db, user_id=uid, course_id=course.id, es_admin=False
        )
        return acceso.tiene_acceso
    return await _is_enrolled(db, uid, course.id)


async def _contenido_listo(db: AsyncSession, uid: str | None, course: Course) -> bool:
    """Si el contenido de este curso se puede ENTREGAR: rutas de video y texto.

    NO ES LO MISMO QUE TENER ACCESO, y confundirlo era el agujero. «Próximamente»
    (`courses.coming_soon`) no es un permiso que le falte a alguien: es que el
    contenido todavía no está hecho. Un curso GRATUITO da acceso a todo el mundo
    —`_tiene_acceso` devuelve True en la primera línea—, así que un curso
    anunciado y sin terminar repartía las rutas de sus vídeos a cualquiera que
    pidiera su ficha, y `/lessons/<id>` entregaba el texto entero de una lección
    escrita.

    La pantalla ya no enlaza ahí desde que se arregló la ficha, pero un enlace
    directo seguía funcionando: arreglar solo lo que se ve deja la puerta puesta.

    Quien gestiona el curso sí lo recibe todo. Es como comprueba lo que sube.
    """
    if await _puede_gestionar(db, uid, course):
        return True
    return not course.coming_soon


async def _puede_gestionar(db: AsyncSession, uid: str | None, course: Course) -> bool:
    if uid is None:
        return False
    if course.author_id == uid:
        return True
    return await is_admin(db, uid)


async def _curso_visible(
    db: AsyncSession, course_id: str, uid: str | None
) -> Course:
    """El curso, si esta persona tiene algo que hacer con el.

    Un borrador es de su autor y de nadie mas. Antes este endpoint devolvia
    cualquier curso por id, asi que un borrador se podia leer entero —titulo,
    descripcion, temario— con solo conocer su identificador.
    """
    ensure_uuid(course_id, "Curso no encontrado.")
    course = await db.get(Course, course_id)
    if course is None or course.status == "deleted":
        raise NotFoundError("Curso no encontrado.")
    if course.status != "published":
        if uid is None or not await _puede_gestionar(db, uid, course):
            raise NotFoundError("Curso no encontrado.")
    return course


async def _temario(
    db: AsyncSession, course_id: str
) -> list[tuple[CourseModule, list[CourseLesson]]]:
    """Modulos y lecciones de un curso en UNA consulta.

    Antes se pedian las lecciones modulo por modulo: un curso de diez modulos
    eran once viajes a la base para pintar una lista. `outerjoin` para que un
    modulo recien creado y todavia vacio no desaparezca del temario.
    """
    filas = (
        await db.execute(
            select(CourseModule, CourseLesson)
            .outerjoin(CourseLesson, CourseLesson.module_id == CourseModule.id)
            .where(CourseModule.course_id == course_id)
            .order_by(
                CourseModule.sort_order,
                CourseLesson.sort_order,
            )
        )
    ).all()

    orden: list[str] = []
    modulos: dict[str, CourseModule] = {}
    lecciones: dict[str, list[CourseLesson]] = {}
    for modulo, leccion in filas:
        if modulo.id not in modulos:
            modulos[modulo.id] = modulo
            lecciones[modulo.id] = []
            orden.append(modulo.id)
        if leccion is not None:
            lecciones[modulo.id].append(leccion)
    return [(modulos[i], lecciones[i]) for i in orden]


async def _progreso_de(
    db: AsyncSession, uid: str | None, lesson_ids: list[str]
) -> dict[str, LessonProgress]:
    """El progreso de ESTAS lecciones, no el de todas las del historial.

    La consulta anterior se traia cada leccion que la persona hubiera terminado
    en cualquier curso: con el tiempo son miles de filas para marcar diez.
    """
    if not uid or not lesson_ids:
        return {}
    filas = (
        await db.execute(
            select(LessonProgress).where(
                LessonProgress.user_id == uid,
                LessonProgress.lesson_id.in_(lesson_ids),
            )
        )
    ).scalars()
    return {fila.lesson_id: fila for fila in filas}


@router.get("/courses/{course_id}", response_model=CourseDetailRead)
async def get_course_detail(
    course_id: str,
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> CourseDetailRead:
    uid = current_user.id if current_user else None
    course = await _curso_visible(db, course_id, uid)

    temario = await _temario(db, course.id)
    lesson_ids = [leccion.id for _, lecciones in temario for leccion in lecciones]
    progreso_por_leccion = await _progreso_de(db, uid, lesson_ids)
    tipos = await cursos_v2.tipos_de_lecciones(db, lesson_ids)
    descripciones = await cursos_v2.descripciones_de_modulos(
        db, [modulo.id for modulo, _ in temario]
    )

    tiene_acceso = await _tiene_acceso(db, uid, course)
    # Anunciado y aún sin contenido: el temario se sigue enseñando —es lo que
    # vende el curso— pero no viaja ni una ruta ni un texto de lección.
    listo = await _contenido_listo(db, uid, course)

    module_reads: list[ModuleRead] = []
    lessons_total = 0
    lessons_completed = 0
    duracion_total = 0
    for modulo, lecciones in temario:
        lesson_reads: list[LessonRead] = []
        for leccion in lecciones:
            avance = progreso_por_leccion.get(leccion.id)
            hecha = bool(avance and avance.completed)
            lessons_total += 1
            duracion_total += leccion.duration_seconds or 0
            if hecha:
                lessons_completed += 1
            # Sin la 0034 no hay tipo ni muestra: video y cerrada, que es
            # exactamente lo que hay hoy y ademas es el lado seguro.
            kind, es_muestra = tipos.get(leccion.id, ("video", False))
            lesson_reads.append(
                LessonRead(
                    id=leccion.id,
                    title=leccion.title,
                    duration_seconds=leccion.duration_seconds,
                    sort_order=leccion.sort_order,
                    completed=hecha,
                    media_path=_media_visible(
                        leccion.media_path,
                        acceso=listo and tiene_acceso,
                        # Una lección de MUESTRA de un curso que aún no existe
                        # tampoco se reproduce: no hay nada que mostrar.
                        muestra=listo and es_muestra,
                    ),
                    has_media=bool(leccion.media_path),
                    progress_seconds=avance.progress_seconds if avance else 0,
                    kind=kind,
                    is_preview=es_muestra,
                )
            )
        module_reads.append(
            ModuleRead(
                id=modulo.id,
                title=modulo.title,
                sort_order=modulo.sort_order,
                description=descripciones.get(modulo.id, ""),
                lessons=lesson_reads,
            )
        )

    temas = await temas_de_curso.leer(db, [course.id])
    ficha = await cursos_v2.leer_una(db, course.id)
    return CourseDetailRead(
        id=course.id,
        author_id=course.author_id,
        title=course.title,
        description=course.description,
        cover_path=course.cover_path,
        price_minor=course.price_minor,
        currency=course.currency,
        status=course.status,
        coming_soon=course.coming_soon,
        topic_ids=temas.get(course.id, []),
        enrolled=bool(uid) and await _is_enrolled(db, uid, course.id),
        has_access=tiene_acceso,
        can_manage=await _puede_gestionar(db, uid, course),
        progress_percent=progreso.porcentaje(lessons_completed, lessons_total),
        lessons_total=lessons_total,
        lessons_completed=lessons_completed,
        duration_seconds_total=duracion_total,
        modules=module_reads,
        subtitle=ficha.subtitle,
        promo_video_path=ficha.promo_video_path,
        primary_topic_id=ficha.primary_topic_id,
        language=ficha.language,
        level=ficha.level,
        highlights=list(course.highlights or []),
        target_audience=ficha.target_audience,
        prerequisites=ficha.prerequisites,
        review_status=ficha.review_status,
        # El motivo del rechazo es para quien tiene que corregirlo, no para
        # quien mira el curso: se manda solo a quien puede gestionarlo.
        rejection_reason=(
            ficha.rejection_reason
            if await _puede_gestionar(db, uid, course)
            else None
        ),
    )


def _media_visible(
    media_path: str | None, *, acceso: bool, muestra: bool
) -> str | None:
    """La ruta del medio, SOLO para quien puede reproducirlo.

    POR QUE EXISTE ESTA FUNCION. El temario se entrega entero sin acceso —
    titulos, duraciones y descripciones son lo que vende el curso— pero la RUTA
    del video no es temario: es el archivo. Este endpoint las devolvia todas a
    cualquiera que abriera la ficha de un curso de pago.

    No era una brecha: el bucket `course-media` es privado y sus politicas
    exigen `has_course_access()` para firmar una URL, asi que la descarga se
    deniega igual. Pero es informacion que no hace falta dar, y el dia que
    alguien afloje una politica de almacenamiento la ruta ya estaria repartida.

    Una leccion marcada como MUESTRA si entrega su ruta: para eso es una
    muestra. Esa parte la respalda `has_lesson_access` en la base de datos
    (0036), que es quien de verdad deja firmar la URL de una preview.
    """
    if media_path is None:
        return None
    return media_path if (acceso or muestra) else None


def _texto_visible(
    body: str | None, *, kind: str, acceso: bool, muestra: bool
) -> str:
    """El cuerpo de una leccion ESCRITA, solo para quien puede leerla.

    POR QUE NO BASTA CON ESCONDER `media_path`. En una leccion de video el
    cuerpo son notas y la puerta de verdad la cierra el almacenamiento: sin
    `has_lesson_access` no se firma la URL, diga lo que diga este endpoint.

    En una leccion `kind='text'` (0034) NO HAY ARCHIVO. El contenido es este
    texto, viaja en la respuesta JSON y el almacenamiento no puede protegerlo
    porque nunca llega a existir un objeto que proteger. Entregarlo sin mirar el
    acceso deja leer entero un curso escrito con solo abrir la leccion, aunque
    todo lo demas del muro este bien puesto.

    Una MUESTRA si entrega su texto: para eso esta marcada.
    """
    if kind != "text" or acceso or muestra:
        return body or ""
    return ""


@router.post("/courses/{course_id}/enroll")
async def enroll_course(
    course_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    """Concede acceso a un curso GRATUITO. No es una compra.

    LO QUE ARREGLA, Y ERA UN AGUJERO DE VERDAD. Antes creaba la fila de acceso
    para CUALQUIER curso sin mirar el precio: un curso de 200 soles se conseguia
    gratis llamando a esta URL. Y no hacia falta saltarse la aplicacion, porque
    el boton «Empezar curso» la llamaba solo. El muro de pago de la migracion
    0016 estaba bien hecho; esta puerta lo rodeaba por dentro.

    POR QUE SIGUE SIENDO UNA FILA DE `purchases`. Porque es la tabla que ya
    consulta `has_course_access()` en la base de datos, que es quien manda de
    verdad sobre los archivos. Inventar una tabla de matriculas aparte
    obligaria a ensenarle la nueva a la RLS y a mantener dos verdades sobre lo
    mismo. Lo que representa esta fila es un DERECHO DE ACCESO gratuito, no un
    cobro: `provider='manual'`, `amount_minor=0`. Ni un centimo cambio de manos
    y ningun sitio finge que si.

    Cuando exista pasarela, el camino de un curso de pago sera
    `/payments/checkout` y su webhook. Nunca este endpoint.
    """
    course = await _curso_visible(db, course_id, current_user.id)

    if course.price_minor > 0:
        raise ForbiddenError(
            "Este curso es de pago; la inscripción gratuita no está permitida.",
            code="course_requires_purchase",
        )

    if not await _is_enrolled(db, current_user.id, course.id):
        db.add(
            Purchase(
                user_id=current_user.id,
                course_id=course.id,
                provider="manual",
                amount_minor=0,
                currency=course.currency,
                status="paid",
            )
        )
        await db.commit()
    return {"enrolled": True}


# --------------------------------------------------------------------------- #
# La Beta gratuita
#
# QUE ES. Mientras `BETA_FREE_ACCESS_ENABLED` este encendido, un curso de pago
# se puede conceder GRATIS a quien lo pide. Es una decision de negocio para la
# fase de pruebas: no hay pasarela lista y no va a haber cobros.
#
# QUE NO ES, Y ES LO QUE MAS IMPORTA. No es una compra ni finge serlo. NO se
# crea orden, NO se crea `payment_transaction`, NO se marca nada como 'paid', NO
# se inventa ningun evento de tienda y NO se toca `price_minor`: el curso sigue
# costando lo que cuesta y se seguira cobrando cuando la beta acabe. Un cobro
# falso de importe cero es una mentira contable que sobrevive a la beta y que
# alguien acaba desenredando con dinero real de por medio.
#
# POR QUE UN `entitlement` Y NO UNA VIA NUEVA. Porque la via ya existe y es la
# CUARTA de las cinco: `entitlements` es la fuente de verdad del acceso desde la
# 0035/0036, la mira `has_course_access()` en la base de datos —o sea, la que
# protege los ARCHIVOS— y la 0035 la dejo abierta a proposito para «un regalo,
# una beca o una compensacion... sin inventarse un cobro que no existio».
# Inventar una sexta via obligaria a ensenarsela tambien a la RLS y a mantener
# dos verdades sobre lo mismo, que es justo el fallo que corrigio la 0016.
#
# COMO SE DISTINGUE DE UNA COMPRA, PARA SIEMPRE. Por `source_provider`, que
# vale `'beta_free'` (`comercio_service.BETA_GRATIS`) y nunca el nombre de una
# pasarela, y por `transaction_id` NULO, porque no hubo cobro que apuntar.
#
# APAGAR EL INTERRUPTOR NO REVOCA NADA. Solo cierra la puerta: deja de
# concederse. Los derechos ya dados siguen 'active' y `has_course_access()` no
# pregunta de donde vienen. Un rollback que le quite el curso a gente real no es
# un rollback.
# --------------------------------------------------------------------------- #
@router.get("/courses/{course_id}/beta-access")
async def beta_access_state(
    course_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    """Si a este curso se le puede pedir el acceso gratuito de la Beta.

    Existe para que la pantalla no tenga que adivinarlo ni repetir la regla: el
    interruptor vive en el servidor, asi que apagarlo tiene que hacer
    desaparecer el boton sin publicar una version nueva de la aplicacion.
    """
    course = await _curso_visible(db, course_id, current_user.id)
    encendida = get_settings().beta_free_access_enabled
    tiene_acceso = await _tiene_acceso(db, current_user.id, course)
    return {
        "enabled": encendida,
        # Un curso gratuito ya entra por la primera via: no hay nada que
        # conceder. Y a quien ya tiene acceso no se le vuelve a ofrecer.
        "available": encendida and course.price_minor > 0 and not tiene_acceso,
        "has_access": tiene_acceso,
    }


@router.post("/courses/{course_id}/beta-access")
async def grant_beta_access(
    course_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    """Concede el acceso gratuito de la Beta. NO ES UNA COMPRA.

    IDEMPOTENTE, Y LO GARANTIZA LA BASE. `conceder_entitlement` inserta con `on
    conflict do nothing` contra el indice unico parcial
    `entitlements_activo_unico`: repetir la operacion —o pulsar dos veces, o dos
    telefonos a la vez— deja UN derecho, no dos. No hay ningun `if ya existe`
    aqui, porque dos peticiones simultaneas lo pasarian las dos.

    El acceso queda en el SERVIDOR, asi que la misma cuenta lo tiene desde
    cualquier dispositivo sin restaurar nada.
    """
    course = await _curso_visible(db, course_id, current_user.id)

    if not get_settings().beta_free_access_enabled:
        raise ForbiddenError(
            "El acceso gratuito de la Beta no está disponible.",
            code="beta_free_access_disabled",
        )

    # Un curso gratuito no necesita derecho —entra por la primera via— y ya
    # tiene su propio camino en `/enroll`. Concederlo tambien aqui serian dos
    # formas de apuntarse a lo mismo, y dos formas acaban diciendo cosas
    # distintas.
    if course.price_minor <= 0:
        raise ValidationAppError(
            "Este curso ya es gratuito: no necesita el acceso de la Beta.",
            code="course_is_free",
        )

    producto = await comercio_service.asegurar_producto_de_curso(
        db, course_id=course.id
    )
    _, es_nuevo = await comercio_service.conceder_entitlement(
        db,
        user_id=current_user.id,
        commerce_product_id=producto.id,
        source_provider=comercio_service.BETA_GRATIS,
        # NULO porque no hubo cobro. No es un descuido: es el dato.
        transaction_id=None,
        # Crea o asegura tambien la matricula, para que el curso salga en la
        # biblioteca. Es idempotente por su clave primaria.
        matricular_tambien=True,
    )
    await db.commit()
    return {"granted": True, "already_granted": not es_nuevo}


@router.get("/me/courses", response_model=list[MyCourseRead])
async def my_courses(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[MyCourseRead]:
    """La biblioteca, reconstruida desde el servidor.

    POR QUE EXISTE. La pantalla se apoyaba en `purchasedCourseIds`, una lista
    guardada en el telefono. Eso significaba que la biblioteca se vaciaba al
    reinstalar, no se compartia entre dispositivos y podia ensenar un curso al
    que ya no se tiene acceso. Lo que una persona tiene es un hecho del
    servidor, no una preferencia local.

    Cuenta constante de consultas: accesos, cursos, temario, progreso.
    """
    uid = current_user.id

    # Lo comprado por el flujo nuevo vive en `entitlements` y NO deja fila en
    # `purchases`; la tabla vieja sigue contando mientras dure el trasvase de la
    # 0036. `cursos_con_acceso` junta las dos, que es exactamente lo que
    # significa «mis cursos». Mirar solo `purchases` dejaba fuera de la
    # biblioteca al que acababa de pagar.
    accesos = await comercio_service.cursos_con_acceso(db, user_id=uid)
    if not accesos:
        return []

    cursos = list(
        await db.scalars(
            select(Course)
            .where(Course.id.in_(accesos), Course.status != "deleted")
            .order_by(Course.created_at.desc())
        )
    )
    if not cursos:
        return []

    filas = (
        await db.execute(
            select(CourseModule.course_id, CourseLesson.id)
            .join(CourseLesson, CourseLesson.module_id == CourseModule.id)
            .where(CourseModule.course_id.in_([c.id for c in cursos]))
            .order_by(CourseModule.sort_order, CourseLesson.sort_order)
        )
    ).all()
    por_curso: dict[str, list[str]] = {}
    for course_id, lesson_id in filas:
        por_curso.setdefault(course_id, []).append(lesson_id)

    # Un curso sin ninguna leccion deja `filas` vacio. Preguntar entonces por
    # `in_([""])` mandaria la cadena vacia a una columna `uuid`: PostgreSQL la
    # rechaza. Si no hay lecciones, no hay nada terminado que buscar.
    hechas: set[str] = set()
    if filas:
        hechas = set(
            await db.scalars(
                select(LessonProgress.lesson_id).where(
                    LessonProgress.user_id == uid,
                    LessonProgress.completed.is_(True),
                    LessonProgress.lesson_id.in_({f[1] for f in filas}),
                )
            )
        )

    salida: list[MyCourseRead] = []
    for curso in cursos:
        lecciones = por_curso.get(curso.id, [])
        completadas = [lid for lid in lecciones if lid in hechas]
        pendiente = next((lid for lid in lecciones if lid not in hechas), None)
        if not lecciones:
            estado = "not_started"
        elif len(completadas) >= len(lecciones):
            estado = "completed"
        elif completadas:
            estado = "in_progress"
        else:
            estado = "not_started"
        salida.append(
            MyCourseRead(
                id=curso.id,
                title=curso.title,
                description=curso.description,
                cover_path=curso.cover_path,
                author_id=curso.author_id,
                price_minor=curso.price_minor,
                currency=curso.currency,
                status=curso.status,
                lessons_total=len(lecciones),
                lessons_completed=len(completadas),
                progress_percent=progreso.porcentaje(len(completadas), len(lecciones)),
                state=estado,
                next_lesson_id=pendiente,
            )
        )
    return salida


async def _leccion_con_curso(
    db: AsyncSession, lesson_id: str
) -> tuple[CourseLesson, CourseModule, Course]:
    ensure_uuid(lesson_id, "Lección no encontrada.")
    fila = (
        await db.execute(
            select(CourseLesson, CourseModule, Course)
            .join(CourseModule, CourseModule.id == CourseLesson.module_id)
            .join(Course, Course.id == CourseModule.course_id)
            .where(CourseLesson.id == lesson_id)
        )
    ).first()
    if fila is None:
        raise NotFoundError("Lección no encontrada.")
    return fila  # type: ignore[return-value]


async def _arrancar_garantia(db: AsyncSession, uid: str, course_id: str) -> None:
    """Pone en marcha las 168 horas la PRIMERA vez que se entrega contenido.

    SOLO PARA QUIEN COMPRO. Un curso gratuito, un acceso de autor, uno de
    administracion o un regalo de la beta no tienen nada que devolver, asi que
    no arrancan ninguna garantia: `_orden_reembolsable` devuelve None y aqui no
    se escribe nada.

    NUNCA REVIENTA LA ENTREGA. Si la 0049 no esta aplicada, o si algo falla al
    escribir, quien pago tiene que ver su leccion igual. Una garantia que no
    arranco es un problema que se puede arreglar despues; una leccion que no se
    entrega es la compra rota.
    """
    from app.modules.refunds import esquema as esquema_devoluciones

    if not await esquema_devoluciones.hay_devoluciones(db):
        return
    # LA BANDERA NO SE MIRA AQUI, y es deliberado. Cierra la ENTRADA de
    # solicitudes nuevas, no las obligaciones ya contraidas. Si se apagara
    # despues de una compra, el primer acceso no escribiria la ventana, el saldo
    # del propietario se quedaria con `available_at` nulo y no se liberaria
    # NUNCA: dinero de un tercero retenido sin fin por un interruptor.
    from app.modules.refunds import service as devoluciones

    orden = await devoluciones._orden_reembolsable(
        db, user_id=uid, course_id=course_id
    )
    if orden is None:
        return

    # SAVEPOINT. Un fallo al escribir la garantia no puede dejar la transaccion
    # abortada: en PostgreSQL eso haria fallar todo lo que venga despues con un
    # error que no menciona la causa. Con `begin_nested` se deshace solo esto.
    try:
        async with db.begin_nested():
            await devoluciones.asegurar_ventana(
                db, user_id=uid, course_id=course_id, order_id=orden.id
            )
    except Exception:  # noqa: BLE001
        logger.exception(
            "[devoluciones] no se pudo arrancar la garantia del curso %s", course_id
        )
        return
    await db.commit()


@router.get("/lessons/{lesson_id}", response_model=LessonDetailRead)
async def get_lesson_detail(
    lesson_id: str,
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> LessonDetailRead:
    """Una leccion por su id.

    La app abre `/lesson/<id>` sin conocer el curso, asi que aqui se resuelve
    el contexto (modulo y curso) con un solo join.

    Se devuelven titulo, duracion y descripcion aunque no haya acceso: eso es
    el temario, que es lo que vende el curso. Lo que no se entrega sin acceso
    es el VIDEO —ni siquiera su ruta— y de eso se encarga ademas la RLS del
    almacenamiento: sin ella no se puede firmar la URL, diga lo que diga este
    endpoint. Salvo que la leccion sea MUESTRA, que es justo para lo que existe.
    """
    leccion, modulo, curso = await _leccion_con_curso(db, lesson_id)
    uid = current_user.id if current_user else None
    if curso.status != "published" and not await _puede_gestionar(db, uid, curso):
        raise NotFoundError("Lección no encontrada.")

    avance = None
    if uid:
        avance = await db.get(
            LessonProgress, {"user_id": uid, "lesson_id": lesson_id}
        )

    kind, es_muestra = (await cursos_v2.tipos_de_lecciones(db, [leccion.id])).get(
        leccion.id, ("video", False)
    )
    tiene_acceso = await _tiene_acceso(db, uid, curso)
    # ESTA ERA LA PUERTA DE ATRAS. La ficha del curso ya no ofrece «Empezar
    # curso» cuando está anunciado, pero `/lesson/<id>` se abre por enlace
    # directo y aquí no se miraba `coming_soon` en ningún momento.
    listo = await _contenido_listo(db, uid, curso)

    # AQUI ARRANCA LA GARANTIA DE DEVOLUCION, y solo aqui: en el instante en
    # que el servidor decide ENTREGAR contenido protegido. No al pagar, no al
    # abrir la ficha, no al ver una muestra.
    entregando_protegido = bool(uid) and listo and tiene_acceso and not es_muestra
    if entregando_protegido:
        await _arrancar_garantia(db, uid, curso.id)

    return LessonDetailRead(
        id=leccion.id,
        title=leccion.title,
        duration_seconds=leccion.duration_seconds,
        sort_order=leccion.sort_order,
        completed=bool(avance and avance.completed),
        media_path=_media_visible(
            leccion.media_path,
            acceso=listo and tiene_acceso,
            muestra=listo and es_muestra,
        ),
        has_media=bool(leccion.media_path),
        progress_seconds=avance.progress_seconds if avance else 0,
        body=_texto_visible(
            leccion.body,
            kind=kind,
            acceso=listo and tiene_acceso,
            muestra=listo and es_muestra,
        ),
        kind=kind,
        is_preview=es_muestra,
        can_manage=await _puede_gestionar(db, uid, curso),
        has_access=tiene_acceso,
        course_id=curso.id,
        course_title=curso.title,
        module_title=modulo.title,
    )


async def _guardar_progreso(
    db: AsyncSession,
    *,
    uid: str,
    lesson_id: str,
    segundos: int,
    declarado: bool,
) -> LessonProgressRead:
    """El nucleo del progreso. Idempotente: repetirlo no cambia el resultado.

    Registra la senal de curso terminado UNA sola vez, y desde el servidor: que
    alguien acabo un curso es un hecho que se deduce de sus lecciones, no algo
    que el movil pueda afirmar. Es la misma filosofia que seguir a alguien o
    cerrar una reserva.
    """
    leccion, _, curso = await _leccion_con_curso(db, lesson_id)

    if not await _tiene_acceso(db, uid, curso):
        raise ForbiddenError(
            "No tienes acceso al contenido de este curso.",
            code="course_access_required",
        )

    segundos = progreso.segundos_validos(segundos, leccion.duration_seconds)
    completa = progreso.esta_completa(
        segundos=segundos, duracion=leccion.duration_seconds, declarado=declarado
    )

    fila = await db.get(LessonProgress, {"user_id": uid, "lesson_id": lesson_id})
    ya_estaba_completa = bool(fila and fila.completed)
    if fila is None:
        fila = LessonProgress(
            user_id=uid,
            lesson_id=lesson_id,
            progress_seconds=segundos,
            completed=completa,
        )
        db.add(fila)
    else:
        # El maximo, no el ultimo: volver al minuto 2 de un video ya visto no
        # es perder el progreso, es repasar.
        fila.progress_seconds = max(fila.progress_seconds or 0, segundos)
        fila.completed = fila.completed or completa

    await db.flush()

    lecciones = list(
        await db.scalars(
            select(CourseLesson.id)
            .join(CourseModule, CourseModule.id == CourseLesson.module_id)
            .where(CourseModule.course_id == curso.id)
        )
    )
    hechas: set[str] = set()
    if lecciones:
        hechas = set(
            await db.scalars(
                select(LessonProgress.lesson_id).where(
                    LessonProgress.user_id == uid,
                    LessonProgress.completed.is_(True),
                    LessonProgress.lesson_id.in_(lecciones),
                )
            )
        )
    curso_completo = bool(lecciones) and len(hechas) >= len(lecciones)

    # Solo al cruzar la linea, no cada vez que se guarda un segundo.
    if curso_completo and not ya_estaba_completa and fila.completed:
        temas = await temas_de_curso.leer(db, [curso.id])
        await registrar_senal(
            db,
            user_id=uid,
            event_type="content_completed",
            entity_type="course",
            entity_id=curso.id,
            topic_ids=temas.get(curso.id) or None,
        )

    await db.commit()
    return LessonProgressRead(
        lesson_id=lesson_id,
        progress_seconds=fila.progress_seconds,
        completed=fila.completed,
        course_completed=curso_completo,
        course_progress_percent=progreso.porcentaje(len(hechas), len(lecciones)),
    )


@router.put("/lessons/{lesson_id}/progress", response_model=LessonProgressRead)
async def save_lesson_progress(
    lesson_id: str,
    payload: LessonProgressInput,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> LessonProgressRead:
    """Guarda por donde va esta persona en esta leccion.

    Es un PUT porque es idempotente: mandar dos veces los mismos segundos deja
    exactamente el mismo estado. Eso es lo que permite al reproductor
    reintentar sin miedo cuando se cae la red.

    La identidad sale del token, nunca del cuerpo: aceptar un `user_id` del
    cliente seria dejar que cualquiera escriba el progreso de otra persona.
    """
    return await _guardar_progreso(
        db,
        uid=current_user.id,
        lesson_id=lesson_id,
        segundos=payload.progress_seconds,
        declarado=payload.completed,
    )


@router.post("/lessons/{lesson_id}/complete", response_model=LessonProgressRead)
async def complete_lesson(
    lesson_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> LessonProgressRead:
    """Marca la leccion como vista. Se mantiene por los clientes ya instalados.

    Pasa por el mismo camino que el progreso para que no haya dos formas de
    completar una leccion que puedan discrepar. Antes esto escribia
    `completed = True` sin mirar si la persona tenia acceso al curso.
    """
    leccion, _, _ = await _leccion_con_curso(db, lesson_id)
    return await _guardar_progreso(
        db,
        uid=current_user.id,
        lesson_id=lesson_id,
        segundos=leccion.duration_seconds,
        declarado=True,
    )


@router.get("/courses/{course_id}/students", response_model=list[CourseStudentRead])
async def list_course_students(
    course_id: str,
    page: Page = Depends(pagination_params),
    buscar: str | None = Query(default=None, alias="q"),
    estado: str | None = Query(default=None, alias="state"),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[CourseStudentRead]:
    """Quien esta matriculado en este curso.

    SOLO EL AUTOR Y LA ADMINISTRACION. No «cualquiera con sesion»: la lista
    dice quien compro que, y eso no es publico. Un usuario ajeno recibe 403,
    no una lista vacia —una lista vacia le diria que el curso no tiene alumnos,
    que tambien es informacion—.

    QUIEN DEVOLVIO SIGUE EN LA LISTA, con el acceso retirado. Sacarlo seria
    perder que compro, y el propietario necesita ver sus devoluciones tanto
    como sus ventas.

    ORDEN ESTABLE por fecha de matricula y despues por id: sin el segundo
    criterio, dos matriculas del mismo instante pueden salir en orden distinto
    en cada pagina y una de ellas se repetiria o se saltaria al paginar.
    """
    ensure_uuid(course_id, "Curso no encontrado.")
    curso = await db.get(Course, course_id)
    if curso is None:
        raise NotFoundError("Curso no encontrado.")
    if not await _puede_gestionar(db, current_user.id, curso):
        raise ForbiddenError("No puedes ver los estudiantes de este curso.")

    if not await esquema_comercio.hay_matriculas(db):
        return []

    from app.modules.commerce.models import CourseEnrollment

    consulta = (
        select(CourseEnrollment, Profile)
        .join(Profile, Profile.id == CourseEnrollment.user_id)
        .where(CourseEnrollment.course_id == course_id)
    )
    if buscar:
        patron = f"%{buscar.strip()}%"
        consulta = consulta.where(
            Profile.full_name.ilike(patron) | Profile.username.ilike(patron)
        )

    # TODOS LOS FILTROS ANTES DE PAGINAR. Filtrar despues del `limit` es un
    # fallo que no se ve con pocos alumnos: se piden veinte, la base devuelve
    # veinte y el filtro deja seis, asi que la pagina sale con seis y la
    # siguiente se salta catorce personas que si cumplian. Con cien alumnos y
    # el filtro «sin empezar», la lista pierde la mayoria sin decirlo.
    #
    # Progreso y acceso viven en otras tablas, asi que el filtro se traduce a
    # subconsultas correlacionadas y NO a un recorte en Python.
    if estado in {"not_started", "in_progress", "completed"}:
        consulta = consulta.where(_condicion_de_progreso(course_id, estado))
    elif estado == "revoked":
        consulta = consulta.where(_condicion_de_acceso_retirado(course_id))

    filas = (
        await db.execute(
            consulta.order_by(
                CourseEnrollment.created_at.desc(), CourseEnrollment.user_id
            )
            .offset(page.offset)
            .limit(page.limit)
        )
    ).all()
    if not filas:
        return []

    total_lecciones = await _cuantas_lecciones(db, course_id)
    ids = [matricula.user_id for matricula, _ in filas]
    hechas = await _completadas_por_alumno(db, course_id, ids)
    accesos = await _acceso_por_alumno(db, course_id, ids)
    comercial = await _estado_comercial(db, course_id, ids)

    alumnos: list[CourseStudentRead] = []
    for matricula, perfil in filas:
        completadas = hechas.get(matricula.user_id, 0)
        porcentaje = (
            int(completadas * 100 / total_lecciones) if total_lecciones else 0
        )
        alumnos.append(
            CourseStudentRead(
                id=perfil.id,
                full_name=perfil.full_name or "",
                username=perfil.username,
                avatar_path=perfil.avatar_path,
                enrolled_at=matricula.created_at,
                source=matricula.source,
                lessons_total=total_lecciones,
                lessons_completed=completadas,
                progress_percent=porcentaje,
                state=(
                    "completed"
                    if total_lecciones and completadas >= total_lecciones
                    else "in_progress"
                    if completadas
                    else "not_started"
                ),
                access_state=accesos.get(matricula.user_id, "none"),
                commercial_state=comercial.get(matricula.user_id, "none"),
            )
        )

    return alumnos


def _lecciones_completadas(course_id: str):
    """Cuantas lleva completadas cada alumno, como subconsulta correlacionada."""
    from app.modules.commerce.models import CourseEnrollment

    return (
        select(func.count())
        .select_from(LessonProgress)
        .join(CourseLesson, CourseLesson.id == LessonProgress.lesson_id)
        .join(CourseModule, CourseModule.id == CourseLesson.module_id)
        .where(
            CourseModule.course_id == course_id,
            LessonProgress.user_id == CourseEnrollment.user_id,
            LessonProgress.completed.is_(True),
        )
        .scalar_subquery()
    )


def _total_de_lecciones(course_id: str):
    return (
        select(func.count())
        .select_from(CourseLesson)
        .join(CourseModule, CourseModule.id == CourseLesson.module_id)
        .where(CourseModule.course_id == course_id)
        .scalar_subquery()
    )


def _condicion_de_progreso(course_id: str, estado: str):
    """El filtro de progreso, en SQL.

    `completed` exige que el curso TENGA lecciones: sin esa guarda, un curso
    vacio daria 0 >= 0 y saldrian todos los alumnos como si lo hubieran
    terminado, cuando en realidad no hay nada que terminar.
    """
    hechas = _lecciones_completadas(course_id)
    total = _total_de_lecciones(course_id)
    if estado == "not_started":
        return hechas == 0
    if estado == "in_progress":
        return (hechas > 0) & (hechas < total)
    return (total > 0) & (hechas >= total)


def _condicion_de_acceso_retirado(course_id: str):
    """Quien tuvo acceso y ya no lo tiene.

    Se pide que exista un derecho NO activo y que no exista ninguno activo: con
    solo lo primero, alguien que devolvio y recompro saldria como retirado
    porque conserva la fila vieja revocada.
    """
    from app.modules.commerce.models import CommerceProduct, CourseEnrollment, Entitlement

    def _derechos(situacion_activa: bool):
        consulta = (
            select(Entitlement.id)
            .join(
                CommerceProduct,
                CommerceProduct.id == Entitlement.commerce_product_id,
            )
            .where(
                CommerceProduct.course_id == course_id,
                Entitlement.user_id == CourseEnrollment.user_id,
            )
        )
        if situacion_activa:
            return consulta.where(Entitlement.status == "active")
        return consulta.where(Entitlement.status != "active")

    return _derechos(False).exists() & ~_derechos(True).exists()


async def _cuantas_lecciones(db: AsyncSession, course_id: str) -> int:
    total = await db.scalar(
        select(func.count())
        .select_from(CourseLesson)
        .join(CourseModule, CourseModule.id == CourseLesson.module_id)
        .where(CourseModule.course_id == course_id)
    )
    return int(total or 0)


async def _completadas_por_alumno(
    db: AsyncSession, course_id: str, ids: list[str]
) -> dict[str, int]:
    """UNA consulta agrupada, no una por alumno.

    Con veinte alumnos por pagina, resolverlo fila a fila serian veinte viajes
    a la base para pintar una lista.
    """
    filas = (
        await db.execute(
            select(LessonProgress.user_id, func.count())
            .join(CourseLesson, CourseLesson.id == LessonProgress.lesson_id)
            .join(CourseModule, CourseModule.id == CourseLesson.module_id)
            .where(
                CourseModule.course_id == course_id,
                LessonProgress.user_id.in_(ids),
                LessonProgress.completed.is_(True),
            )
            .group_by(LessonProgress.user_id)
        )
    ).all()
    return {uid: int(cuantas) for uid, cuantas in filas}


async def _acceso_por_alumno(
    db: AsyncSession, course_id: str, ids: list[str]
) -> dict[str, str]:
    """Si cada uno conserva el acceso. Tambien en una sola consulta."""
    if not await esquema_comercio.hay_comercio(db):
        return {}
    from app.modules.commerce.models import CommerceProduct, Entitlement

    filas = (
        await db.execute(
            select(Entitlement.user_id, Entitlement.status)
            .join(
                CommerceProduct,
                CommerceProduct.id == Entitlement.commerce_product_id,
            )
            .where(
                CommerceProduct.course_id == course_id,
                Entitlement.user_id.in_(ids),
            )
        )
    ).all()
    # Si alguien tiene varias filas —compro, devolvio y recompro— manda la
    # activa: es la que decide si hoy entra.
    resultado: dict[str, str] = {}
    for uid, situacion in filas:
        if resultado.get(uid) == "active":
            continue
        resultado[uid] = "active" if situacion == "active" else "revoked"
    return resultado


async def _quien_compro(
    db: AsyncSession, course_id: str, ids: list[str]
) -> set[str]:
    """Quien tiene una orden PAGADA o REEMBOLSADA de este curso.

    Es lo que distingue una venta de una matricula gratuita. Sin ello, quien
    compro y nunca pidio una devolucion salia sin estado comercial, o sea
    indistinguible de quien entro con un curso gratis.
    """
    if not await esquema_comercio.hay_comercio(db):
        return set()
    from app.modules.commerce.models import CommerceProduct, Order

    filas = await db.scalars(
        select(Order.user_id)
        .join(CommerceProduct, CommerceProduct.id == Order.commerce_product_id)
        .where(
            CommerceProduct.course_id == course_id,
            Order.user_id.in_(ids),
            Order.status.in_(("paid", "refunded")),
        )
    )
    return set(filas)


async def _estado_comercial(
    db: AsyncSession, course_id: str, ids: list[str]
) -> dict[str, str]:
    """El estado de la venta, SIN el motivo privado de nadie.

    Cuatro valores y ninguno cuenta por que: `sold`, `under_review`,
    `refunded`, `none`. El propietario necesita saber que una venta esta en
    revision para no contar con ese dinero; no necesita saber que le parecio
    el curso a quien la pidio.
    """
    from app.modules.refunds import esquema as esquema_devoluciones

    # SE EMPIEZA POR QUIEN COMPRO. Una venta sin incidencias es `sold`; sin
    # esta base, quien compro y nunca pidio nada salia como `none`, o sea igual
    # que quien entro con un curso gratuito.
    compradores = await _quien_compro(db, course_id, ids)
    resultado: dict[str, str] = {uid: "sold" for uid in compradores}

    if not await esquema_devoluciones.hay_devoluciones(db):
        return resultado
    from app.modules.refunds.estados import REFUNDED, VIVOS
    from app.modules.refunds.models import RefundRequest

    filas = (
        await db.execute(
            select(RefundRequest.user_id, RefundRequest.status).where(
                RefundRequest.course_id == course_id,
                RefundRequest.user_id.in_(ids),
            )
        )
    ).all()
    # `refunded` manda sobre todo lo demas, y `under_review` sobre `sold`: si
    # alguien tiene un expediente cerrado y otro abierto, lo que el propietario
    # necesita saber es que hay dinero en revision.
    for uid, situacion in filas:
        if situacion == REFUNDED:
            resultado[uid] = "refunded"
        elif situacion in VIVOS and resultado.get(uid) != "refunded":
            resultado[uid] = "under_review"
    return resultado
