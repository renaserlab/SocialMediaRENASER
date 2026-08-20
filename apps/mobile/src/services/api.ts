const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000';

/**
 * Proveedor de token de acceso. Lo configura la capa de auth (AuthRepository)
 * para que cada request lleve el JWT de Supabase sin que las pantallas lo sepan.
 */
type TokenProvider = () => Promise<string | null>;
let tokenProvider: TokenProvider | null = null;

export function setAuthTokenProvider(provider: TokenProvider | null): void {
  tokenProvider = provider;
}

/** Error uniforme del backend: { error: { code, message, details } }. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Que decir cuando el servidor falla sin explicarse.
 *
 * El texto de respaldo era `Error ${status}`, y ese literal acababa impreso en
 * la pantalla: quien abria la aplicacion leia «Error 500» donde deberia haber
 * un feed. Un numero de estado no le dice nada a quien lo lee ni sugiere que
 * hacer. El estado sigue viajando en `ApiError.status` para quien depura.
 */
function mensajePorEstado(status: number): string {
  if (status === 401 || status === 403) {
    return 'Tu sesión ha caducado. Inicia sesión de nuevo.';
  }
  if (status === 404) return 'No encontramos lo que buscabas.';
  if (status === 429) return 'Demasiadas peticiones. Espera un momento e inténtalo de nuevo.';
  if (status >= 500) {
    return 'El servidor no está disponible ahora mismo. Inténtalo de nuevo en unos minutos.';
  }
  return 'No pudimos completar la operación. Inténtalo de nuevo.';
}

async function parseError(response: Response): Promise<ApiError> {
  let code = 'http_error';
  // Solo es el respaldo: si el backend manda su propio mensaje, manda el suyo.
  let message = mensajePorEstado(response.status);
  let details: unknown;
  try {
    const body = await response.json();
    if (body?.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
      details = body.error.details;
    }
  } catch {
    // respuesta sin cuerpo JSON: dejamos los valores por defecto.
  }
  return new ApiError(response.status, code, message, details);
}

/**
 * Cuanto se espera como maximo por una respuesta, en milisegundos.
 *
 * Sin limite, una conexion mala no falla: se queda esperando. La pantalla se
 * queda «cargando» indefinidamente, sin error y sin nada que reintentar, y da
 * la impresion de que la aplicacion se ha colgado.
 *
 * Veinte segundos son holgados para una respuesta normal —incluso con el
 * servidor recien despertado— y lo bastante cortos para no dejar a nadie
 * mirando una pantalla vacia.
 */
const ESPERA_MAXIMA_MS = 20_000;

export type ApiRequestOptions = RequestInit & {
  /** Si true, incluye el header Authorization con el token actual. Default true. */
  auth?: boolean;
  /** Espera maxima propia, para operaciones que legitimamente tardan mas. */
  timeoutMs?: number;
};

export async function apiRequest<T>(
  path: string,
  { auth = true, headers, timeoutMs = ESPERA_MAXIMA_MS, ...init }: ApiRequestOptions = {},
): Promise<T> {
  const finalHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(headers as Record<string, string> | undefined),
  };

  if (auth && tokenProvider) {
    const token = await tokenProvider();
    if (token) {
      finalHeaders.Authorization = `Bearer ${token}`;
    }
  }

  /*
    Un fallo de red no es lo mismo que un error del servidor, y conviene no
    confundirlos: si el telefono no tiene cobertura, `fetch` lanza sin llegar a
    responder nada. Sin este envoltorio salia un fallo tecnico sin capturar, y
    la pantalla mostraba «No pudimos cargar la informacion», que no dice que el
    problema esta en la conexion y no en la aplicacion.
  */
  const control = new AbortController();
  const corte = setTimeout(() => control.abort(), timeoutMs);

  /*
    Si quien llama trae su propia cancelacion, se encadena a la nuestra en vez
    de sustituirla: pasando la suya directamente al fetch, el corte por tiempo
    se quedaria sin efecto y volveriamos a tener esperas sin fin.
  */
  const externa = init.signal;
  const propagar = () => control.abort();
  if (externa) {
    if (externa.aborted) control.abort();
    else externa.addEventListener('abort', propagar, { once: true });
  }

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: finalHeaders,
      signal: control.signal,
    });
  } catch (fallo) {
    // Agotar la espera y quedarse sin cobertura son cosas distintas y conviene
    // decirlas distinto: en un caso el servidor no contesta, en el otro no hay
    // por donde preguntar.
    // Cancelacion pedida por quien llama (cambio de pantalla, nueva busqueda):
    // no es un fallo que haya que contar a nadie, se deja pasar tal cual.
    if (externa?.aborted) throw fallo;
    if (control.signal.aborted) {
      throw new ApiError(
        0,
        'timeout',
        'El servidor está tardando demasiado en responder. Inténtalo de nuevo.',
      );
    }
    throw new ApiError(
      0,
      'network_error',
      'Sin conexión. Revisa tu internet e inténtalo de nuevo.',
    );
  } finally {
    clearTimeout(corte);
    externa?.removeEventListener('abort', propagar);
  }

  if (!response.ok) {
    throw await parseError(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

/**
 * Despierta el servidor sin esperar respuesta.
 *
 * El backend vive en el plan gratuito de Render, que SUSPENDE la instancia
 * tras un rato sin trafico y tarda ~20-25 segundos en levantarla (medido
 * contra produccion). Si la primera peticion que la despierta es la del feed,
 * el usuario mira una pantalla vacia todo ese tiempo.
 *
 * Llamando a /health en cuanto arranca la aplicacion, el servidor se levanta
 * EN PARALELO mientras la persona ya esta viendo el contenido cacheado. Para
 * cuando el feed de red se pide (o se reintenta), la instancia suele estar
 * lista. Si ya estaba despierta, esta llamada cuesta ~250 ms y nada mas.
 */
export function warmUpApi(): void {
  fetch(`${API_URL}/health`).catch(() => {
    // Sin conexion o servidor caido: el feed ya ensena su propio error.
  });
}

export const API_BASE_URL = API_URL;
export const API_V1 = '/api/v1';
