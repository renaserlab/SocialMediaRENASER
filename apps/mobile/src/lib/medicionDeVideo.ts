/**
 * Cuanto tardan de verdad los videos de Inicio en el telefono de la gente.
 *
 * POR QUE EXISTE. La linea base que tenemos (primer video 3,1 s con wifi y
 * 6,6 s con 4G; pasar al siguiente 0,9 s y 13,5 s) se midio en la WEB. El
 * reproductor nativo de iPhone y de Android es otro mundo —otra cache, otro
 * buffer, HLS—, y decidir optimizaciones del movil con numeros del navegador es
 * adivinar. `perfMark` no sirve para esto: solo escribe en la consola de quien
 * desarrolla y solo con la bandera de depuracion encendida.
 *
 * QUE MIDE, por arranque de la aplicacion:
 *
 *   · hitos de la primera carga de Inicio, en ms desde que arranco el JS:
 *     feed pedido → respuesta del feed → URLs firmadas → primer fotograma →
 *     primera reproduccion real del primer video;
 *   · un tramo por cada video que pasa a ser el activo: cuanto tardo desde el
 *     gesto (o desde que se activo, si no hubo gesto) hasta REPRODUCIR, cuanto
 *     hasta el primer fotograma, cuantas veces se quedo esperando datos
 *     despues de arrancar y cuanto sumaron esas esperas, si era HLS o MP4 y
 *     cuanto pesaba, si se sabe.
 *
 * LO QUE NO PUEDE COSTAR. Esto corre en el telefono de quien usa la app, asi
 * que las reglas son estrictas y no se negocian:
 *
 *   · todo en memoria: ni disco, ni estado de React, ni un render por metrica;
 *   · un tope de tramos por sesion (`TOPE_DE_EVENTOS`);
 *   · UN solo envio por arranque, en un lote, al pasar a segundo plano o al
 *     minuto de sesion —lo que ocurra antes—, sin reintentos; si falla, se
 *     pierde y no pasa nada;
 *   · nunca lanza hacia fuera: cualquier fallo de la medicion se traga aqui.
 *
 * SIN DATOS PERSONALES. Ni id de usuario, ni id de publicacion, ni texto: el id
 * del video solo sirve aqui dentro para saber de que reproductor viene cada
 * aviso, y no sale en el lote. La sesion es un numero al azar por arranque.
 *
 * ESTE FICHERO NO IMPORTA NADA, a proposito: la logica se prueba con Node sin
 * React Native. Lo que toca el telefono (AppState, expo-device, fetch) vive en
 * `medicionDeVideoEnApp.ts`, que construye la instancia de verdad.
 */

/** Interruptor general. En `false`, cada llamada es una comparacion y nada mas. */
export const MEDICION_ENCENDIDA = true;

/**
 * Que fraccion de los arranques se mide (0 a 1).
 *
 * Al 100 % mientras hay pocos usuarios: cada sesion cuenta. Cuando el volumen
 * crezca, bajarlo aqui (0.1 = uno de cada diez arranques) basta; la decision se
 * toma una vez por arranque, asi que una sesion se mide entera o no se mide.
 */
export const MUESTREO = 1;

/** Cuantos tramos de video se guardan como mucho por sesion. */
export const TOPE_DE_EVENTOS = 30;

/** A los cuantos ms de la primera medicion se manda el lote si nadie salio antes. */
export const ENVIAR_TRAS_MS = 60_000;

/** Mas alla de esto un valor no es una medicion util (y el servidor lo rechaza). */
export const MS_MAXIMO = 120_000;

/**
 * Cuanto puede separarse el gesto de la activacion del video siguiente para
 * contar como «deslizar». Un gesto mas viejo que esto no fue el que trajo este
 * video: fue otro (un tirón que no llego a cambiar de pagina, por ejemplo).
 */
export const VENTANA_DEL_GESTO_MS = 3_000;

export type Hito =
  | 'feed_pedido'
  | 'feed_respuesta'
  | 'urls_firmadas'
  | 'primer_fotograma'
  | 'primera_reproduccion';

/**
 * Por que paso a ser activo un video.
 *  - `primer_video`: el primero que se ve en esta sesion.
 *  - `deslizamiento`: hubo un gesto de desplazamiento justo antes.
 *  - `otro`: volvio a activarse sin gesto (cambio de pestana, volver a Inicio).
 */
export type TipoDeTramo = 'primer_video' | 'deslizamiento' | 'otro';

export type FormatoDeVideo = 'hls' | 'mp4';

/** Estados del reproductor que interesan (los de expo-video). */
export type EstadoDelReproductor = 'idle' | 'loading' | 'readyToPlay' | 'error';

/** De donde salio el video. Hoy todo es Supabase; S3 llega con la spec de la opcion B. */
export type AlmacenDeVideo = 'supabase' | 's3';

export type TramoDeVideo = {
  tipo: TipoDeTramo;
  /** Desde el gesto (o la activacion) hasta reproducir de verdad. `null` = no llego. */
  hasta_reproducir_ms: number | null;
  /** Desde el gesto (o la activacion) hasta el primer fotograma, si se vio aqui. */
  hasta_fotograma_ms: number | null;
  /** Veces que se quedo esperando datos DESPUES de haber arrancado. */
  esperas: number;
  /** Suma de esas esperas. */
  espera_ms: number;
  formato: FormatoDeVideo;
  /** De donde salio el video: Supabase Storage (hoy) o S3 + CloudFront. */
  almacen: AlmacenDeVideo;
  /** Peso del archivo que se reproduce, si se conoce (nunca para HLS). */
  bytes: number | null;
  /** El reproductor dio error. */
  error: boolean;
};

export type ContextoDelEquipo = {
  plataforma: 'ios' | 'android' | 'web';
  version_app: string | null;
  /** Id corto de la actualizacion OTA, `embebido` o `null` si no se sabe. */
  build: string | null;
  modelo: string | null;
  sistema: string | null;
  /** Tipo de red. Hoy `null` en nativo: saberlo exige un modulo nativo nuevo. */
  red: string | null;
};

export type LoteDeMedicion = {
  sesion: string;
  contexto: ContextoDelEquipo;
  hitos: Partial<Record<Hito, number>>;
  tramos: TramoDeVideo[];
};

export type DependenciasDeMedicion = {
  /** Reloj en ms (Date.now en la app). */
  ahora: () => number;
  /** Instante del arranque del JS, en la misma escala que `ahora`. */
  origen: number;
  /** Generador al azar en [0, 1). Decide el muestreo y el id de sesion. */
  azar: () => number;
  /** Se pide SOLO al enviar: no se paga nada por leer el equipo antes. */
  contexto: () => ContextoDelEquipo;
  /** Manda el cuerpo. Puede devolver una promesa; si falla, se ignora. */
  enviar: (cuerpo: string) => unknown;
  /** Temporizador (setTimeout en la app). */
  programar: (accion: () => void, ms: number) => unknown;
  /** Se llama una vez, con la primera medicion: ahi la app escucha AppState. */
  alEmpezar?: () => void;
  encendida?: boolean;
  muestreo?: number;
  tope?: number;
  enviarTrasMs?: number;
};

export type Medicion = {
  hito: (nombre: Hito) => void;
  inicioDeGesto: () => void;
  videoActivo: (id: string, datos: { hls: boolean; bytes?: number | null; almacen?: AlmacenDeVideo | null }) => void;
  primerFotograma: (id: string) => void;
  reproduciendo: (id: string) => void;
  estado: (id: string, estado: EstadoDelReproductor) => void;
  /** La app paso a segundo plano: se manda lo que haya, si no se mando ya. */
  aSegundoPlano: () => void;
  /** Lo que se mandaria ahora mismo. Para las pruebas y para depurar. */
  lote: () => LoteDeMedicion;
  readonly midiendo: boolean;
  readonly enviado: boolean;
};

/** Orden de los hitos: cada uno solo vale si el anterior ya ocurrio. */
const PREVIO: Partial<Record<Hito, Hito>> = {
  feed_respuesta: 'feed_pedido',
  urls_firmadas: 'feed_respuesta',
};

type Activo = {
  id: string;
  tipo: TipoDeTramo;
  desde: number;
  formato: FormatoDeVideo;
  almacen: AlmacenDeVideo;
  bytes: number | null;
  reproducidoEn: number | null;
  fotogramaEn: number | null;
  esperas: number;
  esperaMs: number;
  esperandoDesde: number | null;
  error: boolean;
  primero: boolean;
};

/** Un valor en ms acotado a lo que tiene sentido, o `null`. */
function acotar(ms: number): number | null {
  if (!Number.isFinite(ms) || ms < 0 || ms > MS_MAXIMO) return null;
  return Math.round(ms);
}

function idDeSesion(azar: () => number): string {
  let id = '';
  for (let i = 0; i < 16; i++) id += Math.floor(azar() * 16).toString(16);
  return id;
}

export function crearMedicion(deps: DependenciasDeMedicion): Medicion {
  const encendida = deps.encendida ?? MEDICION_ENCENDIDA;
  const muestreo = deps.muestreo ?? MUESTREO;
  const tope = deps.tope ?? TOPE_DE_EVENTOS;
  const enviarTrasMs = deps.enviarTrasMs ?? ENVIAR_TRAS_MS;

  // Se decide UNA vez: una sesion se mide entera o no se mide.
  let midiendo = false;
  try {
    midiendo = encendida && deps.azar() < muestreo;
  } catch {
    midiendo = false;
  }
  const sesion = midiendo ? idDeSesion(deps.azar) : '';

  const hitos: Partial<Record<Hito, number>> = {};
  const tramos: TramoDeVideo[] = [];
  let activo: Activo | null = null;
  let gestoEn: number | null = null;
  let huboVideo = false;
  let empezada = false;
  let enviado = false;

  /** Todo lo que hay detras de una llamada publica: nunca lanza. */
  const seguro =
    <A extends unknown[]>(accion: (...args: A) => void) =>
    (...args: A): void => {
      if (!midiendo || enviado) return;
      try {
        accion(...args);
      } catch {
        // La medicion no puede romper nada de lo que mide.
      }
    };

  function empezar(): void {
    if (empezada) return;
    empezada = true;
    try {
      deps.alEmpezar?.();
    } catch {
      /* sin AppState no hay envio al salir; queda el del minuto */
    }
    try {
      deps.programar(() => enviar(), enviarTrasMs);
    } catch {
      /* sin temporizador queda el envio al pasar a segundo plano */
    }
  }

  function marcarHito(nombre: Hito, en: number): void {
    if (hitos[nombre] !== undefined) return;
    const previo = PREVIO[nombre];
    if (previo && hitos[previo] === undefined) return;
    const ms = acotar(en - deps.origen);
    if (ms === null) return;
    hitos[nombre] = ms;
    empezar();
  }

  /** El tramo de un video tal como va ahora mismo. No toca nada. */
  function tramoDe(a: Activo): TramoDeVideo {
    let esperaMs = a.esperaMs;
    if (a.esperandoDesde !== null) esperaMs += deps.ahora() - a.esperandoDesde;
    return {
      tipo: a.tipo,
      hasta_reproducir_ms: a.reproducidoEn === null ? null : acotar(a.reproducidoEn - a.desde),
      hasta_fotograma_ms: a.fotogramaEn === null ? null : acotar(a.fotogramaEn - a.desde),
      esperas: Math.min(a.esperas, 1000),
      espera_ms: acotar(esperaMs) ?? MS_MAXIMO,
      formato: a.formato,
      almacen: a.almacen,
      bytes: a.bytes,
      error: a.error,
    };
  }

  function cerrarActivo(): void {
    const a = activo;
    if (!a) return;
    activo = null;
    if (tramos.length < tope) tramos.push(tramoDe(a));
  }

  function construirLote(): LoteDeMedicion {
    // El que se esta viendo al enviar tambien cuenta, tal como vaya.
    const todos = activo && tramos.length < tope ? [...tramos, tramoDe(activo)] : [...tramos];
    return { sesion, contexto: deps.contexto(), hitos: { ...hitos }, tramos: todos };
  }

  function enviar(): void {
    if (!midiendo || enviado) return;
    enviado = true;
    try {
      const lote = construirLote();
      // Nada medido (no se llego a abrir Inicio): no se manda nada.
      if (Object.keys(lote.hitos).length === 0 && lote.tramos.length === 0) return;
      const resultado = deps.enviar(JSON.stringify(lote));
      // Fuego y olvido: un rechazo de la promesa no puede llegar a nadie.
      if (resultado && typeof (resultado as Promise<unknown>).catch === 'function') {
        (resultado as Promise<unknown>).catch(() => {});
      }
    } catch {
      // Sin red, sin servidor o sin JSON: se pierde la medicion y ya.
    }
  }

  return {
    hito: seguro((nombre: Hito) => marcarHito(nombre, deps.ahora())),

    inicioDeGesto: seguro(() => {
      gestoEn = deps.ahora();
    }),

    videoActivo: seguro((id: string, datos: { hls: boolean; bytes?: number | null; almacen?: AlmacenDeVideo | null }) => {
      if (activo?.id === id) return;
      const ahora = deps.ahora();
      cerrarActivo();
      const primero = !huboVideo;
      huboVideo = true;
      const gestoReciente = gestoEn !== null && ahora - gestoEn <= VENTANA_DEL_GESTO_MS;
      const tipo: TipoDeTramo = primero ? 'primer_video' : gestoReciente ? 'deslizamiento' : 'otro';
      // Un gesto solo trae UN video: el siguiente necesita su propio gesto.
      const desde = tipo === 'deslizamiento' && gestoEn !== null ? gestoEn : ahora;
      gestoEn = null;
      const bytes =
        !datos.hls && typeof datos.bytes === 'number' && Number.isFinite(datos.bytes) && datos.bytes > 0
          ? Math.round(datos.bytes)
          : null;
      activo = {
        id,
        tipo,
        desde,
        formato: datos.hls ? 'hls' : 'mp4',
        almacen: datos.almacen === 's3' ? 's3' : 'supabase',
        bytes,
        reproducidoEn: null,
        fotogramaEn: null,
        esperas: 0,
        esperaMs: 0,
        esperandoDesde: null,
        error: false,
        primero,
      };
      empezar();
    }),

    primerFotograma: seguro((id: string) => {
      const a = activo;
      if (!a || a.id !== id || a.fotogramaEn !== null) return;
      a.fotogramaEn = deps.ahora();
      if (a.primero) marcarHito('primer_fotograma', a.fotogramaEn);
    }),

    reproduciendo: seguro((id: string) => {
      const a = activo;
      if (!a || a.id !== id) return;
      const ahora = deps.ahora();
      if (a.reproducidoEn === null) {
        a.reproducidoEn = ahora;
        if (a.primero) marcarHito('primera_reproduccion', ahora);
      }
      if (a.esperandoDesde !== null) {
        a.esperaMs += ahora - a.esperandoDesde;
        a.esperandoDesde = null;
      }
    }),

    estado: seguro((id: string, estado: EstadoDelReproductor) => {
      const a = activo;
      if (!a || a.id !== id) return;
      if (estado === 'error') {
        a.error = true;
        return;
      }
      // Solo cuenta como espera si ya habia arrancado: la carga inicial es
      // `hasta_reproducir_ms`, no una espera.
      if (estado === 'loading' && a.reproducidoEn !== null && a.esperandoDesde === null) {
        a.esperas += 1;
        a.esperandoDesde = deps.ahora();
      }
    }),

    aSegundoPlano: () => enviar(),

    lote: () => construirLote(),

    get midiendo() {
      return midiendo;
    },
    get enviado() {
      return enviado;
    },
  };
}
