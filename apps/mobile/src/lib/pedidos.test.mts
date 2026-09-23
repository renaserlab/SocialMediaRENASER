/**
 * El pedido de un producto físico, ejecutado.
 *
 * Lo que se prueba aquí es, otra vez, LO QUE NO SE PUEDE DECIR. Un checkout es
 * la pantalla donde más caro sale mentir: basta con un «Envío: 0,00», con un
 * «compra protegida» sin política detrás o con un «pagado» deducido de un
 * parámetro de la URL para prometer algo que Z no puede cumplir.
 *
 *  1. IMPUESTOS Y ENVÍO NO SON CERO: están sin decidir, y se dicen con palabras.
 *  2. NO SE DICE «COMPRA PROTEGIDA» SIN PLAZO DE INCIDENCIAS.
 *  3. UN PLAZO NULO NO SE ENSEÑA COMO UN NÚMERO.
 *  4. LA VUELTA DEL NAVEGADOR NO CONFIRMA DINERO: la pantalla pregunta al
 *     servidor y ningún parámetro de la URL decide un estado.
 *  5. CANCELAR SOLO ANTES DE PAGAR: después es un reembolso, y no existe.
 *  6. LA DIRECCIÓN NO GUARDA UBICACIÓN EXACTA, y el distrito es obligatorio
 *     donde la dirección no se entiende sin él.
 *  7. NINGÚN FORMULARIO DE TARJETA, ni PayPal, ni nada que lo parezca.
 *  8. EL DOBLE TOQUE ESTÁ BLOQUEADO, y con una clave que viaja al servidor.
 *  9. LOS IMPORTES NO SE CALCULAN AQUÍ.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Condiciones, Pedido, Preparacion } from './pedidos.ts';

/** El mismo resolutor que `carrito.test.mts`, y por lo mismo: `@/` no es Node. */
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
  ESTADOS_DE_PEDIDO,
  ESTADOS_EN_CURSO,
  HAY_ENVIO,
  HAY_IMPUESTOS,
  PAISES_CON_DISTRITO,
  camposIncompletos,
  claveDeErrorDePedidos,
  claveDeLaCompra,
  claveDelCampo,
  claveDelEstado,
  claveDeLoQueFalta,
  direccionCompleta,
  direccionEnUnaLinea,
  esPedidoApagado,
  esperaPago,
  gruposComprables,
  iconoDelEstado,
  mezclaProveedores,
  minutosDeReserva,
  plazoConfigurado,
  precioUnitario,
  reservaVencida,
  sePuedeCancelar,
  sePuedeComprar,
  sePuedeDecirCompraProtegida,
  sePuedePagar,
  subtotalDelGrupo,
  totalDeLaLinea,
  totalDelPedido,
} = await import('./pedidos.ts');

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

function condiciones(campos: Partial<Condiciones> = {}): Condiciones {
  return {
    policy_id: 'pol-1',
    country_code: 'PE',
    version: 1,
    seller_entity: 'Entidad de prueba S.A.C.',
    currency: 'PEN',
    terms: 'Un texto suficientemente largo para ser unas condiciones de venta.',
    terms_sha256: 'a'.repeat(64),
    incident_report_hours: 72,
    return_shipment_days: 7,
    withdrawal_days: 7,
    buyer_pays_return_for_remorse: true,
    seller_pays_return_for_defect: true,
    warranty_rules_url: null,
    effective_at: '2026-01-01T00:00:00Z',
    ...campos,
  };
}

function pedido(campos: Partial<Pedido> = {}): Pedido {
  return {
    id: 'ped-1',
    status: 'PENDING_PAYMENT',
    seller_id: 'v-1',
    seller_name: 'Taller Andino',
    currency: 'PEN',
    subtotal_minor: 36_000,
    total_minor: 36_000,
    reserved_until: null,
    paid_at: null,
    cancelled_at: null,
    expired_at: null,
    failed_at: null,
    review_reason: null,
    policy: condiciones(),
    address: {
      recipient_name: 'Quien recibe',
      phone: '+51987654321',
      country_code: 'PE',
      region: 'Lima',
      city: 'Lima',
      district: 'Miraflores',
      address_line: 'Avenida siempre viva 742',
      reference: null,
      postal_code: null,
      instructions: null,
    },
    items: [
      {
        id: 'l-1',
        product_id: 'p-1',
        version_id: 'v-1',
        variant_id: 'var-1',
        sku: 'CUCH-20',
        name: 'Cuchillo de cocina forjado',
        variant_name: '20 cm',
        unit_price_minor: 18_000,
        quantity: 2,
        subtotal_minor: 36_000,
      },
    ],
    history: [],
    created_at: '2026-09-17T10:00:00Z',
    ...campos,
  };
}

function preparacion(campos: Partial<Preparacion> = {}): Preparacion {
  return {
    disponible: true,
    pending_configuration: [],
    countries_with_policy: ['PE'],
    groups: [
      {
        seller_id: 'v-1',
        seller_name: 'Taller Andino',
        item_ids: ['i-1'],
        units: 2,
        currency: 'PEN',
        subtotal_minor: 36_000,
        purchasable: true,
        issues: [],
      },
    ],
    open_order_id: null,
    ...campos,
  };
}

/* ========================================================================== */
describe('IMPUESTOS Y ENVÍO NO SON CERO', () => {
  it('no existen, y eso se dice en un solo sitio', () => {
    // Un `false` aquí es lo que impide que alguien pinte una línea «Envío» con
    // un cero al lado. Cuando existan de verdad, esto cambia y las pantallas
    // con él.
    assert.equal(HAY_IMPUESTOS, false);
    assert.equal(HAY_ENVIO, false);
  });

  it('el total del pedido es el que mandó el servidor, sin sumarle nada', () => {
    const total = totalDelPedido(pedido());
    assert.equal(total.configurado, true);
    assert.ok(total.configurado && total.texto.includes('360'));
  });

  it('sin pedido no se enseña «0.00»', () => {
    assert.equal(totalDelPedido(null).configurado, false);
  });

  it('un grupo sin nada comprable tampoco', () => {
    assert.equal(subtotalDelGrupo(null).configurado, false);
    const vacio = { ...preparacion().groups[0]!, subtotal_minor: null, currency: null };
    assert.equal(subtotalDelGrupo(vacio).configurado, false);
  });
});

/* ========================================================================== */
describe('NO SE DICE «COMPRA PROTEGIDA» SIN POLÍTICA', () => {
  it('con plazo de incidencias, sí', () => {
    assert.equal(sePuedeDecirCompraProtegida(condiciones()), true);
  });

  it('sin plazo, NO: no hay ninguna protección que ofrecer', () => {
    assert.equal(
      sePuedeDecirCompraProtegida(condiciones({ incident_report_hours: null })),
      false,
    );
  });

  it('y sin condiciones tampoco', () => {
    assert.equal(sePuedeDecirCompraProtegida(null), false);
  });

  it('un plazo nulo no cuenta como configurado, y cero sí es una decisión', () => {
    assert.equal(plazoConfigurado(null), false);
    assert.equal(plazoConfigurado(undefined), false);
    // CERO SÍ ES UN NÚMERO: «cero días para desistir» es una decisión legal que
    // alguien puede haber tomado, y enseñarla como «pendiente» la escondería.
    assert.equal(plazoConfigurado(0), true);
  });
});

/* ========================================================================== */
describe('LOS ESTADOS LOS ESCRIBE EL SERVIDOR', () => {
  it('los siete, y ninguno más', () => {
    assert.deepEqual([...ESTADOS_DE_PEDIDO], [
      'PENDING_PAYMENT',
      'PAYMENT_PROCESSING',
      'PAID',
      'PAYMENT_FAILED',
      'EXPIRED',
      'CANCELLED',
      'UNDER_REVIEW',
    ]);
  });

  it('uno desconocido tiene su propia clave, no ninguna', () => {
    assert.equal(claveDelEstado('PAID'), 'pedidoDeProducto.estado.PAID');
    assert.equal(claveDelEstado('LO_QUE_SEA'), 'pedidoDeProducto.estado.desconocido');
    assert.equal(iconoDelEstado('LO_QUE_SEA'), null);
  });

  it('solo dos estados siguen apartando existencias', () => {
    assert.deepEqual([...ESTADOS_EN_CURSO], ['PENDING_PAYMENT', 'PAYMENT_PROCESSING']);
    assert.equal(esperaPago(pedido()), true);
    assert.equal(esperaPago(pedido({ status: 'PAID' })), false);
  });
});

/* ========================================================================== */
describe('CANCELAR SOLO ANTES DE PAGAR', () => {
  it('pendiente y procesando sí', () => {
    assert.equal(sePuedeCancelar(pedido()), true);
    assert.equal(sePuedeCancelar(pedido({ status: 'PAYMENT_PROCESSING' })), true);
  });

  it('PAGADO NO: eso sería un reembolso, y no existe', () => {
    assert.equal(sePuedeCancelar(pedido({ status: 'PAID' })), false);
  });

  it('ni vencido, ni cancelado, ni en revisión', () => {
    for (const estado of ['EXPIRED', 'CANCELLED', 'UNDER_REVIEW']) {
      assert.equal(sePuedeCancelar(pedido({ status: estado })), false, estado);
    }
  });

  it('un cobro fallido se puede reintentar mientras la reserva viva', () => {
    assert.equal(sePuedePagar(pedido({ status: 'PAYMENT_FAILED' })), true);
    assert.equal(sePuedePagar(pedido({ status: 'PAID' })), false);
    assert.equal(sePuedePagar(null), false);
  });
});

/* ========================================================================== */
describe('LA DIRECCIÓN', () => {
  const completa = {
    recipient_name: 'Quien recibe',
    phone: '+51987654321',
    country_code: 'PE',
    region: 'Lima',
    city: 'Lima',
    district: 'Miraflores',
    address_line: 'Avenida siempre viva 742',
  };

  it('completa es completa', () => {
    assert.deepEqual(camposIncompletos(completa), []);
    assert.equal(direccionCompleta(completa), true);
  });

  it('el distrito es obligatorio donde la dirección no se entiende sin él', () => {
    assert.ok(PAISES_CON_DISTRITO.includes('PE'));
    assert.deepEqual(camposIncompletos({ ...completa, district: '' }), ['district']);
  });

  it('y NO lo es donde ese nivel no existe: exigirlo obligaría a inventarlo', () => {
    const otro = { ...completa, country_code: 'ES', district: '' };
    assert.deepEqual(camposIncompletos(otro), []);
  });

  it('se dicen TODOS los que faltan, no el primero', () => {
    const faltan = camposIncompletos({ country_code: 'PE' });
    assert.ok(faltan.length > 3, JSON.stringify(faltan));
    assert.ok(faltan.includes('recipient_name'));
    assert.ok(faltan.includes('address_line'));
  });

  it('un país mal escrito es un país que falta', () => {
    assert.ok(camposIncompletos({ ...completa, country_code: 'P' }).includes('country_code'));
    assert.ok(camposIncompletos({ ...completa, country_code: '12' }).includes('country_code'));
  });

  it('el resumen de la dirección NO lleva el teléfono', () => {
    const linea = direccionEnUnaLinea(pedido().address);
    assert.ok(linea.includes('Avenida siempre viva 742'));
    assert.ok(!linea.includes('+51987654321'));
  });

  it('cada campo tiene su nombre traducible', () => {
    assert.equal(claveDelCampo('city'), 'pedidoDeProducto.direccion.city');
  });
});

/* ========================================================================== */
describe('LA RESERVA', () => {
  const ahora = Date.parse('2026-09-17T10:00:00Z');

  it('cuenta los minutos enteros que quedan, redondeando HACIA ABAJO', () => {
    // Decir «queda 1 minuto» cuando quedan 20 segundos es lo que hace que
    // alguien se confíe.
    assert.equal(minutosDeReserva('2026-09-17T10:20:50Z', ahora), 20);
    assert.equal(minutosDeReserva('2026-09-17T10:00:40Z', ahora), 0);
  });

  it('sin reserva no hay número, y `null` no es cero', () => {
    assert.equal(minutosDeReserva(null, ahora), null);
    assert.equal(minutosDeReserva('', ahora), null);
    assert.equal(minutosDeReserva('no es una fecha', ahora), null);
    assert.equal(reservaVencida(null, ahora), false);
  });

  it('una reserva pasada está vencida', () => {
    assert.equal(reservaVencida('2026-09-17T09:00:00Z', ahora), true);
    assert.equal(reservaVencida('2026-09-17T11:00:00Z', ahora), false);
  });
});

/* ========================================================================== */
describe('LA PREPARACIÓN DEL CHECKOUT', () => {
  it('sin `disponible` no se compra, aunque haya grupos comprables', () => {
    assert.equal(sePuedeComprar(preparacion()), true);
    assert.equal(sePuedeComprar(preparacion({ disponible: false })), false);
    assert.equal(sePuedeComprar(null), false);
  });

  it('lo que falta se dice con palabras, no con un código', () => {
    assert.equal(
      claveDeLoQueFalta('feature_product_sales'),
      'pedidoDeProducto.falta.feature_product_sales',
    );
    assert.equal(claveDeLoQueFalta('lo_que_sea'), 'pedidoDeProducto.falta.desconocido');
  });

  it('un grupo bloqueado no es comprable', () => {
    const p = preparacion({
      groups: [{ ...preparacion().groups[0]!, purchasable: false, issues: ['insufficient_stock'] }],
    });
    assert.deepEqual(gruposComprables(p), []);
  });

  it('con dos proveedores hay que elegir: no se cobra a varios en silencio', () => {
    const uno = preparacion().groups[0]!;
    const dos = { ...uno, seller_id: 'v-2', seller_name: 'Otro taller' };
    assert.equal(mezclaProveedores(preparacion()), false);
    assert.equal(mezclaProveedores(preparacion({ groups: [uno, dos] })), true);
  });
});

/* ========================================================================== */
describe('LOS ERRORES', () => {
  it('cada código tiene su frase', () => {
    assert.equal(
      claveDeErrorDePedidos('product_policy_not_configured'),
      'pedidoDeProducto.error.sinPolitica',
    );
    assert.equal(claveDeErrorDePedidos('lo_que_sea'), null);
    assert.equal(claveDeErrorDePedidos(null), null);
  });

  it('la 0078 sin aplicar se distingue de una avería', () => {
    assert.equal(esPedidoApagado('product_orders_not_available'), true);
    assert.equal(esPedidoApagado('product_order_not_found'), false);
  });
});

/* ========================================================================== */
describe('EL DOBLE TOQUE', () => {
  it('la clave es distinta en dos pulsaciones y la misma en un reintento', () => {
    assert.equal(claveDeLaCompra('v-1', 1000), claveDeLaCompra('v-1', 1000));
    assert.notEqual(claveDeLaCompra('v-1', 1000), claveDeLaCompra('v-1', 2000));
    assert.notEqual(claveDeLaCompra('v-1', 1000), claveDeLaCompra('v-2', 1000));
  });
});

/* ========================================================================== */
describe('lo que las pantallas del pedido tienen escrito', () => {
  const checkout = sinComentarios(fuente('screens', 'CheckoutDeProductosScreen.tsx'));
  const detalle = sinComentarios(fuente('screens', 'PedidoDeProductoScreen.tsx'));
  const lista = sinComentarios(fuente('screens', 'MisPedidosDeProductosScreen.tsx'));
  const repositorio = sinComentarios(fuente('repositories', 'ProductOrderRepository.ts'));

  it('NINGÚN FORMULARIO DE TARJETA, ni PayPal, ni nada que lo parezca', () => {
    for (const pantalla of [checkout, detalle, lista]) {
      const bajo = pantalla.toLowerCase();
      for (const prohibido of [
        'paypal',
        'cardnumber',
        'card_number',
        'numero de tarjeta',
        'cvv',
        'cvc',
        'expiry',
        'securetextentry',
      ]) {
        assert.ok(!bajo.includes(prohibido), `una pantalla dice «${prohibido}»`);
      }
    }
  });

  it('el checkout NO pinta impuestos ni envío, y lo dice', () => {
    assert.ok(checkout.includes('sinImpuestosNiEnvio'));
    for (const prohibido of ['0.00', '?? 0', 'impuesto: 0', 'envio: 0']) {
      assert.ok(!checkout.toLowerCase().includes(prohibido), prohibido);
    }
  });

  it('y ningún importe se calcula en la pantalla', () => {
    for (const pantalla of [checkout, detalle]) {
      for (const suma of ['reduce(', '* linea.quantity', 'quantity *', '* item.quantity']) {
        assert.ok(!pantalla.includes(suma), `la pantalla suma con «${suma}»`);
      }
    }
    assert.ok(checkout.includes('subtotalDelGrupo('));
    assert.ok(detalle.includes('totalDelPedido('));
  });

  it('la vuelta del navegador NO decide ningún estado', () => {
    // El parámetro solo elige unas palabras. El estado sale de `leer`, que
    // pregunta al servidor, y esa llamada es lo primero que hace la pantalla.
    assert.ok(detalle.includes('ProductOrderRepository.leer('));
    assert.ok(detalle.includes("f(claveDelEstado(pedido.status))"));
    for (const prohibido of ["setPedido({ status: 'PAID'", "status = 'PAID'"]) {
      assert.ok(!detalle.includes(prohibido), prohibido);
    }
  });

  it('pagar abre la pasarela FUERA, y vuelve a preguntar', () => {
    assert.ok(detalle.includes('Linking.openURL('));
    assert.ok(detalle.includes('ProductOrderRepository.iniciarPago('));
  });

  it('el doble toque está bloqueado con una referencia, no con un estado', () => {
    for (const pantalla of [checkout, detalle]) {
      assert.ok(pantalla.includes('ocupadoRef'));
      assert.ok(pantalla.includes('ocupadoRef.current = true'));
    }
  });

  it('y la petición lleva una clave de idempotencia generada aquí', () => {
    assert.ok(checkout.includes('claveDeLaCompra('));
    assert.ok(repositorio.includes("'Idempotency-Key'"));
  });

  it('el repositorio NO manda ningún importe hacia arriba', () => {
    for (const prohibido of ['total_minor:', 'subtotal_minor:', 'amount:', 'price:']) {
      assert.ok(!repositorio.includes(prohibido), prohibido);
    }
  });

  it('ningún texto en duro: todo pasa por el traductor', () => {
    for (const pantalla of [checkout, detalle, lista]) {
      for (const atributo of ['label="', 'title="', 'description="', 'placeholder="']) {
        assert.ok(!pantalla.includes(atributo), atributo);
      }
    }
  });

  it('las tres tienen «Atrás» y no dejan a nadie encerrado', () => {
    for (const pantalla of [checkout, detalle, lista]) {
      assert.ok(pantalla.includes('onBack={volver}'));
      assert.ok(pantalla.includes('router.canGoBack()'));
    }
  });

  it('y los cuatro estados de carga, vacío, error y sin conexión', () => {
    for (const pantalla of [checkout, detalle, lista]) {
      assert.ok(pantalla.includes("state=\"loading\""));
      assert.ok(pantalla.includes("'sinConexion'"));
      assert.ok(pantalla.includes('onRetry='));
    }
  });
});

/* ========================================================================== */
describe('los importes de una línea se escriben, no se calculan', () => {
  it('el unitario y el de la línea salen del servidor', () => {
    const linea = pedido().items[0]!;
    const unitario = precioUnitario(linea, 'PEN');
    const total = totalDeLaLinea(linea, 'PEN');
    assert.equal(unitario.configurado, true);
    assert.equal(total.configurado, true);
    // 18000 x 2 = 36000, y el 36000 viene del servidor: aquí no se multiplica.
    assert.ok(total.configurado && total.texto.includes('360'));
  });
});

describe('a «mis pedidos» se llega sin escribir la URL', () => {
  const portada = fuente('screens', 'ProductosScreen.tsx');
  const bolsa = fuente('screens', 'CarritoScreen.tsx');

  it('la portada de Productos ofrece el acceso a los pedidos', () => {
    // EL BLOQUEANTE QUE ENCONTRÓ LA REVISIÓN INDEPENDIENTE.
    //
    // El único enlace hacia adelante a `/productos/pedidos` vivía en el pie de
    // la bolsa, DENTRO de la rama que se pinta cuando hay líneas. Y el servidor
    // quita de la bolsa exactamente lo que se compró, así que con un solo
    // proveedor la bolsa queda vacía justo después de pagar: la pantalla sale
    // por el estado vacío, el pie no se pinta, y no queda ninguna puerta.
    //
    // A partir de ahí no se podía ver el pedido, ni pagar uno pendiente, ni
    // confirmar que llegó, ni reclamar, ni valorar, ni dar la conformidad:
    // todo eso cuelga del detalle del pedido.
    //
    // Se comprueba en la PORTADA porque es donde alguien lo busca, al lado de
    // la bolsa y de guardados; no en el sitio donde se vio el síntoma.
    assert.ok(
      portada.includes("router.push('/productos/pedidos'"),
      'la portada de Productos no lleva a «mis pedidos»',
    );
  });

  it('y el pie de la bolsa lo ofrece también con la bolsa VACÍA', () => {
    // Su propio comentario decía «SIEMPRE, haya o no algo que comprar», y el
    // bloque estaba dentro de la rama con líneas. Ahora el estado vacío lleva
    // el mismo acceso.
    const vacio = bolsa.slice(
      bolsa.indexOf('if (carritoVacio(carrito))'),
      bolsa.indexOf('const leido = carrito as Carrito;'),
    );
    assert.ok(vacio.length > 100, 'no encontré la rama de la bolsa vacía');
    assert.ok(
      vacio.includes("/productos/pedidos"),
      'con la bolsa vacía no hay forma de llegar a los pedidos',
    );
  });
});
