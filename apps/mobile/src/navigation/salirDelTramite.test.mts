import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ESPERA_MINIMA_MS,
  MARGEN_TRAS_LA_TRANSICION_MS,
  esperaParaPresentar,
} from '../lib/avisoTrasNavegar.ts';
import { empezarDeNuevoEn, volverA } from './salirDelTramite.ts';
import { DURACION_DE_LA_TRANSICION_MS } from './transicion.ts';

/**
 * LA PANTALLA GRIS DESPUÉS DE GUARDAR (teléfono, 06 y 07/10/2026).
 *
 * Dos sitios: al fijar la contraseña nueva y al publicar un curso. En los dos
 * el dato se guardaba y la pantalla siguiente no llegaba a verse; había que
 * cerrar la aplicación.
 *
 * Tenían en común pedir el aviso de «hecho» y sustituir la pantalla en la línea
 * siguiente. Aquí se comprueban las tres cosas que cambian:
 *
 *   1. el aviso espera a que la pantalla esté quieta (se EJECUTA la regla);
 *   2. cada trámite sale por una salida con nombre (se EJECUTAN las dos);
 *   3. las pantallas las usan, y Cursos se refresca al volver (sobre el código).
 *
 * No se ha podido reproducir fuera del teléfono: lo que estas pruebas guardan
 * es el diseño, no la demostración de la causa.
 */

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const RAIZ = join(SRC, '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (codigo: string) =>
  codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const QUIETA = DURACION_DE_LA_TRANSICION_MS + MARGEN_TRAS_LA_TRANSICION_MS;

describe('un aviso no se enseña mientras la pantalla cambia', () => {
  it('sin cambio de pantalla, sale casi al instante', () => {
    assert.equal(esperaParaPresentar(10_000, null, DURACION_DE_LA_TRANSICION_MS), ESPERA_MINIMA_MS);
  });

  it('pedido en el mismo instante que la navegación, espera la transición entera', () => {
    // El caso del fallo: `toast()` y `router.replace()` en la misma línea.
    assert.equal(esperaParaPresentar(10_000, 10_000, DURACION_DE_LA_TRANSICION_MS), QUIETA);
  });

  it('a mitad de la transición, espera lo que falta', () => {
    assert.equal(esperaParaPresentar(10_100, 10_000, DURACION_DE_LA_TRANSICION_MS), QUIETA - 100);
  });

  it('con la pantalla ya quieta, vuelve a ser casi inmediato', () => {
    assert.equal(esperaParaPresentar(10_000 + QUIETA, 10_000, DURACION_DE_LA_TRANSICION_MS), ESPERA_MINIMA_MS);
    assert.equal(esperaParaPresentar(99_999, 10_000, DURACION_DE_LA_TRANSICION_MS), ESPERA_MINIMA_MS);
  });

  it('nunca espera menos del instante mínimo ni más que una pantalla quieta', () => {
    for (const ahora of [0, 9_000, 10_000, 10_001, 10_349, 10_350, 50_000]) {
      const espera = esperaParaPresentar(ahora, 10_000, DURACION_DE_LA_TRANSICION_MS);
      assert.ok(espera >= ESPERA_MINIMA_MS, `ahora=${ahora}: ${espera}`);
      assert.ok(espera <= QUIETA, `ahora=${ahora}: ${espera}`);
    }
  });

  it('el instante mínimo deja ver una navegación que venga detrás, sin notarse', () => {
    // Al menos un fotograma a 60 Hz; y por debajo de lo que se percibe como retraso.
    assert.ok(ESPERA_MINIMA_MS >= 17 && ESPERA_MINIMA_MS <= 100);
  });

  it('el anfitrión pregunta a la regla y no monta el aviso hasta que le toca', () => {
    const host = sinComentarios(fuente('components/ToastHost.tsx'));
    assert.match(host, /const ruta = usePathname\(\);/);
    assert.match(host, /esperaParaPresentar\(\s*Date\.now\(\),\s*ultimoCambioDePantalla\.current,\s*DURACION_DE_LA_TRANSICION_MS,?\s*\)/);
    // Sin presentar, no hay <Toast>: lo que no se monta no anima.
    assert.match(host, /if \(!visible \|\| presentado !== visible\.id\) return null;/);
    // Si la pantalla cambia mientras espera, la espera vuelve a empezar.
    assert.match(host, /\[idDeLaCabeza, presentado, ruta\]/);
  });

  it('el anfitrión apunta el cambio de pantalla ANTES de programar el aviso', () => {
    // Los efectos de un render corren en orden: el que apunta va primero.
    const host = sinComentarios(fuente('components/ToastHost.tsx'));
    const apunta = host.indexOf('ultimoCambioDePantalla.current = Date.now()');
    const programa = host.indexOf('esperaParaPresentar(');
    assert.ok(apunta > 0 && programa > apunta);
  });

  it('la pila y el anfitrión usan la MISMA duración', () => {
    const layout = sinComentarios(readFileSync(join(RAIZ, 'app', '_layout.tsx'), 'utf8'));
    assert.match(layout, /animationDuration: DURACION_DE_LA_TRANSICION_MS/);
    assert.ok(!/animationDuration: \d/.test(layout), 'la duración no se escribe a mano en el layout');
  });
});

/** Un `router` de mentira que apunta lo que se le pide, en orden. */
function enrutador(hayPantallasDebajo: boolean) {
  const ordenes: string[] = [];
  return {
    ordenes,
    canDismiss: () => hayPantallasDebajo,
    dismissAll: () => void ordenes.push('dismissAll'),
    replace: (destino: never) => void ordenes.push(`replace ${String(destino)}`),
    dismissTo: (destino: never) => void ordenes.push(`dismissTo ${String(destino)}`),
  };
}

describe('las dos salidas de un trámite', () => {
  it('empezar de nuevo: vacía la pila y luego pone el destino', () => {
    const router = enrutador(true);
    empezarDeNuevoEn(router, '/(tabs)/home');
    assert.deepEqual(router.ordenes, ['dismissAll', 'replace /(tabs)/home']);
  });

  it('empezar de nuevo sin nada debajo: solo pone el destino', () => {
    // La aplicación la abrió el enlace del correo: no hay pantallas que quitar,
    // y pedir que se quiten es un aviso en consola de la librería.
    const router = enrutador(false);
    empezarDeNuevoEn(router, '/onboarding');
    assert.deepEqual(router.ordenes, ['replace /onboarding']);
  });

  it('volver a: una sola orden, la que retrocede hasta el destino', () => {
    const router = enrutador(true);
    volverA(router, '/cursos');
    assert.deepEqual(router.ordenes, ['dismissTo /cursos']);
  });
});

describe('quién usa cada salida', () => {
  it('la contraseña nueva empieza de nuevo en Inicio, y avisa DESPUÉS de navegar', () => {
    const pantalla = sinComentarios(fuente('screens/ResetPasswordScreen.tsx'));
    const envio = pantalla.slice(pantalla.indexOf('const submit'), pantalla.indexOf('if (recoveryError'));
    assert.match(envio, /await updatePassword\(password\);\s*empezarDeNuevoEn\(router, postAuthRoute\(\)\);\s*toast\(/);
    assert.ok(!/router\.replace\(postAuthRoute/.test(pantalla));
  });

  it('publicar un curso vuelve a Cursos, y avisa DESPUÉS de navegar', () => {
    const asistente = sinComentarios(fuente('screens/AsistenteDeCursoScreen.tsx'));
    const publicar = asistente.slice(asistente.indexOf('const publicar'), asistente.indexOf('const volverSinBorrador'));
    assert.match(publicar, /if \(resultado\.published\) \{\s*volverA\(router, '\/cursos'\);\s*toast\(t\('course\.published'\)\);/);
    assert.ok(!/router\.replace\(`\/course\//.test(publicar));
  });

  it('Cursos vuelve a preguntar al recuperar el foco, pero no la primera vez', () => {
    const cursos = sinComentarios(fuente('screens/CursosScreen.tsx'));
    assert.match(cursos, /useFocusEffect\(\s*useCallback\(\(\) => \{\s*if \(!yaTuvoElFoco\.current\) \{\s*yaTuvoElFoco\.current = true;\s*return;\s*\}\s*void cargarVigente\.current\(\);\s*\}, \[\]\),\s*\);/);
    // La primera carga sigue siendo la del efecto de siempre.
    assert.match(cursos, /useEffect\(\(\) => \{\s*void cargar\(\);\s*\}, \[cargar\]\);/);
  });
});
