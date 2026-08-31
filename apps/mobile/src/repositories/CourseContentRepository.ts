import { signCourseUrls } from '@/services/storage';
import { supabase } from '@/services/supabase';

/**
 * Modulos y lecciones de un curso, contra Supabase (PostgREST).
 *
 * Los cursos se crean por la API FastAPI, pero su CONTENIDO no tenia camino:
 * la API solo expone lectura y las tablas no tenian politica de escritura. Se
 * abre por aqui, como ya se hizo con historias y testimonios, porque la API
 * desplegada se construye desde otra rama.
 *
 * Quien puede escribir lo decide la RLS de 0012_course_content.sql (autor del
 * curso o administracion), no esta capa.
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

  El contenido de un curso se escribe contra Supabase directamente (es la RLS de
  0012 la que decide quién puede), así que aquí no hay un backend que degrade
  por nosotros: si se manda `kind` a una base sin esa columna, PostgREST rechaza
  la fila ENTERA y la lección no se guarda. Perder una lección por un campo
  accesorio es exactamente lo que no puede pasar.

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

/**
 * Escribe `sort_order` = posición para toda la lista.
 *
 * Las escrituras van EN SERIE y no en paralelo a propósito: son pocas y así, si
 * una falla, se sabe cuántas se aplicaron. Un `Promise.all` que falla a la
 * mitad deja el temario en un orden que nadie pidió y sin forma de saber cuál.
 */
async function ordenar(tabla: 'course_modules' | 'course_lessons', ids: string[]): Promise<void> {
  const db = client();
  for (let posicion = 0; posicion < ids.length; posicion += 1) {
    const { error } = await db
      .from(tabla)
      .update({ sort_order: posicion })
      .eq('id', ids[posicion]);
    if (error) throw new Error(error.message);
  }
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

  async setHighlights(courseId: string, highlights: string[]): Promise<void> {
    const { error } = await client()
      .from('courses')
      .update({ highlights })
      .eq('id', courseId);
    if (error) throw new Error(error.message);
  },

  /** ¿El curso esta anunciado pero sin contenido disponible? */
  async getComingSoon(courseId: string): Promise<boolean> {
    const { data, error } = await client()
      .from('courses')
      .select('coming_soon')
      .eq('id', courseId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data?.coming_soon as boolean | null) ?? false;
  },

  async setComingSoon(courseId: string, comingSoon: boolean): Promise<void> {
    const { error } = await client()
      .from('courses')
      .update({ coming_soon: comingSoon })
      .eq('id', courseId);
    if (error) throw new Error(error.message);
  },

  /**
   * Elimina el curso entero. Modulos, lecciones y recursos caen en cascada
   * (`on delete cascade`). La RLS (courses_write) solo lo permite al autor o a
   * la administracion.
   *
   * OJO: un curso con compras tiene `on delete restrict` en purchases, asi que
   * la base lo rechazara si alguien ya lo compro. Es intencionado: no se borra
   * algo por lo que alguien pago.
   */
  async removeCourse(courseId: string): Promise<void> {
    const { error } = await client().from('courses').delete().eq('id', courseId);
    if (error) throw new Error(error.message);
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

  async createModule(
    courseId: string,
    title: string,
    sortOrder: number,
    description = '',
  ): Promise<void> {
    const fila: Record<string, unknown> = {
      course_id: courseId,
      title,
      sort_order: sortOrder,
    };
    // La descripción solo viaja si hay dónde guardarla: sin la 0034, mandarla
    // haría que PostgREST rechazara el módulo entero.
    if (description && (await soportaContenidoV2())) fila.description = description;
    const { error } = await client().from('course_modules').insert(fila);
    if (error) throw new Error(error.message);
  },

  async updateModule(
    moduleId: string,
    cambios: { title?: string; description?: string },
  ): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (cambios.title !== undefined) patch.title = cambios.title;
    if (cambios.description !== undefined && (await soportaContenidoV2())) {
      patch.description = cambios.description;
    }
    if (Object.keys(patch).length === 0) return;
    const { error } = await client().from('course_modules').update(patch).eq('id', moduleId);
    if (error) throw new Error(error.message);
  },

  /** Se mantiene por los sitios que solo cambian el título. */
  async renameModule(moduleId: string, title: string): Promise<void> {
    return CourseContentRepository.updateModule(moduleId, { title });
  },

  /**
   * Deja los módulos EN ESTE orden. `ids` es la lista completa y definitiva.
   *
   * Se escribe el orden de todos y no solo el del que se movió: `sort_order`
   * empatados dejan el temario a merced de cómo devuelva las filas la base, que
   * es lo mismo que no tener orden.
   */
  async reorderModules(ids: string[]): Promise<void> {
    await ordenar('course_modules', ids);
  },

  async reorderLessons(ids: string[]): Promise<void> {
    await ordenar('course_lessons', ids);
  },

  /** Borrar un modulo arrastra sus lecciones (cascada en la base). */
  async removeModule(moduleId: string): Promise<void> {
    const { error } = await client().from('course_modules').delete().eq('id', moduleId);
    if (error) throw new Error(error.message);
  },

  async createLesson(input: {
    moduleId: string;
    title: string;
    body?: string;
    mediaPath?: string | null;
    durationSeconds?: number;
    sortOrder: number;
    kind?: LessonKind;
    isPreview?: boolean;
  }): Promise<void> {
    const fila: Record<string, unknown> = {
      module_id: input.moduleId,
      title: input.title,
      body: input.body ?? '',
      media_path: input.mediaPath ?? null,
      duration_seconds: input.durationSeconds ?? 0,
      sort_order: input.sortOrder,
    };
    if (await soportaContenidoV2()) {
      fila.kind = input.kind ?? 'video';
      fila.is_preview = input.isPreview ?? false;
    }
    const { error } = await client().from('course_lessons').insert(fila);
    if (error) throw new Error(error.message);
  },

  async updateLesson(
    lessonId: string,
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
    if (changes.mediaPath !== undefined) patch.media_path = changes.mediaPath;
    if (changes.durationSeconds !== undefined) patch.duration_seconds = changes.durationSeconds;
    if (changes.kind !== undefined || changes.isPreview !== undefined) {
      if (await soportaContenidoV2()) {
        if (changes.kind !== undefined) patch.kind = changes.kind;
        if (changes.isPreview !== undefined) patch.is_preview = changes.isPreview;
      }
    }
    if (Object.keys(patch).length === 0) return;
    const { error } = await client().from('course_lessons').update(patch).eq('id', lessonId);
    if (error) throw new Error(error.message);
  },

  async removeLesson(lessonId: string): Promise<void> {
    const { error } = await client().from('course_lessons').delete().eq('id', lessonId);
    if (error) throw new Error(error.message);
  },
};
