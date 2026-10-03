import React from 'react';

import { AdminServiciosCondicionesScreen } from '@/screens/AdminServiciosCondicionesScreen';

/** Las condiciones de CONTRATACIÓN (Incremento 5): las acepta quien contrata. */
export default function CondicionesDeContratacion() {
  return <AdminServiciosCondicionesScreen tipo="booking_terms" />;
}
