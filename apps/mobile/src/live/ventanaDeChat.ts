/**
 * LA VENTANA DEL CHAT DE UN DIRECTO: que mensajes hay en memoria, en que orden,
 * y cuando se le pregunta algo al servidor.
 *
 * EL CHAT DE UN DIRECTO NO ES UN HISTORIAL. Quien entra quiere ver de que se
 * habla AHORA; nadie sube doscientos mensajes para leer lo de hace diez
 * minutos, y el servidor los guarda igualmente. Asi que en el telefono vive una
 * VENTANA: los ultimos `TOPE_DE_MENSAJES`. Lo que sale por arriba no se borra
 * de ningun sitio, solo deja de ocupar memoria aqui.
 *
 * Tres cosas que antes estaban repartidas por la pantalla y no se podian
 * probar:
 *
 *   - la lista se SUSTITUIA entera en cada recarga, y las filas perdian su
 *     identidad: React las repintaba todas por un mensaje nuevo;
 *   - un mensaje que llegaba tarde se añadia al final aunque fuera anterior;
 *   - una rafaga de gente nueva escribiendo podia encadenar una lectura al
 *     servidor cada cuarto de segundo mientras durase.
 *
 * NO IMPORTA NADA: se ejecuta con `node --test`.
 */

/** Lo que este modulo necesita saber de un mensaje. */
export type MensajeDeVentana = {
  id: string;
  creadoEnIso: string;
  oculto: boolean;
  cuerpo: string;
  usuarioNombre: string;
  usuarioAvatarUrl?: string;
};

/**
 * Cuantos mensajes se guardan en memoria.
 *
 * Tres veces lo que devuelve la carga inicial (50): deja subir a leer un rato
 * sin que la lista crezca toda la emision. A doce mensajes por persona cada
 * treinta segundos —el limite del servidor—, una sala animada los renueva en
 * menos de un minuto.
 */
export const TOPE_DE_MENSAJES = 150;

/**
 * El instante de un mensaje, o `NaN` si la fecha no se puede leer.
 *
 * PostgreSQL da microsegundos («12:00:00.123456+00:00»), que no todos los
 * motores de JavaScript saben leer: las pruebas corren en V8 y los telefonos en
 * Hermes. Se dejan en milisegundos ANTES de interpretar, que es lo unico que
 * la norma garantiza.
 */
function instante(iso: string): number {
  return Date.parse(typeof iso === 'string' ? iso.replace(/(\.\d{3})\d+/, '$1') : '');
}

/**
 * Orden de conversacion: por hora, y a igualdad, por id (estable).
 *
 * Si una de las dos fechas no se puede leer no hay con que comparar: se
 * respeta el orden de llegada. Antes ordenaba por id, y los ids son al azar:
 * un motor que no leyera las fechas habria barajado el chat entero.
 */
function vaAntes(a: MensajeDeVentana, b: MensajeDeVentana): boolean {
  const ta = instante(a.creadoEnIso);
  const tb = instante(b.creadoEnIso);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return true;
  if (ta !== tb) return ta < tb;
  return a.id < b.id;
}

function dicenLoMismo(a: MensajeDeVentana, b: MensajeDeVentana): boolean {
  return (
    a.oculto === b.oculto &&
    a.cuerpo === b.cuerpo &&
    a.usuarioNombre === b.usuarioNombre &&
    a.usuarioAvatarUrl === b.usuarioAvatarUrl &&
    a.creadoEnIso === b.creadoEnIso
  );
}

function recortar<T>(lista: T[], tope: number): T[] {
  return lista.length > tope ? lista.slice(lista.length - tope) : lista;
}

/**
 * Mete UN mensaje en la ventana: nuevo, o el cambio de uno que ya estaba.
 *
 * - Si ya estaba y dice lo mismo, devuelve LA MISMA ventana: nada que pintar.
 * - Si ya estaba y cambio (en este chat, que lo han escondido), se sustituye
 *   en su sitio.
 * - Si es nuevo, entra por orden de hora. Casi siempre es el ultimo, y ese
 *   caso no recorre la lista.
 *
 * Los demas mensajes conservan su objeto: una fila memorizada no se repinta
 * porque haya llegado otro.
 */
export function aplicarMensaje<T extends MensajeDeVentana>(
  ventana: readonly T[],
  mensaje: T,
  tope: number = TOPE_DE_MENSAJES,
): readonly T[] {
  const posicion = ventana.findIndex((otro) => otro.id === mensaje.id);
  if (posicion >= 0) {
    const anterior = ventana[posicion] as T;
    if (dicenLoMismo(anterior, mensaje)) return ventana;
    const copia = ventana.slice();
    copia[posicion] = mensaje;
    return copia;
  }

  const ultimo = ventana[ventana.length - 1];
  if (!ultimo || vaAntes(ultimo, mensaje)) return recortar([...ventana, mensaje], tope);

  // Llego tarde: se busca su sitio desde el final, que es donde estara.
  let sitio = ventana.length - 1;
  while (sitio > 0 && vaAntes(mensaje, ventana[sitio - 1] as T)) sitio -= 1;
  // Un mensaje anterior a TODA la ventana, con la ventana ya llena, es
  // historial: no entra.
  if (sitio === 0 && ventana.length >= tope) return ventana;
  const copia = ventana.slice();
  copia.splice(sitio, 0, mensaje);
  return recortar(copia, tope);
}

/**
 * Junta la ventana con lo que acaba de devolver el servidor (los ultimos 50).
 *
 * SE FUNDE, NO SE SUSTITUYE. Lo que ya estaba y no viene en la lista —por mas
 * antiguo— se queda, y lo que viene y ya estaba conserva su objeto si no ha
 * cambiado. Devuelve la misma ventana si la lista no aporta nada.
 *
 * SOLO AÑADE. Lo que el servidor ha dejado de devolver lo quita
 * `retirarLoQueYaNoEsta`, que necesita saber algo que esta funcion no sabe:
 * que mensajes ya estaban aqui cuando se pidio la lista.
 */
export function fundirConLaLista<T extends MensajeDeVentana>(
  ventana: readonly T[],
  lista: readonly T[],
  tope: number = TOPE_DE_MENSAJES,
): readonly T[] {
  let resultado = ventana;
  for (const mensaje of lista) resultado = aplicarMensaje(resultado, mensaje, tope);
  return resultado;
}

/**
 * Quita de la ventana lo que el servidor YA NO DEVUELVE.
 *
 * POR QUE HACE FALTA. Esconder un mensaje es un cambio en la base, y Realtime
 * solo se lo entrega a quien todavia puede leer la fila: quien modera y quien
 * la escribio (politica `live_messages_read`). Al publico no le llega nada. Lo
 * unico que le dice que el mensaje ya no esta es que el servidor deja de
 * devolverlo. Cuando la lista sustituia a la ventana eso ocurria solo; al
 * pasar a fundir, el mensaje moderado se quedaba en pantalla.
 *
 * QUE SE QUITA: un mensaje que no viene en la lista, que cae dentro de lo que
 * la lista abarca (no es anterior a su primer mensaje) y que YA ESTABA aqui
 * cuando se pidio.
 *
 * QUE NO SE QUITA:
 *   - lo anterior al primer mensaje de la lista: no es que este escondido, es
 *     que no cabe en los ultimos 50;
 *   - lo que llego DESPUES de pedirla (`esPosterior`): la lista es una foto de
 *     antes, y no traerlo no significa nada.
 *
 * Una lista VACIA es una respuesta completa —no queda nada visible—, asi que
 * se quita todo lo que ya estaba.
 *
 * Devuelve la misma ventana si no hay nada que quitar.
 */
export function retirarLoQueYaNoEsta<T extends MensajeDeVentana>(
  ventana: readonly T[],
  lista: readonly T[],
  esPosterior: (id: string) => boolean,
): readonly T[] {
  const enLaLista = new Set(lista.map((mensaje) => mensaje.id));
  let desde = Number.NEGATIVE_INFINITY;
  if (lista.length > 0) {
    desde = Number.POSITIVE_INFINITY;
    for (const mensaje of lista) {
      const t = instante(mensaje.creadoEnIso);
      // Con una fecha ilegible en la lista no se sabe que abarca: no se quita.
      if (Number.isNaN(t)) return ventana;
      if (t < desde) desde = t;
    }
  }
  const sobra = (mensaje: T): boolean => {
    if (enLaLista.has(mensaje.id) || esPosterior(mensaje.id)) return false;
    const t = instante(mensaje.creadoEnIso);
    return !Number.isNaN(t) && t >= desde;
  };
  return ventana.some(sobra) ? ventana.filter((mensaje) => !sobra(mensaje)) : ventana;
}

/**
 * Los que se pintan: los que la moderacion no ha escondido.
 *
 * Devuelve la misma lista si no hay ninguno escondido, que es lo normal.
 */
export function mensajesVisibles<T extends MensajeDeVentana>(ventana: readonly T[]): readonly T[] {
  return ventana.some((mensaje) => mensaje.oculto)
    ? ventana.filter((mensaje) => !mensaje.oculto)
    : ventana;
}

/**
 * Cuantos mensajes VISIBLES hay en `despues` que no estaban en `antes`.
 *
 * Es lo que se le cuenta a quien esta leyendo mas arriba. Un mensaje que se
 * esconde, o uno que cambia, no es un mensaje nuevo.
 */
export function cuantosNuevos<T extends MensajeDeVentana>(
  antes: readonly T[],
  despues: readonly T[],
): number {
  if (antes === despues) return 0;
  const conocidos = new Set(antes.map((mensaje) => mensaje.id));
  let nuevos = 0;
  for (const mensaje of despues) {
    if (!mensaje.oculto && !conocidos.has(mensaje.id)) nuevos += 1;
  }
  return nuevos;
}

/* ------------------------------------------------------------------------- *
 * SEGUIR EL FINAL, O NO.
 * ------------------------------------------------------------------------- */

/**
 * A cuantos puntos del final se considera que alguien «esta al final».
 *
 * Mas que una fila y menos que dos: un mensaje nuevo que empuja la lista no
 * saca a nadie del final, pero subir a leer si.
 */
export const UMBRAL_DEL_FINAL = 72;

export type Seguimiento = {
  /** Esta viendo lo ultimo: los mensajes nuevos le llevan con ellos. */
  alFinal: boolean;
  /** Cuantos han llegado mientras leia mas arriba. */
  nuevos: number;
};

export function seguimientoInicial(): Seguimiento {
  return { alFinal: true, nuevos: 0 };
}

/**
 * Llegaron `cuantos` mensajes visibles.
 *
 * Quien esta al final no acumula nada: los esta viendo. Quien subio a leer NO
 * se mueve —arrastrarle al final a mitad de una frase es lo que hace
 * insoportable un chat rapido— y se le cuenta cuantos tiene pendientes.
 */
export function alLlegarMensajes(seguimiento: Seguimiento, cuantos: number): Seguimiento {
  if (seguimiento.alFinal || cuantos <= 0) return seguimiento;
  return { alFinal: false, nuevos: seguimiento.nuevos + cuantos };
}

/** La persona desplazo la lista. `distanciaAlFinal` en puntos. */
export function alDesplazar(
  seguimiento: Seguimiento,
  distanciaAlFinal: number,
  umbral: number = UMBRAL_DEL_FINAL,
): Seguimiento {
  const alFinal = distanciaAlFinal <= umbral;
  if (alFinal) return seguimiento.alFinal && seguimiento.nuevos === 0 ? seguimiento : seguimientoInicial();
  return seguimiento.alFinal ? { alFinal: false, nuevos: 0 } : seguimiento;
}

/* ------------------------------------------------------------------------- *
 * EL ESTADO DEL CHAT, dicho con una palabra.
 * ------------------------------------------------------------------------- */

export type EstadoDeChat = 'conectando' | 'conectado' | 'reconectando' | 'cerrado' | 'error';

/**
 * Que se le dice a quien mira sobre el chat.
 *
 * - `cerrado`: la emision no esta en directo. Manda sobre todo lo demas.
 * - `error`: no se pudieron leer los mensajes. Es RECUPERABLE: se ofrece
 *   reintentar, y el siguiente mensaje que llegue lo intenta solo.
 * - `reconectando`: el canal estuvo y se cayo. Se esta recuperando solo.
 * - `conectando`: todavia no ha estado.
 * - `conectado`: lo normal, y no se dice.
 */
export function estadoDelChat(datos: {
  abierto: boolean;
  carga: 'pendiente' | 'lista' | 'fallida';
  canal: 'conectando' | 'suscrito' | 'caido';
  seConectoAntes: boolean;
}): EstadoDeChat {
  if (!datos.abierto) return 'cerrado';
  if (datos.carga === 'fallida') return 'error';
  if (datos.canal === 'suscrito') return datos.carga === 'lista' ? 'conectado' : 'conectando';
  if (datos.canal === 'caido' && datos.seConectoAntes) return 'reconectando';
  return 'conectando';
}

/* ------------------------------------------------------------------------- *
 * LA RECARGA AGRUPADA.
 * ------------------------------------------------------------------------- */

export type RecargaAgrupada = {
  /** Pide una lectura. Barato de llamar: cien llamadas seguidas son una. */
  pedir: () => void;
  /**
   * Lee AHORA, sin esperar a agrupar. Para la carga inicial y el «reintentar».
   * Pasa por la misma cola: si ya hay una lectura en vuelo, es esa.
   */
  leerYa: () => Promise<void>;
  /** Suelta el temporizador. Una lectura en vuelo ya no avisa a nadie. */
  cancelar: () => void;
  /** Cuantas lecturas se han lanzado. Para el diagnostico y las pruebas. */
  lecturas: () => number;
};

/**
 * Agrupa las lecturas al servidor que piden los mensajes de autor desconocido.
 *
 * La fila que entrega Realtime trae `user_id` pero no el nombre, asi que la
 * primera vez que escribe alguien hay que preguntar. Sin agrupar, una sala que
 * se llena pediria la lista una vez por persona.
 *
 * LA GARANTIA: nunca hay dos lecturas a la vez —tampoco la inicial con una
 * agrupada—, y entre el final de una y el principio de la siguiente pasa al
 * menos `esperaMs`. Una rafaga de N peticiones cuesta UNA lectura si cabe en
 * la espera, y como mucho una mas por cada lectura que dure la rafaga —no una
 * por mensaje—.
 *
 * `dispersionMs` añade una espera al azar. Cuando alguien nuevo escribe, la
 * misma fila llega a todos los telefonos de la sala a la vez; sin esto, todos
 * preguntarian al servidor en el mismo instante.
 */
export function crearRecargaAgrupada(entorno: {
  leer: () => Promise<void>;
  esperaMs: number;
  programar: (fn: () => void, ms: number) => () => void;
  dispersionMs?: number;
  /** De 0 a 1. Por defecto, sin dispersion. */
  azar?: () => number;
}): RecargaAgrupada {
  let cancelarEspera: (() => void) | null = null;
  let enVuelo: Promise<void> | null = null;
  let otraMas = false;
  let cancelada = false;
  let lanzadas = 0;

  function programar(): void {
    if (cancelarEspera || cancelada) return;
    const dispersion = (entorno.dispersionMs ?? 0) * (entorno.azar ? entorno.azar() : 0);
    cancelarEspera = entorno.programar(() => {
      cancelarEspera = null;
      void lanzar();
    }, entorno.esperaMs + dispersion);
  }

  function lanzar(): Promise<void> {
    if (cancelada) return Promise.resolve();
    if (enVuelo) return enVuelo;
    lanzadas += 1;
    const lectura = (async () => {
      try {
        await entorno.leer();
      } catch {
        // Un fallo aqui solo significa que ese mensaje tarda un poco mas en
        // aparecer; el siguiente evento vuelve a intentarlo.
      } finally {
        enVuelo = null;
        if (otraMas) {
          otraMas = false;
          programar();
        }
      }
    })();
    enVuelo = lectura;
    return lectura;
  }

  return {
    pedir() {
      if (cancelada) return;
      if (enVuelo) {
        // Lo que se esta leyendo puede no traer a quien acaba de escribir:
        // hace falta UNA mas cuando termine, por muchos que escriban.
        otraMas = true;
        return;
      }
      programar();
    },

    leerYa() {
      if (cancelada) return Promise.resolve();
      if (enVuelo) return enVuelo;
      if (cancelarEspera) {
        cancelarEspera();
        cancelarEspera = null;
      }
      return lanzar();
    },

    cancelar() {
      cancelada = true;
      otraMas = false;
      if (cancelarEspera) {
        cancelarEspera();
        cancelarEspera = null;
      }
    },

    lecturas() {
      return lanzadas;
    },
  };
}

/* ------------------------------------------------------------------------- *
 * EL CHAT EN VIVO: la ventana, quien escribe, y cuando se lee del servidor.
 * ------------------------------------------------------------------------- */

/** Un mensaje del chat tal y como se pinta. Es `MensajeDeEmision`. */
export type MensajeDeChat = MensajeDeVentana & {
  emisionId: string;
  usuarioId: string;
};

/**
 * La fila de `live_messages` que entrega el tiempo real. SIN nombre.
 *
 * Y SIN `hidden`: esa columna no existe. La tabla guarda `hidden_at` (cuando
 * se escondio, o `null`); el booleano `hidden` lo calcula la API. Leer
 * `hidden` de esta fila daba siempre «no escondido», y a quien moderaba le
 * reaparecia el mensaje en cuanto llegaba el cambio.
 */
export type FilaDeChat = {
  id: string;
  session_id: string;
  user_id: string;
  body: string;
  created_at: string;
  hidden_at: string | null;
};

/**
 * El topico de Broadcast por el que se avisa de que el chat ha cambiado.
 * Canonico: solo depende de la emision, igual que el de las reacciones.
 */
export function topicoDeAvisosDelChat(emisionId: string): string {
  return `live-chat-avisos:${emisionId}`;
}

/**
 * Cada cuanto, como mucho, un aviso de moderacion provoca una lectura.
 *
 * El aviso llega por un canal publico: lo puede mandar cualquiera. Sin esta
 * espera, quien lo mandara en bucle pondria a toda la sala a leer del servidor
 * sin parar.
 */
export const ESPERA_ENTRE_AVISOS_MS = 5_000;

/** Lo que se reparte al azar la lectura que sigue a un aviso. */
export const DISPERSION_DE_AVISO_MS = 1_500;

/** Lo que se reparte al azar la lectura por un autor desconocido. */
export const DISPERSION_DE_LECTURA_MS = 400;

/**
 * Cuanto se deja de preguntar por alguien a quien el servidor no devuelve.
 *
 * El servidor no entrega los mensajes de quien uno ha bloqueado, pero la fila
 * de Realtime si llega. Sin esto, cada mensaje de esa persona costaba una
 * lectura entera que nunca la iba a traer.
 */
export const ESPERA_POR_AUTOR_AUSENTE_MS = 60_000;

/** Cuantos nombres se recuerdan. Pasado el tope se olvida el mas antiguo. */
export const TOPE_DE_AUTORES = 1_000;

export type ChatEnVivo = {
  /** La carga inicial, y el «reintentar». No rechaza. */
  cargar: () => Promise<void>;
  /** Llego una fila por tiempo real: un mensaje nuevo, o uno que se esconde. */
  llegaFila: (fila: FilaDeChat) => void;
  /**
   * El canal volvio despues de una caida. Lo que se escribio entre medias no
   * llego: se pide UNA lectura (agrupada con las demas) para recuperarlo.
   */
  volvioElCanal: () => void;
  /**
   * Llego el aviso de que alguien ha moderado. Se vuelve a leer del servidor,
   * que es quien dice que se ve; como mucho una vez cada
   * `ESPERA_ENTRE_AVISOS_MS`, por muchos avisos que lleguen.
   */
  seModero: () => void;
  /** Se sabe como se llama alguien (uno mismo, por ejemplo). */
  conocerA: (usuarioId: string, nombre: string, avatarUrl?: string) => void;
  /** Mete o actualiza un mensaje ya completo (el propio sin tiempo real). */
  poner: (mensaje: MensajeDeChat) => void;
  ventana: () => readonly MensajeDeChat[];
  /** Lecturas al servidor lanzadas, contando la inicial. */
  lecturas: () => number;
  /** Suelta los temporizadores. Despues no avisa de nada. Idempotente. */
  destruir: () => void;
};

/**
 * El chat de una emision, sin React.
 *
 * Es el cableado que antes vivia dentro de la pantalla: que hacer con una fila
 * que llega, que hacer si no se sabe quien la escribio, y como se junta lo que
 * devuelve el servidor con lo que ya habia. Fuera del componente se puede
 * ejecutar con varios clientes a la vez.
 *
 * `alCambiar` recibe la ventana nueva y CUANTOS mensajes visibles son nuevos,
 * que es lo que necesita quien esta leyendo mas arriba. No se llama si la
 * ventana no cambia.
 */
export function crearChatEnVivo(entorno: {
  /** Los ultimos mensajes que guarda el servidor, con su autor. */
  leer: () => Promise<readonly MensajeDeChat[]>;
  esperaMs: number;
  programar: (fn: () => void, ms: number) => () => void;
  ahora: () => number;
  /** De 0 a 1. Por defecto, `Math.random`. */
  azar?: () => number;
  alCambiar: (ventana: readonly MensajeDeChat[], nuevos: number) => void;
  /** Como acabo una lectura. */
  alLeer: (resultado: 'lista' | 'fallida') => void;
}): ChatEnVivo {
  const azar = entorno.azar ?? Math.random;
  /*
    Quien escribio cada mensaje. La fila que entrega el tiempo real trae
    `user_id` y nada mas —el nombre y el avatar viven en otra tabla—, asi que
    este mapa es lo que permite pintar un mensaje nuevo sin volver a preguntar.
  */
  const autores = new Map<string, { nombre: string; avatarUrl?: string }>();
  /** De quien se ha pedido el nombre, y cuando. */
  const pendientes = new Map<string, number>();
  /** A quien el servidor no devolvio: hasta cuando no se vuelve a preguntar. */
  const ausentes = new Map<string, number>();
  /** Cuando entro cada mensaje EN ESTE TELEFONO (no cuando se escribio). */
  const llegadas = new Map<string, number>();
  let ventana: readonly MensajeDeChat[] = [];
  let destruido = false;
  let ultimoAviso = Number.NEGATIVE_INFINITY;
  let cancelarAviso: (() => void) | null = null;

  function recordar(usuarioId: string, nombre: string, avatarUrl?: string): void {
    // Se vuelve a meter al final: el que se olvida es el que lleva mas sin
    // escribir.
    autores.delete(usuarioId);
    autores.set(usuarioId, { nombre, avatarUrl });
    if (autores.size > TOPE_DE_AUTORES) {
      const masAntiguo = autores.keys().next().value;
      if (masAntiguo !== undefined) autores.delete(masAntiguo);
    }
  }

  function publicar(siguiente: readonly MensajeDeChat[]): void {
    if (destruido || siguiente === ventana) return;
    const nuevos = cuantosNuevos(ventana, siguiente);
    const ahora = entorno.ahora();
    const vivos = new Set<string>();
    for (const mensaje of siguiente) {
      vivos.add(mensaje.id);
      if (!llegadas.has(mensaje.id)) llegadas.set(mensaje.id, ahora);
    }
    // Lo que sale de la ventana deja de ocupar sitio aqui tambien.
    for (const id of llegadas.keys()) if (!vivos.has(id)) llegadas.delete(id);
    ventana = siguiente;
    entorno.alCambiar(siguiente, nuevos);
  }

  async function leer(): Promise<void> {
    const empezo = entorno.ahora();
    let lista: readonly MensajeDeChat[];
    try {
      lista = await entorno.leer();
    } catch (fallo) {
      // Sin esto un fallo de carga dejaba el chat vacio, como si nadie hubiera
      // escrito nunca, en vez de avisar de que no se pudo leer.
      if (!destruido) entorno.alLeer('fallida');
      throw fallo;
    }
    if (destruido) return;
    for (const mensaje of lista) {
      recordar(mensaje.usuarioId, mensaje.usuarioNombre, mensaje.usuarioAvatarUrl);
    }

    // A quien se pidio ANTES de esta lectura y sigue sin aparecer, el servidor
    // no lo va a devolver (lo normal: esta persona lo tiene bloqueado).
    for (const [usuarioId, pedido] of [...pendientes]) {
      if (autores.has(usuarioId)) {
        pendientes.delete(usuarioId);
      } else if (pedido <= empezo) {
        pendientes.delete(usuarioId);
        ausentes.set(usuarioId, entorno.ahora() + ESPERA_POR_AUTOR_AUSENTE_MS);
      }
    }
    for (const [usuarioId, hasta] of [...ausentes]) {
      if (hasta <= entorno.ahora()) ausentes.delete(usuarioId);
    }

    // Primero se quita lo que el servidor ya no devuelve; luego se añade.
    const sinLoRetirado = retirarLoQueYaNoEsta(
      ventana,
      lista,
      // Lo que llego despues de pedir la lista no puede venir en ella.
      (id) => (llegadas.get(id) ?? Number.POSITIVE_INFINITY) > empezo,
    );
    publicar(fundirConLaLista(sinLoRetirado, lista));
    entorno.alLeer('lista');
  }

  const recarga = crearRecargaAgrupada({
    leer,
    esperaMs: entorno.esperaMs,
    programar: entorno.programar,
    dispersionMs: DISPERSION_DE_LECTURA_MS,
    azar,
  });

  return {
    cargar() {
      if (destruido) return Promise.resolve();
      return recarga.leerYa();
    },

    llegaFila(fila) {
      if (destruido || !fila || typeof fila.id !== 'string') return;
      const autor = autores.get(fila.user_id);
      if (!autor) {
        /*
          No sabemos quien ha escrito. Antes que pintar el mensaje con un
          nombre inventado o con un hueco, se pide la lista al servidor —que si
          trae los nombres— y entra completo poco despues. Solo pasa la primera
          vez que habla cada persona, y por mucha gente nueva que escriba a la
          vez las lecturas van de una en una.
        */
        const hasta = ausentes.get(fila.user_id);
        if (hasta !== undefined && hasta > entorno.ahora()) return;
        if (!pendientes.has(fila.user_id)) pendientes.set(fila.user_id, entorno.ahora());
        recarga.pedir();
        return;
      }
      publicar(
        aplicarMensaje(ventana, {
          id: fila.id,
          emisionId: fila.session_id,
          usuarioId: fila.user_id,
          usuarioNombre: autor.nombre,
          usuarioAvatarUrl: autor.avatarUrl,
          cuerpo: fila.body,
          creadoEnIso: fila.created_at,
          // `hidden_at`, que es lo que guarda la tabla. Ver `FilaDeChat`.
          oculto: fila.hidden_at != null,
        }),
      );
    },

    volvioElCanal() {
      if (!destruido) recarga.pedir();
    },

    seModero() {
      if (destruido || cancelarAviso) return;
      const falta = Math.max(0, ultimoAviso + ESPERA_ENTRE_AVISOS_MS - entorno.ahora());
      cancelarAviso = entorno.programar(() => {
        cancelarAviso = null;
        if (destruido) return;
        ultimoAviso = entorno.ahora();
        recarga.pedir();
      }, falta + DISPERSION_DE_AVISO_MS * azar());
    },

    conocerA(usuarioId, nombre, avatarUrl) {
      recordar(usuarioId, nombre, avatarUrl);
    },

    poner(mensaje) {
      if (destruido) return;
      recordar(mensaje.usuarioId, mensaje.usuarioNombre, mensaje.usuarioAvatarUrl);
      publicar(aplicarMensaje(ventana, mensaje));
    },

    ventana: () => ventana,

    lecturas: () => recarga.lecturas(),

    destruir() {
      destruido = true;
      recarga.cancelar();
      if (cancelarAviso) {
        cancelarAviso();
        cancelarAviso = null;
      }
    },
  };
}
