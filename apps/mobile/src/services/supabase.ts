import 'react-native-url-polyfill/auto';
import { Platform } from 'react-native';
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
