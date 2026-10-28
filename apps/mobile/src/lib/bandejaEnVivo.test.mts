import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DISPERSION_DE_LA_RECARGA_MS,
  RECARGA_DE_SEGURIDAD_MS,
  anotarConTope,
  aplicarMensaje,
  esperaDeLaRecargaDeSeguridad,
  hayQueAsegurar,
  instanteExacto,
  leerMensajeEnVivo,
  puedeTraerUnAviso,
  queHacerTrasElMensaje,
  type FilaEnVivo,
  type MensajeEnVivo,
} from './bandejaEnVivo.ts';

/*
  La bandeja al día con el mensaje que trae el tiempo real, sin pedirla otra
  vez (auditoría del 28/10, §10). Lo innegociable: que ningún globo mienta.
  Aquí se fija la regla, caso por caso: el orden, lo no leído, lo propio
  frente a lo ajeno, la conversación abierta y que nada se cuente dos veces.
*/

type Fila = FilaEnVivo & { esGrupo?: boolean };

const fila = (
  id: string,
  ultimoMensajeEn: string | null,
  extra: Partial<Fila> = {},
): Fila => ({ id, subtitle: `antes en ${id}`, unread: 0, time: '00:00', ultimoMensajeEn, ...extra });

const mensaje = (
  conversacionId: string,
  creadoEn: string | null,
  extra: Partial<MensajeEnVivo> = {},
): MensajeEnVivo => ({
  id: `m-${conversacionId}-${creadoEn}`,
  conversacionId,
  remitenteId: 'ana',
  texto: 'hola',
  creadoEn,
  ...extra,
});

const hora = (iso: string | null) => `h(${iso})`;
const ajeno = { propio: false, abierta: false, hora };

const T0 = '2026-10-28T10:00:00.000000+00:00';
const T1 = '2026-10-28T10:01:00.000000+00:00';
const T2 = '2026-10-28T10:02:00.000000+00:00';

describe('un mensaje de otra persona, con la conversación cerrada', () => {
  it('sube su fila arriba, cambia el resumen y la hora, y suma uno', () => {
    const antes = [fila('a', T1), fila('b', T0, { unread: 2 }), fila('c', T0)];
    const { lista, efecto } = aplicarMensaje(antes, mensaje('b', T2, { texto: 'nos vemos' }), ajeno);
    assert.equal(efecto, 'aplicado');
    assert.deepEqual(lista.map((c) => c.id), ['b', 'a', 'c']);
    assert.equal(lista[0]?.unread, 3);
    assert.equal(lista[0]?.subtitle, 'nos vemos');
    assert.equal(lista[0]?.time, `h(${T2})`);
    assert.equal(lista[0]?.ultimoMensajeEn, T2);
    // Las demás filas no se tocan: son EL MISMO objeto y no se repintan.
    assert.equal(lista[1], antes[0]);
    assert.equal(lista[2], antes[2]);
    // Y la lista de antes sigue igual: nada se muta.
    assert.equal(antes[1]?.unread, 2);
  });

  it('la que ya estaba arriba se queda arriba', () => {
    const antes = [fila('a', T0), fila('b', T0)];
    const { lista } = aplicarMensaje(antes, mensaje('a', T1), ajeno);
    assert.deepEqual(lista.map((c) => c.id), ['a', 'b']);
    assert.equal(lista[0]?.unread, 1);
  });

  it('en un grupo con temas suma también al total del grupo', () => {
    const antes = [fila('g', T0, { esGrupo: true, unread: 1, totalSinLeer: 4 })];
    const { lista } = aplicarMensaje(antes, mensaje('g', T1), ajeno);
    assert.equal(lista[0]?.unread, 2);
    assert.equal(lista[0]?.totalSinLeer, 5);
  });

  it('el resumen es el texto tal cual, como lo pone el servidor', () => {
    const texto = '  línea uno\nlínea dos  ';
    const { lista } = aplicarMensaje([fila('a', T0)], mensaje('a', T1, { texto }), ajeno);
    assert.equal(lista[0]?.subtitle, texto);
  });
});

describe('lo que NO suma', () => {
  it('un mensaje propio (de este aparato o de otro) mueve la fila pero no suma', () => {
    const antes = [fila('a', T0), fila('b', T0, { unread: 1 })];
    const { lista, efecto } = aplicarMensaje(antes, mensaje('b', T1, { texto: 'yo' }), {
      propio: true,
      abierta: false,
      hora,
    });
    assert.equal(efecto, 'aplicado');
    assert.deepEqual(lista.map((c) => c.id), ['b', 'a']);
    assert.equal(lista[0]?.unread, 1);
    assert.equal(lista[0]?.subtitle, 'yo');
  });

  it('con la conversación abierta no suma: el chat la marca leída al llegar', () => {
    const antes = [fila('a', T0), fila('b', T0, { totalSinLeer: 0 })];
    const { lista } = aplicarMensaje(antes, mensaje('b', T1), { propio: false, abierta: true, hora });
    assert.equal(lista[0]?.id, 'b');
    assert.equal(lista[0]?.unread, 0);
    assert.equal(lista[0]?.totalSinLeer, 0);
  });
});

describe('nada se cuenta dos veces', () => {
  it('el mismo mensaje otra vez no suma: la fila ya lo cuenta', () => {
    const primera = aplicarMensaje([fila('a', T0)], mensaje('a', T1), ajeno);
    const segunda = aplicarMensaje(primera.lista, mensaje('a', T1), ajeno);
    assert.equal(segunda.efecto, 'ya-estaba');
    assert.equal(segunda.lista, primera.lista);
    assert.equal(segunda.lista[0]?.unread, 1);
  });

  it('un mensaje que la lectura del servidor ya traía no suma', () => {
    // El servidor contestó con el mensaje de T1 ya contado (unread 1).
    const delServidor = [fila('a', T1, { unread: 1 })];
    const { lista, efecto } = aplicarMensaje(delServidor, mensaje('a', T1), ajeno);
    assert.equal(efecto, 'ya-estaba');
    assert.equal(lista[0]?.unread, 1);
  });

  it('uno más viejo que el último que la fila conoce tampoco', () => {
    const { efecto } = aplicarMensaje([fila('a', T2, { unread: 1 })], mensaje('a', T1), ajeno);
    assert.equal(efecto, 'ya-estaba');
  });

  it('dos mensajes en el mismo milisegundo son dos: se compara en microsegundos', () => {
    const uno = '2026-10-28T10:00:00.123400+00:00';
    const otro = '2026-10-28T10:00:00.123401+00:00';
    const primera = aplicarMensaje([fila('a', T0)], mensaje('a', uno), ajeno);
    const segunda = aplicarMensaje(primera.lista, mensaje('a', otro), ajeno);
    assert.equal(segunda.efecto, 'aplicado');
    assert.equal(segunda.lista[0]?.unread, 2);
  });

  it('la hora del servidor y la de la base se entienden igual', () => {
    // El servidor: «Z». El tiempo real (Postgres): «+00» o «+00:00».
    const delServidor = [fila('a', '2026-10-28T10:00:00.5Z', { unread: 1 })];
    for (const comoLlega of ['2026-10-28 10:00:00.5+00', '2026-10-28T10:00:00.500000+00:00']) {
      assert.equal(aplicarMensaje(delServidor, mensaje('a', comoLlega), ajeno).efecto, 'ya-estaba');
    }
    assert.equal(
      aplicarMensaje(delServidor, mensaje('a', '2026-10-28T05:00:00.500001-05:00'), ajeno).efecto,
      'aplicado',
    );
  });
});

describe('lo que el teléfono no puede saber', () => {
  it('una conversación que no está en la portada es desconocida y no cambia nada', () => {
    const antes = [fila('a', T0)];
    const { lista, efecto } = aplicarMensaje(antes, mensaje('nueva', T1), ajeno);
    assert.equal(efecto, 'desconocida');
    assert.equal(lista, antes);
  });

  it('sin texto (una foto) se aplica el orden y el globo, pero el resumen lo da el servidor', () => {
    const { lista, efecto } = aplicarMensaje(
      [fila('a', T0), fila('b', T0)],
      mensaje('b', T1, { texto: '' }),
      ajeno,
    );
    assert.equal(efecto, 'sin-resumen');
    assert.equal(lista[0]?.id, 'b');
    assert.equal(lista[0]?.unread, 1);
    assert.equal(lista[0]?.subtitle, 'antes en b');
  });

  it('una fila sin último mensaje (grupo recién creado, chat vaciado) acepta el primero', () => {
    const { lista, efecto } = aplicarMensaje([fila('a', null)], mensaje('a', T0), ajeno);
    assert.equal(efecto, 'aplicado');
    assert.equal(lista[0]?.unread, 1);
  });

  it('si no se puede comparar el instante, no se arriesga: incierto', () => {
    assert.equal(aplicarMensaje([fila('a', T0)], mensaje('a', null), ajeno).efecto, 'incierto');
    assert.equal(aplicarMensaje([fila('a', T0)], mensaje('a', 'ayer'), ajeno).efecto, 'incierto');
    assert.equal(aplicarMensaje([fila('a', 'raro')], mensaje('a', T1), ajeno).efecto, 'incierto');
  });
});

describe('el mensaje del tiempo real se lee sin fiarse', () => {
  it('con todo lo que trae', () => {
    assert.deepEqual(
      leerMensajeEnVivo({ id: 'm1', conversation_id: 'c1', sender_id: 'u1', body: 'hola', created_at: T0 }),
      { id: 'm1', conversacionId: 'c1', remitenteId: 'u1', texto: 'hola', creadoEn: T0 },
    );
  });

  it('sin conversación no hay mensaje; lo demás que falte queda vacío', () => {
    assert.equal(leerMensajeEnVivo({ id: 'm1' }), null);
    assert.equal(leerMensajeEnVivo(null), null);
    assert.equal(leerMensajeEnVivo('x'), null);
    assert.deepEqual(leerMensajeEnVivo({ conversation_id: 'c1', body: null }), {
      id: null,
      conversacionId: 'c1',
      remitenteId: null,
      texto: '',
      creadoEn: null,
    });
  });

  it('los instantes, en microsegundos', () => {
    const base = Date.parse('2026-10-28T10:00:00Z') * 1000;
    assert.equal(instanteExacto('2026-10-28T10:00:00Z'), base);
    assert.equal(instanteExacto('2026-10-28T10:00:00.000001Z'), base + 1);
    assert.equal(instanteExacto('2026-10-28 11:00:00.25+01'), base + 250_000);
    assert.equal(instanteExacto('2026-10-28T10:00:00.1234567+00:00'), base + 123_456);
    assert.equal(instanteExacto(''), null);
    assert.equal(instanteExacto(undefined), null);
    assert.equal(instanteExacto('2026-13-45T10:00:00Z'), null);
  });
});

describe('cuándo se pregunta al servidor', () => {
  it('lo desconocido se pregunta ya; lo que ya se buscó y no estaba, no', () => {
    assert.equal(queHacerTrasElMensaje('desconocida', false), 'preguntar-ya');
    assert.equal(queHacerTrasElMensaje('desconocida', true), 'nada');
    assert.equal(queHacerTrasElMensaje('incierto', true), 'preguntar-ya');
    for (const efecto of ['aplicado', 'sin-resumen', 'ya-estaba'] as const) {
      assert.equal(queHacerTrasElMensaje(efecto, false), 'nada');
    }
  });

  it('los avisos de la campana solo por un chat de dos (o uno nuevo): las sesiones son de dos', () => {
    assert.equal(puedeTraerUnAviso({ esGrupo: false }, false), true);
    assert.equal(puedeTraerUnAviso({}, false), true);
    assert.equal(puedeTraerUnAviso({ esGrupo: true }, false), false);
    // Una conversación nueva puede ser la primera solicitud de alguien.
    assert.equal(puedeTraerUnAviso(undefined, false), true);
    // La que ya se buscó y no estaba es el chat de un tema o una comunidad.
    assert.equal(puedeTraerUnAviso(undefined, true), false);
  });

  it('la recarga de seguridad sale entre 20 y 30 s, repartida al azar', () => {
    assert.equal(RECARGA_DE_SEGURIDAD_MS, 20_000);
    assert.equal(DISPERSION_DE_LA_RECARGA_MS, 10_000);
    assert.equal(esperaDeLaRecargaDeSeguridad(0), 20_000);
    assert.equal(esperaDeLaRecargaDeSeguridad(0.5), 25_000);
    assert.ok(esperaDeLaRecargaDeSeguridad(0.999999) < 30_000);
    // Un azar raro no la saca del intervalo.
    assert.equal(esperaDeLaRecargaDeSeguridad(-3), 20_000);
    assert.equal(esperaDeLaRecargaDeSeguridad(Number.NaN), 20_000);
    assert.ok(esperaDeLaRecargaDeSeguridad(7) <= 30_000);
  });

  it('no hace falta si la bandeja se pidió después del último mensaje', () => {
    assert.equal(hayQueAsegurar(null, null), false);
    assert.equal(hayQueAsegurar(1_000, null), true);
    assert.equal(hayQueAsegurar(1_000, 999), true);
    // Pedida en el mismo instante o después: ya lo trae.
    assert.equal(hayQueAsegurar(1_000, 1_000), false);
    assert.equal(hayQueAsegurar(1_000, 5_000), false);
  });

  it('los conjuntos con tope olvidan lo más antiguo', () => {
    const conjunto = new Set<string>();
    for (const valor of ['a', 'b', 'c', 'a', 'd']) anotarConTope(conjunto, valor, 3);
    // «a» se volvió a anotar: es reciente; se cae «b», el más antiguo.
    assert.deepEqual([...conjunto], ['c', 'a', 'd']);
  });
});
