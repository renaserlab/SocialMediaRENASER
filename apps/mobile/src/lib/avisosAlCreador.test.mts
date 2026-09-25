import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { avisoAlCreador, detalleDelAviso, rutaDelAviso } from './avisosAlCreador.ts';

const SRC = join(import.meta.dirname, '..');

/** Los tipos que escribe el servidor (`notifications/decisiones.py`). */
function tiposDelServidor(): string[] {
  const fuente = readFileSync(
    join(SRC, '..', '..', 'api', 'app', 'modules', 'notifications', 'decisiones.py'),
    'utf8',
  );
  const bloque = fuente.slice(fuente.indexOf('TIPOS: frozenset'), fuente.indexOf('async def avisar'));
  return [...bloque.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
}

test('cada aviso que escribe el servidor tiene título y a dónde llevar', () => {
  const tipos = tiposDelServidor();
  assert.ok(tipos.length >= 14, `solo ${tipos.length} tipos leídos`);
  const sinTitulo = tipos.filter((tipo) => avisoAlCreador(tipo) === null);
  assert.deepEqual(sinTitulo, [], `sin título en el teléfono: ${sinTitulo.join(', ')}`);
  const sinRuta = tipos.filter((tipo) => rutaDelAviso(tipo, 'id-1') === null);
  assert.deepEqual(sinRuta, [], `sin destino: ${sinRuta.join(', ')}`);
});

test('las claves de título existen en el diccionario', () => {
  const es = readFileSync(join(SRC, 'i18n', 'es.ts'), 'utf8');
  for (const tipo of tiposDelServidor()) {
    const clave = avisoAlCreador(tipo)?.titulo ?? '';
    assert.ok(es.includes(`'${clave}':`), `falta ${clave}`);
  }
});

test('lo que hay que corregir lleva al editor; lo publicado, a su ficha', () => {
  assert.equal(rutaDelAviso('event_admission_rejected', 'e1'), '/editar-evento/e1');
  assert.equal(rutaDelAviso('event_published', 'e1'), '/eventos/e1');
  assert.equal(rutaDelAviso('course_review_rejected', 'c1'), '/editar-curso/c1');
  assert.equal(rutaDelAviso('course_published', 'c1'), '/course/c1');
  assert.equal(rutaDelAviso('product_photo_rejected', 'p1'), '/proveedor/productos/p1');
  assert.equal(rutaDelAviso('product_published', 'p1'), '/productos/p1');
  assert.equal(rutaDelAviso('seller_application_accepted', 'a1'), '/proveedor/productos');
  assert.equal(rutaDelAviso('seller_application_rejected', 'a1'), '/proveedor/postular');
  assert.equal(rutaDelAviso('like', 'x'), null, 'lo que no es un aviso al creador no se toca');
});

test('el detalle nombra lo decidido y el motivo, si lo hay', () => {
  assert.equal(
    detalleDelAviso({ title: 'Cena de autor', reason: 'Falta el recinto.' }),
    '«Cena de autor»: Falta el recinto.',
  );
  assert.equal(detalleDelAviso({ title: 'Cena de autor' }), '«Cena de autor»');
  assert.equal(detalleDelAviso(null), '');
  assert.equal(detalleDelAviso({ title: 42 }), '', 'lo que no es texto no se pinta');
});
