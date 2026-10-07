import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'expo-router';

import { Toast } from '@/components/Toast';
import { esperaParaPresentar } from '@/lib/avisoTrasNavegar';
import {
  avanzarCola,
  claveDelAviso,
  duracionDelAviso,
  encolarAviso,
  retirarAvisos,
  type AvisoEnCola,
} from '@/lib/colaDeAvisos';
import { registerToastHost, type ToastRequest } from '@/lib/toast';
import { DURACION_DE_LA_TRANSICION_MS } from '@/navigation/transicion';

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
 * Y NUNCA MIENTRAS LA PANTALLA CAMBIA. La cabeza de la cola no se monta hasta
 * que la pantalla lleva quieta lo que dura una transicion: cuanto falta lo
 * decide `avisoTrasNavegar`, que explica el fallo que lo motivo (la pantalla
 * gris tras guardar, 06–07/10/2026). Un aviso que ya se esta viendo no se
 * toca: la regla es para MONTARLO, no para quitarlo.
 *
 * El cambio de `key` remonta el componente, con lo que la animacion y el
 * temporizador vuelven a empezar; sin eso, el segundo aviso heredaba el tiempo
 * restante del primero y podia desaparecer al instante.
 */
export function ToastHost() {
  const [cola, setCola] = useState<Aviso[]>([]);
  /** El aviso que ya se puede ver. La cabeza espera hasta ser este. */
  const [presentado, setPresentado] = useState<number | null>(null);

  /*
    CUANDO CAMBIO LA PANTALLA POR ULTIMA VEZ. La ruta cambia en el mismo
    instante en que se pide la navegacion, antes de que la pila empiece a
    moverse: es justo la senal que hace falta.

    Este efecto va ANTES que el que programa el aviso, y el orden importa: los
    efectos de un mismo render corren en el orden en que estan escritos, y el
    segundo tiene que leer ya el instante que apunta el primero.
  */
  const ruta = usePathname();
  const ultimoCambioDePantalla = useRef<number | null>(null);
  const rutaAnterior = useRef(ruta);
  useEffect(() => {
    if (rutaAnterior.current === ruta) return;
    rutaAnterior.current = ruta;
    ultimoCambioDePantalla.current = Date.now();
  }, [ruta]);

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
  const idDeLaCabeza = visible?.id ?? null;

  /*
    La cabeza se presenta cuando la pantalla esta quieta. `ruta` esta entre las
    dependencias a proposito: si la pantalla cambia mientras el aviso espera,
    la espera vuelve a empezar desde ese cambio.
  */
  useEffect(() => {
    if (idDeLaCabeza === null || idDeLaCabeza === presentado) return;
    const espera = esperaParaPresentar(
      Date.now(),
      ultimoCambioDePantalla.current,
      DURACION_DE_LA_TRANSICION_MS,
    );
    const reloj = setTimeout(() => setPresentado(idDeLaCabeza), espera);
    return () => clearTimeout(reloj);
  }, [idDeLaCabeza, presentado, ruta]);

  if (!visible || presentado !== visible.id) return null;
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
