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
  opcionesDeMedia,
  parametrosDeVista,
  refrescarPrimeraPagina,
  seccionesDeContenido,
  sigueExistiendo,
  vistaDeSeccion,
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

test('lo que no es una respuesta no ofrece ninguna sección', () => {
  for (const bruto of [null, undefined, 'x', 7, [], {}]) {
    const vistas = leerVistas(bruto);
    assert.deepEqual(vistas.filtros, [], JSON.stringify(bruto));
    assert.equal(vistas.hayFiltros, false);
    assert.equal(vistas.puedoAdministrar, false);
    assert.equal(vistas.conMedia, false);
    assert.deepEqual(seccionesDeContenido(vistas), []);
  }
  assert.deepEqual(seccionesDeContenido(SIN_VISTAS), []);
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

/* La misma respuesta, de un servidor que ya sabe juntar fotos y vídeos. */
const conMedia = (cuentas: Record<string, number>) =>
  leerVistas({
    ...RESPUESTA,
    categories: Object.entries(cuentas).map(([key, count]) => ({ key, count })),
  });

test('las secciones: solo las que tienen algo, en su orden, y los filtros', () => {
  // «Media» antes que «Enlaces», como en cualquier mensajería. Sin «Todo»:
  // el texto suelto no es contenido compartido. Y sin «Audios», que está a cero.
  assert.deepEqual(
    seccionesDeContenido(leerVistas(RESPUESTA)).map((s) => s.clave),
    ['media', 'link', 'document', 'f:f1', 'f:f2'],
  );
  const todo = conMedia({ media: 3, image: 2, video: 2, document: 1, audio: 1, link: 1 });
  assert.deepEqual(
    seccionesDeContenido(todo).map((s) => s.clave),
    ['media', 'link', 'document', 'audio', 'f:f1', 'f:f2'],
  );
  // Un chat en el que solo se ha hablado no enseña ninguna.
  const nada = conMedia({ media: 0, image: 0, video: 0, document: 0, audio: 0, link: 0 });
  assert.deepEqual(seccionesDeContenido({ ...nada, filtros: [] }), []);
});

test('la sección abierta no desaparece aunque se quede a cero', () => {
  const vistas = leerVistas(RESPUESTA);
  assert.ok(seccionesDeContenido(vistas, 'audio').some((s) => s.clave === 'audio'));
  assert.ok(!seccionesDeContenido(vistas).some((s) => s.clave === 'audio'));
});

test('«Media» junta fotos y vídeos, y un servidor antiguo no lo impide', () => {
  // El servidor nuevo dice cuántos mensajes hay: uno con foto Y vídeo cuenta una vez.
  const nuevo = conMedia({ media: 3, image: 2, video: 2 });
  assert.equal(nuevo.conMedia, true);
  const media = seccionesDeContenido(nuevo)[0];
  assert.equal(media?.clave, 'media');
  assert.equal(claveDeVista(vistaDeSeccion(media!, nuevo)), 'c:media');
  assert.equal(claveDeVista(vistaDeSeccion(media!, nuevo, 'video')), 'c:video');
  assert.deepEqual(opcionesDeMedia(nuevo), ['todo', 'image', 'video']);

  // El antiguo no nombra `media`: hay sección igual, y se pide lo que sepa servir.
  const viejo = leerVistas(RESPUESTA);
  assert.equal(viejo.conMedia, false);
  const suMedia = seccionesDeContenido(viejo)[0];
  assert.equal(claveDeVista(vistaDeSeccion(suMedia!, viejo)), 'c:image');
  const soloVideos = conMedia({ image: 0, video: 5 });
  assert.equal(claveDeVista(vistaDeSeccion(seccionesDeContenido(soloVideos)[0]!, soloVideos)), 'c:video');
});

test('dentro de «Media» solo se ofrece elegir cuando hay de las dos cosas', () => {
  assert.deepEqual(opcionesDeMedia(leerVistas(RESPUESTA)), [], 'solo hay fotos');
  assert.deepEqual(opcionesDeMedia(conMedia({ media: 4, image: 4, video: 0 })), []);
  // Con un servidor antiguo no hay «Todo» que pedir: se elige entre las dos.
  assert.deepEqual(opcionesDeMedia(conMedia({ image: 4, video: 1 })), ['image', 'video']);
});

test('una sección de filtro pide su filtro', () => {
  const vistas = leerVistas(RESPUESTA);
  const deFiltro = seccionesDeContenido(vistas).find((s) => s.tipo === 'filtro');
  assert.equal(claveDeVista(vistaDeSeccion(deFiltro!, vistas)), 'f:f1');
  const enlaces = seccionesDeContenido(vistas).find((s) => s.clave === 'link');
  assert.equal(claveDeVista(vistaDeSeccion(enlaces!, vistas)), 'c:link');
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
  // Ni un `.filter` sobre los mensajes para decidir qué entra en una sección:
  // lo que manda el servidor se enseña entero, también el enlace que el
  // teléfono no sepa reconocer.
  const pestanas = leer('../components/chat/PestanasDeContenido.tsx');
  assert.doesNotMatch(pestanas, /mensajes\s*\.filter\(/);
  assert.doesNotMatch(pestanas, /\.filter\(\(fila\)/);
  const pantalla = leer('../hooks/useMensajesDeVista.ts');
  assert.doesNotMatch(pantalla, /\.filter\(/);
  assert.match(pantalla, /MessageRepository\.mensajesDeVista\(conversationId, vista,/);
  // Cada petición lleva su turno y se cancela la anterior.
  assert.match(pantalla, /enCurso\.current\?\.abort\(\);/);
  assert.match(pantalla, /if \(!turnos\.vigente\(turno\)\) return;/);
});

test('los mensajes nuevos recargan la vista, con freno', () => {
  const pantalla = leer('../hooks/useMensajesDeVista.ts');
  assert.match(
    pantalla,
    /subscribeToConversationChanges\(conversationId, \(\) => \{\s*if \(pendiente\) return;/,
  );
  assert.match(pantalla, /ESPERA_ENTRE_RECARGAS_MS = 2000/);
});

test('el menú del chat solo sale cuando hay servidor al que preguntar', () => {
  const chat = leer('../screens/ChatScreen.tsx');
  assert.match(
    chat,
    /alAbrirMenu=\{supabaseEnabled && params\.id \? \(\) => setOpcionesAbiertas\(true\) : undefined\}/,
  );
  const cabecera = leer('../components/CabeceraDeChat.tsx');
  assert.match(cabecera, /rightIcon=\{alAbrirMenu \? 'more-vertical' : undefined\}/);
  assert.match(cabecera, /alAbrirMenu\?: \(\) => void;/);
});

test('pedir las vistas nunca falla hacia la pantalla', () => {
  const repositorio = leer('../repositories/MessageRepository.ts');
  const funcion = repositorio.slice(repositorio.indexOf('async vistas('));
  assert.match(funcion.slice(0, 500), /\/views`/);
  assert.match(funcion.slice(0, 500), /catch \{\s*return SIN_VISTAS;\s*\}/);
});
