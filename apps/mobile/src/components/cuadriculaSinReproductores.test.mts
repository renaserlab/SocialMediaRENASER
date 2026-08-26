import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Lo que NUNCA puede volver a la cuadricula del perfil.
 *
 * Estas comprobaciones miran el CODIGO FUENTE, no la pantalla. No es lo
 * habitual, pero aqui es lo unico que sirve: montar la vista pediria un
 * renderizador de React Native que este proyecto no tiene en las pruebas, y lo
 * que hay que impedir no es un valor mal calculado sino un componente que
 * vuelva a colarse en un sitio donde ya causo el problema una vez.
 *
 * Los dos fallos que fija, ambos vistos en produccion:
 *
 *  - Un reproductor por celda. En el movil dibujan un rectangulo vacio cuando
 *    no reproducen, asi que un perfil enseñaba una cuadricula negra; y cada uno
 *    reserva memoria por delante, de modo que unos pocos agotaban la que
 *    Android concede y cerraban la aplicacion.
 *  - Guardar las miniaturas bajo la URL FIRMADA. Como la firma cambia en cada
 *    refirma, la cache de disco no reconocia nada y el perfil se descargaba
 *    entero otra vez cada hora.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. Ni reproductores ni expo-video en la cuadricula
// ---------------------------------------------------------------------------

test('la galeria del perfil no monta reproductores', () => {
  const galeria = fuente('components/ProfileGallery.tsx');
  assert.ok(
    !/from '@\/components\/VideoPlayer'/.test(galeria),
    'ProfileGallery importa VideoPlayer: una cuadricula no reproduce nada.',
  );
  assert.ok(
    !galeria.includes('expo-video'),
    'ProfileGallery toca expo-video: la celda solo debe pintar el poster.',
  );
  assert.ok(
    galeria.includes('<VideoTile'),
    'La celda de video debe seguir siendo VideoTile (poster, sin reproductor).',
  );
});

test('la celda de video tampoco lo hace por su cuenta', () => {
  const celda = fuente('components/VideoTile.tsx');
  assert.ok(!celda.includes('expo-video'), 'VideoTile monta un reproductor.');
  assert.ok(!celda.includes('useVideoPlayer'), 'VideoTile monta un reproductor.');
});

// ---------------------------------------------------------------------------
// 2. Claves de cache estables
// ---------------------------------------------------------------------------

test('la cuadricula guarda las miniaturas bajo una clave estable', () => {
  const galeria = fuente('components/ProfileGallery.tsx');
  // La regla vive en `miniaturaDePublicacion`, que devuelve la ruta de Storage.
  assert.ok(
    galeria.includes("from '@/lib/miniaturaDePublicacion'"),
    'La galeria debe sacar la fuente de miniaturaDePublicacion, no armarla a mano.',
  );
  assert.ok(
    /cacheKey: mini\.cacheKey/.test(galeria),
    'Falta pasar la clave de cache a expo-image: sin ella manda la URL firmada.',
  );
  assert.ok(
    !/recyclingKey=\{post\.mediaUrl/.test(galeria),
    'La marca de reciclaje no puede ser la URL firmada: cambia en cada refirma.',
  );
});

test('la celda de video guarda su poster bajo la ruta, no bajo la firma', () => {
  const celda = fuente('components/VideoTile.tsx');
  assert.ok(/cacheKey: posterCacheKey/.test(celda));
});

// ---------------------------------------------------------------------------
// 3. Ninguna celda a la espera se pinta de negro
// ---------------------------------------------------------------------------

test('las celdas a la espera no son negras', () => {
  const galeria = fuente('components/ProfileGallery.tsx');
  /*
    Estaban pintadas de negro puro mientras llegaba su foto. Con la cuadricula
    entera cargando, el perfil era un tablero de agujeros —y en tema claro,
    ademas, chillon—. El color tiene que salir del tema.
  */
  assert.ok(
    !/backgroundColor: '#000/i.test(galeria),
    'Hay una celda pintada de negro: debe usar el gris de superficie del tema.',
  );
  assert.ok(
    /backgroundColor: colors\.surfaceAlt/.test(galeria),
    'La espera debe pintarse con la superficie del tema.',
  );
});

// ---------------------------------------------------------------------------
// 4. Abrir un perfil precarga: nadie navega por su cuenta
// ---------------------------------------------------------------------------

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

test('todo el que abre un perfil pasa por irAlPerfil', () => {
  /*
    `irAlPerfil` pide el perfil y sus publicaciones EN EL MISMO GESTO y navega
    sin esperarlas, asi que las peticiones viajan durante la animacion de
    entrada. Quien empuje la ruta por su cuenta se salta esa precarga y su
    pantalla vuelve a abrirse vacia, que es justo el fallo que se corrigio.
  */
  const permitidos = [join(SRC, 'lib', 'irAlPerfil.ts')];
  const culpables: string[] = [];
  for (const ruta of ficherosDeCodigo(SRC)) {
    if (permitidos.includes(ruta) || ruta.endsWith('.test.mts')) continue;
    const texto = readFileSync(ruta, 'utf8');
    if (/router\.push\(\s*`\/profile\//.test(texto)) culpables.push(ruta);
    if (/router\.push\(\{[^}]*'\/profile\/\[id\]'/s.test(texto)) culpables.push(ruta);
  }
  assert.deepEqual(
    culpables.map((r) => r.slice(SRC.length + 1)),
    [],
    'Estos sitios abren un perfil sin precargarlo. Usa irAlPerfil(router, id).',
  );
});
