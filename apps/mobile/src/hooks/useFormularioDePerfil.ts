import { useCallback, useState } from 'react';

import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';

export type ErroresDePerfil = { fullName?: string; username?: string };

/** Como acabo un intento de guardar. */
export type ResultadoDeGuardar =
  | { ok: true }
  /** No se llego a llamar al servidor: los errores ya estan en los campos. */
  | { ok: false; motivo: 'invalido' }
  /** El servidor dijo que no. `mensaje` es lo que se le puede ensenar a la persona. */
  | { ok: false; motivo: 'servidor'; mensaje: string };

/**
 * Nombre, usuario y biografia: el borrador, la validacion y el guardado.
 *
 * POR QUE ES UN HOOK Y NO VIVE EN LA PANTALLA. Se edita desde dos sitios: la
 * bandeja que abre el lapiz del perfil (lo normal desde el 25/09/2026) y la
 * ruta `/edit-profile`. Con la logica copiada en cada uno, la proxima regla del
 * nombre de usuario se cambiaria en uno y no en el otro.
 *
 * NO AVISA CON DIALOGOS. Quien lo usa decide como contar un fallo: la pantalla
 * puede abrir un aviso, pero la bandeja es un `Modal` y en iOS no se presenta
 * nada encima de un Modal abierto (el aviso no saldria y `confirm()` no
 * resolveria nunca). Por eso `guardar` DEVUELVE lo que paso.
 *
 * El borrador vive en quien llama al hook. En el perfil eso importa: al cambiar
 * la foto desde la bandeja, el perfil se sustituye un momento por la
 * confirmacion del recorte (`ConfirmarRecorte`) y la bandeja se desmonta; como
 * el estado esta en `ProfileScreen`, lo escrito sigue ahi al volver.
 */
export function useFormularioDePerfil() {
  const { t } = useTranslation();
  const user = useAppStore((state) => state.user);
  const updateProfile = useAuthStore((state) => state.updateProfile);

  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [username, setUsername] = useState((user?.username ?? '').replace(/^@/, ''));
  const [bio, setBio] = useState(user?.bio ?? '');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<ErroresDePerfil>({});

  /** Vuelve a lo que hay guardado. Se llama al ABRIR la bandeja, no al cerrarla. */
  const reiniciar = useCallback(() => {
    setFullName(user?.fullName ?? '');
    setUsername((user?.username ?? '').replace(/^@/, ''));
    setBio(user?.bio ?? '');
    setErrors({});
  }, [user]);

  const cambiarNombre = useCallback((valor: string) => {
    setFullName(valor);
    setErrors((e) => ({ ...e, fullName: undefined }));
  }, []);

  const cambiarUsuario = useCallback((valor: string) => {
    setUsername(valor);
    setErrors((e) => ({ ...e, username: undefined }));
  }, []);

  const guardar = async (): Promise<ResultadoDeGuardar> => {
    const nuevos: ErroresDePerfil = {};
    if (fullName.trim().length < 3) {
      nuevos.fullName = t('auth.errorName');
    }
    if (username && !/^[a-zA-Z0-9_.-]{3,50}$/.test(username.trim())) {
      nuevos.username = t('editProfile.invalidUsername');
    }
    if (Object.keys(nuevos).length > 0) {
      setErrors(nuevos);
      return { ok: false, motivo: 'invalido' };
    }

    setSaving(true);
    try {
      await updateProfile({
        fullName: fullName.trim(),
        username: username.trim(),
        bio: bio.trim(),
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setErrors({ username: t('editProfile.usernameTaken') });
        return { ok: false, motivo: 'invalido' };
      }
      const mensaje =
        error instanceof ApiError || error instanceof Error
          ? error.message
          : t('editProfile.saveFailedBody');
      return { ok: false, motivo: 'servidor', mensaje };
    } finally {
      setSaving(false);
    }
  };

  return {
    fullName,
    username,
    bio,
    saving,
    errors,
    cambiarNombre,
    cambiarUsuario,
    setBio,
    reiniciar,
    guardar,
  };
}

export type FormularioDePerfil = ReturnType<typeof useFormularioDePerfil>;
