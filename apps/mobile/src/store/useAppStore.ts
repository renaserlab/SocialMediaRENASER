import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { conversations, initialPosts } from '@/data/mockData';
import { Conversation, Post, QuizArea, ThemeMode, UserProfile } from '@/types';

type AppState = {
  hydrated: boolean;
  themeMode: ThemeMode;
  user: UserProfile | null;
  onboardingComplete: boolean;
  quizAnswers: Record<string, QuizArea>;
  quizResult: QuizArea | null;
  posts: Post[];
  likedPostIds: string[];
  savedPostIds: string[];
  reservedEventIds: string[];
  purchasedCourseIds: string[];
  conversations: Conversation[];
  liveMessages: Array<{ id: string; author: string; text: string }>;

  languageSelected: boolean;
  setLanguageSelected: (value: boolean) => void;

  setHydrated: (hydrated: boolean) => void;
  toggleTheme: () => void;
  setUser: (user: UserProfile | null) => void;
  registerLocalUser: (input: { fullName: string; email: string }) => void;
  setOnboardingComplete: (value: boolean) => void;
  answerQuiz: (questionId: string, value: QuizArea) => void;
  finishQuiz: () => QuizArea;
  createPost: (body: string) => void;
  toggleLikePost: (postId: string) => void;
  toggleSavePost: (postId: string) => void;
  addComment: (postId: string, text: string) => void;
  toggleReservation: (eventId: string) => void;
  purchaseCourse: (courseId: string) => void;
  sendMessage: (conversationId: string, text: string) => void;
  sendLiveMessage: (text: string) => void;
  resetDemo: () => void;
};

const defaultUser: UserProfile = {
  id: 'local-user',
  fullName: 'Katherine Béjar',
  username: '@katherine',
  email: 'katherine@renaser.local',
  bio: 'Creando una vida con claridad, propósito y crecimiento consciente.',
  followers: 128,
  following: 96,
  posts: 1,
};

const countWinner = (answers: Record<string, QuizArea>): QuizArea => {
  const counts: Record<QuizArea, number> = {
    mentalidad: 0,
    relaciones: 0,
    negocios: 0,
    salud: 0,
    proposito: 0,
  };
  Object.values(answers).forEach((answer) => {
    counts[answer] = (counts[answer] ?? 0) + 1;
  });
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'mentalidad') as QuizArea;
};

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      hydrated: false,
      themeMode: 'light',
      user: null,
      onboardingComplete: false,
      quizAnswers: {},
      quizResult: null,
      posts: initialPosts,
      likedPostIds: [],
      savedPostIds: [],
      reservedEventIds: [],
      purchasedCourseIds: [],
      conversations,
      liveMessages: [
        { id: 'l1', author: 'María G.', text: 'Gracias Darren, este era el punto que necesitaba.' },
        { id: 'l2', author: 'Carlos R.', text: 'Anotando todo. Vamos al siguiente nivel.' },
      ],

      languageSelected: false,
      setLanguageSelected: (value) => set({ languageSelected: value }),

      setHydrated: (hydrated) => set({ hydrated }),
      toggleTheme: () => set((state) => ({ themeMode: state.themeMode === 'light' ? 'dark' : 'light' })),
      setUser: (user) => set({ user }),
      registerLocalUser: ({ fullName, email }) =>
        set({
          user: {
            ...defaultUser,
            fullName,
            email,
            username: `@${fullName.toLowerCase().replace(/[^a-záéíóúñ0-9]+/gi, '').slice(0, 18) || 'usuario'}`,
          },
        }),
      setOnboardingComplete: (value) => set({ onboardingComplete: value }),
      answerQuiz: (questionId, value) =>
        set((state) => ({ quizAnswers: { ...state.quizAnswers, [questionId]: value } })),
      finishQuiz: () => {
        const result = countWinner(get().quizAnswers);
        set({ quizResult: result });
        return result;
      },
      createPost: (body) => {
        const trimmed = body.trim();
        if (!trimmed) return;
        const user = get().user ?? defaultUser;
        const post: Post = {
          id: `post-${Date.now()}`,
          author: user.fullName,
          username: user.username,
          body: trimmed,
          createdAt: 'Ahora',
          likes: 0,
          comments: [],
          isOwn: true,
        };
        set((state) => ({
          posts: [post, ...state.posts],
          user: state.user ? { ...state.user, posts: state.user.posts + 1 } : state.user,
        }));
      },
      toggleLikePost: (postId) =>
        set((state) => {
          const isLiked = state.likedPostIds.includes(postId);
          return {
            likedPostIds: isLiked
              ? state.likedPostIds.filter((id) => id !== postId)
              : [...state.likedPostIds, postId],
            posts: state.posts.map((post) =>
              post.id === postId
                ? { ...post, likes: Math.max(0, post.likes + (isLiked ? -1 : 1)) }
                : post,
            ),
          };
        }),
      toggleSavePost: (postId) =>
        set((state) => ({
          savedPostIds: state.savedPostIds.includes(postId)
            ? state.savedPostIds.filter((id) => id !== postId)
            : [...state.savedPostIds, postId],
        })),
      addComment: (postId, text) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        const author = get().user?.fullName ?? 'Tú';
        set((state) => ({
          posts: state.posts.map((post) =>
            post.id === postId
              ? {
                  ...post,
                  comments: [
                    ...post.comments,
                    { id: `comment-${Date.now()}`, author, text: trimmed, createdAt: 'Ahora' },
                  ],
                }
              : post,
          ),
        }));
      },
      toggleReservation: (eventId) =>
        set((state) => ({
          reservedEventIds: state.reservedEventIds.includes(eventId)
            ? state.reservedEventIds.filter((id) => id !== eventId)
            : [...state.reservedEventIds, eventId],
        })),
      purchaseCourse: (courseId) =>
        set((state) => ({
          purchasedCourseIds: state.purchasedCourseIds.includes(courseId)
            ? state.purchasedCourseIds
            : [...state.purchasedCourseIds, courseId],
        })),
      sendMessage: (conversationId, text) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        set((state) => ({
          conversations: state.conversations.map((conversation) =>
            conversation.id === conversationId
              ? {
                  ...conversation,
                  subtitle: trimmed,
                  messages: [
                    ...conversation.messages,
                    { id: `message-${Date.now()}`, text: trimmed, sender: 'me', createdAt: 'Ahora' },
                  ],
                }
              : conversation,
          ),
        }));
      },
      sendLiveMessage: (text) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        set((state) => ({
          liveMessages: [
            ...state.liveMessages,
            { id: `live-${Date.now()}`, author: state.user?.fullName ?? 'Tú', text: trimmed },
          ],
        }));
      },
      resetDemo: () =>
        set({
          user: null,
          onboardingComplete: false,
          quizAnswers: {},
          quizResult: null,
          posts: initialPosts,
          likedPostIds: [],
          savedPostIds: [],
          reservedEventIds: [],
          purchasedCourseIds: [],
          conversations,
          languageSelected: false,
        }),
    }),
    {
      name: 'renaser-universo-v1',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state: AppState) => ({
        themeMode: state.themeMode,
        user: state.user,
        onboardingComplete: state.onboardingComplete,
        quizAnswers: state.quizAnswers,
        quizResult: state.quizResult,
        posts: state.posts,
        likedPostIds: state.likedPostIds,
        savedPostIds: state.savedPostIds,
        reservedEventIds: state.reservedEventIds,
        purchasedCourseIds: state.purchasedCourseIds,
        conversations: state.conversations,
        liveMessages: state.liveMessages,
      }),
      onRehydrateStorage: () => (state?: AppState) => state?.setHydrated(true),
    },
  ),
);
