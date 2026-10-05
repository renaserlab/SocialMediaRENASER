import assert from 'node:assert/strict';
import { after, afterEach, describe, it } from 'node:test';

import { crearReloj } from './dobles/enMemoria.mts';
import {
  crearServidorDePrueba,
  pausa,
  type ClienteReal,
  type ServidorDePrueba,
} from './dobles/realtimeDeVerdad.mts';
import {
  ESPERA_DE_REMONTAJE_MS,
  EVENTO_DE_REACCION,
  crearCanalDeReacciones,
  crearTransporteDeRealtime,
  topicoDeReacciones,
  type ConteoDeReacciones,
  type EstadoDeTransporte,
  type TransporteDeBroadcast,
} from './reaccionesEnVivo.ts';
import {
  ESPERA_DE_REENGANCHE_MS,
  ESPERA_MAXIMA_DE_REENGANCHE_MS,
  mantenerSuscripcion,
} from './suscripcionViva.ts';
import { topicoDeAvisosDelChat } from './ventanaDeChat.ts';

/**
 * LO MISMO QUE `reaccionesEnVivo.test.mts`, PERO CON EL CLIENTE DE VERDAD.
 *
 * Aqui no hay un cliente de Realtime de mentira: es el `RealtimeClient` de
 * `node_modules`, hablando con un servidor en memoria
 * (`dobles/realtimeDeVerdad.mts`). Sale de la revision independiente del
 * 04/10/2026, que encontro que una de las «costumbres del cliente» que el
 * codigo daba por comprobadas no lo estaba.
 *
 * La primera bateria no prueba el producto: deja escrito QUE HACE el cliente,
 * que es de donde salen las decisiones del transporte. Si una version nueva
 * cambia alguna, falla aqui y se sabe antes de fiarse.
 */

const TOPICO = topicoDeReacciones('e1');
const OPCIONES = { config: { broadcast: { self: false } } };

/** El reloj de verdad, cien veces mas rapido: dos segundos son veinte ms. */
function programarRapido(fn: () => void, ms: number): () => void {
  const id = setTimeout(fn, ms / 100);
  return () => clearTimeout(id);
}

let abiertos: ClienteReal[] = [];
let avisosDeConsola: string[] = [];
const avisarOriginal = console.warn;

function entorno(): { servidor: ServidorDePrueba; cliente: () => ClienteReal } {
  const servidor = crearServidorDePrueba();
  avisosDeConsola = [];
  console.warn = (...argumentos: unknown[]) => {
    avisosDeConsola.push(String(argumentos[0]));
  };
  return {
    servidor,
    cliente() {
      const cliente = servidor.cliente();
      abiertos.push(cliente);
      return cliente;
    },
  };
}

afterEach(() => {
  console.warn = avisarOriginal;
  for (const cliente of abiertos) cliente.disconnect();
  abiertos = [];
});

after(() => {
  /*
    El cliente de verdad deja temporizadores suyos vivos despues de
    `disconnect()` (los reintentos de union de cada canal, hasta diez
    segundos). No son del producto ni de estas pruebas, pero Node espera a que
    venzan antes de dar el fichero por terminado. Se sale en cuanto todo ha
    informado. `process.exit()` sin argumento conserva el codigo de salida: si
    alguna prueba fallo, sigue saliendo en rojo.
  */
  setTimeout(() => process.exit(), 250).unref();
});

function oyente() {
  const recibidas: unknown[] = [];
  const estados: EstadoDeTransporte[] = [];
  return {
    recibidas,
    estados,
    alRecibir: (carga: unknown) => void recibidas.push(carga),
    alCambiarEstado: (estado: EstadoDeTransporte) => void estados.push(estado),
  };
}

/* ========================================================================= */

describe('QUE HACE EL CLIENTE DE REALTIME (el de verdad, 2.110)', () => {
  it('devuelve EL MISMO canal para el mismo topico', () => {
    const { cliente } = entorno();
    const a = cliente();
    const uno = a.channel(TOPICO, OPCIONES);
    const dos = a.channel(TOPICO, OPCIONES);
    assert.equal(uno, dos, 'ya no comparte canal: el recuento de usuarios sobraria');
    assert.equal(a.getChannels().length, 1);
  });

  it('`removeChannel` quita el canal EN LA MISMA LLAMADA: abrir justo despues da uno nuevo que funciona', async () => {
    const { cliente } = entorno();
    const a = cliente();
    const b = cliente();
    const abrir = (c: ClienteReal, alLlegar: () => void, estados: string[] = []) =>
      c
        .channel(TOPICO, OPCIONES)
        .on('broadcast', { event: EVENTO_DE_REACCION }, alLlegar)
        .subscribe((estado: string) => estados.push(estado));

    const emisor = abrir(b, () => {});
    const primero = abrir(a, () => {});
    await pausa();

    void a.removeChannel(primero);
    assert.equal(a.getChannels().length, 0, 'el cierre ya no es inmediato');
    let recibidas = 0;
    const estados: string[] = [];
    const segundo = abrir(a, () => (recibidas += 1), estados);
    assert.notEqual(segundo, primero, 'devuelve el canal que se estaba cerrando');
    await pausa();

    await emisor.send({ type: 'broadcast', event: EVENTO_DE_REACCION, payload: { tipo: 'corazon' } });
    await pausa();
    assert.deepEqual(estados, ['SUBSCRIBED']);
    assert.equal(recibidas, 1);
  });

  it('`send()` sin suscripcion NO falla: cae a una peticion HTTP y lo avisa', async () => {
    const { servidor, cliente } = entorno();
    const canal = cliente().channel(TOPICO, OPCIONES);
    await canal.send({ type: 'broadcast', event: EVENTO_DE_REACCION, payload: { tipo: 'corazon' } });
    assert.equal(servidor.peticionesHttp(), 1, 'ya no cae a HTTP: la guarda del transporte sobraria');
    assert.ok(avisosDeConsola.some((aviso) => aviso.includes('REST')));
  });

  it('si el canal lo cierra el servidor, lo quita y NO vuelve a unirse', async () => {
    const { servidor, cliente } = entorno();
    const a = cliente();
    const estados: string[] = [];
    a.channel(TOPICO, OPCIONES)
      .on('broadcast', { event: EVENTO_DE_REACCION }, () => {})
      .subscribe((estado: string) => estados.push(estado));
    await pausa();
    assert.equal(servidor.unidos(TOPICO), 1);

    servidor.cerrarCanal(TOPICO);
    await pausa(300);
    assert.deepEqual(estados, ['SUBSCRIBED', 'CLOSED']);
    assert.equal(a.getChannels().length, 0);
    assert.equal(servidor.unidos(TOPICO), 0, 'ha vuelto a unirse solo: el remontaje sobraria');
  });

  it('de una caida de red SI se recupera solo', async () => {
    const { servidor, cliente } = entorno();
    const a = cliente();
    const estados: string[] = [];
    a.channel(TOPICO, OPCIONES)
      .on('broadcast', { event: EVENTO_DE_REACCION }, () => {})
      .subscribe((estado: string) => estados.push(estado));
    await pausa();

    servidor.tirarLaRed(a);
    await pausa(400);
    assert.equal(estados.filter((estado) => estado === 'SUBSCRIBED').length, 2);
    assert.equal(servidor.unidos(TOPICO), 1);
  });
});

describe('el transporte de Broadcast sobre el cliente de verdad', () => {
  const transportes = new WeakMap<object, TransporteDeBroadcast>();
  /** UNO por cliente, como en el producto. */
  function transporteDe(cliente: ClienteReal): TransporteDeBroadcast {
    let transporte = transportes.get(cliente);
    if (!transporte) {
      transporte = crearTransporteDeRealtime(cliente, { programar: programarRapido });
      transportes.set(cliente, transporte);
    }
    return transporte;
  }

  it('se une al topico canonico y con `self: false`', async () => {
    const { servidor, cliente } = entorno();
    transporteDe(cliente()).abrir(TOPICO, oyente());
    await pausa();
    const union = servidor.tramas.find((trama) => trama.event === 'phx_join');
    assert.equal(union?.topic, 'realtime:live-reacciones:e1');
    assert.equal(union?.payload?.config?.broadcast?.self, false, 'la propia reaccion volveria');
  });

  it('A envia y B recibe; a A no le vuelve lo suyo; nada va por HTTP', async () => {
    const { servidor, cliente } = entorno();
    const deA = oyente();
    const deB = oyente();
    const a = transporteDe(cliente()).abrir(TOPICO, deA);
    transporteDe(cliente()).abrir(TOPICO, deB);
    await pausa();

    assert.equal(a.enviar({ v: 1, conteos: { corazon: 2 } }), true);
    await pausa();
    assert.deepEqual(deB.recibidas, [{ v: 1, conteos: { corazon: 2 } }]);
    assert.deepEqual(deA.recibidas, []);
    assert.equal(servidor.peticionesHttp(), 0);
    assert.deepEqual(avisosDeConsola, []);
  });

  it('otra emision es otro topico: no se mezclan', async () => {
    const { cliente } = entorno();
    const enUna = oyente();
    const enOtra = oyente();
    const a = transporteDe(cliente()).abrir(topicoDeReacciones('e1'), enUna);
    transporteDe(cliente()).abrir(topicoDeReacciones('e2'), enOtra);
    await pausa();
    a.enviar({ v: 1, conteos: { corazon: 1 } });
    await pausa();
    assert.deepEqual(enOtra.recibidas, []);
  });

  it('antes de `SUBSCRIBED` no entrega nada a la red, ni por HTTP', async () => {
    const { servidor, cliente } = entorno();
    servidor.retraso(60);
    const deA = oyente();
    const a = transporteDe(cliente()).abrir(TOPICO, deA);
    assert.equal(a.enviar({ v: 1, conteos: { corazon: 1 } }), false);
    await pausa(20);
    assert.equal(a.enviar({ v: 1, conteos: { corazon: 1 } }), false);
    assert.equal(servidor.peticionesHttp(), 0, '`send()` sin suscripcion: una peticion HTTP por toque');

    await pausa(200);
    assert.deepEqual(deA.estados, ['suscrito']);
    assert.equal(a.enviar({ v: 1, conteos: { corazon: 1 } }), true);
    assert.equal(servidor.peticionesHttp(), 0);
  });

  it('el canal de reacciones: lo pulsado antes de suscribirse sale junto, una vez', async () => {
    const { servidor, cliente } = entorno();
    servidor.retraso(60);
    const reloj = crearReloj();
    const recibidasPorB: Partial<ConteoDeReacciones>[] = [];
    const montar = (c: ClienteReal, recibidas?: Partial<ConteoDeReacciones>[]) => {
      const canal = crearCanalDeReacciones({
        emisionId: 'e1',
        transporte: transporteDe(c),
        resumir: async () => {},
        esCierreDeReacciones: () => false,
        intervaloDeResumenMs: 5_000,
        programar: reloj.programar,
        ahora: reloj.ahora,
      });
      if (recibidas) canal.alRecibir((conteos) => recibidas.push(conteos));
      return canal;
    };
    montar(cliente(), recibidasPorB);
    const a = montar(cliente());
    a.enviar('corazon');
    a.enviar('corazon');
    a.enviar('fuego');
    await pausa(250);
    assert.deepEqual(recibidasPorB, [{ corazon: 2, fuego: 1 }]);
    assert.equal(servidor.peticionesHttp(), 0);
    assert.equal(a.diagnostico().pendientes, 0);
  });

  it('REMONTAR en el mismo instante (lo que hace React) deja UN canal que recibe una vez', async () => {
    const { servidor, cliente } = entorno();
    const clienteA = cliente();
    const deB = oyente();
    const b = transporteDe(cliente()).abrir(TOPICO, deB);
    const primera = oyente();
    const uno = transporteDe(clienteA).abrir(TOPICO, primera);
    await pausa();

    uno.cerrar();
    const segunda = oyente();
    const dos = transporteDe(clienteA).abrir(TOPICO, segunda);
    await pausa(60);
    assert.equal(clienteA.getChannels().length, 1);
    assert.equal(servidor.unidos(TOPICO), 2);

    b.enviar({ v: 1, conteos: { fuego: 1 } });
    await pausa();
    assert.deepEqual(segunda.recibidas, [{ v: 1, conteos: { fuego: 1 } }]);
    assert.deepEqual(primera.recibidas, []);
    assert.equal(dos.enviar({ v: 1, conteos: { risa: 1 } }), true);
    await pausa();
    assert.deepEqual(deB.recibidas, [{ v: 1, conteos: { risa: 1 } }]);
    assert.equal(servidor.peticionesHttp(), 0);
  });

  it('cerrar antes de que el servidor confirme no deja nada colgado', async () => {
    const { servidor, cliente } = entorno();
    servidor.retraso(80);
    const clienteA = cliente();
    const uno = transporteDe(clienteA).abrir(TOPICO, oyente());
    await pausa(10);
    uno.cerrar();
    const segunda = oyente();
    const dos = transporteDe(clienteA).abrir(TOPICO, segunda);
    await pausa(400);
    assert.deepEqual(segunda.estados, ['suscrito']);
    assert.equal(clienteA.getChannels().length, 1);
    assert.equal(servidor.unidos(TOPICO), 1);
    assert.equal(dos.enviar({ v: 1, conteos: { corazon: 1 } }), true);
  });

  it('cincuenta montajes y desmontajes: cero canales en el cliente y en el servidor', async () => {
    const { servidor, cliente } = entorno();
    const clienteA = cliente();
    for (let i = 0; i < 50; i += 1) {
      const conexion = transporteDe(clienteA).abrir(TOPICO, oyente());
      if (i % 2 === 0) await pausa(4);
      conexion.cerrar();
      conexion.cerrar();
    }
    await pausa(80);
    assert.equal(clienteA.getChannels().length, 0, 'quedan canales huerfanos en el cliente');
    assert.equal(servidor.unidos(TOPICO), 0, 'quedan suscripciones huerfanas en el servidor');
    assert.equal(servidor.peticionesHttp(), 0);
  });

  it('dos pantallas de la misma emision: un canal, y cerrar una no deja muda a la otra', async () => {
    const { servidor, cliente } = entorno();
    const clienteA = cliente();
    const debajo = oyente();
    const encima = oyente();
    const deDebajo = transporteDe(clienteA).abrir(TOPICO, debajo);
    const deEncima = transporteDe(clienteA).abrir(TOPICO, encima);
    const deB = oyente();
    const b = transporteDe(cliente()).abrir(TOPICO, deB);
    await pausa();
    assert.equal(clienteA.getChannels().length, 1);
    assert.equal(servidor.tramas.filter((t) => t.event === 'phx_join' && t.de === 'ws1').length, 1);
    assert.deepEqual(encima.estados, ['suscrito']);
    assert.deepEqual(debajo.estados, ['suscrito']);

    // La de encima envia: la de debajo lo ve una vez, y B tambien.
    deEncima.enviar({ v: 1, conteos: { corazon: 1 } });
    await pausa();
    assert.deepEqual(debajo.recibidas, [{ v: 1, conteos: { corazon: 1 } }]);
    assert.deepEqual(encima.recibidas, []);
    assert.equal(deB.recibidas.length, 1);

    deEncima.cerrar();
    await pausa();
    assert.equal(clienteA.getChannels().length, 1, 'cerrar una se llevo el canal de la otra');
    b.enviar({ v: 1, conteos: { fuego: 1 } });
    await pausa();
    assert.equal(debajo.recibidas.length, 2);
    assert.equal(deDebajo.enviar({ v: 1, conteos: { risa: 1 } }), true);

    deDebajo.cerrar();
    await pausa();
    assert.equal(clienteA.getChannels().length, 0);
  });

  it('SI EL SERVIDOR CIERRA EL CANAL, se vuelve a montar y sigue funcionando', async () => {
    const { servidor, cliente } = entorno();
    const clienteA = cliente();
    const deA = oyente();
    const deB = oyente();
    const a = transporteDe(clienteA).abrir(TOPICO, deA);
    const b = transporteDe(cliente()).abrir(TOPICO, deB);
    await pausa();
    assert.equal(servidor.unidos(TOPICO), 2);

    servidor.cerrarCanal(TOPICO);
    await pausa(10);
    assert.equal(a.enviar({ v: 1, conteos: { corazon: 1 } }), false, 'envia por un canal cerrado');

    // La espera de remontaje, acelerada cien veces.
    await pausa(ESPERA_DE_REMONTAJE_MS / 100 + 150);
    assert.deepEqual(deA.estados, ['suscrito', 'cerrado', 'suscrito']);
    assert.equal(servidor.unidos(TOPICO), 2, 'la pantalla se quedo sin reacciones hasta salir y volver');
    assert.equal(clienteA.getChannels().length, 1);

    assert.equal(a.enviar({ v: 1, conteos: { corazon: 1 } }), true);
    b.enviar({ v: 1, conteos: { fuego: 1 } });
    await pausa();
    assert.deepEqual(deB.recibidas, [{ v: 1, conteos: { corazon: 1 } }]);
    assert.deepEqual(deA.recibidas, [{ v: 1, conteos: { fuego: 1 } }]);
    assert.equal(servidor.peticionesHttp(), 0);
  });

  it('si quien cierra es la aplicacion, NO se remonta', async () => {
    const { servidor, cliente } = entorno();
    const clienteA = cliente();
    const conexion = transporteDe(clienteA).abrir(TOPICO, oyente());
    await pausa();
    conexion.cerrar();
    await pausa(ESPERA_DE_REMONTAJE_MS / 100 + 150);
    assert.equal(clienteA.getChannels().length, 0);
    assert.equal(servidor.unidos(TOPICO), 0);
    assert.equal(servidor.tramas.filter((t) => t.event === 'phx_join').length, 1);
  });

  it('si el servidor cierra y la pantalla se va antes del remontaje, no se monta nada', async () => {
    const { servidor, cliente } = entorno();
    const clienteA = cliente();
    const conexion = transporteDe(clienteA).abrir(TOPICO, oyente());
    await pausa();
    servidor.cerrarCanal(TOPICO);
    await pausa(10);
    conexion.cerrar();
    await pausa(ESPERA_DE_REMONTAJE_MS / 100 + 150);
    assert.equal(clienteA.getChannels().length, 0);
    assert.equal(servidor.unidos(TOPICO), 0);
  });

  it('una caida de red: `caido`, no se envia mientras tanto, y vuelve a `suscrito`', async () => {
    const { servidor, cliente } = entorno();
    const clienteA = cliente();
    const deA = oyente();
    const a = transporteDe(clienteA).abrir(TOPICO, deA);
    await pausa();
    servidor.tirarLaRed(clienteA);
    assert.equal(a.enviar({ v: 1, conteos: { corazon: 1 } }), false);
    await pausa(400);
    assert.equal(deA.estados.at(-1), 'suscrito');
    assert.ok(deA.estados.includes('caido'));
    assert.equal(a.enviar({ v: 1, conteos: { corazon: 1 } }), true);
    assert.equal(servidor.peticionesHttp(), 0);
  });

  it('el aviso de moderacion viaja por su propio topico, tambien canonico', async () => {
    const { cliente } = entorno();
    const deA = oyente();
    const deB = oyente();
    const reacciones = oyente();
    const a = transporteDe(cliente()).abrir(topicoDeAvisosDelChat('e1'), deA);
    const clienteB = cliente();
    transporteDe(clienteB).abrir(topicoDeAvisosDelChat('e1'), deB);
    transporteDe(clienteB).abrir(TOPICO, reacciones);
    await pausa();
    assert.equal(topicoDeAvisosDelChat('e1'), 'live-chat-avisos:e1');
    a.enviar({ v: 1 });
    await pausa();
    assert.equal(deB.recibidas.length, 1);
    assert.deepEqual(reacciones.recibidas, [], 'el aviso del chat ha llegado como reaccion');
  });
});

describe('una suscripcion que no se queda muerta (el canal del chat)', () => {
  function chatDe(cliente: ClienteReal, estados: string[], nombres: string[]) {
    let serie = 0;
    return mantenerSuscripcion({
      programar: programarRapido,
      alCambiar: (estado) => estados.push(estado),
      abrir: (alCambiar) => {
        serie += 1;
        const nombre = `live-chat:e1:${serie}`;
        nombres.push(nombre);
        const canal = cliente
          .channel(nombre)
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'live_messages', filter: 'session_id=eq.e1' },
            () => {},
          )
          .subscribe(alCambiar);
        return () => void cliente.removeChannel(canal);
      },
    });
  }

  it('si el servidor cierra el canal del chat, se abre otro y vuelve a `suscrito`', async () => {
    const { servidor, cliente } = entorno();
    const a = cliente();
    const estados: string[] = [];
    const nombres: string[] = [];
    chatDe(a, estados, nombres);
    await pausa();
    assert.deepEqual(estados, ['suscrito']);

    servidor.cerrarCanal('live-chat:e1:1');
    await pausa(ESPERA_DE_REENGANCHE_MS / 100 + 150);
    assert.deepEqual(estados, ['suscrito', 'caido', 'suscrito'], 'se quedo en «Reconectando…» para siempre');
    assert.deepEqual(nombres, ['live-chat:e1:1', 'live-chat:e1:2']);
    assert.equal(a.getChannels().length, 1);
    assert.equal(servidor.unidos('live-chat:e1:2'), 1);
  });

  it('cerrarla desde la aplicacion no la reabre, y es seguro dos veces', async () => {
    const { servidor, cliente } = entorno();
    const a = cliente();
    const estados: string[] = [];
    const nombres: string[] = [];
    const dejar = chatDe(a, estados, nombres);
    await pausa();
    dejar();
    dejar();
    await pausa(ESPERA_DE_REENGANCHE_MS / 100 + 150);
    assert.deepEqual(nombres, ['live-chat:e1:1']);
    assert.equal(a.getChannels().length, 0);
    assert.equal(servidor.unidos('live-chat:e1:1'), 0);
    assert.deepEqual(estados, ['suscrito']);
  });

  it('un servidor que cierra una y otra vez no se aporrea: la espera se dobla hasta un tope', () => {
    const reloj = crearReloj();
    const aperturas: number[] = [];
    let alCambiar: ((estado: string) => void) | null = null;
    const dejar = mantenerSuscripcion({
      programar: reloj.programar,
      abrir: (avisar) => {
        aperturas.push(reloj.ahora());
        alCambiar = avisar;
        return () => {};
      },
    });
    const cerrar = () => (alCambiar as unknown as (estado: string) => void)('CLOSED');
    for (let i = 0; i < 8; i += 1) {
      cerrar();
      reloj.avanzar(ESPERA_MAXIMA_DE_REENGANCHE_MS);
    }
    const esperas = aperturas.slice(1).map((t, i) => t - (aperturas[i] as number));
    // 2 s, 4 s, 8 s, 16 s, y de ahi el tope. Cada apertura ocurre dentro de
    // una ventana de 30 s, asi que las esperas se leen entre ventanas.
    assert.equal(aperturas.length, 9);
    assert.ok(esperas.every((espera) => espera >= ESPERA_DE_REENGANCHE_MS));
    assert.ok(esperas.every((espera) => espera <= 2 * ESPERA_MAXIMA_DE_REENGANCHE_MS));
    dejar();
    assert.equal(reloj.vivos(), 0);
  });

  it('un error o un tiempo agotado NO reabren: de esos se recupera el cliente', () => {
    const reloj = crearReloj();
    let aperturas = 0;
    let alCambiar: ((estado: string) => void) | null = null;
    const estados: string[] = [];
    mantenerSuscripcion({
      programar: reloj.programar,
      alCambiar: (estado) => estados.push(estado),
      abrir: (avisar) => {
        aperturas += 1;
        alCambiar = avisar;
        return () => {};
      },
    });
    const avisar = alCambiar as unknown as (estado: string) => void;
    avisar('CHANNEL_ERROR');
    avisar('TIMED_OUT');
    reloj.avanzar(ESPERA_MAXIMA_DE_REENGANCHE_MS * 2);
    assert.equal(aperturas, 1);
    assert.deepEqual(estados, ['caido', 'caido']);
    assert.equal(reloj.vivos(), 0);
  });
});
