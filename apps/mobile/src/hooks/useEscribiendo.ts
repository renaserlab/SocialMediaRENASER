import { useCallback, useEffect, useRef, useState } from 'react';

import {
  NADIE,
  anotar,
  avisoDe,
  esDeFiar,
  faltaParaCaducar,
  leerAviso,
  limpiar,
  quienesEscriben,
  quitar,
  tocaAvisar,
  tocaAvisarQueParo,
  type Escribiendo,
} from '@/lib/escribiendo';
import { canalDeEscritura } from '@/services/realtime';

type Entrada = {
  conversationId: string | undefined;
  /** Quien usa este teléfono: sus propios avisos no se escuchan. */
  yo: string | null | undefined;
  /** Quiénes están en la conversación, si ya se sabe. `null`: todavía no. */
  conocidos: readonly string[] | null;
  activo: boolean;
};

/**
 * «Está escribiendo» de una conversación: quién escribe ahora, y los avisos
 * propios mientras se teclea.
 *
 * NO HAY NADA MONTADO CUANDO NADIE ESCRIBE. La lista vacía es siempre el mismo
 * objeto, y el único temporizador que existe es el que retira un aviso al
 * caducar: mientras no escribe nadie, este hook no hace nada.
 */
export function useEscribiendo({ conversationId, yo, conocidos, activo }: Entrada): {
  /** Identificadores de quienes escriben ahora. */
  quienes: string[];
  /** Se llama con el texto del cuadro cada vez que cambia. */
  alEscribir: (texto: string) => void;
  /** Se llama al enviar: ya no se está escribiendo. */
  alParar: () => void;
} {
  const [lista, setLista] = useState<Escribiendo>(NADIE);
  const canal = useRef<{ avisar: (aviso: Record<string, unknown>) => void } | null>(null);
  const ultimoAviso = useRef<number | undefined>(undefined);
  // En referencias: cambian sin que haya que volver a abrir el canal.
  const quienSoy = useRef(yo);
  const losDeAqui = useRef(conocidos);
  quienSoy.current = yo;
  losDeAqui.current = conocidos;

  useEffect(() => {
    setLista(NADIE);
    ultimoAviso.current = undefined;
    if (!activo || !conversationId) return;

    const abierto = canalDeEscritura(conversationId, (bruto) => {
      const aviso = leerAviso(bruto);
      if (!aviso || !esDeFiar(aviso.usuarioId, quienSoy.current, losDeAqui.current)) return;
      setLista((actual) =>
        aviso.escribe ? anotar(actual, aviso.usuarioId, Date.now()) : quitar(actual, aviso.usuarioId),
      );
    });
    canal.current = abierto;

    return () => {
      // Quien sale del chat a medio escribir deja de escribir para los demás.
      if (ultimoAviso.current !== undefined && quienSoy.current) {
        abierto.avisar(avisoDe(quienSoy.current, false));
      }
      canal.current = null;
      abierto.cerrar();
    };
  }, [activo, conversationId]);

  // Un solo temporizador, y solo mientras alguien escribe: al caducar el
  // primero se limpia la lista, y si queda alguien se arma el siguiente.
  useEffect(() => {
    const falta = faltaParaCaducar(lista, Date.now());
    if (falta === null) return;
    const reloj = setTimeout(() => setLista((actual) => limpiar(actual, Date.now())), falta + 50);
    return () => clearTimeout(reloj);
  }, [lista]);

  const alEscribir = useCallback((texto: string) => {
    const quien = quienSoy.current;
    if (!quien || !canal.current) return;
    const ahora = Date.now();
    if (tocaAvisar(texto, ahora, ultimoAviso.current)) {
      ultimoAviso.current = ahora;
      canal.current.avisar(avisoDe(quien, true));
    } else if (tocaAvisarQueParo(texto, ultimoAviso.current)) {
      ultimoAviso.current = undefined;
      canal.current.avisar(avisoDe(quien, false));
    }
  }, []);

  const alParar = useCallback(() => {
    const quien = quienSoy.current;
    if (!quien || !canal.current || ultimoAviso.current === undefined) return;
    ultimoAviso.current = undefined;
    canal.current.avisar(avisoDe(quien, false));
  }, []);

  return { quienes: quienesEscriben(lista, Date.now()), alEscribir, alParar };
}
