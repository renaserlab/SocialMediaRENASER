import { useEffect, useRef, useState } from 'react';

import { ESPERA_ENTRE_INFORMES_MS, claveDeInvitado, tocaInformarDelPico } from '@/live/audiencia';
import { LiveRepository } from '@/repositories/LiveRepository';
import { seguirAudiencia } from '@/services/directoEnVivo';
import { useAppStore } from '@/store/useAppStore';

/**
 * Quien mira sin cuenta se apunta con esta clave. UNA por arranque de la
 * aplicación: entrar y salir de la sala no lo convierte en dos personas.
 */
const CLAVE_DE_ESTE_TELEFONO = claveDeInvitado();

/**
 * Cuánta gente está viendo una emisión, o `null` si no se sabe.
 *
 * `null` y no `0` a propósito: sin tiempo real, o antes de la primera lista,
 * no hay número, y la cabecera no pinta el ojo en vez de pintar un cero que
 * parecería cierto.
 *
 * QUIEN EMITE, ADEMÁS, INFORMA DEL PICO AL SERVIDOR. Es la única parte que lo
 * hace —así lo exige el servidor— y solo cuando sube, dejando pasar un rato
 * entre informes (`live/audiencia.ts`). Si la subida llega durante esa espera,
 * se informa al terminarla: el máximo no se pierde.
 */
export function useAudienciaDeDirecto(opciones: {
  emisionId: string;
  /** Solo hay audiencia que contar mientras se emite. */
  enDirecto: boolean;
  anfitrionId: string | null;
}): number | null {
  const { emisionId, enDirecto, anfitrionId } = opciones;
  const miId = useAppStore((estado) => estado.user?.id ?? null);
  // Quien EMITE, no quien puede gestionar: la administracion tambien puede
  // terminar una emision ajena, y el servidor solo le acepta el pico a quien
  // la emite.
  const esAnfitrion = miId !== null && miId === anfitrionId;
  const [viendo, setViendo] = useState<number | null>(null);

  useEffect(() => {
    setViendo(null);
    if (!emisionId || !enDirecto) return;
    return seguirAudiencia(emisionId, miId ?? CLAVE_DE_ESTE_TELEFONO, anfitrionId, setViendo);
  }, [emisionId, enDirecto, anfitrionId, miId]);

  /* ---- El pico, que lo informa quien emite. ---- */
  const ultimoInformado = useRef(0);
  const ultimoInformeEn = useRef<number | null>(null);

  useEffect(() => {
    ultimoInformado.current = 0;
    ultimoInformeEn.current = null;
  }, [emisionId]);

  useEffect(() => {
    if (!esAnfitrion || !enDirecto || viendo === null) return;

    const informar = () => {
      ultimoInformado.current = viendo;
      ultimoInformeEn.current = Date.now();
      // Que falle no cambia nada en pantalla: el siguiente aumento lo reintenta.
      LiveRepository.reportarEspectadores(emisionId, viendo).catch(() => {
        ultimoInformado.current = 0;
      });
    };

    const ahora = Date.now();
    if (
      tocaInformarDelPico({
        viendo,
        ultimoInformado: ultimoInformado.current,
        ahora,
        ultimoInformeEn: ultimoInformeEn.current,
      })
    ) {
      informar();
      return;
    }
    if (viendo <= ultimoInformado.current || ultimoInformeEn.current === null) return;

    // Ha subido dentro de la espera: se informa en cuanto termine. Si antes
    // cambia el número, este efecto se limpia y decide de nuevo con el nuevo.
    const falta = ESPERA_ENTRE_INFORMES_MS - (ahora - ultimoInformeEn.current);
    const reloj = setTimeout(informar, Math.max(0, falta));
    return () => clearTimeout(reloj);
  }, [viendo, esAnfitrion, enDirecto, emisionId]);

  return viendo;
}
