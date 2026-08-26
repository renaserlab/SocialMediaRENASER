import { apiRequest, API_V1 } from '@/services/api';
import { profileImageUrl } from '@/services/storage';
import type { PersonaEtiquetada } from '@/types';

type CandidatoDto = {
  id: string;
  full_name: string;
  username: string | null;
  avatar_path: string | null;
};

/**
 * A quién se puede etiquetar en una publicación.
 *
 * ES DISTINTO DE `ProfileRepository.search`, y la diferencia importa: esta
 * lista EXCLUYE a quien está bloqueado en cualquiera de los dos sentidos, así
 * que el límite se nota donde tiene que notarse —la persona no aparece— en vez
 * de en un error al publicar. La decisión la toma el servidor, que es el único
 * que sabe quién bloqueó a quién y el único al que se le puede creer.
 *
 * EXIGE SESIÓN, al contrario que buscar etiquetas: el resultado depende de
 * quién pregunta.
 */
export const MencionRepository = {
  async buscarCandidatos(termino: string, limite = 20): Promise<PersonaEtiquetada[]> {
    const limpio = termino.trim();
    // Con una sola letra el resultado sería «casi todo el mundo», que no ayuda
    // a elegir. El backend aplica el mismo mínimo; aquí se evita el viaje.
    if (limpio.length < 2) return [];
    const dtos = await apiRequest<CandidatoDto[]>(
      `${API_V1}/mentions/candidates?q=${encodeURIComponent(limpio)}&limit=${limite}`,
    );
    return dtos.map((dto) => ({
      id: dto.id,
      nombre: dto.full_name || dto.username || 'Usuario',
      usuario: dto.username ?? undefined,
      avatarUrl: profileImageUrl(dto.avatar_path),
    }));
  },
};
