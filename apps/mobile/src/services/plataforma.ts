import { apiRequest, API_V1 } from '@/services/api';

/**
 * Las reglas del servidor que cambian lo que se pinta (`GET /platform/config`).
 *
 * Dos, hoy:
 *
 *  - El MODO FLEXIBLE (`PUBLICACION_FLEXIBLE`). Encendido, enviar un evento, un
 *    curso o un producto lo PUBLICA al momento, así que los botones dicen
 *    «Publicar» y no «Enviar a revisión», y los mínimos de texto se relajan.
 *  - Z SERVICIOS (`FEATURE_SERVICES`). Apagado —lo de fábrica—, la app no
 *    enseña ninguna entrada de Servicios: ni «Ofrecer un servicio» en el
 *    perfil ni la bandeja en administración.
 *
 * Lo decide el servidor: la app solo adapta lo que enseña, y el servidor
 * vuelve a comprobarlo todo (con Servicios apagado, sus rutas contestan 503).
 *
 * SE PREGUNTA UNA VEZ POR SESIÓN de la app y se comparte: todas las pantallas
 * leen la misma promesa. Un fallo NO se guarda —la siguiente pantalla vuelve a
 * preguntar— y mientras tanto todo vale `false`: el modo estricto, y
 * Servicios escondido. Un servidor viejo que no manda `feature_services` es
 * un servidor sin Servicios.
 */
type Configuracion = { publicacionFlexible: boolean; serviciosEncendido: boolean };

const APAGADA: Configuracion = { publicacionFlexible: false, serviciosEncendido: false };

let enCurso: Promise<Configuracion> | null = null;

function configuracion(): Promise<Configuracion> {
  if (enCurso === null) {
    enCurso = apiRequest<{ publicacion_flexible?: unknown; feature_services?: unknown }>(
      `${API_V1}/platform/config`,
      { auth: false },
    )
      .then((dto) => ({
        publicacionFlexible: dto?.publicacion_flexible === true,
        serviciosEncendido: dto?.feature_services === true,
      }))
      .catch(() => {
        enCurso = null;
        return APAGADA;
      });
  }
  return enCurso;
}

export function publicacionFlexible(): Promise<boolean> {
  return configuracion().then((c) => c.publicacionFlexible);
}

/** Si el servidor tiene Z Servicios encendido. `false` ante la duda. */
export function serviciosEncendido(): Promise<boolean> {
  return configuracion().then((c) => c.serviciosEncendido);
}
