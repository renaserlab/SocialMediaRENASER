import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  invalidar,
  suscribir,
  versionDe,
  type DominioSincronizado,
} from './sincronizacion.ts';

/**
 * QUE LO QUE ACABAS DE PUBLICAR SE VEA SIN SALIR Y VOLVER A ENTRAR.
 *
 * EL FALLO. El estado de un mismo dominio vivía en superficies que no se
 * conocían entre sí:
 *
 *     publicaciones   useAppStore.posts        (Explorar)
 *                     useFeedDeVideos.items    (Inicio)   ← lista propia
 *                     useProfilePosts          (Perfil)   ← lista propia
 *
 * `createPost()` insertaba en `useAppStore.posts`. Las otras dos seguían con lo
 * que habían pedido al montarse, y como una sección montada NO se desmonta, esa
 * lista podía quedarse vieja toda la sesión. Cerrar la aplicación era la única
 * forma de tirarla — literalmente lo que se reportó.
 *
 * Aquí se comprueban DOS cosas distintas: el comportamiento del mecanismo
 * (ejecutándolo de verdad, que para eso el núcleo no depende de React) y que
 * esté conectado donde hace falta (leyendo el código, como el resto de pruebas
 * de este proyecto).
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. El mecanismo, ejecutado de verdad
// ---------------------------------------------------------------------------

test('invalidar sube la version del dominio', () => {
  const antes = versionDe('publicaciones');
  invalidar('publicaciones');
  assert.equal(versionDe('publicaciones'), antes + 1);
});

test('cada dominio va por su cuenta', () => {
  /*
    Si compartieran contador, publicar una historia mandaria a refrescar los
    cursos: peticiones para volver a ver lo mismo.
  */
  const cursos = versionDe('cursos');
  invalidar('publicaciones');
  invalidar('comentarios');
  assert.equal(versionDe('cursos'), cursos, 'cursos no cambia por publicar');
});

test('la version solo sube: nunca vuelve atras', () => {
  /*
    Con un `dirty: boolean` hay una carrera: si llega un segundo cambio mientras
    el refresco esta en vuelo, el `dirty = false` del final se traga el aviso del
    segundo. Un numero que solo crece no puede perder avisos.
  */
  const dominios: DominioSincronizado[] = ['publicaciones', 'historias', 'cursos', 'comentarios'];
  for (const dominio of dominios) {
    const previa = versionDe(dominio);
    invalidar(dominio);
    invalidar(dominio);
    assert.equal(versionDe(dominio), previa + 2);
  }
});

test('quien deja de escuchar deja de recibir avisos', () => {
  // Una superficie desmontada que siguiera despertandose es una fuga.
  let avisos = 0;
  const dejar = suscribir(() => {
    avisos += 1;
  });
  invalidar('publicaciones');
  assert.equal(avisos, 1);
  dejar();
  invalidar('publicaciones');
  assert.equal(avisos, 1, 'tras darse de baja no puede seguir recibiendo');
});

test('invalidar no pide datos a nadie: solo avisa', () => {
  // Es lo que permite llamarlo desde un repositorio sin acoplarlo a la interfaz.
  const codigo = fuente('lib/sincronizacion.ts');
  const cuerpo = codigo.slice(
    codigo.indexOf('export function invalidar'),
    codigo.indexOf('export function versionDe'),
  );
  assert.ok(
    !/fetch|apiRequest|Repository/.test(cuerpo),
    'invalidar no puede disparar peticiones: solo sube un numero y avisa',
  );
});

// ---------------------------------------------------------------------------
// 2. Nada de sondeo ni de recargas globales
// ---------------------------------------------------------------------------

test('no hay temporizadores ni sondeo en el mecanismo', () => {
  const nucleo = fuente('lib/sincronizacion.ts').replace(/\/\*[\s\S]*?\*\//g, '');
  const hook = fuente('hooks/useRefrescoAlEnfocar.ts').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(
    !/setInterval|setTimeout/.test(nucleo + hook),
    'la consistencia no se resuelve con un reloj',
  );
});

test('nadie recarga la aplicacion entera para sincronizar', () => {
  for (const rel of [
    'lib/sincronizacion.ts',
    'hooks/useRefrescoAlEnfocar.ts',
    'hooks/useFeedDeVideos.ts',
    'hooks/useProfilePosts.ts',
    'store/useAppStore.ts',
  ]) {
    const codigo = fuente(rel)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.ok(
      !/window\.location\.reload|Updates\.reloadAsync/.test(codigo),
      `${rel} recarga la aplicacion para refrescar datos`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Nivel A: leer lo que acabas de escribir
// ---------------------------------------------------------------------------

/*
  `loadStories:` a secas casa ANTES con la declaracion de tipo, que esta muy por
  encima de la implementacion: el corte salia vacio y la prueba pasaba sin mirar
  nada. Se ancla en `loadStories: async`, que es el cuerpo.
*/
function bloqueDeCrearPublicacion(): string {
  const store = fuente('store/useAppStore.ts');
  const bloque = store.slice(
    store.indexOf('createPost: async'),
    store.indexOf('loadStories: async'),
  );
  assert.ok(bloque.length > 0, 'no se pudo aislar createPost');
  return bloque;
}

test('publicar inserta la fila del servidor, no espera a un evento', () => {
  const crear = bloqueDeCrearPublicacion();
  // Se usa el objeto que devolvio el POST: trae el id de verdad, que es lo que
  // permitiria reconocerlo si el mismo cambio volviera por otra via.
  assert.match(crear, /const post = await PostRepository\.createPost/);
  assert.match(crear, /posts: \[post, \.\.\.state\.posts\]/);
});

test('el comentario que se pinta es el que devolvio el servidor', () => {
  const store = fuente('store/useAppStore.ts');
  const anadir = store.slice(store.indexOf('addComment: async'));
  const conBackend = anadir.slice(0, anadir.indexOf('const author = get().user'));
  assert.ok(conBackend.length > 0, 'no se pudo aislar addComment');
  assert.match(conBackend, /const comment = await PostRepository\.addComment/);
  assert.match(conBackend, /comments: \[\.\.\.post\.comments, comment\]/);
});

// ---------------------------------------------------------------------------
// 4. Nivel B: las superficies con lista propia se enteran
// ---------------------------------------------------------------------------

test('las mutaciones avisan DESPUES de que el servidor confirme', () => {
  const crear = bloqueDeCrearPublicacion();
  const iAwait = crear.indexOf('await PostRepository.createPost');
  const iAviso = crear.indexOf("invalidar('publicaciones')");
  assert.ok(iAwait !== -1 && iAviso !== -1, 'falta el aviso al publicar');
  assert.ok(
    iAwait < iAviso,
    'avisar antes de que conteste el servidor manda a pedir datos por algo que ' +
      'todavia puede fallar',
  );
});

test('las cuatro mutaciones del reporte avisan', () => {
  const store = fuente('store/useAppStore.ts');
  const cursos = fuente('repositories/LearningRepository.ts');
  assert.match(store, /invalidar\('publicaciones'\)/, 'publicar');
  assert.match(store, /invalidar\('historias'\)/, 'historia');
  assert.match(store, /invalidar\('comentarios'\)/, 'comentario');
  assert.match(cursos, /invalidar\('cursos'\)/, 'curso');
});

test('Inicio y Perfil, que llevan lista propia, escuchan', () => {
  /*
    Son las dos superficies que `createPost` NO tocaba. Explorar no esta aqui a
    proposito: lee `useAppStore.posts`, que la propia mutacion ya actualiza, y
    mandarle un refresco seria pedir al servidor algo que ya se tiene.
  */
  assert.match(
    fuente('hooks/useFeedDeVideos.ts'),
    /useRefrescoAlEnfocar\('publicaciones', refrescar\)/,
  );
  assert.match(
    fuente('hooks/useProfilePosts.ts'),
    /useRefrescoAlEnfocar\('publicaciones', recargar\)/,
  );
});

test('solo se refresca lo que se esta viendo, y solo si cambio', () => {
  const hook = fuente('hooks/useRefrescoAlEnfocar.ts');
  // Sin esta guarda se pediria el muro de Explorar estando en Mensajes.
  assert.match(hook, /if \(!enfocada\) return;/);
  // Y sin esta, cambiar de pestaña volveria a pedirlo todo aunque nada cambiara.
  assert.match(hook, /if \(servida\.current === version\) return;/);
  // Una sola peticion a la vez.
  assert.match(hook, /if \(enVuelo\.current\) return;/);
});

test('un refresco fallido no se da por servido', () => {
  /*
    Si se apuntara la version al fallar, los datos quedarian viejos para siempre
    y nadie volveria a pedirlos.
  */
  const codigo = fuente('hooks/useRefrescoAlEnfocar.ts');
  const ejecutar = codigo.slice(
    codigo.indexOf('const ejecutar = useCallback'),
    codigo.lastIndexOf('useEffect(('),
  );
  const iApunta = ejecutar.indexOf('servida.current = objetivo');
  const iCatch = ejecutar.indexOf('} catch {');
  assert.ok(iApunta !== -1 && iCatch !== -1, 'no se pudo aislar `ejecutar`');
  assert.ok(iApunta < iCatch, 'apuntar la version tiene que quedar dentro del try');
});

// ---------------------------------------------------------------------------
// 5. Lo que NO se toco
// ---------------------------------------------------------------------------

test('no se introdujo otra libreria de estado', () => {
  const paquete = readFileSync(join(SRC, '..', 'package.json'), 'utf8');
  assert.ok(
    !/@tanstack\/react-query|"swr"|"redux"/.test(paquete),
    'Zustand y los hooks bastaban para esto',
  );
});

test('la mensajeria en vivo no se toco', () => {
  // Realtime de mensajes ya funcionaba: esta ronda no entra ahi.
  const realtime = fuente('services/realtime.ts');
  assert.match(realtime, /table: 'messages'/);
  assert.match(realtime, /removeChannel/, 'sigue quitando el canal al salir');
});
