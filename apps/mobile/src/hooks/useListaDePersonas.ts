import { useCallback, useEffect, useState } from 'react';

import type { PersonRow } from '@/components/PeopleList';
import type { ProfileSummary } from '@/mappers/profileMapper';
import { AuthRepository } from '@/repositories/AuthRepository';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import { ApiError } from '@/services/api';
import { profileImageUrl } from '@/services/storage';
import { useAuthStore } from '@/store/useAuthStore';

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
 *
 * FALTAR LA CUENTA NO ES UN ERROR, y hasta ahora se contaba como tal. Estas
 * listas las sirve el backend solo a quien tiene sesión, así que a un visitante
 * le llegaba un 401 y la pantalla imprimía el mensaje del servidor tal cual
 * —«Falta el header Authorization Bearer»—: un texto técnico, en un cuadro de
 * error, con un botón de reintentar que no podía funcionar nunca.
 *
 * Se separa en dos cosas distintas: `error` es que algo falló, y
 * `necesitaCuenta` es que hace falta registrarse. Solo lo segundo tiene una
 * salida que sirve para algo.
 */
export function useListaDePersonas(cargar: (() => Promise<ProfileSummary[]>) | null) {
  const estadoDeSesion = useAuthStore((state) => state.status);
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [necesitaCuenta, setNecesitaCuenta] = useState(false);

  const load = useCallback(async () => {
    if (!cargar || !AuthRepository.enabled) {
      setPeople([]);
      setNecesitaCuenta(false);
      setLoading(false);
      return;
    }
    // Todavía se está averiguando si hay sesión. Preguntar ahora daría un 401
    // de quien sí tiene cuenta, y le ofreceríamos registrarse por nada.
    if (estadoDeSesion === 'loading') {
      setLoading(true);
      return;
    }
    // Sin sesión NO se pregunta. El servidor solo podría responder 401: es un
    // viaje de ida y vuelta cuya respuesta ya conocemos, y de ahí salían los
    // errores en rojo de la consola.
    if (estadoDeSesion !== 'authenticated') {
      setPeople([]);
      setError(null);
      setNecesitaCuenta(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setNecesitaCuenta(false);
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
      // La sesión que creíamos tener ya no vale: mismo destino, entrar.
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setNecesitaCuenta(true);
      } else {
        setError(err instanceof Error ? err.message : 'No se pudo cargar la lista.');
      }
    } finally {
      setLoading(false);
    }
  }, [cargar, estadoDeSesion]);

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

  return { people, loading, error, necesitaCuenta, reload: load, toggleFollow };
}
