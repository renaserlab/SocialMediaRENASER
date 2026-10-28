/**
 * QUE LA FOTO DE UNA HISTORIA SE VEA ANTES, Y QUE EL TRAMO NO SE COMA LA ESPERA.
 *
 * Auditoria del 28/10/2026, §11. Abrir una historia por primera vez era esperar
 * a oscuras: el bucket es privado y la URL firmada no pasa por ninguna cache de
 * CDN, asi que solo el primer byte tardaba entre 0,4 y 1,8 s. Y nada se pedia
 * por adelantado, aunque el listado ya traia las URLs firmadas de todos los
 * tramos. Encima la barra de progreso arrancaba al abrir el tramo, no al llegar
 * la foto: con dos segundos de espera, dos segundos del tramo se iban mirando
 * negro.
 *
 * Aqui vive la parte que se puede decidir SIN pantalla, para poder probarla con
 * `node --test`:
 *
 *  1. QUE se precarga y en que orden (`precargasDeLaFila`, `precargasDelVisor`).
 *  2. CUANTO a la vez y con que tope (`crearColaDePrecarga`).
 *  3. CUANDO empieza a contar un tramo, cuando se da por visto y cuando deja de
 *     esperar (`cargaInicial`, `trasAviso` y compania).
 *
 * Como se calienta de verdad una imagen —y por que NO vale `Image.prefetch` en
 * el movil— esta en `services/precargaDeHistorias.ts`, que es quien toca
 * expo-image.
 */

/** Lo minimo de un tramo para decidir si se precarga y como se carga. */
export type TramoACargar = {
  id: string;
  /** Ruta en Storage: la clave de cache estable (la firma cambia). */
  storagePath: string;
  /** URL firmada. Sin ella no hay nada que pedir. */
  mediaUrl?: string;
  mediaType: 'image' | 'video';
};

/** Lo minimo de un autor de la fila. */
export type GrupoACargar = {
  isOwn: boolean;
  /** `false` si le queda algun tramo sin ver: es lo que enciende el anillo. */
  seen: boolean;
  items: readonly TramoACargar[];
};

/** Una imagen a calentar: lo que se descarga y la clave con la que se guarda. */
export type Precarga = { uri: string; cacheKey: string };

/**
 * Cuantos autores se adelantan al tener la lista.
 *
 * Cuatro son los que se ven en la fila sin desplazar: despues de la tuya, cada
 * burbuja ocupa 70 + 18 pt, asi que en un telefono de 390-430 pt caben tres
 * enteras y asoma la cuarta. Son los que se pueden tocar sin mover nada.
 * Uno por autor —su primer tramo— porque es lo que se pinta al
 * tocar; lo demas lo adelanta el propio visor cuando ya se esta mirando.
 * Con fotos comprimidas por el movil (~150-400 KB) son, como mucho, 1-1,5 MB
 * por sesion, y cada una solo una vez.
 */
export const AUTORES_A_PRECARGAR = 4;

/**
 * Cuantas descargas de precarga van a la vez: UNA, en el orden de la fila.
 *
 * Medido (exportacion web en Chrome con la red ralentizada, 28/10/2026): con
 * dos a la vez, tocar la primera burbuja mientras la precarga aun bajaba
 * hacia que su foto compartiera el ancho de banda con la del segundo autor, y
 * llegaba MAS TARDE que sin precarga (1,7 s frente a 1,1 s en 4G; 5,5 s
 * frente a 2,4 s en 3G). De una en una, la que mas probablemente se toca se
 * lleva toda la linea.
 */
export const PRECARGAS_A_LA_VEZ = 1;

/**
 * Cuantas pueden esperar turno. Lo que no cabe se descarta, no se aplaza: si
 * alguien pasa autores mas deprisa de lo que llegan las fotos, lo que se quedo
 * atras ya no se va a ver y descargarlo seria gastar datos para nada.
 */
export const PRECARGAS_EN_ESPERA = 4;

/**
 * Cuanto espera un tramo a su foto antes de empezar a contar igualmente.
 *
 * Ocho segundos. La espera normal mas lenta medida es ~4,3 s: hasta 1,8 s de
 * primer byte (auditoria §11) mas ~2,5 s de bajar una foto de ~300 KB a 1 Mbps,
 * un 3G flojo. Ocho es casi el doble —no corta una carga lenta pero sana— y
 * queda por debajo de los ~10 s en los que una espera, aun con indicador, se
 * lee como «esto se ha colgado». Pasado el tope el tramo arranca: el visor
 * nunca se queda quieto, y si la foto llega a mitad de tramo se ve igual.
 */
export const ESPERA_MAXIMA_MS = 8000;

// ---------------------------------------------------------------------------
// 1. Que se precarga
// ---------------------------------------------------------------------------

/**
 * Solo fotos. Un video no se descarga entero para adivinar si alguien lo va a
 * abrir, y los tramos de video no traen poster que adelantar. Sin URL firmada
 * tampoco hay nada que pedir.
 */
function comoPrecarga(tramo: TramoACargar | undefined): Precarga | null {
  if (!tramo || tramo.mediaType !== 'image') return null;
  if (!tramo.mediaUrl || !tramo.storagePath) return null;
  return { uri: tramo.mediaUrl, cacheKey: tramo.storagePath };
}

/**
 * Al tener la lista: el primer tramo de los primeros autores con algo sin ver.
 *
 * EL PRIMER TRAMO, NO EL PRIMERO SIN VER, porque es por donde abre el visor
 * (`setSegIndex(0)` en `StoriesScreen`): precargar otro seria calentar una foto
 * que no se pinta al tocar. Si el visor pasara a abrir por el primero sin ver,
 * esto tiene que cambiar con el.
 *
 * Se salta tu propia historia —la subiste tu; es la que menos se abre para
 * mirarla— y los autores ya vistos, que la fila manda al final y casi nadie
 * reabre. El tope cuenta AUTORES, no fotos: un autor que abre con video gasta
 * su plaza sin descargar nada, para no ir a buscar mas alla de lo que se ve.
 */
export function precargasDeLaFila(
  grupos: readonly GrupoACargar[],
  autores: number = AUTORES_A_PRECARGAR,
): Precarga[] {
  const salida: Precarga[] = [];
  let contados = 0;
  for (const grupo of grupos) {
    if (contados >= autores) break;
    if (grupo.isOwn || grupo.seen || grupo.items.length === 0) continue;
    contados += 1;
    const precarga = comoPrecarga(grupo.items[0]);
    if (precarga) salida.push(precarga);
  }
  return salida;
}

/**
 * Dentro del visor: lo que viene justo despues de lo que se esta mirando.
 *
 * El siguiente tramo del mismo autor (es a donde lleva tocar la derecha o que
 * se acabe el tiempo) y el primero del autor siguiente (a donde lleva deslizar,
 * o acabar este autor). En ese orden: el primero es el paso mas probable.
 */
export function precargasDelVisor(
  grupos: readonly GrupoACargar[],
  autor: number,
  tramo: number,
): Precarga[] {
  const salida: Precarga[] = [];
  const delMismo = comoPrecarga(grupos[autor]?.items[tramo + 1]);
  if (delMismo) salida.push(delMismo);
  const delSiguiente = comoPrecarga(grupos[autor + 1]?.items[0]);
  if (delSiguiente && delSiguiente.cacheKey !== delMismo?.cacheKey) salida.push(delSiguiente);
  return salida;
}

// ---------------------------------------------------------------------------
// 2. Cuanto a la vez
// ---------------------------------------------------------------------------

export type ColaDePrecarga = {
  /**
   * Pide calentar estas imagenes. Lo ya pedido —hecho, en curso o esperando—
   * no se repite. `delante` lo pasa por delante de lo que espera: lo que pide
   * el visor es mas urgente que lo que se adelanto desde la fila.
   */
  pedir(lista: readonly Precarga[], opciones?: { delante?: boolean }): void;
  /**
   * Mientras dure la pausa no EMPIEZA nada nuevo (lo que ya baja, sigue).
   * Devuelve con que soltarla; se pueden solapar varias.
   */
  pausar(): () => void;
  /**
   * La precarga de esa clave si esta bajando ahora mismo. Se resuelve al
   * terminar, haya ido bien o mal; nunca falla.
   */
  enCurso(clave: string): Promise<void> | undefined;
  /** Foto del momento, para pruebas y diagnostico. */
  estado(): { enEspera: string[]; enCurso: string[]; hechas: string[]; enPausa: boolean };
};

/**
 * Una cola pequeña con tope, sin saber nada de expo-image: recibe la funcion
 * que calienta, para poder probar el orden y los limites con una falsa.
 *
 * UN FALLO NO CONDENA. Si una precarga falla (sin red, firma caducada) se
 * olvida, y se puede volver a pedir mas adelante. Lo que sale bien se recuerda
 * toda la sesion: volver a la fila no vuelve a pedir lo ya guardado.
 */
export function crearColaDePrecarga(
  calentar: (precarga: Precarga) => Promise<unknown>,
  {
    aLaVez = PRECARGAS_A_LA_VEZ,
    enEspera: maxEnEspera = PRECARGAS_EN_ESPERA,
  }: { aLaVez?: number; enEspera?: number } = {},
): ColaDePrecarga {
  const espera: Precarga[] = [];
  const enCurso = new Map<string, Promise<void>>();
  const hechas = new Set<string>();
  let pausas = 0;

  const conocida = (clave: string) =>
    hechas.has(clave) || enCurso.has(clave) || espera.some((p) => p.cacheKey === clave);

  const arrancar = () => {
    while (pausas === 0 && enCurso.size < aLaVez && espera.length > 0) {
      const precarga = espera.shift()!;
      const clave = precarga.cacheKey;
      let tarea: Promise<unknown>;
      try {
        tarea = Promise.resolve(calentar(precarga));
      } catch (error) {
        tarea = Promise.reject(error);
      }
      // Lo que se guarda en `enCurso` nunca falla: quien se engancha solo
      // quiere saber cuando ha terminado, no como.
      const terminada = tarea.then(
        () => {
          hechas.add(clave);
        },
        () => {
          // Nada que guardar: queda libre para volver a pedirse.
        },
      );
      enCurso.set(clave, terminada);
      void terminada.finally(() => {
        enCurso.delete(clave);
        arrancar();
      });
    }
  };

  return {
    pedir(lista, { delante = false } = {}) {
      const nuevas: Precarga[] = [];
      for (const precarga of lista) {
        const clave = precarga.cacheKey;
        if (nuevas.some((p) => p.cacheKey === clave)) continue;
        const esperando = espera.findIndex((p) => p.cacheKey === clave);
        if (delante && esperando >= 0) {
          // Ya estaba en cola, pero ahora corre prisa: se adelanta.
          espera.splice(esperando, 1);
          nuevas.push(precarga);
          continue;
        }
        if (conocida(clave)) continue;
        nuevas.push(precarga);
      }
      if (delante) espera.unshift(...nuevas);
      else espera.push(...nuevas);
      // Primero sale lo que tiene hueco, y solo despues se recorta: lo que ya
      // esta bajando no ocupa sitio en la espera.
      arrancar();
      // Lo que no cabe se descarta desde el final: es lo menos urgente.
      if (espera.length > maxEnEspera) espera.length = maxEnEspera;
    },
    pausar() {
      pausas += 1;
      let suelta = false;
      return () => {
        if (suelta) return;
        suelta = true;
        pausas -= 1;
        /*
          En el siguiente microtask, no ya. El visor suelta la pausa en la
          LIMPIEZA de un efecto y pide lo siguiente en la PUESTA EN MARCHA de
          otro, en la misma pasada; React ejecuta todas las limpiezas antes que
          ninguna puesta en marcha. Arrancando aqui mismo salia lo que esperaba
          de la fila y lo del visor —el tramo que viene en cinco segundos—
          tenia que esperar a que terminara. Medido en 3G: la segunda foto
          llegaba medio segundo tarde.
        */
        void Promise.resolve().then(arrancar);
      };
    },
    enCurso(clave) {
      return enCurso.get(clave);
    },
    estado() {
      return {
        enEspera: espera.map((p) => p.cacheKey),
        enCurso: [...enCurso.keys()],
        hechas: [...hechas],
        enPausa: pausas > 0,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Cuando cuenta un tramo
// ---------------------------------------------------------------------------

/**
 * - `cargando`: la foto (o el primer fotograma del video) aun no esta.
 * - `lista`: se esta viendo. Es la UNICA que cuenta como visto.
 * - `fallida`: no va a llegar (error, o no hay URL firmada que pedir).
 */
export type FaseDeCarga = 'cargando' | 'lista' | 'fallida';

export type CargaDelTramo = {
  tramoId: string;
  fase: FaseDeCarga;
  /** Se acabo `ESPERA_MAXIMA_MS` con la foto aun en camino. */
  esperaAgotada: boolean;
};

export type AvisoDeCarga = 'cargada' | 'fallida' | 'espera-agotada';

/**
 * Como empieza un tramo. Sin URL firmada ya se sabe que no hay foto que
 * esperar: el visor pinta su imagen de relleno y el tramo cuenta desde ya.
 */
export function cargaInicial(tramo: Pick<TramoACargar, 'id' | 'mediaUrl'>): CargaDelTramo {
  return {
    tramoId: tramo.id,
    fase: tramo.mediaUrl ? 'cargando' : 'fallida',
    esperaAgotada: false,
  };
}

/**
 * La carga del tramo que se esta mirando. Si lo guardado es de OTRO tramo
 * (se acaba de pasar al siguiente), no vale: se empieza de cero. Asi un estado
 * viejo no puede arrancar la barra del tramo nuevo ni un solo fotograma.
 */
export function cargaDe(
  guardada: CargaDelTramo | null,
  tramo: Pick<TramoACargar, 'id' | 'mediaUrl'>,
): CargaDelTramo {
  return guardada && guardada.tramoId === tramo.id ? guardada : cargaInicial(tramo);
}

/**
 * Lo que cambia con cada aviso de la imagen, del video o del temporizador.
 *
 * - Un aviso de otro tramo se ignora: puede llegar tarde, despues de pasar al
 *   siguiente, y no puede dar por cargado lo que no lo esta.
 * - `lista` y `fallida` son finales. En concreto, la imagen de relleno que se
 *   pinta cuando no hay URL tambien avisa de que cargo, y eso no es haber
 *   visto la historia.
 * - La foto que llega DESPUES del tope sigue contando como vista: llego y se
 *   esta viendo, aunque el tramo ya hubiera arrancado.
 */
export function trasAviso(
  actual: CargaDelTramo,
  tramoDelAviso: string,
  aviso: AvisoDeCarga,
): CargaDelTramo {
  if (tramoDelAviso !== actual.tramoId) return actual;
  if (aviso === 'espera-agotada') {
    return actual.esperaAgotada || actual.fase !== 'cargando'
      ? actual
      : { ...actual, esperaAgotada: true };
  }
  if (actual.fase !== 'cargando') return actual;
  return { ...actual, fase: aviso === 'cargada' ? 'lista' : 'fallida' };
}

/**
 * Si el tramo puede contar. Con la foto delante, claro; y tambien si fallo o si
 * se agoto la espera, porque la alternativa es un visor parado para siempre.
 * Al fallar se arranca el tramo en vez de saltarlo: sin red, saltar en cadena
 * cerraria el visor en un parpadeo; asi se ve el texto, se puede responder, y
 * tocar a la derecha sigue pasando.
 */
export function tramoPuedeContar(carga: CargaDelTramo): boolean {
  return carga.fase !== 'cargando' || carga.esperaAgotada;
}

/** La barra se mueve si el tramo puede contar y nadie lo tiene en pausa. */
export function barraAvanza(carga: CargaDelTramo, enPausa: boolean): boolean {
  return !enPausa && tramoPuedeContar(carga);
}

/**
 * Se da por vista cuando la foto (o el video) SE VE, no al abrir.
 *
 * Al abrir era mentira dos veces: quien desliza al siguiente autor antes de que
 * llegue la foto no la ha visto, y quien la abre sin red tampoco. En los dos
 * casos el anillo se apagaba y el autor sumaba una visita que no hubo. Asi, lo
 * que no se llego a ver sigue encendido para volver a el.
 */
export function seHaVisto(carga: CargaDelTramo): boolean {
  return carga.fase === 'lista';
}

/** El indicador va mientras la foto esta en camino, aunque el tramo ya cuente. */
export function muestraCargando(carga: CargaDelTramo): boolean {
  return carga.fase === 'cargando';
}
