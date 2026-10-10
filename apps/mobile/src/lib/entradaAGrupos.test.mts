import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  accionDeTarjeta,
  claveDelFalloDeGrupo,
  colorDeAutor,
  esCodigoDeGrupo,
  leerAjustes,
  leerInfo,
  leerSolicitudes,
  leerTarjeta,
  leerTarjetas,
  miembroDe,
} from './gruposDeChat.ts';
import { rutaDelPush } from './rutaDelPush.ts';
import {
  MAX_EMOJI_DE_STICKER,
  PAQUETES_DE_STICKERS,
  REACCIONES_RAPIDAS,
  contarEmoji,
  esSticker,
} from './stickers.ts';
import {
  enlaceDeDescarga,
  esAudio,
  esHtml,
  extensionDe,
  tipoDeContenidoDe,
} from './tiposDeArchivo.ts';

/*
  Lo del 10/10/2026: cómo se entra a un grupo (foto, enlace, solicitudes),
  stickers, el visor con autor, el vídeo dentro de la aplicación y los tipos de
  archivo que el almacén rechazaba. Lo esencial: pedir entrar no es entrar, el
  código del enlace solo lo recibe quien administra, un sticker no rompe el
  chat en ningún teléfono, y un audio o un HTML se suben con su tipo.
*/

const leer = (ruta: string) =>
  readFileSync(new URL(ruta, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';

// --------------------------------------------------------------------------
// Tipos de archivo
// --------------------------------------------------------------------------

test('un audio sin tipo, o con uno genérico, se sube como audio', () => {
  // El fallo visto en teléfono: el almacén rechazaba estos tres.
  assert.equal(tipoDeContenidoDe(null, 'nota.opus'), 'audio/ogg');
  assert.equal(tipoDeContenidoDe('application/octet-stream', 'cancion.mp3'), 'audio/mpeg');
  assert.equal(tipoDeContenidoDe('application/ogg', 'PTT-20261010.opus'), 'audio/ogg');
  assert.equal(tipoDeContenidoDe('', 'voz.M4A'), 'audio/mp4');
  for (const nombre of ['a.mp3', 'a.m4a', 'a.aac', 'a.wav', 'a.ogg', 'a.opus', 'a.amr', 'a.flac']) {
    assert.ok(tipoDeContenidoDe(null, nombre).startsWith('audio/'), nombre);
    assert.equal(esAudio(null, nombre), true, nombre);
  }
});

test('el tipo que dice el teléfono se respeta cuando es concreto', () => {
  assert.equal(tipoDeContenidoDe('audio/x-m4a', 'voz.m4a'), 'audio/x-m4a');
  assert.equal(tipoDeContenidoDe('IMAGE/PNG', 'foto.jpg'), 'image/png');
  // Y lo que de verdad no se sabe qué es, sigue sin saberse.
  assert.equal(tipoDeContenidoDe(null, 'programa.exe'), 'application/octet-stream');
  assert.equal(tipoDeContenidoDe(null, 'sin_extension'), 'application/octet-stream');
  assert.equal(tipoDeContenidoDe(null, null), 'application/octet-stream');
});

test('un HTML se reconoce por su tipo o por su nombre', () => {
  assert.equal(tipoDeContenidoDe(null, 'pagina.html'), 'text/html');
  assert.equal(tipoDeContenidoDe('application/octet-stream', 'INDEX.HTM'), 'text/html');
  assert.equal(esHtml('text/html; charset=utf-8', 'x'), true);
  assert.equal(esHtml(null, 'informe.html'), true);
  assert.equal(esHtml('application/pdf', 'informe.pdf'), false);
  assert.equal(esHtml(null, 'html'), false);
});

test('la extensión se lee sin fiarse del nombre', () => {
  assert.equal(extensionDe('Informe.Final.PDF'), 'pdf');
  assert.equal(extensionDe('archivo.html?token=abc'), 'html');
  for (const raro of [null, undefined, '', 'sin', 'punto.', 'a.muylargaextension', 'a.c++']) {
    assert.equal(extensionDe(raro), '', String(raro));
  }
});

test('un HTML se descarga: la dirección lleva `download` y no se duplica', () => {
  const firmada = 'https://almacen.example/objeto/pagina.html?token=abc';
  const descarga = enlaceDeDescarga(firmada, 'Mi página.html');
  assert.equal(descarga, `${firmada}&download=Mi%20p%C3%A1gina.html`);
  assert.equal(enlaceDeDescarga(descarga, 'otra.html'), descarga);
  assert.equal(enlaceDeDescarga('https://x.example/a.html', null), 'https://x.example/a.html?download=archivo');
  // En el chat y en Contenido, un HTML se abre SIEMPRE por ese camino.
  for (const pantalla of ['../screens/ChatScreen.tsx', '../screens/ContenidoDeChatScreen.tsx']) {
    assert.match(
      leer(pantalla),
      /esHtml\(adjunto\.mimeType, adjunto\.fileName\)\s*\? enlaceDeDescarga\(adjunto\.url, adjunto\.fileName\)/,
      pantalla,
    );
  }
});

test('al subir, el tipo se deduce y es el que se le dice al servidor', () => {
  const subida = leer('../services/messageMedia.ts');
  assert.match(subida, /tipoDeContenidoDe\(adjunto\.mimeType, adjunto\.name \?\? `archivo\.\$\{ext\}`\)/);
  assert.match(subida, /mime_type: contentType,/);
});

test('la 0105 añade text/html y conserva lo que ya se admitía', () => {
  const sql = leer('../../../../supabase/migrations/0105_html_en_el_chat.sql')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
  const anterior = leer('../../../../supabase/migrations/0033_adjuntos_de_chat.sql');
  const tipos = (texto: string) =>
    [...(texto.match(/allowed_mime_types = array\[([\s\S]*?)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(
      (m) => m[1],
    );
  const antes = tipos(anterior);
  const ahora = tipos(sql);
  assert.ok(antes.length >= 10);
  assert.deepEqual(ahora.filter((t) => t !== 'text/html').sort(), [...antes].sort());
  assert.ok(ahora.includes('text/html'));
  assert.doesNotMatch(sql, /create policy|drop policy|public = true|file_size_limit/);
});

// --------------------------------------------------------------------------
// Stickers
// --------------------------------------------------------------------------

test('un emoji solo, o dos o tres, es un sticker; con texto o con más, no', () => {
  for (const si of ['😀', ' 👍 ', '❤️', '🎉🎉', '😂 😂 😂', '👍🏽', '👨‍👩‍👧', '🇵🇪', '✏️', '☕']) {
    assert.equal(esSticker(si), true, si);
  }
  for (const no of ['', '   ', 'hola', 'ok 👍', '👍 ok', '1', '#', '😀😀😀😀', 'a😀', '😀.']) {
    assert.equal(esSticker(no), false, JSON.stringify(no));
  }
  assert.equal(esSticker(null), false);
  assert.equal(MAX_EMOJI_DE_STICKER, 3);
});

test('los emoji compuestos cuentan como uno', () => {
  assert.equal(contarEmoji('👨‍👩‍👧'), 1); // tres personas unidas: una familia
  assert.equal(contarEmoji('👍🏽'), 1); // con tono de piel
  assert.equal(contarEmoji('❤️'), 1); // con variante
  assert.equal(contarEmoji('🇵🇪🇧🇷'), 2); // dos banderas
  assert.equal(contarEmoji('😀👍🎉'), 3);
});

test('todos los stickers del panel se pintan como sticker', () => {
  const todos = PAQUETES_DE_STICKERS.flatMap((p) => p.stickers);
  assert.ok(todos.length >= 40);
  assert.equal(new Set(todos).size, todos.length, 'hay stickers repetidos');
  for (const sticker of [...todos, ...REACCIONES_RAPIDAS, ...PAQUETES_DE_STICKERS.map((p) => p.icono)]) {
    assert.equal(esSticker(sticker), true, sticker);
  }
});

test('los stickers no usan expresiones que el teléfono puede no entender', () => {
  // `\p{Extended_Pictographic}` no está garantizada en el motor de los
  // teléfonos, y una expresión que no compila tumba la pantalla entera.
  const codigo = leer('./stickers.ts')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
    .join('\n');
  assert.doesNotMatch(codigo, /\\p\{/);
  const chat = leer('../screens/ChatScreen.tsx');
  assert.match(chat, /esSticker\(item\.text\)/);
  // Con adjuntos nunca es un sticker.
  assert.match(chat, /!item\.attachments\?\.length &&[\s\S]{0,120}esSticker\(item\.text\)/);
  assert.match(chat, /void mandar\(\{\s+texto: sticker,\s+archivos: \[\],/);
});

// --------------------------------------------------------------------------
// Quién escribe en un grupo
// --------------------------------------------------------------------------

test('cada persona tiene siempre el mismo color, distinto en claro y en oscuro', () => {
  assert.equal(colorDeAutor(ID, false), colorDeAutor(ID, false));
  assert.notEqual(colorDeAutor(ID, false), colorDeAutor(ID, true));
  const colores = new Set<string>();
  for (let i = 0; i < 60; i += 1) colores.add(colorDeAutor(`persona-${i}`, false));
  assert.ok(colores.size >= 8, `solo ${colores.size} colores distintos entre 60 personas`);
  for (const sin of [undefined, '']) assert.match(colorDeAutor(sin, true), /^#[0-9A-F]{6}$/);
});

test('en un grupo se ve la foto de quien escribe y su nombre en su color', () => {
  const chat = leer('../screens/ChatScreen.tsx');
  assert.match(chat, /esGrupo && !mine && styles\.filaDeGrupo/);
  assert.match(chat, /profileImageUrl\(miembroDe\(infoDeConversacion, item\.autorId\)\?\.avatarPath\)/);
  assert.match(chat, /\{ color: colorDeAutor\(item\.autorId, mode === 'dark'\) \}/);
  const info = leerInfo({
    id: 'g',
    kind: 'group',
    members: [{ id: 'ana', full_name: 'Ana', avatar_path: 'ana/avatar.jpg' }],
  });
  assert.equal(miembroDe(info, 'ana')?.avatarPath, 'ana/avatar.jpg');
  assert.equal(miembroDe(info, 'otro'), undefined);
  assert.equal(miembroDe(null, 'ana'), undefined);
});

// --------------------------------------------------------------------------
// El visor: de quién es, y el vídeo dentro
// --------------------------------------------------------------------------

test('el vídeo se reproduce dentro de la aplicación, no fuera', () => {
  const chat = leer('../screens/ChatScreen.tsx');
  assert.doesNotMatch(chat, /if \(adjunto\.kind === 'video'\) abrirFuera\(adjunto\);/);
  assert.match(chat, /if \(adjunto\.kind === 'video' && !estaEnElServidor\(adjunto\)\) return;/);
  const contenido = leer('../screens/ContenidoDeChatScreen.tsx');
  assert.doesNotMatch(contenido, /if \(adjunto\.kind === 'video'\) abrirFuera\(adjunto\);/);
  const visor = leer('../components/chat/VisorDeAdjunto.tsx');
  assert.match(visor, /useVideoPlayer\(uri,/);
  assert.match(visor, /nativeControls/);
  assert.match(visor, /adjunto\?\.kind === 'video' && adjunto\.url/);
});

test('al ampliar una foto o un vídeo se dice de quién es y cuándo', () => {
  for (const pantalla of ['../screens/ChatScreen.tsx', '../screens/ContenidoDeChatScreen.tsx']) {
    const codigo = leer(pantalla);
    assert.match(codigo, /<VisorDeAdjunto\s+adjunto=\{fotoAmpliada\?\.url \? fotoAmpliada : null\}/, pantalla);
    assert.match(codigo, /const mensajeDelVisor = fotoAmpliada/, pantalla);
  }
  const chat = leer('../screens/ChatScreen.tsx');
  assert.match(chat, /etiqueta: t\('chat\.saveMedia'\)/);
  // Borrar desde el visor solo se ofrece sobre lo propio; el permiso es del servidor.
  assert.match(chat, /mensajeDelVisor\.sender === 'me' && !mensajeDelVisor\.estado/);
});

test('el visor de fotos de siempre no cambia si no se le pasa nada nuevo', () => {
  const visor = leer('../components/ImageViewer.tsx');
  assert.match(visor, /\{cabecera \? \(\s*<View style=\{styles\.cabecera\}>\{cabecera\}<\/View>\s*\) : \(/);
  assert.match(visor, /cabecera\?: React\.ReactNode;/);
  assert.match(visor, /pie\?: React\.ReactNode;/);
});

// --------------------------------------------------------------------------
// Entrar a un grupo
// --------------------------------------------------------------------------

const TARJETA = {
  id: ID,
  title: ' Aula 3 ',
  avatar_path: 'ana/avatar-grupo.jpg',
  members_count: 12,
  admin: { id: 'ana', full_name: 'Ana', username: 'ana' },
  my_status: 'none',
  is_full: false,
};

test('la tarjeta de un grupo se lee sin fiarse de nada', () => {
  assert.deepEqual(leerTarjeta(TARJETA), {
    id: ID,
    titulo: 'Aula 3',
    avatarPath: 'ana/avatar-grupo.jpg',
    miembros: 12,
    administrador: { id: 'ana', nombre: 'Ana' },
    miEstado: 'ninguno',
    lleno: false,
  });
  for (const mala of [null, 'x', {}, { id: ID }, { ...TARJETA, title: ' ' }, { ...TARJETA, admin: null }]) {
    assert.equal(leerTarjeta(mala), null, JSON.stringify(mala));
  }
  assert.equal(leerTarjetas([TARJETA, null, 'x', { ...TARJETA, id: 'otro' }]).length, 2);
  assert.deepEqual(leerTarjetas('no es una lista'), []);
});

test('lo que se ofrece en la tarjeta depende del estado, y pedir no es entrar', () => {
  const con = (cambios: object) => accionDeTarjeta(leerTarjeta({ ...TARJETA, ...cambios })!);
  assert.equal(con({}), 'pedir');
  assert.equal(con({ my_status: 'pending' }), 'esperando');
  assert.equal(con({ my_status: 'member' }), 'abrir');
  assert.equal(con({ is_full: true }), 'lleno');
  // Quien ya está dentro abre el grupo aunque esté lleno.
  assert.equal(con({ my_status: 'member', is_full: true }), 'abrir');

  const es = leer('../i18n/es.ts');
  assert.match(es, /'groupJoin\.ask': 'Pedir unirme',/);
  assert.match(es, /'groupJoin\.explain': '[^']*no te mete en el grupo/);
  const tarjeta = leer('../components/chat/TarjetaDeGrupoVista.tsx');
  assert.match(tarjeta, /GroupRepository\.pedirEntrar\(tarjeta\.id, codigo\)/);
  assert.match(tarjeta, /if \(enCurso\.current\) return;/);
});

test('el código del enlace solo se acepta para quien administra', () => {
  const base = {
    id: ID,
    kind: 'group',
    extras_available: true,
    settings: { listed_on_profile: true, invite_enabled: true, invite_code: 'abcdefghijklmnop1234' },
    pending_requests: 3,
    avatar_path: 'ana/a.jpg',
  };
  const admin = leerInfo({ ...base, can_manage: true });
  assert.deepEqual(admin?.ajustes, { enMiPerfil: true, enlaceActivo: true, codigo: 'abcdefghijklmnop1234' });
  assert.equal(admin?.pendientes, 3);
  assert.equal(admin?.avatarPath, 'ana/a.jpg');

  // Aunque la respuesta lo trajera, a quien no administra no se le guarda.
  const miembro = leerInfo({ ...base, can_manage: false });
  assert.equal(miembro?.ajustes, null);
  assert.equal(miembro?.pendientes, 0);
  assert.equal(miembro?.avatarPath, 'ana/a.jpg');

  // Sin la función en el servidor, nada de esto existe.
  const viejo = leerInfo({ id: ID, kind: 'group', can_manage: true });
  assert.equal(viejo?.hayExtras, false);
  assert.equal(viejo?.ajustes, null);

  // Un enlace «activo» sin código no se puede compartir.
  assert.equal(leerAjustes({ invite_enabled: true }).enlaceActivo, false);
  assert.deepEqual(leerAjustes(null), { enMiPerfil: false, enlaceActivo: false, codigo: null });
});

test('las solicitudes se leen con quién las manda y por dónde llegó', () => {
  const lista = leerSolicitudes([
    { id: 's1', user: { id: 'david', full_name: 'David', username: 'dav' }, source: 'link' },
    { id: 's2', user: { id: 'eva', full_name: '', username: 'eva9' }, source: 'profile' },
    { id: 's3' },
    null,
  ]);
  assert.deepEqual(
    lista.map((s) => [s.id, s.persona.nombre, s.origen]),
    [
      ['s1', 'David', 'enlace'],
      ['s2', 'eva9', 'perfil'],
    ],
  );
  assert.deepEqual(leerSolicitudes({}), []);
});

test('el código de un enlace tiene la forma que exige la base', () => {
  assert.equal(esCodigoDeGrupo('abcdefghijklmnop'), true);
  assert.equal(esCodigoDeGrupo('AbC-123_xyz-456_QRS-789'), true);
  for (const malo of [null, undefined, '', 'corto', 'con espacio 123456789', 'a'.repeat(65), 'ñandú-1234567890abcd']) {
    assert.equal(esCodigoDeGrupo(malo), false, String(malo));
  }
  const sql = leer('../../../../supabase/migrations/0104_puertas_de_grupo.sql');
  assert.match(sql, /invite_code ~ '\^\[A-Za-z0-9_-\]\{16,64\}\$'/);
  // La pantalla del enlace no pregunta al servidor por lo que no puede ser un código.
  assert.match(leer('../screens/UnirseAGrupoScreen.tsx'), /!esCodigoDeGrupo\(codigo\)/);
});

test('el enlace de un grupo se construye, se reconoce y se comparte', () => {
  const enlaces = leer('./enlaces.ts');
  assert.match(enlaces, /return `\$\{base\}\/grupo\/\$\{encodeURIComponent\(codigo\)\}`;/);
  // Pegado en un chat, se abre DENTRO de la aplicación.
  assert.match(enlaces, /\/\^\\\/\(live\|post\|grupo\)\\\/\(\[A-Za-z0-9_-\]\+\)\\\/\?\$\//);
  // Los textos de respaldo son los mismos que los del diccionario.
  const es = leer('../i18n/es.ts');
  for (const clave of ['share.group', 'share.groupNamed']) {
    const respaldo = enlaces.match(new RegExp(`'${clave}': '([^']*)'`))?.[1];
    const diccionario = es.match(new RegExp(`'${clave}': '([^']*)'`))?.[1];
    assert.ok(respaldo, clave);
    assert.equal(respaldo, diccionario, clave);
  }
});

test('el aviso de una solicitud lleva a la ficha del grupo, no al chat', () => {
  assert.equal(rutaDelPush({ type: 'group_join', conversationId: ID }), `/chat/grupo/${ID}`);
  assert.equal(rutaDelPush({ type: 'group_join', conversationId: 'no-es-un-id' }), '/messages');
  assert.equal(rutaDelPush({ type: 'message', conversationId: ID }), `/chat/${ID}`);
  // Es lo mismo que manda el servidor.
  const avisos = leer('../../../api/app/modules/messaging/avisos.py');
  assert.match(avisos, /DESTINO_DE_SOLICITUD = "group_join"/);
});

test('las puertas del grupo solo se pintan para quien administra', () => {
  const puertas = leer('../components/chat/PuertasDelGrupo.tsx');
  assert.match(puertas, /if \(!info\.puedoAdministrar \|\| !info\.hayExtras \|\| !ajustes\) return null;/);
  // Cambiar el enlace deja sin efecto el anterior: se confirma antes.
  assert.match(puertas, /await confirm\(\{\s*title: t\('groupJoin\.rotateTitle'\)/);
});

test('la foto del grupo se cambia tocándola, y solo quien administra', () => {
  const foto = leer('../components/chat/FotoDelGrupo.tsx');
  // Sin administrar, o con un servidor que no conoce la foto, es la foto y nada más.
  assert.match(foto, /if \(!info\.puedoAdministrar \|\| !info\.hayExtras\) return foto;/);
  // Se elige de la galería, se toma con la cámara o se quita.
  assert.match(foto, /await pickImage\(\{ aspect: \[1, 1\] \}\)/);
  assert.match(foto, /await takePhoto\(\{ aspect: \[1, 1\] \}\)/);
  assert.match(foto, /await GroupRepository\.quitarFoto\(grupoId\)/);
  // «Quitar» solo se ofrece si hay foto que quitar.
  assert.match(foto, /\{info\.avatarPath \? \(\s*<ListRow\s*title=\{t\('groups\.photoRemove'\)\}/);
  // La hoja se cierra DESPUÉS de elegir: cerrarla antes rompe el selector en iOS.
  const elegir = foto.slice(foto.indexOf('const elegir = useCallback('), foto.indexOf('const quitar = useCallback('));
  assert.ok(elegir.indexOf('await takePhoto(') < elegir.indexOf('setAbierta(false)'));
  // La foto se sube a la carpeta de quien administra, que es lo que exige el servidor.
  assert.match(foto, /uploadProfileImage\('avatar', elegida\)/);
  const servidor = leer('../../../api/app/modules/messaging/entrada_a_grupos.py');
  assert.match(servidor, /prefijo = f"\{current_user\.id\}\/"/);
  // Sin permiso para las fotos o la cámara se dice el motivo, no «no se pudo subir».
  assert.match(foto, /if \(error instanceof PermisoDenegadoError\) return error\.message;/);
  // Está en lo alto de la ficha, y en un solo sitio: las puertas ya no la llevan.
  const ficha = leer('../screens/GrupoScreen.tsx');
  assert.match(ficha, /<FotoDelGrupo info=\{info\} alCambiar=\{refrescar\} alFallar=\{setFallo\} \/>/);
  assert.doesNotMatch(leer('../components/chat/PuertasDelGrupo.tsx'), /ponerFoto|quitarFoto|pickImage/);
});

test('el perfil no pinta la sección si no hay grupos que enseñar', () => {
  const seccion = leer('../components/chat/GruposDelPerfil.tsx');
  assert.match(seccion, /if \(tarjetas\.length === 0\) return null;/);
  const perfil = leer('../screens/ProfileScreen.tsx');
  assert.match(perfil, /<GruposDelPerfil perfilId=\{galleryOwnerId\} esPropio=\{!isPublic\} \/>/);
  const repositorio = leer('../repositories/GroupRepository.ts');
  const funcion = repositorio.slice(repositorio.indexOf('async tarjetasDe('));
  assert.match(funcion.slice(0, 400), /catch \{\s*return \[\];\s*\}/);
});

test('cada rechazo nuevo del servidor tiene su texto', () => {
  const es = leer('../i18n/es.ts');
  const servidor = leer('../../../api/app/modules/messaging/entrada_a_grupos.py');
  const codigos = [...servidor.matchAll(/code="([a-z_]+)"/g)].map((m) => m[1] as string);
  assert.ok(codigos.length >= 8);
  for (const codigo of new Set(codigos)) {
    const clave = claveDelFalloDeGrupo(codigo);
    assert.ok(es.includes(`'${clave}':`), `${codigo} → ${clave} no está en es.ts`);
  }
  // Un bloqueo y un grupo inexistente dicen lo mismo, y no nombran el bloqueo.
  assert.equal(claveDelFalloDeGrupo('group_not_found'), 'groupJoin.errorNotFound');
  assert.doesNotMatch(es.match(/'groupJoin\.errorNotFound': '([^']*)'/)?.[1] ?? '', /bloque/i);
});
