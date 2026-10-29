// Ayudas del modulo «mensajes» que hablan con el backend LOCAL, sin pasar por
// la pantalla. Maestro ejecuta esto en el PC (no en el emulador), asi que
// 127.0.0.1 es el Supabase y la API locales.
//
// Para que las pruebas no dependan de en que punto dejo los datos la pasada
// anterior: hacer que Beto escriba (para que haya algo sin leer), preguntar a
// la API cuantos no leidos hay (para comparar con lo que pinta la app) y volver
// a dejar sin leer las notificaciones sembradas.
//
// Uso desde un flujo:
//   - runScript:
//       file: _ayudas/api.js
//       env:
//         ACCION: contar            # contar | beto-escribe | contar-avisos | avisos-sin-leer
//         EMAIL: ${E2E_EMAIL}
//         EMAIL_B: ${E2E_EMAIL_B}
//         PASSWORD: ${E2E_PASSWORD}
//         TEXTO: "Hola"             # solo para beto-escribe
//
// Deja en `output.mensajes`: sinLeerTotal, sinLeerBeto; y en `output.avisos`:
// sinLeer (todo como texto, para usarlo en ${...}).
//
// La clave `anon` por defecto es la PUBLICA de demostracion que trae el CLI de
// Supabase para cualquier proyecto local (no es un secreto); se puede cambiar
// con E2E_ANON_KEY. Se niega a hablar con nada que no sea 127.0.0.1/localhost.

var SUPABASE = (typeof E2E_SUPABASE_URL !== 'undefined' && E2E_SUPABASE_URL) || 'http://127.0.0.1:54321';
var API = (typeof E2E_API_URL !== 'undefined' && E2E_API_URL) || 'http://127.0.0.1:8000';
var ANON = (typeof E2E_ANON_KEY !== 'undefined' && E2E_ANON_KEY) ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

// Los de 30-mensajes.sql.
var CHAT_ANA_BETO = 'e2e30000-0000-4000-8000-000000000001';
var AVISOS_SIN_LEER = ['e2e30000-0000-4000-8000-000000000301', 'e2e30000-0000-4000-8000-000000000302'];

function esLocal(url) {
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url);
}
if (!esLocal(SUPABASE) || !esLocal(API)) {
  throw new Error('api.js solo habla con el backend local (127.0.0.1). Abortado.');
}

// El Supabase local admite 30 inicios de sesion cada 5 min por IP, y lo
// comparten las cinco suites: el token se guarda en `output` y se reutiliza en
// las siguientes llamadas del mismo flujo (dura una hora).
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

function contar(token) {
  // Lo mismo que pide la bandeja (primera pagina, agrupada) y la misma regla
  // que `sinLeerDeLaFila`: el mayor entre unread_count y total_unread.
  var r = http.get(API + '/api/v1/conversations?limit=20&offset=0&grouped=true', {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (r.status !== 200) throw new Error('GET /conversations: ' + r.status + ' ' + r.body);
  var total = 0;
  var beto = 0;
  json(r.body).forEach(function (c) {
    var n = Math.max(c.unread_count || 0, c.total_unread || 0);
    total += n;
    if (c.id === CHAT_ANA_BETO) beto = n;
  });
  output.mensajes = { sinLeerTotal: String(total), sinLeerBeto: String(beto) };
}

var accion = typeof ACCION !== 'undefined' ? ACCION : 'contar';

if (accion === 'contar') {
  contar(entrar(EMAIL, PASSWORD));
} else if (accion === 'beto-escribe') {
  var tokenBeto = entrar(EMAIL_B, PASSWORD);
  var r = http.post(API + '/api/v1/conversations/' + CHAT_ANA_BETO + '/messages', {
    headers: { Authorization: 'Bearer ' + tokenBeto, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: typeof TEXTO !== 'undefined' && TEXTO ? TEXTO : 'Mensaje de prueba de Beto' }),
  });
  if (r.status !== 201 && r.status !== 200) {
    throw new Error('Beto no pudo escribir (¿falta sembrar 30-mensajes.sql?): ' + r.status + ' ' + r.body);
  }
} else if (accion === 'contar-avisos') {
  // Lo que la API cuenta como notificaciones sin leer de Ana (la campana).
  var c = http.get(API + '/api/v1/notifications/unread-count', {
    headers: { Authorization: 'Bearer ' + entrar(EMAIL, PASSWORD) },
  });
  if (c.status !== 200) throw new Error('GET /notifications/unread-count: ' + c.status + ' ' + c.body);
  output.avisos = { sinLeer: String(json(c.body).count) };
} else if (accion === 'avisos-sin-leer') {
  // RLS deja a cada cual actualizar SUS notificaciones (notifications_update_own).
  var tokenAna = entrar(EMAIL, PASSWORD);
  var p = http.request(SUPABASE + '/rest/v1/notifications?id=in.(' + AVISOS_SIN_LEER.join(',') + ')', {
    method: 'PATCH',
    headers: {
      apikey: ANON,
      Authorization: 'Bearer ' + tokenAna,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ read_at: null }),
  });
  if (p.status !== 200 || json(p.body).length !== AVISOS_SIN_LEER.length) {
    throw new Error('No se pudieron dejar sin leer los avisos sembrados (¿falta 30-mensajes.sql?): ' + p.status + ' ' + p.body);
  }
} else {
  throw new Error('ACCION desconocida: ' + accion);
}
