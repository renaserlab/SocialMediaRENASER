/**
 * Rellena los datos de la empresa en las páginas legales.
 *
 * Las páginas se escriben con marcadores `[[NOMBRE]]` en lugar de datos reales,
 * porque la razón social, la dirección o el país no se conocían al redactarlas.
 * Este script los sustituye de una vez, para no ir editando cuatro ficheros a
 * mano y arriesgarse a dejar alguno a medias.
 *
 *   1. Copia `datos.ejemplo.json` a `datos.json` y complétalo.
 *   2. node legal/rellenar.mjs
 *
 * Genera las páginas finales en `legal/publicar/`, que es la carpeta que se sube
 * al alojamiento. Los originales con marcadores no se tocan, para poder volver a
 * generarlas cuando cambie un dato.
 *
 * Si queda algún marcador sin sustituir, el script AVISA y termina con error:
 * publicar una política con `[[RAZÓN SOCIAL]]` a la vista sería peor que no
 * publicarla.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SALIDA = join(AQUI, 'publicar');
const DATOS = join(AQUI, 'datos.json');

if (!existsSync(DATOS)) {
  console.error('\nFalta legal/datos.json.');
  console.error('Copia legal/datos.ejemplo.json a legal/datos.json y complétalo.\n');
  process.exit(1);
}

const datos = JSON.parse(readFileSync(DATOS, 'utf8'));
const paginas = readdirSync(AQUI).filter((f) => f.endsWith('.html'));

mkdirSync(SALIDA, { recursive: true });

let pendientes = 0;

for (const pagina of paginas) {
  let html = readFileSync(join(AQUI, pagina), 'utf8');

  for (const [clave, valor] of Object.entries(datos)) {
    html = html.replaceAll(`[[${clave}]]`, valor);
  }

  // Lo que siga entre dobles corchetes es un dato que nadie ha completado.
  const restantes = [...new Set(html.match(/\[\[[^\]]+\]\]/g) ?? [])];
  if (restantes.length > 0) {
    pendientes += restantes.length;
    console.error(`\n  ${pagina}: quedan ${restantes.length} sin completar`);
    for (const r of restantes) console.error(`     ${r}`);
  }

  writeFileSync(join(SALIDA, pagina), html, 'utf8');
}

if (pendientes > 0) {
  console.error(
    `\nNo se puede publicar: ${pendientes} marcador(es) sin completar.` +
      '\nAñádelos a legal/datos.json (o edítalos a mano si son decisiones de texto).\n',
  );
  process.exit(1);
}

console.log(`\nListo: ${paginas.length} páginas generadas en legal/publicar/\n`);
for (const p of paginas) console.log(`   ${p}`);
console.log('\nSube el contenido de esa carpeta al alojamiento.\n');
