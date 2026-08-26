import assert from 'node:assert/strict';
import test from 'node:test';

import { partirEnEtiquetas } from './etiquetasEnTexto.ts';

/**
 * Pintar NO puede cambiar lo que alguien escribio.
 *
 * Es la propiedad que de verdad importa de este fichero, y por eso se comprueba
 * en casi todas las pruebas: si al colorear una etiqueta se perdiera un espacio
 * o se comiera una coma, el texto que se lee en el muro dejaria de ser el que
 * se publico, y nadie lo notaria hasta que alguien comparase.
 */
function reconstruir(cuerpo: string): string {
  return partirEnEtiquetas(cuerpo)
    .map((trozo) => (trozo.tipo === 'etiqueta' ? `#${trozo.valor}` : trozo.valor))
    .join('');
}

const etiquetasDe = (cuerpo: string) =>
  partirEnEtiquetas(cuerpo)
    .filter((t) => t.tipo === 'etiqueta')
    .map((t) => t.valor);

test('encuentra las etiquetas del texto', () => {
  assert.deepEqual(etiquetasDe('Hoy aprendi de #Python y de #IA'), ['Python', 'IA']);
});

test('conserva como se escribio: no normaliza aqui', () => {
  /*
    Normalizar tambien en el movil seria tener la regla en dos sitios. La forma
    normalizada la decide el servidor; aqui se navega con lo que se escribio y
    es el backend quien resuelve que «#MiNegocio» es «minegocio».
  */
  assert.deepEqual(etiquetasDe('Sobre #MiNegocio'), ['MiNegocio']);
});

test('el texto se reconstruye entero', () => {
  const cuerpo = 'Hoy aprendi de #Python y de #IA, un buen dia.';
  assert.equal(reconstruir(cuerpo), cuerpo);
});

test('un texto sin etiquetas se devuelve tal cual', () => {
  const cuerpo = 'Hoy fue un buen dia';
  assert.deepEqual(partirEnEtiquetas(cuerpo), [{ tipo: 'texto', valor: cuerpo }]);
});

test('una almohadilla a mitad de palabra no es una etiqueta', () => {
  // «C#» y «correo#interno» no son etiquetas de nadie.
  assert.deepEqual(etiquetasDe('Programo en C# desde 2010'), []);
  assert.deepEqual(etiquetasDe('escribe a correo#interno'), []);
  assert.equal(reconstruir('Programo en C# desde 2010'), 'Programo en C# desde 2010');
});

test('una etiqueta al principio del texto tambien se reconoce', () => {
  // El caso que rompe cualquier version escrita con lookbehind mal puesto: no
  // hay ningun caracter delante que capturar.
  assert.deepEqual(etiquetasDe('#python es lo mio'), ['python']);
  assert.equal(reconstruir('#python es lo mio'), '#python es lo mio');
});

test('se corta en el signo de puntuacion', () => {
  assert.deepEqual(etiquetasDe('Me gusta #python. Y ya.'), ['python']);
  assert.equal(reconstruir('Me gusta #python. Y ya.'), 'Me gusta #python. Y ya.');
});

test('las tildes y la eñe forman parte de la etiqueta', () => {
  assert.deepEqual(etiquetasDe('Sobre #Programación y #años'), ['Programación', 'años']);
});

test('dos etiquetas seguidas se separan bien', () => {
  assert.deepEqual(etiquetasDe('#uno #dos'), ['uno', 'dos']);
  assert.equal(reconstruir('#uno #dos'), '#uno #dos');
});

test('una etiqueta repetida se pinta las veces que aparece', () => {
  /*
    Al PINTAR se marcan todas: el texto dice «#ia» dos veces y las dos tienen
    que poder tocarse. Que cuenten como UNA sola etiqueta es cosa del servidor
    al guardar, que es otra pregunta distinta.
  */
  assert.deepEqual(etiquetasDe('#ia y otra vez #ia'), ['ia', 'ia']);
});

test('llamarla dos veces da el mismo resultado', () => {
  /*
    La expresion regular es de modulo y `lastIndex` sobrevive entre llamadas.
    Sin reiniciarlo, la segunda publicacion del muro empezaria a buscar por
    donde se quedo la primera y se dejaria etiquetas sin pintar.
  */
  const cuerpo = 'Sobre #python';
  assert.deepEqual(partirEnEtiquetas(cuerpo), partirEnEtiquetas(cuerpo));
});

test('un texto vacio no revienta', () => {
  assert.deepEqual(partirEnEtiquetas(''), []);
});

test('una almohadilla suelta no es una etiqueta', () => {
  assert.deepEqual(etiquetasDe('Puse # y ya'), []);
  assert.equal(reconstruir('Puse # y ya'), 'Puse # y ya');
});
