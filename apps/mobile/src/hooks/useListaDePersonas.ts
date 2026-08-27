import { useCallback, useEffect, useState } from 'react';

import type { PersonRow } from '@/components/PeopleList';
import type { ProfileSummary } from '@/mappers/profileMapper';
import { AuthRepository } from '@/repositories/AuthRepository';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import { profileImageUrl } from '@/services/storage';

/**
 * Una lista de personas con su botón de seguir, venga de donde venga.
 *
 * Nació al añadir «quién reaccionó»: esa pantalla necesita exactamente lo mismo
 * que seguidores y seguidos —cargar, reintentar, y seguir/dejar de seguir de
 * forma optimista— y lo único que cambia es de dónde sale la gente. Copiar el
 * hook entero por tercera vez habría dejado tres sitios donde arreglar el
 * mismo fallo.
 *
 * `cargar` a null significa «todavía no hay nada que pedir» (falta el id, o no
 * hay backend): se responde con la lista vacía y sin quedarse cargando.
 */
export function useListaDePersonas(cargar: (() => Promise<ProfileSummary[]>) | null) {
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!cargar || !AuthRepository.enabled) {
      setPeople([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await cargar();
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
  }, [cargar]);

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
