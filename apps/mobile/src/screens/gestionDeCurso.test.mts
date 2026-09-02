import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * GESTIONAR UN CURSO NO ES CREARLO, Y CONSULTAR NO ES RESOLVER.
 *
 * EL FALLO QUE ESTO IMPIDE. Todo lo de «después» de publicar un curso —quién
 * está dentro, qué se cobró, qué se devolvió— cabe, aparentemente, dentro del
 * asistente de creación: ya está ahí el curso y ya está ahí el formulario. Pero
 * entonces para mirar a tus alumnos hay que entrar en la pantalla desde la que
 * se cambia el precio, y la creación de un curso pasa a arrastrar peticiones de
 * dinero que no tiene por qué conocer.
 *
 * LO SEGUNDO, más grave. Quien vende un curso NO puede aprobar la devolución de
 * su propio curso: es su dinero el que se va. Su pantalla consulta; la de
 * administración resuelve. Si algún día aparece un «Aprobar» en la pantalla del
 * propietario, esta prueba falla.
 *
 * Se mira el CÓDIGO FUENTE, como el resto de pruebas de esta carpeta: montar la
 * vista pediría un renderizador de React Native que este proyecto no tiene en
 * las pruebas. Y lo que hay que impedir no es un valor mal calculado, sino que
 * alguien vuelva a mezclar dos superficies que tienen permisos distintos.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

/** Quita los comentarios: lo que se busca tiene que estar en el codigo. */
function sinComentarios(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const GESTION = sinComentarios(fuente('screens/GestionDeCursoScreen.tsx'));
const ESTUDIANTES = sinComentarios(fuente('screens/EstudiantesDelCursoScreen.tsx'));
const VENTAS = sinComentarios(fuente('screens/VentasDelCursoScreen.tsx'));
const ASISTENTE = sinComentarios(fuente('screens/AsistenteDeCursoScreen.tsx'));
const PERFIL = sinComentarios(fuente('components/ProfileSection.tsx'));
const REPO = sinComentarios(fuente('repositories/OwnerRepository.ts'));

// ---------------------------------------------------------------------------
// 1. La gestion NO vive dentro del asistente de creacion
// ---------------------------------------------------------------------------

test('el asistente de creacion no sabe de alumnos, ventas ni devoluciones', () => {
  for (const ajeno of [
    'OwnerRepository',
    'EstudiantesDelCurso',
    'VentasDelCurso',
    'refund-requests',
    '/students',
  ]) {
    assert.doesNotMatch(ASISTENTE, new RegExp(ajeno), `el asistente arrastra ${ajeno}`);
  }
});

test('la gestion tiene sus propias pantallas, no un paso mas del asistente', () => {
  assert.match(GESTION, /gestionar-curso\/\$\{courseId\}\/estudiantes/);
  assert.match(GESTION, /gestionar-curso\/\$\{courseId\}\/ventas/);
});

test('«Editar curso» ABRE el asistente existente, no lo reimplementa', () => {
  assert.match(GESTION, /editar-curso\/\$\{courseId\}/);
  // Si aqui aparecieran los campos del asistente, serian dos formularios para
  // un solo curso: lo que se arregle en uno seguiria roto en el otro.
  for (const campo of ['CourseContentEditor', 'priceMinor', 'submitForReview']) {
    assert.doesNotMatch(GESTION, new RegExp(campo), `la gestion repite ${campo}`);
  }
});

// ---------------------------------------------------------------------------
// 2. La entrada esta en el perfil, y SOLO para el autor
// ---------------------------------------------------------------------------

test('el perfil ofrece «Gestionar curso» y lleva a la pantalla nueva', () => {
  assert.match(PERFIL, /section\.manageCourse/);
  assert.match(PERFIL, /gestionar-curso\/\$\{course\.id\}/);
});

test('la entrada se decide por AUTORIA, no por el permiso de moderar', () => {
  // `canManage` es cierto tambien para la administracion: usarlo aqui pondria
  // la gestion de los cursos ajenos colgando del perfil de cualquier moderador.
  assert.match(PERFIL, /esAutorDe\(course\)/);
  assert.match(PERFIL, /curso\.authorId === miId/);
});

// ---------------------------------------------------------------------------
// 3. El propietario CONSULTA: ni resuelve devoluciones ni ve lo que no es suyo
// ---------------------------------------------------------------------------

test('la pantalla del propietario no tiene aprobar ni rechazar', () => {
  for (const accion of ['aprobar', 'rechazar', 'approve', 'reject']) {
    assert.doesNotMatch(VENTAS, new RegExp(accion, 'i'), `el propietario puede ${accion}`);
  }
});

test('el propietario no llama a ninguna accion de la bandeja administrativa', () => {
  assert.doesNotMatch(VENTAS, /OwnerRepository\.accion/);
  assert.doesNotMatch(VENTAS, /refund-requests/);
});

test('no se le enseñan notas internas, motivos privados ni ids de pasarela', () => {
  for (const prohibido of ['reviewNotes', 'internalNotes', 'provider', 'orderId', 'reason']) {
    assert.doesNotMatch(VENTAS, new RegExp(prohibido), `las ventas enseñan ${prohibido}`);
  }
});

test('la venta que se pinta no lleva comprador', () => {
  // El balance de un curso no es la ficha financiera de quien compro.
  assert.doesNotMatch(REPO, /buyer|purchaser|comprador/i);
});

// ---------------------------------------------------------------------------
// 4. Estudiantes: paginacion de verdad y mensajeria reutilizada
// ---------------------------------------------------------------------------

test('la lista de estudiantes se pagina contra el servidor', () => {
  assert.match(ESTUDIANTES, /offset: alumnos\.length/);
  assert.match(ESTUDIANTES, /onEndReached/);
  assert.match(ESTUDIANTES, /alumnos\.cargarMas/);
});

test('la busqueda y el filtro viajan al servidor, no se aplican sobre lo bajado', () => {
  // Filtrar aqui diria «nadie coincide» sobre una lista que no esta entera.
  assert.match(ESTUDIANTES, /q: busqueda \|\| undefined/);
  assert.match(ESTUDIANTES, /state: filtro/);
  assert.doesNotMatch(ESTUDIANTES, /alumnos\.filter\(/);
});

test('«Mensaje» REUTILIZA la mensajeria que ya hay', () => {
  // El mismo camino que el perfil y las historias: conversacion idempotente en
  // el servidor y la pantalla de chat de siempre.
  assert.match(ESTUDIANTES, /MessageRepository\.getOrCreateDirect\(alumno\.id\)/);
  assert.match(ESTUDIANTES, /pathname: '\/chat\/\[id\]'/);
});

test('no se escribe otro chat dentro de la lista de estudiantes', () => {
  for (const propio of ['listMessages', 'sendMessage', 'FlatList inverted']) {
    assert.doesNotMatch(ESTUDIANTES, new RegExp(propio), `la lista repite ${propio}`);
  }
});

test('dos toques seguidos no crean dos conversaciones', () => {
  // El cerrojo es una `ref`: el estado no esta puesto hasta el siguiente
  // render, y dos toques rapidos caben de sobra en ese hueco.
  assert.match(ESTUDIANTES, /if \(chatRef\.current\) return;/);
  const manejador = ESTUDIANTES.slice(ESTUDIANTES.indexOf('const escribirA'));
  const cerrojo = manejador.indexOf('chatRef.current = true');
  const peticion = manejador.indexOf('getOrCreateDirect');
  assert.ok(cerrojo > 0 && peticion > cerrojo, 'se pide la conversacion antes de cerrar');
});

test('el avatar y el nombre abren el perfil por ID', () => {
  assert.match(ESTUDIANTES, /irAlPerfil\(router, item\.id\)/);
});

test('hay estado vacio, de carga y de error con reintento', () => {
  assert.match(ESTUDIANTES, /state="loading"/);
  assert.match(ESTUDIANTES, /state="error"[\s\S]{0,120}onRetry/);
  assert.match(ESTUDIANTES, /alumnos\.vacioTitulo/);
});

// ---------------------------------------------------------------------------
// 5. El 403 se dice, no se disfraza
// ---------------------------------------------------------------------------

test('un 403 se distingue de un fallo de carga', () => {
  // Esconder un boton no es un permiso: quien entre igualmente tiene que leer
  // que el curso no es suyo, no una pantalla cargando para siempre.
  assert.match(GESTION, /error instanceof ApiError && error\.status === 403/);
  for (const pantalla of [
    ['gestion', GESTION],
    ['estudiantes', ESTUDIANTES],
    ['ventas', VENTAS],
  ] as const) {
    assert.match(pantalla[1], /esProhibido\(e\)/, `${pantalla[0]} no distingue el 403`);
    assert.match(pantalla[1], /gestion\.sinPermiso/, `${pantalla[0]} no lo explica`);
  }
});
