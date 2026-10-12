import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  adjuntosDe,
  columnasDeRejilla,
  direccionesDe,
  duracionLegible,
  enFilasDe,
  nombreDeSitio,
  sitioDe,
  teselasDe,
} from './contenidoDeChat.ts';

/*
  El contenido compartido de un chat, como en Telegram (11/10/2026): pestañas
  «Miembros», «Media», «Enlaces»…, fotos y vídeos juntos en una cuadrícula, y
  el menú del chat con silenciar, buscar, vaciar y salir.

  Lo esencial: la cuadrícula no pierde ni repite nada, no se ofrece una pestaña
  ni un botón que no vaya a hacer algo, y silenciar o vaciar son de quien lo
  pide.
*/

const leer = (ruta: string) =>
  readFileSync(new URL(ruta, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const adjunto = (id: string, kind: string) => ({ id, kind });
const MENSAJES = [
  { id: 'm1', adjuntos: [adjunto('a1', 'image'), adjunto('a2', 'image')] },
  { id: 'm2', adjuntos: [adjunto('a3', 'video')] },
  { id: 'm3', adjuntos: [adjunto('a4', 'image'), adjunto('a5', 'video'), adjunto('a6', 'document')] },
  { id: 'm4', adjuntos: [adjunto('a7', 'audio')] },
  { id: 'm5', adjuntos: [] },
];

test('la cuadrícula: una tesela por foto o vídeo, en su orden y con su mensaje', () => {
  const teselas = teselasDe(MENSAJES);
  // Un mensaje con dos fotos son dos teselas; el documento y el audio no entran.
  assert.deepEqual(teselas.map((t) => t.adjunto.id), ['a1', 'a2', 'a3', 'a4', 'a5']);
  assert.deepEqual(teselas.map((t) => t.mensaje.id), ['m1', 'm1', 'm2', 'm3', 'm3']);
  // La clave no se repite aunque dos mensajes compartieran identificador de adjunto.
  assert.equal(new Set(teselas.map((t) => t.clave)).size, teselas.length);
  assert.deepEqual(teselasDe([]), []);
});

test('dentro de «Media» se puede ver solo fotos o solo vídeos', () => {
  // Hace falta aunque el servidor ya filtre: el mensaje con foto Y vídeo
  // llega entero a las dos vistas.
  assert.deepEqual(teselasDe(MENSAJES, 'image').map((t) => t.adjunto.id), ['a1', 'a2', 'a4']);
  assert.deepEqual(teselasDe(MENSAJES, 'video').map((t) => t.adjunto.id), ['a3', 'a5']);
  assert.deepEqual(teselasDe(MENSAJES, 'todo').length, 5);
});

test('archivos y audios: uno por fila, con su mensaje', () => {
  assert.deepEqual(adjuntosDe(MENSAJES, 'document').map((t) => `${t.mensaje.id}:${t.adjunto.id}`), ['m3:a6']);
  assert.deepEqual(adjuntosDe(MENSAJES, 'audio').map((t) => t.adjunto.id), ['a7']);
  assert.deepEqual(adjuntosDe(MENSAJES, 'gif'), []);
});

test('partir en filas no pierde nada, y la última puede quedar corta', () => {
  const lista = [1, 2, 3, 4, 5, 6, 7];
  assert.deepEqual(enFilasDe(lista, 3), [[1, 2, 3], [4, 5, 6], [7]]);
  assert.deepEqual(enFilasDe(lista, 3).flat(), lista);
  assert.deepEqual(enFilasDe([], 3), []);
  // Un número de columnas absurdo no deja la lista sin pintar.
  assert.deepEqual(enFilasDe([1, 2], 0), [[1], [2]]);
  assert.deepEqual(enFilasDe([1, 2], Number.NaN).flat(), [1, 2]);
});

test('tres teselas por fila en un teléfono, y más cuando hay sitio', () => {
  assert.equal(columnasDeRejilla(360), 3);
  assert.equal(columnasDeRejilla(430), 3);
  assert.equal(columnasDeRejilla(600), 4);
  assert.equal(columnasDeRejilla(800), 5);
  assert.equal(columnasDeRejilla(1280), 6);
  for (const raro of [0, -1, Number.NaN]) assert.equal(columnasDeRejilla(raro), 3);
});

test('la duración de un vídeo se escribe como en un reloj, o no se escribe', () => {
  assert.equal(duracionLegible(3), '0:03');
  assert.equal(duracionLegible(75), '1:15');
  assert.equal(duracionLegible(59.6), '1:00');
  assert.equal(duracionLegible(3725), '1:02:05');
  // Sin dato no se inventa un «0:00».
  for (const nada of [null, undefined, 0, -4, Number.NaN]) assert.equal(duracionLegible(nada), '');
});

test('el sitio de un enlace sale de su dirección', () => {
  assert.equal(sitioDe('https://m.shein.com/pe/Women-s-Autumn?a=1'), 'shein.com');
  assert.equal(sitioDe('https://www.youtube.com/watch?v=x'), 'youtube.com');
  assert.equal(sitioDe('docs.google.com/document/d/1'), 'docs.google.com');
  assert.equal(sitioDe('http://usuario:clave@minedu.gob.pe:8080/ruta'), 'minedu.gob.pe');
  assert.equal(sitioDe('HTTPS://Z.PE'), 'z.pe');
  for (const raro of ['', '   ', null, undefined, 'https://', 'hola mundo']) {
    assert.equal(sitioDe(raro), '', String(raro));
  }
});

test('el nombre de un sitio es el que la gente reconoce', () => {
  assert.equal(nombreDeSitio('shein.com'), 'Shein');
  assert.equal(nombreDeSitio('docs.google.com'), 'Google');
  assert.equal(nombreDeSitio('minedu.gob.pe'), 'Minedu');
  assert.equal(nombreDeSitio('bbc.co.uk'), 'Bbc');
  assert.equal(nombreDeSitio('z.pe'), 'Z');
  assert.equal(nombreDeSitio('localhost'), 'Localhost');
  // Una dirección numérica no tiene nombre: se enseña tal cual.
  assert.equal(nombreDeSitio('192.168.1.10'), '192.168.1.10');
  assert.equal(nombreDeSitio(''), '');
});

test('las direcciones de un mensaje: en su orden y sin repetir', () => {
  const trozos = [
    { tipo: 'texto', texto: 'Mira ' },
    { tipo: 'enlace', texto: 'z.pe/a', direccion: 'https://z.pe/a' },
    { tipo: 'texto', texto: ' y ' },
    { tipo: 'enlace', texto: 'https://z.pe/b', direccion: 'https://z.pe/b' },
    { tipo: 'enlace', texto: 'z.pe/a', direccion: 'https://z.pe/a' },
  ];
  assert.deepEqual(direccionesDe(trozos), ['https://z.pe/a', 'https://z.pe/b']);
  assert.deepEqual(direccionesDe([{ tipo: 'texto', texto: 'sin enlaces' }]), []);
});

// --------------------------------------------------------------------------
// Las pantallas
// --------------------------------------------------------------------------

test('la ficha del grupo es una sola lista: cabecera, pestañas y contenido', () => {
  const ficha = leer('../screens/GrupoScreen.tsx');
  assert.match(ficha, /<PestanasDeContenido\s+conversationId=\{conversationId\}/);
  // «Miembros» es la primera pestaña, y las demás salen del contenido.
  assert.match(ficha, /primera=\{\{ clave: 'miembros', etiqueta: t\('groups\.members'\), contenido: miembros \}\}/);
  // La pantalla de un chat de dos usa el MISMO componente, sin pestaña propia.
  const contenido = leer('../screens/ContenidoDeChatScreen.tsx');
  assert.match(contenido, /<PestanasDeContenido conversationId=\{conversationId\} nombreDelChat=\{nombre\} \/>/);
});

test('las pestañas salen del servidor, y «Media» pinta por filas de teselas', () => {
  const pestanas = leer('../components/chat/PestanasDeContenido.tsx');
  assert.match(pestanas, /seccionesDeContenido\(vistas, elegida\)/);
  assert.match(pestanas, /enFilasDe\(teselasDe\(mensajes, soloVigente\), columnas\)/);
  // El filtro de dentro de «Media» solo se ofrece cuando hay de las dos cosas.
  assert.match(pestanas, /seccion\?\.tipo === 'media' && opciones\.length > 0 \?/);
  // Lo elegido deja de valer si ya no se ofrece: no se queda en una vista vacía.
  assert.match(pestanas, /opciones\.includes\(solo\) \? solo : opciones\[0\] \?\? 'todo'/);
  // Una sola lista y sin columnas: cambiar de pestaña no la desmonta.
  assert.equal((pestanas.match(/<FlatList/g) ?? []).length, 1);
  assert.doesNotMatch(pestanas, /numColumns/);
  // Y si la pestaña abierta desaparece —se borró su filtro— se cae a la primera.
  assert.match(pestanas, /: primera\?\.clave \?\? secciones\[0\]\?\.clave \?\? null;/);
});

test('las tres acciones de la ficha: escribir, silenciar y salir (o editar)', () => {
  const ficha = leer('../screens/GrupoScreen.tsx');
  assert.match(ficha, /clave: 'mensaje', icono: 'message-circle'/);
  // «Silenciar» solo si el servidor sabe silenciar: nunca un botón muerto.
  assert.match(ficha, /\.\.\.\(funciones\.preferencias\s*\? \[\s*\{\s*clave: 'silencio',/);
  // Volver al chat que está debajo, no apilar otro.
  assert.match(ficha, /router\.dismissTo\(\{ pathname: '\/chat\/\[id\]', params: \{ id: conversationId, name: info\.titulo \} \}\)/);
});

test('el menú del chat: cada fila hace algo, y solo sale lo que el servidor tiene', () => {
  const chat = leer('../screens/ChatScreen.tsx');
  const menu = chat.slice(
    chat.indexOf('<BottomSheet visible={opcionesAbiertas}'),
    chat.indexOf('<HojaDeFondoDeChat'),
  );
  assert.ok(menu.length > 0);
  // Buscar y el fondo no necesitan nada del servidor; silenciar y vaciar, sí.
  assert.match(menu, /title=\{t\('chatMenu\.search'\)\}/);
  assert.match(menu, /title=\{t\('chatBackground\.title'\)\}/);
  assert.equal((menu.match(/\{funciones\.preferencias \? \(/g) ?? []).length, 2);
  // Salir, solo de un grupo que no se administra.
  assert.match(menu, /\{esGrupo && infoDeConversacion && !infoDeConversacion\.puedoAdministrar \? \(/);
  // Cada fila tiene su acción.
  assert.equal((menu.match(/<ListRow/g) ?? []).length, (menu.match(/onPress=\{\(\) => void /g) ?? []).length);
});

test('vaciar pregunta antes, dice lo que no hace y vuelve a pedir el historial', () => {
  const chat = leer('../screens/ChatScreen.tsx');
  const vaciar = chat.slice(chat.indexOf('const vaciarElChat = async'), chat.indexOf('const salirDelGrupo = async'));
  assert.match(vaciar, /await trasElMenu\(\);\s*const seguro = await confirm\(\{/);
  assert.match(vaciar, /destructive: true/);
  assert.match(vaciar, /if \(!seguro\) return;/);
  assert.ok(vaciar.indexOf('if (!seguro) return;') < vaciar.indexOf('MessageRepository.vaciar(params.id)'));
  // Lo que había en pantalla se quita y se pregunta de nuevo al servidor.
  assert.match(vaciar, /setRemoteMessages\(\[\]\);\s*setIntentoDeCarga\(\(n\) => n \+ 1\);/);
  // El texto dice que a los demás no les borra nada, en los tres idiomas.
  for (const idioma of ['es', 'en', 'pt']) {
    const diccionario = leer(`../i18n/${idioma}.ts`);
    for (const clave of ['chatMenu.clearBody', 'chatMenu.clearBodyGroup']) {
      assert.match(diccionario, new RegExp(`'${clave.replace('.', '\\.')}': '[^']{40,}'`), `${idioma} ${clave}`);
    }
  }
});

test('silenciar y vaciar son de quien lo pide: la petición no nombra a nadie', () => {
  const repositorio = leer('../repositories/MessageRepository.ts');
  const silenciar = repositorio.slice(repositorio.indexOf('async silenciar('), repositorio.indexOf('async vaciar('));
  assert.match(silenciar, /method: silenciada \? 'PUT' : 'DELETE'/);
  assert.doesNotMatch(silenciar, /body:/);
  const vaciar = repositorio.slice(repositorio.indexOf('async vaciar('), repositorio.indexOf('async vaciar(') + 300);
  assert.match(vaciar, /\/clear`, \{\s*method: 'POST',\s*\}/);
  assert.doesNotMatch(vaciar, /body:/);
  // Es lo mismo que espera el servidor.
  const servidor = leer('../../../api/app/modules/messaging/preferencias.py');
  assert.match(servidor, /@router\.put\("\/\{conversation_id\}\/mute"/);
  assert.match(servidor, /@router\.delete\("\/\{conversation_id\}\/mute"/);
  assert.match(servidor, /@router\.post\("\/\{conversation_id\}\/clear"/);
});

test('un chat silenciado no avisa dentro de la aplicación, y se nota que lo está', () => {
  const avisos = leer('../hooks/useAvisosEnVivo.ts');
  assert.match(avisos, /if \(conversacion\.silenciada\) return;\s*avisar\(\{/);
  assert.match(avisos, /lista\.filter\(\(conversacion\) => !conversacion\.silenciada\)/);
  // La bandeja y la cabecera del chat lo dicen con una campana tachada.
  assert.match(leer('../components/FilaDeConversacion.tsx'), /\{conversacion\.silenciada \? \(\s*<Feather\s*name="bell-off"/);
  assert.match(leer('../components/CabeceraDeChat.tsx'), /const campana = silenciada \? \(\s*<Feather\s*name="bell-off"/);
  // Solo un `true` del servidor lo marca.
  assert.match(leer('../mappers/messageMapper.ts'), /silenciada: dto\.muted === true/);
  assert.match(leer('./gruposDeChat.ts'), /silenciada: bruto\.muted === true/);
});

test('buscar pregunta al servidor, y solo cuando hay algo que buscar', () => {
  const buscar = leer('../screens/BuscarEnChatScreen.tsx');
  assert.match(buscar, /hayBusqueda \? VISTA_TODO : null/);
  assert.match(buscar, /const hayBusqueda = buscar\.length >= MIN_LETRAS;/);
  assert.doesNotMatch(buscar, /mensajes\.filter\(/);
  // La ruta existe.
  assert.match(leer('../../app/chat/buscar/[id].tsx'), /BuscarEnChatScreen/);
  assert.match(leer('../../app/chat/ajustes-de-grupo/[id].tsx'), /AjustesDeGrupoScreen/);
});
