/**
 * La Beta gratuita, vista desde el movil.
 *
 * LO QUE VIGILA. Que el telefono no decida nada. El interruptor de la beta vive
 * en el backend (`BETA_FREE_ACCESS_ENABLED`) y el derecho lo concede el
 * servidor; si la pantalla se lo guardara —una constante local, un `price` a
 * cero, un «ya lo tienes» en memoria— pasarian dos cosas malas: apagar la beta
 * no apagaria el boton hasta publicar una version nueva, y el acceso volveria a
 * ser una creencia del dispositivo en vez de un hecho de la cuenta. Es
 * exactamente el fallo que ya se corrigio con `purchasedCourseIds`.
 *
 * Miran el CODIGO FUENTE y no la pantalla, como `sinDatosInventados`: montar
 * estas vistas pediria un renderizador de React Native que este proyecto no
 * tiene, y lo que hay que impedir es una decision tomada en el sitio
 * equivocado, no un valor mal calculado.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

const PANTALLA = readFileSync(join(SRC, 'screens', 'CourseScreen.tsx'), 'utf8');
const REPOSITORIO = readFileSync(
  join(SRC, 'repositories', 'LearningRepository.ts'),
  'utf8',
);

describe('quien decide si hay beta gratuita', () => {
  it('lo pregunta al servidor', () => {
    assert.ok(
      PANTALLA.includes('LearningRepository.betaAccess'),
      'La pantalla ya no consulta al servidor si hay acceso de beta.',
    );
    assert.ok(
      REPOSITORIO.includes('/beta-access'),
      'El repositorio dejo de llamar al endpoint de la beta.',
    );
  });

  it('no lo guarda en el telefono', () => {
    // Ni una constante, ni una variable de entorno del cliente: las dos harian
    // que apagar la beta en el servidor no apagara el boton.
    assert.ok(
      !/const\s+BETA[A-Z_]*\s*=\s*(true|false)/.test(PANTALLA),
      'Hay un interruptor de beta escrito a mano en la pantalla.',
    );
    assert.ok(
      !/EXPO_PUBLIC_[A-Z_]*BETA/.test(PANTALLA + REPOSITORIO),
      'La beta se lee de una variable del cliente: el servidor deja de mandar.',
    );
  });

  it('el boton solo sale si el servidor dijo que si', () => {
    assert.ok(
      PANTALLA.includes('beta?.available'),
      'El boton de la beta ya no depende de lo que respondio el servidor.',
    );
  });
});

describe('el precio sigue siendo el precio', () => {
  it('la ficha lo sigue enseñando tal cual', () => {
    // Regalar el acceso durante la beta NO es poner el curso a cero: el curso
    // cuesta lo que cuesta y se cobrara cuando la beta acabe.
    assert.ok(
      PANTALLA.includes('etiquetaDePrecio(course.priceMinor, course.currency)'),
      'La ficha dejo de enseñar el precio real del curso.',
    );
  });

  it('la pantalla no toca `priceMinor`', () => {
    assert.ok(
      !/priceMinor\s*[:=]\s*0/.test(PANTALLA),
      'Alguien pone el precio a cero desde la pantalla del curso.',
    );
  });
});

describe('pedir el acceso de la beta', () => {
  it('no dice en ningun sitio que se haya comprado o pagado', () => {
    // Solo el CUERPO de la concesion: lo que hay despues es el comentario del
    // flujo de compra, que si tiene que hablar de comprar.
    const inicio = PANTALLA.indexOf('const pedirAccesoDeBeta');
    const concesion = PANTALLA.slice(inicio, PANTALLA.indexOf('\n  };', inicio));
    assert.ok(concesion.length > 0, 'No se encuentra la concesion en la pantalla.');
    for (const prohibido of ['comprad', 'Compra', 'pagad', 'recibo', 'factura']) {
      assert.ok(
        !concesion.includes(prohibido),
        `La concesion de beta habla de «${prohibido}», y aqui no se cobra nada.`,
      );
    }
  });

  it('se puede reintentar sin miedo', () => {
    // El servidor lo garantiza con un indice unico; aqui basta con que el
    // repositorio no lleve la cuenta por su cuenta.
    assert.ok(
      /grantBetaAccess\(courseId: string\): Promise<void>/.test(REPOSITORIO),
      'La concesion devuelve algo que la pantalla podria empezar a cachear.',
    );
  });
});
