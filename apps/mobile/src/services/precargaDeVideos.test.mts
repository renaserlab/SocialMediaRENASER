/**
 * La cola de precarga del feed vertical (`precargaDeVideos.ts`).
 *
 * Lo que no puede romperse sin que nadie se entere:
 *  - se mantienen los 5 siguientes, del mas cercano al mas lejano;
 *  - HLS, URLs no http y URLs por renovar NO se precargan;
 *  - al deslizar se cancela lo que sale de la ventana y se pide solo lo nuevo;
 *  - la respuesta tardia de un pedido cancelado no pisa el pedido nuevo;
 *  - sin modulo nativo (web, binario viejo por OTA) todo es no-op y no lanza;
 *  - un modulo que lanza o rechaza no rompe el feed;
 *  - cada primer MB bajado de la red se mide sin contar la espera en la fila
 *    del nativo, y lo que viene del disco no se mide.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { crearMedidorDeRed } from '../lib/medidorDeRed.ts';
import {
  BYTES_A_PRECARGAR,
  KBPS_MAXIMOS_CREIBLES,
  VIDEOS_A_PRECARGAR,
  crearColaNativa,
  crearPrecargador,
  muestraCreible,
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

describe('medir la red con la precarga', () => {
  /** Reloj a mano y una cola nueva por prueba (la de la app es compartida). */
  function montar(modulo: ModuloNativoDePrecarga) {
    let t = 0;
    const muestras: Array<[number, number]> = [];
    const cola = crearPrecargador(modulo, BYTES_A_PRECARGAR, {
      ahora: () => t,
      cola: crearColaNativa(),
      alMedir: (bytes, ms) => muestras.push([bytes, ms]),
    });
    return { cola, muestras, avanzar: (ms: number) => (t += ms) };
  }

  it('mide desde que el pedido llega a la cabeza de la fila nativa, no desde que se pidio', async () => {
    const n = nativoFalso();
    const { cola, muestras, avanzar } = montar(n.modulo);
    cola.actualizar(['a', 'b', 'c']);
    avanzar(800);
    await n.resolver('a', true);
    avanzar(500);
    await n.resolver('b', true);
    avanzar(1200);
    await n.resolver('c', true);
    assert.deepEqual(muestras, [
      [BYTES_A_PRECARGAR, 800],
      [BYTES_A_PRECARGAR, 500],
      [BYTES_A_PRECARGAR, 1200],
    ]);
  });

  it('cancelar la cabeza hace avanzar la fila; cancelar otro no', async () => {
    const n = nativoFalso();
    const { cola, muestras, avanzar } = montar(n.modulo);
    cola.actualizar(['a', 'b', 'c']);
    avanzar(300);
    cola.actualizar(['b', 'c']); // cancela 'a', que era la cabeza: 'b' empieza ahora
    avanzar(400);
    cola.actualizar(['b']); // cancela 'c', que esperaba: no cambia nada
    avanzar(100);
    await n.resolver('b', true);
    assert.deepEqual(muestras, [[BYTES_A_PRECARGAR, 500]]);
  });

  it('no mide fallos, cancelaciones ni respuestas tardias', async () => {
    const n = nativoFalso();
    const { cola, muestras, avanzar } = montar(n.modulo);
    cola.actualizar(['a']);
    avanzar(700);
    await n.resolver('a', false);
    cola.actualizar(['b']);
    cola.actualizar([]);
    avanzar(700);
    await n.resolver('b', true); // llega tarde la del cancelado
    assert.deepEqual(muestras, []);
  });

  it('no mide lo que vino del disco: demasiado rapido o una URL ya bajada', async () => {
    const n = nativoFalso();
    const { cola, muestras, avanzar } = montar(n.modulo);
    cola.actualizar(['a']);
    avanzar(5); // 1 MB en 5 ms = ~1,7 Gbps: cache
    await n.resolver('a', true);
    assert.deepEqual(muestras, []);

    cola.actualizar(['b']);
    avanzar(600);
    await n.resolver('b', true);
    cola.actualizar([]); // sale de la ventana...
    cola.actualizar(['b']); // ...y vuelve: ya esta en disco
    avanzar(600);
    await n.resolver('b', true);
    assert.deepEqual(muestras, [[BYTES_A_PRECARGAR, 600]]);
  });

  it('un medidor que lanza no rompe la precarga', async () => {
    const n = nativoFalso();
    let t = 0;
    const cola = crearPrecargador(n.modulo, BYTES_A_PRECARGAR, {
      ahora: () => t,
      cola: crearColaNativa(),
      alMedir: () => {
        throw new Error('medidor roto');
      },
    });
    cola.actualizar(['a', 'b']);
    t = 900;
    await n.resolver('a', true);
    cola.actualizar(['a', 'b']);
    assert.deepEqual(n.pedidas(), ['a', 'b']);
  });

  it('muestraCreible pone el techo en KBPS_MAXIMOS_CREIBLES', () => {
    const mb = 1024 * 1024;
    assert.equal(muestraCreible(mb, 1000), true);
    assert.equal(muestraCreible(mb, Math.ceil((mb * 8) / KBPS_MAXIMOS_CREIBLES)), true);
    assert.equal(muestraCreible(mb, 10), false);
    assert.equal(muestraCreible(mb, 0), false);
    assert.equal(muestraCreible(0, 100), false);
    assert.equal(muestraCreible(Number.NaN, 100), false);
  });

  it('con el medidor de red de verdad, la precarga da una medicion en kbps', async () => {
    const n = nativoFalso();
    const medidor = crearMedidorDeRed(() => 0);
    let t = 0;
    const cola = crearPrecargador(n.modulo, BYTES_A_PRECARGAR, {
      ahora: () => t,
      cola: crearColaNativa(),
      alMedir: medidor.registrar,
    });
    assert.equal(medidor.kbps(), null);
    cola.actualizar(['a']);
    t = 1000; // 1 MB en 1 s
    await n.resolver('a', true);
    assert.equal(Math.round(medidor.kbps()!), Math.round((BYTES_A_PRECARGAR * 8) / 1000));
  });
});
