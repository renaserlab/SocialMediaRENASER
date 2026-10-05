import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { contadorOptimista, crearConsolidador } from './intencionFinal.ts';

/**
 * GUARDAR, REACCIONAR Y REPUBLICAR, PULSADOS A TODA PRISA.
 *
 * Lo reportado: «cuando se presiona el botón de guardar, se demora un poco en
 * procesar y luego recién puedo volver a desmarcar… no funciona si se presiona
 * el botón constantemente». Aquí no se lee el código: se ejecuta contra un
 * servidor de mentira que contesta cuando la prueba quiere, y en el orden que
 * la prueba quiere.
 */

type Llamada = {
  clave: string;
  valor: boolean;
  resolver: (respuesta: number) => void;
  rechazar: (motivo: unknown) => void;
};

/** Un servidor que apunta lo que le llega y contesta a mano. */
function servidorDeMentira() {
  const llamadas: Llamada[] = [];
  const enviar = (clave: string, valor: boolean) =>
    new Promise<number>((resolver, rechazar) => {
      llamadas.push({ clave, valor, resolver, rechazar });
    });
  return { llamadas, enviar };
}

/** Deja correr las promesas pendientes. */
const respirar = () => new Promise<void>((seguir) => setImmediate(seguir));

const partida = (confirmado: boolean, contador = 0) => () => ({
  confirmado,
  contexto: { contador },
});

test('un toque: una petición, y se asienta con lo pedido', async () => {
  const { llamadas, enviar } = servidorDeMentira();
  const cola = crearConsolidador<number, { contador: number }>(enviar);

  const peticion = cola.pedir('p1', true, partida(false, 4));
  assert.equal(peticion.absorbida, false);
  assert.equal(llamadas.length, 1, 'sale en el mismo toque, sin esperar a nada');
  assert.deepEqual([llamadas[0]?.clave, llamadas[0]?.valor], ['p1', true]);
  assert.equal(cola.pendiente('p1'), true);

  llamadas[0]?.resolver(5);
  const final = await peticion.asentada;
  assert.deepEqual(final, { valor: true, ok: true, respuesta: 5, contexto: { contador: 4 } });
  assert.equal(cola.pendiente('p1'), false);
});

test('diez toques seguidos: nunca dos peticiones a la vez y como mucho dos en total', async () => {
  const { llamadas, enviar } = servidorDeMentira();
  const cola = crearConsolidador<number, { contador: number }>(enviar);

  // guardar, quitar, guardar, quitar… diez veces. La última es «quitar».
  let deseado = false;
  const peticiones = [];
  for (let i = 0; i < 10; i += 1) {
    deseado = !deseado;
    peticiones.push(cola.pedir('p1', deseado, partida(false)));
    assert.equal(llamadas.length, 1, 'mientras la primera vuela no sale ninguna más');
  }
  assert.equal(deseado, false);
  assert.equal(peticiones.filter((p) => !p.absorbida).length, 1, 'solo una empezó la ráfaga');

  // Vuelve la primera («guardar»). Lo que se quiere ahora es «no guardada»,
  // y el servidor tiene «guardada»: sale UNA más, con la intención final.
  llamadas[0]?.resolver(1);
  await respirar();
  assert.equal(llamadas.length, 2);
  assert.equal(llamadas[1]?.valor, false);

  llamadas[1]?.resolver(0);
  const final = await peticiones[0]!.asentada;
  assert.equal(final.valor, false);
  assert.equal(final.ok, true);
  assert.equal(llamadas.length, 2, 'diez toques, dos peticiones');
});

test('si la intención final ya es lo que el servidor tiene, no se manda nada más', async () => {
  const { llamadas, enviar } = servidorDeMentira();
  const cola = crearConsolidador<number, { contador: number }>(enviar);

  const primera = cola.pedir('p1', true, partida(false)); // guardar
  cola.pedir('p1', false, partida(false)); // se arrepiente
  cola.pedir('p1', true, partida(false)); // y vuelve a querer
  llamadas[0]?.resolver(1);

  const final = await primera.asentada;
  assert.equal(final.valor, true);
  assert.equal(llamadas.length, 1, 'tres toques, una petición');
});

test('las respuestas no pueden cruzarse: la segunda no sale hasta que vuelve la primera', async () => {
  /*
    El fallo de antes: «guardar» y «quitar» volaban a la vez, «quitar» llegaba
    primero (no había nada que quitar), después llegaba «guardar», y el
    servidor se quedaba con la publicación guardada mientras la pantalla decía
    que no. Con una sola en vuelo, el servidor recibe las dos EN ORDEN.
  */
  const recibidas: boolean[] = [];
  let estadoDelServidor = false;
  const pendientes: Array<() => void> = [];
  const enviar = (_clave: string, valor: boolean) =>
    new Promise<void>((resolver) => {
      pendientes.push(() => {
        recibidas.push(valor);
        estadoDelServidor = valor;
        resolver();
      });
    });
  const cola = crearConsolidador<void, undefined>(enviar);
  const sinContexto = () => ({ confirmado: false, contexto: undefined });

  const primera = cola.pedir('p1', true, sinContexto);
  cola.pedir('p1', false, sinContexto);
  assert.equal(pendientes.length, 1, 'la segunda todavía no ha salido');

  pendientes[0]?.();
  await respirar();
  assert.equal(pendientes.length, 2);
  pendientes[1]?.();

  const final = await primera.asentada;
  assert.deepEqual(recibidas, [true, false], 'en el orden en que se pulsó');
  assert.equal(estadoDelServidor, false);
  assert.equal(final.valor, estadoDelServidor, 'pantalla y servidor dicen lo mismo');
});

test('si falla, se vuelve a lo que el servidor confirmó y se dice', async () => {
  const { llamadas, enviar } = servidorDeMentira();
  const cola = crearConsolidador<number, { contador: number }>(enviar);

  const peticion = cola.pedir('p1', true, partida(false, 7));
  llamadas[0]?.rechazar(new Error('sin red'));

  const final = await peticion.asentada;
  assert.equal(final.valor, false, 'lo último confirmado');
  assert.equal(final.ok, false, 'no quedó como la persona quería');
  assert.equal(final.contexto.contador, 7, 'con el contador de partida para deshacer');
  assert.equal(cola.pendiente('p1'), false, 'y el botón no se queda colgado');
});

test('si falla la segunda, queda lo que confirmó la primera', async () => {
  const { llamadas, enviar } = servidorDeMentira();
  const cola = crearConsolidador<number, { contador: number }>(enviar);

  const peticion = cola.pedir('p1', true, partida(false));
  cola.pedir('p1', false, partida(false));
  llamadas[0]?.resolver(1);
  await respirar();
  llamadas[1]?.rechazar(new Error('sin red'));

  const final = await peticion.asentada;
  assert.equal(final.valor, true, 'guardada: es lo que el servidor llegó a confirmar');
  assert.equal(final.ok, false, 'la persona quería quitarla y no se pudo');
  assert.equal(final.respuesta, 1);
});

test('fallar hacia donde la persona ya había vuelto no es un error', async () => {
  // Guardar, y antes de que conteste, arrepentirse. La petición de guardar
  // falla: no está guardada, que es justo lo que se quería al final.
  const { llamadas, enviar } = servidorDeMentira();
  const cola = crearConsolidador<number, { contador: number }>(enviar);

  const peticion = cola.pedir('p1', true, partida(false));
  cola.pedir('p1', false, partida(false));
  llamadas[0]?.rechazar(new Error('sin red'));

  const final = await peticion.asentada;
  assert.equal(final.valor, false);
  assert.equal(final.ok, true, 'nada que anunciar');
  assert.equal(llamadas.length, 1);
});

test('después de asentarse, el siguiente toque empieza de cero', async () => {
  const { llamadas, enviar } = servidorDeMentira();
  const cola = crearConsolidador<number, { contador: number }>(enviar);

  const primera = cola.pedir('p1', true, partida(false));
  llamadas[0]?.resolver(1);
  await primera.asentada;

  const segunda = cola.pedir('p1', false, partida(true, 1));
  assert.equal(segunda.absorbida, false, 'ráfaga nueva');
  assert.equal(llamadas.length, 2);
  llamadas[1]?.resolver(0);
  assert.equal((await segunda.asentada).valor, false);
});

test('cada publicación tiene su ráfaga: una no frena a otra', () => {
  const { llamadas, enviar } = servidorDeMentira();
  const cola = crearConsolidador<number, { contador: number }>(enviar);

  cola.pedir('p1', true, partida(false));
  cola.pedir('p2', true, partida(false));
  assert.equal(llamadas.length, 2);
  assert.deepEqual(llamadas.map((l) => l.clave), ['p1', 'p2']);
});

test('el contador sale del de partida, no de sumar sobre lo pintado', () => {
  // Diez toques no pueden dejar un «+10».
  assert.equal(contadorOptimista(4, false, true), 5);
  assert.equal(contadorOptimista(4, false, false), 4);
  assert.equal(contadorOptimista(4, true, false), 3);
  assert.equal(contadorOptimista(4, true, true), 4);
  assert.equal(contadorOptimista(0, true, false), 0, 'nunca baja de cero');
});

// ---------------------------------------------------------------------------
// El store lo usa para guardar y para reaccionar
// ---------------------------------------------------------------------------

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const STORE = readFileSync(join(SRC, 'store', 'useAppStore.ts'), 'utf8').replace(/\r\n/g, '\n');

test('guardar y reaccionar pasan por el consolidador, no llaman al servidor a pelo', () => {
  assert.match(STORE, /const guardados = crearConsolidador</);
  assert.match(STORE, /const meGustas = crearConsolidador</);
  assert.match(STORE, /guardados\.pedir\(postId, guardada, /);
  assert.match(STORE, /meGustas\.pedir\(postId, gusta, /);
  // Las únicas llamadas al repositorio son las de los dos consolidadores.
  assert.equal(STORE.match(/PostRepository\.(save|unsave)\(/g)?.length, 2);
  assert.equal(STORE.match(/PostRepository\.(like|unlike)\(/g)?.length, 2);
});

test('un toque absorbido no anuncia nada: lo hace quien empezó la ráfaga', () => {
  assert.match(
    STORE,
    /if \(peticion\.absorbida\) return \{ guardada: final\.valor, ok: true, absorbida: true \};/,
  );
});

test('pero también espera a que la ráfaga se asiente', () => {
  /*
    La misma publicación puede estar pintada en dos sitios —el muro y su
    detalle—. Si el toque absorbido volviera en el acto, la segunda tarjeta no
    sabría cuándo ha terminado y su marcador se quedaría «pendiente» para
    siempre.
  */
  const guardar = STORE.slice(STORE.indexOf('toggleSavePost: async'), STORE.indexOf('addComment: async'));
  const espera = guardar.indexOf('const final = await peticion.asentada;');
  const absorbida = guardar.indexOf('if (peticion.absorbida) return');
  assert.ok(espera !== -1 && absorbida !== -1 && espera < absorbida);
});

test('todos los que esperan una ráfaga reciben el mismo final', async () => {
  const { llamadas, enviar } = servidorDeMentira();
  const cola = crearConsolidador<number, { contador: number }>(enviar);

  const primera = cola.pedir('p1', true, partida(false));
  const segunda = cola.pedir('p1', false, partida(false));
  assert.equal(segunda.absorbida, true);
  llamadas[0]?.resolver(1);
  await respirar();
  llamadas[1]?.resolver(0);

  const [uno, dos] = await Promise.all([primera.asentada, segunda.asentada]);
  assert.deepEqual(uno, dos);
  assert.equal(uno.valor, false);
});

// ---------------------------------------------------------------------------
// La tarjeta: lo pendiente se apaga, y el estado no viaja con la celda
// ---------------------------------------------------------------------------

const TARJETA = readFileSync(join(SRC, 'components', 'PostCard.tsx'), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

test('«pendiente» se apaga también en el toque absorbido', () => {
  const guardar = TARJETA.slice(TARJETA.indexOf('const alternarGuardado'), TARJETA.indexOf('const alternarRepost'));
  const apaga = guardar.indexOf('setGuardando(false);');
  const sale = guardar.indexOf('if (absorbida) return;');
  assert.ok(apaga !== -1 && sale !== -1 && apaga < sale, 'se apaga ANTES de salir por absorbida');

  const repost = TARJETA.slice(TARJETA.indexOf('const alternarRepost'));
  const apagaRepost = repost.indexOf('if (sigueAqui) setRepublicando(false);');
  const saleRepost = repost.indexOf('if (peticion.absorbida) return;');
  assert.ok(apagaRepost !== -1 && saleRepost !== -1 && apagaRepost < saleRepost);
});

test('al reciclarse la celda, el estado local vuelve a lo que dice la publicación nueva', () => {
  // El muro reutiliza tarjetas: lo que estaba en `useState` no puede viajar a
  // otra publicación.
  assert.match(
    TARJETA,
    /if \(pintada !== post\.id\) \{\s*setPintada\(post\.id\);\s*setRepublicado\(post\.repostedByMe \?\? false\);\s*setRepostsCount\(post\.repostsCount \?\? 0\);\s*setRepublicando\(false\);\s*setGuardando\(false\);\s*\}/,
  );
});

test('lo que vuelve de una espera no se aplica a otra publicación', () => {
  assert.match(TARJETA, /publicacionPintada\.current = post\.id;/);
  assert.match(TARJETA, /if \(publicacionPintada\.current === publicacion\) setGuardando\(false\);/);
  assert.match(TARJETA, /const sigueAqui = publicacionPintada\.current === publicacion;/);
  assert.match(TARJETA, /if \(sigueAqui\) \{\s*setRepublicado\(final\.valor\);/);
});

test('el icono y el contador no animan cuando la celda cambia de publicación', () => {
  assert.equal(TARJETA.match(/<AccionDePublicacion\s+clave=\{post\.id\}/g)?.length, 5);
  /*
    La regla ya no vive escrita dentro de cada componente: es una función pura
    (`daElSalto`, `sentidoDelCambio`) que se prueba ejecutándola en
    `movimientoSoloMientrasDura.test.mts`. Aquí se fija que los dos la usan, y
    que al cambiar de elemento se corta lo que estuviera a medias.
  */
  const REGLA: Record<string, RegExp> = {
    IconoQueSeEnciende: /daElSalto\(antes, \{ activo, clave \}\)/,
    ContadorAnimado: /sentidoDelCambio\(antes, \{ valor, clave \}\)/,
  };
  for (const [componente, regla] of Object.entries(REGLA)) {
    const codigo = readFileSync(join(SRC, 'components', `${componente}.tsx`), 'utf8').replace(/\r\n/g, '\n');
    assert.match(codigo, regla, componente);
    assert.match(codigo, /if \(antes\.clave !== clave\) set\w+\(null\);/, componente);
  }
});
