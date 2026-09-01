import React, { useCallback, useEffect, useState } from 'react';

import { Toast } from '@/components/Toast';
import { registerToastHost, type ToastRequest } from '@/lib/toast';

/** Identifica cada aviso para poder remontar el Toast y reiniciar su animacion. */
let counter = 0;

/**
 * Toast de confirmaciones de exito. Se monta UNA vez en el layout raiz.
 *
 * Un toast nuevo SUSTITUYE al anterior en vez de encolarse: al contrario que el
 * dialogo, aqui no hay nada que decidir y lo ultimo que hizo el usuario es lo
 * relevante. El cambio de `key` remonta el componente, con lo que la animacion
 * y el temporizador vuelven a empezar; sin eso, el segundo aviso heredaba el
 * tiempo restante del primero y podia desaparecer al instante.
 */
export function ToastHost() {
  const [current, setCurrent] = useState<(ToastRequest & { id: number }) | null>(null);

  const present = useCallback((request: ToastRequest) => {
    setCurrent({ ...request, id: ++counter });
  }, []);

  useEffect(() => {
    registerToastHost(present);
    return () => registerToastHost(null);
  }, [present]);

  if (!current) return null;

  return (
    <Toast
      key={current.id}
      visible
      message={current.message}
      icon={current.icon}
      accion={current.accion}
      onHide={() => setCurrent(null)}
    />
  );
}
