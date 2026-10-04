import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAXIMO_A_ANUNCIAR, adelantarMarca, destinoDelAviso, queAnunciar } from './avisosNuevos.ts';
import {
  dejarDeVerConversacion,
  marcarConversacionALaVista,
  seEstaViendoLaConversacion,
} from './loQueSeVe.ts';

/**
 * LOS AVISOS CON LA APLICACIÓN ABIERTA.
 *
 * Lo reportado: «cuando se envía un mensaje, o se le agenda sesión, o
 * reaccionan a su contenido… no aparecen las notificaciones. Deben aparecer
 * tanto en la bandeja como también un mensaje flotante». Aquí se fija qué se
 * anuncia y qué no, que no se anuncie dos veces, y que cada pieza esté
 * enchufada donde tiene que estar.
 */

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (codigo: string) =>
  codigo.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const aviso = (id: string, minuto: number, read = false) => ({
  id,
  createdAtIso: new Date(Date.UTC(2026, 9, 3, 12, minuto)).toISOString(),
  read,
});
const ms = (minuto: number) => Date.UTC(2026, 9, 3, 12, minuto);

describe('qué avisos de la bandeja se anuncian', () => {
  it('al arrancar no se anuncia nada: lo que ya estaba no es una novedad', () => {
    const { anunciar, marca } = queAnunciar([aviso('a', 1), aviso('b', 5)], null);
    assert.deepEqual(anunciar, []);
    assert.equal(marca, ms(5), 'pero la marca se fija en lo más reciente');
  });

  it('solo lo posterior a la marca, y solo lo no leído', () => {
    const { anunciar } = queAnunciar(
      [aviso('viejo', 1), aviso('nuevo', 7), aviso('leido', 8, true)],
      ms(5),
    );
    assert.deepEqual(anunciar.map((a) => a.id), ['nuevo']);
  });

  it('con tope, y salen los más recientes en el orden en que llegaron', () => {
    const muchos = [aviso('a', 6), aviso('b', 7), aviso('c', 8), aviso('d', 9)];
    const { anunciar } = queAnunciar(muchos, ms(5));
    assert.equal(anunciar.length, MAXIMO_A_ANUNCIAR);
    assert.deepEqual(anunciar.map((a) => a.id), ['c', 'd']);
  });

  it('lo ya anunciado no vuelve a salir', () => {
    const lista = [aviso('a', 6)];
    const primera = queAnunciar(lista, ms(5));
    assert.equal(primera.anunciar.length, 1);
    const segunda = queAnunciar(lista, primera.marca);
    assert.deepEqual(segunda.anunciar, []);
  });

  it('la marca nunca retrocede', () => {
    assert.equal(queAnunciar([aviso('a', 1)], ms(5)).marca, ms(5));
    assert.equal(queAnunciar([], ms(5)).marca, ms(5));
  });

  it('un aviso sin fecha válida no se anuncia', () => {
    const roto = { id: 'x', createdAtIso: 'no es una fecha', read: false };
    assert.deepEqual(queAnunciar([roto], ms(5)).anunciar, []);
  });

  it('lo que llegó por push ya está anunciado: adelantar la marca lo deja fuera', () => {
    // Llega el push, se enseña el aviso y se adelanta la marca. Cuando después
    // la lectura periódica trae ese mismo hecho, ya queda por detrás.
    const marca = adelantarMarca(ms(5), ms(10));
    assert.deepEqual(queAnunciar([aviso('el-del-push', 9)], marca).anunciar, []);
    assert.equal(adelantarMarca(ms(10), ms(5)), ms(10), 'tampoco retrocede');
    assert.equal(adelantarMarca(null, ms(5)), ms(5));
  });
});

describe('a dónde lleva un aviso de la bandeja', () => {
  const sinDecision = () => null;

  it('lo decidido sobre algo del creador manda', () => {
    const decision = (tipo: string, id: string | null | undefined) =>
      tipo === 'event_published' ? `/eventos/${id}` : null;
    assert.equal(
      destinoDelAviso({ type: 'event_published', entityId: 'e1', actorId: 'p1' }, decision),
      '/eventos/e1',
    );
  });

  it('una sesión lleva a la agenda, no al perfil de quien la pidió', () => {
    assert.equal(destinoDelAviso({ entityType: 'booking', actorId: 'p1' }, sinDecision), '/agenda');
  });

  it('una publicación, a la publicación; un comentario, a su publicación', () => {
    assert.equal(destinoDelAviso({ entityType: 'post', entityId: 'x', actorId: 'p1' }, sinDecision), '/post/x');
    assert.equal(
      destinoDelAviso({ entityType: 'comment', entityId: 'c', postId: 'x', actorId: 'p1' }, sinDecision),
      '/post/x',
    );
  });

  it('si no habla de nada concreto, al perfil de quien lo provocó', () => {
    assert.equal(destinoDelAviso({ type: 'follow', actorId: 'p1' }, sinDecision), '/profile/p1');
    assert.equal(destinoDelAviso({}, sinDecision), null);
  });

  it('la bandeja y el aviso flotante usan la MISMA decisión', () => {
    assert.match(sinComentarios(fuente('screens/NotificationsScreen.tsx')), /destinoDelAviso\(item, rutaDelAviso\)/);
    assert.match(sinComentarios(fuente('hooks/useAvisosEnVivo.ts')), /destinoDelAviso\(aviso, rutaDelAviso\)/);
  });
});

describe('lo que ya se está leyendo no se anuncia', () => {
  it('solo cuenta la conversación que está a la vista', () => {
    marcarConversacionALaVista('c1');
    assert.equal(seEstaViendoLaConversacion('c1'), true);
    assert.equal(seEstaViendoLaConversacion('c2'), false);
    assert.equal(seEstaViendoLaConversacion(null), false);
    marcarConversacionALaVista(null);
    assert.equal(seEstaViendoLaConversacion('c1'), false);
  });

  it('al pasar de un chat a otro, la salida del viejo no borra la marca del nuevo', () => {
    marcarConversacionALaVista('viejo');
    marcarConversacionALaVista('nuevo'); // el nuevo gana el foco primero
    dejarDeVerConversacion('viejo'); // y el viejo termina de perderlo después
    assert.equal(seEstaViendoLaConversacion('nuevo'), true);
    dejarDeVerConversacion('nuevo');
    assert.equal(seEstaViendoLaConversacion('nuevo'), false);
  });

  it('el chat marca su conversación al ganar el foco y la suelta al perderlo', () => {
    const chat = sinComentarios(fuente('screens/ChatScreen.tsx'));
    assert.match(chat, /marcarConversacionALaVista\(conversacionALaVista\);/);
    assert.match(chat, /dejarDeVerConversacion\(conversacionALaVista\);/);
    // Y retira el aviso de esa conversación que estuviera esperando.
    assert.match(chat, /retirarAvisosDe\(\(clave\) => clave === claveDeConversacion\(conversacionALaVista\)\)/);
  });

  it('ni el aviso en vivo ni el del push salen si esa conversación está delante', () => {
    assert.match(
      sinComentarios(fuente('hooks/useAvisosEnVivo.ts')),
      /if \(seEstaViendoLaConversacion\(id\)\) continue;/,
    );
    assert.match(
      sinComentarios(fuente('hooks/useAvisosDelPush.native.ts')),
      /if \(seEstaViendoLaConversacion\(conversacionDelPush\(data\)\)\) \{/,
    );
  });
});

describe('un solo sistema de avisos, enchufado', () => {
  const VIVO = sinComentarios(fuente('hooks/useAvisosEnVivo.ts'));
  const PUSH = sinComentarios(fuente('hooks/useAvisosDelPush.native.ts'));
  const SERVICIO = sinComentarios(fuente('services/notifications.ts'));
  const RAIZ = sinComentarios(readFileSync(join(SRC, '..', 'app', '_layout.tsx'), 'utf8'));

  it('los dos oyentes se montan en el layout raíz, una vez', () => {
    assert.equal(RAIZ.match(/useAvisosEnVivo\(\);/g)?.length, 1);
    assert.equal(RAIZ.match(/useAvisosDelPush\(\);/g)?.length, 1);
  });

  it('todo sale por el aviso flotante de siempre, no por uno nuevo', () => {
    assert.match(VIVO, /avisar\(\{\s*tipo: 'notificacion'/);
    assert.match(PUSH, /avisar\(\{\s*tipo: 'notificacion'/);
    assert.ok(!/Snackbar|react-native-toast|flash-message|Alert\.alert/.test(VIVO + PUSH));
  });

  it('el mensaje en vivo y su push comparten clave: no salen dos avisos', () => {
    assert.match(VIVO, /clave: claveDeConversacion\(id\)/);
    assert.match(PUSH, /clave: claveDelPush\(data\)/);
  });

  it('nada se queda escuchando al cerrar sesión o desmontar', () => {
    const limpieza = VIVO.slice(VIVO.lastIndexOf('return () => {'));
    assert.match(limpieza, /clearInterval\(reloj\)/);
    assert.match(limpieza, /clearTimeout\(respiro\)/);
    assert.match(limpieza, /alVolver\.remove\(\)/);
    assert.match(limpieza, /removeChannel\(canal\)/);
    assert.match(PUSH, /return \(\) => oyente\.remove\(\);/);
    // Sin sesión no se escucha nada y los contadores de otra cuenta se vacían.
    assert.match(VIVO, /if \(!supabaseEnabled \|\| !conSesion\) \{\s*useContadoresStore\.getState\(\)\.vaciar\(\);\s*return undefined;/);
  });

  it('en segundo plano no se pregunta: para eso está el push', () => {
    assert.match(VIVO, /if \(AppState\.currentState === 'active'\) void mirarAvisos\(\);/);
    assert.ok(!/setInterval\([^)]*,\s*\d{1,4}\)/.test(VIVO), 'nada de sondeos de menos de 10 s');
  });

  it('el destino de un push sale del mapa cerrado', () => {
    assert.match(PUSH, /rutaDelPush\(data, \{ rutaDeDecision: rutaDelAviso \}\)/);
    assert.match(
      sinComentarios(fuente('hooks/useAbrirDesdeElPush.native.ts')),
      /rutaDelPush\(datos, \{ rutaDeDecision: rutaDelAviso \}\)/,
    );
    // Ninguno de los dos navega a algo leído del aviso.
    for (const codigo of [PUSH, sinComentarios(fuente('hooks/useAbrirDesdeElPush.native.ts'))]) {
      assert.ok(!/push\(\s*(data|datos)\.[a-zA-Z]+/.test(codigo));
      assert.ok(!/Linking\.openURL/.test(codigo));
    }
  });

  it('con la aplicación abierta no se pinta además el aviso del sistema', () => {
    assert.match(SERVICIO, /shouldShowBanner: false/);
    // Y lo que se está leyendo ni suena ni se guarda.
    assert.match(SERVICIO, /shouldPlaySound: !aLaVista/);
    assert.match(SERVICIO, /shouldShowList: !aLaVista/);
  });
});

describe('los canales de Android suenan', () => {
  const SERVICIO = sinComentarios(fuente('services/notifications.ts'));

  it('ningún canal se crea con `sound: null`, que es SIN sonido', () => {
    assert.ok(!/sound:\s*null/.test(SERVICIO));
  });

  it('son ids nuevos: Android no deja cambiar el sonido de un canal ya creado', () => {
    for (const canal of ['mensajes-v2', 'interacciones-v2', 'contenido-v2']) {
      assert.ok(SERVICIO.includes(`id: '${canal}'`), canal);
    }
    // Y los mudos se retiran para que no salgan duplicados en los ajustes.
    assert.match(SERVICIO, /deleteNotificationChannelAsync\(viejo\)/);
  });

  it('el servidor manda a esos MISMOS ids', () => {
    const push = readFileSync(
      join(SRC, '..', '..', 'api', 'app', 'modules', 'notifications', 'push.py'),
      'utf8',
    );
    assert.match(push, /SUFIJO_DE_CANAL = "-v2"/);
    assert.match(push, /"channelId": canal_android\(channel\)/);
    assert.match(push, /"channelId": canal_android\(textos\.CANALES\.get\(tipo, "contenido"\)\)/);
    // Los nombres base coinciden con los del teléfono.
    for (const base of ['mensajes', 'interacciones', 'contenido']) {
      assert.ok(push.includes(`"${base}"`), base);
      assert.ok(SERVICIO.includes(`'${base}-v2'`), base);
    }
  });
});

describe('los contadores de no leídos', () => {
  it('la barra inferior lee el contador común, no un almacén que nadie rellenaba', () => {
    const barra = sinComentarios(fuente('components/FloatingGlassTabBar.tsx'));
    assert.match(barra, /useContadoresStore\(\(s\) => s\.mensajes\)/);
    assert.match(barra, /<GloboDeNoLeidos cuenta=\{unread\}/);
  });

  it('la campana se mueve sin tener que salir de Explorar y volver', () => {
    assert.match(
      sinComentarios(fuente('screens/ExploreScreen.tsx')),
      /rightBadge=\{avisosSinLeer > 0 \|\| avisosEnVivo > 0 \|\| darrenNoticePending\}/,
    );
  });

  it('abrir la bandeja apaga la campana y el icono de la aplicación', () => {
    const bandeja = sinComentarios(fuente('screens/NotificationsScreen.tsx'));
    assert.match(bandeja, /markAllRead\(\)\s*\.then\(notificacionesLeidas\)/);
  });

  it('la bandeja de mensajes anota lo no leído sin otra petición, y solo sin filtros', () => {
    assert.match(
      sinComentarios(fuente('screens/MessagesScreen.tsx')),
      /if \(!hayConsulta\(consultaRef\.current\)\) anotarMensajes\(data\);/,
    );
  });

  it('refrescar un contador nunca lanza', () => {
    const contadores = sinComentarios(fuente('services/contadores.ts'));
    assert.equal(contadores.match(/\} catch \{\s*return null;/g)?.length, 2);
  });

  it('lo no leído se resalta en la bandeja, y se dice al lector de pantalla', () => {
    const bandeja = sinComentarios(fuente('screens/NotificationsScreen.tsx'));
    assert.match(bandeja, /const nuevo = !aviso\.read;/);
    assert.match(bandeja, /weight=\{nuevo \? '800' : '600'\}/);
    assert.match(bandeja, /<GloboDeNoLeidos cuenta=\{nuevo \? 1 : 0\} soloPunto \/>/);
    assert.match(bandeja, /t\('notif\.unreadA11y'\)/);
    // Y pagina en vez de quedarse en los primeros cincuenta.
    assert.match(bandeja, /onEndReached=\{cargarMas\}/);
    assert.match(bandeja, /NotificationRepository\.list\(items\.length\)/);
  });

  it('compras y devoluciones ya no salen con el texto genérico', () => {
    const mapper = fuente('mappers/notificationMapper.ts');
    for (const tipo of ['course_purchase', 'refund_requested', 'refund_approved', 'refund_rejected', 'refund_refunded']) {
      assert.ok(mapper.includes(`case '${tipo}':`), tipo);
    }
  });
});
