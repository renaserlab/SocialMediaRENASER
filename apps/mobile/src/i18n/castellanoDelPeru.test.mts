/**
 * El castellano de Z es el del Perú.
 *
 * Z se hizo en el Perú y sus textos se escribieron, sin querer, con giros de
 * España: «vídeo», «añadir», «pulsa», «en directo», «dejaréis de seguiros»,
 * «se ha guardado». Se corrigieron el 12/10/2026. Esta prueba existe para que
 * no vuelvan: un texto nuevo escrito con uno de esos giros falla aquí, con el
 * nombre de la clave y la palabra que hay que cambiar.
 *
 * Mira SOLO lo que se lee en pantalla —los valores de `es.ts`—, no los
 * comentarios ni los nombres del código.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { es } from './es.ts';

const TEXTOS = Object.entries(es) as [string, string][];
const INDICE = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

/** Las claves cuyo texto casa con el patrón, para que el fallo diga cuáles son. */
function clavesCon(patron: RegExp, salvo: ReadonlySet<string> = new Set()): string[] {
  return TEXTOS.filter(([clave, texto]) => !salvo.has(clave) && patron.test(texto)).map(
    ([clave]) => clave,
  );
}

describe('el idioma se llama «castellano»', () => {
  it('así sale en el selector de idioma y en la configuración', () => {
    // `LANGUAGE_NAMES.es` es lo que pintan la pantalla de idioma y la fila
    // «Idioma» de la configuración; `lang.spanish`, lo que se lee en un curso.
    assert.match(INDICE, /^\s*es: 'Castellano',\r?$/m);
    assert.equal(es['lang.spanish'], 'Castellano');
  });

  it('ningún texto lo llama «español»', () => {
    assert.deepEqual(clavesCon(/\bespañol/i), []);
  });
});
