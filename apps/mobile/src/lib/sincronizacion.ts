/**
 * QUE UNA MUTACION SE VEA SIN SALIR Y VOLVER A ENTRAR.
 *
 * =========================================================================
 * EL PROBLEMA REAL
 * =========================================================================
 * Se reportó así: «si un usuario publica un contenido, o una historia, o un
 * curso, o realiza un comentario, la aplicación no responde y el usuario debe
 * estar saliendo y volviendo a entrar para que recién vea lo que publicó».
 *
 * No era un fallo de red ni de caché. Era que el estado de un mismo dominio
 * vive en superficies distintas que no se conocen entre sí:
 *
 *     publicaciones   useAppStore.posts        (Explorar)
 *                     useFeedDeVideos.items    (Inicio)      ← lista propia
 *                     useProfilePosts          (Perfil)      ← lista propia
 *
 * `createPost()` insertaba en `useAppStore.posts`. Las otras dos seguían con la
 * lista que habían pedido al montarse, y como una sección montada NO se
 * desmonta —es lo que hace que volver a una pestaña sea instantáneo— esa lista
 * podía quedarse vieja durante toda la sesión. Cerrar la aplicación era la
 * única forma de tirarla.
 *
 * =========================================================================
 * LO QUE NO SE HIZO, Y POR QUE
 * =========================================================================
 * NO se llama a `refrescar()` desde cada componente que muta algo: eso es el
 * mismo acoplamiento de siempre, escrito veinte veces, y se rompe el día que
 * alguien añade la superficie veintiuna.
 *
 * NO se mete React Query. Resuelve esto y mucho más, pero traer un segundo
 * sistema de estado al lado de Zustand cuesta más de lo que arregla aquí.
 *
 * NO hay sondeo. Nada se pregunta «¿habrá cambiado?» cada dos segundos.
 *
 * NO es un bus de eventos con cargas útiles. Aquí no viaja el objeto que
 * cambió: solo el HECHO de que el dominio cambió. Quien tenga una copia decide
 * si le importa y cuándo pedirla. Un bus con datos obliga a que cada oyente
 * sepa mezclar cada forma de payload, y ahí es donde aparecen los duplicados.
 *
 * =========================================================================
 * LOS TRES NIVELES
 * =========================================================================
 * A. LEER LO QUE ACABAS DE ESCRIBIR — lo resuelve la propia mutación, que
 *    inserta el objeto que devolvió el servidor en el estado que le toca. Es
 *    inmediato y no pasa por aquí. Preferir esto SIEMPRE a esperar un evento:
 *    ya tienes la fila, con su id de verdad.
 *
 * B. LAS DEMAS SUPERFICIES MONTADAS — lo resuelve este fichero. La mutación
 *    marca el dominio, y cada superficie que tenga una copia se entera de que
 *    la suya puede estar vieja. NO se refresca en el acto: se refresca cuando
 *    esa superficie se está viendo. Pedir el muro de Explorar mientras estás en
 *    Inicio gasta batería y datos para pintar algo que nadie mira.
 *
 * C. CAMBIOS DE OTRA PERSONA — eso es Realtime, y va aparte.
 *
 * =========================================================================
 * POR QUE UNA VERSION Y NO UN BOOLEANO
 * =========================================================================
 * Con un `dirty: boolean` hay una carrera: si llega una segunda mutación
 * mientras el refresco está en vuelo, el `dirty = false` del final borra el
 * aviso de la segunda y esa se pierde. Con un número que solo sube, la
 * superficie guarda cuál fue la última versión que llegó a servir; si al
 * terminar la versión ya no coincide, sabe que hay otra pendiente.
 */

/** Los dominios que tienen copia en más de una superficie. */
export type DominioSincronizado = 'publicaciones' | 'historias' | 'cursos' | 'comentarios';

const versiones: Record<DominioSincronizado, number> = {
  publicaciones: 0,
  historias: 0,
  cursos: 0,
  comentarios: 0,
};

const oyentes = new Set<() => void>();

/**
 * Marca que un dominio cambió.
 *
 * Se llama DESPUES de que el servidor haya confirmado, no al lanzar la
 * petición: avisar de un cambio que aún puede fallar haría que las demás
 * superficies pidieran datos para volver a ver lo mismo.
 *
 * Es barato: sube un número y avisa. No pide nada a nadie.
 */
export function invalidar(dominio: DominioSincronizado): void {
  versiones[dominio] += 1;
  oyentes.forEach((avisar) => avisar());
}

/** La versión actual. Fuera de React (repositorios, store). */
export function versionDe(dominio: DominioSincronizado): number {
  return versiones[dominio];
}

/**
 * Escuchar los avisos. Devuelve como dejar de escuchar.
 *
 * Se exporta para `useVersionDe`, que vive en el hook. AQUI NO HAY REACT a
 * proposito: este fichero es el nucleo y se puede ejecutar en las pruebas tal
 * cual, sin renderizador. Los hooks van aparte.
 */
export function suscribir(alCambiar: () => void): () => void {
  oyentes.add(alCambiar);
  return () => {
    oyentes.delete(alCambiar);
  };
}
