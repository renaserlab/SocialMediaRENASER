import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AUTORES_A_PRECARGAR,
  ESPERA_MAXIMA_MS,
  PRECARGAS_A_LA_VEZ,
  PRECARGAS_EN_ESPERA,
  barraAvanza,
  cargaDe,
  cargaInicial,
  crearColaDePrecarga,
  muestraCargando,
  precargasDeLaFila,
  precargasDelVisor,
  seHaVisto,
  trasAviso,
  type AvisoDeCarga,
  type GrupoACargar,
  type Precarga,
  type TramoACargar,
} from './cargaDeHistorias.ts';

/**
 * QUE LA FOTO DE UNA HISTORIA APAREZCA RAPIDO, SOBRE TODO LA PRIMERA VEZ.
 *
 * Auditoria del 28/10/2026, §11: nada se descargaba por adelantado aunque el
 * listado ya traia las URLs firmadas; la barra arrancaba al abrir el tramo y no
 * al llegar la foto; y el visor pintaba sin `cacheKey`, asi que una historia ya
 * vista se volvia a bajar en cuanto cambiaba la firma.
 */

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (codigo: string) =>
  codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function foto(id: string): TramoACargar {
  return { id, storagePath: `uid/${id}.jpg`, mediaUrl: `https://firmada/${id}?token=x`, mediaType: 'image' };
}
function video(id: string): TramoACargar {
  return { id, storagePath: `uid/${id}.mp4`, mediaUrl: `https://firmada/${id}?token=x`, mediaType: 'video' };
}
function autor(items: TramoACargar[], { isOwn = false, seen = false } = {}): GrupoACargar {
  return { isOwn, seen, items };
}
const claves = (lista: Precarga[]) => lista.map((p) => p.cacheKey);

// ---------------------------------------------------------------------------
// 1. Que se precarga al tener la lista
// ---------------------------------------------------------------------------

describe('precarga de la fila', () => {
  it('el primer tramo de cada uno de los primeros autores sin ver, en el orden de la fila', () => {
    const grupos = [
      autor([foto('a1'), foto('a2')]),
      autor([foto('b1')]),
      autor([foto('c1')]),
    ];
    assert.deepEqual(claves(precargasDeLaFila(grupos)), ['uid/a1.jpg', 'uid/b1.jpg', 'uid/c1.jpg']);
  });

  it('guarda bajo la RUTA y descarga la URL firmada', () => {
    assert.deepEqual(precargasDeLaFila([autor([foto('a1')])]), [
      { uri: 'https://firmada/a1?token=x', cacheKey: 'uid/a1.jpg' },
    ]);
  });

  it(`como mucho ${AUTORES_A_PRECARGAR} autores, por muchos que haya`, () => {
    const grupos = Array.from({ length: 12 }, (_, i) => autor([foto(`x${i}`)]));
    const lista = precargasDeLaFila(grupos);
    assert.equal(AUTORES_A_PRECARGAR, 4);
    assert.deepEqual(claves(lista), ['uid/x0.jpg', 'uid/x1.jpg', 'uid/x2.jpg', 'uid/x3.jpg']);
  });

  it('se salta tu propia historia y los autores ya vistos', () => {
    const grupos = [
      autor([foto('mia')], { isOwn: true }),
      autor([foto('a1')]),
      autor([foto('vista')], { seen: true }),
      autor([foto('b1')]),
    ];
    assert.deepEqual(claves(precargasDeLaFila(grupos)), ['uid/a1.jpg', 'uid/b1.jpg']);
  });

  it('no descarga videos: el autor que abre con video gasta su plaza sin bajar nada', () => {
    const grupos = [
      autor([video('v1'), foto('a2')]),
      autor([foto('b1')]),
      autor([foto('c1')]),
      autor([foto('d1')]),
      autor([foto('e1')]),
    ];
    // El quinto queda fuera: el tope es de autores, no de fotos.
    assert.deepEqual(claves(precargasDeLaFila(grupos)), ['uid/b1.jpg', 'uid/c1.jpg', 'uid/d1.jpg']);
  });

  it('sin URL firmada no hay nada que pedir', () => {
    const sinFirma: TramoACargar = { ...foto('a1'), mediaUrl: undefined };
    assert.deepEqual(precargasDeLaFila([autor([sinFirma]), autor([foto('b1')])]).length, 1);
  });

  it('la fila de la bandeja (grupos sin tramos) no precarga nada', () => {
    assert.deepEqual(precargasDeLaFila([autor([]), autor([])]), []);
  });
});

// ---------------------------------------------------------------------------
// 2. Que se precarga dentro del visor
// ---------------------------------------------------------------------------

describe('precarga del visor', () => {
  const grupos = [
    autor([foto('a1'), foto('a2'), foto('a3')]),
    autor([foto('b1'), foto('b2')]),
    autor([video('c1')]),
  ];

  it('el siguiente tramo del mismo autor y despues el primero del siguiente autor', () => {
    assert.deepEqual(claves(precargasDelVisor(grupos, 0, 0)), ['uid/a2.jpg', 'uid/b1.jpg']);
  });

  it('en el ultimo tramo de un autor, solo el primero del siguiente', () => {
    assert.deepEqual(claves(precargasDelVisor(grupos, 0, 2)), ['uid/b1.jpg']);
  });

  it('si lo siguiente es video no se descarga', () => {
    assert.deepEqual(claves(precargasDelVisor(grupos, 1, 0)), ['uid/b2.jpg']);
    assert.deepEqual(claves(precargasDelVisor(grupos, 1, 1)), []);
  });

  it('al final de todo no queda nada que adelantar', () => {
    assert.deepEqual(precargasDelVisor(grupos, 2, 0), []);
    assert.deepEqual(precargasDelVisor([], 0, 0), []);
  });
});

// ---------------------------------------------------------------------------
// 3. La cola: cuanto a la vez, en que orden y con que tope
// ---------------------------------------------------------------------------

/** Una descarga falsa que se resuelve o falla a mano. */
function descargasManuales() {
  const pedidas: string[] = [];
  const pendientes = new Map<string, { bien: () => void; mal: () => void }>();
  const calentar = (p: Precarga) =>
    new Promise<void>((resolver, rechazar) => {
      pedidas.push(p.cacheKey);
      pendientes.set(p.cacheKey, { bien: resolver, mal: () => rechazar(new Error('sin red')) });
    });
  return { calentar, pedidas, pendientes };
}
const turno = () => new Promise((r) => setImmediate(r));
const p = (clave: string): Precarga => ({ uri: `https://firmada/${clave}`, cacheKey: clave });

describe('cola de precarga', () => {
  it('de una en una y en el orden de la fila: la primera burbuja se lleva toda la linea', async () => {
    assert.equal(PRECARGAS_A_LA_VEZ, 1);
    const d = descargasManuales();
    const cola = crearColaDePrecarga(d.calentar);
    cola.pedir([p('a'), p('b'), p('c')]);
    assert.deepEqual(d.pedidas, ['a']);
    assert.deepEqual(cola.estado().enEspera, ['b', 'c']);

    d.pendientes.get('a')!.bien();
    await turno();
    assert.deepEqual(d.pedidas, ['a', 'b']);
  });

  it('con mas hueco, respeta el limite que se le de', async () => {
    const d = descargasManuales();
    const cola = crearColaDePrecarga(d.calentar, { aLaVez: 2 });
    cola.pedir([p('a'), p('b'), p('c'), p('d')]);
    assert.deepEqual(d.pedidas, ['a', 'b']);
    d.pendientes.get('b')!.bien();
    await turno();
    assert.deepEqual(d.pedidas, ['a', 'b', 'c']);
  });

  it('en pausa no empieza nada nuevo, lo que ya baja sigue, y al soltar continua', async () => {
    const d = descargasManuales();
    const cola = crearColaDePrecarga(d.calentar);
    cola.pedir([p('a'), p('b')]);
    const soltar = cola.pausar();
    d.pendientes.get('a')!.bien();
    await turno();
    assert.deepEqual(d.pedidas, ['a'], 'b no arranca mientras el visor espera su foto');
    cola.pedir([p('c')], { delante: true });
    assert.deepEqual(d.pedidas, ['a']);
    assert.equal(cola.estado().enPausa, true);

    soltar();
    soltar(); // soltar dos veces no deja la cuenta en negativo
    await turno();
    assert.deepEqual(d.pedidas, ['a', 'c']);
    assert.equal(cola.estado().enPausa, false);
  });

  it('al soltar la pausa, lo que pide el visor en esa misma pasada sale primero', async () => {
    // El visor suelta la pausa (limpieza de un efecto) y pide lo siguiente
    // (puesta en marcha de otro) sin que medie ninguna espera.
    const d = descargasManuales();
    const cola = crearColaDePrecarga(d.calentar);
    const soltar = cola.pausar();
    cola.pedir([p('fila-b'), p('fila-c')]);
    soltar();
    cola.pedir([p('siguiente-tramo')], { delante: true });
    await turno();
    assert.deepEqual(d.pedidas, ['siguiente-tramo']);
  });

  it('las pausas se pueden solapar: sigue en pausa hasta soltar la ultima', async () => {
    const d = descargasManuales();
    const cola = crearColaDePrecarga(d.calentar);
    const una = cola.pausar();
    const otra = cola.pausar();
    cola.pedir([p('a')]);
    una();
    await turno();
    assert.deepEqual(d.pedidas, []);
    otra();
    await turno();
    assert.deepEqual(d.pedidas, ['a']);
  });

  it('se puede esperar a una precarga en curso, acabe bien o mal', async () => {
    const d = descargasManuales();
    const cola = crearColaDePrecarga(d.calentar, { aLaVez: 2 });
    cola.pedir([p('a'), p('b')]);
    const a = cola.enCurso('a');
    const b = cola.enCurso('b');
    assert.ok(a && b);
    assert.equal(cola.enCurso('c'), undefined);

    d.pendientes.get('a')!.bien();
    d.pendientes.get('b')!.mal();
    await Promise.all([a, b]); // ninguna falla: quien espera solo quiere saber que acabo
    await turno();
    assert.equal(cola.enCurso('a'), undefined);
    assert.equal(cola.enCurso('b'), undefined);
  });

  it('lo ya pedido no se vuelve a pedir: ni en curso, ni esperando, ni hecho', async () => {
    const d = descargasManuales();
    const cola = crearColaDePrecarga(d.calentar, { aLaVez: 1 });
    cola.pedir([p('a'), p('b')]);
    cola.pedir([p('a'), p('b'), p('a')]);
    assert.deepEqual(d.pedidas, ['a']);
    assert.deepEqual(cola.estado().enEspera, ['b']);

    d.pendientes.get('a')!.bien();
    await turno();
    d.pendientes.get('b')!.bien();
    await turno();
    cola.pedir([p('a'), p('b')]);
    assert.deepEqual(d.pedidas, ['a', 'b'], 'volver a la fila no vuelve a descargar');
    assert.deepEqual(cola.estado().hechas.sort(), ['a', 'b']);
  });

  it('un fallo no condena: se puede volver a pedir', async () => {
    const d = descargasManuales();
    const cola = crearColaDePrecarga(d.calentar);
    cola.pedir([p('a')]);
    d.pendientes.get('a')!.mal();
    await turno();
    assert.deepEqual(cola.estado(), { enEspera: [], enCurso: [], hechas: [], enPausa: false });
    cola.pedir([p('a')]);
    assert.deepEqual(d.pedidas, ['a', 'a']);
  });

  it('una descarga que revienta al lanzarse tampoco atasca la cola', async () => {
    let llamadas = 0;
    const cola = crearColaDePrecarga(
      () => {
        llamadas += 1;
        throw new Error('modulo nativo ausente');
      },
      { aLaVez: 1 },
    );
    cola.pedir([p('a'), p('b')]);
    await turno();
    await turno();
    assert.equal(llamadas, 2);
    assert.deepEqual(cola.estado().enCurso, []);
  });

  it('lo del visor pasa delante de lo que se adelanto desde la fila', () => {
    const d = descargasManuales();
    const cola = crearColaDePrecarga(d.calentar, { aLaVez: 1 });
    cola.pedir([p('f1'), p('f2'), p('f3')]);
    cola.pedir([p('v1'), p('f3')], { delante: true });
    // f3 ya esperaba: no se duplica, se adelanta.
    assert.deepEqual(cola.estado().enEspera, ['v1', 'f3', 'f2']);
  });

  it(`como mucho ${PRECARGAS_EN_ESPERA} esperando: lo que no cabe se descarta por el final`, () => {
    const d = descargasManuales();
    const cola = crearColaDePrecarga(d.calentar, { aLaVez: 1 });
    cola.pedir([p('a'), p('b'), p('c'), p('d'), p('e'), p('f'), p('g')]);
    assert.deepEqual(d.pedidas, ['a']);
    assert.deepEqual(cola.estado().enEspera, ['b', 'c', 'd', 'e']);

    // Lo urgente entra y empuja fuera lo mas viejo de la cola.
    cola.pedir([p('v1'), p('v2')], { delante: true });
    assert.deepEqual(cola.estado().enEspera, ['v1', 'v2', 'b', 'c']);

    // Lo descartado no queda marcado: si el visor lo vuelve a necesitar, entra.
    cola.pedir([p('e')], { delante: true });
    assert.deepEqual(cola.estado().enEspera, ['e', 'v1', 'v2', 'b']);
  });

  it('en el peor caso, un uso normal no pasa de lo que se ve venir', () => {
    // La fila (4) y diez pasos en el visor: nunca mas de lo fijado bajando ni esperando.
    const d = descargasManuales();
    const cola = crearColaDePrecarga(d.calentar);
    cola.pedir(Array.from({ length: 4 }, (_, i) => p(`fila${i}`)));
    for (let i = 0; i < 10; i += 1) {
      cola.pedir([p(`sig${i}`), p(`aut${i}`)], { delante: true });
      const { enCurso, enEspera } = cola.estado();
      assert.ok(enCurso.length <= PRECARGAS_A_LA_VEZ);
      assert.ok(enEspera.length <= PRECARGAS_EN_ESPERA);
    }
    assert.equal(d.pedidas.length, PRECARGAS_A_LA_VEZ, 'sin respuestas, no se lanza nada mas');
  });
});

// ---------------------------------------------------------------------------
// 4. Cuando cuenta un tramo
// ---------------------------------------------------------------------------

describe('el tramo espera a su foto', () => {
  const tramo = { id: 't1', mediaUrl: 'https://firmada/t1' };

  it('mientras la foto viene, la barra no avanza y se ve el indicador', () => {
    const c = cargaInicial(tramo);
    assert.equal(c.fase, 'cargando');
    assert.equal(barraAvanza(c, false), false);
    assert.equal(muestraCargando(c), true);
    assert.equal(seHaVisto(c), false);
  });

  it('al cargar, cuenta y se da por vista', () => {
    const c = trasAviso(cargaInicial(tramo), 't1', 'cargada');
    assert.equal(barraAvanza(c, false), true);
    assert.equal(muestraCargando(c), false);
    assert.equal(seHaVisto(c), true);
  });

  it('mantener pulsado la para aunque la foto ya este', () => {
    const c = trasAviso(cargaInicial(tramo), 't1', 'cargada');
    assert.equal(barraAvanza(c, true), false);
  });

  it('si falla, arranca igual pero NO cuenta como vista', () => {
    const c = trasAviso(cargaInicial(tramo), 't1', 'fallida');
    assert.equal(barraAvanza(c, false), true);
    assert.equal(seHaVisto(c), false);
    assert.equal(muestraCargando(c), false);
  });

  it('agotada la espera, arranca con el indicador puesto y sin darla por vista', () => {
    const c = trasAviso(cargaInicial(tramo), 't1', 'espera-agotada');
    assert.equal(barraAvanza(c, false), true);
    assert.equal(muestraCargando(c), true);
    assert.equal(seHaVisto(c), false);
  });

  it('si la foto llega despues del tope, se ve y entonces si cuenta como vista', () => {
    let c = trasAviso(cargaInicial(tramo), 't1', 'espera-agotada');
    c = trasAviso(c, 't1', 'cargada');
    assert.equal(seHaVisto(c), true);
    assert.equal(barraAvanza(c, false), true);
  });

  it('un aviso tardio de OTRO tramo no da por cargado este', () => {
    const c = trasAviso(cargaInicial(tramo), 'anterior', 'cargada');
    assert.equal(c.fase, 'cargando');
    assert.equal(barraAvanza(c, false), false);
  });

  it('sin URL firmada no se espera: cuenta ya, y la imagen de relleno no la marca como vista', () => {
    let c = cargaInicial({ id: 't2' });
    assert.equal(barraAvanza(c, false), true);
    c = trasAviso(c, 't2', 'cargada');
    assert.equal(seHaVisto(c), false);
  });

  it('lo guardado de otro tramo no vale para el nuevo', () => {
    const delAnterior = trasAviso(cargaInicial(tramo), 't1', 'cargada');
    const c = cargaDe(delAnterior, { id: 't2', mediaUrl: 'https://firmada/t2' });
    assert.equal(c.tramoId, 't2');
    assert.equal(barraAvanza(c, false), false, 'la barra del nuevo no hereda la carga del anterior');
    assert.equal(cargaDe(delAnterior, tramo), delAnterior);
  });

  it('el tope cubre una carga lenta normal y no llega a parecer colgado', () => {
    const peorPrimerByte = 1800; // auditoria §11
    const bajarFotoA1Mbps = 2500; // ~300 KB
    assert.ok(ESPERA_MAXIMA_MS >= 1.5 * (peorPrimerByte + bajarFotoA1Mbps));
    assert.ok(ESPERA_MAXIMA_MS < 10_000);
  });
});

/**
 * Cuando empieza a correr la barra, en ms desde que se abre el tramo, dada una
 * linea de tiempo de avisos. Reproduce lo que hace el visor: el tope dispara
 * `espera-agotada` a los `ESPERA_MAXIMA_MS` si la foto sigue en camino.
 */
function arranqueDeLaBarra(avisos: { en: number; aviso: AvisoDeCarga }[]): number {
  const linea = [...avisos, { en: ESPERA_MAXIMA_MS, aviso: 'espera-agotada' as const }].sort(
    (a, b) => a.en - b.en,
  );
  let c = cargaInicial({ id: 't', mediaUrl: 'https://firmada/t' });
  for (const { en, aviso } of linea) {
    c = trasAviso(c, 't', aviso);
    if (barraAvanza(c, false)) return en;
  }
  return Number.POSITIVE_INFINITY;
}

describe('lo que se gana: tiempo del tramo con la foto delante', () => {
  const TRAMO_MS = 5000;

  it('foto que tarda 2 s: antes se perdian 2 s del tramo; ahora se ve el tramo entero', () => {
    const llegaLaFoto = 2000;
    const antes = TRAMO_MS - llegaLaFoto; // la barra arrancaba al abrir
    const arranque = arranqueDeLaBarra([{ en: llegaLaFoto, aviso: 'cargada' }]);
    const ahora = TRAMO_MS - Math.max(0, llegaLaFoto - arranque);
    assert.equal(antes, 3000);
    assert.equal(arranque, 2000);
    assert.equal(ahora, TRAMO_MS);
  });

  it('una foto que nunca llega no cuelga el visor: arranca al tope', () => {
    assert.equal(arranqueDeLaBarra([]), ESPERA_MAXIMA_MS);
  });

  it('un error arranca en el momento, sin esperar al tope', () => {
    assert.equal(arranqueDeLaBarra([{ en: 300, aviso: 'fallida' }]), 300);
  });
});

// ---------------------------------------------------------------------------
// 5. El cableado: que la precarga y el visor usen la MISMA clave
// ---------------------------------------------------------------------------

describe('precarga y visor comparten cache', () => {
  const VISOR = sinComentarios(fuente('screens/StoriesScreen.tsx'));
  const SERVICIO = sinComentarios(fuente('services/precargaDeHistorias.ts'));
  const FILA = sinComentarios(fuente('components/StoriesRow.tsx'));

  it('el visor pinta la foto con cacheKey = ruta de Storage', () => {
    assert.match(VISOR, /\{ uri: item\.mediaUrl, cacheKey: item\.storagePath \}/);
  });

  it('en el movil se precarga con loadAsync y la misma clave; prefetch solo en la web', () => {
    assert.match(SERVICIO, /ExpoImage\.loadAsync\(\{ uri, cacheKey \}/);
    const ramaWeb = SERVICIO.indexOf("Platform.OS === 'web'");
    const prefetch = SERVICIO.indexOf('ExpoImage.prefetch(');
    assert.ok(ramaWeb >= 0 && prefetch > ramaWeb, 'prefetch guarda por URL: solo vale en la web');
    assert.equal(SERVICIO.split('ExpoImage.prefetch(').length - 1, 1);
    assert.match(SERVICIO, /\.release\(\)/, 'la imagen decodificada se suelta al llegar');
  });

  it('el visor marca como visto al cargar, no al abrir', () => {
    assert.match(VISOR, /if \(tramoId && visto\) markStoryViewed\(tramoId\);/);
    assert.equal(VISOR.split('markStoryViewed(').length - 1, 1);
  });

  it('el visor no compite con la precarga: la pausa mientras espera y se engancha a la suya', () => {
    assert.match(VISOR, /if \(!esperandoFoto\) return;\s*\n\s*return pausarPrecargas\(\);/);
    assert.match(VISOR, /precargaEnCurso\(claveDeFoto\)/);
    assert.match(VISOR, /fotoEnCamino\s*\n?\s*\? null/);
  });

  it('la fila precarga solo con los grupos del almacen', () => {
    assert.match(
      FILA,
      /if \(alimentadoDesdeFuera\) return;\s*\n\s*precargarHistorias\(precargasDeLaFila\(gruposDelAlmacen\)\);/,
    );
  });
});
