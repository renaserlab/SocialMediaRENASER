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
  username: string;
  body: string;
  createdAt: string;
  imageKey?: 'hero' | 'speaker' | 'event' | 'circle';
  /** URL firmada de la imagen remota (Supabase Storage). */
  imageUrl?: string;
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
