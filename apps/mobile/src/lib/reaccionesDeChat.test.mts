import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { es } from '../i18n/es.ts';
import {
  MAX_CONSULTA_DE_REACCIONES,
  alReaccionar,
  aplicarReacciones,
  leerCita,
  leerConsultaDeReacciones,
  leerReacciones,
  miReaccion,
  textoDeCita,
  type CitaDeMensaje,
  type ReaccionDeMensaje,
} from './reaccionesDeChat.ts';

/*
  Reaccionar a un mensaje y responder a uno concreto (10/10/2026). Lo esencial:
  cada persona tiene UNA reacción por mensaje, lo que se pinta al tocar se
  corrige con lo que diga el servidor, el texto de un mensaje borrado no sale
  en una cita, y el aviso de «alguien reaccionó» no transporta nada.
*/

const leer = (ruta: string) =>
  readFileSync(new URL(ruta, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const r = (emoji: string, cuantos: number, mia = false): ReaccionDeMensaje => ({
  emoji,
  cuantos,
  mia,
});

// --------------------------------------------------------------------------
// Leer lo que manda el servidor
// --------------------------------------------------------------------------

test('las reacciones se leen agrupadas y se descarta lo que no lo sea', () => {
  assert.deepEqual(
    leerReacciones([
      { emoji: '❤️', count: 3, mine: true },
      { emoji: '👍', count: 1, mine: false },
    ]),
    [r('❤️', 3, true), r('👍', 1)],
  );
  // Ni una lista, ni filas rotas, ni reacciones que nadie ha puesto.
  assert.deepEqual(leerReacciones(null), []);
  assert.deepEqual(leerReacciones({ emoji: '👍', count: 1 }), []);
  assert.deepEqual(
    leerReacciones([null, 'x', { emoji: '', count: 2 }, { emoji: '👍', count: 0 }, { count: 4 }]),
    [],
  );
  // `mine` solo vale si es `true`: un «1» o un «sí» no marcan la reacción como propia.
  assert.equal(leerReacciones([{ emoji: '👍', count: 2, mine: 1 }])[0]?.mia, false);
  // Un recuento con decimales o en texto no rompe la burbuja.
  assert.equal(leerReacciones([{ emoji: '👍', count: 2.9 }])[0]?.cuantos, 2);
  assert.deepEqual(leerReacciones([{ emoji: '👍', count: '3' }]), []);
});

test('una cita se lee con su autor, su extracto y de qué era', () => {
  assert.deepEqual(
    leerCita({
      id: 'm1',
      sender_id: 'u1',
      sender_name: '  Ana  ',
      excerpt: 'nos vemos a las 5',
      kind: 'image',
      deleted: false,
    }),
    {
      id: 'm1',
      autorId: 'u1',
      autor: 'Ana',
      extracto: 'nos vemos a las 5',
      tipo: 'image',
      eliminado: false,
    },
  );
  // Sin cita, o con algo que no lo es, no hay nada que pintar.
  assert.equal(leerCita(null), undefined);
  assert.equal(leerCita({ excerpt: 'sin id' }), undefined);
  assert.equal(leerCita([{ id: 'm1' }]), undefined);
  // Un tipo que la aplicación no conoce se queda en «mensaje», no rompe.
  assert.equal(leerCita({ id: 'm1', kind: 'holograma' })?.tipo, null);
});

test('el texto de un mensaje borrado no sale en la cita aunque llegara', () => {
  const cita = leerCita({
    id: 'm1',
    sender_id: 'u1',
    sender_name: 'Ana',
    excerpt: 'esto ya no debería verse',
    kind: 'image',
    deleted: true,
  });
  assert.equal(cita?.eliminado, true);
  assert.equal(cita?.extracto, '');
  assert.equal(cita?.tipo, null);
  assert.deepEqual(textoDeCita(cita as CitaDeMensaje), { clave: 'chat.deletedMessage' });
});

test('una cita enseña su texto y, si no tenía, de qué era', () => {
  const base: CitaDeMensaje = {
    id: 'm1',
    autorId: 'u1',
    autor: 'Ana',
    extracto: '',
    tipo: null,
    eliminado: false,
  };
  assert.deepEqual(textoDeCita({ ...base, extracto: 'hola', tipo: 'image' }), { texto: 'hola' });
  assert.deepEqual(textoDeCita({ ...base, tipo: 'image' }), { clave: 'chat.replyPhoto' });
  assert.deepEqual(textoDeCita({ ...base, tipo: 'video' }), { clave: 'chat.replyVideo' });
  assert.deepEqual(textoDeCita({ ...base, tipo: 'audio' }), { clave: 'chat.replyAudio' });
  assert.deepEqual(textoDeCita({ ...base, tipo: 'document' }), { clave: 'chat.replyFile' });
  assert.deepEqual(textoDeCita(base), { clave: 'chat.replyMessage' });
});

test('toda clave que puede salir de una cita está en el diccionario', () => {
  // La pantalla las traduce con un `as`: TypeScript no avisaría si faltara una
  // y en la burbuja se pintaría la clave cruda.
  const fuente = leer('./reaccionesDeChat.ts');
  const claves = [...fuente.matchAll(/clave: '([\w.]+)'/g)].map((casa) => casa[1] as string);
  assert.equal(claves.length, 6);
  for (const clave of claves) assert.ok(clave in es, clave);
});

// --------------------------------------------------------------------------
// Pintar el toque antes de que conteste el servidor
// --------------------------------------------------------------------------

test('poner una reacción la suma, y cada persona tiene UNA por mensaje', () => {
  // La primera de todas.
  assert.deepEqual(alReaccionar([], '👍'), [r('👍', 1, true)]);
  // A una que ya habían puesto otros.
  assert.deepEqual(alReaccionar([r('👍', 2)], '👍'), [r('👍', 3, true)]);
  // Cambiarla quita la anterior: nunca quedan dos mías.
  const cambiada = alReaccionar([r('👍', 3, true), r('❤️', 1)], '❤️');
  assert.deepEqual(cambiada, [r('👍', 2), r('❤️', 2, true)]);
  assert.equal(cambiada.filter((x) => x.mia).length, 1);
  // Si la anterior era solo mía, desaparece en vez de quedarse a cero.
  assert.deepEqual(alReaccionar([r('👍', 1, true)], '😂'), [r('😂', 1, true)]);
});

test('quitar la reacción resta la propia y no toca las de los demás', () => {
  assert.deepEqual(alReaccionar([r('👍', 3, true), r('❤️', 1)], null), [r('👍', 2), r('❤️', 1)]);
  assert.deepEqual(alReaccionar([r('👍', 1, true)], null), []);
  // Quien no había reaccionado no quita nada.
  assert.deepEqual(alReaccionar([r('👍', 2)], null), [r('👍', 2)]);
});

test('reaccionar no altera la lista que se le pasa', () => {
  // De esa lista sale la vuelta atrás cuando el servidor rechaza la reacción.
  const antes = [r('👍', 1, true), r('❤️', 2)];
  const copia = JSON.parse(JSON.stringify(antes));
  alReaccionar(antes, '❤️');
  alReaccionar(antes, null);
  assert.deepEqual(antes, copia);
});

test('se sabe cuál es la reacción de quien mira', () => {
  assert.equal(miReaccion([r('👍', 2), r('❤️', 1, true)]), '❤️');
  assert.equal(miReaccion([r('👍', 2)]), null);
  assert.equal(miReaccion(undefined), null);
});

// --------------------------------------------------------------------------
// Ponerse al día cuando reacciona otra persona
// --------------------------------------------------------------------------

test('la consulta de reacciones se lee por mensaje y sin fiarse de nada', () => {
  assert.deepEqual(
    leerConsultaDeReacciones({
      reactions: {
        m1: [{ emoji: '👍', count: 2, mine: false }],
        m2: [],
        m3: 'roto',
      },
    }),
    { m1: [r('👍', 2)] },
  );
  assert.deepEqual(leerConsultaDeReacciones(null), {});
  assert.deepEqual(leerConsultaDeReacciones({ reactions: [] }), {});
});

test('al ponerse al día, un mensaje consultado que no vuelve se queda sin reacciones', () => {
  const mensajes = [
    { id: 'm1', reacciones: [r('👍', 1)] },
    { id: 'm2', reacciones: [r('❤️', 1, true)] },
    { id: 'm3', reacciones: [r('😂', 1)] },
  ];
  const salida = aplicarReacciones(mensajes, ['m1', 'm2'], { m1: [r('👍', 2)] });
  assert.deepEqual(salida[0]?.reacciones, [r('👍', 2)]);
  // Se preguntó por él y no vino: quien reaccionó la quitó.
  assert.deepEqual(salida[1]?.reacciones, []);
  // Por este no se preguntó, así que no se toca: ni siquiera se copia.
  assert.equal(salida[2], mensajes[2]);
});

test('una consulta sin novedades devuelve la MISMA lista para no repintar el chat', () => {
  const mensajes = [
    { id: 'm1', reacciones: [r('👍', 2, true)] },
    { id: 'm2' },
  ];
  assert.equal(aplicarReacciones(mensajes, ['m1', 'm2'], { m1: [r('👍', 2, true)] }), mensajes);
  // Que cambie solo de quién es ya cuenta como novedad.
  assert.notEqual(aplicarReacciones(mensajes, ['m1'], { m1: [r('👍', 2)] }), mensajes);
});

test('se pregunta por tantos mensajes como admite el servidor, no más', () => {
  assert.equal(MAX_CONSULTA_DE_REACCIONES, 100);
  const servidor = readFileSync(
    new URL('../../../api/app/modules/messaging/reacciones.py', import.meta.url),
    'utf8',
  );
  assert.match(servidor, /MAX_CONSULTA\s*=\s*100\b/);
  assert.match(leer('../screens/ChatScreen.tsx'), /\.slice\(-MAX_CONSULTA_DE_REACCIONES\)/);
});

// --------------------------------------------------------------------------
// Lo que se custodia en el código que no se puede ejecutar aquí
// --------------------------------------------------------------------------

test('el mensaje llega a la pantalla con sus reacciones y su cita', () => {
  const mapeador = leer('../mappers/messageMapper.ts');
  assert.match(mapeador, /reacciones: leerReacciones\(dto\.reactions\)/);
  assert.match(mapeador, /respuestaA: leerCita\(dto\.reply_to\)/);
});

test('responder manda a qué mensaje, y un mensaje normal no manda nada de eso', () => {
  const repositorio = leer('../repositories/MessageRepository.ts');
  assert.match(repositorio, /\.\.\.\(replyToId \? \{ reply_to_id: replyToId \} : \{\}\)/);
  // Poner es un PUT con el emoji; quitar, un DELETE sin cuerpo.
  assert.match(
    repositorio,
    /emoji \? \{ method: 'PUT', body: JSON\.stringify\(\{ emoji \}\) \} : \{ method: 'DELETE' \}/,
  );
  assert.match(repositorio, /reactions\/lookup/);
  assert.match(repositorio, /message_ids: messageIds/);
});

test('sin la migración, la aplicación no ofrece reaccionar ni responder', () => {
  const repositorio = leer('../repositories/MessageRepository.ts');
  // Solo un `true` del servidor las enciende; si no se sabe, apagadas.
  assert.match(repositorio, /reacciones: dto\.reactions === true/);
  assert.match(repositorio, /respuestasAHistorias: false, reacciones: false/);
  const pantalla = leer('../screens/ChatScreen.tsx');
  // El menú de un mensaje ajeno solo existe para reaccionar o responder.
  assert.match(pantalla, /const conAcciones = !item\.estado && \(mine \|\| funciones\.reacciones\)/);
  // Y eliminar sigue siendo solo de quien lo escribió.
  assert.match(pantalla, /accionesDe\?\.sender === 'me' \? \(\s*<ListRow\s+title=\{t\('common\.delete'\)\}/);
});

test('el aviso de que alguien reaccionó no transporta nada', () => {
  const tiempoReal = leer('../services/realtime.ts');
  const desde = tiempoReal.indexOf('export function avisosDeReacciones');
  assert.ok(desde > 0);
  const funcion = tiempoReal.slice(desde);
  // Ni quién, ni a qué mensaje, ni con qué: cualquiera puede escuchar el canal.
  assert.match(funcion, /event: 'reaccion', payload: \{\}/);
  // Todos en el mismo canal de la conversación, y sin oírse a uno mismo.
  assert.match(funcion, /`chat-reacciones:\$\{conversationId\}`/);
  assert.match(funcion, /broadcast: \{ self: false \}/);
  assert.match(funcion, /removeChannel\(channel\)/);
});

test('la reacción se pinta al tocar y se deshace si el servidor no la guarda', () => {
  const pantalla = leer('../screens/ChatScreen.tsx');
  const desde = pantalla.indexOf('const reaccionar = useCallback(');
  assert.ok(desde > 0);
  const funcion = pantalla.slice(desde, pantalla.indexOf('const textoDeLaCita', desde));
  const pintar = funcion.indexOf('poner(alReaccionar(antes, emoji))');
  const guardar = funcion.indexOf('await MessageRepository.reaccionar(');
  const deshacer = funcion.indexOf('poner(antes)');
  assert.ok(pintar > 0 && guardar > pintar, 'se pinta antes de esperar al servidor');
  assert.ok(deshacer > guardar, 'si falla, se vuelve a como estaba');
  // Lo definitivo es lo que contesta el servidor, y solo entonces se avisa.
  assert.match(funcion, /poner\(await MessageRepository\.reaccionar\(/);
  assert.ok(funcion.indexOf('avisosDeReaccion.current?.avisar()') > guardar);
  assert.ok(funcion.indexOf("t('chat.reactFailedTitle')") > deshacer);
  // A un mensaje sin enviar o eliminado no se reacciona.
  assert.match(funcion, /mensaje\.estado \|\| mensaje\.eliminado\) return/);
});

test('los avisos de reacciones se agrupan y solo se oyen si el servidor las conoce', () => {
  const pantalla = leer('../screens/ChatScreen.tsx');
  assert.match(
    pantalla,
    /if \(!supabaseEnabled \|\| !params\.id \|\| !funciones\.reacciones\) return;\s+let pendiente/,
  );
  // Una ráfaga de reacciones no dispara una consulta por cada una.
  assert.match(pantalla, /if \(pendiente\) return;\s+pendiente = setTimeout\(/);
  assert.match(pantalla, /if \(pendiente\) clearTimeout\(pendiente\);/);
  assert.match(pantalla, /canal\.cerrar\(\);/);
});

test('la respuesta se manda con el mensaje y deja de estar puesta al enviarlo', () => {
  const pantalla = leer('../screens/ChatScreen.tsx');
  assert.match(pantalla, /envio\.respondeA \?\? null,/);
  // La burbuja provisional ya enseña la cita, sin esperar al servidor.
  assert.match(pantalla, /respuestaA: envio\.cita,/);
  const desde = pantalla.indexOf('const submit = async () => {');
  const envio = pantalla.slice(desde, pantalla.indexOf('const reintentar', desde));
  assert.match(envio, /respondeA: respondiendoA\?\.id,/);
  assert.ok(envio.indexOf('setRespondiendoA(null)') < envio.indexOf('await mandar(envio)'));
  // Tocar la cita lleva al mensaje original.
  assert.match(pantalla, /onPress=\{\(\) => setMensajeBuscado\(item\.respuestaA\?\.id \?\? null\)\}/);
  // Y a uno mismo no se le dice «Respondiendo a Tú».
  assert.match(pantalla, /respondiendoA\.sender === 'me'\s+\? t\('chat\.replyingToYou'\)/);
});

test('desde la foto ampliada se puede responder y reaccionar', () => {
  const pantalla = leer('../screens/ChatScreen.tsx');
  assert.match(
    pantalla,
    /funciones\.reacciones && mensajeDelVisor && !mensajeDelVisor\.estado \? \(/,
  );
  assert.match(pantalla, /setRespondiendoA\(mensajeDelVisor\);\s+setFotoAmpliada\(null\);/);
  assert.match(pantalla, /REACCIONES_RAPIDAS\.slice\(0, 3\)\.map/);
});
