import { useCallback, useRef, useState } from 'react';

import { describeError } from '@/lib/describeError';
import type { UploadProgress } from '@/services/storage';

/**
 * El ciclo de publicar algo, con sus estados de verdad.
 *
 * Publicar no es "pulsar y esperar": puede tardar minutos (un video se
 * comprime, se sube por trozos y despues se crea la publicacion), puede
 * fallar a mitad, y quien lo hizo tiene que poder reintentarlo sin volver a
 * elegir el archivo ni escribir el texto otra vez.
 *
 * Lo que resuelve, y que estaba suelto o sin resolver en cada pantalla:
 *  - DOBLE PULSACION: mientras hay un envio en curso, el segundo se ignora.
 *    Esta es la causa clasica de publicaciones duplicadas.
 *  - REINTENTO: el trabajo se guarda tal cual, asi que reintentar es repetir
 *    lo mismo, no reconstruirlo.
 *  - CANCELACION: se puede abandonar. Con honestidad sobre lo que significa
 *    (ver `cancelar`).
 *  - ERRORES EN CASTELLANO: nunca un codigo ni un objeto de red en pantalla.
 */

export type FaseDePublicacion =
  | 'inactivo'
  | 'comprimiendo'
  | 'subiendo'
  | 'publicando'
  | 'hecho'
  | 'error';

export type ContextoDePublicacion = {
  /** Avisa del avance para pintar la barra. */
  avance: (progreso: UploadProgress) => void;
  /** `true` si la persona pidio cancelar: hay que dejarlo antes de publicar. */
  cancelado: () => boolean;
};

export type TrabajoDePublicacion = (ctx: ContextoDePublicacion) => Promise<void>;

/** Se lanza cuando el trabajo se abandona a peticion de la persona. */
export class PublicacionCancelada extends Error {
  constructor() {
    super('Publicación cancelada.');
    this.name = 'PublicacionCancelada';
  }
}

export function usePublicacion() {
  const [fase, setFase] = useState<FaseDePublicacion>('inactivo');
  const [progreso, setProgreso] = useState(0);
  const [error, setError] = useState<string | null>(null);

  /** El trabajo en curso o el ultimo que fallo, para poder reintentarlo. */
  const trabajoRef = useRef<TrabajoDePublicacion | null>(null);
  /*
    El cerrojo va en una referencia y no en el estado: se consulta y se escribe
    dentro del mismo manejador, y con estado la segunda pulsacion leeria el
    valor viejo y pasaria igual. Es justo el caso que produce duplicados.
  */
  const ocupadoRef = useRef(false);
  const canceladoRef = useRef(false);

  const ejecutar = useCallback(async (trabajo: TrabajoDePublicacion) => {
    if (ocupadoRef.current) return;
    ocupadoRef.current = true;
    canceladoRef.current = false;
    trabajoRef.current = trabajo;
    setError(null);
    setProgreso(0);
    setFase('publicando');

    try {
      await trabajo({
        avance: ({ phase, ratio }) => {
          setFase(phase === 'compressing' ? 'comprimiendo' : 'subiendo');
          setProgreso(ratio);
        },
        cancelado: () => canceladoRef.current,
      });
      if (canceladoRef.current) {
        setFase('inactivo');
        return;
      }
      // El trabajo termino: se olvida, para que un reintento posterior no
      // pueda volver a publicar lo mismo.
      trabajoRef.current = null;
      setProgreso(1);
      setFase('hecho');
    } catch (e) {
      if (e instanceof PublicacionCancelada) {
        setFase('inactivo');
        return;
      }
      setError(describeError(e, 'No se pudo publicar. Inténtalo de nuevo.'));
      setFase('error');
    } finally {
      ocupadoRef.current = false;
    }
  }, []);

  const reintentar = useCallback(() => {
    const trabajo = trabajoRef.current;
    if (!trabajo) return;
    void ejecutar(trabajo);
  }, [ejecutar]);

  /**
   * Abandona el envio.
   *
   * Lo que NO hace, y conviene tenerlo claro: no recupera los bytes que ya
   * viajaron. El archivo puede quedar subido en el almacen, pero la
   * PUBLICACION no llega a crearse, que es lo unico que se ve. Un fichero
   * huerfano es un coste asumible; una publicacion que aparece despues de que
   * alguien pulse «cancelar», no.
   */
  const cancelar = useCallback(() => {
    canceladoRef.current = true;
    setFase('inactivo');
    setProgreso(0);
  }, []);

  const limpiar = useCallback(() => {
    trabajoRef.current = null;
    canceladoRef.current = false;
    setError(null);
    setProgreso(0);
    setFase('inactivo');
  }, []);

  return {
    fase,
    progreso,
    error,
    /** `true` mientras hay un envio en marcha. Apaga el boton de publicar. */
    ocupado: fase === 'comprimiendo' || fase === 'subiendo' || fase === 'publicando',
    puedeReintentar: fase === 'error' && trabajoRef.current !== null,
    ejecutar,
    reintentar,
    cancelar,
    limpiar,
  };
}
