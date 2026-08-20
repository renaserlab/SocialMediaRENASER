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
  likes: number;
  comments: Comment[];
  /** Contador de comentarios del backend (los comments se cargan bajo demanda). */
  commentsCount?: number;
  isOwn?: boolean;
};

export type Message = {
  id: string;
  text: string;
  sender: 'me' | 'them';
  createdAt: string;
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
  price: number;
  currency: 'PEN' | 'MXN' | 'USD';
  modules: number;
  lessons: number;
  description: string;
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
