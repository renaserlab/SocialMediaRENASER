import 'react-native-url-polyfill/auto';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { olvidarInstantaneaDeVideos } from '@/feed/cacheDeVideos';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

import {
  compressImage,
  compressVideo,
  compressionAvailable,
  createVideoPoster,
  readVideoMetadata,
} from '@/services/mediaCompressor';
import { uploadResumable } from '@/services/resumableUpload';
import { supabase, supabaseUrl } from '@/services/supabase';

const BUCKET = 'post-media';
const SIGNED_URL_TTL = 60 * 60; // 1 hora

/**
 * Cache de URLs firmadas.
 *
 * Cada llamada a `createSignedUrls` devuelve una firma DISTINTA para el mismo
 * archivo, asi que la URL cambiaba en cada carga del feed y la imagen nunca se
 * reutilizaba de la cache del sistema: se descargaba entera otra vez.
 * Reutilizando la firma mientras siga vigente, volver a una pantalla ya vista
 * es inmediato. Se renueva 10 min antes de caducar para no servir un enlace
 * muerto.
 */
const CACHE_TTL_MS = (SIGNED_URL_TTL - 600) * 1000;
const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();

/**
 * Firmas que ya se estan pidiendo ahora mismo, por ruta.
 *
 * Evita que dos llamadas simultaneas firmen el mismo archivo dos veces. El
 * porque largo esta en `signMediaUrls`, donde se usa.
 */
const firmasEnVuelo = new Map<string, Promise<string | undefined>>();

/*
  La cache de firmas SOBREVIVE al cierre de la aplicacion.

  Solo en memoria, cada arranque partia de cero: se volvia a firmar todo y,
  como cada firma produce una URL DISTINTA, la cache de disco de expo-image no
  reconocia ninguna imagen y el muro entero se descargaba otra vez en cada
  apertura (medido: el feed actual son varios MB de fotos). Guardando las
  firmas vigentes, al reabrir dentro de la hora la URL es la misma, no hay
  peticion de firma y las imagenes salen del disco al instante.

  Se guarda solo el mapa ruta→{url, caducidad}: unos pocos KB.
*/
const SIGNED_CACHE_STORAGE_KEY = 'z-signed-urls-v1';

let signedCacheReady: Promise<void> | null = null;

function ensureSignedCacheLoaded(): Promise<void> {
  if (!signedCacheReady) {
    signedCacheReady = AsyncStorage.getItem(SIGNED_CACHE_STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        const now = Date.now();
        const saved = JSON.parse(raw) as Record<string, { url: string; expiresAt: number }>;
        for (const [path, entry] of Object.entries(saved)) {
          // Las caducadas no se restauran; se refirmaran al pedirse.
          if (entry?.url && entry.expiresAt > now && !signedUrlCache.has(path)) {
            signedUrlCache.set(path, entry);
          }
        }
      })
      .catch(() => {
        // Una cache ilegible no es un error: se firma de nuevo y listo.
      });
  }
  return signedCacheReady;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Persiste la cache con un pequeño retraso para agrupar rafagas de firmas. */
function scheduleSignedCacheSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const out: Record<string, { url: string; expiresAt: number }> = {};
    const now = Date.now();
    for (const [path, entry] of signedUrlCache) {
      if (entry.expiresAt > now) out[path] = entry;
    }
    AsyncStorage.setItem(SIGNED_CACHE_STORAGE_KEY, JSON.stringify(out)).catch(() => {});
  }, 500);
}

export type MediaKind = 'image' | 'video' | 'audio';

/** Medio elegido por el usuario, antes de subirlo. */
export type PickedMedia = {
  uri: string;
  kind: MediaKind;
  mimeType?: string | null;
  name?: string | null;
  /** Duracion en ms cuando el medio es un video (la informa el selector). */
  durationMs?: number | null;
  /** Medidas que informa el selector; sirven para la proporcion del hueco. */
  width?: number | null;
  height?: number | null;
};

/** Medio ya subido a Storage, listo para enviar al backend. */
export type UploadedMedia = {
  storagePath: string;
  mediaType: MediaKind;
  /*
    Metadata que viaja al backend junto a la ruta. Con ella la tarjeta reserva
    el hueco exacto (sin saltos de layout) y el poster se pinta al instante
    mientras el video prepara. Todo opcional: donde no se pueda calcular
    (Expo Go sin modulo nativo), el post funciona igual que antes.
  */
  width?: number;
  height?: number;
  durationS?: number;
  bytes?: number;
  /** Ruta del poster ya subido a Storage (solo videos, cuando se pudo). */
  posterPath?: string;
};

const DEFAULT_EXT: Record<MediaKind, string> = {
  image: 'jpg',
  video: 'mp4',
  audio: 'm4a',
};

// --------------------------------------------------------------------------
// Selección
// --------------------------------------------------------------------------

export type PickImageOptions = {
  /** Proporción del recorte. Solo la respeta Android. */
  aspect?: [number, number];
  /**
   * Recorte antes de subir. Debe ir a `false` para banners: con `true`, iOS
   * fuerza un recorte CUADRADO y una portada apaisada pierde los bordes.
   */
  allowsEditing?: boolean;
};

/**
 * El permiso de fotos o de camara esta denegado.
 *
 * Se lanza en vez de devolver `null` porque `null` significa "la persona
 * cancelo", y confundir ambos casos dejaba el boton sin hacer NADA: ni foto ni
 * explicacion. En iOS el sistema solo pregunta UNA vez, asi que si se rechazo
 * en su dia, todas las llamadas siguientes fallan calladas para siempre y la
 * unica salida es activarlo a mano en los ajustes del telefono.
 */
export class PermisoDenegadoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermisoDenegadoError';
  }
}

const AVISO_FOTOS =
  'Z no tiene permiso para acceder a tus fotos. Actívalo en la configuración del ' +
  'teléfono → Z → Fotos.';
const AVISO_CAMARA =
  'Z no tiene permiso para usar la cámara. Actívalo en la configuración del ' +
  'teléfono → Z → Cámara.';

/**
 * `aspect` solo se envia en Android.
 *
 * iOS lo ignora —su recorte siempre es cuadrado— pero ademas pasarlo impedia
 * que el selector llegara a abrirse: los sitios que lo enviaban (historias,
 * foto de perfil) no hacian nada al tocarlos, mientras que crear una
 * publicacion, que no lo envia, funcionaba. Como en iOS no aportaba nada, se
 * omite en vez de arrastrar el problema.
 */
function aspectoPorPlataforma(
  aspect: [number, number] | undefined,
): { aspect?: [number, number] } {
  if (Platform.OS !== 'android' || !aspect) return {};
  return { aspect };
}

/** Abre la galería y devuelve la imagen elegida (o null si se cancela). */
export async function pickImage(
  options: PickImageOptions = {},
): Promise<PickedMedia | null> {
  const { aspect, allowsEditing = true } = options;
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new PermisoDenegadoError(AVISO_FOTOS);
  // `MediaTypeOptions` esta deprecado en expo-image-picker 17: se usa el array.
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 0.8,
    allowsEditing,
    ...aspectoPorPlataforma(aspect),
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  return {
    uri: asset.uri,
    kind: 'image',
    mimeType: asset.mimeType,
    name: asset.fileName,
    width: asset.width ?? null,
    height: asset.height ?? null,
  };
}

/**
 * Abre la cámara y devuelve la foto tomada (o null si se cancela).
 *
 * `aspect` solo lo respeta Android; en iOS el recorte siempre es cuadrado.
 */
export async function takePhoto(
  options: PickImageOptions = {},
): Promise<PickedMedia | null> {
  const { aspect, allowsEditing = true } = options;
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) throw new PermisoDenegadoError(AVISO_CAMARA);
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images'],
    quality: 0.8,
    allowsEditing,
    ...aspectoPorPlataforma(aspect),
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  return {
    uri: asset.uri,
    kind: 'image',
    mimeType: asset.mimeType,
    name: asset.fileName,
    width: asset.width ?? null,
    height: asset.height ?? null,
  };
}

/** Abre la galería y devuelve el video elegido (o null si se cancela). */
export async function pickVideo(maxDurationSec = 180): Promise<PickedMedia | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new PermisoDenegadoError(AVISO_FOTOS);
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['videos'],
    // Reduce el peso en origen: los videos de galeria pasan de 100 MB con
    // facilidad y en iOS se reexportan a 720p antes de subirlos.
    videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium,
    // OJO: solo limita la grabacion con camara. Al elegir de la galeria hay que
    // comprobar `durationMs` en quien llama.
    videoMaxDuration: maxDurationSec,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  return {
    uri: asset.uri,
    kind: 'video',
    mimeType: asset.mimeType,
    name: asset.fileName,
    durationMs: duracionEnMs(asset.duration),
    width: asset.width ?? null,
    height: asset.height ?? null,
  };
}

/**
 * La duracion del selector, siempre en MILISEGUNDOS.
 *
 * En movil `expo-image-picker` la da en milisegundos, pero su implementacion
 * web la saca de `HTMLVideoElement.duration`, que esta en SEGUNDOS, y aqui se
 * copiaba tal cual. Resultado: en el navegador un video de noventa segundos
 * llegaba como `durationMs = 90` y cualquier limite en milisegundos lo dejaba
 * pasar. No es una conversion «por si acaso»: es que las dos plataformas
 * devuelven unidades distintas por el mismo campo.
 */
function duracionEnMs(duracion: number | null | undefined): number | null {
  if (typeof duracion !== 'number' || !Number.isFinite(duracion) || duracion <= 0) return null;
  return Platform.OS === 'web' ? Math.round(duracion * 1000) : duracion;
}

/** Abre el selector de archivos para elegir un audio. */
export async function pickAudio(): Promise<PickedMedia | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'audio/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets?.[0];
  if (!asset) return null;
  return { uri: asset.uri, kind: 'audio', mimeType: asset.mimeType, name: asset.name };
}

// --------------------------------------------------------------------------
// Subida
// --------------------------------------------------------------------------

export function randomName(ext: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now()}-${rand}.${ext}`;
}

function resolveExtension(media: PickedMedia): string {
  const fromName = media.name?.split('.').pop()?.toLowerCase();
  if (fromName && fromName.length <= 5 && /^[a-z0-9]+$/.test(fromName)) return fromName;
  const fromUri = media.uri.split('?')[0]?.split('.').pop()?.toLowerCase();
  if (fromUri && fromUri.length <= 5 && /^[a-z0-9]+$/.test(fromUri)) return fromUri;
  return DEFAULT_EXT[media.kind];
}

function resolveContentType(media: PickedMedia, ext: string): string {
  if (media.mimeType) return media.mimeType;
  if (media.kind === 'image') return `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  if (media.kind === 'video') return `video/${ext}`;
  return `audio/${ext === 'm4a' ? 'mp4' : ext}`;
}

/**
 * Límite por archivo, en MB. Debe coincidir con el limite real del proyecto
 * Supabase (Storage → Settings → Upload file size limit) y con el del bucket:
 * el plan free tope a 50 MB, el Pro admite hasta 50 GB. Esta comprobacion es
 * solo para fallar rapido y con un mensaje claro; quien manda es el servidor.
 */
const MAX_UPLOAD_MB = Number(process.env.EXPO_PUBLIC_MAX_UPLOAD_MB ?? 500);
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

/**
 * Tope para un video que NO ha pasado por el compresor.
 *
 * El compresor deja un video de movil en 10-20 MB y, de paso, coloca el indice
 * del archivo al principio, que es lo que permite empezar a verlo enseguida en
 * vez de esperar. Cuando no esta disponible —en Expo Go o en la web— el video
 * viaja tal cual, y ahi es donde se colaron los que hay hoy: hasta 161 MB para
 * menos de dos minutos, a una velocidad que ninguna conexion movil sostiene y
 * gastando 89 MB de datos por cada minuto visto a quien lo mira.
 *
 * Sesenta megas es holgado para un video corto ya comprimido y corta en seco
 * los originales de camara sin tocar. Solo se aplica cuando no se ha podido
 * comprimir: si el compresor hizo su trabajo, manda el limite general.
 */
const MAX_VIDEO_SIN_COMPRIMIR_BYTES = 60 * 1024 * 1024;

export function formatMb(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

/**
 * Traduce un error de Storage a algo accionable.
 *
 * Storage responde SIEMPRE con HTTP 400 y mete el codigo real en el cuerpo
 * (`statusCode`), asi que sin esto en consola solo se ve "400 (Bad Request)".
 */
export function describeStorageError(error: unknown): string {
  const err = error as {
    message?: string;
    statusCode?: string | number;
    // tus-js-client adjunta la respuesta HTTP que provoco el fallo.
    originalResponse?: { getStatus?: () => number };
  };
  const code = String(err?.statusCode ?? err?.originalResponse?.getStatus?.() ?? '');
  const message = err?.message ?? 'Error desconocido';

  if (/network|failed to fetch|timeout/i.test(message)) {
    return 'Se perdió la conexión durante la subida. Vuelve a intentarlo: se reanudará donde se quedó.';
  }

  if (code === '413' || /exceeded the maximum allowed size|too large/i.test(message)) {
    // El servidor lo rechaza aunque pase el chequeo local: el limite del
    // proyecto/bucket en Supabase es menor que EXPO_PUBLIC_MAX_UPLOAD_MB.
    // El remedio es de quien administra el proyecto, no de quien sube la foto:
    // va a la consola, y a la pantalla solo lo que esa persona puede entender.
    console.warn(
      '[storage] archivo rechazado por tamaño: sube el límite en Storage → Settings → Upload file size limit (y en el bucket post-media)',
      error,
    );
    return 'El archivo es demasiado grande.';
  }
  if (code === '403' || /unauthorized|row-level security|violates/i.test(message)) {
    return 'No tienes permiso para subir este archivo. Cierra sesión y vuelve a entrar.';
  }
  if (code === '409' || /already exists/i.test(message)) {
    return 'Ya existe un archivo con ese nombre. Inténtalo de nuevo.';
  }
  if (/mime|content-type/i.test(message)) {
    console.warn(`[storage] el bucket no acepta este tipo de archivo (${message})`, error);
    return 'Ese tipo de archivo no se admite.';
  }
  console.warn(
    `[storage] Storage rechazó el archivo: ${message}${code ? ` (código ${code})` : ''}`,
    error,
  );
  return 'No se pudo subir el archivo. Inténtalo de nuevo.';
}

/**
 * A partir de este tamaño se usa subida reanudable (TUS) en vez de un POST
 * unico. Es el umbral que recomienda Supabase.
 */
export const RESUMABLE_THRESHOLD = 6 * 1024 * 1024;

/** Archivo local ya leido, listo para subir por cualquiera de las dos vias. */
export type LocalFile = {
  /** Tamaño real en bytes. */
  size: number;
  /** Cuerpo para el POST directo de supabase-js. */
  directBody: () => Promise<Blob | ArrayBuffer>;
  /** Cuerpo (Blob) para la subida reanudable por trozos (TUS). */
  resumableBody: () => Promise<Blob>;
};

/**
 * Prepara un archivo local para subirlo, leyendo su tamaño y sus bytes.
 *
 * El motivo de que exista: en React Native, `fetch(uri).blob()` devuelve un
 * Blob que informa bien su `size`, pero cuyo cuerpo viaja VACIO cuando
 * supabase-js lo envia en el POST. Una foto tomada desde el iPhone se subia
 * como 0 bytes y, claro, no se veia. Solo afectaba a los archivos por debajo
 * del umbral reanudable: los grandes van por TUS, que recorre el Blob por
 * trozos y si transmite el contenido.
 *
 * En nativo se leen los bytes reales con expo-file-system (`File.arrayBuffer`),
 * que supabase-js sube correctamente. En web el Blob funciona y se conserva tal
 * cual, sin cargar nada extra en memoria.
 */
export async function readLocalFile(uri: string): Promise<LocalFile> {
  if (Platform.OS === 'web') {
    const response = await fetch(uri);
    if (!response.ok) throw new Error('No se pudo leer el archivo seleccionado.');
    const blob = await response.blob();
    return {
      size: blob.size,
      directBody: async () => blob,
      resumableBody: async () => blob,
    };
  }
  // El tamaño se obtiene sin cargar el archivo entero en memoria.
  const file = new File(uri);
  const tamano = file.size ?? 0;
  if (tamano > 0) {
    return {
      size: tamano,
      directBody: () => file.arrayBuffer(),
      // TUS lee el Blob por trozos; ahi el contenido si viaja bien en RN.
      resumableBody: async () => (await fetch(uri)).blob(),
    };
  }

  /*
    Tamaño cero con una ruta `content://`: no es que el archivo este vacio.

    `File` de expo-file-system solo sabe leer rutas `file://`. Varios Android
    —depende del fabricante y de que selector abra el sistema— devuelven la foto
    como `content://`, que es un identificador dentro del proveedor de
    documentos, no una ruta en disco. Ahi no hay nada que medir y sale cero.

    POR QUE SE COPIA Y NO SE USA EL BLOB. La tentacion es `fetch(uri).blob()`,
    que si informa bien el tamaño. Pero en React Native ese Blob viaja VACIO
    cuando supabase-js lo manda en el POST —es el fallo que dio origen a esta
    funcion, y esta explicado en su cabecera—: subiria cero bytes diciendo que
    son dos megas. Copiar deja un archivo de verdad, y a partir de ahi todo
    funciona por el camino ya probado.

    La copia va por la API antigua a proposito: es la unica que sabe leer del
    proveedor de documentos de Android. Se importa aqui dentro para que no entre
    en el paquete de quien nunca la necesita (web, y todo `file://`).
  */
  const copia = await copiarDesdeElProveedor(uri);
  if (!copia) {
    return { size: 0, directBody: async () => new ArrayBuffer(0), resumableBody: async () => new Blob([]) };
  }
  const copiado = new File(copia);
  return {
    size: copiado.size ?? 0,
    directBody: () => copiado.arrayBuffer(),
    resumableBody: async () => (await fetch(copia)).blob(),
  };
}

/** Carpeta propia dentro de la cache, para poder limpiarla sin tocar nada mas. */
const CARPETA_DE_COPIAS = 'z-origen-content';

/**
 * Cuanto sobrevive una copia antes de que la borre la siguiente lectura.
 *
 * No se borra al terminar de subir porque `readLocalFile` no sabe cuando acaba
 * quien la llama —son cinco sitios distintos— y obligarles a avisar seria mas
 * facil de olvidar que de recordar. Diez minutos son de sobra para la subida
 * mas lenta y lo bastante poco para que la cache no crezca.
 */
const VIDA_DE_LA_COPIA_MS = 10 * 60 * 1000;

async function copiarDesdeElProveedor(uri: string): Promise<string | null> {
  try {
    const legacy = await import('expo-file-system/legacy');
    const cache = legacy.cacheDirectory;
    if (!cache) return null;

    const carpeta = `${cache}${CARPETA_DE_COPIAS}/`;
    const info = await legacy.getInfoAsync(carpeta);
    if (!info.exists) {
      await legacy.makeDirectoryAsync(carpeta, { intermediates: true });
    } else {
      // Barrido de lo viejo. Va antes de copiar y nunca despues de subir: si la
      // aplicacion se cierra a mitad de una subida, la copia igual desaparece.
      const ahora = Date.now();
      for (const nombre of await legacy.readDirectoryAsync(carpeta)) {
        const suyo = await legacy.getInfoAsync(`${carpeta}${nombre}`);
        const nacio = suyo.exists ? (suyo.modificationTime ?? 0) * 1000 : 0;
        if (ahora - nacio > VIDA_DE_LA_COPIA_MS) {
          await legacy.deleteAsync(`${carpeta}${nombre}`, { idempotent: true });
        }
      }
    }

    const destino = `${carpeta}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await legacy.copyAsync({ from: uri, to: destino });
    return destino;
  } catch {
    // Si el proveedor tampoco deja copiar, quien llama vera tamaño cero y dira
    // la verdad. Callar aqui es correcto: el mensaje util se da arriba, con el
    // contexto de que se estaba subiendo.
    return null;
  }
}

export type UploadPhase = 'compressing' | 'uploading';

export type UploadProgress = {
  phase: UploadPhase;
  /** Avance de 0 a 1. */
  ratio: number;
};

/**
 * Sube un medio (imagen/video/audio) al bucket post-media dentro de la carpeta
 * del usuario (uid/...), como exige la política RLS. Devuelve la ruta y su tipo.
 *
 * Antes comprime en el dispositivo y, si el archivo sigue siendo grande, lo
 * sube por trozos reanudables para sobrevivir a cortes de red.
 */
export async function uploadPostMedia(
  media: PickedMedia,
  onProgress?: (progress: UploadProgress) => void,
): Promise<UploadedMedia> {
  if (!supabase) throw new Error('Almacenamiento no disponible.');
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  const uid = session?.user?.id;
  if (!session || !uid) throw new Error('Inicia sesión para subir archivos.');

  // 1. Compresión en el dispositivo (no-op en web). Un video de galeria de
  //    100 MB suele bajar a 10-20 MB, que es lo que hace que subir por datos
  //    moviles sea viable.
  let uri = media.uri;
  let compressed = false;
  if (compressionAvailable && (media.kind === 'video' || media.kind === 'image')) {
    try {
      onProgress?.({ phase: 'compressing', ratio: 0 });
      uri =
        media.kind === 'video'
          ? await compressVideo(media.uri, (ratio) =>
              onProgress?.({ phase: 'compressing', ratio }),
            )
          : await compressImage(media.uri);
      compressed = uri !== media.uri;
    } catch {
      // Si la compresión falla no bloqueamos la publicación: sube el original,
      // pero mas abajo se comprueba que no sea desmesurado.
      uri = media.uri;
    }
  }

  /*
    Un video que no ha pasado por el compresor viaja con el tamaño original y
    con el indice al final del archivo. Se marca aqui para poder exigirle un
    tope mas estricto: hasta ahora subia en silencio y el problema no aparecia
    hasta que alguien intentaba verlo.
  */
  const videoSinComprimir = media.kind === 'video' && !compressed;

  // Tras comprimir el contenedor es otro (mp4/jpg), asi que el nombre original
  // ya no describe la extension real: se deduce de la ruta resultante.
  const ext = resolveExtension(compressed ? { ...media, uri, name: null } : media);
  const path = `${uid}/${randomName(ext)}`;
  const contentType = resolveContentType(
    compressed ? { ...media, mimeType: null } : media,
    ext,
  );

  const local = await readLocalFile(uri);

  if (local.size === 0) {
    throw new Error('El archivo seleccionado está vacío.');
  }
  if (local.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `El archivo pesa ${formatMb(local.size)} y el máximo son ${formatMb(MAX_UPLOAD_BYTES)}. Elige un video más corto o comprímelo antes de subirlo.`,
    );
  }
  if (videoSinComprimir && local.size > MAX_VIDEO_SIN_COMPRIMIR_BYTES) {
    throw new Error(
      `Este video pesa ${formatMb(local.size)} y no se pudo comprimir en este dispositivo. ` +
        `Súbelo desde la aplicación instalada, o elige uno de menos de ${formatMb(MAX_VIDEO_SIN_COMPRIMIR_BYTES)}: ` +
        'a ese tamaño tardaría demasiado en cargar y consumiría muchos datos a quien lo vea.',
    );
  }

  /*
    Metadata y poster ANTES de subir, con el archivo definitivo (el comprimido
    si lo hubo). Ninguno es imprescindible: si algo falla, el post sale igual
    que salia antes y el pipeline del backend puede completarlo despues.
  */
  const meta: Pick<UploadedMedia, 'width' | 'height' | 'durationS' | 'bytes'> = {
    bytes: local.size,
  };
  let posterPath: string | undefined;
  if (media.kind === 'video') {
    const fromFile = await readVideoMetadata(uri).catch(() => null);
    meta.width = fromFile?.width ?? media.width ?? undefined;
    meta.height = fromFile?.height ?? media.height ?? undefined;
    meta.durationS =
      fromFile?.durationS ?? (media.durationMs ? media.durationMs / 1000 : undefined);

    // El poster es la diferencia entre un rectangulo negro y ver de que va el
    // video sin descargar ni un byte de el.
    try {
      const poster = await createVideoPoster(uri);
      if (poster) {
        const posterLocal = await readLocalFile(poster.uri);
        if (posterLocal.size > 0) {
          const candidate = `${uid}/poster-${randomName('jpg')}`;
          const { error: posterError } = await supabase.storage
            .from(BUCKET)
            .upload(candidate, await posterLocal.directBody(), {
              contentType: 'image/jpeg',
              upsert: false,
            });
          if (!posterError) {
            posterPath = candidate;
            meta.width = meta.width ?? poster.width;
            meta.height = meta.height ?? poster.height;
          }
        }
      }
    } catch {
      // Sin poster: el muro pinta su celda generica, como hasta ahora.
    }
  } else if (media.kind === 'image') {
    // El compresor reescala en proporcion, asi que las medidas del selector
    // valen para reservar el hueco aunque el archivo subido sea mas pequeno.
    meta.width = media.width ?? undefined;
    meta.height = media.height ?? undefined;
  }

  onProgress?.({ phase: 'uploading', ratio: 0 });

  // 2a. Archivo grande: subida reanudable por trozos, con progreso real.
  if (local.size > RESUMABLE_THRESHOLD && supabaseUrl) {
    const { done } = uploadResumable({
      supabaseUrl,
      accessToken: session.access_token,
      bucket: BUCKET,
      path,
      file: await local.resumableBody(),
      contentType,
      onProgress: (ratio) => onProgress?.({ phase: 'uploading', ratio }),
    });
    try {
      await done;
    } catch (error) {
      throw new Error(describeStorageError(error));
    }
    return { storagePath: path, mediaType: media.kind, ...meta, posterPath };
  }

  // 2b. Archivo pequeño: un POST directo es mas simple y rapido.
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, await local.directBody(), { contentType, upsert: false });
  if (error) throw new Error(describeStorageError(error));
  onProgress?.({ phase: 'uploading', ratio: 1 });
  return { storagePath: path, mediaType: media.kind, ...meta, posterPath };
}

// --------------------------------------------------------------------------
// Fotos de perfil y portada
// --------------------------------------------------------------------------

const AVATAR_BUCKET = 'avatars';
/**
 * Tope del bucket `avatars`, fijado en la migracion 0004.
 *
 * Se repite aqui a proposito para poder avisar ANTES de subir: el servidor
 * responde 413 sin decir de que bucket habla, y el mensaje generico mandaba a
 * cambiar el limite del bucket equivocado.
 */
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/**
 * Ancho que se pide para una foto de perfil, en pixeles.
 *
 * Se sirve a 44 px como mucho, pero en una pantalla de 3x eso son 132 px
 * reales; 160 deja margen sin llegar a notarse en la factura de bytes.
 */
const ANCHO_AVATAR = 160;

/** Ancho para la portada, que si ocupa el ancho de la pantalla. */
const ANCHO_PORTADA = 1080;

/**
 * URL publica de una ruta del bucket `avatars` (avatar o portada).
 *
 * El bucket es publico, asi que no hace falta firmar y la URL no caduca, algo
 * importante porque la foto de perfil se pinta en cada tarjeta del feed.
 * Devuelve undefined cuando no hay foto, para que la vista use el placeholder.
 *
 * POR QUE SE PIDE UNA VERSION REDIMENSIONADA. Lo que se guarda es el fichero
 * tal cual sale de la camara. Medido contra produccion, un avatar real pesaba
 * 3 909 KB (1170x2532) y se pintaba en un circulo de 40 px: el telefono
 * descargaba 3,9 MB para ensenar el equivalente a 6 KB de pixeles. Con diez
 * caras en el muro eso son decenas de MB por pantalla, y es la causa principal
 * de que la aplicacion se sintiera lenta.
 *
 * Pidiendo el mismo fichero por `render/image` Storage devuelve la version ya
 * escalada: el mismo avatar baja a 17 KB a 96 px (230 veces menos). El
 * original no se toca ni se pierde; esto solo cambia lo que se pide.
 *
 * La URL sigue siendo estable —mismos parametros siempre— asi que la cache en
 * disco de `expo-image` sigue acertando. Si algun dia hiciera falta volver
 * atras, basta con devolver `getPublicUrl(path)` sin opciones.
 */
export function profileImageUrl(
  path: string | null | undefined,
  opciones?: { ancho?: number },
): string | undefined {
  if (!supabase || !path) return undefined;
  const width = opciones?.ancho ?? ANCHO_AVATAR;
  return supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path, {
    transform: { width, height: width, resize: 'cover', quality: 75 },
  }).data.publicUrl;
}

/** URL de una portada de perfil: misma foto, ancho de pantalla. */
export function coverImageUrl(path: string | null | undefined): string | undefined {
  if (!supabase || !path) return undefined;
  return supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path, {
    transform: { width: ANCHO_PORTADA, resize: 'contain', quality: 75 },
  }).data.publicUrl;
}

/**
 * Sube la foto de perfil o portada al bucket `avatars` y devuelve su RUTA.
 *
 * Se guarda la ruta (no la URL) porque es lo que persiste el backend: asi el
 * bucket puede pasar a privado sin reescribir la base de datos. La carpeta debe
 * empezar por el uid, que es lo que exige la politica RLS.
 */
export async function uploadProfileImage(
  kind: 'avatar' | 'cover',
  media: PickedMedia,
): Promise<string> {
  if (!supabase) throw new Error('Almacenamiento no disponible.');
  const { data } = await supabase.auth.getSession();
  const uid = data.session?.user?.id;
  if (!uid) throw new Error('Inicia sesión para cambiar tus fotos.');

  // Una foto de perfil no necesita la resolucion original de la camara.
  let uri = media.uri;
  /*
    Si el compresor llego a correr. Importa mas de lo que parece: la
    recompresion cambia el FORMATO del archivo, y con el, el tipo que hay que
    declarar al subirlo.
  */
  let comprimida = false;
  if (compressionAvailable) {
    try {
      uri = await compressImage(media.uri);
      comprimida = uri !== media.uri;
    } catch {
      uri = media.uri;
    }
  }

  const ext = resolveExtension({ ...media, uri, name: null });
  const path = `${uid}/${kind}-${randomName(ext)}`;

  const local = await readLocalFile(uri);
  if (local.size === 0) {
    /*
      Cero bytes casi nunca significa «la foto esta vacia».

      Antes esto pasaba siempre que un Android devolvia la foto como
      `content://`: no habia forma de leerla. Eso YA no ocurre —`readLocalFile`
      la copia del proveedor de documentos antes de medirla—, asi que llegar
      aqui con un `content://` significa que ni siquiera se pudo copiar, que es
      otra cosa y merece otro mensaje.
    */
    throw new Error(
      uri.startsWith('content://')
        ? 'Tu teléfono no dejó leer esa foto desde la galería. Prueba a hacerla con ' +
          'la cámara de la aplicación, o a elegirla desde Google Fotos.'
        : 'No pudimos leer la imagen seleccionada.',
    );
  }
  /*
    El bucket `avatars` tiene un tope de 5 MB (migracion 0004) y hasta ahora
    esta subida era la UNICA de las tres que no lo comprobaba: pasado el tope,
    el servidor devolvia un 413 y el mensaje generico hablaba de otro bucket.
    Una camara de 50 MP se lo salta sin esfuerzo cuando el compresor no esta
    disponible (Expo Go) o falla en silencio.
  */
  if (local.size > MAX_AVATAR_BYTES) {
    throw new Error(
      `La foto pesa ${formatMb(local.size)} y el máximo para una foto de perfil son ` +
        `${formatMb(MAX_AVATAR_BYTES)}. Recórtala o elige una más pequeña.`,
    );
  }

  const { error } = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(path, await local.directBody(), {
      /*
        EL TIPO SE DECLARA SOBRE EL ARCHIVO QUE SE SUBE, no sobre el que se
        eligio.

        Aqui se pasaba `media` entero, asi que ganaba el `mimeType` del
        selector. En un Android cuya galeria informa `image/heic`, el compresor
        entrega JPEG y el objeto quedaba guardado con bytes JPEG y la etiqueta
        `image/heic`: el bucket lo acepta (su lista permite `image/*`) pero el
        transformador de imagenes de Supabase —por el que pasa toda foto de
        perfil— no sabe que hacer con un archivo mal etiquetado, y el avatar
        salia en blanco. Las otras dos subidas ya anulaban el tipo tras
        comprimir; a esta se le habia pasado.
      */
      contentType: resolveContentType(comprimida ? { ...media, mimeType: null } : media, ext),
      upsert: false,
    });
  if (error) throw new Error(describeStorageError(error));
  return path;
}

/** Firma en lote rutas de post-media para poder mostrarlas (bucket privado). */
const COURSE_BUCKET = 'course-media';

/**
 * Sube el video (o material) de una leccion y devuelve su RUTA.
 *
 * Va al bucket `course-media`, no a `post-media`: admite 2 GB por archivo
 * (0004_storage_limits). Se guarda la ruta, no la URL, porque el bucket es
 * privado y las firmas caducan.
 *
 * LA RUTA ES LA PRUEBA DE PROPIEDAD:  `<uid>/<courseId>/<archivo>`
 *
 * Hasta la migracion 0028, escribir en este bucket estaba reservado a la
 * administracion, asi que cualquiera podia montar el esqueleto de un curso
 * —modulos y lecciones si le dejaba la RLS— y no podia subirle un solo video.
 * Un curso sin video no es un curso.
 *
 * Abrirlo del todo (`using (true)`) habria dejado que cualquiera escribiese
 * sobre cualquier archivo del bucket. En vez de eso, la carpeta dice de quien
 * es y de que curso, y la politica lo comprueba CONTRA LA TABLA `courses`: da
 * igual lo que mande el cliente, si ese curso no es suyo la base lo rechaza.
 *
 * El `courseId` no es opcional a proposito. Con un valor por defecto, olvidarlo
 * en una llamada nueva daria una ruta que la RLS rechaza, y el fallo aparece en
 * el unico sitio donde nadie lo esta mirando: subiendo un archivo grande.
 */
export async function uploadCourseMedia(
  media: PickedMedia,
  courseId: string,
  onProgress?: (progress: UploadProgress) => void,
): Promise<string> {
  if (!supabase) throw new Error('Almacenamiento no disponible.');
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  const uid = session?.user?.id;
  if (!session || !uid) throw new Error('Inicia sesión para subir el contenido.');

  let uri = media.uri;
  if (compressionAvailable && media.kind === 'video') {
    try {
      onProgress?.({ phase: 'compressing', ratio: 0 });
      uri = await compressVideo(media.uri, (ratio) =>
        onProgress?.({ phase: 'compressing', ratio }),
      );
    } catch {
      uri = media.uri;
    }
  }

  if (!courseId) throw new Error('Falta el curso al que pertenece el material.');

  const ext = resolveExtension({ ...media, uri, name: null });
  // `<uid>/<courseId>/…`: las dos carpetas que comprueba la politica de la
  // migracion 0028. Los archivos subidos ANTES viven en `<uid>/…` y se siguen
  // leyendo igual; no se mueve ni se renombra nada.
  const path = `${uid}/${courseId}/${randomName(ext)}`;
  const contentType = resolveContentType({ ...media, mimeType: null }, ext);

  const local = await readLocalFile(uri);
  if (local.size === 0) throw new Error('El archivo seleccionado está vacío.');

  onProgress?.({ phase: 'uploading', ratio: 0 });

  // Igual que en las publicaciones: por encima del umbral, subida reanudable.
  if (local.size > RESUMABLE_THRESHOLD && supabaseUrl) {
    const { done } = uploadResumable({
      supabaseUrl,
      accessToken: session.access_token,
      bucket: COURSE_BUCKET,
      path,
      file: await local.resumableBody(),
      contentType,
      onProgress: (ratio) => onProgress?.({ phase: 'uploading', ratio }),
    });
    try {
      await done;
    } catch (error) {
      throw new Error(describeStorageError(error));
    }
    return path;
  }

  const { error } = await supabase.storage
    .from(COURSE_BUCKET)
    .upload(path, await local.directBody(), { contentType, upsert: false });
  if (error) throw new Error(describeStorageError(error));
  onProgress?.({ phase: 'uploading', ratio: 1 });
  return path;
}

/** Firma rutas del bucket `course-media` (privado, como post-media). */
export async function signCourseUrls(paths: string[]): Promise<Record<string, string>> {
  if (!supabase || paths.length === 0) return {};
  const { data, error } = await supabase.storage
    .from(COURSE_BUCKET)
    .createSignedUrls(paths, SIGNED_URL_TTL);
  if (error || !data) return {};
  const map: Record<string, string> = {};
  for (const item of data) {
    if (item.path && item.signedUrl) map[item.path] = item.signedUrl;
  }
  return map;
}

export async function signMediaUrls(
  paths: string[],
): Promise<Record<string, string>> {
  if (!supabase || paths.length === 0) return {};

  // Las firmas guardadas del arranque anterior cuentan como cache valida.
  await ensureSignedCacheLoaded();

  // Solo se piden las que no estan en cache o estan a punto de caducar.
  const now = Date.now();
  const map: Record<string, string> = {};
  const missing: string[] = [];
  for (const path of paths) {
    const hit = signedUrlCache.get(path);
    if (hit && hit.expiresAt > now) map[path] = hit.url;
    else missing.push(path);
  }
  if (missing.length === 0) return map;

  /*
    LO QUE YA SE ESTA FIRMANDO NO SE VUELVE A FIRMAR.

    Al arrancar hay tres llamadas a la vez con rutas que se solapan: la
    instantanea del feed, la primera pagina de red y el feed de video. Las tres
    calculaban `missing` ANTES de que ninguna hubiera escrito en la cache, asi
    que una misma ruta se firmaba dos o tres veces.

    Y cada firma de la misma ruta devuelve una URL DISTINTA, que es el problema
    de verdad: `expo-image` y `expo-video` guardan en disco POR URL, asi que
    tres firmas del mismo video son tres descargas del mismo video. Medido en
    la web desplegada: el mismo .mp4 bajado tres veces en una sola visita a
    Inicio, con tres firmas distintas.

    Con este mapa, quien llega segundo espera el resultado del primero en vez
    de pedir otra firma. Mismo fichero, misma URL, una sola descarga.
  */
  const esperando: string[] = [];
  const nuevas: string[] = [];
  for (const path of missing) {
    if (firmasEnVuelo.has(path)) esperando.push(path);
    else nuevas.push(path);
  }

  const promesas = new Map<string, Promise<string | undefined>>();
  for (const path of esperando) {
    const enVuelo = firmasEnVuelo.get(path);
    if (enVuelo) promesas.set(path, enVuelo);
  }

  if (nuevas.length > 0) {
    const lote = (async (): Promise<Record<string, string>> => {
      const salida: Record<string, string> = {};
      const { data, error } = await supabase!.storage
        .from(BUCKET)
        .createSignedUrls(nuevas, SIGNED_URL_TTL);
      if (error || !data) return salida;
      const expiresAt = Date.now() + CACHE_TTL_MS;
      for (const item of data) {
        if (item.path && item.signedUrl) {
          salida[item.path] = item.signedUrl;
          signedUrlCache.set(item.path, { url: item.signedUrl, expiresAt });
        }
      }
      scheduleSignedCacheSave();
      return salida;
    })();

    for (const path of nuevas) {
      // Una promesa por ruta, para que quien espere solo dependa de LO SUYO.
      const suya = lote.then((s) => s[path]).catch(() => undefined);
      promesas.set(path, suya);
      firmasEnVuelo.set(path, suya);
    }
    // Se sueltan pase lo que pase: dejar una firma fallida marcada como «en
    // vuelo» bloquearia esa imagen para siempre.
    void lote
      .catch(() => {})
      .finally(() => {
        for (const path of nuevas) firmasEnVuelo.delete(path);
      });
  }

  const pendientes = [...promesas.keys()];
  const resueltas = await Promise.all(pendientes.map((p) => promesas.get(p)!));
  pendientes.forEach((path, i) => {
    const url = resueltas[i];
    if (url) map[path] = url;
  });
  return map;
}

/** Se vacia al cerrar sesion: las firmas van atadas al usuario. */
export function clearSignedUrlCache(): void {
  signedUrlCache.clear();
  AsyncStorage.removeItem(SIGNED_CACHE_STORAGE_KEY).catch(() => {});
  // La instantanea del Inicio tambien: el contenido guardado es de quien lo
  // vio, y quedaria visible para la siguiente persona que entrara sin red.
  void olvidarInstantaneaDeVideos();
}
