/**
 * Como se junta lo que llega al chat por tres caminos distintos sin duplicar.
 *
 * EL PROBLEMA, que es el clasico de cualquier chat en vivo. Un mensaje propio
 * llega DOS veces:
 *
 *   1. Por la respuesta del `POST` que lo guardo.
 *   2. Por la suscripcion de Realtime, que entrega el INSERT a todos los
 *      miembros de la conversacion, y el que escribe es uno de ellos.
 *
 * Y ademas, mientras esas dos llegan, en la pantalla ya hay una burbuja
 * OPTIMISTA puesta al pulsar enviar, para que escribir se note instantaneo.
 * Son tres versiones del mismo mensaje.
 *
 * El orden en que llegan las dos primeras NO esta garantizado. Realtime suele
 * ser mas rapido que la respuesta HTTP, asi que el caso frecuente es el que
 * peor se maneja si solo se descarta «lo que ya tenga ese id»: cuando llega la
 * fila de Realtime, la burbuja optimista todavia tiene su identificador
 * temporal, no coincide con nada, y el mensaje se pinta DOS VECES —una vez
 * como pendiente y otra como recibido— hasta que la respuesta del POST llega y
 * limpia. Un parpadeo que se ve.
 *
 * LAS TRES REGLAS, y estan aqui y no dentro de la pantalla para poder probarlas
 * sin montar un canal de Realtime ni un servidor:
 *
 *   1. Un mensaje solo existe una vez por identificador, y gana la version mas
 *      reciente: la del servidor trae cosas que la optimista no puede saber,
 *      como los adjuntos ya registrados o la hora de verdad.
 *   2. Un mensaje PROPIO confirmado sustituye a la burbuja optimista que le
 *      corresponde, aunque sus identificadores no coincidan.
 *   3. El orden lo manda el instante del servidor. Lo que aun no ha llegado al
 *      servidor —lo optimista— va al final, que es donde lo espera quien acaba
 *      de escribirlo.
 *
 * Estas funciones son PURAS: no saben de React, ni de red, ni de Supabase.
 */

/** Lo minimo que necesita saber esta logica de un mensaje. */
export type MensajeFusionable = {
  id: string;
  /**
   * El instante que puso el servidor, en ISO. Los mensajes optimistas todavia
   * no lo tienen: no han llegado al servidor, asi que no hay hora que valga.
   */
  createdAtIso?: string;
  text: string;
  sender: 'me' | 'them';
};

/**
 * Como empiezan los identificadores de las burbujas optimistas.
 *
 * Un prefijo y no un campo aparte porque el identificador ya viaja por todas
 * partes —es la clave de la lista— y asi no hay forma de perder el dato por el
 * camino.
 */
export const PREFIJO_TEMPORAL = 'tmp-';

/** Si este mensaje todavia no existe en el servidor. */
export function esTemporal(id: string): boolean {
  return id.startsWith(PREFIJO_TEMPORAL);
}

/** Un identificador temporal nuevo. */
export function nuevoIdTemporal(semilla: number = Date.now()): string {
  return `${PREFIJO_TEMPORAL}${semilla}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Ordena por el instante del servidor y deja lo pendiente al final.
 *
 * El desempate por identificador no es adorno: dos mensajes pueden compartir
 * instante —se guardaron dentro del mismo milisegundo, o el reloj de la base
 * tiene menos resolucion— y sin un segundo criterio la lista bailaria entre
 * repintados, moviendo burbujas mientras alguien las lee.
 */
function comparar(a: MensajeFusionable, b: MensajeFusionable): number {
  if (a.createdAtIso && b.createdAtIso) {
    if (a.createdAtIso !== b.createdAtIso) {
      return a.createdAtIso < b.createdAtIso ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }
  // Sin instante = todavia no ha llegado al servidor = va al final.
  if (!a.createdAtIso && !b.createdAtIso) return a.id < b.id ? -1 : 1;
  return a.createdAtIso ? -1 : 1;
}

/**
 * Junta lo que ya se pintaba con lo que acaba de llegar.
 *
 * Sirve igual para la carga inicial, para el historial que se trae al subir,
 * para lo que entrega Realtime y para el lote que completa los adjuntos: en
 * todos los casos la pregunta es la misma, «que hay ahora en la lista».
 */
export function fusionar<T extends MensajeFusionable>(
  actuales: readonly T[],
  entrantes: readonly T[],
): T[] {
  return combinar(actuales, entrantes, true);
}

/**
 * El motor de las dos anteriores.
 *
 * `emparejarPorContenido` decide si se aplica la regla 2. Se apaga cuando quien
 * llama YA SABE que burbuja optimista corresponde —porque acaba de recibir la
 * respuesta de su propio envio— y eso es lo unico que hace correcto el caso de
 * dos mensajes seguidos con el mismo texto: «si», «si». Emparejando por
 * contenido, confirmar el primero borraria el segundo, que todavia esta en
 * vuelo, y ese mensaje desapareceria de la pantalla sin que nadie lo hubiera
 * cancelado.
 */
function combinar<T extends MensajeFusionable>(
  actuales: readonly T[],
  entrantes: readonly T[],
  emparejarPorContenido: boolean,
): T[] {
  if (entrantes.length === 0) return [...actuales];

  const porId = new Map<string, T>();
  for (const mensaje of actuales) porId.set(mensaje.id, mensaje);

  for (const entrante of entrantes) {
    // Regla 2: un mensaje propio confirmado se come su burbuja optimista.
    // Se busca por CONTENIDO porque es lo unico que comparten: el servidor no
    // sabe nada del identificador temporal que invento la pantalla.
    //
    // SOLO SI ES LA PRIMERA VEZ QUE LLEGA. Si ya esta en la lista, ya se comio
    // su burbuja —o la quito `reconciliarEnvio`— y lo que llega es su eco de
    // tiempo real. Emparejarlo otra vez se llevaria la burbuja del SIGUIENTE
    // envio con el mismo texto: con varios archivos o dos notas de voz
    // seguidas, todas sin texto, el segundo desaparecia mientras subia.
    if (
      emparejarPorContenido &&
      !esTemporal(entrante.id) &&
      entrante.sender === 'me' &&
      !porId.has(entrante.id)
    ) {
      for (const [id, candidato] of porId) {
        if (esTemporal(id) && candidato.text === entrante.text) {
          // El primero que encaja, y `Map` conserva el orden de insercion: con
          // dos pendientes iguales se confirma el mas antiguo, que es el que
          // se envio antes.
          porId.delete(id);
          break;
        }
      }
    }
    // Regla 1: gana la version que acaba de llegar.
    porId.set(entrante.id, entrante);
  }

  return [...porId.values()].sort(comparar);
}

/**
 * Cierra el envio: quita la burbuja optimista y deja la version del servidor.
 *
 * Se separa de `fusionar` porque aqui SI se conoce el identificador temporal
 * exacto, y borrarlo por identificador es mas seguro que por contenido: dos
 * mensajes seguidos con el mismo texto —«si», «si»— son de lo mas normal, y
 * por contenido se borraria el que no toca.
 */
export function reconciliarEnvio<T extends MensajeFusionable>(
  actuales: readonly T[],
  idTemporal: string,
  guardado: T,
): T[] {
  const sinTemporal = actuales.filter((mensaje) => mensaje.id !== idTemporal);
  // Sin emparejar por contenido: el temporal que tocaba ya se ha quitado por
  // identificador, y dejar la regla activa se llevaria por delante OTRO envio
  // pendiente con el mismo texto.
  return combinar(sinTemporal, [guardado], false);
}

/** Quita una burbuja optimista que no llego a enviarse. */
export function descartarEnvio<T extends MensajeFusionable>(
  actuales: readonly T[],
  idTemporal: string,
): T[] {
  return actuales.filter((mensaje) => mensaje.id !== idTemporal);
}

/**
 * El instante del mensaje mas reciente ya confirmado.
 *
 * Es lo que se manda como `after` para pedir de una vez todo lo que haya
 * entrado desde entonces. Se ignoran los optimistas a proposito: como no tienen
 * instante, tomarlos por el ultimo dejaria el hueco sin rellenar.
 */
export function instanteMasReciente(lista: readonly MensajeFusionable[]): string | undefined {
  let mayor: string | undefined;
  for (const mensaje of lista) {
    if (mensaje.createdAtIso && (!mayor || mensaje.createdAtIso > mayor)) {
      mayor = mensaje.createdAtIso;
    }
  }
  return mayor;
}

/**
 * Desde donde pedir para COMPLETAR las filas que trajo Realtime.
 *
 * La fila cruda no trae adjuntos, cita ni historia: se piden despues, con
 * `after`, en UNA peticion para toda la rafaga (28/10/2026; antes era una por
 * fila). Por eso el corte tiene que ser ANTERIOR a la mas antigua de las que
 * faltan: es lo mas reciente de lo que ya esta completo y llego antes que
 * ella. Mirar solo «lo mas reciente que no falta» dejaria fuera una fila que
 * llego desordenada, detras de otra ya completa.
 *
 * Devuelve `null` si ninguna de esas filas sigue en la lista —se vacio el
 * chat—: no hay nada que completar. Y `undefined` si no hay nada anterior: el
 * primer mensaje de una conversacion recien abierta, que se completa pidiendo
 * la primera pagina, como hasta ahora.
 */
export function corteParaCompletar(
  lista: readonly MensajeFusionable[],
  pendientes: ReadonlySet<string>,
): string | undefined | null {
  let masAntigua: string | undefined;
  for (const mensaje of lista) {
    if (!pendientes.has(mensaje.id) || !mensaje.createdAtIso) continue;
    if (!masAntigua || mensaje.createdAtIso < masAntigua) masAntigua = mensaje.createdAtIso;
  }
  if (!masAntigua) return null;
  let corte: string | undefined;
  for (const mensaje of lista) {
    if (pendientes.has(mensaje.id) || !mensaje.createdAtIso) continue;
    if (mensaje.createdAtIso < masAntigua && (!corte || mensaje.createdAtIso > corte)) {
      corte = mensaje.createdAtIso;
    }
  }
  return corte;
}

/**
 * El instante del mensaje mas antiguo. Es lo que se manda como `before` para
 * subir por el historial.
 */
export function instanteMasAntiguo(lista: readonly MensajeFusionable[]): string | undefined {
  let menor: string | undefined;
  for (const mensaje of lista) {
    if (mensaje.createdAtIso && (!menor || mensaje.createdAtIso < menor)) {
      menor = mensaje.createdAtIso;
    }
  }
  return menor;
}
