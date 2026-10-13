import { useEffect, useMemo, useRef } from 'react';

import {
  cambioDeAtendidas,
  esDeFiarEnBandeja,
  fraseDeEscritura,
  lasQueSeAtienden,
  leerAviso,
  nombreDePila,
  quienesEscriben,
  type FraseDeEscritura,
} from '@/lib/escribiendo';
import { nombreDelAutor } from '@/lib/gruposDeChat';
import { GroupRepository } from '@/repositories/GroupRepository';
import { canalDeEscritura } from '@/services/realtime';
import { useEscribiendoEnBandejaStore } from '@/store/useEscribiendoEnBandejaStore';
import type { Conversation } from '@/types';

type Atendida = { esGrupo: boolean; otroId?: string | null };

/**
 * Atiende «está escribiendo» de las primeras conversaciones de la bandeja.
 *
 * Lo llama la pantalla de Mensajes, una vez. No devuelve nada: lo que llega va
 * al almacén, y cada fila lee lo suyo con `useQuienEscribeEn`.
 *
 * LOS CANALES NO SE REABREN PORQUE LA BANDEJA SE REORDENE. Solo se abre el de
 * la conversación que entra entre las atendidas y se cierra el de la que sale.
 * El canal de una conversación es UNO aunque el chat también lo tenga abierto
 * (`canalDeEscritura` lo comparte).
 */
export function useEscribiendoEnBandeja(
  conversaciones: readonly Conversation[],
  yo: string | null | undefined,
  activo: boolean,
): void {
  // Lo que hay que saber de cada conversación para creerse un aviso.
  const datos = useRef(new Map<string, Atendida>());
  const quienSoy = useRef(yo);
  quienSoy.current = yo;

  const atendidas = useMemo(() => {
    const mapa = new Map<string, Atendida>();
    for (const c of conversaciones) {
      mapa.set(c.id, { esGrupo: c.esGrupo === true, otroId: c.otherId });
    }
    datos.current = mapa;
    return activo ? lasQueSeAtienden(conversaciones.map((c) => c.id)) : [];
  }, [conversaciones, activo]);
  // Las mismas conversaciones en el mismo orden no son un cambio.
  const huella = atendidas.join('|');

  const abiertos = useRef(new Map<string, () => void>());
  const pidiendo = useRef(new Set<string>());

  useEffect(() => {
    const almacen = useEscribiendoEnBandejaStore.getState();
    const { abrir, cerrar } = cambioDeAtendidas([...abiertos.current.keys()], atendidas);

    for (const id of cerrar) {
      abiertos.current.get(id)?.();
      abiertos.current.delete(id);
    }
    if (cerrar.length > 0) almacen.quedarseCon(atendidas);

    for (const id of abrir) {
      const canal = canalDeEscritura(id, (bruto) => {
        const aviso = leerAviso(bruto);
        const conversacion = datos.current.get(id);
        if (!aviso || !conversacion) return;
        const estado = useEscribiendoEnBandejaStore.getState();
        const info = estado.miembros[id];
        const miembros = info ? info.miembros.map((miembro) => miembro.id) : null;
        if (!esDeFiarEnBandeja(aviso.usuarioId, quienSoy.current, conversacion, miembros)) return;
        if (!aviso.escribe) {
          estado.quitar(id, aviso.usuarioId);
          return;
        }
        estado.anotar(id, aviso.usuarioId);

        // El nombre de quien escribe en un grupo: se pide una vez por grupo, la
        // primera vez que alguien escribe en él. Mientras llega se ve «Alguien».
        if (!conversacion.esGrupo || info !== undefined || pidiendo.current.has(id)) return;
        pidiendo.current.add(id);
        estado.guardarMiembros(id, null);
        void GroupRepository.info(id)
          .then((leida) => {
            const ahora = useEscribiendoEnBandejaStore.getState();
            ahora.guardarMiembros(id, leida ?? null);
            if (!leida) return;
            // Con la lista delante, quien no está en el grupo deja de contar.
            const dentro = leida.miembros.map((miembro) => miembro.id);
            for (const usuarioId of Object.keys(ahora.porConversacion[id] ?? {})) {
              if (!dentro.includes(usuarioId)) ahora.quitar(id, usuarioId);
            }
          })
          .finally(() => pidiendo.current.delete(id));
      });
      abiertos.current.set(id, canal.cerrar);
    }
    // `huella` y no `atendidas`: la lista es un objeto nuevo en cada dibujo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [huella]);

  // Al irse la pantalla se cierra todo y no queda nadie «escribiendo».
  useEffect(() => {
    const canales = abiertos.current;
    return () => {
      for (const cerrar of canales.values()) cerrar();
      canales.clear();
      useEscribiendoEnBandejaStore.getState().quedarseCon([]);
    };
  }, []);
}

/**
 * Quién escribe en una conversación de la bandeja, listo para traducir.
 *
 * `null` casi siempre: es lo que hace que la fila no cambie.
 */
export function useQuienEscribeEn(
  conversacion: Pick<Conversation, 'id' | 'esGrupo'>,
): FraseDeEscritura | null {
  const lista = useEscribiendoEnBandejaStore((estado) => estado.porConversacion[conversacion.id]);
  const info = useEscribiendoEnBandejaStore((estado) => estado.miembros[conversacion.id]);
  return useMemo(() => {
    if (!lista) return null;
    const quienes = quienesEscriben(lista, Date.now());
    return fraseDeEscritura(
      quienes.map((id) => nombreDePila(nombreDelAutor(info, id))),
      conversacion.esGrupo === true,
    );
  }, [lista, info, conversacion.esGrupo]);
}
