import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  ICONOS_DE_TEMA,
  MAX_NOMBRE_DE_TEMA,
  MAX_TITULO_DE_COMUNIDAD,
  SIN_COMUNIDADES,
  SIN_TEMAS,
  abreLaLista,
  accionDeComunidad,
  claveDelFalloDeTemas,
  fusionarMensajesDeTema,
  iconoDeTema,
  instanteMasAntiguoDeTema,
  juzgarNombreDeTema,
  juzgarTituloDeComunidad,
  leerComunidades,
  leerCuenta,
  leerDatosDeTema,
  leerPaginaDeTema,
  leerTemas,
  leerUltimo,
  limpiarNombre,
  refrescarLoReciente,
  resumenDeUltimo,
  sinLeerDeLaFila,
} from './temasDeGrupo.ts';
import { leerInfo } from './gruposDeChat.ts';
import { es } from '../i18n/es.ts';

/*
  Temas y comunidades de un grupo (26/10/2026), contra el contrato de
  `docs/CONTRATOS_TEMAS_Y_COMUNIDADES.md`. Lo esencial: sin las migraciones no
  se ofrece nada (nunca un botón muerto), quien no está en una comunidad no ve
  sus mensajes, un tema no repite burbujas al paginar ni guarda las que ya se
  fueron, y la bandeja abre la lista solo cuando hay algo más que General.
*/

const leer = (ruta: string) =>
  readFileSync(new URL(ruta, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const TEMA = {
  id: 't1',
  name: 'Anuncios',
  icon: 'bell',
  position: 0,
  chat_id: 'c-t1',
  references: 3,
  own: 1,
  unseen: 2,
  contains: null,
  last: { sender_name: 'Ana Torres', excerpt: 'Recuerden…', kind: 'text', at: '2026-10-26T10:25:00Z', own: true },
};

const COMUNIDAD = {
  id: 's1',
  title: 'Valorant',
  avatar_path: null,
  description: '',
  entry: 'open',
  position: 0,
  members_count: 3,
  is_member: true,
  request_pending: false,
  pending_requests: 2,
  unread_count: 1,
  last: { sender_name: 'Bruno Díaz', excerpt: 'Hoy a las 9…', kind: 'text', at: '2026-10-26T09:40:00Z' },
};

// ---------------------------------------------------------------------------
// Leer los temas
// ---------------------------------------------------------------------------

describe('leer los temas de un grupo', () => {
  test('se lee un tema con todo lo que dice el contrato', () => {
    const leidos = leerTemas({ available: true, can_manage: true, topics: [TEMA] });
    assert.equal(leidos.disponible, true);
    assert.equal(leidos.puedoAdministrar, true);
    assert.deepEqual(leidos.temas[0], {
      id: 't1',
      nombre: 'Anuncios',
      icono: 'bell',
      posicion: 0,
      chatId: 'c-t1',
      referencias: 3,
      propios: 1,
      sinVer: 2,
      contiene: null,
      ultimo: {
        autor: 'Ana Torres',
        extracto: 'Recuerden…',
        tipo: 'text',
        fechaIso: '2026-10-26T10:25:00Z',
        propio: true,
      },
    });
  });

  test('sin la 0108 no hay temas que ofrecer, diga lo que diga el resto', () => {
    assert.deepEqual(leerTemas({ available: false, can_manage: true, topics: [TEMA] }), SIN_TEMAS);
    assert.deepEqual(leerTemas(null), SIN_TEMAS);
    assert.deepEqual(leerTemas('nada'), SIN_TEMAS);
    // Una API antigua que no conoce la ruta tampoco manda `available`.
    assert.deepEqual(leerTemas({ topics: [TEMA] }), SIN_TEMAS);
  });

  test('un tema sin su chat o sin nombre no se pinta: no se podría abrir bien', () => {
    const leidos = leerTemas({
      available: true,
      topics: [
        { ...TEMA, id: 'a', chat_id: '' },
        { ...TEMA, id: 'b', name: '   ' },
        null,
        'x',
        { ...TEMA, id: 'c' },
        { ...TEMA, id: 'c', name: 'Repetido' },
      ],
    });
    assert.deepEqual(leidos.temas.map((t) => [t.id, t.nombre]), [['c', 'Anuncios']]);
  });

  test('el orden es el del servidor: el mismo para todos', () => {
    const leidos = leerTemas({
      available: true,
      topics: [
        { ...TEMA, id: 'z', position: 5 },
        { ...TEMA, id: 'a', position: 1 },
      ],
    });
    assert.deepEqual(leidos.temas.map((t) => t.id), ['z', 'a']);
  });

  test('un icono fuera de la lista cerrada es una carpeta, como en el servidor', () => {
    assert.equal(iconoDeTema('bell'), 'bell');
    assert.equal(iconoDeTema('rocket'), 'folder');
    assert.equal(iconoDeTema(undefined), 'folder');
    assert.equal(ICONOS_DE_TEMA.length, 10);
  });

  test('las cuentas raras valen cero: un globo con «-1» no dice nada', () => {
    assert.equal(leerCuenta(-1), 0);
    assert.equal(leerCuenta('3'), 0);
    assert.equal(leerCuenta(Number.NaN), 0);
    assert.equal(leerCuenta(2.7), 2);
    const [tema] = leerTemas({ available: true, topics: [{ ...TEMA, unseen: -4, references: '9' }] }).temas;
    assert.equal(tema?.sinVer, 0);
    assert.equal(tema?.referencias, 0);
  });

  test('con `message_id`, cada tema dice si ya contiene el mensaje', () => {
    const leidos = leerTemas({
      available: true,
      topics: [
        { ...TEMA, id: 'a', contains: true },
        { ...TEMA, id: 'b', contains: false },
      ],
    });
    assert.deepEqual(leidos.temas.map((t) => t.contiene), [true, false]);
  });

  test('lo último: sin texto se dice qué era, con las claves de las citas', () => {
    const foto = leerUltimo({ sender_name: 'Ana', excerpt: '', kind: 'image', at: null });
    assert.ok(foto);
    assert.deepEqual(resumenDeUltimo(foto), { clave: 'chat.replyPhoto' });
    const raro = leerUltimo({ sender_name: 'Ana', excerpt: '', kind: 'holograma' });
    assert.equal(raro?.tipo, 'text');
    assert.deepEqual(resumenDeUltimo(raro!), { clave: 'chat.replyMessage' });
    assert.deepEqual(resumenDeUltimo(leerUltimo(TEMA.last)!), { texto: 'Recuerden…' });
    assert.equal(leerUltimo(null), null);
    for (const tipo of ['image', 'video', 'audio', 'document', 'link', 'text'] as const) {
      const r = resumenDeUltimo({ autor: '', extracto: '', tipo, fechaIso: null, propio: false });
      if ('clave' in r) assert.ok(r.clave in es, `falta ${r.clave}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Leer las comunidades
// ---------------------------------------------------------------------------

describe('leer las comunidades de un grupo', () => {
  test('se lee una comunidad de la que se es miembro', () => {
    const leidas = leerComunidades({ available: true, can_manage: true, subgroups: [COMUNIDAD] });
    const [c] = leidas.comunidades;
    assert.equal(c?.titulo, 'Valorant');
    assert.equal(c?.entrada, 'open');
    assert.equal(c?.miembros, 3);
    assert.equal(c?.soyMiembro, true);
    assert.equal(c?.sinLeer, 1);
    assert.equal(c?.solicitudes, 2);
    assert.equal(c?.ultimo?.autor, 'Bruno Díaz');
  });

  test('quien no está dentro no ve mensajes: ni cuántos ni el último', () => {
    const [c] = leerComunidades({
      available: true,
      subgroups: [{ ...COMUNIDAD, is_member: false }],
    }).comunidades;
    assert.equal(c?.sinLeer, 0);
    assert.equal(c?.ultimo, null);
  });

  test('las solicitudes son solo de quien administra', () => {
    const [c] = leerComunidades({ available: true, can_manage: false, subgroups: [COMUNIDAD] }).comunidades;
    assert.equal(c?.solicitudes, 0);
  });

  test('quien ya está dentro no espera respuesta a nada', () => {
    const [c] = leerComunidades({
      available: true,
      subgroups: [{ ...COMUNIDAD, request_pending: true }],
    }).comunidades;
    assert.equal(c?.solicitudPendiente, false);
  });

  test('lo que no es `request` es abierta, que es lo que dice la 0109 por omisión', () => {
    const [a, b] = leerComunidades({
      available: true,
      subgroups: [
        { ...COMUNIDAD, id: 'a', entry: 'request' },
        { ...COMUNIDAD, id: 'b', entry: 'otra cosa' },
      ],
    }).comunidades;
    assert.equal(a?.entrada, 'request');
    assert.equal(b?.entrada, 'open');
  });

  test('sin la 0109 no hay comunidades que ofrecer', () => {
    assert.deepEqual(leerComunidades({ available: false, subgroups: [COMUNIDAD] }), SIN_COMUNIDADES);
    assert.deepEqual(leerComunidades(undefined), SIN_COMUNIDADES);
  });

  test('a cada comunidad, su botón: nunca dos ni ninguno', () => {
    assert.equal(accionDeComunidad({ soyMiembro: true, entrada: 'request', solicitudPendiente: false }), 'abrir');
    assert.equal(accionDeComunidad({ soyMiembro: false, entrada: 'open', solicitudPendiente: false }), 'unirme');
    assert.equal(accionDeComunidad({ soyMiembro: false, entrada: 'request', solicitudPendiente: false }), 'pedir');
    assert.equal(accionDeComunidad({ soyMiembro: false, entrada: 'request', solicitudPendiente: true }), 'retirar');
  });
});

// ---------------------------------------------------------------------------
// Los mensajes de un tema
// ---------------------------------------------------------------------------

const fila = (id: string, orden: string, extra: Record<string, unknown> = {}) => ({
  id,
  conversation_id: 'general',
  sender: { id: 'u1', full_name: 'Ana', username: 'ana', avatar_path: null },
  body: id,
  created_at: orden,
  order_at: orden,
  own: false,
  added_by: { id: 'u9', full_name: 'Admin', username: null, avatar_path: null },
  added_at: orden,
  ...extra,
});

describe('los mensajes de un tema', () => {
  test('se leen los datos que el tema añade al mensaje', () => {
    assert.deepEqual(leerDatosDeTema(fila('m1', '2026-10-26T10:00:00Z')), {
      propio: false,
      conversacionId: 'general',
      anadidoPor: { id: 'u9', nombre: 'Admin' },
      anadidoEnIso: '2026-10-26T10:00:00Z',
      ordenIso: '2026-10-26T10:00:00Z',
    });
    // Un mensaje propio: su conversación es la del tema y no lo agregó nadie.
    const propio = leerDatosDeTema(
      fila('m2', '2026-10-26T10:05:00Z', { conversation_id: 'c-t1', own: true, added_by: null, added_at: null }),
    );
    assert.equal(propio?.propio, true);
    assert.equal(propio?.conversacionId, 'c-t1');
    assert.equal(propio?.anadidoPor, null);
  });

  test('sin `order_at` se ordena por cuándo se escribió', () => {
    const sinOrden = { ...fila('m1', '2026-10-26T10:00:00Z'), order_at: undefined };
    assert.equal(leerDatosDeTema(sinOrden)?.ordenIso, '2026-10-26T10:00:00Z');
  });

  test('la página deja fuera lo que rompería una burbuja', () => {
    const { filas, hayMas } = leerPaginaDeTema({
      items: [
        fila('m1', '2026-10-26T10:00:00Z'),
        { ...fila('m2', '2026-10-26T10:01:00Z'), sender: null },
        { ...fila('m3', '2026-10-26T10:02:00Z'), conversation_id: '' },
        null,
        fila('m4', '2026-10-26T10:03:00Z'),
      ],
      has_more: true,
    });
    assert.deepEqual(filas.map((f) => f.id), ['m1', 'm4']);
    assert.equal(hayMas, true);
    assert.deepEqual(leerPaginaDeTema('x'), { filas: [], hayMas: false });
  });

  const m = (id: string, ordenIso: string) => ({ id, ordenIso });

  test('subir por el historial no repite mensajes y deja el orden de un chat', () => {
    const actuales = [m('b', '2026-10-26T10:02:00Z'), m('c', '2026-10-26T10:03:00Z')];
    const viejos = [m('a', '2026-10-26T10:01:00Z'), m('b', '2026-10-26T10:02:00Z')];
    assert.deepEqual(fusionarMensajesDeTema(actuales, viejos).map((x) => x.id), ['a', 'b', 'c']);
    assert.equal(instanteMasAntiguoDeTema(actuales), '2026-10-26T10:02:00Z');
    assert.equal(instanteMasAntiguoDeTema([]), null);
  });

  test('lo que se quitó del tema desaparece al refrescar, y lo de más arriba se queda', () => {
    const actuales = [
      m('viejo', '2026-10-26T09:00:00Z'),
      m('sigue', '2026-10-26T10:02:00Z'),
      m('quitado', '2026-10-26T10:03:00Z'),
    ];
    const pagina = [m('sigue', '2026-10-26T10:02:00Z'), m('nuevo', '2026-10-26T10:04:00Z')];
    // Queda algo más atrás: en el tramo de la página manda ella sola, y lo ya
    // bajado de antes del corte se conserva.
    assert.deepEqual(
      refrescarLoReciente(actuales, pagina, true).map((x) => x.id),
      ['viejo', 'sigue', 'nuevo'],
    );
    // No queda nada atrás: la página ES el tema entero.
    assert.deepEqual(refrescarLoReciente(actuales, pagina, false).map((x) => x.id), ['sigue', 'nuevo']);
    // Un tema que se quedó vacío se queda vacío.
    assert.deepEqual(refrescarLoReciente(actuales, [], false), []);
  });
});

// ---------------------------------------------------------------------------
// La bandeja
// ---------------------------------------------------------------------------

describe('la fila de la bandeja', () => {
  test('abre la lista solo si hay algo más que General', () => {
    assert.equal(abreLaLista({ unread: 0, esGrupo: true, temas: 1, comunidades: 0 }), true);
    assert.equal(abreLaLista({ unread: 0, esGrupo: true, temas: 0, comunidades: 2 }), true);
    assert.equal(abreLaLista({ unread: 0, esGrupo: true, temas: 0, comunidades: 0 }), false);
    // Un servidor anterior no manda las cuentas: el chat se abre como siempre.
    assert.equal(abreLaLista({ unread: 3, esGrupo: true }), false);
    assert.equal(abreLaLista({ unread: 0, esGrupo: false, temas: 4 }), false);
  });

  test('el globo cuenta todo lo del grupo, y nunca menos que General', () => {
    assert.equal(sinLeerDeLaFila({ unread: 2, totalSinLeer: 7 }), 7);
    // Un servidor que aún no calcula el total manda el cero por omisión.
    assert.equal(sinLeerDeLaFila({ unread: 2, totalSinLeer: 0 }), 2);
    assert.equal(sinLeerDeLaFila({ unread: 4 }), 4);
  });

  test('el repositorio pide la bandeja agrupada, también para el contador', () => {
    const repo = leer('../repositories/MessageRepository.ts');
    assert.match(repo, /parametrosDeBandeja\(consulta, \{ limit, offset \}\)\}&grouped=true/);
  });

  test('la fila usa el total, y marca con icono y texto lo que abre la lista', () => {
    const fila = leer('../components/FilaDeConversacion.tsx');
    assert.match(fila, /sinLeerDeLaFila\(conversacion\)/);
    assert.match(fila, /name="layers"/);
    assert.match(fila, /accessibilityLabel=\{t\('groupTopics\.badge'\)\}/);
  });

  test('la bandeja abre la lista del grupo cuando toca', () => {
    const pantalla = leer('../screens/MessagesScreen.tsx');
    assert.match(pantalla, /abreLaLista\(conversacion\)/);
    assert.match(pantalla, /'\/chat\/lista\/\[id\]'/);
  });
});

// ---------------------------------------------------------------------------
// Escribir nombres y explicar rechazos
// ---------------------------------------------------------------------------

describe('escribir nombres', () => {
  test('el nombre de un tema, como lo guardará el servidor', () => {
    assert.equal(limpiarNombre('  Material   de\nestudio '), 'Material de estudio');
    assert.equal(juzgarNombreDeTema('   '), 'vacio');
    assert.equal(juzgarNombreDeTema('x'.repeat(MAX_NOMBRE_DE_TEMA)), 'vale');
    assert.equal(juzgarNombreDeTema('x'.repeat(MAX_NOMBRE_DE_TEMA + 1)), 'largo');
    // «anúncios» choca con «Anuncios»: el servidor compara el nombre normalizado.
    assert.equal(juzgarNombreDeTema(' anúncios ', ['Anuncios']), 'repetido');
    assert.equal(juzgarNombreDeTema('Videos', ['Anuncios']), 'vale');
  });

  test('el nombre de una comunidad', () => {
    assert.equal(juzgarTituloDeComunidad(''), 'vacio');
    assert.equal(juzgarTituloDeComunidad('x'.repeat(MAX_TITULO_DE_COMUNIDAD + 1)), 'largo');
    assert.equal(juzgarTituloDeComunidad('valorant', ['Valorant']), 'repetido');
  });

  test('cada rechazo conocido tiene su texto, y lo demás cae en los de grupos', () => {
    const codigos = [
      'topic_name_taken',
      'topics_limit',
      'topics_unavailable',
      'topic_admin_only',
      'topic_not_found',
      'message_not_in_group',
      'not_a_top_level_group',
      'subgroups_unavailable',
      'subgroup_requires_request',
      'subgroup_not_found',
    ];
    for (const codigo of codigos) {
      const clave = claveDelFalloDeTemas(codigo);
      assert.ok(clave && clave in es, `${codigo} → ${clave}`);
    }
    assert.equal(claveDelFalloDeTemas('group_is_full'), null);
    assert.equal(claveDelFalloDeTemas(undefined), null);
  });
});

// ---------------------------------------------------------------------------
// Qué es una conversación: comunidad o chat de un tema
// ---------------------------------------------------------------------------

describe('la información de una conversación', () => {
  const GRUPO = { id: 'c1', kind: 'group', title: 'Valorant', can_manage: false, members: [] };

  test('una comunidad dice de qué grupo cuelga', () => {
    const info = leerInfo({ ...GRUPO, parent: { id: 'g1', title: ' Juegos ' } });
    assert.deepEqual(info?.padre, { id: 'g1', titulo: 'Juegos' });
    assert.equal(info?.tema, null);
  });

  test('el chat de un tema dice a qué tema llevar', () => {
    const info = leerInfo({ ...GRUPO, topic: { group_id: 'g1', topic_id: 't1', name: 'Anuncios' } });
    assert.deepEqual(info?.tema, { grupoId: 'g1', temaId: 't1', nombre: 'Anuncios' });
  });

  test('a medias no se lleva a ningún sitio, y un chat de dos no es nada de eso', () => {
    const info = leerInfo({ ...GRUPO, parent: { title: 'Sin id' }, topic: { group_id: 'g1' } });
    assert.equal(info?.padre, null);
    assert.equal(info?.tema, null);
    const directo = leerInfo({
      id: 'd1',
      kind: 'direct',
      members: [],
      parent: { id: 'g1', title: 'x' },
      topic: { group_id: 'g1', topic_id: 't1', name: 'x' },
    });
    assert.equal(directo?.padre, null);
    assert.equal(directo?.tema, null);
    // Un servidor anterior no manda nada de esto.
    assert.equal(leerInfo(GRUPO)?.padre, null);
  });
});
