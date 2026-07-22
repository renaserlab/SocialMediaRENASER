import type { Course, Lesson } from '@/types';

/** Leccion tal y como la devuelve el backend. */
export type LessonDto = {
  id: string;
  title: string;
  duration_seconds: number;
  sort_order: number;
  completed: boolean;
  /** Ruta del video en Storage; hay que firmarla para reproducirlo. */
  media_path?: string | null;
};

export type LessonDetailDto = LessonDto & {
  course_id: string;
  course_title: string;
  module_title: string;
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
  title: string;
  description: string;
  cover_path: string | null;
  price_minor: number;
  currency: string;
  status: string;
  enrolled: boolean;
  progress_percent: number;
  lessons_total: number;
  lessons_completed: number;
  modules: ModuleDto[];
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
};

const CURRENCIES: Course['currency'][] = ['PEN', 'MXN', 'USD'];

function toCurrency(value: string): Course['currency'] {
  const upper = value?.toUpperCase() as Course['currency'];
  return CURRENCIES.includes(upper) ? upper : 'PEN';
}

/**
 * El backend guarda el precio en la unidad menor (centavos) para no arrastrar
 * decimales; la vista lo muestra en la unidad mayor.
 */
function toMajorUnits(priceMinor: number): number {
  return Math.round((priceMinor ?? 0) / 100);
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
    price: toMajorUnits(dto.price_minor),
    currency: toCurrency(dto.currency),
    modules: dto.modules?.length ?? 0,
    lessons: dto.lessons_total ?? 0,
    description: dto.description ?? '',
  };
}

export function toCourseFromSummary(dto: CourseDto): Course {
  return {
    id: dto.id,
    title: dto.title,
    coverPath: dto.cover_path ?? null,
    subtitle: deriveSubtitle(dto.description),
    price: toMajorUnits(dto.price_minor),
    currency: toCurrency(dto.currency),
    // El listado no trae el desglose; el detalle del curso si.
    modules: 0,
    lessons: 0,
    description: dto.description ?? '',
  };
}

/**
 * El backend aun no guarda transcripcion, mentor ni recursos descargables de
 * cada leccion. Se mapea lo que existe y esos campos quedan vacios: la pantalla
 * oculta esas secciones en vez de mostrarlas sin contenido.
 */
export function toLesson(dto: LessonDetailDto): Lesson {
  return {
    id: dto.id,
    courseId: dto.course_id,
    order: dto.sort_order,
    title: dto.title,
    durationMin: Math.max(1, Math.round((dto.duration_seconds ?? 0) / 60)),
    mentor: '',
    summary: '',
    resources: [],
    mediaPath: dto.media_path ?? null,
  };
}
