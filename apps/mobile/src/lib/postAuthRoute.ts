import { useAuthStore } from '@/store/useAuthStore';

/**
 * Destino tras autenticarse.
 *
 * Todos pasan por "Miembros RENASER" salvo el modo demo (sin backend, no hay a
 * quien seguir). La propia pantalla decide si hay algo que sugerir: si el
 * usuario ya sigue a los destacados (o es Darren), se salta sola al home. Asi
 * la condicion es "¿sigues a Darren?", no "¿sigues a alguien?".
 */
export function postAuthRoute(): string {
  return useAuthStore.getState().supabaseEnabled ? '/members' : '/(tabs)/home';
}
