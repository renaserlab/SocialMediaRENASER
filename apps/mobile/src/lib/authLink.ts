import type { TranslationKey } from '@/i18n';

/**
 * Lectura de los enlaces de autenticacion que llegan por correo.
 *
 * Supabase no devuelve la informacion siempre en el mismo sitio: los tokens del
 * flujo implicito viajan en el FRAGMENTO (`#access_token=...`), el codigo del
 * flujo PKCE en la QUERY (`?code=...`) y los fallos —enlace caducado o ya
 * usado— tambien en el fragmento (`#error_code=otp_expired`). Aqui se leen las
 * dos partes y se devuelve una sola estructura, para que el resto de la
 * aplicacion no tenga que saber por donde vino cada cosa.
 */

export type EnlaceAuth = {
  /** `recovery`, `signup`, `magiclink`... segun el correo del que venga. */
  tipo: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  /** Codigo de un solo uso del flujo PKCE. */
  code: string | null;
  /** `otp_expired`, `access_denied`... cuando el enlace ya no sirve. */
  errorCode: string | null;
  /** Texto tecnico de Supabase. Vale para el log, NUNCA para la pantalla. */
  errorDescription: string | null;
};

const VACIO: EnlaceAuth = {
  tipo: null,
  accessToken: null,
  refreshToken: null,
  code: null,
  errorCode: null,
  errorDescription: null,
};

/** Une los parametros de la query y del fragmento en un solo mapa. */
function parametros(url: string): URLSearchParams {
  const unidos = new URLSearchParams();

  // Se corta primero por '#' para no meter el fragmento dentro de la query.
  const [antesDelHash = '', ...restoHash] = url.split('#');
  const fragmento = restoHash.join('#');
  const query = antesDelHash.split('?').slice(1).join('?');

  for (const trozo of [query, fragmento]) {
    if (!trozo) continue;
    for (const [clave, valor] of new URLSearchParams(trozo)) {
      if (valor) unidos.set(clave, valor);
    }
  }
  return unidos;
}

/**
 * Devuelve lo que trae el enlace, o `null` si no es un enlace de Supabase.
 *
 * Distinguir «no es un enlace de auth» de «es un enlace roto» importa: la
 * aplicacion se abre tambien desde enlaces normales (una publicacion, un
 * perfil) y esos no deben acabar en la pantalla de contrasena.
 */
export function leerEnlaceAuth(url: string | null | undefined): EnlaceAuth | null {
  if (!url) return null;

  const p = parametros(url);
  const enlace: EnlaceAuth = {
    ...VACIO,
    tipo: p.get('type'),
    accessToken: p.get('access_token'),
    refreshToken: p.get('refresh_token'),
    code: p.get('code'),
    errorCode: p.get('error_code') ?? p.get('error'),
    errorDescription: p.get('error_description'),
  };

  const traeAlgo =
    enlace.accessToken || enlace.code || enlace.errorCode || enlace.tipo;
  return traeAlgo ? enlace : null;
}

/** ¿Este enlace es el del correo de «he olvidado mi contrasena»? */
export function esEnlaceDeRecuperacion(enlace: EnlaceAuth): boolean {
  return enlace.tipo === 'recovery';
}

/**
 * Traduce el fallo que viene EN EL PROPIO ENLACE a algo que se pueda leer.
 *
 * Se llega aqui cuando el correo es viejo, ya se uso o alguien retoco la URL.
 * El texto original de Supabase («Email link is invalid or has expired») queda
 * para el log; al usuario se le dice que hacer, no que fallo.
 */

/**
 * Cómo se traduce lo que sale de aquí.
 *
 * Lo pasa quien pinta. Este módulo NO puede importar el diccionario: se prueba
 * con el runner de Node, que no resuelve el alias `@/`. Sin traductor se
 * escribe en español, que es el idioma de referencia.
 */
export type Traductor = (
  clave: TranslationKey,
  params?: Record<string, string | number>,
) => string;

/**
 * El español de cada clave. Es el mismo texto que hay en `i18n/es.ts`, y que no
 * se desvíen lo comprueba `i18n/diccionariosSincronizados.test.mts`.
 */
export const RESPALDOS_ES = {
  'authError.linkExpired': 'El enlace de recuperación ha caducado. Solicita uno nuevo.',
  'authLink.alreadyUsed':
    'Este enlace ya no es válido. Puede que se haya usado antes o que hayas pedido otro más reciente.',
  'authLink.cannotOpen': 'No pudimos abrir el enlace de recuperación. Solicita uno nuevo.',
} as const;

const enEspanol: Traductor = (clave, params) => {
  let texto: string = RESPALDOS_ES[clave as keyof typeof RESPALDOS_ES] ?? '';
  for (const [nombre, valor] of Object.entries(params ?? {})) {
    texto = texto.replace(`{${nombre}}`, String(valor));
  }
  return texto;
};

export function mensajeDeEnlace(enlace: EnlaceAuth, traducir: Traductor = enEspanol): string {
  const codigo = enlace.errorCode ?? '';

  if (/otp_expired|expired/i.test(codigo)) {
    return traducir('authError.linkExpired');
  }
  if (/access_denied|invalid|used/i.test(codigo)) {
    return traducir('authLink.alreadyUsed');
  }
  return traducir('authLink.cannotOpen');
}
