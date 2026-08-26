import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Las dos reglas duras del contenido de curso, comprobadas sobre el CÓDIGO.
 *
 * Se mira el código y no la pantalla por lo mismo que en
 * `navigation/sinCambioDeSeccion.test.mts`: montar la vista pediría un
 * renderizador de React Native que este proyecto no tiene en las pruebas, y lo
 * que hay que impedir no es un valor mal calculado sino que alguien vuelva a
 * hacer algo que ya salió caro.
 *
 * 1. LOS TIPOS DE LECCIÓN QUE ADMITE LA BASE Y LOS QUE ESCRIBE LA APP TIENEN
 *    QUE SER LOS MISMOS. El `check` de la migración 0034 y la unión de
 *    TypeScript son la misma decisión escrita dos veces; si se separan, la app
 *    guarda un tipo que PostgreSQL rechaza y la lección se pierde al guardarla.
 *
 * 2. LAS COLUMNAS DE LA 0034 SE NOMBRAN EN UN SOLO SITIO. El contenido de un
 *    curso se escribe contra Supabase directamente, así que aquí no hay un
 *    backend que degrade por nosotros: nombrar `kind` en una base sin esa
 *    columna hace que PostgREST rechace la fila ENTERA. La comprobación (y el
 *    recuerdo de su respuesta) vive en `CourseContentRepository.ts`; repartirla
 *    es garantizar que un día alguien escriba la columna sin preguntar.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..', '..');
const RAIZ = join(SRC, '..', '..', '..');

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

function relativa(ruta: string): string {
  return ruta.slice(SRC.length + 1).replace(/\\/g, '/');
}

const REPOSITORIO = join(SRC, 'repositories', 'CourseContentRepository.ts');

test('los tipos de lección de la app son los que admite la migración 0034', () => {
  const sql = readFileSync(
    join(RAIZ, 'supabase', 'migrations', '0034_cursos_v2.sql'),
    'utf8',
  );
  const check = /course_lessons_kind_check[\s\S]*?check \(kind in \(([^)]*)\)\)/.exec(sql);
  assert.ok(check, 'la 0034 tiene que declarar el CHECK de `kind`');
  const enLaBase = [...check[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();

  const ts = readFileSync(REPOSITORIO, 'utf8');
  const union = /export type LessonKind = ([^;]+);/.exec(ts);
  assert.ok(union, 'el repositorio tiene que declarar `LessonKind`');
  const enLaApp = [...union[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();

  assert.deepEqual(
    enLaApp,
    enLaBase,
    'La app y la migración no admiten los mismos tipos de lección. Si se añade ' +
      'uno (cuestionario, directo), se cambian LOS DOS y además la pantalla que ' +
      'sabe abrirlo: un tipo que nadie sabe pintar es una lección rota.',
  );
});

test('no se ofrecen tipos de lección que ninguna pantalla sabe abrir', () => {
  const editor = readFileSync(join(CARPETA, 'EditorDeContenido.tsx'), 'utf8');
  for (const inventado of ["'quiz'", "'live'", "'assignment'"]) {
    assert.ok(
      !editor.includes(inventado),
      `El editor ofrece ${inventado}, y no hay pantalla que lo abra: sería un botón muerto.`,
    );
  }
});

test('solo el repositorio le nombra a SUPABASE las columnas de la 0034', () => {
  /*
    El peligro es concreto: nombrarle una columna que no existe a PostgREST
    hace que rechace la fila ENTERA. Leer `is_preview` de la respuesta JSON del
    backend (lo que hace `mappers/learningMapper.ts`) no tiene ese riesgo,
    porque ahí el que degrada es el servidor. Por eso la regla mira quién habla
    con Supabase, no quién escribe el nombre.
  */
  const columnas = ['is_preview', 'kind'];
  const culpables: string[] = [];

  for (const ruta of ficherosDeCodigo(SRC)) {
    if (ruta === REPOSITORIO) continue;
    if (ruta.endsWith('.test.mts')) continue;
    const texto = readFileSync(ruta, 'utf8');
    const hablaConSupabase = /from\('course_(lessons|modules)'\)/.test(texto);
    if (!hablaConSupabase) continue;
    if (columnas.some((columna) => texto.includes(columna))) culpables.push(relativa(ruta));
  }

  assert.deepEqual(
    culpables,
    [],
    'Estos ficheros le nombran a Supabase columnas de la migración 0034 fuera de ' +
      '`repositories/CourseContentRepository.ts`, que es donde se comprueba si ' +
      'existen. Sin esa comprobación, contra la base de HOY PostgREST rechaza la ' +
      'fila entera y se pierde la lección.',
  );
});

test('el repositorio recuerda la respuesta, pero no recuerda un fallo de red', () => {
  const texto = readFileSync(REPOSITORIO, 'utf8');
  assert.match(
    texto,
    /esColumnaQueNoExiste/,
    'la respuesta solo se cachea cuando es concluyente',
  );
  assert.match(
    texto,
    /42703/,
    'se distingue «la columna no existe» de «no se pudo preguntar» por el código ' +
      'de PostgreSQL: cachear un fallo de red dejaría la app creyendo para siempre ' +
      'que la migración no está.',
  );
  assert.match(texto, /export function olvidarSoporteV2/, 'las pruebas pueden olvidarlo');
});
