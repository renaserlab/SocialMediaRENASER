import { AuthRepository } from '@/repositories/AuthRepository';
import { usePreferenciasStore } from '@/store/usePreferenciasStore';
import { useAuthStore } from '@/store/useAuthStore';

/**
 * Destino tras autenticarse.
 *
 * Solo queda UNA parada posible antes del feed, y es la que el producto exige:
 * el cuestionario de recomendacion, cuando esta persona todavia no ha pasado
 * por el. Sin saber que busca, Z no puede recomendarle nada; por eso ese si se
 * queda.
 *
 * LO QUE SE QUITO Y POR QUE. Antes se pasaba por «Miembros RENASER»
 * (`/members`) con la idea de que el feed no empezara vacio. En produccion esa
 * pantalla ensena UN solo perfil, un boton «Ahora no» y media pantalla en
 * blanco: no es un paso de alta, es un resto de cuando la app se demostraba con
 * datos de ejemplo. Interrumpir el acceso para eso cuesta mas de lo que aporta,
 * asi que se sale directamente al flujo normal. La ruta sigue existiendo —el
 * fichero de `app/` NO se toca: en Expo Router la ruta ES el fichero— pero ya
 * no forma parte del camino posterior al inicio de sesion.
 *
 * Quien llama debe haber resuelto antes el estado del cuestionario
 * (`usePreferenciasStore.cargarEstado`). Si no lo hizo, sale 'desconocido' y se
 * sigue de largo: nunca se retiene a nadie por no saber.
 */
export function postAuthRoute(): string {
  if (!useAuthStore.getState().supabaseEnabled) return '/(tabs)/home';
  if (usePreferenciasStore.getState().estado === 'pendiente') return '/onboarding';
  return '/(tabs)/home';
}

/**
 * Lo mismo, pero resolviendo antes si toca el cuestionario.
 *
 * Es la version que usan las pantallas de acceso. Ahi SI se puede esperar un
 * instante: la persona acaba de pulsar «entrar» y ya cuenta con que algo pase.
 * En el arranque, en cambio, esa espera seria una rueda girando sin motivo, y
 * por eso alli se usa la version sincrona con lo que ya se sepa.
 *
 * El identificador sale de la SESION y no del perfil: el perfil se carga en
 * paralelo y puede no haber llegado todavia.
 */
export async function rutaTrasAutenticar(): Promise<string> {
  if (!useAuthStore.getState().supabaseEnabled) return '/(tabs)/home';
  try {
    const session = await AuthRepository.getSession();
    const usuarioId = session?.user?.id;
    if (usuarioId) await usePreferenciasStore.getState().cargarEstado(usuarioId);
  } catch (error) {
    // No poder preguntarlo no puede impedir entrar: se sigue sin cuestionario.
    console.warn('[acceso] no se pudo resolver el cuestionario', error);
  }
  return postAuthRoute();
}
