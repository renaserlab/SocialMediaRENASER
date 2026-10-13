import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { afterSheetClose, closeThen } from '../lib/afterSheetClose.ts';

/**
 * LA PANTALLA GRIS AL CREAR UN CURSO O UN EVENTO, Y AL PUBLICAR (13/10/2026).
 *
 * Una hoja inferior y un cuadro de confirmación son un `Modal`: otra ventana,
 * con su velo oscuro, que tarda en irse. La regla del proyecto
 * (`lib/afterSheetClose`) es no lanzar nada mientras se está yendo. La hoja de
 * «Crear» la cumplía al borrar y no al crear: cerraba y metía el asistente en
 * el mismo instante.
 *
 * Lo que se guarda aquí es que la regla se cumple en esos sitios. Que eso
 * quite el gris en un teléfono solo lo puede decir un teléfono.
 */

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (codigo: string) =>
  codigo.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('la espera a que una ventana se haya ido', () => {
  it('dura lo que tarda en fundirse un Modal, con holgura', async () => {
    const antes = Date.now();
    await afterSheetClose();
    const espera = Date.now() - antes;
    assert.ok(espera >= 280, `solo esperó ${espera} ms`);
    assert.ok(espera < 1000, `esperó ${espera} ms: eso ya se nota`);
  });

  it('cerrar y después hacer: primero se cierra, y lo otro no corre en el mismo instante', async () => {
    const pasos: string[] = [];
    closeThen(
      () => pasos.push('cerrar'),
      () => pasos.push('navegar'),
    );
    assert.deepEqual(pasos, ['cerrar']);
    await afterSheetClose();
    await new Promise((listo) => setTimeout(listo, 30));
    assert.deepEqual(pasos, ['cerrar', 'navegar']);
  });
});

describe('la hoja de «Crear» se va antes de abrir el asistente', () => {
  const hoja = sinComentarios(fuente('components/CreateCatalogSheet.tsx'));

  it('al crear un curso o un evento: cerrar, esperar, navegar y avisar', () => {
    assert.match(
      hoja,
      /close\(\);\s*if \(destino === null\) \{\s*toast\(hecho\);\s*\} else \{\s*await afterSheetClose\(\);\s*router\.push\(destino as never\);\s*toast\(hecho\);\s*\}/,
    );
    // El destino es el asistente del curso o el borrador del evento.
    assert.match(hoja, /nuevoCurso\s*\? `\/editar-curso\/\$\{nuevoCurso\}`\s*: nuevoEvento\s*\? `\/editar-evento\/\$\{nuevoEvento\}`\s*: null/);
  });

  it('en ningún sitio de la hoja se cierra y se navega en el mismo instante', () => {
    assert.doesNotMatch(hoja, /close\(\);\s*router\.(push|replace)\(/);
    assert.doesNotMatch(hoja, /onClose\(\);\s*router\.(push|replace)\(/);
    // «Abrir el asistente» desde la hoja de editar: lo mismo.
    assert.match(hoja, /closeThen\(close, \(\) => router\.push\(`\/editar-curso\/\$\{destino\}` as never\)\);/);
  });

  it('y sigue esperando antes de preguntar al borrar, como ya hacía', () => {
    assert.match(hoja, /onClose\(\);\s*await new Promise\(\(resolve\) => setTimeout\(resolve, 300\)\);\s*const accepted = await confirm\(/);
  });
});

describe('tras aceptar un cuadro de confirmación, se espera a que se haya ido', () => {
  it('enviar o publicar un evento', () => {
    const evento = sinComentarios(fuente('screens/EditarEventoScreen.tsx'));
    const enviar = evento.slice(evento.indexOf('const enviar = async'), evento.indexOf('const salir = '));
    assert.match(
      enviar,
      /if \(!aceptado\) return;\s*await afterSheetClose\(\);\s*if \(ocupadoRef\.current\) return;/,
    );
    // Y todo lo que toca la pantalla va después de esa espera.
    assert.ok(enviar.indexOf('await afterSheetClose()') < enviar.indexOf('guardar()'));
    assert.ok(enviar.indexOf('await afterSheetClose()') < enviar.indexOf('enviarARevision('));
    assert.ok(enviar.indexOf('await afterSheetClose()') < enviar.indexOf('toast('));
  });

  it('publicar un producto, con el cerrojo tomado desde antes de preguntar', () => {
    const producto = sinComentarios(fuente('screens/EditarProductoScreen.tsx'));
    const postular = producto.slice(producto.indexOf('const postular = '), producto.indexOf('const salir'));
    assert.match(postular, /void conCerrojo\(async \(\) => \{\s*const aceptado = await confirm\(/);
    assert.match(
      postular,
      /if \(!aceptado\) return;\s*await afterSheetClose\(\);\s*const resultado = await ProductSellerRepository\.postularProducto\(/,
    );
  });
});
