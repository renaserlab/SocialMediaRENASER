import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * EL TEMARIO SE ESCRIBE POR LA API. Y NO PUEDE VOLVER ATRÁS.
 *
 * `course_modules` y `course_lessons` se escribían contra PostgREST con la
 * clave anónima. La RLS de la 0012 decidía quién podía, así que nunca fue un
 * agujero de permisos: era un agujero de RASTRO. Un autor reescribía el temario
 * de un curso YA VENDIDO —quitaba lecciones, cambiaba de qué iba— y no quedaba
 * ni una línea diciendo que había pasado, ni sobre qué versión se editó. Eso es
 * lo mismo que dejó escrito `test_una_orden_historica_se_queda_sin_version` en
 * el backend: «no hay forma de saber qué contenido se vendió».
 *
 * Volver a abrir ese camino no se ve en una revisión: es UNA línea, funciona
 * igual de bien en pantalla y no rompe ninguna otra prueba. Por eso hace falta
 * un cerrojo que mire el código.
 *
 * Se mira el CÓDIGO y no el comportamiento por lo mismo que en
 * `components/curso/contenidoV2.test.mts`: montar la pantalla pediría un
 * renderizador de React Native que este proyecto no tiene en las pruebas, y lo
 * que hay que impedir no es un valor mal calculado, es que alguien rehaga algo
 * que ya salió caro.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');
const REPOSITORIO = join(SRC, 'repositories', 'CourseContentRepository.ts');
const EDITORES = [
  join(SRC, 'components', 'CourseContentEditor.tsx'),
  join(SRC, 'components', 'curso', 'EditorDeContenido.tsx'),
];

function ficherosDeCodigo(dir: string, encontrados: string[] = []): string[] {
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const ruta = join(dir, entrada.name);
    if (entrada.isDirectory()) ficherosDeCodigo(ruta, encontrados);
    // Las pruebas quedan fuera: esta misma escribe los nombres que persigue, y
    // una prueba que se acusa a sí misma no sirve de cerrojo.
    else if (/\.tsx?$/.test(entrada.name) && !entrada.name.endsWith('.d.ts')) {
      encontrados.push(ruta);
    }
  }
  return encontrados;
}

function relativa(ruta: string): string {
  return ruta.slice(SRC.length + 1).replace(/\\/g, '/');
}

/** Una llamada a PostgREST sobre las tablas del temario. */
const HABLA_CON_LA_TABLA = /\.from\(\s*['"`](course_modules|course_lessons)['"`]\s*\)/g;
/** Lo que convierte esa llamada en una ESCRITURA. Leer sigue permitido. */
const ESCRIBE = /\.(insert|update|upsert|delete)\s*\(/;

/**
 * Las escrituras directas de un fichero, como «tabla.verbo()».
 *
 * Se mira SOLO hasta el `;` que cierra la sentencia: una consulta y la de
 * después son cosas distintas, y sin ese corte un `listContent` que lee y un
 * `addResource` que escribe más abajo saldrían como una sola infracción.
 */
function escriturasDirectas(texto: string): string[] {
  const hallazgos: string[] = [];
  for (const encontrado of texto.matchAll(HABLA_CON_LA_TABLA)) {
    const inicio = (encontrado.index ?? 0) + encontrado[0].length;
    const punto = texto.indexOf(';', inicio);
    const cadena = texto.slice(inicio, punto >= 0 ? punto : texto.length);
    const verbo = ESCRIBE.exec(cadena);
    if (verbo) hallazgos.push(`${encontrado[1]}.${verbo[1]}()`);
  }
  return hallazgos;
}

describe('el temario no se escribe a mano contra la base', () => {
  it('ningún fichero de la app inserta, actualiza ni borra módulos o lecciones', () => {
    const culpables: string[] = [];
    for (const ruta of ficherosDeCodigo(SRC)) {
      for (const escritura of escriturasDirectas(readFileSync(ruta, 'utf8'))) {
        culpables.push(`${relativa(ruta)}: ${escritura}`);
      }
    }

    assert.deepEqual(
      culpables,
      [],
      'Aquí hay escrituras del temario que se saltan la API, y con ella la ' +
        'auditoría y el control de versión: un curso ya vendido se puede ' +
        'reescribir sin dejar rastro. Van por los endpoints de ' +
        '`/catalog/courses/{id}/modules...`, como el resto.',
    );
  });

  it('leer el temario por la base SIGUE valiendo: es lo que no tiene endpoint', () => {
    /*
      El cerrojo de arriba tiene que distinguir leer de escribir. Si prohibiera
      cualquier `.from('course_lessons')`, la única salida sería borrar
      `listContent`, que compone el temario con sus URLs firmadas en dos
      consultas y no tiene endpoint que lo sustituya.
    */
    const repositorio = readFileSync(REPOSITORIO, 'utf8');
    assert.match(
      repositorio,
      HABLA_CON_LA_TABLA,
      'el repositorio sigue LEYENDO el temario contra Supabase',
    );
    assert.deepEqual(escriturasDirectas(repositorio), []);
  });
});

describe('las ocho escrituras del temario', () => {
  it('salen por la API y por ningún otro sitio', () => {
    const repositorio = readFileSync(REPOSITORIO, 'utf8');
    // Los nombres de las variables dan igual; lo que se comprueba es la FORMA
    // de la ruta, que es el contrato con el backend.
    const rutas = new Set(
      [...repositorio.matchAll(/`(\$\{CURSOS\}[^`]*)`/g)].map((m) =>
        m[1]!.replace(/\$\{[^}]+\}/g, '{}'),
      ),
    );

    assert.deepEqual(
      [...rutas].sort(),
      [
        '{}/{}/modules',
        '{}/{}/modules/reorder',
        '{}/{}/modules/{}',
        '{}/{}/modules/{}/lessons',
        '{}/{}/modules/{}/lessons/reorder',
        '{}/{}/modules/{}/lessons/{}',
      ].sort(),
      'Estas seis rutas cubren las ocho operaciones (editar y borrar comparten ' +
        'la del módulo, y también la de la lección). Si falta una, esa ' +
        'operación se quedó fuera de la API.',
    );
  });

  it('traducen el 409 de versión a un error propio, no a uno crudo', () => {
    const repositorio = readFileSync(REPOSITORIO, 'utf8');
    assert.match(
      repositorio,
      /course_version_mismatch/,
      'el conflicto de versión se reconoce por su `code`',
    );
    assert.match(
      repositorio,
      /export class ContenidoDelCursoCambiado/,
      'Quien lo recibe tiene que poder distinguirlo SIN comparar el texto del ' +
        'mensaje: ante esto no se reintenta, se recarga el temario.',
    );
  });
});

describe('un doble toque no crea dos módulos', () => {
  it('las dos creaciones EXIGEN una clave de idempotencia', () => {
    const repositorio = readFileSync(REPOSITORIO, 'utf8');
    assert.match(
      repositorio,
      /'Idempotency-Key': opciones\.claveDeIdempotencia/,
      'la clave viaja en la cabecera que el backend lee',
    );
    // `claveDeIdempotencia: string` y no `?: string`: opcional, la creación que
    // se olvide de mandarla compila igual y el doble toque vuelve.
    const obligatorias = repositorio.match(/claveDeIdempotencia: string;/g) ?? [];
    assert.equal(
      obligatorias.length,
      2,
      'las dos altas —módulo y lección— tienen que pedirla, y sin `?`',
    );
  });

  it('la clave se reusa en el reintento en vez de nacer otra vez', () => {
    /*
      ES LA MITAD QUE DE VERDAD PROTEGE. Una clave nueva en cada intento es un
      identificador distinto por petición: el servidor derivaría otro id y
      crearía el segundo módulo, que es exactamente lo que había que impedir.
      Por eso se reserva con `??=` sobre una referencia que sobrevive al
      reintento, y antes de esperar a nadie.
    */
    for (const ruta of EDITORES) {
      const texto = readFileSync(ruta, 'utf8');
      const generadas = texto.match(/nuevaClaveDeCreacion\(\)/g) ?? [];
      const reusadas = texto.match(/\.current \?\?= nuevaClaveDeCreacion\(\)/g) ?? [];
      assert.ok(generadas.length > 0, `${relativa(ruta)} tiene que generar la clave`);
      assert.equal(
        reusadas.length,
        generadas.length,
        `En ${relativa(ruta)} hay una clave que se genera sin reusar la del ` +
          'intento anterior. Con eso, el segundo toque crea el segundo módulo.',
      );
    }
  });
});
