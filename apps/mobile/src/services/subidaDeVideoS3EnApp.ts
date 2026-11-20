import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { File } from 'expo-file-system';

import { apiRequest, ApiError, API_V1 } from '@/services/api';
import {
  compressVideo,
  compressionAvailable,
  createVideoPoster,
  readVideoMetadata,
} from '@/services/mediaCompressor';
import { mediosS3Subida, quienPregunta } from '@/services/plataforma';
import {
  formatMb,
  medida,
  MAX_UPLOAD_BYTES,
  MAX_VIDEO_SIN_COMPRIMIR_BYTES,
  readLocalFile,
  uploadPostMedia,
  type PickedMedia,
  type UploadedMedia,
  type UploadProgress,
} from '@/services/storage';
import {
  nuevoGrupo,
  subirVideoDePublicacion,
  type ApiDeSubidas,
  type HacerPut,
  type MemoriaDeSubida,
  type SubidaGuardada,
} from '@/services/subidaDeVideoS3';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';

/**
 * El medio de una publicacion de Reel, Publicacion o Edicion, subido donde
 * toque.
 *
 * Es la UNICA puerta a S3 (opcion B) y la usan solo esas tres pantallas. Con
 * la bandera `medios_s3_subida` apagada para esta cuenta, ausente o ilegible,
 * y para todo lo que no sea video, delega en `uploadPostMedia` tal cual: la
 * app se comporta exactamente como antes. Historias, testimonios, resenas,
 * catalogo, eventos y audio ni pasan por aqui.
 */
export async function subirMedioDePublicacion(
  media: PickedMedia,
  onProgress?: (progress: UploadProgress) => void,
): Promise<UploadedMedia> {
  if (media.kind !== 'video' || !(await subeAS3())) return uploadPostMedia(media, onProgress);
  try {
    const subido = await subirVideoAS3(media, onProgress);
    // Un formato que S3 no admite (p. ej. webm desde la web): por Supabase.
    return subido ?? (await uploadPostMedia(media, onProgress));
  } catch (error) {
    /*
      La bandera se pregunta una vez por sesion y el servidor pudo apagarla
      entretanto: si dice que esta cuenta ya no sube a S3, se sube a Supabase
      sin molestar a nadie. Cualquier otro fallo se cuenta.
    */
    if (error instanceof ApiError && error.status === 403 && error.code === 'medios_s3_no_habilitado') {
      return uploadPostMedia(media, onProgress);
    }
    throw new Error(describirFallo(error));
  }
}

/** Si ESTA cuenta sube a S3. Misma identidad que el resto de banderas. */
function subeAS3(): Promise<boolean> {
  const perfil = useAppStore.getState().user?.id ?? null;
  const conSesion = useAuthStore.getState().status === 'authenticated';
  return mediosS3Subida(quienPregunta(perfil, conSesion)).catch(() => false);
}

function describirFallo(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) {
      return 'Llegaste al límite de publicaciones con video por hora. Inténtalo de nuevo más tarde.';
    }
    // El servidor ya explica el resto (tamaño, tipo, sesión) en español.
    return error.message;
  }
  if (Platform.OS === 'web') {
    return 'Se perdió la conexión durante la subida. Vuelve a intentarlo.';
  }
  return 'Se perdió la conexión durante la subida. Vuelve a intentarlo: se reanudará donde se quedó.';
}

// --------------------------------------------------------------------------
// La API de subidas y el PUT a S3
// --------------------------------------------------------------------------

const api: ApiDeSubidas = {
  abrir: (cuerpo) =>
    apiRequest(`${API_V1}/medios/subidas`, { method: 'POST', body: JSON.stringify(cuerpo) }),
  pedirPartes: (id, numeros) =>
    apiRequest(`${API_V1}/medios/subidas/${encodeURIComponent(id)}/partes`, {
      method: 'POST',
      body: JSON.stringify({ numeros }),
    }),
  consultar: (id) => apiRequest(`${API_V1}/medios/subidas/${encodeURIComponent(id)}`),
  completar: (id, partes) =>
    apiRequest(`${API_V1}/medios/subidas/${encodeURIComponent(id)}/completar`, {
      method: 'POST',
      body: JSON.stringify({ partes }),
    }),
};

/**
 * Lo que puede tardar un PUT. Quince minutos: lo que dura su firma. Mas alla
 * S3 lo rechazaria igual, y el reintento pide una URL nueva.
 */
const ESPERA_DEL_PUT_MS = 15 * 60 * 1000;

/**
 * PUT por XHR, en web y en nativo.
 *
 * POR QUE XHR Y NO `fetch`: en React Native el Blob de `fetch(uri).blob()`
 * informa bien su tamano pero viaja VACIO por `fetch` (la trampa de las fotos
 * de 0 bytes, ver CLAUDE.md). Por XHR si viaja: es como TUS sube hoy los
 * videos grandes a Supabase (`resumableUpload.ts`). Y XHR da progreso de
 * subida, que `fetch` no. `uploadAsync` de expo-file-system no sirve: no sabe
 * subir un rango de bytes.
 */
const putPorXhr: HacerPut = (url, cuerpo, cabeceras, alAvanzar) =>
  new Promise((resolver, rechazar) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.timeout = ESPERA_DEL_PUT_MS;
    for (const [nombre, valor] of Object.entries(cabeceras)) xhr.setRequestHeader(nombre, valor);
    if (xhr.upload) xhr.upload.onprogress = (evento) => alAvanzar(evento.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        // El ETag llega entre comillas; S3 lo quiere igual al completar.
        resolver({ etag: xhr.getResponseHeader('ETag') ?? xhr.getResponseHeader('etag') });
      } else {
        rechazar(Object.assign(new Error(`S3 respondió ${xhr.status}`), { status: xhr.status }));
      }
    };
    xhr.onerror = () => rechazar(new Error('network error'));
    xhr.ontimeout = () => rechazar(new Error('timeout'));
    xhr.send(cuerpo as Blob);
  });

// --------------------------------------------------------------------------
// Memoria para reanudar (solo nativo)
// --------------------------------------------------------------------------

/**
 * Subidas a medias, por archivo de origen (lo que eligio la persona).
 *
 * Se guarda tambien el archivo YA COMPRIMIDO y su metadata: al volver a pulsar
 * «Publicar», comprimir otra vez daria otro archivo (otros bytes) y lo subido
 * no serviria. Solo se reanuda si ese archivo sigue en disco con el mismo
 * tamano; las copias de `content://` se borran a los 10 min, y entonces se
 * empieza de cero. En web no hay nada de esto: tras cerrar no queda archivo.
 */
const CLAVE_DE_MEMORIA = 'z-subidas-s3-v1';

/** Pasado un dia, lo guardado ya no le interesa a nadie. */
const VIDA_DE_LA_MEMORIA_MS = 24 * 60 * 60 * 1000;

type Entrada = {
  uriLocal: string;
  contentType: 'video/mp4' | 'video/quicktime';
  grupo: string;
  bytes: number;
  sinComprimir: boolean;
  meta: Pick<UploadedMedia, 'width' | 'height' | 'durationS'>;
  posterUri?: string;
  subida?: SubidaGuardada;
  guardadaEn: number;
};

async function leerTodo(): Promise<Record<string, Entrada>> {
  try {
    const crudo = await AsyncStorage.getItem(CLAVE_DE_MEMORIA);
    const todo = crudo ? (JSON.parse(crudo) as Record<string, Entrada>) : {};
    const ahora = Date.now();
    for (const [origen, entrada] of Object.entries(todo)) {
      if (!entrada || ahora - (entrada.guardadaEn ?? 0) > VIDA_DE_LA_MEMORIA_MS) delete todo[origen];
    }
    return todo;
  } catch {
    return {};
  }
}

async function escribir(origen: string, entrada: Entrada | null): Promise<void> {
  try {
    const todo = await leerTodo();
    if (entrada) todo[origen] = entrada;
    else delete todo[origen];
    await AsyncStorage.setItem(CLAVE_DE_MEMORIA, JSON.stringify(todo));
  } catch {
    // Reanudar es una comodidad: si el disco no deja, se sube de cero.
  }
}

function memoriaDe(origen: string, base: Entrada): MemoriaDeSubida {
  let actual = base;
  return {
    leer: async () => actual.subida ?? null,
    guardar: async (subida) => {
      actual = { ...actual, subida, guardadaEn: Date.now() };
      await escribir(origen, actual);
    },
    borrar: async () => {
      actual = { ...actual, subida: undefined };
      await escribir(origen, actual);
    },
  };
}

function sigueEnDisco(uri: string, bytes: number): boolean {
  try {
    const archivo = new File(uri);
    return archivo.exists && (archivo.size ?? 0) === bytes;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------
// El flujo
// --------------------------------------------------------------------------

/** El tipo que S3 va a guardar, o null si no es uno de los admitidos. */
function tipoDeVideo(media: PickedMedia, comprimido: boolean): Entrada['contentType'] | null {
  if (comprimido) return 'video/mp4';
  const mime = media.mimeType?.toLowerCase();
  if (mime === 'video/mp4') return 'video/mp4';
  if (mime === 'video/quicktime') return 'video/quicktime';
  if (mime) return null;
  const ext = (media.name ?? media.uri).split('?')[0]?.split('.').pop()?.toLowerCase();
  if (ext === 'mov') return 'video/quicktime';
  if (ext === 'mp4' || ext === 'm4v') return 'video/mp4';
  return null;
}

/**
 * Comprime (como hoy), saca metadata y poster local, y sube a S3.
 *
 * Devuelve `null` si el formato no es uno que la API admita: entonces quien
 * llama sube por Supabase, como siempre. La compresion, el poster y la barra
 * de progreso son las mismas de `uploadPostMedia`.
 */
async function subirVideoAS3(
  media: PickedMedia,
  onProgress?: (progress: UploadProgress) => void,
): Promise<UploadedMedia | null> {
  const nativo = Platform.OS !== 'web';
  const origen = media.uri;

  // ¿Quedo una subida a medias de este mismo video, con su archivo en disco?
  let entrada: Entrada | null = nativo ? ((await leerTodo())[origen] ?? null) : null;
  if (entrada && !sigueEnDisco(entrada.uriLocal, entrada.bytes)) {
    await escribir(origen, null);
    entrada = null;
  }

  if (!entrada) {
    let uri = media.uri;
    let comprimido = false;
    if (compressionAvailable) {
      try {
        onProgress?.({ phase: 'compressing', ratio: 0 });
        uri = await compressVideo(media.uri, (ratio) => onProgress?.({ phase: 'compressing', ratio }));
        comprimido = uri !== media.uri;
      } catch {
        // Igual que en Supabase: si comprimir falla se sube el original, con
        // el tope mas estricto de abajo.
        uri = media.uri;
      }
    }
    const contentType = tipoDeVideo(media, comprimido);
    if (!contentType) return null;

    const local = await readLocalFile(uri);
    const meta: Entrada['meta'] = {};
    const fromFile = await readVideoMetadata(uri).catch(() => null);
    // `medida()` y no `??`: un 0 x 0 (navegador que no decodifica el HEVC
    // del iPhone) tiene que quedar como «sin dato»; la API rechaza el 0.
    meta.width = medida(fromFile?.width) ?? medida(media.width);
    meta.height = medida(fromFile?.height) ?? medida(media.height);
    meta.durationS = fromFile?.durationS ?? (media.durationMs ? media.durationMs / 1000 : undefined);
    const poster = await createVideoPoster(uri).catch(() => null);
    if (poster) {
      meta.width = meta.width ?? medida(poster.width);
      meta.height = meta.height ?? medida(poster.height);
    }
    entrada = {
      uriLocal: uri,
      contentType,
      grupo: nuevoGrupo(),
      bytes: local.size,
      sinComprimir: media.kind === 'video' && !comprimido,
      meta,
      posterUri: poster?.uri,
      guardadaEn: Date.now(),
    };
  }

  const local = await readLocalFile(entrada.uriLocal);
  if (local.size === 0) throw new Error('El archivo seleccionado está vacío.');
  if (local.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `El archivo pesa ${formatMb(local.size)} y el máximo son ${formatMb(MAX_UPLOAD_BYTES)}. Elige un video más corto o comprímelo antes de subirlo.`,
    );
  }
  if (entrada.sinComprimir && local.size > MAX_VIDEO_SIN_COMPRIMIR_BYTES) {
    throw new Error(
      `Este video pesa ${formatMb(local.size)} y no se pudo comprimir en este dispositivo. ` +
        `Súbelo desde la aplicación instalada, o elige uno de menos de ${formatMb(MAX_VIDEO_SIN_COMPRIMIR_BYTES)}: ` +
        'a ese tamaño tardaría demasiado en cargar y consumiría muchos datos a quien lo vea.',
    );
  }
  entrada = { ...entrada, bytes: local.size };

  // Trozos con `Blob.slice`, como TUS: el Blob se recorre, no se carga entero.
  const blob = await local.resumableBody();
  const video = {
    bytes: local.size,
    contentType: entrada.contentType,
    trozo: (inicio: number, fin: number) => blob.slice(inicio, fin),
  };

  let poster: { bytes: number; trozo: (inicio: number, fin: number) => unknown } | null = null;
  if (entrada.posterUri) {
    try {
      const posterLocal = await readLocalFile(entrada.posterUri);
      if (posterLocal.size > 0) {
        const posterBlob = await posterLocal.resumableBody();
        poster = { bytes: posterLocal.size, trozo: (a, b) => posterBlob.slice(a, b) };
      }
    } catch {
      // Sin poster: el muro pinta su celda generica, como hasta ahora.
    }
  }

  if (nativo) await escribir(origen, entrada);
  onProgress?.({ phase: 'uploading', ratio: 0 });
  const { idDeSubida, idDeSubidaPoster } = await subirVideoDePublicacion({
    api,
    hacerPut: putPorXhr,
    grupo: entrada.grupo,
    video,
    poster,
    memoria: nativo ? memoriaDe(origen, entrada) : null,
    alAvanzar: (ratio) => onProgress?.({ phase: 'uploading', ratio }),
  });
  if (nativo) await escribir(origen, null);

  return {
    // Vacio a proposito: la clave definitiva la decide la API al publicar.
    storagePath: '',
    mediaType: 'video',
    ...entrada.meta,
    bytes: local.size,
    idDeSubida,
    ...(idDeSubidaPoster ? { idDeSubidaPoster } : {}),
  };
}
