import { Linking, Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Camera } from 'expo-camera';

import {
  interpretarPermiso as traducir,
  type EstadoDePermiso,
} from '@/lib/estadoDePermiso';

// Se reexporta para que el resto de la aplicacion siga pidiendo el tipo aqui,
// junto a las funciones que lo devuelven.
export type { EstadoDePermiso };

/**
 * Permisos del dispositivo, con los cuatro estados que existen de verdad.
 *
 * POR QUE NO BASTA CON UN BOOLEANO. "Tiene permiso / no tiene permiso" deja
 * fuera los dos casos que mas confunden a quien usa la aplicacion:
 *
 *  - LIMITADO (iOS 14+): la persona concedio acceso solo a unas fotos
 *    concretas. El selector abre, pero medio carrete no esta, y sin explicarlo
 *    parece que la aplicacion haya perdido sus fotos.
 *  - BLOQUEADO: ya se rechazo antes y el sistema NO volvera a preguntar. Pedir
 *    otra vez no hace absolutamente nada: el boton parece roto. La unica
 *    salida son los ajustes del telefono, y hay que llevar a la persona alli.
 *
 * Los permisos se piden JUSTO CUANDO hacen falta (al abrir la camara, al
 * elegir una foto), nunca al arrancar: pedirlos de golpe y sin contexto es lo
 * que hace que se rechacen, y un rechazo en iOS es para siempre.
 */

export type TipoDePermiso = 'fotos' | 'camara' | 'microfono';

/** Consulta el permiso SIN pedirlo. Sirve para decidir que pintar. */
export async function consultarPermiso(tipo: TipoDePermiso): Promise<EstadoDePermiso> {
  if (tipo === 'fotos') {
    return traducir(await ImagePicker.getMediaLibraryPermissionsAsync());
  }
  if (tipo === 'camara') {
    return traducir(await Camera.getCameraPermissionsAsync());
  }
  return traducir(await Camera.getMicrophonePermissionsAsync());
}

/**
 * Pide el permiso. Si ya estaba bloqueado, NO vuelve a preguntar: el sistema
 * ignoraria la peticion y quien mira solo veria un boton que no hace nada.
 *
 * Los dos estados que SI preguntan son «sinPreguntar» —la primera vez— y
 * «denegado» —se dijo que no y el sistema todavia deja insistir—. En Android
 * cada «no» cuenta: al segundo, el sistema deja de preguntar para siempre. Por
 * eso esto no se llama solo desde ningun efecto; siempre lo dispara un gesto de
 * la persona o el momento exacto en que la camara hace falta.
 */
export async function pedirPermiso(tipo: TipoDePermiso): Promise<EstadoDePermiso> {
  const actual = await consultarPermiso(tipo);
  if (actual === 'concedido' || actual === 'limitado' || actual === 'bloqueado') return actual;

  if (tipo === 'fotos') {
    return traducir(await ImagePicker.requestMediaLibraryPermissionsAsync());
  }
  if (tipo === 'camara') {
    return traducir(await Camera.requestCameraPermissionsAsync());
  }
  return traducir(await Camera.requestMicrophonePermissionsAsync());
}

/** Abre los ajustes de la aplicacion. En la web no existe tal cosa. */
export function abrirAjustes(): void {
  if (Platform.OS === 'web') return;
  void Linking.openSettings().catch(() => {});
}

const NOMBRE: Record<TipoDePermiso, string> = {
  fotos: 'tus fotos y vídeos',
  camara: 'la cámara',
  microfono: 'el micrófono',
};

/**
 * Que decirle a la persona segun el estado.
 *
 * Se explica PARA QUE se pide antes de pedirlo: un permiso sin motivo se
 * rechaza, y en iOS ese rechazo no tiene vuelta atras dentro de la aplicacion.
 */
export function textoDePermiso(
  tipo: TipoDePermiso,
  estado: EstadoDePermiso,
): { titulo: string; cuerpo: string; accion: string; vaAAjustes: boolean } {
  if (estado === 'bloqueado') {
    return {
      titulo: `Z no puede acceder a ${NOMBRE[tipo]}`,
      cuerpo:
        'Ya se rechazó antes y el teléfono no volverá a preguntar. Puedes ' +
        'activarlo en los ajustes; volvemos aquí en cuanto lo hagas.',
      accion: 'Abrir ajustes',
      vaAAjustes: true,
    };
  }
  if (estado === 'limitado') {
    return {
      titulo: 'Solo vemos algunas fotos',
      cuerpo:
        'Diste acceso a una selección. Puedes seguir así y elegir entre esas, ' +
        'o ampliar la selección desde los ajustes.',
      accion: 'Gestionar selección',
      vaAAjustes: true,
    };
  }
  if (estado === 'denegado') {
    /*
      Ya se dijo que no UNA vez. No es lo mismo que no haber preguntado nunca:
      repetir el texto de invitacion suena a que la aplicacion no se ha enterado
      de la respuesta. Se reconoce el «no» y se dice que se puede cambiar.
    */
    return {
      titulo: `Sin ${NOMBRE[tipo]} no se puede grabar`,
      cuerpo:
        'Dijiste que no, y está bien. Si cambias de idea puedes darle acceso ' +
        'ahora; solo se usa mientras estés creando algo.',
      accion: 'Volver a intentarlo',
      vaAAjustes: false,
    };
  }
  return {
    titulo: `Z necesita ${NOMBRE[tipo]}`,
    cuerpo:
      tipo === 'microfono'
        ? 'Sin micrófono el vídeo se graba mudo.'
        : 'Solo se usa cuando tú lo pides, para crear el contenido que publicas.',
    accion: 'Permitir',
    vaAAjustes: false,
  };
}
