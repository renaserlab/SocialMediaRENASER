/**
 * Toda clave que una pantalla pide EXISTE en el diccionario.
 *
 * POR QUÉ HACE FALTA ADEMÁS DE `diccionariosSincronizados`. Aquella comprueba
 * que los tres diccionarios digan lo mismo entre sí; ninguna comprobaba que lo
 * que el código PIDE esté en ellos. Y `translate` devuelve la propia clave
 * cuando falta en los tres, así que el fallo no revienta: se PINTA. La revisión
 * independiente encontró `incidencia.proveedor.pedirQue` como marcador de un
 * campo del formulario de disputa, y el lector de pantalla leyéndolo en voz
 * alta.
 *
 * TypeScript no lo caza porque la mayoría de las pantallas de Productos traduce
 * a través de `useClaveDeProductos`, que convierte la clave con un `as`.
 *
 * QUÉ SE MIRA: las claves LITERALES pasadas a `f(...)`, `t(...)` o
 * `translate(...)`. Las que se componen en tiempo de ejecución —una plantilla
 * con el estado dentro— no se pueden comprobar leyendo, y por eso cada módulo
 * las pasa por su propio validador con su `.desconocido`.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { es } from './es.ts';

const RAIZ = join(fileURLToPath(import.meta.url), '..', '..', '..');

function fuentes(carpeta: string): string[] {
  const salida: string[] = [];
  for (const nombre of readdirSync(carpeta)) {
    const ruta = join(carpeta, nombre);
    if (statSync(ruta).isDirectory()) {
      salida.push(...fuentes(ruta));
    } else if (/\.(ts|tsx)$/.test(nombre) && !/\.test\./.test(nombre)) {
      salida.push(ruta);
    }
  }
  return salida;
}

/** `f('a.b')`, `t("a.b")`, `translate('a.b')`: el primer argumento literal. */
const LLAMADA = /\b(?:f|t|translate)\(\s*(['"])([A-Za-z][\w]*(?:\.[\w]+)+)\1/g;

it('ninguna pantalla pide una clave que no esté en el diccionario', () => {
  const conocidas = new Set(Object.keys(es));
  const ficheros = [...fuentes(join(RAIZ, 'src')), ...fuentes(join(RAIZ, 'app'))];
  assert.ok(ficheros.length > 100, `solo encontré ${ficheros.length} ficheros`);

  const rotas: string[] = [];
  let vistas = 0;
  for (const fichero of ficheros) {
    const texto = readFileSync(fichero, 'utf8');
    for (const casa of texto.matchAll(LLAMADA)) {
      vistas += 1;
      if (!conocidas.has(casa[2])) {
        rotas.push(`${casa[2]}  (${fichero.slice(RAIZ.length + 1)})`);
      }
    }
  }

  // NO VACUO: si el patrón dejara de casar, la lista de rotas saldría vacía
  // sin haber mirado nada.
  assert.ok(vistas > 1000, `solo se reconocieron ${vistas} claves literales`);
  assert.deepEqual(rotas, [], `claves que se pintarían crudas:\n  ${rotas.join('\n  ')}`);
});
