import { create } from 'zustand';

import {
  NADIE_EN_NINGUNA,
  anotarEn,
  faltaParaCaducarAlguna,
  limpiarTodas,
  quitarDe,
  soloDe,
  type EscribiendoEnBandeja,
} from '@/lib/escribiendo';
import type { InfoDeConversacion } from '@/lib/gruposDeChat';

type Estado = {
  /** Quién escribe ahora en cada conversación atendida. */
  porConversacion: EscribiendoEnBandeja;
  /**
   * Quién está en cada grupo, para poner el nombre de quien escribe. Se pide
   * la primera vez que alguien escribe en ese grupo; `null` mientras llega.
   */
  miembros: Readonly<Record<string, InfoDeConversacion | null>>;
  anotar: (conversacionId: string, usuarioId: string) => void;
  quitar: (conversacionId: string, usuarioId: string) => void;
  guardarMiembros: (conversacionId: string, info: InfoDeConversacion | null) => void;
  /** Olvida lo de las conversaciones que ya no se atienden. */
  quedarseCon: (atendidas: readonly string[]) => void;
};

/**
 * «Escribiendo…» en la bandeja de Mensajes.
 *
 * VA EN UN ALMACÉN Y NO EN EL ESTADO DE LA PANTALLA para que cada fila mire
 * solo lo suyo: un aviso llega cada dos segundos y medio mientras alguien
 * teclea, y con el estado en la pantalla cada uno la repintaría entera. Así
 * se repinta UNA fila, y solo cuando cambia quién escribe en ella.
 *
 * EL ÚNICO TEMPORIZADOR es el que retira un aviso al caducar, y solo existe
 * mientras alguien escribe en alguna parte. Sin nadie escribiendo, aquí no
 * corre nada.
 */
export const useEscribiendoEnBandejaStore = create<Estado>((set, get) => {
  let reloj: ReturnType<typeof setTimeout> | null = null;

  const programar = () => {
    if (reloj) clearTimeout(reloj);
    reloj = null;
    const falta = faltaParaCaducarAlguna(get().porConversacion, Date.now());
    if (falta === null) return;
    reloj = setTimeout(() => {
      reloj = null;
      const antes = get().porConversacion;
      const ahora = limpiarTodas(antes, Date.now());
      if (ahora !== antes) set({ porConversacion: ahora });
      programar();
    }, falta + 50);
  };

  return {
    porConversacion: NADIE_EN_NINGUNA,
    miembros: {},
    anotar: (conversacionId, usuarioId) => {
      set({ porConversacion: anotarEn(get().porConversacion, conversacionId, usuarioId, Date.now()) });
      programar();
    },
    quitar: (conversacionId, usuarioId) => {
      const antes = get().porConversacion;
      const ahora = quitarDe(antes, conversacionId, usuarioId);
      if (ahora === antes) return;
      set({ porConversacion: ahora });
      programar();
    },
    guardarMiembros: (conversacionId, info) => {
      set({ miembros: { ...get().miembros, [conversacionId]: info } });
    },
    quedarseCon: (atendidas) => {
      const antes = get().porConversacion;
      const ahora = soloDe(antes, atendidas);
      if (ahora === antes) return;
      set({ porConversacion: ahora });
      programar();
    },
  };
});
