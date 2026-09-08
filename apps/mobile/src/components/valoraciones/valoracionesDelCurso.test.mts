/**
 * La seccion de valoraciones de un curso, comprobada sobre el CODIGO.
 *
 * POR QUE SOBRE EL CODIGO Y NO SOBRE LA PANTALLA: montar la vista pediria un
 * renderizador de React Native que este proyecto no tiene en las pruebas (ver
 * `components/cuadriculaSinReproductores.test.mts`). Todo lo que SI se puede
 * ejecutar —la media que no es cero, los fallos traducidos, la paginacion— vive
 * en `lib/valoracionesDeCurso.ts` y se prueba alli, ejecutandolo de verdad.
 *
 * Aqui quedan las garantias que solo existen en el arbol de componentes, y cada
 * una se comprueba por su PROPIEDAD (que exista el rol, que un cerrojo se eche
 * antes del primer `await`), no copiando una linea literal que dejaria de valer
 * al mover una coma.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { es } from '../../i18n/es.ts';
import { en } from '../../i18n/en.ts';
import { pt } from '../../i18n/pt.ts';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

// Los comentarios NOMBRAN lo que el codigo evita («0.0», «mockData»), asi que
// hay que quitarlos antes de buscar rastros en el codigo de verdad.
const BLOQUE = new RegExp('/\\*[\\s\\S]*?\\*/', 'g');
const LINEA = new RegExp('//[^\\n]*', 'g');
const sinComentarios = (c: string) => c.replace(BLOQUE, ' ').replace(LINEA, ' ');

const RUTAS = {
  selector: 'components/valoraciones/SelectorDeEstrellas.tsx',
  puntuacion: 'components/valoraciones/PuntuacionEnEstrellas.tsx',
  resumen: 'components/valoraciones/ResumenDeLasValoraciones.tsx',
  hoja: 'components/valoraciones/HojaDeValoracion.tsx',
  seccion: 'components/valoraciones/ValoracionesDelCurso.tsx',
  repositorio: 'repositories/CourseReviewRepository.ts',
  logica: 'lib/valoracionesDeCurso.ts',
  pantalla: 'screens/CourseScreen.tsx',
} as const;

const SELECTOR = sinComentarios(fuente(RUTAS.selector));
const PUNTUACION = sinComentarios(fuente(RUTAS.puntuacion));
const RESUMEN = sinComentarios(fuente(RUTAS.resumen));
const HOJA = sinComentarios(fuente(RUTAS.hoja));
const SECCION = sinComentarios(fuente(RUTAS.seccion));
const REPOSITORIO = sinComentarios(fuente(RUTAS.repositorio));
const PANTALLA = fuente(RUTAS.pantalla);

/** El cuerpo de una funcion declarada como `const nombre = ... => {`. */
function cuerpoDe(codigo: string, nombre: string): string {
  const inicio = codigo.indexOf(`const ${nombre} =`);
  assert.notEqual(inicio, -1, `no se encontro la funcion ${nombre}`);
  const abre = codigo.indexOf('{', inicio);
  let nivel = 0;
  for (let i = abre; i < codigo.length; i += 1) {
    if (codigo[i] === '{') nivel += 1;
    else if (codigo[i] === '}') {
      nivel -= 1;
      if (nivel === 0) return codigo.slice(abre, i + 1);
    }
  }
  return codigo.slice(abre);
}

/**
 * Que el cerrojo se eche ANTES del primer `await`.
 *
 * Es la unica forma de que dos toques rapidos no manden dos peticiones: el
 * estado (`guardando`) no esta puesto hasta el siguiente render, y entre el
 * primer toque y ese render caben mas toques.
 */
function cerrojoAntesDelPrimerAwait(cuerpo: string, referencia: string): void {
  // Se busca la LECTURA de la referencia, no una condicion literal: la guarda
  // puede ir acompañada («if (!mia || retirandoRef.current) return;»).
  const guarda = cuerpo.indexOf(`${referencia}.current)`);
  const echa = cuerpo.indexOf(`${referencia}.current = true`);
  const primerAwait = cuerpo.indexOf('await ');
  assert.notEqual(guarda, -1, `falta la guarda de ${referencia}`);
  assert.notEqual(echa, -1, `${referencia} no se echa nunca`);
  assert.notEqual(primerAwait, -1, 'la funcion no espera a nada: no hace falta cerrojo');
  assert.ok(guarda < echa, `${referencia}: se echa antes de comprobarse`);
  assert.ok(
    echa < primerAwait,
    `${referencia} se echa DESPUES del primer await: el segundo toque se cuela`,
  );
  assert.match(
    cuerpo,
    new RegExp(`${referencia}\\.current = false`),
    `${referencia} no se suelta nunca`,
  );
}

describe('el selector de puntuacion se puede usar con lector de pantalla', () => {
  it('es un grupo de opciones excluyentes, no cinco botones sueltos', () => {
    assert.match(SELECTOR, /accessibilityRole="radiogroup"/);
    assert.match(SELECTOR, /accessibilityRole="radio"/);
  });

  it('cada estrella se llama «N de 5», y ese texto sale de la logica comun', () => {
    /*
      Sin nombre, un lector anuncia cinco veces «botón» y no dice cual esta
      elegido: la unica pista seria el relleno del dibujo.
    */
    assert.match(SELECTOR, /accessibilityLabel=\{etiquetaDePuntuacion\(/);
    assert.match(SELECTOR, /accessibilityState=\{\{[^}]*checked:/);
  });

  it('el grupo tambien se presenta', () => {
    assert.match(SELECTOR, /accessibilityRole="radiogroup"[\s\S]{0,160}accessibilityLabel=/);
  });

  it('cada estrella se puede pulsar: 44 puntos y ademas holgura', () => {
    assert.match(SELECTOR, /minWidth: 44/);
    assert.match(SELECTOR, /minHeight: 44/);
    assert.match(SELECTOR, /hitSlop=/);
  });
});

describe('una puntuacion no se cuenta solo con estrellas', () => {
  it('se anuncia como «N de 5»', () => {
    assert.match(PUNTUACION, /const etiqueta = etiquetaDePuntuacion\(/);
    assert.match(PUNTUACION, /accessibilityLabel=\{etiqueta\}/);
  });

  it('el dibujo queda fuera de la lectura, para que no suene dos veces', () => {
    assert.match(PUNTUACION, /accessibilityElementsHidden/);
    assert.match(PUNTUACION, /importantForAccessibility="no-hide-descendants"/);
  });

  it('el numero tambien se ESCRIBE: ni el color ni la forma lo llevan solos', () => {
    assert.match(PUNTUACION, /conTexto \?[\s\S]{0,200}\{etiqueta\}/);
  });

  it('relleno y contorno son dos iconos distintos, no el mismo con otro color', () => {
    assert.match(PUNTUACION, /'star' : 'star-outline'/);
  });
});

describe('el resumen nunca convierte «sin valoraciones» en un cero', () => {
  it('la media se pide a la logica comun, no se formatea aqui', () => {
    assert.match(RESUMEN, /textoDeMedia\(/);
    assert.match(RESUMEN, /hayMedia\(/);
  });

  it('no hay ningun cero escrito a mano haciendo de puntuacion', () => {
    for (const rastro of ['0.0', '0,0', 'toFixed', '?? 0']) {
      assert.ok(!RESUMEN.includes(rastro), `«${rastro}» no puede estar en el resumen`);
    }
  });

  it('sin media no se pintan ni las estrellas ni las cinco barras vacias', () => {
    // Cinco barras a cero parecen un fallo de carga y no dicen nada que la
    // frase «Sin valoraciones» no diga ya.
    assert.match(
      RESUMEN,
      /conMedia \? \([\s\S]{0,400}<PuntuacionEnEstrellas/,
      'las estrellas se pintan sin media',
    );
    assert.match(
      RESUMEN,
      /conMedia \? \([\s\S]{0,400}PUNTUACIONES\.map/,
      'la distribucion se pinta sin media',
    );
  });

  it('se anuncia con su media y su total, en una sola frase', () => {
    assert.match(RESUMEN, /accessible accessibilityLabel=\{anuncioDelResumen\(/);
  });

  it('cada barra dice ademas su nota y cuantas la eligieron', () => {
    assert.match(RESUMEN, /accessibilityLabel=\{etiquetaDeDistribucion\(/);
  });
});

describe('enviar dos veces no crea dos valoraciones', () => {
  it('el cerrojo se echa antes del primer await', () => {
    cerrojoAntesDelPrimerAwait(cuerpoDe(HOJA, 'enviar'), 'enviandoRef');
  });

  it('es una referencia, no estado: el estado llega un render tarde', () => {
    assert.match(HOJA, /const enviandoRef = useRef\(false\)/);
  });

  it('el boton tambien se apaga: es la mitad visible de la misma proteccion', () => {
    assert.match(HOJA, /disabled=\{guardando \|\|/);
  });

  it('con valoracion propia se EDITA (PATCH) y sin ella se CREA (POST)', () => {
    const cuerpo = cuerpoDe(HOJA, 'enviar');
    assert.match(
      cuerpo,
      /existente\s*\?[\s\S]{0,200}CourseReviewRepository\.editar[\s\S]{0,200}CourseReviewRepository\.crear/,
    );
    assert.match(REPOSITORIO, /method: 'PATCH'/);
    assert.match(REPOSITORIO, /method: 'POST'/);
  });

  it('el formulario se abre con lo que ya habia, no en blanco', () => {
    assert.match(HOJA, /setPuntuacion\(existente\?\.puntuacion \?\? 0\)/);
    assert.match(HOJA, /setComentario\(existente\?\.comentario \?\? ''\)/);
  });

  it('el fallo se lee DENTRO de la hoja: un dialogo sobre un Modal no se ve en iOS', () => {
    assert.match(HOJA, /<InlineError message=\{error\}/);
    assert.ok(!HOJA.includes('confirm('), 'la confirmacion no puede vivir dentro de la hoja');
  });
});

describe('los estados de la seccion', () => {
  it('con la migracion 0056 sin aplicar no se pinta NADA, ni un error', () => {
    assert.match(SECCION, /if \(seccionNoMontada\(fallo\)\) return null;/);
  });

  it('cargando, error con reintento y vacio son tres cosas distintas', () => {
    assert.match(SECCION, /state="loading"/);
    assert.match(SECCION, /state="error"[\s\S]{0,200}onRetry=\{\(\) => void cargar\(\)\}/);
    assert.match(SECCION, /t\('valoracion\.vacio'\)/);
  });

  it('el fallo se guarda crudo: es lo unico que distingue «no se pudo» de «no existe»', () => {
    assert.match(SECCION, /useState<unknown>\(null\)/);
    assert.match(SECCION, /mensajeDeErrorDeValoracion\(fallo, t\)/);
  });

  it('las dos peticiones se recogen con allSettled, no con all', () => {
    // Con la 0056 sin aplicar fallan las dos, y `all` deja el segundo rechazo
    // sin recoger: aviso de promesa no manejada en cada apertura del curso.
    assert.match(SECCION, /Promise\.allSettled\(/);
    assert.ok(!SECCION.includes('Promise.all('), 'un rechazo se quedaria suelto');
  });

  it('perder la pagina siguiente no borra lo que ya se leyo', () => {
    const cuerpo = cuerpoDe(SECCION, 'verMas');
    assert.match(cuerpo, /fusionarPaginas\(previas, siguiente\)/);
    assert.ok(!cuerpo.includes('setLista([])'), 'un fallo al seguir no vacia la lista');
  });

  it('pedir mas y retirar tambien llevan cerrojo sincrono', () => {
    cerrojoAntesDelPrimerAwait(cuerpoDe(SECCION, 'verMas'), 'siguiendoRef');
    cerrojoAntesDelPrimerAwait(cuerpoDe(SECCION, 'retirar'), 'retirandoRef');
  });

  it('retirar se confirma antes, y la pregunta se hace con la hoja cerrada', () => {
    const cuerpo = cuerpoDe(SECCION, 'retirar');
    const pregunta = cuerpo.indexOf('confirm({');
    const borra = cuerpo.indexOf('CourseReviewRepository.retirar(');
    assert.ok(pregunta !== -1 && pregunta < borra, 'se borra sin preguntar');
    assert.match(cuerpo, /if \(!aceptado\) return;/);
  });

  it('tras guardar se vuelve a preguntar al servidor: la media no se recompone aqui', () => {
    assert.match(SECCION, /setHojaAbierta\(false\);[\s\S]{0,200}void cargar\(\)/);
  });

  it('el sello de compra solo se pinta cuando lo da el servidor', () => {
    assert.match(SECCION, /valoracion\.compraVerificada \?/);
    assert.match(REPOSITORIO, /verified_purchase === true/);
  });

  it('para abrir un perfil se pasa por irAlPerfil', () => {
    assert.match(SECCION, /irAlPerfil\(router, valoracion\.autorId\)/);
  });
});

describe('nada de datos inventados', () => {
  it('ningun fichero de la seccion trae datos de mentira', () => {
    for (const [nombre, codigo] of Object.entries({ SELECTOR, PUNTUACION, RESUMEN, HOJA, SECCION, REPOSITORIO })) {
      for (const rastro of ['mockData', 'sampleReviews', 'DEMO_']) {
        assert.ok(!codigo.includes(rastro), `${nombre} usa ${rastro}`);
      }
    }
  });

  it('la media que llega null NUNCA se sustituye por un numero', () => {
    const LOGICA = sinComentarios(fuente(RUTAS.logica));
    for (const rastro of ['average ?? 0', 'media ?? 0', 'average || 0', 'media || 0']) {
      assert.ok(!LOGICA.includes(rastro), `«${rastro}» convierte «sin valorar» en «mal valorado»`);
      assert.ok(!REPOSITORIO.includes(rastro), `«${rastro}» en el repositorio`);
    }
  });

  it('un campo ausente no se lee como compra verificada ni como valoracion propia', () => {
    assert.match(REPOSITORIO, /verified_purchase === true/);
    assert.match(REPOSITORIO, /is_mine === true/);
    for (const perezoso of ['verified_purchase ?? false', 'is_mine ?? false']) {
      assert.ok(!REPOSITORIO.includes(perezoso));
    }
  });

  it('sin nombre y sin usuario no se firma la valoracion con nada', () => {
    assert.match(SECCION, /autorNombre\.trim\(\) \|\|/);
    assert.match(SECCION, /nombre \?/);
  });
});

describe('el detalle del curso monta la seccion', () => {
  it('la pinta con el curso que se esta viendo', () => {
    assert.match(PANTALLA, /<ValoracionesDelCurso cursoId=\{course\.id\}/);
  });

  it('no ofrece valorar a quien no ha entrado al curso ni a quien lo publico', () => {
    assert.match(PANTALLA, /puedeValorar=\{hasAccess && !canManage\}/);
  });
});

describe('los tres idiomas dicen todo lo que la seccion pregunta', () => {
  it('ninguna clave usada aqui falta en es, en o pt', () => {
    const diccionarios: Array<[string, Record<string, string>]> = [
      ['es', es as unknown as Record<string, string>],
      ['en', en as Record<string, string>],
      ['pt', pt as Record<string, string>],
    ];
    const usadas = new Set<string>();
    for (const rel of Object.values(RUTAS)) {
      if (rel === RUTAS.pantalla) continue;
      for (const encontrada of fuente(rel).matchAll(/\bt\('([^']+)'/g)) {
        usadas.add(encontrada[1] as string);
      }
    }
    assert.ok(usadas.size > 0, 'no se encontro ninguna clave: la busqueda esta rota');

    const faltan: string[] = [];
    for (const clave of usadas) {
      for (const [idioma, diccionario] of diccionarios) {
        if (!(clave in diccionario)) faltan.push(`${clave} (${idioma})`);
      }
    }
    assert.deepEqual(faltan, [], `sin traducir: ${faltan.join(', ')}`);
  });
});
