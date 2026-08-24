"""Endpoints de aprendizaje: detalle del curso, acceso, progreso y biblioteca.

QUIEN DECIDE EL ACCESO. La verdad vive en la base de datos, en
`public.has_course_access()` (migracion 0016): es la que protege los ARCHIVOS,
y funciona aunque alguien llame al almacenamiento saltandose esta aplicacion.
Lo que hay aqui es la misma regla escrita para que la interfaz sepa que ensenar,
mas las comprobaciones de escritura, que si tienen que estar en el servidor.

Las dos tienen que decir lo mismo. `tests/test_muro_de_pago.py` las compara.
"""

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenError, NotFoundError
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.catalog.models import Course
from app.modules.learning import progreso
from app.modules.learning.models import (
    CourseLesson,
    CourseModule,
    LessonProgress,
    Purchase,
)
from app.modules.learning.schemas import (
    CourseDetailRead,
    LessonDetailRead,
    LessonProgressInput,
    LessonProgressRead,
    LessonRead,
    ModuleRead,
    MyCourseRead,
)
from app.modules.recommendations import temas_de_curso
from app.modules.recommendations.signals import registrar_senal
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.permissions import is_admin

router = APIRouter(prefix="/learning", tags=["learning"])


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
    """Las mismas cuatro vias que `has_course_access()` en la base de datos.

    Gratuito, autor, administracion o compra PAGADA. `pending` no cuenta: un
    cobro iniciado y no completado no es un cobro.
    """
    if course.price_minor <= 0:
        return True
    if uid is None:
        return False
    if course.author_id == uid:
        return True
    if await is_admin(db, uid):
        return True
    return await _is_enrolled(db, uid, course.id)


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

    module_reads: list[ModuleRead] = []
    lessons_total = 0
    lessons_completed = 0
    for modulo, lecciones in temario:
        lesson_reads: list[LessonRead] = []
        for leccion in lecciones:
            avance = progreso_por_leccion.get(leccion.id)
            hecha = bool(avance and avance.completed)
            lessons_total += 1
            if hecha:
                lessons_completed += 1
            lesson_reads.append(
                LessonRead(
                    id=leccion.id,
                    title=leccion.title,
                    duration_seconds=leccion.duration_seconds,
                    sort_order=leccion.sort_order,
                    completed=hecha,
                    media_path=leccion.media_path,
                    progress_seconds=avance.progress_seconds if avance else 0,
                )
            )
        module_reads.append(
            ModuleRead(
                id=modulo.id,
                title=modulo.title,
                sort_order=modulo.sort_order,
                lessons=lesson_reads,
            )
        )

    temas = await temas_de_curso.leer(db, [course.id])
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
        has_access=await _tiene_acceso(db, uid, course),
        can_manage=await _puede_gestionar(db, uid, course),
        progress_percent=progreso.porcentaje(lessons_completed, lessons_total),
        lessons_total=lessons_total,
        lessons_completed=lessons_completed,
        modules=module_reads,
    )


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

    accesos = list(
        await db.scalars(
            select(Purchase.course_id).where(
                Purchase.user_id == uid, Purchase.status == "paid"
            )
        )
    )
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

    hechas = set(
        await db.scalars(
            select(LessonProgress.lesson_id).where(
                LessonProgress.user_id == uid,
                LessonProgress.completed.is_(True),
                LessonProgress.lesson_id.in_([f[1] for f in filas] or [""]),
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
    es el VIDEO, y de eso se encarga la RLS del almacenamiento: sin ella no se
    puede firmar la URL, diga lo que diga este endpoint.
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

    return LessonDetailRead(
        id=leccion.id,
        title=leccion.title,
        duration_seconds=leccion.duration_seconds,
        sort_order=leccion.sort_order,
        completed=bool(avance and avance.completed),
        media_path=leccion.media_path,
        progress_seconds=avance.progress_seconds if avance else 0,
        body=leccion.body or "",
        can_manage=await _puede_gestionar(db, uid, curso),
        has_access=await _tiene_acceso(db, uid, curso),
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
    hechas = set(
        await db.scalars(
            select(LessonProgress.lesson_id).where(
                LessonProgress.user_id == uid,
                LessonProgress.completed.is_(True),
                LessonProgress.lesson_id.in_(lecciones or [""]),
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
