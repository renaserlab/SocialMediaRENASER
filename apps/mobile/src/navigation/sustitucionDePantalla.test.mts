import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PILA_VACIA,
  anotar,
  asentar,
  esSustitucion,
  fotoDe,
  llegaSinAnimacion,
  nuevoRegistro,
} from './sustitucionDePantalla.ts';

/**
 * LA PANTALLA GRIS AL TERMINAR UN TRÁMITE (teléfono; 06, 07 y 12/10/2026).
 *
 * Lo que se comprueba aquí es la regla: cuándo una pantalla «sustituye» a la
 * de arriba, que llega sin animación y que después la recupera. Que eso quite
 * el gris en un teléfono no lo puede decir una prueba: la causa está en cómo
 * Android anima dos pantallas a la vez, y solo se ve en un teléfono.
 */

const RAIZ = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const fuente = (rel: string) => readFileSync(join(RAIZ, rel), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (codigo: string) =>
  codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const pila = (...claves: string[]) => ({ claves, cima: claves[claves.length - 1] ?? null });
const estado = (...claves: string[]) => ({
  index: claves.length - 1,
  routes: claves.map((key) => ({ key })),
});

describe('cuándo una pantalla sustituye a la de arriba', () => {
  it('publicar un curso abierto desde «Crear»: el asistente se va y entra Cursos', () => {
    assert.equal(esSustitucion(pila('tabs', 'asistente'), pila('tabs', 'cursos')), true);
  });

  it('crear un producto: «nuevo» se cambia por la ficha del que se creó', () => {
    assert.equal(esSustitucion(pila('tabs', 'lista', 'nuevo'), pila('tabs', 'lista', 'ficha')), true);
  });

  it('fijar la contraseña: se vacía la pila entera y entra Inicio', () => {
    assert.equal(esSustitucion(pila('bienvenida', 'correo', 'clave'), pila('tabs')), true);
  });

  it('avanzar no es sustituir: la de antes sigue debajo', () => {
    assert.equal(esSustitucion(pila('tabs'), pila('tabs', 'curso')), false);
  });

  it('volver atrás no es sustituir: la que queda ya estaba', () => {
    assert.equal(esSustitucion(pila('tabs', 'curso'), pila('tabs')), false);
    assert.equal(esSustitucion(pila('tabs', 'a', 'b', 'c'), pila('tabs', 'a')), false);
  });

  it('volver a una pantalla que SÍ estaba (Cursos → asistente → publicar) tampoco', () => {
    assert.equal(esSustitucion(pila('tabs', 'cursos', 'asistente'), pila('tabs', 'cursos')), false);
  });

  it('la primera pantalla de la aplicación no sustituye a nadie', () => {
    assert.equal(esSustitucion(PILA_VACIA, pila('tabs')), false);
  });

  it('si no cambia la de arriba, no hay nada que decidir', () => {
    assert.equal(esSustitucion(pila('tabs', 'curso'), pila('tabs', 'curso')), false);
  });
});

describe('la foto de la pila', () => {
  it('sale del estado de la navegación', () => {
    assert.deepEqual(fotoDe(estado('tabs', 'curso')), { claves: ['tabs', 'curso'], cima: 'curso' });
  });

  it('sin estado todavía, la pila está vacía', () => {
    assert.equal(fotoDe(undefined), PILA_VACIA);
    assert.equal(fotoDe(null), PILA_VACIA);
    assert.equal(fotoDe({ index: 0, routes: [] }), PILA_VACIA);
  });
});

describe('lo que la pila recuerda entre un dibujo y el siguiente', () => {
  it('la que llega sustituyendo queda sin animación; las demás, no', () => {
    const registro = nuevoRegistro();
    anotar(registro, fotoDe(estado('tabs')));
    anotar(registro, fotoDe(estado('tabs', 'asistente')));
    assert.equal(llegaSinAnimacion(registro, 'asistente'), false);

    anotar(registro, fotoDe(estado('tabs', 'cursos')));
    assert.equal(llegaSinAnimacion(registro, 'cursos'), true);
    assert.equal(llegaSinAnimacion(registro, 'tabs'), false);
  });

  it('preguntar varias veces por el mismo estado no cambia nada', () => {
    // Las opciones se calculan una vez por pantalla y por dibujo.
    const registro = nuevoRegistro();
    anotar(registro, fotoDe(estado('tabs', 'asistente')));
    for (let i = 0; i < 4; i += 1) anotar(registro, fotoDe(estado('tabs', 'cursos')));
    assert.equal(llegaSinAnimacion(registro, 'cursos'), true);
    assert.equal(registro.sinAnimacion.size, 1);
  });

  it('terminada la llegada recupera su animación, y avisa una sola vez', () => {
    const registro = nuevoRegistro();
    anotar(registro, fotoDe(estado('tabs', 'asistente')));
    anotar(registro, fotoDe(estado('tabs', 'cursos')));

    assert.equal(asentar(registro, 'cursos'), true);
    assert.equal(llegaSinAnimacion(registro, 'cursos'), false);
    // Un segundo aviso —o el de una pantalla cualquiera— no pide dibujar nada.
    assert.equal(asentar(registro, 'cursos'), false);
    assert.equal(asentar(registro, 'tabs'), false);
    assert.equal(asentar(registro, undefined), false);
  });

  it('asentada, seguir navegando no la vuelve a marcar', () => {
    const registro = nuevoRegistro();
    anotar(registro, fotoDe(estado('tabs', 'asistente')));
    anotar(registro, fotoDe(estado('tabs', 'cursos')));
    asentar(registro, 'cursos');
    anotar(registro, fotoDe(estado('tabs', 'cursos', 'curso')));
    anotar(registro, fotoDe(estado('tabs', 'cursos')));
    assert.equal(llegaSinAnimacion(registro, 'cursos'), false);
  });

  it('si se sale antes de que termine de llegar, no se queda apuntada', () => {
    const registro = nuevoRegistro();
    anotar(registro, fotoDe(estado('tabs', 'asistente')));
    anotar(registro, fotoDe(estado('tabs', 'cursos')));
    anotar(registro, fotoDe(estado('tabs')));
    assert.equal(registro.sinAnimacion.size, 0);
  });

  it('dos sustituciones seguidas: cada una llega sin animación', () => {
    const registro = nuevoRegistro();
    anotar(registro, fotoDe(estado('tabs', 'leccion-1')));
    anotar(registro, fotoDe(estado('tabs', 'leccion-2')));
    anotar(registro, fotoDe(estado('tabs', 'leccion-3')));
    assert.equal(llegaSinAnimacion(registro, 'leccion-3'), true);
    assert.equal(llegaSinAnimacion(registro, 'leccion-2'), false);
  });
});

describe('la pila raíz aplica la regla', () => {
  const raiz = sinComentarios(fuente('app/_layout.tsx'));

  it('apunta la pila y decide la animación de cada pantalla al dibujarla', () => {
    assert.match(raiz, /anotar\(llegadas, fotoDe\(navigation\.getState\(\)\)\);/);
    assert.match(raiz, /llegaSinAnimacion\(llegadas, route\.key\)/);
    assert.match(raiz, /animation: sinAnimacion \? 'none' : 'slide_from_right'/);
  });

  it('solo en Android: en iPhone la sustitución sigue deslizando', () => {
    assert.match(raiz, /Platform\.OS === 'android' && llegaSinAnimacion\(/);
  });

  it('al terminar la llegada, devuelve la animación y vuelve a dibujar', () => {
    assert.match(
      raiz,
      /transitionEnd: \(evento\) => \{\s*if \(asentar\(llegadas, evento\.target\)\) repintarLaPila\(\);/,
    );
  });

  it('el registro es uno solo y vive lo que vive la aplicación', () => {
    assert.match(raiz, /const llegadas = useRef\(nuevoRegistro\(\)\)\.current;/);
  });
});
