import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * GUARDAR Y REPUBLICAR TIENEN QUE NOTARSE.
 *
 * LO QUE SE REPORTO. Al guardar no pasaba nada visible: el icono cambiaba de
 * `textMuted` a `text` —dos grises que en un movil al sol no se distinguen— y
 * la unica forma de saber si habia funcionado era ir al perfil y mirar la
 * lista. Al republicar, ni eso: «solo nos damos cuenta que realmente funcionó
 * cuando el usuario recarga el vercel o cuando sale y vuelve a entrar».
 *
 * Y un tercer problema, del mismo sitio: nadie sabe que hace el icono de
 * republicar. Dos flechas en ciclo no significan nada para quien no las ha
 * visto antes en otra aplicacion.
 *
 * LO QUE NO SE HIZO. Ni un sistema de avisos nuevo —se extendio el que ya
 * habia—, ni reescribir el guardado o el repost, que ya eran optimistas y ya
 * deshacian el cambio al fallar. Lo que faltaba era decirlo.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

/**
 * El codigo sin comentarios.
 *
 * Aqui se habla de lo que NO se hizo —«nada de un segundo Snackbar»— y buscar
 * esas palabras sobre el fichero entero encuentra la advertencia y la confunde
 * con el problema. Es el mismo helper de `grabadoraNoTocaLoLiberado`.
 */
function sinComentarios(codigo: string): string {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const POST_CARD = fuente('components/PostCard.tsx');
const ACCION = fuente('components/AccionDePublicacion.tsx');
const TOAST_LIB = fuente('lib/toast.ts');
const TOAST = fuente('components/Toast.tsx');
const STORE = fuente('store/useAppStore.ts');

// ---------------------------------------------------------------------------
// 1. El aviso con accion, en el sistema que ya existia
// ---------------------------------------------------------------------------

test('la accion del toast es opcional: los avisos de siempre no cambian', () => {
  assert.match(TOAST_LIB, /accion\?: \{/, 'tiene que ser opcional');
  // `toast()` sigue existiendo con su firma: hay decenas de llamadas.
  assert.match(TOAST_LIB, /export function toast\(/);
  assert.match(TOAST_LIB, /export function toastConAccion\(/);
});

test('no se creo un segundo sistema de avisos', () => {
  // Un Snackbar en paralelo significaria dos cosas apilandose en la pantalla.
  const codigo = sinComentarios(TOAST_LIB + TOAST + POST_CARD);
  assert.ok(
    !/Snackbar|react-native-toast|flash-message/i.test(codigo),
    'se mantiene un unico sistema de avisos',
  );
});

test('el aviso con accion sigue yendose solo', () => {
  // Un aviso que espera a que lo atiendan es un dialogo, y esto no lo es.
  // Cuanto dura lo decide la cola segun el tipo (`colaDeAvisos`), y con una
  // accion dura mas —hay que llegar con el dedo—, pero SIEMPRE tiene reloj.
  assert.match(TOAST, /setTimeout\(despedir, duration\)/);
  assert.match(fuente('components/ToastHost.tsx'), /duration=\{duracionDelAviso\(/);
});

test('pulsar la accion hace lo suyo y cierra el aviso', () => {
  // Dejarlo puesto despues de navegar seria un cartel sobre la pantalla nueva.
  assert.match(TOAST, /accion\.alPulsar\(\);\s*\n\s*despedir\(\);/);
});

// ---------------------------------------------------------------------------
// 2. Guardar
// ---------------------------------------------------------------------------

test('el store dice como acabo, en vez de deshacer en silencio', () => {
  assert.match(
    STORE,
    /toggleSavePost: \(postId: string\) => Promise<\{ guardada: boolean; ok: boolean \}>/,
    'sin resultado no hay forma de distinguir guardado de rechazado',
  );
  // Y sigue deshaciendo el cambio cuando el servidor lo rechaza.
  assert.match(STORE, /return \{ guardada, ok: false \}/);
});

test('la peticion de guardar se hace UNA vez, en el store', () => {
  /*
    Si `PostCard` volviera a llamar al repositorio, guardar mandaria dos
    peticiones: la del store y la suya.
  */
  assert.ok(
    !/PostRepository\.(save|unsave)\(/.test(POST_CARD),
    'PostCard no puede repetir la llamada que ya hace el store',
  );
  assert.match(STORE, /PostRepository\.unsave\(postId\) : PostRepository\.save\(postId\)/);
});

test('guardar avisa y ofrece ver la lista; quitar solo avisa', () => {
  assert.match(POST_CARD, /toastConAccion\(\s*t\('post\.savedToast'\)/);
  assert.match(POST_CARD, /etiqueta: t\('post\.viewSavedList'\)/);
  assert.match(POST_CARD, /alPulsar: \(\) => router\.push\('\/saved' as never\)/);
  assert.match(POST_CARD, /toast\(t\('post\.unsavedToast'\)\)/);
});

test('al quitar no se ofrece «Ver lista»', () => {
  /*
    Lo que se acaba de hacer es sacarlo de ahi: mandar a esa pantalla seria
    llevar a ver una ausencia.
  */
  const rama = POST_CARD.slice(
    POST_CARD.indexOf("toast(t('post.unsavedToast')"),
    POST_CARD.indexOf("toast(t('post.unsavedToast')") + 160,
  );
  assert.ok(!/viewSavedList/.test(rama));
});

test('si el servidor rechaza, se dice; no se anuncia exito', () => {
  const guardar = POST_CARD.slice(
    POST_CARD.indexOf('const alternarGuardado'),
    POST_CARD.indexOf('const alternarRepost'),
  );
  assert.match(guardar, /if \(!ok\) \{/);
  assert.match(guardar, /notify\(t\('post\.saveFailed'\)/);
  // Y el aviso de exito queda DESPUES de esa salida.
  assert.ok(
    guardar.indexOf('notify(') < guardar.indexOf('toastConAccion('),
    'el error tiene que cortar antes de llegar al aviso de guardado',
  );
});

test('el icono guardado usa un color de estado del tema, no un amarillo fijo', () => {
  assert.match(POST_CARD, /icono="bookmark"[\s\S]{0,600}?colorActivo=\{colors\.primary\}/);
  assert.ok(
    !/#[Ff][Ff][A-Fa-f0-9]{4}|'yellow'|'gold'|'#FFD700'/.test(POST_CARD),
    'nada de amarillos escritos a mano: el tema tiene claro y oscuro',
  );
});

// ---------------------------------------------------------------------------
// 3. Republicar
// ---------------------------------------------------------------------------

test('republicar avisa solo cuando el servidor ya lo acepto', () => {
  const repost = POST_CARD.slice(
    POST_CARD.indexOf('const alternarRepost'),
    POST_CARD.indexOf('const alternarRepost') + 2200,
  );
  const iAwait = repost.indexOf('await PostRepository.repost');
  const iToast = repost.indexOf("t('post.repostedToast')");
  const iCatch = repost.indexOf('} catch {');
  assert.ok(iAwait !== -1 && iToast !== -1 && iCatch !== -1);
  assert.ok(iAwait < iToast, 'el aviso va despues de que el servidor conteste');
  assert.ok(iToast < iCatch, 'y dentro del try, no despues de tragarse el error');
});

test('al fallar se deshace y no queda ningun aviso de exito', () => {
  const repost = POST_CARD.slice(POST_CARD.indexOf('const alternarRepost'));
  const captura = repost.slice(repost.indexOf('} catch {'), repost.indexOf('} finally {'));
  assert.match(captura, /setRepublicado\(!siguiente\)/, 'rollback del estado');
  assert.match(captura, /notify\(t\('post\.repostFailed'\)/);
  assert.ok(!/toast\(/.test(captura), 'no se felicita por algo que fallo');
});

// ---------------------------------------------------------------------------
// 4. Los nombres bajo los botones
// ---------------------------------------------------------------------------

test('las cinco acciones llevan nombre', () => {
  for (const clave of [
    'post.actionLike',
    'post.actionComment',
    'post.actionRepost',
    'post.actionShare',
    'post.actionSave',
  ]) {
    assert.ok(
      POST_CARD.includes(`t('${clave}')`),
      `falta el nombre ${clave} en la fila de acciones`,
    );
  }
});

test('los nombres estan en los tres idiomas', () => {
  for (const idioma of ['es', 'en', 'pt']) {
    const diccionario = fuente(`i18n/${idioma}.ts`);
    for (const clave of [
      'post.actionLike',
      'post.actionComment',
      'post.actionRepost',
      'post.actionShare',
      'post.actionSave',
      'post.savedToast',
      'post.unsavedToast',
      'post.viewSavedList',
      'post.saveFailed',
      'post.repostedToast',
      'post.unrepostedToast',
    ]) {
      assert.ok(diccionario.includes(`'${clave}'`), `falta ${clave} en ${idioma}.ts`);
    }
  }
});

test('la fila aguanta un telefono estrecho', () => {
  /*
    Cinco columnas con nombre debajo. Sin reparto igual y sin recorte a una
    linea, «Republicar» empujaria a las demas o partiria en dos y estiraria la
    tarjeta.
  */
  assert.match(ACCION, /flex: 1/, 'cada accion ocupa la misma fraccion');
  assert.match(ACCION, /numberOfLines=\{1\}/, 'el nombre se recorta, no envuelve');
  assert.match(ACCION, /minHeight: 44/, 'area pulsable');
  // Y el hueco entre acciones bajo, porque ahora hay cinco columnas.
  assert.match(POST_CARD, /actions: \{[^}]*gap: spacing\.xs/);
});

test('el nombre no roba el toque al boton', () => {
  // En «me gusta» hay dos destinos —corazon y numero—: un area que abarcara
  // los dos no podria decidir cual.
  const etiqueta = ACCION.slice(ACCION.indexOf('El nombre NO es pulsable'));
  assert.ok(
    !/<Pressable/.test(etiqueta.slice(0, etiqueta.indexOf('</View>'))),
    'la etiqueta se queda como texto',
  );
});
