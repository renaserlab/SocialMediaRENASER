/**
 * Cuanto se adelanta cada reproductor del muro de Inicio, y cuales existen.
 *
 * POR QUE UN MODULO APARTE Y SIN IMPORTAR NADA. Es la unica parte de la
 * precarga con REGLAS; el resto es pintar. Asi se prueba en Node
 * (`precargaDeVideos.test.mts`) sin levantar React Native ni expo-video.
 *
 * LA IDEA (la de TikTok). Antes el activo y sus vecinos pedian lo mismo: 15 s o
 * 12 MB cada uno. Con tres reproductores eso son hasta 36 MB compitiendo por la
 * misma conexion, y el que se ve —el unico que importa— se llevaba un tercio
 * del ancho de banda justo cuando arrancaba. Ahora:
 *
 *  - El ACTIVO pide mucho (15 s / 12 MB), igual que antes.
 *  - Los VECINOS piden poco (~2 s / ~1,5 MB): lo justo para tener el primer
 *    fotograma pintado y arrancar sin espera al deslizar. Al volverse activo,
 *    el mismo reproductor sube a 15 s en caliente (expo-video aplica
 *    `bufferOptions` al instante en Android e iOS), sin recrearse.
 *  - Mientras el activo va justo de buffer, o mientras el dedo arrastra la
 *    lista, los vecinos se quedan en el MINIMO: no sueltan lo que ya tienen,
 *    pero dejan de pedir mas.
 *
 * Y la ventana pasa de N-1..N+1 a N-1..N+2: cuatro reproductores como mucho
 * (ver `MAX_REPRODUCTORES`), que es el techo que aguantan bien los
 * decodificadores de un Android modesto.
 */

/** Reproductores por detras del activo que se mantienen preparados. */
export const VECINOS_ATRAS = 1;
/** Reproductores por delante del activo que se mantienen preparados. */
export const VECINOS_ADELANTE = 2;
/**
 * Techo de reproductores vivos en el muro: el activo y sus vecinos.
 *
 * Cada uno es un decodificador de video y una superficie en Android. Pasar de
 * cuatro en un telefono de gama baja es donde empiezan los fallos de memoria
 * nativa, asi que la ventana se calcula para no superarlo nunca.
 */
export const MAX_REPRODUCTORES = 1 + VECINOS_ATRAS + VECINOS_ADELANTE;

/** Lo que entiende `player.bufferOptions` de expo-video (la parte que usamos). */
export type PerfilDeBuffer = {
  preferredForwardBufferDuration: number;
  maxBufferBytes: number;
};

/** El que se ve: lo de siempre. 12 MB son ~7 s del video mas pesado subido. */
export const BUFFER_ACTIVO: PerfilDeBuffer = {
  preferredForwardBufferDuration: 15,
  maxBufferBytes: 12 * 1024 * 1024,
};

/**
 * Un vecino listo para arrancar: dos segundos dan el primer fotograma y el
 * arranque sin espera; mas seria descargar algo que quiza no se vea nunca.
 */
export const BUFFER_VECINO: PerfilDeBuffer = {
  preferredForwardBufferDuration: 2,
  maxBufferBytes: 1.5 * 1024 * 1024,
};

/**
 * Un vecino en espera: lo minimo para no perder el primer fotograma.
 *
 * Medio segundo NO es arbitrario: es el suelo que ExoPlayer aplica de todas
 * formas (por debajo se atasca). Y nunca 0: en iOS `preferredForwardBufferDuration
 * = 0` significa «decide tu», que es justo lo contrario de lo que se quiere.
 * El tope de bytes deja sitio de sobra para un fotograma clave de 1080p.
 */
export const BUFFER_MINIMO: PerfilDeBuffer = {
  preferredForwardBufferDuration: 0.5,
  maxBufferBytes: 1024 * 1024,
};

/**
 * ¿Esta celda tiene reproductor? Ventana N-1..N+2 en telefonos.
 *
 * En la web se mantiene N-1..N+1: alli el reproductor es un `<video>` y la
 * ventana nueva no se ha medido, asi que no cambia de comportamiento.
 */
export function enVentanaDePrecarga(indice: number, indiceActivo: number, web = false): boolean {
  const distancia = indice - indiceActivo;
  if (web) return Math.abs(distancia) <= 1;
  return distancia >= -VECINOS_ATRAS && distancia <= VECINOS_ADELANTE;
}

/** Estado compartido del muro que decide si los vecinos se contienen. */
export type EstadoDePrecarga = {
  /** El dedo esta arrastrando la lista o esta sigue por inercia. */
  arrastrando: boolean;
  /** Al activo le queda poco por delante (o aun no ha arrancado). */
  activoConPocoBuffer: boolean;
};

/**
 * El perfil de buffer de un reproductor segun su distancia al activo.
 *
 * - 0: el activo, siempre lo maximo.
 * - El activo va justo: TODOS los vecinos al minimo. Es cuando cada byte que
 *   se lleva un vecino se nota como un tiron en el que se ve.
 * - Arrastrando: al minimo todos menos el SIGUIENTE (+1), que es a donde va el
 *   dedo casi siempre; frenarlo justo ahora retrasaria su arranque.
 * - Si no, el perfil de vecino.
 */
export function perfilDeBuffer(distancia: number, estado: EstadoDePrecarga): PerfilDeBuffer {
  if (distancia === 0) return BUFFER_ACTIVO;
  if (estado.activoConPocoBuffer) return BUFFER_MINIMO;
  if (estado.arrastrando && distancia !== 1) return BUFFER_MINIMO;
  return BUFFER_VECINO;
}

/**
 * Por debajo de esto por delante, el activo va justo y los vecinos se frenan.
 */
export const POCO_BUFFER_S = 2;
/**
 * Por encima de esto, el activo ya va holgado y los vecinos pueden seguir.
 *
 * Dos umbrales y no uno (histeresis): con uno solo, un activo rondando los
 * 2 s haria que los vecinos cambiaran de perfil cuatro veces por segundo.
 */
export const BUFFER_HOLGADO_S = 5;

/** Lo que dice el activo en cada aviso de avance o de estado. */
export type LecturaDelActivo = {
  currentTime: number;
  bufferedPosition: number;
  duration: number;
  /** El reproductor dice que esta esperando datos (`status === 'loading'`). */
  cargando: boolean;
};

/**
 * ¿Le falta buffer al activo? Recibe lo que se decidio la ultima vez para
 * aplicar la histeresis.
 *
 * Si el reproductor no sabe cuanto lleva (`bufferedPosition` negativo o no
 * numerico, que pasa antes de cargar y en algunos HLS), se responde «no»: ante
 * la duda los vecinos se comportan como un vecino normal, nunca se quedan
 * frenados por un dato que no llega.
 */
export function activoConPocoBuffer(lectura: LecturaDelActivo, antes: boolean): boolean {
  if (lectura.cargando) return true;
  const { currentTime, bufferedPosition, duration } = lectura;
  if (!Number.isFinite(bufferedPosition) || bufferedPosition < 0) return false;
  // Ya tiene descargado hasta el final (video corto o en bucle): nada que pedir.
  if (Number.isFinite(duration) && duration > 0 && bufferedPosition >= duration - 0.25) return false;
  const porDelante = bufferedPosition - (Number.isFinite(currentTime) ? currentTime : 0);
  if (antes) return porDelante < BUFFER_HOLGADO_S;
  return porDelante < POCO_BUFFER_S;
}

/** Cuanto se espera, tras soltar el dedo, a que empiece la inercia. */
export const ESPERA_DE_INERCIA_MS = 250;

type Temporizador = {
  poner: (fn: () => void, ms: number) => unknown;
  quitar: (id: unknown) => void;
};

const temporizadorReal: Temporizador = {
  poner: (fn, ms) => setTimeout(fn, ms),
  quitar: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/**
 * El coordinador del muro: un estado pequeno con oyentes, fuera de React.
 *
 * FUERA DE REACT A PROPOSITO. Cambia varias veces por deslizamiento; si fuera
 * estado, cada cambio redibujaria las celdas de la lista —memoizadas justo para
 * no hacerlo— y competiria con la animacion del desplazamiento. Aqui cada
 * reproductor se suscribe y ajusta su `bufferOptions` directamente, sin render.
 */
export function crearCoordinadorDePrecarga(temporizador: Temporizador = temporizadorReal) {
  let estado: EstadoDePrecarga = { arrastrando: false, activoConPocoBuffer: false };
  const oyentes = new Set<(estado: EstadoDePrecarga) => void>();
  let finPendiente: unknown = null;

  const cambiar = (parcial: Partial<EstadoDePrecarga>) => {
    const siguiente = { ...estado, ...parcial };
    if (
      siguiente.arrastrando === estado.arrastrando &&
      siguiente.activoConPocoBuffer === estado.activoConPocoBuffer
    ) {
      return;
    }
    estado = siguiente;
    for (const oyente of oyentes) oyente(estado);
  };

  const cancelarFin = () => {
    if (finPendiente !== null) {
      temporizador.quitar(finPendiente);
      finPendiente = null;
    }
  };

  return {
    estado: () => estado,
    suscribir(oyente: (estado: EstadoDePrecarga) => void): () => void {
      oyentes.add(oyente);
      return () => {
        oyentes.delete(oyente);
      };
    },
    /** El dedo empieza a mover la lista. */
    inicioDeArrastre() {
      cancelarFin();
      cambiar({ arrastrando: true });
    },
    /**
     * El dedo se levanta. Con paginacion casi siempre sigue una inercia; si no
     * llega en un momento, se da el gesto por terminado (si no, un arrastre
     * sin inercia dejaria a los vecinos frenados para siempre).
     */
    finDeArrastre() {
      cancelarFin();
      finPendiente = temporizador.poner(() => {
        finPendiente = null;
        cambiar({ arrastrando: false });
      }, ESPERA_DE_INERCIA_MS);
    },
    inicioDeInercia() {
      cancelarFin();
      cambiar({ arrastrando: true });
    },
    finDeInercia() {
      cancelarFin();
      cambiar({ arrastrando: false });
    },
    /**
     * Hay un activo nuevo: aun no ha arrancado, asi que va justo por
     * definicion hasta que diga lo contrario con su primer aviso de avance.
     */
    nuevoActivo() {
      cambiar({ activoConPocoBuffer: true });
    },
    /** Un aviso del activo (avance o cambio de estado). */
    lecturaDelActivo(lectura: LecturaDelActivo) {
      cambiar({ activoConPocoBuffer: activoConPocoBuffer(lectura, estado.activoConPocoBuffer) });
    },
    /** El activo se fue (salir del muro): nadie a quien dejar sitio. */
    sinActivo() {
      cambiar({ activoConPocoBuffer: false });
    },
  };
}

export type CoordinadorDePrecarga = ReturnType<typeof crearCoordinadorDePrecarga>;
