import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  MAX_MIEMBROS_DE_GRUPO,
  MAX_PERSONAS_POR_TANDA,
  MAX_TITULO_DE_GRUPO,
  claveDelFalloDeGrupo,
  juzgarGrupoNuevo,
  juzgarTitulo,
  leerInfo,
  limpiarTitulo,
  nombreDelAutor,
} from './gruposDeChat.ts';
import {
  PAGINAS_PARA_IR_A_UN_MENSAJE,
  pedirSalto,
  tomarSalto,
} from './saltoDeChat.ts';
import {
  BORRADOR_VACIO,
  MAX_PALABRAS_DE_FILTRO,
  alternar,
  borradorDe,
  cuerpoDeFiltro,
  huellaDeCriterios,
  juzgarFiltro,
  leerVistas,
  palabrasDe,
  type BorradorDeFiltro,
} from './vistasDeChat.ts';

/*
  Grupos de mensajería (09/10/2026). Lo esencial: un grupo no se pinta como un
  chat de dos, cada mensaje dice de quién es, la aplicación no decide permisos,
  y lo que el servidor rechazaría se dice antes de enviar.
*/

const leer = (ruta: string) =>
  readFileSync(new URL(ruta, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const GRUPO = {
  id: 'g1',
  kind: 'group',
  title: '  Aula 3 ',
  can_manage: true,
  members_count: 3,
  max_members: 100,
  members: [
    { id: 'ana', full_name: 'Ana', username: 'ana', avatar_path: 'a.jpg', is_admin: true },
    { id: 'bruno', full_name: '', username: 'bruno99', avatar_path: null, is_admin: false },
    { id: 'carla', full_name: 'Carla', username: null, is_admin: false },
  ],
};

// --------------------------------------------------------------------------
// Leer qué es una conversación
// --------------------------------------------------------------------------

test('se lee un grupo: su nombre, quién administra y quién está', () => {
  const info = leerInfo(GRUPO);
  assert.ok(info);
  assert.equal(info.esGrupo, true);
  assert.equal(info.titulo, 'Aula 3');
  assert.equal(info.puedoAdministrar, true);
  assert.equal(info.maximoDeMiembros, 100);
  assert.deepEqual(
    info.miembros.map((m) => [m.id, m.nombre, m.administra]),
    [
      ['ana', 'Ana', true],
      // Sin nombre se enseña el usuario: una fila en blanco no dice quién es.
      ['bruno', 'bruno99', false],
      ['carla', 'Carla', false],
    ],
  );
  assert.equal(info.miembros[0]?.avatarPath, 'a.jpg');
  assert.equal(info.miembros[1]?.avatarPath, undefined);
});

test('lo que no se entiende es «no se sabe», no un grupo', () => {
  for (const bruto of [null, undefined, 'x', [], {}, { id: 'c1' }, { kind: 'group' }]) {
    assert.equal(leerInfo(bruto), null, JSON.stringify(bruto));
  }
});

test('en un chat de dos nadie administra, diga lo que diga la respuesta', () => {
  const info = leerInfo({ id: 'c1', kind: 'direct', can_manage: true, members: [] });
  assert.ok(info);
  assert.equal(info.esGrupo, false);
  assert.equal(info.puedoAdministrar, false);
  assert.equal(info.maximoDeMiembros, MAX_MIEMBROS_DE_GRUPO);
});

test('los miembros mal formados se dejan fuera sin romper la lista', () => {
  const info = leerInfo({ ...GRUPO, members: [null, 'x', { full_name: 'Sin id' }, GRUPO.members[0]] });
  assert.deepEqual(info?.miembros.map((m) => m.id), ['ana']);
});

// --------------------------------------------------------------------------
// De quién es cada mensaje
// --------------------------------------------------------------------------

test('el autor sale de la lista de miembros, y si ya no está, del mensaje', () => {
  const info = leerInfo(GRUPO);
  // Una fila de tiempo real trae solo el identificador.
  assert.equal(nombreDelAutor(info, 'carla'), 'Carla');
  // La lista manda sobre lo que traía el mensaje: es lo más reciente.
  assert.equal(nombreDelAutor(info, 'ana', 'Ana (antes)'), 'Ana');
  // Quien salió del grupo no está en la lista, pero su mensaje trae su nombre.
  assert.equal(nombreDelAutor(info, 'david', 'David'), 'David');
  // Sin nada, cadena vacía: la pantalla pone «Alguien».
  assert.equal(nombreDelAutor(info, 'nadie'), '');
  assert.equal(nombreDelAutor(null, undefined, '  '), '');
});

test('en un grupo, dos personas distintas no comparten ráfaga', () => {
  const chat = leer('../screens/ChatScreen.tsx');
  assert.match(
    chat,
    /actual\.sender === 'them' &&\s*anterior\.autorId &&\s*actual\.autorId &&\s*anterior\.autorId !== actual\.autorId/,
  );
  // El nombre va solo en un grupo, solo en lo ajeno y solo al empezar ráfaga.
  assert.match(chat, /\{esGrupo && !mine && !agrupado \? \(/);
  assert.match(chat, /nombreDelAutor\(infoDeConversacion, item\.autorId, item\.autorNombre\)/);
});

test('los mensajes traen a su autor, también los de tiempo real', () => {
  const mapeador = leer('../mappers/messageMapper.ts');
  assert.match(mapeador, /autorId: dto\.sender\.id,/);
  assert.match(mapeador, /autorId: row\.sender_id,/);
  assert.match(mapeador, /esGrupo: dto\.kind === 'group',/);
});

test('la cabecera no busca «la otra persona» hasta saber que no es un grupo', () => {
  const chat = leer('../screens/ChatScreen.tsx');
  assert.match(
    chat,
    /supabaseEnabled && !!params\.id && infoDeConversacion !== undefined && !esGrupo/,
  );
  const cabecera = leer('../components/CabeceraDeChat.tsx');
  assert.match(cabecera, /grupo \? \(/);
  assert.match(cabecera, /t\('groups\.membersCount', \{ n: grupo\.miembros \}\)/);
});

// --------------------------------------------------------------------------
// Crear un grupo
// --------------------------------------------------------------------------

test('el título se limpia y se juzga como lo hará el servidor', () => {
  assert.equal(limpiarTitulo('  Aula   3 \n'), 'Aula 3');
  assert.equal(juzgarTitulo('   '), 'vacio');
  assert.equal(juzgarTitulo('x'.repeat(MAX_TITULO_DE_GRUPO)), 'vale');
  assert.equal(juzgarTitulo('x'.repeat(MAX_TITULO_DE_GRUPO + 1)), 'largo');
});

test('un grupo necesita nombre y al menos una persona', () => {
  assert.equal(juzgarGrupoNuevo('', 3), 'vacio');
  assert.equal(juzgarGrupoNuevo('Aula', 0), 'sin_personas');
  assert.equal(juzgarGrupoNuevo('Aula', 1), 'vale');
  assert.equal(juzgarGrupoNuevo('Aula', MAX_PERSONAS_POR_TANDA), 'vale');
  assert.equal(juzgarGrupoNuevo('Aula', MAX_PERSONAS_POR_TANDA + 1), 'demasiadas');
});

test('la aplicación y el servidor usan los mismos topes', () => {
  const servidor = leer('../../../api/app/modules/messaging/grupos.py');
  assert.match(servidor, new RegExp(`^MAX_MIEMBROS = ${MAX_MIEMBROS_DE_GRUPO}$`, 'm'));
  assert.match(servidor, new RegExp(`^MAX_POR_TANDA = ${MAX_PERSONAS_POR_TANDA}$`, 'm'));
  assert.match(servidor, new RegExp(`^MAX_TITULO = ${MAX_TITULO_DE_GRUPO}$`, 'm'));
  const vistas = leer('../../../api/app/modules/messaging/vistas.py');
  assert.match(vistas, new RegExp(`^MAX_PALABRAS = ${MAX_PALABRAS_DE_FILTRO}$`, 'm'));
});

test('cada rechazo del servidor tiene su texto, y el desconocido uno genérico', () => {
  const es = leer('../i18n/es.ts');
  const servidor =
    leer('../../../api/app/modules/messaging/grupos.py') +
    leer('../../../api/app/modules/messaging/vistas.py');
  const codigos = [...servidor.matchAll(/code="([a-z_]+)"/g)].map((m) => m[1] as string);
  assert.ok(codigos.length >= 12, `solo ${codigos.length} códigos en el servidor`);
  for (const codigo of new Set(codigos)) {
    const clave = claveDelFalloDeGrupo(codigo);
    assert.ok(es.includes(`'${clave}':`), `${codigo} → ${clave} no está en es.ts`);
  }
  assert.equal(claveDelFalloDeGrupo('algo_nuevo'), 'groups.errorGeneric');
  assert.equal(claveDelFalloDeGrupo(null), 'groups.errorGeneric');
  // Que te hayan bloqueado y que la persona no exista dicen lo mismo.
  assert.equal(claveDelFalloDeGrupo('group_member_not_allowed'), 'groups.errorMemberNotAllowed');
  assert.doesNotMatch(es.match(/'groups\.errorMemberNotAllowed': '([^']*)'/)?.[1] ?? '', /bloque/i);
});

test('los botones de administrar dependen de lo que dice el servidor', () => {
  const grupo = leer('../screens/GrupoScreen.tsx');
  // Sacar a alguien y añadir: solo con `puedoAdministrar`. Quien administra
  // lleva su insignia y no se puede sacar a sí mismo.
  assert.match(grupo, /\{miembro\.administra \? \([\s\S]{0,400}?\) : info\.puedoAdministrar \? \(\s*<Pressable\s*onPress=\{\(\) => void sacar\(miembro\)\}/);
  assert.match(grupo, /\{info\.puedoAdministrar \? \(\s*<View style=\{styles\.seccion\}>\s*\{cabenMas \? \(/);
  // El lápiz, también: lo demás de administrar vive en su propia pantalla.
  assert.match(grupo, /rightIcon=\{info\.puedoAdministrar \? 'edit-2' : undefined\}/);
  // Y salir, solo quien NO administra: el servidor se lo negaría.
  assert.match(grupo, /info\.puedoAdministrar\s*\? \{ clave: 'editar',[^}]*\}\s*: \{\s*clave: 'salir',/);
  // Sacar y salir piden confirmación.
  assert.equal((grupo.match(/await confirm\(\{/g) ?? []).length, 2);
  // Renombrar, el enlace y los filtros: la pantalla de editar no se le abre a nadie más.
  const ajustes = leer('../screens/AjustesDeGrupoScreen.tsx');
  assert.match(ajustes, /if \(!info\.puedoAdministrar\) \{\s*return \(/);
  assert.ok(ajustes.indexOf('if (!info.puedoAdministrar)') < ajustes.indexOf('<Input'));
});

test('crear un grupo no se puede lanzar dos veces', () => {
  const pantalla = leer('../screens/NuevoGrupoScreen.tsx');
  assert.match(pantalla, /if \(juicio !== 'vale' \|\| enCurso\.current\) return;/);
  assert.match(pantalla, /router\.replace\(\{ pathname: '\/chat\/\[id\]'/);
});

test('el botón de crear grupo solo sale con sesión y servidor', () => {
  const bandeja = leer('../screens/MessagesScreen.tsx');
  assert.match(bandeja, /rightIcon=\{supabaseEnabled && signedIn \? 'users' : undefined\}/);
  assert.match(bandeja, /router\.push\('\/chat\/nuevo-grupo' as never\)/);
});

// --------------------------------------------------------------------------
// Escribir un filtro
// --------------------------------------------------------------------------

const borrador = (cambios: Partial<BorradorDeFiltro> = {}): BorradorDeFiltro => ({
  ...BORRADOR_VACIO,
  nombre: 'Material',
  criterios: { tipos: [], palabras: ['examen'], modo: 'any', autores: [] },
  ...cambios,
});

test('las palabras se separan por comas, no por espacios, y sin repetir', () => {
  assert.deepEqual(palabrasDe('examen final,  Parcial\nEXAMEN FINAL, , tarea'), [
    'examen final',
    'Parcial',
    'tarea',
  ]);
  assert.deepEqual(palabrasDe('   '), []);
});

test('un filtro se juzga antes de enviarlo', () => {
  assert.equal(juzgarFiltro(borrador()), 'vale');
  assert.equal(juzgarFiltro(borrador({ nombre: '  ' })), 'sin_nombre');
  assert.equal(juzgarFiltro(borrador({ nombre: 'x'.repeat(41) })), 'nombre_largo');
  assert.equal(juzgarFiltro(borrador({ descripcion: 'x'.repeat(201) })), 'descripcion_larga');
  const con = (criterios: Partial<BorradorDeFiltro['criterios']>) =>
    juzgarFiltro(borrador({ criterios: { ...borrador().criterios, ...criterios } }));
  assert.equal(con({ palabras: [] }), 'sin_criterios');
  assert.equal(con({ palabras: ['ab'] }), 'palabra_corta');
  assert.equal(con({ palabras: ['x'.repeat(41)] }), 'palabra_larga');
  assert.equal(con({ palabras: ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis'] }), 'muchas_palabras');
  assert.equal(con({ palabras: [], tipos: ['image'] }), 'vale');
  assert.equal(con({ palabras: [], autores: ['u1'] }), 'vale');
  assert.equal(con({ autores: Array.from({ length: 11 }, (_, i) => `u${i}`) }), 'muchos_autores');
});

test('el cuerpo lleva los nombres del servidor y los tipos en su orden', () => {
  const cuerpo = cuerpoDeFiltro(
    borrador({
      nombre: '  Material   de estudio ',
      descripcion: ' Lo del  examen ',
      icono: 'book-open',
      activo: false,
      criterios: { tipos: ['link', 'document'], palabras: ['examen'], modo: 'all', autores: ['u1'] },
    }),
  );
  assert.deepEqual(cuerpo, {
    name: 'Material de estudio',
    description: 'Lo del examen',
    icon: 'book-open',
    enabled: false,
    criteria: {
      types: ['document', 'link'],
      keywords: ['examen'],
      keyword_mode: 'all',
      author_ids: ['u1'],
    },
  });
  // Y son justo los campos que acepta el servidor (rechaza cualquier otro).
  const servidor = leer('../../../api/app/modules/messaging/vistas.py');
  const clase = servidor.slice(servidor.indexOf('class FiltroEscrito'));
  for (const campo of Object.keys(cuerpo)) {
    assert.match(clase.slice(0, 600), new RegExp(`^    ${campo}: `, 'm'), campo);
  }
});

test('editar parte de lo que el filtro tiene, sin compartir sus listas', () => {
  const vistas = leerVistas({
    kind: 'group',
    filters_available: true,
    filters: [
      { id: 'f1', name: 'Tareas', icon: 'flag', criteria: { keywords: ['tarea'], types: ['document'] } },
    ],
  });
  const filtro = vistas.filtros[0];
  assert.ok(filtro);
  const copia = borradorDe(filtro);
  assert.equal(copia.nombre, 'Tareas');
  copia.criterios.palabras.push('otra');
  assert.deepEqual(filtro.criterios.palabras, ['tarea']);
});

test('alternar pone y quita sin tocar la lista original', () => {
  const lista = ['a', 'b'] as const;
  assert.deepEqual(alternar(lista, 'c'), ['a', 'b', 'c']);
  assert.deepEqual(alternar(lista, 'a'), ['b']);
  assert.deepEqual([...lista], ['a', 'b']);
});

test('la huella cambia con los criterios y no con el nombre', () => {
  const de = (criteria: object, name = 'F') =>
    huellaDeCriterios(
      leerVistas({ kind: 'group', filters_available: true, filters: [{ id: 'f', name, criteria }] })
        .filtros[0],
    );
  assert.equal(de({ keywords: ['examen'] }), de({ keywords: ['examen'] }, 'Otro nombre'));
  assert.notEqual(de({ keywords: ['examen'] }), de({ keywords: ['parcial'] }));
  assert.notEqual(de({ keywords: ['uno', 'dos'] }), de({ keywords: ['uno', 'dos'], keyword_mode: 'all' }));
  assert.equal(huellaDeCriterios(undefined), '');
});

test('borrar un filtro pide confirmación y dice que los mensajes se quedan', () => {
  const pantalla = leer('../screens/FiltrosDeGrupoScreen.tsx');
  assert.match(pantalla, /await confirm\(\{\s*title: t\('groupFilters\.deleteTitle'/);
  assert.match(pantalla, /message: t\('groupFilters\.deleteBody'\)/);
  assert.match(leer('../i18n/es.ts'), /'groupFilters\.deleteBody': '[^']*siguen en el chat/);
  // Los botones de cambiar solo se pintan para quien administra.
  assert.match(pantalla, /\{vistas\.puedoAdministrar \? \(\s*<View style=\{styles\.acciones\}>/);
});

// --------------------------------------------------------------------------
// Ir a un mensaje, y enterarse de los borrados
// --------------------------------------------------------------------------

test('el encargo de ir a un mensaje se gasta al recogerlo', () => {
  assert.equal(tomarSalto('c1'), null);
  pedirSalto('c1', 'm1');
  pedirSalto('c1', 'm2'); // el último gana
  pedirSalto('c2', 'm9');
  assert.equal(tomarSalto('c1'), 'm2');
  assert.equal(tomarSalto('c1'), null);
  assert.equal(tomarSalto('c2'), 'm9');
  assert.equal(tomarSalto(null), null);
  pedirSalto('', 'm1');
  pedirSalto('c3', '');
  assert.equal(tomarSalto('c3'), null);
});

test('el chat sube por el historial hasta el mensaje, con tope, y avisa si no llega', () => {
  const chat = leer('../screens/ChatScreen.tsx');
  assert.match(chat, /const pedido = tomarSalto\(/);
  assert.match(chat, /pagina <= PAGINAS_PARA_IR_A_UN_MENSAJE/);
  assert.ok(PAGINAS_PARA_IR_A_UN_MENSAJE >= 5 && PAGINAS_PARA_IR_A_UN_MENSAJE <= 20);
  // Deja de seguir el final antes de moverse, o la lista volvería abajo sola.
  assert.match(chat, /pegadoAlFinal\.current = false;\s*setLejosDelFinal\(true\);\s*setResaltado\(buscado\);/);
  assert.match(chat, /notify\(t\('chat\.jumpNotFoundTitle'\), t\('chat\.jumpNotFoundBody'\)\)/);
  // La lista recicla celdas: tiene que enterarse del resalte y del grupo.
  assert.match(chat, /\(\{ estadosDeSesion, sesionOcupada, infoDeConversacion, resaltado \}\)/);
});

test('desde Contenido y desde Buscar se vuelve al chat abierto, no se apila otro', () => {
  for (const ruta of ['../components/chat/PestanasDeContenido.tsx', '../screens/BuscarEnChatScreen.tsx']) {
    assert.match(leer(ruta), /pedirSalto\(conversationId, mensaje\.id\);\s*router\.dismissTo\(/, ruta);
  }
});

test('Contenido se entera de los borrados, no solo de los mensajes nuevos', () => {
  const pantalla = leer('../hooks/useMensajesDeVista.ts');
  assert.match(pantalla, /subscribeToConversationChanges\(conversationId, \(\) => \{\s*if \(pendiente\) return;/);
  const tiempoReal = leer('../services/realtime.ts');
  const funcion = tiempoReal.slice(tiempoReal.indexOf('export function subscribeToConversationChanges'));
  assert.match(funcion, /event: '\*',/);
  assert.match(funcion, /filter: `conversation_id=eq\.\$\{conversationId\}`/);
  // El chat sigue con su canal de altas, que entrega la fila.
  assert.match(leer('../screens/ChatScreen.tsx'), /subscribeToConversation\(conversationId, \(row\) =>/);
});

test('cambiar los criterios del filtro abierto recarga su lista', () => {
  // La huella de los criterios es una dependencia de la carga…
  const carga = leer('../hooks/useMensajesDeVista.ts');
  assert.match(carga, /\[conversationId, clave, buscar, currentUserId, turnos, t, huella\]/);
  // …y quien pinta las pestañas se la pasa cuando lo abierto es un filtro.
  const pestanas = leer('../components/chat/PestanasDeContenido.tsx');
  assert.match(
    pestanas,
    /huella: seccion\?\.tipo === 'filtro' \? huellaDeCriterios\(seccion\.filtro\) : ''/,
  );
});
