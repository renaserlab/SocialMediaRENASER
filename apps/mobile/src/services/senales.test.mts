/**
 * Que ninguna señal salga sin sesión.
 *
 * EL FALLO QUE SE ARREGLA AQUÍ. La aplicación se puede recorrer entera SIN
 * cuenta —el feed de Inicio se ve sin iniciar sesión—, así que la cola de
 * señales se llenaba con las impresiones de vídeo de alguien anónimo. Ocho
 * segundos después salía un `POST /recommendations/events` sin cabecera
 * `Authorization`, el servidor respondía **401** y la consola se llenaba de
 * errores por una petición que jamás debió salir.
 *
 * `haySesion()` es la comprobación que ahora precede a cada envío, y por eso se
 * fija aquí: es la pieza pequeña y sin dependencias de la que depende que el
 * 401 no vuelva.
 *
 * Por qué no se prueba aquí la cola entera: `senales.ts` importa `AppState` de
 * react-native y, por el repositorio, la cadena que acaba en supabase-js y
 * expo-file-system. Nada de eso se resuelve en el runner de Node, que es el que
 * usa este proyecto (`npm run test`) precisamente por no arrastrar
 * dependencias. La regla que sí es comprobable —«sin token, no se manda»— vive
 * en esta función.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { haySesion, setAuthTokenProvider } from './api.ts';

afterEach(() => setAuthTokenProvider(null));

describe('hay sesion?', () => {
  it('sin proveedor de token, no', async () => {
    // Arranque en frío: `bootstrap` todavía no ha instalado el proveedor.
    setAuthTokenProvider(null);
    assert.equal(await haySesion(), false);
  });

  it('con proveedor pero sin token, tampoco', async () => {
    // ESTE es el caso del 401: la aplicación arrancada y navegando sin cuenta.
    // El proveedor existe, pero no tiene ningún token que dar.
    setAuthTokenProvider(async () => null);
    assert.equal(await haySesion(), false);
  });

  it('con token vacio, tampoco', async () => {
    // Una cadena vacía viajaría como `Authorization: Bearer ` y el servidor
    // respondería 401 igual. Es «no hay token», no «hay uno raro».
    setAuthTokenProvider(async () => '');
    assert.equal(await haySesion(), false);
  });

  it('con token, si', async () => {
    setAuthTokenProvider(async () => 'jwt-de-prueba');
    assert.equal(await haySesion(), true);
  });

  it('si preguntar por el token falla, se asume que NO hay sesion', async () => {
    // Ante la duda no se manda. Una señal perdida es un dato menos; un 401 en
    // consola es ruido que tapa los errores que sí importan.
    setAuthTokenProvider(async () => {
      throw new Error('la sesion no se pudo refrescar');
    });
    assert.equal(await haySesion(), false);
  });

  it('no cachea: responde a la sesion de AHORA', async () => {
    // Cerrar sesión tiene que notarse en la siguiente pregunta, no en la
    // siguiente recarga de la aplicación.
    let token: string | null = 'jwt-de-prueba';
    setAuthTokenProvider(async () => token);
    assert.equal(await haySesion(), true);
    token = null;
    assert.equal(await haySesion(), false);
  });
});
