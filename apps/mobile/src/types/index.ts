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
  /** Foto de perfil elegida por el usuario. Sin valor se usa el avatar por defecto. */
  avatarUrl?: string;
  /** Foto de portada elegida por el usuario. Sin valor se usa la imagen por defecto. */
  coverUrl?: string;
  /** Gestiona la aplicación (crear cursos, moderar). Lo resuelve el backend. */
  isAdmin?: boolean;
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
};

export type EventItem = {
  id: string;
  title: string;
  description: string;
  date: string;
  location: string;
  type: 'presencial' | 'webinar' | 'live';
};

export type Course = {
  id: string;
  title: string;
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
