/**
 * El catálogo de Productos Z, ejecutado.
 *
 * Lo que se prueba aquí es, casi entero, LO QUE NO SE PUEDE DECIR. La cabecera
 * de `products/catalog.py` enumera lo que el servidor deliberadamente no manda,
 * y la forma en que eso se rompe no es un error de compilación: es una pantalla
 * que se ve perfecta y afirma cosas que nadie ha comprobado.
 *
 *  1. UNA MEDIA DE ESTRELLAS. `rating` viaja `null` porque no hay reseñas de
 *     productos. Un «4,8 ★» pintado aquí es una recomendación de compra que Z
 *     no ha hecho, y la referencia visual la trae, así que la tentación está
 *     escrita en el diseño. Ninguna función puede producir una media, y el
 *     bloque tiene que quedarse FUERA.
 *  2. UN NÚMERO DE COMPRAS VERIFICADAS. No hay pedidos físicos: no se puede
 *     contar ninguna. La referencia dice «184 compras verificadas».
 *  3. UN PLAZO O UNA CONDICIÓN DE DEVOLUCIÓN. `delivery` viaja `null` porque no
 *     hay transportista, ni cobertura, ni condiciones aprobadas. La referencia
 *     dice «3 días para reportar una incidencia».
 *  4. UN BOTÓN DE COMPRAR. `purchasable` es hoy siempre `false` y en la API no
 *     hay carrito, checkout ni pedido. La referencia pone «Comprar» en una
 *     barra fija negra: es la diferencia más visible y la que más cuesta.
 *  5. UN PRECIO CON UNA MONEDA SUPUESTA. Sin `currency` no hay importe, y sin
 *     `price_minor` tampoco: «49.90» sin moneda vale tres precios distintos.
 *  6. UN TÍTULO QUE DICE «PARA TI» SIN RECOMENDADOR. El contrato manda
 *     `personalized: false` justo para que el título sea el honesto.
 *
 * Las que no son funciones —el orden de los quince bloques, los textos en duro,
 * el lenguaje prohibido— se comprueban sobre el CÓDIGO de las pantallas y sobre
 * los diccionarios, porque ahí es donde viven.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { es } from '../i18n/es.ts';
import { en } from '../i18n/en.ts';
import { pt } from '../i18n/pt.ts';
import {
  ACCIONES_DE_LA_FICHA,
  BLOQUES_CON_TITULO,
  BLOQUES_DE_LA_FICHA,
  CLAVE_SIN_PRECIO,
  COLUMNAS_MAXIMAS,
  CONFIANZAS_CONOCIDAS,
  DECISIONES,
  DIMENSIONES,
  IMAGENES_FIRMABLES,
  LARGO_MINIMO_DE_LA_BUSQUEDA,
  MANIFIESTO,
  ORDEN_DE_DIMENSIONES,
  POR_BLOQUE,
  POR_PAGINA,
  RAZONES_EXIGIDAS,
  TIPOS_DE_EVIDENCIA,
  accionesDeLaFicha,
  bloqueConDatos,
  bloquesFuera,
  bloquesVisibles,
  catalogoDisponible,
  categoriasOfrecidas,
  claveDeAccion,
  claveDeConfianza,
  claveDeDecision,
  claveDeDimension,
  claveDeErrorDeProductos,
  claveDeErrorPorEstado,
  claveDeTipoDeEvidencia,
  claveDelBloque,
  claveDelBloqueFuera,
  claveDelBloquePersonal,
  claveDelCuerpoDelBloquePersonal,
  clavesDeLaEvidenciaDeLaRazon,
  conGuardado,
  consultaUtil,
  contadorDeLaBolsa,
  cuantosGuardados,
  deltaDeLaVariante,
  esFaltaDeSesion,
  esGuardadosApagado,
  esInformeApagado,
  esProductosApagado,
  etiquetaDeVersion,
  fechaLegible,
  filasDelInforme,
  hayMasPaginas,
  hayPuntuacion,
  huellaCorta,
  iconoDeLaDimension,
  indicadorDeConfianza,
  momentoLegible,
  opcionesDeLaVariante,
  partesDelSello,
  portadaVacia,
  posicionEnLaGaleria,
  precioDeLaTarjeta,
  precioLegible,
  puntuacionLegible,
  razonesOrdenadas,
  seDejaFuera,
  sePuedeBuscar,
  sePuedeMostrarLaImagen,
  selloAbreInforme,
  textoDelManifiesto,
  unirPaginas,
  valorLiteral,
  type BloqueDeLaFicha,
  type Ficha,
  type Informe,
  type Portada,
  type TarjetaDeProducto,
} from './productos.ts';

const AQUI = fileURLToPath(new URL('.', import.meta.url));

function fuente(carpeta: string, nombre: string): string {
  return readFileSync(join(AQUI, '..', carpeta, nombre), 'utf8');
}

/** El código sin comentarios: lo que la pantalla HACE, no lo que explica. */
function sinComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((linea) => !linea.trim().startsWith('//'))
    .join('\n');
}

function tarjeta(campos: Partial<TarjetaDeProducto> = {}): TarjetaDeProducto {
  return {
    product_id: 'producto-1',
    name: 'Silla de madera',
    seller_id: 'vendedor-1',
    seller_name: 'Taller Aroma',
    price_minor: 4990,
    currency: 'PEN',
    image_path: 'productos/silla.jpg',
    trust: 'origin',
    trust_value: 'PE',
    saved: false,
    ...campos,
  };
}

function ficha(campos: Partial<Ficha> = {}): Ficha {
  return {
    product_id: 'producto-1',
    version_id: 'version-1',
    version: 'v1',
    name: 'Silla de madera',
    summary: null,
    description: null,
    materials: null,
    origin_country: null,
    manufacturer: null,
    price_minor: null,
    currency: null,
    content_sha256: 'abcdef0123456789abcdef',
    published_at: null,
    status: 'published',
    seller_id: 'vendedor-1',
    seller_name: 'Taller Aroma',
    seller_profile_id: 'perfil-1',
    gallery: [],
    variants: [],
    reasons: [],
    seal: 'Producto de Excelencia Z · Evaluado y aprobado por nuestro estándar',
    evaluation_id: null,
    rating: null,
    delivery: null,
    related: [],
    saved: false,
    purchasable: false,
    ...campos,
  };
}

function portada(campos: Partial<Portada> = {}): Portada {
  return {
    manifest: MANIFIESTO,
    seleccion: [],
    para_ti: [],
    personalized: false,
    creadores: [],
    disponible: true,
    ...campos,
  };
}

function informe(campos: Partial<Informe> = {}): Informe {
  return {
    evaluation_id: 'evaluacion-1',
    version_id: 'version-1',
    seal: 'Producto de Excelencia Z · Evaluado y aprobado por nuestro estándar',
    decision: 'approved',
    score_total: 9000,
    decided_at: '2026-03-01T10:00:00Z',
    dimensions: {},
    ...campos,
  };
}

/* ========================================================================== */
describe('el precio va con su moneda o no existe', () => {
  it('sin precio no se escribe un número: se dice que no está configurado', () => {
    assert.deepEqual(precioLegible(null, 'PEN'), { configurado: false });
    assert.deepEqual(precioLegible(undefined, 'PEN'), { configurado: false });
  });

  it('SIN MONEDA NO HAY IMPORTE, y no se supone ninguna', () => {
    // Suponer «S/» o «$» es escribir un precio que quien vende no puso, y en
    // tres monedas distintas significa tres cosas.
    const leido = precioLegible(4990, null);
    assert.deepEqual(leido, { configurado: false });
    for (const supuesta of ['S/', '$', 'PEN', 'USD', 'MXN', '€']) {
      assert.ok(!JSON.stringify(leido).includes(supuesta), supuesta);
    }
  });

  it('una moneda en blanco tampoco cuenta como moneda', () => {
    assert.deepEqual(precioLegible(4990, '   '), { configurado: false });
    assert.deepEqual(precioLegible(4990, ''), { configurado: false });
  });

  it('con las dos cosas, el importe lleva SU codigo de moneda', () => {
    assert.deepEqual(precioLegible(4990, 'PEN'), { configurado: true, texto: '49.90 PEN' });
    assert.deepEqual(precioLegible(4990, 'usd'), { configurado: true, texto: '49.90 USD' });
  });

  it('los céntimos se escriben siempre con dos cifras', () => {
    assert.equal((precioLegible(4900, 'PEN') as { texto: string }).texto, '49.00 PEN');
    assert.equal((precioLegible(4909, 'PEN') as { texto: string }).texto, '49.09 PEN');
    assert.equal((precioLegible(9, 'PEN') as { texto: string }).texto, '0.09 PEN');
  });

  it('un cero CON moneda es un precio de cero, no un precio sin poner', () => {
    // El contrato admite `price_minor: 0` (ge=0). Lo que significa «sin poner»
    // es `null`, y son dos respuestas distintas.
    assert.deepEqual(precioLegible(0, 'PEN'), { configurado: true, texto: '0.00 PEN' });
  });

  it('lo que no es un número no produce ningún precio', () => {
    assert.deepEqual(precioLegible(Number.NaN, 'PEN'), { configurado: false });
    assert.deepEqual(precioLegible(Number.POSITIVE_INFINITY, 'PEN'), { configurado: false });
  });

  it('la tarjeta de lista usa exactamente el mismo criterio', () => {
    assert.deepEqual(precioDeLaTarjeta(tarjeta()), { configurado: true, texto: '49.90 PEN' });
    assert.deepEqual(precioDeLaTarjeta(tarjeta({ currency: null })), { configurado: false });
    assert.deepEqual(precioDeLaTarjeta(tarjeta({ price_minor: null })), { configurado: false });
  });

  it('la clave de «sin precio» no habla de gratis ni de cero', () => {
    assert.equal(CLAVE_SIN_PRECIO, 'productos.sinPrecio');
    for (const prohibida of ['gratis', 'free', 'cero', 'zero', 'desde']) {
      assert.ok(!CLAVE_SIN_PRECIO.toLowerCase().includes(prohibida), prohibida);
    }
  });
});

/* ========================================================================== */
describe('el delta de una variante', () => {
  const conPrecio = ficha({ price_minor: 10_000, currency: 'PEN' });
  const variante = (delta: number) => ({
    id: 'variante-1',
    sku: 'SKU-1',
    name: 'Grande',
    options: {},
    price_delta_minor: delta,
  });

  it('un delta de cero no se enseña: parecería que cuesta aparte', () => {
    assert.deepEqual(deltaDeLaVariante(conPrecio, variante(0)), { configurado: false });
  });

  it('sumar lleva su signo, y restar el suyo', () => {
    assert.equal(
      (deltaDeLaVariante(conPrecio, variante(1500)) as { texto: string }).texto,
      '+15.00 PEN',
    );
    assert.equal(
      (deltaDeLaVariante(conPrecio, variante(-1500)) as { texto: string }).texto,
      '-15.00 PEN',
    );
  });

  it('sin moneda en la ficha, el delta tampoco es un importe', () => {
    assert.deepEqual(deltaDeLaVariante(ficha(), variante(1500)), { configurado: false });
  });

  it('las opciones se enseñan en crudo y ordenadas, sin interpretarlas', () => {
    assert.deepEqual(
      opcionesDeLaVariante({
        ...variante(0),
        options: { talla: 'L', color: 'nogal' },
      }),
      [
        ['color', 'nogal'],
        ['talla', 'L'],
      ],
    );
    assert.equal(valorLiteral(null), '');
    assert.equal(valorLiteral(3), '3');
    assert.equal(valorLiteral(true), 'true');
    assert.equal(valorLiteral({ a: 1 }), '{"a":1}');
  });
});

/* ========================================================================== */
describe('un solo indicador de confianza, y demostrable', () => {
  it('el origen sí: es el único que hoy se puede probar', () => {
    assert.deepEqual(indicadorDeConfianza(tarjeta()), { clase: 'origin', valor: 'PE' });
    assert.equal(claveDeConfianza('origin'), 'productos.confianza.origin');
  });

  it('«98 % lo recomienda» y «Garantía 3 años» NO se pintan', () => {
    // Están en la referencia visual, y ninguno existe: el primero necesita
    // reseñas y el segundo condiciones de garantía aprobadas. Un `trust` que no
    // conocemos se descarta en vez de repetirse sin leerlo.
    for (const inventado of ['recommendation', 'verified_purchases', 'warranty', 'rating']) {
      assert.equal(indicadorDeConfianza(tarjeta({ trust: inventado })), null, inventado);
      assert.equal(claveDeConfianza(inventado), null, inventado);
    }
  });

  it('sin valor no hay indicador, aunque venga la clase', () => {
    assert.equal(indicadorDeConfianza(tarjeta({ trust_value: null })), null);
    assert.equal(indicadorDeConfianza(tarjeta({ trust_value: '  ' })), null);
    assert.equal(indicadorDeConfianza(tarjeta({ trust: null })), null);
  });

  it('la lista de indicadores conocidos tiene UNO', () => {
    assert.deepEqual([...CONFIANZAS_CONOCIDAS], ['origin']);
  });

  it('ninguna clave de confianza habla de estrellas ni de compras', () => {
    for (const clase of CONFIANZAS_CONOCIDAS) {
      const clave = claveDeConfianza(clase) ?? '';
      for (const prohibida of ['estrella', 'star', 'rating', 'compra', 'purchase', 'recomienda']) {
        assert.ok(!clave.toLowerCase().includes(prohibida), `${clave} / ${prohibida}`);
      }
    }
  });
});

/* ========================================================================== */
describe('el título del segundo bloque es el honesto', () => {
  it('con `personalized: false` se llama «Nuevos en Z»', () => {
    assert.equal(claveDelBloquePersonal(false), 'productos.nuevosEnZ');
    assert.equal(claveDelCuerpoDelBloquePersonal(false), 'productos.nuevosEnZCuerpo');
  });

  it('y NO «Elegidos para ti»: no hay recomendador de productos', () => {
    const clave = claveDelBloquePersonal(false);
    for (const prohibida of ['paraTi', 'elegidos', 'forYou', 'recomend']) {
      assert.ok(!clave.toLowerCase().includes(prohibida.toLowerCase()), prohibida);
    }
  });

  it('el día que el servidor diga `true`, el título cambia solo', () => {
    assert.equal(claveDelBloquePersonal(true), 'productos.paraTi');
    assert.equal(claveDelCuerpoDelBloquePersonal(true), 'productos.paraTiCuerpo');
  });

  it('el manifiesto es el del servidor, y el nuestro solo de respaldo', () => {
    assert.equal(MANIFIESTO, 'No está todo. Está lo que merece estar.');
    assert.equal(textoDelManifiesto(portada({ manifest: 'Otro texto' })), 'Otro texto');
    assert.equal(textoDelManifiesto(portada({ manifest: '  ' })), MANIFIESTO);
    assert.equal(textoDelManifiesto(null), MANIFIESTO);
  });

  it('una portada vacía no es un error, y `disponible: false` no es vacía', () => {
    assert.equal(portadaVacia(portada()), true);
    assert.equal(portadaVacia(portada({ seleccion: [tarjeta()] })), false);
    assert.equal(catalogoDisponible(portada()), true);
    assert.equal(catalogoDisponible(portada({ disponible: false })), false);
    assert.equal(catalogoDisponible(null), false);
  });
});

/* ========================================================================== */
describe('la bolsa cuenta solo cuando hay algo', () => {
  it('cero no pinta contador', () => {
    assert.equal(contadorDeLaBolsa(0), null);
  });

  it('uno o más, sí', () => {
    assert.equal(contadorDeLaBolsa(1), 1);
    assert.equal(contadorDeLaBolsa(12), 12);
  });

  it('lo raro no inventa un número', () => {
    assert.equal(contadorDeLaBolsa(-3), null);
    assert.equal(contadorDeLaBolsa(Number.NaN), null);
    assert.equal(contadorDeLaBolsa(null), null);
    assert.equal(contadorDeLaBolsa(undefined), null);
  });

  it('cuántos guardados hay en una lista ya leída', () => {
    assert.equal(cuantosGuardados([tarjeta(), tarjeta({ saved: true })]), 1);
    assert.equal(cuantosGuardados([]), 0);
  });

  it('marcar uno como guardado no toca a los demás', () => {
    const lista = [tarjeta({ product_id: 'a' }), tarjeta({ product_id: 'b' })];
    const despues = conGuardado(lista, 'b', true);
    assert.equal(despues[0]?.saved, false);
    assert.equal(despues[1]?.saved, true);
    // Y no muta la lista original.
    assert.equal(lista[1]?.saved, false);
  });
});

/* ========================================================================== */
describe('la búsqueda y sus páginas', () => {
  it('con una letra no se busca, igual que en el servidor', () => {
    assert.equal(LARGO_MINIMO_DE_LA_BUSQUEDA, 2);
    assert.equal(consultaUtil('s'), null);
    assert.equal(consultaUtil(' s '), null);
    assert.equal(consultaUtil(''), null);
    assert.equal(consultaUtil(null), null);
  });

  it('dos letras ya viajan, sin espacios sobrantes', () => {
    assert.equal(consultaUtil('  si  '), 'si');
    assert.equal(consultaUtil('silla de madera'), 'silla de madera');
  });

  it('el campo vacío SÍ busca: es navegar el catálogo, no filtrar mal', () => {
    assert.equal(sePuedeBuscar('', null), true);
    assert.equal(sePuedeBuscar('   ', null), true);
  });

  it('una letra sola no busca, salvo que haya categoría elegida', () => {
    assert.equal(sePuedeBuscar('s', null), false);
    assert.equal(sePuedeBuscar('s', 'categoria-1'), true);
  });

  it('hay más páginas mientras venga cursor', () => {
    assert.equal(hayMasPaginas({ items: [], next_cursor: 'producto-9' }), true);
    assert.equal(hayMasPaginas({ items: [], next_cursor: null }), false);
    assert.equal(hayMasPaginas({ items: [], next_cursor: '   ' }), false);
    assert.equal(hayMasPaginas(null), false);
  });

  it('la página siguiente se pega detrás SIN REPETIR', () => {
    // El cursor es el id del último producto: si alguien publica entre dos
    // páginas, la siguiente puede traer una fila que ya estaba.
    const primera = [tarjeta({ product_id: 'a' }), tarjeta({ product_id: 'b' })];
    const segunda = [tarjeta({ product_id: 'b' }), tarjeta({ product_id: 'c' })];
    assert.deepEqual(
      unirPaginas(primera, segunda).map((x) => x.product_id),
      ['a', 'b', 'c'],
    );
  });

  it('unir no cambia el orden de lo que ya estaba', () => {
    const primera = [tarjeta({ product_id: 'a' }), tarjeta({ product_id: 'b' })];
    assert.deepEqual(
      unirPaginas(primera, []).map((x) => x.product_id),
      ['a', 'b'],
    );
    assert.deepEqual(unirPaginas([], []), []);
  });

  it('las categorías salen en el orden del servidor, y vacío es vacío', () => {
    const items = [
      { id: '2', slug: 'muebles', name: 'Muebles', position: 2 },
      { id: '1', slug: 'textil', name: 'Textil', position: 1 },
      { id: '3', slug: 'cocina', name: 'Cocina', position: 2 },
    ];
    assert.deepEqual(
      categoriasOfrecidas({ items }).map((c) => c.slug),
      ['textil', 'cocina', 'muebles'],
    );
    assert.deepEqual(categoriasOfrecidas({ items: [] }), []);
    assert.deepEqual(categoriasOfrecidas(null), []);
  });

  it('la página no pide más de lo que el servidor admite', () => {
    assert.equal(POR_PAGINA, 20);
    assert.equal(POR_BLOQUE, 8);
  });
});

/* ========================================================================== */
describe('el orden de la ficha es el del blueprint, y no se toca', () => {
  it('son los quince bloques, en su orden', () => {
    assert.deepEqual(
      [...BLOQUES_DE_LA_FICHA],
      [
        'galeria',
        'creador',
        'nombre',
        'precio',
        'sello',
        'razones',
        'variantes',
        'descripcion',
        'materialesYOrigen',
        'valoracion',
        'compraProtegida',
        'entregaYDevolucion',
        'perfilDelCreador',
        'relacionados',
        'barraFija',
      ],
    );
  });

  it('lo visible y lo que se deja fuera salen en ese mismo orden', () => {
    const completa = ficha({
      gallery: [{ id: 'm1', kind: 'image', storage_path: 'a.jpg', alt_text: null }],
      description: 'Hecha a mano.',
      related: [tarjeta()],
    });
    const visibles = bloquesVisibles(completa);
    const posiciones = visibles.map((b) => BLOQUES_DE_LA_FICHA.indexOf(b));
    assert.deepEqual(posiciones, [...posiciones].sort((a, b) => a - b));
    // Y entre las dos listas está la lista entera, sin perder ni repetir.
    assert.equal(visibles.length + bloquesFuera(completa).length, BLOQUES_DE_LA_FICHA.length);
  });

  it('los bloques que nunca se caen son los que siempre hay', () => {
    const vacia = ficha();
    for (const siempre of ['creador', 'nombre', 'precio', 'sello', 'perfilDelCreador', 'barraFija']) {
      assert.ok(bloqueConDatos(vacia, siempre as BloqueDeLaFicha), siempre);
    }
  });

  it('un bloque que no conocemos no se pinta', () => {
    assert.equal(bloqueConDatos(ficha(), 'inventado' as BloqueDeLaFicha), false);
  });
});

/* ========================================================================== */
describe('lo que no existe SE DEJA FUERA, no se rellena', () => {
  it('sin valoraciones, el bloque de valoración se queda fuera', () => {
    // `rating: null` es «no hay reseñas de productos», no «sacó cero».
    const sinNada = ficha();
    assert.equal(seDejaFuera(sinNada, 'valoracion'), true);
    assert.ok(!bloquesVisibles(sinNada).includes('valoracion'));
  });

  it('el día que haya valoraciones, el bloque entra solo', () => {
    assert.equal(seDejaFuera(ficha({ rating: { average: 4.8 } }), 'valoracion'), false);
  });

  it('sin condiciones de entrega, fuera el bloque de entrega y devolución', () => {
    assert.equal(seDejaFuera(ficha(), 'entregaYDevolucion'), true);
    assert.equal(seDejaFuera(ficha({ delivery: { days: 3 } }), 'entregaYDevolucion'), false);
  });

  it('sin compra, fuera «compra protegida»: no hay compra que proteger', () => {
    assert.equal(seDejaFuera(ficha(), 'compraProtegida'), true);
    assert.equal(seDejaFuera(ficha({ purchasable: true }), 'compraProtegida'), false);
  });

  it('los tres bloques imposibles de hoy salen fuera A LA VEZ', () => {
    const hoy = bloquesFuera(ficha());
    for (const bloque of ['valoracion', 'compraProtegida', 'entregaYDevolucion']) {
      assert.ok(hoy.includes(bloque as BloqueDeLaFicha), bloque);
    }
  });

  it('cada bloque que se cae explica POR QUÉ, con una frase verdadera', () => {
    for (const bloque of bloquesFuera(ficha())) {
      if (bloque === 'barraFija') continue;
      const clave = claveDelBloqueFuera(bloque);
      assert.ok(clave !== null, `${bloque} se cae sin decir nada`);
      assert.ok(clave.startsWith('productos.fuera.'), clave ?? '');
    }
  });

  it('los que no se caen no tienen frase de ausencia', () => {
    for (const bloque of ['nombre', 'precio', 'creador', 'sello', 'barraFija']) {
      assert.equal(claveDelBloqueFuera(bloque), null, bloque);
    }
  });

  it('NINGUNA frase de ausencia promete un plazo ni una media', () => {
    for (const bloque of BLOQUES_DE_LA_FICHA) {
      const clave = claveDelBloqueFuera(bloque);
      if (clave === null) continue;
      const texto = (es as unknown as Record<string, string>)[clave] ?? '';
      assert.notEqual(texto, '', clave);
      for (const prohibida of ['días', 'dias', 'estrellas', '4,8', '4.8', '%', 'devolver en']) {
        assert.ok(!texto.toLowerCase().includes(prohibida.toLowerCase()), `${clave}: ${prohibida}`);
      }
      assert.ok(!/\d/.test(texto), `${clave} lleva un número: ${texto}`);
    }
  });

  it('descripción y materiales se caen cuando no hay nada escrito', () => {
    assert.equal(seDejaFuera(ficha(), 'descripcion'), true);
    assert.equal(seDejaFuera(ficha({ summary: 'Un resumen' }), 'descripcion'), false);
    assert.equal(seDejaFuera(ficha({ description: 'Larga' }), 'descripcion'), false);
    assert.equal(seDejaFuera(ficha(), 'materialesYOrigen'), true);
    assert.equal(seDejaFuera(ficha({ materials: 'Nogal' }), 'materialesYOrigen'), false);
    assert.equal(seDejaFuera(ficha({ origin_country: 'PE' }), 'materialesYOrigen'), false);
    assert.equal(seDejaFuera(ficha({ manufacturer: 'Taller' }), 'materialesYOrigen'), false);
  });

  it('las imágenes todavía no se pueden firmar, y eso se dice', () => {
    // No hay depósito de productos en el almacenamiento: firmar la ruta contra
    // uno ajeno daría una URL que falla.
    assert.equal(IMAGENES_FIRMABLES, false);
    assert.equal(sePuedeMostrarLaImagen('productos/silla.jpg'), false);
    assert.equal(sePuedeMostrarLaImagen(null), false);
  });
});

/* ========================================================================== */
describe('NINGÚN BOTÓN DE COMPRAR', () => {
  it('las acciones de la ficha no incluyen comprar, y no pueden', () => {
    for (const accion of ACCIONES_DE_LA_FICHA) {
      for (const prohibida of ['comprar', 'buy', 'carrito', 'cart', 'checkout', 'pagar', 'pay']) {
        assert.ok(!accion.toLowerCase().includes(prohibida), `${accion} / ${prohibida}`);
      }
    }
  });

  it('con `purchasable: false` se ofrece guardar, y nada de vender', () => {
    assert.deepEqual(accionesDeLaFicha(ficha()), ['guardar', 'verCreador']);
  });

  it('AUNQUE `purchasable` fuera true, aquí no aparece comprar', () => {
    // Si algún día el servidor lo pone en `true`, la compra será una pantalla
    // nueva con su carrito y su pedido; no un botón que se enciende solo.
    const acciones = accionesDeLaFicha(ficha({ purchasable: true }));
    assert.ok(!acciones.some((a) => String(a).toLowerCase().includes('compr')));
  });

  it('lo guardado ofrece quitar, no comprar otra vez', () => {
    assert.ok(accionesDeLaFicha(ficha({ saved: true })).includes('quitar'));
    assert.ok(!accionesDeLaFicha(ficha({ saved: true })).includes('guardar'));
  });

  it('el informe solo se ofrece cuando hay informe que abrir', () => {
    assert.equal(selloAbreInforme(ficha()), false);
    assert.ok(!accionesDeLaFicha(ficha()).includes('verInforme'));
    const conInforme = ficha({ evaluation_id: 'evaluacion-1' });
    assert.equal(selloAbreInforme(conInforme), true);
    assert.ok(accionesDeLaFicha(conInforme).includes('verInforme'));
  });

  it('cada acción tiene su texto, y lo desconocido cae aparte', () => {
    const claves = ACCIONES_DE_LA_FICHA.map(claveDeAccion);
    assert.equal(new Set(claves).size, claves.length);
    assert.equal(claveDeAccion('comprar'), 'productos.accion.desconocido');
  });
});

/* ========================================================================== */
describe('el sello y las razones vienen del servidor', () => {
  it('el sello se PARTE por su punto medio, no se reescribe', () => {
    const { titulo, cuerpo } = partesDelSello(
      'Producto de Excelencia Z · Evaluado y aprobado por nuestro estándar',
    );
    assert.equal(titulo, 'Producto de Excelencia Z');
    assert.equal(cuerpo, 'Evaluado y aprobado por nuestro estándar');
  });

  it('un sello sin punto medio se enseña entero', () => {
    assert.deepEqual(partesDelSello('Producto de Excelencia Z'), {
      titulo: 'Producto de Excelencia Z',
      cuerpo: null,
    });
  });

  it('sin sello no se inventa ninguno', () => {
    assert.deepEqual(partesDelSello(null), { titulo: '', cuerpo: null });
    assert.deepEqual(partesDelSello('   '), { titulo: '', cuerpo: null });
    assert.equal(bloqueConDatos(ficha({ seal: '' }), 'sello'), false);
  });

  it('las razones van en su orden y como mucho tres', () => {
    const razones = [3, 1, 2, 4].map((position) => ({
      position,
      text: `razon ${position}`,
      evidence_kind: 'inspection',
      evidence_dimension: 'quality',
    }));
    assert.deepEqual(
      razonesOrdenadas(ficha({ reasons: razones })).map((r) => r.position),
      [1, 2, 3],
    );
    assert.equal(RAZONES_EXIGIDAS, 3);
  });

  it('cada razón dice de qué evidencia sale', () => {
    const claves = clavesDeLaEvidenciaDeLaRazon({
      position: 1,
      text: 'Aguanta el uso diario',
      evidence_kind: 'functional_test',
      evidence_dimension: 'durability',
    });
    assert.equal(claves.tipo, 'productos.evidencia.functional_test');
    assert.equal(claves.dimension, 'productos.dimension.durability');
  });

  it('EL ICONO DE UNA RAZÓN SALE DE SU EVIDENCIA, no de un gusto', () => {
    assert.equal(iconoDeLaDimension('quality'), 'layers');
    assert.equal(iconoDeLaDimension('durability'), 'layers');
    assert.equal(iconoDeLaDimension('origin'), 'user');
    assert.equal(iconoDeLaDimension('warranty'), 'shield');
    assert.equal(iconoDeLaDimension('design'), 'feather');
    assert.equal(iconoDeLaDimension('usefulness'), 'target');
  });

  it('una dimensión que no conocemos va SIN icono', () => {
    assert.equal(iconoDeLaDimension('inventada'), null);
    assert.equal(iconoDeLaDimension(''), null);
    assert.equal(iconoDeLaDimension(null), null);
  });

  it('todas las dimensiones de la matriz tienen icono', () => {
    for (const dimension of ORDEN_DE_DIMENSIONES) {
      assert.ok(iconoDeLaDimension(dimension) !== null, dimension);
    }
  });

  it('el contador de la galería cuenta lo que hay, y nunca «1/0»', () => {
    assert.equal(posicionEnLaGaleria(0, 5), 1);
    assert.equal(posicionEnLaGaleria(4, 5), 5);
    // Al final de un desplazamiento el cálculo puede pasarse.
    assert.equal(posicionEnLaGaleria(9, 5), 5);
    assert.equal(posicionEnLaGaleria(-1, 5), 1);
    assert.equal(posicionEnLaGaleria(0, 0), 0);
  });
});

/* ========================================================================== */
describe('el informe: centésimas de punto, y nada relleno', () => {
  it('9 000 centésimas son 90,00, no nueve mil', () => {
    assert.equal(puntuacionLegible(9000), '90,00');
    assert.equal(puntuacionLegible(8750), '87,50');
    assert.equal(puntuacionLegible(10_000), '100,00');
    assert.equal(puntuacionLegible(9), '0,09');
  });

  it('el separador decimal lo pone el idioma', () => {
    assert.equal(puntuacionLegible(9000, '.'), '90.00');
  });

  it('sin puntuación no se escribe un cero: se dice que no hay', () => {
    assert.equal(puntuacionLegible(null), '');
    assert.equal(puntuacionLegible(undefined), '');
    assert.equal(hayPuntuacion(informe({ score_total: null })), false);
    assert.equal(hayPuntuacion(null), false);
    assert.equal(hayPuntuacion(informe()), true);
  });

  it('un cero registrado SÍ es un cero', () => {
    assert.equal(puntuacionLegible(0), '0,00');
    assert.equal(hayPuntuacion(informe({ score_total: 0 })), true);
  });

  it('la puntuación NUNCA sale como estrellas', () => {
    // Es una puntuación sobre 100 de una evaluación, no una media de reseñas.
    for (const valor of [9000, 4800, 0]) {
      const escrito = puntuacionLegible(valor);
      assert.ok(!escrito.includes('★'));
      assert.ok(!escrito.toLowerCase().includes('estrella'));
    }
  });

  it('las dimensiones salen en el orden de la matriz', () => {
    const leido = informe({
      dimensions: {
        warranty: { score: 70, weight: 10, evidence: [] },
        quality: { score: 90, weight: 25, evidence: [] },
        origin: { score: 80, weight: 10, evidence: [] },
      },
    });
    assert.deepEqual(
      filasDelInforme(leido).map((x) => x.dimension),
      ['quality', 'origin', 'warranty'],
    );
  });

  it('LAS QUE NO VINIERON NO SE RELLENAN con ceros', () => {
    // Rellenarlas diría que se miraron las seis y que en unas se sacó cero.
    const leido = informe({ dimensions: { quality: { score: 90, weight: 25 } } });
    assert.equal(filasDelInforme(leido).length, 1);
  });

  it('una dimensión sin puntuar se cuenta como sin puntuar, no como cero', () => {
    const fila = filasDelInforme(
      informe({ dimensions: { quality: { evidence: [{ kind: 'photo', summary: 'foto' }] } } }),
    )[0];
    assert.equal(fila?.score, null);
    assert.deepEqual(fila?.evidencia, [{ kind: 'photo', summary: 'foto' }]);
  });

  it('el peso que vale es el congelado; sin él, el de la matriz de hoy', () => {
    const congelado = filasDelInforme(
      informe({ dimensions: { quality: { score: 90, weight: 30 } } }),
    )[0];
    assert.equal(congelado?.weight, 30);
    const sinPeso = filasDelInforme(informe({ dimensions: { quality: { score: 90 } } }))[0];
    assert.equal(sinPeso?.weight, DIMENSIONES.quality);
  });

  it('una dimensión que la matriz no conoce se pinta al final, con su nombre', () => {
    const filas = filasDelInforme(
      informe({ dimensions: { inventada: { score: 50 }, quality: { score: 90 } } }),
    );
    assert.deepEqual(
      filas.map((x) => x.dimension),
      ['quality', 'inventada'],
    );
    assert.equal(filas[1]?.weight, null);
    assert.equal(claveDeDimension('inventada'), 'productos.dimension.desconocido');
  });

  it('un informe sin detalle no produce ninguna fila inventada', () => {
    assert.deepEqual(filasDelInforme(informe()), []);
    assert.deepEqual(filasDelInforme(null), []);
  });

  it('la matriz es la del servidor y suma 100', () => {
    assert.deepEqual(DIMENSIONES, {
      quality: 25,
      design: 20,
      usefulness: 20,
      durability: 15,
      origin: 10,
      warranty: 10,
    });
    assert.equal(
      Object.values(DIMENSIONES).reduce((suma, peso) => suma + peso, 0),
      100,
    );
  });

  it('las tres decisiones y los diez tipos de evidencia tienen texto propio', () => {
    const decisiones = DECISIONES.map(claveDeDecision);
    assert.equal(new Set(decisiones).size, 3);
    assert.equal(claveDeDecision('otra'), 'productos.decision.desconocido');
    assert.equal(claveDeDecision(null), 'productos.decision.desconocido');
    const evidencias = TIPOS_DE_EVIDENCIA.map(claveDeTipoDeEvidencia);
    assert.equal(new Set(evidencias).size, TIPOS_DE_EVIDENCIA.length);
    assert.equal(claveDeTipoDeEvidencia('otro'), 'productos.evidencia.desconocido');
  });
});

/* ========================================================================== */
describe('el formato no añade nada que no viniera', () => {
  it('la huella se recorta para poder leerla, y no se rellena', () => {
    assert.equal(huellaCorta('abcdef0123456789abcdef'), 'abcdef012345');
    assert.equal(huellaCorta('abc'), 'abc');
    assert.equal(huellaCorta(null), '');
  });

  it('la versión se enseña como se escribió', () => {
    assert.equal(etiquetaDeVersion('  v2 '), 'v2');
    assert.equal(etiquetaDeVersion(null), '');
  });

  it('una fecha ilegible se queda vacía, no pone «hoy»', () => {
    assert.equal(fechaLegible('mañana'), '');
    assert.equal(fechaLegible(null), '');
    assert.notEqual(fechaLegible('2026-03-01T10:00:00Z'), '');
    assert.equal(momentoLegible('no-es-fecha'), '');
    assert.ok(momentoLegible('2026-03-01T10:00:00Z').includes('·'));
  });

  it('los títulos de bloque existen solo donde hay título', () => {
    for (const bloque of BLOQUES_CON_TITULO) {
      assert.equal(claveDelBloque(bloque), `productos.bloque.${bloque}`);
    }
    for (const sinTitulo of ['barraFija', 'sello', 'nombre', 'precio']) {
      assert.equal(claveDelBloque(sinTitulo), null, sinTitulo);
    }
  });
});

/* ========================================================================== */
describe('cuando algo sale mal', () => {
  it('cada código del servidor tiene su mensaje, y ninguno se repite', () => {
    const codigos = [
      'products_not_available',
      'product_admission_not_available',
      'product_saves_not_available',
      'product_evaluation_not_available',
      'product_not_found',
    ];
    const claves = codigos.map(claveDeErrorDeProductos);
    assert.ok(claves.every((x) => x !== null));
    assert.equal(new Set(claves).size, claves.length);
  });

  it('un código que no conocemos deja hablar al servidor', () => {
    assert.equal(claveDeErrorDeProductos('lo_que_sea'), null);
    assert.equal(claveDeErrorDeProductos(null), null);
  });

  it('los tres 503 de las migraciones significan lo mismo para quien mira', () => {
    // La 0070, la 0071 y la 0072 se entregan sin aplicar y cada puerta contesta
    // su propio código. Ninguno es una avería.
    assert.equal(esProductosApagado('products_not_available'), true);
    assert.equal(esProductosApagado('product_admission_not_available'), true);
    assert.equal(esProductosApagado('product_saves_not_available'), true);
    assert.equal(esProductosApagado('network_error'), false);
    assert.equal(esProductosApagado(null), false);
  });

  it('lo apagado puede ser solo guardar, o solo el informe', () => {
    assert.equal(esGuardadosApagado('product_saves_not_available'), true);
    assert.equal(esGuardadosApagado('products_not_available'), false);
    assert.equal(esInformeApagado('product_evaluation_not_available'), true);
    assert.equal(esInformeApagado('product_admission_not_available'), true);
    assert.equal(esInformeApagado('products_not_available'), false);
  });

  it('401, 403, 404 y 503 se cuentan distinto entre sí', () => {
    const claves = [401, 403, 404, 503].map(claveDeErrorPorEstado);
    assert.ok(claves.every((x) => x !== null));
    assert.equal(new Set(claves).size, 4);
    assert.equal(claveDeErrorPorEstado(500), null);
  });

  it('guardar sin sesión es un 401, y se cuenta como falta de sesión', () => {
    assert.equal(esFaltaDeSesion(401), true);
    assert.equal(esFaltaDeSesion(403), false);
    assert.equal(esFaltaDeSesion(null), false);
  });
});

/* ========================================================================== */
describe('todas las claves que produce el módulo están traducidas', () => {
  const diccionario = es as unknown as Record<string, string>;

  it('cada clave calculada existe en `es.ts`', () => {
    const calculadas = [
      CLAVE_SIN_PRECIO,
      claveDelBloquePersonal(true),
      claveDelBloquePersonal(false),
      claveDelCuerpoDelBloquePersonal(true),
      claveDelCuerpoDelBloquePersonal(false),
      ...CONFIANZAS_CONOCIDAS.map((c) => claveDeConfianza(c)),
      ...BLOQUES_CON_TITULO.map((b) => claveDelBloque(b)),
      ...BLOQUES_DE_LA_FICHA.map((b) => claveDelBloqueFuera(b)),
      ...ACCIONES_DE_LA_FICHA.map(claveDeAccion),
      claveDeAccion('inventada'),
      ...DECISIONES.map(claveDeDecision),
      claveDeDecision('inventada'),
      ...ORDEN_DE_DIMENSIONES.map(claveDeDimension),
      claveDeDimension('inventada'),
      ...TIPOS_DE_EVIDENCIA.map(claveDeTipoDeEvidencia),
      claveDeTipoDeEvidencia('inventado'),
      claveDeErrorDeProductos('products_not_available'),
      claveDeErrorDeProductos('product_admission_not_available'),
      claveDeErrorDeProductos('product_saves_not_available'),
      claveDeErrorDeProductos('product_evaluation_not_available'),
      claveDeErrorDeProductos('product_not_found'),
      claveDeErrorPorEstado(401),
      claveDeErrorPorEstado(403),
      claveDeErrorPorEstado(404),
      claveDeErrorPorEstado(503),
    ].filter((clave): clave is string => typeof clave === 'string');
    const faltan = calculadas.filter((clave) => !(clave in diccionario));
    assert.deepEqual(faltan, [], `sin traducir: ${faltan.join(', ')}`);
  });

  it('los tres idiomas tienen las MISMAS claves de Productos', () => {
    const deProductos = (d: Record<string, string>) =>
      Object.keys(d).filter((k) => k.startsWith('productos.')).sort();
    const enProductos = deProductos(en as unknown as Record<string, string>);
    const ptProductos = deProductos(pt as unknown as Record<string, string>);
    assert.deepEqual(enProductos, deProductos(diccionario));
    assert.deepEqual(ptProductos, deProductos(diccionario));
    assert.ok(deProductos(diccionario).length > 0);
  });
});

/* ========================================================================== */
describe('EL LENGUAJE PROHIBIDO no está en ningún diccionario', () => {
  /**
   * Presumir de tamaño, de precio o meter prisa. NUNCA, en ninguna pantalla:
   * Z no compite por catálogo ni por barato, y estas frases dicen lo contrario
   * de lo que el manifiesto promete.
   */
  const NUNCA = [
    'millones de productos',
    'millions of products',
    'milhões de produtos',
    'precios más bajos',
    'lowest prices',
    'preços mais baixos',
    'ofertas imperdibles',
    'unmissable deals',
    'ofertas imperdíveis',
    'mejor precio garantizado',
    'best price guaranteed',
  ];

  /**
   * Reclutar proveedores DESDE EL CATÁLOGO.
   *
   * Se comprueba sobre las claves de `productos.` —lo que lee quien mira
   * productos— y no sobre el diccionario entero, porque la bandeja de admisión
   * sí habla de postular: ahí es la descripción de su propio trabajo, no una
   * llamada a vender metida en la portada.
   */
  const NO_EN_EL_CATALOGO = [
    'vende en z',
    'hazte vendedor',
    'conviértete en vendedor',
    'sell on z',
    'become a seller',
    'vende na z',
    'torna-te vendedor',
  ];

  for (const [idioma, diccionario] of [
    ['es', es],
    ['en', en],
    ['pt', pt],
  ] as Array<[string, Record<string, string>]>) {
    it(`${idioma} no presume de tamaño, de precio ni mete prisa`, () => {
      const encontradas: string[] = [];
      for (const [clave, texto] of Object.entries(diccionario)) {
        const bajo = String(texto).toLowerCase();
        for (const frase of NUNCA) {
          if (bajo.includes(frase)) encontradas.push(`${clave}: ${frase}`);
        }
      }
      assert.deepEqual(encontradas, [], encontradas.join(' · '));
    });

    it(`${idioma} no recluta vendedores desde el catálogo`, () => {
      const encontradas: string[] = [];
      for (const [clave, texto] of Object.entries(diccionario)) {
        if (!clave.startsWith('productos.')) continue;
        const bajo = String(texto).toLowerCase();
        for (const frase of NO_EN_EL_CATALOGO) {
          if (bajo.includes(frase)) encontradas.push(`${clave}: ${frase}`);
        }
      }
      assert.deepEqual(encontradas, [], encontradas.join(' · '));
    });
  }

  it('ninguna clave de Productos inventa una valoración ni un plazo', () => {
    const encontradas: string[] = [];
    for (const [clave, texto] of Object.entries(es as unknown as Record<string, string>)) {
      if (!clave.startsWith('productos.')) continue;
      const bajo = String(texto).toLowerCase();
      for (const frase of ['★', 'estrella', '4,8', '4.8', 'compras verificadas', 'envío gratis']) {
        if (bajo.includes(frase)) encontradas.push(`${clave}: ${frase}`);
      }
    }
    assert.deepEqual(encontradas, [], encontradas.join(' · '));
  });
});

/* ========================================================================== */
describe('lo que las pantallas y el repositorio tienen escrito', () => {
  const portadaSrc = sinComentarios(fuente('screens', 'ProductosScreen.tsx'));
  const fichaSrc = sinComentarios(fuente('screens', 'ProductoScreen.tsx'));
  const buscarSrc = sinComentarios(fuente('screens', 'BuscarProductosScreen.tsx'));
  const guardadosSrc = sinComentarios(fuente('screens', 'ProductosGuardadosScreen.tsx'));
  const informeSrc = sinComentarios(fuente('screens', 'InformeDeEvaluacionScreen.tsx'));
  const repositorio = sinComentarios(fuente('repositories', 'ProductCatalogRepository.ts'));
  const PANTALLAS: Array<[string, string]> = [
    ['ProductosScreen', portadaSrc],
    ['ProductoScreen', fichaSrc],
    ['BuscarProductosScreen', buscarSrc],
    ['ProductosGuardadosScreen', guardadosSrc],
    ['InformeDeEvaluacionScreen', informeSrc],
  ];

  it('LA FICHA PINTA LOS BLOQUES EN EL ORDEN DEL BLUEPRINT', () => {
    // El orden se recorre desde la lista del módulo, y cada bloque tiene su
    // `case` en ese mismo orden: reordenar el JSX se ve aquí.
    assert.ok(fichaSrc.includes('BLOQUES_DE_LA_FICHA.map('));
    const posiciones = BLOQUES_DE_LA_FICHA.map((bloque) => {
      const donde = fichaSrc.indexOf(`case '${bloque}'`);
      assert.notEqual(donde, -1, `falta el bloque ${bloque}`);
      return donde;
    });
    assert.deepEqual(posiciones, [...posiciones].sort((a, b) => a - b));
  });

  it('la ficha deja los bloques sin datos fuera pasando por el módulo', () => {
    assert.ok(fichaSrc.includes('seDejaFuera('));
    assert.ok(fichaSrc.includes('claveDelBloqueFuera('));
    // Y no se salta la regla mirando los campos a mano.
    assert.ok(!fichaSrc.includes('rating !== null'));
    assert.ok(!fichaSrc.includes('delivery !== null'));
  });

  it('NINGUNA PANTALLA TIENE UN BOTÓN DE COMPRAR', () => {
    for (const [nombre, codigo] of PANTALLAS) {
      // `sinComprar` es justo lo contrario —la línea que dice que en Z todavía
      // no se compra— así que se quita antes de buscar «comprar» suelto.
      const bajo = codigo.toLowerCase().split('sincomprar').join('');
      for (const prohibido of [
        'comprar',
        'carrito',
        'checkout',
        'addtocart',
        'añadiralcarrito',
        'pagar(',
        'purchase(',
        'purchasable ?',
      ]) {
        assert.ok(!bajo.includes(prohibido), `${nombre} dice «${prohibido}»`);
      }
    }
  });

  it('y el repositorio no sabe comprar: no hay ruta que llamar', () => {
    for (const prohibido of ['/cart', '/checkout', '/orders', 'comprar(', 'pagar(']) {
      assert.ok(!repositorio.includes(prohibido), prohibido);
    }
    // Ni se mete en lo del proveedor ni en lo de administración.
    assert.ok(!repositorio.includes('/admin/'));
    assert.ok(!repositorio.includes('/products/seller'));
  });

  it('las siete llamadas del catálogo, y esas siete', () => {
    for (const ruta of [
      '${API_V1}/products`',
      '/products/search',
      '/products/categories',
      '/products/saved',
      '/products/${productoId}`',
      '/evaluation',
      '/save',
    ]) {
      assert.ok(repositorio.includes(ruta), `falta ${ruta}`);
    }
    assert.ok(repositorio.includes("method: 'POST'"));
    assert.ok(repositorio.includes("method: 'DELETE'"));
  });

  it('ningún texto en duro: todo pasa por el traductor', () => {
    for (const [nombre, codigo] of PANTALLAS) {
      for (const atributo of ['label="', 'title="', 'description="', 'placeholder="']) {
        assert.ok(!codigo.includes(atributo), `${nombre} lleva ${atributo}`);
      }
    }
  });

  it('el sello y el manifiesto se cogen del servidor, no se escriben', () => {
    for (const [nombre, codigo] of PANTALLAS) {
      assert.ok(!codigo.includes('Producto de Excelencia'), `${nombre} escribe el sello`);
      assert.ok(!codigo.includes('merece estar'), `${nombre} escribe el manifiesto`);
    }
    assert.ok(fichaSrc.includes('partesDelSello(leida.seal)'));
    assert.ok(informeSrc.includes('leido.seal'));
    assert.ok(portadaSrc.includes('textoDelManifiesto(portada)'));
  });

  it('las tarjetas van a DOS COLUMNAS COMO MÁXIMO', () => {
    assert.equal(COLUMNAS_MAXIMAS, 2);
    assert.ok(portadaSrc.includes("maxWidth: '50%'"));
    assert.ok(!portadaSrc.includes('numColumns={3}'));
    assert.ok(!portadaSrc.includes("flexBasis: '31%'"));
  });

  it('el contador de la bolsa solo se pinta cuando hay algo', () => {
    assert.ok(portadaSrc.includes('contadorDeLaBolsa('));
    assert.ok(portadaSrc.includes('contador !== null'));
    assert.ok(!portadaSrc.includes('contador ?? 0'));
  });

  it('el título del bloque personal sale del módulo, no está escrito', () => {
    assert.ok(portadaSrc.includes('claveDelBloquePersonal(portada.personalized)'));
    assert.ok(!portadaSrc.includes("'productos.paraTi'"));
  });

  it('cada pantalla tiene sus estados: carga, error, vacío y el 503', () => {
    for (const [nombre, codigo] of PANTALLAS) {
      assert.ok(codigo.includes('state="loading"'), `${nombre} sin carga`);
      assert.ok(codigo.includes('esFalloDeRed('), `${nombre} sin sin-conexión`);
      assert.ok(codigo.includes('onRetry'), `${nombre} sin reintento`);
    }
    for (const [nombre, codigo] of PANTALLAS) {
      assert.ok(codigo.includes('state="empty"'), `${nombre} sin vacío`);
    }
    assert.ok(portadaSrc.includes('catalogoDisponible(portada)'));
    assert.ok(portadaSrc.includes('esProductosApagado('));
    assert.ok(guardadosSrc.includes('esFaltaDeSesion('));
    assert.ok(informeSrc.includes('esInformeApagado('));
  });

  it('la búsqueda pagina por cursor y no repite filas', () => {
    assert.ok(buscarSrc.includes('unirPaginas('));
    assert.ok(buscarSrc.includes('hayMasPaginas('));
    assert.ok(buscarSrc.includes('cursor: pagina.next_cursor'));
    assert.ok(!buscarSrc.includes('offset'));
  });

  it('el informe escribe la puntuación en centésimas, con su separador', () => {
    assert.ok(informeSrc.includes('puntuacionLegible('));
    assert.ok(informeSrc.includes("f('productos.separadorDecimal')"));
    // Y no pinta el número en crudo, que serían nueve mil puntos.
    assert.ok(!informeSrc.includes('{leido.score_total}'));
  });

  it('el icono de cada razón sale de la evidencia, no de una lista a mano', () => {
    assert.ok(fichaSrc.includes('iconoDeLaDimension(razon.evidence_dimension)'));
  });

  it('el acceso desde Explorar lleva al catálogo', () => {
    const accesos = sinComentarios(fuente('components', 'AccesosAVerticales.tsx'));
    assert.ok(
      accesos.includes("{ clave: 'productos', icono: 'shopping-bag', ruta: '/productos' }"),
    );
  });
});
