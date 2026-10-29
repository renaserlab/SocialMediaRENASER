// Restauraciones del módulo «perfil-ajustes» contra el backend LOCAL, sin
// pasar por la pantalla. Maestro ejecuta esto en el PC (no en el emulador),
// así que 127.0.0.1 es el Supabase y la API locales.
//
// POR QUÉ NO POR LA PANTALLA. Los `onFlowComplete` corren cuando un flujo ya
// falló, con la app en un estado desconocido (una bandeja abierta, el foco
// fuera del campo...). Restaurar tecleando a ciegas acabó escribiendo texto en
// la app equivocada y guardando un perfil a medias. La API no depende de eso.
//
// Uso desde un flujo:
//   - runScript:
//       file: _sub/api.js
//       env:
//         ACCION: restaurar-ana   # restaurar-ana | desbloquear-delia | dejar-de-seguir-delia
//         EMAIL: ${E2E_EMAIL}
//         PASSWORD: ${E2E_PASSWORD}
//
// La clave `anon` por defecto es la PÚBLICA de demostración que trae el CLI de
// Supabase para cualquier proyecto local (no es un secreto; la misma que usa
// mensajes/_ayudas/api.js); se puede cambiar con E2E_ANON_KEY. Se niega a
// hablar con nada que no sea 127.0.0.1/localhost.

var SUPABASE = (typeof E2E_SUPABASE_URL !== 'undefined' && E2E_SUPABASE_URL) || 'http://127.0.0.1:54321';
var API = (typeof E2E_API_URL !== 'undefined' && E2E_API_URL) || 'http://127.0.0.1:8000';
var ANON = (typeof E2E_ANON_KEY !== 'undefined' && E2E_ANON_KEY) ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

// Los de 00-base.sql y 40-perfil.sql.
var NOMBRE_ANA = 'Ana Prueba';
var BIO_ANA = 'Cuenta de pruebas E2E. Ceramica y diseno.';
var DELIA = 'e2e0d0d0-0000-4000-8000-000000000040';

function esLocal(url) {
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url);
}
if (!esLocal(SUPABASE) || !esLocal(API)) {
  throw new Error('api.js solo habla con el backend local (127.0.0.1). Abortado.');
}

// Límite local: 30 inicios de sesión cada 5 min por IP, compartidos por las
// cinco suites. El token se guarda en `output` y se reutiliza.
function entrar(correo, clave) {
  output.tokensE2E = output.tokensE2E || {};
  if (output.tokensE2E[correo]) return output.tokensE2E[correo];
  var r = http.post(SUPABASE + '/auth/v1/token?grant_type=password', {
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: correo, password: clave }),
  });
  if (r.status !== 200) throw new Error('No se pudo entrar como ' + correo + ': ' + r.status + ' ' + r.body);
  output.tokensE2E[correo] = json(r.body).access_token;
  return output.tokensE2E[correo];
}

function llamar(metodo, ruta, token, cuerpo) {
  var opciones = {
    method: metodo,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  };
  if (cuerpo !== undefined) opciones.body = JSON.stringify(cuerpo);
  return http.request(API + ruta, opciones);
}

var accion = typeof ACCION !== 'undefined' ? ACCION : '';
var token = entrar(EMAIL, PASSWORD);

if (accion === 'restaurar-ana') {
  var r = llamar('PATCH', '/api/v1/profiles/me', token, { full_name: NOMBRE_ANA, bio: BIO_ANA });
  if (r.status !== 200) throw new Error('No se pudo restaurar el perfil de Ana: ' + r.status + ' ' + r.body);
} else if (accion === 'desbloquear-delia') {
  // Idempotente: desbloquear a quien no está bloqueado no falla.
  var b = llamar('DELETE', '/api/v1/profiles/' + DELIA + '/block', token);
  if (b.status >= 300 && b.status !== 404) throw new Error('No se pudo desbloquear a Delia: ' + b.status + ' ' + b.body);
} else if (accion === 'dejar-de-seguir-delia') {
  var f = llamar('DELETE', '/api/v1/profiles/' + DELIA + '/follow', token);
  if (f.status >= 300 && f.status !== 404) throw new Error('No se pudo dejar de seguir a Delia: ' + f.status + ' ' + f.body);
} else {
  throw new Error('api.js: ACCION desconocida: ' + accion);
}
