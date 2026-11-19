/**
 * Volver a pedir las URLs de video que caducan (videos en S3, opcion B).
 *
 * Lo que aqui no puede romperse sin que nadie se entere:
 *  - lo vencido o a menos de 10 min de vencer se vuelve a pedir, con
 *    `GET /posts?ids=` y en lotes de 50;
 *  - sin nada vencido NO se pide nada (la primera pintura no paga esto);
 *  - lo de Supabase, o sin fecha, nunca se pide (seria un bucle);
 *  - ante un error de reproduccion se pide UNA vez, no en bucle;
 *  - sin red, lo que se ve se queda como estaba.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  crearReintentoUnico,
  enLotes,
  MARGEN_DE_VENCIMIENTO_MS,
  publicacionNecesitaUrls,
  reelNecesitaUrls,
  renovarUrls,
  urlsPorVencer,
} from './urlsDeMedios.ts';

const AHORA = Date.parse('2026-11-19T12:00:00Z');
const enMin = (minutos: number) => new Date(AHORA + minutos * 60_000).toISOString();

describe('cuando unas URLs estan por vencer', () => {
  it('vencidas o a menos de 10 min: si; con mas margen: no', () => {
    assert.equal(MARGEN_DE_VENCIMIENTO_MS, 10 * 60_000);
    assert.equal(urlsPorVencer(enMin(-60), AHORA), true);
    assert.equal(urlsPorVencer(enMin(9), AHORA), true);
    assert.equal(urlsPorVencer(enMin(11), AHORA), false);
    assert.equal(urlsPorVencer(enMin(6 * 60), AHORA), false);
  });

  it('sin fecha o con una ilegible: no (no hay nada que esperar de pedirla otra vez)', () => {
    assert.equal(urlsPorVencer(undefined, AHORA), false);
    assert.equal(urlsPorVencer(null, AHORA), false);
    assert.equal(urlsPorVencer('mañana', AHORA), false);
  });

  it('solo las publicaciones de S3; y una de S3 sin URL (instantanea del muro) tambien', () => {
    assert.equal(
      publicacionNecesitaUrls({ mediaAlmacen: 'supabase', mediaUrl: 'x', urlsExpiran: enMin(-5) }, AHORA),
      false,
    );
    assert.equal(publicacionNecesitaUrls({ mediaUrl: 'x' }, AHORA), false);
    assert.equal(publicacionNecesitaUrls({ mediaAlmacen: 's3', mediaUrl: 'x', urlsExpiran: enMin(60) }, AHORA), false);
    assert.equal(publicacionNecesitaUrls({ mediaAlmacen: 's3', mediaUrl: 'x', urlsExpiran: enMin(5) }, AHORA), true);
    assert.equal(publicacionNecesitaUrls({ mediaAlmacen: 's3', urlsExpiran: enMin(60) }, AHORA), true);
  });

  it('en el feed vertical, la presencia de `urlsExpiran` ya dice que es de S3', () => {
    assert.equal(reelNecesitaUrls({}, AHORA), false);
    assert.equal(reelNecesitaUrls({ urlsExpiran: enMin(-1) }, AHORA), true);
  });
});

type Reel = { id: string; uri: string; urlsExpiran?: string; likes?: number };

describe('la nueva peticion de URLs vencidas', () => {
  it('desde una instantanea vieja: pide solo las vencidas y las reemplaza, en orden', async () => {
    const instantanea: Reel[] = [
      { id: 'a', uri: 'https://cdn/a?vieja', urlsExpiran: enMin(-2 * 24 * 60) },
      { id: 'b', uri: 'https://supabase/b' },
      { id: 'c', uri: 'https://cdn/c?vigente', urlsExpiran: enMin(120) },
      { id: 'd', uri: 'https://cdn/d?vieja', urlsExpiran: enMin(3) },
    ];
    const pedidas: string[][] = [];
    const { items, renovados } = await renovarUrls(instantanea, {
      necesita: (r) => reelNecesitaUrls(r, AHORA),
      pedir: async (ids) => {
        pedidas.push(ids);
        return ids.map((id) => ({ id, uri: `https://cdn/${id}?nueva`, urlsExpiran: enMin(6 * 60) }));
      },
      combinar: (viejo, nuevo) => ({ ...viejo, uri: nuevo.uri, urlsExpiran: nuevo.urlsExpiran }),
    });
    assert.deepEqual(pedidas, [['a', 'd']]);
    assert.deepEqual(renovados, ['a', 'd']);
    assert.deepEqual(
      items.map((r) => r.uri),
      ['https://cdn/a?nueva', 'https://supabase/b', 'https://cdn/c?vigente', 'https://cdn/d?nueva'],
    );
    // Lo que no se renueva es el mismo objeto: no se redibuja.
    assert.equal(items[1], instantanea[1]);
    assert.equal(items[2], instantanea[2]);
  });

  it('sin nada vencido no pide nada y devuelve la MISMA lista', async () => {
    const lista: Reel[] = [{ id: 'a', uri: 'x', urlsExpiran: enMin(300) }, { id: 'b', uri: 'y' }];
    let pedidas = 0;
    const r = await renovarUrls(lista, {
      necesita: (x) => reelNecesitaUrls(x, AHORA),
      pedir: async () => {
        pedidas++;
        return [];
      },
    });
    assert.equal(pedidas, 0);
    assert.equal(r.items, lista);
  });

  it('en lotes de 50 como mucho, el tope de la API', async () => {
    const muchas: Reel[] = Array.from({ length: 120 }, (_, i) => ({ id: `p${i}`, uri: 'x', urlsExpiran: enMin(-1) }));
    const tamanos: number[] = [];
    await renovarUrls(muchas, {
      necesita: (x) => reelNecesitaUrls(x, AHORA),
      pedir: async (ids) => {
        tamanos.push(ids.length);
        return [];
      },
    });
    assert.deepEqual(tamanos, [50, 50, 20]);
    assert.deepEqual(enLotes([1, 2, 3], 2), [[1, 2], [3]]);
  });

  it('forzar pide aunque la fecha valga (un error de reproduccion)', async () => {
    const lista: Reel[] = [{ id: 'a', uri: 'x', urlsExpiran: enMin(300) }];
    const pedidas: string[][] = [];
    const r = await renovarUrls(lista, {
      necesita: (x) => reelNecesitaUrls(x, AHORA),
      forzar: ['a'],
      pedir: async (ids) => {
        pedidas.push(ids);
        return [{ id: 'a', uri: 'nueva', urlsExpiran: enMin(360) }];
      },
    });
    assert.deepEqual(pedidas, [['a']]);
    assert.equal(r.items[0]?.uri, 'nueva');
  });

  it('sin red, o si la publicacion ya no vuelve, se queda lo que habia', async () => {
    const lista: Reel[] = [
      { id: 'a', uri: 'vieja-a', urlsExpiran: enMin(-1) },
      { id: 'b', uri: 'vieja-b', urlsExpiran: enMin(-1) },
    ];
    const sinRed = await renovarUrls(lista, {
      necesita: (x) => reelNecesitaUrls(x, AHORA),
      pedir: async () => {
        throw new Error('sin cobertura');
      },
    });
    assert.equal(sinRed.items, lista);
    assert.deepEqual(sinRed.renovados, []);

    const borrada = await renovarUrls(lista, {
      necesita: (x) => reelNecesitaUrls(x, AHORA),
      pedir: async () => [{ id: 'b', uri: 'nueva-b', urlsExpiran: enMin(360) }],
    });
    assert.deepEqual(borrada.items.map((r) => r.uri), ['vieja-a', 'nueva-b']);
    assert.deepEqual(borrada.renovados, ['b']);
  });
});

describe('ante un error de reproduccion, una sola vez', () => {
  it('la primera vez si; despues, el error de siempre. Cada video lleva su cuenta', () => {
    const reintento = crearReintentoUnico();
    assert.equal(reintento.puede('a'), true);
    assert.equal(reintento.puede('a'), false);
    assert.equal(reintento.puede('a'), false);
    assert.equal(reintento.puede('b'), true);
  });
});
