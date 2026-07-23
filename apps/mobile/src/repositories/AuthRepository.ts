import { Platform } from 'react-native';
import type { Session } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';

import { apiRequest, API_V1 } from '@/services/api';
import { supabase, isSupabaseConfigured } from '@/services/supabase';

/** Proveedores externos ofrecidos en las pantallas de acceso. */
export type OAuthProvider = 'google' | 'apple';

/**
 * El proveedor existe en Supabase pero no esta activado en el panel.
 * Se distingue para poder decirlo con claridad en vez de un error tecnico.
 */
export class ProviderNotEnabledError extends Error {
  constructor(provider: OAuthProvider) {
    super(
      `El acceso con ${provider === 'google' ? 'Google' : 'Apple'} aún no está activado.`,
    );
    this.name = 'ProviderNotEnabledError';
  }
}

/** Lee tokens tanto del fragmento (#) como de la query (?) de la URL. */
function extractTokens(url: string): { access: string; refresh: string } | null {
  const raw = url.split('#')[1] ?? url.split('?')[1] ?? '';
  const params = new URLSearchParams(raw);
  const access = params.get('access_token');
  const refresh = params.get('refresh_token');
  return access && refresh ? { access, refresh } : null;
}

/**
 * Error para cuando Supabase no esta configurado (falta EXPO_PUBLIC_SUPABASE_*).
 * Permite que la UI caiga al modo demo local sin romperse.
 */
export class AuthNotConfiguredError extends Error {
  constructor() {
    super('Supabase Auth no esta configurado.');
    this.name = 'AuthNotConfiguredError';
  }
}

export type SignUpInput = { fullName: string; email: string; password: string };
export type SignInInput = { email: string; password: string };

export type SignUpResult = {
  /** true si Supabase requiere confirmar el correo antes de iniciar sesion. */
  needsEmailConfirmation: boolean;
  session: Session | null;
};

function requireClient() {
  if (!supabase) throw new AuthNotConfiguredError();
  return supabase;
}

export const AuthRepository = {
  get enabled(): boolean {
    return isSupabaseConfigured;
  },

  /**
   * Crea la cuenta en Supabase Auth. El nombre viaja en user_metadata para que
   * el trigger handle_new_user cree el perfil en public.profiles.
   */
  async signUp({ fullName, email, password }: SignUpInput): Promise<SignUpResult> {
    const client = requireClient();
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } },
    });
    if (error) throw error;
    return {
      session: data.session,
      needsEmailConfirmation: data.session === null,
    };
  },

  async signIn({ email, password }: SignInInput): Promise<Session> {
    const client = requireClient();
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.session;
  },

  /**
   * Acceso con un proveedor externo (Google / Apple).
   *
   * Web: Supabase redirige la pagina entera y la sesion se recoge al volver
   * (por eso `detectSessionInUrl` esta activo en web).
   * Nativo: se abre un navegador seguro del sistema y, al volver al esquema
   * `renaser://`, se leen los tokens de la URL y se establece la sesion.
   */
  async signInWithProvider(provider: OAuthProvider): Promise<void> {
    const client = requireClient();

    if (Platform.OS === 'web') {
      const { error } = await client.auth.signInWithOAuth({
        provider,
        options: { redirectTo: window.location.origin },
      });
      if (error) throw AuthRepository._describeOAuthError(error, provider);
      // La pagina navega a Google; no hay nada mas que hacer aqui.
      return;
    }

    const redirectTo = Linking.createURL('auth-callback');
    const { data, error } = await client.auth.signInWithOAuth({
      provider,
      // En nativo abrimos el navegador nosotros, no la libreria.
      options: { redirectTo, skipBrowserRedirect: true },
    });
    if (error) throw AuthRepository._describeOAuthError(error, provider);
    if (!data?.url) throw new Error('No se pudo iniciar el acceso.');

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    // El usuario cerro el navegador: no es un error.
    if (result.type !== 'success') return;

    const tokens = extractTokens(result.url);
    if (!tokens) throw new Error('No se pudo completar el acceso.');
    const { error: sessionError } = await client.auth.setSession({
      access_token: tokens.access,
      refresh_token: tokens.refresh,
    });
    if (sessionError) throw sessionError;
  },

  /** Traduce el error de Supabase cuando el proveedor no esta habilitado. */
  _describeOAuthError(error: { message?: string }, provider: OAuthProvider): Error {
    if (/not enabled|unsupported provider|provider is not/i.test(error?.message ?? '')) {
      return new ProviderNotEnabledError(provider);
    }
    return error instanceof Error ? error : new Error(error?.message ?? 'Error de acceso.');
  },

  async signOut(): Promise<void> {
    if (!supabase) return;
    await supabase.auth.signOut();
  },

  /**
   * Borra la cuenta de forma permanente y cierra la sesion.
   *
   * Primero el backend, que elimina el usuario y todo su contenido; solo si eso
   * responde bien se cierra la sesion local. Al reves —cerrar sesion antes— se
   * perderia el token y la peticion de borrado iria sin autenticar: la cuenta
   * quedaria a medio eliminar.
   */
  async deleteAccount(): Promise<void> {
    await apiRequest<void>(`${API_V1}/auth/me`, { method: 'DELETE' });
    if (supabase) await supabase.auth.signOut();
  },

  async getSession(): Promise<Session | null> {
    if (!supabase) return null;
    const { data } = await supabase.auth.getSession();
    return data.session;
  },

  /** Token de acceso actual (para inyectar en las llamadas al backend). */
  async getAccessToken(): Promise<string | null> {
    const session = await AuthRepository.getSession();
    return session?.access_token ?? null;
  },

  /**
   * Envia el correo con el enlace para restablecer la contrasena.
   *
   * `redirectTo` debe estar dado de alta en Supabase (Authentication -> URL
   * Configuration -> Redirect URLs) o el enlace lleva al sitio por defecto.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const client = requireClient();
    const redirectTo =
      Platform.OS === 'web'
        ? `${window.location.origin}/reset-password`
        : Linking.createURL('reset-password');
    const { error } = await client.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo,
    });
    if (error) throw AuthRepository._describeResetError(error);
  },

  /**
   * Cambia la contrasena del usuario con sesion abierta.
   *
   * Tras pulsar el enlace del correo, Supabase abre una sesion de recuperacion:
   * es esa sesion la que autoriza el cambio, no hace falta la contrasena vieja.
   */
  async updatePassword(password: string): Promise<void> {
    const client = requireClient();
    const { error } = await client.auth.updateUser({ password });
    if (error) throw error;
  },

  /** Traduce los errores mas habituales del envio a algo accionable. */
  _describeResetError(error: { message?: string; status?: number }): Error {
    const message = error?.message ?? '';
    if (error?.status === 429 || /rate limit|too many/i.test(message)) {
      /*
        Supabase impone DOS limites distintos y conviene no confundirlos:
        - una espera entre envios al MISMO correo (dice los segundos exactos),
        - y un tope por hora del proyecto.
        Si nos dice los segundos, se los damos al usuario en vez de un vago
        "espera un momento".
      */
      const seconds = message.match(/after (\d+) seconds?/i)?.[1];
      if (seconds) {
        return new Error(
          `Acabamos de enviarte un correo. Espera ${seconds} segundos antes de pedir otro.`,
        );
      }
      return new Error(
        'Se alcanzó el límite de envíos. Espera unos minutos e inténtalo de nuevo.',
      );
    }
    if (/smtp|email provider/i.test(message)) {
      return new Error('El servidor de correo no está configurado. Avisa al administrador.');
    }
    return error instanceof Error ? error : new Error(message || 'No se pudo enviar el correo.');
  },

  /**
   * Suscripcion a cambios de sesion. Ademas de la sesion informa del EVENTO,
   * porque `PASSWORD_RECOVERY` hay que distinguirlo: al volver del correo
   * Supabase abre sesion, y sin diferenciarlo el usuario entraria directo al
   * feed sin llegar a cambiar la contrasena.
   */
  onAuthStateChange(
    callback: (session: Session | null, event?: string) => void,
  ): () => void {
    if (!supabase) return () => {};
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      callback(session, event);
    });
    return () => data.subscription.unsubscribe();
  },
};
