import { useAppStore } from '@/store/useAppStore';

/**
 * Destino tras autenticarse.
 *
 * Quien no sigue a nadie pasa por "Miembros RENASER" para que su feed no
 * empiece vacio; quien ya sigue a alguien va directo al home. Al ser una
 * condicion sobre el estado real (y no una bandera guardada), la pantalla deja
 * de aparecer sola en cuanto el usuario sigue a alguien.
 */
export function postAuthRoute(): string {
  const user = useAppStore.getState().user;
  return (user?.following ?? 0) === 0 ? '/members' : '/(tabs)/home';
}
