import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';

import { marcarDirectoComoAvisado } from '@/components/AvisoDeDirectoSeguido';
import { rutaDelAviso } from '@/lib/avisosAlCreador';
import { RUTA_DE_LA_BANDEJA, directoDelPush, rutaDelPush } from '@/lib/rutaDelPush';
import { anotarToqueAtendido, reservarToque, soltarToque } from '@/services/pushAtendido';

/** Que la biblioteca no vuelva a devolver este toque. Si no sabe, no pasa nada. */
function olvidarEnLaBiblioteca(): void {
  try {
    Notifications.clearLastNotificationResponse();
  } catch {
    // Queda la memoria propia (`services/pushAtendido`), que es la que manda.
  }
}

/**
 * Tocar un push lleva a lo que anuncia.
 *
 * A donde lleva cada aviso lo decide `rutaDelPush`, que es pura y esta probada;
 * aqui solo se escucha y se navega.
 *
 * `useLastNotificationResponse` cubre los dos casos: la aplicacion estaba
 * cerrada y la abrio el push, o estaba en segundo plano y volvio.
 *
 * TRES CUIDADOS, y los tres salieron de un fallo real (05/10/2026: la
 * aplicacion dejaba de abrirse despues de tocar un aviso):
 *
 *  - SE NAVEGA SOLO CON EL NAVEGADOR DE LA APLICACION MONTADO. Lo dice quien
 *    llama (`useNavegadorMontado`). Antes se miraba
 *    `useRootNavigationState()?.key`, que es cierto desde el primer instante:
 *    se navegaba con el layout raiz aun devolviendo `null`, el enrutador
 *    aplicaba la orden a su navegador interno y volvia a montar el layout
 *    entero, que leia el mismo toque y volvia a navegar. Ver
 *    `lib/navegadorMontado.ts`.
 *  - CADA TOQUE SE ATIENDE UNA VEZ, Y LA MEMORIA NO VIVE EN EL COMPONENTE. Con
 *    un `useRef`, un layout que se vuelve a montar olvida lo atendido. Y entre
 *    aperturas tambien hay que acordarse: el sistema sigue entregando el mismo
 *    toque en cada arranque (`services/pushAtendido`).
 *  - AL ATENDERLO SE LE DICE A LA BIBLIOTECA QUE LO OLVIDE, para que no lo
 *    vuelva a devolver.
 */
export function useAbrirDesdeElPush(navegadorMontado: boolean): void {
  const router = useRouter();
  // El enrutador puede cambiar de identidad entre renders; el efecto no.
  const navegar = useRef(router);
  navegar.current = router;
  const respuesta = Notifications.useLastNotificationResponse();

  useEffect(() => {
    if (!navegadorMontado || !respuesta) return undefined;
    // Solo el toque normal en el aviso, no un boton de accion.
    if (respuesta.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return undefined;
    const identificador = respuesta.notification.request.identifier;
    const datos = respuesta.notification.request.content.data;

    let vivo = true;
    let atendido = false;
    void reservarToque(identificador).then((libre) => {
      if (!libre) {
        // Es el de una apertura anterior, que el sistema ha vuelto a entregar.
        olvidarEnLaBiblioteca();
        return;
      }
      if (!vivo) {
        soltarToque(identificador);
        return;
      }
      atendido = true;
      // El destino sale del MAPA CERRADO, nunca de una ruta que traiga el aviso.
      // Lo que no se reconoce lleva a la bandeja; lo que ni es un aviso, a nada.
      // Un aviso sin datos (los de la cola de servicios, eventos y productos no
      // los mandan) lleva a la bandeja, que es donde esta su fila y su destino.
      const ruta = rutaDelPush(datos, { rutaDeDecision: rutaDelAviso }) ?? RUTA_DE_LA_BANDEJA;
      // Quien entra por el push de un directo ya va a verlo: el aviso de
      // «está transmitiendo» no tiene que salirle encima del mismo directo.
      const directo = directoDelPush(datos);
      if (directo) marcarDirectoComoAvisado(directo);
      navegar.current.push(ruta as never);
      void anotarToqueAtendido(identificador);
      olvidarEnLaBiblioteca();
    });

    return () => {
      vivo = false;
      // Si se fue antes de decidir, la reserva la suelta el propio `then`.
      if (!atendido) soltarToque(identificador);
    };
  }, [navegadorMontado, respuesta]);
}
