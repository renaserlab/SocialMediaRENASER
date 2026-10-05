import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RUTA_DE_LA_BANDEJA,
  claveDeConversacion,
  claveDelPush,
  conversacionDelPush,
  destinoDelToque,
  directoDelPush,
  mensajeDelPush,
  rutaDelPush,
} from './rutaDelPush.ts';

/**
 * TOCAR UN AVISO LLEVA A LO QUE ANUNCIA, Y SOLO A DONDE LA APLICACIÓN DECIDE.
 *
 * Antes solo el aviso de un directo llevaba a algún sitio. Ahora cada tipo
 * tiene su destino, y lo que se fija aquí es que ese destino sale de un mapa
 * CERRADO: lo que llega en un push viene de fuera del teléfono y no puede
 * elegir pantalla.
 */

const ID = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const OTRO = '11111111-2222-4333-8444-555555555555';

test('un aviso de directo lleva al directo', () => {
  assert.equal(rutaDelPush({ type: 'live_started', liveId: ID }), `/live/${ID}`);
  assert.equal(directoDelPush({ type: 'live_started', liveId: ID }), ID);
});

test('un mensaje lleva a su conversación', () => {
  assert.equal(rutaDelPush({ type: 'message', conversationId: ID }), `/chat/${ID}`);
  assert.equal(conversacionDelPush({ type: 'message', conversationId: ID }), ID);
});

test('lo que habla de una publicación lleva a la publicación', () => {
  for (const type of ['like', 'comment', 'comment_reply', 'comment_like', 'post_mention']) {
    assert.equal(rutaDelPush({ type, postId: ID }), `/post/${ID}`, type);
  }
});

test('un seguidor nuevo lleva a su perfil', () => {
  assert.equal(rutaDelPush({ type: 'follow', profileId: ID }), `/profile/${ID}`);
});

test('lo de las sesiones lleva a la agenda', () => {
  for (const type of [
    'booking',
    'session_booked',
    'session_accepted',
    'session_rejected',
    'session_cancelled',
    'session_rescheduled',
    'session_completed',
  ]) {
    assert.equal(rutaDelPush({ type, id: ID }), '/agenda', type);
  }
});

test('una decisión sobre algo del creador usa el mapa de la bandeja', () => {
  const rutaDeDecision = (tipo: string, entidad: string | null | undefined) =>
    tipo === 'event_published' && entidad ? `/eventos/${entidad}` : null;
  assert.equal(
    rutaDelPush({ type: 'event_published', entityType: 'event', entityId: ID }, { rutaDeDecision }),
    `/eventos/${ID}`,
  );
  // Sin ese mapa, o si no reconoce el tipo, a la bandeja.
  assert.equal(rutaDelPush({ type: 'event_published', entityId: ID }), RUTA_DE_LA_BANDEJA);
  assert.equal(rutaDelPush({ type: 'otra_cosa', entityId: ID }, { rutaDeDecision }), RUTA_DE_LA_BANDEJA);
});

test('un aviso sin destino conocido lleva a la bandeja, que siempre existe', () => {
  for (const datos of [{}, { type: 'service_booking_confirmed' }, { type: 'algo_nuevo', x: 1 }]) {
    assert.equal(rutaDelPush(datos), RUTA_DE_LA_BANDEJA, JSON.stringify(datos));
  }
});

test('lo que ni siquiera es un aviso abre la aplicación sin más', () => {
  for (const datos of [null, undefined, 'live_started', 42, ['message', ID]]) {
    assert.equal(rutaDelPush(datos), null, JSON.stringify(datos));
    assert.equal(directoDelPush(datos), null);
  }
});

test('un identificador que no es un UUID no acaba metido en una ruta', () => {
  const raros = [
    '../../admin',
    `${ID}/../../admin`,
    `${ID}?next=https://malo.example`,
    'javascript:alert(1)',
    '',
    ' ',
    123,
    null,
    { id: ID },
  ];
  for (const raro of raros) {
    assert.equal(rutaDelPush({ type: 'live_started', liveId: raro }), RUTA_DE_LA_BANDEJA);
    assert.equal(rutaDelPush({ type: 'message', conversationId: raro }), '/messages');
    assert.equal(rutaDelPush({ type: 'like', postId: raro }), RUTA_DE_LA_BANDEJA);
    assert.equal(rutaDelPush({ type: 'follow', profileId: raro }), RUTA_DE_LA_BANDEJA);
    assert.equal(conversacionDelPush({ type: 'message', conversationId: raro }), null);
  }
});

test('una ruta que venga escrita en el aviso se ignora', () => {
  // El aviso trae un tipo y un identificador. Cualquier «ve aquí» no existe.
  const trampa = {
    type: 'like',
    postId: ID,
    url: 'https://malo.example',
    route: '/admin',
    ruta: '/admin/finanzas',
    path: '/pago',
    href: 'zexcelencia://admin',
  };
  assert.equal(rutaDelPush(trampa), `/post/${ID}`);
  assert.equal(rutaDelPush({ url: '/admin', route: '/admin' }), RUTA_DE_LA_BANDEJA);
});

test('todos los destinos posibles salen de una lista conocida', () => {
  const permitidos = [
    /^\/live\/[0-9a-f-]{36}$/,
    /^\/chat\/[0-9a-f-]{36}$/,
    /^\/post\/[0-9a-f-]{36}$/,
    /^\/profile\/[0-9a-f-]{36}$/,
    /^\/agenda$/,
    /^\/messages$/,
    /^\/notifications$/,
  ];
  const tipos = [
    'live_started', 'message', 'like', 'comment', 'comment_reply', 'comment_like',
    'post_mention', 'follow', 'booking', 'session_booked', 'session_accepted',
    'desconocido', '',
  ];
  for (const type of tipos) {
    for (const id of [ID, 'no-es-uuid', undefined]) {
      const ruta = rutaDelPush({
        type, liveId: id, conversationId: id, postId: id, profileId: id, entityId: id, id,
      });
      assert.ok(ruta !== null && permitidos.some((patron) => patron.test(ruta)), `${type} → ${ruta}`);
    }
  }
});

test('los avisos de una conversación comparten clave: son uno que se renueva', () => {
  const uno = claveDelPush({ type: 'message', conversationId: ID });
  const otro = claveDelPush({ type: 'message', conversationId: ID });
  assert.equal(uno, otro);
  assert.equal(uno, claveDeConversacion(ID));
  assert.notEqual(uno, claveDelPush({ type: 'message', conversationId: OTRO }));
});

test('lo demás se agrupa por tipo y por aquello de lo que habla', () => {
  assert.equal(claveDelPush({ type: 'like', postId: ID }), claveDelPush({ type: 'like', postId: ID }));
  assert.notEqual(claveDelPush({ type: 'like', postId: ID }), claveDelPush({ type: 'like', postId: OTRO }));
  assert.notEqual(claveDelPush({ type: 'like', postId: ID }), claveDelPush({ type: 'comment', postId: ID }));
  assert.equal(claveDelPush(null), 'aviso');
});

test('el identificador del mensaje sirve para no avisar dos veces, y solo si es un UUID', () => {
  assert.equal(mensajeDelPush({ type: 'message', conversationId: ID, messageId: OTRO }), OTRO);
  assert.equal(mensajeDelPush({ type: 'message', conversationId: ID }), null);
  assert.equal(mensajeDelPush({ type: 'message', messageId: '../../x' }), null);
  assert.equal(mensajeDelPush({ type: 'like', messageId: OTRO }), null);
  assert.equal(mensajeDelPush(null), null);
  // No cambia a dónde lleva el aviso.
  assert.equal(rutaDelPush({ type: 'message', conversationId: ID, messageId: OTRO }), `/chat/${ID}`);
});

/*
  ABRIR LA APLICACIÓN NO ES TOCAR UN AVISO (05/10/2026).

  Reportado con la compilación 46, en un Xiaomi: «cada que entro a la
  aplicación me redirige a notificaciones». En Android la biblioteca de avisos
  entrega como «han tocado un aviso» cualquier dato con que el sistema abra la
  aplicación, y ese lanzador la abre con datos suyos.
*/

test('lo que no trae identificador no es un aviso: la aplicación se queda en Inicio', () => {
  // Lo que deja el lanzador: sin identificador y con datos que no son nuestros.
  const delLanzador = { profile: 0, 'android.intent.extra.REFERRER': 'launcher' };
  for (const identificador of [null, undefined, '', '   ', 0, {}]) {
    assert.equal(destinoDelToque({ identificador, datos: delLanzador }), null);
    // Ni aunque los datos PAREZCAN un aviso: sin identificador no lo es.
    assert.equal(
      destinoDelToque({ identificador, datos: { type: 'message', conversationId: ID } }),
      null,
    );
  }
});

test('un toque de verdad lleva a lo que anuncia', () => {
  const identificador = '0:1759683633526098%a1b2c3d4';
  assert.equal(
    destinoDelToque({ identificador, datos: { type: 'message', conversationId: ID } }),
    `/chat/${ID}`,
  );
  assert.equal(destinoDelToque({ identificador, datos: { type: 'follow', profileId: ID } }), `/profile/${ID}`);
  assert.equal(destinoDelToque({ identificador, datos: { type: 'session_booked' } }), '/agenda');
  assert.equal(destinoDelToque({ identificador, datos: { type: 'live_started', liveId: ID } }), `/live/${ID}`);
  // Y las decisiones sobre lo del creador, por el mapa que se le pasa.
  assert.equal(
    destinoDelToque(
      { identificador, datos: { type: 'event_published', entityId: OTRO } },
      { rutaDeDecision: (tipo, entidad) => (tipo === 'event_published' ? `/eventos/${entidad}` : null) },
    ),
    `/eventos/${OTRO}`,
  );
});

test('un aviso sin destino propio ya no abre la bandeja: se entra por Inicio', () => {
  const identificador = '0:1759683633526098%a1b2c3d4';
  // Los de la cola (servicios, eventos, productos) llegan sin datos.
  assert.equal(destinoDelToque({ identificador, datos: {} }), null);
  assert.equal(destinoDelToque({ identificador, datos: null }), null);
  assert.equal(destinoDelToque({ identificador, datos: undefined }), null);
  // Un tipo que esta versión no conoce, o uno conocido con el identificador roto.
  assert.equal(destinoDelToque({ identificador, datos: { type: 'algo_nuevo' } }), null);
  assert.equal(destinoDelToque({ identificador, datos: { type: 'like', postId: 'no-es-un-uuid' } }), null);
  // `rutaDelPush` sigue diciendo «bandeja» para quien pinta un aviso con la
  // aplicación abierta: lo que cambia es que ARRANCAR no acaba allí.
  assert.equal(rutaDelPush({ type: 'algo_nuevo' }), RUTA_DE_LA_BANDEJA);
});
