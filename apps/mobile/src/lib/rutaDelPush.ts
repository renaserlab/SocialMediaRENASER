/**
 * A dónde lleva TOCAR un push.
 *
 * Hasta el 25/09/2026 tocar un push solo abría la aplicación, sin llevar a
 * ningún sitio. Con el aviso «Juan está transmitiendo en vivo» eso no vale: el
 * aviso invita a entrar al directo, y abrir el muro obligaría a buscarlo.
 *
 * Hoy solo los directos (`live_started`, ver `live/avisos.py` en la API). El
 * resto de avisos siguen abriendo la aplicación sin más, como antes.
 *
 * LOS DATOS DEL PUSH NO SON DE FIAR para construir rutas: llegan de fuera de la
 * aplicación. El identificador tiene que ser un UUID; cualquier otra cosa no
 * lleva a ningún sitio, en vez de acabar metida en una ruta.
 *
 * Sin imports: se prueba tal cual con `node --test` (`rutaDelPush.test.mts`).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function rutaDelPush(datos: unknown): string | null {
  if (datos === null || typeof datos !== 'object') return null;
  const d = datos as Record<string, unknown>;
  if (d.type === 'live_started' && typeof d.liveId === 'string' && UUID.test(d.liveId)) {
    return `/live/${d.liveId}`;
  }
  return null;
}

/** El directo al que lleva un push, o `null`. Para no anunciarlo otra vez al abrir. */
export function directoDelPush(datos: unknown): string | null {
  const ruta = rutaDelPush(datos);
  return ruta?.startsWith('/live/') ? ruta.slice('/live/'.length) : null;
}
