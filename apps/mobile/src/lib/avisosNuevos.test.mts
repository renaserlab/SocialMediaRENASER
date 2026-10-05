import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAXIMO_A_ANUNCIAR,
  SILENCIO_TRAS_UN_AVISO_DE_SESION_MS,
  actoresDeSesionNuevos,
  desdeCuandoPreguntar,
  destinoDelAviso,
  hayQueLeerLaBandeja,
  queAnunciar,
} from './avisosNuevos.ts';
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

  it('ponerse al día sin anunciar: lo que ya se avisó por otro lado no vuelve a salir', () => {
    // Llega un push y se enseña; o la aplicación vuelve de segundo plano, donde
    // el sistema ya avisó. Se llama «en callado» —sin marca— y solo se fija la
    // marca. Cuando después la lectura periódica trae ese mismo hecho, ya queda
    // por detrás.
    const lista = [aviso('el-del-push', 9)];
    const callado = queAnunciar(lista, null);
    assert.deepEqual(callado.anunciar, []);
    assert.deepEqual(queAnunciar(lista, callado.marca).anunciar, []);
    // Y lo que llegue DESPUÉS sí se anuncia.
    assert.deepEqual(
      queAnunciar([...lista, aviso('otro', 12)], callado.marca).anunciar.map((a) => a.id),
      ['otro'],
    );
  });

  it('la marca sale de las fechas del servidor, no del reloj del teléfono', () => {
    const lib = sinComentarios(fuente('lib/avisosNuevos.ts'));
    const hook = sinComentarios(fuente('hooks/useAvisosEnVivo.ts'));
    assert.ok(!/Date\.now\(\)/.test(lib));
    // En el hook, `Date.now()` solo nombra el canal; la marca nunca sale de él.
    assert.ok(!/marca\s*=[^;]*Date\.now\(\)/.test(hook));
    assert.match(hook, /marca = Math\.max\(marca \?\? 0, resultado\.marca\);/);
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
    assert.match(sinComentarios(fuente('screens/NotificationsScreen.tsx')), /destinoDelAviso\(aviso, rutaDelAviso\)/);
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
    const push = sinComentarios(fuente('hooks/useAvisosDelPush.native.ts'));
    assert.match(push, /const conversacion = conversacionDelPush\(data\);/);
    assert.match(push, /if \(seEstaViendoLaConversacion\(conversacion\)\) \{/);
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

  it('el mensaje en vivo y su push son UN aviso: se reconocen por el identificador', () => {
    // El push de un mensaje no se pinta en su oyente: se entrega al camino en
    // vivo, que ya puede haber anunciado ese mismo mensaje.
    assert.match(
      PUSH,
      /if \(conversacion && alRecibirUnMensajePorPush\(conversacion, mensajeDelPush\(data\)\)\) return;/,
    );
    // Y allí el segundo se descarta por su identificador.
    assert.match(VIVO, /if \(anunciados\.has\(mensajeId\)\) return;/);
    assert.match(VIVO, /anotarMensaje\(fila\.conversation_id, fila\.id \?\? null, fila\.sender_id \?\? null\);/);
    assert.match(VIVO, /mensajeDelPush = anotarMensaje;/);
    // La memoria de lo anunciado tiene tope.
    assert.match(VIVO, /if \(anunciados\.size > MENSAJES_RECORDADOS\)/);
    // Lo demás sigue agrupándose por clave en la cola.
    assert.match(VIVO, /clave: claveDeConversacion\(id\)/);
    assert.match(PUSH, /clave: claveDelPush\(data\)/);
  });

  it('el servidor manda el identificador del mensaje, que es lo que los une', () => {
    const avisos = readFileSync(
      join(SRC, '..', '..', 'api', 'app', 'modules', 'messaging', 'avisos.py'),
      'utf8',
    );
    assert.match(avisos, /"messageId": message_id/);
  });

  it('sin saber quién soy no se anuncia un mensaje: podría ser mío', () => {
    assert.match(VIVO, /if \(!fila\.conversation_id \|\| yo === null \|\| fila\.sender_id === yo\) return;/);
    assert.match(VIVO, /\.catch\(\(\) => \{/, 'averiguar la sesión no puede reventar el hook');
  });

  it('al volver a la aplicación se pone al día SIN anunciar: eso ya lo avisó el sistema', () => {
    const alVolver = VIVO.slice(VIVO.indexOf("AppState.addEventListener('change'"));
    assert.match(alVolver.slice(0, 300), /void mirarAvisos\(true\);/);
    // Y lo mismo tras un push recibido con la aplicación abierta.
    assert.match(VIVO, /ponerseAlDia = \(\) => \{\s*void mirarAvisos\(true\);/);
    // Callado solo fija la marca.
    assert.match(VIVO, /queAnunciar\(avisos, callado \? null : marca\)/);
  });

  it('si hay algo nuevo lo dice el servidor, no una resta con un contador que escriben otros', () => {
    /*
      LO REPORTADO (04/10/2026): «no llegó ninguna notificación cuando un
      usuario me agendó una sesión». Se decidía con «la cuenta de ahora es
      mayor que la de antes», y la de antes se leía del contador común, que
      también refrescan otras pantallas. Ya no se lee ninguna cuenta anterior.
    */
    const leer = VIVO.slice(VIVO.indexOf('const leerAvisos'), VIVO.indexOf('const mirarMensajes'));
    assert.ok(!/getState\(\)\.notificaciones/.test(leer), 'se sigue comparando con el contador común');
    assert.ok(!/cuenta <= antes/.test(leer));
    assert.match(leer, /await refrescarNotificaciones\(desdeCuandoPreguntar\(marca\)\)/);
    assert.match(leer, /if \(!hayQueLeerLaBandeja\(\{ primera, callado, \.\.\.lectura \}\)\) return;/);
    assert.ok(!/cuentaAnterior/.test(VIVO));
  });

  it('las lecturas no se solapan: dos a la vez anunciarían lo mismo', () => {
    assert.match(
      VIVO,
      /lecturaEnCurso = lecturaEnCurso\.then\(\(\) => leerAvisos\(callado\)\)\.catch\(\(\) => \{\}\);/,
    );
  });

  it('un mensaje adelanta la pregunta por los avisos, y el de una sesión no se anuncia dos veces', () => {
    const mensajes = VIVO.slice(VIVO.indexOf('const mirarMensajes'), VIVO.indexOf('const anotarMensaje'));
    // Los avisos se miran A LA VEZ que los mensajes, y con tope: si la bandeja
    // tarda, el mensaje se anuncia igual.
    assert.match(mensajes, /await Promise\.all\(\[\s*Promise\.race\(\[\s*mirarAvisos\(\),/);
    assert.match(mensajes, /setTimeout\(listo, ESPERA_POR_LOS_AVISOS_MS\)/);
    assert.match(mensajes, /refrescarMensajes\(\),\s*\]\);/);
    // El silencio CALLA UN MENSAJE, no a la persona: se gasta al usarlo, y lo
    // siguiente que escriba —«nos vemos el martes»— sí da su aviso.
    assert.match(
      mensajes,
      /if \(remitente && \(conAvisoDeSesion\.get\(remitente\) \?\? 0\) > ahora\) \{\s*conAvisoDeSesion\.delete\(remitente\);\s*continue;\s*\}/,
    );
    // El remitente sale de la fila que entrega el tiempo real.
    assert.match(VIVO, /anotarMensaje\(fila\.conversation_id, fila\.id \?\? null, fila\.sender_id \?\? null\);/);
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

describe('que el teléfono quede registrado para el push', () => {
  const SERVICIO = sinComentarios(fuente('services/notifications.ts'));
  const EN_VIVO = sinComentarios(fuente('hooks/useAvisosEnVivo.ts'));

  it('el registro se reintenta al volver a la aplicación', () => {
    // Se intentaba UNA vez, al entrar. Sin cobertura en ese momento, o con el
    // permiso concedido después desde los ajustes, no había push hasta cerrar
    // la aplicación del todo y volver a abrirla.
    assert.match(SERVICIO, /export async function asegurarRegistroDePush\(\): Promise<void>/);
    const alVolver = EN_VIVO.slice(EN_VIVO.indexOf("AppState.addEventListener('change'"));
    assert.match(alVolver, /void asegurarRegistroDePush\(\);/);
  });

  it('el reintento NO vuelve a preguntar por el permiso', () => {
    const reintento = SERVICIO.slice(SERVICIO.indexOf('export async function asegurarRegistroDePush'));
    const cuerpo = reintento.slice(0, reintento.indexOf('\n}\n'));
    assert.match(cuerpo, /const permiso = await Notifications\.getPermissionsAsync\(\);/);
    assert.match(cuerpo, /if \(!permiso\.granted\) return;/);
    assert.ok(!/requestPermissionsAsync/.test(cuerpo), 'insistir con el diálogo acaba en un «no» para siempre');
    // Y ya registrado, o en web, no hace nada.
    assert.match(cuerpo, /if \(registrado \|\| Platform\.OS === 'web' \|\| !Device\.isDevice\) return;/);
  });

  it('solo se da por registrado cuando el token quedó guardado', () => {
    const registro = SERVICIO.slice(
      SERVICIO.indexOf('export async function registerForPush'),
      SERVICIO.indexOf('export async function asegurarRegistroDePush'),
    );
    const fallo = registro.indexOf("console.warn('[push] no se pudo guardar el token:'");
    const hecho = registro.indexOf('registrado = true;');
    assert.ok(fallo > 0 && hecho > fallo, 'se marca después de comprobar que guardar no falló');
  });

  it('al cerrar sesión, la cuenta siguiente vuelve a registrarse', () => {
    const baja = SERVICIO.slice(SERVICIO.indexOf('export async function unregisterPush'));
    assert.match(baja.slice(0, 200), /registrado = false;/);
  });

  it('los avisos se miran cada medio minuto, no cada minuto', () => {
    // Todo lo que no es un mensaje —una sesión pedida, un seguidor— depende de
    // esta pregunta mientras no llegue el push: en web, siempre.
    assert.match(EN_VIVO, /const CADA_MS = 30_000;/);
    // Y solo en primer plano: en segundo plano no se pregunta.
    assert.match(EN_VIVO, /if \(AppState\.currentState === 'active'\) void mirarAvisos\(\);/);
  });
});

describe('si hay algo nuevo que anunciar lo dice el servidor', () => {
  it('lo reportado: había avisos sin leer, llega uno más y OTRA pantalla refresca antes', () => {
    // Con la resta de cuentas, aquí «2 no es más que 2» y no se anunciaba.
    // Ahora no entra ninguna cuenta anterior: hay 1 posterior a la marca.
    assert.equal(hayQueLeerLaBandeja({ primera: false, callado: false, cuenta: 2, nuevos: 1 }), true);
  });

  it('abrir la bandeja (cuenta a cero) y que llegue uno: también se anuncia', () => {
    assert.equal(hayQueLeerLaBandeja({ primera: false, callado: false, cuenta: 1, nuevos: 1 }), true);
  });

  it('sin nada posterior a la marca no se pide la bandeja, haya lo que haya sin leer', () => {
    assert.equal(hayQueLeerLaBandeja({ primera: false, callado: false, cuenta: 7, nuevos: 0 }), false);
    assert.equal(hayQueLeerLaBandeja({ primera: false, callado: false, cuenta: 0, nuevos: 0 }), false);
  });

  it('la primera vez y al ponerse al día se pide siempre: hay que fijar la marca', () => {
    assert.equal(hayQueLeerLaBandeja({ primera: true, callado: false, cuenta: 0, nuevos: null }), true);
    assert.equal(hayQueLeerLaBandeja({ primera: false, callado: true, cuenta: 0, nuevos: 0 }), true);
  });

  it('un servidor que todavía no dice cuántos son nuevos no se toma por «ninguno»', () => {
    // Una lectura de más es mejor que un aviso de menos.
    assert.equal(hayQueLeerLaBandeja({ primera: false, callado: false, cuenta: 3, nuevos: null }), true);
    assert.equal(hayQueLeerLaBandeja({ primera: false, callado: false, cuenta: 0, nuevos: null }), false);
  });

  it('se pregunta desde un milisegundo después de lo último visto', () => {
    assert.equal(desdeCuandoPreguntar(null), null);
    assert.equal(desdeCuandoPreguntar(0), null);
    assert.equal(desdeCuandoPreguntar(Number.NaN), null);
    const marca = Date.parse('2026-10-04T21:41:00.123Z');
    // El aviso de las …00.123456 fijó la marca en …00.123: preguntar desde
    // …00.123 lo devolvería como nuevo en cada vuelta.
    assert.equal(desdeCuandoPreguntar(marca), '2026-10-04T21:41:00.124Z');
  });

  it('con la marca que deja `queAnunciar`, el aviso que la fijó ya no cuenta como nuevo', () => {
    const avisos = [{ id: 'a1', createdAtIso: '2026-10-04T21:41:00.123456+00:00', read: false }];
    const { marca } = queAnunciar(avisos, null);
    const desde = Date.parse(desdeCuandoPreguntar(marca)!);
    // El servidor compara con microsegundos: …00.123456 no es posterior a …00.124.
    assert.ok(Date.parse('2026-10-04T21:41:00.123Z') < desde);
  });
});

describe('un hecho, un aviso: la sesión que también deja un mensaje', () => {
  const T0 = Date.parse('2026-10-04T21:40:00.000Z');
  const sesion = (id: string, actorId: string, iso: string) => ({
    id,
    createdAtIso: iso,
    read: false,
    entityType: 'booking',
    actorId,
  });

  it('quien acaba de pedir una sesión queda anotado: su mensaje no da otro aviso', () => {
    const avisos = [sesion('a1', 'katy', '2026-10-04T21:41:00.000Z')];
    assert.deepEqual(actoresDeSesionNuevos(avisos, T0), ['katy']);
  });

  it('un aviso de sesión de antes de la marca no calla nada', () => {
    const avisos = [sesion('a1', 'katy', '2026-10-04T21:30:00.000Z')];
    assert.deepEqual(actoresDeSesionNuevos(avisos, T0), []);
  });

  it('lo que no es de la agenda no calla mensajes', () => {
    const avisos = [
      { id: 'a1', createdAtIso: '2026-10-04T21:41:00.000Z', read: false, entityType: 'post', actorId: 'katy' },
      { id: 'a2', createdAtIso: '2026-10-04T21:41:00.000Z', read: false, entityType: 'booking' },
    ];
    assert.deepEqual(actoresDeSesionNuevos(avisos, T0), []);
  });

  it('al arrancar, sin marca, no se calla nada', () => {
    assert.deepEqual(actoresDeSesionNuevos([sesion('a1', 'katy', '2026-10-04T21:41:00.000Z')], null), []);
  });

  it('cada persona una vez, aunque haya pedido y cancelado seguido', () => {
    const avisos = [
      sesion('a1', 'katy', '2026-10-04T21:41:00.000Z'),
      sesion('a2', 'katy', '2026-10-04T21:41:30.000Z'),
      sesion('a3', 'luis', '2026-10-04T21:42:00.000Z'),
    ];
    assert.deepEqual(actoresDeSesionNuevos(avisos, T0).sort(), ['katy', 'luis']);
  });

  it('el silencio dura lo justo: cubre la llegada del mensaje, no la conversación que siga', () => {
    assert.ok(SILENCIO_TRAS_UN_AVISO_DE_SESION_MS >= 5_000);
    assert.ok(SILENCIO_TRAS_UN_AVISO_DE_SESION_MS <= 30_000);
  });
});

describe('el push de una sesión, con la aplicación abierta, no da un segundo aviso', () => {
  /*
    Encontrado en la revisión independiente (04/10/2026): el mensaje que la
    sesión deja en el chat adelanta la lectura de la bandeja y anuncia; el push
    llegaba un instante después y se pintaba otra vez, con otra clave.
  */
  const VIVO = fuente('hooks/useAvisosEnVivo.ts');
  const PUSH = fuente('hooks/useAvisosDelPush.native.ts');

  it('se reconoce por su tipo', async () => {
    const { esPushDeSesion } = await import('./rutaDelPush.ts');
    assert.equal(esPushDeSesion({ type: 'booking', id: 'x' }), true);
    assert.equal(esPushDeSesion({ type: 'message', conversationId: 'x' }), false);
    assert.equal(esPushDeSesion({ type: 'follow' }), false);
    assert.equal(esPushDeSesion(null), false);
    assert.equal(esPushDeSesion('booking'), false);
    assert.equal(esPushDeSesion(undefined), false);
  });

  it('el oyente del push no lo pinta: lo entrega a la lectura de la bandeja', () => {
    const entrega = PUSH.indexOf('if (esPushDeSesion(data) && alRecibirUnPushDeSesion()) return;');
    const pintado = PUSH.indexOf('avisar({');
    assert.ok(entrega !== -1, 'el push de una sesión no se entrega');
    assert.ok(entrega < pintado, 'se pinta antes de entregarlo');
  });

  it('y allí se ANUNCIA (no callado): cada aviso sale una vez, llegue antes quien llegue', () => {
    assert.match(VIVO, /sesionDelPush = \(\) => \{\s*void mirarAvisos\(\);\s*void refrescarMensajes\(\);\s*\};/);
    // Sin nadie escuchando, el oyente del push lo enseña por su cuenta.
    assert.match(VIVO, /if \(!sesionDelPush\) return false;/);
    // Y se suelta al desmontar.
    assert.match(VIVO.slice(VIVO.lastIndexOf('return () => {')), /sesionDelPush = null;/);
  });
});
