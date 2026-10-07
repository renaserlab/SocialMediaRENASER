import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * LA BARRA DE LA PANTALLA DE RECORTE SE LEE.
 *
 * Reportado el 06/10/2026, con captura: al cambiar la foto de perfil, la barra
 * de arriba —atrás, girar, voltear y «CORTAR»— salía gris oscuro con todo en
 * negro. «Aparece opaco» y «no aparece el botón de cambiar foto».
 *
 * Esa pantalla es de `expo-image-picker`. Pinta la barra TRANSPARENTE sobre un
 * tema oscuro y, en modo claro, los iconos en negro. `plugins/
 * withColoresDelRecorte` declara esos colores como recursos de la aplicación,
 * con la barra OPACA. Aquí se comprueba que lo que declara se lee de verdad.
 */

const RAIZ = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const requerir = createRequire(import.meta.url);

type Colores = Record<string, string>;
const { EN_CLARO, EN_OSCURO } = requerir(join(RAIZ, 'plugins', 'withColoresDelRecorte.js')) as {
  EN_CLARO: Colores;
  EN_OSCURO: Colores;
};

/** Luminancia relativa de un `#RRGGBB` (WCAG 2). */
function luminancia(hex: string): number {
  const canal = (i: number) => {
    const v = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * canal(0) + 0.7152 * canal(1) + 0.0722 * canal(2);
}

function contraste(a: string, b: string): number {
  const [clara, oscura] = [luminancia(a), luminancia(b)].sort((x, y) => y - x) as [number, number];
  return (clara + 0.05) / (oscura + 0.05);
}

/** Los nombres que lee la biblioteca. Si los cambia, esto se queda sin efecto. */
const NOMBRES = [
  'expoCropToolbarColor',
  'expoCropToolbarIconColor',
  'expoCropToolbarActionTextColor',
  'expoCropBackButtonIconColor',
  'expoCropBackgroundColor',
];

describe('los colores de la pantalla de recorte', () => {
  for (const [modo, colores] of [
    ['claro', EN_CLARO],
    ['oscuro', EN_OSCURO],
  ] as const) {
    it(`en ${modo}: están los cinco, y la barra es opaca`, () => {
      assert.deepEqual(Object.keys(colores).sort(), [...NOMBRES].sort());
      for (const valor of Object.values(colores)) {
        // Seis cifras: sin canal de transparencia. La barra transparente era el fallo.
        assert.match(valor, /^#[0-9A-F]{6}$/);
      }
    });

    it(`en ${modo}: iconos, «CORTAR» y la flecha se leen sobre la barra`, () => {
      const barra = colores.expoCropToolbarColor as string;
      for (const encima of ['expoCropToolbarIconColor', 'expoCropToolbarActionTextColor', 'expoCropBackButtonIconColor']) {
        const razon = contraste(barra, colores[encima] as string);
        // 7:1 es el nivel AAA de texto; aquí es negro sobre blanco o al revés.
        assert.ok(razon >= 7, `${encima} sobre la barra: ${razon.toFixed(1)}:1`);
      }
    });
  }

  it('los nombres son los que la biblioteca lee de verdad', () => {
    const recursos = readFileSync(
      join(RAIZ, '..', '..', 'node_modules', 'expo-image-picker', 'android', 'src', 'main', 'res', 'values', 'colors.xml'),
      'utf8',
    );
    for (const nombre of NOMBRES) {
      assert.ok(recursos.includes(`name="${nombre}"`), `${nombre} ya no existe en expo-image-picker`);
    }
    // Y el defecto que se tapa sigue siendo ese: la barra transparente.
    assert.match(recursos, /name="expoCropToolbarColor">#00000000</);
  });

  it('el plugin está en app.json', () => {
    const app = JSON.parse(readFileSync(join(RAIZ, 'app.json'), 'utf8')) as {
      expo: { plugins: (string | [string, unknown])[] };
    };
    assert.ok(app.expo.plugins.includes('./plugins/withColoresDelRecorte'));
  });
});
