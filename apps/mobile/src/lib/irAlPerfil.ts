import { precargarPerfil } from '@/services/cachePerfil';

/**
 * Solo se le pide empujar una ruta. Tipado asi para no arrastrar los tipos de
 * expo-router hasta aqui: cualquier `useRouter()` encaja.
 */
type Navegador = { push: (destino: never) => void };

/**
 * Abrir el perfil de alguien: PRIMERO se pide lo suyo, DESPUES se navega.
 *
 * El orden es el arreglo entero. Navegar es instantaneo —la pantalla ya
 * entraba al momento—; lo que tardaba era tener algo dentro. Lanzando las
 * peticiones en el mismo gesto del dedo, viajan durante la animacion de
 * entrada, unos 300 ms que antes se perdian esperando a que la pantalla se
 * montara para recien entonces empezar a pedir.
 *
 * Lo que NO se hace, y conviene decirlo porque es la tentacion evidente:
 * esperar a que llegue el perfil y navegar despues. Eso convierte un toque en
 * una pausa sin explicacion, con el dedo ya levantado y la pantalla quieta. La
 * regla es toque -> pantalla -> lo que se sepa -> refresco.
 *
 * Existe como funcion, y no como dos lineas repetidas en cada sitio, porque
 * hay una decena de puntos desde los que se abre un perfil (el muro, los
 * reels, la busqueda, los avisos, las listas de seguidores...). Repartida, el
 * siguiente sitio que se añada se olvidara de precargar y nadie lo notara
 * hasta que alguien se queje otra vez de que el perfil «tarda».
 */
export function irAlPerfil(
  router: Navegador,
  id: string | null | undefined,
  /** Seccion a abrir dentro del perfil (podcast, cursos...). Opcional. */
  section?: string,
): void {
  if (!id) return;
  precargarPerfil(id);
  router.push(
    (section
      ? { pathname: '/profile/[id]', params: { id, section } }
      : `/profile/${id}`) as never,
  );
}
