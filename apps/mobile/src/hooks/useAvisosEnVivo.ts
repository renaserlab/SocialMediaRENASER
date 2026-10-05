import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useRouter } from 'expo-router';

import { traduceEnElIdiomaActual } from '@/i18n';
import { rutaDelAviso } from '@/lib/avisosAlCreador';
import {
  SILENCIO_TRAS_UN_AVISO_DE_SESION_MS,
  actoresDeSesionNuevos,
  desdeCuandoPreguntar,
  destinoDelAviso,
  hayQueLeerLaBandeja,
  queAnunciar,
} from '@/lib/avisosNuevos';
import { seEstaViendoLaConversacion } from '@/lib/loQueSeVe';
import { claveDeConversacion } from '@/lib/rutaDelPush';
import { avisar } from '@/lib/toast';
import { NotificationRepository } from '@/repositories/NotificationRepository';
import { refrescarMensajes, refrescarNotificaciones } from '@/services/contadores';
import { asegurarRegistroDePush } from '@/services/notifications';
import { supabase } from '@/services/supabase';
import { useAuthStore } from '@/store/useAuthStore';
import { useContadoresStore } from '@/store/useContadoresStore';

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
 * mensaje en el chat, que sí llega al momento, y ese mensaje adelanta la
 * pregunta (ver `mirarMensajes`).
 */
const CADA_MS = 30_000;
/** Varios mensajes seguidos son una sola consulta, pasado este respiro. */
const RESPIRO_DE_MENSAJES_MS = 500;
/** Cuántos mensajes ya anunciados se recuerdan para no repetirlos. */
const MENSAJES_RECORDADOS = 200;
/**
 * Cuánto espera el aviso de un mensaje a la lectura de la bandeja. Con el
 * servidor lento, un mensaje no puede quedarse sin anunciar por esperar a
 * saber si además había un aviso de sesión.
 */
const ESPERA_POR_LOS_AVISOS_MS = 2_500;

type FilaDeMensaje = { id?: string; conversation_id?: string; sender_id?: string };

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
  | ((conversacionId: string, mensajeId: string | null, remitenteId?: string | null) => void)
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
export function alRecibirUnMensajePorPush(conversacionId: string, mensajeId: string | null): boolean {
  if (!mensajeDelPush) return false;
  mensajeDelPush(conversacionId, mensajeId);
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
 *   - Lo que llegó mientras la aplicación estaba en segundo plano ya lo avisó
 *     el sistema. Al volver se ponen al día los contadores y la marca SIN
 *     anunciar nada.
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

    const leerAvisos = async (callado: boolean) => {
      /*
        SI HAY ALGO NUEVO LO DICE EL SERVIDOR, no una resta hecha aquí. Antes
        se comparaba la cuenta de ahora con la del contador común, que también
        escriben otras pantallas: si una lo refrescaba primero, la cuenta ya no
        «subía» y el aviso no se anunciaba nunca. Ver `hayQueLeerLaBandeja`.
      */
      const lectura = await refrescarNotificaciones(desdeCuandoPreguntar(marca));
      if (!vivo || lectura === null) return;
      const primera = marca === null;
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
        const hasta = Date.now() + SILENCIO_TRAS_UN_AVISO_DE_SESION_MS;
        for (const actor of actoresDeSesionNuevos(avisos, marca)) {
          conAvisoDeSesion.set(actor, hasta);
        }
        // Callado es lo mismo que la primera vez: solo se fija la marca.
        const resultado = queAnunciar(avisos, callado ? null : marca);
        marca = Math.max(marca ?? 0, resultado.marca);
        for (const aviso of resultado.anunciar) {
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
    /**
     * @param callado pone al día los contadores y la marca SIN anunciar. Es lo
     *   que toca cuando lo nuevo ya se avisó por otro lado: el sistema lo hizo
     *   mientras la aplicación estaba en segundo plano, o acaba de salir el
     *   aviso de un push.
     */
    const mirarAvisos = (callado = false): Promise<void> => {
      lecturaEnCurso = lecturaEnCurso.then(() => leerAvisos(callado)).catch(() => {});
      return lecturaEnCurso;
    };

    /* --------------------------------------------------------- mensajes */
    let respiro: ReturnType<typeof setTimeout> | null = null;
    /** Conversación → quién escribió lo último que llegó (si se sabe). */
    const pendientes = new Map<string, string | null>();
    /** Los mensajes ya anunciados, por identificador. Con tope. */
    const anunciados = new Set<string>();

    const mirarMensajes = async () => {
      respiro = null;
      const deQuien = Array.from(pendientes);
      pendientes.clear();
      /*
        PRIMERO LOS AVISOS. Un mensaje puede ser el registro de una sesión —se
        pidió, se aceptó, se canceló—, y su aviso está en la bandeja desde la
        misma transacción. Preguntar ahora hace dos cosas: el aviso de la
        sesión sale AL MOMENTO, sin esperar a la vuelta periódica, y se sabe a
        qué mensajes no hay que darles un segundo aviso.
      */
      const [, conversaciones] = await Promise.all([
        // A LA VEZ que los mensajes, y con tope: si la bandeja tarda, el
        // mensaje se anuncia igual.
        Promise.race([
          mirarAvisos(),
          new Promise<void>((listo) => setTimeout(listo, ESPERA_POR_LOS_AVISOS_MS)),
        ]),
        refrescarMensajes(),
      ]);
      if (!vivo || !conversaciones) return;
      const ahora = Date.now();
      for (const [id, remitente] of deQuien) {
        // El mensaje ya está a la vista: lo pinta la conversación.
        if (seEstaViendoLaConversacion(id)) continue;
        // Ya se anunció como lo que es: un aviso de sesión de esta persona.
        // CALLA UN MENSAJE, NO A LA PERSONA: el silencio se gasta aquí, y lo
        // siguiente que escriba —«nos vemos el martes»— sí da su aviso.
        if (remitente && (conAvisoDeSesion.get(remitente) ?? 0) > ahora) {
          conAvisoDeSesion.delete(remitente);
          continue;
        }
        const conversacion = conversaciones.find((c) => c.id === id);
        if (!conversacion) continue;
        avisar({
          tipo: 'notificacion',
          titulo: conversacion.name,
          message: conversacion.subtitle || traduceEnElIdiomaActual('notif.newMessage'),
          avatarUrl: conversacion.avatarUrl ?? null,
          icon: 'message-square',
          clave: claveDeConversacion(id),
          alTocar: () => abrir(`/chat/${id}`),
        });
      }
    };

    /**
     * Un mensaje nuevo, venga del tiempo real o del push. El identificador es
     * lo que hace que los dos caminos den un solo aviso.
     */
    const anotarMensaje = (
      conversacionId: string,
      mensajeId: string | null,
      remitenteId: string | null = null,
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
      pendientes.set(conversacionId, remitenteId ?? pendientes.get(conversacionId) ?? null);
      if (respiro === null) respiro = setTimeout(() => void mirarMensajes(), RESPIRO_DE_MENSAJES_MS);
    };

    const alLlegarMensaje = (fila: FilaDeMensaje) => {
      // Sin saber quién soy no se puede distinguir mi propio mensaje —enviado
      // desde este u otro aparato— del de otra persona: no se anuncia.
      if (!fila.conversation_id || yo === null || fila.sender_id === yo) return;
      anotarMensaje(fila.conversation_id, fila.id ?? null, fila.sender_id ?? null);
    };

    const cliente = supabase;
    const canal = cliente
      ?.channel(`avisos-de-mensajes:${Date.now()}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload: { new: FilaDeMensaje }) => alLlegarMensaje(payload.new),
      )
      .subscribe();

    /* --------------------------------------------------------- arranque */
    cliente?.auth
      .getSession()
      .then(({ data }) => {
        if (vivo) yo = data.session?.user?.id ?? null;
      })
      .catch(() => {
        /* Sin saber quién soy no se anuncian mensajes; lo demás sigue. */
      });
    void mirarAvisos();
    void refrescarMensajes();

    const reloj = setInterval(() => {
      // Con la aplicación en segundo plano no se pregunta: para eso está el push.
      if (AppState.currentState === 'active') void mirarAvisos();
    }, CADA_MS);

    const alVolver = AppState.addEventListener('change', (estado) => {
      if (estado !== 'active') return;
      // Lo que llegó estando fuera ya lo avisó el sistema: al día, sin anunciar.
      void mirarAvisos(true);
      void refrescarMensajes();
      // Y si este teléfono aún no dejó su token (sin red al entrar, permiso
      // concedido después), se intenta ahora.
      void asegurarRegistroDePush();
    });

    ponerseAlDia = () => {
      void mirarAvisos(true);
      void refrescarMensajes();
    };
    // El push de un mensaje lo manda otra persona: no hace falta saber quién soy.
    mensajeDelPush = anotarMensaje;
    // El de una sesión se ANUNCIA por aquí (no callado): la bandeja dice qué
    // ha pasado y cada aviso sale una sola vez, llegue antes el push o el
    // mensaje que la sesión deja en el chat.
    sesionDelPush = () => {
      void mirarAvisos();
      void refrescarMensajes();
    };

    return () => {
      vivo = false;
      ponerseAlDia = null;
      mensajeDelPush = null;
      sesionDelPush = null;
      clearInterval(reloj);
      if (respiro !== null) clearTimeout(respiro);
      alVolver.remove();
      if (cliente && canal) void cliente.removeChannel(canal);
    };
  }, [supabaseEnabled, conSesion]);
}
