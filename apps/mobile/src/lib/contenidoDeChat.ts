/**
 * El contenido compartido de un chat, listo para pintarse como en cualquier
 * mensajería: fotos y vídeos en una cuadrícula, y los enlaces como una lista.
 *
 * Aquí está lo que se decide sin pantalla y sin red: aplanar los mensajes en
 * teselas, partir una lista en filas, sacar el nombre de un sitio de su
 * dirección y escribir una duración.
 *
 * NADA SE FILTRA AQUÍ. Qué mensajes pertenecen a «Media» o a «Enlaces» lo
 * decide el servidor (`messaging/vistas.py`); esto solo ordena lo que llega.
 *
 * Sin importaciones, a propósito: se prueba con `node --test` tal cual.
 */

type AdjuntoMinimo = { id: string; kind: string };
type MensajeMinimo = { id: string; adjuntos: readonly AdjuntoMinimo[] };

/** Una foto o un vídeo de la cuadrícula, con el mensaje del que cuelga. */
export type Tesela<M extends MensajeMinimo> = {
  clave: string;
  mensaje: M;
  adjunto: M['adjuntos'][number];
};

/**
 * Las fotos y los vídeos de unos mensajes, uno por tesela y en su orden.
 *
 * UN MENSAJE CON CINCO FOTOS SON CINCO TESELAS: en la cuadrícula se mira cada
 * imagen, no cada mensaje. `solo` deja únicamente fotos o únicamente vídeos, y
 * hace falta aunque el servidor ya haya filtrado: un mensaje con una foto y un
 * vídeo llega entero a las dos vistas.
 */
export function teselasDe<M extends MensajeMinimo>(
  mensajes: readonly M[],
  solo: 'todo' | 'image' | 'video' = 'todo',
): Tesela<M>[] {
  const salida: Tesela<M>[] = [];
  for (const mensaje of mensajes) {
    for (const adjunto of mensaje.adjuntos) {
      if (adjunto.kind !== 'image' && adjunto.kind !== 'video') continue;
      if (solo !== 'todo' && adjunto.kind !== solo) continue;
      salida.push({ clave: `${mensaje.id}:${adjunto.id}`, mensaje, adjunto });
    }
  }
  return salida;
}

/** Los adjuntos de un tipo, uno por fila y con su mensaje: archivos o audios. */
export function adjuntosDe<M extends MensajeMinimo>(
  mensajes: readonly M[],
  tipo: string,
): Tesela<M>[] {
  const salida: Tesela<M>[] = [];
  for (const mensaje of mensajes) {
    for (const adjunto of mensaje.adjuntos) {
      if (adjunto.kind === tipo) {
        salida.push({ clave: `${mensaje.id}:${adjunto.id}`, mensaje, adjunto });
      }
    }
  }
  return salida;
}

/** Parte una lista en filas de `columnas`. La última puede quedar corta. */
export function enFilasDe<T>(lista: readonly T[], columnas: number): T[][] {
  // Un número de columnas que no vale —cero, o un ancho que aún no se ha
  // medido— no puede dejar la lista sin pintar: se va de uno en uno.
  const ancho = Number.isFinite(columnas) && columnas >= 1 ? Math.floor(columnas) : 1;
  const filas: T[][] = [];
  for (let i = 0; i < lista.length; i += ancho) filas.push(lista.slice(i, i + ancho));
  return filas;
}

/** Cuántas teselas caben por fila: tres en un teléfono, más en algo ancho. */
export function columnasDeRejilla(anchoDePantalla: number): number {
  if (!(anchoDePantalla > 0)) return 3;
  if (anchoDePantalla >= 1000) return 6;
  if (anchoDePantalla >= 700) return 5;
  if (anchoDePantalla >= 520) return 4;
  return 3;
}

/** `75` → `1:15`. Vacío si no se sabe: mejor nada que `0:00`. */
export function duracionLegible(segundos: number | null | undefined): string {
  if (typeof segundos !== 'number' || !Number.isFinite(segundos) || segundos <= 0) return '';
  const total = Math.round(segundos);
  const horas = Math.floor(total / 3600);
  const minutos = Math.floor((total % 3600) / 60);
  const resto = String(total % 60).padStart(2, '0');
  return horas > 0
    ? `${horas}:${String(minutos).padStart(2, '0')}:${resto}`
    : `${minutos}:${resto}`;
}

/** Los prefijos que no dicen nada del sitio: `m.shein.com` es Shein. */
const PREFIJOS_SIN_NOMBRE = new Set(['www', 'm', 'mobile', 'amp']);
/** Los que van delante del país: en `gob.pe`, el nombre no es «gob». */
const SEGUNDO_NIVEL = new Set(['com', 'co', 'org', 'net', 'gob', 'gov', 'edu', 'ac']);

/**
 * El sitio de una dirección: `https://m.shein.com/pe/x` → `shein.com`.
 *
 * Se saca a mano y no con `URL`: lo que se escribe en un chat no siempre trae
 * `https://` y en algunos motores `URL` no lo perdona. Cadena vacía si no se
 * entiende.
 */
export function sitioDe(direccion: string | null | undefined): string {
  const limpia = (direccion ?? '').trim().toLowerCase();
  if (!limpia) return '';
  const sinEsquema = limpia.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const anfitrion = (sinEsquema.split(/[/?#]/)[0] ?? '').replace(/^[^@]*@/, '').replace(/:\d+$/, '');
  if (!anfitrion || !/^[a-z0-9.-]+$/.test(anfitrion)) return '';
  const partes = anfitrion.split('.').filter(Boolean);
  while (partes.length > 2 && PREFIJOS_SIN_NOMBRE.has(partes[0] as string)) partes.shift();
  return partes.join('.');
}

/**
 * El nombre con el que se reconoce un sitio: `shein.com` → `Shein`,
 * `docs.google.com` → `Google`, `minedu.gob.pe` → `Minedu`.
 *
 * No hay vista previa de la página (pedirla sería visitar cada enlace en
 * nombre de quien mira), así que el nombre sale de la propia dirección.
 */
export function nombreDeSitio(sitio: string): string {
  const partes = sitio.split('.').filter(Boolean);
  if (partes.length === 0) return '';
  // Una dirección numérica no tiene nombre: se enseña tal cual.
  if (partes.every((parte) => /^\d+$/.test(parte))) return sitio;
  let indice = partes.length - 2;
  const ultima = partes[partes.length - 1] as string;
  if (
    partes.length >= 3 &&
    ultima.length === 2 &&
    SEGUNDO_NIVEL.has(partes[partes.length - 2] as string)
  ) {
    indice = partes.length - 3;
  }
  const nombre = partes[Math.max(0, indice)] as string;
  return nombre.charAt(0).toUpperCase() + nombre.slice(1);
}

/** Las direcciones distintas de un texto ya partido en trozos, en su orden. */
export function direccionesDe(
  trozos: readonly { tipo: string; direccion?: string }[],
): string[] {
  const vistas = new Set<string>();
  const salida: string[] = [];
  for (const trozo of trozos) {
    if (trozo.tipo !== 'enlace' || !trozo.direccion || vistas.has(trozo.direccion)) continue;
    vistas.add(trozo.direccion);
    salida.push(trozo.direccion);
  }
  return salida;
}
