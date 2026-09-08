import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

// Sin comentarios: el propio fichero nombra «factura» e «impuestos» para
// explicar por que no estan.
const BLOQUE = new RegExp('/\\*[\\s\\S]*?\\*/', 'g');
const LINEA = new RegExp('//[^\\n]*', 'g');
const sinComentarios = (c: string) => c.replace(BLOQUE, ' ').replace(LINEA, ' ');

const PANTALLA_ENTERA = fuente('screens/ConstanciaDeCompraScreen.tsx');
const PANTALLA = sinComentarios(PANTALLA_ENTERA);
const VUELTA = fuente('screens/VueltaDelPagoScreen.tsx');
const ES = fuente('i18n/es.ts');

describe('la constancia de compra', () => {
  it('tiene su ruta', () => {
    assert.ok(existsSync(join(SRC, '..', 'app', 'compras', '[id].tsx')));
  });

  it('NO se llama factura ni boleta', () => {
    // No hay integración tributaria: llamarlo factura sería afirmar algo falso.
    // Se mira el TEXTO del diccionario, que es lo que lee la persona; el código
    // nombra «noEsFactura» a propósito, para decir justamente lo contrario.
    const textos = ES.split('\n').filter((l) => l.includes("'constancia."));
    const titulo = textos.find((l) => l.includes("'constancia.titulo'")) ?? '';
    for (const palabra of ['actura', 'oleta']) {
      assert.ok(
        !titulo.includes(palabra),
        `el título de la constancia no puede contener «${palabra}».`,
      );
    }
    assert.ok(ES.includes("'constancia.noEsFactura'"), 'y se dice explícitamente.');
  });

  it('no inventa datos fiscales', () => {
    for (const inventado of ['ruc', 'RUC', 'razonSocial', 'serie', 'impuesto', 'iva', 'IVA']) {
      assert.ok(!PANTALLA.includes(inventado), `«${inventado}» no existe en la orden.`);
    }
  });

  it('el importe sale de la orden, no del catálogo', () => {
    assert.ok(PANTALLA_ENTERA.includes('deCentavos(orden.amountMinor, orden.currency)'));
    assert.ok(
      !PANTALLA.includes('priceMinor'),
      'el precio de hoy del catálogo no representa una compra histórica.',
    );
  });

  it('la versión solo se pinta si consta', () => {
    assert.ok(PANTALLA_ENTERA.includes('if (orden.version !== null)'));
  });

  it('desde el retorno del pago se puede ver, solo si está confirmada', () => {
    assert.ok(VUELTA.includes("estado === 'confirmado' && orderId"));
    assert.ok(VUELTA.includes("t('pago.verConstancia')"));
  });

  it('el identificador se valida antes de preguntar', () => {
    assert.ok(PANTALLA_ENTERA.includes('ordenDeLaUrl(id)'));
  });
});
