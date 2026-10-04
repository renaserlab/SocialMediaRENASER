import React, { useCallback, useEffect, useState } from 'react';

import { Toast } from '@/components/Toast';
import {
  avanzarCola,
  claveDelAviso,
  duracionDelAviso,
  encolarAviso,
  retirarAvisos,
  type AvisoEnCola,
} from '@/lib/colaDeAvisos';
import { registerToastHost, type ToastRequest } from '@/lib/toast';

/** Identifica cada aviso para poder remontar el Toast y reiniciar su animacion. */
let counter = 0;

type Aviso = AvisoEnCola & { peticion: ToastRequest };

/**
 * Los avisos transitorios de la aplicacion. Se monta UNA vez en el layout raiz.
 *
 * NUNCA DOS A LA VEZ. Se ve el primero de la cola y los demas esperan; como
 * conviven —quien sustituye a quien, que se repite y que no, cuantos caben— lo
 * decide `colaDeAvisos`, que es una funcion pura y esta probada. Aqui solo se
 * guarda la cola y se pinta su cabeza.
 *
 * El cambio de `key` remonta el componente, con lo que la animacion y el
 * temporizador vuelven a empezar; sin eso, el segundo aviso heredaba el tiempo
 * restante del primero y podia desaparecer al instante.
 */
export function ToastHost() {
  const [cola, setCola] = useState<Aviso[]>([]);

  const present = useCallback((peticion: ToastRequest) => {
    const tipo = peticion.tipo ?? 'exito';
    const aviso: Aviso = {
      id: ++counter,
      tipo,
      clave: claveDelAviso(tipo, peticion.message, peticion.clave),
      peticion,
    };
    setCola((actual) => encolarAviso(actual, aviso));
  }, []);

  const retirar = useCallback((esDeLaClave: (clave: string) => boolean) => {
    setCola((actual) => retirarAvisos(actual, esDeLaClave));
  }, []);

  useEffect(() => {
    registerToastHost(present, retirar);
    return () => registerToastHost(null);
  }, [present, retirar]);

  const visible = cola[0];
  if (!visible) return null;
  const { peticion } = visible;

  return (
    <Toast
      key={visible.id}
      message={peticion.message}
      titulo={peticion.titulo}
      tipo={visible.tipo}
      icon={peticion.icon}
      avatarUrl={peticion.avatarUrl}
      accion={peticion.accion}
      alTocar={peticion.alTocar}
      duration={duracionDelAviso(visible.tipo, Boolean(peticion.accion), peticion.duracion)}
      onHide={() => setCola((actual) => avanzarCola(actual, visible.id))}
    />
  );
}
