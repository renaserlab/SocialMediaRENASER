import { sinLeerEn } from '@/lib/bandeja';
import { aplicarMensaje, type EfectoDelMensaje, type MensajeEnVivo } from '@/lib/bandejaEnVivo';
import { sinLeerDeLaFila } from '@/lib/temasDeGrupo';
import { formatTime } from '@/mappers/messageMapper';
import { MessageRepository } from '@/repositories/MessageRepository';
import { NotificationRepository } from '@/repositories/NotificationRepository';
import { setBadgeCount } from '@/services/notifications';
import { useContadoresStore } from '@/store/useContadoresStore';
import type { Conversation } from '@/types';

/**
 * Pregunta al servidor lo que hay sin leer y lo deja en el contador común.
 *
 * NINGUNA DE ESTAS FUNCIONES LANZA. Un contador que no se pudo refrescar se
 * queda con el último valor conocido: es un adorno informativo, y un fallo de
 * red aquí no puede convertirse en un error en pantalla.
 */

/** La insignia del icono de la aplicación: la suma de lo que hay sin leer. */
function ponerInsignia(): void {
  const { notificaciones, mensajes } = useContadoresStore.getState();
  void setBadgeCount(notificaciones + mensajes);
}

/**
 * Cuántos avisos hay sin leer y cuántos son posteriores a `desdeIso`.
 *
 * Deja la cuenta en el contador común y devuelve las dos cosas, o `null` si no
 * se pudo. `nuevos` es `null` si el servidor no lo dice (ver el repositorio).
 */
export async function refrescarNotificaciones(
  desdeIso: string | null = null,
): Promise<{ cuenta: number; nuevos: number | null } | null> {
  try {
    const lectura = await NotificationRepository.novedades(desdeIso);
    useContadoresStore.getState().ponerNotificaciones(lectura.cuenta);
    ponerInsignia();
    return lectura;
  } catch {
    return null;
  }
}

/** La bandeja se acaba de abrir y todo quedó leído. */
export function notificacionesLeidas(): void {
  useContadoresStore.getState().ponerNotificaciones(0);
  ponerInsignia();
  for (const oyente of oyentesDeAvisosLeidos) oyente();
}

const oyentesDeAvisosLeidos = new Set<() => void>();

/** Cada vez que se abre la bandeja de notificaciones y queda todo leído. */
export function alLeerLasNotificaciones(oyente: () => void): () => void {
  oyentesDeAvisosLeidos.add(oyente);
  return () => {
    oyentesDeAvisosLeidos.delete(oyente);
  };
}

/**
 * Los mensajes sin leer, sumando la primera página de conversaciones.
 *
 * NO ES UNA CUENTA EXACTA DE TODA LA HISTORIA, y no hace falta que lo sea: las
 * conversaciones llegan ordenadas por actividad, así que lo no leído reciente
 * está siempre en la primera página. Sirve para un globo que dice «tienes
 * mensajes» y cuántos, sin pedir un endpoint nuevo al servidor.
 *
 * Devuelve las conversaciones leídas, para quien quiera usarlas (el aviso
 * flotante necesita el nombre y el resumen), o `null` si no se pudo.
 */
export async function refrescarMensajes(): Promise<Conversation[] | null> {
  try {
    // Cuándo SALE la pregunta: lo que llegue en vivo a partir de aquí puede
    // no venir en la respuesta y se vuelve a poner encima (`adoptarPortada`).
    const pedidaEn = Date.now();
    const leidas = await MessageRepository.listConversations();
    const conversaciones = anotarMensajes(leidas, pedidaEn);
    // Y se le da a quien tenga la bandeja pintada: ya está pedida, no hace
    // falta que la vuelva a pedir para enterarse.
    for (const oyente of oyentesDeLaBandeja) oyente(conversaciones);
    return conversaciones;
  } catch {
    return null;
  }
}

/**
 * La portada de la bandeja recién leída del servidor (la primera página, sin
 * búsqueda ni filtro): queda como la vigente y de ella sale el globo.
 *
 * Para la pantalla de mensajes, que ya tiene la lista: no hace falta otra
 * petición. Devuelve la lista con lo llegado en vivo mientras la pregunta iba
 * y venía ya puesto encima: es la que hay que pintar.
 *
 * @param pedidaEn cuándo salió la pregunta (`Date.now()` antes de pedirla).
 *   Sin él se da por pedida ahora y no se repone nada.
 */
export function anotarMensajes(
  conversaciones: readonly Conversation[],
  pedidaEn: number = Date.now(),
): Conversation[] {
  const alDia = adoptarPortada(conversaciones, pedidaEn);
  contarMensajes(alDia);
  return alDia;
}

/** El globo de Mensajes y la insignia, contados sobre una portada. */
function contarMensajes(conversaciones: readonly Conversation[]): void {
  // Lo mismo que dice el globo de cada fila: en un grupo con temas o
  // comunidades, todo lo de dentro (las comunidades ya no salen sueltas).
  const total = conversaciones.reduce(
    (suma, conversacion) => suma + sinLeerDeLaFila(conversacion),
    0,
  );
  useContadoresStore.getState().ponerMensajes(total);
  ponerInsignia();
}

/*
  LA PORTADA, AL DÍA SIN PREGUNTAR (28/10/2026).

  Antes cada mensaje nuevo hacía que este teléfono volviera a pedir la bandeja
  entera para contar el globo: con N miembros de un grupo conectados, cada
  mensaje eran N lecturas de la consulta más cara de la API (auditoría del
  28/10, §10). Ahora se guarda aquí la última portada que dio el servidor y el
  mensaje que trae el tiempo real se le aplica encima (`lib/bandejaEnVivo.ts`).
  El globo, la fila y el orden salen de ella.

  LO QUE PASA MIENTRAS UNA PREGUNTA VA Y VIENE. El servidor contesta con lo
  que había cuando hizo la consulta; lo que llegó en vivo después de PEDIRLA
  puede no estar. Por eso se apunta todo lo que llega (mensajes y lecturas)
  con su hora, y al adoptar una respuesta se vuelve a aplicar lo posterior a
  la pregunta. Aplicar dos veces no cuenta dos veces: un mensaje solo suma si
  es más nuevo que el último que la fila ya conoce.
*/

/** La última portada conocida: la del servidor, con lo llegado en vivo encima. */
let portada: Conversation[] | null = null;
/** Cuándo se PIDIÓ la portada vigente al servidor. */
let portadaPedidaEn: number | null = null;

type Suceso =
  | { tipo: 'mensaje'; en: number; mensaje: MensajeEnVivo; propio: boolean; abierta: boolean }
  | { tipo: 'leida'; en: number; conversacionId: string };

/**
 * Lo llegado en vivo en el último rato, en orden. Con tope de tiempo y de
 * tamaño: solo hace falta lo que pudo cruzarse con una pregunta en vuelo.
 */
const sucesos: Suceso[] = [];
const SUCESOS_RECORDADOS = 200;
const SUCESOS_DURAN_MS = 120_000;

function apuntar(suceso: Suceso): void {
  sucesos.push(suceso);
  const corte = suceso.en - SUCESOS_DURAN_MS;
  while (sucesos.length > SUCESOS_RECORDADOS || (sucesos[0] && sucesos[0].en < corte)) {
    sucesos.shift();
  }
}

/**
 * Hace vigente una portada recién leída, con lo llegado después de pedirla.
 *
 * UNA RESPUESTA MÁS VIEJA QUE LA VIGENTE NO LA PISA: dos preguntas en vuelo
 * pueden contestar en cualquier orden.
 *
 * UN CASO QUE NO SE PUEDE RESOLVER AQUÍ: una conversación que se leyó y
 * recibió otro mensaje, las dos cosas mientras la pregunta iba y venía. Si la
 * respuesta ya traía ese mensaje, no hay forma de saber si se contó antes o
 * después de leer. Entonces se avisa (`alQuedarDudasEnLaBandeja`) para
 * preguntar otra vez.
 */
function adoptarPortada(leidas: readonly Conversation[], pedidaEn: number): Conversation[] {
  if (portada !== null && portadaPedidaEn !== null && pedidaEn < portadaPedidaEn) return portada;
  let alDia: Conversation[] = [...leidas];
  const leidasEnVuelo = new Set<string>();
  let dudas = false;
  for (const suceso of sucesos) {
    if (suceso.en < pedidaEn) continue;
    if (suceso.tipo === 'leida') {
      alDia = sinLeerEn(alDia, suceso.conversacionId) as Conversation[];
      leidasEnVuelo.add(suceso.conversacionId);
      continue;
    }
    const { lista, efecto } = aplicarMensaje(alDia, suceso.mensaje, {
      propio: suceso.propio,
      abierta: suceso.abierta,
      hora: formatTime,
    });
    alDia = lista as Conversation[];
    if (
      efecto === 'ya-estaba' &&
      !suceso.propio &&
      !suceso.abierta &&
      leidasEnVuelo.has(suceso.mensaje.conversacionId)
    ) {
      dudas = true;
    }
  }
  portada = alDia;
  portadaPedidaEn = pedidaEn;
  if (dudas) for (const oyente of oyentesDeDudas) oyente();
  return alDia;
}

/**
 * Un mensaje que acaba de llegar por tiempo real, aplicado a la portada.
 *
 * Mueve la fila, el globo de la fila y el de la pestaña, y se lo dice a quien
 * tenga la bandeja pintada (`alCambiarLaBandeja`). No pregunta nada: lo que
 * devuelve dice si al teléfono le falta algo que solo sabe el servidor, y
 * quien llama decide cuándo preguntar (`hooks/useAvisosEnVivo.ts`).
 *
 * Sin portada todavía —la primera lectura no ha vuelto— el mensaje se apunta
 * y se pondrá encima cuando vuelva.
 */
export function aplicarMensajeEnVivo(
  mensaje: MensajeEnVivo,
  { propio, abierta }: { propio: boolean; abierta: boolean },
): EfectoDelMensaje {
  apuntar({ tipo: 'mensaje', en: Date.now(), mensaje, propio, abierta });
  if (portada === null) return 'desconocida';
  const { lista, efecto } = aplicarMensaje(portada, mensaje, { propio, abierta, hora: formatTime });
  if (lista !== portada) {
    portada = lista as Conversation[];
    contarMensajes(portada);
    for (const oyente of oyentesDeCambios) oyente(portada);
  }
  return efecto;
}

/** Cuándo se pidió al servidor la portada vigente. `null` si aún no hay. */
export function cuandoSePidioLaPortada(): number | null {
  return portadaPedidaEn;
}

/** Al cerrar sesión: la portada de otra cuenta no se hereda. */
export function olvidarLaBandeja(): void {
  portada = null;
  portadaPedidaEn = null;
  sucesos.length = 0;
}

/*
  LA BANDEJA SE ENTERA SIN PREGUNTAR.

  La pantalla de mensajes guarda su propia lista y no la vuelve a pedir en
  treinta segundos (`lib/bandeja.ts`). Dos cosas que pasan fuera de ella la
  dejaban vieja: leer una conversación y la lectura fresca que este mismo
  fichero hace para el contador. Aquí se le avisan las dos.
*/
type OyenteDeLaBandeja = (frescas: readonly Conversation[]) => void;
type OyenteDeLeida = (conversacionId: string) => void;

const oyentesDeLaBandeja = new Set<OyenteDeLaBandeja>();
const oyentesDeLeida = new Set<OyenteDeLeida>();
const oyentesDeCambios = new Set<OyenteDeLaBandeja>();
const oyentesDeDudas = new Set<() => void>();

/** Cada vez que el contador trae la primera página de la bandeja. */
export function alLlegarLaBandeja(oyente: OyenteDeLaBandeja): () => void {
  oyentesDeLaBandeja.add(oyente);
  return () => {
    oyentesDeLaBandeja.delete(oyente);
  };
}

/**
 * Cada vez que la portada cambia SIN haber preguntado: llegó un mensaje en
 * vivo y se le aplicó.
 *
 * VA APARTE DE `alLlegarLaBandeja` A PROPÓSITO. Lo de allí es una lectura del
 * servidor y la pantalla de Mensajes la cuenta como «recién cargada» para no
 * volver a pedirla al enfocar; esto no lo es. Si contara, una bandeja con
 * mensajes entrando no se contrastaría nunca con el servidor.
 */
export function alCambiarLaBandeja(oyente: OyenteDeLaBandeja): () => void {
  oyentesDeCambios.add(oyente);
  return () => {
    oyentesDeCambios.delete(oyente);
  };
}

/** Cuando al adoptar una lectura queda un globo que solo el servidor puede aclarar. */
export function alQuedarDudasEnLaBandeja(oyente: () => void): () => void {
  oyentesDeDudas.add(oyente);
  return () => {
    oyentesDeDudas.delete(oyente);
  };
}

/** Cada vez que se lee una conversación (se abrió su chat, o llegó algo con él delante). */
export function alLeerUnaConversacion(oyente: OyenteDeLeida): () => void {
  oyentesDeLeida.add(oyente);
  return () => {
    oyentesDeLeida.delete(oyente);
  };
}

/*
  EL CHAT ABIERTO SE ENTERA POR MÁS DE UN CAMINO.

  Con una conversación delante, un mensaje nuevo solo podía aparecer por el
  canal de tiempo real de ESA pantalla; el aviso flotante y el push se callan a
  propósito —«ya lo está leyendo»—. Si ese canal estaba caído, el mensaje no
  aparecía por ningún lado hasta salir del chat y volver a entrar (reportado el
  05/10/2026). Ahora el push de un mensaje se lo dice también al chat, que
  pregunta al servidor lo que le falta.
*/
/**
 * `mensajeId` es el del push, si lo trae: el chat que YA tiene ese mensaje
 * (llegó antes por su canal, que es lo normal) no pregunta nada.
 */
type OyenteDeMensaje = (conversacionId: string, mensajeId: string | null) => void;

const oyentesDeMensaje = new Set<OyenteDeMensaje>();

/** Cada vez que se sabe, por un camino que no es el canal del chat, que entró un mensaje. */
export function alSaberDeUnMensaje(oyente: OyenteDeMensaje): () => void {
  oyentesDeMensaje.add(oyente);
  return () => {
    oyentesDeMensaje.delete(oyente);
  };
}

/** Ha entrado un mensaje en esa conversación: que quien la tenga abierta se ponga al día. */
export function hayMensajeNuevoEn(conversacionId: string, mensajeId: string | null = null): void {
  for (const oyente of oyentesDeMensaje) oyente(conversacionId, mensajeId);
}

/**
 * Marca una conversación como leída: en el servidor y, YA, en la bandeja.
 *
 * No lanza. Si el servidor falla, la bandeja se corrige sola en su siguiente
 * lectura, que es lo que pasaba antes con todo.
 *
 * Devuelve una promesa que dice si el SERVIDOR ya lo anotó. Quien avisa a los
 * demás de que se leyó tiene que esperar a eso: avisar antes haría que
 * preguntaran y recibieran todavía la marca anterior.
 */
export function marcarConversacionLeida(conversacionId: string): Promise<boolean> {
  const anotado = MessageRepository.markRead(conversacionId).then(
    () => true,
    () => false,
  );
  // La portada también, y con ella el globo de la pestaña: los mensajes que
  // lleguen después se suman sobre esto, no sobre lo que había sin leer. Se
  // apunta por si una pregunta en vuelo vuelve con la cuenta de antes.
  apuntar({ tipo: 'leida', en: Date.now(), conversacionId });
  if (portada !== null) {
    const leida = sinLeerEn(portada, conversacionId) as Conversation[];
    if (leida !== portada) {
      portada = leida;
      contarMensajes(portada);
    }
  }
  for (const oyente of oyentesDeLeida) oyente(conversacionId);
  return anotado;
}
