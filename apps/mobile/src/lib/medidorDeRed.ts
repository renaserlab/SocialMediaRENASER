/**
 * Cuánto da la red, medido con descargas que la app YA hace.
 *
 * NO DESCARGA NADA PARA MEDIR: una prueba de velocidad gasta datos de quien
 * mira justo cuando su red es mala. Quien baja bytes de verdad (la precarga
 * de los primeros bytes de un video, por ejemplo) llama a
 * `registrarMuestraDeRed(bytes, ms)` y aquí se lleva una media móvil. En
 * iPhone y Android esa fuente es la precarga nativa del primer MB
 * (`hooks/usePrecargaDeVideos.ts` → `services/precargaDeVideos.ts`), que ya
 * descuenta la espera en la fila del nativo y las lecturas de disco.
 *
 * En la web, además, el navegador da gratis su estimación
 * (`navigator.connection`: `downlink`, `effectiveType`, `saveData`); en
 * iPhone y Android eso no existe sin un módulo nativo nuevo, y esto tiene
 * que poder llegar por EAS Update (ver `medicionDeVideoEnApp.ts`).
 *
 * Sin React Native a propósito: se prueba en Node (sus pruebas viven en
 * `elegirVariante.test.mts`).
 */
import type { MedicionDeRed } from './elegirVariante.ts';

/**
 * Por debajo de esto una muestra mide sobre todo la latencia, no el ancho de
 * banda: con 20 KB y 200 ms de ida y vuelta saldría «800 kbps» en un wifi
 * de 100 Mbps, y se bajaría la calidad sin motivo.
 */
export const BYTES_MINIMOS_POR_MUESTRA = 128 * 1024;
/** Peso de la muestra nueva en la media móvil. */
export const PESO_DE_LA_MUESTRA = 0.3;
/** Pasado esto sin muestras, la medición ya no describe la red de ahora. */
export const VIGENCIA_MS = 5 * 60 * 1000;

export function crearMedidorDeRed(ahora: () => number = Date.now) {
  let kbps: number | null = null;
  let medidoEn = 0;
  return {
    /** Una descarga terminada: cuántos bytes y en cuántos milisegundos. */
    registrar(bytes: number, ms: number): void {
      if (!Number.isFinite(bytes) || !Number.isFinite(ms)) return;
      if (bytes < BYTES_MINIMOS_POR_MUESTRA || ms <= 0) return;
      const muestra = (bytes * 8) / ms; // bits por ms = kbps
      const vigente = kbps !== null && ahora() - medidoEn < VIGENCIA_MS;
      kbps = vigente ? kbps! * (1 - PESO_DE_LA_MUESTRA) + muestra * PESO_DE_LA_MUESTRA : muestra;
      medidoEn = ahora();
    },
    /** kbps estimados, o `null` si no hay una medición vigente. */
    kbps(): number | null {
      if (kbps === null || ahora() - medidoEn >= VIGENCIA_MS) return null;
      return kbps;
    },
    olvidar(): void {
      kbps = null;
      medidoEn = 0;
    },
  };
}

type ConexionDelNavegador = {
  downlink?: number;
  effectiveType?: string;
  saveData?: boolean;
};

/** Lo que dice el navegador, si lo dice (Chrome y Android). Nunca lanza. */
export function medicionDelNavegador(entorno: unknown = globalThis): MedicionDeRed | null {
  try {
    const conexion = (entorno as { navigator?: { connection?: ConexionDelNavegador } })
      ?.navigator?.connection;
    if (!conexion) return null;
    const downlink = typeof conexion.downlink === 'number' && conexion.downlink > 0 ? conexion.downlink : null;
    return {
      // `downlink` viene en Mbps.
      kbps: downlink !== null ? downlink * 1000 : null,
      tipo: typeof conexion.effectiveType === 'string' ? conexion.effectiveType : null,
      ahorroDeDatos: conexion.saveData === true,
    };
  } catch {
    return null;
  }
}

/**
 * Junta lo medido por la app con lo que diga el navegador. Lo medido manda:
 * son bytes de verdad de este servidor, no una estimación genérica.
 */
export function combinarMediciones(
  kbpsMedidos: number | null,
  delNavegador: MedicionDeRed | null,
): MedicionDeRed | null {
  if (kbpsMedidos === null && !delNavegador) return null;
  return {
    kbps: kbpsMedidos ?? delNavegador?.kbps ?? null,
    tipo: delNavegador?.tipo ?? null,
    ahorroDeDatos: delNavegador?.ahorroDeDatos ?? false,
  };
}

/** El medidor de esta sesión de la app. */
export const medidorDeRed = crearMedidorDeRed();

/** Punto de entrada para quien descarga bytes de video (p. ej. la precarga). */
export function registrarMuestraDeRed(bytes: number, ms: number): void {
  medidorDeRed.registrar(bytes, ms);
}

/** Lo que se sabe de la red ahora mismo. `null` si no se sabe nada. */
export function medicionDeRedActual(): MedicionDeRed | null {
  return combinarMediciones(medidorDeRed.kbps(), medicionDelNavegador());
}
