import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Restos de maqueta que no pueden volver.
 *
 * Miran el CODIGO FUENTE y no la pantalla, como `cuadriculaSinReproductores`:
 * montar estas vistas pediria un renderizador de React Native que las pruebas
 * de este proyecto no tienen, y lo que hay que impedir no es un valor mal
 * calculado sino contenido inventado que se enseña como si fuera real.
 *
 * La regla del proyecto: la aplicacion no enseña datos inventados como si
 * fueran de esta persona. Ya se aplico a la lista de seguidores, que salia de
 * `mockData`; estos dos casos son los mismos.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');
const MOVIL = join(SRC, '..');

function ficherosDeCodigo(dir: string, encontrados: string[] = []): string[] {
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const ruta = join(dir, entrada.name);
    if (entrada.isDirectory()) ficherosDeCodigo(ruta, encontrados);
    else if (/\.tsx?$/.test(entrada.name) && !entrada.name.endsWith('.d.ts')) {
      encontrados.push(ruta);
    }
  }
  return encontrados;
}

// ---------------------------------------------------------------------------
// 1. «Mis Audios» no inventa un historial
// ---------------------------------------------------------------------------

test('la biblioteca no trae audios escritos a mano', () => {
  /*
    Eran dos: «Tu enfoque de esta semana» y «El poder de la disciplina diaria».
    Se pintaban como el historial de quien miraba, y ademas los dos abrian el
    MISMO contenido, porque `/audio/[id]` ignora el id y siempre carga el audio
    privado vigente.

    SIGUE SIN HABER HISTORIAL DE ESCUCHA: no existe ni tabla ni endpoint que
    registre lo que alguien ha oido. La pestaña ya no esta vacia, pero lo que
    enseña son los audios GUARDADOS (`/saved-posts?media=audio`), un hecho del
    servidor. Lo que no puede volver es prometer un historial.
  */
  const pantalla = readFileSync(join(SRC, 'screens', 'LibraryScreen.tsx'), 'utf8');
  assert.ok(
    !/const audios\s*=/.test(pantalla),
    'Vuelve a haber una lista de audios escrita a mano en la biblioteca.',
  );
  assert.ok(
    !/router\.push\(\s*`\/audio\//.test(pantalla),
    'La biblioteca navega a /audio/{id}, y esa pantalla no lee el id: todos los ' +
      'audios abririan el mismo contenido.',
  );
  assert.ok(
    /listSaved\(/.test(pantalla) && /media: 'audio'/.test(pantalla),
    '«Mis Audios» tiene que salir del servidor (`listSaved` con media audio); ' +
      'cualquier otra fuente se pierde al reinstalar.',
  );
  /*
    Los textos que prometian escuchas. Se buscan tal cual se pintaban y no por
    la palabra «historial» a secas, porque el comentario de cabecera de la
    pantalla explica justo por que NO existe ese historial: buscarla suelta
    convertiria esa explicacion en un fallo.
  */
  for (const promesa of ['Historial de audios vacío', 'audios que escuches']) {
    assert.ok(
      !pantalla.includes(promesa),
      `«Mis Audios» vuelve a prometer un historial de escucha ("${promesa}") que no existe.`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. La pantalla de short de maqueta esta borrada
// ---------------------------------------------------------------------------

test('no queda ninguna ruta ni pantalla de short suelta', () => {
  /*
    `/short/[id]` reproducia siempre el mismo clip de demostracion alojado
    fuera, con los me gusta y el autor escritos a mano. La galeria de /dev era
    lo unico que enlazaba, y esa SI comprueba `__DEV__`; el fichero de ruta no,
    asi que la pantalla viajaba en las builds y en la web bastaba con escribir
    la URL. El feed de shorts real es `components/ShortVideoItem`, en Inicio.
  */
  assert.ok(
    !existsSync(join(MOVIL, 'app', 'short')),
    'Ha vuelto la ruta app/short: el feed de shorts es la pantalla de Inicio.',
  );
  assert.ok(
    !existsSync(join(SRC, 'screens', 'ShortVideoScreen.tsx')),
    'Ha vuelto ShortVideoScreen: era una maqueta sobre un clip de demostracion.',
  );
  assert.ok(
    existsSync(join(SRC, 'components', 'ShortVideoItem.tsx')),
    'Falta ShortVideoItem, que es el feed de video REAL y no tiene nada que ver.',
  );
});

/**
 * Un enlace a la ruta, no la ruta nombrada de paso.
 *
 * Se exige el verbo de navegacion delante (`push`, `replace`, `href`) porque
 * el motivo por el que se borro esa pantalla esta escrito en comentarios que
 * la mencionan; buscar el texto a secas convertiria esa explicacion en un
 * fallo de las pruebas.
 */
const ENLACE_A_SHORT = /(?:push|replace|href)[^\n]{0,60}['"`]\/short\//;

test('nadie enlaza a /short/', () => {
  const culpables: string[] = [];
  for (const raiz of [join(MOVIL, 'app'), SRC]) {
    for (const ruta of ficherosDeCodigo(raiz)) {
      if (ruta.endsWith('.test.mts')) continue;
      if (ENLACE_A_SHORT.test(readFileSync(ruta, 'utf8'))) culpables.push(ruta);
    }
  }
  assert.deepEqual(
    culpables.map((r) => r.slice(MOVIL.length + 1)),
    [],
    'Estos sitios enlazan a /short/, que ya no existe. El feed de shorts es /(tabs)/home.',
  );
});
