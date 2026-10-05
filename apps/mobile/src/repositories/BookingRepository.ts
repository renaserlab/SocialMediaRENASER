import { apiRequest, API_V1 } from '@/services/api';
import { profileImageUrl } from '@/services/storage';

/**
 * La agenda: sesiones 1:1 con estado propio.
 *
 * Antes esto era un AVISO (`session_booked`) y nada mas. Un aviso se lee una
 * vez, se pierde entre los demas, y no se puede aceptar, rechazar, reprogramar
 * ni dar por hecho. Tampoco deja rastro de que dos personas se hayan visto, que
 * es lo que hara falta el dia que una resena tenga que ser verificable.
 */

/** Los estados por los que pasa una sesion. */
export type EstadoDeSesion =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'reschedule_requested'
  | 'completed'
  | 'expired';

type PerfilDto = {
  id: string;
  full_name: string;
  username: string | null;
  avatar_path: string | null;
  bio: string;
};

type SesionDto = {
  id: string;
  topic: string;
  note: string;
  status: EstadoDeSesion;
  scheduled_at: string | null;
  timezone: string | null;
  conversation_id: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  requester: PerfilDto;
  provider: PerfilDto;
  my_role: 'provider' | 'requester';
};

export type PersonaDeSesion = {
  id: string;
  nombre: string;
  usuario: string | null;
  avatarUrl?: string;
};

export type Sesion = {
  id: string;
  tema: string;
  nota: string;
  estado: EstadoDeSesion;
  /** Momento propuesto, en ISO. Nulo mientras se acuerda por chat. */
  cuandoIso: string | null;
  zonaHoraria: string | null;
  conversacionId: string | null;
  completadaIso: string | null;
  creadaIso: string;
  /** Cuándo cambió por última vez, según el servidor. */
  actualizadaIso: string;
  quienPide: PersonaDeSesion;
  quienDa: PersonaDeSesion;
  /** 'provider' = me la piden a mi; 'requester' = la pedi yo. */
  miRol: 'provider' | 'requester';
};

function aPersona(dto: PerfilDto): PersonaDeSesion {
  return {
    id: dto.id,
    nombre: dto.full_name || 'Usuario',
    usuario: dto.username ? `@${dto.username}` : null,
    avatarUrl: profileImageUrl(dto.avatar_path),
  };
}

function aSesion(dto: SesionDto): Sesion {
  return {
    id: dto.id,
    tema: dto.topic,
    nota: dto.note ?? '',
    estado: dto.status,
    cuandoIso: dto.scheduled_at,
    zonaHoraria: dto.timezone,
    conversacionId: dto.conversation_id,
    completadaIso: dto.completed_at,
    creadaIso: dto.created_at,
    actualizadaIso: dto.updated_at,
    quienPide: aPersona(dto.requester),
    quienDa: aPersona(dto.provider),
    miRol: dto.my_role,
  };
}

export const BookingRepository = {
  /**
   * `received` = las que me piden a mi; `sent` = las que he pedido yo.
   *
   * Se piden por separado y no se filtran en el movil: son las dos listas que
   * la pantalla ensena, y traerlo todo para partirlo aqui significaria pedir de
   * mas y descuadrar la paginacion en cuanto crezcan.
   */
  async list(rol: 'received' | 'sent' | 'all' = 'all'): Promise<Sesion[]> {
    const dtos = await apiRequest<SesionDto[]>(`${API_V1}/bookings?role=${rol}&limit=50`);
    return dtos.map(aSesion);
  },

  /**
   * Pide una sesion.
   *
   * No lleva quien la pide: sale del token. Si el backend encuentra una
   * solicitud pendiente con la misma persona devuelve ESA, para que tocar dos
   * veces no deje dos solicitudes identicas en su bandeja.
   */
  async create(entrada: {
    proveedorId: string;
    tema: string;
    nota?: string;
    cuandoIso?: string | null;
  }): Promise<Sesion> {
    const dto = await apiRequest<SesionDto>(`${API_V1}/bookings`, {
      method: 'POST',
      body: JSON.stringify({
        provider_id: entrada.proveedorId,
        topic: entrada.tema,
        note: entrada.nota ?? '',
        scheduled_at: entrada.cuandoIso ?? null,
        // La zona del dispositivo: sin ella «5:00 PM» no significa lo mismo
        // para las dos partes.
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
      }),
    });
    return aSesion(dto);
  },

  /** Acepta, rechaza, cancela, reprograma o da por hecha una sesion. */
  async update(
    id: string,
    estado: Exclude<EstadoDeSesion, 'pending' | 'expired'>,
    extra: { cuandoIso?: string | null } = {},
  ): Promise<Sesion> {
    const dto = await apiRequest<SesionDto>(`${API_V1}/bookings/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: estado,
        ...(extra.cuandoIso !== undefined ? { scheduled_at: extra.cuandoIso } : {}),
      }),
    });
    return aSesion(dto);
  },
};
