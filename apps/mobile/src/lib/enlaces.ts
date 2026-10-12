import type { TranslationKey } from '@/i18n';

/**
 * Enlaces publicos al contenido de Z, y el texto con el que se comparten.
 *
 * EL FALLO QUE ARREGLA. Los tres botones de compartir (el muro, el feed de
 * video y el audio) mandaban SOLO TEXTO: «Mira este short de Katherine en Z.».
 * Quien recibia el mensaje no tenia forma de llegar al contenido; el enlace es
 * justo lo unico que hacia falta.
 *
 * Vive aqui, en `lib/`, y no dentro de cada componente, por dos motivos: la
 * construccion de la URL es una sola decision (si se copia tres veces, la
 * siguiente correccion se aplica a dos), y `src/lib/*.test.mts` es lo unico
 * que el runner de node sabe ejecutar.
 */

/**
 * De donde sale la direccion de la web. NO se escribe a fuego.
 *
 * Mismo criterio que `EXPO_PUBLIC_API_URL`: valor por perfil en `eas.json` y
 * copia en `.env`/`.env.example`. El nombre esta aqui como constante para que
 * los mensajes de aviso y las pruebas hablen de la misma variable.
 *
 * Ojo al tocar esto: Metro sustituye `process.env.EXPO_PUBLIC_*` por el texto
 * literal al empaquetar, asi que la lectura tiene que escribirse entera y tal
 * cual. Leerla dentro de la funcion —y no en una constante de modulo— es lo
 * que permite probarla sin reimportar.
 */
export const VARIABLE_DE_LA_WEB = 'EXPO_PUBLIC_WEB_URL';

/**
 * Cómo se traduce la frase que se comparte.
 *
 * Lo pasa quien pinta. Este módulo NO puede importar el diccionario: se prueba
 * con el runner de Node, que no resuelve el alias `@/`. Sin traductor se
 * escribe en español, que es el idioma de referencia.
 */
export type TraductorDeEnlaces = (
  clave: TranslationKey,
  params?: Record<string, string | number>,
) => string;

/**
 * El español de cada clave.
 *
 * Es el mismo texto que hay en `i18n/es.ts`, y que no se desvíen lo comprueba
 * `i18n/diccionariosSincronizados.test.mts`.
 */
export const RESPALDOS_ES = {
  'share.audio': 'Escucha este audio en Z',
  'share.audioBy': 'Escucha este audio de {nombre} en Z',
  'share.video': 'Mira este video en Z',
  'share.videoBy': 'Mira este video de {nombre} en Z',
  'share.post': 'Mira esta publicación en Z',
  'share.postBy': 'Mira esta publicación de {nombre} en Z',
  'share.live': 'Mira esta transmisión en vivo en Z',
  'share.liveBy': 'Mira la transmisión en vivo de {nombre} en Z',
  'share.group': 'Únete a mi grupo en Z',
  'share.groupNamed': 'Únete al grupo «{nombre}» en Z',
} as const;

const enEspanol: TraductorDeEnlaces = (clave, params) => {
  let texto: string = RESPALDOS_ES[clave as keyof typeof RESPALDOS_ES] ?? '';
  for (const [nombre, valor] of Object.entries(params ?? {})) {
    texto = texto.replace(`{${nombre}}`, String(valor));
  }
  return texto;
};

/** Que se esta compartiendo. Cambia el verbo, no la ruta: todo es un post. */
export type ClaseDeContenido = 'publicacion' | 'video' | 'audio';

/** Lo que se le entrega a `Share.share`. */
export type MensajeCompartido = {
  message: string;
  /** La URL suelta, o `null` si no se pudo construir. Sirve para probar. */
  url: string | null;
};

/**
 * La direccion de la web, ya normalizada, o `null` si no sirve.
 *
 * Se exige HTTPS a proposito. Un enlace `http://` o un `localhost` no llevan a
 * nadie al contenido desde el telefono de otra persona: compartir una URL rota
 * es PEOR que compartir solo texto, porque parece que funciona. Ante la duda,
 * esta funcion devuelve `null` y el mensaje se queda sin enlace.
 */
export function baseDeLaWeb(): string | null {
  const bruto = process.env.EXPO_PUBLIC_WEB_URL;
  if (typeof bruto !== 'string') return null;

  const limpio = bruto.trim().replace(/\/+$/, '');
  if (!limpio.startsWith('https://')) return null;
  // Tiene que quedar algo detras del esquema: «https://» a secas no es un sitio.
  if (limpio.length <= 'https://'.length) return null;
  return limpio;
}

/**
 * Enlace canonico a una publicacion: `/post/{id}`.
 *
 * Vale para texto, foto, video y audio porque en este producto TODO es una
 * publicacion; `PostDetailScreen` la pide al servidor por id, asi que el
 * enlace abre igual con la aplicacion recien arrancada.
 *
 * `null` si falta la configuracion o el id: quien llame decide, y lo que hacen
 * todos es compartir sin enlace en vez de inventarse un dominio.
 */
export function enlaceDePublicacion(postId: string | null | undefined): string | null {
  const base = baseDeLaWeb();
  if (!base || !postId) return null;
  return `${base}/post/${encodeURIComponent(postId)}`;
}

/**
 * La frase, sin enlace.
 *
 * Degrada con dignidad cuando no hay nombre: «Mira esta publicación en Z» se
 * lee bien, y es preferible a colar un «de undefined» o un nombre inventado.
 */
export function textoParaCompartir(
  clase: ClaseDeContenido,
  autor?: string | null,
  traducir: TraductorDeEnlaces = enEspanol,
): string {
  const nombre = autor?.trim();
  /*
    Con nombre y sin nombre son DOS frases, no una con un trozo pegado: en
    ingles el «de {nombre}» va en otro sitio, y armarla concatenando dejaria
    la version traducida mal escrita.
  */
  if (clase === 'audio') {
    return nombre ? traducir('share.audioBy', { nombre }) : traducir('share.audio');
  }
  if (clase === 'video') {
    return nombre ? traducir('share.videoBy', { nombre }) : traducir('share.video');
  }
  return nombre ? traducir('share.postBy', { nombre }) : traducir('share.post');
}

/**
 * Texto + enlace, listo para `Share.share`.
 *
 * La URL va DENTRO de `message` y no en el campo `url`. Android ignora `url`
 * por completo (solo mira `message`), asi que separarlos dejaria el enlace
 * fuera justo en la plataforma principal; y ponerlo en los dos sitios lo
 * duplica en iOS y en `navigator.share`. Un unico sitio, en el que funciona
 * siempre.
 */
export function compartirPublicacion(opciones: {
  postId: string | null | undefined;
  autor?: string | null;
  clase?: ClaseDeContenido;
  /** El idioma, que lo pone quien pinta. Sin él se escribe en español. */
  traducir?: TraductorDeEnlaces;
}): MensajeCompartido {
  const clase = opciones.clase ?? 'publicacion';
  const texto = textoParaCompartir(clase, opciones.autor, opciones.traducir);
  const url = enlaceDePublicacion(opciones.postId);
  return { message: url ? `${texto}\n${url}` : texto, url };
}

/**
 * Enlace a la sala de un directo: `/live/{id}`.
 *
 * Es la misma ruta que abre la aplicacion (`app/live/[id].tsx`), asi que el
 * enlace lleva a ESE directo y no a una portada. `null` con las mismas
 * condiciones que el de una publicacion.
 */
export function enlaceDeDirecto(emisionId: string | null | undefined): string | null {
  const base = baseDeLaWeb();
  if (!base || !emisionId) return null;
  return `${base}/live/${encodeURIComponent(emisionId)}`;
}

/**
 * Texto + enlace de un directo, listo para `Share.share`.
 *
 * Mismo criterio que `compartirPublicacion`: la URL va dentro de `message`, y
 * con nombre y sin nombre son dos frases distintas.
 */
export function compartirDirecto(opciones: {
  emisionId: string | null | undefined;
  anfitrion?: string | null;
  traducir?: TraductorDeEnlaces;
}): MensajeCompartido {
  const traducir = opciones.traducir ?? enEspanol;
  const nombre = opciones.anfitrion?.trim();
  const texto = nombre ? traducir('share.liveBy', { nombre }) : traducir('share.live');
  const url = enlaceDeDirecto(opciones.emisionId);
  return { message: url ? `${texto}
${url}` : texto, url };
}

/**
 * Enlace de invitacion a un grupo: `/grupo/{codigo}`.
 *
 * Lleva a la TARJETA del grupo, desde la que se pide entrar. No mete a nadie:
 * quien administra el grupo decide. El codigo es el secreto del enlace, y
 * cambiarlo en la ficha del grupo deja este enlace sin efecto.
 */
export function enlaceDeGrupo(codigo: string | null | undefined): string | null {
  const base = baseDeLaWeb();
  if (!base || !codigo) return null;
  return `${base}/grupo/${encodeURIComponent(codigo)}`;
}

/** Texto + enlace de un grupo, listo para `Share.share`. */
export function compartirGrupo(opciones: {
  codigo: string | null | undefined;
  grupo?: string | null;
  traducir?: TraductorDeEnlaces;
}): MensajeCompartido {
  const traducir = opciones.traducir ?? enEspanol;
  const nombre = opciones.grupo?.trim();
  const texto = nombre ? traducir('share.groupNamed', { nombre }) : traducir('share.group');
  const url = enlaceDeGrupo(opciones.codigo);
  return { message: url ? `${texto}\n${url}` : texto, url };
}

/**
 * La ruta de la aplicacion a la que lleva un enlace de la propia web de Z, o
 * `null` si el enlace es de fuera.
 *
 * Para que un enlace de Z pegado en un chat se abra DENTRO de la aplicacion y
 * no saque a la persona al navegador a ver lo mismo. Solo se reconoce lo que
 * la aplicacion sabe abrir por ruta: un directo, una publicacion y el enlace
 * de un grupo.
 */
export function rutaInternaDe(url: string | null | undefined): string | null {
  const base = baseDeLaWeb();
  if (!base || typeof url !== 'string') return null;
  const limpio = url.trim();
  if (!limpio.startsWith(`${base}/`)) return null;
  const camino = limpio.slice(base.length).split(/[?#]/)[0] ?? '';
  const partes = /^\/(live|post|grupo)\/([A-Za-z0-9_-]+)\/?$/.exec(camino);
  if (!partes) return null;
  return `/${partes[1]}/${partes[2]}`;
}
