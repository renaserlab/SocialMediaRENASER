/**
 * LA CALIDAD DEL VIDEO QUE SE RECIBE, y cuando se dice que la conexion va mal.
 *
 * NO HAY UN BOTON «HD». La calidad de un directo no la sube un interruptor: la
 * pone quien emite (hasta donde le deje la plantilla del proveedor) y la baja
 * la red de quien mira. Lo unico que este telefono puede elegir de verdad es
 * CUAL de las versiones que ya se estan emitiendo quiere recibir, y solo si
 * hay mas de una (Simulcast activado en la plantilla). Si no las hay, aqui no
 * se ofrece nada.
 *
 * LAS TRES OPCIONES, y a que corresponde cada una en el proveedor:
 *
 *   - `automatica`: el proveedor elige la capa segun el tamaño de la vista y
 *     la red. Es lo que ocurre si nadie toca nada.
 *   - `ahorro`: se pide la capa MAS BAJA que exista. Gasta menos datos.
 *   - `alta`: se pide la capa MAS ALTA que exista, sin ajuste por tamaño.
 *
 * LO QUE NINGUNA PROMETE: con mala red el proveedor baja o corta la imagen
 * igual, elija lo que elija la persona. Y «alta» es la mas alta QUE SE EMITE,
 * no una resolucion concreta: por eso se enseña la medida real de la capa.
 *
 * Quien EMITE no elige nada aqui: ve su propia camara, que no tiene capas.
 *
 * NO IMPORTA NADA: se ejecuta con `node --test`.
 */

export type CapaDeVideo = 'baja' | 'media' | 'alta';

const ORDEN_DE_CAPAS: readonly CapaDeVideo[] = ['baja', 'media', 'alta'];

/** Una de las versiones que se estan emitiendo, con su tamaño real. */
export type DefinicionDeCapa = { capa: CapaDeVideo; ancho: number; alto: number };

export type PreferenciaDeCalidad = 'automatica' | 'ahorro' | 'alta';

export type OpcionDeCalidad = {
  preferencia: PreferenciaDeCalidad;
  /** La capa que se pide. `null` en `automatica`: la elige el proveedor. */
  capa: CapaDeVideo | null;
  /** El tamaño real de esa capa. 0 si no se sabe o no aplica. */
  ancho: number;
  alto: number;
};

export type EstadoDeCalidad = {
  /** Vacia = no hay nada que elegir, y no se pinta el control. */
  opciones: readonly OpcionDeCalidad[];
  elegida: PreferenciaDeCalidad;
  aplicando: boolean;
  /** El ultimo cambio no se pudo aplicar. Se sigue recibiendo lo de antes. */
  fallo: boolean;
};

export function calidadSinOpciones(): EstadoDeCalidad {
  return { opciones: [], elegida: 'automatica', aplicando: false, fallo: false };
}

/** Si un texto cualquiera es una capa conocida. */
export function esCapaDeVideo(valor: unknown): valor is CapaDeVideo {
  return typeof valor === 'string' && (ORDEN_DE_CAPAS as readonly string[]).includes(valor);
}

/**
 * Las opciones que tienen correspondencia REAL con las capas que hay.
 *
 * Con menos de dos capas distintas no hay nada que elegir y devuelve una lista
 * vacia: ofrecer «ahorrar datos» sobre una sola version de la imagen seria un
 * boton que no hace nada.
 */
export function opcionesDeCalidad(capas: readonly DefinicionDeCapa[]): OpcionDeCalidad[] {
  const conocidas = new Map<CapaDeVideo, DefinicionDeCapa>();
  for (const capa of capas) {
    if (capa && esCapaDeVideo(capa.capa) && !conocidas.has(capa.capa)) conocidas.set(capa.capa, capa);
  }
  if (conocidas.size < 2) return [];

  const ordenadas = ORDEN_DE_CAPAS.filter((capa) => conocidas.has(capa)).map(
    (capa) => conocidas.get(capa) as DefinicionDeCapa,
  );
  const baja = ordenadas[0] as DefinicionDeCapa;
  const alta = ordenadas[ordenadas.length - 1] as DefinicionDeCapa;
  const medida = (n: number) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

  return [
    { preferencia: 'automatica', capa: null, ancho: 0, alto: 0 },
    { preferencia: 'ahorro', capa: baja.capa, ancho: medida(baja.ancho), alto: medida(baja.alto) },
    { preferencia: 'alta', capa: alta.capa, ancho: medida(alta.ancho), alto: medida(alta.alto) },
  ];
}

export type GestorDeCalidad = {
  estado: () => EstadoDeCalidad;
  /** Si la vista debe dejar que el proveedor elija la capa. */
  capaAutomatica: () => boolean;
  /**
   * Cambio la pista que se esta viendo (o dejo de haberla: `null`). Se
   * vuelven a leer sus capas y se repone lo que la persona habia elegido.
   * No lanza.
   */
  cambioLaPista: (pistaId: string | null) => Promise<void>;
  /** Elige una opcion. No lanza: si no se puede, `fallo` queda en `true`. */
  elegir: (preferencia: PreferenciaDeCalidad) => Promise<EstadoDeCalidad>;
  destruir: () => void;
};

export type EntornoDeCalidad = {
  /** Las capas de una pista ajena. Lista vacia si no tiene Simulcast. */
  leerCapas: (pistaId: string) => Promise<readonly DefinicionDeCapa[]>;
  /** Pide una capa concreta de una pista ajena. */
  fijarCapa: (pistaId: string, capa: CapaDeVideo) => Promise<void>;
  alCambiar: (estado: EstadoDeCalidad) => void;
  /**
   * Para volver a preguntar UNA vez por las capas de una pista que al
   * aparecer no trajo ninguna. Sin esto no se vuelve a preguntar.
   *
   * No esta comprobado en un telefono si hace falta: las capas se leen en el
   * momento en que aparece la pista, y si el proveedor aun no las ha anunciado
   * el selector no saldria en toda la emision. Una segunda lectura lo cubre y,
   * si la primera ya era buena, no llega a hacerse.
   */
  programar?: (fn: () => void, ms: number) => () => void;
  esperaParaReleerMs?: number;
};

/**
 * Lleva la preferencia de calidad de quien mira.
 *
 * LA PREFERENCIA SE RECUERDA MIENTRAS DURE LA PANTALLA, no entre sesiones. Hace
 * falta recordarla porque la pista cambia de identidad —quien emite apaga y
 * enciende la camara, o se reconecta— y la capa se pide POR PISTA: sin esto,
 * «ahorrar datos» duraria hasta el primer corte. Guardarla entre aperturas de
 * la aplicacion no aporta nada todavia y obligaria a decidir donde.
 *
 * CAMBIAR DE CALIDAD NO RECONECTA NADA: es un mensaje al servidor de video
 * sobre una pista a la que ya se esta suscrito.
 */
export function crearGestorDeCalidad(entorno: EntornoDeCalidad): GestorDeCalidad {
  let pistaId: string | null = null;
  let opciones: OpcionDeCalidad[] = [];
  let elegida: PreferenciaDeCalidad = 'automatica';
  let aplicando = 0;
  let fallo = false;
  let destruido = false;
  /** Cada lectura de capas lleva numero: una vieja que llega tarde no manda. */
  let generacion = 0;
  let cancelarRelectura: (() => void) | null = null;

  const estado = (): EstadoDeCalidad => ({
    opciones: opciones.map((opcion) => ({ ...opcion })),
    elegida,
    aplicando: aplicando > 0,
    fallo,
  });

  const avisar = (): void => {
    if (!destruido) entorno.alCambiar(estado());
  };

  /** Pide al proveedor la capa de `preferencia` sobre la pista actual. */
  async function pedir(preferencia: PreferenciaDeCalidad, pista: string): Promise<void> {
    // `automatica` no fija nada: vuelve a la capa de partida del proveedor (la
    // mas alta) y deja que el la ajuste.
    const buscada = preferencia === 'automatica' ? 'alta' : preferencia;
    const opcion = opciones.find((otra) => otra.preferencia === buscada);
    if (!opcion?.capa) return;
    await entorno.fijarCapa(pista, opcion.capa);
  }

  /** Lee las capas de la pista y repone lo elegido. No lanza. */
  async function actualizar(nueva: string | null, esRelectura: boolean): Promise<void> {
    if (destruido) return;
    const turno = ++generacion;
    pistaId = nueva;
    if (cancelarRelectura) {
      cancelarRelectura();
      cancelarRelectura = null;
    }
    if (!nueva) {
      if (opciones.length > 0) {
        opciones = [];
        avisar();
      }
      return;
    }

    let capas: readonly DefinicionDeCapa[] = [];
    try {
      capas = await entorno.leerCapas(nueva);
    } catch {
      // Un SDK que no sabe decir las capas es una pista sin capas.
      capas = [];
    }
    if (destruido || turno !== generacion) return;
    opciones = opcionesDeCalidad(capas);
    fallo = false;

    // La pista es otra: lo que se habia elegido hay que volver a pedirlo.
    if (opciones.length > 0 && elegida !== 'automatica') {
      try {
        await pedir(elegida, nueva);
      } catch {
        fallo = true;
      }
      if (destruido || turno !== generacion) return;
    }
    avisar();

    // Sin capas a la primera, se pregunta una vez mas pasado un rato.
    if (opciones.length === 0 && !esRelectura && entorno.programar) {
      cancelarRelectura = entorno.programar(() => {
        cancelarRelectura = null;
        if (!destruido && pistaId === nueva) void actualizar(nueva, true);
      }, entorno.esperaParaReleerMs ?? 4_000);
    }
  }

  return {
    estado,

    capaAutomatica() {
      return elegida === 'automatica';
    },

    cambioLaPista(nueva) {
      return actualizar(nueva, false);
    },

    async elegir(preferencia) {
      if (destruido) return estado();
      const pista = pistaId;
      if (!pista || !opciones.some((opcion) => opcion.preferencia === preferencia)) {
        // Sin pista o sin esa opcion no hay nada que pedir, y no se finge.
        return estado();
      }
      const anterior = elegida;
      elegida = preferencia;
      fallo = false;
      aplicando += 1;
      avisar();
      try {
        await pedir(preferencia, pista);
      } catch {
        // No se pudo: se dice, y se vuelve a marcar lo que de verdad se recibe.
        elegida = anterior;
        fallo = true;
      } finally {
        aplicando -= 1;
      }
      avisar();
      return estado();
    },

    destruir() {
      destruido = true;
      generacion += 1;
      if (cancelarRelectura) {
        cancelarRelectura();
        cancelarRelectura = null;
      }
    },
  };
}

/* ------------------------------------------------------------------------- *
 * CUANDO SE DICE «CONEXION LENTA».
 * ------------------------------------------------------------------------- */

/**
 * La nota de red del proveedor a partir de la cual la conexion va mal.
 *
 * La escala es la de 100ms: 5 excelente, 4 buena, 3 moderada, 2 mala, 1 muy
 * mala. 0 es «desconectado o no se pudo medir» y -1 «todavia no se sabe»: con
 * esas dos no se decide nada (de la desconexion ya avisa la reconexion).
 */
export const NOTA_DE_RED_MALA = 2;

/**
 * Cuantas lecturas seguidas hacen falta para cambiar de opinion.
 *
 * Una sola lectura mala es un bache. Sin esto el aviso de «conexion lenta»
 * apareceria y desapareceria cada pocos segundos, que es peor que no avisar.
 */
export const LECTURAS_PARA_CAMBIAR = 2;

export type VigiaDeConexion = {
  /** Una lectura de la calidad de bajada de ESTE telefono. */
  nota: (calidadDeBajada: unknown) => void;
  /**
   * El proveedor ha rebajado o cortado la imagen que se esta viendo porque la
   * red no da. Es la señal mas clara de todas: no espera a ninguna lectura.
   */
  pistaDegradada: (degradada: boolean) => void;
  /** Vuelve al principio (al salir o al volver a entrar). No avisa. */
  reiniciar: () => void;
  buena: () => boolean;
};

/**
 * Decide si la conexion va bien, y avisa SOLO cuando cambia.
 *
 * Empieza en «buena»: mientras no se sepa nada no se asusta a nadie.
 */
export function crearVigiaDeConexion(alCambiar: (buena: boolean) => void): VigiaDeConexion {
  let redMala = false;
  let degradada = false;
  let racha = 0;
  let anunciada = true;

  function publicar(): void {
    const buena = !redMala && !degradada;
    if (buena === anunciada) return;
    anunciada = buena;
    alCambiar(buena);
  }

  return {
    nota(calidadDeBajada) {
      if (typeof calidadDeBajada !== 'number' || !Number.isFinite(calidadDeBajada)) return;
      if (calidadDeBajada < 1) return;
      const mala = calidadDeBajada <= NOTA_DE_RED_MALA;
      if (mala === redMala) {
        racha = 0;
        return;
      }
      racha += 1;
      if (racha < LECTURAS_PARA_CAMBIAR) return;
      racha = 0;
      redMala = mala;
      publicar();
    },

    pistaDegradada(valor) {
      degradada = valor === true;
      publicar();
    },

    reiniciar() {
      redMala = false;
      degradada = false;
      racha = 0;
      anunciada = true;
    },

    buena() {
      return anunciada;
    },
  };
}
