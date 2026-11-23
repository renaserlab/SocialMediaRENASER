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
 *
 * MEDIR LA RED DE PASO. Cada primer MB que baja de verdad es una muestra de
 * throughput gratis para `lib/medidorDeRed.ts` (que elige la calidad de los
 * videos). El nativo solo devuelve `true`/`false`, asi que el tiempo se toma
 * aqui, con cuidado de no medir lo que no es red (ver `crearColaNativa` y
 * `muestraCreible`). Sin cambiar el nativo: esto llega por EAS Update.
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

/**
 * Por encima de esto, 1 MB «bajado» no vino de la red sino del disco.
 *
 * El nativo responde `true` tambien cuando el tramo YA estaba en cache (iOS
 * casi al instante; Android lo relee del disco en milisegundos). Esa muestra
 * diria «cientos de Mbps» y subiria la calidad sin motivo. Un primer MB por
 * una conexion nueva necesita varias idas y vueltas (arranque lento de TCP),
 * asi que 100 Mbps es un techo que un telefono rara vez supera de verdad; y
 * descartar una muestra rapida real no cuesta nada: con red de sobra ya se
 * elige la calidad de arriba.
 */
export const KBPS_MAXIMOS_CREIBLES = 100_000;

/** Si `(bytes, ms)` parece una descarga de red y no una lectura de disco. */
export function muestraCreible(bytes: number, ms: number): boolean {
  if (!Number.isFinite(bytes) || !Number.isFinite(ms) || bytes <= 0 || ms <= 0) return false;
  return (bytes * 8) / ms <= KBPS_MAXIMOS_CREIBLES;
}

/** Cuantas URLs bajadas se recuerdan para no medir dos veces la misma. */
const URLS_RECORDADAS = 300;

/**
 * Modelo, en JS, de la fila del modulo nativo, para saber cuanto tardo DE
 * VERDAD cada pedido.
 *
 * POR QUE. El nativo atiende UN pedido a la vez, en el orden de llegada
 * (Android: un solo hilo; iOS: cada tarea espera a la anterior). Se mandan
 * hasta 5 juntos, asi que el quinto resuelve cuando terminan los cuatro de
 * delante: medido desde que se pidio, pareceria cinco veces mas lento. El
 * tiempo que cuenta es desde que llego a la CABEZA de la fila (cuando
 * termino o se cancelo el anterior) hasta que resolvio.
 *
 * Una sola para todos los feeds porque el modulo nativo es uno solo.
 */
export function crearColaNativa() {
  const fila: string[] = [];
  let cabezaDesde = 0;
  const bajadas = new Set<string>();
  return {
    entrar(clave: string, t: number): void {
      fila.push(clave);
      if (fila.length === 1) cabezaDesde = t;
    },
    /**
     * Sale un pedido (resolvio o se cancelo). Devuelve desde cuando lo
     * atendia el nativo si era la cabeza, o `null` si no lo era (no se mide).
     */
    salir(clave: string, t: number): number | null {
      const i = fila.indexOf(clave);
      if (i < 0) return null;
      fila.splice(i, 1);
      if (i !== 0) return null;
      const inicio = cabezaDesde;
      // El siguiente empieza a atenderse justo ahora.
      cabezaDesde = t;
      return inicio;
    },
    yaBajada(url: string): boolean {
      return bajadas.has(url);
    },
    recordarBajada(url: string): void {
      if (bajadas.has(url)) return;
      if (bajadas.size >= URLS_RECORDADAS) {
        const primera = bajadas.values().next().value;
        if (primera !== undefined) bajadas.delete(primera);
      }
      bajadas.add(url);
    },
  };
}

export type ColaNativa = ReturnType<typeof crearColaNativa>;

/** La fila del unico modulo nativo de la app. */
const colaNativa = crearColaNativa();
let precargadoresCreados = 0;

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
  {
    alMedir,
    ahora = Date.now,
    cola = colaNativa,
  }: {
    /** Recibe `(bytes, ms)` de cada tramo que muy probablemente bajo de la red. */
    alMedir?: (bytes: number, ms: number) => void;
    ahora?: () => number;
    cola?: ColaNativa;
  } = {},
): Precargador {
  /** URL → numero de pedido. El numero evita que la respuesta de un pedido
   *  cancelado borre el pedido nuevo de la misma URL. */
  const enCurso = new Map<string, number>();
  const idDePrecargador = ++precargadoresCreados;
  /** Ya en cache. Solo se recuerda lo que sigue en la ventana: volver atras
   *  y pedirlo otra vez cuesta una consulta a disco, no una descarga. */
  const listas = new Set<string>();
  let siguientePedido = 0;

  /** Numero de pedido → clave en la cola nativa compartida. */
  const claveEnCola = (pedido: number) => `${idDePrecargador}:${pedido}`;

  const cancelar = (url: string) => {
    const pedido = enCurso.get(url);
    if (pedido !== undefined) cola.salir(claveEnCola(pedido), ahora());
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
        cola.entrar(claveEnCola(pedido), ahora());
        promesa.then(
          (listo) => {
            if (enCurso.get(url) !== pedido) return;
            enCurso.delete(url);
            const fin = ahora();
            const inicio = cola.salir(claveEnCola(pedido), fin);
            if (listo !== true) return;
            listas.add(url);
            // Una URL que ya quedo en cache antes se lee de disco: no es red.
            const repetida = cola.yaBajada(url);
            cola.recordarBajada(url);
            if (alMedir && inicio !== null && !repetida && muestraCreible(bytes, fin - inicio)) {
              try {
                alMedir(bytes, fin - inicio);
              } catch {
                // Medir nunca puede romper la precarga.
              }
            }
          },
          () => {
            if (enCurso.get(url) !== pedido) return;
            enCurso.delete(url);
            cola.salir(claveEnCola(pedido), ahora());
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
