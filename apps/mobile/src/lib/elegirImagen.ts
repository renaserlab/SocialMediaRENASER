import * as ImagePicker from 'expo-image-picker';

import { TIPOS_ADMITIDOS } from '@/lib/fotosDeProducto';

/**
 * Elegir una imagen del dispositivo, en el teléfono y en el navegador.
 *
 * ESTABA DENTRO DE `FotosDeProductoScreen` y sale aquí porque el Incremento 7
 * necesita exactamente lo mismo para la evidencia de una reclamación. Dos
 * copias de esto habrían sido dos sitios donde arreglar la trampa del `Blob`
 * vacío el día que alguien la vuelva a pisar.
 *
 * EL ARCHIVO VIAJA COMO `{uri, name, type}` EN EL TELÉFONO, que es lo que el
 * `FormData` de React Native sabe leer. Un `Blob` sacado de `fetch(uri).blob()`
 * informa bien el tamaño pero VIAJA VACÍO —la trampa ya pagada que cuenta
 * `CLAUDE.md`—: subiría cero bytes diciendo que son dos megas.
 *
 * NO SE VALIDA NADA MÁS QUE LO BARATO. El tipo y el tamaño que se miran aquí
 * sirven para no gastar una subida entera en algo que va a fallar; quien decide
 * de verdad es el servidor, que abre la imagen y mira los bytes.
 */

/** Un archivo ya elegido, con lo que hace falta para comprobarlo antes de subir. */
export type ImagenElegida = {
  archivo: Blob;
  nombre: string;
  tipo: string | null;
  bytes: number | null;
};

/** Quien dijo que no a las fotos del teléfono. NO ES UNA AVERÍA. */
export class PermisoNegado extends Error {}

/**
 * El tipo deducido de la extensión, y SOLO si es uno de los tres admitidos.
 *
 * `expo-image-picker` casi siempre manda `mimeType`, pero no está garantizado.
 * Sin esto, un JPEG perfectamente válido se rechazaría aquí por «tipo no
 * admitido» sin haber salido del teléfono. No se adivina nada más: lo que no
 * cuadra con la lista cerrada vuelve nulo y lo decide el servidor.
 */
export function tipoPorExtension(uri: string): string | null {
  const limpio = uri.split('?')[0] ?? '';
  const punto = limpio.lastIndexOf('.');
  if (punto === -1) return null;
  const extension = limpio.slice(punto + 1).toLowerCase();
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  return null;
}

/**
 * El selector del navegador: un `<input type="file">` oculto.
 *
 * Se crea, se pulsa y se quita. React Native Web no pinta elementos del DOM
 * desde el JSX, así que el campo no puede vivir en el árbol de componentes.
 */
export function elegirEnWeb(): Promise<ImagenElegida | null> {
  return new Promise((resolver) => {
    if (typeof document === 'undefined') {
      resolver(null);
      return;
    }
    const entrada = document.createElement('input');
    entrada.type = 'file';
    entrada.accept = TIPOS_ADMITIDOS.join(',');
    entrada.style.display = 'none';
    const terminar = (elegido: ImagenElegida | null) => {
      entrada.remove();
      resolver(elegido);
    };
    entrada.addEventListener('change', () => {
      const archivo = entrada.files?.[0];
      if (archivo === undefined) {
        terminar(null);
        return;
      }
      terminar({
        archivo,
        nombre: archivo.name,
        tipo: archivo.type === '' ? tipoPorExtension(archivo.name) : archivo.type,
        bytes: archivo.size,
      });
    });
    // Cerrar el diálogo sin elegir nada tiene que soltar la promesa igual.
    entrada.addEventListener('cancel', () => terminar(null));
    document.body.appendChild(entrada);
    entrada.click();
  });
}

/** El selector del teléfono. Lanza `PermisoNegado` si dijeron que no. */
export async function elegirEnNativo(): Promise<ImagenElegida | null> {
  const permiso = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permiso.granted) throw new PermisoNegado();

  const resultado = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: false,
  });
  if (resultado.canceled) return null;
  const elegida = resultado.assets?.[0];
  if (elegida === undefined) return null;

  const tipo = elegida.mimeType ?? tipoPorExtension(elegida.uri);
  const nombre = elegida.fileName ?? `${Date.now()}`;
  return {
    archivo: {
      uri: elegida.uri,
      name: nombre,
      type: tipo ?? undefined,
    } as unknown as Blob,
    nombre,
    tipo,
    bytes: typeof elegida.fileSize === 'number' ? elegida.fileSize : null,
  };
}
