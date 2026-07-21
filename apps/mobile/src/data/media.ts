// Recursos multimedia de muestra (mock). Al integrar backend, estas URLs/assets
// se reemplazan por los del contenido real.

// Audio de muestra empaquetado en la app.
export const SAMPLE_AUDIO = require('../../assets/sample-audio.wav');

// Video de muestra público — corto y liviano (~790 KB, ~10 s), hace loop limpio.
// Nota: el bucket `gtv-videos-bucket` de Google que se usaba antes empezó a
// responder HTTP 403, por eso se cambió de origen.
export const SAMPLE_VIDEO_URL = 'https://www.w3schools.com/html/mov_bbb.mp4';
