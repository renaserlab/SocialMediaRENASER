import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';

import {
  alRecibirUnMensajePorPush,
  alRecibirUnPush,
  alRecibirUnPushDeSesion,
} from '@/hooks/useAvisosEnVivo';
import { rutaDelAviso } from '@/lib/avisosAlCreador';
import { seEstaViendoLaConversacion } from '@/lib/loQueSeVe';
import {
  claveDelPush,
  conversacionDelPush,
  esPushDeSesion,
  mensajeDelPush,
  rutaDelPush,
} from '@/lib/rutaDelPush';
import { avisar } from '@/lib/toast';

/**
 * El push que llega CON LA APLICACIÓN ABIERTA.
 *
 * No había ningún oyente de recepción: con la aplicación delante, un push
 * dependía de que el sistema quisiera enseñar su propio aviso encima, y la
 * aplicación no se enteraba de nada —ni la campana ni el globo de mensajes se
 * movían—.
 *
 * Ahora, cuando llega:
 *
 *   - se enseña el aviso PROPIO de la aplicación (el mismo de siempre, con su
 *     cola y su deduplicación), con el título y el texto que trae el push;
 *   - tocarlo lleva a donde diga el MAPA CERRADO de destinos (`rutaDelPush`),
 *     nunca a una ruta que venga dentro del aviso;
 *   - si es un mensaje de la conversación que la persona tiene delante, NO se
 *     avisa: el mensaje ya está apareciendo en la conversación;
 *   - y se ponen al día los contadores.
 *
 * El aviso del sistema no se enseña en primer plano (lo decide
 * `setNotificationHandler` en `services/notifications`): serían dos avisos del
 * mismo hecho, uno encima de otro.
 *
 * Se monta UNA vez, en el layout raíz. El oyente se quita al desmontar.
 */
export function useAvisosDelPush(): void {
  const router = useRouter();
  const navegar = useRef(router);
  navegar.current = router;

  useEffect(() => {
    const oyente = Notifications.addNotificationReceivedListener((notificacion) => {
      const { title, body, data } = notificacion.request.content;

      const conversacion = conversacionDelPush(data);

      // Lo que ya se está leyendo no se anuncia.
      if (seEstaViendoLaConversacion(conversacion)) {
        alRecibirUnPush();
        return;
      }

      /*
        EL PUSH DE UN MENSAJE NO SE PINTA AQUÍ. Con la aplicación abierta ese
        mismo mensaje llega también en tiempo real, y eran dos avisos del mismo
        hecho: el segundo volvía a entrar, a vibrar y a anunciarse. Se entrega
        al camino en vivo, que lo reconoce por su identificador y da UNO, con
        el nombre y el resumen de la conversación. Solo si nadie escucha allí
        se enseña el del push, que es mejor que nada.
      */
      if (
        conversacion &&
        alRecibirUnMensajePorPush(conversacion, mensajeDelPush(data), (body ?? '').trim() || null)
      ) {
        return;
      }

      /*
        EL DE UNA SESIÓN TAMPOCO, y por lo mismo. Una sesión deja además un
        mensaje en el chat que llega en tiempo real y adelanta la lectura de la
        bandeja: el aviso sale por ahí. Pintar también el del push eran dos
        avisos de «te han pedido una sesión». Se entrega a esa misma lectura,
        que anuncia cada aviso una sola vez, llegue antes quien llegue.
      */
      if (esPushDeSesion(data) && alRecibirUnPushDeSesion()) return;

      const texto = (body ?? '').trim();
      const titulo = (title ?? '').trim();
      if (texto || titulo) {
        const ruta = rutaDelPush(data, { rutaDeDecision: rutaDelAviso });
        avisar({
          tipo: 'notificacion',
          titulo: texto ? titulo || undefined : undefined,
          message: texto || titulo,
          clave: claveDelPush(data),
          alTocar: ruta ? () => navegar.current.push(ruta as never) : undefined,
        });
      }
      alRecibirUnPush();
    });
    return () => oyente.remove();
  }, []);
}
