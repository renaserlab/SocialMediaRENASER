import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * LOS BOTONES DE LA BANDEJA TIENEN QUE COINCIDIR CON LO QUE EL SERVIDOR ACEPTA.
 *
 * EL FALLO QUE ESTO IMPIDE. Un boton que el backend va a rechazar seguro no es
 * una opcion: es una trampa. «Aprobar» en una solicitud recien pedida —que
 * primero hay que tomar— o «Reintentar» sobre un reembolso que la pasarela ya
 * esta procesando terminan en el mismo sitio: un aviso de que se va a mover
 * dinero, una confirmacion, y un error. Y el segundo es peor que un boton
 * muerto: reintentar con un reembolso vivo es pedir el dinero dos veces.
 *
 * LO QUE NO SIGNIFICA. Esconder un boton NO es un permiso. El servidor sigue
 * comprobandolo todo, y por eso tambien se prueba que un 403 y un conflicto de
 * estado se digan con palabras distintas y distintas de «no se pudo cargar».
 *
 * Se mira el CODIGO FUENTE, como el resto de pruebas de esta carpeta.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

function sinComentarios(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const BANDEJA = sinComentarios(fuente('screens/AdminDevolucionesScreen.tsx'));
const REPO = sinComentarios(fuente('repositories/OwnerRepository.ts'));

/** La tabla del codigo, leida tal cual esta escrita. */
function tablaDeAcciones(): Record<string, string[]> {
  const inicio = BANDEJA.indexOf('const ACCIONES_POR_ESTADO');
  assert.ok(inicio > 0, 'no hay tabla de acciones por estado');
  const abre = BANDEJA.indexOf('{', inicio);
  const cierra = BANDEJA.indexOf('};', abre);
  const cuerpo = BANDEJA.slice(abre + 1, cierra);
  const tabla: Record<string, string[]> = {};
  for (const [, estado, lista] of cuerpo.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
    tabla[estado] = [...lista.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  }
  return tabla;
}

const TABLA = tablaDeAcciones();

/**
 * El contrato, estado por estado.
 *
 * `refund_processing` esta aqui en su forma SIN referencia externa; la otra
 * mitad la decide `accionesDisponibles` y tiene su propia prueba.
 */
const CONTRATO: Record<string, string[]> = {
  requested: ['take', 'cancel'],
  under_review: ['approve', 'reject', 'cancel'],
  approved: ['execute', 'cancel'],
  refund_processing: ['retry'],
  refunded: [],
  rejected: [],
  failed: ['retry', 'cancel'],
  cancelled: [],
};

// ---------------------------------------------------------------------------
// 1. La tabla, estado por estado
// ---------------------------------------------------------------------------

for (const [estado, esperadas] of Object.entries(CONTRATO)) {
  test(`«${estado}» ofrece exactamente ${esperadas.join(', ') || 'nada'}`, () => {
    assert.deepEqual(
      TABLA[estado],
      esperadas,
      `las acciones de ${estado} no son las que el servidor acepta`,
    );
  });
}

test('la tabla cubre los ocho estados y ninguno mas', () => {
  assert.deepEqual(Object.keys(TABLA).sort(), Object.keys(CONTRATO).sort());
});

test('una solicitud recien pedida hay que TOMARLA antes de resolverla', () => {
  // Aprobar o rechazar sin tomarla es la transicion que la maquina de estados
  // del backend no permite: `requested` solo va a `under_review` o `cancelled`.
  assert.ok(!TABLA.requested?.includes('approve'));
  assert.ok(!TABLA.requested?.includes('reject'));
});

test('desde «approved» se EJECUTA el reembolso, que antes no se podia', () => {
  assert.ok(TABLA.approved?.includes('execute'), 'aprobar dejaba el expediente parado');
  assert.match(BANDEJA, /execute: 'ejecutar',/);
  assert.match(BANDEJA, /execute: 'devolucionesAdmin\.avisoEjecutar',/);
});

test('lo que ya termino no ofrece nada', () => {
  for (const final of ['refunded', 'rejected', 'cancelled']) {
    assert.deepEqual(TABLA[final], [], `${final} sigue ofreciendo acciones`);
  }
});

// ---------------------------------------------------------------------------
// 2. `refund_processing`: la referencia externa lo decide
// ---------------------------------------------------------------------------

test('con reembolso ya pedido a la pasarela solo cabe CONCILIAR', () => {
  /*
    Reintentar con una referencia viva es pedir el dinero dos veces, y el
    backend lo rechaza. Sin referencia no hay nada que preguntar y lo que toca
    es volver a ejecutarlo.
  */
  assert.match(
    BANDEJA,
    /if \(solicitud\.status === 'refund_processing'\) \{\s*return solicitud\.externalReference \? \['reconcile'\] : \['retry'\];/,
  );
});

test('la referencia externa llega del servidor, no se supone', () => {
  assert.match(REPO, /externalReference: textoONulo\(dto\.external_refund_id \?\? dto\.external_reference\)/);
  // Una cadena vacia no es una referencia: con ella se ofreceria conciliar algo
  // que no existe.
  assert.match(REPO, /valor\.trim\(\) !== ''/);
});

test('la pantalla usa la tabla ya resuelta, no la cruda', () => {
  assert.match(BANDEJA, /const disponibles = accionesDisponibles\(solicitud\);/);
});

// ---------------------------------------------------------------------------
// 3. Ejecutar y reintentar son la misma ruta, con nombres distintos
// ---------------------------------------------------------------------------

test('el nombre del endpoint vive en UN solo sitio', () => {
  // Si el backend separa ejecutar de reintentar, solo cambia esta tabla.
  assert.match(REPO, /const ENDPOINT_DE_ACCION: Record<AccionDeDevolucion, string>/);
  assert.match(REPO, /execute: 'retry',/);
  assert.match(REPO, /refund-requests\/\$\{id\}\/\$\{ENDPOINT_DE_ACCION\[accion\]\}/);
});

test('ejecutar avisa antes, como toda accion que mueve dinero', () => {
  assert.match(REPO, /ACCIONES_FINANCIERAS: readonly AccionDeDevolucion\[\] = \[[^\]]*'execute'/);
  const ejecutar = BANDEJA.slice(BANDEJA.indexOf('const ejecutar'));
  const confirmacion = ejecutar.indexOf('await confirm(');
  const peticion = ejecutar.indexOf('OwnerRepository.accion');
  assert.ok(confirmacion > 0 && peticion > confirmacion, 'se actua antes de avisar');
});

test('sigue sin poderse pulsar dos veces', () => {
  assert.match(BANDEJA, /if \(enviandoRef\.current\) return;/);
  assert.match(BANDEJA, /const ocupado = enviando !== null;/);
  assert.match(BANDEJA, /disabled=\{ocupado\}/);
});

// ---------------------------------------------------------------------------
// 4. Rechazar exige motivo, y los errores se distinguen
// ---------------------------------------------------------------------------

test('rechazar SIN motivo no llega al servidor', () => {
  const ejecutar = BANDEJA.slice(BANDEJA.indexOf('const ejecutar'));
  const guarda = ejecutar.indexOf("accion === 'reject' && motivo === ''");
  const peticion = ejecutar.indexOf('OwnerRepository.accion');
  assert.ok(guarda > 0, 'no se comprueba el motivo antes de rechazar');
  assert.ok(peticion > guarda, 'se envia el rechazo sin comprobar el motivo');
  assert.match(ejecutar.slice(guarda, peticion), /notify\(t\('devolucionesAdmin\.notasFaltan'\)\)/);
  assert.match(ejecutar.slice(guarda, peticion), /return;/);
});

test('un 403 se dice con sus palabras, distintas del fallo de carga', () => {
  // Esconder un boton no es un permiso: quien llegue igualmente tiene que leer
  // que su cuenta no puede, no un «no pudimos» que invita a reintentar.
  assert.match(BANDEJA, /esProhibido\(e\)\s*\?\s*t\('devolucionesAdmin\.sinPermiso'\)/);
  // Y el fallo de CARGA de la lista es otro mensaje y otro sitio.
  assert.match(BANDEJA, /if \(esProhibido\(e\)\) setProhibido\(true\);/);
  assert.match(BANDEJA, /else setError\(e instanceof Error \? e\.message : t\('common\.loadFailed'\)\)/);
});

test('un conflicto de estado no se confunde con un fallo cualquiera', () => {
  /*
    409 o 422 es «el expediente ya no esta en ese estado» —otro administrador,
    o un webhook que llego entre medias—. Reintentar no arregla nada: hay que
    releer, y por eso se relee.
  */
  assert.match(BANDEJA, /function esConflictoDeEstado\(error: unknown\): boolean/);
  assert.match(BANDEJA, /error\.status === 409 \|\| error\.status === 422/);
  assert.match(BANDEJA, /t\('devolucionesAdmin\.conflicto'\)/);
  const ejecutar = BANDEJA.slice(BANDEJA.indexOf('const ejecutar'));
  assert.match(ejecutar, /if \(conflicto\) \{[\s\S]{0,160}OwnerRepository\.solicitud\(solicitud\.id\)/);
});

test('los tres desenlaces son tres mensajes distintos', () => {
  for (const clave of [
    'devolucionesAdmin.sinPermiso',
    'devolucionesAdmin.conflicto',
    'devolucionesAdmin.fallo',
  ]) {
    assert.match(BANDEJA, new RegExp(clave.replace('.', '\\.')), `falta el mensaje ${clave}`);
  }
});
