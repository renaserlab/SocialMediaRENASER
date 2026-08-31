import type { TranslationKey } from '@/i18n';

/**
 * CUANTO PUEDE DURAR UNA HISTORIA. Un solo numero y una sola decision.
 *
 * QUE PEDIA EL ENCARGO: hasta treinta segundos se publica; mas de treinta NO se
 * publica directamente y se avisa con claridad. Y ademas, poder recortar como
 * en WhatsApp.
 *
 * EL RECORTE NO EXISTE, Y NO SE FINGE. Se miro primero que hay instalado:
 *
 *   - `react-native-compressor` 1.19.4 —el unico modulo nativo de media del
 *     proyecto— solo sabe RECOMPRIMIR un archivo entero. Su contrato nativo
 *     (`NativeCompressor.ts`) no tiene ni `startTime`, ni `endTime`, ni `trim`.
 *   - No hay `expo-av`, ni `expo-video-thumbnails`, ni `ffmpeg-kit`. Cero.
 *   - En el servidor SI hay ffmpeg, pero las historias no pasan por la API:
 *     se insertan directamente contra PostgREST.
 *
 * Cortar un video de verdad pide o una dependencia nativa nueva (y con ella una
 * compilacion nueva, porque en Expo Go no cargaria) o mover la creacion de
 * historias al backend. Las dos son decisiones de alcance, no un detalle que se
 * pueda colar aqui. Asi que hoy: LIMITE REAL, MEDIDO Y BIEN EXPLICADO, y el
 * recorte queda escrito como pendiente. Un recortador que en realidad no
 * recorta seria peor que no tenerlo.
 *
 * LO QUE SI SE ARREGLA. Antes el limite se comprobaba contra la duracion que
 * REPORTABA el selector, y esa cifra falta a menudo: cuando faltaba valia cero
 * y un video de cinco minutos pasaba el control sin que nadie lo mirara. Ahora
 * se distingue «cabe», «no cabe» y «no se ha podido medir», que son tres
 * situaciones distintas y piden tres respuestas distintas.
 */

/** Tope de una historia. */
export const MAX_HISTORIA_MS = 30_000;

/**
 * Lo que admite hoy la base de datos.
 *
 * La migracion 0003 dejo escrito `check (duration_ms between 1000 and 15000)`.
 * Subir el tope a treinta segundos necesita la migracion 0042, que esta escrita
 * pero SIN aplicar. Mientras no se aplique, el numero que se GUARDA no puede
 * pasar de aqui o la insercion se rechaza; ver `StoryRepository.create`, que se
 * apoya en esto para degradar sin romper nada.
 */
export const TOPE_GUARDADO_SIN_0042_MS = 15_000;

/** Lo que dura una foto en el visor. */
export const FOTO_MS = 5_000;

/** Minimo que admite la base de datos: por debajo, el visor ni parpadea. */
export const MIN_HISTORIA_MS = 1_000;

export type DecisionDeHistoria =
  | { estado: 'cabe'; durationMs: number }
  | { estado: 'demasiado-larga'; durationMs: number; mensaje: string }
  | { estado: 'sin-medir'; mensaje: string };

/** Segundos legibles: 30, 12.5, sin decimales inutiles. */
function segundos(ms: number): string {
  const s = ms / 1000;
  return Number.isInteger(s) ? String(s) : s.toFixed(1);
}


/**
 * Cómo se traduce lo que sale de aquí.
 *
 * Lo pasa quien pinta. Este módulo NO puede importar el diccionario: se prueba
 * con el runner de Node, que no resuelve el alias `@/`. Sin traductor se
 * escribe en español, que es el idioma de referencia.
 */
export type Traductor = (
  clave: TranslationKey,
  params?: Record<string, string | number>,
) => string;

/**
 * El español de cada clave. Es el mismo texto que hay en `i18n/es.ts`, y que no
 * se desvíen lo comprueba `i18n/diccionariosSincronizados.test.mts`.
 */
export const RESPALDOS_ES = {
  'story.cannotMeasure':
    'No pudimos comprobar cuánto dura este vídeo. Grábalo con la cámara de la app, que ya corta a los {tope} segundos.',
  'story.tooLong':
    'Este vídeo dura {duracion} s y las historias admiten hasta {tope}. Todavía no podemos recortarlo aquí: elige un vídeo más corto, recórtalo en tu galería o grábalo con la cámara de la app.',
} as const;

const enEspanol: Traductor = (clave, params) => {
  let texto: string = RESPALDOS_ES[clave as keyof typeof RESPALDOS_ES] ?? '';
  for (const [nombre, valor] of Object.entries(params ?? {})) {
    texto = texto.replace(`{${nombre}}`, String(valor));
  }
  return texto;
};

/**
 * ¿Se puede publicar este video como historia?
 *
 * `durationMs` es lo que se haya podido MEDIR: `null` o `0` significan que
 * nadie sabe cuanto dura, no que dure cero.
 */
export function revisarDuracionDeHistoria(
  durationMs: number | null | undefined,
  traducir: Traductor = enEspanol,
): DecisionDeHistoria {
  if (durationMs === null || durationMs === undefined || durationMs <= 0) {
    /*
      No se pudo medir. Ocurre cuando el modulo nativo de metadatos no esta
      disponible (Expo Go) y el selector tampoco informa. Antes esto contaba
      como «dura cero» y colaba cualquier cosa; ahora se dice la verdad y se
      ofrece la unica salida honesta, que es grabar dentro de la aplicacion,
      donde el tope lo pone la propia camara.
    */
    return {
      estado: 'sin-medir',
      mensaje: traducir('story.cannotMeasure', { tope: segundos(MAX_HISTORIA_MS) }),
    };
  }
  if (durationMs > MAX_HISTORIA_MS) {
    return {
      estado: 'demasiado-larga',
      durationMs,
      mensaje: traducir('story.tooLong', {
        duracion: segundos(durationMs),
        tope: segundos(MAX_HISTORIA_MS),
      }),
    };
  }
  return { estado: 'cabe', durationMs: Math.max(MIN_HISTORIA_MS, Math.round(durationMs)) };
}

/**
 * Une lo que dicen las dos fuentes de duracion.
 *
 * El selector y la camara dan una cifra (a veces ninguna) y el modulo de
 * metadatos lee el archivo. Se queda con la MAYOR de las dos, no con la del
 * archivo a secas: si una de las dos dice que el video es largo, es largo. Un
 * limite que se relaja en cuanto una fuente falla no es un limite.
 */
export function duracionMedida(
  reportadaMs: number | null | undefined,
  medidaMs: number | null | undefined,
): number | null {
  const candidatas = [reportadaMs, medidaMs].filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0,
  );
  return candidatas.length ? Math.max(...candidatas) : null;
}
