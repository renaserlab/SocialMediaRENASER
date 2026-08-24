import { AppState } from 'react-native';

import {
  RecommendationRepository,
  type BehaviorEvent,
  type Superficie,
} from '@/repositories/RecommendationRepository';
import { haySesion } from '@/services/api';

/**
 * Las senales de uso, enviadas por lotes.
 *
 * MEDIR NO PUEDE ESTROPEAR LO QUE SE MIDE. Una peticion por impresion
 * convertiria bajar el feed en una tormenta de red: con seis videos por
 * pantalla y un deslizamiento por segundo, serian decenas de peticiones por
 * minuto compitiendo con el propio contenido por la conexion. Y el contenido
 * es lo que la persona vino a ver.
 *
 * Por eso aqui se acumula y se manda de golpe:
 *
 *   - cuando hay LOTE_MAXIMO senales;
 *   - cuando pasan ESPERA_MS sin novedades;
 *   - cuando la aplicacion pasa a segundo plano, para no perder lo acumulado.
 *
 * Lo que NUNCA se guarda: texto escrito, mensajes, terminos de busqueda ni
 * nada que pueda decir algo intimo de nadie. Solo QUE se toco, de que tipo era
 * y cuanto se quedo. Con eso basta para ordenar; con mas, esto seria otra cosa.
 */

/** Un lote no puede crecer sin fin: el backend acepta 50 como maximo. */
const LOTE_MAXIMO = 25;

/**
 * Cuanto se espera antes de mandar lo acumulado.
 *
 * Ocho segundos son suficientes para juntar un puñado de videos y lo bastante
 * poco para que cerrar la aplicacion no pierda casi nada.
 */
const ESPERA_MS = 8000;

let cola: BehaviorEvent[] = [];
let temporizador: ReturnType<typeof setTimeout> | null = null;
let suscrito = false;

/** Claves ya encoladas o enviadas en esta sesion. Evita duplicar sin red. */
const yaVistas = new Set<string>();

/**
 * Tope de la memoria de claves. Sin el, una sesion larga acumularia una clave
 * por cada video visto para siempre.
 */
const MAX_CLAVES_RECORDADAS = 1000;

function programarEnvio(): void {
  if (temporizador) return;
  temporizador = setTimeout(() => {
    temporizador = null;
    void vaciar();
  }, ESPERA_MS);
}

/**
 * Manda ya lo acumulado. No lanza nunca.
 *
 * SIN SESION NO SE MANDA NADA, y ademas se TIRA. Una senal se guarda contra
 * una persona (`behavior_events.user_id`), asi que sin sesion no hay a quien
 * atribuirla: la peticion salia sin cabecera y el servidor respondia 401.
 *
 * Y se tira en vez de guardarse para despues a proposito. Retenerla y enviarla
 * al iniciar sesion significaria atribuir a esa cuenta todo lo que la persona
 * miro ANTES de identificarse, que es una decision de privacidad que nadie ha
 * tomado. La aplicacion se puede recorrer entera sin cuenta; recorrerla no
 * deberia dejar un rastro que aparezca luego bajo un nombre.
 */
export async function vaciar(): Promise<void> {
  if (temporizador) {
    clearTimeout(temporizador);
    temporizador = null;
  }
  if (cola.length === 0) return;

  if (!(await haySesion())) {
    descartar();
    return;
  }

  const lote = cola;
  cola = [];
  await RecommendationRepository.sendEvents(lote);
}

function asegurarSuscripcion(): void {
  if (suscrito) return;
  suscrito = true;
  // Al irse a segundo plano se manda lo pendiente: si no, cerrar la aplicacion
  // tiraria los ultimos ocho segundos de uso, que son justo los mas recientes.
  AppState.addEventListener('change', (estado) => {
    if (estado !== 'active') void vaciar();
  });
}

/**
 * Encola una senal. Devuelve enseguida: nada de lo que hace esta funcion puede
 * hacer esperar a quien la llama.
 *
 * `eventKey` es la idempotencia. Con ella, la misma senal no se cuenta dos
 * veces aunque el lote se reintente o la pantalla se vuelva a montar.
 */
export function registrar(evento: BehaviorEvent): void {
  asegurarSuscripcion();

  if (evento.eventKey) {
    if (yaVistas.has(evento.eventKey)) return;
    if (yaVistas.size >= MAX_CLAVES_RECORDADAS) yaVistas.clear();
    yaVistas.add(evento.eventKey);
  }

  cola.push(evento);
  if (cola.length >= LOTE_MAXIMO) {
    void vaciar();
    return;
  }
  programarEnvio();
}

/** Al cerrar sesion: lo acumulado era de la cuenta anterior. */
export function descartar(): void {
  if (temporizador) {
    clearTimeout(temporizador);
    temporizador = null;
  }
  cola = [];
  yaVistas.clear();
}

/* -------------------------------------------------------------- Atajos ---- */

/**
 * De donde venia lo que se toco.
 *
 * POR QUE HACE FALTA. Una impresion sin origen solo dice «esto se vio»; con
 * origen dice «esto se vio PORQUE lo pusimos aqui, en este puesto y con esta
 * version del algoritmo», que es la unica forma de saber despues si aquella
 * recomendacion produjo algo o si la persona habria llegado igual.
 *
 * Es OPCIONAL entero y a proposito: lo que ocurre fuera de una recomendacion
 * —un video abierto desde un enlace, un perfil abierto desde un comentario— no
 * tiene superficie, y eso es un dato en si mismo, no un hueco que rellenar con
 * un valor por defecto.
 */
export type ContextoDeRecomendacion = {
  surface?: Superficie;
  algorithmVersion?: string;
  /** Puesto en la lista donde se mostro. Lo primero se toca mas, sea bueno o no. */
  rank?: number;
};

/** El video que se esta viendo ahora. Una vez por video y sesion. */
export function videoVisible(postId: string, contexto?: ContextoDeRecomendacion): void {
  registrar({
    eventType: 'content_impression',
    entityType: 'post',
    entityId: postId,
    eventKey: `imp:${postId}`,
    ...contexto,
  });
}

/**
 * Cuanto se vio de un video, al salir de el.
 *
 * `proporcion` es 0..1. Por debajo de un tercio no se manda nada: pasar de
 * largo ya quedo contado como impresion, y guardar ademas «lo vio un 4 %»
 * seria ruido con forma de dato.
 */
export function videoVisto(
  postId: string,
  proporcion: number,
  msVisible: number,
  contexto?: ContextoDeRecomendacion,
): void {
  if (!Number.isFinite(proporcion) || proporcion < 0.33) return;
  const completo = proporcion >= 0.9;
  registrar({
    eventType: completo ? 'content_completed' : 'content_engaged',
    entityType: 'post',
    entityId: postId,
    value: Math.min(1, proporcion),
    dwellMs: Math.min(600_000, Math.max(0, Math.round(msVisible))),
    eventKey: `${completo ? 'fin' : 'vis'}:${postId}`,
    ...contexto,
  });
}

/**
 * La tarjeta de una persona recomendada esta a la vista.
 *
 * Se cuenta cuando SE VE, no cuando llega la respuesta: media lista sigue fuera
 * de la pantalla al recibirla, y contar aquellas tarjetas como mostradas hunde
 * la tasa de acierto de las que si se vieron.
 */
export function personaVisible(profileId: string, contexto?: ContextoDeRecomendacion): void {
  registrar({
    eventType: 'content_impression',
    entityType: 'profile',
    entityId: profileId,
    // Clave propia: un perfil y una publicacion pueden compartir identificador
    // y sin este prefijo una impresion taparia la otra.
    eventKey: `imp:perfil:${profileId}`,
    ...contexto,
  });
}

/** Abrio un perfil. */
export function perfilVisto(profileId: string, contexto?: ContextoDeRecomendacion): void {
  registrar({
    eventType: 'profile_view',
    entityType: 'profile',
    entityId: profileId,
    eventKey: `perfil:${profileId}`,
    ...contexto,
  });
}

/**
 * Eligio un resultado de busqueda. Se guarda QUE abrio, NUNCA que escribio:
 * el termino de busqueda puede contener cualquier cosa.
 */
export function resultadoAbierto(entityType: 'profile' | 'post', entityId: string): void {
  registrar({
    eventType: 'search_result_opened',
    entityType,
    entityId,
  });
}

/**
 * «No me interesa» sobre una publicacion.
 *
 * ESTA NO ESPERA AL LOTE. Todo lo demas aqui es medicion —da igual que llegue
 * ocho segundos tarde—, pero esto es una PETICION de la persona: ha dicho que
 * no quiere volver a ver algo. Si se quedara en la cola, refrescar el feed en
 * ese hueco devolveria el mismo video que se acaba de rechazar, y lo que se
 * rompe entonces no es una metrica, es la confianza en que el boton hace algo.
 *
 * Es explicita y poco frecuente, asi que su peticion suelta no tiene nada que
 * ver con el motivo por el que las impresiones van por lotes.
 *
 * Rechazar un video NO es rechazar a quien lo publico: aqui se manda el POST y
 * nada mas. Ni deja de seguirse a nadie, ni se bloquea, ni se esconde el resto
 * de su contenido.
 */
export function contenidoNoInteresa(postId: string, contexto?: ContextoDeRecomendacion): void {
  registrar({
    eventType: 'not_interested',
    entityType: 'post',
    entityId: postId,
    eventKey: `no:${postId}`,
    ...contexto,
  });
  // Sale ya, sin esperar los ESPERA_MS del lote. No se devuelve la promesa: la
  // interfaz ya ha quitado el video y no tiene nada que esperar.
  void vaciar();
}
