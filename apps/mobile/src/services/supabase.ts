import 'react-native-url-polyfill/auto';
import { AppState, Platform } from 'react-native';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

export const supabase = url && anonKey
  ? createClient(url, anonKey, {
      auth: {
        storage: AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        // Al volver de Google, la sesion llega en el fragmento de la URL y
        // solo el navegador puede leerla. En nativo no hay URL que inspeccionar
        // (el retorno lo gestiona WebBrowser), y dejarlo activo daba avisos.
        detectSessionInUrl: Platform.OS === 'web',
      },
    })
  : null;

export const isSupabaseConfigured = Boolean(supabase);

/** URL base del proyecto; la necesita la subida reanumable (TUS). */
export const supabaseUrl = url ?? null;

/*
  Renovacion del token ligada al ciclo de vida de la aplicacion.

  `autoRefreshToken` renueva la sesion con un temporizador, y en un movil los
  temporizadores se detienen cuando la aplicacion pasa a segundo plano. Al
  volver despues de un rato, el token podia estar caducado y el temporizador
  parado: todas las peticiones respondian «no autorizado» y no habia forma de
  recuperarse sin cerrar la aplicacion y abrirla de nuevo. Es el fallo tipico
  de «la dejo abierta, vuelvo por la tarde y ya no me carga nada».

  Al volver al primer plano se reanuda la renovacion —lo que fuerza una
  comprobacion inmediata— y al salir se detiene, para no gastar bateria
  renovando una sesion que nadie esta usando.

  En navegador no hace falta: no hay segundo plano que congele los
  temporizadores.
*/
if (supabase && Platform.OS !== 'web') {
  AppState.addEventListener('change', (estado) => {
    if (estado === 'active') void supabase.auth.startAutoRefresh();
    else void supabase.auth.stopAutoRefresh();
  });
}
