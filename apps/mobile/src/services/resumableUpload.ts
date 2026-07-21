import * as tus from 'tus-js-client';

/**
 * Supabase Storage expone un endpoint TUS (subida reanudable). Frente al POST
 * unico, trocea el archivo y reintenta solo el trozo que fallo: si se cae la
 * conexion al 90 % de un video, no se vuelve a empezar desde cero.
 *
 * Supabase exige un chunkSize de EXACTAMENTE 6 MB; cualquier otro valor da 400.
 */
const CHUNK_SIZE = 6 * 1024 * 1024;

export type ResumableUploadOptions = {
  supabaseUrl: string;
  accessToken: string;
  bucket: string;
  /** Ruta destino dentro del bucket (uid/archivo.mp4). */
  path: string;
  file: Blob;
  contentType: string;
  /** Progreso de 0 a 1. */
  onProgress?: (ratio: number) => void;
};

/** Handle para poder cancelar una subida en curso. */
export type ResumableUploadHandle = {
  done: Promise<void>;
  abort: () => void;
};

export function uploadResumable({
  supabaseUrl,
  accessToken,
  bucket,
  path,
  file,
  contentType,
  onProgress,
}: ResumableUploadOptions): ResumableUploadHandle {
  let upload: tus.Upload;

  const done = new Promise<void>((resolve, reject) => {
    upload = new tus.Upload(file, {
      endpoint: `${supabaseUrl}/storage/v1/upload/resumable`,
      // Espera creciente entre reintentos: cubre desde un microcorte hasta un
      // cambio de wifi a datos moviles sin perder lo ya subido.
      retryDelays: [0, 1000, 3000, 5000, 10000, 20000],
      headers: {
        authorization: `Bearer ${accessToken}`,
        'x-upsert': 'false',
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      chunkSize: CHUNK_SIZE,
      metadata: {
        bucketName: bucket,
        objectName: path,
        contentType,
        cacheControl: '3600',
      },
      onError: (error) => reject(error),
      onProgress: (uploaded, total) => {
        if (total > 0) onProgress?.(uploaded / total);
      },
      onSuccess: () => resolve(),
    });

    // Si quedo una subida a medias del mismo archivo, se reanuda en vez de
    // volver a empezar.
    upload
      .findPreviousUploads()
      .then((previous) => {
        if (previous.length > 0 && previous[0]) {
          upload.resumeFromPreviousUpload(previous[0]);
        }
        upload.start();
      })
      .catch(() => upload.start());
  });

  return {
    done,
    abort: () => {
      void upload?.abort();
    },
  };
}
