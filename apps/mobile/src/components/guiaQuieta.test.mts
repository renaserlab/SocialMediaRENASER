import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * La guia de primeros pasos (`CoachMark`) solo anima mientras se ve.
 *
 * Mira el CODIGO FUENTE porque las pruebas no montan React Native. Explorar
 * monta dos guias y la ficha del curso otra, se vean o no; con el bucle
 * arrancado antes del `return null`, una guia cerrada seguia latiendo sin
 * pintar nada y la pantalla nunca se quedaba quieta.
 */

const FUENTE = readFileSync(
  fileURLToPath(new URL('./CoachMark.tsx', import.meta.url)),
  'utf8',
);

function efectoDelLatido(): string {
  const inicio = FUENTE.indexOf('useEffect(');
  const fin = FUENTE.indexOf('loop.start()', inicio);
  assert.ok(inicio >= 0 && fin > inicio, 'el latido sigue siendo un useEffect con loop.start()');
  return FUENTE.slice(inicio, fin);
}

test('el bucle no arranca con la guia cerrada, oculta o con «reducir movimiento»', () => {
  assert.match(FUENTE, /useReduceMotion\(\)/);
  assert.match(
    FUENTE,
    /const debeLatir = visible && !dismissed && !reducirMovimiento;/,
    'la condicion del latido junta las tres cosas',
  );
  const efecto = efectoDelLatido();
  const salida = efecto.indexOf('if (!debeLatir)');
  const bucle = efecto.indexOf('Animated.loop(');
  assert.ok(salida >= 0 && bucle > salida, 'se sale del efecto antes de crear el bucle');
});

test('el efecto se rehace cuando la guia aparece o desaparece', () => {
  assert.match(FUENTE, /\}, \[pulse, debeLatir\]\);/);
});
