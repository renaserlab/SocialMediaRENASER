/**
 * El disparador de una camara que SOLO graba (Reel).
 *
 * En Historia y Publicacion un toque hace una foto y mantener graba. En Reel no
 * hay foto que hacer, y aun asi un toque la hacia: el modo Reel pedia «solo
 * video» al carrete, pero la camara no se enteraba y seguia siendo la de las
 * historias. La foto acababa en el paso de «describe tu reel», que la intentaba
 * reproducir como video.
 *
 * Mantener pulsado tampoco sirve como unico gesto: un reel llega a tres
 * minutos, y nadie aguanta el dedo tres minutos. Asi que aqui el disparador
 * funciona de las dos maneras que la gente ya conoce:
 *
 *   · un TOQUE empieza a grabar y otro toque termina;
 *   · MANTENER graba mientras se mantiene y termina al soltar (y deja deslizar
 *     el dedo para acercar, que es para lo que sirve tenerlo apoyado).
 *
 * Aqui vive solo la decision —que se puede probar sin camara—; los gestos y la
 * camara estan en `StoryCaptureScreen`. Sin importaciones, a proposito.
 */

/** A partir de aqui la pulsacion se considera larga. El mismo umbral que en la camara de historias. */
export const MANTENER_MS = 350;

export type AlSoltar = 'parar' | 'seguir';

/**
 * Que hacer al levantar el dedo del disparador, en una camara que solo graba.
 *
 * - `grabando`: la grabacion llego a empezar. Si no —se esta pidiendo el
 *   microfono, por ejemplo—, soltar no la cancela: empezara y se parara con
 *   otro toque. Cancelarla aqui dejaba el primer toque «sin hacer nada» justo
 *   la primera vez, que es cuando sale el dialogo del permiso.
 * - `yaGrababa`: al APOYAR el dedo ya se estaba grabando. Entonces este toque
 *   es el de terminar, dure lo que dure.
 * - `duroMs`: cuanto estuvo apoyado el dedo.
 */
export function alSoltarElDisparadorDeVideo(estado: {
  grabando: boolean;
  yaGrababa: boolean;
  duroMs: number;
}): AlSoltar {
  if (!estado.grabando) return 'seguir';
  if (estado.yaGrababa) return 'parar';
  return estado.duroMs >= MANTENER_MS ? 'parar' : 'seguir';
}
