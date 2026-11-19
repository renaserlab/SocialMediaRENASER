/**
 * Volver a pedir las URLs de video que caducan (videos en S3, opcion B).
 *
 * POR QUE. Las URLs de CloudFront las firma la API y duran unas horas. Con
 * Supabase el telefono refirmaba solo; con S3 no puede: la unica forma de
 * tener una URL nueva es volver a pedir la publicacion (`GET /posts?ids=`).
 * Y hay publicaciones que viven mucho mas que su firma: la instantanea de
 * Inicio dura hasta tres dias (`cacheDeVideos.ts`), la del muro tambien se
 * guarda, y una app que vuelve del fondo tras una tarde sigue con la lista de
 * la manana. CloudFront rechaza hasta los pedidos de rango hechos tras el
 * vencimiento, asi que reproducir eso es un video negro.
 *
 * Todo es PURO a proposito (se prueba en `urlsDeMedios.test.mts`): quien pide
 * a la red se inyecta. Y nada aqui espera si no hay nada vencido: la primera
 * pintura del feed no paga ni una peticion por esto.
 */

/** Margen: lo que vence en menos de esto se trata como vencido. */
export const MARGEN_DE_VENCIMIENTO_MS = 10 * 60 * 1000;

/** Tope de ids por peticion que acepta `GET /posts?ids=`. */
export const MAXIMO_IDS_POR_PETICION = 50;

/**
 * Si unas URLs ya vencieron o les queda menos del margen.
 *
 * Sin fecha (fila de Supabase, servidor viejo) o con una fecha ilegible, NO:
 * pedir otra vez algo que nunca va a traer fecha seria un bucle de peticiones.
 */
export function urlsPorVencer(
  expiran: string | null | undefined,
  ahora: number = Date.now(),
): boolean {
  if (!expiran) return false;
  const vence = Date.parse(expiran);
  if (Number.isNaN(vence)) return false;
  return vence - ahora < MARGEN_DE_VENCIMIENTO_MS;
}

/**
 * Si una publicacion del modelo de vista necesita URLs nuevas.
 *
 * Solo las de S3. Ademas de la fecha, una fila `s3` SIN `mediaUrl` tambien:
 * es lo que deja la instantanea del muro, que guarda las publicaciones sin
 * URLs (son volatiles) y antes las recuperaba refirmando en Supabase.
 */
export function publicacionNecesitaUrls(
  post: { mediaAlmacen?: 'supabase' | 's3'; mediaUrl?: string; urlsExpiran?: string },
  ahora: number = Date.now(),
): boolean {
  if (post.mediaAlmacen !== 's3') return false;
  if (!post.mediaUrl) return true;
  return urlsPorVencer(post.urlsExpiran, ahora);
}

/**
 * Si un elemento del feed vertical necesita URLs nuevas. En `ReelItem` solo
 * las filas de S3 llevan `urlsExpiran`, asi que su sola presencia lo dice.
 */
export function reelNecesitaUrls(
  reel: { urlsExpiran?: string },
  ahora: number = Date.now(),
): boolean {
  return urlsPorVencer(reel.urlsExpiran, ahora);
}

/** Parte una lista en trozos de como mucho `tamano`. */
export function enLotes<T>(lista: T[], tamano: number): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < lista.length; i += tamano) lotes.push(lista.slice(i, i + tamano));
  return lotes;
}

export type RenovacionDeUrls<T> = {
  /** La lista con las URLs nuevas puestas. Es la MISMA si no se renovo nada. */
  items: T[];
  /** Ids que de verdad volvieron con URLs nuevas. */
  renovados: string[];
};

/**
 * Renueva las URLs de los elementos que lo necesiten.
 *
 * - Si ninguno lo necesita, devuelve la misma lista sin pedir nada.
 * - Pide solo los que hacen falta, en lotes de 50 (el tope de la API).
 * - Lo que no vuelve (borrado, ya no visible) se queda como estaba: el
 *   reproductor fallara y se vera el error de siempre, que es lo honesto.
 * - Un fallo de red no rompe nada: se devuelve lo que habia.
 *
 * `combinar` decide que se copia del elemento nuevo al viejo; por defecto, el
 * nuevo entero.
 */
export async function renovarUrls<T extends { id: string }>(
  items: T[],
  {
    necesita,
    pedir,
    combinar = (_viejo, nuevo) => nuevo,
    forzar = [],
  }: {
    necesita: (item: T) => boolean;
    pedir: (ids: string[]) => Promise<T[]>;
    combinar?: (viejo: T, nuevo: T) => T;
    /** Ids a renovar aunque su fecha aun valga (un error de reproduccion). */
    forzar?: string[];
  },
): Promise<RenovacionDeUrls<T>> {
  const forzados = new Set(forzar);
  const ids = [
    ...new Set(items.filter((item) => forzados.has(item.id) || necesita(item)).map((i) => i.id)),
  ];
  if (ids.length === 0) return { items, renovados: [] };

  const nuevos = new Map<string, T>();
  for (const lote of enLotes(ids, MAXIMO_IDS_POR_PETICION)) {
    try {
      for (const nuevo of await pedir(lote)) nuevos.set(nuevo.id, nuevo);
    } catch (error) {
      // Sin red no hay URLs nuevas, pero lo que se ve no se pierde.
      console.warn('[medios] no se pudieron renovar las URLs', error);
    }
  }
  if (nuevos.size === 0) return { items, renovados: [] };

  const renovados: string[] = [];
  const salida = items.map((item) => {
    const nuevo = nuevos.get(item.id);
    if (!nuevo) return item;
    renovados.push(item.id);
    return combinar(item, nuevo);
  });
  return { items: salida, renovados: [...new Set(renovados)] };
}

/**
 * «Ante un error de reproduccion, pedir la publicacion otra vez UNA sola vez».
 *
 * Lleva la cuenta por id: la primera vez dice que si y apunta; las siguientes,
 * que no. Asi un video roto de verdad (archivo borrado, publicacion retirada)
 * no se queda pidiendo URLs en bucle: al segundo fallo se ve el error de
 * siempre.
 */
export function crearReintentoUnico(): { puede: (id: string) => boolean } {
  const usados = new Set<string>();
  return {
    puede(id) {
      if (usados.has(id)) return false;
      usados.add(id);
      return true;
    },
  };
}
