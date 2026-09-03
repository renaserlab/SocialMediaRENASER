import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * COMENTAR SIN CUENTA: NO, Y CON UNA EXPLICACION.
 *
 * Del informe de preproduccion: «cuando la persona no esta registrada o
 * logueada, no debe poder comentar. Debe aparecer una ventana indicando que
 * debe loguearse o registrarse, tal cual aparece cuando se pone en reaccionar o
 * repostear».
 *
 * LEER SIGUE SIENDO LIBRE, y eso es una decision del producto: la aplicacion se
 * recorre entera sin registrarse —el muro, los perfiles, los cursos— y la
 * cuenta se pide en el momento en que la accion la necesita de verdad. Lo que
 * estaba mal era dejar ESCRIBIR: el campo aceptaba el texto, el boton se
 * encendia, y al enviar el servidor contestaba 401. Se perdia lo escrito y
 * encima no se decia lo unico util, que hace falta una cuenta.
 *
 * Las tres escrituras van por la misma puerta: comentar, responder y reaccionar
 * a un comentario.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

const COMENTARIOS = fuente('components/ContenidoDeComentarios.tsx');
const PUERTA = fuente('hooks/useRequireAuth.ts');

// ---------------------------------------------------------------------------
// 1. Las tres escrituras piden cuenta
// ---------------------------------------------------------------------------

test('enviar un comentario pasa por la puerta', () => {
  assert.match(COMENTARIOS, /requireAuth\('auth\.reasonComment', enviar\)/);
});

test('responder tambien: una respuesta es un comentario', () => {
  assert.match(
    COMENTARIOS,
    /requireAuth\('auth\.reasonComment', \(\) =>\s*setRespondiendo\(/,
  );
});

test('reaccionar a un comentario tambien', () => {
  assert.match(
    COMENTARIOS,
    /requireAuth\('auth\.reasonReact', \(\) => reaccionar\(item\.id\)\)/,
  );
});

test('no queda ninguna escritura suelta', () => {
  for (const suelta of [
    'onPress={() => void enviar()}',
    'onPress={() => void reaccionar(item.id)}',
    'onPress={() => setRespondiendo({ id: item.id, author: item.author })}',
  ]) {
    assert.ok(
      !COMENTARIOS.includes(suelta),
      `«${suelta}» vuelve a escribir sin comprobar que hay cuenta.`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. El aviso llega ANTES de escribir, no despues
// ---------------------------------------------------------------------------

test('sin cuenta el teclado no llega a abrirse', () => {
  assert.match(COMENTARIOS, /editable=\{!haceFaltaCuenta\}/);
});

test('el primer toque explica; no se queda mudo', () => {
  /*
    Un campo desactivado a secas no hace NADA al tocarlo y parece que la
    aplicacion se ha colgado. La capa por encima convierte ese toque en el
    aviso, que es lo que el informe pide.
  */
  const barra = COMENTARIOS.slice(COMENTARIOS.indexOf('styles.barra,'));
  assert.match(barra, /haceFaltaCuenta \? \(\s*<Pressable/);
  assert.match(barra, /style=\{StyleSheet\.absoluteFill\}/);
  assert.match(barra, /onPress=\{pedirCuenta\}/);
  assert.match(barra, /accessibilityRole="button"/);
});

// ---------------------------------------------------------------------------
// 3. La regla vive en un solo sitio
// ---------------------------------------------------------------------------

test('«hace falta cuenta» sale del mismo hook que la exige', () => {
  /*
    La regla tiene una excepcion —en modo demo, sin backend, no hay sesion que
    exigir— y escribirla dos veces es como una pantalla acaba bloqueando lo que
    la otra permite.
  */
  assert.match(PUERTA, /export function useHaceFaltaCuenta\(\): boolean/);
  assert.match(PUERTA, /supabaseEnabled && status !== 'authenticated'/);
  assert.ok(
    !COMENTARIOS.includes('useAuthStore'),
    'ContenidoDeComentarios vuelve a leer el estado de sesion por su cuenta.',
  );
});

test('el motivo esta traducido en los tres idiomas', () => {
  for (const idioma of ['es', 'en', 'pt']) {
    assert.ok(
      fuente(`i18n/${idioma}.ts`).includes("'auth.reasonComment'"),
      `Falta auth.reasonComment en ${idioma}.ts`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Lo que NO cambia
// ---------------------------------------------------------------------------

test('leer los comentarios sigue sin pedir nada', () => {
  /*
    Abrir la hoja es una lectura. Cerrarla detras de un registro convertiria la
    aplicacion en lo que precisamente se dejo de hacer: un formulario antes de
    poder ver de que va.
  */
  const tarjeta = fuente('components/PostCard.tsx');
  assert.match(tarjeta, /onPress=\{\(\) => setComentariosAbiertos\(true\)\}/);
});
