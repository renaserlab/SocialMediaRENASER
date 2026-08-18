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

/** Desde donde se pregunta; cambia el mensaje por defecto. */
export type ContextoAuth = 'recuperacion' | 'nueva-contrasena' | 'acceso' | 'registro';

const POR_DEFECTO: Record<ContextoAuth, string> = {
  recuperacion: 'No pudimos enviar el correo de recuperación. Inténtalo de nuevo.',
  'nueva-contrasena': 'No pudimos guardar tu contraseña nueva. Inténtalo de nuevo.',
  acceso: 'No pudimos iniciar sesión. Inténtalo de nuevo.',
  registro: 'No pudimos crear tu cuenta. Inténtalo de nuevo.',
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
export function mensajeDeAuth(error: unknown, contexto: ContextoAuth): string {
  registrar(contexto, error);

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
    return 'Sin conexión. Revisa tu internet e inténtalo de nuevo.';
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
      return `Acabamos de enviarte un correo. Espera ${segundos} segundos antes de pedir otro.`;
    }
    return 'Has hecho demasiados intentos. Espera unos minutos e inténtalo de nuevo.';
  }

  // --- El enlace del correo ya no sirve. ---
  if (/otp_expired|expired|access_denied/i.test(texto)) {
    return 'El enlace de recuperación ha caducado. Solicita uno nuevo.';
  }

  // --- La sesion de recuperacion se perdio por el camino. ---
  if (
    nombre === 'AuthSessionMissingError' ||
    /session.?(not.?found|missing)|missing sub claim|jwt expired|invalid.?claim/i.test(texto)
  ) {
    return 'Tu enlace de recuperación ha caducado. Pide uno nuevo para crear tu contraseña.';
  }

  // --- Contrasena nueva rechazada. ---
  if (/same_password|should be different from the old/i.test(texto)) {
    return 'La contraseña nueva debe ser distinta de la anterior.';
  }
  if (/weak_password|password should be at least|password is too short/i.test(texto)) {
    return 'La contraseña es demasiado corta. Usa al menos 6 caracteres.';
  }
  if (/pwned|compromised/i.test(texto)) {
    return 'Esa contraseña aparece en filtraciones conocidas. Elige otra distinta.';
  }

  // --- Correo mal escrito. ---
  if (/validation_failed|unable to validate email|invalid format/i.test(texto)) {
    return 'Ese correo no parece válido. Revísalo e inténtalo de nuevo.';
  }

  // --- Credenciales de acceso. ---
  if (/invalid_credentials|invalid login credentials|invalid grant/i.test(texto)) {
    return 'Correo o contraseña incorrectos.';
  }
  if (/email_not_confirmed|email not confirmed/i.test(texto)) {
    return 'Todavía no has confirmado tu correo. Busca el mensaje de bienvenida y pulsa el enlace.';
  }
  if (/user_already_exists|email_exists|already registered/i.test(texto)) {
    return 'Ese correo ya tiene una cuenta. Inicia sesión o recupera tu contraseña.';
  }
  if (/user_banned/i.test(texto)) {
    return 'Esta cuenta está suspendida. Escríbenos si crees que es un error.';
  }
  if (/signup.?disabled|email_provider_disabled/i.test(texto)) {
    return 'El registro no está disponible en este momento. Inténtalo más tarde.';
  }

  // --- El correo no llego a salir (SMTP caido o mal configurado). ---
  if (/smtp|error sending|email provider|failed to send/i.test(texto)) {
    return contexto === 'recuperacion'
      ? 'No pudimos enviar el correo de recuperación ahora mismo. Inténtalo de nuevo en unos minutos.'
      : 'No pudimos enviar el correo. Inténtalo de nuevo en unos minutos.';
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
      return 'No pudimos enviar el correo de recuperación ahora mismo. Inténtalo de nuevo en unos minutos.';
    }
    return 'El servicio no está disponible ahora mismo. Inténtalo de nuevo en unos minutos.';
  }

  return POR_DEFECTO[contexto];
}
