import React from 'react';

import { VueltaDelPagoScreen } from '@/screens/VueltaDelPagoScreen';

/**
 * `/pago/cancelado` — a donde manda la pasarela cuando se abandona el pago.
 * Ver `payments_cancel_url`.
 *
 * SE LE PREGUNTA AL SERVIDOR IGUAL QUE EN LA OTRA RUTA. Haber vuelto por aqui
 * NO demuestra que no se haya cobrado: entre que la pasarela cobra y el
 * navegador vuelve puede pasar de todo. `cancelada` solo cambia las PALABRAS
 * cuando el servidor confirma que no hubo cobro.
 */
export default function PagoCancelado() {
  return <VueltaDelPagoScreen cancelada />;
}
