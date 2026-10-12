import type { TranslationKey } from '@/i18n';

/**
 * Traduccion de los fallos de Supabase Auth a lenguaje de persona.
 *
 * El problema que resuelve: `error.message` de Supabase esta en ingles y
 * describe el fallo del servidor, no lo que puede hacer quien lo lee
 * («AuthApiError», «invalid_grant», «Unable to validate email address:
 * invalid format», «Failed to fetch»). Pintado en rojo bajo un campo, parece
 * que la aplicacion se ha roto.
 *
 * Regla: el detalle tecnico se conserva ENTERO en la consola —que es donde
 * sirve para arreglar algo— y a la pantalla solo sale una frase que dice que
 * ha pasado y que hacer a continuacion.
 *
 * Y un limite que no se cruza: en la recuperacion de contrasena jamas se dice
 * si un correo tiene cuenta o no. Revelarlo convierte el formulario en un
 * comprobador de quien esta registrado en la aplicacion.
 */

/**
 * Cómo se traduce lo que sale de aquí.
 *
 * Lo pasa la pantalla, que es React y tiene `useTranslation`. Este módulo NO
 * puede importar el diccionario: se prueba con el runner de Node, que no
 * resuelve el alias `@/`, y un import de valor dejaría la prueba sin arrancar.
 * Sin traductor se escribe en español, que es el idioma de referencia.
 */
export type TraductorDeAuth = (
  clave: TranslationKey,
  params?: Record<string, string | number>,
) => string;

/**
 * El español de cada clave.
 *
 * Es el mismo texto que hay en `i18n/es.ts`, y que no se desvíen lo comprueba
 * `i18n/diccionariosSincronizados.test.mts`: si alguien cambia uno y olvida el
 * otro, esa prueba falla.
 */
export const RESPALDOS_ES = {
  'authError.defaultRecovery': 'No pudimos enviar el correo de recuperación. Inténtalo de nuevo.',
  'authError.defaultNewPassword': 'No pudimos guardar tu contraseña nueva. Inténtalo de nuevo.',
  'authError.defaultSignIn': 'No pudimos iniciar sesión. Inténtalo de nuevo.',
  'authError.defaultSignUp': 'No pudimos crear tu cuenta. Inténtalo de nuevo.',
  'authError.offline': 'Sin conexión. Revisa tu internet e inténtalo de nuevo.',
  'authError.waitSeconds':
    'Acabamos de enviarte un correo. Espera {segundos} segundos antes de pedir otro.',
  'authError.tooManyAttempts': 'Has hecho demasiados intentos. Espera unos minutos e inténtalo de nuevo.',
  'authError.linkExpired': 'El enlace de recuperación ha caducado. Solicita uno nuevo.',
  'authError.sessionLost':
    'Tu enlace de recuperación ha caducado. Pide uno nuevo para crear tu contraseña.',
  'authError.samePassword': 'La contraseña nueva debe ser distinta de la anterior.',
  'authError.weakPassword': 'La contraseña es demasiado corta. Usa al menos 6 caracteres.',
  'authError.pwnedPassword': 'Esa contraseña aparece en filtraciones conocidas. Elige otra distinta.',
  'authError.invalidEmail': 'Ese correo no parece válido. Revísalo e inténtalo de nuevo.',
  'authError.badCredentials': 'Correo o contraseña incorrectos.',
  'authError.emailNotConfirmed':
    'Todavía no has confirmado tu correo. Busca el mensaje de bienvenida y toca el enlace.',
  'authError.emailTaken': 'Ese correo ya tiene una cuenta. Inicia sesión o recupera tu contraseña.',
  'authError.banned': 'Esta cuenta está suspendida. Escríbenos si crees que es un error.',
  'authError.signupDisabled': 'El registro no está disponible en este momento. Inténtalo más tarde.',
  'authError.mailFailedRecovery':
    'No pudimos enviar el correo de recuperación ahora mismo. Inténtalo de nuevo en unos minutos.',
  'authError.mailFailed': 'No pudimos enviar el correo. Inténtalo de nuevo en unos minutos.',
  'authError.serviceDown': 'El servicio no está disponible ahora mismo. Inténtalo de nuevo en unos minutos.',
} as const;

/** El respaldo en español, con sus huecos ya sustituidos. */
const enEspanol: TraductorDeAuth = (clave, params) => {
  let texto: string = RESPALDOS_ES[clave as keyof typeof RESPALDOS_ES] ?? clave;
  for (const [nombre, valor] of Object.entries(params ?? {})) {
    texto = texto.replace(`{${nombre}}`, String(valor));
  }
  return texto;
};

/** Desde donde se pregunta; cambia el mensaje por defecto. */
export type ContextoAuth = 'recuperacion' | 'nueva-contrasena' | 'acceso' | 'registro';

/*
  Los textos viven en el diccionario, no aqui: son de los que mas se leen —basta
  con equivocarse de contraseña— y en ingles o portugues tienen que leerse en
  ingles o en portugues. Aqui se guardan las CLAVES; el idioma lo pone
  `traduceEnElIdiomaActual`, que es la unica forma de traducir fuera de React.
*/
const POR_DEFECTO: Record<ContextoAuth, TranslationKey> = {
  recuperacion: 'authError.defaultRecovery',
  'nueva-contrasena': 'authError.defaultNewPassword',
  acceso: 'authError.defaultSignIn',
  registro: 'authError.defaultSignUp',
};

type DatosDeError = { message: string; code: string; status: number; nombre: string };

/** Saca lo poco que se puede dar por seguro de algo que ha sido lanzado. */
function leerError(error: unknown): DatosDeError {
  const e = error as
    | { message?: unknown; code?: unknown; status?: unknown; name?: unknown }
    | null
    | undefined;
  return {
    message: typeof e?.message === 'string' ? e.message : '',
    code: typeof e?.code === 'string' ? e.code : '',
    status: typeof e?.status === 'number' ? e.status : 0,
    nombre: typeof e?.name === 'string' ? e.name : '',
  };
}

/**
 * Deja el fallo completo en la consola.
 *
 * No se filtra por entorno a proposito: en una compilacion de produccion la
 * consola no la ve nadie salvo quien conecta el depurador, y cuando algo falla
 * en el telefono de un usuario esta es la unica pista que queda.
 */
function registrar(contexto: ContextoAuth, error: unknown): void {
  console.warn(`[auth:${contexto}]`, error);
}

/**
 * Mensaje para la pantalla. Nunca devuelve el texto original de Supabase.
 */
export function mensajeDeAuth(
  error: unknown,
  contexto: ContextoAuth,
  traducir?: TraductorDeAuth,
): string {
  registrar(contexto, error);
  const t = traducir ?? enEspanol;

  const { message, code, status, nombre } = leerError(error);
  const texto = `${code} ${message}`;

  /*
    --- Sin red de verdad. ---

    Cuidado con `AuthRetryableFetchError`: supabase-js lo usa para DOS cosas
    distintas. Un fallo real de conexion lo lanza con `status: 0`, pero
    CUALQUIER respuesta 5xx del servidor tambien acaba en esa misma clase, con
    el status real dentro (ver NETWORK_ERROR_CODES en auth-js).

    Mirar solo el nombre de la clase hacia que un error del servidor se
    anunciara como «Sin conexión. Revisa tu internet». Es de los mensajes mas
    daninos que se pueden dar: manda a la persona a revisar su wifi, que esta
    perfecto, mientras el problema real esta al otro lado y no depende de ella.
  */
  const fallaLaConexion =
    (nombre === 'AuthRetryableFetchError' && status === 0) ||
    /failed to fetch|network request failed|networkerror|load failed/i.test(texto);
  if (fallaLaConexion) {
    return t('authError.offline');
  }

  // --- Demasiados intentos. ---
  if (status === 429 || /rate.?limit|too many/i.test(texto)) {
    /*
      Supabase impone DOS limites distintos y conviene no confundirlos: una
      espera entre envios al MISMO correo (dice los segundos exactos) y un tope
      por hora del proyecto. Si nos dice los segundos, se los damos, que es
      accionable; si no, se pide paciencia sin numeros inventados.
    */
    const segundos = message.match(/after (\d+) seconds?/i)?.[1];
    if (segundos) {
      return t('authError.waitSeconds', { segundos });
    }
    return t('authError.tooManyAttempts');
  }

  // --- El enlace del correo ya no sirve. ---
  if (/otp_expired|expired|access_denied/i.test(texto)) {
    return t('authError.linkExpired');
  }

  // --- La sesion de recuperacion se perdio por el camino. ---
  if (
    nombre === 'AuthSessionMissingError' ||
    /session.?(not.?found|missing)|missing sub claim|jwt expired|invalid.?claim/i.test(texto)
  ) {
    return t('authError.sessionLost');
  }

  // --- Contrasena nueva rechazada. ---
  if (/same_password|should be different from the old/i.test(texto)) {
    return t('authError.samePassword');
  }
  if (/weak_password|password should be at least|password is too short/i.test(texto)) {
    return t('authError.weakPassword');
  }
  if (/pwned|compromised/i.test(texto)) {
    return t('authError.pwnedPassword');
  }

  // --- Correo mal escrito. ---
  if (/validation_failed|unable to validate email|invalid format/i.test(texto)) {
    return t('authError.invalidEmail');
  }

  // --- Credenciales de acceso. ---
  if (/invalid_credentials|invalid login credentials|invalid grant/i.test(texto)) {
    return t('authError.badCredentials');
  }
  if (/email_not_confirmed|email not confirmed/i.test(texto)) {
    return t('authError.emailNotConfirmed');
  }
  if (/user_already_exists|email_exists|already registered/i.test(texto)) {
    return t('authError.emailTaken');
  }
  if (/user_banned/i.test(texto)) {
    return t('authError.banned');
  }
  if (/signup.?disabled|email_provider_disabled/i.test(texto)) {
    return t('authError.signupDisabled');
  }

  // --- El correo no llego a salir (SMTP caido o mal configurado). ---
  if (/smtp|error sending|email provider|failed to send/i.test(texto)) {
    return contexto === 'recuperacion'
      ? t('authError.mailFailedRecovery')
      : t('authError.mailFailed');
  }

  /*
    --- El servidor tuvo un problema suyo. ---

    En un 5xx supabase-js ni siquiera lee el cuerpo de la respuesta, asi que
    aqui no llega el detalle («Error sending recovery email» y demas): solo el
    numero. Por eso se responde segun DESDE DONDE se pregunta, que es la unica
    pista fiable que queda. Pidiendo un correo de recuperacion, un 5xx es casi
    siempre que el envio no salio.
  */
  if (status >= 500) {
    if (contexto === 'recuperacion') {
      return t('authError.mailFailedRecovery');
    }
    return t('authError.serviceDown');
  }

  return t(POR_DEFECTO[contexto]);
}
