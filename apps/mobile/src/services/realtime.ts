import { supabase } from '@/services/supabase';
import { juntarPistas, leerPistaDeTemas, type PistaDeTemas } from '@/lib/temasDeGrupo';
import type { MessageRow } from '@/mappers/messageMapper';

// Contador para nombres de canal únicos: evita reusar un canal ya suscrito
// (Supabase lanza "cannot add postgres_changes callbacks after subscribe()"
// si se hace .on() sobre un canal existente, p. ej. al re-montar el efecto).
let channelSeq = 0;

/**
 * Suscribe a los mensajes nuevos de una conversación vía Supabase Realtime.
 * Devuelve una función para cancelar la suscripción.
 *
 * `alCambiar` DICE SI EL CANAL ESTÁ ENGANCHADO, y no es un detalle. El canal
 * no avisa de lo que se pierde: mientras se engancha, y cada vez que se cae
 * —la red cambia, el teléfono duerme— y vuelve, lo que entró en medio NO llega
 * por aquí ni llegará después. Quien pinta un chat necesita saberlo para
 * preguntar al servidor lo que falta (`true`, cada vez que se engancha o se
 * reengancha) y para no fiarse del canal mientras está caído (`false`).
 */
export function subscribeToConversation(
  conversationId: string,
  onInsert: (row: MessageRow) => void,
  alCambiar?: (enganchado: boolean) => void,
): () => void {
  const client = supabase;
  if (!client) return () => {};

  channelSeq += 1;
  const channel = client
    .channel(`messages:${conversationId}:${channelSeq}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${conversationId}`,
      },
      (payload: { new: MessageRow }) => onInsert(payload.new),
    )
    .subscribe((estado) => alCambiar?.(estado === 'SUBSCRIBED'));

  return () => {
    void client.removeChannel(channel);
  };
}

/**
 * Avisa de CUALQUIER cambio en los mensajes de una conversación: uno nuevo, y
 * también uno que se borra (borrar es marcar la fila, o sea un cambio).
 *
 * NO ENTREGA LA FILA, a propósito. Quien escucha —la pantalla de contenido por
 * vistas— no puede decidir con la fila si el mensaje pertenece a lo que está
 * mirando: eso lo sabe el servidor. Aquí solo se dice «algo cambió, vuelve a
 * preguntar».
 *
 * El chat sigue con `subscribeToConversation`, que sí entrega la fila para
 * pintar la burbuja al instante.
 */
export function subscribeToConversationChanges(
  conversationId: string,
  alCambiar: () => void,
): () => void {
  const client = supabase;
  if (!client) return () => {};

  channelSeq += 1;
  const channel = client
    .channel(`messages-changes:${conversationId}:${channelSeq}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${conversationId}`,
      },
      () => alCambiar(),
    )
    .subscribe();

  return () => {
    void client.removeChannel(channel);
  };
}

/**
 * «Alguien ha reaccionado en esta conversación: vuelve a preguntar».
 *
 * Una reacción no es un mensaje nuevo: cambia uno que ya está en pantalla, y
 * el canal de mensajes no se entera. Quien reacciona manda este aviso por
 * difusión y los demás preguntan a la API por las reacciones de lo que ven.
 *
 * EL AVISO NO LLEVA NADA: ni quién, ni a qué mensaje, ni con qué. Un canal de
 * difusión lo puede escuchar —y escribir— cualquiera con la aplicación, así
 * que no puede transportar nada que importe. Lo peor que consigue quien mande
 * avisos falsos es que los demás pregunten una vez de más, y lo que les
 * contesta la API es lo que de verdad pueden ver.
 */
export function avisosDeReacciones(
  conversationId: string,
  alAvisar: () => void,
): { avisar: () => void; cerrar: () => void } {
  const client = supabase;
  if (!client || !conversationId) return { avisar: () => {}, cerrar: () => {} };

  // SIN contador en el nombre: todos los teléfonos de la conversación tienen
  // que estar en el MISMO canal para oírse. `self: false` evita oírse a uno
  // mismo, que ya pintó su propia reacción.
  const channel = client
    .channel(`chat-reacciones:${conversationId}`, { config: { broadcast: { self: false } } })
    .on('broadcast', { event: 'reaccion' }, () => alAvisar())
    .subscribe();

  return {
    avisar: () => {
      void channel.send({ type: 'broadcast', event: 'reaccion', payload: {} });
    },
    cerrar: () => {
      void client.removeChannel(channel);
    },
  };
}

/**
 * «Alguien ha leído en esta conversación: vuelve a preguntar».
 *
 * Igual que con las reacciones, y por lo mismo: que una persona abra el chat
 * no crea ningún mensaje, así que el canal de mensajes no se entera. Quien lee
 * manda este aviso DESPUÉS de que el servidor anote su lectura, y los demás le
 * preguntan a la API hasta dónde ha leído cada quien.
 *
 * EL AVISO NO LLEVA NADA, ni quién leyó. Lo peor que consigue quien mande
 * avisos falsos es una pregunta de más; lo que contesta la API es lo cierto.
 */
export function avisosDeLectura(
  conversationId: string,
  alAvisar: () => void,
): { avisar: () => void; cerrar: () => void } {
  const client = supabase;
  if (!client || !conversationId) return { avisar: () => {}, cerrar: () => {} };

  // SE AVISA AL ABRIR EL CHAT, que es justo cuando el canal todavía se está
  // uniendo. Un aviso mandado antes de estar dentro no le llega a nadie, así
  // que el que llegue pronto espera a que el canal esté listo.
  let unido = false;
  let debeAvisar = false;
  const mandar = () => {
    void channel.send({ type: 'broadcast', event: 'leido', payload: {} });
  };
  const channel = client
    .channel(`chat-lecturas:${conversationId}`, { config: { broadcast: { self: false } } })
    .on('broadcast', { event: 'leido' }, () => alAvisar())
    .subscribe((estado: string) => {
      unido = estado === 'SUBSCRIBED';
      if (unido && debeAvisar) {
        debeAvisar = false;
        mandar();
      }
    });

  return {
    avisar: () => {
      if (unido) mandar();
      else debeAvisar = true;
    },
    cerrar: () => {
      void client.removeChannel(channel);
    },
  };
}

/** Quien escucha los avisos de temas: con la pista, si el aviso traía una. */
type OyenteDeTemas = (pista: PistaDeTemas | null) => void;

type CanalDeTemas = {
  enviar: (pista: PistaDeTemas | null) => void;
  /** Lo llama el último oyente al irse. */
  soltar: () => void;
  /** Llega un oyente nuevo: si el canal iba a cerrarse, ya no. */
  retener: () => void;
  oyentes: Set<OyenteDeTemas>;
};

/** Los canales de temas abiertos ahora mismo, uno por grupo. */
const canalesDeTemas = new Map<string, CanalDeTemas>();

/**
 * Cuánto se deja abierto un canal sin oyentes que tiene un aviso por mandar.
 * Es lo que tarda de sobra en unirse; pasado eso, el aviso ya no sale.
 */
const ESPERA_PARA_AVISAR_MS = 4_000;

function abrirCanalDeTemas(
  client: NonNullable<typeof supabase>,
  grupoId: string,
): CanalDeTemas {
  const oyentes = new Set<OyenteDeTemas>();
  let unido = false;
  /**
   * El aviso que espera a que el canal se una, con su pista. `undefined`:
   * ninguno. Varios se juntan en uno (`juntarPistas`).
   */
  let porMandar: PistaDeTemas | null | undefined;
  let cierreDiferido: ReturnType<typeof setTimeout> | null = null;

  // Sin pista viaja vacío, como siempre: lo entiende cualquier versión.
  const mandar = (pista: PistaDeTemas | null) => {
    void channel.send({ type: 'broadcast', event: 'temas', payload: pista ?? {} });
  };
  const cerrarDeVerdad = () => {
    if (cierreDiferido) clearTimeout(cierreDiferido);
    cierreDiferido = null;
    // Alguien volvió mientras se esperaba: el canal sigue.
    if (oyentes.size > 0) return;
    // Solo si sigue siendo el vigente: otro pudo abrir uno nuevo entretanto.
    if (canalesDeTemas.get(grupoId) === canal) canalesDeTemas.delete(grupoId);
    void client.removeChannel(channel);
  };

  // `self: false`: quien avisa ya pintó su propio cambio.
  const channel = client
    .channel(`chat-temas:${grupoId}`, { config: { broadcast: { self: false } } })
    .on('broadcast', { event: 'temas' }, (mensaje: { payload?: unknown }) => {
      const pista = leerPistaDeTemas(mensaje?.payload);
      // Sobre una copia: un oyente puede darse de baja mientras se reparte.
      for (const oyente of [...oyentes]) oyente(pista);
    })
    .subscribe((estado: string) => {
      unido = estado === 'SUBSCRIBED';
      if (unido && porMandar !== undefined) {
        const pista = porMandar;
        porMandar = undefined;
        mandar(pista);
        // Era lo único que lo mantenía abierto.
        if (cierreDiferido) cerrarDeVerdad();
      }
    });

  const canal: CanalDeTemas = {
    oyentes,
    enviar: (pista) => {
      if (unido) mandar(pista);
      else porMandar = juntarPistas(porMandar, pista);
    },
    soltar: () => {
      // UN AVISO PENDIENTE NO SE TIRA AL CERRAR. La hoja de temas avisa y se
      // cierra en el mismo gesto («Listo»); si el canal aún no estaba dentro,
      // cerrarlo ya sería perder justo el aviso que motivó abrirlo.
      if (porMandar !== undefined) {
        cierreDiferido = setTimeout(cerrarDeVerdad, ESPERA_PARA_AVISAR_MS);
        return;
      }
      cerrarDeVerdad();
    },
    retener: () => {
      if (cierreDiferido) clearTimeout(cierreDiferido);
      cierreDiferido = null;
    },
  };
  return canal;
}

/**
 * «Algo cambió en los temas de este grupo: vuelve a preguntar».
 *
 * Agregar o quitar una referencia no crea ningún mensaje, así que el canal de
 * mensajes no se entera. Quien lo hace manda este aviso, igual que
 * `avisosDeReacciones`, y quien tiene abierta la lista del grupo o un tema
 * vuelve a preguntar a la API. Lo escrito en un tema no pasa por aquí: llega
 * por `subscribeToConversation` de su chat.
 *
 * EL AVISO NO LLEVA NADA, ni qué tema ni qué mensaje: un canal de difusión lo
 * puede escuchar —y escribir— cualquiera con la aplicación. Lo peor que logra
 * un aviso falso es una pregunta de más, y la API contesta lo que de verdad se
 * puede ver. La única excepción es una PISTA (28/10/2026): quien escribe en un
 * tema dice en cuál, para que los demás temas abiertos no lo recarguen todo
 * (ver `PistaDeTemas`). Quien no la entiende, o no la recibe, pregunta todo.
 *
 * UN SOLO CANAL POR GRUPO, LO PIDA QUIEN LO PIDA, como `canalDeEscritura`. Lo
 * atienden a la vez la lista del grupo, el tema abierto encima y la hoja de
 * «Agregar a un tema» del chat. La librería devuelve EL MISMO canal a quien
 * pide un nombre que ya existe: el primero que cerrase dejaría sordos a los
 * demás. Así que se abre con el primero, reparte a todos y se cierra con el
 * último.
 *
 * Y SE AVISA AUNQUE EL CANAL SE ESTÉ UNIENDO, como `avisosDeLectura`: la hoja
 * de temas avisa en cuanto se agrega algo, a veces antes de estar dentro. Ese
 * aviso espera a que el canal esté listo en vez de perderse.
 */
export function avisosDeTemas(
  grupoId: string,
  alAvisar: OyenteDeTemas,
): { avisar: (pista?: PistaDeTemas) => void; cerrar: () => void } {
  const client = supabase;
  if (!client || !grupoId) return { avisar: () => {}, cerrar: () => {} };

  let abierto = canalesDeTemas.get(grupoId);
  if (!abierto) {
    abierto = abrirCanalDeTemas(client, grupoId);
    canalesDeTemas.set(grupoId, abierto);
  }

  const elCanal = abierto;
  elCanal.retener();
  elCanal.oyentes.add(alAvisar);
  let cerrado = false;
  return {
    avisar: (pista) => {
      if (!cerrado) elCanal.enviar(pista ?? null);
    },
    cerrar: () => {
      if (cerrado) return;
      cerrado = true;
      elCanal.oyentes.delete(alAvisar);
      if (elCanal.oyentes.size === 0) elCanal.soltar();
    },
  };
}

type CanalAbierto = {
  enviar: (aviso: Record<string, unknown>) => void;
  cerrar: () => void;
  oyentes: Set<(aviso: unknown) => void>;
};

/** Los canales de escritura abiertos ahora mismo, uno por conversación. */
const canalesDeEscritura = new Map<string, CanalAbierto>();

/**
 * «Está escribiendo», entre los teléfonos que atienden la conversación.
 *
 * No se guarda en ningún sitio: es difusión pura, y caduca sola en quien la
 * recibe (`lib/escribiendo`). Lo que viaja es SOLO un identificador y si
 * escribe o paró; el nombre no, porque a un canal que puede escribir
 * cualquiera no se le cree. Quien recibe decide a quién le hace caso.
 *
 * UN SOLO CANAL POR CONVERSACIÓN, LO PIDA QUIEN LO PIDA. Lo atienden dos
 * sitios a la vez: el chat abierto y la bandeja, que enseña «escribiendo…»
 * en su fila. La librería devuelve EL MISMO canal a quien pide un tema que ya
 * existe (`RealtimeClient.channel`): el segundo no podría añadirle su oyente
 * —ya está suscrito— y el primero que cerrase dejaría sordo al otro. Así que
 * el canal se abre con el primero que llega, reparte a todos y se cierra
 * cuando se va el último.
 */
export function canalDeEscritura(
  conversationId: string,
  alRecibir: (aviso: unknown) => void,
): { avisar: (aviso: Record<string, unknown>) => void; cerrar: () => void } {
  const client = supabase;
  if (!client || !conversationId) return { avisar: () => {}, cerrar: () => {} };

  let abierto = canalesDeEscritura.get(conversationId);
  if (!abierto) {
    const oyentes = new Set<(aviso: unknown) => void>();
    let unido = false;
    const channel = client
      .channel(`chat-escribiendo:${conversationId}`, { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'escribe' }, (mensaje: { payload?: unknown }) => {
        // Sobre una copia: un oyente puede darse de baja mientras se reparte.
        for (const oyente of [...oyentes]) oyente(mensaje?.payload);
      })
      .subscribe((estado: string) => {
        unido = estado === 'SUBSCRIBED';
      });
    abierto = {
      oyentes,
      // Antes de estar dentro del canal el aviso se pierde, y no pasa nada: el
      // siguiente sale a los pocos segundos si la persona sigue tecleando.
      enviar: (aviso) => {
        if (!unido) return;
        void channel.send({ type: 'broadcast', event: 'escribe', payload: aviso });
      },
      cerrar: () => {
        void client.removeChannel(channel);
      },
    };
    canalesDeEscritura.set(conversationId, abierto);
  }

  const elCanal = abierto;
  elCanal.oyentes.add(alRecibir);
  let cerrado = false;
  return {
    avisar: (aviso) => {
      if (!cerrado) elCanal.enviar(aviso);
    },
    cerrar: () => {
      if (cerrado) return;
      cerrado = true;
      elCanal.oyentes.delete(alRecibir);
      if (elCanal.oyentes.size > 0) return;
      // Solo si sigue siendo el vigente: otro pudo abrir uno nuevo entretanto.
      if (canalesDeEscritura.get(conversationId) === elCanal) {
        canalesDeEscritura.delete(conversationId);
      }
      elCanal.cerrar();
    },
  };
}
