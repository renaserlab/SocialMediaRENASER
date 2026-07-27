import { create } from 'zustand';

import {
  AuthRepository,
  OAuthProvider,
  SignInInput,
  SignUpInput,
  SignUpResult,
} from '@/repositories/AuthRepository';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import { setAuthTokenProvider, ApiError } from '@/services/api';
import { registerForPush, unregisterPush } from '@/services/notifications';
import { clearSignedUrlCache } from '@/services/storage';
import { useAppStore } from '@/store/useAppStore';
import type { UserProfile } from '@/types';

export type ProfilePatch = Partial<Pick<UserProfile, 'fullName' | 'username' | 'bio'>>;

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

type AuthState = {
  status: AuthStatus;
  /** true cuando Supabase esta configurado; false = modo demo local. */
  supabaseEnabled: boolean;
  initialized: boolean;
  /** Mensaje si fallo la carga del perfil (para mostrar reintento en la UI). */
  profileError: string | null;

  bootstrap: () => Promise<void>;
  signUpEmail: (input: SignUpInput) => Promise<SignUpResult>;
  signInEmail: (input: SignInInput) => Promise<void>;
  signInWithProvider: (provider: OAuthProvider) => Promise<void>;
  /**
   * El usuario llego desde el enlace del correo y todavia no ha fijado su nueva
   * contrasena. Mientras sea true, la app lo lleva a /reset-password en vez de
   * al feed: Supabase abre sesion al pulsar el enlace, asi que sin esta marca
   * entraria directo y no cambiaria nada.
   */
  passwordRecovery: boolean;
  requestPasswordReset: (email: string) => Promise<void>;
  updatePassword: (password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Borra la cuenta y todo su contenido, luego cierra sesion. */
  deleteAccount: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  updateProfile: (patch: ProfilePatch) => Promise<void>;
};

let unsubscribeAuth: (() => void) | null = null;

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'loading',
  supabaseEnabled: AuthRepository.enabled,
  initialized: false,
  profileError: null,
  passwordRecovery: false,

  async bootstrap() {
    if (get().initialized) return;
    set({ initialized: true });

    if (!AuthRepository.enabled) {
      // Modo demo: sin backend real. La app sigue funcionando con datos locales.
      set({ status: 'anonymous', supabaseEnabled: false });
      return;
    }

    // Cada request al backend llevara el JWT actual de Supabase.
    setAuthTokenProvider(() => AuthRepository.getAccessToken());

    try {
      const session = await AuthRepository.getSession();
      if (session) {
        // La sesion basta para entrar. El perfil se pide en paralelo y no se
        // espera: es informacion para pintar la pantalla, no permiso de acceso.
        //
        // Esperarlo dejaba la aplicacion en el indicador de carga mientras el
        // servidor respondia y, si estaba dormido, eso son hasta sesenta
        // segundos mirando una rueda girar.
        set({ status: 'authenticated' });
        void get().refreshProfile();
      } else {
        set({ status: 'anonymous' });
      }
    } catch (error) {
      // Si la sesion no se puede resolver (red caida, backend abajo) NO dejamos
      // `status` en 'loading': eso congelaba el spinner de app/index.tsx para
      // siempre. Degradamos a anonimo y liberamos el guard para poder reintentar.
      console.warn('[auth] no se pudo restaurar la sesion; se continua como anonimo', error);
      set({ status: 'anonymous', initialized: false });
      return;
    }

    // Mantiene la sesion sincronizada ante login/logout/refresh de token.
    // El trabajo async se difiere para no llamar a Supabase dentro de su
    // propio callback (evita un posible deadlock documentado en supabase-js).
    unsubscribeAuth?.();
    unsubscribeAuth = AuthRepository.onAuthStateChange((nextSession, event) => {
      if (event === 'PASSWORD_RECOVERY') set({ passwordRecovery: true });
      setTimeout(() => {
        if (nextSession) {
          // Mismo criterio que arriba: la sesion decide, el perfil acompana.
          set({ status: 'authenticated' });
          void get().refreshProfile();
          // El dispositivo se registra al iniciar sesion, no al arrancar la
          // app: el permiso se pide cuando ya tiene sentido para quien la usa.
          // Si falla (Expo Go, emulador, permiso denegado) devuelve null y no
          // pasa nada mas: la app funciona igual, sin avisos en el telefono.
          void registerForPush();
        } else {
          useAppStore.getState().setUser(null);
          set({ status: 'anonymous' });
        }
      }, 0);
    });
  },

  async refreshProfile() {
    // Se reintenta porque justo despues de iniciar sesion la primera peticion
    // puede fallar de forma transitoria (token recien emitido, perfil aun
    // creandose por el trigger). Sin reintento el usuario quedaba a null y la
    // sesion se veia sin perfil hasta recargar la app entera.
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const profile = await ProfileRepository.getMyProfile();
        useAppStore.getState().setUser(profile);
        set({ profileError: null });
        return;
      } catch (error) {
        const isLast = attempt === MAX_ATTEMPTS;

        // Si el perfil aun no existe (trigger en curso) no bloqueamos la sesion.
        if (error instanceof ApiError && error.status === 404 && isLast) {
          set({ profileError: null });
          return;
        }

        if (isLast) {
          set({
            profileError:
              error instanceof Error ? error.message : 'No se pudo cargar el perfil.',
          });
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
    }
  },

  async signUpEmail(input) {
    const result = await AuthRepository.signUp(input);
    if (result.session) {
      set({ status: 'authenticated' });
      // Recien creada la cuenta, el perfil lo escribe un disparador en la base
      // de datos y puede tardar un instante en existir; `refreshProfile` ya
      // reintenta por su cuenta, asi que tampoco aqui hay que esperarlo.
      void get().refreshProfile();
    }
    return result;
  },

  async signInEmail(input) {
    await AuthRepository.signIn(input);
    // Se entra en cuanto la sesion es valida; el perfil llega despues (ver
    // `bootstrap`). Antes se aguardaba a cargarlo y el formulario se quedaba
    // pensando aunque la contrasena ya se hubiera aceptado.
    set({ status: 'authenticated' });
    void get().refreshProfile();
  },

  async signInWithProvider(provider) {
    await AuthRepository.signInWithProvider(provider);
    // En web la pagina se redirige y la sesion se resuelve al volver; en nativo
    // ya tenemos sesion y solo falta cargar el perfil.
    if (await AuthRepository.getSession()) {
      set({ status: 'authenticated' });
      void get().refreshProfile();
    }
  },

  async requestPasswordReset(email) {
    await AuthRepository.requestPasswordReset(email);
  },

  async updatePassword(password) {
    await AuthRepository.updatePassword(password);
    // Cambiada: se levanta la marca y la sesion pasa a ser normal.
    set({ passwordRecovery: false });
    await get().refreshProfile();
    set({ status: 'authenticated' });
  },

  async signOut() {
    // ANTES de cerrar: dar de baja el dispositivo necesita la sesion viva.
    // Sin esto, quien cierra sesion en un telefono compartido seguiria
    // recibiendo los avisos de su cuenta en un aparato que ya no usa.
    await unregisterPush().catch(() => {});
    await AuthRepository.signOut();
    // Las firmas van atadas a la sesion: no deben sobrevivir al cierre.
    clearSignedUrlCache();
    set({ passwordRecovery: false });
    useAppStore.getState().setUser(null);
    set({ status: 'anonymous' });
  },

  async deleteAccount() {
    // Si el borrado falla se propaga el error y NO se limpia el estado: la
    // sesion sigue viva y la pantalla puede avisar de que no se pudo.
    await AuthRepository.deleteAccount();
    // A partir de aqui es el mismo cierre que signOut: la cuenta ya no existe.
    clearSignedUrlCache();
    set({ passwordRecovery: false });
    useAppStore.getState().setUser(null);
    set({ status: 'anonymous' });
  },

  async updateProfile(patch) {
    const appStore = useAppStore.getState();

    // Modo demo: se actualiza el usuario local sin backend.
    if (!AuthRepository.enabled) {
      const current = appStore.user;
      if (current) appStore.setUser({ ...current, ...patch });
      return;
    }

    const updated = await ProfileRepository.updateMyProfile(patch);
    appStore.setUser(updated);
  },
}));
