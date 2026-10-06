/**
 * Los tonos del chat: uno al enviar un mensaje y otro al recibirlo con la
 * conversación delante.
 *
 * LO PEDIDO (06/10/2026): «agregarle un sonido de que se envió el mensaje o
 * cuando recibe», como en cualquier chat.
 *
 * POR QUÉ SON AVISOS SIN AVISO, Y NO UN REPRODUCTOR. La aplicación tiene UNA
 * sesión de audio, la de los episodios y las notas de voz, que pide el sonido
 * del teléfono para ella sola y suena aunque esté en silencio
 * (`hooks/useBackgroundAudio`). Un tono por ese camino pararía la música de
 * quien la esté oyendo en otra aplicación cada vez que manda un mensaje, y
 * sonaría con el teléfono en silencio. Por el camino de los avisos el sistema
 * lo trata como lo que es —un sonido de notificación—: respeta el modo
 * silencio y el volumen de avisos, y no le quita el sonido a nadie.
 *
 * Se programa un aviso local que NO SE ENSEÑA —ni tira, ni lista, ni globo— y
 * solo suena (`services/notifications`). Los dos ficheros van dentro de la
 * compilación (`sounds` del plugin `expo-notifications` en `app.json`), así
 * que esto no llega por actualización: hace falta un binario nuevo.
 *
 * Aquí vive lo que se puede probar sin teléfono: los nombres, la marca que
 * distingue un tono de un aviso de verdad y cuándo toca que suene.
 */

export type TonoDelChat = 'enviado' | 'recibido';

/**
 * Cada tono: su fichero y su canal de Android.
 *
 * EL CANAL LLEVA `-v1` por lo mismo que los de los avisos: Android no deja
 * cambiar el sonido de un canal ya creado. Si un día cambia el tono, cambia
 * el identificador.
 *
 * Los nombres de fichero van en minúsculas y con guion bajo: Android los
 * empaqueta como recursos y no admite otra cosa.
 */
export const TONOS: Record<TonoDelChat, { fichero: string; canal: string; nombre: string }> = {
  enviado: {
    fichero: 'mensaje_enviado.wav',
    canal: 'tono-enviado-v1',
    nombre: 'Sonido al enviar un mensaje',
  },
  recibido: {
    fichero: 'mensaje_recibido.wav',
    canal: 'tono-recibido-v1',
    nombre: 'Sonido al recibir un mensaje',
  },
};

/** La clave que llevan en sus datos, para no confundirlos con un aviso. */
export const MARCA_DE_TONO = 'tonoDelChat';

/** Lo que viaja en el aviso local de un tono. */
export function datosDelTono(cual: TonoDelChat): Record<string, string> {
  return { [MARCA_DE_TONO]: cual };
}

/** Si los datos de un aviso son los de un tono: no se pinta ni se cuenta. */
export function esUnTono(datos: unknown): boolean {
  if (typeof datos !== 'object' || datos === null) return false;
  const marca = (datos as Record<string, unknown>)[MARCA_DE_TONO];
  return marca === 'enviado' || marca === 'recibido';
}

/** Entre dos tonos iguales tiene que pasar al menos esto. */
export const PAUSA_ENTRE_TONOS_MS = 700;

/**
 * Si puede sonar ahora un tono que sonó por última vez en `ultimo`.
 *
 * Una ráfaga —cinco mensajes que llegan de golpe al volver a la aplicación—
 * es UN sonido, no cinco pisándose.
 */
export function puedeSonar(ahora: number, ultimo: number | undefined): boolean {
  return ultimo === undefined || ahora - ultimo >= PAUSA_ENTRE_TONOS_MS;
}

/**
 * Si lo último que ha entrado en la conversación merece el tono de recibido.
 *
 * Solo lo AJENO, solo si es una novedad —lo que trae la carga inicial no
 * suena—, solo si es un mensaje de verdad (la tarjeta de una sesión que se
 * pinta al final no lo es) y solo si se está mirando: con la conversación
 * detrás de otra pantalla, o la aplicación en segundo plano, ya avisa el push
 * con su propio sonido, y serían dos.
 */
export function suenaLoQueLlega(caso: {
  antes: string | null;
  ahora: string | null;
  mio: boolean;
  seEstaMirando: boolean;
}): boolean {
  if (caso.ahora === null || caso.antes === null || caso.ahora === caso.antes) return false;
  if (caso.mio || !caso.seEstaMirando) return false;
  return !caso.ahora.startsWith('sesion:');
}
