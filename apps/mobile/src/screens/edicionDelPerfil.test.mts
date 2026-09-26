import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * EDITAR EL PERFIL ES UNA BANDEJA, Y EL AUDIO PROPIO VIVE EN ELLA.
 *
 * Lo pedido el 25/09/2026: en el perfil propio, nada de boton «Editar perfil»
 * debajo de las cifras; un lapiz junto a la foto que abre una bandeja con foto,
 * nombre completo, nombre de usuario, biografia y el audio de presentacion. En
 * los perfiles ajenos el audio sigue a la vista.
 *
 * Lo delicado no es pintar la bandeja sino lo que NO puede pasar dentro de
 * ella: es un `Modal`, y en iOS no se presenta nada encima —`confirm()` no
 * resuelve y la pantalla se queda esperando; los `toast` quedan debajo—.
 *
 * Se mira el CODIGO FUENTE, como el resto de pruebas de esta carpeta.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

function sinComentarios(texto: string): string {
  return texto
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const PERFIL = sinComentarios(fuente('screens/ProfileScreen.tsx'));
const BANDEJA = sinComentarios(fuente('components/EditarPerfilSheet.tsx'));
const AUDIO = sinComentarios(fuente('components/AudioDePresentacion.tsx'));
const PANTALLA = sinComentarios(fuente('screens/EditProfileScreen.tsx'));

/** Lo que se pinta del perfil, sin el esqueleto de carga. */
const VISTA = PERFIL.slice(0, PERFIL.indexOf('function EsqueletoDePerfil'));

test('la ficha propia ya no tiene boton «Editar perfil» ni lleva a otra pantalla', () => {
  assert.doesNotMatch(
    VISTA,
    /<Button\s+label=\{t\('profile\.editProfile'\)\}/,
    'volvio el boton «Editar perfil» debajo de las cifras',
  );
  assert.doesNotMatch(
    VISTA,
    /router\.push\('\/edit-profile'/,
    'el perfil vuelve a mandar a la pantalla aparte en vez de abrir la bandeja',
  );
});

test('un lapiz junto a la foto abre la bandeja', () => {
  assert.match(VISTA, /<Feather name="edit-2"/);
  const lapiz = VISTA.slice(0, VISTA.indexOf('<Feather name="edit-2"'));
  assert.match(
    lapiz.slice(lapiz.lastIndexOf('<Pressable')),
    /onPress=\{abrirEdicion\}/,
    'el lapiz no abre la bandeja',
  );
  // Y la camara que habia en su sitio se fue: la foto se cambia en la bandeja
  // (o tocando la foto, que sigue abriendo el selector).
  assert.doesNotMatch(VISTA, /<Feather name="camera"/);
  assert.match(VISTA, /onPress=\{isPublic \? undefined : \(\) => openPhotoSheet\('avatar'\)\}/);
});

test('el menu de opciones abre la misma bandeja, esperando a que se cierre', () => {
  const fila = VISTA.slice(VISTA.lastIndexOf("title={t('profile.editProfile')}"));
  const accion = fila.slice(0, fila.indexOf('/>'));
  assert.match(accion, /setOptionsVisible\(false\);\s*await afterSheetClose\(\);\s*abrirEdicion\(\);/);
});

test('el audio de presentacion solo se ve en perfiles ajenos', () => {
  const usos = [...VISTA.matchAll(/<AudioDePresentacion[\s\S]*?\/>/g)].map((m) => m[0]);
  assert.equal(usos.length, 1, 'el perfil pinta el audio desde mas de un sitio');
  assert.match(usos[0], /esPropio=\{false\}/);
  const antes = VISTA.slice(0, VISTA.indexOf('<AudioDePresentacion'));
  assert.match(
    antes.slice(-40),
    /\{isPublic \? \(\s*$/,
    'el audio se pinta tambien en el perfil propio',
  );
});

test('la bandeja lleva foto, nombre, usuario, biografia y audio', () => {
  assert.match(BANDEJA, /<BottomSheet visible=\{visible\} onClose=\{onClose\}>/);
  for (const pieza of [
    "alElegirFoto('gallery')",
    "alElegirFoto('camera')",
    'onPress={alQuitarFoto}',
    '<CamposDePerfil formulario={formulario} />',
    'onPress={alGuardar}',
  ]) {
    assert.ok(BANDEJA.includes(pieza), `a la bandeja le falta ${pieza}`);
  }
  assert.match(BANDEJA, /<AudioDePresentacion[\s\S]*?esPropio[\s\S]*?enHoja[\s\S]*?\/>/);
  // Los tres campos, en un solo sitio para la bandeja y para /edit-profile.
  const campos = sinComentarios(fuente('components/CamposDePerfil.tsx'));
  for (const campo of ['formulario.fullName', 'formulario.username', 'formulario.bio']) {
    assert.ok(campos.includes(campo), `falta el campo ${campo}`);
  }
  assert.ok(PANTALLA.includes('<CamposDePerfil formulario={formulario} />'));
  assert.ok(PANTALLA.includes('useFormularioDePerfil()'));
});

test('dentro de la bandeja no se abre ningun dialogo', () => {
  assert.doesNotMatch(BANDEJA, /\b(confirm|notify|toast)\(/);
  // Los fallos de foto y de guardar se cuentan dentro, no con un aviso.
  const guardar = PERFIL.slice(PERFIL.indexOf('const guardarPerfilEditado'));
  const cuerpo = guardar.slice(0, guardar.indexOf('\n  };'));
  assert.doesNotMatch(cuerpo, /notify\(/);
  assert.match(cuerpo, /setAvisoAlGuardar\(/);
  for (const nombre of ['const elegirFotoDesdeLaBandeja', 'const quitarFotoDesdeLaBandeja']) {
    const desde = PERFIL.slice(PERFIL.indexOf(nombre));
    const funcion = desde.slice(0, desde.indexOf('\n  };'));
    assert.doesNotMatch(funcion, /notify\(/, `${nombre} avisa con un dialogo encima de la hoja`);
    assert.match(funcion, /setAvisoDeFoto\(/);
  }
});

test('en una hoja, el audio confirma y avisa en su tarjeta', () => {
  const borrar = AUDIO.slice(AUDIO.indexOf('const borrar = useCallback'));
  const cuerpo = borrar.slice(0, borrar.indexOf('}, ['));
  assert.ok(
    cuerpo.indexOf('if (enHoja)') >= 0 && cuerpo.indexOf('if (enHoja)') < cuerpo.indexOf('confirm('),
    'en una hoja se llega a `confirm()`, que en iOS no sale encima del Modal',
  );
  assert.match(AUDIO, /if \(enHoja\) setHecho\(texto\);\s*else toast\(texto\);/);
  // Los dos avisos de exito pasan por ahi.
  assert.doesNotMatch(AUDIO, /toast\(t\('intro\.(saved|removed)'\)\)/);
});

test('elegir foto en la bandeja vuelve a la bandeja, no al selector', () => {
  const guarda = PERFIL.slice(PERFIL.indexOf('if (porConfirmar) {'));
  const bloque = guarda.slice(0, guarda.indexOf('\n  }'));
  assert.match(
    bloque,
    /if \(porConfirmar\.desdeLaBandeja\) setEditandoPerfil\(true\);\s*else setEditingPhoto\(porConfirmar\.kind\);/,
  );
  const confirmar = PERFIL.slice(PERFIL.indexOf('const confirmarFoto'));
  assert.match(
    confirmar.slice(0, confirmar.indexOf('} catch')),
    /if \(porConfirmar\.desdeLaBandeja\) setEditandoPerfil\(true\);/,
  );
  // Y la bandeja se cierra y se espera a que termine ANTES de la confirmacion.
  const elegir = PERFIL.slice(PERFIL.indexOf('const elegirFotoDesdeLaBandeja'));
  assert.match(
    elegir,
    /setEditandoPerfil\(false\);\s*await afterSheetClose\(\);\s*setPorConfirmar\(\{ kind: 'avatar', media: picked, desdeLaBandeja: true \}\);/,
  );
});
