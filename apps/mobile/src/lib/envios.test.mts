/**
 * La entrega de un pedido de productos, ejecutada. Incremento 6.
 *
 * Lo que se prueba aquí es, otra vez, LO QUE NO SE PUEDE DECIR. Un seguimiento
 * es la pantalla donde más barato sale mentir y más caro cuesta: basta con una
 * fecha de llegada inventada, con un «atrasado» contra un plazo que nadie
 * publicó o con un «entregado» deducido del paso del tiempo para prometer algo
 * que Z no puede cumplir.
 *
 *  1. NINGUNA FECHA DE LLEGADA, NINGÚN ENLACE DE SEGUIMIENTO: no hay
 *     transportista elegido, y las dos constantes lo dicen en un solo sitio.
 *  2. NULO NO ES «N/A»: sin transportista escrito se dice que no lo indicaron.
 *  3. NADIE MARCA «ATRASADO»: se dice cuánto tiempo ha pasado, que es un hecho.
 *  4. LA PANTALLA NO DECIDE NINGÚN SALTO: solo ofrece lo que el servidor dijo.
 *  5. UN PAQUETE SE CIERRA ENTERO O NO SE CIERRA.
 *  6. CONFIRMAR QUE LLEGÓ NO ES DAR LA CONFORMIDAD, y no se ofrece dos veces
 *     ni sobre algo que no ha salido.
 *  7. UN ESTADO DESCONOCIDO TIENE TEXTO: un estado sin nombre es peor que un
 *     nombre feo.
 *  8. LAS DOS MÁQUINAS SE MEZCLAN AL PINTAR Y NO EN LA BASE.
 *  9. LAS PANTALLAS NO ESCRIBEN NINGUNO DE LOS DATOS PROHIBIDOS.
 * 10. LOS ESTADOS DEL MÓVIL SON LOS DEL SERVIDOR, leídos de su fichero.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Envio, EventoDelEnvio, LineaPreparada } from './envios.ts';

/** El mismo resolutor que `pedidos.test.mts`, y por lo mismo: `@/` no es Node. */
registerHooks({
  resolve(especificador, contexto, siguiente) {
    if (especificador.startsWith('@/')) {
      return {
        url: new URL(`../${especificador.slice(2)}.ts`, import.meta.url).href,
        shortCircuit: true,
      };
    }
    return siguiente(especificador, contexto);
  },
});

const {
  ANTES_DE_SALIR,
  DESPUES_DE_SALIR,
  ESTADOS_DE_ENVIO,
  HAY_ENLACE_DE_SEGUIMIENTO,
  HAY_FECHA_PREVISTA,
  avanceDeLaPreparacion,
  claveDeErrorDeEnvios,
  claveDeLaEspera,
  claveDelEstadoDeEnvio,
  esEnvioApagado,
  esEstadoConocido,
  faltanDeLaLinea,
  hayDatosDeTransporte,
  iconoDelEstadoDeEnvio,
  lineaCompleta,
  lineaDeTiempo,
  loQueFalta,
  numeroDeLaEspera,
  ofrece,
  sePuedeCerrar,
  sePuedeConfirmarRecepcion,
  yaLlego,
  yaSalio,
} = await import('./envios.ts');

const AQUI = fileURLToPath(new URL('.', import.meta.url));

function fuente(carpeta: string, nombre: string): string {
  return readFileSync(join(AQUI, '..', carpeta, nombre), 'utf8');
}

/** El servidor, leído de verdad: el contrato no se copia de memoria. */
function delServidor(ruta: string): string {
  return readFileSync(
    join(AQUI, '..', '..', '..', 'api', 'app', 'modules', 'products', ruta),
    'utf8',
  );
}

/** El código sin comentarios: lo que la pantalla HACE, no lo que explica. */
function sinComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((linea) => !linea.trim().startsWith('//') && !linea.trim().startsWith('*'))
    .join('\n');
}

function linea(campos: Partial<LineaPreparada> = {}): LineaPreparada {
  return {
    order_item_id: 'it-1',
    sku: 'CUCH-20',
    name: 'Cuchillo',
    variant_name: null,
    ordered_quantity: 2,
    prepared_quantity: 0,
    ...campos,
  };
}

function envio(campos: Partial<Envio> = {}): Envio {
  return {
    order_id: 'po-1',
    status: 'PENDING',
    exists: false,
    carrier_name: null,
    tracking_reference: null,
    prepared_at: null,
    ready_at: null,
    dispatched_at: null,
    delivered_at: null,
    failed_at: null,
    cancelled_at: null,
    delivered_source: null,
    buyer_confirmed_at: null,
    failure_reason: null,
    cancellation_reason: null,
    items: [linea()],
    history: [],
    available_transitions: [],
    ...campos,
  };
}

function paso(campos: Partial<EventoDelEnvio> = {}): EventoDelEnvio {
  return {
    from_status: null,
    to_status: 'PREPARING',
    actor_role: 'seller',
    reason: null,
    created_at: '2026-09-20T10:00:00Z',
    ...campos,
  };
}

/* ========================================================================== */
/* 1. Lo que no se puede inventar                                             */
/* ========================================================================== */
describe('el seguimiento no inventa nada', () => {
  it('NO HAY ENLACE DE SEGUIMIENTO NI FECHA PREVISTA, y está escrito una vez', () => {
    // Construir una URL exige saber el transportista, y la empresa no ha
    // elegido ninguno: un enlace inventado dentro de un pedido pagado es un
    // enlace roto en el peor sitio. Y una fecha se lee como un compromiso.
    assert.equal(HAY_ENLACE_DE_SEGUIMIENTO, false);
    assert.equal(HAY_FECHA_PREVISTA, false);
  });

  it('el módulo no sabe calcular ninguna fecha de llegada', () => {
    const texto = sinComentarios(fuente('lib', 'envios.ts'));
    for (const prohibido of [
      'estimatedDelivery',
      'estimated_delivery',
      'fechaPrevista',
      'diasDeTransporte',
      'trackingUrl',
      'tracking_url',
    ]) {
      assert.ok(!texto.includes(prohibido), `aparece «${prohibido}»`);
    }
  });

  it('sin transportista escrito no hay nada que enseñar, y NO es «N/A»', () => {
    assert.equal(hayDatosDeTransporte(envio()), false);
    assert.equal(hayDatosDeTransporte(null), false);
    // Espacios en blanco tampoco son un transportista.
    assert.equal(
      hayDatosDeTransporte(envio({ carrier_name: '   ', tracking_reference: '' })),
      false,
    );
    assert.equal(hayDatosDeTransporte(envio({ carrier_name: 'Transporte X' })), true);
    assert.equal(hayDatosDeTransporte(envio({ tracking_reference: 'AB-1' })), true);
  });
});

/* ========================================================================== */
/* 2. La espera es un hecho, no un juicio                                     */
/* ========================================================================== */
describe('nadie marca nada como atrasado', () => {
  it('se dice cuánto tiempo ha pasado, en horas o en días', () => {
    assert.equal(claveDeLaEspera(5), 'envio.espera.horas');
    assert.equal(numeroDeLaEspera(5), 5);
    assert.equal(claveDeLaEspera(23), 'envio.espera.horas');
    assert.equal(claveDeLaEspera(24), 'envio.espera.dias');
    assert.equal(numeroDeLaEspera(49), 2);
  });

  it('sin fecha de pago no se inventa un cero', () => {
    // Cero horas esperando es una afirmación; «no lo sabemos» es la verdad.
    assert.equal(claveDeLaEspera(null), 'envio.espera.desconocida');
  });

  it('ni el módulo ni la bandeja conocen la palabra «atrasado»', () => {
    // NINGUNA POLÍTICA PUBLICA UN PLAZO DE DESPACHO. Llamarle tarde a algo sin
    // plazo es inventarse el plazo, y quien lo lea actuaría sobre un
    // incumplimiento que nadie definió.
    const textos = [
      sinComentarios(fuente('lib', 'envios.ts')),
      sinComentarios(fuente('screens', 'EnviosPendientesScreen.tsx')),
      sinComentarios(fuente('screens', 'PedidosDeMiTiendaScreen.tsx')),
    ].join('\n');
    for (const prohibido of ['atrasado', 'overdue', 'isLate', 'retraso', 'sla', 'deadline']) {
      const patron = new RegExp(`\\b${prohibido}\\b`, 'i');
      assert.ok(!patron.test(textos), `aparece «${prohibido}»`);
    }
  });
});

/* ========================================================================== */
/* 3. La pantalla no decide ningún salto                                      */
/* ========================================================================== */
describe('quien decide es el servidor', () => {
  it('solo se ofrece lo que el servidor dice que está disponible', () => {
    assert.equal(ofrece(envio({ available_transitions: ['READY'] }), 'READY'), true);
    assert.equal(ofrece(envio({ available_transitions: ['READY'] }), 'DISPATCHED'), false);
    assert.equal(ofrece(null, 'READY'), false);
  });

  it('un envío listo con todo dentro NO se despacha si el servidor no lo ofrece', () => {
    // ES LA PRUEBA DE QUE ESTA CAPA NO DEDUCE. El estado y el contenido de la
    // caja dirían que sí; la lista del servidor dice que no, y manda ella.
    const listo = envio({
      status: 'READY',
      items: [linea({ prepared_quantity: 2 })],
      available_transitions: [],
    });
    assert.equal(sePuedeCerrar(listo), true, 'la caja sí está completa');
    assert.equal(ofrece(listo, 'DISPATCHED'), false, 'y aun así no se ofrece');
  });
});

/* ========================================================================== */
/* 4. Un paquete sale entero o no sale                                        */
/* ========================================================================== */
describe('la preparación', () => {
  it('una línea a medias no está completa, y se dice cuánto falta', () => {
    assert.equal(lineaCompleta(linea({ prepared_quantity: 1 })), false);
    assert.equal(faltanDeLaLinea(linea({ prepared_quantity: 1 })), 1);
    assert.equal(lineaCompleta(linea({ prepared_quantity: 2 })), true);
    assert.equal(faltanDeLaLinea(linea({ prepared_quantity: 2 })), 0);
  });

  it('nunca faltan un número negativo de unidades', () => {
    // Si el servidor mandara más preparadas que compradas —no puede, lo
    // rechaza—, «faltan -3» sería un texto absurdo en una pantalla.
    assert.equal(faltanDeLaLinea(linea({ prepared_quantity: 5 })), 0);
  });

  it('con una línea a medias no se puede cerrar', () => {
    const medio = envio({
      items: [linea({ prepared_quantity: 2 }), linea({ order_item_id: 'it-2' })],
    });
    assert.equal(sePuedeCerrar(medio), false);
    assert.equal(loQueFalta(medio).length, 1);
    assert.equal(loQueFalta(medio)[0]?.order_item_id, 'it-2');
  });

  it('UN ENVÍO SIN LÍNEAS NO ESTÁ LISTO', () => {
    // Contestar «listo» sobre una lista vacía dejaría cerrar una caja vacía.
    assert.equal(sePuedeCerrar(envio({ items: [] })), false);
    assert.equal(sePuedeCerrar(null), false);
  });

  it('el avance cuenta unidades, no líneas', () => {
    const dos = envio({
      items: [
        linea({ prepared_quantity: 2 }),
        linea({ order_item_id: 'it-2', ordered_quantity: 3, prepared_quantity: 1 }),
      ],
    });
    assert.deepEqual(avanceDeLaPreparacion(dos), { hechas: 3, total: 5 });
    assert.deepEqual(avanceDeLaPreparacion(null), { hechas: 0, total: 0 });
  });
});

/* ========================================================================== */
/* 5. Confirmar que llegó                                                     */
/* ========================================================================== */
describe('confirmar la recepción', () => {
  it('no se ofrece sobre algo que todavía no ha salido', () => {
    // Ofrecerlo invitaría a confirmar una entrega que no ocurrió.
    for (const estado of ANTES_DE_SALIR) {
      assert.equal(
        sePuedeConfirmarRecepcion(
          envio({ status: estado, available_transitions: ['DELIVERED'] }),
        ),
        false,
        estado,
      );
    }
  });

  it('se ofrece sobre lo despachado y sobre una entrega fallida', () => {
    for (const estado of ['DISPATCHED', 'DELIVERY_FAILED']) {
      assert.equal(
        sePuedeConfirmarRecepcion(
          envio({ status: estado, available_transitions: ['DELIVERED'] }),
        ),
        true,
        estado,
      );
    }
  });

  it('NO SE OFRECE DOS VECES', () => {
    // Ofrecerlo otra vez haría dudar de si la primera se guardó.
    assert.equal(
      sePuedeConfirmarRecepcion(
        envio({
          status: 'DELIVERED',
          buyer_confirmed_at: '2026-09-20T12:00:00Z',
          available_transitions: ['DELIVERED'],
        }),
      ),
      false,
    );
  });

  it('el texto dice que NO es dar la conformidad', () => {
    // Si la pantalla lo insinuara, alguien confirmaría creyendo que renuncia a
    // algo, o creyendo que ha pagado a alguien.
    const es = fuente('i18n', 'es.ts');
    assert.ok(es.includes("'envio.detalle.confirmarNoEsConformidad'"));
    const pantalla = sinComentarios(fuente('screens', 'PedidoDeProductoScreen.tsx'));
    assert.ok(pantalla.includes('envio.detalle.confirmarNoEsConformidad'));
  });
});

/* ========================================================================== */
/* 6. Los estados                                                             */
/* ========================================================================== */
describe('los estados', () => {
  it('un estado desconocido tiene texto, no un hueco', () => {
    assert.equal(claveDelEstadoDeEnvio('LO_QUE_SEA'), 'envio.estado.desconocido');
    assert.equal(iconoDelEstadoDeEnvio('LO_QUE_SEA'), null);
    assert.equal(esEstadoConocido('LO_QUE_SEA'), false);
  });

  it('cada estado conocido tiene texto e icono', () => {
    // EL COLOR NUNCA ES EL ÚNICO PORTADOR: sin icono, un estado se distinguiría
    // solo por el tono, y hay quien no lo distingue.
    const es = fuente('i18n', 'es.ts');
    for (const estado of ESTADOS_DE_ENVIO) {
      assert.equal(claveDelEstadoDeEnvio(estado), `envio.estado.${estado}`);
      assert.ok(iconoDelEstadoDeEnvio(estado) !== null, estado);
      assert.ok(es.includes(`'envio.estado.${estado}'`), estado);
    }
  });

  it('SON LOS DEL SERVIDOR, leídos de su fichero', () => {
    // Copiarlos de memoria es cómo el móvil acaba sin texto para un estado que
    // el servidor ya escribe.
    const maquina = delServidor('estados_de_envio.py');
    for (const estado of ESTADOS_DE_ENVIO) {
      assert.ok(maquina.includes(`"${estado}"`), `${estado} no está en el servidor`);
    }
    // Y AL REVÉS: ninguno del servidor puede faltar aquí.
    const enElServidor = [
      ...maquina.matchAll(/^(?:PENDIENTE|PREPARANDO|LISTO|DESPACHADO|ENTREGADO|ENTREGA_FALLIDA|CANCELADO) = "([A-Z_]+)"$/gm),
    ].map((m) => m[1]);
    assert.equal(enElServidor.length, 7, 'se leyeron los siete del servidor');
    for (const estado of enElServidor) {
      assert.ok(
        (ESTADOS_DE_ENVIO as readonly string[]).includes(estado as string),
        `${estado} falta en el móvil`,
      );
    }
  });

  it('antes y después de salir no se solapan', () => {
    for (const estado of ANTES_DE_SALIR) {
      assert.ok(!DESPUES_DE_SALIR.includes(estado), estado);
      assert.equal(yaSalio(envio({ status: estado })), false);
    }
    for (const estado of DESPUES_DE_SALIR) {
      assert.equal(yaSalio(envio({ status: estado })), true);
    }
    assert.equal(yaLlego(envio({ status: 'DELIVERED' })), true);
    assert.equal(yaLlego(envio({ status: 'DISPATCHED' })), false);
  });
});

/* ========================================================================== */
/* 7. La línea de tiempo                                                      */
/* ========================================================================== */
describe('la línea de tiempo', () => {
  it('mezcla el pago y el envío, en orden y diciendo de dónde viene cada uno', () => {
    const pasos = lineaDeTiempo(
      [
        paso({ to_status: 'PENDING_PAYMENT', created_at: '2026-09-20T09:00:00Z' }),
        paso({ to_status: 'PAID', created_at: '2026-09-20T09:30:00Z' }),
      ],
      envio({
        history: [
          paso({ to_status: 'PREPARING', created_at: '2026-09-20T11:00:00Z' }),
          paso({ to_status: 'DISPATCHED', created_at: '2026-09-20T10:00:00Z' }),
        ],
      }),
    );
    assert.deepEqual(
      pasos.map((p) => p.origen),
      ['pago', 'pago', 'envio', 'envio'],
    );
    assert.deepEqual(
      pasos.map((p) => p.clave),
      [
        'pedidoDeProducto.estado.PENDING_PAYMENT',
        'pedidoDeProducto.estado.PAID',
        'envio.estado.DISPATCHED',
        'envio.estado.PREPARING',
      ],
    );
  });

  it('dos hechos del mismo instante no bailan entre dos renders', () => {
    // Pagar vacía la bolsa y anota: las dos cosas ocurren a la vez, y un orden
    // que cambiara solo haría dudar de lo que se lee.
    const mismos = [
      paso({ to_status: 'PAID', created_at: '2026-09-20T09:00:00Z' }),
      paso({ to_status: 'PENDING_PAYMENT', created_at: '2026-09-20T09:00:00Z' }),
    ];
    const primera = lineaDeTiempo(mismos, null).map((p) => p.clave);
    const segunda = lineaDeTiempo(mismos, null).map((p) => p.clave);
    assert.deepEqual(primera, segunda);
    assert.deepEqual(primera, [
      'pedidoDeProducto.estado.PAID',
      'pedidoDeProducto.estado.PENDING_PAYMENT',
    ]);
  });

  it('sin envío es solo el historial del pago', () => {
    const pasos = lineaDeTiempo([paso({ to_status: 'PAID' })], null);
    assert.equal(pasos.length, 1);
    assert.equal(pasos[0]?.origen, 'pago');
  });

  it('una fecha ilegible no rompe la lista ni la reordena al azar', () => {
    const pasos = lineaDeTiempo(
      [paso({ to_status: 'PAID', created_at: 'no es una fecha' })],
      envio({ history: [paso({ to_status: 'DISPATCHED' })] }),
    );
    assert.equal(pasos.length, 2);
    assert.deepEqual(
      pasos.map((p) => p.origen),
      ['pago', 'envio'],
    );
  });
});

/* ========================================================================== */
/* 8. Los errores                                                             */
/* ========================================================================== */
describe('los errores', () => {
  it('cada código del servidor tiene texto en los tres idiomas', () => {
    const maquina = delServidor('envios.py') + delServidor('estados_de_envio.py');
    const codigos = [...maquina.matchAll(/code = "(product_shipment[a-z_0-9]*)"/g)].map(
      (m) => m[1] as string,
    );
    assert.ok(codigos.length >= 8, `solo se leyeron ${codigos.length} códigos`);
    const diccionarios = ['es.ts', 'en.ts', 'pt.ts'].map((f) => fuente('i18n', f));
    for (const codigo of codigos) {
      const clave = claveDeErrorDeEnvios(codigo);
      assert.ok(clave !== null, `${codigo} sin traducir`);
      for (const diccionario of diccionarios) {
        assert.ok(diccionario.includes(`'${clave}'`), `${clave} falta en un idioma`);
      }
    }
  });

  it('un código que no es de envíos no se traduce como si lo fuera', () => {
    assert.equal(claveDeErrorDeEnvios('product_order_not_found'), null);
    assert.equal(claveDeErrorDeEnvios(undefined), null);
    assert.equal(claveDeErrorDeEnvios(''), null);
    assert.equal(claveDeErrorDeEnvios(null), null);
  });

  it('la función no configurada se distingue de un error', () => {
    assert.equal(esEnvioApagado('product_shipments_not_available'), true);
    assert.equal(esEnvioApagado('product_shipment_not_found'), false);
    assert.equal(esEnvioApagado(undefined), false);
  });
});

/* ========================================================================== */
/* 9. Lo que las pantallas tienen prohibido escribir                          */
/* ========================================================================== */
describe('las pantallas del envío', () => {
  const preparar = sinComentarios(fuente('screens', 'PrepararPedidoScreen.tsx'));
  const tienda = sinComentarios(fuente('screens', 'PedidosDeMiTiendaScreen.tsx'));
  const bandeja = sinComentarios(fuente('screens', 'EnviosPendientesScreen.tsx'));
  const comprador = sinComentarios(fuente('screens', 'PedidoDeProductoScreen.tsx'));

  it('NINGUNA calcula un importe ni enseña un coste de envío', () => {
    // Impuestos y envío no están decididos. Un cero es una promesa de envío
    // gratis que nadie ha hecho.
    for (const [nombre, texto] of [
      ['preparar', preparar],
      ['tienda', tienda],
      ['bandeja', bandeja],
    ] as const) {
      for (const prohibido of ['shipping_cost', 'shippingCost', 'tax_minor', '0.00', '0,00']) {
        assert.ok(!texto.includes(prohibido), `${nombre}: aparece «${prohibido}»`);
      }
    }
  });

  it('LA BANDEJA DE ADMINISTRACIÓN NO ENSEÑA NI UN DATO PERSONAL', () => {
    // Es lo que permite que la lea curaduría sin que eso reparta domicilios.
    for (const prohibido of [
      'address',
      'recipient_name',
      'phone',
      'buyer',
      'total_minor',
      'direccion',
    ]) {
      assert.ok(!bandeja.includes(prohibido), `aparece «${prohibido}»`);
    }
  });

  it('LA BANDEJA NO DESPACHA NI ENTREGA', () => {
    // Sacar la caja del almacén solo puede afirmarlo quien la saca, y escribir
    // «llegó» sin saberlo es fabricar una entrega.
    for (const prohibido of ['despachar', 'dispatch', 'registrarEntrega', 'DELIVERED']) {
      assert.ok(!bandeja.includes(prohibido), `aparece «${prohibido}»`);
    }
  });

  it('la lista de la tienda no enseña la dirección completa', () => {
    // La ciudad basta para ordenar el trabajo; el domicilio está en el detalle,
    // donde se entra a propósito y no se lee por encima del hombro.
    for (const prohibido of ['address_line', 'recipient_name', 'phone']) {
      assert.ok(!tienda.includes(prohibido), `aparece «${prohibido}»`);
    }
  });

  it('despachar PREGUNTA ANTES, porque saca unidades del almacén', () => {
    assert.ok(preparar.includes('confirm('), 'falta la confirmación');
    assert.ok(preparar.includes('envio.preparar.confirmarDespachoCuerpo'));
  });

  it('el comprador ve el seguimiento y NO ve una fecha de llegada', () => {
    assert.ok(comprador.includes('envio.detalle.sinFechaPrevista'));
    for (const prohibido of ['estimated', 'llegaEl', 'fechaDeLlegada']) {
      assert.ok(!comprador.includes(prohibido), `aparece «${prohibido}»`);
    }
  });

  it('las cuatro rutas son alcanzables desde una pantalla', () => {
    // UNA RUTA QUE SOLO FUNCIONA ESCRIBIENDO LA URL NO ESTÁ TERMINADA.
    const misProductos = sinComentarios(fuente('screens', 'MisProductosScreen.tsx'));
    const adminProductos = sinComentarios(fuente('screens', 'AdminProductosScreen.tsx'));
    assert.ok(misProductos.includes("'/proveedor/pedidos'"), 'pedidos de mi tienda');
    assert.ok(tienda.includes('/proveedor/pedidos/'), 'el detalle del pedido');
    assert.ok(adminProductos.includes("'/admin/productos/envios'"), 'la bandeja');
  });
});
