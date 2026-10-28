import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useRouter } from 'expo-router';

import { traduceEnElIdiomaActual } from '@/i18n';
import { rutaDelAviso } from '@/lib/avisosAlCreador';
import {
  anotarConTope,
  esperaDeLaRecargaDeSeguridad,
  hayQueAsegurar,
  leerMensajeEnVivo,
  puedeTraerUnAviso,
  queHacerTrasElMensaje,
} from '@/lib/bandejaEnVivo';
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
  alQuedarDudasEnLaBandeja,
  aplicarMensajeEnVivo,
  cuandoSePidioLaPortada,
  olvidarLaBandeja,
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
/** Cuántas conversaciones «buscadas y que no estaban» se recuerdan. */
const AUSENTES_RECORDADAS = 500;

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
  /** Cuándo se guardó. Es lo que deja colocarlo en la bandeja sin preguntar. */
  created_at?: string;
};

/**
 * El puente con el oyente del push (`useAvisosDelPush`), que vive en otro
 * fichero porque solo existe en el teléfono.
 *
 * - `avisosDelPush`: llegó un push que NO es de un mensaje con la aplicación
 *   abierta y ya se enseñó. La lectura periódica no tiene que anunciarlo otra
 *   vez.
 * - `ponerseAlDia`: lo mismo, y además la bandeja de mensajes. Solo para lo
 *   que cambia una conversación sin mandar un mensaje (silenciarla).
 * - `mensajeDelPush`: llegó el push DE UN MENSAJE. No se enseña allí: se trae
 *   aquí, al mismo camino que el mensaje en tiempo real, para que los dos
 *   —que son el mismo mensaje— den UN aviso.
 *
 * Son `null` cuando el hook no está escuchando (sin sesión).
 */
let avisosDelPush: (() => void) | null = null;
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

/**
 * Llegó un push que no es de un mensaje y ya se enseñó: los avisos se ponen
 * al día sin anunciarlo otra vez.
 *
 * LA BANDEJA DE MENSAJES NO SE VUELVE A PEDIR AQUÍ (28/10/2026). Lo hacía, y
 * con el chat abierto este camino recibía el push de CADA mensaje: dos
 * peticiones por mensaje en cada teléfono que tuviera delante esa
 * conversación. Un push que no es de un mensaje no cambia la bandeja, y el de
 * un mensaje va por `alRecibirUnMensajePorPush`.
 */
export function alRecibirUnPush(): void {
  avisosDelPush?.();
}

/**
 * Se silenció un chat, o se le devolvieron los avisos. La lista de
 * conversaciones conocidas se vuelve a leer YA: sin esto, el primer mensaje
 * tras silenciar todavía daría su aviso, con lo que se sabía de antes.
 */
export function alCambiarElSilencioDeUnChat(): void {
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
 *     y el servidor solo entrega las filas que puede leer). Al llegar uno se
 *     coloca en la bandeja y en el contador SIN PREGUNTAR AL SERVIDOR (ver
 *     «La bandeja no se pide por cada mensaje», más abajo) y, si es de otra
 *     persona, sale el aviso flotante, salvo que sea de la conversación que
 *     tiene delante.
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
    /**
     * Conversaciones que todavía no se conocen → lo último que llegó de ellas.
     * Se anuncian cuando vuelva la lista, que es la que sabe su nombre.
     */
    const pendientes = new Map<string, { remitente: string | null; texto: string | null }>();
    /** Los mensajes ya anunciados, por identificador. Con tope. */
    const anunciados = new Set<string>();

    /*
      LA BANDEJA NO SE PIDE POR CADA MENSAJE (28/10/2026).

      Antes, cada mensaje —de quien fuera, en la conversación que fuera—
      acababa, medio segundo después, en una lectura entera de la bandeja y
      otra del contador de avisos. Con N miembros de un grupo conectados, cada
      mensaje eran 2N peticiones, y con doscientos la API tardaba unos diez
      segundos en atenderlo (auditoría del 28/10, §10).

      Ahora el mensaje se coloca en la bandeja aquí mismo
      (`aplicarMensajeEnVivo`) y al servidor solo se le pregunta:

        - por la BANDEJA, si el mensaje es de una conversación que no está en
          ella (nueva, o de más abajo), si no se pudo colocar, o si el push
          trae un mensaje que el tiempo real no trajo (el canal puede estar
          caído). Y como red de seguridad, como mucho una vez cada veinte
          segundos mientras sigan llegando mensajes
          (`RECARGA_DE_SEGURIDAD_MS`, con su porqué);
        - por los AVISOS, solo si el mensaje es de un chat de dos: es el único
          que puede venir con un aviso de sesión (`puedeTraerUnAviso`).

      Al reengancharse el canal, al volver del segundo plano y al enfocar
      Mensajes con datos de más de treinta segundos se sigue leyendo todo,
      como antes.
    */
    /** Lo que el próximo respiro tiene que pedir, además de anunciar. */
    let leerLaLista = false;
    let mirarLosAvisos = false;
    /** Conversaciones que no estaban en la bandeja → cuándo llegó su mensaje. */
    const porBuscar = new Map<string, number>();
    /**
     * Las que se buscaron en una lectura posterior a su mensaje y no estaban:
     * el chat de un tema, una comunidad (viven dentro de su grupo). No se
     * vuelven a buscar mensaje a mensaje.
     */
    const ausentes = new Set<string>();
    /** Los mensajes que ya trajo el tiempo real: su push no pregunta nada. */
    const vistosEnVivo = new Set<string>();
    /** Cuándo se supo por última vez de un mensaje que la bandeja puede no tener. */
    let ultimoMensajeEn: number | null = null;
    let seguridad: ReturnType<typeof setTimeout> | null = null;
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
      apartarLasQueNoEstan(lista);
      // Lo silenciado no se anuncia al entrar: sigue contando en la bandeja.
      const { pendientes: sinLeer, total } = conversacionesPendientes(
        lista.filter((conversacion) => !conversacion.silenciada),
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
      // UN CHAT SILENCIADO NO AVISA, tampoco con la aplicación abierta. El
      // mensaje llega y cuenta como no leído, pero no interrumpe: es lo que
      // ya hace el servidor con el push.
      if (conversacion.silenciada) return;
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

    /**
     * Lo que se hace con cada lectura de la bandeja, además de recordarla:
     * las conversaciones que se estaban buscando y no vinieron se apartan.
     *
     * SOLO SI LA LECTURA SALIÓ DESPUÉS DE SU MENSAJE: una que salió antes no
     * lo podía traer, y apartar por eso una conversación nueva callaría sus
     * avisos.
     */
    const apartarLasQueNoEstan = (lista: readonly Conversation[]) => {
      const pedidaEn = cuandoSePidioLaPortada();
      const estan = new Set(lista.map((conversacion) => conversacion.id));
      for (const id of estan) ausentes.delete(id);
      if (pedidaEn === null) return;
      for (const [id, llegadoEn] of porBuscar) {
        if (llegadoEn > pedidaEn) continue;
        porBuscar.delete(id);
        if (!estan.has(id)) anotarConTope(ausentes, id, AUSENTES_RECORDADAS);
      }
    };

    /** Abre el respiro, si no lo estaba: lo que llegue junto se pide junto. */
    const abrirElRespiro = () => {
      if (respiro === null && (leerLaLista || mirarLosAvisos)) {
        respiro = setTimeout(() => void ponerAlDiaLosMensajes(), RESPIRO_DE_MENSAJES_MS);
      }
    };

    /** Que el próximo respiro lea la bandeja. */
    const pedirLaLista = (conversacionId?: string) => {
      ultimoMensajeEn = Date.now();
      if (conversacionId && !porBuscar.has(conversacionId)) {
        porBuscar.set(conversacionId, ultimoMensajeEn);
      }
      leerLaLista = true;
      abrirElRespiro();
    };

    /**
     * La red de seguridad: UNA lectura de la bandeja entre veinte y treinta
     * segundos después del primer mensaje de la tanda, por mucho que sigan
     * llegando. Y ninguna si mientras tanto ya se leyó por otro motivo.
     */
    const programarLaRecargaDeSeguridad = () => {
      if (seguridad !== null) return;
      seguridad = setTimeout(() => {
        seguridad = null;
        // En segundo plano no se pregunta: al volver, `entrar` lo lee todo.
        if (AppState.currentState !== 'active') return;
        if (!hayQueAsegurar(ultimoMensajeEn, cuandoSePidioLaPortada())) return;
        void refrescarMensajes().then((lista) => alDiaConLaLista(lista, false));
      }, esperaDeLaRecargaDeSeguridad(Math.random()));
    };

    /** Tras el respiro: lo que este lote de mensajes necesita del servidor, y nada más. */
    const ponerAlDiaLosMensajes = async () => {
      respiro = null;
      const deQuien = Array.from(pendientes);
      pendientes.clear();
      const conAvisos = mirarLosAvisos;
      const conLista = leerLaLista;
      mirarLosAvisos = false;
      leerLaLista = false;
      // Los avisos de la bandeja, A LA VEZ y sin que nadie los espere: un
      // mensaje de un chat de dos puede ser el registro de una sesión y su
      // aviso ya está allí. De un grupo, nunca (`puedeTraerUnAviso`).
      if (conAvisos) void mirarAvisos();
      if (!conLista) return;
      const conversaciones = await refrescarMensajes();
      if (!vivo) return;
      if (!conversaciones) {
        // Sin red: lo intentará la recarga de seguridad.
        programarLaRecargaDeSeguridad();
        return;
      }
      // Sin decir nada: cada uno de estos mensajes ya dio su aviso al llegar.
      alDiaConLaLista(conversaciones, false);
      for (const [id, pendiente] of deQuien) {
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
      // UN PUSH QUE EL TIEMPO REAL NO TRAJO —su canal puede estar caído—: la
      // bandeja no tiene ese mensaje, y solo el servidor puede dárselo.
      if (!mensajeId || !vistosEnVivo.has(mensajeId)) pedirLaLista(conversacionId);

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

      // Una conversación que no se conoce se anuncia cuando vuelva la lista,
      // con su nombre. Salvo si ya se buscó y no estaba (el chat de un tema,
      // una comunidad): la lista no la va a traer.
      const ausente = ausentes.has(conversacionId);
      if (decision === 'esperar-a-la-lista' && !ausente) {
        const previo = pendientes.get(conversacionId);
        pendientes.set(conversacionId, {
          remitente: remitenteId ?? previo?.remitente ?? null,
          texto: texto ?? previo?.texto ?? null,
        });
        pedirLaLista(conversacionId);
      }
      // Los avisos de la campana, solo si pudo ser el registro de una sesión.
      if (puedeTraerUnAviso(conocida, ausente)) mirarLosAvisos = true;
      // Varios mensajes seguidos son UNA puesta al día, y solo de lo que haga falta.
      abrirElRespiro();
    };

    /**
     * Un mensaje del tiempo real, colocado en la bandeja. EL PROPIO TAMBIÉN
     * —escrito aquí o en otro aparato—: sube la fila y cambia su resumen,
     * aunque no sume a lo no leído.
     */
    const ponerEnLaBandeja = (fila: FilaDeMensaje) => {
      const mensaje = leerMensajeEnVivo(fila);
      if (!mensaje) return;
      if (mensaje.id) anotarConTope(vistosEnVivo, mensaje.id, MENSAJES_RECORDADOS);
      // Sin saber quién soy no se sabe si suma: que lo cuente el servidor.
      if (yo === null) {
        pedirLaLista(mensaje.conversacionId);
        return;
      }
      ultimoMensajeEn = Date.now();
      const efecto = aplicarMensajeEnVivo(mensaje, {
        propio: mensaje.remitenteId === yo,
        abierta: seEstaViendoLaConversacion(mensaje.conversacionId),
      });
      if (queHacerTrasElMensaje(efecto, ausentes.has(mensaje.conversacionId)) === 'preguntar-ya') {
        pedirLaLista(mensaje.conversacionId);
      }
      programarLaRecargaDeSeguridad();
    };

    const alLlegarMensaje = (fila: FilaDeMensaje) => {
      // La bandeja primero, con todo mensaje: así su push, si llega después,
      // sabe que no tiene que preguntar nada.
      ponerEnLaBandeja(fila);
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
    // Una lectura que volvió sin poder aclarar un globo: se pregunta otra vez.
    const dejarDeOirLasDudas = alQuedarDudasEnLaBandeja(() => pedirLaLista());

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

    avisosDelPush = () => {
      void mirarAvisos('callado');
    };
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
      avisosDelPush = null;
      ponerseAlDia = null;
      mensajeDelPush = null;
      sesionDelPush = null;
      clearInterval(reloj);
      if (respiro !== null) clearTimeout(respiro);
      if (seguridad !== null) clearTimeout(seguridad);
      alVolver.remove();
      dejarDeOirLaBandeja();
      dejarDeOirLoLeido();
      dejarDeOirLasDudas();
      if (cliente && canal) void cliente.removeChannel(canal);
      // La portada de esta cuenta no se queda para la siguiente.
      olvidarLaBandeja();
    };
  }, [supabaseEnabled, conSesion]);
}
