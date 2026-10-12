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

describe('las palabras son las de aquí', () => {
  /**
   * La palabra de España, la que se usa en el Perú, y las claves donde la
   * primera está bien porque ahí significa otra cosa.
   */
  const PALABRAS: { deAlla: RegExp; deAqui: string; salvo?: string[] }[] = [
    { deAlla: /\bvídeo/i, deAqui: '«video», sin tilde' },
    { deAlla: /\bañad/i, deAqui: '«agregar»' },
    { deAlla: /\bpuls(a|ar|as|e|es|ado|ada)\b/i, deAqui: '«tocar» o «mantener presionado»' },
    {
      deAlla: /\bdirectos?\b/i,
      deAqui: '«transmisión» o «en vivo»',
      // «Mensaje directo» y «contacto directo» no son una transmisión.
      salvo: ['booking.directMessage', 'support.directContact'],
    },
    { deAlla: /\bajustes\b/i, deAqui: '«configuración»' },
    { deAlla: /\bplazas?\b/i, deAqui: '«cupo»' },
    { deAlla: /\bcostes?\b/i, deAqui: '«costo»' },
    { deAlla: /\bcarrete\b/i, deAqui: '«galería»' },
    { deAlla: /\bordenador(es)?\b/i, deAqui: '«computadora»' },
    { deAlla: /\b(el|tu|un|del|al|este|ese) móvil\b/i, deAqui: '«celular» o «teléfono»' },
  ];

  for (const { deAlla, deAqui, salvo } of PALABRAS) {
    it(`no se escribe ${deAlla.source}: se escribe ${deAqui}`, () => {
      assert.deepEqual(clavesCon(deAlla, new Set(salvo)), []);
    });
  }

  it('una transmisión se «transmite», no se «emite»', () => {
    // Solo en los textos de las transmisiones: en el resto «emitir» es otra
    // cosa —un certificado, una entrada, un comprobante— y está bien dicho.
    const deTransmisiones = TEXTOS.filter(([clave]) =>
      /^(live\.|create\.live|notif\.live|share\.live)/.test(clave),
    );
    assert.ok(deTransmisiones.length > 100, 'No se encuentran los textos de las transmisiones.');
    assert.deepEqual(
      deTransmisiones.filter(([, texto]) => /\bemi(sión|siones|t[eia])/i.test(texto)).map(([clave]) => clave),
      [],
    );
  });
});
