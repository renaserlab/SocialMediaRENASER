import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { notify } from '@/lib/confirm';
import {
  claveDeErrorDeServicios,
  claveDeErrorPorEstado,
  falloDeCarga,
  hayQueRecargar,
  type FalloDeCarga,
  type SolicitudPrivada,
} from '@/lib/serviciosAdmision';
import {
  claveDeErrorDelCatalogo,
  falloDelCatalogo,
  hayQueRecargarElCatalogo,
  type FalloDelCatalogo,
} from '@/lib/serviciosCatalogo';
import { ServiceProviderRepository } from '@/repositories/ServiceProviderRepository';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Lo que comparten las pantallas de Z Servicios: traducir un error, cargar el
 * expediente propio y el cerrojo contra el doble toque.
 */

/**
 * De qué parte de Servicios es la pantalla. El catálogo tiene sus propios
 * códigos (y un «es tuyo» que habla de un servicio, no de una postulación);
 * lo que no es suyo se traduce como en la admisión.
 */
export type AmbitoDeServicios = 'admision' | 'catalogo';

/** `t` para claves que se arman en tiempo de ejecución (`servicios.estado.draft`). */
export function useTextosDeServicios(ambito: AmbitoDeServicios = 'admision') {
  const { t, language } = useTranslation();
  const f = useCallback(
    (clave: string, params?: Record<string, string | number>) => t(clave as TranslationKey, params),
    [t],
  );
  /** Un error de la API, en palabras. NUNCA el código interno. */
  const textoDelError = useCallback(
    (error: unknown): string => {
      if (error instanceof ApiError) {
        const porCodigo =
          (ambito === 'catalogo' ? claveDeErrorDelCatalogo(error.code) : null) ??
          claveDeErrorDeServicios(error.code);
        if (porCodigo !== null) return f(porCodigo);
        const porEstado = claveDeErrorPorEstado(error.status);
        if (porEstado !== null) return f(porEstado);
        if (error.code === 'network_error' || error.code === 'timeout') return t('common.loadFailed');
      }
      return t('common.tryAgain');
    },
    [ambito, f, t],
  );
  return { t, f, textoDelError, idioma: language as string };
}

export function leerFallo(error: unknown): FalloDeCarga {
  return error instanceof ApiError ? falloDeCarga(error.status, error.code) : 'error';
}

/** Lo mismo para el catálogo, que distingue «aún no eres prestador activo». */
export function leerFalloDelCatalogo(error: unknown): FalloDelCatalogo {
  return error instanceof ApiError ? falloDelCatalogo(error.status, error.code) : 'error';
}

/**
 * El cerrojo. SE CIERRA ANTES DEL PRIMER `await` —que puede ser el propio
 * diálogo de confirmación—: dos toques seguidos no mandan dos veces.
 *
 * Si el trabajo falla, se avisa con el texto del error y, cuando el servidor
 * dice que el expediente cambió (409/404), se llama a `alCambiar` para volver
 * a leerlo: nunca se asume el resultado. En el catálogo, también cuando un
 * envío llega incompleto: la lista de lo que falta se vuelve a pedir.
 */
export function useCerrojo(alCambiar?: () => Promise<void> | void, ambito: AmbitoDeServicios = 'admision') {
  const { f, textoDelError } = useTextosDeServicios(ambito);
  const cerrado = useRef(false);
  const [ocupado, setOcupado] = useState(false);
  const correr = useCallback(
    async (trabajo: () => Promise<void>): Promise<boolean> => {
      if (cerrado.current) return false;
      cerrado.current = true;
      setOcupado(true);
      try {
        await trabajo();
        return true;
      } catch (error) {
        notify(f('servicios.noSePudo'), textoDelError(error));
        const recargar = ambito === 'catalogo' ? hayQueRecargarElCatalogo : hayQueRecargar;
        if (error instanceof ApiError && recargar(error.status, error.code) && alCambiar) {
          await alCambiar();
        }
        return false;
      } finally {
        cerrado.current = false;
        setOcupado(false);
      }
    },
    [alCambiar, ambito, f, textoDelError],
  );
  return { ocupado, correr };
}

/**
 * El expediente PROPIO, leído del servidor cada vez que la pantalla gana el
 * foco (volver de otro paso trae lo último).
 *
 * `ninguna` es «todavía no has postulado» (404 `service_application_not_found`),
 * que NO es un fallo: es el principio del recorrido.
 */
export function useExpedienteDeServicios() {
  const [solicitud, setSolicitud] = useState<SolicitudPrivada | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<FalloDeCarga | null>(null);
  const [ninguna, setNinguna] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      setSolicitud(await ServiceProviderRepository.postulacion());
      setNinguna(false);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'service_application_not_found') {
        setSolicitud(null);
        setNinguna(true);
      } else {
        setFallo(leerFallo(error));
      }
    } finally {
      setCargando(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  return { solicitud, setSolicitud, cargando, fallo, ninguna, cargar };
}
