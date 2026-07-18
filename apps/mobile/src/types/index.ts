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
  username: string;
  body: string;
  createdAt: string;
  imageKey?: 'hero' | 'speaker' | 'event' | 'circle';
  likes: number;
  comments: Comment[];
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
