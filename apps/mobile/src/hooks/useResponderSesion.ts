import { useCallback, useRef, useState } from 'react';

import { traduceEnElIdiomaActual } from '@/i18n';
import { CODIGO_YA_NO_SE_PUEDE, type AccionDeSesion } from '@/lib/accionesDeSesion';
import { confirm } from '@/lib/confirm';
import { describeError } from '@/lib/describeError';
import { toast, toastDeError } from '@/lib/toast';
import { BookingRepository, type Sesion } from '@/repositories/BookingRepository';
import { ApiError } from '@/services/api';

type Opciones = {
  /** La sesión, tal y como quedó en el servidor. */
  alCambiar: (sesion: Sesion) => void;
  /**
   * El servidor dijo «eso ya no se puede»: la sesión cambió por otro lado y lo
   * que hay en pantalla es viejo. Quien llama vuelve a leer.
   */
  alDesfasar: () => void;
};

/**
 * Responder a una sesión 1:1: aceptar, rechazar, cancelar o darla por hecha.
 *
 * UN SOLO SITIO PARA LA AGENDA Y PARA EL CHAT. Los dos ofrecen los mismos
 * botones (`lib/accionesDeSesion.ts`) y tienen que comportarse igual al
 * pulsarlos; con una copia en cada pantalla, una arregla un fallo y la otra no.
 *
 * - UN TOQUE, UNA PETICIÓN. El cerrojo va en una referencia: con estado, dos
 *   toques en el mismo instante leen el valor viejo y salen los dos.
 * - CANCELAR SE CONFIRMA. No tiene vuelta atrás —una sesión cancelada se pide
 *   otra vez— y el botón está al lado del de dar por hecha.
 * - «YA NO SE PUEDE» NO ES UN ERROR. Es que la sesión cambió por otro lado. Se
 *   dice con calma y se vuelve a leer; antes se enseñaba como un fallo y el
 *   botón que lo provocaba seguía ahí.
 */
export function useResponderSesion({ alCambiar, alDesfasar }: Opciones) {
  /** La sesión con una respuesta en curso: apaga sus botones. */
  const [ocupada, setOcupada] = useState<string | null>(null);
  const cerrojo = useRef<string | null>(null);
  /** Hay un «¿seguro?» abierto: un segundo toque no encola otro. */
  const preguntando = useRef(false);
  // Lo último que pasó quien llama, sin obligarle a memorizarlo.
  const avisos = useRef({ alCambiar, alDesfasar });
  avisos.current = { alCambiar, alDesfasar };

  const responder = useCallback(async (sesionId: string, accion: AccionDeSesion) => {
    if (cerrojo.current || preguntando.current) return;
    const t = traduceEnElIdiomaActual;

    if (accion === 'cancelled') {
      preguntando.current = true;
      let seguro = false;
      try {
        seguro = await confirm({
          title: t('agenda.cancelConfirmTitle'),
          message: t('agenda.cancelConfirmBody'),
          confirmLabel: t('agenda.cancelSession'),
          cancelLabel: t('agenda.keepSession'),
          destructive: true,
        });
      } finally {
        preguntando.current = false;
      }
      if (!seguro) return;
      // Mientras el diálogo estaba abierto pudo empezar otra respuesta.
      if (cerrojo.current) return;
    }

    cerrojo.current = sesionId;
    setOcupada(sesionId);
    try {
      const actualizada = await BookingRepository.update(sesionId, accion);
      avisos.current.alCambiar(actualizada);
      toast(
        accion === 'accepted'
          ? t('notif.sessionAcceptedTitle')
          : accion === 'rejected'
          ? t('notif.sessionRejectedTitle')
          : accion === 'completed'
          ? t('agenda.markedDone')
          : t('notif.sessionCancelledTitle'),
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === CODIGO_YA_NO_SE_PUEDE) {
        toast(t('agenda.alreadyChanged'), 'info');
        avisos.current.alDesfasar();
      } else {
        toastDeError(describeError(error, t('agenda.updateFailed')));
      }
    } finally {
      cerrojo.current = null;
      setOcupada(null);
    }
  }, []);

  return { ocupada, responder };
}
