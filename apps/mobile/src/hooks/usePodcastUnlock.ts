import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { DRIP_EPISODES, gateFor, hasPendingUnlocks, type EpisodeGate } from '@/lib/podcastUnlock';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';

/**
 * Origen provisional mientras el servidor no ha dado el suyo.
 *
 * Tiene que quedar CONGELADO. Si en su lugar se usara "ahora" en cada repintado,
 * la resta daría siempre el mismo resultado y la cuenta atrás se vería parada en
 * cifras redondas (08:00:00, 16:00:00...) por mucho que el reloj avanzara.
 *
 * Vive fuera del componente para que salir de la sección y volver a entrar no lo
 * reinicie. Es solo un apaño para el rato que tarda la respuesta: en cuanto
 * llega el instante del servidor, manda ese.
 */
let provisionalOrigin: number | null = null;

export type PodcastAccess = {
  /** Estado de la fila `index` (base 0). */
  gateFor: (index: number) => EpisodeGate;
  /**
   * Si procede pintar los huecos del catálogo que aún no existen. Son el
   * escaparate de la membresía, así que no se le enseñan a quien administra:
   * para quien sube los audios serían treinta candados sin sentido.
   */
  showsCatalogSlots: boolean;
};

/**
 * Acceso a los episodios para QUIEN mira, no para el dueño del perfil: el
 * podcast vive en el perfil de RENASER pero la cuenta atrás es de cada persona.
 *
 * Hay tres casos y conviene tenerlos separados:
 *
 *  - **Administración**: sin ningún bloqueo. Es quien sube los audios; verlos
 *    con candado le impediría comprobar lo que acaba de publicar.
 *  - **Con sesión iniciada**: los cinco primeros salen uno cada 8 horas desde el
 *    instante que guarda su cuenta, y del sexto en adelante es membresía.
 *  - **Sin sesión**: no se aplica la espera. La cuenta atrás cuelga de una
 *    cuenta —ahí se guarda su origen—, así que sin ella no hay nada que contar.
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
export function usePodcastUnlock(enabled = true): PodcastAccess {
  const startedAtIso = useAppStore((state) => state.user?.podcastStartedAt ?? null);
  const isAdmin = useAppStore((state) => state.user?.isAdmin === true);
  const setUser = useAppStore((state) => state.setUser);
  // Se distinguen dos cosas: si YA hay sesion (para pedir el origen al backend)
  // y si SE SABE que no la hay (para no aplicar la espera). Mientras se esta
  // comprobando no es ninguna de las dos, y ahi conviene mantener el bloqueo:
  // darlo por abierto dejaria los cinco episodios sueltos ese instante.
  const signedIn = useAuthStore((state) => state.status === 'authenticated');
  const anonymous = useAuthStore((state) => state.status === 'anonymous');

  const [now, setNow] = useState(() => Date.now());
  const startedAt = startedAtIso ? Date.parse(startedAtIso) : null;

  // Solo se cuenta el tiempo de quien tiene cuenta y no administra.
  const drips = enabled && !anonymous && !isAdmin;

  // Primera visita: se pide al backend que fije el origen. Es idempotente, así
  // que volver a entrar no reinicia nada.
  useEffect(() => {
    // El origen se pide con la sesion ya confirmada: sin token seria un 401.
    if (!drips || !signedIn || startedAtIso) return;
    let cancelled = false;
    void ProfileRepository.startPodcastDrip()
      .then((profile) => {
        if (!cancelled) setUser(profile);
      })
      .catch((error) => {
        // Sin conexión se reintenta al volver a entrar, y mientras tanto se usa
        // el origen provisional. Se avisa en desarrollo porque el síntoma (una
        // cuenta atrás que nunca persiste entre recargas) no apunta solo a su
        // causa: lo habitual es un backend sin el endpoint desplegado.
        if (__DEV__) {
          console.warn(
            '[podcast] no se pudo fijar el inicio en el servidor; la cuenta ' +
              'atrás no sobrevivirá a una recarga.',
            error,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [drips, signedIn, startedAtIso, setUser]);

  let origin: number;
  if (startedAt != null) {
    origin = startedAt;
  } else {
    provisionalOrigin ??= Date.now();
    origin = provisionalOrigin;
  }

  const ticking = drips && hasPendingUnlocks(origin, now);

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

  if (isAdmin) {
    return { gateFor: () => ({ state: 'open' }), showsCatalogSlots: false };
  }
  if (!drips) {
    // Sin sesión: no hay espera, pero el catálogo se sigue anunciando igual.
    return {
      gateFor: (index) => (index < DRIP_EPISODES ? { state: 'open' } : { state: 'membership' }),
      showsCatalogSlots: true,
    };
  }
  return { gateFor: (index) => gateFor(index, origin, now), showsCatalogSlots: true };
}
