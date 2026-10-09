import { useCallback, useEffect, useState } from 'react';

import { type InfoDeConversacion } from '@/lib/gruposDeChat';
import { GroupRepository } from '@/repositories/GroupRepository';

/**
 * Lo último que se supo de cada conversación, para toda la sesión.
 *
 * Abrir un grupo por segunda vez pinta su nombre al instante en vez de esperar
 * a la red. Se vuelve a preguntar igual —la gente entra y sale—, pero ya hay
 * algo cierto que enseñar mientras tanto.
 *
 * LA CLAVE LLEVA A QUIEN MIRA. Un grupo tiene el mismo identificador para
 * todos sus miembros, pero «puedo administrarlo» depende de quién pregunta:
 * con la conversación sola como clave, cambiar de cuenta en el mismo teléfono
 * enseñaría un instante los botones de la cuenta anterior.
 */
const SABIDO = new Map<string, InfoDeConversacion>();

const clave = (quien: string | null | undefined, conversationId: string): string =>
  `${quien ?? ''}:${conversationId}`;

export type EstadoDeLaInfo = {
  /**
   * `undefined`: todavía no se sabe (se está preguntando).
   * `null`: no se pudo saber; se trata como un chat de dos.
   */
  info: InfoDeConversacion | null | undefined;
  /** Vuelve a preguntar: tras añadir o sacar a alguien, o al volver a la pantalla. */
  refrescar: () => void;
};

/**
 * Qué es una conversación —de dos o un grupo— y quién está en ella.
 *
 * LA DISTINCIÓN ENTRE `undefined` Y `null` IMPORTA. Mientras no se sabe, la
 * cabecera del chat no se lanza a averiguar «la otra persona» leyendo los
 * mensajes: en un grupo enseñaría el nombre de quien escribió primero como si
 * fuera el del chat.
 */
export function useInfoDeConversacion(
  conversationId: string | null | undefined,
  quien: string | null | undefined,
  activo: boolean,
): EstadoDeLaInfo {
  const [info, setInfo] = useState<InfoDeConversacion | null | undefined>(() =>
    conversationId ? SABIDO.get(clave(quien, conversationId)) : undefined,
  );
  const [vuelta, setVuelta] = useState(0);

  useEffect(() => {
    if (!activo || !conversationId) {
      setInfo(null);
      return;
    }
    let montado = true;
    const suClave = clave(quien, conversationId);
    setInfo(SABIDO.get(suClave));
    void GroupRepository.info(conversationId).then((leida) => {
      if (leida) SABIDO.set(suClave, leida);
      // Un fallo no borra lo que ya se sabía de esta conversación.
      if (montado) setInfo(leida ?? SABIDO.get(suClave) ?? null);
    });
    return () => {
      montado = false;
    };
  }, [conversationId, quien, activo, vuelta]);

  const refrescar = useCallback(() => setVuelta((n) => n + 1), []);
  return { info, refrescar };
}
