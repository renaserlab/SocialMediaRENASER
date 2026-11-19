/**
 * Subir el video de una publicacion a S3 (opcion B), sin red: la API y el PUT
 * se inyectan y apuntan lo que se les pide.
 *
 * Lo que aqui no puede romperse sin que nadie se entere:
 *  - una parte que falla se reintenta SOLA, con URL nueva, sin repetir las
 *    demas (repetirlas es pagar otra vez los megas de quien sube por 4G);
 *  - nunca mas de tres partes a la vez;
 *  - reanudar pregunta a la API que partes tiene y sube solo las que faltan;
 *  - el PUT simple manda las cabeceras de la API tal cual y el archivo entero;
 *  - si el poster falla, la publicacion sigue sin el.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  nuevoGrupo,
  subirArchivoAS3,
  subirVideoDePublicacion,
  type ApiDeSubidas,
  type EstadoDeSubida,
  type HacerPut,
  type MemoriaDeSubida,
  type SubidaAbierta,
  type SubidaGuardada,
} from './subidaDeVideoS3.ts';

const MiB = 1024 * 1024;
const AHORA = Date.parse('2026-11-19T12:00:00Z');
const enMin = (m: number) => new Date(AHORA + m * 60_000).toISOString();
const sinEsperas = async () => {};

type Trozo = { inicio: number; fin: number };
const archivo = (bytes: number) => ({ bytes, trozo: (inicio: number, fin: number): Trozo => ({ inicio, fin }) });

/** Una API de mentira que apunta todo. */
function apiDePrueba(abierta: Partial<SubidaAbierta> = {}, estado?: Partial<EstadoDeSubida>) {
  const llamadas = {
    abrir: [] as unknown[],
    pedirPartes: [] as number[][],
    consultar: [] as string[],
    completar: [] as { id: string; partes: { numero: number; etag: string }[] }[],
  };
  let lote = 0;
  const api: ApiDeSubidas = {
    async abrir(cuerpo) {
      llamadas.abrir.push(cuerpo);
      return {
        id_de_subida: 'sub-1',
        modo: 'partes',
        url: null,
        cabeceras: {},
        upload_id: 'up-1',
        partes_totales: 3,
        tamano_parte: 10 * MiB,
        expira: enMin(60),
        ...abierta,
      };
    },
    async pedirPartes(_id, numeros) {
      llamadas.pedirPartes.push(numeros);
      lote++;
      return {
        partes: numeros.map((numero) => ({ numero, url: `https://s3/parte-${numero}?lote=${lote}`, bytes: 0 })),
        expira: enMin(15),
      };
    },
    async consultar(id) {
      llamadas.consultar.push(id);
      return {
        id_de_subida: id,
        estado: 'abierta',
        modo: 'partes',
        partes_totales: 3,
        tamano_parte: 10 * MiB,
        partes_hechas: [],
        expira: enMin(60),
        ...estado,
      };
    },
    async completar(id, partes) {
      llamadas.completar.push({ id, partes });
      return { id_de_subida: id, estado: 'subida' };
    },
  };
  return { api, llamadas };
}

/** Un PUT de mentira: apunta cada pedido y puede fallar a demanda. */
function putDePrueba(fallar: (url: string, intentoDeEstaUrl: number) => boolean = () => false) {
  const pedidos: { url: string; cuerpo: Trozo; cabeceras: Record<string, string> }[] = [];
  const porUrl = new Map<string, number>();
  let enVuelo = 0;
  let maximo = 0;
  const hacerPut: HacerPut = async (url, cuerpo, cabeceras, alAvanzar) => {
    enVuelo++;
    maximo = Math.max(maximo, enVuelo);
    try {
      await new Promise((r) => setTimeout(r, 2));
      const vez = (porUrl.get(url) ?? 0) + 1;
      porUrl.set(url, vez);
      pedidos.push({ url, cuerpo: cuerpo as Trozo, cabeceras });
      if (fallar(url, vez)) throw new Error('network error');
      const t = cuerpo as Trozo;
      alAvanzar(t.fin - t.inicio);
      const numero = /parte-(\d+)/.exec(url)?.[1] ?? 'simple';
      return { etag: `"etag-${numero}"` };
    } finally {
      enVuelo--;
    }
  };
  return { hacerPut, pedidos, maximoEnVuelo: () => maximo };
}

function memoriaDePrueba(inicial: SubidaGuardada | null = null) {
  let guardada = inicial;
  const historial: (SubidaGuardada | null)[] = [];
  const memoria: MemoriaDeSubida = {
    leer: async () => guardada,
    guardar: async (s) => {
      guardada = s;
      historial.push(s);
    },
    borrar: async () => {
      guardada = null;
      historial.push(null);
    },
  };
  return { memoria, actual: () => guardada, historial };
}

describe('subida simple (hasta 50 MB)', () => {
  it('un PUT con las cabeceras de la API y el archivo entero, y progreso hasta 1', async () => {
    const { api, llamadas } = apiDePrueba({
      modo: 'simple',
      url: 'https://s3/pendiente?firma',
      cabeceras: { 'Content-Type': 'video/mp4' },
      upload_id: null,
      partes_totales: null,
      tamano_parte: null,
    });
    const put = putDePrueba();
    const avance: number[] = [];
    const id = await subirArchivoAS3({
      api,
      hacerPut: put.hacerPut,
      archivo: archivo(8 * MiB),
      tipo: 'video',
      contentType: 'video/mp4',
      grupo: 'g-1',
      alAvanzar: (r) => avance.push(r),
      esperar: sinEsperas,
    });
    assert.equal(id, 'sub-1');
    assert.deepEqual(llamadas.abrir, [{ tipo: 'video', content_type: 'video/mp4', bytes: 8 * MiB, grupo: 'g-1' }]);
    assert.equal(put.pedidos.length, 1);
    assert.deepEqual(put.pedidos[0], {
      url: 'https://s3/pendiente?firma',
      cuerpo: { inicio: 0, fin: 8 * MiB },
      cabeceras: { 'Content-Type': 'video/mp4' },
    });
    assert.equal(avance.at(-1), 1);
    assert.deepEqual(llamadas.pedirPartes, []);
  });

  it('si cerrar el modo simple no aplica (4xx) da igual; un fallo de red si se cuenta', async () => {
    const simple = { modo: 'simple' as const, url: 'https://s3/x', partes_totales: null, tamano_parte: null };
    const conCuatro = apiDePrueba(simple);
    conCuatro.api.completar = async () => {
      throw Object.assign(new Error('no aplica'), { status: 422 });
    };
    assert.equal(
      await subirArchivoAS3({
        api: conCuatro.api,
        hacerPut: putDePrueba().hacerPut,
        archivo: archivo(10),
        tipo: 'video',
        contentType: 'video/mp4',
        grupo: 'g',
        esperar: sinEsperas,
      }),
      'sub-1',
    );
    const sinRed = apiDePrueba(simple);
    sinRed.api.completar = async () => {
      throw Object.assign(new Error('sin red'), { status: 0 });
    };
    await assert.rejects(
      subirArchivoAS3({
        api: sinRed.api,
        hacerPut: putDePrueba().hacerPut,
        archivo: archivo(10),
        tipo: 'video',
        contentType: 'video/mp4',
        grupo: 'g',
        esperar: sinEsperas,
      }),
      /sin red/,
    );
  });
});

describe('subida por partes', () => {
  it('reintenta la parte que falla, con URL nueva, sin repetir las demas', async () => {
    const { api, llamadas } = apiDePrueba();
    // La parte 2 falla la primera vez que se intenta.
    const put = putDePrueba((url, vez) => url.includes('parte-2') && url.includes('lote=1') && vez === 1);
    const id = await subirArchivoAS3({
      api,
      hacerPut: put.hacerPut,
      archivo: archivo(25 * MiB),
      tipo: 'video',
      contentType: 'video/mp4',
      grupo: 'g',
      esperar: sinEsperas,
    });
    assert.equal(id, 'sub-1');

    const vecesPorParte = (n: number) => put.pedidos.filter((p) => p.url.includes(`parte-${n}?`)).length;
    assert.equal(vecesPorParte(1), 1, 'la parte 1 no se repite');
    assert.equal(vecesPorParte(2), 2, 'la parte 2 se reintenta una vez');
    assert.equal(vecesPorParte(3), 1, 'la parte 3 no se repite');

    // El reintento pidio una URL nueva solo para la parte 2.
    assert.deepEqual(llamadas.pedirPartes.at(-1), [2]);

    // Cortes exactos: 10, 10 y 5 MiB.
    const cortes = put.pedidos.map((p) => p.cuerpo).sort((a, b) => a.inicio - b.inicio);
    assert.deepEqual(
      [...new Map(cortes.map((c) => [c.inicio, c])).values()],
      [
        { inicio: 0, fin: 10 * MiB },
        { inicio: 10 * MiB, fin: 20 * MiB },
        { inicio: 20 * MiB, fin: 25 * MiB },
      ],
    );

    // Se cierra con los ETag de cada parte, en orden.
    assert.deepEqual(llamadas.completar, [
      {
        id: 'sub-1',
        partes: [
          { numero: 1, etag: '"etag-1"' },
          { numero: 2, etag: '"etag-2"' },
          { numero: 3, etag: '"etag-3"' },
        ],
      },
    ]);
  });

  it('de a tres a la vez como mucho, y las URLs se piden por tandas pequenas', async () => {
    const { api, llamadas } = apiDePrueba({ partes_totales: 20 });
    const put = putDePrueba();
    await subirArchivoAS3({
      api,
      hacerPut: put.hacerPut,
      archivo: archivo(200 * MiB),
      tipo: 'video',
      contentType: 'video/mp4',
      grupo: 'g',
      esperar: sinEsperas,
    });
    assert.equal(put.pedidos.length, 20);
    assert.ok(put.maximoEnVuelo() <= 3, `hubo ${put.maximoEnVuelo()} a la vez`);
    assert.ok(put.maximoEnVuelo() >= 2, 'si van en paralelo');
    for (const tanda of llamadas.pedirPartes) assert.ok(tanda.length <= 6);
    // Ninguna parte pidio su URL dos veces sin haber fallado.
    const pedidas = llamadas.pedirPartes.flat();
    assert.equal(new Set(pedidas).size, pedidas.length);
  });

  it('con el reloj del telefono adelantado, no pide la URL de cada parte dos veces', async () => {
    const { api, llamadas } = apiDePrueba({ partes_totales: 9 });
    const put = putDePrueba();
    await subirArchivoAS3({
      api,
      hacerPut: put.hacerPut,
      archivo: archivo(90 * MiB),
      tipo: 'video',
      contentType: 'video/mp4',
      grupo: 'g',
      esperar: sinEsperas,
      // Dos horas por delante: para el telefono, `expira` ya paso.
      ahora: () => AHORA + 2 * 60 * 60_000,
    });
    const pedidas = llamadas.pedirPartes.flat();
    assert.equal(put.pedidos.length, 9);
    assert.equal(new Set(pedidas).size, pedidas.length);
  });

  it('el progreso solo sube, y termina en 1', async () => {
    const { api } = apiDePrueba();
    const avance: number[] = [];
    await subirArchivoAS3({
      api,
      hacerPut: putDePrueba().hacerPut,
      archivo: archivo(25 * MiB),
      tipo: 'video',
      contentType: 'video/mp4',
      grupo: 'g',
      alAvanzar: (r) => avance.push(r),
      esperar: sinEsperas,
    });
    assert.equal(avance.at(-1), 1);
    assert.ok(avance.every((r) => r >= 0 && r <= 1));
  });

  it('si una parte agota sus intentos falla, y lo hecho queda apuntado para reanudar', async () => {
    const { api, llamadas } = apiDePrueba({ partes_totales: 6 });
    const put = putDePrueba((url) => url.includes('parte-2?'));
    const { memoria, actual } = memoriaDePrueba();
    await assert.rejects(
      subirArchivoAS3({
        api,
        hacerPut: put.hacerPut,
        archivo: archivo(60 * MiB),
        tipo: 'video',
        contentType: 'video/mp4',
        grupo: 'g',
        memoria,
        esperar: sinEsperas,
        intentosPorParte: 3,
      }),
      /network/,
    );
    assert.equal(put.pedidos.filter((p) => p.url.includes('parte-2?')).length, 3);
    assert.deepEqual(llamadas.completar, []);
    const guardada = actual();
    assert.ok(guardada);
    assert.equal(guardada.idDeSubida, 'sub-1');
    assert.ok(guardada.hechas.length >= 1);
    assert.ok(guardada.hechas.every((p) => p.numero !== 2 && p.etag));
  });
});

describe('reanudar', () => {
  const guardada: SubidaGuardada = {
    idDeSubida: 'sub-viejo',
    bytes: 25 * MiB,
    contentType: 'video/mp4',
    partesTotales: 3,
    tamanoParte: 10 * MiB,
    uploadId: 'up-viejo',
    expira: enMin(60),
    hechas: [{ numero: 1, etag: '"etag-1"', bytes: 10 * MiB }],
  };

  it('sube solo lo que falta segun la API (que manda sobre lo apuntado) y no abre otra', async () => {
    const { api, llamadas } = apiDePrueba(
      {},
      {
        partes_hechas: [
          { numero: 1, etag: '"etag-1"', bytes: 10 * MiB },
          // Llego justo al cerrarse la app, sin apuntarse en el telefono.
          { numero: 2, etag: '"etag-2"', bytes: 10 * MiB },
        ],
      },
    );
    const put = putDePrueba();
    const { memoria, actual } = memoriaDePrueba(guardada);
    const id = await subirArchivoAS3({
      api,
      hacerPut: put.hacerPut,
      archivo: archivo(25 * MiB),
      tipo: 'video',
      contentType: 'video/mp4',
      grupo: 'g',
      memoria,
      esperar: sinEsperas,
      ahora: () => AHORA,
    });
    assert.equal(id, 'sub-viejo');
    assert.deepEqual(llamadas.consultar, ['sub-viejo']);
    assert.deepEqual(llamadas.abrir, []);
    assert.deepEqual(put.pedidos.map((p) => p.cuerpo), [{ inicio: 20 * MiB, fin: 25 * MiB }]);
    assert.deepEqual(llamadas.completar[0]?.partes.map((p) => p.numero), [1, 2, 3]);
    assert.equal(actual(), null, 'al terminar se olvida');
  });

  it('si la API ya la tiene completa, no sube nada', async () => {
    const { api, llamadas } = apiDePrueba({}, { estado: 'subida' });
    const put = putDePrueba();
    const id = await subirArchivoAS3({
      api,
      hacerPut: put.hacerPut,
      archivo: archivo(25 * MiB),
      tipo: 'video',
      contentType: 'video/mp4',
      grupo: 'g',
      memoria: memoriaDePrueba(guardada).memoria,
      esperar: sinEsperas,
      ahora: () => AHORA,
    });
    assert.equal(id, 'sub-viejo');
    assert.equal(put.pedidos.length, 0);
    assert.deepEqual(llamadas.completar, []);
  });

  it('vencida, cancelada, otro archivo o sin respuesta: se olvida y se empieza de cero', async () => {
    const casos: [string, Partial<EstadoDeSubida> | 'falla', SubidaGuardada][] = [
      ['vencida en la API', { estado: 'vencida' }, guardada],
      ['cancelada', { estado: 'cancelada' }, guardada],
      ['otro tamano', {}, { ...guardada, bytes: 1 }],
      ['caducada en el telefono', {}, { ...guardada, expira: enMin(-1) }],
      ['la API no contesta', 'falla', guardada],
    ];
    for (const [nombre, estado, previa] of casos) {
      const { api, llamadas } = apiDePrueba({}, estado === 'falla' ? {} : estado);
      if (estado === 'falla') {
        api.consultar = async () => {
          throw new Error('sin red');
        };
      }
      const put = putDePrueba();
      const id = await subirArchivoAS3({
        api,
        hacerPut: put.hacerPut,
        archivo: archivo(25 * MiB),
        tipo: 'video',
        contentType: 'video/mp4',
        grupo: 'g',
        memoria: memoriaDePrueba(previa).memoria,
        esperar: sinEsperas,
        ahora: () => AHORA,
      });
      assert.equal(id, 'sub-1', nombre);
      assert.equal(llamadas.abrir.length, 1, nombre);
      assert.equal(put.pedidos.length, 3, nombre);
    }
  });
});

describe('video y poster de una publicacion', () => {
  it('comparten grupo; el poster va primero y como imagen', async () => {
    const { api, llamadas } = apiDePrueba();
    api.abrir = async (cuerpo) => {
      llamadas.abrir.push(cuerpo);
      return cuerpo.tipo === 'poster'
        ? { id_de_subida: 'sub-poster', modo: 'simple', url: 'https://s3/poster', cabeceras: {}, upload_id: null, partes_totales: null, tamano_parte: null, expira: enMin(15) }
        : { id_de_subida: 'sub-video', modo: 'simple', url: 'https://s3/video', cabeceras: {}, upload_id: null, partes_totales: null, tamano_parte: null, expira: enMin(15) };
    };
    const r = await subirVideoDePublicacion({
      api,
      hacerPut: putDePrueba().hacerPut,
      grupo: 'g-pub',
      video: { ...archivo(5 * MiB), contentType: 'video/quicktime' },
      poster: archivo(80_000),
      esperar: sinEsperas,
    });
    assert.deepEqual(r, { idDeSubida: 'sub-video', idDeSubidaPoster: 'sub-poster' });
    assert.deepEqual(llamadas.abrir, [
      { tipo: 'poster', content_type: 'image/jpeg', bytes: 80_000, grupo: 'g-pub' },
      { tipo: 'video', content_type: 'video/quicktime', bytes: 5 * MiB, grupo: 'g-pub' },
    ]);
  });

  it('si el poster falla, la publicacion sigue sin el', async () => {
    const { api } = apiDePrueba({ modo: 'simple', url: 'https://s3/video', partes_totales: null, tamano_parte: null });
    const put = putDePrueba((url) => url.includes('poster'));
    const abrir = api.abrir;
    api.abrir = async (cuerpo) =>
      cuerpo.tipo === 'poster'
        ? { ...(await abrir(cuerpo)), id_de_subida: 'p', url: 'https://s3/poster' }
        : abrir(cuerpo);
    const original = console.warn;
    console.warn = () => {};
    try {
      const r = await subirVideoDePublicacion({
        api,
        hacerPut: put.hacerPut,
        grupo: 'g',
        video: { ...archivo(1000), contentType: 'video/mp4' },
        poster: archivo(10),
        esperar: sinEsperas,
      });
      assert.deepEqual(r, { idDeSubida: 'sub-1' });
    } finally {
      console.warn = original;
    }
  });

  it('el grupo es un UUID v4', () => {
    const g = nuevoGrupo();
    assert.match(g, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(nuevoGrupo(), g);
  });
});
