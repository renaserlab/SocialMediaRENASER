import { Image as ExpoImage } from 'expo-image';

import { miniaturaDePublicacion } from '@/lib/miniaturaDePublicacion';
import type { FeaturedMember } from '@/mappers/profileMapper';
import { PostRepository } from '@/repositories/PostRepository';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import type { Post, UserProfile } from '@/types';

/**
 * Lo que ya se sabe de un perfil, para que abrirlo no empiece en negro.
 *
 * EL PROBLEMA QUE RESUELVE. Tocar un perfil no tardaba en NAVEGAR: tardaba en
 * TENER ALGO QUE ENSENAR. La pantalla se montaba al instante y acto seguido se
 * tapaba entera con un indicador de carga hasta que respondia `/profiles/{id}`;
 * debajo, la cuadricula esperaba a su propia peticion y esa, a su vez, a las
 * firmas de Storage. Tres viajes encadenados contra una base de datos que
 * responde en tres cuartos de segundo cuando esta caliente. Entre el toque y la
 * primera foto no habia nada: ni nombre, ni foto, ni huecos. Solo oscuro.
 *
 * QUE HACE ESTE MODULO, en dos ideas:
 *
 *  1. GUARDA lo ya pedido. Volver a un perfil visitado pinta al momento con lo
 *     que hay y refresca por detras. Nunca se enseña un hueco por algo que ya
 *     se descargo una vez.
 *
 *  2. EMPIEZA ANTES. `precargarPerfil` se llama AL TOCAR, no al montar la
 *     pantalla: la peticion viaja durante la animacion de entrada, que son unos
 *     300 ms regalados. Y como las peticiones EN VUELO se comparten, la
 *     pantalla no lanza una segunda: se engancha a la que ya va.
 *
 * LO QUE NO HACE. No descarga videos. Ni el original ni el derivado ligero.
 * Precargar un video que quiza nadie abra gasta los datos de quien mira para
 * adivinar. Se calientan el perfil, sus publicaciones y los PRIMEROS posters,
 * que es exactamente lo que se ve sin desplazar.
 *
 * Vive en memoria a proposito: al cerrar la aplicacion se va con ella. Lo que
 * de verdad ahorra red entre arranques es la cache de firmas (`storage.ts`) y
 * la de disco de `expo-image`, que si persisten.
 */

type Entrada<T> = { valor: T; momento: number };

/**
 * Cuanto vale lo guardado antes de volver a pedirlo.
 *
 * Dos minutos. Es un perfil: el nombre y la foto no cambian, y los contadores
 * pueden ir un poco por detras mientras se refresca. Mas corto convertiria cada
 * paso atras en otra peticion; mas largo enseñaría cifras viejas demasiado
 * tiempo.
 */
const VIGENCIA_MS = 2 * 60 * 1000;

/**
 * Cuantas publicaciones se piden. UNA sola cifra para todos los que llaman: si
 * la precarga pidiera 12 y la pantalla 60, serian dos peticiones distintas en
 * vez de una compartida, que es justo lo que se venia a evitar.
 */
export const LIMITE_GALERIA = 60;

/**
 * Cuantos posters se calientan al tocar. Nueve son las tres primeras filas de
 * la cuadricula: lo que se ve sin desplazar. Traer los sesenta convertiria un
 * toque en varios megas de descarga para mirar tres filas.
 */
const POSTERS_A_PRECARGAR = 9;

const perfiles = new Map<string, Entrada<UserProfile>>();
const galerias = new Map<string, Entrada<Post[]>>();

/** Peticiones vivas, para que dos sitios que piden lo mismo hagan UN viaje. */
const perfilEnVuelo = new Map<string, Promise<UserProfile>>();
const galeriaEnVuelo = new Map<string, Promise<Post[]>>();

function vigente(entrada: Entrada<unknown> | undefined): boolean {
  return !!entrada && Date.now() - entrada.momento < VIGENCIA_MS;
}

/**
 * El perfil que ya se conoce, SIN pedir nada. Puede estar algo viejo: se
 * devuelve igual para pintar de inmediato, y quien llama refresca por detras.
 */
export function perfilEnCache(id: string | null | undefined): UserProfile | null {
  if (!id) return null;
  return perfiles.get(id)?.valor ?? null;
}

/** Las publicaciones ya conocidas de un perfil, sin pedir nada. */
export function galeriaEnCache(id: string | null | undefined): Post[] | null {
  if (!id) return null;
  return galerias.get(id)?.valor ?? null;
}

/** Guarda un perfil recien traido (tambien tras seguir, bloquear o editar). */
export function guardarPerfil(perfil: UserProfile): void {
  perfiles.set(perfil.id, { valor: perfil, momento: Date.now() });
}

export async function pedirPerfil(
  id: string,
  { refrescar = false }: { refrescar?: boolean } = {},
): Promise<UserProfile> {
  const guardado = perfiles.get(id);
  if (!refrescar && vigente(guardado) && guardado) return guardado.valor;

  const enVuelo = perfilEnVuelo.get(id);
  if (enVuelo) return enVuelo;

  const peticion = ProfileRepository.getById(id)
    .then((perfil) => {
      guardarPerfil(perfil);
      return perfil;
    })
    .finally(() => {
      perfilEnVuelo.delete(id);
    });
  perfilEnVuelo.set(id, peticion);
  return peticion;
}

export async function pedirGaleria(
  id: string,
  { refrescar = false }: { refrescar?: boolean } = {},
): Promise<Post[]> {
  const guardada = galerias.get(id);
  if (!refrescar && vigente(guardada) && guardada) return guardada.valor;

  const enVuelo = galeriaEnVuelo.get(id);
  if (enVuelo) return enVuelo;

  /*
    El tercer argumento es a quien pertenece el perfil, igual que antes de que
    esta cache existiera. Importa que sea SIEMPRE el mismo: si un sitio pidiera
    la galeria "como visitante" y otro "como dueño", el resultado guardado
    dependeria de quien llego primero. Nadie lee esa marca en la cuadricula
    —solo se pintan miniaturas—, pero una cache que devuelve cosas distintas
    segun el orden es una trampa esperando.
  */
  const peticion = PostRepository.listByAuthor(id, { limit: LIMITE_GALERIA }, id)
    .then((posts) => {
      galerias.set(id, { valor: posts, momento: Date.now() });
      return posts;
    })
    .finally(() => {
      galeriaEnVuelo.delete(id);
    });
  galeriaEnVuelo.set(id, peticion);
  return peticion;
}

// ---------------------------------------------------------------------------
// Perfiles destacados (/profiles/featured)
// ---------------------------------------------------------------------------

/*
  La MISMA lista la piden cinco pantallas: Explorar, Avisos, Miembros, el audio
  privado y las secciones del perfil. Cada una la pedia por su cuenta, asi que
  recorrer la aplicacion disparaba la misma consulta una y otra vez contra una
  base que tarda casi un segundo en responder. Es contenido de portada: cambia
  cada varios dias, no cada minuto.
*/
let destacados: Entrada<FeaturedMember[]> | undefined;
let destacadosEnVuelo: Promise<FeaturedMember[]> | null = null;

/** Diez minutos: es la vitrina de la casa, no un contador en movimiento. */
const VIGENCIA_DESTACADOS_MS = 10 * 60 * 1000;

export function destacadosEnCache(): FeaturedMember[] | null {
  return destacados?.valor ?? null;
}

/**
 * Quien administra RENASER, si ya se sabe. Sin peticion y sin espera: sirve
 * para poder NAVEGAR en el mismo toque en vez de averiguarlo primero.
 */
export function adminEnCache(): string | null {
  const lista = destacados?.valor;
  if (!lista?.length) return null;
  return (lista.find((m) => m.isAdmin) ?? lista[0])?.id ?? null;
}

export async function pedirDestacados(): Promise<FeaturedMember[]> {
  if (destacados && Date.now() - destacados.momento < VIGENCIA_DESTACADOS_MS) {
    return destacados.valor;
  }
  if (destacadosEnVuelo) return destacadosEnVuelo;

  destacadosEnVuelo = ProfileRepository.listFeatured()
    .then((lista) => {
      destacados = { valor: lista, momento: Date.now() };
      return lista;
    })
    .finally(() => {
      destacadosEnVuelo = null;
    });
  return destacadosEnVuelo;
}

/**
 * Calienta las imagenes de las primeras celdas.
 *
 * `Image.prefetch` NO sirve aqui: solo acepta URLs, asi que guarda lo
 * descargado bajo la firma, que caduca y cambia. La celda pide la misma imagen
 * bajo la RUTA de Storage, no la encontraria, y se descargaria dos veces: peor
 * que no precargar. `loadAsync` si acepta la fuente entera —incluida la clave—
 * y deja la imagen guardada donde la celda la va a buscar.
 */
function precargarMiniaturas(posts: Post[]): void {
  let calentadas = 0;
  for (const post of posts) {
    if (calentadas >= POSTERS_A_PRECARGAR) break;
    const mini = miniaturaDePublicacion(post);
    if (!mini) continue;
    calentadas += 1;
    // Sin `await` y sin guardar la referencia: es una comodidad, no un paso del
    // que dependa nada. Si falla (sin red, firma caducada) la celda la pedira
    // por su cuenta al pintarse.
    void ExpoImage.loadAsync({ uri: mini.uri, cacheKey: mini.cacheKey }).catch(() => {});
  }
}

/**
 * Al TOCAR un perfil: perfil, publicaciones y primeras miniaturas en camino.
 *
 * No devuelve nada y no puede fallar hacia fuera: quien lo llama tiene que
 * navegar en el mismo gesto, sin esperar a nada. Esa es la regla —toque,
 * pantalla, y el contenido llegando— y no al reves.
 */
export function precargarPerfil(id: string | null | undefined): void {
  if (!id) return;
  // El perfil demo no existe en el backend: pedirlo seria un 404 seguro.
  if (id === 'darren') return;

  void pedirPerfil(id)
    .then((perfil) => {
      // La foto grande del perfil es la MISMA URL que la miniatura de la lista
      // de la que se viene, asi que casi siempre ya esta en disco. Cuando no
      // (se llega desde un aviso, por ejemplo), esto la adelanta. El bucket de
      // avatares es publico: la URL no caduca y vale de clave por si misma.
      if (perfil.avatarUrl) void ExpoImage.prefetch(perfil.avatarUrl, 'memory-disk');
    })
    .catch(() => {});

  void pedirGaleria(id).then(precargarMiniaturas).catch(() => {});
}

/** Se vacia al cerrar sesion: lo visto es de quien lo vio. */
export function olvidarPerfiles(): void {
  perfiles.clear();
  galerias.clear();
  perfilEnVuelo.clear();
  galeriaEnVuelo.clear();
  // Los destacados dependen de quien mira: la lista EXCLUYE a quien la pide.
  destacados = undefined;
  destacadosEnVuelo = null;
}
