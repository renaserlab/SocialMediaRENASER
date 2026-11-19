import { apiRequest, API_V1 } from '@/services/api';

/**
 * Las reglas del servidor que cambian lo que se pinta (`GET /platform/config`).
 *
 * Tres familias, hoy (la tercera, los videos en S3, esta al final):
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
 *    ADMINISTRACIÓN ES OTRA RESPUESTA (`feature_services_admin`): va por el
 *    rol, no por la lista. Quien revisa no tiene por qué ser del piloto, y con
 *    una sola respuesta se quedaba sin su bandeja.
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
type Configuracion = {
  publicacionFlexible: boolean;
  serviciosEncendido: boolean;
  serviciosDeAdministracion: boolean;
  mediosS3Subida: boolean;
  mediosS3Lectura: boolean;
};

const APAGADA: Configuracion = {
  publicacionFlexible: false,
  serviciosEncendido: false,
  serviciosDeAdministracion: false,
  mediosS3Subida: false,
  mediosS3Lectura: false,
};

/** Para quién se preguntó: ver `quienPregunta`. `null` es sin sesión. */
type Quien = string | null;

const SESION_SIN_PERFIL = 'sesion-sin-perfil';

/**
 * Para quién se pregunta: el id del perfil o, sin él, si hay sesión.
 *
 * El perfil puede no haber cargado todavía (o haber fallado) con la sesión ya
 * iniciada: la pregunta viaja con ESE token, y su respuesta no puede quedarse
 * guardada como la de «nadie». Al salir se vuelve a preguntar.
 */
export function quienPregunta(perfil: string | null, conSesion: boolean): Quien {
  return perfil ?? (conSesion ? SESION_SIN_PERFIL : null);
}

let enCurso: Promise<Configuracion> | null = null;
let deQuien: Quien = null;

function configuracion(quien: Quien): Promise<Configuracion> {
  if (enCurso === null || deQuien !== quien) {
    deQuien = quien;
    const pedida: Promise<Configuracion> = apiRequest<{
      publicacion_flexible?: unknown;
      feature_services?: unknown;
      feature_services_admin?: unknown;
      medios_s3_subida?: unknown;
      medios_s3_lectura?: unknown;
    }>(`${API_V1}/platform/config`)
      .then((dto) => ({
        publicacionFlexible: dto?.publicacion_flexible === true,
        serviciosEncendido: dto?.feature_services === true,
        serviciosDeAdministracion: dto?.feature_services_admin === true,
        mediosS3Subida: dto?.medios_s3_subida === true,
        mediosS3Lectura: dto?.medios_s3_lectura === true,
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
 * `quien` sale de `quienPregunta`. Al cambiar —entrar, salir u otra cuenta—
 * se vuelve a preguntar: lo que valía para la anterior no vale para esta.
 */
export function serviciosEncendido(quien: Quien): Promise<boolean> {
  return configuracion(quien).then((c) => c.serviciosEncendido);
}

/**
 * Si a ESTA persona le toca administrar Z Servicios: la sección del panel de
 * administración. Por su rol, esté o no en el piloto. `false` ante la duda.
 */
export function serviciosDeAdministracion(quien: Quien): Promise<boolean> {
  return configuracion(quien).then((c) => c.serviciosDeAdministracion);
}

/**
 * Si ESTA cuenta sube los videos de sus publicaciones a S3 (opcion B).
 *
 * Como Servicios, va por persona: el servidor la enciende para nadie, para una
 * lista de cuentas o para todas, y la app solo recibe un si o un no. Apagada,
 * ausente (servidor viejo) o ante cualquier fallo: `false`, y Reel,
 * Publicacion y Edicion suben a Supabase exactamente como antes. Ver
 * `services/subidaDeVideoS3EnApp.ts`.
 */
export function mediosS3Subida(quien: Quien): Promise<boolean> {
  return configuracion(quien).then((c) => c.mediosS3Subida);
}

/**
 * Si la API firma y entrega los videos en S3. Es el interruptor de emergencia
 * del servidor: apagado, esas publicaciones simplemente no llegan. La app no
 * necesita hacer nada distinto con el; se expone para diagnostico.
 */
export function mediosS3Lectura(quien: Quien): Promise<boolean> {
  return configuracion(quien).then((c) => c.mediosS3Lectura);
}
