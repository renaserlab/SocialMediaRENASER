import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { unaALaVez } from './unaALaVez.ts';

/**
 * EL CHAT SE PONE AL DÍA POR TODOS LOS CAMINOS, Y NUNCA DOS VECES A LA VEZ.
 *
 * Reportado el 05/10/2026 con la compilación 46: «a pesar de que me aparezca en
 * la bandeja que tengo mensajes, estos no llegaban hasta que volvía a entrar al
 * chat», y «los mensajes no llegan instantáneamente». La pantalla cargaba una
 * vez y después dependía por entero de su canal de tiempo real, que no repone
 * lo que se pierde mientras está caído.
 */

/** Una tarea que se puede soltar a mano, para ver qué pasa mientras corre. */
function tareaManual() {
  let vueltas = 0;
  const sueltas: (() => void)[] = [];
  const tarea = () =>
    new Promise<void>((resolver) => {
      vueltas += 1;
      sueltas.push(resolver);
    });
  return {
    tarea,
    vueltas: () => vueltas,
    soltar: () => sueltas.shift()?.(),
  };
}

const unTick = () => new Promise<void>((resolver) => setImmediate(resolver));

describe('una tarea que nunca corre dos veces a la vez', () => {
  it('si no está corriendo, corre', async () => {
    const manual = tareaManual();
    const pedir = unaALaVez(manual.tarea);
    const fin = pedir();
    assert.equal(manual.vueltas(), 1);
    manual.soltar();
    await fin;
    assert.equal(manual.vueltas(), 1, 'sin nadie pidiéndola, no repite');
  });

  it('pedida mientras corre, no corre en paralelo: corre UNA vez más al terminar', async () => {
    const manual = tareaManual();
    const pedir = unaALaVez(manual.tarea);
    const fin = pedir();
    // El canal se reengancha, llega un push y la pantalla recupera el foco.
    void pedir();
    void pedir();
    void pedir();
    assert.equal(manual.vueltas(), 1, 'se lanzaron varias a la vez');
    manual.soltar();
    await unTick();
    assert.equal(manual.vueltas(), 2, 'lo pedido en medio se quedó sin atender');
    manual.soltar();
    await fin;
    assert.equal(manual.vueltas(), 2, 'tres peticiones en medio son UNA vuelta más, no tres');
  });

  it('terminada, la siguiente petición vuelve a correr', async () => {
    const manual = tareaManual();
    const pedir = unaALaVez(manual.tarea);
    const primera = pedir();
    manual.soltar();
    await primera;
    const segunda = pedir();
    assert.equal(manual.vueltas(), 2);
    manual.soltar();
    await segunda;
  });

  it('una vuelta que falla no rompe a quien la pidió ni deja la tarea atascada', async () => {
    let vueltas = 0;
    const pedir = unaALaVez(async () => {
      vueltas += 1;
      if (vueltas === 1) throw new Error('sin red');
    });
    await assert.doesNotReject(pedir());
    await pedir();
    assert.equal(vueltas, 2, 'tras un fallo no volvió a intentarlo');
  });
});

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (codigo: string) =>
  codigo.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const CHAT = sinComentarios(fuente('screens/ChatScreen.tsx'));
const CANAL = sinComentarios(fuente('services/realtime.ts'));
const PUSH = sinComentarios(fuente('hooks/useAvisosDelPush.native.ts'));
const CONTADORES = sinComentarios(fuente('services/contadores.ts'));

describe('el chat abierto pregunta lo que le falta', () => {
  const alDia = CHAT.slice(CHAT.indexOf('const ponerAlDia = unaALaVez('), CHAT.indexOf('let canalEnganchado'));

  it('pide lo posterior a lo último que tiene, después de la primera página', () => {
    assert.ok(alDia.length > 0, 'no hay puesta al día');
    assert.match(alDia, /await cargaInicial;\s*if \(!montado \|\| !cargada\) return;/);
    assert.match(alDia, /const desde = instanteMasReciente\(mensajesRef\.current\);/);
    assert.match(alDia, /MessageRepository\.listMessagesSince\(conversationId, desde, currentUserId\)/);
    // Solo cuenta lo que no estaba: el corte puede devolver el último conocido.
    assert.match(alDia, /if \(!recibidos\.some\(\(m\) => !conocidos\.has\(m\.id\)\)\) return;/);
    assert.match(alDia, /aplicar\(fusionar\(mensajesRef\.current, recibidos\)\);/);
  });

  it('el canal dice cuándo se engancha, y cada enganche es una puesta al día', () => {
    assert.match(CANAL, /alCambiar\?: \(enganchado: boolean\) => void,/);
    assert.match(CANAL, /\.subscribe\(\(estado\) => alCambiar\?\.\(estado === 'SUBSCRIBED'\)\);/);
    assert.match(
      CHAT,
      /\(enganchado\) => \{\s*canalEnganchado = enganchado;\s*if \(enganchado\) void ponerAlDia\(\);\s*\}/,
    );
  });

  it('volver del segundo plano y recuperar el foco también', () => {
    assert.match(
      CHAT,
      /AppState\.addEventListener\('change', \(estado\) => \{\s*if \(estado !== 'active'\) return;\s*void ponerAlDia\(\);/,
    );
    // La primera vez carga el montaje; las siguientes, la puesta al día.
    assert.match(CHAT, /if \(vistaAntes\.current\) ponerseAlDia\.current\?\.\(\);\s*vistaAntes\.current = true;/);
  });

  it('el push de un mensaje se lo dice al chat de esa conversación', () => {
    // Antes de decidir si se anuncia: con el chat delante no se anuncia, y es
    // justo cuando hace falta que el chat se entere.
    const avisa = PUSH.indexOf('if (conversacion) hayMensajeNuevoEn(conversacion);');
    const calla = PUSH.indexOf('if (seEstaViendoLaConversacion(conversacion)) {');
    assert.ok(avisa !== -1 && calla !== -1 && avisa < calla);
    assert.match(CONTADORES, /export function hayMensajeNuevoEn\(conversacionId: string\): void \{\s*for \(const oyente of oyentesDeMensaje\) oyente\(conversacionId\);/);
    assert.match(
      CHAT,
      /alSaberDeUnMensaje\(\(conversacion\) => \{\s*if \(conversacion === conversationId\) void ponerAlDia\(\);\s*\}\);/,
    );
  });

  it('con el canal caído se pregunta cada pocos segundos; con el canal sano, no', () => {
    assert.match(
      CHAT,
      /setInterval\(\(\) => \{\s*if \(!canalEnganchado && aLaVista\.current && AppState\.currentState === 'active'\) \{\s*void ponerAlDia\(\);\s*\}\s*\}, SONDEO_SIN_TIEMPO_REAL_MS\);/,
    );
    const periodo = Number(/const SONDEO_SIN_TIEMPO_REAL_MS = ([\d_]+);/.exec(CHAT)?.[1]?.replace(/_/g, ''));
    assert.ok(periodo >= 2_000 && periodo <= 10_000, `un periodo raro: ${periodo}`);
  });

  it('todo se desmonta con la pantalla', () => {
    const salida = CHAT.slice(CHAT.indexOf('ponerseAlDia.current = null;'));
    assert.match(
      salida.slice(0, 200),
      /clearInterval\(sondeo\);\s*alVolver\.remove\(\);\s*dejarDeOir\(\);\s*unsubscribe\(\);/,
    );
  });

  it('solo se marca como leído lo que de verdad se está mirando', () => {
    /*
      Un chat enterrado bajo otra pantalla, o con la aplicación en segundo
      plano, marcaba como leído lo que nadie había visto: el mensaje llegaba
      por su canal y la conversación se quedaba sin globo.
    */
    assert.match(
      CHAT,
      /const leerSiSeVe = \(\) => \{\s*if \(aLaVista\.current && AppState\.currentState === 'active'\) \{\s*marcarConversacionLeida\(conversationId\);/,
    );
    // Lo único que marca sin mirar es entrar: el montaje.
    assert.equal(CHAT.match(/marcarConversacionLeida\(conversationId\);/g)?.length, 2);
    assert.match(CHAT, /aLaVista\.current = true;\s*marcarConversacionALaVista\(conversacionALaVista\);/);
    assert.match(CHAT, /return \(\) => \{\s*aLaVista\.current = false;/);
  });
});
