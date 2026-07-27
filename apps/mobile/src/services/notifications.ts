import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';

import { supabase } from '@/services/supabase';

/**
 * Avisos en el telefono.
 *
 * Hay DOS mecanismos distintos y conviene no confundirlos:
 *
 * - **Push (remoto)**: lo manda el servidor y llega aunque la app este cerrada.
 *   Es lo que de verdad hace falta en una app movil. NO funciona en Expo Go
 *   desde el SDK 53: requiere una build propia (EAS o Xcode).
 * - **Local**: lo programa la propia app. Suena y sale como aviso del sistema
 *   igual que el push, pero solo puede dispararlo el dispositivo, no otra
 *   persona. Si funciona en Expo Go, asi que sirve para validar el sonido y el
 *   aspecto antes de tener la build.
 *
 * Aqui viven los dos. El sonido es el del sistema a proposito: respeta lo que
 * cada usuario tenga configurado y no anade peso a la app.
 */

/** Como se comporta un aviso con la app abierta: se ve y suena igual. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

/**
 * Canales de Android.
 *
 * Android agrupa los avisos por canal y deja que el usuario silencie unos y
 * conserve otros desde los ajustes del sistema. Separarlos desde el principio
 * evita el todo o nada: quien no quiera saber de cada "me gusta" puede apagar
 * solo ese canal sin perderse un mensaje directo.
 *
 * Ojo: los canales se crean UNA vez y despues Android ignora los cambios. Si
 * hay que cambiar el sonido o la importancia de uno, hay que darle otro id.
 */
const CHANNELS = [
  { id: 'mensajes', name: 'Mensajes', description: 'Mensajes directos y del círculo' },
  { id: 'interacciones', name: 'Interacciones', description: 'Me gusta, comentarios y seguidores' },
  { id: 'contenido', name: 'Contenido', description: 'Cursos, eventos y sesiones' },
] as const;

export type NotificationChannel = (typeof CHANNELS)[number]['id'];

async function ensureAndroidChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  for (const channel of CHANNELS) {
    await Notifications.setNotificationChannelAsync(channel.id, {
      name: channel.name,
      description: channel.description,
      importance: Notifications.AndroidImportance.HIGH,
      // `null` = sonido de notificacion por defecto del telefono.
      sound: null,
      vibrationPattern: [0, 250, 250, 250],
    });
  }
}

/**
 * Pide permiso para avisar.
 *
 * En iOS el permiso solo se puede pedir UNA vez: si se rechaza, la unica via es
 * que el usuario lo active a mano en los ajustes del sistema. Por eso conviene
 * llamar a esto cuando ya tiene sentido para quien usa la app (con sesion
 * iniciada), no nada mas abrirla por primera vez.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  // Un emulador no recibe avisos; pedirlo alli solo genera ruido en los logs.
  if (!Device.isDevice) return false;

  const current = await Notifications.getPermissionsAsync();
  if (current.granted) {
    await ensureAndroidChannels();
    return true;
  }
  // `canAskAgain` en false significa que ya lo rechazo: insistir no abre nada.
  if (!current.canAskAgain) return false;

  const asked = await Notifications.requestPermissionsAsync();
  if (asked.granted) await ensureAndroidChannels();
  return asked.granted;
}

/** Id del proyecto en EAS; sin el, Expo no puede emitir un token. */
function projectId(): string | null {
  return (
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId ??
    null
  );
}

/**
 * Registra este dispositivo para recibir push y guarda su token.
 *
 * Devuelve el token, o null si no se pudo (sin permiso, en Expo Go, o en un
 * emulador). Que devuelva null NO es un error: la app sigue funcionando igual,
 * simplemente no recibira avisos con la app cerrada.
 */
export async function registerForPush(): Promise<string | null> {
  if (!supabase) return null;

  const granted = await requestNotificationPermission();
  if (!granted) return null;

  const id = projectId();
  if (!id) return null;

  let token: string;
  try {
    const result = await Notifications.getExpoPushTokenAsync({ projectId: id });
    token = result.data;
  } catch (error) {
    // En Expo Go esto falla a proposito desde el SDK 53. No es un fallo
    // recuperable ni algo que deba interrumpir el arranque de la app.
    console.warn('[push] no se pudo obtener el token (¿Expo Go?):', error);
    return null;
  }

  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user?.id;
  if (!userId) return null;

  // `upsert` por token: si el mismo telefono cambia de cuenta, la fila se
  // reasigna en vez de duplicarse y seguir avisando al usuario anterior.
  const { error } = await supabase.from('device_tokens').upsert(
    {
      token,
      user_id: userId,
      platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: 'token' },
  );
  if (error) {
    console.warn('[push] no se pudo guardar el token:', error.message);
    return null;
  }

  return token;
}

/**
 * Da de baja este dispositivo. Se llama al cerrar sesion.
 *
 * Sin esto, quien cierra sesion en un telefono compartido seguiria recibiendo
 * los avisos de su cuenta en un aparato que ya no usa.
 */
export async function unregisterPush(): Promise<void> {
  if (!supabase || !Device.isDevice) return;
  const id = projectId();
  if (!id) return;
  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: id });
    await supabase.from('device_tokens').delete().eq('token', token);
  } catch {
    // Si no hay token que borrar, no hay nada que hacer.
  }
}

/**
 * Lanza un aviso local, ahora mismo.
 *
 * Existe por dos motivos: permite oir y ver el aviso en Expo Go, donde el push
 * remoto no llega, y sirve para avisar de algo que la propia app detecta
 * mientras esta abierta sin tener que pasar por el servidor.
 */
export async function notifyLocally(
  title: string,
  body: string,
  channel: NotificationChannel = 'interacciones',
): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        sound: true,
        ...(Platform.OS === 'android' ? { channelId: channel } : {}),
      },
      // null = inmediato.
      trigger: null,
    });
  } catch (error) {
    // Un aviso que no sale nunca debe tumbar la accion que lo provoco.
    console.warn('[aviso] no se pudo mostrar:', error);
  }
}

/** Pone el numero del icono de la app. En Android depende del lanzador. */
export async function setBadgeCount(count: number): Promise<void> {
  try {
    await Notifications.setBadgeCountAsync(Math.max(0, count));
  } catch {
    // No todos los lanzadores lo soportan; no es critico.
  }
}
