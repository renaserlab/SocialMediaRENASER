import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_TEMAS_DEL_AUTOR,
  PASOS,
  accionFinal,
  avisoDeRevision,
  duracionLegible,
  duracionTotal,
  maximoDeTemas,
  moviendo,
  pasoCompleto,
  temasAlElegirCategoria,
  totalDeLecciones,
  totalDeTemas,
  type BorradorDeCurso,
  type ResumenDeModulo,
} from './asistenteDeCurso.ts';

/**
 * La lógica del asistente de curso.
 *
 * LO QUE **NO** SE PRUEBA AQUÍ: si un curso se puede publicar. Esa decisión es
 * del servidor (`_requisitos_que_faltan`) y tiene sus propias pruebas en
 * `apps/api/tests/test_cursos_v2.py`. Lo de aquí son las pistas del indicador
 * de pasos, que no impiden nada.
 */

const BASE: BorradorDeCurso = {
  title: '',
  subtitle: '',
  description: '',
  primaryTopicId: null,
  topicIds: [],
  level: null,
  language: 'es',
  highlights: [],
  targetAudience: [],
  prerequisites: [],
  dePago: false,
  precio: '',
};

const COMPLETO: BorradorDeCurso = {
  ...BASE,
  title: 'Liderazgo consciente',
  description: 'Una descripción larga de verdad, de más de treinta caracteres.',
  primaryTopicId: 'tema-1',
  level: 'beginner',
  highlights: ['Tomar decisiones difíciles'],
};

function modulos(...duraciones: number[][]): ResumenDeModulo[] {
  return duraciones.map((lecciones, i) => ({
    id: `m${i}`,
    lessons: lecciones.map((durationSeconds, j) => ({ id: `l${i}-${j}`, durationSeconds })),
  }));
}

// ---------------------------------------------------------------------------
// Duración
// ---------------------------------------------------------------------------

test('la duración total suma todas las lecciones de todos los módulos', () => {
  assert.equal(duracionTotal(modulos([600, 600], [1200])), 2400);
  assert.equal(duracionTotal([]), 0);
});

test('un curso sin contenido no dura cero: es que no tiene contenido', () => {
  // «0 min» hace pensar en un curso vacío que sí existe. Son cosas distintas
  // para quien lo lee, y la ficha tiene que decir cuál de las dos es.
  assert.equal(duracionLegible(0), 'Sin contenido todavía');
  assert.equal(duracionLegible(-5), 'Sin contenido todavía');
});

test('la duración se lee en horas y minutos', () => {
  assert.equal(duracionLegible(60), '1 min');
  assert.equal(duracionLegible(2700), '45 min');
  assert.equal(duracionLegible(3600), '1 h');
  assert.equal(duracionLegible(12000), '3 h 20 min');
});

test('una lección de veinte segundos no desaparece al redondear', () => {
  // Redondear a cero diría que el curso no tiene contenido, y sí lo tiene.
  assert.equal(duracionLegible(20), '1 min');
});

test('se cuentan las lecciones de todos los módulos', () => {
  assert.equal(totalDeLecciones(modulos([1, 2, 3], [4])), 4);
  assert.equal(totalDeLecciones(modulos([], [])), 0);
});

// ---------------------------------------------------------------------------
// Pasos
// ---------------------------------------------------------------------------

test('los pasos son los cinco acordados y en orden', () => {
  assert.deepEqual(
    PASOS.map((p) => p.id),
    ['basico', 'oferta', 'contenido', 'precio', 'revisar'],
  );
});

test('el paso básico necesita título, descripción larga, categoría y nivel', () => {
  assert.equal(pasoCompleto('basico', BASE, []), false);
  assert.equal(pasoCompleto('basico', COMPLETO, []), true);
  assert.equal(pasoCompleto('basico', { ...COMPLETO, level: null }, []), false);
  assert.equal(pasoCompleto('basico', { ...COMPLETO, primaryTopicId: null }, []), false);
  assert.equal(pasoCompleto('basico', { ...COMPLETO, description: 'Corta' }, []), false);
});

test('el paso de qué ofrece necesita al menos un resultado de aprendizaje', () => {
  assert.equal(pasoCompleto('oferta', BASE, []), false);
  // Un punto en blanco no cuenta: se pinta como una viñeta vacía.
  assert.equal(pasoCompleto('oferta', { ...BASE, highlights: ['   '] }, []), false);
  assert.equal(pasoCompleto('oferta', COMPLETO, []), true);
});

test('el paso de contenido necesita un módulo Y una lección', () => {
  assert.equal(pasoCompleto('contenido', BASE, []), false);
  assert.equal(pasoCompleto('contenido', BASE, modulos([])), false);
  assert.equal(pasoCompleto('contenido', BASE, modulos([600])), true);
});

test('gratuito ya es una respuesta; de pago necesita importe', () => {
  assert.equal(pasoCompleto('precio', BASE, []), true);
  assert.equal(pasoCompleto('precio', { ...BASE, dePago: true }, []), false);
  assert.equal(pasoCompleto('precio', { ...BASE, dePago: true, precio: '49.90' }, []), true);
});

test('el paso de revisar nunca se marca como completo', () => {
  // Es donde se mira todo lo demás: decir que está «completo» no significaría
  // nada, y un tic ahí invitaría a no leerlo.
  assert.equal(pasoCompleto('revisar', COMPLETO, modulos([600])), false);
});

// ---------------------------------------------------------------------------
// Revisión
// ---------------------------------------------------------------------------

test('cada estado de la revisión se cuenta con icono y texto, no con color', () => {
  const estados = ['draft', 'pending_review', 'approved', 'rejected', undefined];
  const iconos = estados.map((e) => avisoDeRevision(e).icono);
  assert.equal(new Set(iconos.slice(0, 4)).size, 4, 'cada estado tiene su propio icono');
  for (const estado of estados) {
    const aviso = avisoDeRevision(estado);
    assert.ok(aviso.titulo.length > 0);
    assert.ok(aviso.detalle.length > 0);
  }
});

test('un rechazo enseña el motivo, y si no lo hay lo dice', () => {
  assert.match(avisoDeRevision('rejected', 'La portada no es tuya.').detalle, /portada/);
  assert.match(avisoDeRevision('rejected', '   ').detalle, /No se indicó un motivo/);
  assert.match(avisoDeRevision('rejected', null).detalle, /No se indicó un motivo/);
});

test('un estado desconocido cae en borrador y no en un hueco', () => {
  assert.equal(avisoDeRevision('lo_que_sea').titulo, 'Borrador');
});

// ---------------------------------------------------------------------------
// Qué botón se ofrece al final
// ---------------------------------------------------------------------------

test('sin revisión disponible se ofrece publicar, nunca un botón que da 503', () => {
  // Es el mundo de HOY: la 0034 espera aprobación y el servidor responde 503 a
  // cualquier intento de enviar a revisión.
  assert.equal(accionFinal(false, 'draft'), 'publicar');
  assert.equal(accionFinal(false, 'rejected'), 'publicar');
});

test('con revisión disponible, el botón depende de dónde esté', () => {
  assert.equal(accionFinal(true, 'draft'), 'enviar');
  assert.equal(accionFinal(true, 'rejected'), 'enviar');
  assert.equal(accionFinal(true, 'pending_review'), 'esperar');
  assert.equal(accionFinal(true, 'approved'), 'publicar');
});

// ---------------------------------------------------------------------------
// Temas: son 1 + 5, no 5 en total
// ---------------------------------------------------------------------------

test('elegir categoría principal NO le quita un hueco al autor', () => {
  // La regla: la categoría es la categoría y los cinco son «el resto». Cuando
  // descontaba, elegir categoría dejaba al autor con cuatro huecos de golpe y
  // nada explicaba por qué se le había encogido la lista.
  assert.equal(maximoDeTemas(null), MAX_TEMAS_DEL_AUTOR);
  assert.equal(maximoDeTemas('tema-principal'), MAX_TEMAS_DEL_AUTOR);
  assert.equal(MAX_TEMAS_DEL_AUTOR, 5);
});

test('con categoría principal, un curso llega a seis temas: la suya y cinco más', () => {
  const cinco = ['a', 'b', 'c', 'd', 'e'];
  assert.equal(totalDeTemas(cinco, 'principal'), 6);
  // Y el sexto del autor sí sobra: el tope sigue siendo un tope.
  assert.ok(cinco.length <= MAX_TEMAS_DEL_AUTOR);
  assert.ok(['a', 'b', 'c', 'd', 'e', 'f'].length > MAX_TEMAS_DEL_AUTOR);
});

test('sin categoría principal el curso llega a cinco', () => {
  assert.equal(totalDeTemas(['a', 'b', 'c', 'd', 'e'], null), 5);
  assert.equal(totalDeTemas([], null), 0);
});

test('elegir categoría no recorta los temas que ya había', () => {
  // El fallo que fija: se recortaban a cuatro al elegir categoría, así que un
  // tema elegido antes desaparecía sin que nadie lo hubiera quitado.
  const cinco = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(temasAlElegirCategoria(cinco, 'principal'), cinco);
});

test('la categoría no aparece además como tema suelto', () => {
  // Estaría dos veces en la ficha, y quitarla de la fila de temas parecería
  // quitarla del curso sin hacerlo.
  assert.deepEqual(temasAlElegirCategoria(['a', 'principal', 'b'], 'principal'), ['a', 'b']);
  assert.equal(totalDeTemas(['a', 'principal', 'b'], 'principal'), 3);
});

test('quitar la categoría deja los temas del autor intactos', () => {
  assert.deepEqual(temasAlElegirCategoria(['a', 'b'], null), ['a', 'b']);
  assert.equal(totalDeTemas(['a', 'b'], null), 2);
});

// ---------------------------------------------------------------------------
// Reordenar
// ---------------------------------------------------------------------------

test('mover una fila deja el resto en su orden', () => {
  assert.deepEqual(moviendo(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moviendo(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
  assert.deepEqual(moviendo(['a', 'b', 'c'], 1, 0), ['b', 'a', 'c']);
});

test('un movimiento imposible devuelve LA MISMA lista, para no escribir nada', () => {
  // La identidad importa: quien llama la usa para decidir si hay que guardar.
  // Subir el primero o bajar el último no puede disparar cinco escrituras.
  const ids = ['a', 'b', 'c'];
  assert.equal(moviendo(ids, 0, -1), ids);
  assert.equal(moviendo(ids, 2, 3), ids);
  assert.equal(moviendo(ids, 1, 1), ids);
  assert.equal(moviendo(ids, 5, 0), ids);
});
