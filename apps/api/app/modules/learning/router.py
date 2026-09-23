"""Endpoints de aprendizaje: detalle del curso, acceso, progreso y biblioteca.

QUIEN DECIDE EL ACCESO. La verdad vive en la base de datos, en
`public.has_course_access()` (migracion 0016): es la que protege los ARCHIVOS,
y funciona aunque alguien llame al almacenamiento saltandose esta aplicacion.
Lo que hay aqui es la misma regla escrita para que la interfaz sepa que ensenar,
mas las comprobaciones de escritura, que si tienen que estar en el servidor.

Las dos tienen que decir lo mismo. `tests/test_muro_de_pago.py` las compara.
"""

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, Query, status
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.exceptions import (
    ConflictError,
    ForbiddenError,
    NotFoundError,
    ServiceUnavailableError,
    ValidationAppError,
)
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.catalog import cursos_v2, versiones
from app.modules.catalog.contenido import id_idempotente
from app.modules.gobernanza import auditoria
from app.modules.catalog.models import Course, CourseVersion
from app.modules.commerce import esquema as esquema_comercio
from app.modules.commerce import service as comercio_service
from app.modules.learning import esquema as esquema_aprendizaje
from app.modules.learning import certificados, evaluacion, finalizacion, progreso
from app.modules.learning.models import (
    CourseCertificate,
    CourseLesson,
    CourseModule,
    CourseQuiz,
    LessonNote,
    LessonProgress,
    Purchase,
    QuizAnswer,
    QuizAttempt,
    QuizOption,
    QuizQuestion,
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
    CertificadoRead,
    EnvioDeIntento,
    EvaluacionDeAutorRead,
    EvaluacionGuardada,
    EvaluacionRead,
    IntentoRead,
    NotaCreate,
    NotaRead,
    NotaUpdate,
    FinalizacionRead,
    MotivoDeRevocacion,
    OpcionDeAutorRead,
    OpcionRead,
    PreguntaDeAutorRead,
    PreguntaRead,
    VerificacionPublicaRead,
)
from app.modules.profiles.models import Profile
from app.modules.recommendations import temas_de_curso
from app.modules.recommendations.signals import registrar_senal
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.pagination import Page, pagination_params
from app.shared.permissions import is_admin, require_owner_or_strict_admin

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
    autor = await db.get(Profile, course.author_id)
    return CourseDetailRead(
        id=course.id,
        author_id=course.author_id,
        author_name=autor.full_name if autor else None,
        author_username=autor.username if autor else None,
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


async def _evaluaciones_de(
    db: AsyncSession, uid: str, course_ids: list[str]
) -> tuple[set[str], set[str]]:
    """Que cursos EXIGEN evaluacion y en cuales la aprobo esta persona.

    Dos consultas para la lista entera. Preguntarlo curso a curso serian dos por
    cada uno, y esto es la biblioteca completa de alguien.
    """
    if not course_ids or not await esquema_aprendizaje.hay_evaluaciones(db):
        return set(), set()

    exigen: dict[str, str] = {
        quiz.course_id: quiz.id
        for quiz in await db.scalars(
            select(CourseQuiz).where(
                CourseQuiz.course_id.in_(course_ids),
                CourseQuiz.status == "published",
            )
        )
    }
    if not exigen:
        return set(), set()

    por_quiz = {qid: cid for cid, qid in exigen.items()}
    aprobados = {
        por_quiz[qid]
        for qid in await db.scalars(
            select(QuizAttempt.quiz_id).where(
                QuizAttempt.quiz_id.in_(por_quiz.keys()),
                QuizAttempt.user_id == uid,
                QuizAttempt.status == "submitted",
                QuizAttempt.passed.is_(True),
            )
        )
        if qid in por_quiz
    }
    return set(exigen.keys()), aprobados


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

    # TERMINAR ES LA MISMA REGLA AQUI QUE EN `/completion`. Contar solo lecciones
    # dejaba la biblioteca diciendo «Finalizados» sobre un curso cuya evaluacion
    # no se ha aprobado, mientras la pantalla de finalizacion decia que no y el
    # certificado se rechazaba. Dos respuestas a la misma pregunta.
    #
    # En DOS consultas para todos los cursos, no una por curso: esta pantalla es
    # la biblioteca entera de alguien.
    exigen, aprobados = await _evaluaciones_de(db, uid, [c.id for c in cursos])

    salida: list[MyCourseRead] = []
    for curso in cursos:
        lecciones = por_curso.get(curso.id, [])
        completadas = [lid for lid in lecciones if lid in hechas]
        pendiente = next((lid for lid in lecciones if lid not in hechas), None)
        contenido_hecho = bool(lecciones) and len(completadas) >= len(lecciones)
        terminado = contenido_hecho and (
            curso.id not in exigen or curso.id in aprobados
        )
        if not lecciones:
            estado = "not_started"
        elif terminado:
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

    # TERMINAR EL CURSO NO ES SOLO VER LAS LECCIONES. Si hay evaluacion final
    # publicada, hace falta ademas un intento aprobado; la regla entera vive en
    # `finalizacion.py` y aqui se pregunta, no se repite.
    estado = await finalizacion.registrar(db, user_id=uid, course_id=curso.id)
    curso_completo = estado.terminado

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
        course_progress_percent=estado.porcentaje,
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


# --------------------------------------------------------------------------- #
# Notas privadas de una lección (0057)
#
# PRIVADAS SIN EXCEPCIONES. No hay ruta para leer las de otro: ni el autor del
# curso, ni moderación, ni administración. Por eso ninguna de estas funciones
# acepta un `user_id` y todas filtran por `current_user.id`.
# --------------------------------------------------------------------------- #


async def _exigir_notas(db: AsyncSession) -> None:
    if not await esquema_aprendizaje.hay_notas(db):
        raise ServiceUnavailableError(
            "Las notas todavía no están disponibles.",
            code="lesson_notes_not_available",
        )


def _a_nota(fila: LessonNote, version: int | None) -> NotaRead:
    return NotaRead(
        id=fila.id,
        lesson_id=fila.lesson_id,
        course_id=fila.course_id,
        body=fila.body,
        position_seconds=fila.position_seconds,
        course_version=version,
        created_at=fila.created_at,
        updated_at=fila.updated_at,
    )


async def _versiones_de(db: AsyncSession, ids: set[str]) -> dict[str, int]:
    """El número legible de cada versión, en UNA consulta."""
    limpios = {i for i in ids if i}
    if not limpios:
        return {}
    filas = await db.execute(
        select(CourseVersion.id, CourseVersion.version).where(
            CourseVersion.id.in_(limpios)
        )
    )
    return {vid: numero for vid, numero in filas}


async def _mi_nota(db: AsyncSession, note_id: str, uid: str) -> LessonNote:
    """La nota propia, o 404. Nunca 403: decir «existe pero no es tuya» ya
    cuenta algo de lo que otra persona escribió."""
    fila = await db.get(LessonNote, ensure_uuid(note_id, "Nota no encontrada."))
    if fila is None or fila.user_id != uid:
        raise NotFoundError("Nota no encontrada.")
    return fila


@router.get("/lessons/{lesson_id}/notes", response_model=list[NotaRead])
async def listar_notas(
    lesson_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[NotaRead]:
    """Mis notas de esta lección, de la más reciente a la más vieja."""
    await _exigir_notas(db)
    lid = ensure_uuid(lesson_id, "Lección no encontrada.")

    filas = list(
        await db.scalars(
            select(LessonNote)
            .where(LessonNote.user_id == current_user.id, LessonNote.lesson_id == lid)
            # Desempate por id: sin él, dos del mismo instante bailan entre cargas.
            .order_by(LessonNote.created_at.desc(), LessonNote.id.desc())
        )
    )
    numeros = await _versiones_de(db, {f.course_version_id for f in filas})
    return [_a_nota(f, numeros.get(f.course_version_id)) for f in filas]


@router.post(
    "/lessons/{lesson_id}/notes",
    response_model=NotaRead,
    status_code=status.HTTP_201_CREATED,
)
async def crear_nota(
    lesson_id: str,
    payload: NotaCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> NotaRead:
    """Apuntar algo en esta lección.

    PIDE ACCESO al contenido del curso: tomar apuntes de una lección que no se
    puede abrir no es un caso real, y sin esta comprobación cualquiera podría
    escribir filas asociadas a cualquier curso.

    UN DOBLE TOQUE NO CREA DOS NOTAS: con `Idempotency-Key` el id se DERIVA de
    la clave, así que la segunda inserción choca contra la clave primaria y se
    devuelve la que ya estaba. Lo sostiene la base, no un `if`.
    """
    await _exigir_notas(db)
    leccion, _modulo, curso = await _leccion_con_curso(db, lesson_id)
    if not await _tiene_acceso(db, current_user.id, curso):
        raise ForbiddenError(
            "Necesitas acceso al curso para tomar notas.",
            code="lesson_notes_access_required",
        )

    texto = payload.body.strip()
    if not texto:
        raise ValidationAppError(
            "La nota no puede estar vacía.", code="lesson_note_empty"
        )

    derivado = id_idempotente(f"nota:{leccion.id}", current_user.id, idempotency_key)
    if derivado is not None:
        existente = await db.get(LessonNote, derivado)
        if existente is not None:
            numeros = await _versiones_de(db, {existente.course_version_id})
            return _a_nota(existente, numeros.get(existente.course_version_id))

    version = await versiones.vigente(db, curso.id)
    fila = LessonNote(
        user_id=current_user.id,
        course_id=curso.id,
        lesson_id=leccion.id,
        course_version_id=version.id if version is not None else None,
        body=texto,
        position_seconds=payload.position_seconds,
    )
    if derivado is not None:
        fila.id = derivado
    db.add(fila)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        existente = await db.get(LessonNote, derivado) if derivado else None
        if existente is None:
            raise
        numeros = await _versiones_de(db, {existente.course_version_id})
        return _a_nota(existente, numeros.get(existente.course_version_id))

    await db.refresh(fila)
    return _a_nota(fila, version.version if version is not None else None)


@router.patch("/notes/{note_id}", response_model=NotaRead)
async def editar_nota(
    note_id: str,
    payload: NotaUpdate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> NotaRead:
    """Corregir una nota propia. La versión anotada NO se toca: dice cuándo se
    estudió, no cuándo se editó."""
    await _exigir_notas(db)
    fila = await _mi_nota(db, note_id, current_user.id)

    cambios = payload.model_dump(exclude_unset=True)
    if not cambios:
        raise ValidationAppError(
            "No hay nada que cambiar.", code="lesson_note_no_changes"
        )
    if "body" in cambios:
        texto = (cambios["body"] or "").strip()
        if not texto:
            raise ValidationAppError(
                "La nota no puede estar vacía.", code="lesson_note_empty"
            )
        fila.body = texto
    if "position_seconds" in cambios:
        fila.position_seconds = cambios["position_seconds"]

    await db.commit()
    await db.refresh(fila)
    numeros = await _versiones_de(db, {fila.course_version_id})
    return _a_nota(fila, numeros.get(fila.course_version_id))


@router.delete("/notes/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
async def retirar_nota(
    note_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Borrar una nota propia. Es suya: se borra de verdad, no se oculta."""
    await _exigir_notas(db)
    fila = await _mi_nota(db, note_id, current_user.id)
    await db.delete(fila)
    await db.commit()


# --------------------------------------------------------------------------- #
# Evaluación final del curso (0058)
#
# LA RESPUESTA CORRECTA NO SALE DE AQUÍ mientras se responde. La garantía no es
# «acordarse de no incluirla»: son DOS familias de esquemas, y el del alumno
# —`OpcionRead`— ni siquiera declara el campo.
# --------------------------------------------------------------------------- #


async def _exigir_evaluaciones(db: AsyncSession) -> None:
    if not await esquema_aprendizaje.hay_evaluaciones(db):
        raise ServiceUnavailableError(
            "La evaluación todavía no está disponible.",
            code="course_quiz_not_available",
        )


async def _exigir_autoria_de_la_evaluacion(
    db: AsyncSession, curso: Course, current_user: AuthUser, accion: str
) -> None:
    """Quien puede TOCAR las respuestas correctas de un curso.

    NO ES `_puede_gestionar`, que incluye a `moderator`. Moderar existe para
    ocultar contenido y resolver reportes, no para decidir quien se certifica:
    quien cambia la alternativa correcta cambia quien aprueba, y con ello quien
    obtiene un certificado verificable. Eso es del autor, o de administracion
    con poder real —la misma que mueve dinero—, y queda anotado.
    """
    if curso.author_id != current_user.id:
        await require_owner_or_strict_admin(
            db,
            curso.author_id,
            current_user,
            "Solo el autor del curso puede administrar su evaluación.",
        )
        # Solo se anota cuando NO es el autor: que alguien edite lo suyo no es
        # un hecho que investigar.
        await auditoria.anotar(
            db,
            actor_id=current_user.id,
            action=f"course_quiz.{accion}",
            entity_type="course",
            entity_id=curso.id,
            payload={"author_id": curso.author_id},
        )


async def _curso_o_404(db: AsyncSession, course_id: str) -> Course:
    curso = await db.get(Course, ensure_uuid(course_id, "Curso no encontrado."))
    if curso is None or curso.status == "deleted":
        raise NotFoundError("Curso no encontrado.")
    return curso


async def _preguntas_con_opciones(
    db: AsyncSession, quiz_id: str
) -> list[tuple[QuizQuestion, list[QuizOption]]]:
    """El cuestionario entero en DOS consultas, no una por pregunta."""
    preguntas = list(
        await db.scalars(
            select(QuizQuestion)
            .where(QuizQuestion.quiz_id == quiz_id)
            .order_by(QuizQuestion.sort_order, QuizQuestion.id)
        )
    )
    if not preguntas:
        return []
    opciones: dict[str, list[QuizOption]] = {}
    for opcion in await db.scalars(
        select(QuizOption)
        .where(QuizOption.question_id.in_([p.id for p in preguntas]))
        .order_by(QuizOption.sort_order, QuizOption.id)
    ):
        opciones.setdefault(opcion.question_id, []).append(opcion)
    return [(p, opciones.get(p.id, [])) for p in preguntas]


def _a_intento(fila: QuizAttempt, version: int | None = None) -> IntentoRead:
    return IntentoRead(
        id=fila.id,
        status=fila.status,
        score_percent=fila.score_percent,
        passed=fila.passed,
        started_at=fila.started_at,
        submitted_at=fila.submitted_at,
        course_version=version,
    )


async def _quiz_del_curso(db: AsyncSession, course_id: str) -> CourseQuiz | None:
    return await db.scalar(select(CourseQuiz).where(CourseQuiz.course_id == course_id))


async def _mejor_intento(
    db: AsyncSession, *, quiz_id: str, user_id: str
) -> QuizAttempt | None:
    """El mejor enviado. Es el que cuenta para terminar el curso: reintentar no
    puede empeorar lo que ya se consiguió."""
    return await db.scalar(
        select(QuizAttempt)
        .where(
            QuizAttempt.quiz_id == quiz_id,
            QuizAttempt.user_id == user_id,
            QuizAttempt.status == "submitted",
        )
        .order_by(QuizAttempt.score_percent.desc(), QuizAttempt.submitted_at.desc())
        .limit(1)
    )


@router.get("/courses/{course_id}/quiz/draft", response_model=EvaluacionDeAutorRead)
async def borrador_de_evaluacion(
    course_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EvaluacionDeAutorRead:
    """La evaluación CON las respuestas correctas. Solo quien gestiona el curso.

    ESTE GET ESCRIBE, y es a propósito: es la única puerta de toda la API por la
    que sale `is_correct`, así que cuando la abre alguien que no es el autor
    tiene que quedar constancia. `anotar` solo hace `flush` y nadie confirma por
    una petición de lectura, así que el `commit` va aquí: sin él la nota se
    deshacía al cerrar la sesión y la puerta quedaba sin rastro.
    """
    await _exigir_evaluaciones(db)
    curso = await _curso_o_404(db, course_id)
    await _exigir_autoria_de_la_evaluacion(db, curso, current_user, "read_draft")
    await db.commit()
    return await _leer_borrador(db, curso)


async def _leer_borrador(db: AsyncSession, curso: Course) -> EvaluacionDeAutorRead:
    """El borrador, SIN comprobar permiso y sin anotar nada.

    Lo llaman `guardar` y `publicar` para devolver el estado nuevo: pasar por el
    endpoint dejaba una segunda nota `read_draft` en cada escritura, escrita
    después del `commit` y por tanto descartada. Una nota que no se guarda y un
    hecho que no ocurrió.
    """
    quiz = await _quiz_del_curso(db, curso.id)
    if quiz is None:
        raise NotFoundError(
            "Este curso todavía no tiene evaluación.", code="course_quiz_not_found"
        )

    filas = await _preguntas_con_opciones(db, quiz.id)
    return EvaluacionDeAutorRead(
        id=quiz.id,
        course_id=quiz.course_id,
        title=quiz.title,
        pass_percent=quiz.pass_percent,
        status=quiz.status,
        questions=[
            PreguntaDeAutorRead(
                id=p.id,
                prompt=p.prompt,
                sort_order=p.sort_order,
                options=[
                    OpcionDeAutorRead(id=o.id, body=o.body, is_correct=o.is_correct)
                    for o in opciones
                ],
            )
            for p, opciones in filas
        ],
        blocking_reason=evaluacion.motivo_para_no_publicar(
            [(p.id, [o.is_correct for o in opciones]) for p, opciones in filas]
        ),
    )


@router.put("/courses/{course_id}/quiz", response_model=EvaluacionDeAutorRead)
async def guardar_evaluacion(
    course_id: str,
    payload: EvaluacionGuardada,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EvaluacionDeAutorRead:
    """Guardar la evaluación entera.

    SE REEMPLAZA COMPLETA, y a propósito: media evaluación guardada —preguntas
    nuevas con las alternativas viejas— es peor que ninguna.

    LOS INTENTOS YA ENVIADOS NO SE TOCAN. Guardan su nota, así que reescribir
    las preguntas no cambia lo que alguien sacó el mes pasado. Sus respuestas
    sí se van con las opciones borradas —son de esas opciones— pero la nota,
    que es lo que decide el certificado, se queda.
    """
    await _exigir_evaluaciones(db)
    curso = await _curso_o_404(db, course_id)
    await _exigir_autoria_de_la_evaluacion(db, curso, current_user, "written")

    for pregunta in payload.questions:
        if sum(1 for o in pregunta.options if o.is_correct) > 1:
            raise ValidationAppError(
                "Cada pregunta tiene una sola respuesta correcta.",
                code="quiz_multiple_correct",
            )

    quiz = await _quiz_del_curso(db, curso.id)
    if quiz is None:
        quiz = CourseQuiz(course_id=curso.id)
        db.add(quiz)
        await db.flush()
    quiz.title = payload.title.strip()
    quiz.pass_percent = payload.pass_percent

    # Borrar y volver a escribir: las respuestas de un intento ABIERTO apuntan a
    # opciones que dejan de existir, y eso es correcto —la evaluación cambió—.
    await db.execute(
        delete(QuizQuestion).where(QuizQuestion.quiz_id == quiz.id)
    )
    for posicion, pregunta in enumerate(payload.questions):
        fila = QuizQuestion(
            quiz_id=quiz.id, prompt=pregunta.prompt.strip(), sort_order=posicion
        )
        db.add(fila)
        await db.flush()
        for orden, opcion in enumerate(pregunta.options):
            db.add(
                QuizOption(
                    question_id=fila.id,
                    body=opcion.body.strip(),
                    is_correct=opcion.is_correct,
                    sort_order=orden,
                )
            )
    await db.flush()
    # UNA EVALUACIÓN PUBLICADA SIEMPRE SE PUEDE APROBAR. Vaciarla o dejar una
    # pregunta sin respuesta correcta la volvía imposible de aprobar SIN dejar
    # de ser obligatoria, y con eso el curso entero se quedaba sin poder
    # terminarse para todos sus alumnos. Vuelve a borrador, que es lo que es, y
    # el estado sale en la respuesta para que quien la editó lo vea.
    if quiz.status == "published":
        filas = await _preguntas_con_opciones(db, quiz.id)
        if (
            evaluacion.motivo_para_no_publicar(
                [(p.id, [o.is_correct for o in opciones]) for p, opciones in filas]
            )
            is not None
        ):
            quiz.status = "draft"
    await db.commit()
    return await _leer_borrador(db, curso)


@router.post("/courses/{course_id}/quiz/publish", response_model=EvaluacionDeAutorRead)
async def publicar_evaluacion(
    course_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EvaluacionDeAutorRead:
    """Ponerla delante del alumno. Se comprueba ANTES de tocar el estado."""
    await _exigir_evaluaciones(db)
    curso = await _curso_o_404(db, course_id)
    await _exigir_autoria_de_la_evaluacion(db, curso, current_user, "published")

    quiz = await _quiz_del_curso(db, curso.id)
    if quiz is None:
        raise NotFoundError(
            "Este curso todavía no tiene evaluación.", code="course_quiz_not_found"
        )

    filas = await _preguntas_con_opciones(db, quiz.id)
    motivo = evaluacion.motivo_para_no_publicar(
        [(p.id, [o.is_correct for o in opciones]) for p, opciones in filas]
    )
    if motivo is not None:
        raise ValidationAppError(
            "La evaluación todavía no está lista para publicarse.", code=motivo
        )

    quiz.status = "published"
    await db.commit()
    return await _leer_borrador(db, curso)


@router.get("/courses/{course_id}/quiz", response_model=EvaluacionRead)
async def evaluacion_publicada(
    course_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EvaluacionRead:
    """La evaluación, SIN soluciones, para quien tiene el curso."""
    await _exigir_evaluaciones(db)
    curso = await _curso_o_404(db, course_id)
    if not await _tiene_acceso(db, current_user.id, curso):
        raise ForbiddenError(
            "Necesitas acceso al curso para hacer la evaluación.",
            code="course_quiz_access_required",
        )

    quiz = await _quiz_del_curso(db, curso.id)
    if quiz is None or quiz.status != "published":
        raise NotFoundError(
            "Este curso no tiene evaluación publicada.", code="course_quiz_not_found"
        )

    filas = await _preguntas_con_opciones(db, quiz.id)
    abierto = await db.scalar(
        select(QuizAttempt).where(
            QuizAttempt.quiz_id == quiz.id,
            QuizAttempt.user_id == current_user.id,
            QuizAttempt.status == "in_progress",
        )
    )
    mejor = await _mejor_intento(db, quiz_id=quiz.id, user_id=current_user.id)
    return EvaluacionRead(
        id=quiz.id,
        course_id=quiz.course_id,
        title=quiz.title,
        pass_percent=quiz.pass_percent,
        questions=[
            PreguntaRead(
                id=p.id,
                prompt=p.prompt,
                sort_order=p.sort_order,
                options=[OpcionRead(id=o.id, body=o.body) for o in opciones],
            )
            for p, opciones in filas
        ],
        open_attempt=_a_intento(abierto) if abierto is not None else None,
        best_attempt=_a_intento(mejor) if mejor is not None else None,
    )


@router.post(
    "/courses/{course_id}/quiz/attempts",
    response_model=IntentoRead,
    status_code=status.HTTP_201_CREATED,
)
async def empezar_intento(
    course_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> IntentoRead:
    """Empezar, o retomar el que ya estaba abierto.

    UN SOLO INTENTO ABIERTO por persona y evaluación, y lo sostiene un índice
    único parcial: dos toques a la vez no abren dos, el segundo choca contra el
    índice y se devuelve el que ya había.
    """
    await _exigir_evaluaciones(db)
    curso = await _curso_o_404(db, course_id)
    if not await _tiene_acceso(db, current_user.id, curso):
        raise ForbiddenError(
            "Necesitas acceso al curso para hacer la evaluación.",
            code="course_quiz_access_required",
        )

    quiz = await _quiz_del_curso(db, curso.id)
    if quiz is None or quiz.status != "published":
        raise NotFoundError(
            "Este curso no tiene evaluación publicada.", code="course_quiz_not_found"
        )

    abierto = await db.scalar(
        select(QuizAttempt).where(
            QuizAttempt.quiz_id == quiz.id,
            QuizAttempt.user_id == current_user.id,
            QuizAttempt.status == "in_progress",
        )
    )
    if abierto is not None:
        return _a_intento(abierto)

    version = await versiones.vigente(db, curso.id)
    fila = QuizAttempt(
        quiz_id=quiz.id,
        user_id=current_user.id,
        course_id=curso.id,
        course_version_id=version.id if version is not None else None,
    )
    db.add(fila)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        abierto = await db.scalar(
            select(QuizAttempt).where(
                QuizAttempt.quiz_id == quiz.id,
                QuizAttempt.user_id == current_user.id,
                QuizAttempt.status == "in_progress",
            )
        )
        if abierto is None:
            raise
        return _a_intento(abierto)

    await db.refresh(fila)
    return _a_intento(fila, version.version if version is not None else None)


@router.post("/quiz-attempts/{attempt_id}/submit", response_model=IntentoRead)
async def enviar_intento(
    attempt_id: str,
    payload: EnvioDeIntento,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> IntentoRead:
    """Enviar las respuestas. LA NOTA LA PONE EL SERVIDOR.

    UN INTENTO ENVIADO NO SE MODIFICA: el segundo envío responde 409 con la
    nota que ya tenía, en vez de recalcularla. Así un doble toque no produce
    dos resultados distintos ni permite ir probando respuestas.
    """
    await _exigir_evaluaciones(db)
    intento = await db.get(
        QuizAttempt, ensure_uuid(attempt_id, "Intento no encontrado.")
    )
    if intento is None or intento.user_id != current_user.id:
        raise NotFoundError("Intento no encontrado.")
    if intento.status == "submitted":
        raise ConflictError(
            "Este intento ya se envió.",
            code="quiz_attempt_already_submitted",
            details={"score_percent": intento.score_percent, "passed": intento.passed},
        )

    quiz = await db.get(CourseQuiz, intento.quiz_id)
    if quiz is None:
        raise NotFoundError("Intento no encontrado.")

    filas = await _preguntas_con_opciones(db, quiz.id)
    correctas = {
        pregunta.id: next((o.id for o in opciones if o.is_correct), "")
        for pregunta, opciones in filas
    }
    validas = {
        pregunta.id: {o.id for o in opciones} for pregunta, opciones in filas
    }

    elegidas: dict[str, str] = {}
    for respuesta in payload.answers:
        if respuesta.question_id not in validas:
            raise ValidationAppError(
                "Esa pregunta no es de esta evaluación.", code="quiz_question_unknown"
            )
        if respuesta.option_id not in validas[respuesta.question_id]:
            raise ValidationAppError(
                "Esa alternativa no es de esa pregunta.", code="quiz_option_unknown"
            )
        elegidas[respuesta.question_id] = respuesta.option_id

    nota, aprobado = evaluacion.califica(elegidas, correctas, quiz.pass_percent)

    await db.execute(delete(QuizAnswer).where(QuizAnswer.attempt_id == intento.id))
    for pregunta_id, opcion_id in elegidas.items():
        db.add(
            QuizAnswer(
                attempt_id=intento.id, question_id=pregunta_id, option_id=opcion_id
            )
        )
    intento.status = "submitted"
    intento.score_percent = nota
    intento.passed = aprobado
    intento.submitted_at = datetime.now(timezone.utc)
    await db.flush()
    # Aprobar puede ser lo ULTIMO que faltaba: si el curso queda terminado con
    # este intento, la fecha se anota ahora y no cuando alguien vuelva a tocar
    # una leccion que ya estaba completa.
    await finalizacion.registrar(
        db, user_id=current_user.id, course_id=intento.course_id
    )
    await db.commit()
    await db.refresh(intento)
    return _a_intento(intento)


@router.get("/courses/{course_id}/quiz/attempts", response_model=list[IntentoRead])
async def historial_de_intentos(
    course_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[IntentoRead]:
    """Mis intentos, del más reciente al más viejo. Solo los propios."""
    await _exigir_evaluaciones(db)
    curso = await _curso_o_404(db, course_id)
    quiz = await _quiz_del_curso(db, curso.id)
    if quiz is None:
        return []

    filas = list(
        await db.scalars(
            select(QuizAttempt)
            .where(
                QuizAttempt.quiz_id == quiz.id,
                QuizAttempt.user_id == current_user.id,
            )
            .order_by(QuizAttempt.started_at.desc(), QuizAttempt.id.desc())
        )
    )
    numeros = await _versiones_de(db, {f.course_version_id for f in filas})
    return [_a_intento(f, numeros.get(f.course_version_id)) for f in filas]


# --------------------------------------------------------------------------- #
# Finalización y certificado (0059)
#
# NADA DE ESTO LO DECIDE EL CLIENTE. Que un curso esté terminado se deduce de
# las lecciones y de la evaluación; el certificado se emite contra ese hecho.
# --------------------------------------------------------------------------- #


async def _exigir_certificados(db: AsyncSession) -> None:
    if not await esquema_aprendizaje.hay_certificados(db):
        raise ServiceUnavailableError(
            "Los certificados todavía no están disponibles.",
            code="course_certificates_not_available",
        )


async def _certificado_de(
    db: AsyncSession, *, user_id: str, course_id: str
) -> CourseCertificate | None:
    if not await esquema_aprendizaje.hay_certificados(db):
        return None
    return await db.scalar(
        select(CourseCertificate).where(
            CourseCertificate.user_id == user_id,
            CourseCertificate.course_id == course_id,
        )
    )


def _a_certificado(fila: CourseCertificate) -> CertificadoRead:
    return CertificadoRead(
        public_id=fila.public_id,
        course_id=fila.course_id,
        course_title=fila.course_title,
        display_name=fila.display_name,
        author_name=fila.author_name,
        course_version=fila.course_version,
        completed_at=fila.completed_at,
        issued_at=fila.issued_at,
        status=fila.status,
        verify_url=certificados.direccion_de_verificacion(fila.public_id),
    )


@router.get("/courses/{course_id}/completion", response_model=FinalizacionRead)
async def estado_de_finalizacion(
    course_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FinalizacionRead:
    """Si este curso está terminado, y qué falta si no lo está.

    Se registra la fecha aquí también: quien abre esta pantalla después de
    aprobar la evaluación tiene el curso terminado desde ese momento, y no
    tiene por qué volver a tocar una lección para que quede anotado.
    """
    curso = await _curso_o_404(db, course_id)
    if not await _tiene_acceso(db, current_user.id, curso):
        raise ForbiddenError(
            "No tienes acceso a este curso.", code="course_access_required"
        )

    estado = await finalizacion.registrar(
        db, user_id=current_user.id, course_id=curso.id
    )
    await db.commit()
    certificado = await _certificado_de(
        db, user_id=current_user.id, course_id=curso.id
    )
    return FinalizacionRead(
        course_id=curso.id,
        course_title=curso.title,
        lessons_total=estado.lecciones_totales,
        lessons_completed=estado.lecciones_hechas,
        progress_percent=estado.porcentaje,
        quiz_required=estado.exige_evaluacion,
        quiz_best_score=estado.mejor_nota,
        quiz_passed=estado.evaluacion_aprobada,
        completed=estado.terminado,
        completed_at=estado.terminado_en,
        certificate_public_id=(
            certificado.public_id if certificado is not None else None
        ),
    )


@router.post(
    "/courses/{course_id}/certificate",
    response_model=CertificadoRead,
    status_code=status.HTTP_201_CREATED,
)
async def emitir_certificado(
    course_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CertificadoRead:
    """Emitir el certificado de un curso terminado.

    NO SE EMITE POR UNA AFIRMACIÓN DEL CLIENTE: se vuelve a calcular la
    finalización aquí. Y hace falta acceso vigente en el momento de emitir:
    quien devolvió el curso no se lleva un certificado de camino a la puerta.

    UNO POR PERSONA Y CURSO. La segunda llamada devuelve el que ya existe, y lo
    sostiene el índice único: dos toques a la vez no emiten dos.
    """
    await _exigir_certificados(db)
    curso = await _curso_o_404(db, course_id)
    if not await _tiene_acceso(db, current_user.id, curso):
        raise ForbiddenError(
            "Necesitas acceso vigente al curso para obtener el certificado.",
            code="certificate_access_required",
        )

    existente = await _certificado_de(
        db, user_id=current_user.id, course_id=curso.id
    )
    if existente is not None and existente.status == "valid":
        return _a_certificado(existente)

    estado = await finalizacion.registrar(
        db, user_id=current_user.id, course_id=curso.id
    )
    await db.commit()
    if not estado.terminado or estado.terminado_en is None:
        raise ValidationAppError(
            "Todavía no has terminado este curso.",
            code="certificate_course_not_completed",
            details={
                "lessons_total": estado.lecciones_totales,
                "lessons_completed": estado.lecciones_hechas,
                "quiz_required": estado.exige_evaluacion,
                "quiz_passed": estado.evaluacion_aprobada,
            },
        )

    perfil = await db.get(Profile, current_user.id)
    autor = await db.get(Profile, curso.author_id)
    version = await versiones.vigente(db, curso.id)

    # REVOCADO Y VUELTO A GANAR. Quien devolvió el curso, lo compró otra vez y
    # volvió a terminarlo tiene derecho al certificado; sin esto se quedaba con
    # el revocado para siempre, porque solo puede haber uno por persona y curso.
    # NO se pierde nada: la revocación y esta reposición quedan las dos en
    # auditoría.
    if existente is not None:
        await certificados.reponer(
            db, existente, actor_id=current_user.id, completado_en=estado.terminado_en
        )
        await db.commit()
        await db.refresh(existente)
        return _a_certificado(existente)

    fila = CourseCertificate(
        public_id=certificados.nuevo_codigo_publico(),
        user_id=current_user.id,
        course_id=curso.id,
        # Copia del momento de la emisión. Si el perfil no tiene nombre se usa
        # el usuario; lo que no se hace es dejarlo vacío ni inventarlo.
        display_name=certificados.nombre_para_el_certificado(perfil),
        course_title=curso.title,
        author_name=certificados.nombre_para_el_certificado(autor) if autor else "",
        course_version=version.version if version is not None else None,
        completed_at=estado.terminado_en,
    )
    db.add(fila)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        existente = await _certificado_de(
            db, user_id=current_user.id, course_id=curso.id
        )
        if existente is None:
            raise
        return _a_certificado(existente)

    await db.refresh(fila)
    return _a_certificado(fila)


@router.get("/me/certificates", response_model=list[CertificadoRead])
async def mis_certificados(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[CertificadoRead]:
    """Los míos, del más reciente al más viejo. Los revocados TAMBIÉN salen:
    desaparecer sin decir nada es peor que decir que no está vigente."""
    await _exigir_certificados(db)
    filas = await db.scalars(
        select(CourseCertificate)
        .where(CourseCertificate.user_id == current_user.id)
        .order_by(CourseCertificate.issued_at.desc(), CourseCertificate.id.desc())
    )
    return [_a_certificado(f) for f in filas]


@router.get("/certificates/{public_id}", response_model=VerificacionPublicaRead)
async def verificar_certificado(
    public_id: str,
    db: AsyncSession = Depends(get_db),
) -> VerificacionPublicaRead:
    """Verificación PÚBLICA. Sin sesión.

    NO SE PUEDE RECORRER: el código lo genera `secrets` y no es correlativo, así
    que no hay una lista que enumerar. Un código que no existe responde 404,
    igual que uno mal escrito: distinguirlos diría cuáles existen.

    Lo que sale es lo justo para verificar. Ni correo, ni identificador de
    usuario, ni orden, ni importe.
    """
    await _exigir_certificados(db)
    fila = await db.scalar(
        select(CourseCertificate).where(CourseCertificate.public_id == public_id.strip())
    )
    if fila is None:
        raise NotFoundError(
            "No encontramos ningún certificado con ese código.",
            code="certificate_not_found",
        )
    return VerificacionPublicaRead(
        public_id=fila.public_id,
        display_name=fila.display_name,
        course_title=fila.course_title,
        author_name=fila.author_name,
        course_version=fila.course_version,
        completed_at=fila.completed_at,
        issued_at=fila.issued_at,
        status=fila.status,
    )


@router.post("/admin/certificates/{public_id}/revoke", response_model=CertificadoRead)
async def revocar_certificado(
    public_id: str,
    payload: MotivoDeRevocacion,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CertificadoRead:
    """Revocar por fraude, error o invalidación documentada.

    REVOCAR NO BORRA: la fila se queda, con su motivo y su fecha, y la
    verificación pública dice que no está vigente. Y queda en auditoría: es una
    decisión sobre el logro de otra persona.
    """
    await _exigir_certificados(db)
    if not await is_admin(db, current_user.id):
        raise ForbiddenError("Solo administración puede revocar un certificado.")

    fila = await db.scalar(
        select(CourseCertificate).where(CourseCertificate.public_id == public_id.strip())
    )
    if fila is None:
        raise NotFoundError(
            "No encontramos ningún certificado con ese código.",
            code="certificate_not_found",
        )
    if fila.status == "revoked":
        return _a_certificado(fila)

    await certificados.revocar(
        db, fila, motivo=payload.reason.strip(), actor_id=current_user.id
    )
    await db.commit()
    await db.refresh(fila)
    return _a_certificado(fila)
