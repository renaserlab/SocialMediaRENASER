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
 *    perfil ni la bandeja en administración. Y ENCENDIDO NO ES PARA TODOS:
 *    durante el piloto el servidor contesta `true` solo a los perfiles
 *    autorizados, y `false` a los demás y a quien no tiene sesión. Por eso la
 *    pregunta va CON la sesión, y se repite cuando cambia quien la usa.
 *
 * Lo decide el servidor: la app solo adapta lo que enseña, y el servidor
 * vuelve a comprobarlo todo (a quien no entra, sus rutas le contestan 503
 * `services_disabled`, esté Servicios apagado o no sea del piloto). La app
 * nunca recibe la lista del piloto: solo un sí o un no para esta persona.
 *
 * SE PREGUNTA UNA VEZ POR PERSONA y se comparte: todas las pantallas leen la
 * misma promesa mientras no cambie quien usa la app. Un fallo NO se guarda —la
 * siguiente pantalla vuelve a preguntar— y mientras tanto todo vale `false`:
 * el modo estricto, y Servicios escondido. Un servidor viejo que no manda
 * `feature_services` es un servidor sin Servicios.
 */
type Configuracion = { publicacionFlexible: boolean; serviciosEncendido: boolean };

const APAGADA: Configuracion = { publicacionFlexible: false, serviciosEncendido: false };

/** Para quién se preguntó: el id de su perfil, o `null` sin sesión. */
type Quien = string | null;

let enCurso: Promise<Configuracion> | null = null;
let deQuien: Quien = null;

function configuracion(quien: Quien): Promise<Configuracion> {
  if (enCurso === null || deQuien !== quien) {
    deQuien = quien;
    const pedida: Promise<Configuracion> = apiRequest<{
      publicacion_flexible?: unknown;
      feature_services?: unknown;
    }>(`${API_V1}/platform/config`)
      .then((dto) => ({
        publicacionFlexible: dto?.publicacion_flexible === true,
        serviciosEncendido: dto?.feature_services === true,
      }))
      .catch(() => {
        // Solo se olvida si nadie preguntó por otra persona entretanto.
        if (enCurso === pedida) enCurso = null;
        return APAGADA;
      });
    enCurso = pedida;
  }
  return enCurso;
}

/** El modo flexible es del servidor, no de la persona: vale lo último preguntado. */
export function publicacionFlexible(): Promise<boolean> {
  return configuracion(deQuien).then((c) => c.publicacionFlexible);
}

/**
 * Si ESTA persona puede usar Z Servicios. `false` ante la duda.
 *
 * `quien` es el id de su perfil (`null` sin sesión). Al cambiar —entrar, salir
 * u otra cuenta— se vuelve a preguntar: lo que valía para la anterior no vale
 * para esta.
 */
export function serviciosEncendido(quien: Quien): Promise<boolean> {
  return configuracion(quien).then((c) => c.serviciosEncendido);
}
