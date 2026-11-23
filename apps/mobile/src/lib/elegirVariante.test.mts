/**
 * Calidades de video elegidas una vez por video (ver `elegirVariante.ts`).
 *
 * Lo que no puede romperse: sin variantes, la fuente es EXACTAMENTE la de
 * hoy; con variantes y sin medición, la de arriba (el `mediaUrl` de hoy).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  crearMemoriaDeCalidad,
  elegirVariante,
  MARGEN_DEL_THROUGHPUT,
  normalizarVariantes,
  type VarianteDeVideo,
} from './elegirVariante.ts';
import { elegirFuenteDeVideo } from './elegirFuenteDeVideo.ts';
import {
  BYTES_MINIMOS_POR_MUESTRA,
  combinarMediciones,
  crearMedidorDeRed,
  medicionDelNavegador,
  VIGENCIA_MS,
} from './medidorDeRed.ts';

const ESCALERA: VarianteDeVideo[] = [
  { alto: 480, url: 'https://cdn/480p.mp4?f', bitrate: 1_000_000 },
  { alto: 560, url: 'https://cdn/560p.mp4?f', bitrate: 1_400_000 },
  { alto: 720, url: 'https://cdn/feed-720.mp4?f', bitrate: 2_500_000 },
];

describe('elegirVariante', () => {
  it('sin variantes no elige nada (se hace lo de hoy)', () => {
    assert.equal(elegirVariante(undefined, { kbps: 500 }), null);
    assert.equal(elegirVariante([], { kbps: 500 }), null);
    // Con una sola no hay nada que elegir.
    assert.equal(elegirVariante([ESCALERA[2]], { kbps: 500 }), null);
  });

  it('sin medición se queda con la de arriba', () => {
    assert.equal(elegirVariante(ESCALERA)?.alto, 720);
    assert.equal(elegirVariante(ESCALERA, {})?.alto, 720);
    assert.equal(elegirVariante(ESCALERA, { tipo: 'wifi' })?.alto, 720);
    assert.equal(elegirVariante(ESCALERA, { tipo: 'desconocido' })?.alto, 720);
  });

  it('con throughput elige la más alta que entra con margen', () => {
    // 2.5 Mbps / 0.7 ≈ 3.58 Mbps hacen falta para la de 720.
    assert.equal(elegirVariante(ESCALERA, { kbps: 10_000 })?.alto, 720);
    assert.equal(elegirVariante(ESCALERA, { kbps: 3_600 })?.alto, 720);
    assert.equal(elegirVariante(ESCALERA, { kbps: 3_000 })?.alto, 560);
    assert.equal(elegirVariante(ESCALERA, { kbps: 1_500 })?.alto, 480);
    // Ninguna entra: la más baja, nunca nada.
    assert.equal(elegirVariante(ESCALERA, { kbps: 100 })?.alto, 480);
    assert.ok(MARGEN_DEL_THROUGHPUT < 1);
  });

  it('el tipo de red sirve cuando no hay kbps', () => {
    assert.equal(elegirVariante(ESCALERA, { tipo: '3g' })?.alto, 480);
    assert.equal(elegirVariante(ESCALERA, { tipo: '2g' })?.alto, 480);
    assert.equal(elegirVariante(ESCALERA, { tipo: '4g' })?.alto, 720);
    // Lo medido manda sobre el tipo.
    assert.equal(elegirVariante(ESCALERA, { tipo: '3g', kbps: 10_000 })?.alto, 720);
  });

  it('ahorro de datos: la más baja', () => {
    assert.equal(elegirVariante(ESCALERA, { ahorroDeDatos: true, kbps: 50_000 })?.alto, 480);
  });

  it('sin bitrate usa uno supuesto por altura', () => {
    const sinBitrate = ESCALERA.map(({ alto, url }) => ({ alto, url }));
    assert.equal(elegirVariante(sinBitrate, { kbps: 1_600 })?.alto, 480);
    assert.equal(elegirVariante(sinBitrate, { kbps: 2_100 })?.alto, 560);
  });

  it('normaliza: descarta basura, repetidas y URLs que no son http, y ordena', () => {
    const crudas = [
      ESCALERA[2],
      { alto: 480, url: 'javascript:alert(1)' },
      ESCALERA[0],
      { alto: 480, url: 'https://otra' },
      null,
      { alto: 'x', url: 'https://cdn/x' },
      { alto: 560, url: 'https://cdn/560p.mp4?f', bitrate: -3 },
    ];
    const lista = normalizarVariantes(crudas);
    assert.deepEqual(
      lista?.map((v) => [v.alto, v.bitrate]),
      [[480, 1_000_000], [560, null], [720, 2_500_000]],
    );
    assert.equal(normalizarVariantes('nada'), undefined);
  });
});

describe('memoria de calidad: una vez por video', () => {
  it('la renovación de firmas trae la MISMA calidad aunque la red cambie', () => {
    const memoria = crearMemoriaDeCalidad();
    assert.equal(memoria.elegir('p1', ESCALERA, { kbps: 1_000 })?.alto, 480);
    const renovadas = ESCALERA.map((v) => ({ ...v, url: v.url.replace('?f', '?g') }));
    const otraVez = memoria.elegir('p1', renovadas, { kbps: 50_000 });
    assert.equal(otraVez?.alto, 480);
    assert.equal(otraVez?.url, 'https://cdn/480p.mp4?g');
    // Otro video sí se elige con la red de ahora.
    assert.equal(memoria.elegir('p2', ESCALERA, { kbps: 50_000 })?.alto, 720);
  });

  it('si la calidad recordada ya no existe, se vuelve a elegir', () => {
    const memoria = crearMemoriaDeCalidad();
    memoria.elegir('p1', ESCALERA, { kbps: 1_000 });
    assert.equal(memoria.elegir('p1', ESCALERA.slice(1), { kbps: 50_000 })?.alto, 720);
  });

  it('no crece sin límite', () => {
    const memoria = crearMemoriaDeCalidad(2);
    memoria.elegir('a', ESCALERA, { kbps: 1_000 });
    memoria.elegir('b', ESCALERA, { kbps: 1_000 });
    memoria.elegir('c', ESCALERA, { kbps: 1_000 });
    // `a` salió: se vuelve a elegir con la red de ahora.
    assert.equal(memoria.elegir('a', ESCALERA, { kbps: 50_000 })?.alto, 720);
  });
});

describe('elegirFuenteDeVideo con variantes', () => {
  const elegir = (v: readonly VarianteDeVideo[]) => elegirVariante(v, { kbps: 1_000 });

  it('sin variantes, exactamente como hoy (HLS en nativo, MP4 en web)', () => {
    const post = { streamUrl: 'https://api/hls.m3u8', mediaUrl: 'https://cdn/feed.mp4' };
    assert.deepEqual(elegirFuenteDeVideo(post, true, elegir), { uri: post.streamUrl, isStream: true });
    assert.deepEqual(elegirFuenteDeVideo(post, false, elegir), { uri: post.mediaUrl, isStream: false });
    assert.deepEqual(elegirFuenteDeVideo({ ...post, variantes: [] }, true, elegir), {
      uri: post.streamUrl,
      isStream: true,
    });
    assert.equal(elegirFuenteDeVideo({}, true, elegir), null);
  });

  it('con variantes, el MP4 elegido va antes que el HLS (entra en la caché de iOS)', () => {
    const post = { streamUrl: 'https://api/hls.m3u8', mediaUrl: ESCALERA[2].url, variantes: ESCALERA };
    assert.deepEqual(elegirFuenteDeVideo(post, true, elegir), {
      uri: ESCALERA[0].url,
      isStream: false,
      alto: 480,
    });
    // En la web igual.
    assert.equal(elegirFuenteDeVideo(post, false, elegir)?.uri, ESCALERA[0].url);
  });

  it('si el elector no da nada, se cae a lo de hoy', () => {
    const post = { mediaUrl: 'https://cdn/feed.mp4', variantes: ESCALERA };
    assert.deepEqual(elegirFuenteDeVideo(post, true, () => null), {
      uri: post.mediaUrl,
      isStream: false,
    });
    // Y sin elector (llamador viejo), también.
    assert.deepEqual(elegirFuenteDeVideo(post, true), { uri: post.mediaUrl, isStream: false });
  });
});

describe('medidor de red', () => {
  it('media móvil de descargas grandes; las pequeñas no cuentan', () => {
    let reloj = 0;
    const medidor = crearMedidorDeRed(() => reloj);
    assert.equal(medidor.kbps(), null);
    medidor.registrar(20_000, 100); // mide latencia, no ancho de banda
    assert.equal(medidor.kbps(), null);
    medidor.registrar(1_000_000, 1_000); // 8000 kbps
    assert.equal(medidor.kbps(), 8_000);
    medidor.registrar(BYTES_MINIMOS_POR_MUESTRA * 10, 10_000); // ~1049 kbps
    const media = medidor.kbps()!;
    assert.ok(media < 8_000 && media > 1_049);
    medidor.registrar(Number.NaN, 10);
    medidor.registrar(1_000_000, 0);
    assert.equal(medidor.kbps(), media);
  });

  it('una medición vieja deja de valer', () => {
    let reloj = 0;
    const medidor = crearMedidorDeRed(() => reloj);
    medidor.registrar(1_000_000, 1_000);
    reloj = VIGENCIA_MS;
    assert.equal(medidor.kbps(), null);
    // Y la siguiente muestra empieza de cero, sin arrastrar la vieja.
    medidor.registrar(1_000_000, 2_000);
    assert.equal(medidor.kbps(), 4_000);
  });

  it('lee el navegador cuando existe y nunca lanza', () => {
    assert.deepEqual(
      medicionDelNavegador({ navigator: { connection: { downlink: 1.5, effectiveType: '3g', saveData: true } } }),
      { kbps: 1_500, tipo: '3g', ahorroDeDatos: true },
    );
    assert.equal(medicionDelNavegador({ navigator: {} }), null);
    assert.equal(medicionDelNavegador(undefined), null);
    const hostil = {
      get navigator(): never {
        throw new Error('no');
      },
    };
    assert.equal(medicionDelNavegador(hostil), null);
  });

  it('lo medido por la app manda sobre el navegador', () => {
    assert.equal(combinarMediciones(null, null), null);
    assert.deepEqual(combinarMediciones(900, { kbps: 10_000, tipo: '4g', ahorroDeDatos: false }), {
      kbps: 900,
      tipo: '4g',
      ahorroDeDatos: false,
    });
    assert.equal(combinarMediciones(null, { kbps: 10_000, tipo: '4g' })?.kbps, 10_000);
  });
});
