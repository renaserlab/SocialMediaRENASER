import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { gateFor, hasPendingUnlocks, type EpisodeGate } from '@/lib/podcastUnlock';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import { useAppStore } from '@/store/useAppStore';

/**
 * Estado de desbloqueo de los episodios para QUIEN mira, no para el dueño del
 * perfil: el podcast vive en el perfil de RENASER pero la cuenta atrás es de
 * cada persona, y arranca la primera vez que abre la sección.
 *
 * Sobre el paso del tiempo: el intervalo de un segundo solo mueve el número en
 * pantalla. Lo que decide si un episodio está abierto es la comparación contra
 * el instante guardado en el servidor, así que la espera avanza igual con la
 * app cerrada o el móvil apagado. Por eso además se recalcula al volver del
 * segundo plano, donde el sistema congela los temporizadores.
 *
 * @param enabled `false` en las vistas donde no hace falta (evita el reloj y la
 *                llamada de arranque).
 */
export function usePodcastUnlock(enabled = true): (index: number) => EpisodeGate {
  const startedAtIso = useAppStore((state) => state.user?.podcastStartedAt ?? null);
  const isAdmin = useAppStore((state) => state.user?.isAdmin === true);
  const setUser = useAppStore((state) => state.setUser);

  const [now, setNow] = useState(() => Date.now());
  const startedAt = startedAtIso ? Date.parse(startedAtIso) : null;

  // Primera visita: se pide al backend que fije el origen. Es idempotente, así
  // que volver a entrar no reinicia nada. Si falla (sin red) no se bloquea la
  // vista: se sigue con el origen provisional "ahora" y se reintenta al volver.
  useEffect(() => {
    if (!enabled || startedAtIso) return;
    let cancelled = false;
    void ProfileRepository.startPodcastDrip()
      .then((profile) => {
        if (!cancelled) setUser(profile);
      })
      .catch(() => {
        /* Sin conexión se reintenta en la siguiente entrada al podcast. */
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, startedAtIso, setUser]);

  const ticking = enabled && !isAdmin && hasPendingUnlocks(startedAt, now);

  useEffect(() => {
    if (!ticking) return;
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 1000);
    // Al reanudar, el reloj de la app puede llevar horas parado.
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') tick();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [ticking]);

  // Quien administra sube los episodios: tiene que poder escucharlos al subirlos.
  // Se le exime de la ESPERA (origen en el pasado), no de la lista: los huecos
  // de membresía se siguen viendo igual que los ve cualquier otra persona.
  const origin = isAdmin ? 0 : startedAt;
  return (index: number) => gateFor(index, origin, now);
}
