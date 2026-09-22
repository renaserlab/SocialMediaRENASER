/**
 * Admitir y evaluar un producto, ejecutado.
 *
 * Lo que se prueba aquí es lo que se rompe sin que se note mirando la aplicación:
 *
 *  1. UNA PUNTUACIÓN CON CINCO DIMENSIONES CONTADA COMO PUNTUACIÓN. Es el fallo más
 *     caro de todos: una ausencia leída como cero hunde un producto bueno y leída como
 *     el máximo aprueba uno que nadie miró. Se comprueba que `puntuacionPonderada`
 *     devuelve `null` —y que `null` no es un número— en todas las formas posibles de que
 *     falte una dimensión.
 *  2. UNA PUNTUACIÓN SIN EVIDENCIA. La columna «evidencia mínima» de la matriz no es una
 *     sugerencia: se comprueba que una sola dimensión sin evidencia bloquea la decisión.
 *  3. LA MATRIZ COPIADA MAL. Los pesos y los umbrales están transcritos del servidor, así
 *     que se leen los ficheros del servidor y se comparan letra por letra y número por
 *     número. Si alguien cambia uno de los dos lados, esto lo dice.
 *  4. UNA FALLA CRÍTICA COMPENSADA CON PUNTAJE. Rechaza directo, y se comprueba que
 *     ninguna combinación produce «aprobado» junto a una falla.
 *  5. UN BOTÓN DE PUBLICAR SOBRE UN PRODUCTO QUE EL SERVIDOR VA A RECHAZAR. Se comprueba
 *     que `sePuedePublicar` lee el `bloqueo` y no lo recalcula, y que
 *     `conditionally_approved` tiene su propio texto en vez de un botón ausente.
 *
 * Las que no son funciones —el cerrojo, la confirmación, los textos traducidos, que no
 * haya puntuaciones escritas a mano— se comprueban sobre el CÓDIGO de las pantallas,
 * porque ahí es donde están escritas.
 *
 * NO SE MIRAN LOS DICCIONARIOS. La paridad de `es`/`en`/`pt` la comprueba
 * `i18n/diccionariosSincronizados.test.mts`, que es su sitio.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  APROBADO_DESDE,
  BLOQUEOS_DE_EVALUACION,
  BLOQUEOS_DE_PUBLICACION,
  CODIGOS_TRADUCIDOS,
  CONDICIONADO_DESDE,
  DECISIONES,
  DIMENSIONES,
  DIMENSIONES_EXIGIDAS,
  DIMENSIONES_ORDENADAS,
  DOCUMENTOS,
  ESTADOS_DE_POSTULACION,
  ESTADOS_DE_PRODUCTO,
  ESTADOS_QUE_SE_FILTRAN,
  FALLAS_CRITICAS,
  LARGO_DEL_RESUMEN_DE_EVIDENCIA,
  LARGO_DE_LA_RAZON,
  LARGO_DE_LA_REFERENCIA,
  LARGO_MAXIMO_DEL_MOTIVO,
  LARGO_MAXIMO_DE_LAS_NOTAS,
  LIMITES_DE_LA_LISTA,
  LIMITE_INICIAL,
  LIMITE_MAXIMO,
  PESO_TOTAL,
  POSTULACIONES_QUE_SE_FILTRAN,
  PUNTUACION_MAXIMA,
  PUNTUACION_MAXIMA_DE_DIMENSION,
  PUNTUACION_MINIMA_DE_DIMENSION,
  RAZONES_EXIGIDAS,
  TIPOS_DE_EVIDENCIA,
  abreviarIdentificador,
  cadenaDeFiltros,
  claveDeErrorDeProductos,
  claveDeLaDecision,
  claveDeLaDimension,
  claveDeLaFallaCritica,
  claveDelBloqueoDeEvaluacion,
  claveDelBloqueoDePublicacion,
  claveDelCuerpoDelFallo,
  claveDelDocumento,
  claveDelEstadoDePostulacion,
  claveDelEstadoDeProducto,
  claveDelFallo,
  claveDelTipoDeEvidencia,
  combinacionImposible,
  decisionExigeMotivo,
  decisionPorPuntuacion,
  dimensionValida,
  dimensionesDeLaMatriz,
  enCatalogo,
  esAprobadoConCondiciones,
  esAutoevaluacion,
  esConflicto,
  esDecisionCondicionada,
  esNoDisponible,
  evaluacionAbierta,
  evidenciaDeLaDimension,
  evidenciaPorDimension,
  fallaCriticaValida,
  fallaQueViaja,
  falloDeCarga,
  limiteValido,
  llegoAlTope,
  ofrecePublicar,
  ofreceSuspender,
  pesoDeLaDimension,
  previsualizarDecision,
  puntuacionDeDimensionValida,
  puntuacionLegible,
  puntuacionPonderada,
  queFalta,
  razonesCompletas,
  revisarDecisionDePostulacion,
  revisarMotivo,
  revisarPuntuacion,
  revisarRazon,
  revisarRazones,
  revisarResumenDeEvidencia,
  rutaValida,
  sePuedeDecidir,
  sePuedeDecidirPostulacion,
  sePuedePublicar,
  sePuedeTomar,
  seReintenta,
  siguienteLimite,
  soloDigitos,
  textoUtil,
  tipoDeEvidenciaValido,
  tonoDelEstado,
  transicionExigeMotivo,
  transicionesQueSeOfrecen,
  type EvidenciaRead,
  type PuntuacionRead,
} from './evaluacionDeProductos.ts';

const AQUI = fileURLToPath(new URL('.', import.meta.url));

/** Un fichero de `apps/mobile/src`. */
function fuente(...partes: string[]): string {
  return readFileSync(join(AQUI, '..', ...partes), 'utf8');
}

/** Un fichero del SERVIDOR. Se lee para comparar la matriz con su origen. */
function delServidor(fichero: string): string {
  return readFileSync(
    join(AQUI, '..', '..', '..', 'api', 'app', 'modules', 'products', fichero),
    'utf8',
  );
}

/** El código sin comentarios: lo que el fichero HACE, no lo que explica. */
function sinComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((linea) => !linea.trim().startsWith('//'))
    .join('\n');
}

const MODULO = fuente('lib', 'evaluacionDeProductos.ts');
const REPOSITORIO = fuente('repositories', 'ProductAdmissionRepository.ts');
const ADMISION = fuente('screens', 'AdmisionDeProductosScreen.tsx');
const EVALUAR = fuente('screens', 'EvaluarProductoScreen.tsx');
const PANEL = fuente('screens', 'AdminProductosScreen.tsx');
const PANTALLAS: Array<[string, string]> = [
  ['AdmisionDeProductosScreen.tsx', ADMISION],
  ['EvaluarProductoScreen.tsx', EVALUAR],
  ['AdminProductosScreen.tsx', PANEL],
];

/** Seis dimensiones puntuadas con la misma nota, con el peso de la matriz. */
function todas(score: number): PuntuacionRead[] {
  return DIMENSIONES_ORDENADAS.map((dimension) => ({
    dimension,
    score,
    weight: DIMENSIONES[dimension],
    note: null,
  }));
}

/** Una evidencia por dimensión: lo mínimo que el servidor exige. */
function evidenciaCompleta(): EvidenciaRead[] {
  return DIMENSIONES_ORDENADAS.map((dimension, i) => ({
    id: `ev-${i}`,
    dimension,
    kind: TIPOS_DE_EVIDENCIA[0],
    summary: 'se comprobó lo que había que comprobar',
    storage_path: null,
  }));
}

/** Entradas de todo tipo, para recorrer el módulo entero sin que lance. */
const BASURA: unknown[] = [
  null,
  undefined,
  '',
  '   ',
  'draft',
  'approved',
  'quality',
  'lo_que_sea',
  0,
  -1,
  9_000,
  8_500,
  100,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  true,
  {},
  [],
];

/* ========================================================================== */
/* 1. La puntuación con una dimensión de menos no es una puntuación            */
/* ========================================================================== */

describe('cinco dimensiones no son una puntuación: es `null`, nunca cero', () => {
  it('con las seis puntuadas sale la ponderada del servidor', () => {
    // 100 en todas: 100 × 100 de peso = 10 000 centésimas = 100,00.
    assert.equal(puntuacionPonderada(todas(100)), 10_000);
    assert.equal(puntuacionPonderada(todas(90)), 9_000);
    assert.equal(puntuacionPonderada(todas(0)), 0);
  });

  it('QUITANDO UNA CUALQUIERA de las seis, la puntuación es `null`', () => {
    for (const fuera of DIMENSIONES_ORDENADAS) {
      const cinco = todas(90).filter((s) => s.dimension !== fuera);
      assert.equal(cinco.length, DIMENSIONES_EXIGIDAS - 1);
      const total = puntuacionPonderada(cinco);
      assert.equal(total, null, `faltando ${fuera} salió ${String(total)}`);
      // Y NO ES UN NÚMERO: ni cero, ni la media de lo que hay.
      assert.equal(typeof total, 'object');
      assert.notEqual(total, 0);
      assert.equal(Number.isFinite(total as unknown as number), false);
    }
  });

  it('`null` no se puede confundir con cero en ninguna lectura', () => {
    const cinco = todas(90).slice(0, 5);
    assert.equal(puntuacionPonderada(cinco), null);
    // Lo que se ENSEÑA también es `null`: no se escribe «0,00».
    assert.equal(puntuacionLegible(puntuacionPonderada(cinco)), null);
    // Y cero sí se escribe cuando es un cero de verdad.
    assert.equal(puntuacionLegible(0), '0,00');
  });

  it('una lista vacía no es un cero: es `null`', () => {
    assert.equal(puntuacionPonderada([]), null);
    assert.equal(puntuacionPonderada(null), null);
    assert.equal(puntuacionPonderada(undefined), null);
  });

  it('la misma dimensión repetida no cuenta como dos', () => {
    const repetidas: PuntuacionRead[] = [
      ...todas(90).slice(0, 5),
      { dimension: DIMENSIONES_ORDENADAS[0], score: 100, weight: 25, note: null },
    ];
    assert.equal(repetidas.length, DIMENSIONES_EXIGIDAS);
    assert.equal(puntuacionPonderada(repetidas), null);
  });

  it('una dimensión inventada no rellena el hueco de una real', () => {
    const cinco = todas(90).slice(0, 5);
    const conIntrusa: PuntuacionRead[] = [
      ...cinco,
      { dimension: 'lo_que_sea', score: 100, weight: 10, note: null },
    ];
    assert.equal(puntuacionPonderada(conIntrusa), null);
  });

  it('una puntuación imposible en una fila invalida el total, no se redondea', () => {
    for (const mala of [-1, 101, 90.5, Number.NaN]) {
      const filas = todas(90);
      filas[2] = { ...filas[2], score: mala };
      assert.equal(puntuacionPonderada(filas), null, String(mala));
    }
  });

  it('EL PESO SALE DE LA FILA, no de la matriz de hoy', () => {
    // Así una decisión pasada se sigue explicando con sus propios números.
    const conPesoViejo = todas(100).map((s) => ({ ...s, weight: 10 }));
    assert.equal(puntuacionPonderada(conPesoViejo), 100 * 10 * 6);
  });

  it('si la fila no trae peso utilizable se usa el de la matriz, no cero', () => {
    const sinPeso = todas(100).map((s) => ({
      ...s,
      weight: Number.NaN as unknown as number,
    }));
    assert.equal(puntuacionPonderada(sinPeso), PUNTUACION_MAXIMA);
  });

  it('la ponderación es exactamente la del servidor, peso a peso', () => {
    const filas = todas(0);
    // 100 solo en «calidad», que pesa 25: 100 × 25 = 2 500 centésimas.
    filas[0] = { ...filas[0], score: 100 };
    assert.equal(puntuacionPonderada(filas), 100 * DIMENSIONES[DIMENSIONES_ORDENADAS[0]]);
  });
});

/* ========================================================================== */
/* 2. Sin evidencia no se decide                                               */
/* ========================================================================== */

describe('una dimensión sin evidencia bloquea la decisión', () => {
  it('con las seis puntuadas y evidencia en todas, se puede decidir', () => {
    assert.equal(
      sePuedeDecidir({ scores: todas(90), evidence: evidenciaCompleta() }),
      true,
    );
  });

  it('QUITANDO LA EVIDENCIA DE UNA CUALQUIERA, ya no se puede', () => {
    for (const fuera of DIMENSIONES_ORDENADAS) {
      const evidencia = evidenciaCompleta().filter((e) => e.dimension !== fuera);
      const evaluacion = { scores: todas(100), evidence: evidencia };
      assert.equal(sePuedeDecidir(evaluacion), false, `sin evidencia de ${fuera}`);
      assert.deepEqual(queFalta(evaluacion).sinEvidencia, [fuera]);
      // Y NI CON EL MÁXIMO EN TODO: el puntaje no compensa una ausencia.
      const vista = previsualizarDecision(evaluacion);
      assert.equal(vista.estado, 'faltan');
    }
  });

  it('sin ninguna evidencia faltan las seis, dichas por su nombre', () => {
    const falta = queFalta({ scores: todas(90), evidence: [] });
    assert.deepEqual(falta.sinPuntuar, []);
    assert.deepEqual(falta.sinEvidencia, [...DIMENSIONES_ORDENADAS].sort());
    assert.equal(falta.sinEvidencia.length, DIMENSIONES_EXIGIDAS);
  });

  it('se dicen las DOS cosas a la vez, no de una en una', () => {
    // El servidor contesta primero las dimensiones y luego la evidencia; quien
    // evalúa necesita saber todo lo que le queda.
    const falta = queFalta({ scores: todas(90).slice(0, 4), evidence: [] });
    assert.equal(falta.sinPuntuar.length, 2);
    assert.equal(falta.sinEvidencia.length, DIMENSIONES_EXIGIDAS);
  });

  it('varias evidencias de la misma dimensión no cubren a las demás', () => {
    const muchas: EvidenciaRead[] = [0, 1, 2, 3].map((i) => ({
      id: `e${i}`,
      dimension: DIMENSIONES_ORDENADAS[0],
      kind: TIPOS_DE_EVIDENCIA[1],
      summary: 'la misma dimensión otra vez',
      storage_path: null,
    }));
    assert.equal(sePuedeDecidir({ scores: todas(95), evidence: muchas }), false);
    assert.equal(evidenciaPorDimension(muchas)[DIMENSIONES_ORDENADAS[0]], 4);
  });

  it('la evidencia se reparte por dimensión sin mezclarse', () => {
    const evidencia = evidenciaCompleta();
    for (const dimension of DIMENSIONES_ORDENADAS) {
      const suyas = evidenciaDeLaDimension(evidencia, dimension);
      assert.equal(suyas.length, 1);
      assert.equal(suyas[0].dimension, dimension);
    }
    assert.deepEqual(evidenciaDeLaDimension(evidencia, 'lo_que_sea'), []);
  });

  it('una evaluación vacía no se puede decidir, y no revienta', () => {
    assert.equal(sePuedeDecidir(null), false);
    assert.equal(sePuedeDecidir(undefined), false);
    assert.equal(sePuedeDecidir({}), false);
  });

  it('el resumen de la evidencia se revisa aquí, con los topes del servidor', () => {
    assert.deepEqual(revisarResumenDeEvidencia(''), { estado: 'falta' });
    assert.deepEqual(revisarResumenDeEvidencia('   '), { estado: 'falta' });
    assert.deepEqual(revisarResumenDeEvidencia('corto'), {
      estado: 'corto',
      minimo: LARGO_DEL_RESUMEN_DE_EVIDENCIA.minimo,
    });
    assert.deepEqual(
      revisarResumenDeEvidencia('a'.repeat(LARGO_DEL_RESUMEN_DE_EVIDENCIA.maximo + 1)),
      { estado: 'largo', maximo: LARGO_DEL_RESUMEN_DE_EVIDENCIA.maximo },
    );
    assert.deepEqual(revisarResumenDeEvidencia('  se probó a mano  '), {
      estado: 'listo',
      resumen: 'se probó a mano',
    });
  });

  it('los topes del resumen son los del contrato', () => {
    assert.equal(LARGO_DEL_RESUMEN_DE_EVIDENCIA.minimo, 10);
    assert.equal(LARGO_DEL_RESUMEN_DE_EVIDENCIA.maximo, 1_000);
  });

  it('una URL no es una ruta de almacenamiento', () => {
    assert.equal(rutaValida('productos/1/foto.jpg'), true);
    assert.equal(rutaValida(''), true);
    assert.equal(rutaValida(null), true);
    assert.equal(rutaValida('https://ejemplo.com/foto.jpg'), false);
    assert.equal(rutaValida('s3://cubo/foto.jpg'), false);
  });
});

/* ========================================================================== */
/* 3. La matriz y los umbrales, comparados con el servidor                     */
/* ========================================================================== */

describe('la matriz es la del servidor, letra por letra', () => {
  const MODELOS = delServidor('models.py');
  const EVALUACIONES = delServidor('evaluations.py');

  /** El bloque `DIMENSIONES: dict[str, int] = { ... }` del servidor, leído. */
  function matrizDelServidor(): Array<[string, number]> {
    const bloque = /DIMENSIONES: dict\[str, int\] = \{([\s\S]*?)\}/.exec(MODELOS);
    assert.ok(bloque, 'no se encontró DIMENSIONES en models.py');
    return [...bloque[1].matchAll(/"(\w+)":\s*(\d+)/g)].map((m) => [
      m[1],
      Number(m[2]),
    ]);
  }

  /** Una tupla de cadenas del servidor, por su nombre. */
  function tuplaDelServidor(nombre: string, texto: string): string[] {
    const bloque = new RegExp(`${nombre}(?::[^=]*)? = \\(([\\s\\S]*?)\\)`).exec(texto);
    assert.ok(bloque, `no se encontró ${nombre}`);
    return [...bloque[1].matchAll(/"([\w]+)"/g)].map((m) => m[1]);
  }

  it('los pesos son 25/20/20/15/10/10, en ese orden', () => {
    assert.deepEqual(
      DIMENSIONES_ORDENADAS.map((d) => DIMENSIONES[d]),
      [25, 20, 20, 15, 10, 10],
    );
  });

  it('LA MATRIZ SUMA 100', () => {
    // Una matriz que no sume 100 daría puntuaciones que no se pueden comparar
    // entre productos, y el sello dejaría de querer decir lo mismo en dos fichas.
    assert.equal(PESO_TOTAL, 100);
    let suma = 0;
    for (const dimension of DIMENSIONES_ORDENADAS) suma += DIMENSIONES[dimension];
    assert.equal(suma, 100);
  });

  it('son SEIS, ni una más ni una menos', () => {
    assert.equal(DIMENSIONES_ORDENADAS.length, 6);
    assert.equal(DIMENSIONES_EXIGIDAS, 6);
    assert.equal(Object.keys(DIMENSIONES).length, 6);
    assert.equal(new Set(DIMENSIONES_ORDENADAS).size, 6);
  });

  it('es EXACTAMENTE la del servidor: mismos nombres, mismos pesos, mismo orden', () => {
    const suya = matrizDelServidor();
    assert.equal(suya.length, 6, 'el servidor ya no tiene seis dimensiones');
    assert.deepEqual(
      suya.map(([nombre]) => nombre),
      [...DIMENSIONES_ORDENADAS],
    );
    assert.deepEqual(
      suya,
      DIMENSIONES_ORDENADAS.map((d) => [d, DIMENSIONES[d]]),
    );
    // Y la suya también suma 100: si allí cambiara, aquí falla.
    assert.equal(
      suya.reduce((total, [, peso]) => total + peso, 0),
      100,
    );
  });

  it('LOS UMBRALES SON 9 000 Y 8 500, en centésimas', () => {
    assert.equal(APROBADO_DESDE, 9_000);
    assert.equal(CONDICIONADO_DESDE, 8_500);
    // 90,00 y 85,00 leídos.
    assert.equal(puntuacionLegible(APROBADO_DESDE), '90,00');
    assert.equal(puntuacionLegible(CONDICIONADO_DESDE), '85,00');
  });

  it('los umbrales son los que el servidor tiene escritos', () => {
    const leer = (nombre: string) => {
      const m = new RegExp(`${nombre} = ([0-9_]+)`).exec(EVALUACIONES);
      assert.ok(m, `no se encontró ${nombre} en evaluations.py`);
      return Number(m[1].replace(/_/g, ''));
    };
    assert.equal(leer('APROBADO_DESDE'), APROBADO_DESDE);
    assert.equal(leer('CONDICIONADO_DESDE'), CONDICIONADO_DESDE);
  });

  it('las fallas críticas son las seis del servidor', () => {
    assert.deepEqual(
      [...FALLAS_CRITICAS],
      tuplaDelServidor('FALLAS_CRITICAS', MODELOS),
    );
    assert.equal(FALLAS_CRITICAS.length, 6);
  });

  it('los tipos de evidencia son los del servidor', () => {
    assert.deepEqual(
      [...TIPOS_DE_EVIDENCIA],
      tuplaDelServidor('TIPOS_DE_EVIDENCIA', MODELOS),
    );
  });

  it('los tipos de documento son los del servidor', () => {
    assert.deepEqual([...DOCUMENTOS], tuplaDelServidor('DOCUMENTOS', MODELOS));
  });

  it('los once estados del producto existen en el servidor', () => {
    const valores = new Set(
      [...MODELOS.matchAll(/^(\w+) = "([\w]+)"$/gm)].map((m) => m[2]),
    );
    for (const estado of ESTADOS_DE_PRODUCTO) {
      assert.ok(valores.has(estado), `el servidor no tiene el estado ${estado}`);
    }
    assert.equal(ESTADOS_DE_PRODUCTO.length, 11);
  });

  it('los seis estados de la postulación existen en el servidor', () => {
    const valores = new Set(
      [...MODELOS.matchAll(/^(\w+) = "([\w]+)"$/gm)].map((m) => m[2]),
    );
    for (const estado of ESTADOS_DE_POSTULACION) {
      assert.ok(valores.has(estado), `el servidor no tiene el estado ${estado}`);
    }
  });

  it('son tres razones, como dice el servidor', () => {
    const m = /RAZONES_EXIGIDAS = (\d+)/.exec(MODELOS);
    assert.ok(m);
    assert.equal(Number(m[1]), RAZONES_EXIGIDAS);
    assert.equal(RAZONES_EXIGIDAS, 3);
  });

  it('el máximo posible es 10 000 centésimas, o sea 100,00', () => {
    assert.equal(PUNTUACION_MAXIMA, 10_000);
    assert.equal(puntuacionLegible(PUNTUACION_MAXIMA), '100,00');
  });

  it('el peso que se enseña es el de la evaluación, no la copia local', () => {
    // La matriz puede cambiar; lo que se va a aplicar es lo que mandó el servidor.
    assert.equal(pesoDeLaDimension({ quality: 40 }, 'quality'), 40);
    assert.equal(pesoDeLaDimension({}, 'quality'), DIMENSIONES.quality);
    assert.equal(pesoDeLaDimension(null, 'design'), DIMENSIONES.design);
    assert.equal(pesoDeLaDimension(null, 'lo_que_sea'), null);
  });

  it('una matriz del servidor con dimensiones nuevas se enseña igual, al final', () => {
    const orden = dimensionesDeLaMatriz({ design: 20, quality: 25, nueva: 5 });
    assert.deepEqual(orden, ['quality', 'design', 'nueva']);
    assert.deepEqual(dimensionesDeLaMatriz(null), [...DIMENSIONES_ORDENADAS]);
    assert.deepEqual(dimensionesDeLaMatriz({}), [...DIMENSIONES_ORDENADAS]);
  });

  it('`dimensionValida` es exactamente la matriz', () => {
    for (const d of DIMENSIONES_ORDENADAS) assert.equal(dimensionValida(d), true);
    for (const d of ['', 'lo_que_sea', 'Quality', null, undefined]) {
      assert.equal(dimensionValida(d as string), false, String(d));
    }
  });
});

/* ========================================================================== */
/* 4. Los umbrales, y el 8 999 que no es un 9 000                              */
/* ========================================================================== */

describe('la decisión la da la puntuación, y el borde se respeta', () => {
  it('9 000 es APROBADO', () => {
    assert.equal(decisionPorPuntuacion(9_000), 'approved');
  });

  it('8 999 es CONDICIONADO, no aprobado', () => {
    // 89,99 no es 90,00. Redondear aquí aprobaría algo que el servidor no aprueba.
    assert.equal(decisionPorPuntuacion(8_999), 'conditionally_approved');
    assert.notEqual(decisionPorPuntuacion(8_999), decisionPorPuntuacion(9_000));
  });

  it('8 500 es condicionado y 8 499 es rechazado', () => {
    assert.equal(decisionPorPuntuacion(8_500), 'conditionally_approved');
    assert.equal(decisionPorPuntuacion(8_499), 'rejected');
  });

  it('los extremos caen donde tienen que caer', () => {
    assert.equal(decisionPorPuntuacion(10_000), 'approved');
    assert.equal(decisionPorPuntuacion(0), 'rejected');
  });

  it('la puntuación se lee con dos decimales y sin inventar nada', () => {
    assert.equal(puntuacionLegible(9_000), '90,00');
    assert.equal(puntuacionLegible(8_999), '89,99');
    assert.equal(puntuacionLegible(8_500), '85,00');
    assert.equal(puntuacionLegible(10_000), '100,00');
    assert.equal(puntuacionLegible(5), '0,05');
    assert.equal(puntuacionLegible(50), '0,50');
  });

  it('el separador se puede pedir: el servidor nunca recibe la coma', () => {
    assert.equal(puntuacionLegible(9_000, '.'), '90.00');
    assert.equal(puntuacionLegible(8_999, '.'), '89.99');
  });

  it('lo que no es un número no se dibuja como si lo fuera', () => {
    assert.equal(puntuacionLegible(null), null);
    assert.equal(puntuacionLegible(undefined), null);
    assert.equal(puntuacionLegible(Number.NaN), null);
    assert.equal(puntuacionLegible(Number.POSITIVE_INFINITY), null);
  });

  it('la previsualización dice lo mismo que el servidor va a escribir', () => {
    const evidencia = evidenciaCompleta();
    const noventa = previsualizarDecision({ scores: todas(90), evidence: evidencia });
    assert.deepEqual(noventa, { estado: 'listo', decision: 'approved', total: 9_000 });

    const ochentaYnueve = previsualizarDecision({
      scores: todas(89),
      evidence: evidencia,
    });
    assert.deepEqual(ochentaYnueve, {
      estado: 'listo',
      decision: 'conditionally_approved',
      total: 8_900,
    });

    const bajo = previsualizarDecision({ scores: todas(50), evidence: evidencia });
    assert.deepEqual(bajo, { estado: 'listo', decision: 'rejected', total: 5_000 });
  });

  it('las tres decisiones son las del servidor', () => {
    assert.deepEqual(
      [...DECISIONES],
      ['approved', 'conditionally_approved', 'rejected'],
    );
  });

  it('cada decisión tiene su clave, y lo raro cae en desconocido', () => {
    for (const decision of DECISIONES) {
      assert.equal(claveDeLaDecision(decision), `productosAdmin.decision.${decision}`);
    }
    assert.equal(claveDeLaDecision('lo_que_sea'), 'productosAdmin.decision.desconocido');
    assert.equal(claveDeLaDecision(''), 'productosAdmin.decision.desconocido');
  });

  it('«aprobado con condiciones» se reconoce como decisión y como estado', () => {
    assert.equal(esDecisionCondicionada('conditionally_approved'), true);
    assert.equal(esDecisionCondicionada('approved'), false);
    assert.equal(esDecisionCondicionada(null), false);
    assert.equal(esAprobadoConCondiciones('conditionally_approved'), true);
    assert.equal(esAprobadoConCondiciones('approved'), false);
  });
});

/* ========================================================================== */
/* 5. Una falla crítica no se combina con una aprobación                       */
/* ========================================================================== */

describe('una falla crítica rechaza, y no se compensa con puntaje', () => {
  it('NINGUNA falla se puede combinar con «aprobado»', () => {
    for (const falla of FALLAS_CRITICAS) {
      assert.equal(combinacionImposible('approved', falla), true, falla);
      assert.equal(combinacionImposible('conditionally_approved', falla), true, falla);
      assert.equal(combinacionImposible('rejected', falla), false, falla);
    }
  });

  it('sin falla, cualquier decisión es posible', () => {
    for (const decision of DECISIONES) {
      assert.equal(combinacionImposible(decision, null), false);
      assert.equal(combinacionImposible(decision, undefined), false);
      assert.equal(combinacionImposible(decision, '   '), false);
    }
  });

  it('con falla y CON EL MÁXIMO EN TODO, la previsión sigue siendo rechazo', () => {
    const evaluacion = { scores: todas(100), evidence: evidenciaCompleta() };
    // Sin falla eso es un aprobado de libro.
    assert.deepEqual(previsualizarDecision(evaluacion), {
      estado: 'listo',
      decision: 'approved',
      total: 10_000,
    });
    for (const falla of FALLAS_CRITICAS) {
      const vista = previsualizarDecision(evaluacion, falla);
      assert.equal(vista.estado, 'fallaCritica');
      assert.equal(vista.decision, 'rejected');
      // Y SIN TOTAL: la puntuación no participa en este rechazo.
      assert.equal(vista.total, null);
      assert.equal(combinacionImposible(vista.decision, falla), false);
    }
  });

  it('una falla rechaza sin exigir la matriz completa', () => {
    // Una falsificación no necesita seis notas para rechazarse.
    const vista = previsualizarDecision({ scores: [], evidence: [] }, 'counterfeit');
    assert.equal(vista.estado, 'fallaCritica');
    assert.equal(vista.decision, 'rejected');
  });

  it('una falla inventada NO se manda, y no rechaza por su cuenta', () => {
    assert.equal(fallaQueViaja('lo_que_sea'), null);
    assert.equal(fallaQueViaja(''), null);
    assert.equal(fallaQueViaja('   '), null);
    assert.equal(fallaQueViaja(null), null);
    assert.equal(fallaQueViaja(undefined), null);
    assert.equal(fallaQueViaja('safety'), 'safety');
    // Con una falla inventada la previsión vuelve a mirar la matriz.
    const vista = previsualizarDecision({ scores: [], evidence: [] }, 'lo_que_sea');
    assert.equal(vista.estado, 'faltan');
  });

  it('`fallaCriticaValida` es exactamente la lista del servidor', () => {
    for (const falla of FALLAS_CRITICAS) assert.equal(fallaCriticaValida(falla), true);
    for (const falla of ['', 'Safety', 'lo_que_sea', null, undefined]) {
      assert.equal(fallaCriticaValida(falla as string), false, String(falla));
    }
  });

  it('cada falla tiene su clave, y lo raro cae en desconocido', () => {
    for (const falla of FALLAS_CRITICAS) {
      assert.equal(claveDeLaFallaCritica(falla), `productosAdmin.falla.${falla}`);
    }
    assert.equal(claveDeLaFallaCritica('lo_que_sea'), 'productosAdmin.falla.desconocido');
  });

  it('la pantalla dice, con su propio texto, que la falla será un rechazo', () => {
    assert.ok(EVALUAR.includes('productosAdmin.fallaSeraRechazo'));
    assert.ok(EVALUAR.includes('productosAdmin.fallaMandaSobreTodo'));
    assert.ok(EVALUAR.includes('productosAdmin.previsionRechazo'));
    assert.ok(EVALUAR.includes('productosAdmin.confirmarFallaCuerpo'));
    // Y es un selector APARTE, con su propio título.
    assert.ok(EVALUAR.includes('productosAdmin.fallaTitulo'));
    assert.ok(EVALUAR.includes('productosAdmin.sinFalla'));
  });

  it('la pantalla no puede mandar una decisión: solo la falla y la nota', () => {
    const codigo = sinComentarios(EVALUAR);
    const trozo = codigo.slice(codigo.indexOf('decidirEvaluacion('));
    const cuerpo = trozo.slice(0, trozo.indexOf('});'));
    assert.ok(cuerpo.includes('critical_failure'));
    assert.ok(cuerpo.includes('notes'));
    assert.ok(!cuerpo.includes('decision'));
    assert.ok(!cuerpo.includes('score_total'));
  });
});

/* ========================================================================== */
/* 6. Las razones salen de la evidencia registrada                             */
/* ========================================================================== */

describe('una razón sin evidencia no existe', () => {
  const evidencia = evidenciaCompleta();

  it('con una evidencia de esta evaluación, la razón vale', () => {
    assert.deepEqual(
      revisarRazon('ev-0', 'material certificado y trazable al lote', evidencia),
      {
        estado: 'listo',
        razon: {
          evidence_id: 'ev-0',
          text: 'material certificado y trazable al lote',
        },
      },
    );
  });

  it('SIN EVIDENCIA ELEGIDA no hay razón, aunque el texto sea perfecto', () => {
    for (const id of [null, undefined, '', '   ']) {
      assert.deepEqual(
        revisarRazon(id, 'una frase larga y perfectamente escrita', evidencia),
        { estado: 'sinEvidencia' },
      );
    }
  });

  it('una evidencia de OTRA evaluación tampoco vale', () => {
    // Apuntar a la evidencia de otro producto es cómo se acaba enseñando una
    // razón que nadie comprobó aquí.
    assert.deepEqual(
      revisarRazon('ev-de-otro', 'una frase larga y bien escrita', evidencia),
      { estado: 'sinEvidencia' },
    );
    assert.deepEqual(revisarRazon('ev-0', 'una frase larga y bien escrita', []), {
      estado: 'sinEvidencia',
    });
  });

  it('el texto se revisa con los topes del servidor', () => {
    assert.deepEqual(revisarRazon('ev-0', '', evidencia), { estado: 'falta' });
    assert.deepEqual(revisarRazon('ev-0', '   ', evidencia), { estado: 'falta' });
    assert.deepEqual(revisarRazon('ev-0', 'corto', evidencia), {
      estado: 'corto',
      minimo: LARGO_DE_LA_RAZON.minimo,
    });
    assert.deepEqual(
      revisarRazon('ev-0', 'a'.repeat(LARGO_DE_LA_RAZON.maximo + 1), evidencia),
      { estado: 'largo', maximo: LARGO_DE_LA_RAZON.maximo },
    );
    assert.equal(LARGO_DE_LA_RAZON.minimo, 10);
    assert.equal(LARGO_DE_LA_RAZON.maximo, 240);
  });

  it('la evidencia se comprueba ANTES del texto', () => {
    // Si se comprobara al revés, la pantalla pediría escribir una razón que de
    // todas formas no se va a poder mandar.
    assert.deepEqual(revisarRazon('', '', evidencia), { estado: 'sinEvidencia' });
  });

  it('tres razones con tres evidencias distintas pasan', () => {
    const revisadas = revisarRazones(
      [
        { evidence_id: 'ev-0', text: 'el material aguanta el uso diario' },
        { evidence_id: 'ev-1', text: 'la garantía está escrita y es aplicable' },
        { evidence_id: 'ev-2', text: 'la procedencia se pudo verificar' },
      ],
      evidencia,
    );
    assert.equal(revisadas.estado, 'listo');
    assert.equal(revisadas.estado === 'listo' ? revisadas.razones.length : 0, 3);
  });

  it('la misma evidencia en dos razones se rechaza', () => {
    const revisadas = revisarRazones(
      [
        { evidence_id: 'ev-0', text: 'el material aguanta el uso diario' },
        { evidence_id: 'ev-0', text: 'y además está bien acabado' },
      ],
      evidencia,
    );
    assert.deepEqual(revisadas, { estado: 'repetida', posicion: 2 });
  });

  it('más de tres razones se rechaza aquí, no con un 422', () => {
    const cuatro = [0, 1, 2, 3].map((i) => ({
      evidence_id: `ev-${i}`,
      text: 'una razón perfectamente válida y larga',
    }));
    assert.deepEqual(revisarRazones(cuatro, evidencia), {
      estado: 'demasiadas',
      maximo: RAZONES_EXIGIDAS,
    });
  });

  it('se dice QUÉ razón está mal, y por qué', () => {
    const revisadas = revisarRazones(
      [
        { evidence_id: 'ev-0', text: 'el material aguanta el uso diario' },
        { evidence_id: null, text: 'esta no tiene evidencia' },
      ],
      evidencia,
    );
    assert.equal(revisadas.estado, 'invalida');
    if (revisadas.estado === 'invalida') {
      assert.equal(revisadas.posicion, 2);
      assert.deepEqual(revisadas.motivo, { estado: 'sinEvidencia' });
    }
  });

  it('las tres son las tres: ni dos ni cuatro', () => {
    assert.equal(razonesCompletas([1, 2, 3]), true);
    assert.equal(razonesCompletas([1, 2]), false);
    assert.equal(razonesCompletas([1, 2, 3, 4]), false);
    assert.equal(razonesCompletas([]), false);
    assert.equal(razonesCompletas(null), false);
  });

  it('el módulo no tiene NINGUNA función que construya una razón sin evidencia', () => {
    // Toda firma que produce una `RazonRequest` pide un `evidence_id`.
    const construyen = [...MODULO.matchAll(/export function (revisarRazon\w*)/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(construyen.sort(), ['revisarRazon', 'revisarRazones']);
    assert.ok(MODULO.includes('evidence_id: id'));
    assert.ok(!/text:\s*limpio\s*\}\s*;/.test(MODULO.replace(/evidence_id[^\n]*\n/g, '')));
  });

  it('el repositorio solo acepta razones con `evidence_id`', () => {
    const codigo = sinComentarios(REPOSITORIO);
    assert.ok(codigo.includes('razones: RazonRequest[]'));
    assert.ok(!codigo.includes('texto: string'));
  });

  it('la pantalla elige la evidencia y dice que es de ahí de donde sale', () => {
    assert.ok(EVALUAR.includes('productosAdmin.elegirEvidencia'));
    assert.ok(EVALUAR.includes('productosAdmin.razonSaleDe'));
    assert.ok(EVALUAR.includes('productosAdmin.razonesSinEvidencia'));
    assert.ok(EVALUAR.includes('cambiarRazon(indice, { evidencia: e.id })'));
    // Y sin evidencia registrada NO se ofrece ningún campo de texto libre.
    const codigo = sinComentarios(EVALUAR);
    assert.ok(/evaluacion\.evidence\.length === 0[\s\S]{0,400}razonesSinEvidencia/.test(codigo));
  });
});

/* ========================================================================== */
/* 7. Publicar: se lee el bloqueo del servidor, no se recalcula                */
/* ========================================================================== */

describe('no hay botón de publicar cuando el servidor manda un bloqueo', () => {
  const listo = { status: 'approved', acciones: ['published', 'draft'], bloqueo: null };

  it('sin bloqueo y con la acción ofrecida, se puede publicar', () => {
    assert.equal(sePuedePublicar(listo), true);
  });

  it('CON CUALQUIER BLOQUEO, no se puede, aunque el servidor ofrezca la acción', () => {
    for (const bloqueo of BLOQUEOS_DE_PUBLICACION) {
      assert.equal(sePuedePublicar({ ...listo, bloqueo }), false, bloqueo);
    }
    // Y tampoco con uno que esta pantalla no conozca.
    assert.equal(sePuedePublicar({ ...listo, bloqueo: 'algo_nuevo' }), false);
  });

  it('sin la acción ofrecida tampoco: publicar es de administración', () => {
    assert.equal(sePuedePublicar({ ...listo, acciones: ['draft'] }), false);
    assert.equal(sePuedePublicar({ ...listo, acciones: [] }), false);
    assert.equal(sePuedePublicar({ status: 'approved', bloqueo: null }), false);
  });

  it('un producto que no llega no ofrece publicar', () => {
    assert.equal(sePuedePublicar(null), false);
    assert.equal(sePuedePublicar(undefined), false);
    assert.equal(sePuedePublicar({}), false);
  });

  it('CADA BLOQUEO SE EXPLICA: nunca un botón ausente y ningún motivo', () => {
    for (const bloqueo of BLOQUEOS_DE_PUBLICACION) {
      assert.equal(
        claveDelBloqueoDePublicacion({ status: 'approved', bloqueo }),
        `productosAdmin.bloqueo.${bloqueo}`,
      );
    }
    assert.equal(
      claveDelBloqueoDePublicacion({ status: 'approved', bloqueo: 'algo_nuevo' }),
      'productosAdmin.bloqueo.desconocido',
    );
    assert.equal(claveDelBloqueoDePublicacion({ status: 'approved', bloqueo: null }), null);
    assert.equal(claveDelBloqueoDePublicacion(null), null);
  });

  it('`conditionally_approved` NO PUEDE PUBLICAR, y tiene su propio texto', () => {
    // El servidor manda `product_not_approved`, que no explica nada. Lo que pasa
    // de verdad es que la empresa no ha definido las condiciones.
    const condicionado = {
      status: 'conditionally_approved',
      acciones: ['evaluation', 'draft'],
      bloqueo: 'product_not_approved',
    };
    assert.equal(sePuedePublicar(condicionado), false);
    assert.equal(
      claveDelBloqueoDePublicacion(condicionado),
      'productosAdmin.bloqueo.condicionado',
    );
    assert.notEqual(
      claveDelBloqueoDePublicacion(condicionado),
      'productosAdmin.bloqueo.product_not_approved',
    );
  });

  it('el módulo NO recalcula el bloqueo: no mira razones, ni fotos, ni evaluación', () => {
    const codigo = sinComentarios(MODULO);
    const trozo = codigo.slice(codigo.indexOf('export function sePuedePublicar'));
    const cuerpo = trozo.slice(0, trozo.indexOf('\n}'));
    assert.ok(cuerpo.includes('producto.bloqueo'));
    assert.ok(cuerpo.includes('ofrecePublicar'));
    assert.ok(!cuerpo.includes('reasons'));
    assert.ok(!cuerpo.includes('gallery'));
    assert.ok(!cuerpo.includes('RAZONES_EXIGIDAS'));
  });

  it('la pantalla solo pinta el botón cuando `sePuedePublicar` lo dice', () => {
    const codigo = sinComentarios(PANEL);
    assert.ok(codigo.includes('const puedePublicar = sePuedePublicar(producto)'));
    assert.ok(/\{puedePublicar \?[\s\S]{0,300}productosAdmin\.publicar/.test(codigo));
    // Y el motivo se dice siempre que haya bloqueo.
    assert.ok(codigo.includes('claveDelBloqueoDePublicacion(producto)'));
    assert.ok(codigo.includes('productosAdmin.bloqueoTitulo'));
    assert.ok(codigo.includes('productosAdmin.condicionadoQueHacer'));
  });

  it('publicar y suspender no se ofrecen como transiciones cualquiera', () => {
    // Tienen su propia ruta, que comprueba lo que `transition` no comprueba.
    const acciones = ['published', 'suspended', 'observation', 'removed', 'draft'];
    assert.deepEqual(transicionesQueSeOfrecen(acciones), [
      'observation',
      'removed',
      'draft',
    ]);
    assert.deepEqual(transicionesQueSeOfrecen([]), []);
    assert.deepEqual(transicionesQueSeOfrecen(null), []);
    assert.equal(ofrecePublicar(acciones), true);
    assert.equal(ofreceSuspender(acciones), true);
    assert.equal(ofrecePublicar(['draft']), false);
    assert.equal(ofreceSuspender(['draft']), false);
  });

  it('suspender exige motivo, y devolver a borrador o retirar también', () => {
    assert.equal(transicionExigeMotivo('suspended'), true);
    assert.equal(transicionExigeMotivo('draft'), true);
    assert.equal(transicionExigeMotivo('removed'), true);
    assert.equal(transicionExigeMotivo('published'), false);
    assert.equal(transicionExigeMotivo('evaluation'), false);
    assert.equal(transicionExigeMotivo(null), false);
  });

  it('el repositorio pide el motivo de suspender en la firma', () => {
    assert.ok(REPOSITORIO.includes('async suspender(productId: string, motivo: string)'));
    // Publicar NO manda cuerpo: lo comprueba todo el servidor.
    const codigo = sinComentarios(REPOSITORIO);
    const trozo = codigo.slice(codigo.indexOf('async publicar('));
    const cuerpo = trozo.slice(0, trozo.indexOf('},'));
    assert.ok(!cuerpo.includes('body'));
  });
});

/* ========================================================================== */
/* 8. Las pantallas: ni texto en duro ni puntuaciones a mano                   */
/* ========================================================================== */

describe('las pantallas no escriben a mano nada que decida el servidor', () => {
  /** Los umbrales, en todas las formas en las que se podrían colar. */
  const UMBRALES = [/\b9000\b/, /\b9_000\b/, /\b8500\b/, /\b8_500\b/];

  for (const [nombre, codigo] of PANTALLAS) {
    it(`${nombre} no tiene ni un texto en duro dentro del JSX`, () => {
      const limpio = sinComentarios(codigo);
      const sueltos = [...limpio.matchAll(/[^=]>\s*\n?\s*[A-Za-zÁÉÍÓÚÑáéíóúñ¿¡]/g)];
      assert.deepEqual(
        sueltos.map((m) => m[0]),
        [],
        `hay texto escrito directamente en el JSX de ${nombre}`,
      );
    });

    it(`${nombre} NO ESCRIBE NINGÚN UMBRAL a mano`, () => {
      const limpio = sinComentarios(codigo);
      for (const umbral of UMBRALES) {
        assert.ok(!umbral.test(limpio), `${nombre} escribe ${umbral} a mano`);
      }
    });

    it(`${nombre} no escribe la matriz: ni un nombre de dimensión ni su peso`, () => {
      const limpio = sinComentarios(codigo);
      for (const dimension of DIMENSIONES_ORDENADAS) {
        assert.ok(
          !limpio.includes(`'${dimension}'`),
          `${nombre} escribe la dimensión ${dimension} a mano`,
        );
      }
      // Y no hay ningún mapa de pesos escrito en la pantalla.
      assert.ok(!/quality|durability|usefulness/.test(limpio), nombre);
    });

    it(`${nombre} no escribe a mano una falla crítica ni un tipo de evidencia`, () => {
      const limpio = sinComentarios(codigo);
      for (const falla of FALLAS_CRITICAS) {
        assert.ok(!limpio.includes(`'${falla}'`), `${nombre} escribe ${falla}`);
      }
      for (const kind of TIPOS_DE_EVIDENCIA) {
        assert.ok(!limpio.includes(`'${kind}'`), `${nombre} escribe ${kind}`);
      }
    });

    it(`${nombre} no calcula ninguna puntuación: la pide al módulo`, () => {
      const limpio = sinComentarios(codigo);
      // Ni una multiplicación por un peso, ni una división por cien.
      assert.ok(!/\*\s*weight/.test(limpio), nombre);
      assert.ok(!/\/\s*100\b/.test(limpio), nombre);
      assert.ok(!/score_total\s*=/.test(limpio), nombre);
      assert.ok(!/reduce\(/.test(limpio), nombre);
    });

    it(`${nombre} saca todos los colores del tema`, () => {
      const limpio = sinComentarios(codigo);
      assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(limpio), `${nombre} tiene un color a mano`);
      assert.ok(!/rgba?\(/.test(limpio), nombre);
      assert.ok(limpio.includes('useAppTheme()'));
    });

    it(`${nombre} pasa todas sus claves por el traductor`, () => {
      const limpio = sinComentarios(codigo);
      const claves = [...limpio.matchAll(/'productosAdmin\.[a-zA-Z_.]+'/g)];
      assert.ok(claves.length > 15, `${nombre} usa solo ${claves.length} claves`);
      for (const clave of claves) {
        const antes = limpio.slice(Math.max(0, (clave.index ?? 0) - 3), clave.index);
        assert.ok(
          antes.endsWith('f(') || antes.endsWith('t(') || antes.endsWith("= '"),
          `la clave ${clave[0]} de ${nombre} no pasa por el traductor`,
        );
      }
    });

    it(`${nombre} no habla con Supabase ni con ningún mock`, () => {
      const limpio = sinComentarios(codigo);
      assert.ok(!limpio.includes('supabase'));
      assert.ok(!limpio.includes('fetch('));
      assert.ok(!limpio.includes('mock'));
      assert.ok(limpio.includes('ProductAdmissionRepository'));
    });

    it(`${nombre} NO TIENE NI UN CONTROL FINANCIERO`, () => {
      // Estas pantallas no mueven dinero, y un botón que lo insinúe sería una
      // promesa que nadie ha autorizado.
      const limpio = sinComentarios(codigo).toLowerCase();
      for (const palabra of [
        'saldo',
        'transferencia',
        'transferir',
        'payout',
        'balance',
        'cobrar',
        'pagar',
        'refund',
        'reembolso',
        'price_minor',
        'currency',
      ]) {
        assert.ok(!limpio.includes(palabra), `${nombre} nombra «${palabra}»`);
      }
    });

    it(`${nombre} echa el cerrojo ANTES del primer await`, () => {
      const limpio = sinComentarios(codigo);
      const salida = limpio.indexOf('if (ocupadoRef.current) return;');
      const cerrojo = limpio.indexOf('ocupadoRef.current = true');
      const primerAwait = limpio.indexOf('await trabajo()');
      assert.ok(salida >= 0 && salida < cerrojo, `${nombre} no comprueba antes`);
      assert.ok(cerrojo < primerAwait, `${nombre} echa el cerrojo tarde`);
      assert.ok(codigo.includes('const ocupadoRef = useRef(false)'));
      assert.ok(/finally \{[\s\S]{0,120}ocupadoRef\.current = false/.test(limpio));
    });

    it(`${nombre} apaga sus controles mientras va`, () => {
      const limpio = sinComentarios(codigo);
      const apagados = limpio.match(/disabled=\{ocupado/g) ?? [];
      assert.ok(apagados.length >= 4, `${nombre} solo apaga ${apagados.length}`);
      assert.ok(limpio.includes('loading={ocupado}'));
    });

    it(`${nombre} recarga tras un conflicto en vez de mandar a salir y entrar`, () => {
      const limpio = sinComentarios(codigo);
      assert.ok(/esConflicto\(error\.code\)[\s\S]{0,160}await cargar\(\)/.test(limpio));
      assert.ok(limpio.includes('productosAdmin.conflictoTitulo'));
    });

    it(`${nombre} no indexa nada con un valor del servidor`, () => {
      // Un `TEXTOS[producto.status]` sería `undefined` pintado en pantalla.
      const limpio = sinComentarios(codigo);
      assert.ok(!/\[producto\.status\]/.test(limpio));
      assert.ok(!/\[postulacion\.status\]/.test(limpio));
      assert.ok(!/\[evaluacion\.decision\]/.test(limpio));
    });
  }

  it('la admisión exige el motivo ANTES de llamar y antes de confirmar', () => {
    // Solo dentro de `decidir`: `tomar` también confirma, y antes en el fichero.
    const entero = sinComentarios(ADMISION);
    const limpio = entero.slice(entero.indexOf('const decidir ='));
    const revisa = limpio.indexOf('revisarDecisionDePostulacion(');
    const confirma = limpio.indexOf('await confirm(');
    const llama = limpio.indexOf('ProductAdmissionRepository.decidirPostulacion');
    assert.ok(revisa > 0, 'no se revisa la decisión');
    assert.ok(confirma > revisa, 'confirma antes de tener el motivo');
    assert.ok(llama > revisa, 'llama antes de revisar');
    assert.ok(/estado === 'faltaMotivo'[\s\S]{0,200}return;/.test(limpio));
    assert.ok(limpio.includes('productosAdmin.faltaMotivo'));
  });

  it('la admisión enseña los documentos presentados y el botón de tomar', () => {
    assert.ok(ADMISION.includes('productosAdmin.documentosTitulo'));
    assert.ok(ADMISION.includes('productosAdmin.sinDocumentos'));
    assert.ok(ADMISION.includes('claveDelDocumento(documento.kind)'));
    assert.ok(ADMISION.includes('productosAdmin.tomar'));
    assert.ok(ADMISION.includes('tomarPostulacion'));
  });

  it('la admisión no abre el contenido de ningún documento', () => {
    // De un documento se dice que se presentó; su contenido no se lee en una lista,
    // y menos el de una cuenta bancaria.
    const limpio = sinComentarios(ADMISION);
    assert.ok(limpio.includes('productosAdmin.documentoPresentado'));
    assert.ok(!limpio.includes('Linking'));
    assert.ok(!limpio.includes('openURL'));
    assert.ok(!limpio.includes('WebBrowser'));
  });

  it('la evaluación enseña QUÉ FALTA siempre, y el peso de cada dimensión', () => {
    assert.ok(EVALUAR.includes('productosAdmin.queFaltaTitulo'));
    assert.ok(EVALUAR.includes('productosAdmin.faltanPuntuar'));
    assert.ok(EVALUAR.includes('productosAdmin.faltanEvidencia'));
    assert.ok(EVALUAR.includes('productosAdmin.sinTotalTodavia'));
    assert.ok(EVALUAR.includes('pesoDeLaDimension(evaluacion.matriz, dimension)'));
    assert.ok(EVALUAR.includes('DIMENSIONES_ORDENADAS.map('));
  });

  it('la evaluación previsualiza la decisión antes de decidir', () => {
    assert.ok(EVALUAR.includes('productosAdmin.previsualizacionTitulo'));
    assert.ok(EVALUAR.includes('previsualizarDecision(evaluacion, falla)'));
    const limpio = sinComentarios(EVALUAR);
    // El botón de decidir se apaga mientras falte algo.
    assert.ok(/disabled=\{ocupado \|\| imposible \|\| vista\.estado === 'faltan'\}/.test(limpio));
    assert.ok(limpio.includes('productosAdmin.decidirBloqueado'));
  });

  it('la evaluación no ofrece controles cuando ya está decidida', () => {
    const limpio = sinComentarios(EVALUAR);
    assert.ok(limpio.includes('const abierta = evaluacionAbierta(evaluacion.status)'));
    assert.ok(limpio.includes('productosAdmin.yaDecidida'));
    // Todo lo que escribe cuelga de `abierta`.
    const veces = limpio.match(/\{abierta \?|abierta &&/g) ?? [];
    assert.ok(veces.length >= 4, `solo ${veces.length} bloques dependen de «abierta»`);
  });

  it('el campo de puntuación solo admite dígitos', () => {
    const limpio = sinComentarios(EVALUAR);
    assert.ok(limpio.includes('soloDigitos(texto)'));
    assert.ok(limpio.includes('keyboardType="number-pad"'));
    assert.ok(limpio.includes('revisarPuntuacion(escritas[dimension])'));
  });

  it('los selectores se anuncian como elección única', () => {
    for (const [nombre, codigo] of PANTALLAS) {
      if (!codigo.includes('<Chip')) continue;
      const radios = codigo.match(/rol="radio"/g) ?? [];
      assert.ok(radios.length >= 2, `${nombre} tiene chips que no son de opción única`);
    }
  });

  it('lo que se pulsa a mano llega a los 44 puntos', () => {
    assert.ok(ADMISION.includes('minHeight: 44'));
    assert.ok(PANEL.includes('minHeight: 44'));
  });

  it('las tres pantallas tienen sus cuatro estados', () => {
    for (const [nombre, codigo] of PANTALLAS) {
      assert.ok(codigo.includes('state="loading"'), nombre);
      assert.ok(codigo.includes('state="empty"'), nombre);
      assert.ok(codigo.includes("'offline' : 'error'"), nombre);
      assert.ok(codigo.includes('onRetry={() => void cargar()}'), nombre);
    }
  });

  it('las tres dicen que no mueven dinero, con su propia clave', () => {
    for (const [nombre, codigo] of PANTALLAS) {
      assert.ok(codigo.includes('productosAdmin.sinDinero'), nombre);
    }
  });

  it('las rutas de expo-router apuntan a las tres pantallas', () => {
    const ruta = (...partes: string[]) =>
      readFileSync(join(AQUI, '..', '..', 'app', ...partes), 'utf8');
    assert.ok(ruta('admin', 'productos', 'index.tsx').includes('AdminProductosScreen'));
    assert.ok(
      ruta('admin', 'productos', 'admision.tsx').includes('AdmisionDeProductosScreen'),
    );
    assert.ok(
      ruta('admin', 'productos', 'evaluar', '[evaluationId].tsx').includes(
        'EvaluarProductoScreen',
      ),
    );
  });

  it('la cola de administración lleva a las dos pantallas nuevas', () => {
    const cola = fuente('screens', 'AdminEventosScreen.tsx');
    assert.ok(cola.includes("'/admin/productos'"));
    assert.ok(cola.includes("'/admin/productos/admision'"));
    assert.ok(cola.includes('productosAdmin.tituloPanel'));
    assert.ok(cola.includes('productosAdmin.tituloAdmision'));
  });
});

/* ========================================================================== */
/* El repositorio: catorce llamadas y ni una más                                */
/* ========================================================================== */

describe('el repositorio llama a las catorce rutas del contrato', () => {
  it('son exactamente esas catorce', () => {
    const rutas = [...REPOSITORIO.matchAll(/\$\{API_V1\}(\/[^`?]*)/g)].map((m) => m[1]);
    assert.deepEqual(
      new Set(rutas),
      new Set([
        '/admin/products/applications',
        '/admin/products/applications/${applicationId}/take',
        '/admin/products/applications/${applicationId}/decide',
        '/admin/products',
        '/admin/products/evaluations',
        '/admin/products/evaluations/${evaluationId}',
        '/admin/products/versions/${versionId}/evaluation',
        '/admin/products/evaluations/${evaluationId}/scores/${dimension}',
        '/admin/products/evaluations/${evaluationId}/evidence',
        '/admin/products/evaluations/${evaluationId}/reasons',
        '/admin/products/evaluations/${evaluationId}/decide',
        '/admin/products/${productId}/transition',
        '/admin/products/${productId}/publish',
        '/admin/products/${productId}/suspend',
      ]),
    );
    assert.equal(rutas.length, 14);
  });

  it('hay catorce llamadas y catorce métodos', () => {
    const codigo = sinComentarios(REPOSITORIO);
    assert.equal((codigo.match(/apiRequest</g) ?? []).length, 14);
    assert.equal((codigo.match(/^  async \w+\(/gm) ?? []).length, 14);
  });

  it('no hay ningún método de borrado ni de dinero', () => {
    const codigo = sinComentarios(REPOSITORIO).toLowerCase();
    for (const palabra of [
      'delete',
      'borrar',
      'eliminar',
      'saldo',
      'payout',
      'transfer',
      'refund',
      'price',
    ]) {
      assert.ok(!codigo.includes(palabra), `el repositorio nombra «${palabra}»`);
    }
  });

  it('pasa por `apiRequest` y por nada más', () => {
    const codigo = sinComentarios(REPOSITORIO);
    assert.ok(codigo.includes("from '@/services/api'"));
    assert.ok(!codigo.includes('supabase'));
    assert.ok(!codigo.includes('fetch('));
  });

  it('el cuerpo de puntuar lleva la nota entera, sin coma', () => {
    const codigo = sinComentarios(REPOSITORIO);
    assert.ok(codigo.includes('cuerpo: PuntuacionRequest'));
    assert.ok(!codigo.includes('toFixed'));
    assert.ok(!codigo.includes('replace(\',\''));
  });
});

/* ========================================================================== */
/* La postulación: un rechazo sin motivo no sale de la pantalla                */
/* ========================================================================== */

describe('un rechazo de postulación exige motivo', () => {
  it('rechazar sin motivo se para AQUÍ', () => {
    for (const motivo of ['', '   ', null, undefined]) {
      assert.deepEqual(revisarDecisionDePostulacion(false, motivo), {
        estado: 'faltaMotivo',
      });
    }
  });

  it('aceptar sin motivo es legítimo: el motivo es una nota', () => {
    assert.deepEqual(revisarDecisionDePostulacion(true, ''), {
      estado: 'listo',
      cuerpo: { aceptar: true, motivo: null, notas: null },
    });
  });

  it('rechazar con motivo pasa, recortado de los bordes', () => {
    assert.deepEqual(revisarDecisionDePostulacion(false, '  faltan permisos  '), {
      estado: 'listo',
      cuerpo: { aceptar: false, motivo: 'faltan permisos', notas: null },
    });
  });

  it('las notas internas viajan aparte del motivo', () => {
    const revisada = revisarDecisionDePostulacion(true, 'bienvenida', 'llamar al taller');
    assert.deepEqual(revisada, {
      estado: 'listo',
      cuerpo: { aceptar: true, motivo: 'bienvenida', notas: 'llamar al taller' },
    });
  });

  it('los topes se miran antes de mandar, no después del 422', () => {
    assert.deepEqual(
      revisarDecisionDePostulacion(false, 'a'.repeat(LARGO_MAXIMO_DEL_MOTIVO + 1)),
      { estado: 'motivoLargo', maximo: LARGO_MAXIMO_DEL_MOTIVO },
    );
    assert.deepEqual(
      revisarDecisionDePostulacion(
        true,
        null,
        'a'.repeat(LARGO_MAXIMO_DE_LAS_NOTAS + 1),
      ),
      { estado: 'notasLargas', maximo: LARGO_MAXIMO_DE_LAS_NOTAS },
    );
    assert.equal(LARGO_MAXIMO_DEL_MOTIVO, 2_000);
    assert.equal(LARGO_MAXIMO_DE_LAS_NOTAS, 4_000);
  });

  it('solo un rechazo exige motivo', () => {
    assert.equal(decisionExigeMotivo(false), true);
    assert.equal(decisionExigeMotivo(true), false);
  });

  it('tomar solo se ofrece sobre lo enviado, y decidir sobre lo que espera', () => {
    assert.equal(sePuedeTomar('submitted'), true);
    assert.equal(sePuedeTomar('under_review'), false);
    assert.equal(sePuedeTomar('accepted'), false);
    assert.equal(sePuedeTomar(null), false);
    assert.equal(sePuedeDecidirPostulacion('submitted'), true);
    assert.equal(sePuedeDecidirPostulacion('under_review'), true);
    assert.equal(sePuedeDecidirPostulacion('accepted'), false);
    assert.equal(sePuedeDecidirPostulacion('rejected'), false);
    assert.equal(sePuedeDecidirPostulacion('withdrawn'), false);
    assert.equal(sePuedeDecidirPostulacion(undefined), false);
  });

  it('se filtra por lo que espera y por lo que alguien tomó', () => {
    assert.deepEqual([...POSTULACIONES_QUE_SE_FILTRAN], ['submitted', 'under_review']);
  });

  it('cada estado de postulación tiene su clave', () => {
    for (const estado of ESTADOS_DE_POSTULACION) {
      assert.equal(
        claveDelEstadoDePostulacion(estado),
        `productosAdmin.postulacion.${estado}`,
      );
    }
    assert.equal(
      claveDelEstadoDePostulacion('lo_que_sea'),
      'productosAdmin.postulacion.desconocido',
    );
  });

  it('cada tipo de documento tiene su clave', () => {
    for (const kind of DOCUMENTOS) {
      assert.equal(claveDelDocumento(kind), `productosAdmin.documento.${kind}`);
    }
    assert.equal(claveDelDocumento(''), 'productosAdmin.documento.desconocido');
  });
});

/* ========================================================================== */
/* El motivo, el ciclo, la lista y los errores                                 */
/* ========================================================================== */

describe('el motivo se revisa aquí, y su obligatoriedad depende de qué se hace', () => {
  it('obligatorio y vacío es «falta»', () => {
    assert.deepEqual(revisarMotivo(true, ''), { estado: 'falta' });
    assert.deepEqual(revisarMotivo(true, '   \n\t '), { estado: 'falta' });
    assert.deepEqual(revisarMotivo(true, null), { estado: 'falta' });
  });

  it('opcional y vacío viaja como `null`, no como cadena vacía', () => {
    assert.deepEqual(revisarMotivo(false, ''), { estado: 'listo', motivo: null });
    assert.deepEqual(revisarMotivo(false, '  '), { estado: 'listo', motivo: null });
  });

  it('justo en el tope pasa, y uno más no', () => {
    const justo = 'a'.repeat(LARGO_MAXIMO_DEL_MOTIVO);
    assert.deepEqual(revisarMotivo(true, justo), { estado: 'listo', motivo: justo });
    assert.deepEqual(revisarMotivo(true, `${justo}a`), {
      estado: 'largo',
      maximo: LARGO_MAXIMO_DEL_MOTIVO,
    });
  });

  it('`textoUtil` recorta al tope y devuelve `null` cuando no hay nada', () => {
    assert.equal(textoUtil('  ', 10), null);
    assert.equal(textoUtil(null, 10), null);
    assert.equal(textoUtil('  hola  ', 10), 'hola');
    assert.equal(textoUtil('a'.repeat(20), 10)?.length, 10);
    assert.equal(textoUtil('hola', 0), '');
  });
});

describe('la puntuación escrita a mano se revisa antes de mandarse', () => {
  it('solo dígitos, de 0 a 100', () => {
    assert.deepEqual(revisarPuntuacion('0'), { estado: 'listo', score: 0 });
    assert.deepEqual(revisarPuntuacion('90'), { estado: 'listo', score: 90 });
    assert.deepEqual(revisarPuntuacion('100'), { estado: 'listo', score: 100 });
    assert.deepEqual(revisarPuntuacion(' 85 '), { estado: 'listo', score: 85 });
  });

  it('UNA COMA NO SE CORRIGE POR NUESTRA CUENTA: se dice que no vale', () => {
    // Redondear «90,5» a algo sería guardar una nota que nadie escribió.
    for (const texto of ['90,5', '90.5', '9e1', '-5', '+5', '9 0', 'noventa', '1,0']) {
      const revisada = revisarPuntuacion(texto);
      assert.notEqual(revisada.estado, 'listo', texto);
    }
  });

  it('los espacios de los bordes se recortan, que no es corregir el número', () => {
    assert.deepEqual(revisarPuntuacion('  90  '), { estado: 'listo', score: 90 });
  });

  it('vacío es «falta», no cero', () => {
    assert.deepEqual(revisarPuntuacion(''), { estado: 'falta' });
    assert.deepEqual(revisarPuntuacion('   '), { estado: 'falta' });
    assert.deepEqual(revisarPuntuacion(null), { estado: 'falta' });
    assert.deepEqual(revisarPuntuacion(undefined), { estado: 'falta' });
  });

  it('fuera de rango se dice con sus cotas', () => {
    assert.deepEqual(revisarPuntuacion('101'), {
      estado: 'fuera',
      minimo: PUNTUACION_MINIMA_DE_DIMENSION,
      maximo: PUNTUACION_MAXIMA_DE_DIMENSION,
    });
    assert.equal(PUNTUACION_MINIMA_DE_DIMENSION, 0);
    assert.equal(PUNTUACION_MAXIMA_DE_DIMENSION, 100);
  });

  it('`soloDigitos` deja lo que el campo puede aceptar', () => {
    assert.equal(soloDigitos('9a0,5'), '905');
    assert.equal(soloDigitos('1234'), '123');
    assert.equal(soloDigitos(''), '');
    assert.equal(soloDigitos(null), '');
    assert.equal(soloDigitos('-90'), '90');
  });

  it('`puntuacionDeDimensionValida` es el 0 al 100 entero del contrato', () => {
    for (const score of [0, 1, 50, 99, 100]) {
      assert.equal(puntuacionDeDimensionValida(score), true, String(score));
    }
    for (const score of [-1, 101, 0.5, '90', null, undefined, Number.NaN, {}]) {
      assert.equal(puntuacionDeDimensionValida(score), false, String(score));
    }
  });
});

describe('el ciclo del producto se lee, no se decide aquí', () => {
  it('los once estados tienen su clave, y lo raro cae en desconocido', () => {
    for (const estado of ESTADOS_DE_PRODUCTO) {
      assert.equal(
        claveDelEstadoDeProducto(estado),
        `productosAdmin.estado.${estado}`,
      );
    }
    assert.equal(
      claveDelEstadoDeProducto('lo_que_sea'),
      'productosAdmin.estado.desconocido',
    );
  });

  it('los filtros solo ofrecen estados que existen', () => {
    for (const estado of ESTADOS_QUE_SE_FILTRAN) {
      assert.ok(
        (ESTADOS_DE_PRODUCTO as readonly string[]).includes(estado),
        estado,
      );
    }
  });

  it('«en observación» sigue en catálogo: observar es vigilar, no esconder', () => {
    assert.equal(enCatalogo('published'), true);
    assert.equal(enCatalogo('observation'), true);
    assert.equal(enCatalogo('suspended'), false);
    assert.equal(enCatalogo('approved'), false);
    assert.equal(enCatalogo(null), false);
  });

  it('el tono distingue catálogo, alerta y lo demás', () => {
    assert.equal(tonoDelEstado('published'), 'catalogo');
    assert.equal(tonoDelEstado('observation'), 'catalogo');
    assert.equal(tonoDelEstado('suspended'), 'alerta');
    assert.equal(tonoDelEstado('removed'), 'alerta');
    assert.equal(tonoDelEstado('draft'), 'neutro');
    assert.equal(tonoDelEstado('lo_que_sea'), 'neutro');
  });

  it('una evaluación decidida no está abierta', () => {
    assert.equal(evaluacionAbierta('draft'), true);
    assert.equal(evaluacionAbierta('decided'), false);
    assert.equal(evaluacionAbierta(null), false);
  });

  it('los tipos de evidencia y sus claves', () => {
    for (const kind of TIPOS_DE_EVIDENCIA) {
      assert.equal(tipoDeEvidenciaValido(kind), true);
      assert.equal(claveDelTipoDeEvidencia(kind), `productosAdmin.evidencia.${kind}`);
    }
    assert.equal(tipoDeEvidenciaValido('lo_que_sea'), false);
    assert.equal(
      claveDelTipoDeEvidencia(''),
      'productosAdmin.evidencia.desconocido',
    );
  });

  it('las dimensiones tienen su clave, y una inventada no revienta', () => {
    for (const dimension of DIMENSIONES_ORDENADAS) {
      assert.equal(
        claveDeLaDimension(dimension),
        `productosAdmin.dimension.${dimension}`,
      );
    }
    assert.equal(
      claveDeLaDimension('lo_que_sea'),
      'productosAdmin.dimension.desconocido',
    );
    // Y la cadena vacía, que es lo que manda el servidor si perdió la evidencia.
    assert.equal(claveDeLaDimension(''), 'productosAdmin.dimension.desconocido');
  });
});

describe('la lista: hay tope y se dice, porque no hay cursor', () => {
  it('los topes son los que el servidor admite', () => {
    assert.deepEqual([...LIMITES_DE_LA_LISTA], [50, 100, 200]);
    assert.equal(LIMITE_INICIAL, 50);
    assert.equal(LIMITE_MAXIMO, 200);
  });

  it('se sube hasta el máximo y ahí se para', () => {
    assert.equal(siguienteLimite(50), 100);
    assert.equal(siguienteLimite(100), 200);
    assert.equal(siguienteLimite(200), null);
    assert.equal(siguienteLimite(999), null);
  });

  it('tantos resultados como el tope significa que puede haber más', () => {
    assert.equal(llegoAlTope(50, 50), true);
    assert.equal(llegoAlTope(49, 50), false);
  });

  it('un tope imposible se corrige a uno que el servidor acepte', () => {
    assert.equal(limiteValido(undefined), LIMITE_INICIAL);
    assert.equal(limiteValido(Number.NaN), LIMITE_INICIAL);
    assert.equal(limiteValido(0), 1);
    assert.equal(limiteValido(5_000), LIMITE_MAXIMO);
    assert.equal(limiteValido(77.9), 77);
  });

  it('la cola siempre lleva el tope, y lo vacío no viaja', () => {
    assert.equal(cadenaDeFiltros(), `limit=${LIMITE_INICIAL}`);
    assert.equal(cadenaDeFiltros({ estado: 'approved', limite: 100 }), 'limit=100&estado=approved');
    assert.equal(cadenaDeFiltros({ estado: '   ' }), 'limit=50');
    assert.equal(cadenaDeFiltros({ estado: null }), 'limit=50');
    assert.equal(cadenaDeFiltros({ estado: 'a b&c' }), 'limit=50&estado=a%20b%26c');
  });

  it('las pantallas avisan del tope en vez de fingir que están todos', () => {
    for (const [nombre, codigo] of PANTALLAS) {
      if (nombre === 'EvaluarProductoScreen.tsx') continue;
      assert.ok(codigo.includes('productosAdmin.tope'), nombre);
      assert.ok(codigo.includes('productosAdmin.verMas'), nombre);
    }
  });
});

describe('el 401, el 403, el 404, el 409 y el 503 no son lo mismo', () => {
  it('cada estado tiene su propio fallo', () => {
    assert.equal(falloDeCarga(401, null), 'sinSesion');
    assert.equal(falloDeCarga(403, null), 'sinPermiso');
    assert.equal(falloDeCarga(404, null), 'noEncontrada');
    assert.equal(falloDeCarga(422, null), 'datosInvalidos');
    assert.equal(falloDeCarga(503, null), 'noDisponible');
    assert.equal(falloDeCarga(500, null), 'red');
    assert.equal(falloDeCarga(null, null), 'red');
  });

  it('«es tu propio producto» NO es el mismo 403 que «no eres curaduría»', () => {
    assert.equal(falloDeCarga(403, 'product_self_review_forbidden'), 'esTuProducto');
    assert.equal(
      falloDeCarga(403, 'seller_application_self_review_forbidden'),
      'esTuProducto',
    );
    assert.equal(falloDeCarga(403, 'product_review_forbidden'), 'sinPermiso');
    assert.notEqual(
      falloDeCarga(403, 'product_self_review_forbidden'),
      falloDeCarga(403, 'product_review_forbidden'),
    );
    assert.equal(esAutoevaluacion('product_self_review_forbidden'), true);
    assert.equal(esAutoevaluacion('product_review_forbidden'), false);
    assert.equal(esAutoevaluacion(null), false);
  });

  it('«nadie evalúa lo suyo» tiene su propio texto y no se reintenta', () => {
    assert.equal(claveDelFallo('esTuProducto'), 'productosAdmin.fallo.esTuProducto');
    assert.equal(
      claveDelCuerpoDelFallo('esTuProducto'),
      'productosAdmin.falloCuerpo.esTuProducto',
    );
    assert.equal(seReintenta('esTuProducto'), false);
    assert.equal(
      claveDeErrorDeProductos('product_self_review_forbidden'),
      'productosAdmin.error.product_self_review_forbidden',
    );
  });

  it('las migraciones sin aplicar mandan sobre el estado HTTP', () => {
    assert.equal(falloDeCarga(403, 'product_admission_not_available'), 'noDisponible');
    assert.equal(esNoDisponible('products_not_available'), true);
    assert.equal(esNoDisponible('product_evaluation_not_available'), true);
    assert.equal(esNoDisponible('lo_que_sea'), false);
  });

  it('un corte de red se dice corte de red, y se reintenta', () => {
    assert.equal(falloDeCarga(0, 'network_error'), 'sinConexion');
    assert.equal(falloDeCarga(0, 'timeout'), 'sinConexion');
    assert.equal(seReintenta('sinConexion'), true);
    assert.equal(seReintenta('red'), true);
  });

  it('un permiso denegado no se reintenta: reintentarlo no cambia nada', () => {
    for (const fallo of [
      'sinPermiso',
      'sinSesion',
      'noDisponible',
      'noEncontrada',
      'datosInvalidos',
      'esTuProducto',
    ]) {
      assert.equal(seReintenta(fallo), false, fallo);
    }
  });

  it('cada fallo tiene titular y explicación, y lo raro cae en desconocido', () => {
    for (const fallo of [
      'sinSesion',
      'sinPermiso',
      'esTuProducto',
      'noDisponible',
      'noEncontrada',
      'datosInvalidos',
    ]) {
      assert.equal(claveDelFallo(fallo), `productosAdmin.fallo.${fallo}`);
      assert.equal(
        claveDelCuerpoDelFallo(fallo),
        `productosAdmin.falloCuerpo.${fallo}`,
      );
    }
    assert.equal(claveDelFallo('red'), 'productosAdmin.fallo.desconocido');
    assert.equal(
      claveDelCuerpoDelFallo('lo_que_sea'),
      'productosAdmin.falloCuerpo.desconocido',
    );
  });

  it('un conflicto es «alguien se adelantó», no un error seco', () => {
    assert.equal(esConflicto('product_changed'), true);
    assert.equal(esConflicto('seller_application_changed'), true);
    assert.equal(esConflicto('product_evaluation_closed'), true);
    assert.equal(esConflicto('lo_que_sea'), false);
    assert.equal(esConflicto(null), false);
  });

  it('TODOS los códigos del servidor están traducidos', () => {
    // Se leen del propio servidor: si alguien añade uno nuevo, esto lo dice.
    const codigos = new Set<string>();
    for (const fichero of [
      'applications.py',
      'evaluations.py',
      'permissions.py',
      'service.py',
      'states.py',
      'esquema.py',
      'router.py',
      'catalog.py',
      // Los tres del Incremento 4. Sin ellos, un código nuevo de fotografías,
      // inventario o carrito podría salir a producción sin texto.
      'media.py',
      'inventory.py',
      'carts.py',
      // Los del Incremento 6, que faltaban: sin ellos un codigo nuevo de
      // envios podia salir sin texto aunque `envios.ts` ya se leyera abajo.
      'envios.py',
      'estados_de_envio.py',
      // Los del Incremento 7. `estados_de_incidencia.py` va aparte porque los
      // tres codigos de transicion viven en la maquina, no en el servicio.
      'incidencias.py',
      'estados_de_incidencia.py',
      // El del Incremento 8. Sin el, un codigo nuevo de valoraciones podia
      // salir a produccion sin texto detras.
      'resenas.py',
      // Y los dos del Incremento 9. Aqui pesa mas que en ningun otro sitio:
      // un codigo de dinero sin texto deja a quien vende leyendo el mensaje
      // crudo del servidor en castellano, sea cual sea su idioma.
      'finanzas.py',
      'devoluciones.py',
    ]) {
      let texto = '';
      try {
        texto = delServidor(fichero);
      } catch {
        continue;
      }
      for (const m of texto.matchAll(/code\s*=\s*"([a-z_0-9]+)"/g)) {
        const codigo = m[1];
        if (codigo.startsWith('product') || codigo.startsWith('seller')) {
          codigos.add(codigo);
        }
      }
    }
    assert.ok(codigos.size > 40, `solo se leyeron ${codigos.size} códigos`);
    // CUALQUIERA DE LOS CUATRO TRADUCTORES vale: lo que no puede pasar es que
    // un código llegue a una pantalla sin ningún texto detrás. Cada módulo del
    // Incremento 4 traduce lo suyo, y el del catálogo además conoce las puertas
    // de esquema, que se pueden ver desde cualquier sitio.
    //
    // Los cinco se leen DEL CÓDIGO y no se importan: `carrito.ts` importa
    // valores por el alias `@/`, que el ejecutor de Node no resuelve. Leer el
    // fichero comprueba lo mismo —que el código está en su tabla— sin arrastrar
    // un resolutor a esta prueba.
    const enLosNuevos = new Set<string>();
    for (const modulo of [
      'carrito.ts',
      'inventario.ts',
      'fotosDeProducto.ts',
      'pedidos.ts',
      'envios.ts',
      'incidencias.ts',
      'resenasDeProductos.ts',
      'finanzasDeProductos.ts',
    ]) {
      for (const m of fuente('lib', modulo).matchAll(
        /^\s{2}([a-z_0-9]+):\s*'[^']+',$/gm,
      )) {
        enLosNuevos.add(m[1] as string);
      }
    }
    assert.ok(enLosNuevos.size > 15, `solo ${enLosNuevos.size} en los nuevos`);
    const sinTraducir = [...codigos].filter(
      (codigo) =>
        claveDeErrorDeProductos(codigo) === null && !enLosNuevos.has(codigo),
    );
    assert.deepEqual(
      sinTraducir,
      [],
      `códigos del servidor sin traducir: ${sinTraducir.join(', ')}`,
    );
  });

  it('los bloqueos de la evaluación se traducen con su propio prefijo', () => {
    for (const bloqueo of BLOQUEOS_DE_EVALUACION) {
      assert.equal(
        claveDelBloqueoDeEvaluacion(bloqueo),
        `productosAdmin.bloqueoEvaluacion.${bloqueo}`,
      );
    }
    assert.equal(
      claveDelBloqueoDeEvaluacion('algo_nuevo'),
      'productosAdmin.bloqueoEvaluacion.desconocido',
    );
    assert.equal(claveDelBloqueoDeEvaluacion(null), null);
    assert.equal(claveDelBloqueoDeEvaluacion('  '), null);
  });

  it('un código que no se conoce deja hablar al servidor', () => {
    assert.equal(claveDeErrorDeProductos('lo_que_sea'), null);
    assert.equal(claveDeErrorDeProductos(null), null);
    assert.equal(claveDeErrorDeProductos(undefined), null);
    assert.ok(CODIGOS_TRADUCIDOS.length > 50);
  });
});

describe('el módulo entero aguanta basura sin lanzar y sin inventarse nada', () => {
  it('ninguna función lanza con entradas de cualquier tipo', () => {
    for (const entrada of BASURA) {
      assert.doesNotThrow(() => {
        claveDelEstadoDeProducto(entrada as string);
        claveDelEstadoDePostulacion(entrada as string);
        claveDeLaDimension(entrada as string);
        claveDeLaFallaCritica(entrada as string);
        claveDelTipoDeEvidencia(entrada as string);
        claveDelDocumento(entrada as string);
        claveDeLaDecision(entrada as string);
        claveDelFallo(entrada as string);
        claveDelCuerpoDelFallo(entrada as string);
        claveDeErrorDeProductos(entrada as string);
        claveDelBloqueoDeEvaluacion(entrada as string);
        claveDelBloqueoDePublicacion({ bloqueo: entrada as string });
        dimensionValida(entrada as string);
        fallaCriticaValida(entrada as string);
        fallaQueViaja(entrada as string);
        tipoDeEvidenciaValido(entrada as string);
        puntuacionDeDimensionValida(entrada);
        puntuacionLegible(entrada as number);
        revisarPuntuacion(entrada as string);
        soloDigitos(entrada as string);
        revisarMotivo(true, entrada as string);
        revisarResumenDeEvidencia(entrada as string);
        rutaValida(entrada as string);
        tonoDelEstado(entrada as string);
        enCatalogo(entrada as string);
        evaluacionAbierta(entrada as string);
        esConflicto(entrada as string);
        esAutoevaluacion(entrada as string);
        esNoDisponible(entrada as string);
        esAprobadoConCondiciones(entrada as string);
        esDecisionCondicionada(entrada as string);
        sePuedeTomar(entrada as string);
        sePuedeDecidirPostulacion(entrada as string);
        transicionExigeMotivo(entrada as string);
        seReintenta(entrada as string);
        limiteValido(entrada as number);
        abreviarIdentificador(entrada as string);
        cadenaDeFiltros({ estado: entrada as string });
      }, String(entrada));
    }
  });

  it('`previsualizarDecision` nunca devuelve un total sin las seis dimensiones', () => {
    const combinaciones = [
      { scores: [], evidence: [] },
      { scores: todas(90).slice(0, 1), evidence: evidenciaCompleta() },
      { scores: todas(90).slice(0, 5), evidence: evidenciaCompleta() },
      { scores: todas(90), evidence: [] },
      { scores: null, evidence: null },
      {},
    ];
    for (const evaluacion of combinaciones) {
      const vista = previsualizarDecision(evaluacion);
      assert.notEqual(vista.estado, 'listo', JSON.stringify(evaluacion));
      assert.ok(!('total' in vista) || vista.total === null);
    }
  });

  it('las referencias internas no se convierten en nombres inventados', () => {
    assert.equal(
      abreviarIdentificador('0f2b7c91-4d3a-4a1e-9f11-9c2d5b7a8e01'),
      '0f2b7c91…',
    );
    assert.equal(abreviarIdentificador('abc'), 'abc');
    assert.equal(abreviarIdentificador(''), null);
    assert.equal(abreviarIdentificador(null), null);
    assert.equal(LARGO_DE_LA_REFERENCIA, 8);
  });

  it('el módulo no exporta nada financiero', () => {
    const exportadas = [...MODULO.matchAll(/export (?:function|const) (\w+)/g)].map((m) =>
      m[1].toLowerCase(),
    );
    assert.ok(exportadas.length > 40, 'el módulo debería exportar bastante');
    for (const nombre of exportadas) {
      for (const palabra of ['saldo', 'payout', 'transfer', 'refund', 'precio', 'price']) {
        assert.ok(!nombre.includes(palabra), `«${nombre}» suena a dinero`);
      }
    }
  });
});
