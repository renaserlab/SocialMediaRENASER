import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * «JUAN ESTÁ TRANSMITIENDO EN VIVO», COMO EN TIKTOK (25/09/2026).
 *
 * Tres piezas: el push (lo manda el servidor), la fila en la bandeja (tambien
 * del servidor, aqui solo se pinta) y el aviso que sale arriba al abrir la
 * aplicacion. Lo que se fija aqui es la parte del movil:
 *
 *  - El aviso emergente pregunta al ENTRAR y al VOLVER del segundo plano, solo
 *    con sesion y solo si esta build emite directos; cada directo, una vez.
 *  - Tocar el push abre el directo (antes solo abria la aplicacion).
 *  - La bandeja dice «Juan está transmitiendo en vivo» y lleva al directo.
 *
 * Se mira el CODIGO FUENTE: montar las vistas pediria un renderizador de React
 * Native que el proyecto no tiene. La ruta del push, que es donde hay reglas de
 * verdad (solo UUID), se EJECUTA en `lib/rutaDelPush.test.mts`.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');
const RAIZ = join(SRC, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

function sinComentarios(texto: string): string {
  return texto
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const AVISO = sinComentarios(fuente('components/AvisoDeDirectoSeguido.tsx'));
const PUSH_NATIVO = sinComentarios(fuente('hooks/useAbrirDesdeElPush.native.ts'));
const PUSH_WEB = sinComentarios(fuente('hooks/useAbrirDesdeElPush.ts'));
const RAIZ_LAYOUT = sinComentarios(readFileSync(join(RAIZ, 'app', '_layout.tsx'), 'utf8'));

test('el aviso solo pregunta con sesion y si esta build emite directos', () => {
  assert.match(AVISO, /if \(!FEATURE_LIVE \|\| !conSesion\) return;/);
  assert.match(AVISO, /LiveRepository\.enVivoDeQuienSigo\(\)/);
  // Y el repositorio pregunta lo que toca.
  assert.match(
    fuente('repositories/LiveRepository.ts'),
    /\/live\/sessions\/following\?limit=/,
  );
});

test('pregunta al entrar y al volver del segundo plano', () => {
  assert.match(AVISO, /useEffect\(\(\) => \{\s*void consultar\(\);\s*\}, \[consultar\]\);/);
  assert.match(AVISO, /AppState\.addEventListener\('change'/);
  assert.match(AVISO, /if \(estado === 'active'\) void consultar\(\);/);
  assert.match(AVISO, /return \(\) => suscripcion\.remove\(\);/);
});

test('cada directo se anuncia una sola vez por arranque', () => {
  // En el modulo, no en el estado: volver del segundo plano no lo repite.
  assert.match(AVISO, /^const yaAvisados = new Set<string>\(\);/m);
  assert.match(AVISO, /vivas\.find\(\(e\) => !yaAvisados\.has\(e\.id\)\)/);
  assert.match(AVISO, /yaAvisados\.add\(nueva\.id\);/);
});

test('se va solo, se puede cerrar y tocarlo abre el directo', () => {
  assert.match(AVISO, /setTimeout\(\(\) => setEmision\(null\), DURACION_MS\)/);
  assert.match(AVISO, /return \(\) => clearTimeout\(temporizador\);/);
  assert.match(AVISO, /router\.push\(`\/live\/\$\{id\}` as never\)/);
  assert.match(AVISO, /accessibilityLabel=\{t\('common\.close'\)\}/);
  // Un fallo al preguntar no se enseña: es un extra.
  assert.doesNotMatch(AVISO, /\b(notify|confirm|toast)\(/);
});

test('el layout raiz monta el aviso y escucha el toque en el push', () => {
  assert.match(RAIZ_LAYOUT, /useAbrirDesdeElPush\(\);/);
  const aviso = RAIZ_LAYOUT.indexOf('<AvisoDeDirectoSeguido />');
  const dialogo = RAIZ_LAYOUT.indexOf('<DialogHost />');
  assert.ok(aviso > 0 && aviso < dialogo, 'el aviso tiene que quedar por debajo de los dialogos');
});

test('tocar el push abre el directo, una vez y con la navegacion ya montada', () => {
  assert.match(PUSH_NATIVO, /Notifications\.useLastNotificationResponse\(\)/);
  assert.match(PUSH_NATIVO, /if \(!lista \|\| !respuesta\) return;/);
  assert.match(PUSH_NATIVO, /if \(atendidas\.current\.has\(identificador\)\) return;/);
  assert.match(PUSH_NATIVO, /const ruta = rutaDelPush\(datos\);/);
  // Quien entra por el push no ve encima el aviso del mismo directo.
  assert.match(PUSH_NATIVO, /if \(directo\) marcarDirectoComoAvisado\(directo\);/);
  // La web no escucha push nativos: ni siquiera importa la libreria.
  assert.doesNotMatch(PUSH_WEB, /expo-notifications/);
  assert.match(PUSH_WEB, /export function useAbrirDesdeElPush\(\): void/);
});

test('la bandeja dice quien esta en directo', () => {
  const mapeador = sinComentarios(fuente('mappers/notificationMapper.ts'));
  assert.match(
    mapeador,
    /case 'live_started':\s*title = t\('notif\.liveTitle'\);\s*subtitle = t\('notif\.liveBody', \{ actor \}\);\s*icon = 'radio';/,
  );
  const es = fuente('i18n/es.ts');
  assert.match(es, /'notif\.liveBody': '\{actor\} está transmitiendo en vivo'/);
});
