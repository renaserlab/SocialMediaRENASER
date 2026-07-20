import type { Session } from '@supabase/supabase-js';

import { supabase, isSupabaseConfigured } from '@/services/supabase';

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
