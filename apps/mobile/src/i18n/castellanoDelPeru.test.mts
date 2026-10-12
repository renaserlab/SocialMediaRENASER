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

  const GIROS: { deAlla: RegExp; deAqui: string; salvo?: string[] }[] = [
    { deAlla: /\bno val(e|en)\b/i, deAqui: '«no es válido»' },
    { deAlla: /\bfallos?\b/i, deAqui: '«error» o «falla»' },
    { deAlla: /\baverías?\b/i, deAqui: '«falla»' },
    { deAlla: /\bcomo mucho\b/i, deAqui: '«como máximo»' },
    { deAlla: /\blaborables?\b/i, deAqui: '«hábiles»' },
    {
      deAlla: /\benseñ/i,
      deAqui: '«mostrar»',
      // Aquí «enseñar» es dar clase, que es lo que quiere decir.
      salvo: ['offer.teaches', 'offer.teachesOwn', 'reason.teaches', 'reason.teachesGeneric'],
    },
  ];

  for (const { deAlla, deAqui, salvo } of GIROS) {
    it(`no se dice ${deAlla.source}: se dice ${deAqui}`, () => {
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

describe('las frases también', () => {
  it('se habla de «ustedes», nunca de «vosotros»', () => {
    // «Dejaréis de seguiros», «Tenéis intereses parecidos». Los números
    // «dieciséis» y «veintiséis» acaban igual y no tienen nada que ver.
    //
    // Con `\p{L}` y no con `\b`: para JavaScript una «í» no es letra, y
    // «envíos» o «vacíos» le parecían la palabra «os».
    const vosotros =
      /(?<!\p{L})(?!dieciséis|veintiséis)\p{L}+[áé]is(?!\p{L})|(?<!\p{L})(vosotr[oa]s|vuestr[oa]s?|os)(?!\p{L})/iu;
    assert.deepEqual(clavesCon(vosotros), []);
  });

  it('lo que acaba de pasar se cuenta en pasado simple', () => {
    /*
      «Ocurrió un error», «Cancelaste el pago», «Se volvió a cargar»; no «Ha
      ocurrido», «Has cancelado», «Se ha vuelto a cargar».

      Solo se vigila la frase que EMPIEZA así, que es la forma inconfundible.
      «Todavía no has publicado nada» o «Nadie ha escrito todavía» se dicen
      igual aquí y no se tocan: hablan de algo que sigue sin ocurrir.
    */
    const reciente =
      /(^|[.:;!?»…]\s+)((Has|Hemos|Ha|Se han?)\s+([a-záéíóúñ]+\s+)?[a-záéíóúñ]+(ado|ido|to|cho|so)\b|No se han? podido\b)/;
    assert.deepEqual(clavesCon(reciente), []);
  });
});
