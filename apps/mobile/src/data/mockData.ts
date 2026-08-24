import { Circle, Conversation, Course, EventItem, Lesson, Person, Post, QuizQuestion, Short, Story } from '@/types';
import { SAMPLE_VIDEO_URL } from '@/data/media';

export const quizQuestions: QuizQuestion[] = [
  {
    id: 'q1',
    question: '¿En qué área sientes que más te cuesta avanzar hoy?',
    options: [
      { label: 'Mentalidad', value: 'mentalidad' },
      { label: 'Relaciones', value: 'relaciones' },
      { label: 'Negocios / Finanzas', value: 'negocios' },
      { label: 'Salud', value: 'salud' },
      { label: 'Propósito', value: 'proposito' },
    ],
  },
  {
    id: 'q2',
    question: '¿Qué situación consume más tu energía durante la semana?',
    options: [
      { label: 'Pensar demasiado antes de actuar', value: 'mentalidad' },
      { label: 'Conflictos o falta de límites', value: 'relaciones' },
      { label: 'Incertidumbre económica', value: 'negocios' },
      { label: 'Cansancio y poca constancia', value: 'salud' },
      { label: 'No saber hacia dónde avanzar', value: 'proposito' },
    ],
  },
  {
    id: 'q3',
    question: '¿Qué cambio tendría mayor impacto inmediato en tu vida?',
    options: [
      { label: 'Confiar más en mis decisiones', value: 'mentalidad' },
      { label: 'Mejorar mi comunicación', value: 'relaciones' },
      { label: 'Ordenar mis ingresos y proyectos', value: 'negocios' },
      { label: 'Recuperar energía física', value: 'salud' },
      { label: 'Tener una dirección clara', value: 'proposito' },
    ],
  },
  {
    id: 'q4',
    question: 'Cuando aparece un reto importante, ¿qué suele detenerte?',
    options: [
      { label: 'El miedo a equivocarme', value: 'mentalidad' },
      { label: 'La opinión de otras personas', value: 'relaciones' },
      { label: 'La falta de recursos o estrategia', value: 'negocios' },
      { label: 'El agotamiento', value: 'salud' },
      { label: 'No sentir que vale la pena', value: 'proposito' },
    ],
  },
  {
    id: 'q5',
    question: '¿Qué frase describe mejor tu momento actual?',
    options: [
      { label: 'Sé qué hacer, pero me saboteo', value: 'mentalidad' },
      { label: 'Doy demasiado y recibo poco', value: 'relaciones' },
      { label: 'Trabajo mucho, pero no escalo', value: 'negocios' },
      { label: 'Quiero avanzar, pero mi cuerpo no acompaña', value: 'salud' },
      { label: 'Cumplo metas que ya no me representan', value: 'proposito' },
    ],
  },
  {
    id: 'q6',
    question: '¿Qué te gustaría sentir con más frecuencia?',
    options: [
      { label: 'Seguridad', value: 'mentalidad' },
      { label: 'Conexión', value: 'relaciones' },
      { label: 'Libertad', value: 'negocios' },
      { label: 'Vitalidad', value: 'salud' },
      { label: 'Sentido', value: 'proposito' },
    ],
  },
  {
    id: 'q7',
    question: '¿Qué resultado esperas obtener de RENASER?',
    options: [
      { label: 'Dominar mis pensamientos y hábitos', value: 'mentalidad' },
      { label: 'Construir relaciones más sanas', value: 'relaciones' },
      { label: 'Crecer profesional y financieramente', value: 'negocios' },
      { label: 'Vivir con mayor equilibrio', value: 'salud' },
      { label: 'Alinear mi vida con mi propósito', value: 'proposito' },
    ],
  },
];

export const initialPosts: Post[] = [
  {
    id: 'post-1',
    author: 'Darren Supa',
    username: '@darrensupa',
    body: 'La claridad no llega cuando tienes todas las respuestas. Llega cuando estás dispuesto a hacerte las preguntas correctas.',
    createdAt: 'Hace 2 horas',
    imageKey: 'hero',
    likes: 1240,
    comments: [
      { id: 'c1', author: 'María G.', text: 'Necesitaba leer esto hoy.', createdAt: 'Hace 1 hora' },
      { id: 'c2', author: 'Carlos R.', text: 'La pregunta correcta cambia todo.', createdAt: 'Hace 35 min' },
    ],
  },
  {
    id: 'post-2',
    author: 'Equipo RENASER',
    username: '@renaser',
    body: 'Esta semana abrimos un nuevo círculo para líderes que desean crecer sin perder su equilibrio personal.',
    createdAt: 'Ayer',
    imageKey: 'circle',
    likes: 642,
    comments: [],
  },
];

export const conversations: Conversation[] = [
  {
    id: 'darren',
    name: 'Darren Supa',
    subtitle: 'Gracias por ser parte de Renaser Social Media.',
    unread: 1,
    messages: [
      { id: 'm1', text: 'Bienvenida a Renaser Social Media.', sender: 'them', createdAt: '9:35' },
      { id: 'm2', text: 'Tu próximo nivel comienza con una decisión consciente.', sender: 'them', createdAt: '9:36' },
    ],
  },
  {
    id: 'equipo',
    name: 'Equipo RENASER',
    subtitle: 'Tu próximo evento comienza en 2 días.',
    unread: 0,
    messages: [
      { id: 'm3', text: 'Recuerda reservar tu lugar en el webinar gratuito.', sender: 'them', createdAt: 'Ayer' },
    ],
  },
  {
    id: 'lideres',
    name: 'Líderes RENASER',
    subtitle: 'Ana: Nos vemos en el live.',
    unread: 0,
    messages: [
      { id: 'm4', text: 'Nos vemos en el live de esta noche.', sender: 'them', createdAt: 'Ayer' },
    ],
  },
];

export const events: EventItem[] = [
  {
    id: 'alquimia',
    title: 'ALQUIMIA',
    description: 'La experiencia de transformación más profunda de RENASER.',
    date: '24–26 MAY 2026',
    location: 'Lima, Perú',
    type: 'presencial',
  },
  {
    id: 'webinar-cambio',
    title: 'Los 3 pilares del cambio real',
    description: 'Webinar gratuito para diseñar una estrategia de crecimiento sostenible.',
    date: '30 ABR · 8:00 PM',
    location: 'Online',
    type: 'webinar',
  },
  {
    id: 'preguntas',
    title: 'Preguntas y respuestas con Darren',
    description: 'Sesión en vivo para resolver bloqueos concretos.',
    date: '5 MAY · 7:00 PM',
    location: 'Sala RENASER',
    type: 'live',
  },
];

export const course: Course = {
  id: 'lider-vida-empresa',
  title: 'Líder de tu vida y de tu empresa',
  subtitle: 'Programa online',
  priceMinor: 149700,
  currency: 'MXN',
  modules: 8,
  lessons: 45,
  description: 'Un programa práctico para desarrollar liderazgo, mentalidad y estrategia sin sacrificar tu bienestar.',
};

export const circle: Circle = {
  id: 'lideres-renaser',
  name: 'Círculo Privado Líderes RENASER',
  description: 'Un espacio para compartir, aprender y avanzar junto a personas comprometidas con su crecimiento.',
  members: 423,
};

export const lessons: Lesson[] = [
  {
    id: '1',
    courseId: course.id,
    order: 1,
    title: 'El Poder de la Disciplina Diaria',
    durationMin: 18,
    mentor: 'Darren Hardy',
    summary:
      'La disciplina es el puente entre tus metas y tus logros. El éxito no se consigue con saltos gigantescos, sino con la acumulación constante de pequeñas acciones diarias. En esta lección analizamos las rutinas matutinas que definen el día y cómo crear barreras contra la distracción en un mundo hiperconectado.',
    resources: [
      { id: 'r1', title: 'Guía de Trabajo PDF', subtitle: 'Planificador Diario.pdf (4.2 MB)', icon: 'file-text' },
      { id: 'r2', title: 'Audio Resumen MP3', subtitle: 'Resumen de lección.mp3 (12.8 MB)', icon: 'music' },
    ],
  },
  {
    id: '2',
    courseId: course.id,
    order: 2,
    title: 'Mentalidad de Crecimiento y Estrategia',
    durationMin: 22,
    mentor: 'Darren Hardy',
    summary:
      'Tu forma de interpretar los obstáculos define tu techo. Aquí trabajamos cómo convertir la visión en un plan accionable y cómo tomar decisiones con claridad bajo presión.',
    resources: [
      { id: 'r1', title: 'Plantilla de Estrategia', subtitle: 'Estrategia 90 días.pdf (2.1 MB)', icon: 'file-text' },
    ],
  },
  {
    id: '3',
    courseId: course.id,
    order: 3,
    title: 'Liderazgo sin Agotamiento',
    durationMin: 20,
    mentor: 'Darren Hardy',
    summary:
      'Liderar equipos y tu propia vida sin quemarte requiere sistemas, no fuerza de voluntad. Revisamos hábitos sostenibles y cómo proteger tu energía a largo plazo.',
    resources: [
      { id: 'r1', title: 'Checklist de Hábitos', subtitle: 'Habitos sostenibles.pdf (1.4 MB)', icon: 'file-text' },
      { id: 'r2', title: 'Audio de Cierre', subtitle: 'Integración final.mp3 (9.6 MB)', icon: 'music' },
    ],
  },
];

// ─── Historias (visor a pantalla completa) ───────────────────────────────────
export const stories: Story[] = [
  {
    id: 'tu-historia',
    author: 'Tu historia',
    avatar: 'avatar',
    segments: [
      { id: 'th-1', image: 'avatar', caption: 'Comparte tu primer momento del día.' },
    ],
  },
  {
    id: 'reto-diario',
    author: 'Reto diario',
    avatar: 'speaker',
    segments: [
      { id: 'rd-1', image: 'speaker', caption: 'Reto 1: 20 minutos sin distracciones.' },
      { id: 'rd-2', image: 'hero', caption: 'Reto 2: escribe la decisión que postergas.' },
    ],
  },
  {
    id: 'alquimia',
    author: 'Alquimia',
    avatar: 'hero',
    segments: [
      { id: 'al-1', image: 'hero', caption: 'Transformar hábitos empieza por el entorno.' },
      { id: 'al-2', image: 'course', caption: 'Diseña tu semana antes de que te diseñe a ti.' },
    ],
  },
  {
    id: 'comunidad',
    author: 'Comunidad',
    avatar: 'circle',
    segments: [
      { id: 'co-1', image: 'circle', caption: '423 personas avanzando contigo.' },
    ],
  },
  {
    id: 'en-vivo',
    author: 'En vivo',
    avatar: 'speaker',
    segments: [
      { id: 'ev-1', image: 'event', caption: 'Hoy 7:00 PM · Sala RENASER.' },
    ],
  },
];

// ─── Shorts (feed vertical tipo reels) ───────────────────────────────────────
export const shorts: Short[] = [
  {
    id: 'short-1',
    author: 'Darren Hardy',
    avatar: 'speaker',
    caption: 'El secreto de tu éxito está en tu rutina diaria. #crecimiento #mindset',
    uri: SAMPLE_VIDEO_URL,
    poster: 'hero',
    likes: 142,
    comments: 28,
  },
  {
    id: 'short-2',
    author: 'Ana Sofía',
    avatar: 'avatar',
    caption: 'Poner un límite también es un acto de amor propio. #relaciones',
    uri: SAMPLE_VIDEO_URL,
    poster: 'circle',
    likes: 86,
    comments: 12,
  },
  {
    id: 'short-3',
    author: 'RENASER',
    avatar: 'circle',
    caption: 'Tu energía es la base de todo lo que quieres construir. #salud',
    uri: SAMPLE_VIDEO_URL,
    poster: 'course',
    likes: 231,
    comments: 41,
  },
];

// ─── Personas (seguidores / siguiendo / resultados de búsqueda) ──────────────
export const people: Person[] = [
  { id: 'darren', fullName: 'Darren Hardy', username: '@darrenhardy', avatar: 'speaker', bio: 'Mentor de líderes.' },
  { id: 'ana', fullName: 'Ana Sofía', username: '@anasofia', avatar: 'avatar', bio: 'Construyendo hábitos sostenibles.' },
  { id: 'carlos', fullName: 'Carlos R.', username: '@carlosr', avatar: 'circle', bio: 'Estrategia y foco.' },
  { id: 'maria', fullName: 'María G.', username: '@mariag', avatar: 'hero', bio: 'Aprendiendo cada día.' },
  { id: 'esteban', fullName: 'Esteban R.', username: '@estebanr', avatar: 'course', bio: 'Liderazgo consciente.' },
  { id: 'sophia', fullName: 'Sophia V.', username: '@sophiav', avatar: 'event', bio: 'Claridad y propósito.' },
];
