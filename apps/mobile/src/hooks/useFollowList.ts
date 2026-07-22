import { useCallback, useEffect, useState } from 'react';

import type { PersonRow } from '@/components/PeopleList';
import { AuthRepository } from '@/repositories/AuthRepository';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import { profileImageUrl } from '@/services/storage';

export type FollowListKind = 'followers' | 'following';

/**
 * Seguidores o seguidos de un perfil, con seguir/dejar de seguir real.
 *
 * Antes ambas pantallas pintaban la gente de `mockData`, asi que cualquier
 * usuario veia siempre a las mismas personas inventadas, y el boton "Seguir"
 * solo cambiaba un `useState` que se perdia al salir.
 */
export function useFollowList(profileId: string | undefined, kind: FollowListKind) {
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profileId || !AuthRepository.enabled) {
      setPeople([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list =
        kind === 'followers'
          ? await ProfileRepository.listFollowers(profileId)
          : await ProfileRepository.listFollowing(profileId);
      setPeople(
        list.map((p) => ({
          id: p.id,
          fullName: p.fullName,
          username: p.username,
          avatarUrl: profileImageUrl(p.avatarPath) ?? undefined,
          isFollowing: p.isFollowing,
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar la lista.');
    } finally {
      setLoading(false);
    }
  }, [profileId, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Alterna el seguimiento de forma optimista y revierte si el envio falla. */
  const toggleFollow = useCallback(async (person: PersonRow) => {
    const wasFollowing = person.isFollowing === true;
    setPeople((prev) =>
      prev.map((p) => (p.id === person.id ? { ...p, isFollowing: !wasFollowing } : p)),
    );
    try {
      if (wasFollowing) await ProfileRepository.unfollow(person.id);
      else await ProfileRepository.follow(person.id);
    } catch {
      setPeople((prev) =>
        prev.map((p) => (p.id === person.id ? { ...p, isFollowing: wasFollowing } : p)),
      );
    }
  }, []);

  return { people, loading, error, reload: load, toggleFollow };
}
