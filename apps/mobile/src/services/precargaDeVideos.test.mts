/**
 * La cola de precarga del feed vertical (`precargaDeVideos.ts`).
 *
 * Lo que no puede romperse sin que nadie se entere:
 *  - se mantienen los 5 siguientes, del mas cercano al mas lejano;
 *  - HLS, URLs no http y URLs por renovar NO se precargan;
 *  - al deslizar se cancela lo que sale de la ventana y se pide solo lo nuevo;
 *  - la respuesta tardia de un pedido cancelado no pisa el pedido nuevo;
 *  - sin modulo nativo (web, binario viejo por OTA) todo es no-op y no lanza;
 *  - un modulo que lanza o rechaza no rompe el feed.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BYTES_A_PRECARGAR,
  VIDEOS_A_PRECARGAR,
  crearPrecargador,
  esModuloDePrecarga,
  sePuedePrecargar,
  urlsAPrecargar,
  type ModuloNativoDePrecarga,
} from './precargaDeVideos.ts';

const mp4 = (n: number) => ({ uri: `https://cdn.ejemplo.com/v${n}.mp4?firma=${n}` });
const feed = (n: number) => Array.from({ length: n }, (_, i) => mp4(i));

type Llamada = { tipo: 'precargar'; url: string; bytes: number } | { tipo: 'cancelar'; url: string };

function nativoFalso() {
  const llamadas: Llamada[] = [];
  const pendientes = new Map<string, Array<(listo: boolean) => void>>();
  const modulo: ModuloNativoDePrecarga = {
    precargarVideoAsync(url, bytes) {
      llamadas.push({ tipo: 'precargar', url, bytes });
      return new Promise<boolean>((resolver) => {
        pendientes.set(url, [...(pendientes.get(url) ?? []), resolver]);
      });
    },
    cancelarPrecargaDeVideo(url) {
      llamadas.push({ tipo: 'cancelar', url });
    },
    cancelarPrecargasDeVideo() {
      throw new Error('un feed nunca cancela lo de los demas');
    },
  };
  /** Resuelve el pedido MAS ANTIGUO aun pendiente de esa URL. */
  const resolver = async (url: string, listo: boolean) => {
    const cola = pendientes.get(url) ?? [];
    const primero = cola.shift();
    primero?.(listo);
    await new Promise((r) => setImmediate(r));
  };
  const pedidas = () => llamadas.filter((l) => l.tipo === 'precargar').map((l) => l.url);
  const canceladas = () => llamadas.filter((l) => l.tipo === 'cancelar').map((l) => l.url);
  return { modulo, llamadas, resolver, pedidas, canceladas };
}

describe('urlsAPrecargar', () => {
  it('son los 5 siguientes, en orden de cercania', () => {
    const items = feed(20);
    assert.equal(VIDEOS_A_PRECARGAR, 5);
    assert.deepEqual(urlsAPrecargar(items, 3), [4, 5, 6, 7, 8].map((i) => items[i]!.uri));
  });

  it('salta los vecinos que ya tienen reproductor, sin estirar la ventana', () => {
    const items = feed(20);
    assert.deepEqual(
      urlsAPrecargar(items, 3, { conReproductor: 1 }),
      [5, 6, 7, 8].map((i) => items[i]!.uri),
    );
  });

  it('se corta al final de la lista y no acepta indices raros', () => {
    const items = feed(4);
    assert.deepEqual(urlsAPrecargar(items, 2), [items[3]!.uri]);
    assert.deepEqual(urlsAPrecargar(items, 3), []);
    assert.deepEqual(urlsAPrecargar(items, -1), []);
    assert.deepEqual(urlsAPrecargar(items, Number.NaN), []);
    assert.deepEqual(urlsAPrecargar([], 0), []);
  });

  it('ignora HLS, URLs que no son http y las que estan por renovarse', () => {
    const items = [
      mp4(0),
      { uri: 'https://cdn.ejemplo.com/v1/master.m3u8', isStream: true },
      { uri: 'file:///local/v2.mp4' },
      { uri: undefined },
      { ...mp4(4), urlsExpiran: 'vence' },
      mp4(5),
    ];
    const urls = urlsAPrecargar(items, 0, { necesitaUrls: (v) => v.urlsExpiran === 'vence' });
    assert.deepEqual(urls, [items[5]!.uri]);
  });

  it('no repite una URL que aparece dos veces', () => {
    const items = [mp4(0), mp4(1), mp4(1), mp4(2)];
    assert.deepEqual(urlsAPrecargar(items, 0), [mp4(1).uri, mp4(2).uri]);
  });
});

describe('sePuedePrecargar y esModuloDePrecarga', () => {
  it('solo MP4 por http(s)', () => {
    assert.equal(sePuedePrecargar(mp4(1)), true);
    assert.equal(sePuedePrecargar({ uri: 'HTTP://x/y.mp4' }), true);
    assert.equal(sePuedePrecargar({ uri: 'https://x/y.m3u8', isStream: true }), false);
    assert.equal(sePuedePrecargar({ uri: '' }), false);
  });

  it('un binario sin el parche (modulo sin las funciones) no cuenta', () => {
    assert.equal(esModuloDePrecarga(null), false);
    assert.equal(esModuloDePrecarga(undefined), false);
    assert.equal(esModuloDePrecarga({ clearVideoCacheAsync: () => undefined }), false);
    assert.equal(esModuloDePrecarga({ precargarVideoAsync: () => undefined }), false);
    assert.equal(esModuloDePrecarga(nativoFalso().modulo), true);
  });
});

describe('crearPrecargador', () => {
  it('pide 1 MB de cada URL, en el orden dado', () => {
    const n = nativoFalso();
    const cola = crearPrecargador(n.modulo);
    cola.actualizar(['a', 'b', 'c']);
    assert.deepEqual(n.llamadas, [
      { tipo: 'precargar', url: 'a', bytes: BYTES_A_PRECARGAR },
      { tipo: 'precargar', url: 'b', bytes: BYTES_A_PRECARGAR },
      { tipo: 'precargar', url: 'c', bytes: BYTES_A_PRECARGAR },
    ]);
    assert.equal(BYTES_A_PRECARGAR, 1024 * 1024);
  });

  it('al deslizar cancela lo que sale y pide solo lo que entra', async () => {
    const items = feed(20);
    const n = nativoFalso();
    const cola = crearPrecargador(n.modulo);
    cola.actualizar(urlsAPrecargar(items, 0, { conReproductor: 1 })); // 2..5
    await n.resolver(items[2]!.uri, true);
    cola.actualizar(urlsAPrecargar(items, 1, { conReproductor: 1 })); // 3..6
    // El 2 ya estaba listo (y ahora tiene reproductor): no hay nada que
    // cancelar. Del 3 al 5 siguen en curso. Se pide solo el 6.
    assert.deepEqual(n.canceladas(), []);
    assert.deepEqual(n.pedidas(), [2, 3, 4, 5, 6].map((i) => items[i]!.uri));

    cola.actualizar(urlsAPrecargar(items, 3, { conReproductor: 1 })); // 5..8
    // El 3 (ahora el actual) y el 4 (ahora con reproductor) compiten: fuera.
    assert.deepEqual(n.canceladas(), [items[3]!.uri, items[4]!.uri]);
    assert.deepEqual(n.pedidas().slice(5), [items[7]!.uri, items[8]!.uri]);
  });

  it('lo ya listo no se vuelve a pedir mientras siga en la ventana', async () => {
    const n = nativoFalso();
    const cola = crearPrecargador(n.modulo);
    cola.actualizar(['a', 'b']);
    await n.resolver('a', true);
    cola.actualizar(['a', 'b']);
    assert.deepEqual(n.pedidas(), ['a', 'b']);
    // Sale de la ventana y vuelve: se pide otra vez (en nativo es una
    // consulta a disco, no una descarga).
    cola.actualizar(['b']);
    cola.actualizar(['a', 'b']);
    assert.deepEqual(n.pedidas(), ['a', 'b', 'a']);
  });

  it('lo que fallo o se cancelo se puede volver a pedir', async () => {
    const n = nativoFalso();
    const cola = crearPrecargador(n.modulo);
    cola.actualizar(['a']);
    await n.resolver('a', false);
    cola.actualizar(['a']);
    assert.deepEqual(n.pedidas(), ['a', 'a']);
  });

  it('la respuesta tardia de un pedido cancelado no pisa el nuevo', async () => {
    const n = nativoFalso();
    const cola = crearPrecargador(n.modulo);
    cola.actualizar(['a']);
    cola.actualizar([]); // cancela el primer pedido de 'a'
    cola.actualizar(['a']); // segundo pedido de 'a', en curso
    await n.resolver('a', false); // llega tarde la del primero
    cola.actualizar(['a']);
    // Sigue en curso el segundo: no se pide un tercero.
    assert.deepEqual(n.pedidas(), ['a', 'a']);
    await n.resolver('a', true);
    cola.actualizar(['a']);
    assert.deepEqual(n.pedidas(), ['a', 'a']);
  });

  it('detener cancela solo lo suyo, una URL a la vez', () => {
    const n = nativoFalso();
    const cola = crearPrecargador(n.modulo);
    cola.actualizar(['a', 'b']);
    cola.detener();
    assert.deepEqual(n.canceladas(), ['a', 'b']);
    cola.detener();
    assert.deepEqual(n.canceladas(), ['a', 'b']);
  });

  it('sin modulo nativo es no-op y no lanza', () => {
    const cola = crearPrecargador(null);
    assert.doesNotThrow(() => {
      cola.actualizar(['a', 'b']);
      cola.actualizar([]);
      cola.detener();
    });
  });

  it('un modulo que lanza o rechaza no rompe nada', async () => {
    const lanza: ModuloNativoDePrecarga = {
      precargarVideoAsync: () => {
        throw new Error('nativo roto');
      },
      cancelarPrecargaDeVideo: () => {
        throw new Error('nativo roto');
      },
      cancelarPrecargasDeVideo: () => undefined,
    };
    const cola = crearPrecargador(lanza);
    assert.doesNotThrow(() => {
      cola.actualizar(['a']);
      cola.actualizar([]);
      cola.detener();
    });

    let pedidos = 0;
    const rechaza: ModuloNativoDePrecarga = {
      precargarVideoAsync: () => {
        pedidos++;
        return Promise.reject(new Error('sin red'));
      },
      cancelarPrecargaDeVideo: () => undefined,
      cancelarPrecargasDeVideo: () => undefined,
    };
    const otra = crearPrecargador(rechaza);
    otra.actualizar(['a']);
    await new Promise((r) => setImmediate(r));
    otra.actualizar(['a']);
    assert.equal(pedidos, 2);
  });
});
