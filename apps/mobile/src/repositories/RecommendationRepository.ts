import { apiRequest, API_V1 } from '@/services/api';
import { toPost, type PostDto } from '@/mappers/postMapper';
import type { Post } from '@/types';

/**
 * El recomendador, visto desde el movil.
 *
 * La identidad NUNCA viaja en estas peticiones: el backend la saca del JWT. No
 * hay forma de pedir las recomendaciones —ni de escribir las preferencias— de
 * otra persona, porque no hay parametro por donde intentarlo.
 */

/* --------------------------------------------------------------- Catalogo -- */

export type TopicDto = {
  id: string;
  slug: string;
  name: string;
  group: string;
  position: number;
};

export type OptionDto = {
  key: string;
  label: string;
  help: string;
};

export type OnboardingCatalog = {
  onboardingVersion: number;
  /** Temas agrupados como los pinta el cuestionario, en el orden del servidor. */
  topics: TopicDto[];
  goals: OptionDto[];
  connectionTypes: OptionDto[];
  contentFormats: OptionDto[];
  offerModes: OptionDto[];
};

type CatalogDto = {
  onboarding_version: number;
  topics: TopicDto[];
  goals: OptionDto[];
  connection_types: OptionDto[];
  content_formats: OptionDto[];
  offer_modes: OptionDto[];
};

/* ----------------------------------------------------------------- Estado -- */

export type OnboardingStatus = {
  /** Si hay que ensenarle el cuestionario a esta persona. Lo decide el servidor. */
  shouldShow: boolean;
  completed: boolean;
  skipped: boolean;
};

type StatusDto = {
  completed: boolean;
  should_show: boolean;
  onboarding_version: number;
  current_version: number;
  skipped: boolean;
  completed_at: string | null;
};

/* ----------------------------------------------------------- Preferencias -- */

export type PreferencesInput = {
  goals: string[];
  learningTopicIds: string[];
  connectionTypes: string[];
  contentFormats: string[];
  offerModes: string[];
  offerTopicIds: string[];
  skipped?: boolean;
};

export type Preferences = PreferencesInput & { completed: boolean };

type PreferencesDto = {
  goals: string[];
  learning_topic_ids: string[];
  connection_types: string[];
  content_formats: string[];
  offer_modes: string[];
  offer_topic_ids: string[];
  completed_at: string | null;
  skipped: boolean;
};

/* --------------------------------------------------------------- Personas -- */

export type RecommendationReason = {
  /** TOPIC_MATCH, TEACHES, CAN_HELP... La frase la redacta la interfaz. */
  code: string;
  /** Nombres de tema legibles. Vacio en los motivos que no deben nombrar temas. */
  topics: string[];
};

export type RecommendedPerson = {
  id: string;
  fullName: string;
  username: string | null;
  avatarPath: string | null;
  bio: string;
  isFollowing: boolean;
  reasons: RecommendationReason[];
};

export type PeopleRecommendations = {
  items: RecommendedPerson[];
  /**
   * `personalized` = hubo con que personalizar.
   * `cold_start`   = es un respaldo, y la pantalla puede decirlo.
   * `disabled`     = la personalizacion esta apagada en el servidor.
   */
  strategy: 'personalized' | 'cold_start' | 'disabled';
};

type PeopleDto = {
  algorithm_version: string;
  strategy: PeopleRecommendations['strategy'];
  items: Array<{
    id: string;
    full_name: string;
    username: string | null;
    avatar_path: string | null;
    bio: string;
    is_following: boolean;
    reasons: RecommendationReason[];
  }>;
};

/* ---------------------------------------------------------------- Senales -- */

export type BehaviorEvent = {
  eventType:
    | 'content_impression'
    | 'content_engaged'
    | 'content_completed'
    | 'profile_view'
    | 'search_result_opened'
    | 'not_interested';
  entityType: 'post' | 'profile' | 'course' | 'booking' | 'conversation';
  entityId?: string | null;
  /** Proporcion vista (0..1). */
  value?: number;
  dwellMs?: number;
  /** Idempotencia: reintentar un lote no debe duplicar sus senales. */
  eventKey?: string;
};

export const RecommendationRepository = {
  async getOnboardingStatus(signal?: AbortSignal): Promise<OnboardingStatus> {
    const dto = await apiRequest<StatusDto>(`${API_V1}/recommendations/onboarding/status`, {
      signal,
      // El arranque no puede quedarse esperando al servidor: si tarda mas de
      // esto, se sigue sin el (ver `usePreferenciasStore`).
      timeoutMs: 8000,
    });
    return {
      shouldShow: dto.should_show,
      completed: dto.completed,
      skipped: dto.skipped,
    };
  },

  async getCatalog(): Promise<OnboardingCatalog> {
    const dto = await apiRequest<CatalogDto>(`${API_V1}/recommendations/onboarding/catalog`);
    return {
      onboardingVersion: dto.onboarding_version,
      topics: dto.topics,
      goals: dto.goals,
      connectionTypes: dto.connection_types,
      contentFormats: dto.content_formats,
      offerModes: dto.offer_modes,
    };
  },

  async getPreferences(): Promise<Preferences> {
    const dto = await apiRequest<PreferencesDto>(`${API_V1}/recommendations/preferences`);
    return toPreferences(dto);
  },

  /**
   * Guarda (reemplaza) las respuestas. Es PUT porque es idempotente: pulsar
   * dos veces guardar deja el mismo estado, que es lo que hace falta cuando la
   * red obliga a reintentar.
   */
  async savePreferences(input: PreferencesInput): Promise<Preferences> {
    const dto = await apiRequest<PreferencesDto>(`${API_V1}/recommendations/preferences`, {
      method: 'PUT',
      body: JSON.stringify({
        goals: input.goals,
        learning_topic_ids: input.learningTopicIds,
        connection_types: input.connectionTypes,
        content_formats: input.contentFormats,
        offer_modes: input.offerModes,
        offer_topic_ids: input.offerTopicIds,
        skipped: input.skipped ?? false,
      }),
    });
    return toPreferences(dto);
  },

  async listPeople(
    { limit = 10, offset = 0 }: { limit?: number; offset?: number } = {},
  ): Promise<PeopleRecommendations> {
    const dto = await apiRequest<PeopleDto>(
      `${API_V1}/recommendations/people?limit=${limit}&offset=${offset}`,
    );
    return {
      strategy: dto.strategy,
      items: dto.items.map((item) => ({
        id: item.id,
        fullName: item.full_name,
        username: item.username,
        avatarPath: item.avatar_path,
        bio: item.bio,
        isFollowing: item.is_following,
        reasons: item.reasons ?? [],
      })),
    };
  },

  /**
   * Contenido recomendado, con la MISMA forma que el feed normal. Por eso la
   * pantalla no distingue una fuente de otra.
   */
  async listContent(
    {
      limit = 6,
      offset = 0,
      media,
    }: { limit?: number; offset?: number; media?: 'video' | 'image' } = {},
    currentUserId?: string | null,
  ): Promise<Post[]> {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (media) params.set('media', media);
    const dtos = await apiRequest<PostDto[]>(
      `${API_V1}/recommendations/content?${params.toString()}`,
    );
    return dtos.map((dto) => toPost(dto, currentUserId));
  },

  /**
   * Envia un lote de senales. NUNCA lanza: una senal perdida es un dato menos,
   * pero un error aqui interrumpiria lo que la persona estaba haciendo.
   */
  async sendEvents(events: BehaviorEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
      await apiRequest<{ accepted: number; duplicated: number }>(
        `${API_V1}/recommendations/events`,
        {
          method: 'POST',
          body: JSON.stringify({
            events: events.map((e) => ({
              event_type: e.eventType,
              entity_type: e.entityType,
              entity_id: e.entityId ?? null,
              value: e.value ?? null,
              dwell_ms: e.dwellMs ?? null,
              event_key: e.eventKey ?? null,
            })),
          }),
        },
      );
    } catch (error) {
      // Se registra pero no se propaga: medir no puede estropear el uso.
      console.warn('[recomendaciones] no se pudieron enviar las senales', error);
    }
  },
};

function toPreferences(dto: PreferencesDto): Preferences {
  return {
    goals: dto.goals ?? [],
    learningTopicIds: dto.learning_topic_ids ?? [],
    connectionTypes: dto.connection_types ?? [],
    contentFormats: dto.content_formats ?? [],
    offerModes: dto.offer_modes ?? [],
    offerTopicIds: dto.offer_topic_ids ?? [],
    skipped: dto.skipped,
    completed: dto.completed_at !== null,
  };
}
