import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Linking from 'expo-linking';
import { useRootNavigationState, useRouter } from 'expo-router';

import { mensajeDeAuth } from '@/lib/authErrors';
import { esEnlaceDeRecuperacion, leerEnlaceAuth, mensajeDeEnlace } from '@/lib/authLink';
import { AuthRepository } from '@/repositories/AuthRepository';
import { useAuthStore } from '@/store/useAuthStore';

/**
 * Atiende los enlaces de correo que abren la aplicacion en el telefono.
 *
 * Por que existe: en nativo `detectSessionInUrl` esta apagado —no hay barra de
 * direcciones que supabase-js pueda mirar— y nadie leia lo que el sistema
 * entrega al abrir `z://reset-password#access_token=...`. El enlace abria la
 * aplicacion, si, pero la sesion de recuperacion no llegaba a crearse: la
 * pantalla de contrasena nueva no encontraba sesion y respondia «Enlace no
 * valido o caducado» SIEMPRE, incluso con un correo recien recibido. Es decir,
 * recuperar la contrasena era imposible desde el movil.
 *
 * Se cubren los dos momentos en que puede llegar el enlace, que son distintos:
 * con la aplicacion cerrada (`getInitialURL`) y con ella ya abierta (evento
 * `url`). Atender solo uno deja la mitad de los casos rotos, y justo el mas
 * comun —abrir el correo con la app en segundo plano— es el segundo.
 *
 * En web no hace nada: alli la sesion la resuelve supabase-js al arrancar y el
 * motivo del fallo lo recoge `enlaceAuthInicial`.
 */
export function useAuthDeepLink(): void {
  const router = useRouter();
  /*
    Mientras esto sea `undefined` el navegador todavia no existe y cualquier
    `router.replace` se perderia. Importa porque el caso normal es justo ese:
    el enlace ABRE la aplicacion, asi que llega antes de que haya nada montado.
    Lo pendiente se guarda y se resuelve en cuanto el navegador esta listo.
  */
  const navegacionLista = !!useRootNavigationState()?.key;
  const destinoPendiente = useRef(false);

  useEffect(() => {
    if (Platform.OS === 'web') return;

    let vivo = true;

    /** Lleva a la pantalla de contrasena, ahora o en cuanto se pueda. */
    const irAReset = () => {
      if (navegacionLista) router.replace('/reset-password');
      else destinoPendiente.current = true;
    };

    const atender = async (url: string | null) => {
      const enlace = leerEnlaceAuth(url);
      // Enlaces normales de la aplicacion (una publicacion, un perfil): que
      // sigan su camino, esto no va con ellos.
      if (!enlace || !vivo) return;

      const { startPasswordRecovery, setRecoveryError } = useAuthStore.getState();

      // El enlace ya no sirve: caducado, usado o manipulado.
      if (enlace.errorCode) {
        console.warn('[auth] enlace de recuperacion rechazado', enlace);
        setRecoveryError(mensajeDeEnlace(enlace));
        irAReset();
        return;
      }

      if (!esEnlaceDeRecuperacion(enlace)) return;

      try {
        const abierta = await AuthRepository.abrirSesionDesdeEnlace(enlace);
        if (!vivo) return;
        if (!abierta) {
          setRecoveryError(mensajeDeEnlace(enlace));
          irAReset();
          return;
        }
        startPasswordRecovery();
        irAReset();
      } catch (error) {
        if (!vivo) return;
        setRecoveryError(mensajeDeAuth(error, 'nueva-contrasena'));
        irAReset();
      }
    };

    // La aplicacion estaba cerrada y la abre el enlace.
    void Linking.getInitialURL().then(atender);

    // La aplicacion ya estaba abierta (el caso mas frecuente: se mira el correo
    // y se vuelve).
    const suscripcion = Linking.addEventListener('url', ({ url }) => void atender(url));

    return () => {
      vivo = false;
      suscripcion.remove();
    };
  }, [router, navegacionLista]);

  // El enlace llego con la aplicacion aun arrancando: se navega en cuanto hay
  // navegador. Sin esto la sesion de recuperacion quedaba abierta pero el
  // usuario se encontraba en el feed, sin la pantalla para cambiar la clave.
  useEffect(() => {
    if (!navegacionLista || !destinoPendiente.current) return;
    destinoPendiente.current = false;
    router.replace('/reset-password');
  }, [navegacionLista, router]);
}
