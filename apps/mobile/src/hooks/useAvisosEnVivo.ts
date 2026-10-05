import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useRouter } from 'expo-router';

import { traduceEnElIdiomaActual } from '@/i18n';
import { rutaDelAviso } from '@/lib/avisosAlCreador';
import {
  SILENCIO_TRAS_UN_AVISO_DE_SESION_MS,
  actoresDeSesionNuevos,
  conversacionesPendientes,
  desdeCuandoPreguntar,
  destinoDelAviso,
  elMensajeYaLoDijo,
  hayPendientesQueDecir,
  hayQueLeerLaBandeja,
  queAnunciar,
  queHacerConUnMensaje,
} from '@/lib/avisosNuevos';
import { seEstaViendoLaConversacion } from '@/lib/loQueSeVe';
import { claveDeConversacion } from '@/lib/rutaDelPush';
import { avisar } from '@/lib/toast';
import type { NotificationItem } from '@/mappers/notificationMapper';
import { NotificationRepository } from '@/repositories/NotificationRepository';
import {
  alLeerLasNotificaciones,
  alLlegarLaBandeja,
  refrescarMensajes,
  refrescarNotificaciones,
} from '@/services/contadores';
import { asegurarRegistroDePush } from '@/services/notifications';
import { supabase } from '@/services/supabase';
import { useAuthStore } from '@/store/useAuthStore';
import { useContadoresStore } from '@/store/useContadoresStore';
import type { Conversation } from '@/types';

/**
 * Cada cuánto se pregunta por avisos nuevos con la aplicación abierta.
 *
 * Eran 60 s. Un mensaje llega al momento por tiempo real, pero todo lo demás
 * —que alguien pida una sesión, te siga o reaccione— depende de esta pregunta
 * mientras el push no la adelante: en web no hay push, y en Android no lo
 * habrá hasta que la compilación lleve las credenciales. Un minuto entero
 * entre que te piden una sesión y que te enteras se lee como «no funciona».
 *
 * Es una cuenta, no la bandeja: una consulta con índice. Lo que dejaría esto
 * en instantáneo es publicar `notifications` en tiempo real, y eso es una
 * migración que no se ha hecho.
 *
 * Los avisos de SESIÓN no esperan a esta vuelta: cada uno deja además un
 * mensaje en el chat, que sí llega al momento y se anuncia al momento (ver
 * `anotarMensaje`).
 */
const CADA_MS = 30_000;
/** Varios mensajes seguidos son una sola consulta, pasado este respiro. */
const RESPIRO_DE_MENSAJES_MS = 500;
/** Cuántos mensajes ya anunciados se recuerdan para no repetirlos. */
const MENSAJES_RECORDADOS = 200;

/**
 * Cómo se mira la bandeja.
 *
 * - `anunciar`: lo nuevo sale en pantalla, aviso por aviso. La vuelta periódica.
 * - `callado`: solo ponerse al día. Lo nuevo acaba de anunciarse por otro lado
 *   (el aviso de un push, con la aplicación abierta).
 * - `entrar`: se acaba de abrir la aplicación o de volver a ella. No se repasa
 *   aviso por aviso lo que llegó estando fuera: se dice UNA vez cuánto hay sin
 *   leer, si hay más que la última vez (`hayPendientesQueDecir`).
 */
type Modo = 'anunciar' | 'callado' | 'entrar';

type FilaDeMensaje = {
  id?: string;
  conversation_id?: string;
  sender_id?: string;
  /** El texto, cuando lo hay: una nota de voz o una foto llegan sin él. */
  body?: string | null;
};

/**
 * El puente con el oyente del push (`useAvisosDelPush`), que vive en otro
 * fichero porque solo existe en el teléfono.
 *
 * - `ponerseAlDia`: llegó un push con la aplicación abierta y ya se enseñó. La
 *   lectura periódica no tiene que anunciarlo otra vez.
 * - `mensajeDelPush`: llegó el push DE UN MENSAJE. No se enseña allí: se trae
 *   aquí, al mismo camino que el mensaje en tiempo real, para que los dos
 *   —que son el mismo mensaje— den UN aviso.
 *
 * Son `null` cuando el hook no está escuchando (sin sesión).
 */
let ponerseAlDia: (() => void) | null = null;
let mensajeDelPush:
  | ((
      conversacionId: string,
      mensajeId: string | null,
      remitenteId?: string | null,
      texto?: string | null,
    ) => void)
  | null = null;

let sesionDelPush: (() => void) | null = null;

export function alRecibirUnPush(): void {
  ponerseAlDia?.();
}

/**
 * Entrega a la lectura de la bandeja el push de una SESIÓN (se pidió, se
 * aceptó, se canceló…). Devuelve `false` si nadie escucha: entonces quien
 * llama enseña el aviso por su cuenta.
 */
export function alRecibirUnPushDeSesion(): boolean {
  if (!sesionDelPush) return false;
  sesionDelPush();
  return true;
}

/**
 * Entrega al camino en vivo el push de un mensaje. Devuelve `false` si nadie
 * escucha: entonces quien llama enseña el aviso por su cuenta.
 */
export function alRecibirUnMensajePorPush(
  conversacionId: string,
  mensajeId: string | null,
  texto: string | null = null,
): boolean {
  if (!mensajeDelPush) return false;
  mensajeDelPush(conversacionId, mensajeId, null, texto);
  return true;
}

/**
 * Lo que mantiene vivos los avisos mientras la aplicación está ABIERTA.
 *
 * LO REPORTADO. «Cuando se envía un mensaje a un usuario, o cuando se le
 * agenda sesión, o cuando reaccionan a su contenido… no aparecen las
 * notificaciones. Deben aparecer tanto en la bandeja como también un mensaje
 * flotante». Con la aplicación abierta no había nada escuchando: la campana
 * solo se actualizaba al volver a Explorar y el globo de Mensajes no se movía
 * nunca.
 *
 * QUÉ HACE, sin depender del push —que necesita una compilación con las
 * credenciales de Google y de Apple—:
 *
 *   - MENSAJES, AL MOMENTO. Se suscribe a los mensajes nuevos de las
 *     conversaciones de esta persona (la tabla ya se publicaba en tiempo real
 *     y el servidor solo entrega las filas que puede leer). Al llegar uno de
 *     otra persona se refresca el contador y sale el aviso flotante, salvo que
 *     sea de la conversación que tiene delante.
 *   - LO DEMÁS, CADA MINUTO: se pregunta cuántos avisos hay sin leer y, si han
 *     subido, se piden los últimos y se anuncian los nuevos. No hay un segundo
 *     sistema: es la misma bandeja y el mismo aviso flotante (`avisar`).
 *
 * UN HECHO, UN AVISO.
 *
 *   - Un mensaje llega por dos caminos —tiempo real y push— y los dos acaban
 *     aquí con el identificador del mensaje: el segundo se descarta.
 *   - Lo que llegó mientras la aplicación estaba cerrada o en segundo plano
 *     no se repasa aviso por aviso. AL ENTRAR se dice UNA vez cuánto hay sin
 *     leer —mensajes por un lado, notificaciones por otro—, y solo si hay más
 *     que la última vez que se miró.
 *   - La marca se fija con las fechas del SERVIDOR, nunca con el reloj del
 *     teléfono, que puede ir adelantado o atrasado.
 *
 * TODO SE DESMONTA. Al cerrar sesión o al desmontarse se quitan el canal, el
 * reloj y el oyente de `AppState`; no queda nada preguntando por detrás.
 *
 * Se monta UNA vez, en el layout raíz.
 */
export function useAvisosEnVivo(): void {
  const router = useRouter();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const conSesion = useAuthStore((state) => state.status === 'authenticated');
  // El navegador puede cambiar de identidad entre renders; el efecto no.
  const navegar = useRef(router);
  navegar.current = router;

  useEffect(() => {
    if (!supabaseEnabled || !conSesion) {
      useContadoresStore.getState().vaciar();
      return undefined;
    }

    let vivo = true;
    /** Hasta cuándo se han visto pasar avisos. `null` hasta la primera lectura. */
    let marca: number | null = null;
    /** Quién soy. `null` hasta que se sabe: mientras tanto no se anuncia nada. */
    let yo: string | null = null;

    const abrir = (ruta: string) => navegar.current.push(ruta as never);

    /* ------------------------------------------------ avisos de la bandeja */
    /**
     * De quién llegó un aviso de sesión hace un momento, y hasta cuándo calla
     * al «mensaje nuevo» de esa misma persona. Un hecho, un aviso.
     */
    const conAvisoDeSesion = new Map<string, number>();
    /**
     * Y al revés: de quién se acaba de anunciar un MENSAJE, y hasta cuándo
     * calla a su aviso de sesión. El mensaje llega antes casi siempre —va por
     * tiempo real— y ya se anunció; el aviso de la bandeja diría lo mismo.
     */
    const conMensajeAnunciado = new Map<string, number>();

    /** Lo que había sin leer la última vez que se miró, por cualquier camino. */
    let avisosDichos = 0;
    let mensajesDichos = 0;

    /** Al entrar: UN aviso con lo que hay en la bandeja sin leer. */
    const decirAvisosPendientes = (avisos: readonly NotificationItem[], cuenta: number) => {
      // Si es uno solo, se dice cuál: es más útil que «tienes una notificación».
      const unico = cuenta === 1 ? avisos.find((aviso) => !aviso.read) : undefined;
      if (unico) {
        const destino = destinoDelAviso(unico, rutaDelAviso);
        avisar({
          tipo: 'notificacion',
          titulo: unico.title,
          message: unico.subtitle,
          icon: unico.icon,
          clave: 'pendientes:avisos',
          alTocar: () => abrir(destino ?? '/notifications'),
        });
        return;
      }
      avisar({
        tipo: 'notificacion',
        titulo: traduceEnElIdiomaActual(
          cuenta === 1 ? 'notif.pendingNoticesOne' : 'notif.pendingNoticesMany',
          { cuenta },
        ),
        message: traduceEnElIdiomaActual('notif.pendingNoticesTap'),
        icon: 'bell',
        clave: 'pendientes:avisos',
        alTocar: () => abrir('/notifications'),
      });
    };

    const leerAvisos = async (modo: Modo) => {
      /*
        SI HAY ALGO NUEVO LO DICE EL SERVIDOR, no una resta hecha aquí. Antes
        se comparaba la cuenta de ahora con la del contador común, que también
        escriben otras pantallas: si una lo refrescaba primero, la cuenta ya no
        «subía» y el aviso no se anunciaba nunca. Ver `hayQueLeerLaBandeja`.
      */
      const lectura = await refrescarNotificaciones(desdeCuandoPreguntar(marca));
      if (!vivo || lectura === null) return;
      const primera = marca === null;
      // La primera lectura ES entrar, la pida quien la pida: si la del
      // arranque falló, la siguiente vuelta es la que abre.
      const entrando = modo === 'entrar' || primera;
      const callado = modo !== 'anunciar';
      const decirPendientes = entrando && hayPendientesQueDecir(lectura.cuenta, avisosDichos);
      avisosDichos = lectura.cuenta;
      // La lista solo se pide cuando hace falta: al empezar, para fijar la
      // marca; cuando hay algo posterior a ella; o para ponerse al día sin
      // anunciar. Una vuelta tras otra sin novedad es una consulta de dos
      // números, nada más.
      if (!hayQueLeerLaBandeja({ primera, callado, ...lectura })) return;
      try {
        const avisos = await NotificationRepository.list();
        if (!vivo) return;
        // Se anuncie o no, se anota de quién acaba de llegar un aviso de
        // sesión: su mensaje del chat no tiene que dar un segundo aviso.
        const ahora = Date.now();
        const hasta = ahora + SILENCIO_TRAS_UN_AVISO_DE_SESION_MS;
        for (const actor of actoresDeSesionNuevos(avisos, marca)) {
          // Si su mensaje ya se anunció, el que calla es este aviso (abajo),
          // no el siguiente mensaje que escriba.
          if ((conMensajeAnunciado.get(actor) ?? 0) > ahora) continue;
          conAvisoDeSesion.set(actor, hasta);
        }
        // Callado es lo mismo que la primera vez: solo se fija la marca.
        const resultado = queAnunciar(avisos, callado ? null : marca);
        marca = Math.max(marca ?? 0, resultado.marca);
        if (decirPendientes) decirAvisosPendientes(avisos, lectura.cuenta);
        for (const aviso of resultado.anunciar) {
          // Un hecho, un aviso: su mensaje del chat ya lo anunció. Calla UN
          // aviso, no a la persona: el silencio se gasta aquí.
          if (elMensajeYaLoDijo(aviso, conMensajeAnunciado, ahora)) {
            if (aviso.actorId) conMensajeAnunciado.delete(aviso.actorId);
            continue;
          }
          const destino = destinoDelAviso(aviso, rutaDelAviso);
          avisar({
            tipo: 'notificacion',
            titulo: aviso.title,
            message: aviso.subtitle,
            icon: aviso.icon,
            clave: `aviso:${aviso.id}`,
            alTocar: destino ? () => abrir(destino) : () => abrir('/notifications'),
          });
        }
      } catch {
        /* Se intentará en la siguiente vuelta. */
      }
    };

    /*
      UNA LECTURA A LA VEZ. La vuelta periódica, un push y un mensaje pueden
      pedirla casi juntos; dos lecturas solapadas leerían la misma marca y
      anunciarían lo mismo. La segunda espera a la primera y luego mira.
    */
    let lecturaEnCurso: Promise<void> = Promise.resolve();
    const mirarAvisos = (modo: Modo = 'anunciar'): Promise<void> => {
      lecturaEnCurso = lecturaEnCurso.then(() => leerAvisos(modo)).catch(() => {});
      return lecturaEnCurso;
    };

    /* --------------------------------------------------------- mensajes */
    let respiro: ReturnType<typeof setTimeout> | null = null;
    /** Conversación → lo último que llegó y si ya se anunció. */
    const pendientes = new Map<
      string,
      { remitente: string | null; texto: string | null; anunciado: boolean }
    >();
    /** Los mensajes ya anunciados, por identificador. Con tope. */
    const anunciados = new Set<string>();
    /**
     * Lo último que se supo de cada conversación —su nombre, su foto—. Con esto
     * el aviso de un mensaje no espera a la red: se pinta con lo que ya se sabe.
     */
    const conocidas = new Map<string, Conversation>();
    const recordar = (lista: readonly Conversation[] | null) => {
      if (!lista) return;
      for (const conversacion of lista) conocidas.set(conversacion.id, conversacion);
    };

    /**
     * Lo que se hace con la lista de conversaciones cada vez que se lee: se
     * recuerda, y AL ENTRAR se dice lo que haya sin leer —una vez, y solo si
     * hay más que la última vez que se miró—.
     */
    const alDiaConLaLista = (lista: readonly Conversation[] | null, entrando: boolean) => {
      if (!vivo || !lista) return;
      recordar(lista);
      const { pendientes: sinLeer, total } = conversacionesPendientes(
        lista,
        seEstaViendoLaConversacion,
      );
      const decir = entrando && hayPendientesQueDecir(total, mensajesDichos);
      mensajesDichos = total;
      if (!decir) return;
      const varios = traduceEnElIdiomaActual(
        total === 1 ? 'notif.pendingMessagesOne' : 'notif.pendingMessagesMany',
        { cuenta: total },
      );
      // De una sola persona: se dice de quién, con su foto, y se abre su chat.
      const unica = sinLeer.length === 1 ? sinLeer[0] : undefined;
      if (unica) {
        avisar({
          tipo: 'notificacion',
          titulo: unica.name,
          message: unica.subtitle || varios,
          avatarUrl: unica.avatarUrl ?? null,
          icon: 'message-square',
          clave: claveDeConversacion(unica.id),
          alTocar: () => abrir(`/chat/${unica.id}`),
        });
        return;
      }
      avisar({
        tipo: 'notificacion',
        titulo: varios,
        message: traduceEnElIdiomaActual('notif.pendingMessagesTap'),
        icon: 'message-square',
        clave: 'pendientes:mensajes',
        alTocar: () => abrir('/messages'),
      });
    };

    /**
     * @param fresca la conversación se acaba de leer del servidor: su resumen ES
     *   el mensaje nuevo. Si no, el resumen guardado es del mensaje anterior y
     *   no se usa.
     */
    const anunciarMensaje = (
      id: string,
      conversacion: Conversation,
      texto: string | null,
      remitente: string | null,
      fresca: boolean,
    ) => {
      avisar({
        tipo: 'notificacion',
        titulo: conversacion.name,
        message:
          (texto ?? '').trim() ||
          (fresca ? conversacion.subtitle : '') ||
          traduceEnElIdiomaActual('notif.newMessage'),
        avatarUrl: conversacion.avatarUrl ?? null,
        icon: 'message-square',
        clave: claveDeConversacion(id),
        alTocar: () => abrir(`/chat/${id}`),
      });
      if (remitente) {
        conMensajeAnunciado.set(remitente, Date.now() + SILENCIO_TRAS_UN_AVISO_DE_SESION_MS);
      }
    };

    /** Tras el respiro: contadores, bandeja y lo que no se pudo anunciar antes. */
    const ponerAlDiaLosMensajes = async () => {
      respiro = null;
      const deQuien = Array.from(pendientes);
      pendientes.clear();
      // Los avisos de la bandeja, A LA VEZ y sin que nadie los espere: un
      // mensaje puede ser el registro de una sesión y su aviso ya está allí.
      void mirarAvisos();
      const conversaciones = await refrescarMensajes();
      if (!vivo || !conversaciones) return;
      // Sin decir nada: cada uno de estos mensajes ya dio su aviso al llegar.
      alDiaConLaLista(conversaciones, false);
      for (const [id, pendiente] of deQuien) {
        if (pendiente.anunciado) continue;
        // Mientras se pedía la lista pudo abrir esa conversación.
        if (seEstaViendoLaConversacion(id)) continue;
        const conversacion = conversaciones.find((c) => c.id === id);
        if (!conversacion) continue;
        anunciarMensaje(id, conversacion, pendiente.texto, pendiente.remitente, true);
      }
    };

    /**
     * Un mensaje nuevo, venga del tiempo real o del push. El identificador es
     * lo que hace que los dos caminos den un solo aviso.
     *
     * SE ANUNCIA AQUÍ MISMO si se puede (`queHacerConUnMensaje`): antes
     * esperaba medio segundo, luego a la lista de conversaciones y hasta dos
     * segundos y medio más a la bandeja de avisos.
     */
    const anotarMensaje = (
      conversacionId: string,
      mensajeId: string | null,
      remitenteId: string | null = null,
      texto: string | null = null,
    ) => {
      if (mensajeId) {
        if (anunciados.has(mensajeId)) return;
        anunciados.add(mensajeId);
        if (anunciados.size > MENSAJES_RECORDADOS) {
          // Se cae el más antiguo: un `Set` conserva el orden de inserción.
          const primero = anunciados.values().next().value;
          if (primero !== undefined) anunciados.delete(primero);
        }
      }

      const ahora = Date.now();
      const conocida = conocidas.get(conversacionId);
      const decision = queHacerConUnMensaje({
        aLaVista: seEstaViendoLaConversacion(conversacionId),
        conAvisoDeSesionReciente:
          remitenteId !== null && (conAvisoDeSesion.get(remitenteId) ?? 0) > ahora,
        conversacionConocida: conocida !== undefined,
      });
      // CALLA UN MENSAJE, NO A LA PERSONA: el silencio se gasta aquí, y lo
      // siguiente que escriba —«nos vemos el martes»— sí da su aviso.
      if (decision === 'callar' && remitenteId) conAvisoDeSesion.delete(remitenteId);
      if (decision === 'anunciar-ya' && conocida) {
        anunciarMensaje(conversacionId, conocida, texto, remitenteId, false);
      }

      const previo = pendientes.get(conversacionId);
      pendientes.set(conversacionId, {
        remitente: remitenteId ?? previo?.remitente ?? null,
        texto: texto ?? previo?.texto ?? null,
        anunciado: decision !== 'esperar-a-la-lista' || (previo?.anunciado ?? false),
      });
      // Varios mensajes seguidos son UNA puesta al día de contadores y bandeja.
      if (respiro === null) {
        respiro = setTimeout(() => void ponerAlDiaLosMensajes(), RESPIRO_DE_MENSAJES_MS);
      }
    };

    const alLlegarMensaje = (fila: FilaDeMensaje) => {
      // Sin saber quién soy no se puede distinguir mi propio mensaje —enviado
      // desde este u otro aparato— del de otra persona: no se anuncia.
      if (!fila.conversation_id || yo === null || fila.sender_id === yo) return;
      anotarMensaje(fila.conversation_id, fila.id ?? null, fila.sender_id ?? null, fila.body ?? null);
    };

    /*
      LEER BAJA LA CUENTA DE «LO DICHO», LO LEA QUIEN LO LEA. Abrir la bandeja
      o leer un chat no pasa por este hook: sin esto la cuenta se quedaba en lo
      de antes, y lo siguiente que llegara estando fuera —un mensaje, cuando ya
      se habían leído los tres de antes— no era «más que la última vez» y no se
      decía. Solo BAJA: subirla desde aquí callaría lo que aún no se ha dicho.
    */
    const dejarDeOirLaBandeja = alLlegarLaBandeja((frescas) => {
      const { total } = conversacionesPendientes(frescas, seEstaViendoLaConversacion);
      if (total < mensajesDichos) mensajesDichos = total;
    });
    const dejarDeOirLoLeido = alLeerLasNotificaciones(() => {
      avisosDichos = 0;
    });

    /** Mirar todo como quien acaba de llegar: contadores al día y lo pendiente, dicho. */
    const entrar = () => {
      void mirarAvisos('entrar');
      void refrescarMensajes().then((lista) => alDiaConLaLista(lista, true));
    };

    let yaSuscrito = false;
    const cliente = supabase;
    const canal = cliente
      ?.channel(`avisos-de-mensajes:${Date.now()}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload: { new: FilaDeMensaje }) => alLlegarMensaje(payload.new),
      )
      .subscribe((estado) => {
        if (estado !== 'SUBSCRIBED') return;
        // La primera vez ya se está leyendo todo en el arranque. Las demás son
        // REENGANCHES —se cayó la red, el teléfono durmió—, y lo que entró con
        // el canal caído no llegó por aquí ni va a llegar: hay que preguntarlo.
        if (yaSuscrito) entrar();
        yaSuscrito = true;
      });

    /* --------------------------------------------------------- arranque */
    cliente?.auth
      .getSession()
      .then(({ data }) => {
        if (vivo) yo = data.session?.user?.id ?? null;
      })
      .catch(() => {
        /* Sin saber quién soy no se anuncian mensajes; lo demás sigue. */
      });
    entrar();

    const reloj = setInterval(() => {
      // Con la aplicación en segundo plano no se pregunta: para eso está el push.
      if (AppState.currentState !== 'active') return;
      void mirarAvisos();
      /*
        Y SI ESTE TELÉFONO AÚN NO DEJÓ SU TOKEN, SE INTENTA EN CADA VUELTA. Solo
        se reintentaba al volver del segundo plano: quien concedía el permiso
        y seguía usando la aplicación —o arrancó sin que Firebase hubiera dado
        aún el token, que pasa recién instalada— se quedaba sin avisos con la
        aplicación cerrada hasta salir y volver a entrar. Reportado el
        05/10/2026: «no me llegaban hasta que entraba a la app; luego recién
        comenzó a funcionarme». Una vez registrado no hace nada.
      */
      void asegurarRegistroDePush();
    }, CADA_MS);

    const alVolver = AppState.addEventListener('change', (estado) => {
      if (estado !== 'active') return;
      // Lo que llegó estando fuera no se repasa aviso por aviso: se dice
      // cuánto hay sin leer, si hay más que al salir.
      entrar();
      void asegurarRegistroDePush();
    });

    ponerseAlDia = () => {
      void mirarAvisos('callado');
      void refrescarMensajes().then((lista) => alDiaConLaLista(lista, false));
    };
    // El push de un mensaje lo manda otra persona: no hace falta saber quién soy.
    mensajeDelPush = anotarMensaje;
    // El de una sesión se ANUNCIA por aquí (no callado): la bandeja dice qué
    // ha pasado y cada aviso sale una sola vez, llegue antes el push o el
    // mensaje que la sesión deja en el chat.
    sesionDelPush = () => {
      void mirarAvisos();
      void refrescarMensajes().then((lista) => alDiaConLaLista(lista, false));
    };

    return () => {
      vivo = false;
      ponerseAlDia = null;
      mensajeDelPush = null;
      sesionDelPush = null;
      clearInterval(reloj);
      if (respiro !== null) clearTimeout(respiro);
      alVolver.remove();
      dejarDeOirLaBandeja();
      dejarDeOirLoLeido();
      if (cliente && canal) void cliente.removeChannel(canal);
    };
  }, [supabaseEnabled, conSesion]);
}
