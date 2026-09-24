/**
 * QUE SE VE EN UNA PANTALLA DE DIRECTO: la decision y la maquina que la aplica.
 *
 * POR QUE ESTE FICHERO NO IMPORTA NADA. Es el mismo motivo que
 * `navigation/atras.ts`, y aqui pesa mas todavia: los catorce estados de un
 * directo son casi todos estados de EXCEPCION —permiso denegado, proveedor
 * caido, red que se va, sesion que termina mientras miras—, y ninguno se puede
 * provocar a mano en un telefono. Escritos dentro de un componente no se
 * comprueban nunca; escritos aqui se ejecutan tal cual con `node --test`.
 *
 * Va todo junto —decision, naturaleza de cada estado y motor— porque el
 * proyecto no permite importar entre ficheros `.ts` con extension
 * (`allowImportingTsExtensions` esta apagado) y sin ella Node no resuelve la
 * ruta. Partirlo obligaria a cambiar la configuracion de TypeScript para no
 * ganar nada. Lo que SI esta fuera es lo que se puede inyectar: la sala de
 * video (`salaDeVideo.ts`) y la politica de reintentos (`reintentos.ts`)
 * entran por el entorno, y por eso este fichero no sabe nada del SDK ni de
 * cuantas veces se reintenta.
 */

/* ========================================================================= *
 * 1. CLASIFICAR EL FALLO DE LA CREDENCIAL
 *
 * El backend contesta con codigos propios en el cuerpo. La pantalla NO puede
 * leer esos codigos: en cuanto lo hace, cambiar un nombre en el servidor rompe
 * en silencio un `if` de la interfaz, y ademas obliga a que cada sitio que
 * pinte un directo repita la misma tabla. Se traduce una vez, aqui, a un tipo
 * del dominio.
 * ========================================================================= */

export const CLASES_DE_FALLO = [
  /** No hay proveedor de video: bandera apagada, o configurado y desaparecido. */
  'sin_proveedor',
  /** La sesion ya no admite a nadie: termino o se cancelo. */
  'no_unible',
  /** Bloqueado, o la emision no es visible para esta persona. */
  'sin_permiso',
  /** Demasiadas peticiones de credencial. */
  'limitado',
  /** No se llego al servidor. */
  'red',
  /** Contesto algo que no sabemos interpretar. */
  'desconocido',
] as const;

export type ClaseDeFallo = (typeof CLASES_DE_FALLO)[number];

export type FalloDeCredencial = {
  clase: ClaseDeFallo;
  /** Lo que sugiere el servidor esperar, si lo sugiere. Solo tras un 429. */
  esperaSugeridaMs?: number;
};

/** Lo minimo que hace falta de un error para clasificarlo. */
export type ErrorDelServidor = {
  /** Codigo HTTP. `0`, `undefined` o `null` = no se llego a hablar con nadie. */
  status?: number | null;
  /** El `code` del cuerpo uniforme del backend. */
  code?: string | null;
  esperaSugeridaMs?: number | null;
};

/**
 * Los codigos del backend que ya dicen por si solos de que va el fallo.
 *
 * Se miran ANTES que el estado HTTP porque son mas precisos: los dos motivos de
 * «no hay proveedor» llegan como 503, igual que llegaria una caida del propio
 * servidor, y confundirlos haria que un despliegue en curso se anunciara como
 * «no hay proveedor de video» —que suena definitivo— en vez de reintentarse.
 */
const CLASE_POR_CODIGO: Record<string, ClaseDeFallo> = {
  live_provider_not_configured: 'sin_proveedor',
  live_provider_missing: 'sin_proveedor',
  live_not_available: 'sin_proveedor',
  live_not_joinable: 'no_unible',
  live_credential_rate_limited: 'limitado',
};

/**
 * Traduce un fallo del servidor a una clase del dominio.
 *
 * El orden es la regla:
 *
 *  1. CODIGO conocido. Es lo que el backend quiso decir exactamente.
 *  2. Ausencia de estado (`0`, `undefined`): no hubo respuesta. Es red, y la
 *     red se reintenta. Va antes que cualquier rango porque un `status` que no
 *     existe no se puede comparar con nada.
 *  3. ESTADO HTTP, del mas especifico al mas general.
 *
 * Un 500 cae en `red` y no en `desconocido` a proposito: es un fallo del
 * servidor, no del contrato, y esos se pasan solos. `desconocido` queda para lo
 * que de verdad no encaja —un 400, un 422—, que se reintenta una vez por si
 * acaso pero no da pie a insistir.
 */
export function clasificarFalloDeCredencial(error: ErrorDelServidor): FalloDeCredencial {
  const sugerida =
    typeof error.esperaSugeridaMs === 'number' && Number.isFinite(error.esperaSugeridaMs)
      ? { esperaSugeridaMs: error.esperaSugeridaMs }
      : {};

  const porCodigo = error.code ? CLASE_POR_CODIGO[error.code] : undefined;
  if (porCodigo) return { clase: porCodigo, ...sugerida };

  const status = error.status;
  if (typeof status !== 'number' || !Number.isFinite(status) || status === 0) {
    return { clase: 'red', ...sugerida };
  }

  if (status === 401 || status === 403) return { clase: 'sin_permiso', ...sugerida };
  // Un 404 es una emision que ya no esta. Insistir no la devuelve.
  if (status === 404 || status === 409 || status === 410) {
    return { clase: 'no_unible', ...sugerida };
  }
  if (status === 429) return { clase: 'limitado', ...sugerida };
  if (status === 503) return { clase: 'sin_proveedor', ...sugerida };
  if (status >= 500) return { clase: 'red', ...sugerida };
  return { clase: 'desconocido', ...sugerida };
}

/* ========================================================================= *
 * 2. LOS ESTADOS Y LA DECISION
 * ========================================================================= */

/** Los catorce estados del encargo. Ni uno mas: cada uno se pinta distinto. */
export const ESTADOS_DE_DIRECTO = [
  'conectando',
  'conectado',
  'reconectando',
  'programado',
  'en_directo',
  'terminado',
  'cancelado',
  'acceso_denegado',
  'proveedor_no_configurado',
  'permiso_camara_denegado',
  'permiso_microfono_denegado',
  'conexion_lenta',
  'error_recuperable',
  'error_definitivo',
] as const;

export type EstadoDeDirecto = (typeof ESTADOS_DE_DIRECTO)[number];

/** El estado de la SESION segun el servidor. Es el `status` de la ficha. */
export type EstadoDeSesion = 'scheduled' | 'live' | 'ended' | 'cancelled';

/** Como va la peticion de credencial. */
export type ResultadoDeCredencial =
  | { estado: 'pendiente' }
  | { estado: 'lista'; puedePublicar: boolean; hayVideo: boolean }
  | { estado: 'fallo'; fallo: FalloDeCredencial };

/**
 * Un permiso del dispositivo, desde el punto de vista del directo.
 *
 * `noHaceFalta` NO es «denegado» ni «concedido»: es que a esta persona NO se le
 * va a preguntar. Es el estado de quien solo mira, y tenerlo como valor propio
 * es lo que hace imposible que un espectador acabe en
 * `permiso_camara_denegado`.
 */
export type PermisoDeMedios = 'noHaceFalta' | 'pendiente' | 'concedido' | 'denegado';

/** Como esta la conexion con la sala, segun el SDK. */
export type ConexionDeSala =
  | 'sinIniciar'
  | 'conectando'
  | 'conectado'
  | 'reconectando'
  /** Conectado pero con la calidad por los suelos. */
  | 'lenta'
  /** Se cayo. */
  | 'perdida';

export type EntradaDeDirecto = {
  /** `null` mientras no se sabe: la ficha todavia esta viajando. */
  sesion: EstadoDeSesion | null;
  credencial: ResultadoDeCredencial;
  permisoCamara: PermisoDeMedios;
  permisoMicrofono: PermisoDeMedios;
  conexion: ConexionDeSala;
  /**
   * Hay imagen o sonido circulando: alguien esta publicando.
   *
   * Es lo que separa `conectado` de `en_directo`. Estar dentro de la sala no es
   * estar viendo algo: quien emite entra, se ve en la vista previa y todavia no
   * ha pulsado «empezar», y quien mira puede entrar antes que el.
   */
  hayMedios: boolean;
  /** Queda algun reintento por delante. Lo decide la politica, no la maquina. */
  quedanReintentos: boolean;
};

/**
 * El estado que hay que pintar. Ocho preguntas en un orden que ES la regla.
 *
 *  1. CANCELADA y 2. TERMINADA mandan sobre todo lo demas. Son las dos unicas
 *     situaciones en que la respuesta correcta no depende de nada mas: da igual
 *     que la credencial fallara, que falte un permiso o que la red vaya mal, no
 *     hay directo que ver. Si esto estuviera despues de la credencial, una
 *     emision terminada con la red caida diria «error de conexion, reintentando»
 *     y se pasaria un minuto reintentando entrar en una sala cerrada.
 *
 *  3. SIN FICHA todavia: se esta abriendo. No es un error.
 *
 *  4. PROGRAMADA. Aun no ha empezado, asi que no hay sala a la que unirse y
 *     —esto es lo importante— no se le pide la camara a nadie por algo que
 *     empieza dentro de tres horas.
 *
 *  5. EL FALLO DE CREDENCIAL. Antes que los permisos a proposito: preguntar por
 *     la camara y despues decir «resulta que no hay proveedor de video» es
 *     gastarle a alguien un permiso —que en iOS se concede una sola vez— para
 *     nada. Preguntando primero al servidor, quien solo mira no llega nunca a
 *     ver un dialogo de permisos.
 *
 *  6. SIN VIDEO EN LA CREDENCIAL. Un 200 con `provider: "none"` es la respuesta
 *     normal con la bandera apagada, y significa lo mismo que el 503.
 *
 *  7. LOS PERMISOS, y SOLO si el servidor concedio publicar. `puedePublicar` lo
 *     decide el backend; la pantalla no puede ascender a nadie a emisor.
 *
 *  8. LA CONEXION.
 */
export function decidirEstadoDeDirecto(entrada: EntradaDeDirecto): EstadoDeDirecto {
  const {
    sesion,
    credencial,
    permisoCamara,
    permisoMicrofono,
    conexion,
    hayMedios,
    quedanReintentos,
  } = entrada;

  if (sesion === 'cancelled') return 'cancelado';
  if (sesion === 'ended') return 'terminado';
  if (sesion === null) return 'conectando';
  if (sesion === 'scheduled') return 'programado';

  if (credencial.estado === 'fallo') {
    switch (credencial.fallo.clase) {
      case 'sin_proveedor':
        return 'proveedor_no_configurado';
      case 'sin_permiso':
        return 'acceso_denegado';
      case 'no_unible':
        /*
          El servidor dice que la sala no admite a nadie aunque la ficha que
          tenemos siga diciendo `live`. Manda el servidor: la ficha es una foto
          de hace unos segundos y el 409 es de ahora.
        */
        return 'terminado';
      case 'limitado':
      case 'red':
      case 'desconocido':
        return quedanReintentos ? 'error_recuperable' : 'error_definitivo';
    }
  }

  if (credencial.estado === 'pendiente') return 'conectando';

  if (!credencial.hayVideo) return 'proveedor_no_configurado';

  if (credencial.puedePublicar) {
    /*
      La camara antes que el microfono porque es la que tiene vista previa: sin
      imagen no hay nada que encuadrar y el aviso llega antes de que la persona
      se coloque. Los dos avisos son distintos porque las salidas son distintas
      —una lleva a los ajustes de camara y la otra a los de microfono— y un
      unico «faltan permisos» deja a quien lo lee sin saber cual tocar.
    */
    if (permisoCamara === 'denegado') return 'permiso_camara_denegado';
    if (permisoMicrofono === 'denegado') return 'permiso_microfono_denegado';
    if (permisoCamara === 'pendiente' || permisoMicrofono === 'pendiente') return 'conectando';
  }

  switch (conexion) {
    case 'sinIniciar':
    case 'conectando':
      return 'conectando';
    case 'reconectando':
      return 'reconectando';
    case 'perdida':
      return quedanReintentos ? 'error_recuperable' : 'error_definitivo';
    case 'lenta':
      // Va antes que `en_directo`: se esta viendo algo, pero a trompicones, y
      // decirlo evita que la persona crea que el telefono se ha roto.
      return 'conexion_lenta';
    case 'conectado':
      return hayMedios ? 'en_directo' : 'conectado';
  }
}

/* ========================================================================= *
 * 3. QUE SE PUEDE HACER CON CADA ESTADO
 * ========================================================================= */

export type NaturalezaDeEstado =
  /** Va a cambiar solo. No hay nada que ofrecer. */
  | 'transitorio'
  /** Es un sitio donde se puede estar. */
  | 'estable'
  /** Se reintenta solo. */
  | 'recuperable'
  /** Solo lo arregla la persona, y no reintentando. */
  | 'requiereAccion'
  /** No se reintenta NUNCA. */
  | 'definitivo';

export const NATURALEZA_DEL_ESTADO: Record<EstadoDeDirecto, NaturalezaDeEstado> = {
  conectando: 'transitorio',
  reconectando: 'transitorio',
  conectado: 'estable',
  en_directo: 'estable',
  conexion_lenta: 'estable',
  programado: 'estable',
  error_recuperable: 'recuperable',
  permiso_camara_denegado: 'requiereAccion',
  permiso_microfono_denegado: 'requiereAccion',
  terminado: 'definitivo',
  cancelado: 'definitivo',
  acceso_denegado: 'definitivo',
  proveedor_no_configurado: 'definitivo',
  error_definitivo: 'definitivo',
};

/**
 * De aqui no se sale reintentando.
 *
 * Es la pregunta que corta el bucle: quien la haga NO vuelve a llamar al
 * servidor. Los permisos denegados NO son definitivos —cambiarlos en los
 * ajustes arregla la pantalla sin salir de ella— pero tampoco se reintentan
 * solos, y por eso tienen su propia naturaleza.
 */
export function esDefinitivo(estado: EstadoDeDirecto): boolean {
  return NATURALEZA_DEL_ESTADO[estado] === 'definitivo';
}

/** Se vuelve a intentar SOLO, sin que nadie pulse nada. */
export function admiteReintentoAutomatico(estado: EstadoDeDirecto): boolean {
  return NATURALEZA_DEL_ESTADO[estado] === 'recuperable';
}

/** Hace falta que la persona haga algo (los ajustes del telefono). */
export function pideAccionDeLaPersona(estado: EstadoDeDirecto): boolean {
  return NATURALEZA_DEL_ESTADO[estado] === 'requiereAccion';
}

/** Se esta viendo o emitiendo algo ahora mismo. */
export function hayEmisionEnMarcha(estado: EstadoDeDirecto): boolean {
  return estado === 'en_directo' || estado === 'conexion_lenta';
}

/* ========================================================================= *
 * 4. QUE TEXTO E ICONO LLEVA CADA ESTADO
 *
 * Se devuelven CLAVES de `i18n`, no frases: este fichero no puede importar el
 * diccionario (lo dejaria fuera de `node --test`) y tampoco debe llevar textos
 * propios, que se desviarian del diccionario en cuanto alguien corrigiera uno.
 * `maquinaDeDirecto.test.mts` comprueba que las catorce claves existen de
 * verdad en `i18n/es.ts`.
 * ========================================================================= */

export type CartelDeEstado = {
  /** Nombre de un icono de Feather. */
  icono: string;
  titulo: string;
  cuerpo: string;
};

/**
 * El cartel de cada estado.
 *
 * `esAnfitrion` cambia dos de ellos y no es un capricho: «conectado, esperando
 * a que empiece» y «listo, pulsa para empezar a emitir» son la misma situacion
 * tecnica contada a las dos personas que la viven, y darle a quien emite el
 * texto del espectador lo deja esperando a si mismo.
 */
export function cartelDelEstado(estado: EstadoDeDirecto, esAnfitrion: boolean): CartelDeEstado {
  switch (estado) {
    case 'conectando':
      return { icono: 'loader', titulo: 'live.connectingTitle', cuerpo: 'live.connectingBody' };
    case 'reconectando':
      return { icono: 'refresh-cw', titulo: 'live.reconnectingTitle', cuerpo: 'live.reconnectingBody' };
    case 'conectado':
      return esAnfitrion
        ? { icono: 'video', titulo: 'live.previewTitle', cuerpo: 'live.previewBody' }
        : { icono: 'users', titulo: 'live.waitingHostTitle', cuerpo: 'live.waitingHostBody' };
    case 'en_directo':
      return { icono: 'video', titulo: 'live.badgeLive', cuerpo: 'live.onAirBody' };
    case 'conexion_lenta':
      return { icono: 'wifi', titulo: 'live.slowTitle', cuerpo: 'live.slowBody' };
    case 'programado':
      return { icono: 'clock', titulo: 'live.notStartedTitle', cuerpo: 'live.notStartedBody' };
    case 'terminado':
      return { icono: 'check-circle', titulo: 'live.endedTitle', cuerpo: 'live.endedBody' };
    case 'cancelado':
      return { icono: 'slash', titulo: 'live.cancelledTitle', cuerpo: 'live.cancelledBody' };
    case 'acceso_denegado':
      return { icono: 'lock', titulo: 'live.deniedTitle', cuerpo: 'live.deniedBody' };
    case 'proveedor_no_configurado':
      return { icono: 'video-off', titulo: 'live.noVideoTitle', cuerpo: 'live.noVideoBody' };
    case 'permiso_camara_denegado':
      return { icono: 'camera-off', titulo: 'live.cameraDeniedTitle', cuerpo: 'live.cameraDeniedBody' };
    case 'permiso_microfono_denegado':
      return { icono: 'mic-off', titulo: 'live.micDeniedTitle', cuerpo: 'live.micDeniedBody' };
    case 'error_recuperable':
      return { icono: 'alert-circle', titulo: 'live.recoverableTitle', cuerpo: 'live.recoverableBody' };
    case 'error_definitivo':
      return { icono: 'alert-triangle', titulo: 'live.finalErrorTitle', cuerpo: 'live.finalErrorBody' };
  }
}

/* ========================================================================= *
 * 5. LA MAQUINA
 *
 * Lo que hay que poder comprobar no es la decision suelta sino lo que la rodea,
 * que es donde estan los fallos de verdad de un directo: que a quien solo mira
 * NO se le pide la camara, que dos toques seguidos en «terminar» no terminan dos
 * veces ni abren dos dialogos, que salir siendo anfitrion pregunta antes, que al
 * desmontar no queda ni un temporizador ni un oyente ni la camara encendida, y
 * que un fallo definitivo NO se reintenta.
 *
 * Por eso el entorno se INYECTA entero: red, permisos, sala, reloj, dialogos y
 * politica de reintentos son parametros. Las pruebas mandan sobre las esperas
 * en vez de esperarlas, y pueden AFIRMAR que algo no se llamo.
 * ========================================================================= */

/** La credencial ya leida, con lo unico que la maquina necesita saber. */
export type CredencialLeida = {
  puedePublicar: boolean;
  hayVideo: boolean;
  /**
   * La credencial entera, sin abrir.
   *
   * La maquina no la mira: solo se la pasa a `unirseALaSala`. Asi no depende de
   * la forma que fije el proveedor, que es exactamente lo que este modulo no
   * debe saber.
   */
  opaca: unknown;
};

/** Lo que se pinta. Todo lo que la pantalla necesita, y nada mas. */
export type VistaDeDirecto = {
  estado: EstadoDeDirecto;
  /** Los controles de quien emite. Todo apagado mientras no se publique. */
  camara: boolean;
  microfono: boolean;
  camaraFrontal: boolean;
  /** Si el servidor autorizo a emitir. Es lo que decide si hay controles. */
  puedePublicar: boolean;
  /** Hay una accion en vuelo: los botones que la lanzan van deshabilitados. */
  ocupado: boolean;
  /** Reintentos automaticos ya gastados. Para poder decirlo si hace falta. */
  intentos: number;
};

/**
 * La vista de antes de arrancar.
 *
 * Existe para que la pantalla tenga algo coherente que pintar en su PRIMER
 * render, antes de que la maquina publique nada. Sin esto haria falta un
 * `null` que cada sitio tendria que comprobar, o —peor— un objeto escrito a
 * mano en la pantalla que se desviaria del de aqui en cuanto cambie el tipo.
 */
export function vistaInicialDeDirecto(sesion: EstadoDeSesion | null): VistaDeDirecto {
  return {
    estado: decidirEstadoDeDirecto({
      sesion,
      credencial: { estado: 'pendiente' },
      permisoCamara: 'noHaceFalta',
      permisoMicrofono: 'noHaceFalta',
      conexion: 'sinIniciar',
      hayMedios: false,
      quedanReintentos: false,
    }),
    camara: false,
    microfono: false,
    camaraFrontal: true,
    puedePublicar: false,
    ocupado: false,
    intentos: 0,
  };
}

export type EntornoDeDirecto = {
  /**
   * Si esta persona gestiona la emision (`can_manage` del servidor).
   *
   * NO es lo mismo que `puedePublicar`, que lo decide la credencial. Quien
   * gestiona puede terminar la emision y moderar el chat; publicar es otra
   * autorizacion y la da el proveedor de video.
   */
  /**
   * Si quien mira es quien emite. FUNCION y no valor: se consulta en el momento
   * de usarlo, para que cambiarlo no obligue a reconstruir la maquina.
   */
  esAnfitrion: () => boolean;
  /**
   * La bandera de directo de la aplicacion (`FEATURE_LIVE`).
   *
   * Apagada, NO se llama al servidor: la respuesta ya se sabe y una peticion
   * que solo sirve para confirmar lo que ya sabemos es una peticion de mas —y
   * cuenta para el limite de ritmo del endpoint de credencial—.
   */
  banderaEncendida: boolean;
  estadoInicialDeSesion: EstadoDeSesion | null;

  pedirCredencial: () => Promise<CredencialLeida>;
  /** Traduce lo que sea que haya lanzado la red a una clase del dominio. */
  clasificarFallo: (error: unknown) => FalloDeCredencial;
  /** `true` si se concedio. Solo se llama a quien va a publicar. */
  pedirPermiso: (tipo: 'camara' | 'microfono') => Promise<boolean>;

  unirseALaSala: (credencial: unknown, publicar: boolean) => Promise<void>;
  salirDeLaSala: () => Promise<void>;
  alternarCamaraEnLaSala: (encendida: boolean) => Promise<void>;
  alternarMicrofonoEnLaSala: (encendido: boolean) => Promise<void>;
  cambiarCamaraEnLaSala: () => Promise<void>;
  /** Libera el SDK. Se llama una sola vez, al desmontar. */
  destruirLaSala: () => void;

  empezarEnElServidor: () => Promise<void>;
  terminarEnElServidor: () => Promise<void>;
  /** «¿Terminar la emision?». `true` = adelante. */
  confirmarFinal: () => Promise<boolean>;
  /** «Sigues emitiendo, ¿seguro que sales?». `true` = adelante. */
  confirmarSalida: () => Promise<boolean>;

  /**
   * Cuanto esperar antes del siguiente intento, o `null` para parar.
   *
   * Lo contesta `reintentos.esperaAntesDeReintentar`. Entra por aqui —y no por
   * un import— porque este fichero no puede importar otro modulo `.ts`, y de
   * paso permite probar la maquina con una politica de mentira y ademas con la
   * de verdad.
   */
  esperaAntesDeReintentar: (intentosHechos: number, clase: ClaseDeFallo) => number | null;
  /** Programa algo. Devuelve como cancelarlo. */
  programar: (fn: () => void, ms: number) => () => void;

  /** Se llama en cada cambio. Es lo que repinta la pantalla. */
  alCambiar: (vista: VistaDeDirecto) => void;
  /** Un aviso puntual para la banda de error. Recibe una clave de `i18n`. */
  avisar: (clave: string) => void;
};

export type SesionDeDirecto = {
  vista: () => VistaDeDirecto;
  /** Arranca: pide credencial, permisos si toca, y entra en la sala. */
  arrancar: () => void;

  /* Lo que cuenta el servidor. */
  cambiaLaSesion: (estado: EstadoDeSesion) => void;

  /* Lo que cuenta la sala de video. */
  laSalaConecto: () => void;
  laSalaReconecta: () => void;
  laSalaCambioDeCalidad: (buena: boolean) => void;
  laSalaCambioDeMedios: (medios: {
    camara: boolean;
    microfono: boolean;
    camaraFrontal: boolean;
    publicando: boolean;
  }) => void;
  /**
   * Llega (o deja de llegar) imagen o sonido de OTRA persona. Es lo que pone
   * «en directo» a quien solo mira; sin esto se quedaba en «conectado» para
   * siempre, porque `publicando` es solo lo propio y un espectador no publica.
   */
  laSalaCambioDePistasAjenas: (hayMediosAjenos: boolean) => void;
  laSalaSeCayo: (recuperable: boolean) => void;

  /* Gestos. */
  empezar: () => Promise<void>;
  terminar: () => Promise<void>;
  /** `true` si se puede salir de la pantalla. Pregunta si hace falta. */
  intentarSalir: () => Promise<boolean>;
  alternarCamara: () => Promise<void>;
  alternarMicrofono: () => Promise<void>;
  cambiarCamara: () => Promise<void>;
  /** Reintento a mano. Vuelve a poner el contador a cero. */
  reintentar: () => void;

  /** Suelta todo: temporizador, sala, camara y microfono. Idempotente. */
  destruir: () => void;
};

export function crearSesionDeDirecto(entorno: EntornoDeDirecto): SesionDeDirecto {
  let sesion: EstadoDeSesion | null = entorno.estadoInicialDeSesion;
  let credencial: ResultadoDeCredencial = { estado: 'pendiente' };
  let permisoCamara: PermisoDeMedios = 'noHaceFalta';
  let permisoMicrofono: PermisoDeMedios = 'noHaceFalta';
  let conexion: ConexionDeSala = 'sinIniciar';
  /** Lo PROPIO: esta persona esta emitiendo. */
  let publicandoAqui = false;
  /** Lo AJENO: llega imagen o sonido de otra persona. */
  let mediosAjenos = false;
  /** Hay algo circulando, sea lo propio o lo ajeno. */
  const hayMedios = (): boolean => publicandoAqui || mediosAjenos;
  let quedanReintentos = false;
  let intentos = 0;
  let puedePublicar = false;

  let camara = false;
  let microfono = false;
  let camaraFrontal = true;

  /** Hay una accion de la persona en vuelo. Es el freno de la doble pulsacion. */
  let ocupado = false;
  let arrancada = false;
  let destruida = false;
  /**
   * Hay una conexion en vuelo.
   *
   * Es lo que impide entrar dos veces en la misma sala: `arrancar` tenia su
   * propio guardian pero `reintentar` no, y dos toques seguidos dejaban una
   * conexion huerfana con la camara encendida.
   */
  let conectando = false;
  /** Estamos dentro de la sala del SDK: sin esto, `destruir` saldria de nada. */
  let dentroDeLaSala = false;
  let cancelarReintento: (() => void) | null = null;

  const vistaActual = (): VistaDeDirecto => ({
    estado: decidirEstadoDeDirecto({
      sesion,
      credencial,
      permisoCamara,
      permisoMicrofono,
      conexion,
      hayMedios: hayMedios(),
      quedanReintentos,
    }),
    camara,
    microfono,
    camaraFrontal,
    puedePublicar,
    ocupado,
    intentos,
  });

  const publicar = (): void => {
    if (destruida) return;
    entorno.alCambiar(vistaActual());
  };

  const olvidarReintento = (): void => {
    if (cancelarReintento) {
      cancelarReintento();
      cancelarReintento = null;
    }
    quedanReintentos = false;
  };

  /**
   * Un fallo entra por aqui, y este es el unico sitio que decide si se insiste.
   *
   * `esperaAntesDeReintentar` devuelve `null` para todo lo que no se arregla
   * insistiendo Y tambien cuando se acabaron los intentos: la maquina no
   * distingue los dos casos porque en pantalla no se distinguen —se para— y
   * darle esa decision a la politica es lo que impide que se dupliquen las
   * reglas en dos sitios.
   */
  const tratarFallo = (error: unknown): void => {
    if (destruida) return;
    const fallo = entorno.clasificarFallo(error);
    credencial = { estado: 'fallo', fallo };
    olvidarReintento();

    const espera = entorno.esperaAntesDeReintentar(intentos, fallo.clase);
    if (espera === null) {
      quedanReintentos = false;
      publicar();
      return;
    }

    intentos += 1;
    quedanReintentos = true;
    cancelarReintento = entorno.programar(() => {
      cancelarReintento = null;
      void conectar();
    }, espera);
    publicar();
  };

  /**
   * El camino completo: credencial, permisos si toca, y entrada en la sala.
   *
   * NO se le pide un solo permiso a quien no va a publicar, y no es un `if` en
   * la pantalla: es este orden. Primero contesta el servidor si esta persona
   * puede emitir, y solo entonces se pregunta por camara y microfono. Un
   * espectador no llega nunca a la linea que los pide.
   */
  const conectar = async (): Promise<void> => {
    if (destruida) return;

    if (!entorno.banderaEncendida) {
      // La bandera apagada se cuenta como una credencial sin video, que es
      // literalmente lo que responderia el servidor. Ni una peticion.
      credencial = { estado: 'lista', puedePublicar: false, hayVideo: false };
      puedePublicar = false;
      publicar();
      return;
    }

    if (sesion === null || sesion !== 'live') {
      // Programada, terminada o cancelada: no hay sala. Pedir credencial aqui
      // solo se ganaria un 409, y con el, un contador de intentos gastado.
      publicar();
      return;
    }

    credencial = { estado: 'pendiente' };
    conexion = 'conectando';
    publicar();

    conectando = true;
    try {
      await entrarEnLaSala();
    } finally {
      conectando = false;
    }
  };

  /**
   * ¿Sigue teniendo sentido conectarse?
   *
   * SE PREGUNTA DESPUES DE CADA ESPERA. Entre pedir la credencial y entrar en la
   * sala pasan segundos, y en ese hueco la emision puede terminar —el anfitrion
   * la cierra, o llega el aviso por Realtime—. Sin esto se seguia adelante:
   * se pedian los permisos y se entraba en la sala de una emision TERMINADA, y
   * la camara se quedaba encendida detras de una pantalla que decia «terminado»
   * hasta que alguien desmontara el componente.
   */
  const yaNoProcede = (): boolean => destruida || sesion !== 'live';

  const entrarEnLaSala = async (): Promise<void> => {
    let leida: CredencialLeida;
    try {
      leida = await entorno.pedirCredencial();
    } catch (error) {
      if (yaNoProcede()) return;
      tratarFallo(error);
      return;
    }
    if (yaNoProcede()) return;
    if (destruida) return;

    puedePublicar = leida.puedePublicar;
    credencial = {
      estado: 'lista',
      puedePublicar: leida.puedePublicar,
      hayVideo: leida.hayVideo,
    };

    if (!leida.hayVideo) {
      // `provider: "none"`: hay respuesta, pero no hay video. No se pide ningun
      // permiso ni se entra en ninguna sala.
      conexion = 'sinIniciar';
      publicar();
      return;
    }

    if (leida.puedePublicar) {
      permisoCamara = 'pendiente';
      permisoMicrofono = 'pendiente';
      publicar();

      const camaraOk = await entorno.pedirPermiso('camara');
      if (yaNoProcede()) return;
      permisoCamara = camaraOk ? 'concedido' : 'denegado';
      if (!camaraOk) {
        // Se para aqui: sin camara no hay emision, y pedir el microfono
        // despues seria encadenar dos dialogos para acabar igual.
        permisoMicrofono = 'noHaceFalta';
        conexion = 'sinIniciar';
        publicar();
        return;
      }

      const microfonoOk = await entorno.pedirPermiso('microfono');
      if (yaNoProcede()) return;
      permisoMicrofono = microfonoOk ? 'concedido' : 'denegado';
      if (!microfonoOk) {
        conexion = 'sinIniciar';
        publicar();
        return;
      }
    }

    if (yaNoProcede()) return;
    try {
      await entorno.unirseALaSala(leida.opaca, leida.puedePublicar);
    } catch (error) {
      if (yaNoProcede()) return;
      tratarFallo(error);
      return;
    }
    if (yaNoProcede()) {
      // La pantalla se fue, o la emision termino, mientras se entraba: se sale
      // inmediatamente, o la camara se queda encendida detras de una pantalla
      // que ya no existe o que dice «terminado».
      void entorno.salirDeLaSala();
      return;
    }

    dentroDeLaSala = true;
    // El SDK avisara con `laSalaConecto`. Hasta entonces, conectando.
    publicar();
  };

  /**
   * Envuelve un gesto de la persona con el freno de la doble pulsacion.
   *
   * El freno se pone ANTES de cualquier `await`, incluido el del dialogo de
   * confirmacion: dos toques rapidos en «terminar» abrian dos dialogos, y
   * confirmar el segundo mandaba un segundo `POST /end` sobre una emision ya
   * cerrada, que vuelve con un 409 y se pinta como si algo hubiera fallado.
   */
  const conFreno = async (accion: () => Promise<void>): Promise<void> => {
    if (destruida || ocupado) return;
    ocupado = true;
    publicar();
    try {
      await accion();
    } finally {
      ocupado = false;
      if (!destruida) publicar();
    }
  };

  return {
    vista: vistaActual,

    arrancar() {
      if (arrancada || destruida) return;
      arrancada = true;
      void conectar();
    },

    cambiaLaSesion(nuevo) {
      if (destruida || nuevo === sesion) return;
      const antes = sesion;
      sesion = nuevo;

      if (nuevo === 'ended' || nuevo === 'cancelled') {
        /*
          LA EMISION SE ACABA MIENTRAS SE MIRA. Se suelta la sala en el acto: si
          no, el SDK sigue conectado contra una sala que el servidor ya cerro,
          empieza a reintentar por su cuenta y deja la camara de quien emitia
          encendida despues de terminar.
        */
        olvidarReintento();
        if (dentroDeLaSala) {
          dentroDeLaSala = false;
          void entorno.salirDeLaSala();
        }
        conexion = 'sinIniciar';
        publicandoAqui = false;
        mediosAjenos = false;
        camara = false;
        microfono = false;
        publicar();
        return;
      }

      if (nuevo === 'live' && antes !== 'live') {
        // Ha empezado: ahora si hay sala. Es el camino de una emision
        // programada que arranca con la pantalla ya abierta.
        publicar();
        void conectar();
        return;
      }

      publicar();
    },

    laSalaConecto() {
      if (destruida) return;
      olvidarReintento();
      intentos = 0;
      conexion = 'conectado';
      publicar();
    },

    laSalaReconecta() {
      if (destruida) return;
      conexion = 'reconectando';
      publicar();
    },

    laSalaCambioDeCalidad(buena) {
      if (destruida) return;
      // Solo mueve la aguja estando conectado: una mala medida durante la
      // reconexion no puede pintar «conexion lenta» sobre algo que no conecta.
      if (conexion !== 'conectado' && conexion !== 'lenta') return;
      conexion = buena ? 'conectado' : 'lenta';
      publicar();
    },

    laSalaCambioDeMedios(medios) {
      if (destruida) return;
      camara = medios.camara;
      microfono = medios.microfono;
      camaraFrontal = medios.camaraFrontal;
      publicandoAqui = medios.publicando;
      publicar();
    },

    laSalaCambioDePistasAjenas(hay) {
      if (destruida) return;
      mediosAjenos = hay;
      publicar();
    },

    laSalaSeCayo(recuperable) {
      if (destruida) return;
      dentroDeLaSala = false;
      conexion = 'perdida';
      publicandoAqui = false;
      mediosAjenos = false;
      if (!recuperable) {
        /*
          Token caducado, expulsion, sala cerrada por el proveedor: volver a
          entrar con la MISMA credencial da exactamente el mismo resultado. Se
          para —`error_definitivo`— y queda el reintento a mano, que si pide una
          credencial nueva.
        */
        credencial = { estado: 'fallo', fallo: { clase: 'desconocido' } };
        olvidarReintento();
        publicar();
        return;
      }
      tratarFallo({ status: 0 });
    },

    empezar() {
      return conFreno(async () => {
        try {
          await entorno.empezarEnElServidor();
        } catch {
          entorno.avisar('live.startFailed');
        }
      });
    },

    terminar() {
      return conFreno(async () => {
        const seguro = await entorno.confirmarFinal();
        if (!seguro || destruida) return;
        try {
          await entorno.terminarEnElServidor();
        } catch {
          entorno.avisar('live.endFailed');
        }
      });
    },

    async intentarSalir() {
      if (destruida) return true;
      /*
        Solo se pregunta a quien esta EMITIENDO de verdad. A quien mira no se le
        pone un dialogo por salir de un video —seria como preguntar antes de
        cerrar una pestaña— y a quien gestiona una emision que aun no ha
        empezado, tampoco: no hay nada que interrumpir.
      */
      // SE LEE AL VUELO, no se captura al construir. `esAnfitrion` sale de
      // `can_manage`, que el servidor recalcula en cada lectura de la ficha: si
      // estuviera en las dependencias del `useMemo`, un refresco que lo
      // devolviera distinto —una ventana de renovacion de token, por ejemplo—
      // destruiria la maquina y la sala a mitad de emision, y al anfitrion se
      // le cortaria la camara en su propio directo.
      if (!entorno.esAnfitrion() || sesion !== 'live') return true;
      return entorno.confirmarSalida();
    },

    alternarCamara() {
      return conFreno(async () => {
        if (!puedePublicar) return;
        await entorno.alternarCamaraEnLaSala(!camara);
      });
    },

    alternarMicrofono() {
      return conFreno(async () => {
        if (!puedePublicar) return;
        await entorno.alternarMicrofonoEnLaSala(!microfono);
      });
    },

    cambiarCamara() {
      return conFreno(async () => {
        if (!puedePublicar) return;
        await entorno.cambiarCamaraEnLaSala();
      });
    },

    reintentar() {
      if (destruida) return;
      /*
        SIN ESTO SE ENTRABA DOS VECES EN LA SALA. Era el unico gesto publico que
        no comprobaba si ya habia una conexion en vuelo: dos toques dentro del
        mismo fotograma —antes de que React repinte y esconda el boton— pedian
        dos credenciales, encadenaban cuatro dialogos de permiso y llamaban dos
        veces a `unirse`. Al desmontar solo se salia una vez, asi que la segunda
        conexion quedaba huerfana con la camara encendida.
      */
      if (conectando) return;
      /*
        A MANO SI SE PUEDE INSISTIR, y el contador vuelve a cero.

        No es una contradiccion con «nada de reintentos infinitos»: lo que no
        puede ser infinito es lo que ocurre SOLO, sin que nadie mire. Aqui hay
        una persona pulsando, y quien decide cuando parar es ella. Los estados
        definitivos siguen sin ofrecer este boton.
      */
      olvidarReintento();
      intentos = 0;
      credencial = { estado: 'pendiente' };
      conexion = 'sinIniciar';
      arrancada = true;
      publicar();
      void conectar();
    },

    destruir() {
      if (destruida) return;
      destruida = true;
      /*
        EL ORDEN IMPORTA. Primero se corta el temporizador —un reintento en
        vuelo sobre una pantalla desmontada volveria a pedir credencial y a
        entrar en una sala que nadie va a ver—, luego se sale, y por ultimo se
        destruye el SDK, que es lo que apaga de verdad la camara y el
        microfono. `salir` sin `destruir` deja el motor cargado y, en algunos
        telefonos, el piloto de la camara encendido.
      */
      if (cancelarReintento) {
        cancelarReintento();
        cancelarReintento = null;
      }
      if (dentroDeLaSala) {
        dentroDeLaSala = false;
        void entorno.salirDeLaSala();
      }
      entorno.destruirLaSala();
    },
  };
}
