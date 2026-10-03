import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Una relectura que falla no borra el pedido que ya se ve.
 *
 * El pedido de entradas y el de productos se releen cada vez que la aplicación
 * vuelve a primer plano, porque el cobro ocurre fuera, en el navegador. Y lo
 * normal al reanudar es que la primera petición no salga. Si ese fallo pusiera
 * la pantalla de error, quien vuelve de pagar vería «no se pudo cargar» en
 * lugar de su pedido: peor que no releer.
 *
 * SE MIRA EL CÓDIGO FUENTE: reproducirlo de verdad exige un teléfono, una red
 * que falle y un navegador del que volver.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const fuente = (nombre: string) =>
  readFileSync(join(CARPETA, `${nombre}.tsx`), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

for (const pantalla of ['PedidoDeEntradasScreen', 'PedidoDeProductoScreen']) {
  test(`${pantalla}: se relee al volver y un fallo de red no quita el pedido`, () => {
    const codigo = fuente(pantalla);
    // Se relee al volver a primer plano (no solo al cambiar de pantalla).
    assert.match(codigo, /const activa = useSeccionActiva\(\);\s*useEffect\(\(\) => \{\s*if \(activa\) void cargar\(\);/);
    // Se anota que ya se pintó JUSTO después de guardarlo.
    assert.match(codigo, /const yaPintado = useRef\(false\);/);
    assert.match(codigo, /setPedido\([^;]+\);\s*yaPintado\.current = true;/);

    const captura = codigo.slice(codigo.indexOf('} catch (error) {', codigo.indexOf('yaPintado.current = true;')));
    const pintado = captura.indexOf('yaPintado.current');
    const sinConexion = captura.indexOf("setFallo('sinConexion')");
    const red = captura.indexOf("setFallo('red')");
    assert.ok(pintado !== -1 && sinConexion !== -1 && red !== -1, 'no se reconoce la captura de la carga');
    // ANTES que los dos fallos pasajeros: con el pedido a la vista, se avisa y ya.
    assert.ok(pintado < sinConexion && pintado < red, 'un fallo de red vuelve a tapar el pedido');
    assert.match(captura.slice(pintado, sinConexion), /toast\(t\('common\.tryAgain'\), 'alert-circle'\)/);
    // DESPUÉS de los definitivos: un pedido que ya no existe sí cambia la pantalla.
    const noEncontrado = captura.indexOf("setFallo('noEncontrado')");
    assert.ok(noEncontrado !== -1 && noEncontrado < pintado, 'un 404 tiene que seguir cambiando la pantalla');
  });
}
