/**
 * Borrar la cuenta desde Ajustes: lo que el teléfono tiene que decir cuando el
 * servidor NO la borra.
 *
 * Se comprueba sobre el TEXTO de los ficheros, como `devolucionesYGarantia`:
 * las pruebas corren con el runner de Node, sin renderizador.
 *
 * DESDE LA 0089 (29/09/2026) `DELETE /auth/me` tiene tres respuestas:
 *
 *  - 204: borrada. El móvil cierra la sesión.
 *  - 409 `account_deletion_blocked`: la cuenta tiene ventas, pedidos o
 *    reclamos que se conservan. REINTENTAR NO SIRVE, y decir «inténtalo en
 *    unos momentos» es mentir: hay que escribir a soporte.
 *  - 409 `service_history_requires_support` (F21, 02/10/2026): la cuenta es
 *    parte de una reserva de Servicios. Lo mismo: soporte, no reintentar.
 *  - 503 `account_deletion_storage_failed` (o cualquier otro fallo): la cuenta
 *    sigue activa y reintentar sí lo arregla.
 *
 * Y en ningún fallo se cierra la sesión: la cuenta sigue viva.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
}

const AJUSTES = fuente('screens/SettingsScreen.tsx');
const REPOSITORIO = fuente('repositories/AuthRepository.ts');
const ALMACEN = fuente('store/useAuthStore.ts');

function bloque(texto: string, desde: string, hasta: string): string {
  const inicio = texto.indexOf(desde);
  assert.notEqual(inicio, -1, `No se encontró «${desde}».`);
  const fin = texto.indexOf(hasta, inicio + desde.length);
  assert.notEqual(fin, -1, `No se encontró «${hasta}» después de «${desde}».`);
  return texto.slice(inicio, fin);
}

describe('Borrar la cuenta', () => {
  const manejador = bloque(AJUSTES, 'const handleDeleteAccount', '\n  };\n');

  it('una cuenta bloqueada NO se presenta como «inténtalo de nuevo»', () => {
    const rama = bloque(manejador, 'BAJA_BLOQUEADA.includes(error.code)', 'return;');
    assert.ok(manejador.includes('error instanceof ApiError'), 'lee el código del error del servidor');
    assert.ok(rama.includes("t('settings.deleteAccountBlocked')"));
    assert.ok(rama.includes("t('settings.deleteAccountBlockedBody')"));
    assert.ok(!rama.includes('deleteAccountFailedBody'));
  });

  it('la historia de Servicios (F21) se trata como bloqueada, no como un fallo pasajero', () => {
    const bloqueada = bloque(AJUSTES, 'const BAJA_BLOQUEADA', ';');
    assert.ok(bloqueada.includes("'account_deletion_blocked'"));
    assert.ok(bloqueada.includes("'service_history_requires_support'"));
    // Con reservas NO se promete cerrarla («la cerramos contigo»): tiene su texto.
    const rama = bloque(manejador, 'BAJA_BLOQUEADA.includes(error.code)', 'return;');
    assert.ok(/error\.code === 'account_deletion_blocked'\s*\?\s*t\('settings\.deleteAccountBlockedBody'\)\s*:\s*t\('settings\.deleteAccountHistoryBody'\)/.test(rama));
    // Va ANTES que «no se sabe» y que «inténtalo de nuevo»: un 409 no llega a ellas.
    assert.ok(manejador.indexOf('BAJA_BLOQUEADA.includes') < manejador.indexOf('sinSaberComoTermino(error)'));
    assert.ok(!bloque(AJUSTES, 'const BAJA_NO_HECHA', ';').includes('service_history_requires_support'));
  });

  it('el texto de las reservas pide escribir a soporte y no promete un cierre que hoy no existe', () => {
    const promesas = { es: 'cerramos contigo', en: 'close it with you', pt: 'encerramos com você' };
    const soporte = { es: 'soporte', en: 'support', pt: 'suporte' };
    for (const idioma of ['es', 'en', 'pt'] as const) {
      const cuerpo = bloque(fuente(`i18n/${idioma}.ts`), "'settings.deleteAccountHistoryBody':", "',\n");
      assert.ok(cuerpo.includes(soporte[idioma]), `${idioma}: remite a soporte`);
      assert.ok(!cuerpo.includes(promesas[idioma]), `${idioma}: no promete cerrarla`);
    }
  });

  it('sin respuesta de la API NO afirma que la cuenta sigue activa (la baja pudo terminar)', () => {
    const rama = bloque(manejador, 'sinSaberComoTermino(error)', 'return;');
    assert.ok(rama.includes("t('settings.deleteAccountUnknown')"));
    assert.ok(rama.includes("t('settings.deleteAccountUnknownBody')"));
    assert.ok(!rama.includes('deleteAccountFailedBody'));
  });

  it('«no se sabe» = sin respuesta, o un 5xx que no es uno de los dos 503 de la API (el 504 del CDN)', () => {
    const regla = bloque(AJUSTES, 'function sinSaberComoTermino', '\n}\n');
    assert.ok(/error\.status === 0/.test(regla));
    assert.ok(/error\.status >= 500/.test(regla));
    const conocidos = bloque(AJUSTES, 'const BAJA_NO_HECHA', ';');
    assert.ok(conocidos.includes("'account_deletion_storage_failed'"));
    assert.ok(conocidos.includes("'account_deletion_unavailable'"));
  });

  it('cualquier otro fallo sigue diciendo que la cuenta sigue activa', () => {
    const despues = manejador.slice(manejador.indexOf('sinSaberComoTermino(error)'));
    assert.ok(despues.includes("t('settings.deleteAccountFailedBody')"));
  });

  it('la baja espera más que una petición normal: borra archivos antes de confirmar', () => {
    const borrar = bloque(REPOSITORIO, 'async deleteAccount()', '\n  },');
    const espera = /timeoutMs:\s*([\d_]+)/.exec(borrar);
    assert.ok(espera, 'la baja lleva su propia espera');
    assert.ok(Number(espera[1].replace(/_/g, '')) >= 60_000);
  });

  it('solo se sale a la portada si el servidor la borró', () => {
    assert.ok(
      /await deleteAccount\(\);\s*router\.replace\('\/'\);/.test(manejador),
      'la navegación va DESPUÉS del borrado y dentro del try',
    );
  });

  it('el borrado va primero al servidor y la sesión se cierra solo si respondió bien', () => {
    const borrar = bloque(REPOSITORIO, 'async deleteAccount()', '\n  },');
    assert.ok(borrar.indexOf("method: 'DELETE'") < borrar.indexOf('signOut()'));
    const limpiar = bloque(ALMACEN, 'async deleteAccount()', 'clearSignedUrlCache');
    assert.ok(limpiar.includes('await AuthRepository.deleteAccount();'));
  });

  it('los textos nuevos existen en los tres idiomas', () => {
    for (const idioma of ['es', 'en', 'pt']) {
      const textos = fuente(`i18n/${idioma}.ts`);
      for (const clave of ['deleteAccountBlocked', 'deleteAccountBlockedBody', 'deleteAccountHistoryBody', 'deleteAccountUnknown', 'deleteAccountUnknownBody']) {
        assert.ok(textos.includes(`'settings.${clave}':`), `${idioma}: ${clave}`);
      }
    }
  });
});
