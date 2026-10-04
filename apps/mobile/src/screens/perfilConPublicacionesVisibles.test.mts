import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * VOLVER A LAS PUBLICACIONES DEL PERFIL NO PUEDE SER UN TRUCO.
 *
 * Lo reportado: «cuando comenzamos a navegar por cursos, podcast, reseñas… la
 * información de las publicaciones desaparece y se necesita un botón para
 * volver a ver las publicaciones; actualmente no lo tiene y lo que se debe
 * hacer es presionar dos veces el ícono en donde se está».
 *
 * Los accesos eran interruptores: el mismo círculo abría su sección y, al
 * tocarlo otra vez, la cerraba. Nada lo decía. Ahora «Publicaciones» es un
 * acceso más, el primero, y cada círculo hace una sola cosa.
 */

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (codigo: string) =>
  codigo.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const PERFIL = sinComentarios(fuente('screens/ProfileScreen.tsx'));
const ACCESOS = PERFIL.slice(PERFIL.indexOf('<View style={styles.shortcuts}>'));

describe('la pestaña Publicaciones', () => {
  it('existe, con su nombre, y es la primera', () => {
    const primero = ACCESOS.indexOf('<Shortcut');
    const publicaciones = ACCESOS.indexOf("label={t('profile.postsTab')}");
    const podcast = ACCESOS.indexOf("label={t('profile.podcast')}");
    assert.notEqual(publicaciones, -1, 'falta el acceso de Publicaciones');
    assert.ok(primero < publicaciones && publicaciones < podcast, 'va antes que los demás');
  });

  it('está encendida justo cuando se ven las publicaciones', () => {
    assert.match(
      ACCESOS,
      /label=\{t\('profile\.postsTab'\)\}\s*active=\{activeSection === null\}\s*onPress=\{\(\) => setActiveSection\(null\)\}/,
    );
    // Y lo que se pinta con `null` sigue siendo la galería de publicaciones.
    assert.match(PERFIL, /\{activeSection \? \(\s*<ProfileSection[\s\S]*?\) : \(\s*<ProfileGallery/);
  });

  it('ningún acceso se apaga al tocarlo por segunda vez', () => {
    assert.ok(
      !/setActiveSection\(\(v\) => \(v === '[a-z]+' \? null : /.test(PERFIL),
      'Queda un acceso que funciona como interruptor: tocarlo dos veces vuelve ' +
        'a las publicaciones sin que nada lo diga.',
    );
    for (const seccion of ['podcast', 'cursos', 'testimonios']) {
      assert.match(ACCESOS, new RegExp(`onPress=\\{\\(\\) => setActiveSection\\('${seccion}'\\)\\}`));
    }
  });

  it('los accesos se anuncian como pestañas, con cuál está elegida', () => {
    const acceso = PERFIL.slice(PERFIL.indexOf('function Shortcut('));
    // Pestaña por defecto; «Agenda», que navega fuera, se anuncia como botón.
    assert.match(acceso, /rol = 'tab',/);
    assert.match(acceso, /accessibilityRole=\{rol\}/);
    assert.match(ACCESOS, /rol="button"\s*onPress=\{\(\) =>\s*isPublic \? setBookingVisible\(true\)/);
    assert.match(acceso, /accessibilityState=\{\{ selected: active \}\}/);
    // El estado no vive solo en el color: el círculo se invierte, la etiqueta
    // pasa a negrita y el icono salta al encenderse.
    assert.match(acceso, /fontWeight: active \? '800' : '500'/);
    assert.match(acceso, /<IconoQueSeEnciende\s+activo=\{active\}/);
  });

  it('el cambio de sección se ve: el contenido entra', () => {
    assert.match(PERFIL, /<Aparecer key=\{activeSection \?\? 'publicaciones'\}>/);
  });

  it('no se creó ninguna ruta ni se toca el servidor para esto', () => {
    assert.ok(!/router\.(push|replace)\([^)]*publicaciones/i.test(ACCESOS.slice(0, 3000)));
  });

  it('el nombre está en los tres idiomas', () => {
    for (const idioma of ['es', 'en', 'pt']) {
      assert.ok(fuente(`i18n/${idioma}.ts`).includes("'profile.postsTab'"), `falta en ${idioma}.ts`);
    }
  });
});
