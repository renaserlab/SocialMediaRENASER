import { AuthRepository } from '@/repositories/AuthRepository';
import { usePreferenciasStore } from '@/store/usePreferenciasStore';
import { useAuthStore } from '@/store/useAuthStore';

/**
 * Destino tras autenticarse.
 *
 * El orden dice lo que el producto considera importante, y por eso vive en una
 * sola funcion en vez de repetido en cada pantalla de acceso:
 *
 *   1. El cuestionario de recomendacion, si esta persona todavia no ha pasado
 *      por el. Sin saber que busca, Z no puede recomendarle nada.
 *   2. "Miembros RENASER", para que el feed no empiece vacio. La propia
 *      pantalla se salta sola si ya sigue a los destacados.
 *   3. El feed, en modo demo (sin backend no hay a quien seguir ni que
 *      preguntar).
 *
 * Quien llama debe haber resuelto antes el estado del cuestionario
 * (`usePreferenciasStore.cargarEstado`). Si no lo hizo, sale 'desconocido' y se
 * sigue de largo: nunca se retiene a nadie por no saber.
 */
export function postAuthRoute(): string {
  if (!useAuthStore.getState().supabaseEnabled) return '/(tabs)/home';
  if (usePreferenciasStore.getState().estado === 'pendiente') return '/onboarding';
  return '/members';
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
