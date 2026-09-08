import { LearningRepository } from '@/repositories/LearningRepository';
import { API_V1, ApiError, apiRequest } from '@/services/api';
import { signCourseUrls } from '@/services/storage';
import { supabase } from '@/services/supabase';

/**
 * Modulos y lecciones de un curso.
 *
 * ## Escribir el temario va POR LA API. Leerlo, todavia no.
 *
 * Todo esto se escribia contra PostgREST con la clave anonima porque la API no
 * ofrecia otro camino. La RLS de 0012 decidia quien podia, asi que no era un
 * agujero de permisos: era un agujero de RASTRO. Un autor reescribia el temario
 * de un curso YA VENDIDO y no quedaba ni una linea diciendo que habia pasado, y
 * ni siquiera se sabia sobre que version se habia editado. Los ocho endpoints
 * de `catalog/router.py` cierran eso: cada escritura deja su nota de auditoria
 * con el estado del curso y su version vigente.
 *
 * LAS LECTURAS SIGUEN POR SUPABASE, y no por descuido: `listContent` compone el
 * temario entero con sus URLs firmadas en dos consultas, y no hay endpoint que
 * devuelva eso. Mientras no lo haya, cambiarlas seria empeorar la pantalla para
 * que el fichero quedara uniforme.
 *
 * TAMPOCO se han movido las escrituras que NO son temario: los recursos
 * descargables (`addResource`, `removeResource`) y `removeCourse`, que no
 * tienen endpoint ninguno, y `setHighlights` y `setComingSoon`, que son campos
 * de la FICHA del curso. Cada una dice en su sitio por que sigue ahi.
 */

/** Los tipos de lección que la aplicación sabe pintar (migración 0034). */
export type LessonKind = 'video' | 'text';

export type CourseLesson = {
  id: string;
  moduleId: string;
  title: string;
  body: string;
  /** Ruta en `course-media`; hay que firmarla para reproducir. */
  mediaPath: string | null;
  /** URL firmada, ya resuelta al listar. */
  mediaUrl?: string;
  durationSeconds: number;
  sortOrder: number;
  /**
   * `video` o `text`. Sin la 0034 todas son de vídeo, que es lo que hay hoy.
   *
   * NO se ofrecen cuestionarios ni directos aunque la columna pueda crecer: una
   * lección de un tipo que ninguna pantalla sabe abrir es una lección rota.
   */
  kind: LessonKind;
  /** Lección abierta sin comprar. Sin la 0034 ninguna lo es. */
  isPreview: boolean;
};

export type CourseModule = {
  id: string;
  courseId: string;
  title: string;
  /** De qué va el bloque (0034). Vacía mientras la migración no esté puesta. */
  description: string;
  sortOrder: number;
  lessons: CourseLesson[];
};

/** Documento descargable de una leccion (PDF, plantilla...). */
export type LessonResourceFile = {
  id: string;
  lessonId: string;
  title: string;
  storagePath: string;
  /** URL firmada, ya resuelta al listar. */
  url?: string;
  mimeType: string | null;
  sizeBytes: number | null;
  sortOrder: number;
};

type ResourceRow = {
  id: string;
  lesson_id: string;
  title: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  sort_order: number;
};

type ModuleRow = {
  id: string;
  course_id: string;
  title: string;
  sort_order: number;
  description?: string | null;
};
type LessonRow = {
  id: string;
  module_id: string;
  title: string;
  body: string | null;
  media_path: string | null;
  duration_seconds: number;
  sort_order: number;
  kind?: string | null;
  is_preview?: boolean | null;
};

function client() {
  if (!supabase) throw new Error('Supabase no esta configurado.');
  return supabase;
}

/*
  ¿SABE ESTA BASE DE LA 0034?

  El temario se LEE contra Supabase directamente, así que en la lectura no hay
  un backend que degrade por nosotros: si se le pide `kind` a una base sin esa
  columna, PostgREST no devuelve la fila sin ese campo, devuelve un error y
  ninguna fila. El temario entero desaparecería por un campo accesorio.

  ESCRIBIR YA NO NECESITA PREGUNTAR: las ocho operaciones van por la API, que
  acepta `kind`, `is_preview` y `description` y los ignora si la migración no
  está (ver `catalog/cursos_v2.py`). Lo que queda de esta comprobación es la
  lectura y una decisión de interfaz: el asistente no ofrece un interruptor de
  «muestra gratuita» que la base de hoy no vaya a recordar.

  Se pregunta UNA vez por sesión y se recuerda la respuesta, igual que hace el
  backend en `catalog/esquema.py`. Y solo se recuerda cuando la respuesta es
  concluyente: un fallo de red no puede dejar la aplicación creyendo para
  siempre que la migración no está.
*/
let soporteV2: boolean | null = null;
let preguntaEnCurso: Promise<boolean> | null = null;

/** La columna no existe. Es el código de PostgreSQL para «undefined_column». */
function esColumnaQueNoExiste(error: { code?: string; message?: string }): boolean {
  return error.code === '42703' || /column .* does not exist/i.test(error.message ?? '');
}

async function preguntarPorV2(): Promise<boolean> {
  const { error } = await client()
    .from('course_lessons')
    .select('id, kind, is_preview')
    .limit(1);
  if (!error) {
    soporteV2 = true;
    return true;
  }
  if (esColumnaQueNoExiste(error)) {
    soporteV2 = false;
    return false;
  }
  // Ni sí ni no: se degrada por esta vez y se volverá a preguntar.
  throw new Error(error.message);
}

/**
 * Si esta base admite la ficha de contenido de la 0034.
 *
 * La usa el asistente para no ofrecer lo que no se puede guardar: sin la
 * migración no aparecen ni el tipo de lección ni la muestra gratuita, en vez de
 * aparecer y fallar al guardar.
 */
export async function soportaContenidoV2(): Promise<boolean> {
  if (soporteV2 !== null) return soporteV2;
  if (!preguntaEnCurso) {
    preguntaEnCurso = preguntarPorV2().finally(() => {
      preguntaEnCurso = null;
    });
  }
  try {
    return await preguntaEnCurso;
  } catch {
    return false;
  }
}

/** Solo para las pruebas: que una no herede lo que averiguó la anterior. */
export function olvidarSoporteV2(): void {
  soporteV2 = null;
  preguntaEnCurso = null;
}

function aTipo(valor: string | null | undefined): LessonKind {
  return valor === 'text' ? 'text' : 'video';
}

/** Donde vive el temario en la API. Las ocho escrituras cuelgan de aquí. */
const CURSOS = `${API_V1}/catalog/courses`;

/**
 * El temario cambió por debajo mientras alguien lo editaba.
 *
 * ES UN TIPO PROPIO Y NO EL `ApiError` CRUDO porque quien lo recibe tiene que
 * poder distinguirlo sin leer el texto del mensaje: ante esto NO se reintenta
 * —guardar otra vez pisaría lo que acaba de hacer el otro— sino que se vuelve a
 * cargar el temario y se dice qué pasó. Comparar cadenas para decidirlo se
 * rompe en cuanto el mensaje se traduce.
 *
 * El servidor lo devuelve como 409 `course_version_mismatch` cuando la petición
 * llevaba `If-Match` con una huella que ya no es la vigente.
 *
 * HOY LA APP NO MANDA `If-Match`, y no por dejadez: NINGÚN endpoint entrega el
 * `content_hash` de la versión vigente. `GET /catalog/courses/{id}/version`
 * devuelve número, estado y fotografía, pero no la huella, así que no hay de
 * dónde sacar lo que habría que mandar, y calcularla aquí sería reescribir en
 * la app la firma que hace `versiones.py`. La traducción se deja puesta porque
 * el día que el backend exponga la huella esto tiene que estar ya resuelto, no
 * descubrirse con el primer autor que pierda su trabajo.
 */
export class ContenidoDelCursoCambiado extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ContenidoDelCursoCambiado';
  }
}

/*
  LA CLAVE DE IDEMPOTENCIA, Y POR QUÉ LA TRAE QUIEN LLAMA.

  El servidor DERIVA el identificador de la fila a partir de esta clave (ver
  `catalog/contenido.py`), así que dos peticiones con la misma clave crean UN
  módulo: la segunda choca contra la clave primaria y recibe el que ya estaba.
  Eso es lo que convierte un doble toque —o un reintento tras un corte de red
  que quizá sí llegó— en una sola alta, y lo garantiza la base, no un `if`.

  NO SE GENERA DENTRO DEL REPOSITORIO. Una clave nueva en cada llamada no
  protegería de nada: sería un identificador distinto por petición, que es
  exactamente el problema. La clave pertenece al INTENTO DE GUARDADO, y quien
  sabe cuándo empieza y cuándo acaba un intento es la pantalla; por eso la
  guarda en una referencia y la reusa mientras la hoja siga abierta.

  Y TAMPOCO SE DERIVA DEL CONTENIDO (curso + título): dos módulos que alguien
  quiere llamar igual —«Práctica», dos veces— serían entonces el mismo módulo, y
  el segundo no se crearía nunca.
*/
let creaciones = 0;

/** Una clave para un intento de creación. Se reusa mientras sea el mismo. */
export function nuevaClaveDeCreacion(): string {
  creaciones += 1;
  // Hora, contador y azar juntos: la hora sola repite si dos altas caen en el
  // mismo milisegundo, y el contador solo repite entre dos arranques de la app.
  return `${Date.now().toString(36)}-${creaciones}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Lo que hace falta para escribir en una lección concreta. */
export type ReferenciaDeLeccion = {
  courseId: string;
  /**
   * Puede faltar: `GET /learning/lessons/{id}` devuelve `module_title` pero no
   * `module_id`, así que la pantalla de la lección no lo tiene. Ver
   * `moduloDeLaLeccion`.
   */
  moduleId?: string;
  lessonId: string;
};

/**
 * Una escritura del temario, con el conflicto de versión ya traducido.
 *
 * Pasa por aquí TODO lo que escribe módulos y lecciones para que la traducción
 * del 409 exista en un solo sitio: repartida por las ocho operaciones, la
 * siguiente que se añada se olvidaría de hacerla.
 */
async function escribirTemario(
  ruta: string,
  opciones: { method: string; cuerpo?: unknown; claveDeIdempotencia?: string },
): Promise<void> {
  try {
    await apiRequest<void>(ruta, {
      method: opciones.method,
      ...(opciones.cuerpo !== undefined ? { body: JSON.stringify(opciones.cuerpo) } : {}),
      ...(opciones.claveDeIdempotencia
        ? { headers: { 'Idempotency-Key': opciones.claveDeIdempotencia } }
        : {}),
    });
  } catch (fallo) {
    if (fallo instanceof ApiError && fallo.code === 'course_version_mismatch') {
      throw new ContenidoDelCursoCambiado(fallo.message);
    }
    throw fallo;
  }
}

/**
 * A qué módulo pertenece una lección.
 *
 * Existe por UN caso: la pantalla de la lección llega con el curso y la lección
 * y nada más, porque el detalle de `learning` no devuelve `module_id`. Los dos
 * editores sí lo traen en el propio modelo y no pagan esta consulta.
 *
 * Es una LECTURA por PostgREST, de las que se quedan mientras la API no ofrezca
 * el temario completo.
 */
async function moduloDeLaLeccion(lessonId: string): Promise<string> {
  const { data, error } = await client()
    .from('course_lessons')
    .select('module_id')
    .eq('id', lessonId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const moduleId = (data as { module_id?: string } | null)?.module_id;
  if (!moduleId) throw new Error('Lección no encontrada.');
  return moduleId;
}

/** La ruta de una lección, resolviendo el módulo solo cuando no viene dado. */
async function rutaDeLeccion(ref: ReferenciaDeLeccion): Promise<string> {
  const moduleId = ref.moduleId ?? (await moduloDeLaLeccion(ref.lessonId));
  return `${CURSOS}/${ref.courseId}/modules/${moduleId}/lessons/${ref.lessonId}`;
}

export const CourseContentRepository = {
  /** Modulos de un curso con sus lecciones, en orden y con las URLs firmadas. */
  async listContent(courseId: string): Promise<CourseModule[]> {
    const db = client();
    // Se pregunta ANTES de nombrar columnas: pedir `kind` a una base sin la
    // 0034 no devuelve la fila sin ese campo, devuelve un error y ninguna fila.
    const v2 = await soportaContenidoV2();

    const { data: moduleRows, error: modulesError } = await db
      .from('course_modules')
      .select(v2 ? 'id, course_id, title, sort_order, description' : 'id, course_id, title, sort_order')
      .eq('course_id', courseId)
      .order('sort_order', { ascending: true });
    if (modulesError) throw new Error(modulesError.message);

    const modules: CourseModule[] = ((moduleRows ?? []) as unknown as ModuleRow[]).map((row) => ({
      id: row.id,
      courseId: row.course_id,
      title: row.title,
      description: row.description ?? '',
      sortOrder: row.sort_order,
      lessons: [],
    }));
    if (modules.length === 0) return modules;

    const camposDeLeccion = 'id, module_id, title, body, media_path, duration_seconds, sort_order';
    const { data: lessonRows, error: lessonsError } = await db
      .from('course_lessons')
      .select(v2 ? `${camposDeLeccion}, kind, is_preview` : camposDeLeccion)
      .in('module_id', modules.map((m) => m.id))
      .order('sort_order', { ascending: true });
    if (lessonsError) throw new Error(lessonsError.message);

    const byModule = new Map(modules.map((m) => [m.id, m]));
    const lessons: CourseLesson[] = ((lessonRows ?? []) as unknown as LessonRow[]).map((row) => ({
      id: row.id,
      moduleId: row.module_id,
      title: row.title,
      body: row.body ?? '',
      mediaPath: row.media_path,
      durationSeconds: row.duration_seconds,
      sortOrder: row.sort_order,
      kind: aTipo(row.kind),
      isPreview: row.is_preview === true,
    }));

    // Una sola firma en lote para todos los videos del curso.
    const paths = lessons.map((l) => l.mediaPath).filter((p): p is string => !!p);
    if (paths.length > 0) {
      const urls = await signCourseUrls(paths);
      lessons.forEach((lesson) => {
        if (lesson.mediaPath) lesson.mediaUrl = urls[lesson.mediaPath];
      });
    }

    lessons.forEach((lesson) => byModule.get(lesson.moduleId)?.lessons.push(lesson));
    return modules;
  },

  /**
   * Puntos de "Lo que vas a desarrollar".
   *
   * Se leen de Supabase y no de la API porque el endpoint desplegado no
   * devuelve la columna (se anadio en 0013, despues de su ultimo despliegue).
   */
  async getHighlights(courseId: string): Promise<string[]> {
    const { data, error } = await client()
      .from('courses')
      .select('highlights')
      .eq('id', courseId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data?.highlights as string[] | null) ?? [];
  },

  /**
   * SIGUE CONTRA SUPABASE, y queda apuntado como lo que es: pendiente.
   *
   * Esto NO es temario —es la ficha del curso, `courses.highlights`— así que no
   * lo cubre ninguno de los ocho endpoints de módulos y lecciones. Sí lo
   * aceptaría `PATCH /catalog/courses/{id}`, que además deja rastro; moverlo es
   * un cambio de la ficha, con su propia pantalla y sus propias pruebas, y
   * meterlo aquí sería arrastrarlo dentro de otra cosa.
   */
  async setHighlights(courseId: string, highlights: string[]): Promise<void> {
    await LearningRepository.updateCourse(courseId, { highlights });
  },

  /**
   * Marca (o desmarca) el curso como anunciado sin contenido disponible.
   *
   * NO HAY LECTOR AQUÍ, y es a propósito. Lo había —`getComingSoon`, contra
   * Supabase— mientras la ficha del curso leía el MISMO dato de la API. Dos
   * fuentes para lo mismo son dos respuestas posibles: la etiqueta de arriba
   * decía una cosa y el bloque del temario otra. Se lee del detalle del curso,
   * que es de donde viene todo lo demás de esa pantalla.
   *
   * ESCRIBIR SIGUE AQUÍ por lo mismo que `setHighlights`: `coming_soon` es un
   * campo de la ficha del curso, no del temario, y no lo toca ninguno de los
   * ocho endpoints que se acaban de migrar.
   */
  async setComingSoon(courseId: string, comingSoon: boolean): Promise<void> {
    await LearningRepository.updateCourse(courseId, { comingSoon });
  },

  /**
   * Elimina el curso entero. Modulos, lecciones y recursos caen en cascada
   * (`on delete cascade`). La RLS (courses_write) solo lo permite al autor o a
   * la administracion.
   *
   * OJO: un curso con compras tiene `on delete restrict` en purchases, asi que
   * la base lo rechazara si alguien ya lo compro. Es intencionado: no se borra
   * algo por lo que alguien pago.
   *
   * SIGUE CONTRA SUPABASE porque NO HAY endpoint: el catálogo no expone
   * `DELETE /courses/{id}`. Es, además, la escritura que más falta le hace un
   * rastro, así que queda apuntada aquí y no en un documento aparte.
   */
  async removeCourse(courseId: string): Promise<void> {
    await LearningRepository.deleteCourse(courseId);
  },

  /** Material descargable de una leccion, con las URLs ya firmadas. */
  async listResources(lessonId: string): Promise<LessonResourceFile[]> {
    const { data, error } = await client()
      .from('course_lesson_resources')
      .select('id, lesson_id, title, storage_path, mime_type, size_bytes, sort_order')
      .eq('lesson_id', lessonId)
      .order('sort_order', { ascending: true });
    if (error) throw new Error(error.message);

    const items: LessonResourceFile[] = ((data ?? []) as ResourceRow[]).map((row) => ({
      id: row.id,
      lessonId: row.lesson_id,
      title: row.title,
      storagePath: row.storage_path,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      sortOrder: row.sort_order,
    }));
    /*
      LA LISTA NO SE FIRMA. Se firma lo que se abre.

      Antes se pedia una firma para CADA documento de la leccion nada mas
      entrar, aunque nadie fuera a abrir ninguno. En una leccion con veinte
      recursos eso son veinte firmas —y su ida y vuelta al servidor— compitiendo
      por la misma conexion justo en el momento en que lo unico que importa es
      que arranque el video. Y ademas caducan: una firma emitida al entrar puede
      estar muerta cuando por fin se pulsa.

      Para PINTAR la fila no hace falta la URL: el titulo, el tipo y el tamaño
      vienen en la propia fila. La firma se pide al pulsar (`firmarRecurso`),
      que es cuando de verdad se necesita y cuando esta recien emitida.
    */
    return items;
  },

  /** URL firmada de UN documento, en el momento de abrirlo. */
  async firmarRecurso(storagePath: string): Promise<string | null> {
    const urls = await signCourseUrls([storagePath]);
    return urls[storagePath] ?? null;
  },

  /*
    LOS RECURSOS SE QUEDAN CONTRA SUPABASE, y no hay decisión que tomar: la API
    no conoce `course_lesson_resources`. No hay endpoint que crear ni borrar un
    documento de una lección, así que migrarlos hoy sería inventárselos.
  */
  async addResource(input: {
    lessonId: string;
    title: string;
    storagePath: string;
    mimeType?: string | null;
    sizeBytes?: number | null;
    sortOrder: number;
  }): Promise<void> {
    const { error } = await client().from('course_lesson_resources').insert({
      lesson_id: input.lessonId,
      title: input.title,
      storage_path: input.storagePath,
      mime_type: input.mimeType ?? null,
      size_bytes: input.sizeBytes ?? null,
      sort_order: input.sortOrder,
    });
    if (error) throw new Error(error.message);
  },

  async removeResource(id: string): Promise<void> {
    const { error } = await client().from('course_lesson_resources').delete().eq('id', id);
    if (error) throw new Error(error.message);
  },

  /*
    LAS ALTAS YA NO ELIGEN POSICIÓN, y por eso desapareció `sortOrder`.

    Lo elegía el cliente contando lo que tenía en pantalla, y dos altas seguidas
    —o dos personas a la vez— proponían el MISMO número: dos elementos con el
    mismo `sort_order` dejan el temario a merced de cómo devuelva las filas la
    base, y el alumno ve las lecciones bailar entre dos cargas de la misma
    pantalla. Ahora se añade siempre al final y el orden se cambia en un solo
    sitio, `reorder`, que reescribe la lista entera.

    Las dos pantallas pasaban justamente «cuántos hay», que es el final: no se
    pierde nada al quitarlo.
  */

  /** Añade un módulo AL FINAL del temario. */
  async createModule(input: {
    courseId: string;
    title: string;
    description?: string;
    /** Ver `nuevaClaveDeCreacion`. Obligatoria: sin ella dos toques, dos módulos. */
    claveDeIdempotencia: string;
  }): Promise<void> {
    await escribirTemario(`${CURSOS}/${input.courseId}/modules`, {
      method: 'POST',
      // La descripción viaja SIEMPRE. Antes había que preguntar si la 0034
      // estaba puesta, porque nombrarle a PostgREST una columna que no existe
      // hace que rechace la fila entera y se pierda el módulo; ahora degrada el
      // servidor, que la acepta y no la guarda si no tiene dónde.
      cuerpo: { title: input.title, description: input.description ?? '' },
      claveDeIdempotencia: input.claveDeIdempotencia,
    });
  },

  /** Edita un módulo. Lo que no viaja no se toca. */
  async updateModule(
    courseId: string,
    moduleId: string,
    cambios: { title?: string; description?: string },
  ): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (cambios.title !== undefined) patch.title = cambios.title;
    if (cambios.description !== undefined) patch.description = cambios.description;
    // Un PATCH sin campos no es una edición: se ahorra el viaje y, sobre todo,
    // la línea de auditoría que diría que alguien tocó algo sin tocarlo.
    if (Object.keys(patch).length === 0) return;
    await escribirTemario(`${CURSOS}/${courseId}/modules/${moduleId}`, {
      method: 'PATCH',
      cuerpo: patch,
    });
  },

  /** Se mantiene por los sitios que solo cambian el título. */
  async renameModule(courseId: string, moduleId: string, title: string): Promise<void> {
    return CourseContentRepository.updateModule(courseId, moduleId, { title });
  },

  /**
   * Deja los módulos EN ESTE orden. `ids` es la lista completa y definitiva.
   *
   * UNA sola petición donde antes había una por módulo. No es solo ahorro: el
   * servidor rechaza una lista incompleta o con intrusos ANTES de escribir
   * nada, mientras que el bucle podía aplicar la mitad y fallar, y entonces el
   * temario quedaba en un orden que no había pedido nadie.
   */
  async reorderModules(courseId: string, ids: string[]): Promise<void> {
    await escribirTemario(`${CURSOS}/${courseId}/modules/reorder`, {
      method: 'POST',
      cuerpo: { ids },
    });
  },

  /** El orden se reescribe DENTRO de un módulo: mover de módulo es otra cosa. */
  async reorderLessons(courseId: string, moduleId: string, ids: string[]): Promise<void> {
    await escribirTemario(`${CURSOS}/${courseId}/modules/${moduleId}/lessons/reorder`, {
      method: 'POST',
      cuerpo: { ids },
    });
  },

  /** Borrar un modulo arrastra sus lecciones (cascada en la base). */
  async removeModule(courseId: string, moduleId: string): Promise<void> {
    await escribirTemario(`${CURSOS}/${courseId}/modules/${moduleId}`, { method: 'DELETE' });
  },

  /** Añade una lección AL FINAL del módulo. */
  async createLesson(input: {
    courseId: string;
    moduleId: string;
    title: string;
    body?: string;
    mediaPath?: string | null;
    durationSeconds?: number;
    kind?: LessonKind;
    isPreview?: boolean;
    /** Ver `nuevaClaveDeCreacion`. Obligatoria por el mismo motivo. */
    claveDeIdempotencia: string;
  }): Promise<void> {
    await escribirTemario(`${CURSOS}/${input.courseId}/modules/${input.moduleId}/lessons`, {
      method: 'POST',
      cuerpo: {
        title: input.title,
        body: input.body ?? '',
        media_path: input.mediaPath ?? null,
        duration_seconds: input.durationSeconds ?? 0,
        // `kind` e `is_preview` viajan siempre por lo mismo que la descripción:
        // sin la 0034 los ignora el servidor en vez de perderse la lección.
        kind: input.kind ?? 'video',
        is_preview: input.isPreview ?? false,
      },
      claveDeIdempotencia: input.claveDeIdempotencia,
    });
  },

  async updateLesson(
    ref: ReferenciaDeLeccion,
    changes: {
      title?: string;
      body?: string;
      mediaPath?: string | null;
      durationSeconds?: number;
      kind?: LessonKind;
      isPreview?: boolean;
    },
  ): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (changes.title !== undefined) patch.title = changes.title;
    if (changes.body !== undefined) patch.body = changes.body;
    // `mediaPath: null` SÍ borra el vídeo: es la única forma de quitarlo, y por
    // eso se mira si el campo se envió y no si vale algo.
    if (changes.mediaPath !== undefined) patch.media_path = changes.mediaPath;
    if (changes.durationSeconds !== undefined) patch.duration_seconds = changes.durationSeconds;
    if (changes.kind !== undefined) patch.kind = changes.kind;
    if (changes.isPreview !== undefined) patch.is_preview = changes.isPreview;
    if (Object.keys(patch).length === 0) return;
    await escribirTemario(await rutaDeLeccion(ref), { method: 'PATCH', cuerpo: patch });
  },

  async removeLesson(ref: ReferenciaDeLeccion): Promise<void> {
    await escribirTemario(await rutaDeLeccion(ref), { method: 'DELETE' });
  },
};
