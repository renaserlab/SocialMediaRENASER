/**
 * «MEJORAR»: PIEL SUAVE, LUZ, CONTRASTE, NITIDEZ Y RUBOR EN LA CÁMARA DE QUIEN
 * EMITE (aprobado el 02/11/2026, maqueta «Efectos de cámara» v4).
 *
 * SIN TERCEROS. En Android los aplica un complemento de video propio que
 * retoca en la GPU (`modules/mejoras-de-video`), enganchado al SDK de 100ms,
 * a los fotogramas ANTES de codificarlos: lo que ve quien emite es lo que
 * reciben los demás. El filtro de 100ms (`HMSVideoFilter`) se probó y se
 * descartó: se quedaba segundos atrás y devolvía la imagen en espejo. En iOS
 * no se ofrece todavía.
 *
 * ESTE FICHERO NO SABE DE QUÉ SDK SE TRATA. Habla con un
 * `ComplementoDeMejoras` de tres verbos —encender, ajustar, apagar— y guarda
 * las reglas que el complemento no tiene:
 *
 *   - Cada efecto va de 0 a 100 y 0 es SIN EFECTO: el valor neutro del filtro.
 *     Cuánto es 100 en cada plataforma lo dicen `ESCALA_ANDROID` y
 *     `ESCALA_IOS`, y es lo único que hay que tocar para afinarlo.
 *   - Una operación a la vez, y manda LA ÚLTIMA: arrastrar la barra no deja
 *     una cola de valores viejos.
 *   - Ninguna llamada puede dejar el control colgado: todas tienen límite de
 *     tiempo, el mismo que los fondos.
 *   - Si algo falla o no contesta, «Mejorar» SE APAGA SOLO para esta sala, con
 *     los valores en 0, y se dice. La cámara sigue como estaba.
 *   - NO SE COMBINA CON UN FONDO (ver `MEJORAR_Y_FONDO_A_LA_VEZ`): mientras
 *     haya un fondo o un desenfoque, el filtro está quitado; al volver a
 *     «Ninguno», se repone con los mismos valores.
 *
 * Y además, puro y con su prueba: la barra (imán y límite de envío) y lo que
 * se recuerda en el teléfono.
 *
 * NO IMPORTA NADA DE REACT NI DEL SDK: se ejecuta con `node --test`.
 */

// Solo TIPOS por ruta relativa: un `import` de valores con extensión lo
// rechaza TypeScript (TS5097), y sin extensión no lo encuentra `node --test`.
import type { ComplementoDeEfectos } from './efectosDeVideo.ts';

/**
 * Los mismos límites de tiempo que los fondos (`ESPERA_DE_EFECTO_MS` y
 * `ESPERA_AL_SALIR_MS` de `efectosDeVideo.ts`; la prueba comprueba que no se
 * separen): 8 s para cualquier llamada, 1,5 s al salir.
 */
export const ESPERA_DE_MEJORA_MS = 8_000;
export const ESPERA_DE_MEJORA_AL_SALIR_MS = 1_500;

/* ------------------------------------------------------------------------- *
 * LOS CINCO EFECTOS
 * ------------------------------------------------------------------------- */

/** En el orden de la hoja. */
export const MEJORAS = ['piel', 'luz', 'contraste', 'nitidez', 'rubor'] as const;

export type IdDeMejora = (typeof MEJORAS)[number];

/** Cada efecto, de 0 (sin efecto) a 100. Enteros. */
export type ValoresDeMejora = Record<IdDeMejora, number>;

export function valoresEnCero(): ValoresDeMejora {
  return { piel: 0, luz: 0, contraste: 0, nitidez: 0, rubor: 0 };
}

/** Un valor de la barra: entero de 0 a 100. Lo que no es un número, 0. */
export function normalizarValor(valor: unknown): number {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return 0;
  return Math.min(100, Math.max(0, Math.round(valor)));
}

/** Los cinco, normalizados. Lo que falta o no vale, 0. */
export function normalizarValores(valores: unknown): ValoresDeMejora {
  const limpio = valoresEnCero();
  if (typeof valores !== 'object' || valores === null) return limpio;
  for (const id of MEJORAS) {
    limpio[id] = normalizarValor((valores as Record<string, unknown>)[id]);
  }
  return limpio;
}

/** Si hay algún efecto puesto. */
export function hayMejora(valores: ValoresDeMejora): boolean {
  return MEJORAS.some((id) => valores[id] > 0);
}

export function mismosValores(a: ValoresDeMejora, b: ValoresDeMejora): boolean {
  return MEJORAS.every((id) => a[id] === b[id]);
}

/* ------------------------------------------------------------------------- *
 * LA BARRA
 * ------------------------------------------------------------------------- */

/** Donde la barra se engancha: sin efecto y la mitad. */
export const IMANES: readonly number[] = [0, 50];

/** A cuántos puntos del imán se engancha. */
export const RADIO_DEL_IMAN = 3;

/** El valor con el imán aplicado. */
export function conIman(valor: number): number {
  const v = normalizarValor(valor);
  for (const iman of IMANES) {
    if (Math.abs(v - iman) <= RADIO_DEL_IMAN) return iman;
  }
  return v;
}

/** Lo que mueve la barra cada gesto de accesibilidad (subir o bajar). */
export const PASO_DE_ACCESIBILIDAD = 5;

/**
 * Como mucho un valor cada tanto mientras se arrastra.
 *
 * Arrastrar la barra da decenas de valores por segundo, y cada uno es una
 * llamada que cruza al nativo y repinta los filtros. Se manda el primero en el
 * acto, luego como mucho uno por intervalo —el último que haya—, y al soltar,
 * el último sin esperar.
 */
export const INTERVALO_DE_ENVIO_MS = 100;

export type Limitador<T> = {
  /** Un valor nuevo. Sale ahora o, como tarde, al acabar el intervalo. */
  empujar: (valor: T) => void;
  /** Se soltó la barra: lo que quede pendiente sale YA. */
  soltar: () => void;
  /** Se descarta lo pendiente sin mandarlo (la hoja se desmonta). */
  cancelar: () => void;
};

export function crearLimitador<T>(opciones: {
  intervaloMs: number;
  ahora: () => number;
  programar: (fn: () => void, ms: number) => () => void;
  enviar: (valor: T) => void;
}): Limitador<T> {
  const { intervaloMs, ahora, programar, enviar } = opciones;
  let ultimoEnvio = Number.NEGATIVE_INFINITY;
  let hayPendiente = false;
  let pendiente: T | undefined;
  let cancelarCita: (() => void) | null = null;

  const mandar = (valor: T) => {
    ultimoEnvio = ahora();
    enviar(valor);
  };

  const vaciar = () => {
    cancelarCita = null;
    if (!hayPendiente) return;
    hayPendiente = false;
    const valor = pendiente as T;
    pendiente = undefined;
    mandar(valor);
  };

  return {
    empujar(valor) {
      const pasado = ahora() - ultimoEnvio;
      if (!cancelarCita && pasado >= intervaloMs) {
        mandar(valor);
        return;
      }
      hayPendiente = true;
      pendiente = valor;
      if (!cancelarCita) cancelarCita = programar(vaciar, Math.max(0, intervaloMs - pasado));
    },
    soltar() {
      cancelarCita?.();
      cancelarCita = null;
      vaciar();
    },
    cancelar() {
      cancelarCita?.();
      cancelarCita = null;
      hayPendiente = false;
      pendiente = undefined;
    },
  };
}

/* ------------------------------------------------------------------------- *
 * DE 0–100 A LO QUE PIDE CADA PLATAFORMA
 * ------------------------------------------------------------------------- */

/** Los cinco parámetros de los filtros de 100ms, con sus nombres. */
export type ParametrosDeFiltro = {
  smoothness: number;
  brightness: number;
  contrast: number;
  sharpness: number;
  redness: number;
};

type Escala = { parametro: keyof ParametrosDeFiltro; neutro: number; maximo: number };

/**
 * ANDROID: el retoque propio en la GPU (`RetocadorGpu.kt`, en el módulo
 * `mejoras-de-video`). Cada ajuste va de 0 (sin efecto) a 1:
 *
 * - **Piel suave** 0 → 0,8: cuánto se mezcla la piel con su versión alisada.
 *   Solo lo que parece piel, y respetando los bordes (ojos, labios, pelo).
 * - **Luz** 0 → 0,6: una curva que aclara sombras y medios sin quemar los
 *   blancos (el gris medio pasa de 0,5 a 0,65).
 * - **Contraste** 0 → 0,4: ×1 → ×1,4 alrededor del gris medio.
 * - **Nitidez** 0 → 1: máscara de enfoque con los 4 vecinos, la misma de
 *   GPUImage con nitidez 1 (lo que daba el filtro de 100ms al máximo).
 * - **Rubor** 0 → 0,2: el rojo ×1 → ×1,2, solo sobre la piel.
 *
 * Los máximos son un punto de partida: se afinan aquí mirándolo en un teléfono.
 */
export const ESCALA_ANDROID: Readonly<Record<IdDeMejora, Escala>> = {
  piel: { parametro: 'smoothness', neutro: 0, maximo: 0.8 },
  luz: { parametro: 'brightness', neutro: 0, maximo: 0.6 },
  contraste: { parametro: 'contrast', neutro: 0, maximo: 0.4 },
  nitidez: { parametro: 'sharpness', neutro: 0, maximo: 1 },
  rubor: { parametro: 'redness', neutro: 0, maximo: 0.2 },
};

/**
 * iOS (`HMSVideoFilterPlugin`, Core Image). Escalas distintas: el contraste
 * neutro es 1, el rubor neutro también, y la nitidez y la piel parten de 0.
 * Los máximos buscan el MISMO resultado que en Android. «Mejorar» no se ofrece
 * en iOS en esta versión: esto queda listo para cuando se haga su puente.
 */
export const ESCALA_IOS: Readonly<Record<IdDeMejora, Escala>> = {
  piel: { parametro: 'smoothness', neutro: 0, maximo: 0.8 },
  luz: { parametro: 'brightness', neutro: 0.5, maximo: 0.8 },
  contraste: { parametro: 'contrast', neutro: 1, maximo: 1.4 },
  nitidez: { parametro: 'sharpness', neutro: 0, maximo: 1 },
  rubor: { parametro: 'redness', neutro: 1, maximo: 1.2 },
};

/** Sin restos de coma flotante: 0,5 + 0,3 tiene que dar 0,8. */
function redondear(valor: number): number {
  return Math.round(valor * 10_000) / 10_000;
}

function convertir(escala: Readonly<Record<IdDeMejora, Escala>>, valores: ValoresDeMejora): ParametrosDeFiltro {
  const parametros = {} as ParametrosDeFiltro;
  for (const id of MEJORAS) {
    const { parametro, neutro, maximo } = escala[id];
    parametros[parametro] = redondear(neutro + ((maximo - neutro) * normalizarValor(valores[id])) / 100);
  }
  return parametros;
}

export function parametrosDeAndroid(valores: ValoresDeMejora): ParametrosDeFiltro {
  return convertir(ESCALA_ANDROID, valores);
}

export function parametrosDeIos(valores: ValoresDeMejora): ParametrosDeFiltro {
  return convertir(ESCALA_IOS, valores);
}

/**
 * Lo que se le manda al filtro de Android, y qué efectos se le han mandado ya.
 *
 * Un efecto en 0 que nunca se tocó no se manda (`null`: el filtro lo deja como
 * está, y nace en 0); uno que ya se mandó, sí, aunque vuelva a 0, para que
 * deje de notarse. `tocados` vuelve a empezar cada vez que se enciende el
 * filtro: al encenderse nace todo en 0.
 */
export function ajusteDeAndroid(
  valores: ValoresDeMejora,
  tocados: ReadonlySet<IdDeMejora>,
): { parametros: { [K in keyof ParametrosDeFiltro]: number | null }; tocados: Set<IdDeMejora> } {
  const todos = parametrosDeAndroid(valores);
  const siguientes = new Set(tocados);
  const parametros = {
    smoothness: null,
    brightness: null,
    contrast: null,
    sharpness: null,
    redness: null,
  } as { [K in keyof ParametrosDeFiltro]: number | null };
  for (const id of MEJORAS) {
    if (valores[id] > 0 || siguientes.has(id)) {
      const nombre = ESCALA_ANDROID[id].parametro;
      parametros[nombre] = todos[nombre];
      siguientes.add(id);
    }
  }
  return { parametros, tocados: siguientes };
}

/* ------------------------------------------------------------------------- *
 * LO QUE SE RECUERDA EN ESTE TELÉFONO
 * ------------------------------------------------------------------------- */

/**
 * Dónde se guarda. Lo lee y lo escribe `useSesionDeDirecto` con AsyncStorage.
 *
 * SE GUARDA POR CUENTA, no solo por teléfono: en un teléfono compartido, quien
 * transmite después no hereda la piel suave de quien transmitió antes. Solo los
 * cinco valores; el fondo NO se recuerda (sigue empezando en «Ninguno», como
 * hasta ahora). Y una cuenta con todo en 0 no deja nada escrito.
 */
export const CLAVE_DE_MEJORAS = 'z.mejoras.v1';

type Guardado = { cuentas: Record<string, ValoresDeMejora> };

function leerGuardado(crudo: string | null | undefined): Guardado {
  if (!crudo) return { cuentas: {} };
  try {
    const dato = JSON.parse(crudo) as unknown;
    const cuentas = (dato as { cuentas?: unknown } | null)?.cuentas;
    if (typeof cuentas !== 'object' || cuentas === null || Array.isArray(cuentas)) {
      return { cuentas: {} };
    }
    const limpio: Record<string, ValoresDeMejora> = {};
    for (const [cuenta, valores] of Object.entries(cuentas as Record<string, unknown>)) {
      const normal = normalizarValores(valores);
      if (hayMejora(normal)) limpio[cuenta] = normal;
    }
    return { cuentas: limpio };
  } catch {
    // Lo guardado no se entiende: se empieza en 0, que es lo seguro.
    return { cuentas: {} };
  }
}

/** Lo que esta cuenta dejó puesto en este teléfono. Nada, todo en 0. */
export function mejorasGuardadas(crudo: string | null | undefined, cuenta: string): ValoresDeMejora {
  return leerGuardado(crudo).cuentas[cuenta] ?? valoresEnCero();
}

/** Lo que hay que escribir para recordar `valores` de esta cuenta. */
export function guardarMejoras(
  crudo: string | null | undefined,
  cuenta: string,
  valores: ValoresDeMejora,
): string {
  const guardado = leerGuardado(crudo);
  const normal = normalizarValores(valores);
  if (hayMejora(normal)) guardado.cuentas[cuenta] = normal;
  else delete guardado.cuentas[cuenta];
  return JSON.stringify(guardado);
}

/* ------------------------------------------------------------------------- *
 * EL GESTOR
 * ------------------------------------------------------------------------- */

/**
 * Si «Mejorar» y un fondo pueden ir a la vez. NO (leído en el SDK de Android
 * 2.9.84, `HMSVideoPluginsManager`): a cada complemento le llega EL MISMO
 * fotograma de la cámara y la salida de todos va al mismo sitio, sin
 * encadenarse. Con los dos puestos saldría un fotograma con el fondo y el
 * siguiente con la casa real. Por eso existe `protegerFondoConMejoras`.
 */
export const MEJORAR_Y_FONDO_A_LA_VEZ = false;

/**
 * Con todo en 0, cuánto se espera antes de QUITAR el filtro. Bajar a 0 de
 * paso, o comparar, no lo quita: volver a ponerlo cuesta. Quedarse en 0 sí,
 * porque el filtro procesa cada fotograma aunque no cambie nada.
 */
export const ESPERA_PARA_QUITAR_EN_CERO_MS = 3_000;

/** Lo mínimo que se le pide al SDK. */
export type ComplementoDeMejoras = {
  /** Engancha el filtro a la pista que sale, sin efecto. */
  encender: () => Promise<unknown>;
  /** Pone estos valores. Solo con el filtro encendido. */
  ajustar: (valores: ValoresDeMejora) => Promise<unknown>;
  /** Lo quita. La pista vuelve a ser la cámara tal cual. */
  apagar: () => Promise<unknown>;
};

export type CapacidadDeMejoras = { admitida: boolean };

export type EstadoDeMejoras = {
  /** Lo que quiere la persona. Es lo que se recuerda. */
  valores: ValoresDeMejora;
  /** Mantiene el ojo: sale sin efecto mientras tanto, para todos. */
  comparando: boolean;
  /** Hay un fondo o un desenfoque: el filtro está quitado. */
  bloqueada: boolean;
  /** Falló o no contestó: se apagó sola para esta sala. */
  averiada: boolean;
  /** Hay una operación en vuelo. */
  aplicando: boolean;
};

export function estadoSinMejoras(): EstadoDeMejoras {
  return {
    valores: valoresEnCero(),
    comparando: false,
    bloqueada: false,
    averiada: false,
    aplicando: false,
  };
}

/** Si la mejora se está aplicando de verdad (para el punto del botón de efectos). */
export function mejoraPuesta(estado: EstadoDeMejoras): boolean {
  return hayMejora(estado.valores) && !estado.bloqueada && !estado.averiada;
}

export type GestorDeMejoras = {
  capacidad: () => CapacidadDeMejoras;
  estado: () => EstadoDeMejoras;
  /** Los valores nuevos. Resuelve cuando la pista ya lleva lo último pedido. */
  cambiar: (valores: ValoresDeMejora) => Promise<EstadoDeMejoras>;
  /** Mantener el ojo: `true` sale sin efecto; `false` lo devuelve. */
  comparar: (si: boolean) => Promise<EstadoDeMejoras>;
  /**
   * Un fondo entra (`true`) o sale (`false`). Con `true`, resuelve `true`
   * SOLO si el filtro está quitado con seguridad: si no, el fondo no se pone.
   */
  bloquear: (si: boolean) => Promise<boolean>;
  /** Hay pista nueva (se entró en la sala publicando): se repone lo que había. */
  laPistaEsNueva: () => Promise<EstadoDeMejoras>;
  /** Quita el filtro antes de irse, sin olvidar los valores. No lanza. */
  apagarParaSalir: () => Promise<void>;
  /** Deja de avisar. Idempotente. */
  destruir: () => void;
};

export type EntornoDeMejoras = {
  /** `null` = este teléfono no admite «Mejorar». */
  complemento: ComplementoDeMejoras | null;
  programar: (fn: () => void, ms: number) => () => void;
  alCambiar: (estado: EstadoDeMejoras) => void;
};

export function crearGestorDeMejoras(entorno: EntornoDeMejoras): GestorDeMejoras {
  const { complemento } = entorno;
  let deseados = valoresEnCero();
  let comparando = false;
  let bloqueada = false;
  let averiada = false;
  /** Hay pista que filtrar: se entró publicando y no se ha salido. */
  let pistaLista = false;
  /** El filtro está enganchado. */
  let activo = false;
  /** `encender` no contestó a tiempo y aún puede aparecer. */
  let dudoso = false;
  /** Un `apagar` falló: puede seguir puesto. */
  let incierto = false;
  /** Lo último que lleva el filtro. `null` = nada desde que se encendió. */
  let enviados: ValoresDeMejora | null = null;
  /** Todo está en 0 desde hace poco: se deja puesto un rato. */
  let retener = false;
  let cancelarRetencion: (() => void) | null = null;
  let pendiente = false;
  let enCurso: Promise<void> | null = null;
  let destruido = false;

  const estado = (): EstadoDeMejoras => ({
    valores: { ...deseados },
    comparando,
    bloqueada,
    averiada,
    aplicando: enCurso !== null,
  });

  const avisar = (): void => {
    if (!destruido) entorno.alCambiar(estado());
  };

  const AGOTADO = new Error('El filtro no respondió a tiempo.');

  /** Una llamada al SDK que no puede quedarse colgada. Igual que los fondos. */
  function conLimite(hacer: () => Promise<unknown>, ms: number, tardia?: (p: Promise<unknown>) => void): Promise<void> {
    return new Promise<void>((resolver, rechazar) => {
      let resuelta = false;
      let promesa: Promise<unknown> | null = null;
      const cancelar = entorno.programar(() => {
        if (resuelta) return;
        resuelta = true;
        if (promesa && tardia) tardia(promesa);
        rechazar(AGOTADO);
      }, ms);
      const cerrar = (fn: () => void) => {
        if (resuelta) return;
        resuelta = true;
        cancelar();
        fn();
      };
      try {
        promesa = Promise.resolve(hacer());
      } catch (fallo) {
        // Un módulo sin enlazar lanza al tocarlo, antes de dar promesa.
        cerrar(() => rechazar(fallo));
        return;
      }
      promesa.then(
        () => cerrar(resolver),
        (fallo: unknown) => cerrar(() => rechazar(fallo)),
      );
    });
  }

  function quiereEnchufado(): boolean {
    return (
      !destruido &&
      !averiada &&
      !bloqueada &&
      pistaLista &&
      (hayMejora(deseados) || (activo && retener))
    );
  }

  function quitarRetencion(): void {
    cancelarRetencion?.();
    cancelarRetencion = null;
    retener = false;
  }

  async function quitar(plugin: ComplementoDeMejoras): Promise<void> {
    try {
      await conLimite(() => plugin.apagar(), ESPERA_DE_MEJORA_MS);
      incierto = false;
      dudoso = false;
    } catch (fallo) {
      incierto = true;
      throw fallo;
    } finally {
      activo = false;
      enviados = null;
    }
  }

  async function enchufar(plugin: ComplementoDeMejoras): Promise<void> {
    await conLimite(() => plugin.encender(), ESPERA_DE_MEJORA_MS, (tardia) => {
      // No contestó a tiempo y puede aparecer después: si aparece, se quita.
      // A estas alturas ya se dio por averiada y nadie lo quiere puesto.
      dudoso = true;
      tardia.then(
        () => {
          if (destruido) return;
          void conLimite(() => plugin.apagar(), ESPERA_DE_MEJORA_MS).then(
            () => {
              dudoso = false;
            },
            () => {
              incierto = true;
            },
          );
        },
        () => {
          dudoso = false;
        },
      );
    });
    activo = true;
    enviados = null;
  }

  /** Falló algo: se apaga sola, con todo en 0, y se queda así en esta sala. */
  async function rendirse(plugin: ComplementoDeMejoras): Promise<void> {
    averiada = true;
    deseados = valoresEnCero();
    comparando = false;
    quitarRetencion();
    try {
      await conLimite(() => plugin.apagar(), ESPERA_DE_MEJORA_MS);
      incierto = false;
    } catch {
      incierto = true;
    }
    activo = false;
    enviados = null;
  }

  async function vaciar(plugin: ComplementoDeMejoras): Promise<void> {
    while (pendiente && !destruido) {
      pendiente = false;
      try {
        if (!quiereEnchufado()) {
          if (activo || dudoso || incierto) await quitar(plugin);
          continue;
        }
        if (!activo) await enchufar(plugin);
        const objetivo = comparando ? valoresEnCero() : { ...deseados };
        if (!enviados || !mismosValores(enviados, objetivo)) {
          await conLimite(() => plugin.ajustar(objetivo), ESPERA_DE_MEJORA_MS);
          enviados = objetivo;
        }
      } catch {
        await rendirse(plugin);
      }
    }
  }

  function arrancar(): Promise<void> {
    pendiente = true;
    if (!complemento || destruido) return Promise.resolve();
    if (!enCurso) {
      enCurso = vaciar(complemento).finally(() => {
        enCurso = null;
        avisar();
      });
      avisar();
    }
    return enCurso;
  }

  return {
    capacidad() {
      return { admitida: complemento !== null };
    },

    estado,

    async cambiar(valores) {
      if (destruido || averiada) return estado();
      const habia = hayMejora(deseados);
      deseados = normalizarValores(valores);
      if (hayMejora(deseados)) {
        quitarRetencion();
      } else if (habia || activo) {
        // Todo en 0: el filtro se queda un rato por si se vuelve a subir.
        quitarRetencion();
        retener = true;
        cancelarRetencion = entorno.programar(() => {
          cancelarRetencion = null;
          retener = false;
          void arrancar();
        }, ESPERA_PARA_QUITAR_EN_CERO_MS);
      }
      if (!hayMejora(deseados)) comparando = false;
      avisar();
      await arrancar();
      return estado();
    },

    async comparar(si) {
      if (destruido) return estado();
      // Sin nada puesto no hay con qué comparar.
      const nuevo = si && hayMejora(deseados) && !averiada && !bloqueada;
      if (nuevo === comparando) return estado();
      comparando = nuevo;
      avisar();
      await arrancar();
      return estado();
    },

    async bloquear(si) {
      if (!destruido && bloqueada !== si) {
        bloqueada = si;
        if (si) comparando = false;
        avisar();
      }
      await arrancar();
      return !activo && !dudoso && !incierto;
    },

    async laPistaEsNueva() {
      // El filtro estaba enganchado a una pista —y a un SDK— que ya no existen.
      activo = false;
      dudoso = false;
      incierto = false;
      enviados = null;
      pistaLista = true;
      await arrancar();
      return estado();
    },

    async apagarParaSalir() {
      pistaLista = false;
      quitarRetencion();
      comparando = false;
      const puedeEstarPuesto = activo || dudoso || incierto || enCurso !== null;
      activo = false;
      enviados = null;
      // Si hay una operación en vuelo, que vuelva a mirar al acabar: ya no
      // hay pista y lo que haya puesto se quita.
      pendiente = true;
      if (!complemento || !puedeEstarPuesto) return;
      try {
        await conLimite(() => complemento.apagar(), ESPERA_DE_MEJORA_AL_SALIR_MS);
        incierto = false;
      } catch {
        // Salir libera la pista igualmente.
      }
    },

    destruir() {
      destruido = true;
      quitarRetencion();
    },
  };
}

/**
 * EL FONDO, CON EL FILTRO QUITADO ANTES. Envuelve los verbos del fondo virtual
 * para que nunca estén los dos complementos a la vez:
 *
 *   - antes de ENCENDER el fondo se quita «Mejorar» y se espera a que esté
 *     quitado; si no se pudo quitar, el fondo no se pone (falla como
 *     cualquier otro fallo del fondo, y la cámara sigue sin fondo);
 *   - al APAGAR el fondo —y solo si se apagó— «Mejorar» vuelve con sus
 *     valores.
 *
 * Cambiar de un fondo a otro no pasa por aquí: el procesado ya está
 * enganchado y «Mejorar» sigue quitado.
 */
export function protegerFondoConMejoras(
  fondo: ComplementoDeEfectos,
  mejoras: Pick<GestorDeMejoras, 'bloquear'>,
): ComplementoDeEfectos {
  if (MEJORAR_Y_FONDO_A_LA_VEZ) return fondo;
  return {
    async activar() {
      const libre = await mejoras.bloquear(true);
      if (!libre) {
        void mejoras.bloquear(false);
        throw new Error('No se pudo quitar «Mejorar» para poner el fondo.');
      }
      try {
        return await fondo.activar();
      } catch (fallo) {
        void mejoras.bloquear(false);
        throw fallo;
      }
    },
    async desactivar() {
      const hecho = await fondo.desactivar();
      // Solo si se apagó de verdad: con el fondo quizá puesto, el filtro no.
      void mejoras.bloquear(false);
      return hecho;
    },
    desenfocar: (radio) => fondo.desenfocar(radio),
    ponerFondo: (fondoId) => fondo.ponerFondo(fondoId),
  };
}
