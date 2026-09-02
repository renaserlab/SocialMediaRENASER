import { useCallback, useEffect, useRef, useState } from 'react';

import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { DevolucionesRepository } from '@/repositories/PaymentRepository';
import type { EstadoDeGarantia } from '@/repositories/PaymentRepository';

/**
 * La cuenta atrás de la garantía, con la hora del SERVIDOR.
 *
 * EL FALLO QUE ESTO EVITA: una cuenta atrás nacida de `Date.now()`. El reloj
 * del teléfono lo elige quien lo lleva —atrasarlo una semana es un gesto de
 * ajustes— y con él la pantalla diría «te quedan 6 días» sobre un plazo que el
 * servidor ya dio por vencido. Lo contrario también pasa sin tocar nada: un
 * reloj adelantado apaga el botón de alguien que sí está en plazo.
 *
 * CÓMO SE HACE. La respuesta trae `server_time`, que es la hora del servidor al
 * contestar. Se guarda el DESFASE con la hora local en ese mismo instante y a
 * partir de ahí todo se mide contra `Date.now() + desfase`. La hora local sigue
 * usándose, pero solo como CRONÓMETRO —para saber cuánto ha pasado desde la
 * respuesta—, nunca como autoridad de qué hora es.
 *
 * Y NO SE VUELVE A PREGUNTAR. El refresco visual es un intervalo local de un
 * segundo: pedirle la hora al servidor cada segundo sería una petición por
 * segundo y por persona mirando una ficha de curso, para pintar un número que
 * ya se puede calcular.
 *
 * Quien decide de verdad sigue siendo el servidor: revalida el plazo al recibir
 * la solicitud, así que esta cuenta atrás informa, no autoriza.
 */

/** Diferencia entre el reloj del servidor y el local, en milisegundos. */
export function desfaseConElServidor(serverTime: string, ahoraLocal: number): number {
  const servidor = Date.parse(serverTime);
  // Sin hora del servidor no se inventa un desfase: cero es «confía en lo que
  // hay», que es exactamente lo que había antes de responder.
  if (!Number.isFinite(servidor)) return 0;
  return servidor - ahoraLocal;
}

/**
 * Segundos que quedan hasta `venceEn`, medidos con el reloj del servidor.
 *
 * `ahoraLocal` entra por parámetro y no se lee dentro a propósito: así la
 * función es pura y el desfase se aplica en un solo sitio.
 */
export function segundosRestantesSegunElServidor(
  venceEn: string | null,
  desfaseMs: number,
  ahoraLocal: number,
): number {
  if (!venceEn) return 0;
  const vence = Date.parse(venceEn);
  if (!Number.isFinite(vence)) return 0;
  const ahoraSegunElServidor = ahoraLocal + desfaseMs;
  return Math.max(0, Math.floor((vence - ahoraSegunElServidor) / 1000));
}

/** Trocea los segundos para poder escribirlos con palabras. */
export function partesDeCuentaAtras(totalSegundos: number): {
  dias: number;
  horas: number;
  minutos: number;
  segundos: number;
} {
  const total = Math.max(0, Math.floor(totalSegundos));
  return {
    dias: Math.floor(total / 86400),
    horas: Math.floor((total % 86400) / 3600),
    minutos: Math.floor((total % 3600) / 60),
    segundos: total % 60,
  };
}

export type Garantia = {
  estado: EstadoDeGarantia | null;
  cargando: boolean;
  error: string | null;
  /** Segundos que quedan, ya corregidos con el desfase del servidor. */
  restantes: number;
  recargar: () => void;
};

/**
 * Estado de la garantía de un curso.
 *
 * `activo` apaga la consulta entera: para un curso gratis, o sin comprar, no
 * hay garantía que preguntar y se ahorra la llamada.
 */
export function useGarantia(courseId: string | undefined, activo: boolean): Garantia {
  const [estado, setEstado] = useState<EstadoDeGarantia | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restantes, setRestantes] = useState(0);
  const [intento, setIntento] = useState(0);

  /**
   * `server_time` menos la hora local, en el instante de recibir la respuesta.
   * Va en una ref y no en el estado porque cambiarlo NO tiene que repintar: se
   * lee dentro del intervalo, que ya repinta por su cuenta.
   */
  const desfaseRef = useRef(0);

  const recargar = useCallback(() => setIntento((n) => n + 1), []);

  useEffect(() => {
    let vigente = true;
    if (!courseId || !activo) {
      setEstado(null);
      setError(null);
      setRestantes(0);
      // Apagar la consulta no puede dejar la pantalla «cargando» para siempre.
      setCargando(false);
      return;
    }
    setCargando(true);
    setError(null);
    DevolucionesRepository.garantia(courseId)
      .then((respuesta) => {
        if (!vigente) return;
        // El desfase se calcula AQUÍ, junto a la respuesta: hacerlo más tarde
        // mediría también lo que tardó el render.
        desfaseRef.current = desfaseConElServidor(respuesta.serverTime, Date.now());
        setEstado(respuesta);
        setRestantes(
          segundosRestantesSegunElServidor(
            respuesta.venceEn,
            desfaseRef.current,
            Date.now(),
          ),
        );
      })
      .catch((fallo: unknown) => {
        if (!vigente) return;
        // Que falle preguntando no puede romper la ficha del curso: se queda
        // sin tarjeta y con un error que se puede reintentar.
        setEstado(null);
        setError(fallo instanceof Error ? fallo.message : 'error');
      })
      .finally(() => {
        if (vigente) setCargando(false);
      });
    return () => {
      vigente = false;
    };
  }, [courseId, activo, intento]);

  const venceEn = estado?.venceEn ?? null;

  useEffect(() => {
    if (!venceEn) return;
    const tic = setInterval(() => {
      setRestantes(
        segundosRestantesSegunElServidor(venceEn, desfaseRef.current, Date.now()),
      );
    }, 1000);
    // Sin esto el intervalo sobrevive a la pantalla: sigue llamando a
    // `setRestantes` sobre un componente desmontado, y por cada visita queda
    // uno más corriendo.
    return () => clearInterval(tic);
  }, [venceEn]);

  return { estado, cargando, error, restantes, recargar };
}
