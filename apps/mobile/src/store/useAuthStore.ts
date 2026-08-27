import { create } from 'zustand';

import {
  AuthRepository,
  OAuthProvider,
  SignInInput,
  SignUpInput,
  SignUpResult,
} from '@/repositories/AuthRepository';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import { esEnlaceDeRecuperacion, mensajeDeEnlace } from '@/lib/authLink';
import { perfMark } from '@/lib/perf';
import { setAuthTokenProvider, ApiError } from '@/services/api';
import { enlaceAuthInicial } from '@/services/supabase';
import { registerForPush, unregisterPush } from '@/services/notifications';
import { sincronizarAlEntrar } from '@/services/compras';
import { cerrarSesion as cerrarSesionDeCompras } from '@/services/revenueCat';
import { descartar as descartarSenales } from '@/services/senales';
import { olvidarFirmasDeAdjuntos } from '@/services/messageMedia';
import { clearSignedUrlCache } from '@/services/storage';
import { olvidarPerfiles } from '@/services/cachePerfil';
import { useAppStore } from '@/store/useAppStore';
import { usePreferenciasStore } from '@/store/usePreferenciasStore';
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
  /**
   * Por que no se pudo abrir el enlace del correo, ya en lenguaje de persona.
   * Lo pinta ResetPasswordScreen: sin esto la pantalla decia siempre «enlace no
   * valido o caducado» aunque el motivo real fuera otro.
   */
  recoveryError: string | null;
  /** Marca que hay sesion de recuperacion en curso (la abre el enlace). */
  startPasswordRecovery: () => void;
  /** Guarda el motivo por el que el enlace no sirvio. */
  setRecoveryError: (message: string | null) => void;
  requestPasswordReset: (email: string) => Promise<void>;
  updatePassword: (password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Borra la cuenta y todo su contenido, luego cierra sesion. */
  deleteAccount: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  updateProfile: (patch: ProfilePatch) => Promise<void>;
};

let unsubscribeAuth: (() => void) | null = null;

/**
 * Pregunta al servidor si a esta persona le toca el cuestionario de
 * recomendacion. Se dispara junto al perfil, no antes: es informacion para
 * decidir una ruta, no permiso de acceso, y nada debe esperarla.
 */
function resolverCuestionario(usuarioId: string | undefined): void {
  if (!usuarioId) return;
  void usePreferenciasStore.getState().cargarEstado(usuarioId);
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'loading',
  supabaseEnabled: AuthRepository.enabled,
  initialized: false,
  profileError: null,
  passwordRecovery: false,
  recoveryError: null,

  startPasswordRecovery() {
    set({ passwordRecovery: true, recoveryError: null });
  },

  setRecoveryError(message) {
    // Un motivo nuevo cancela la recuperacion en curso: si el enlace no sirve,
    // no hay sesion que aprovechar y dejar la marca puesta atraparia al usuario
    // en la pantalla de contrasena nueva sin poder guardarla.
    set({ recoveryError: message, passwordRecovery: message ? false : get().passwordRecovery });
  },

  async bootstrap() {
    if (get().initialized) return;
    set({ initialized: true });

    if (!AuthRepository.enabled) {
      // Modo demo: sin backend real. La app sigue funcionando con datos locales.
      set({ status: 'anonymous', supabaseEnabled: false });
      return;
    }

    // La ultima tanda de publicaciones guardada se pinta sin esperar a nada.
    void useAppStore.getState().hydrateFeedFromCache();

    // Cada request al backend llevara el JWT actual de Supabase.
    setAuthTokenProvider(() => AuthRepository.getAccessToken());

    /*
      El enlace del correo abierto EN EL NAVEGADOR se resuelve solo: supabase-js
      lee el fragmento de la direccion al arrancar. Pero si el enlace venia
      caducado no hay sesion y tampoco evento, asi que sin mirar la URL de
      entrada la aplicacion no tenia forma de explicar por que. `enlaceAuthInicial`
      guarda ese motivo antes de que la libreria limpie la direccion.
    */
    if (enlaceAuthInicial?.errorCode) {
      console.warn('[auth] el enlace de entrada traia un error', enlaceAuthInicial);
      set({ recoveryError: mensajeDeEnlace(enlaceAuthInicial) });
    } else if (enlaceAuthInicial && esEnlaceDeRecuperacion(enlaceAuthInicial)) {
      // La sesion la abre supabase-js; aqui solo se deja constancia de que este
      // arranque viene de una recuperacion, para no colar al usuario en el feed
      // si el evento PASSWORD_RECOVERY llega antes de que nadie escuche.
      set({ passwordRecovery: true });
    }

    /*
      La suscripcion va ANTES de resolver la sesion, no despues.

      `getSession()` espera a que supabase-js termine de arrancar, y es durante
      ese arranque cuando emite `PASSWORD_RECOVERY` al detectar el enlace en la
      direccion. Suscribiendose despues, ese aviso ya habia pasado y se perdia:
      la marca de recuperacion nunca se levantaba y el usuario entraba al feed
      con la contrasena vieja intacta.
    */
    unsubscribeAuth?.();
    unsubscribeAuth = AuthRepository.onAuthStateChange((nextSession, event) => {
      if (event === 'PASSWORD_RECOVERY') set({ passwordRecovery: true, recoveryError: null });
      setTimeout(() => {
        if (nextSession) {
          // Mismo criterio que abajo: la sesion decide, el perfil acompana.
          set({ status: 'authenticated' });
          void get().refreshProfile();
          // Y con el, si a esta persona le toca el cuestionario. Va en
          // paralelo: el arranque lo espera solo un par de segundos.
          void resolverCuestionario(nextSession.user?.id);
          // El dispositivo se registra al iniciar sesion, no al arrancar la
          // app: el permiso se pide cuando ya tiene sentido para quien la usa.
          // Si falla (Expo Go, emulador, permiso denegado) devuelve null y no
          // pasa nada mas: la app funciona igual, sin avisos en el telefono.
          void registerForPush();
          // Y las compras de las tiendas se atan a ESTA cuenta. El
          // `appUserID` de RevenueCat es el UUID de Supabase, nunca el correo:
          // un correo se cambia, y si el identificador cambia se pierden las
          // compras y la persona pagaria dos veces por lo mismo.
          //
          // Es silencioso a proposito, igual que el registro de avisos: entrar
          // en la aplicacion no puede depender de que la tienda responda. Si
          // falla, la siguiente sincronizacion lo recupera, y siempre queda
          // «Restaurar compras» en la pantalla del curso.
          const uuid = nextSession.user?.id;
          if (uuid) void sincronizarAlEntrar(uuid);
        } else {
          useAppStore.getState().setUser(null);
          set({ status: 'anonymous' });
          // Se desata la cuenta de la tienda. Sin esto, quien inicie sesion
          // despues en el mismo telefono heredaria el `appUserID` anterior y
          // con el las compras de otra persona.
          void cerrarSesionDeCompras();
        }
      }, 0);
    });

    try {
      const session = await AuthRepository.getSession();
      perfMark('AUTH_RESTORED');
      if (session) {
        // La sesion basta para entrar. El perfil se pide en paralelo y no se
        // espera: es informacion para pintar la pantalla, no permiso de acceso.
        //
        // Esperarlo dejaba la aplicacion en el indicador de carga mientras el
        // servidor respondia y, si estaba dormido, eso son hasta sesenta
        // segundos mirando una rueda girar.
        set({ status: 'authenticated' });
        void get().refreshProfile();
        void resolverCuestionario(session.user?.id);
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
    set({ passwordRecovery: false, recoveryError: null });
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
    // Y las de los adjuntos de chat aparte, que viven en su propio bucket
    // privado: una firma vigente es un enlace a una conversacion ajena.
    olvidarFirmasDeAdjuntos();
    // Y lo mismo los perfiles ya vistos: quien entre despues en este telefono
    // no tiene por que ver de quien era la cuenta anterior.
    olvidarPerfiles();
    // Lo que sabiamos del cuestionario era de la cuenta anterior, y las
    // senales pendientes tambien: enviarlas ahora las atribuiria a quien entre
    // despues en este mismo telefono.
    descartarSenales();
    usePreferenciasStore.getState().reiniciar();
    set({ passwordRecovery: false, recoveryError: null });
    useAppStore.getState().setUser(null);
    set({ status: 'anonymous' });
  },

  async deleteAccount() {
    // Si el borrado falla se propaga el error y NO se limpia el estado: la
    // sesion sigue viva y la pantalla puede avisar de que no se pudo.
    await AuthRepository.deleteAccount();
    // A partir de aqui es el mismo cierre que signOut: la cuenta ya no existe.
    clearSignedUrlCache();
    olvidarFirmasDeAdjuntos();
    olvidarPerfiles();
    // Lo que sabiamos del cuestionario era de la cuenta anterior, y las
    // senales pendientes tambien: enviarlas ahora las atribuiria a quien entre
    // despues en este mismo telefono.
    descartarSenales();
    usePreferenciasStore.getState().reiniciar();
    set({ passwordRecovery: false, recoveryError: null });
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
