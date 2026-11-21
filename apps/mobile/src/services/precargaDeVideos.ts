/**
 * Precarga del primer MB de los videos que vienen en el feed vertical.
 *
 * QUE SE BUSCA (lo que mide el paper Dashlet, NSDI 2023, §2.2, sobre TikTok):
 * tener SIEMPRE en cache el primer 1 MB —o el video entero si pesa menos— de
 * los 5 videos siguientes. Al deslizar se cancelan las precargas que ya no
 * tocan y se pide el primer MB del que entra a la cola. El resto de cada video
 * solo lo baja el reproductor cuando de verdad se reproduce.
 *
 * QUIEN BAJA. Un parche de expo-video (`patches/expo-video+3.0.16.patch`) que
 * escribe en la MISMA cache de disco del reproductor y con la misma clave (la
 * URL completa). Un `fetch` desde aqui no serviria: esa cache es interna y el
 * reproductor no la veria. Por eso aqui no hay red: este archivo solo decide
 * QUE pedir y QUE cancelar, y es puro para probarlo en Node
 * (`precargaDeVideos.test.mts`). El modulo nativo se inyecta.
 *
 * NO-OP SEGURO. Sin modulo nativo (web, Expo Go, o un binario anterior al
 * parche que recibe esta version por OTA, como iOS v7) no se hace nada y el
 * feed sigue exactamente como antes.
 *
 * RIESGO A CONOCER: la clave es la URL firmada COMPLETA. Si la URL que se
 * reproduce no es letra por letra la que se precargo (refirma de Supabase,
 * renovacion de las de S3), lo precargado no se usa: el reproductor baja de
 * nuevo y lo huerfano lo expulsa la cache por antiguedad. Se pierde la
 * ventaja, no se rompe nada. Por eso no se precarga lo que esta por vencer: se
 * renovaria antes de reproducirse.
 */

/** Cuanto del inicio de cada video se precarga: 1 MB, como TikTok. */
export const BYTES_A_PRECARGAR = 1024 * 1024;

/** Cuantos videos por delante del actual se mantienen precargados. */
export const VIDEOS_A_PRECARGAR = 5;

/** Lo minimo del modulo nativo que hace falta (nombres del parche). */
export type ModuloNativoDePrecarga = {
  /** Resuelve `true` si el tramo quedo en cache, `false` si se cancelo o fallo. */
  precargarVideoAsync: (url: string, bytes: number) => Promise<boolean>;
  cancelarPrecargaDeVideo: (url: string) => void;
  cancelarPrecargasDeVideo: () => void;
};

/** Lo que hace falta saber de cada elemento del feed. */
export type VideoDelFeed = {
  uri?: string;
  /** HLS: no se precarga (la cache de expo-video no lo soporta en iOS). */
  isStream?: boolean;
  urlsExpiran?: string;
};

/**
 * Si el objeto es de verdad el modulo parcheado.
 *
 * Un binario viejo SI trae el modulo `ExpoVideo`, pero sin estas funciones:
 * se comprueba cada una para no llamar a algo que no existe.
 */
export function esModuloDePrecarga(modulo: unknown): modulo is ModuloNativoDePrecarga {
  if (!modulo || typeof modulo !== 'object') return false;
  const m = modulo as Record<string, unknown>;
  return (
    typeof m.precargarVideoAsync === 'function' &&
    typeof m.cancelarPrecargaDeVideo === 'function' &&
    typeof m.cancelarPrecargasDeVideo === 'function'
  );
}

/** Solo MP4 progresivo por http(s): lo que sirve la cache del reproductor. */
export function sePuedePrecargar(video: VideoDelFeed): video is VideoDelFeed & { uri: string } {
  return !video.isStream && typeof video.uri === 'string' && /^https?:\/\//i.test(video.uri);
}

/**
 * Las URLs a tener precargadas estando en `indiceActivo`, de la mas cercana a
 * la mas lejana (el nativo las atiende en ese orden).
 *
 * `conReproductor`: cuantos de los siguientes ya tienen reproductor montado
 * (en el feed, `preload`). Esos los bufferiza su propio reproductor, que
 * escribe en la misma cache; precargarlos a la vez seria bajar dos veces lo
 * mismo, compitiendo por la red. Asi la ventana de 5 sigue cubierta entera.
 *
 * `necesitaUrls`: si la URL de un elemento esta por renovarse. Esa no se
 * precarga: la URL que se reproduzca sera otra (ver la cabecera).
 */
export function urlsAPrecargar(
  items: readonly VideoDelFeed[],
  indiceActivo: number,
  {
    cuantos = VIDEOS_A_PRECARGAR,
    conReproductor = 0,
    necesitaUrls = () => false,
  }: {
    cuantos?: number;
    conReproductor?: number;
    necesitaUrls?: (video: VideoDelFeed) => boolean;
  } = {},
): string[] {
  if (!Number.isInteger(indiceActivo) || indiceActivo < 0) return [];
  const urls: string[] = [];
  const desde = indiceActivo + 1 + Math.max(0, conReproductor);
  const hasta = indiceActivo + cuantos;
  for (let i = desde; i <= hasta && i < items.length; i++) {
    const video = items[i];
    if (!video || !sePuedePrecargar(video) || necesitaUrls(video)) continue;
    if (!urls.includes(video.uri)) urls.push(video.uri);
  }
  return urls;
}

export type Precargador = {
  /** Deja precargadas exactamente estas URLs: cancela lo que sobra, pide lo que falta. */
  actualizar: (urls: readonly string[]) => void;
  /** Cancela todo lo que pidio ESTE precargador (no lo de otros feeds). */
  detener: () => void;
};

/**
 * Cola de precarga de un feed.
 *
 * Cada feed (Para ti, Siguiendo) tiene la suya; el modulo nativo es uno solo,
 * asi que cada precargador cancela por URL lo suyo y nunca usa el
 * `cancelarPrecargasDeVideo` global.
 *
 * Con `nativo` en `null` todo es no-op.
 */
export function crearPrecargador(
  nativo: ModuloNativoDePrecarga | null,
  bytes: number = BYTES_A_PRECARGAR,
): Precargador {
  /** URL → numero de pedido. El numero evita que la respuesta de un pedido
   *  cancelado borre el pedido nuevo de la misma URL. */
  const enCurso = new Map<string, number>();
  /** Ya en cache. Solo se recuerda lo que sigue en la ventana: volver atras
   *  y pedirlo otra vez cuesta una consulta a disco, no una descarga. */
  const listas = new Set<string>();
  let siguientePedido = 0;

  const cancelar = (url: string) => {
    enCurso.delete(url);
    try {
      nativo?.cancelarPrecargaDeVideo(url);
    } catch {
      // Cancelar nunca puede romper el feed.
    }
  };

  return {
    actualizar(urls) {
      if (!nativo) return;
      const deseadas = new Set(urls);
      for (const url of [...enCurso.keys()]) {
        if (!deseadas.has(url)) cancelar(url);
      }
      for (const url of [...listas]) {
        if (!deseadas.has(url)) listas.delete(url);
      }
      for (const url of urls) {
        if (enCurso.has(url) || listas.has(url)) continue;
        const pedido = ++siguientePedido;
        enCurso.set(url, pedido);
        let promesa: Promise<boolean>;
        try {
          promesa = Promise.resolve(nativo.precargarVideoAsync(url, bytes));
        } catch {
          enCurso.delete(url);
          continue;
        }
        promesa.then(
          (listo) => {
            if (enCurso.get(url) !== pedido) return;
            enCurso.delete(url);
            if (listo === true) listas.add(url);
          },
          () => {
            if (enCurso.get(url) === pedido) enCurso.delete(url);
          },
        );
      }
    },
    detener() {
      for (const url of [...enCurso.keys()]) cancelar(url);
      listas.clear();
    },
  };
}
