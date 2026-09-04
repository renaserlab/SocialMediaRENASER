/**
 * CUANTAS VECES SE REINTENTA UN DIRECTO, CUANTO SE ESPERA, Y CUANDO SE PARA.
 *
 * POR QUE ES UN FICHERO APARTE Y SIN IMPORTS. Es la misma razon que
 * `lib/estadoDePermiso.ts` o `navigation/atras.ts`: es la parte con REGLAS, y
 * escrita dentro de un `useEffect` no se puede comprobar sin montar la
 * aplicacion, esperar de verdad los segundos y provocar de verdad un 429.
 *
 * LOS DOS FALLOS QUE ESTO IMPIDE, y los dos son reales en un directo:
 *
 *  1. REINTENTAR LO QUE NO SE PUEDE ARREGLAR. El backend contesta 503
 *     `live_provider_not_configured` cuando no hay proveedor contratado. Eso no
 *     cambia por insistir: un bucle de reintentos contra ese 503 gasta bateria
 *     y datos toda la tarde para acabar exactamente igual. Lo mismo con un 403
 *     —quien mira esta bloqueado— y con un 409 —la emision ya termino—.
 *
 *  2. REINTENTAR UN LIMITE DE RITMO A TODA VELOCIDAD. El endpoint de credencial
 *     tiene freno (429 `live_credential_rate_limited`). Volver a pedirla al
 *     segundo siguiente no la consigue: alarga el castigo. Por eso el 429 tiene
 *     su propia espera minima y respeta la que sugiera el servidor.
 *
 * Y LO QUE NUNCA HACE: reintentos infinitos. Hay un tope duro, y al llegar se
 * para y se lo dice a la persona, que es quien decide si insiste.
 */

/* ------------------------------------------------------------------ Ajustes */

/**
 * Reintentos AUTOMATICOS como maximo. Al cuarto fallo se para.
 *
 * Tres y no diez: con la espera exponencial de abajo, tres reintentos cubren
 * algo mas de veinte segundos de red mala, que es lo que dura un cambio de
 * celda o un ascensor. Mas alla de eso el problema ya no es un bache, y seguir
 * intentandolo en silencio solo consigue que la pantalla parezca colgada.
 */
export const MAXIMO_DE_REINTENTOS = 3;

/** Espera del primer reintento. Se duplica en cada uno siguiente. */
export const ESPERA_BASE_MS = 1_000;

/** Tope de la espera calculada. */
export const ESPERA_MAXIMA_MS = 20_000;

/**
 * Espera minima despues de un 429.
 *
 * El freno del backend se cuenta en ventanas de varios segundos; volver antes
 * es pedir otro 429 y gastar uno de los tres reintentos sin ninguna opcion de
 * acertar.
 */
export const ESPERA_MINIMA_TRAS_LIMITE_MS = 5_000;

/**
 * Tope de lo que se acepta de una sugerencia del servidor (`Retry-After`).
 *
 * Se obedece al servidor, pero no hasta el infinito: una cabecera absurda
 * —minutos— dejaria la pantalla esperando sin nada que mirar. Pasado el minuto
 * se para y se le ofrece a la persona reintentar cuando quiera.
 */
export const ESPERA_SUGERIDA_MAXIMA_MS = 60_000;

/**
 * Las clases de fallo que NO se reintentan nunca.
 *
 * Se escribe la lista de lo que se descarta, no la de lo que se reintenta: un
 * fallo nuevo que nadie haya clasificado todavia cae del lado de reintentar, y
 * equivocarse hacia ese lado cuesta tres peticiones; hacia el otro, dejar
 * muerta una pantalla que se habria recuperado sola.
 */
export const CLASES_SIN_REINTENTO = ['sin_proveedor', 'no_unible', 'sin_permiso'] as const;

/* ------------------------------------------------------------------- El plan */

export type MotivoDeParada =
  /** El fallo no se arregla insistiendo. */
  | 'definitivo'
  /** Se acabaron los intentos. */
  | 'agotado';

export type PlanDeReintento =
  | { reintentar: true; intento: number; enMs: number }
  | { reintentar: false; motivo: MotivoDeParada };

export type EntradaDeReintento = {
  /**
   * Reintentos YA hechos. Cero en el primer fallo.
   *
   * Se cuentan los reintentos, no los intentos: el primero no es un reintento,
   * y contarlo desplazaria toda la escalera de esperas.
   */
  intentosHechos: number;
  /** Como se clasifico el fallo. Ver `maquinaDeDirecto.clasificarFallo`. */
  clase: string;
  /** Lo que sugiere el servidor, si lo sugiere. Solo se mira en un 429. */
  esperaSugeridaMs?: number | null;
  /**
   * Fuente de dispersion, en `[0, 1)`. Inyectada para que las pruebas puedan
   * afirmar una espera exacta en vez de un intervalo.
   */
  azar?: () => number;
};

function normalizarIntentos(valor: number): number {
  // Un contador que llega roto (NaN por una resta con undefined, negativo por
  // un reinicio a medias) se trata como «ninguno todavia»: nunca como si ya se
  // hubieran agotado, porque eso cortaria un reintento legitimo.
  if (!Number.isFinite(valor) || valor < 0) return 0;
  return Math.floor(valor);
}

/**
 * Decide si hay otro intento, y dentro de cuanto.
 *
 * LA DISPERSION NO ES ADORNO. Cuando un directo se cae, se cae para todo el
 * mundo a la vez: sin dispersion, los mil telefonos que estaban mirando vuelven
 * a pedir credencial en el mismo milisegundo y tiran el endpoint justo cuando
 * intenta recuperarse. El factor va entre 0,75 y 1,25 de la espera calculada.
 *
 * La sugerencia del servidor NO se dispersa hacia abajo: si dice «espera diez
 * segundos», volver a los siete y medio es desobedecer y ganarse otro 429.
 */
export function planificarReintento({
  intentosHechos,
  clase,
  esperaSugeridaMs,
  azar = () => 0.5,
}: EntradaDeReintento): PlanDeReintento {
  if ((CLASES_SIN_REINTENTO as readonly string[]).includes(clase)) {
    return { reintentar: false, motivo: 'definitivo' };
  }

  const hechos = normalizarIntentos(intentosHechos);
  if (hechos >= MAXIMO_DE_REINTENTOS) {
    return { reintentar: false, motivo: 'agotado' };
  }

  const sugerida =
    typeof esperaSugeridaMs === 'number' &&
    Number.isFinite(esperaSugeridaMs) &&
    esperaSugeridaMs > 0
      ? esperaSugeridaMs
      : null;

  // Un servidor que pide mas de un minuto no esta pidiendo un reintento: esta
  // diciendo que vuelvas mas tarde. Se para y decide la persona.
  if (sugerida !== null && sugerida > ESPERA_SUGERIDA_MAXIMA_MS) {
    return { reintentar: false, motivo: 'agotado' };
  }

  const exponencial = Math.min(ESPERA_MAXIMA_MS, ESPERA_BASE_MS * 2 ** hechos);
  const piso = clase === 'limitado' ? ESPERA_MINIMA_TRAS_LIMITE_MS : 0;
  const calculada = Math.max(exponencial, piso);

  // `azar()` fuera de `[0, 1)` no dispersa nada: se ignora y queda la espera
  // calculada tal cual, que siempre es una espera valida.
  const bruto = azar();
  const factor = Number.isFinite(bruto) && bruto >= 0 && bruto < 1 ? 0.75 + bruto * 0.5 : 1;

  const enMs =
    sugerida !== null && clase === 'limitado'
      ? Math.round(Math.max(calculada, sugerida))
      : Math.round(calculada * factor);

  return { reintentar: true, intento: hechos + 1, enMs };
}

/**
 * Adaptador para la maquina de estados: los milisegundos, o `null` si se para.
 *
 * La maquina no necesita saber POR QUE se para —lo unico que cambia en pantalla
 * es que deja de haber reintento— y con esto no tiene que importar este fichero,
 * cosa que ademas el proyecto no permite entre modulos `.ts` probados con Node.
 */
export function esperaAntesDeReintentar(
  intentosHechos: number,
  clase: string,
  esperaSugeridaMs?: number | null,
): number | null {
  const plan = planificarReintento({ intentosHechos, clase, esperaSugeridaMs });
  return plan.reintentar ? plan.enMs : null;
}
