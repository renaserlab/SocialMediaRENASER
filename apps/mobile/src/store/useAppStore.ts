import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { conversations, initialPosts } from '@/data/mockData';
import { formatRelativeTime } from '@/mappers/postMapper';
import { AuthRepository } from '@/repositories/AuthRepository';
import {
  PostRepository,
  resolveMediaUrls,
  type FeedKind,
  type FeedPage,
} from '@/repositories/PostRepository';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import { StoryRepository } from '@/repositories/StoryRepository';
import { ApiError } from '@/services/api';
import { uploadProfileImage, type PickedMedia, type UploadedMedia } from '@/services/storage';
import { perfMark } from '@/lib/perf';
import {
  idiomaEfectivo,
  migraIdiomaGuardado,
  type IdiomaElegido,
} from '@/lib/idioma';
import { mezclarReacciones } from '@/lib/reacciones';
import type { Tramo } from '@/lib/historias';
import type { Language } from '@/i18n';
import { Conversation, Post, QuizArea, StoryGroup, ThemeMode, UserProfile } from '@/types';

/** Con Supabase configurado usamos el backend real; si no, modo demo local. */
const backendEnabled = AuthRepository.enabled;
const FEED_PAGE = 20;

/*
  Instantanea local del feed (stale-while-revalidate).

  Al abrir la aplicacion se pinta la ULTIMA tanda de publicaciones guardada y,
  en paralelo, se consulta el servidor y se reconcilia en silencio. Sin esto,
  cada arranque era una pantalla de esqueletos hasta que el backend —que en el
  plan gratuito de Render puede tardar ~25 s en despertar— respondiera.

  Se guarda SOLO metadata ligera (texto, autor, contadores, rutas de Storage y
  medidas): unos pocos KB. Nunca URLs firmadas (caducan) ni blobs (para eso
  estan las caches de disco de expo-image/expo-video).

  Por que AsyncStorage y no expo-sqlite: es UN objeto pequeño que se lee una
  vez al arrancar y se escribe una vez por carga de feed. SQLite anadiria un
  modulo nativo, un esquema y migraciones para un caso que no consulta, no
  filtra y no crece. Si algun dia se cachean cientos de posts o se busca
  offline, ese sera el momento de migrar.
*/
const FEED_SNAPSHOT_KEY = 'z-feed-snapshot-v1';
const FEED_SNAPSHOT_SIZE = 12;

type FeedSnapshot = { savedAt: number; posts: Post[] };

function saveFeedSnapshot(posts: Post[]): void {
  const slim = posts.slice(0, FEED_SNAPSHOT_SIZE).map((post) => ({
    ...post,
    // Volatil o pesado: fuera. Se reconstruye al cargar.
    mediaUrl: undefined,
    posterUrl: undefined,
    comments: [],
  }));
  const snapshot: FeedSnapshot = { savedAt: Date.now(), posts: slim };
  AsyncStorage.setItem(FEED_SNAPSHOT_KEY, JSON.stringify(snapshot)).catch(() => {});
}

/** Completa mediaUrl/posterUrl de los posts del estado, casando por id. */
function mergeMediaUrls(current: Post[], withUrls: Post[]): Post[] {
  const byId = new Map(withUrls.map((post) => [post.id, post]));
  return current.map((post) => {
    const resolved = byId.get(post.id);
    if (!resolved) return post;
    if (resolved.mediaUrl === post.mediaUrl && resolved.posterUrl === post.posterUrl) {
      return post;
    }
    return {
      ...post,
      mediaUrl: resolved.mediaUrl ?? post.mediaUrl,
      posterUrl: resolved.posterUrl ?? post.posterUrl,
    };
  });
}

/*
  Deduplicacion de cargas del feed: el montaje doble de un efecto, volver a la
  pestana o un focus rapido disparaban `loadFeed` varias veces seguidas y cada
  una era UNA peticion completa al backend. La que llega mientras otra igual
  esta en vuelo simplemente espera a esa.
*/
let feedInFlight: { kind: FeedKind; promise: Promise<void> } | null = null;
/** true en cuanto una carga de red termina: la instantanea ya no debe pisar. */
let feedLoadedFromNetwork = false;

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
  /**
   * Cuántas reacciones tiene cada publicación, para las pantallas que NO
   * mantienen su propia lista de publicaciones.
   *
   * El muro lee el contador de `posts`, pero el feed de vídeo de Inicio tiene
   * su propia cola de elementos y no puede: sin esto, cada celda se guardaba
   * el número en un `useState` que nacía del valor de carga y se quedaba
   * congelado ahí. Reaccionar en Inicio subía un número que no existía en
   * ningún otro sitio y se perdía al desmontar la celda.
   *
   * NO se persiste: es una foto del servidor, no una preferencia. Guardarla
   * en disco solo serviría para enseñar un número viejo al abrir.
   */
  likeCounts: Record<string, number>;
  reservedEventIds: string[];
  conversations: Conversation[];

  /**
   * Silencio de los videos del muro, compartido por todas las tarjetas.
   *
   * Arranca SILENCIADO, como Instagram: los videos se reproducen solos al
   * aparecer, y que ademas sonaran sin permiso seria intrusivo (y los
   * navegadores directamente lo bloquean). Se decide una vez para todo el
   * muro: si cada video recordara el suyo, bajar la lista seria un sobresalto
   * continuo. No se persiste a proposito: cada sesion vuelve a empezar en
   * silencio.
   */
  feedMuted: boolean;
  toggleFeedMuted: () => void;

  // Estado del feed remoto (no se persiste)
  feedStatus: 'idle' | 'loading' | 'error';
  feedError: string | null;
  feedHasMore: boolean;
  feedLoadingMore: boolean;
  feedOffset: number;
  /** Pestaña activa del feed; la conserva `loadMoreFeed` al paginar. */
  feedKind: FeedKind;
  loadFeed: (feed?: FeedKind) => Promise<void>;
  loadMoreFeed: () => Promise<void>;
  loadCommentsFor: (postId: string) => Promise<void>;
  /** Pinta la ultima instantanea guardada del feed mientras llega la red. */
  hydrateFeedFromCache: () => Promise<void>;

  // Historias (efimeras, 24 h). No se persisten: caducan solas.
  storyGroups: StoryGroup[];
  storiesStatus: 'idle' | 'loading' | 'error';
  loadStories: () => Promise<void>;
  /** `tramo` solo cuando hay que recortar: entonces publica el SERVIDOR. */
  createStory: (media: UploadedMedia, durationMs?: number, tramo?: Tramo) => Promise<void>;
  deleteStory: (storyId: string) => Promise<void>;
  markStoryViewed: (storyId: string) => void;

  /**
   * Guias "toca aqui" que el usuario ya cerro a mano. Se persisten para que no
   * reaparezcan en cada arranque; las que dependen de una accion (publicar por
   * primera vez) se apagan solas al completarla y no necesitan estar aqui.
   */
  dismissedGuides: string[];
  dismissGuide: (id: string) => void;

  /**
   * LO QUE LA PERSONA ELIGIO. `null` = todavia no ha elegido.
   *
   * Es el UNICO dato de idioma que se guarda, y por eso «sin elegir» y «eligio
   * español» dejan de ser indistinguibles (ver `@/lib/idioma`). El idioma con
   * el que se pinta sale de aqui con `idiomaEfectivo`, no de otro campo.
   */
  idiomaElegido: IdiomaElegido;
  /** Guarda la eleccion. A partir de aqui no se vuelve a preguntar. */
  elegirIdioma: (language: Language) => void;

  setHydrated: (hydrated: boolean) => void;
  toggleTheme: () => void;
  setUser: (user: UserProfile | null) => void;
  setPosts: (posts: Post[]) => void;
  setConversations: (conversations: Conversation[]) => void;
  registerLocalUser: (input: { fullName: string; email: string }) => void;
  setOnboardingComplete: (value: boolean) => void;
  answerQuiz: (questionId: string, value: QuizArea) => void;
  finishQuiz: () => QuizArea;
  /** `topicIds`: de qué trata la publicación (taxonomía de `topics`, hasta 3). */
  createPost: (body: string, media?: UploadedMedia[], topicIds?: string[]) => Promise<void>;
  deletePost: (postId: string) => Promise<void>;
  /** `media` a null quita la foto y devuelve la imagen por defecto. */
  setProfileImage: (kind: 'avatar' | 'cover', media: PickedMedia | null) => Promise<void>;
  toggleLikePost: (postId: string) => void;
  /**
   * Aplica lo que dice el SERVIDOR sobre las reacciones de una tanda.
   *
   * Se pasa la tanda entera y no solo lo que tiene me gusta a propósito: sin
   * saber qué publicaciones venían en la respuesta no se puede distinguir
   * «esta no le gusta» de «esta no venía». Con las dos listas se corrige solo
   * lo que el servidor ha hablado y no se toca el resto, que es lo que permite
   * que Inicio y Explorar se pisen sin borrarse el estado.
   */
  aplicarLikesDelServidor: (idsDeLaTanda: string[], idsConMeGusta: string[], contadores?: Record<string, number>) => void;
  toggleSavePost: (postId: string) => void;
  addComment: (postId: string, text: string) => Promise<void>;
  toggleReservation: (eventId: string) => void;
  sendMessage: (conversationId: string, text: string) => void;
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
      // Con backend real se arranca VACIO a proposito. Al precargar los datos
      // de demo, `posts.length > 0` hacia que el esqueleto de carga no se
      // mostrara nunca: se pintaban publicaciones falsas y un instante despues
      // saltaban a las reales. Vacio -> se ve el esqueleto y luego el contenido.
      posts: backendEnabled ? [] : initialPosts,
      likedPostIds: [],
      savedPostIds: [],
      likeCounts: {},
      reservedEventIds: [],
      conversations: backendEnabled ? [] : conversations,

      feedMuted: true,
      toggleFeedMuted: () => set((state) => ({ feedMuted: !state.feedMuted })),

      feedKind: 'all',
      feedStatus: 'idle',
      feedError: null,
      feedHasMore: false,
      feedLoadingMore: false,
      feedOffset: 0,

      storyGroups: [],
      storiesStatus: 'idle',

      dismissedGuides: [],
      dismissGuide: (id) =>
        set((state) =>
          state.dismissedGuides.includes(id)
            ? state
            : { dismissedGuides: [...state.dismissedGuides, id] },
        ),

      idiomaElegido: null,
      elegirIdioma: (language) => set({ idiomaElegido: language }),

      setHydrated: (hydrated) => set({ hydrated }),
      toggleTheme: () => set((state) => ({ themeMode: state.themeMode === 'light' ? 'dark' : 'light' })),
      /*
        Al salir se olvidan las reacciones, y va AQUI y no en `signOut` porque
        hay tres caminos distintos que dejan la sesion a null y bastaba con que
        uno se olvidara.

        `likedPostIds` y `savedPostIds` se persisten en disco, asi que sin esto
        la siguiente persona que iniciara sesion en el mismo telefono veria los
        corazones de la cuenta anterior encendidos —y al tocarlos estaria
        quitando un me gusta que nunca dio—.
      */
      setUser: (user) =>
        set(user ? { user } : { user: null, likedPostIds: [], savedPostIds: [], likeCounts: {} }),
      setPosts: (posts) => set({ posts }),
      setConversations: (conversations) => set({ conversations }),
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
      createPost: async (body, media = [], topicIds = []) => {
        const trimmed = body.trim();
        /*
          Sin texto Y sin adjunto no hay nada que publicar. Con adjunto SI se
          publica aunque no haya texto: un reel o una foto se explican solos, y
          obligar a escribir algo para poder compartirlos era un requisito
          nuestro, no de la persona.
        */
        if (!trimmed && media.length === 0) return;

        if (backendEnabled) {
          const uid = get().user?.id ?? null;
          // La categoría va sin valor a propósito: es la carpeta de audios del
          // podcast y no tiene nada que ver con de qué trata la publicación.
          const post = await PostRepository.createPost(trimmed, media, uid, undefined, topicIds);
          set((state) => ({
            posts: [post, ...state.posts],
            user: state.user ? { ...state.user, posts: state.user.posts + 1 } : state.user,
          }));
          return;
        }

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
      loadStories: async () => {
        // Sin backend no hay historias: la fila se queda vacia en vez de
        // mostrar burbujas de mentira.
        if (!backendEnabled) {
          set({ storyGroups: [], storiesStatus: 'idle' });
          return;
        }
        set({ storiesStatus: 'loading' });
        try {
          set({ storyGroups: await StoryRepository.list(), storiesStatus: 'idle' });
        } catch (error) {
          // Un fallo aqui no debe tumbar el inicio: el feed sigue funcionando.
          // Pero se registra: un error silencioso aqui dejaba la fila vacia sin
          // ninguna pista de por que (p. ej. un embed ambiguo de PostgREST).
          console.warn('[historias] no se pudieron cargar:', error);
          set({ storiesStatus: 'error' });
        }
      },
      createStory: async (media, durationMs = 5000, tramo) => {
        await StoryRepository.create(media, { durationMs, tramo });
        await get().loadStories();
      },
      deleteStory: async (storyId) => {
        // Se quita al instante y se recarga para recalcular anillos y orden.
        set((state) => ({
          storyGroups: state.storyGroups
            .map((group) => ({ ...group, items: group.items.filter((i) => i.id !== storyId) }))
            .filter((group) => group.items.length > 0),
        }));
        try {
          await StoryRepository.remove(storyId);
        } finally {
          await get().loadStories();
        }
      },
      markStoryViewed: (storyId) => {
        const groups = get().storyGroups;
        const alreadySeen = groups.every((group) =>
          group.items.every((item) => item.id !== storyId || item.viewedByMe),
        );
        if (alreadySeen) return;

        // Mirar tu propia historia no cuenta como visita. Antes lo filtraba la
        // API; ahora que se inserta desde el cliente hay que hacerlo aqui, o el
        // contador se inflaria solo con abrirla.
        const isOwn = groups.some(
          (group) => group.isOwn && group.items.some((item) => item.id === storyId),
        );

        // Optimista: el anillo se apaga sin esperar a la red.
        set({
          storyGroups: groups.map((group) => {
            const items = group.items.map((item) =>
              item.id === storyId ? { ...item, viewedByMe: true } : item,
            );
            return { ...group, items, seen: items.every((item) => item.viewedByMe) };
          }),
        });
        if (backendEnabled && !isOwn) {
          StoryRepository.markViewed(storyId).catch(() => {
            // Marcar una vista no es critico: si falla, se reintenta al reabrir.
          });
        }
      },
      deletePost: async (postId) => {
        const index = get().posts.findIndex((post) => post.id === postId);
        if (index < 0) return;
        const removed = get().posts[index]!;

        // Quitamos de inmediato para que la UI responda sin esperar a la red.
        set((state) => ({
          posts: state.posts.filter((post) => post.id !== postId),
          user: state.user
            ? { ...state.user, posts: Math.max(0, state.user.posts - 1) }
            : state.user,
        }));

        if (!backendEnabled) return;

        try {
          await PostRepository.deletePost(postId);
        } catch (error) {
          // Devolvemos la publicación a su posición original.
          set((state) => {
            const posts = [...state.posts];
            posts.splice(Math.min(index, posts.length), 0, removed);
            return {
              posts,
              user: state.user ? { ...state.user, posts: state.user.posts + 1 } : state.user,
            };
          });
          throw error;
        }
      },
      setProfileImage: async (kind, media) => {
        const field = kind === 'avatar' ? 'avatarUrl' : 'coverUrl';
        const previous = get().user;
        // Sin perfil cargado no se inventa uno: antes caia a `defaultUser` y el
        // usuario terminaba con la identidad del demo.
        if (!previous) return;

        // Optimista: la foto aparece al instante mientras sube de fondo.
        set({ user: { ...previous, [field]: media?.uri } });

        // Modo demo sin backend: se queda en local, que es lo unico que hay.
        if (!backendEnabled) return;

        try {
          const path = media ? await uploadProfileImage(kind, media) : null;
          const updated = await ProfileRepository.updateMyProfile(
            kind === 'avatar' ? { avatarPath: path } : { coverPath: path },
          );
          // La respuesta trae ya la URL publica y persistente del bucket, que
          // sustituye al uri local (temporal, y en web invalido tras recargar).
          set({ user: updated });
        } catch (error) {
          set({ user: previous });
          throw error;
        }
      },
      toggleLikePost: (postId) => {
        const wasLiked = get().likedPostIds.includes(postId);
        /*
          El contador vive en DOS sitios y los dos se mueven a la vez.

          `posts` es el del muro, que tiene la publicacion entera. `likeCounts`
          es el de las pantallas que no la tienen —el feed de video de Inicio
          lleva su propia cola de elementos—. Antes solo existia el primero, y
          por eso Inicio se guardaba el numero en un `useState` suyo que no se
          enteraba de nada.

          `contadorActual` sale de donde haya: del mapa si ya se conoce, y si
          no de la publicacion del muro.
        */
        const estado = get();
        const enElMuro = estado.posts.find((post) => post.id === postId);
        const contadorActual = estado.likeCounts[postId] ?? enElMuro?.likes ?? 0;
        const contadorOptimista = Math.max(0, contadorActual + (wasLiked ? -1 : 1));

        // Actualización optimista.
        set((state) => ({
          likedPostIds: wasLiked
            ? state.likedPostIds.filter((id) => id !== postId)
            : [...state.likedPostIds, postId],
          likeCounts: { ...state.likeCounts, [postId]: contadorOptimista },
          posts: state.posts.map((post) =>
            post.id === postId
              ? { ...post, likes: Math.max(0, post.likes + (wasLiked ? -1 : 1)) }
              : post,
          ),
        }));

        if (!backendEnabled) return;
        const op = wasLiked ? PostRepository.unlike(postId) : PostRepository.like(postId);
        op
          .then((likesCount) =>
            // La cuenta REAL del servidor manda sobre la optimista.
            set((state) => ({
              likeCounts: { ...state.likeCounts, [postId]: likesCount },
              posts: state.posts.map((post) =>
                post.id === postId ? { ...post, likes: likesCount } : post,
              ),
            })),
          )
          .catch(() =>
            // Revertir ante fallo de red.
            set((state) => ({
              likedPostIds: wasLiked
                ? [...state.likedPostIds, postId]
                : state.likedPostIds.filter((id) => id !== postId),
              likeCounts: { ...state.likeCounts, [postId]: contadorActual },
              posts: state.posts.map((post) =>
                post.id === postId
                  ? { ...post, likes: Math.max(0, post.likes + (wasLiked ? 1 : -1)) }
                  : post,
              ),
            })),
          );
      },

      aplicarLikesDelServidor: (idsDeLaTanda, idsConMeGusta, contadores) => {
        if (idsDeLaTanda.length === 0) return;
        // La regla de mezcla vive en `lib/reacciones` y esta probada alli: es
        // donde estaba el fallo y donde tiene que quedar fijado.
        set((state) => ({
          likedPostIds: mezclarReacciones(state.likedPostIds, idsDeLaTanda, idsConMeGusta),
          likeCounts: contadores ? { ...state.likeCounts, ...contadores } : state.likeCounts,
        }));
      },
      toggleSavePost: (postId) => {
        const wasSaved = get().savedPostIds.includes(postId);
        set((state) => ({
          savedPostIds: wasSaved
            ? state.savedPostIds.filter((id) => id !== postId)
            : [...state.savedPostIds, postId],
        }));

        if (!backendEnabled) return;
        const op = wasSaved ? PostRepository.unsave(postId) : PostRepository.save(postId);
        op.catch(() =>
          set((state) => ({
            savedPostIds: wasSaved
              ? [...state.savedPostIds, postId]
              : state.savedPostIds.filter((id) => id !== postId),
          })),
        );
      },
      addComment: async (postId, text) => {
        const trimmed = text.trim();
        if (!trimmed) return;

        if (backendEnabled) {
          const comment = await PostRepository.addComment(postId, trimmed);
          set((state) => ({
            posts: state.posts.map((post) =>
              post.id === postId
                ? {
                    ...post,
                    comments: [...post.comments, comment],
                    commentsCount: (post.commentsCount ?? post.comments.length) + 1,
                  }
                : post,
            ),
          }));
          return;
        }

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
      hydrateFeedFromCache: async () => {
        if (!backendEnabled) return;
        try {
          const raw = await AsyncStorage.getItem(FEED_SNAPSHOT_KEY);
          if (!raw) return;
          // La red pudo ganar a la lectura de disco: entonces no hay nada que
          // aportar, lo que se ve ya es mas fresco que la instantanea.
          if (feedLoadedFromNetwork || get().posts.length > 0) return;
          const snapshot = JSON.parse(raw) as FeedSnapshot;
          if (!Array.isArray(snapshot?.posts) || snapshot.posts.length === 0) return;
          const posts = snapshot.posts.map((post) => ({
            ...post,
            // El "hace 2 h" guardado envejecio: se recalcula desde la fecha ISO.
            createdAt: post.createdAtIso
              ? formatRelativeTime(post.createdAtIso)
              : post.createdAt,
          }));
          perfMark('FEED_CACHE_SHOWN');
          set((state) => ({
            posts,
            // Si una carga de red esta en vuelo se respeta su estado visual.
            feedStatus: state.feedStatus === 'loading' ? 'loading' : state.feedStatus,
          }));
          // Segunda fase: firmar las rutas. Con la cache de firmas persistente
          // esto se resuelve de disco, sin red, y la imagen sale al instante.
          const withUrls = await resolveMediaUrls(posts);
          if (feedLoadedFromNetwork) return;
          set((state) => ({ posts: mergeMediaUrls(state.posts, withUrls) }));
        } catch {
          // Instantanea corrupta o ilegible: la carga de red sigue su curso.
        }
      },
      loadFeed: async (feed) => {
        const kind = feed ?? get().feedKind;
        if (!backendEnabled) {
          set({ feedStatus: 'idle', feedKind: kind });
          return;
        }
        if (feedInFlight?.kind === kind) return feedInFlight.promise;
        const promise = (async () => {
          set({ feedStatus: 'loading', feedError: null, feedKind: kind });
          try {
            const uid = get().user?.id ?? null;
            const options = {
              limit: FEED_PAGE,
              offset: 0,
              feed: kind,
              // Dos fases: primero el JSON (texto + metadata), despues las
              // firmas. El primer post no espera a Storage.
              withMediaUrls: false,
              // El muro es el unico sitio donde una republicacion significa lo
              // que significa: alguien comparte algo y por eso lo estas viendo.
              withReposts: true,
            };
            let page: FeedPage;
            try {
              page = await PostRepository.listFeed(options, uid);
            } catch (error) {
              // Un unico reintento tras agotar la espera. Se mantiene porque
              // una red movil mala corta peticiones sin que el servidor tenga
              // nada que ver; el segundo intento suele bastar.
              if (error instanceof ApiError && error.code === 'timeout') {
                page = await PostRepository.listFeed(options, uid);
              } else {
                throw error;
              }
            }
            feedLoadedFromNetwork = true;
            perfMark('FEED_RESPONSE');
            set({
              posts: page.items,
              feedStatus: 'idle',
              // Lo que MANDO el servidor, no lo que sobrevivio a quitar
              // repetidas: el desplazamiento cuenta filas suyas, no nuestras.
              feedOffset: page.recibidos,
              feedHasMore: page.recibidos === FEED_PAGE,
            });
            /*
              Las reacciones se APLICAN, no se sustituyen.

              Antes esto era `likedPostIds: page.likedIds`, que borra de un
              plumazo los me gusta de cualquier publicacion que no viniera en
              esta pagina. Como Inicio y Explorar comparten la lista, cargar el
              muro apagaba los corazones de los videos de Inicio: el sintoma que
              se reporto. Se corrige solo lo que el servidor ha hablado.
            */
            const idsDeLaTanda = page.items.map((post) => post.id);
            get().aplicarLikesDelServidor(
              idsDeLaTanda,
              page.likedIds,
              Object.fromEntries(page.items.map((post) => [post.id, post.likes])),
            );
            set((state) => ({
              savedPostIds: mezclarReacciones(state.savedPostIds, idsDeLaTanda, page.savedIds),
            }));
            const withUrls = await resolveMediaUrls(page.items);
            perfMark('FEED_URLS_READY');
            set((state) => ({ posts: mergeMediaUrls(state.posts, withUrls) }));
            // Solo la pestana "Para ti" alimenta la instantanea: es la que se
            // ve al abrir la aplicacion.
            if (kind === 'all') saveFeedSnapshot(withUrls);
          } catch (error) {
            set({
              // Con contenido ya en pantalla (instantanea o carga anterior) el
              // fallo no debe taparlo: se queda lo que hay y el estado vuelve a
              // reposo. El aviso de error queda para cuando no hay nada que ver.
              feedStatus: get().posts.length > 0 ? 'idle' : 'error',
              feedError: error instanceof Error ? error.message : 'No se pudo cargar el feed.',
            });
          } finally {
            feedInFlight = null;
          }
        })();
        feedInFlight = { kind, promise };
        return promise;
      },
      loadMoreFeed: async () => {
        if (!backendEnabled) return;
        const { feedHasMore, feedLoadingMore, feedOffset } = get();
        if (!feedHasMore || feedLoadingMore) return;
        set({ feedLoadingMore: true });
        try {
          const uid = get().user?.id ?? null;
          const page = await PostRepository.listFeed(
            {
              limit: FEED_PAGE,
              offset: feedOffset,
              feed: get().feedKind,
              withReposts: true,
            },
            uid,
          );
          set((state) => {
            /*
              Ni una publicacion dos veces en la lista.

              `listFeed` ya quita las repetidas DENTRO de su pagina, pero no
              puede saber lo que hay en pantalla de las anteriores: alguien
              republica algo que ya se leyo hace tres paginas y vuelve a llegar.
              Aqui si se sabe.

              El «¿hay mas?» y el desplazamiento siguen contando `recibidos`, lo
              que mando el servidor. Si contaran lo que sobrevive, quitar una
              repetida pararia el scroll antes de tiempo.
            */
            const yaEstan = new Set(state.posts.map((post) => post.id));
            const nuevas = page.items.filter((post) => !yaEstan.has(post.id));
            return {
              posts: [...state.posts, ...nuevas],
              likedPostIds: Array.from(new Set([...state.likedPostIds, ...page.likedIds])),
              savedPostIds: Array.from(new Set([...state.savedPostIds, ...page.savedIds])),
              feedOffset: state.feedOffset + page.recibidos,
              feedHasMore: page.recibidos === FEED_PAGE,
              feedLoadingMore: false,
            };
          });
        } catch {
          set({ feedLoadingMore: false });
        }
      },
      loadCommentsFor: async (postId) => {
        if (!backendEnabled) return;
        try {
          const comments = await PostRepository.listComments(postId);
          set((state) => ({
            posts: state.posts.map((post) =>
              post.id === postId ? { ...post, comments } : post,
            ),
          }));
        } catch {
          // Silencioso: la tarjeta conserva el contador del feed.
        }
      },
      toggleReservation: (eventId) =>
        set((state) => ({
          reservedEventIds: state.reservedEventIds.includes(eventId)
            ? state.reservedEventIds.filter((id) => id !== eventId)
            : [...state.reservedEventIds, eventId],
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
          conversations,
          dismissedGuides: [],
          // Se vuelve a preguntar el idioma porque se esta empezando de cero,
          // no porque el idioma «se rompa»: es un reinicio de datos de demo.
          idiomaElegido: null,
        }),
    }),
    {
      // NO CAMBIAR este nombre aunque el producto se llame ahora Z: es la clave
      // con la que se guardan las preferencias en el dispositivo. Renombrarla
      // haria que la aplicacion no encontrara lo guardado y todo el mundo
      // perderia sus ajustes al actualizar.
      name: 'renaser-universo-v1',
      storage: createJSONStorage(() => AsyncStorage),
      /*
        VERSION 1: el idioma pasa de dos campos (`language` + `languageSelected`)
        a uno solo (`idiomaElegido`, `null` = sin elegir).

        La migracion existe para que a NADIE que ya hubiera elegido se le vuelva
        a preguntar al actualizar: se lee lo guardado por la version anterior y
        se traduce. La regla vive en `@/lib/idioma` y esta probada aparte
        (`idioma.test.mts`).
      */
      version: 1,
      migrate: (guardado, version) => {
        const estado = { ...(guardado as Record<string, unknown> | null) };
        if (version < 1) {
          estado.idiomaElegido = migraIdiomaGuardado(estado);
          delete estado.language;
          delete estado.languageSelected;
        }
        return estado as Partial<AppState>;
      },
      // Solo se persisten preferencias y estado ligero del usuario.
      // `posts` y `conversations` quedan FUERA a proposito: son colecciones sin
      // techo que se repueblan con loadFeed()/los repositorios, y persistirlas
      // obligaba a reserializar todo el feed a AsyncStorage en cada like (jank
      // de disco y riesgo de superar la cuota de SQLite).
      partialize: (state: AppState) => ({
        themeMode: state.themeMode,
        user: state.user,
        onboardingComplete: state.onboardingComplete,
        dismissedGuides: state.dismissedGuides,
        // La eleccion de idioma, y nada mas: el idioma «efectivo» se calcula,
        // no se guarda, para que no pueda volver a confundirse con ella.
        idiomaElegido: state.idiomaElegido,
        quizAnswers: state.quizAnswers,
        quizResult: state.quizResult,
        likedPostIds: state.likedPostIds,
        savedPostIds: state.savedPostIds,
        reservedEventIds: state.reservedEventIds,
      }),
      // La firma real es (state, error). Si la rehidratacion falla, `state` llega
      // undefined y el arranque se quedaba bloqueado para siempre en el splash.
      // Marcamos hidratado SIEMPRE para que la app pueda continuar.
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          console.warn('[store] fallo la rehidratacion; se continua con estado en memoria', error);
        }
        if (state) state.setHydrated(true);
        else useAppStore.setState({ hydrated: true });
      },
    },
  ),
);
