import { Platform } from 'react-native';
import type { Session } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';

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

  /** Suscripcion a cambios de sesion (login/logout/refresh). Devuelve unsubscribe. */
  onAuthStateChange(callback: (session: Session | null) => void): () => void {
    if (!supabase) return () => {};
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      callback(session);
    });
    return () => data.subscription.unsubscribe();
  },
};
