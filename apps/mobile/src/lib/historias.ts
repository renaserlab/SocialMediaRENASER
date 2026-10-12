import type { TranslationKey } from '@/i18n';

/**
 * CUANTO PUEDE DURAR UNA HISTORIA, y como se elige el tramo que se queda.
 *
 * QUE PEDIA EL ENCARGO: hasta treinta segundos se publica; mas de treinta se
 * recorta. Un solo numero (`MAX_HISTORIA_MS`) y una sola decision.
 *
 * ===========================================================================
 * EL RECORTE YA EXISTE, Y LO HACE EL SERVIDOR. HAY QUE SUBIR EL VIDEO ENTERO.
 * ===========================================================================
 *
 * No es lo que hace WhatsApp. WhatsApp corta en el telefono y sube solo el
 * tramo; aqui se sube el video completo y el servidor se queda con el tramo.
 * ES LA UNICA VIA HONESTA CON LO QUE HAY INSTALADO:
 *
 *   - `react-native-compressor` 1.19.4 —el unico modulo nativo de media del
 *     proyecto— solo sabe RECOMPRIMIR un archivo entero. Su contrato nativo
 *     (`NativeCompressor.ts`) no tiene ni `startTime`, ni `endTime`, ni `trim`.
 *   - No hay `expo-av`, ni `expo-video-thumbnails`, ni `ffmpeg-kit`. Cero.
 *   - En el SERVIDOR si hay ffmpeg, desde el 27/08/2026 (ver `apps/api/Dockerfile`).
 *
 * Cortar aqui exigiria una dependencia nativa nueva y, con ella, una
 * compilacion nueva —en Expo Go no cargaria—. Asi que se corta donde SI se
 * puede. Lo que cuesta: los datos de quien publica, que sube el video entero
 * aunque solo se vea un tramo. Lo que lo hace soportable: el movil ya comprime
 * antes de subir (~2.5 Mbps), asi que no viaja el original de camara.
 *
 * Este fichero solo hace las CUENTAS del tramo. Quien lo corta es
 * `apps/api/app/modules/stories/recorte.py`, y quien decide si un video se
 * puede publicar es el servidor midiendo el archivo con ffprobe: lo de aqui es
 * para que la persona vea lo que elige, no el control de verdad.
 *
 * LO QUE SE ARREGLO ANTES Y SIGUE VALIENDO. El limite se comprobaba contra la
 * duracion que REPORTABA el selector, y esa cifra falta a menudo: cuando
 * faltaba valia cero y un video de cinco minutos pasaba el control sin que
 * nadie lo mirara. Ahora se distingue «cabe», «no cabe» y «no se ha podido
 * medir», que son tres situaciones distintas y piden tres respuestas distintas.
 */

/** Tope de una historia. */
export const MAX_HISTORIA_MS = 30_000;

/**
 * Lo que admitia la base ANTES de la 0042.
 *
 * La migracion 0003 dejo escrito `check (duration_ms between 1000 and 15000)`.
 * La 0042 lo subio a treinta y YA ESTA APLICADA, asi que el reintento que se
 * apoya en este numero (`StoryRepository.create`) no llega a ejecutarse nunca.
 * Se conserva porque una aplicacion instalada hace meses puede seguir hablando
 * con una base que no lo este, y porque quitarlo no arregla nada.
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
    'No pudimos comprobar cuánto dura este video. Grábalo con la cámara de la app, que ya corta a los {tope} segundos.',
  'story.tooLong':
    'Este video dura {duracion} s y las historias admiten hasta {tope}. Elige el tramo que quieres publicar: lo recortamos al subirlo.',
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

/* ------------------------------------------------------------------------- *
 * EL TRAMO
 *
 * Las cuentas del recortador, aparte del componente que las pinta. Aqui no hay
 * pixeles ni gestos: entra un tramo y una duracion, sale un tramo valido. Asi
 * se puede comprobar lo unico que importa de verdad —que NUNCA sale un tramo de
 * mas de treinta segundos ni uno que se salga del video— sin montar una
 * pantalla.
 *
 * QUIEN MANDA NO ES ESTO. El tramo viaja a `POST /stories` y alli se revisa
 * otra vez contra la duracion que mide ffprobe sobre el archivo ya subido
 * (`stories/recorte.py`). Lo de aqui es para que la persona vea lo que elige;
 * un limite que solo vive en el cliente no es un limite.
 * ------------------------------------------------------------------------- */

/** Un trozo del video, en milisegundos desde el principio. */
export type Tramo = { inicioMs: number; finMs: number };

/** Lo que dura un tramo. */
export function largoDelTramo(tramo: Tramo): number {
  return tramo.finMs - tramo.inicioMs;
}

function acotar(valor: number, minimo: number, maximo: number): number {
  return Math.max(minimo, Math.min(maximo, Math.round(valor)));
}

/**
 * El tramo que se propone al abrir el recortador: desde el principio, y tan
 * largo como se admita.
 *
 * Empezar por el principio y no por el medio porque es lo que la persona acaba
 * de ver al elegir el video, y porque cualquier otra eleccion seria una
 * suposicion sobre que parte le interesa.
 */
export function tramoInicial(duracionMs: number): Tramo {
  const fin = Math.min(duracionMs, MAX_HISTORIA_MS);
  return { inicioMs: 0, finMs: Math.max(fin, Math.min(duracionMs, MIN_HISTORIA_MS)) };
}

/**
 * Mueve el PRINCIPIO. El final se queda donde esta.
 *
 * CADA TIRADOR MUEVE SOLO SU LADO, y el otro extremo es su limite. Es lo que
 * hace cualquier recortador y es lo unico predecible: si arrastrar el principio
 * empujara el final, el tramo se desplazaria bajo el dedo y quien lo mira no
 * sabria cual de los dos esta moviendo. Para mover los dos a la vez esta
 * `desplazarTramo`, que es lo que hace arrastrar por el medio.
 *
 * Los topes: no se puede pasar del final menos el minimo, ni quedarse mas atras
 * de lo que el tope de treinta segundos permite.
 */
export function moverInicio(_duracionMs: number, tramo: Tramo, inicioMs: number): Tramo {
  const inicio = acotar(
    inicioMs,
    Math.max(0, tramo.finMs - MAX_HISTORIA_MS),
    Math.max(0, tramo.finMs - MIN_HISTORIA_MS),
  );
  return { inicioMs: inicio, finMs: tramo.finMs };
}

/** Mueve el FINAL. Mismo criterio, del otro lado. */
export function moverFin(duracionMs: number, tramo: Tramo, finMs: number): Tramo {
  const fin = acotar(
    finMs,
    Math.min(tramo.inicioMs + MIN_HISTORIA_MS, duracionMs),
    Math.min(duracionMs, tramo.inicioMs + MAX_HISTORIA_MS),
  );
  return { inicioMs: tramo.inicioMs, finMs: fin };
}

/**
 * Arrastra el tramo ENTERO sin cambiar lo que dura.
 *
 * Al chocar con un extremo se queda pegado a el en vez de encogerse: encoger el
 * tramo porque el dedo se ha pasado no es lo que nadie espera.
 */
export function desplazarTramo(duracionMs: number, tramo: Tramo, deltaMs: number): Tramo {
  const largo = largoDelTramo(tramo);
  const inicio = acotar(tramo.inicioMs + deltaMs, 0, Math.max(0, duracionMs - largo));
  return { inicioMs: inicio, finMs: inicio + largo };
}

/** `true` si este tramo se puede mandar al servidor. */
export function tramoValido(duracionMs: number, tramo: Tramo): boolean {
  const largo = largoDelTramo(tramo);
  return (
    tramo.inicioMs >= 0 &&
    tramo.finMs <= duracionMs &&
    largo >= Math.min(MIN_HISTORIA_MS, duracionMs) &&
    largo <= MAX_HISTORIA_MS
  );
}

/** `m:ss` para pintar una marca de tiempo. */
export function reloj(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutos = Math.floor(total / 60);
  return `${minutos}:${String(total % 60).padStart(2, '0')}`;
}
