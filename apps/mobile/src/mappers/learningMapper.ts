import type { Course, Lesson, MyCourse } from '@/types';

/** Leccion tal y como la devuelve el backend. */
export type LessonDto = {
  id: string;
  title: string;
  duration_seconds: number;
  sort_order: number;
  completed: boolean;
  /** Ruta del video en Storage; hay que firmarla para reproducirlo. */
  media_path?: string | null;
  /** Por donde iba esta persona. Existia en la base y nadie lo devolvia. */
  progress_seconds?: number;
};

export type LessonDetailDto = LessonDto & {
  course_id: string;
  course_title: string;
  module_title: string;
  /** La descripción de la lección. Se guardaba y no se devolvía. */
  body?: string;
  can_manage?: boolean;
  has_access?: boolean;
};

export type ModuleDto = {
  id: string;
  title: string;
  sort_order: number;
  lessons: LessonDto[];
};

/** GET /learning/courses/{id} */
export type CourseDetailDto = {
  id: string;
  author_id: string;
  title: string;
  description: string;
  cover_path: string | null;
  price_minor: number;
  currency: string;
  status: string;
  coming_soon?: boolean;
  topic_ids?: string[];
  enrolled: boolean;
  /** Si puede ver el contenido de pago. Lo decide el servidor. */
  has_access?: boolean;
  /** Si puede editar el curso: su autor o la administración. */
  can_manage?: boolean;
  progress_percent: number;
  lessons_total: number;
  lessons_completed: number;
  modules: ModuleDto[];
};

/** GET /learning/me/courses */
export type MyCourseDto = {
  id: string;
  title: string;
  description: string;
  cover_path: string | null;
  author_id: string;
  price_minor: number;
  currency: string;
  status: string;
  lessons_total: number;
  lessons_completed: number;
  progress_percent: number;
  state: string;
  next_lesson_id: string | null;
};

/** GET /catalog/courses */
export type CourseDto = {
  id: string;
  author_id: string;
  title: string;
  description: string;
  cover_path: string | null;
  price_minor: number;
  currency: string;
  status: string;
  coming_soon?: boolean;
  topic_ids?: string[];
};

const CURRENCIES: Course['currency'][] = ['PEN', 'MXN', 'USD'];

function toCurrency(value: string): Course['currency'] {
  const upper = value?.toUpperCase() as Course['currency'];
  return CURRENCIES.includes(upper) ? upper : 'PEN';
}

/** Primera frase de la descripcion: el backend no tiene campo `subtitle`. */
function deriveSubtitle(description: string): string {
  const first = description?.split(/[.\n]/)[0]?.trim() ?? '';
  return first.length > 90 ? `${first.slice(0, 87)}…` : first;
}

export function toCourseFromDetail(dto: CourseDetailDto): Course {
  return {
    id: dto.id,
    title: dto.title,
    coverPath: dto.cover_path ?? null,
    subtitle: deriveSubtitle(dto.description),
    authorId: dto.author_id,
    priceMinor: dto.price_minor ?? 0,
    currency: toCurrency(dto.currency),
    modules: dto.modules?.length ?? 0,
    lessons: dto.lessons_total ?? 0,
    description: dto.description ?? '',
    status: dto.status,
    topicIds: dto.topic_ids ?? [],
    comingSoon: dto.coming_soon ?? false,
  };
}

export function toCourseFromSummary(dto: CourseDto): Course {
  return {
    id: dto.id,
    authorId: dto.author_id,
    title: dto.title,
    coverPath: dto.cover_path ?? null,
    subtitle: deriveSubtitle(dto.description),
    priceMinor: dto.price_minor ?? 0,
    currency: toCurrency(dto.currency),
    // El listado no trae el desglose; el detalle del curso si.
    modules: 0,
    lessons: 0,
    description: dto.description ?? '',
    status: dto.status,
    topicIds: dto.topic_ids ?? [],
    comingSoon: dto.coming_soon ?? false,
  };
}

const ESTADOS = ['not_started', 'in_progress', 'completed'] as const;

export function toMyCourse(dto: MyCourseDto): MyCourse {
  return {
    id: dto.id,
    title: dto.title,
    subtitle: deriveSubtitle(dto.description),
    coverPath: dto.cover_path ?? null,
    authorId: dto.author_id,
    priceMinor: dto.price_minor ?? 0,
    currency: toCurrency(dto.currency),
    lessonsTotal: dto.lessons_total ?? 0,
    lessonsCompleted: dto.lessons_completed ?? 0,
    progressPercent: dto.progress_percent ?? 0,
    state: (ESTADOS as readonly string[]).includes(dto.state)
      ? (dto.state as MyCourse['state'])
      : 'not_started',
    nextLessonId: dto.next_lesson_id ?? null,
  };
}

/**
 * El backend aun no guarda transcripcion, mentor ni recursos descargables de
 * cada leccion. Se mapea lo que existe y esos campos quedan vacios: la pantalla
 * oculta esas secciones en vez de mostrarlas sin contenido.
 *
 * `summary` SI existe ya: es `course_lessons.body`. Antes se dejaba vacio a la
 * fuerza porque el endpoint no lo devolvia, asi que quien escribia una
 * descripcion la veia desaparecer justo despues de guardarla.
 */
export function toLesson(dto: LessonDetailDto): Lesson {
  return {
    id: dto.id,
    courseId: dto.course_id,
    order: dto.sort_order,
    title: dto.title,
    durationMin: Math.max(1, Math.round((dto.duration_seconds ?? 0) / 60)),
    mentor: '',
    summary: dto.body ?? '',
    resources: [],
    mediaPath: dto.media_path ?? null,
    progressSeconds: dto.progress_seconds ?? 0,
    completed: dto.completed ?? false,
    durationSeconds: dto.duration_seconds ?? 0,
    canManage: dto.can_manage ?? false,
    hasAccess: dto.has_access ?? false,
  };
}
