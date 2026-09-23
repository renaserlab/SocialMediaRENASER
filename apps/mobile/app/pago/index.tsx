import { VueltaDelPagoScreen } from '@/screens/VueltaDelPagoScreen';

/**
 * `/pago` — a donde vuelve el checkout web. Ver `payments_return_url`.
 *
 * La ruta existe porque el backend ya mandaba aqui: sin ella, quien acababa de
 * pagar caia en la pantalla de ruta desconocida de expo-router.
 */
export default VueltaDelPagoScreen;
