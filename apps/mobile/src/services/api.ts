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

async function parseError(response: Response): Promise<ApiError> {
  let code = 'http_error';
  let message = `Error ${response.status}`;
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

export type ApiRequestOptions = RequestInit & {
  /** Si true, incluye el header Authorization con el token actual. Default true. */
  auth?: boolean;
};

export async function apiRequest<T>(
  path: string,
  { auth = true, headers, ...init }: ApiRequestOptions = {},
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
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...init, headers: finalHeaders });
  } catch {
    throw new ApiError(
      0,
      'network_error',
      'Sin conexión. Revisa tu internet e inténtalo de nuevo.',
    );
  }

  if (!response.ok) {
    throw await parseError(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export const API_BASE_URL = API_URL;
export const API_V1 = '/api/v1';
