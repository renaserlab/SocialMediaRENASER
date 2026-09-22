/**
 * Las reglas de las reseñas de producto, ejecutadas.
 *
 * Las que más importan son cuatro, y las cuatro se pueden romper sin que se
 * note mirando la aplicación:
 *
 *  1. `null` convertido en cero. Un producto sin reseñas enseñado como «0,0»
 *     con cinco estrellas vacías dice que está mal valorado; lo cierto es que
 *     todavía no lo ha valorado nadie. Igual con el porcentaje que recomienda
 *     y con cada eje por separado.
 *  2. El sello inventado. «Compra verificada» lo afirma el servidor en
 *     `compra_verificada`; deducirlo del hecho de que la reseña exista es
 *     ponerle un sello a un dato que no se ha comprobado.
 *  3. La puntuación ajustada calculada aquí. La fórmula vive en el servidor,
 *     que es quien sabe cuántas reseñas hay y de dónde sale el promedio de
 *     referencia; repetirla daría dos verdades que se separan.
 *  4. El cuerpo de la petición llevando el producto, el pedido o una fecha.
 *     Todo eso lo pone el servidor: si lo mandara el formulario, «compra
 *     verificada» sería un campo que se rellena.
 *
 * Las que no son funciones —lo que está escrito en las pantallas— se comprueban
 * sobre el código fuente.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { en } from '../i18n/en.ts';
import { es } from '../i18n/es.ts';
import { pt } from '../i18n/pt.ts';
import {
  EJES,
  ESTRELLAS,
  LARGO_MAXIMO_DEL_COMENTARIO,
  LARGO_MAXIMO_DE_LA_RESPUESTA,
  MOTIVOS_PARA_RESENAR,
  POR_PAGINA,
  PUNTUACIONES,
  ajustadaLegible,
  anchoDeBarra,
  borradorVacio,
  claveDeErrorDeResena,
  claveDelEje,
  claveDelMotivoParaResenar,
  comentarioParaEnviar,
  compraVerificada,
  comprasVerificadas,
  cuerpoDeResena,
  cursorDeLaPagina,
  ejesDelResumen,
  esResenasApagadas,
  estaEscondida,
  fusionarPaginas,
  hayMasPaginas,
  hayValoraciones,
  histogramaOrdenado,
  largoDelComentario,
  lineasPendientes,
  lineasYaValoradas,
  motivoDelRechazo,
  motivoParaNoEnviar,
  porcentajeLegible,
  porcentajeQueRecomienda,
  promedioLegible,
  proporcionDeBarra,
  puedeEditar,
  puedeOfrecerResponder,
  puntuacionValida,
  respuestaParaEnviar,
  sePuedeEnviar,
  sePuedeOfrecerValorar,
  tieneRespuesta,
  usaReferenciaPorDefecto,
  valorDelEje,
} from './resenasDeProductos.ts';

const RAIZ = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function fuente(...partes: string[]): string {
  return readFileSync(join(RAIZ, ...partes), 'utf8');
}

const DICCIONARIOS: Array<Record<string, string>> = [
  es as unknown as Record<string, string>,
  en as unknown as Record<string, string>,
  pt as unknown as Record<string, string>,
];

/** Las pantallas del Incremento 8, para comprobar sus textos. */
const PANTALLAS = [
  'ValorarCompraScreen.tsx',
  'ResenasDelProductoScreen.tsx',
  'MiResenaDeProductoScreen.tsx',
  'ResenasDeMiTiendaScreen.tsx',
  'ModerarResenasDeProductosScreen.tsx',
];

const LLENO = {
  product_id: 'p1',
  total: 4,
  average: 4.25,
  adjusted: 4.21,
  distribution: { cinco: 2, cuatro: 1, tres: 1, dos: 0, uno: 0 },
  recommend_bps: 7500,
  quality: 4.5,
  fidelity: 4,
  functioning: 4.25,
  value_for_money: 3.5,
  category_average: 4.2,
  category_configured: false,
};

const VACIO = {
  product_id: 'p2',
  total: 0,
  average: null,
  adjusted: null,
  distribution: { uno: 0, dos: 0, tres: 0, cuatro: 0, cinco: 0 },
  recommend_bps: null,
  quality: null,
  fidelity: null,
  functioning: null,
  value_for_money: null,
  category_average: 4.2,
  category_configured: false,
};

// ========================================================================== //
// 1. Sin reseñas no hay puntuación, y no hay un cero
// ========================================================================== //
describe('sin reseñas no se inventa un cero', () => {
  it('no hay valoraciones con total 0', () => {
    assert.equal(hayValoraciones(VACIO), false);
    assert.equal(hayValoraciones(LLENO), true);
    assert.equal(hayValoraciones(null), false);
    assert.equal(hayValoraciones(undefined), false);
  });

  it('el promedio y la ajustada son null, nunca «0.0»', () => {
    assert.equal(promedioLegible(VACIO), null);
    assert.equal(ajustadaLegible(VACIO), null);
    assert.equal(promedioLegible(LLENO), '4.3');
    assert.equal(ajustadaLegible(LLENO), '4.2');
  });

  it('un promedio que llega con total 0 tampoco se enseña', () => {
    // Defensa contra un servidor que mandara una media residual: una media
    // sobre cero opiniones no es una media.
    const raro = { ...VACIO, average: 4.2, adjusted: 4.2 };
    assert.equal(promedioLegible(raro), null);
    assert.equal(ajustadaLegible(raro), null);
  });

  it('el histograma está vacío, no en cinco barras a cero', () => {
    assert.deepEqual(histogramaOrdenado(VACIO), []);
    const barras = histogramaOrdenado(LLENO);
    assert.equal(barras.length, 5);
    assert.deepEqual(
      barras.map((b) => b.puntuacion),
      [...PUNTUACIONES],
    );
    assert.equal(barras[0].cuantas, 2);
  });

  it('el porcentaje que recomienda es null y no «0%»', () => {
    assert.equal(porcentajeQueRecomienda(null), null);
    assert.equal(porcentajeLegible(null), null);
    assert.equal(porcentajeLegible(7500), '75%');
    // Y un 0 de verdad SÍ es un 0: nadie lo recomienda.
    assert.equal(porcentajeLegible(0), '0%');
  });

  it('cada eje es null por separado cuando no hay nada', () => {
    for (const eje of EJES) {
      assert.equal(valorDelEje(VACIO, eje), null);
    }
    assert.equal(valorDelEje(LLENO, 'quality'), 4.5);
    assert.equal(valorDelEje(LLENO, 'inventado'), null);
  });

  it('los cuatro ejes salen en orden y con su clave', () => {
    const ejes = ejesDelResumen(LLENO);
    assert.deepEqual(
      ejes.map((e) => e.eje),
      [...EJES],
    );
    assert.equal(ejes[0].clave, 'resenaDeProducto.eje.quality');
  });

  it('las compras verificadas son el total, y sin reseñas son cero', () => {
    assert.equal(comprasVerificadas(LLENO), 4);
    assert.equal(comprasVerificadas(VACIO), 0);
  });
});

// ========================================================================== //
// 2. La puntuación ajustada NO se calcula aquí
// ========================================================================== //
describe('la fórmula vive en el servidor', () => {
  it('no hay ninguna función que la calcule', () => {
    const codigo = fuente('lib', 'resenasDeProductos.ts');
    // Los dos números de la fórmula del blueprint no pueden aparecer en una
    // cuenta: si aparecen, alguien la copió y habrá dos verdades.
    assert.ok(!/\/\s*\(\s*\w+\s*\+\s*10\s*\)/.test(codigo));
    assert.ok(!codigo.includes('* 4.2'));
  });

  it('dice si el previo es la referencia por defecto', () => {
    assert.equal(usaReferenciaPorDefecto(LLENO), true);
    assert.equal(usaReferenciaPorDefecto({ ...LLENO, category_configured: true }), false);
    // Sin reseñas no se dice nada: no hay ninguna puntuación que explicar.
    assert.equal(usaReferenciaPorDefecto(VACIO), false);
  });
});

// ========================================================================== //
// 3. El sello no se deduce
// ========================================================================== //
describe('compra verificada', () => {
  it('sale del campo del servidor y solo con true', () => {
    assert.equal(compraVerificada({ id: 'r', created_at: 'x', compra_verificada: true }), true);
    assert.equal(compraVerificada({ id: 'r', created_at: 'x' }), false);
    assert.equal(
      compraVerificada({ id: 'r', created_at: 'x', compra_verificada: false }),
      false,
    );
    assert.equal(compraVerificada(null), false);
  });

  it('no existe ninguna función que lo invente', () => {
    const codigo = fuente('lib', 'resenasDeProductos.ts');
    assert.ok(!/compra_verificada\s*=\s*true/.test(codigo));
    assert.ok(!/verified/.test(codigo));
  });
});

// ========================================================================== //
// 4. El formulario
// ========================================================================== //
describe('el borrador', () => {
  it('nace vacío y no se puede enviar', () => {
    const borrador = borradorVacio();
    assert.equal(sePuedeEnviar(borrador), false);
    assert.equal(motivoParaNoEnviar(borrador), 'resenaDeProducto.falta.general');
  });

  it('pide las cinco puntuaciones y la recomendación', () => {
    const borrador = { ...borradorVacio(), overall: 5 };
    assert.equal(motivoParaNoEnviar(borrador), 'resenaDeProducto.falta.quality');
    const casi = {
      overall: 5,
      quality: 5,
      fidelity: 4,
      functioning: 5,
      value_for_money: 3,
      recommends: null,
      comment: '',
    };
    assert.equal(motivoParaNoEnviar(casi), 'resenaDeProducto.falta.recomienda');
    assert.equal(sePuedeEnviar({ ...casi, recommends: false }), true);
  });

  it('una puntuación fuera de rango no vale', () => {
    assert.equal(puntuacionValida(0), false);
    assert.equal(puntuacionValida(6), false);
    assert.equal(puntuacionValida(3.5), false);
    assert.equal(puntuacionValida('4'), false);
    for (const n of ESTRELLAS) assert.equal(puntuacionValida(n), true);
  });

  it('el comentario es opcional y se recorta', () => {
    assert.equal(comentarioParaEnviar('   '), null);
    assert.equal(comentarioParaEnviar(null), null);
    assert.equal(comentarioParaEnviar('  hola  '), 'hola');
    const largo = 'a'.repeat(LARGO_MAXIMO_DEL_COMENTARIO + 50);
    assert.equal(comentarioParaEnviar(largo)?.length, LARGO_MAXIMO_DEL_COMENTARIO);
    assert.equal(largoDelComentario('  hola  '), 4);
  });

  it('el cuerpo NO lleva el producto, el pedido ni ninguna fecha', () => {
    const cuerpo = cuerpoDeResena({
      overall: 5,
      quality: 4,
      fidelity: 4,
      functioning: 5,
      value_for_money: 3,
      recommends: true,
      comment: 'Bien.',
    });
    assert.deepEqual(Object.keys(cuerpo).sort(), [
      'comment',
      'fidelity',
      'functioning',
      'overall',
      'quality',
      'recommends',
      'value_for_money',
    ]);
    for (const prohibido of [
      'product_id',
      'order_id',
      'order_item_id',
      'delivered_at',
      'order_paid_at',
      'compra_verificada',
    ]) {
      assert.ok(!(prohibido in cuerpo), prohibido);
    }
  });

  it('un borrador incompleto no produce cuerpo', () => {
    assert.throws(() => cuerpoDeResena(borradorVacio()));
  });
});

// ========================================================================== //
// 5. Qué se le ofrece a quién
// ========================================================================== //
describe('los botones no se los inventa la pantalla', () => {
  const visible = { id: 'r1', created_at: 'x' };
  const conRespuesta = { id: 'r2', created_at: 'x', reply: { id: 'a', body: 'b' } };
  const escondida = { id: 'r3', created_at: 'x', status: 'hidden' };

  it('responder solo si no está escondida y no tiene respuesta', () => {
    assert.equal(puedeOfrecerResponder(visible), true);
    assert.equal(puedeOfrecerResponder(conRespuesta), false);
    assert.equal(puedeOfrecerResponder(escondida), false);
    assert.equal(puedeOfrecerResponder(null), false);
  });

  it('editar solo la que no está escondida', () => {
    assert.equal(puedeEditar(visible), true);
    assert.equal(puedeEditar(escondida), false);
    assert.equal(puedeEditar(null), false);
  });

  it('tieneRespuesta y estaEscondida miran el campo, no lo deducen', () => {
    assert.equal(tieneRespuesta(conRespuesta), true);
    assert.equal(tieneRespuesta(visible), false);
    assert.equal(estaEscondida(escondida), true);
    assert.equal(estaEscondida(visible), false);
  });

  it('valorar solo si queda alguna línea pendiente', () => {
    const lineas = [
      {
        order_item_id: 'a',
        order_id: 'o',
        product_id: 'p',
        name: 'Uno',
        quantity: 1,
        delivered_at: 'x',
        can_review: true,
      },
      {
        order_item_id: 'b',
        order_id: 'o',
        product_id: 'p',
        name: 'Dos',
        quantity: 1,
        delivered_at: 'x',
        can_review: false,
        review_id: 'r',
      },
    ];
    assert.equal(sePuedeOfrecerValorar(lineas), true);
    assert.equal(lineasPendientes(lineas).length, 1);
    assert.equal(lineasYaValoradas(lineas).length, 1);
    assert.equal(sePuedeOfrecerValorar([lineas[1]]), false);
    assert.equal(sePuedeOfrecerValorar([]), false);
    assert.equal(sePuedeOfrecerValorar(null), false);
  });
});

// ========================================================================== //
// 6. Paginación
// ========================================================================== //
describe('la paginación', () => {
  const pagina = Array.from({ length: POR_PAGINA }, (_, i) => ({
    id: `r${i}`,
    created_at: `2026-09-2${i % 10}T00:00:00Z`,
  }));

  it('el cursor son las dos partes, o ninguna', () => {
    const cursor = cursorDeLaPagina(pagina);
    assert.ok(cursor);
    assert.equal(cursor?.before_id, pagina[pagina.length - 1].id);
    assert.equal(cursorDeLaPagina(pagina.slice(0, 3)), null);
    assert.equal(cursorDeLaPagina([]), null);
  });

  it('no pide más cuando la página vino corta', () => {
    assert.equal(hayMasPaginas(POR_PAGINA), true);
    assert.equal(hayMasPaginas(3), false);
  });

  it('fusionar no repite', () => {
    const juntas = fusionarPaginas(
      [{ id: 'a' }, { id: 'b' }],
      [{ id: 'b' }, { id: 'c' }],
    );
    assert.deepEqual(
      juntas.map((x) => x.id),
      ['a', 'b', 'c'],
    );
  });

  it('las barras no se pasan de 1', () => {
    assert.equal(proporcionDeBarra(5, 4), 1);
    assert.equal(proporcionDeBarra(0, 4), 0);
    assert.equal(proporcionDeBarra(2, 0), 0);
    assert.equal(anchoDeBarra(1, 4), '25%');
  });
});

// ========================================================================== //
// 7. Los errores, y la paridad de idiomas
// ========================================================================== //
describe('lo que dice el servidor se traduce', () => {
  it('cada código tiene su clave', () => {
    assert.equal(
      claveDeErrorDeResena('product_review_already_exists'),
      'resenaDeProducto.error.product_review_already_exists',
    );
    assert.equal(claveDeErrorDeResena('lo_que_sea'), 'resenaDeProducto.error.desconocido');
    assert.equal(claveDeErrorDeResena(null), 'resenaDeProducto.error.desconocido');
  });

  it('reconoce las reseñas apagadas', () => {
    assert.equal(esResenasApagadas('product_reviews_not_available'), true);
    assert.equal(esResenasApagadas('otra_cosa'), false);
  });

  it('el motivo de un 409 sale del detalle', () => {
    assert.equal(
      motivoDelRechazo({ reason: 'not_delivered' }),
      'resenaDeProducto.motivo.not_delivered',
    );
    assert.equal(motivoDelRechazo({ reason: 'inventado' }), 'resenaDeProducto.motivo.desconocido');
    assert.equal(motivoDelRechazo(null), null);
    assert.equal(motivoDelRechazo({}), null);
  });

  it('cada motivo y cada eje tienen texto en los tres idiomas', () => {
    for (const diccionario of DICCIONARIOS) {
      for (const motivo of [...MOTIVOS_PARA_RESENAR, 'desconocido']) {
        assert.ok(`resenaDeProducto.motivo.${motivo}` in diccionario, motivo);
      }
      for (const eje of [...EJES, 'desconocido']) {
        assert.ok(`resenaDeProducto.eje.${eje}` in diccionario, eje);
      }
      assert.ok('resenaDeProducto.error.desconocido' in diccionario);
    }
  });

  it('los tres diccionarios tienen EXACTAMENTE las mismas claves', () => {
    // PARIDAD DE VERDAD, no «que no falte ninguna»: una clave de más en un
    // idioma es texto que nadie ve y que nadie va a mantener.
    const claves = DICCIONARIOS.map((d) =>
      Object.keys(d)
        .filter((k) => k.startsWith('resenaDeProducto.'))
        .sort(),
    );
    assert.ok(claves[0].length > 0, 'el espacio resenaDeProducto está vacío');
    assert.deepEqual(claves[1], claves[0]);
    assert.deepEqual(claves[2], claves[0]);
  });

  it('todo el texto de las pantallas pasa por el diccionario', () => {
    for (const pantalla of PANTALLAS) {
      const codigo = fuente('screens', pantalla);
      const usadas = [...codigo.matchAll(/t\('(resenaDeProducto\.[^']+)'\)/g)].map(
        (m) => m[1],
      );
      for (const diccionario of DICCIONARIOS) {
        const faltan = usadas.filter((clave) => !(clave in diccionario));
        assert.deepEqual(faltan, [], `${pantalla}: ${faltan.join(', ')}`);
      }
    }
  });
});

// ========================================================================== //
// 8. Lo que está escrito en las pantallas
// ========================================================================== //
describe('las pantallas no prometen lo que no hay', () => {
  it('el repositorio no tiene ningún método que mueva dinero', () => {
    const codigo = fuente('repositories', 'ProductReviewRepository.ts');
    for (const prohibido of ['reembols', 'refund', 'transfer', 'payout', 'saldo']) {
      assert.ok(!codigo.toLowerCase().includes(prohibido), prohibido);
    }
  });

  it('el repositorio no manda el sello ni la fecha de entrega', () => {
    // SE MIRA LO QUE SE ENVIA, no el fichero entero: los tipos de LECTURA si
    // nombran product_id, porque el servidor lo devuelve. Lo que no puede
    // pasar es que salga en un cuerpo de peticion.
    const codigo = fuente('repositories', 'ProductReviewRepository.ts');
    const cuerpos = [...codigo.matchAll(/JSON\.stringify\(([^;]*?)\)/g)].map(
      (m) => m[1] as string,
    );
    assert.ok(cuerpos.length >= 4, `solo ${cuerpos.length} cuerpos`);
    for (const cuerpo of cuerpos) {
      for (const prohibido of [
        'compra_verificada',
        'delivered_at',
        'order_paid_at',
        'product_id',
        'order_id',
        'order_item_id',
      ]) {
        assert.ok(!cuerpo.includes(prohibido), `${prohibido} en ${cuerpo}`);
      }
    }
  });

  it('la respuesta del proveedor se recorta al tope del servidor', () => {
    assert.equal(respuestaParaEnviar('  '), null);
    assert.equal(respuestaParaEnviar(' hola '), 'hola');
    const largo = 'b'.repeat(LARGO_MAXIMO_DE_LA_RESPUESTA + 10);
    assert.equal(respuestaParaEnviar(largo)?.length, LARGO_MAXIMO_DE_LA_RESPUESTA);
  });

  it('claveDelMotivoParaResenar solo devuelve claves conocidas', () => {
    for (const motivo of MOTIVOS_PARA_RESENAR) {
      assert.equal(claveDelMotivoParaResenar(motivo), `resenaDeProducto.motivo.${motivo}`);
    }
    assert.equal(claveDelMotivoParaResenar('xx'), 'resenaDeProducto.motivo.desconocido');
    assert.equal(claveDelEje('xx'), 'resenaDeProducto.eje.desconocido');
  });
});
