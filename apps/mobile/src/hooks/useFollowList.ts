import { useCallback } from 'react';

import { ProfileRepository } from '@/repositories/ProfileRepository';
import { useListaDePersonas } from '@/hooks/useListaDePersonas';

export type FollowListKind = 'followers' | 'following';

/**
 * Seguidores o seguidos de un perfil, con seguir/dejar de seguir real.
 *
 * Antes ambas pantallas pintaban la gente de `mockData`, asi que cualquier
 * usuario veia siempre a las mismas personas inventadas, y el boton "Seguir"
 * solo cambiaba un `useState` que se perdia al salir.
 *
 * El cómo (estado, reintento, seguir de forma optimista) vive en
 * `useListaDePersonas`, que comparte con la lista de quién reaccionó: es la
 * misma pantalla con otra fuente.
 */
export function useFollowList(profileId: string | undefined, kind: FollowListKind) {
  const cargar = useCallback(async () => {
    if (!profileId) return [];
    return kind === 'followers'
      ? ProfileRepository.listFollowers(profileId)
      : ProfileRepository.listFollowing(profileId);
  }, [profileId, kind]);

  return useListaDePersonas(profileId ? cargar : null);
}
