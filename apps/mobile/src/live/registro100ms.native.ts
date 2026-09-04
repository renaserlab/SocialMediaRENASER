import { hayProveedorDeVideo, registrarFabricaDeSala } from '@/live/salaDeVideo';

/**
 * Enchufa 100ms como proveedor de vídeo, y solo donde existe.
 *
 * POR QUÉ NO ES UN `import` NORMAL. `@100mslive/react-native-hms` es un módulo
 * NATIVO: en el navegador no existe, y en `node --test` tampoco. Importarlo
 * desde arriba tumbaría la exportación web entera y todas las pruebas, aunque
 * nadie llegara a abrir una transmisión.
 *
 * Con `require` dentro de una función y detrás de una comprobación de
 * plataforma, el empaquetador no lo mete en el paquete de web y el módulo solo
 * se toca en un teléfono.
 *
 * SE LLAMA TARDE, cuando alguien abre una transmisión, y no al arrancar la
 * aplicación: cargar el SDK cuesta memoria y arranque, y la inmensa mayoría de
 * las sesiones de Z no ven un directo.
 *
 * ES IDEMPOTENTE: llamarla en cada montaje de la pantalla registra una vez.
 */
export function asegurarProveedorDeVideo(): void {
  if (hayProveedorDeVideo()) return;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const modulo = require('@/live/salaDeVideo100ms') as {
      crearSalaDe100ms: () => import('@/live/salaDeVideo').SalaDeVideo;
    };
    registrarFabricaDeSala(modulo.crearSalaDe100ms);
  } catch {
    /*
      El SDK no está instalado o no se puede cargar en este aparato. NO se
      levanta: sin proveedor, `crearSalaDeVideo()` devuelve la sala falsa y la
      pantalla enseña «el vídeo no está disponible», que es exactamente el
      comportamiento correcto y el que había antes de instalar nada.
    */
  }
}
