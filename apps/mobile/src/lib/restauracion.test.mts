import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { accesosTras } from './restauracion.ts';

/**
 * «RESTAURAR COMPRAS» TIENE QUE DECIR LA VERDAD, y ha dicho dos mentiras
 * distintas en dos intentos seguidos.
 *
 * La primera: `sincronizar()` tiraba la respuesta del servidor y devolvía
 * «comprada» con que la petición no reventara, así que quien pulsaba el botón
 * sin ninguna compra en esa cuenta de la tienda leía «Compras restauradas» y
 * seguía viendo el botón de comprar.
 *
 * La segunda, arreglando la primera: contar solo `granted`. El servidor mete
 * ahí solo los accesos NUEVOS, así que a quien ya lo tenía concedido se le
 * contestaba «no encontramos compras» —a alguien que sí había pagado—.
 *
 * Y la prueba que cubría esto miraba subcadenas del código fuente: cambiando
 * `granted.length` por `granted.length + 1` seguía verde. Por eso ahora se
 * ejecuta el código.
 */
describe('cuántos accesos dice el servidor que hay', () => {
  it('ninguno es ninguno', () => {
    assert.equal(accesosTras({ granted: [], unchanged: [] }), 0);
  });

  it('los recién concedidos cuentan', () => {
    assert.equal(accesosTras({ granted: ['c1'], unchanged: [] }), 1);
  });

  it('LOS QUE YA ESTABAN TAMBIÉN CUENTAN', () => {
    /*
      El caso que se rompió: la tienda ya había avisado, o la aplicación
      sincronizó sola al entrar, o es el segundo toque del botón. El curso
      vuelve en `unchanged` y `granted` llega vacío. Contando solo `granted`,
      a esta persona —que pagó— se le dice que no encontramos sus compras.
    */
    assert.equal(accesosTras({ granted: [], unchanged: ['c1'] }), 1);
  });

  it('se suman', () => {
    assert.equal(accesosTras({ granted: ['c1'], unchanged: ['c2', 'c3'] }), 3);
  });
});

describe('la pantalla usa ese número', () => {
  const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const CURSO = readFileSync(join(SRC, 'screens/CourseScreen.tsx'), 'utf8');
  const COMPRAS = readFileSync(join(SRC, 'services/compras.ts'), 'utf8');

  it('sincronizar suma los dos, no solo los nuevos', () => {
    assert.ok(
      COMPRAS.includes('accesos: granted.length + unchanged.length'),
      'contar solo `granted` deja fuera a quien ya tenía el acceso.',
    );
  });

  it('el mensaje de éxito depende del número', () => {
    assert.ok(CURSO.includes("resultado.estado === 'comprada' && resultado.accesos > 0"));
    assert.ok(CURSO.includes("t('course.noPurchasesFound')"));
  });

  it('los dos caminos recargan', () => {
    /*
      También el de «no hay ninguna»: el servidor acaba de decir la verdad sobre
      esta cuenta y la pantalla tiene que reflejarla, tenga compras o no. En el
      primer intento de arreglar esto, esa rama se quedó sin `reload()` y la
      pantalla seguía enseñando lo de antes.
    */
    const restaurar = CURSO.slice(CURSO.indexOf('const restaurar ='));
    const cuerpo = restaurar.slice(0, restaurar.indexOf('};'));
    assert.equal(
      cuerpo.split('reload();').length - 1,
      2,
      'las dos ramas de «comprada» tienen que recargar.',
    );
  });
});
