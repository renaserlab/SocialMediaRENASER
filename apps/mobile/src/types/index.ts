export type ThemeMode = 'light' | 'dark';

export type UserProfile = {
  id: string;
  fullName: string;
  username: string;
  email: string;
  bio: string;
  followers: number;
  following: number;
  posts: number;
  /** Si el usuario actual sigue a este perfil (solo en perfiles ajenos). */
  isFollowing?: boolean;
  /** Si el usuario actual ha bloqueado a este perfil. */
  isBlocked?: boolean;
  /** Foto de perfil elegida por el usuario. Sin valor se usa el avatar por defecto. */
  avatarUrl?: string;
  /** Foto de portada elegida por el usuario. Sin valor se usa la imagen por defecto. */
  coverUrl?: string;
  /** Gestiona la aplicación (crear cursos, moderar). Lo resuelve el backend. */
  isAdmin?: boolean;
  /**
   * Instante (ISO, del servidor) en que arrancó la liberación progresiva del
   * podcast. Nulo mientras no se haya abierto el podcast por primera vez.
   */
  podcastStartedAt?: string | null;
  /**
   * "Me gusta" RECIBIDOS en sus publicaciones.
   *
   * Es la cifra que se muestra en el perfil junto a seguidores y seguidos. No
   * son los que ha dado: cuantos ha repartido una persona no dice nada de ella
   * para quien la visita.
   */
  likes?: number;
  /** Ruta en Storage del audio de presentación. Sin valor, no tiene. */
  introAudioPath?: string | null;
  /** Duración de ese audio, en segundos. */
  introAudioDurationS?: number | null;
  /** Cuándo se subió el audio vigente; sirve de clave de caché. */
  introAudioUpdatedAt?: string | null;
};

export type QuizArea = 'mentalidad' | 'relaciones' | 'negocios' | 'salud' | 'proposito';

export type QuizQuestion = {
  id: string;
  question: string;
  options: Array<{ label: string; value: QuizArea }>;
};

export type Comment = {
  id: string;
  author: string;
  text: string;
  createdAt: string;
};

export type Post = {
  id: string;
  author: string;
  /** id del autor en el backend (para navegar a su perfil). */
  authorId?: string;
  /** URL publica del avatar del autor; sin valor se usa el placeholder. */
  authorAvatarUrl?: string;
  username: string;
  body: string;
  createdAt: string;
  imageKey?: 'hero' | 'speaker' | 'event' | 'circle';
  /** URL firmada del medio remoto (Supabase Storage). */
  mediaUrl?: string;
  /** Tipo del medio remoto: imagen, video o audio. */
  mediaType?: 'image' | 'video' | 'audio';
  /**
   * Ruta del medio en Storage. Es la identidad ESTABLE del archivo: la URL
   * firmada cambia con cada firma, asi que las caches (disco de expo-image,
   * snapshot del feed) se indexan por esta ruta y no por la URL.
   */
  mediaPath?: string;
  /** URL firmada del poster del video (se pinta mientras el video prepara). */
  posterUrl?: string;
  /** Ruta del poster en Storage, para refirmarlo. */
  posterPath?: string;
  /** Medidas reales del medio: reservan el hueco exacto y evitan saltos. */
  mediaWidth?: number;
  mediaHeight?: number;
  /** Duracion del video/audio en segundos. */
  mediaDurationS?: number;
  /** Fecha ISO original; `createdAt` es su forma corta y hay que recalcularla. */
  createdAtIso?: string;
  /**
   * URL de la playlist HLS del video (streaming adaptativo por segmentos).
   * Solo existe si el video fue transcodificado; el reproductor nativo la
   * prefiere sobre el MP4. En web se ignora (el <video> del navegador no
   * reproduce HLS salvo Safari) y se usa el MP4 de siempre.
   */
  streamUrl?: string;
  /**
   * Estado del procesado del medio (posters/derivados). `processing` significa
   * que el original ya se ve pero las versiones optimizadas aun no existen.
   */
  processingStatus?: 'uploaded' | 'processing' | 'ready' | 'failed';
  /** Categoría temática; alimenta los filtros del podcast. */
  category?: string | null;
  /**
   * De qué trata: ids de la taxonomía común de `topics`, la misma que eligen
   * las personas. No confundir con `category`, que es la carpeta con la que un
   * creador ordena SUS audios.
   */
  topicIds?: string[];
  /**
   * Etiquetas sociales del texto, TAL Y COMO SE ESCRIBIERON («MiNegocio», sin
   * almohadilla). Las extrae el servidor del propio cuerpo, no las manda el
   * cliente: si no, cualquiera aparecería en #python sin decir «python».
   *
   * No confundir con `topicIds`, que es la taxonomía cerrada del producto. Los
   * hashtags son vocabulario abierto de la gente y conviven con los temas.
   *
   * Vacío en el contenido anterior a la migración 0031: el texto se ve igual,
   * lo que no hay es nada que tocar.
   */
  hashtags?: string[];
  /** A quién etiqueta la publicación (migración 0032). */
  mentions?: PersonaEtiquetada[];
  likes: number;
  comments: Comment[];
  /** Contador de comentarios del backend (los comments se cargan bajo demanda). */
  commentsCount?: number;
  isOwn?: boolean;
};

/** Alguien etiquetado en una publicación: lo justo para pintarlo y abrirlo. */
export type PersonaEtiquetada = {
  id: string;
  nombre: string;
  usuario?: string;
  /** URL pública del avatar; sin valor se usa el marcador de posición. */
  avatarUrl?: string;
};

/** Un archivo colgado de un mensaje: foto, vídeo o documento. */
export type MessageAttachment = {
  id: string;
  /** Ruta dentro del bucket privado `message-media`. Se firma para verla. */
  storagePath: string;
  kind: 'image' | 'video' | 'document';
  mimeType?: string | null;
  /** El nombre original; para un documento es lo único que lo identifica. */
  fileName?: string | null;
  bytes?: number | null;
  width?: number | null;
  height?: number | null;
  durationS?: number | null;
  /** URL firmada, cuando ya se ha pedido. Caduca. */
  url?: string;
};

export type Message = {
  id: string;
  text: string;
  sender: 'me' | 'them';
  /** Hora ya formateada para pintarla. */
  createdAt: string;
  /**
   * El instante exacto del servidor, sin formatear.
   *
   * Es lo que ordena la lista y lo que se manda como `before`/`after` para
   * pedir historial o novedades. `createdAt` no sirve para eso: solo lleva la
   * hora y el minuto, así que dos mensajes de días distintos parecen el mismo
   * momento. Los mensajes que todavía no han llegado al servidor no lo tienen.
   */
  createdAtIso?: string;
  attachments?: MessageAttachment[];
  /** Lo que está pasando con este mensaje mientras se envía. */
  estado?: 'enviando' | 'error';
  /** Avance de la subida de sus archivos, de 0 a 1. */
  progreso?: number;
};

export type Conversation = {
  id: string;
  name: string;
  subtitle: string;
  unread: number;
  messages: Message[];
  /** Hora del último mensaje (para la lista de conversaciones). */
  time?: string;
  /** Foto del otro participante; sin valor se usa el avatar por defecto. */
  avatarUrl?: string;
  /** Su id, para poder abrir su perfil desde la conversación. */
  otherId?: string;
};

export type EventItem = {
  id: string;
  /** Quien organiza el evento; permite listar los de un perfil. */
  organizerId?: string;
  /** Fecha real de inicio; `date` es solo el texto ya formateado. */
  startsAtDate?: Date;
  /** Fin del evento; con el se muestran rangos ("25-26 de agosto"). */
  endsAtDate?: Date | null;
  /** Invitación al grupo de WhatsApp donde se dan los detalles. */
  whatsappUrl?: string | null;
  /** Ruta de la portada en Storage; hay que firmarla para mostrarla. */
  coverPath?: string | null;
  /** URL firmada de la portada, ya resuelta. */
  coverUrl?: string;
  title: string;
  description: string;
  date: string;
  location: string;
  type: 'presencial' | 'webinar' | 'live';
};

export type Course = {
  id: string;
  /** Quién publica el curso; permite listar los de un perfil. */
  authorId?: string;
  title: string;
  /** Ruta de la portada en Storage (bucket post-media). */
  coverPath?: string | null;
  /** URL firmada de la portada, ya resuelta por el repositorio. */
  coverUrl?: string;
  subtitle: string;
  /**
   * Precio en la unidad MENOR (centavos). Nunca decimales.
   *
   * Antes era `price` en unidad mayor y el servidor multiplicaba por 100, con
   * lo que «49.90» no se podia expresar. Ver `lib/dinero.ts`.
   */
  priceMinor: number;
  currency: 'PEN' | 'MXN' | 'USD';
  modules: number;
  lessons: number;
  description: string;
  /** `draft` | `published` | `hidden`. Un borrador solo lo ve su autor. */
  status?: string;
  /** Temas del catálogo común. Vacío mientras la 0028 no esté aplicada. */
  topicIds?: string[];
  /** Anunciado pero todavía sin contenido. No es lo mismo que borrador. */
  comingSoon?: boolean;
};

/** Un curso al que se tiene acceso, con el avance real. Lo devuelve el servidor. */
export type MyCourse = {
  id: string;
  title: string;
  subtitle: string;
  coverPath?: string | null;
  coverUrl?: string;
  authorId: string;
  priceMinor: number;
  currency: 'PEN' | 'MXN' | 'USD';
  lessonsTotal: number;
  lessonsCompleted: number;
  progressPercent: number;
  /** `not_started` | `in_progress` | `completed`. Tres cosas distintas. */
  state: 'not_started' | 'in_progress' | 'completed';
  /** Primera lección pendiente, para «Continuar». */
  nextLessonId: string | null;
};

export type Circle = {
  id: string;
  name: string;
  description: string;
  members: number;
};

export type LessonResource = {
  id: string;
  title: string;
  subtitle: string;
  icon: 'file-text' | 'music' | 'video';
};

export type Lesson = {
  id: string;
  courseId: string;
  order: number;
  title: string;
  durationMin: number;
  mentor: string;
  summary: string;
  resources: LessonResource[];
  /** Ruta del video en Storage; la pantalla la firma para reproducirlo. */
  mediaPath?: string | null;
  /** Por dónde iba: el reproductor arranca ahí en vez de desde el principio. */
  progressSeconds?: number;
  completed?: boolean;
  durationSeconds?: number;
  /** Si puede editar esta lección: el autor del curso o la administración. */
  canManage?: boolean;
  /** Si tiene acceso al contenido de pago del curso. */
  hasAccess?: boolean;
};

/** Un tramo real de historia, tal y como lo devuelve el backend. */
export type StoryItem = {
  id: string;
  storagePath: string;
  /** URL firmada del medio; se resuelve al cargar el listado. */
  mediaUrl?: string;
  mediaType: 'image' | 'video';
  /** Cuanto dura el tramo en el visor (en video, su duracion real). */
  durationMs: number;
  caption: string;
  createdAt: string;
  viewedByMe: boolean;
  /** Solo llega con valor en las historias propias. */
  viewsCount: number;
};

/** Las historias vigentes de un autor: una burbuja en la fila de inicio. */
export type StoryGroup = {
  authorId: string;
  author: string;
  username: string;
  avatarPath?: string;
  /** URL publica del avatar del autor; sin valor se usa el placeholder. */
  avatarUrl?: string;
  items: StoryItem[];
  /** false si queda algun tramo sin ver: es lo que decide el anillo. */
  seen: boolean;
  isOwn: boolean;
};

/** Quien vio una historia (solo lo consulta su autor). */
export type StoryViewer = {
  id: string;
  fullName: string;
  username: string;
  /** URL publica del avatar; sin valor se usa el placeholder. */
  avatarUrl?: string;
  viewedAt: string;
};

/** Filtro de la galeria de testimonios. */
export type TestimonialFilter = 'all' | 'image' | 'video';

/** Foto o video de la galeria de testimonios (solo los publica la admin). */
export type Testimonial = {
  id: string;
  storagePath: string;
  /** URL firmada; el bucket es privado, asi que caduca. */
  mediaUrl?: string;
  mediaType: 'image' | 'video';
  caption: string;
  createdAt: string;
};

/** Un tramo de una historia (imagen a pantalla completa con texto opcional). */
export type StorySegment = {
  id: string;
  /** Clave de `data/assets` con la imagen del tramo. */
  image: string;
  caption?: string;
};

/** Historia de un autor: se ve como una secuencia de tramos. */
export type Story = {
  id: string;
  author: string;
  /** Clave de `data/assets` con el avatar del autor. */
  avatar: string;
  segments: StorySegment[];
};

/** Persona en listas sociales (seguidores / siguiendo / resultados). */
export type Person = {
  id: string;
  fullName: string;
  username: string;
  /** Clave de `data/assets` con el avatar. */
  avatar: string;
  bio?: string;
};

/** Item del feed vertical de shorts (reels). */
export type Short = {
  id: string;
  author: string;
  /** Clave de `data/assets` con el avatar del autor. */
  avatar: string;
  caption: string;
  /** URL del video. */
  uri: string;
  /** Clave de `data/assets` usada como póster. */
  poster: string;
  likes: number;
  comments: number;
};
