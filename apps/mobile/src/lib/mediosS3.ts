/**
 * Videos guardados en S3 + CloudFront (opcion B): lo que cambia al LEERLOS.
 *
 * POR QUE UN MODULO APARTE Y SIN DEPENDENCIAS. Conviven dos almacenes: lo de
 * siempre en Supabase Storage, que se firma en el telefono con su cache de
 * firmas, y los videos nuevos en S3, que la API entrega YA firmados. Mezclar
 * las dos reglas dentro del repositorio dejaba la rama vieja a merced de
 * cualquier retoque de la nueva. Aqui las decisiones son funciones puras: se
 * prueban sin red ni React Native (`mediosS3.test.mts`), y quien las usa
 * (mapper, repositorio, `signMediaUrls`) solo las llama.
 *
 * REGLA DE ORO: si la API no dice `almacen: 's3'` —servidor viejo, bandera
 * apagada—, todo se comporta EXACTAMENTE como antes.
 */

/** Lo que la API anade a cada medio de una publicacion en filas `s3`. */
export type MedioConUrlsDeS3 = {
  almacen?: 'supabase' | 's3' | null;
  poster_path?: string | null;
  media_url?: string | null;
  poster_url?: string | null;
  stream_url?: string | null;
  urls_expiran?: string | null;
};

/**
 * Lo que una fila `s3` pisa en el `Post` del modelo de vista.
 *
 * Opcionales en el TIPO solo para que TypeScript deje propagarlo encima de lo
 * ya calculado; en ejecucion `camposDeS3` pone SIEMPRE las cinco claves, aunque
 * valgan `undefined`, porque tienen que pisar lo de Supabase.
 */
export type CamposDeS3 = {
  mediaUrl?: string;
  posterUrl?: string;
  posterPath?: string;
  streamUrl?: string;
  urlsExpiran?: string;
};

/**
 * La ruta sin la query.
 *
 * Las caches de disco se indexan por una clave ESTABLE (ver «Rendimiento» en
 * el CLAUDE.md). En Supabase es la ruta del bucket; en S3, la clave del objeto
 * (`videos/<uid>/<media_id>/poster-v1.jpg`). Si algun dia la API mandara la
 * clave con algo detras de `?`, la firma se colaria en la clave de cache y
 * cada refirma volveria a descargar la portada: por eso se corta aqui.
 */
export function claveSinQuery(ruta: string | null | undefined): string | undefined {
  if (!ruta) return undefined;
  const corte = ruta.indexOf('?');
  return corte >= 0 ? ruta.slice(0, corte) : ruta;
}

/**
 * Las claves de S3 empiezan por su carpeta de nivel superior; las rutas del
 * bucket de Supabase, por el uid de quien sube (la RLS lo exige). Nunca se
 * confunden, y eso permite que `signMediaUrls` se niegue a firmar una clave de
 * S3 aunque algun llamador despistado se la pase: Supabase contestaria con un
 * error y, peor, la guardaria como fallo en su cache.
 */
export function esClaveDeS3(ruta: string): boolean {
  return /^(videos|pendientes|borrados)\//.test(ruta);
}

/**
 * La URL del HLS, absoluta.
 *
 * La API puede mandarla relativa (`/api/v1/media/{id}/hls/master.m3u8?t=…`)
 * porque es ella misma quien reescribe las listas con el token. El reproductor
 * nativo no sabe de bases, asi que se resuelve contra la misma base de la API
 * que usa toda la app. Cualquier otra cosa rara se descarta: sin HLS se usa el
 * MP4, que es el respaldo seguro (ver `elegirFuenteDeVideo`).
 */
export function resolverStreamUrl(
  stream: string | null | undefined,
  baseDeLaApi: string,
): string | undefined {
  if (!stream) return undefined;
  if (/^https?:\/\//i.test(stream)) return stream;
  if (stream.startsWith('/')) return `${baseDeLaApi.replace(/\/+$/, '')}${stream}`;
  return undefined;
}

/**
 * Los campos de vista de una fila `s3`, o nada si la fila es de Supabase.
 *
 * Devuelve las claves AUNQUE valgan `undefined` a proposito: el mapper las
 * propaga al final del objeto y tienen que PISAR lo calculado para Supabase
 * (sobre todo el HLS armado a mano, que sin el token de la API no abre).
 */
export function camposDeS3(
  medio: MedioConUrlsDeS3 | null | undefined,
  baseDeLaApi: string,
): CamposDeS3 {
  if (!medio || medio.almacen !== 's3') return {};
  return {
    mediaUrl: medio.media_url ?? undefined,
    posterUrl: medio.poster_url ?? undefined,
    posterPath: claveSinQuery(medio.poster_path),
    streamUrl: resolverStreamUrl(medio.stream_url, baseDeLaApi),
    urlsExpiran: medio.urls_expiran ?? undefined,
  };
}

/** Lo minimo de un `Post` que mira la fase de firmas. */
type ConRutas = {
  mediaPath?: string;
  posterPath?: string;
  mediaUrl?: string;
  posterUrl?: string;
  mediaAlmacen?: 'supabase' | 's3';
};

/**
 * Las rutas que hay que firmar en Supabase, sin repetir y en orden.
 *
 * Las filas `s3` NO aportan nada: sus rutas son claves de S3 y sus URLs ya
 * vienen firmadas. Para el resto, lo mismo que se hacia antes.
 */
export function rutasParaFirmar(items: ConRutas[]): string[] {
  const rutas = new Set<string>();
  for (const item of items) {
    if (item.mediaAlmacen === 's3') continue;
    if (item.mediaPath) rutas.add(item.mediaPath);
    if (item.posterPath) rutas.add(item.posterPath);
  }
  return [...rutas];
}

/**
 * Pone las firmas de Supabase en cada publicacion. Las filas `s3` se devuelven
 * tal cual (mismo objeto). Las de Supabase siguen la regla de siempre: copia
 * solo si hay algo que poner, y lo que no se pudo firmar conserva lo anterior.
 */
export function aplicarFirmas<T extends ConRutas>(
  items: T[],
  urls: Record<string, string>,
): T[] {
  return items.map((item) => {
    if (item.mediaAlmacen === 's3') return item;
    const mediaUrl = item.mediaPath ? urls[item.mediaPath] : undefined;
    const posterUrl = item.posterPath ? urls[item.posterPath] : undefined;
    if (!mediaUrl && !posterUrl) return item;
    return {
      ...item,
      mediaUrl: mediaUrl ?? item.mediaUrl,
      posterUrl: posterUrl ?? item.posterUrl,
    };
  });
}

/** Un medio ya subido, visto desde lo que viaja a `POST/PATCH /posts`. */
export type MedioParaPublicar = {
  storagePath: string;
  mediaType: string;
  width?: number;
  height?: number;
  durationS?: number;
  bytes?: number;
  posterPath?: string;
  /** Subida pendiente en S3 (`POST /medios/subidas`). Con esto NO va ruta. */
  idDeSubida?: string;
  idDeSubidaPoster?: string;
};

/**
 * El elemento de `media[]` que se manda al publicar o editar.
 *
 * Un video subido a S3 viaja por su `id_de_subida` y SIN `storage_path`: la
 * API comprueba que la pendiente es de esta cuenta, la copia a su sitio
 * definitivo y es ella quien decide la clave (para filas `s3` ignora cualquier
 * ruta que mande el cliente). Todo lo demas, igual que siempre.
 */
export function cuerpoDeMedio(m: MedioParaPublicar): Record<string, unknown> {
  if (m.idDeSubida) {
    return {
      media_type: m.mediaType,
      id_de_subida: m.idDeSubida,
      ...(m.idDeSubidaPoster ? { id_de_subida_poster: m.idDeSubidaPoster } : {}),
      width: m.width ?? null,
      height: m.height ?? null,
      duration_s: m.durationS ?? null,
      bytes: m.bytes ?? null,
    };
  }
  return {
    storage_path: m.storagePath,
    media_type: m.mediaType,
    // Metadata calculada en el dispositivo. Un backend anterior a la
    // migracion 0021 ignora estos campos sin quejarse (Pydantic descarta
    // lo que no conoce), asi que la app funciona contra ambas versiones.
    width: m.width ?? null,
    height: m.height ?? null,
    duration_s: m.durationS ?? null,
    bytes: m.bytes ?? null,
    poster_path: m.posterPath ?? null,
  };
}
