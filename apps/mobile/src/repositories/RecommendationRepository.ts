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
  content_topics_available?: boolean;
  course_topics_available?: boolean;
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
  /**
   * En que puesto lo puso el SERVIDOR. Viaja de vuelta en la impresion: lo
   * primero se toca mas, sea bueno o no, y sin la posicion las tasas no se
   * pueden leer.
   */
  rank: number;
};

export type PeopleRecommendations = {
  items: RecommendedPerson[];
  /**
   * Con que version del algoritmo se ordeno esta lista. Viaja de vuelta en cada
   * impresion: sin ella, dos ordenaciones distintas se mezclan en la misma
   * metrica y no hay forma de saber cual de las dos funcionaba.
   *
   * La decide el SERVIDOR. Escrita en el movil, una version antigua de la
   * aplicacion mediria para siempre contra una etiqueta equivocada.
   */
  algorithmVersion: string;
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
    rank: number;
  }>;
};

/* -------------------------------------------------------------- Contenido -- */

export type ContentRecommendations = {
  items: Post[];
  algorithmVersion: string;
  strategy: 'personalized' | 'cold_start' | 'disabled';
};

type ContentDto = {
  algorithm_version: string;
  strategy: ContentRecommendations['strategy'];
  with_own_topics: number;
  items: PostDto[];
};

/* ---------------------------------------------------------------- Senales -- */

/**
 * Donde se mostro algo. Los valores los fija el servidor (migracion 0027): una
 * superficie escrita a mano en dos sitios acaba siendo dos superficies y las
 * metricas dejan de sumar.
 */
export type Superficie =
  | 'people_for_you'
  | 'for_you_feed'
  | 'following_feed'
  | 'search'
  | 'profile';

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
  /**
   * De donde venia. Los tres son opcionales: una accion sin superficie es una
   * accion que ocurrio FUERA de una recomendacion —un perfil abierto desde un
   * comentario— y eso es informacion, no un hueco que rellenar.
   */
  surface?: Superficie;
  algorithmVersion?: string;
  rank?: number;
};

/* ------------------------------------------------------- Oferta publica -- */

/**
 * Las tres unicas formas de OFRECER algo. La otra mitad del recomendador
 * —`interest`, `learn`, `seek_guidance`— es privada y no viaja por aqui.
 */
export type RelacionDeOferta = 'can_help' | 'teach' | 'experienced';

/** Un tema que alguien declara poder aportar, y en que forma. */
export type OfferedTopic = {
  topicId: string;
  name: string;
  relations: Array<RelacionDeOferta>;
};

type OfferedTopicDto = {
  topic_id: string;
  name: string;
  relations: string[];
};

type ProfileOfferDto = {
  topics: OfferedTopicDto[];
};

/**
 * Relaciones que ESTA version de la aplicacion sabe escribir en castellano.
 *
 * Si el servidor gana una relacion nueva, una aplicacion vieja la recibiria sin
 * saber traducirla; se descarta aqui, en la frontera, para que ninguna pantalla
 * tenga que decidir que hacer con un codigo crudo como `mentors`.
 */
const RELACIONES_CONOCIDAS: readonly string[] = ['can_help', 'teach', 'experienced'];

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

  /**
   * Solo los temas, para el selector de Crear y Editar.
   *
   * Reutiliza el catalogo del cuestionario en vez de tener su propio endpoint:
   * es la MISMA taxonomia, y dos fuentes para la misma lista acaban
   * discrepando.
   */
  async listTopics(para: 'contenido' | 'curso' = 'contenido'): Promise<TopicDto[]> {
    const dto = await apiRequest<CatalogDto>(`${API_V1}/recommendations/onboarding/catalog`);
    /*
      Lista vacia cuando el servidor NO puede guardar los temas de ESO.

      El selector se esconde solo al no recibir ninguno (ver `SelectorDeTemas`),
      que es justo lo que tiene que pasar: ofrecer «elige hasta 3 temas» y luego
      descartarlos en silencio seria prometer algo que no se cumple.

      Son dos banderas distintas porque son dos migraciones distintas: las
      publicaciones pueden llevar temas desde la 0027 y los cursos desde la
      0028, y una puede estar aplicada sin la otra.
    */
    const disponible =
      para === 'curso' ? dto.course_topics_available : dto.content_topics_available;
    if (disponible === false) return [];
    return dto.topics;
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
      algorithmVersion: dto.algorithm_version,
      strategy: dto.strategy,
      items: dto.items.map((item) => ({
        id: item.id,
        fullName: item.full_name,
        username: item.username,
        avatarPath: item.avatar_path,
        bio: item.bio,
        isFollowing: item.is_following,
        reasons: item.reasons ?? [],
        rank: item.rank ?? 0,
      })),
    };
  },

  /**
   * Contenido recomendado. Los elementos son `Post` normales —el mismo mapper
   * que el feed cronologico—, envueltos en el contexto necesario para poder
   * medir: la version del algoritmo la decide el SERVIDOR, y si el movil la
   * llevara escrita en su codigo, una version antigua de la aplicacion mediria
   * contra una etiqueta equivocada.
   */
  async listContent(
    {
      limit = 6,
      offset = 0,
      media,
    }: { limit?: number; offset?: number; media?: 'video' | 'image' } = {},
    currentUserId?: string | null,
  ): Promise<ContentRecommendations> {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (media) params.set('media', media);
    const dto = await apiRequest<ContentDto>(
      `${API_V1}/recommendations/content?${params.toString()}`,
    );
    return {
      algorithmVersion: dto.algorithm_version,
      strategy: dto.strategy,
      items: (dto.items ?? []).map((item) => toPost(item, currentUserId)),
    };
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
              surface: e.surface ?? null,
              algorithm_version: e.algorithmVersion ?? null,
              rank: e.rank ?? null,
            })),
          }),
        },
      );
    } catch (error) {
      // Se registra pero no se propaga: medir no puede estropear el uso.
      console.warn('[recomendaciones] no se pudieron enviar las senales', error);
    }
  },

  /**
   * Lo que una persona declara poder APORTAR. Solo eso.
   *
   * No existe el endpoint simetrico —«que busca esta persona»— y no es un
   * olvido del backend: la demanda es privada. Ofrecerse a ensenar carpinteria
   * es una declaracion que alguien hace para que le encuentren; buscar
   * orientacion sobre su familia, no. Como la demanda no cabe en el contrato,
   * no puede escaparse a un perfil publico aunque la interfaz se equivoque.
   *
   * `relations` llega filtrada: ver `RELACIONES_CONOCIDAS`.
   */
  async getProfileOffer(profileId: string): Promise<OfferedTopic[]> {
    const dto = await apiRequest<ProfileOfferDto>(
      `${API_V1}/recommendations/profiles/${profileId}/offer`,
    );
    return (dto.topics ?? []).map((tema) => ({
      topicId: tema.topic_id,
      name: tema.name,
      relations: (tema.relations ?? []).filter((r): r is RelacionDeOferta =>
        RELACIONES_CONOCIDAS.includes(r),
      ),
    }));
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
