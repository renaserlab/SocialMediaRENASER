#!/usr/bin/env node
/**
 * Lanza las baterías del móvil, y se niega a hacerlo si encuentra muy pocas.
 *
 * POR QUÉ NO ES UNA LÍNEA EN `package.json`. Lo era:
 *
 *     node --experimental-strip-types --test "src/**./*.test.mts"
 *
 * y un patrón que no casa nada **no es un error para Node**: son «cero pruebas,
 * todo bien», salida 0, trabajo en verde. Basta con renombrar a `.test.ts`,
 * mover las pruebas a otra carpeta o tocar el patrón en un refactor para que
 * las ciento trece baterías dejen de ejecutarse sin que nadie se entere. Es
 * exactamente la misma forma de fallo que la lista de ficheros escrita a mano
 * del trabajo con PostgreSQL, y esa ya se quedó vieja dos veces.
 *
 * Así que el patrón y el suelo viven juntos, en un solo sitio, y el suelo está
 * MEDIDO: 113 ficheros el 22/09/2026. Va algo por debajo para que borrar una
 * batería obsoleta no tumbe la integración, y lo bastante alto para que perder
 * una carpeta entera sí lo haga.
 *
 * NO DECIDE NADA MÁS: el resultado de las pruebas lo decide `node --test`, y
 * su código de salida se propaga tal cual.
 */
import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `apps/mobile`: este guion vive en `scripts/`.
 *
 * CON `fileURLToPath` Y NO CON `new URL(...).pathname`: el segundo deja los
 * espacios del camino codificados como `%20`, y la carpeta de este repositorio
 * tiene uno. El patron no casaba nada y este mismo guion lo leia como «han
 * desaparecido las baterias».
 */
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

const PATRON = 'src/**/*.test.mts';

/** Medido, no supuesto. Ver la cabecera. */
const SUELO = 105;

//: DESDE LA RAIZ DEL PAQUETE Y NO DESDE DONDE SE LANCE. Un patron relativo al
//: directorio actual daria cero baterias —y este mismo guion lo leeria como
//: «han desaparecido»— con solo llamarlo desde la raiz del repositorio.
const ficheros = globSync(PATRON, { cwd: RAIZ }).sort();

if (ficheros.length < SUELO) {
  console.error(
    `\n  El patrón «${PATRON}» encuentra ${ficheros.length} baterías y se ` +
      `esperaban al menos ${SUELO}.\n\n` +
      '  Esto NO es que las pruebas fallen: es que no se están encontrando.\n' +
      '  Revisa si se han movido, renombrado o cambiado de extensión.\n',
  );
  process.exit(1);
}

console.log(`${ficheros.length} baterías encontradas con «${PATRON}»\n`);

const resultado = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--test', ...ficheros],
  { stdio: 'inherit', cwd: RAIZ },
);

process.exit(resultado.status ?? 1);
