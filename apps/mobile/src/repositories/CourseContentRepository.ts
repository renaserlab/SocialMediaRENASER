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
};

export type CourseModule = {
  id: string;
  courseId: string;
  title: string;
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

type ModuleRow = { id: string; course_id: string; title: string; sort_order: number };
type LessonRow = {
  id: string;
  module_id: string;
  title: string;
  body: string | null;
  media_path: string | null;
  duration_seconds: number;
  sort_order: number;
};

function client() {
  if (!supabase) throw new Error('Supabase no esta configurado.');
  return supabase;
}

export const CourseContentRepository = {
  /** Modulos de un curso con sus lecciones, en orden y con las URLs firmadas. */
  async listContent(courseId: string): Promise<CourseModule[]> {
    const db = client();

    const { data: moduleRows, error: modulesError } = await db
      .from('course_modules')
      .select('id, course_id, title, sort_order')
      .eq('course_id', courseId)
      .order('sort_order', { ascending: true });
    if (modulesError) throw new Error(modulesError.message);

    const modules: CourseModule[] = ((moduleRows ?? []) as ModuleRow[]).map((row) => ({
      id: row.id,
      courseId: row.course_id,
      title: row.title,
      sortOrder: row.sort_order,
      lessons: [],
    }));
    if (modules.length === 0) return modules;

    const { data: lessonRows, error: lessonsError } = await db
      .from('course_lessons')
      .select('id, module_id, title, body, media_path, duration_seconds, sort_order')
      .in('module_id', modules.map((m) => m.id))
      .order('sort_order', { ascending: true });
    if (lessonsError) throw new Error(lessonsError.message);

    const byModule = new Map(modules.map((m) => [m.id, m]));
    const lessons: CourseLesson[] = ((lessonRows ?? []) as LessonRow[]).map((row) => ({
      id: row.id,
      moduleId: row.module_id,
      title: row.title,
      body: row.body ?? '',
      mediaPath: row.media_path,
      durationSeconds: row.duration_seconds,
      sortOrder: row.sort_order,
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
    if (items.length === 0) return items;

    const urls = await signCourseUrls(items.map((i) => i.storagePath));
    items.forEach((item) => {
      item.url = urls[item.storagePath];
    });
    return items;
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

  async createModule(courseId: string, title: string, sortOrder: number): Promise<void> {
    const { error } = await client()
      .from('course_modules')
      .insert({ course_id: courseId, title, sort_order: sortOrder });
    if (error) throw new Error(error.message);
  },

  async renameModule(moduleId: string, title: string): Promise<void> {
    const { error } = await client().from('course_modules').update({ title }).eq('id', moduleId);
    if (error) throw new Error(error.message);
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
  }): Promise<void> {
    const { error } = await client().from('course_lessons').insert({
      module_id: input.moduleId,
      title: input.title,
      body: input.body ?? '',
      media_path: input.mediaPath ?? null,
      duration_seconds: input.durationSeconds ?? 0,
      sort_order: input.sortOrder,
    });
    if (error) throw new Error(error.message);
  },

  async updateLesson(
    lessonId: string,
    changes: { title?: string; body?: string; mediaPath?: string | null; durationSeconds?: number },
  ): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (changes.title !== undefined) patch.title = changes.title;
    if (changes.body !== undefined) patch.body = changes.body;
    if (changes.mediaPath !== undefined) patch.media_path = changes.mediaPath;
    if (changes.durationSeconds !== undefined) patch.duration_seconds = changes.durationSeconds;
    const { error } = await client().from('course_lessons').update(patch).eq('id', lessonId);
    if (error) throw new Error(error.message);
  },

  async removeLesson(lessonId: string): Promise<void> {
    const { error } = await client().from('course_lessons').delete().eq('id', lessonId);
    if (error) throw new Error(error.message);
  },
};
