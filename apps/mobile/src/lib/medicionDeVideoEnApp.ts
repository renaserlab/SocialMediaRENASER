/**
 * La medicion de video de Inicio, conectada al telefono.
 *
 * La logica (que se mide, cuando se manda, el tope y el muestreo) vive en
 * `medicionDeVideo.ts` y se prueba sin React Native. Aqui solo se le dan las
 * piezas del aparato: el reloj, el envio por `fetch`, el paso a segundo plano y
 * los datos del equipo.
 *
 * LO QUE NO SE AÑADE, a proposito: ningun modulo nativo nuevo. Un modulo
 * nativo obliga a compilar y pasar por las tiendas, y esto tiene que poder
 * llegar por EAS Update. Por eso el TIPO DE RED queda en `null` en iPhone y en
 * Android (saberlo exige `@react-native-community/netinfo` o `expo-network`,
 * que no estan en el binario publicado); en la web sale del navegador sin coste.
 * `expo-device` y `expo-constants` ya viajan en el binario (los usan los avisos
 * push), y `expo-updates` tambien.
 */
import { AppState, Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';

import {
  crearMedicion,
  MEDICION_ENCENDIDA,
  type ContextoDelEquipo,
  type Medicion,
} from '@/lib/medicionDeVideo';
import { ORIGEN_DEL_ARRANQUE } from '@/lib/perf';

/**
 * A donde se manda. Se lee la variable tal cual y NO la de `services/api.ts`,
 * que cae a `localhost` cuando falta: sin direccion de API la medicion se
 * apaga, no se pone a llamar a un servidor que no existe.
 */
const API = process.env.EXPO_PUBLIC_API_URL;
const RUTA = '/api/v1/telemetria/video';

/** Si el servidor no contesta en esto, se corta. No hay segundo intento. */
const ESPERA_DEL_ENVIO_MS = 5_000;

/** Id corto de la actualizacion OTA en uso, o `embebido` si es la del binario. */
function versionDelPaquete(): string | null {
  try {
    // Carga protegida: si el modulo no estuviera (Expo Go antiguo), no pasa nada.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const updates = require('expo-updates') as { updateId?: string | null; isEmbeddedLaunch?: boolean };
    if (updates.updateId && !updates.isEmbeddedLaunch) return String(updates.updateId).slice(0, 8);
    return 'embebido';
  } catch {
    return null;
  }
}

/** Tipo de red SOLO donde sale gratis: la API de red del navegador (Chrome/Android). */
function tipoDeRed(): string | null {
  if (Platform.OS !== 'web') return null;
  try {
    const conexion = (globalThis as { navigator?: { connection?: { effectiveType?: string } } })
      .navigator?.connection;
    return conexion?.effectiveType ? String(conexion.effectiveType).slice(0, 16) : null;
  } catch {
    return null;
  }
}

function contexto(): ContextoDelEquipo {
  const plataforma = Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web';
  return {
    plataforma,
    version_app: Constants.expoConfig?.version?.slice(0, 32) ?? null,
    build: versionDelPaquete(),
    modelo: Device.modelName?.slice(0, 64) ?? null,
    sistema: Device.osVersion ? `${Device.osName ?? ''} ${Device.osVersion}`.trim().slice(0, 32) : null,
    red: tipoDeRed(),
  };
}

function enviar(cuerpo: string): Promise<unknown> {
  const control = typeof AbortController === 'function' ? new AbortController() : null;
  const corte = setTimeout(() => control?.abort(), ESPERA_DEL_ENVIO_MS);
  return fetch(`${API}${RUTA}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: cuerpo,
    // En la web deja que el envio sobreviva a cerrar la pestana. React Native
    // lo ignora, y no pasa nada: alli la app sigue viva unos segundos al salir.
    keepalive: true,
    signal: control?.signal,
  })
    .catch(() => {})
    .finally(() => clearTimeout(corte));
}

function crear(): Medicion {
  const instancia: Medicion = crearMedicion({
    ahora: Date.now,
    origen: ORIGEN_DEL_ARRANQUE,
    azar: Math.random,
    contexto,
    enviar,
    programar: (accion, ms) => setTimeout(accion, ms),
    // Solo se escucha el paso a segundo plano si hay algo medido: quien nunca
    // abre Inicio no carga con un oyente mas.
    alEmpezar: () => {
      const suscripcion = AppState.addEventListener('change', (estado) => {
        // `background` y no «todo lo que no sea active»: en iOS bajar el centro
        // de control pasa por `inactive` y se vuelve; salir de verdad siempre
        // termina en `background` (en Android y en la web no hay `inactive`).
        if (estado !== 'background') return;
        instancia.aSegundoPlano();
        suscripcion.remove();
      });
    },
    encendida: MEDICION_ENCENDIDA && Boolean(API),
  });
  return instancia;
}

/** La instancia de este arranque. Una por proceso: el id de sesion va con ella. */
export const medicionDeVideo: Medicion = crear();
