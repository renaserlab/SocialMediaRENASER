import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * QUE LA PRIMERA PULSACION SUENE, Y QUE SOLO SUENE UNA COSA.
 *
 * Dos reglas que se repetian mal en cada reproductor de audio y que aqui se
 * escriben una sola vez.
 *
 * ## 1. La primera pulsacion no reproducia
 *
 * El patron roto era siempre el mismo:
 *
 *     const reproductor = useAudioPlayer(url ? { uri: url } : null);
 *     ...
 *     const url = await pedirLaUrl();   // llega DESPUES
 *     reproductor.play();               // el de ESTE render, sin fuente
 *
 * `useAudioPlayer` se apoya en `useReleasingSharedObject`: crea el objeto
 * NATIVO con la fuente que tenga en ese momento y solo lo cambia por otro
 * cuando la fuente cambia, o sea EN EL RENDER SIGUIENTE. La funcion que maneja
 * la pulsacion tiene capturado el reproductor viejo —el que se creo con `null`—
 * y `play()` sobre el no hace nada, sin lanzar ni avisar. Al segundo toque ya
 * existe el reproductor bueno y suena; de ahi «la primera vez no funciona».
 *
 * La solucion no es reintentar ni esperar con un temporizador: es APUNTAR la
 * intencion y dispararla cuando la fuente Y el reproductor esten listos, que es
 * exactamente lo que hace {@link useReproduccionDiferida}.
 *
 * ## 2. Solo un audio a la vez
 *
 * Cambiar de episodio desmonta un reproductor y monta otro, pero en Android la
 * liberacion del objeto nativo se encola (el mismo motivo documentado en
 * `components/audioDelReproductor.test.mts`): durante esos milisegundos se oyen
 * los dos. El registro de aqui pausa al anterior ANTES de que el nuevo empiece,
 * mientras sigue vivo.
 */

/** Lo minimo que se le pide a un reproductor de `expo-audio`. */
export type ReproductorMinimo = {
  play: () => void;
  pause: () => void;
  muted?: boolean;
};

/**
 * Ejecuta algo sobre el objeto nativo tolerando que ya no exista.
 *
 * Es la misma regla que `safely()` en `VideoPlayer`: al desmontar, `expo-audio`
 * puede haber liberado ya el objeto y cualquier llamada lanza.
 */
function conCuidado(accion: () => void): void {
  try {
    accion();
  } catch {
    // Reproductor ya liberado: no queda nada que parar.
  }
}

/** El unico reproductor que puede estar sonando. Vive fuera de React a proposito. */
let enMarcha: ReproductorMinimo | null = null;

/** Reserva el sonido para este reproductor y calla al que hubiera antes. */
export function reclamarSonido(reproductor: ReproductorMinimo): void {
  const anterior = enMarcha;
  if (anterior && anterior !== reproductor) conCuidado(() => anterior.pause());
  enMarcha = reproductor;
}

/** Devuelve el turno. Se llama al desmontar, para no dejar una referencia muerta. */
export function soltarSonido(reproductor: ReproductorMinimo): void {
  if (enMarcha === reproductor) enMarcha = null;
}

/** Solo para las pruebas: deja el registro como recien arrancado. */
export function olvidarSonido(): void {
  enMarcha = null;
}

/**
 * Tope de espera de una reproduccion pendiente.
 *
 * Una URL que no carga nunca —firma caducada, archivo borrado, sin red— dejaria
 * la rueda girando para siempre. Quince segundos son de sobra para cualquier
 * conexion que vaya a funcionar, y a partir de ahi es mejor decirlo.
 */
export const ESPERA_MAXIMA_MS = 15_000;

export type ReproduccionDiferida = {
  /** Hay una reproduccion esperando a que la fuente cargue. */
  pendiente: boolean;
  /** Suena ya si se puede; si no, en cuanto la fuente este lista. */
  pedir: () => void;
  /** Cancela la espera: segundo toque, cambio de perfil o salida de pantalla. */
  cancelar: () => void;
};

/**
 * Reproduccion diferida: se apunta la intencion y se dispara cuando se puede.
 *
 * @param reproductor El de ESTE render. Cambia de identidad cuando cambia la
 *                    fuente, y esa es justo la senal que se estaba perdiendo.
 * @param listo       `status.isLoaded`. Antes de eso `play()` no hace nada.
 * @param alAgotarse  Se avisa si la fuente no llega a cargar nunca.
 */
export function useReproduccionDiferida(
  reproductor: ReproductorMinimo | null,
  listo: boolean,
  alAgotarse?: () => void,
): ReproduccionDiferida {
  const [pendiente, setPendiente] = useState(false);

  // El aviso en una referencia: si fuera dependencia del efecto, una funcion
  // nueva en cada render reiniciaria la cuenta atras y nunca se agotaria.
  const aviso = useRef(alAgotarse);
  aviso.current = alAgotarse;

  const pedir = useCallback(() => setPendiente(true), []);
  const cancelar = useCallback(() => setPendiente(false), []);

  /*
    Estado y no referencia: hace falta que el cambio provoque un render para
    que este efecto vuelva a evaluarse cuando `listo` o el reproductor cambien.
    Es idempotente, asi que un doble toque no encola dos reproducciones.
  */
  useEffect(() => {
    if (!pendiente || !reproductor || !listo) return;
    reclamarSonido(reproductor);
    conCuidado(() => reproductor.play());
    setPendiente(false);
  }, [pendiente, reproductor, listo]);

  useEffect(() => {
    if (!pendiente) return;
    const reloj = setTimeout(() => {
      setPendiente(false);
      /*
        Ultimo recurso: se pide igual. Si un dia `isLoaded` no llegara a ser
        cierto en alguna plataforma, esto deja el comportamiento como estaba
        antes —un `play()` a ciegas— en vez de callar del todo. No sustituye a
        la espera: llega quince segundos tarde y solo para no perder el audio.
      */
      if (reproductor) {
        reclamarSonido(reproductor);
        conCuidado(() => reproductor.play());
      }
      aviso.current?.();
    }, ESPERA_MAXIMA_MS);
    return () => clearTimeout(reloj);
  }, [pendiente, reproductor]);

  return { pendiente, pedir, cancelar };
}

/**
 * Calla el reproductor mientras TODAVIA existe.
 *
 * `useLayoutEffect` y no `useEffect`: React ejecuta las limpiezas de layout en
 * la fase de mutacion, antes que las pasivas, y la pasiva de
 * `useReleasingSharedObject` es la que suelta el objeto nativo. Con un efecto
 * normal la pausa caeria sobre algo ya liberado —se la tragaria `conCuidado()`—
 * y el silencio dependeria entero de una liberacion que en Android se encola.
 *
 * Corre tambien cuando cambia la FUENTE: ahi el reproductor saliente sigue vivo
 * y hay que pararlo antes de que el nuevo arranque.
 */
export function useSilencioAlDesmontar(reproductor: ReproductorMinimo | null): void {
  useLayoutEffect(() => {
    if (!reproductor) return;
    return () => {
      conCuidado(() => {
        reproductor.pause();
        // Silenciar ademas de pausar: entre la pausa y la liberacion nativa un
        // buffer ya entregado puede seguir oyendose.
        reproductor.muted = true;
      });
      soltarSonido(reproductor);
    };
  }, [reproductor]);
}
