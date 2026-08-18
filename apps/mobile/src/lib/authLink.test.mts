/**
 * Pruebas del enlace que llega por correo.
 *
 * Se cubren las formas reales en que Supabase devuelve la informacion, porque
 * confundirlas era justo lo que dejaba la recuperacion de contrasena rota en el
 * telefono: los tokens llegan en el fragmento, el codigo PKCE en la query y el
 * fallo del enlace caducado tambien en el fragmento.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { leerEnlaceAuth, esEnlaceDeRecuperacion, mensajeDeEnlace } = await import('./authLink.ts');

test('lee los tokens del fragmento de un deep link nativo', () => {
  const enlace = leerEnlaceAuth(
    'z://reset-password#access_token=abc&refresh_token=def&type=recovery&expires_in=3600',
  );
  assert.ok(enlace);
  assert.equal(enlace.accessToken, 'abc');
  assert.equal(enlace.refreshToken, 'def');
  assert.equal(enlace.tipo, 'recovery');
  assert.ok(esEnlaceDeRecuperacion(enlace));
});

test('lee el codigo PKCE de la query', () => {
  const enlace = leerEnlaceAuth('z://reset-password?code=un-codigo&type=recovery');
  assert.ok(enlace);
  assert.equal(enlace.code, 'un-codigo');
  assert.equal(enlace.accessToken, null);
  assert.ok(esEnlaceDeRecuperacion(enlace));
});

test('lee query y fragmento a la vez, sin mezclarlos', () => {
  const enlace = leerEnlaceAuth('https://app.example/reset-password?code=xyz#type=recovery');
  assert.ok(enlace);
  assert.equal(enlace.code, 'xyz');
  assert.equal(enlace.tipo, 'recovery');
});

test('reconoce el enlace caducado que devuelve Supabase', () => {
  const enlace = leerEnlaceAuth(
    'https://app.example/reset-password#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
  );
  assert.ok(enlace);
  assert.equal(enlace.errorCode, 'otp_expired');
  assert.match(mensajeDeEnlace(enlace), /caducado/i);
  // El texto tecnico de Supabase NO puede acabar en la pantalla.
  assert.doesNotMatch(mensajeDeEnlace(enlace), /Email link|invalid|expired$/);
});

test('un enlace normal de la aplicacion no se confunde con uno de auth', () => {
  assert.equal(leerEnlaceAuth('z://post/123'), null);
  assert.equal(leerEnlaceAuth('z://profile/abc?tab=posts'), null);
  assert.equal(leerEnlaceAuth(''), null);
  assert.equal(leerEnlaceAuth(null), null);
});
