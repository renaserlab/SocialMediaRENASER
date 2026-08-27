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
): string {
  const nombre = autor?.trim();
  const de = nombre ? ` de ${nombre}` : '';
  if (clase === 'audio') return `Escucha este audio${de} en Z`;
  if (clase === 'video') return `Mira este vídeo${de} en Z`;
  return `Mira esta publicación${de} en Z`;
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
}): MensajeCompartido {
  const clase = opciones.clase ?? 'publicacion';
  const texto = textoParaCompartir(clase, opciones.autor);
  const url = enlaceDePublicacion(opciones.postId);
  return { message: url ? `${texto}\n${url}` : texto, url };
}
