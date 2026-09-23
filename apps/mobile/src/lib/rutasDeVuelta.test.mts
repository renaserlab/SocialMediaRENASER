import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const RAIZ = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const APP = join(RAIZ, 'app');
const CONFIG = join(RAIZ, '..', 'api', 'app', 'core', 'config.py');

/**
 * QUE LAS RUTAS A LAS QUE EL BACKEND MANDA A LA GENTE EXISTAN EN LA APLICACIÓN.
 *
 * EL FALLO QUE ESTO CIERRA. `payments_return_url` apuntaba a `/pago` y
 * `payments_cancel_url` a `/pago/cancelado`, y ninguna de las dos existía en
 * `app/`. Tampoco había `+not-found`. Quien acabara de pagar aterrizaba en la
 * pantalla de ruta desconocida de expo-router: en inglés, con jerga de
 * desarrollo y sin ninguna salida, sin saber si se le había cobrado.
 *
 * No se disparaba porque las compras están apagadas. Se habría disparado el día
 * que se encendieran, que es exactamente cuando nadie quiere descubrirlo.
 *
 * Esta prueba vive en el móvil y lee la configuración del backend a propósito:
 * el contrato es entre los dos, y cambiar una URL allí sin crear la ruta aquí
 * tiene que ponerse rojo en algún sitio.
 */
describe('las rutas de vuelta del pago', () => {
  const config = readFileSync(CONFIG, 'utf8');

  function rutaDeclarada(clave: string): string {
    const casa = config.match(new RegExp(`${clave}:\\s*str\\s*=\\s*"([^"]+)"`));
    assert.ok(casa, `no se encuentra ${clave} en la configuración del backend`);
    return new URL(casa[1]).pathname;
  }

  it('existe una pantalla para cada URL de vuelta que anuncia el backend', () => {
    for (const clave of ['payments_return_url', 'payments_cancel_url']) {
      const ruta = rutaDeclarada(clave);
      const segmentos = ruta.split('/').filter(Boolean);
      // expo-router resuelve `/pago` con `app/pago.tsx` o con `app/pago/index.tsx`.
      const candidatos = [
        join(APP, ...segmentos) + '.tsx',
        join(APP, ...segmentos, 'index.tsx'),
      ];
      assert.ok(
        candidatos.some((c) => existsSync(c)),
        `${clave} manda a «${ruta}» y no hay ninguna pantalla ahí: ` +
          `quien acabe de pagar cae en la ruta desconocida de expo-router.`,
      );
    }
  });

  it('y hay una red por debajo para cualquier otra ruta', () => {
    assert.ok(
      existsSync(join(APP, '+not-found.tsx')),
      'sin `+not-found`, un enlace viejo lleva a la pantalla de expo-router, ' +
        'en inglés y sin salida.',
    );
  });

  it('la pantalla de vuelta le pregunta al SERVIDOR, no a la URL', () => {
    /*
      Lo único que trae el navegador es `?order=<id>`, y ese parámetro lo
      escribe cualquiera. Conceder acceso —o simplemente decir «pago
      confirmado»— a partir de él sería dejar que quien pide decida si ha
      pagado.
    */
    const pantalla = readFileSync(
      join(RAIZ, 'src', 'screens', 'VueltaDelPagoScreen.tsx'),
      'utf8',
    );
    assert.ok(
      pantalla.includes('CommerceRepository.estadoDeOrden('),
      'la pantalla tiene que consultar el estado de la orden al servidor.',
    );
    assert.ok(
      pantalla.includes('ordenDeLaUrl(parametros.order)'),
      'el identificador de la URL tiene que validarse antes de usarse.',
    );
  });
});
