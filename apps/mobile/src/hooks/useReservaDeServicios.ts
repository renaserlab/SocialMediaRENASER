import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import type { FalloDeCarga } from '@/lib/serviciosAdmision';
import {
  segundosRestantes,
  type AmbitoDeReservas,
  type PaginaDeReservas,
  type Reserva,
  type Resumen,
} from '@/lib/serviciosReserva';
import { leerFallo } from '@/hooks/useServicios';
import { ServiceBookingRepository } from '@/repositories/ServiceBookingRepository';

/**
 * El resumen de una retención PROPIA, leído del servidor cada vez que la
 * pantalla gana el foco (volver de las condiciones o de «tus datos» trae lo
 * último). `recibidaEn` es cuándo llegó, en el reloj del teléfono: la cuenta
 * atrás solo resta lo que ha pasado desde entonces.
 */
export function useResumenDeLaContratacion(retencion: string) {
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [recibidaEn, setRecibidaEn] = useState(0);
  const [fallo, setFallo] = useState<FalloDeCarga | null>(null);

  const cargar = useCallback(async (): Promise<Resumen | null> => {
    setFallo(null);
    try {
      const fresco = await ServiceBookingRepository.resumen(retencion);
      setResumen(fresco);
      setRecibidaEn(Date.now());
      return fresco;
    } catch (error) {
      setFallo(leerFallo(error));
      return null;
    }
  }, [retencion]);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  return { resumen, recibidaEn, fallo, cargar };
}

/** Los segundos que le quedan a la retención, refrescados cada segundo. */
export function useCuentaAtras(resumen: Resumen | null, recibidaEn: number): number {
  const calcular = useCallback(
    () => (resumen ? segundosRestantes(resumen.hold, recibidaEn, Date.now()) : 0),
    [resumen, recibidaEn],
  );
  const [segundos, setSegundos] = useState(calcular);
  useEffect(() => {
    setSegundos(calcular());
    if (!resumen || resumen.hold.status !== 'active') return undefined;
    const reloj = setInterval(() => setSegundos(calcular()), 1000);
    return () => clearInterval(reloj);
  }, [calcular, resumen]);
  return segundos;
}

/**
 * Una lista de reservas por cursor: la primera página al ganar el foco, y
 * «ver más» sin repetir. `ambito`: por venir o pasadas.
 */
export function useListaDeReservas(
  pedir: (ambito: AmbitoDeReservas, cursor: string | null) => Promise<PaginaDeReservas>,
  ambito: AmbitoDeReservas,
) {
  const [reservas, setReservas] = useState<Reserva[] | null>(null);
  const [siguiente, setSiguiente] = useState<string | null>(null);
  const [fallo, setFallo] = useState<FalloDeCarga | null>(null);
  const [cargandoMas, setCargandoMas] = useState(false);
  const vigente = useRef(0);

  const cargar = useCallback(async () => {
    const esta = ++vigente.current;
    setFallo(null);
    try {
      const pagina = await pedir(ambito, null);
      if (esta !== vigente.current) return;
      setReservas(pagina.items);
      setSiguiente(pagina.next_cursor);
    } catch (error) {
      if (esta === vigente.current) setFallo(leerFallo(error));
    }
  }, [ambito, pedir]);

  const mas = useCallback(async () => {
    if (!siguiente || cargandoMas) return;
    const esta = vigente.current;
    setCargandoMas(true);
    try {
      const pagina = await pedir(ambito, siguiente);
      if (esta !== vigente.current) return;
      setReservas((ya) => [...(ya ?? []), ...pagina.items.filter((b) => !(ya ?? []).some((x) => x.id === b.id))]);
      setSiguiente(pagina.next_cursor);
    } catch (error) {
      if (esta === vigente.current) setFallo(leerFallo(error));
    } finally {
      setCargandoMas(false);
    }
  }, [ambito, cargandoMas, pedir, siguiente]);

  useFocusEffect(
    useCallback(() => {
      setReservas(null);
      void cargar();
    }, [cargar]),
  );

  return { reservas, siguiente, fallo, cargar, mas, cargandoMas };
}
