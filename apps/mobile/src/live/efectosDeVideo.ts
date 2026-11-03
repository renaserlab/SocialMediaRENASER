/**
 * LOS FONDOS DE LA CAMARA DE QUIEN EMITE: ninguno, desenfoque del fondo (suave o
 * fuerte en Android), o un fondo de los que trae la aplicacion.
 *
 * AQUI SOLO HAY FONDOS. Piel suave, luz, contraste, nitidez y rubor
 * («Mejorar», 02/11/2026) son otro complemento del SDK y tienen sus reglas en
 * `mejorasDeVideo.ts`; los dos no pueden ir a la vez. Maquillaje, mascaras o
 * seguimiento de la cara no los ofrece el proveedor y no se fingen.
 *
 * EL EFECTO VA EN LA PISTA QUE SALE. Lo aplica el SDK de video a los fotogramas
 * de la camara ANTES de codificarlos, asi que lo que ve quien emite es lo mismo
 * que reciben los demas. Un dibujo puesto encima de la vista previa no vale: lo
 * veria solo quien emite, que es justo quien menos lo necesita.
 *
 * ESTE FICHERO NO SABE DE QUE SDK SE TRATA. Habla con un `ComplementoDeEfectos`
 * de cuatro verbos, y lo que hay aqui son las reglas que el complemento no
 * tiene:
 *
 *   - una operacion a la vez, y manda LA ULTIMA que se pidio;
 *   - «Ninguno» se puede pedir siempre, tambien a mitad de otra: es la salida
 *     cuando el telefono no puede con el efecto;
 *   - ninguna llamada al SDK puede dejar el control bloqueado: todas tienen
 *     limite de tiempo;
 *   - si algo falla, se vuelve a «Ninguno» y se dice. Un efecto que parece
 *     puesto y no lo esta es peor que no tenerlo.
 *
 * NO IMPORTA NADA: se ejecuta con `node --test`.
 */

export type EfectoDeVideo =
  | { tipo: 'ninguno' }
  /**
   * `fuerza`: solo Android ofrece dos (02/11/2026). Sin ella es el fuerte, el
   * de siempre: lo que ya estaba guardado o repuesto sigue igual.
   */
  | { tipo: 'desenfoque'; fuerza?: FuerzaDeDesenfoque }
  | { tipo: 'fondo'; fondoId: string };

export type FuerzaDeDesenfoque = 'suave' | 'fuerte';

/** Por que esta sala no ofrece efectos. Se le dice a la persona. */
export type MotivoSinEfectos =
  /** No hay proveedor de video (web, pruebas, version sin SDK). */
  | 'sin_proveedor'
  /** Esta persona no emite: no hay camara propia que procesar. */
  | 'no_publica'
  /** La version instalada de la aplicacion no trae el modulo de efectos. */
  | 'sin_modulo'
  /** El sistema del telefono es anterior al minimo que pide el proveedor. */
  | 'sistema_antiguo';

export type CapacidadDeEfectos = {
  admitidos: boolean;
  /** Solo cuando `admitidos` es `false`. */
  motivo?: MotivoSinEfectos;
  /** Los fondos que se pueden pedir. Lista cerrada: los que trae la app. */
  fondos: readonly string[];
  /**
   * Hay desenfoque suave y fuerte. Solo en Android: en iOS el radio lo fija el
   * SDK al construirse y hay uno solo.
   */
  dosDesenfoques?: boolean;
};

/** Lo que salio mal la ultima vez, para decirlo. `null` = nada. */
export type ErrorDeEfecto =
  /** No se pudo poner lo que se pidio. La camara sigue sin efecto. */
  | 'no_se_pudo'
  /** Habia un efecto y hubo que quitarlo (al volver a entrar en la sala). */
  | 'se_apago';

export type EstadoDeEfectos = {
  /** El efecto que lleva la pista AHORA. Nunca el que se esta intentando. */
  efecto: EfectoDeVideo;
  /** Hay una operacion en vuelo. */
  aplicando: boolean;
  error: ErrorDeEfecto | null;
};

/** Lo minimo que se le pide al SDK. */
export type ComplementoDeEfectos = {
  /** Engancha el procesado a la pista que sale. */
  activar: () => Promise<unknown>;
  /** Lo quita. La pista vuelve a ser la camara tal cual. */
  desactivar: () => Promise<unknown>;
  /** De 0 a 100. Solo con el procesado activo. */
  desenfocar: (radio: number) => Promise<unknown>;
  /** Uno de `fondos`. Solo con el procesado activo. */
  ponerFondo: (fondoId: string) => Promise<unknown>;
};

/**
 * Cuanto se desenfoca. De 0 a 100.
 *
 * Es el valor con el que arranca el propio complemento en Android. En iOS el
 * radio lo fija el SDK al construirse y este numero no se usa.
 */
export const RADIO_DE_DESENFOQUE = 75;

/** El desenfoque suave de Android. Se nota el fondo, pero no se lee. */
export const RADIO_DE_DESENFOQUE_SUAVE = 40;

/** El radio que lleva cada desenfoque. Sin fuerza, el fuerte de siempre. */
export function radioDeDesenfoque(fuerza: FuerzaDeDesenfoque | undefined): number {
  return fuerza === 'suave' ? RADIO_DE_DESENFOQUE_SUAVE : RADIO_DE_DESENFOQUE;
}

/**
 * Cuanto se espera a que el SDK conteste antes de darlo por perdido.
 *
 * Cargar el modelo que separa a la persona del fondo tarda la primera vez. Mas
 * que esto no es «tarda»: es que no va a contestar, y el control no se puede
 * quedar girando.
 */
export const ESPERA_DE_EFECTO_MS = 8_000;

/** Para salir no se espera tanto: salir siempre tiene que poder ocurrir. */
export const ESPERA_AL_SALIR_MS = 1_500;

export function sinEfecto(): EfectoDeVideo {
  return { tipo: 'ninguno' };
}

export function estadoSinEfectos(): EstadoDeEfectos {
  return { efecto: sinEfecto(), aplicando: false, error: null };
}

/** Si dos efectos son el mismo. */
export function mismoEfecto(a: EfectoDeVideo, b: EfectoDeVideo): boolean {
  if (a.tipo !== b.tipo) return false;
  if (a.tipo === 'fondo' && b.tipo === 'fondo') return a.fondoId === b.fondoId;
  if (a.tipo === 'desenfoque' && b.tipo === 'desenfoque') {
    return radioDeDesenfoque(a.fuerza) === radioDeDesenfoque(b.fuerza);
  }
  return true;
}

/** Una sala que no admite efectos, y por que. */
export function sinCapacidadDeEfectos(motivo: MotivoSinEfectos): CapacidadDeEfectos {
  return { admitidos: false, motivo, fondos: [] };
}

export type GestorDeEfectos = {
  capacidad: () => CapacidadDeEfectos;
  estado: () => EstadoDeEfectos;
  /**
   * Pide un efecto. Resuelve cuando la pista ya lleva lo ultimo que se pidio
   * (que puede no ser esto, si entre medias se pidio otra cosa). NUNCA rechaza.
   */
  aplicar: (efecto: EfectoDeVideo) => Promise<EstadoDeEfectos>;
  /**
   * La pista local es NUEVA (se volvio a entrar en la sala): el procesado ya
   * no esta enganchado a nada. Se intenta reponer el efecto que habia; si no
   * se puede, se apaga y se dice.
   */
  laPistaEsNueva: () => Promise<EstadoDeEfectos>;
  /**
   * Quita el procesado antes de irse, y RECUERDA que habia. No lanza y no
   * espera de mas.
   */
  apagarParaSalir: () => Promise<void>;
  /**
   * Si al volver a entrar habra que reponer un efecto.
   *
   * Quien entra lo pregunta ANTES de encender la camara: alguien que emitia
   * con el fondo desenfocado no puede reaparecer, tras una caida, enseñando su
   * casa durante los segundos que tarda el efecto en volver.
   */
  hayQueReponer: () => boolean;
  /** Deja de avisar. Idempotente. */
  destruir: () => void;
};

export type EntornoDeEfectos = {
  /** `null` = esta sala no admite efectos. */
  complemento: ComplementoDeEfectos | null;
  /** Por que no los admite. Solo se lee si `complemento` es `null`. */
  motivo?: MotivoSinEfectos;
  /** Los ids de los fondos que trae la aplicacion. */
  fondos: readonly string[];
  /** Si este aparato ofrece desenfoque suave y fuerte (Android). */
  dosDesenfoques?: boolean;
  /** Programa algo. Devuelve como cancelarlo. */
  programar: (fn: () => void, ms: number) => () => void;
  alCambiar: (estado: EstadoDeEfectos) => void;
};

export function crearGestorDeEfectos(entorno: EntornoDeEfectos): GestorDeEfectos {
  const { complemento } = entorno;
  let efecto: EfectoDeVideo = sinEfecto();
  let error: ErrorDeEfecto | null = null;
  /** Si el procesado esta enganchado a la pista. */
  let activo = false;
  /**
   * `activar` no contesto a tiempo y SIGUE SIN CONTESTAR: el procesado puede
   * estar poniendose ahora mismo. Mientras dure, «ninguno» y salir llaman a
   * `desactivar` aunque para la aplicacion ya no haya efecto, y cuando la
   * respuesta por fin llega, lo que haya aparecido se quita.
   *
   * Sin esto (revision del 04/10/2026): en un Android lento el modelo tardaba
   * mas que el limite, la hoja decia «no se pudo», el desenfoque aparecia un
   * segundo despues y ya no habia forma de quitarlo.
   */
  let dudoso = false;
  /** Lo ultimo que se ha pedido y aun no se ha puesto. */
  let deseado: EfectoDeVideo | null = null;
  /** Lo que habia al salir de la sala, para reponerlo al volver. */
  let recordado: EfectoDeVideo | null = null;
  /** La operacion en vuelo. Mientras exista, las peticiones se encolan. */
  let enCurso: Promise<void> | null = null;
  let destruido = false;

  const estado = (): EstadoDeEfectos => ({
    efecto: { ...efecto },
    aplicando: enCurso !== null,
    error,
  });

  const avisar = (): void => {
    if (!destruido) entorno.alCambiar(estado());
  };

  /** Con lo que rechaza `conLimite` cuando el SDK no contesta a tiempo. */
  const AGOTADO = new Error('El efecto no respondió a tiempo.');

  /** Una llamada al SDK que no puede quedarse colgada. */
  function conLimite(hacer: () => Promise<unknown>, ms: number): Promise<void> {
    return new Promise<void>((resolver, rechazar) => {
      let resuelta = false;
      const cancelar = entorno.programar(() => {
        if (resuelta) return;
        resuelta = true;
        rechazar(AGOTADO);
      }, ms);
      const cerrar = (fn: () => void) => {
        if (resuelta) return;
        resuelta = true;
        cancelar();
        fn();
      };
      let promesa: Promise<unknown>;
      try {
        promesa = Promise.resolve(hacer());
      } catch (fallo) {
        // Un complemento sin enlazar lanza al tocarlo, antes de dar promesa.
        cerrar(() => rechazar(fallo));
        return;
      }
      promesa.then(
        () => cerrar(resolver),
        (fallo: unknown) => cerrar(() => rechazar(fallo)),
      );
    });
  }

  function valido(pedido: EfectoDeVideo): boolean {
    if (pedido.tipo === 'desenfoque' && pedido.fuerza === 'suave') return entorno.dosDesenfoques === true;
    return pedido.tipo !== 'fondo' || entorno.fondos.includes(pedido.fondoId);
  }

  /**
   * Engancha el procesado. Si no contesta a tiempo, lanza —como cualquier otro
   * fallo— pero se queda vigilando la respuesta: ver `dudoso`.
   */
  async function activar(plugin: ComplementoDeEfectos): Promise<void> {
    let respuesta: Promise<unknown> | null = null;
    try {
      await conLimite(() => {
        respuesta = Promise.resolve(plugin.activar());
        return respuesta;
      }, ESPERA_DE_EFECTO_MS);
      activo = true;
    } catch (fallo) {
      const tardia = respuesta as Promise<unknown> | null;
      if (fallo === AGOTADO && tardia) {
        dudoso = true;
        tardia.then(
          () => {
            dudoso = false;
            // Si mientras tanto alguien lo ha vuelto a pedir, ya decide esa
            // operacion. Si no, nadie lo quiere puesto: fuera.
            if (destruido || activo || enCurso) return;
            void conLimite(() => plugin.desactivar(), ESPERA_DE_EFECTO_MS).catch(() => {});
          },
          () => {
            // Acabo fallando: no esta puesto.
            dudoso = false;
          },
        );
      }
      throw fallo;
    }
  }

  /** Lleva la pista de como esta a `pedido`. Lanza si el SDK falla. */
  async function poner(pedido: EfectoDeVideo, plugin: ComplementoDeEfectos): Promise<void> {
    if (pedido.tipo === 'ninguno') {
      if (activo) {
        await conLimite(() => plugin.desactivar(), ESPERA_DE_EFECTO_MS);
        activo = false;
      } else if (dudoso) {
        // Puede estar poniendose: se pide quitarlo. Si el SDK dice que no hay
        // nada que quitar, no es un error de quien pulso «Ninguno».
        await conLimite(() => plugin.desactivar(), ESPERA_DE_EFECTO_MS).catch(() => {});
      }
      return;
    }
    if (!activo) await activar(plugin);
    if (pedido.tipo === 'desenfoque') {
      const radio = radioDeDesenfoque(pedido.fuerza);
      await conLimite(() => plugin.desenfocar(radio), ESPERA_DE_EFECTO_MS);
    } else {
      await conLimite(() => plugin.ponerFondo(pedido.fondoId), ESPERA_DE_EFECTO_MS);
    }
  }

  /** Deja la camara sin efecto, pase lo que pase. No lanza. */
  async function volverANinguno(plugin: ComplementoDeEfectos): Promise<void> {
    if (activo || dudoso) {
      try {
        await conLimite(() => plugin.desactivar(), ESPERA_DE_EFECTO_MS);
      } catch {
        // Si ni quitarlo se puede, lo unico honesto es no decir que esta puesto.
      }
    }
    activo = false;
    efecto = sinEfecto();
  }

  async function vaciarCola(plugin: ComplementoDeEfectos, alFallar: ErrorDeEfecto): Promise<void> {
    while (deseado && !destruido) {
      const pedido = deseado;
      deseado = null;
      if (mismoEfecto(pedido, efecto) && (pedido.tipo === 'ninguno') === !activo && !dudoso) {
        continue;
      }
      try {
        await poner(pedido, plugin);
        efecto = pedido;
        error = null;
      } catch {
        await volverANinguno(plugin);
        error = alFallar;
      }
    }
  }

  function arrancar(plugin: ComplementoDeEfectos, alFallar: ErrorDeEfecto): Promise<void> {
    if (!enCurso) {
      enCurso = vaciarCola(plugin, alFallar).finally(() => {
        enCurso = null;
        avisar();
      });
      avisar();
    }
    return enCurso;
  }

  return {
    capacidad() {
      if (!complemento) return sinCapacidadDeEfectos(entorno.motivo ?? 'sin_proveedor');
      return entorno.dosDesenfoques
        ? { admitidos: true, fondos: [...entorno.fondos], dosDesenfoques: true }
        : { admitidos: true, fondos: [...entorno.fondos] };
    },

    estado,

    async aplicar(pedido) {
      if (destruido) return estado();
      if (!complemento || !valido(pedido)) {
        // Sin complemento, o un fondo que la aplicacion no trae: no se toca
        // la pista. Pedir «ninguno» sin complemento no es un error.
        if (pedido.tipo !== 'ninguno') {
          error = 'no_se_pudo';
          avisar();
        }
        return estado();
      }
      deseado = pedido;
      await arrancar(complemento, 'no_se_pudo');
      return estado();
    },

    async laPistaEsNueva() {
      // El procesado estaba enganchado a una pista que ya no existe.
      activo = false;
      const habia = recordado ?? efecto;
      recordado = null;
      if (destruido || !complemento) return estado();
      // Si mientras tanto se pidio otra cosa, manda esa.
      const pedido = deseado ?? habia;
      efecto = sinEfecto();
      if (pedido.tipo === 'ninguno') return estado();
      deseado = pedido;
      await arrancar(complemento, 'se_apago');
      return estado();
    },

    async apagarParaSalir() {
      // Lo ultimo que la persona quiso es lo que se repone al volver.
      recordado = deseado ?? efecto;
      deseado = null;
      // Con una operacion en vuelo el procesado puede estar enganchandose
      // ahora mismo: se quita igual. Quitar lo que no esta puesto no rompe nada.
      const puedeEstarPuesto = activo || dudoso || enCurso !== null;
      activo = false;
      efecto = sinEfecto();
      error = null;
      if (!complemento || !puedeEstarPuesto) return;
      try {
        await conLimite(() => complemento.desactivar(), ESPERA_AL_SALIR_MS);
      } catch {
        // Salir libera la pista igualmente.
      }
    },

    hayQueReponer() {
      // `recordado ?? efecto`, y no solo `recordado`: quien pregunta va a
      // estrenar pista, haya salido antes de la sala o no. Si dependiera de
      // haber salido, un reintento sin salida previa dejaria la camara
      // encendida y sin el efecto.
      return !destruido && complemento !== null && (recordado ?? efecto).tipo !== 'ninguno';
    },

    destruir() {
      destruido = true;
      deseado = null;
      recordado = null;
    },
  };
}
