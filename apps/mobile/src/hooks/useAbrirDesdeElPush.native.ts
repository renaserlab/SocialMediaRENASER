import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import { useRootNavigationState, useRouter } from 'expo-router';

import { marcarDirectoComoAvisado } from '@/components/AvisoDeDirectoSeguido';
import { directoDelPush, rutaDelPush } from '@/lib/rutaDelPush';

/**
 * Tocar un push lleva a lo que anuncia (hoy, los directos).
 *
 * Hasta el 25/09/2026 tocar cualquier push solo abria la aplicacion. El aviso
 * «Juan está transmitiendo en vivo» invita a entrar al directo, asi que ahora
 * lleva a el. A donde lleva cada aviso lo decide `rutaDelPush`, que es pura y
 * esta probada; aqui solo se escucha y se navega.
 *
 * `useLastNotificationResponse` cubre los dos casos: la aplicacion estaba
 * cerrada y la abrio el push, o estaba en segundo plano y volvio.
 *
 * DOS CUIDADOS:
 *  - Se espera a que exista la navegacion (`useRootNavigationState`): el
 *    layout raiz devuelve `null` hasta que hidrata, y navegar antes revienta.
 *  - Cada respuesta se atiende UNA vez. El hook devuelve la ultima respuesta en
 *    cada render, y sin esto cada repintado volveria a abrir el directo.
 */
export function useAbrirDesdeElPush(): void {
  const router = useRouter();
  const navegacion = useRootNavigationState();
  const lista = !!navegacion?.key;
  const respuesta = Notifications.useLastNotificationResponse();
  const atendidas = useRef(new Set<string>());

  useEffect(() => {
    if (!lista || !respuesta) return;
    // Solo el toque normal en el aviso, no un boton de accion.
    if (respuesta.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const identificador = respuesta.notification.request.identifier;
    if (atendidas.current.has(identificador)) return;
    atendidas.current.add(identificador);

    const datos = respuesta.notification.request.content.data;
    const ruta = rutaDelPush(datos);
    if (!ruta) return;
    // Quien entra por el push de un directo ya va a verlo: el aviso de
    // «está transmitiendo» no tiene que salirle encima del mismo directo.
    const directo = directoDelPush(datos);
    if (directo) marcarDirectoComoAvisado(directo);
    router.push(ruta as never);
  }, [lista, respuesta, router]);
}
