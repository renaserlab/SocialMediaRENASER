import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { huellaDeMarcas, type MarcaDeLectura } from '@/lib/lecturaDeMensajes';
import { MessageRepository } from '@/repositories/MessageRepository';
import { avisosDeLectura } from '@/services/realtime';

const SIN_MARCAS: MarcaDeLectura[] = [];

/** Varios avisos seguidos son UNA pregunta al servidor. */
const ESPERA_MS = 700;

/**
 * Hasta dónde ha leído cada una de las otras personas de la conversación.
 *
 * Se pregunta al abrir el chat, cada vez que alguien avisa de que leyó y al
 * volver a la aplicación —por si el aviso llegó con el teléfono dormido—. Si
 * el servidor contesta lo mismo que ya se tenía, no se cambia nada: la lista
 * de mensajes no repinta por una respuesta idéntica.
 *
 * `avisarQueLei` es para quien acaba de marcar la conversación como leída.
 */
export function useLecturasDelChat(
  conversationId: string | undefined,
  activo: boolean,
): { marcas: MarcaDeLectura[]; avisarQueLei: () => void } {
  const [marcas, setMarcas] = useState<MarcaDeLectura[]>(SIN_MARCAS);
  const canal = useRef<{ avisar: () => void } | null>(null);

  useEffect(() => {
    setMarcas(SIN_MARCAS);
    if (!activo || !conversationId) return;

    let montado = true;
    let pendiente: ReturnType<typeof setTimeout> | null = null;

    const preguntar = () => {
      MessageRepository.marcasDeLectura(conversationId).then(
        (nuevas) => {
          if (!montado) return;
          setMarcas((actuales) =>
            huellaDeMarcas(actuales) === huellaDeMarcas(nuevas) ? actuales : nuevas,
          );
        },
        // Sin respuesta se queda lo que había: una marca vieja, no una falsa.
        () => {},
      );
    };

    preguntar();
    const abierto = avisosDeLectura(conversationId, () => {
      if (pendiente) return;
      pendiente = setTimeout(() => {
        pendiente = null;
        preguntar();
      }, ESPERA_MS);
    });
    canal.current = abierto;

    const alVolver = AppState.addEventListener('change', (estado) => {
      if (estado === 'active') preguntar();
    });

    return () => {
      montado = false;
      if (pendiente) clearTimeout(pendiente);
      alVolver.remove();
      canal.current = null;
      abierto.cerrar();
    };
  }, [activo, conversationId]);

  const avisarQueLei = useCallback(() => {
    canal.current?.avisar();
  }, []);

  return { marcas, avisarQueLei };
}
