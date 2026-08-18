/**
 * Pruebas del traductor de errores de Supabase Auth.
 *
 * La regla que se comprueba aqui es una sola y no admite excepciones: por la
 * pantalla no puede salir jerga tecnica. Se usan los mensajes literales que
 * devuelve Supabase hoy.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

const { mensajeDeAuth } = await import('./authErrors.ts');

// El traductor deja el detalle en la consola a proposito; aqui solo estorba.
const warnOriginal = console.warn;
before(() => {
  console.warn = () => {};
});
after(() => {
  console.warn = warnOriginal;
});

/** Imita la forma de un AuthApiError de supabase-js. */
function errorSupabase(message: string, code = '', status = 400, name = 'AuthApiError') {
  return Object.assign(new Error(message), { code, status, name });
}

const JERGA = /AuthApiError|invalid_grant|JWT|TypeError|undefined|Failed to fetch|\b4\d\d\b|\b5\d\d\b/;

test('ningun mensaje traducido contiene jerga tecnica', () => {
  const casos = [
    errorSupabase('Unable to validate email address: invalid format', 'validation_failed', 400),
    errorSupabase('Invalid login credentials', 'invalid_credentials', 400),
    errorSupabase('Email not confirmed', 'email_not_confirmed', 400),
    errorSupabase('User already registered', 'user_already_exists', 422),
    errorSupabase('Error sending recovery email', '', 500),
    errorSupabase('Email link is invalid or has expired', 'otp_expired', 401),
    errorSupabase('Auth session missing!', '', 400, 'AuthSessionMissingError'),
    errorSupabase('New password should be different from the old password.', 'same_password', 422),
    errorSupabase('Password should be at least 6 characters.', 'weak_password', 422),
    errorSupabase('Failed to fetch', '', 0, 'AuthRetryableFetchError'),
    new TypeError('Network request failed'),
    { cualquierCosa: true },
    null,
  ];
  for (const caso of casos) {
    for (const ctx of ['recuperacion', 'nueva-contrasena', 'acceso', 'registro'] as const) {
      const texto = mensajeDeAuth(caso, ctx);
      assert.doesNotMatch(texto, JERGA, `filtro jerga en: ${texto}`);
      assert.ok(texto.length > 10, 'el mensaje tiene que decir algo');
    }
  }
});

test('la espera entre envios se dice con los segundos que faltan', () => {
  const texto = mensajeDeAuth(
    errorSupabase('For security purposes, you can only request this after 51 seconds.', 'over_email_send_rate_limit', 429),
    'recuperacion',
  );
  assert.match(texto, /51 segundos/);
});

test('el tope de envios sin segundos pide paciencia, sin numeros inventados', () => {
  const texto = mensajeDeAuth(
    errorSupabase('email rate limit exceeded', 'over_email_send_rate_limit', 429),
    'recuperacion',
  );
  assert.match(texto, /demasiados intentos/i);
  assert.doesNotMatch(texto, /\d+ segundos/);
});

test('quedarse sin cobertura se dice como tal', () => {
  const texto = mensajeDeAuth(new TypeError('Network request failed'), 'acceso');
  assert.match(texto, /Sin conexión/i);
});

test('el enlace caducado invita a pedir otro', () => {
  const texto = mensajeDeAuth(
    errorSupabase('Email link is invalid or has expired', 'otp_expired', 401),
    'nueva-contrasena',
  );
  assert.match(texto, /caducado/i);
});

test('la recuperacion nunca revela si el correo tiene cuenta', () => {
  const casos = [
    errorSupabase('User not found', 'user_not_found', 404),
    errorSupabase('Unable to validate email address: invalid format', 'validation_failed', 400),
  ];
  for (const caso of casos) {
    const texto = mensajeDeAuth(caso, 'recuperacion');
    assert.doesNotMatch(texto, /no existe|no está registrad|sin cuenta|not found/i);
  }
});

test('la contrasena repetida se explica sin tecnicismos', () => {
  const texto = mensajeDeAuth(
    errorSupabase('New password should be different from the old password.', 'same_password', 422),
    'nueva-contrasena',
  );
  assert.match(texto, /distinta de la anterior/i);
});

test('un 5xx del servidor NO se anuncia como falta de conexion', () => {
  /*
    supabase-js envuelve cualquier 5xx en AuthRetryableFetchError, la misma
    clase que usa cuando no hay red, y en ese caso ni siquiera lee el cuerpo:
    solo queda el status. Confundirlos mandaba al usuario a revisar su wifi por
    un fallo del servidor de correo.
  */
  const fallo5xx = Object.assign(new Error(''), {
    name: 'AuthRetryableFetchError',
    status: 500,
  });

  const enRecuperacion = mensajeDeAuth(fallo5xx, 'recuperacion');
  assert.doesNotMatch(enRecuperacion, /Sin conexión|internet/i);
  assert.match(enRecuperacion, /no pudimos enviar el correo/i);

  const enAcceso = mensajeDeAuth(fallo5xx, 'acceso');
  assert.doesNotMatch(enAcceso, /Sin conexión|internet/i);
  assert.match(enAcceso, /no está disponible/i);
});

test('la falta de red real si se sigue anunciando como tal', () => {
  // El fallo de conexion autentico llega con status 0.
  const sinRed = Object.assign(new Error('Network request failed'), {
    name: 'AuthRetryableFetchError',
    status: 0,
  });
  assert.match(mensajeDeAuth(sinRed, 'acceso'), /Sin conexión/i);
  assert.match(mensajeDeAuth(sinRed, 'recuperacion'), /Sin conexión/i);
});
