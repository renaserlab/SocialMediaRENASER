import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  CATEGORIAS,
  MAX_BUSQUEDA_EN_VISTA,
  SIN_VISTAS,
  TIPOS_DE_CONTENIDO,
  VISTA_TODO,
  claveDeVista,
  crearTurnos,
  fundirPaginas,
  leerCursor,
  leerVistas,
  parametrosDeVista,
  pestanasDe,
  refrescarPrimeraPagina,
  sigueExistiendo,
} from './vistasDeChat.ts';

/*
  Vistas de un chat (09/10/2026): categorías automáticas y filtros de grupo.
  Lo esencial: no se ofrece una pestaña que no se puede abrir, la aplicación no
  filtra por su cuenta, paginar no repite mensajes, y la respuesta que llega
  tarde de una pestaña anterior no pisa la que se está mirando.
*/

const leer = (ruta: string) =>
  readFileSync(new URL(ruta, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const RESPUESTA = {
  kind: 'group',
  categories: [
    { key: 'all', count: 0 },
    { key: 'image', count: 4 },
    { key: 'video', count: 0 },
    { key: 'document', count: 2 },
    { key: 'audio', count: 0 },
    { key: 'link', count: 1 },
  ],
  filters_available: true,
  can_manage: true,
  filters: [
    {
      id: 'f1',
      name: 'Material de estudio',
      description: 'Lo del examen',
      icon: 'book-open',
      criteria: { types: ['document'], keywords: ['examen'], keyword_mode: 'all', author_ids: [] },
      enabled: true,
    },
    {
      id: 'f2',
      name: 'Anuncios',
      criteria: { types: [], keywords: [], keyword_mode: 'any', author_ids: ['u1'] },
      enabled: false,
    },
  ],
  icons: ['filter', 'star'],
  max_filters: 20,
};

test('lo que no es una respuesta deja solo «Todo»', () => {
  for (const bruto of [null, undefined, 'x', 7, [], {}]) {
    const vistas = leerVistas(bruto);
    assert.deepEqual(vistas.filtros, [], JSON.stringify(bruto));
    assert.equal(vistas.hayFiltros, false);
    assert.equal(vistas.puedoAdministrar, false);
    assert.deepEqual(
      pestanasDe(vistas).map((p) => claveDeVista(p.vista)),
      ['c:all'],
    );
  }
  assert.deepEqual(pestanasDe(SIN_VISTAS).map((p) => claveDeVista(p.vista)), ['c:all']);
});

test('se leen las cuentas, los filtros y el permiso', () => {
  const vistas = leerVistas(RESPUESTA);
  assert.equal(vistas.esGrupo, true);
  assert.equal(vistas.cuentas.image, 4);
  assert.equal(vistas.cuentas.video, 0);
  assert.equal(vistas.puedoAdministrar, true);
  assert.equal(vistas.maximoDeFiltros, 20);
  assert.deepEqual(vistas.filtros[0], {
    id: 'f1',
    nombre: 'Material de estudio',
    descripcion: 'Lo del examen',
    icono: 'book-open',
    criterios: { tipos: ['document'], palabras: ['examen'], modo: 'all', autores: [] },
    activo: true,
  });
  // Lo que falta se rellena con lo neutro, no con `undefined`.
  assert.equal(vistas.filtros[1]?.descripcion, '');
  assert.equal(vistas.filtros[1]?.icono, 'filter');
  assert.equal(vistas.filtros[1]?.activo, false);
});

test('las pestañas: Todo, las categorías con algo, y los filtros', () => {
  const pestanas = pestanasDe(leerVistas(RESPUESTA));
  assert.deepEqual(
    pestanas.map((p) => claveDeVista(p.vista)),
    ['c:all', 'c:image', 'c:document', 'c:link', 'f:f1', 'f:f2'],
  );
});

test('la categoría abierta no desaparece aunque se quede a cero', () => {
  const vistas = leerVistas(RESPUESTA);
  const abierta = { tipo: 'categoria', clave: 'video' } as const;
  assert.ok(pestanasDe(vistas, abierta).some((p) => claveDeVista(p.vista) === 'c:video'));
  assert.ok(!pestanasDe(vistas).some((p) => claveDeVista(p.vista) === 'c:video'));
});

test('sin permiso para filtros, no hay filtros ni se puede administrar', () => {
  const vistas = leerVistas({ ...RESPUESTA, filters_available: false });
  assert.deepEqual(vistas.filtros, []);
  assert.equal(vistas.puedoAdministrar, false);
});

test('un filtro sin criterios, o sin nombre, no se ofrece', () => {
  const vistas = leerVistas({
    ...RESPUESTA,
    filters: [
      { id: 'a', name: 'Vacío', criteria: { types: [], keywords: [], author_ids: [] } },
      { id: 'b', criteria: { keywords: ['x'] } },
      { id: 'c', name: 'Tipo raro', criteria: { types: ['sticker'] } },
      'basura',
      { id: 'd', name: 'Bueno', criteria: { keywords: ['examen'] } },
    ],
  });
  assert.deepEqual(vistas.filtros.map((f) => f.id), ['d']);
});

test('una cuenta que no es un número positivo vale cero', () => {
  const vistas = leerVistas({
    categories: [
      { key: 'image', count: -3 },
      { key: 'video', count: 'muchos' },
      { key: 'sticker', count: 9 },
      { key: 'link', count: 2.9 },
    ],
  });
  assert.deepEqual(
    [vistas.cuentas.image, vistas.cuentas.video, vistas.cuentas.link],
    [0, 0, 2],
  );
  assert.ok(!('sticker' in vistas.cuentas));
});

test('el filtro que se miraba deja de existir cuando lo borran', () => {
  const vistas = leerVistas(RESPUESTA);
  assert.equal(sigueExistiendo(vistas, { tipo: 'filtro', id: 'f1' }), true);
  assert.equal(sigueExistiendo(vistas, { tipo: 'filtro', id: 'borrado' }), false);
  assert.equal(sigueExistiendo(SIN_VISTAS, VISTA_TODO), true);
});

test('la consulta lleva la vista, la búsqueda limpia y el cursor entero', () => {
  assert.equal(parametrosDeVista(VISTA_TODO), 'category=all&limit=30');
  assert.equal(
    parametrosDeVista({ tipo: 'filtro', id: 'f1' }, { buscar: '  examen final ' }),
    'filter_id=f1&q=examen%20final&limit=30',
  );
  assert.equal(
    parametrosDeVista(
      { tipo: 'categoria', clave: 'image' },
      { cursor: { antes: '2026-10-01T12:00:00+00:00', antesId: 'm9' }, limite: 10 },
    ),
    'category=image&before=2026-10-01T12%3A00%3A00%2B00%3A00&before_id=m9&limit=10',
  );
  // Un espacio no es buscar, y lo escrito tiene tope.
  assert.ok(!parametrosDeVista(VISTA_TODO, { buscar: '   ' }).includes('q='));
  const larga = parametrosDeVista(VISTA_TODO, { buscar: 'x'.repeat(200) });
  assert.ok(larga.includes(`q=${'x'.repeat(MAX_BUSQUEDA_EN_VISTA)}&`));
});

test('el cursor hace falta entero: el instante solo no vale', () => {
  assert.deepEqual(leerCursor({ next_before: '2026-10-01T12:00:00Z', next_before_id: 'm1' }), {
    antes: '2026-10-01T12:00:00Z',
    antesId: 'm1',
  });
  for (const bruto of [
    null,
    {},
    { next_before: null, next_before_id: null },
    { next_before: '2026-10-01T12:00:00Z' },
    { next_before_id: 'm1' },
  ]) {
    assert.equal(leerCursor(bruto), null, JSON.stringify(bruto));
  }
});

test('juntar páginas no repite ningún mensaje', () => {
  const a = [{ id: '5' }, { id: '4' }, { id: '3' }];
  const b = [{ id: '3' }, { id: '2' }, { id: '1' }];
  assert.deepEqual(fundirPaginas(a, b).map((m) => m.id), ['5', '4', '3', '2', '1']);
  assert.deepEqual(fundirPaginas([], b), b);
});

test('refrescar la primera página mete lo nuevo y quita lo borrado', () => {
  // Había dos páginas de 3 cargadas. Entra el 7 y se borra el 5.
  const previos = ['6', '5', '4', '3', '2', '1'].map((id) => ({ id }));
  const primera = ['7', '6', '4'].map((id) => ({ id }));
  assert.deepEqual(
    refrescarPrimeraPagina(previos, primera, 3).map((m) => m.id),
    ['7', '6', '4', '3', '2', '1'],
  );
});

test('solo cuenta la última petición lanzada', () => {
  const turnos = crearTurnos();
  const fotos = turnos.siguiente();
  const archivos = turnos.siguiente();
  // La de fotos contesta tarde, cuando ya se miran los archivos.
  assert.equal(turnos.vigente(fotos), false);
  assert.equal(turnos.vigente(archivos), true);
});

test('la aplicación y el servidor hablan de las mismas categorías y tipos', () => {
  const servidor = leer('../../../api/app/modules/messaging/vistas.py');
  assert.match(
    servidor,
    new RegExp(`CATEGORIAS = \\(${CATEGORIAS.map((c) => `"${c}"`).join(', ')}\\)`),
  );
  assert.match(servidor, /TIPOS_DE_ADJUNTO = \("image", "video", "document", "audio"\)/);
  assert.match(servidor, /TIPOS = \("text", \*TIPOS_DE_ADJUNTO, "link"\)/);
  assert.deepEqual([...TIPOS_DE_CONTENIDO], ['text', 'image', 'video', 'document', 'audio', 'link']);
  assert.match(servidor, new RegExp(`MAX_BUSQUEDA`));
});

test('la pantalla no filtra por su cuenta: pregunta al servidor', () => {
  const pantalla = leer('../screens/ContenidoDeChatScreen.tsx');
  // Ni un `.filter` sobre los mensajes para decidir qué entra en la vista: los
  // dos que hay separan los adjuntos de UN mensaje para pintarlos.
  assert.doesNotMatch(pantalla, /mensajes\.filter\(/);
  assert.match(pantalla, /MessageRepository\.mensajesDeVista\(conversationId, vista,/);
  // Cada petición lleva su turno y se cancela la anterior.
  assert.match(pantalla, /enCurso\.current\?\.abort\(\);/);
  assert.match(pantalla, /if \(!turnos\.vigente\(turno\)\) return;/);
});

test('los mensajes nuevos recargan la vista, con freno', () => {
  const pantalla = leer('../screens/ContenidoDeChatScreen.tsx');
  assert.match(pantalla, /subscribeToConversation\(conversationId, \(\) => \{\s*if \(pendiente\) return;/);
  assert.match(pantalla, /ESPERA_ENTRE_RECARGAS_MS = 2000/);
});

test('el botón de contenido solo sale cuando hay servidor al que preguntar', () => {
  const chat = leer('../screens/ChatScreen.tsx');
  assert.match(chat, /alAbrirContenido=\{\s*supabaseEnabled && params\.id\s*\?/);
  const cabecera = leer('../components/CabeceraDeChat.tsx');
  assert.match(cabecera, /rightIcon=\{alAbrirContenido \? 'grid' : undefined\}/);
  assert.match(cabecera, /alAbrirContenido\?: \(\) => void;/);
});

test('pedir las vistas nunca falla hacia la pantalla', () => {
  const repositorio = leer('../repositories/MessageRepository.ts');
  const funcion = repositorio.slice(repositorio.indexOf('async vistas('));
  assert.match(funcion.slice(0, 500), /\/views`/);
  assert.match(funcion.slice(0, 500), /catch \{\s*return SIN_VISTAS;\s*\}/);
});
