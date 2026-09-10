/**
 * Las reglas del pedido y de la entrada, ejecutadas.
 *
 * Las que más importan: que un intento no se lea como un pago, que una entrada
 * usada no vuelva a ofrecerse, y que la pantalla no llame factura a lo que no lo
 * es. Lo tercero se comprueba sobre el CÓDIGO de las pantallas, porque no es una
 * función: es lo que está escrito.
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
  ESTADOS_DE_ENTRADA,
  ESTADOS_DE_PEDIDO,
  RESULTADOS_DE_ADMISION,
  claveDelEstadoDeEntrada,
  claveDelEstadoDePedido,
  claveDelResultado,
  codigoLegible,
  codigoTecleado,
  cuantasEntradas,
  entradaVigente,
  estaCerrado,
  motivoParaNoPedir,
  pareceUnCodigo,
  repartirEntradas,
  siguePagable,
} from './pedidoDeEntradas.ts';

const AQUI = fileURLToPath(new URL('.', import.meta.url));
const PANTALLAS = join(AQUI, '..', 'screens');

function fuente(nombre: string): string {
  return readFileSync(join(PANTALLAS, nombre), 'utf8');
}

/** El código sin comentarios: lo que la pantalla HACE, no lo que explica. */
function sinComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((linea) => !linea.trim().startsWith('//'))
    .join('\n');
}

describe('un intento no es un pago', () => {
  it('solo lo pendiente o en curso sigue siendo pagable', () => {
    assert.equal(siguePagable('PENDING_PAYMENT', 60), true);
    assert.equal(siguePagable('PAYMENT_PROCESSING', 60), true);
  });

  it('un pedido PAGADO no se vuelve a pagar', () => {
    // Ofrecer el botón sobre él es como alguien paga dos veces lo mismo.
    assert.equal(siguePagable('PAID', 60), false);
  });

  it('sin tiempo en la reserva no se paga, diga lo que diga el estado', () => {
    assert.equal(siguePagable('PENDING_PAYMENT', 0), false);
    assert.equal(siguePagable('PAYMENT_PROCESSING', -1), false);
  });

  it('lo fallido, vencido y cancelado tampoco', () => {
    for (const estado of ['PAYMENT_FAILED', 'EXPIRED', 'CANCELLED']) {
      assert.equal(siguePagable(estado, 600), false, estado);
    }
  });
});

describe('un pedido cerrado se dice cerrado', () => {
  it('un pagado NO está cerrado: lleva a sus entradas', () => {
    assert.equal(estaCerrado('PAID', 0), false);
  });

  it('un pendiente sin tiempo sí, aunque su estado tarde en decirlo', () => {
    assert.equal(estaCerrado('PENDING_PAYMENT', 0), true);
    assert.equal(estaCerrado('PENDING_PAYMENT', 30), false);
  });

  it('y los estados terminales, siempre', () => {
    for (const estado of ['PAYMENT_FAILED', 'EXPIRED', 'CANCELLED']) {
      assert.equal(estaCerrado(estado, 600), true, estado);
    }
  });
});

describe('las entradas se reparten en tres montones', () => {
  const entradas = [
    { id: '1', status: 'VALID' },
    { id: '2', status: 'USED' },
    { id: '3', status: 'REVOKED' },
    { id: '4', status: 'VALID' },
  ];

  it('cada una en el suyo', () => {
    const { vigentes, usadas, revocadas } = repartirEntradas(entradas);
    assert.deepEqual(vigentes.map((e) => e.id), ['1', '4']);
    assert.deepEqual(usadas.map((e) => e.id), ['2']);
    assert.deepEqual(revocadas.map((e) => e.id), ['3']);
  });

  it('y ninguna desaparece', () => {
    const { vigentes, usadas, revocadas } = repartirEntradas(entradas);
    assert.equal(vigentes.length + usadas.length + revocadas.length, entradas.length);
  });

  it('solo la válida sirve para entrar', () => {
    assert.equal(entradaVigente('VALID'), true);
    assert.equal(entradaVigente('USED'), false);
    assert.equal(entradaVigente('REVOKED'), false);
  });
});

describe('el código que se dicta y el que se teclea', () => {
  it('se agrupa para poder leerlo en voz alta', () => {
    assert.equal(codigoLegible('ABCD2345EFGH67'), 'ABCD 2345 EFGH 67');
  });

  it('y lo tecleado vuelve a ser el código, con espacios o sin ellos', () => {
    assert.equal(codigoTecleado('abcd 2345-efgh 67'), 'ABCD2345EFGH67');
  });

  it('lo que no puede ser un código no se manda', () => {
    // Cada envío es un intento anotado en la puerta.
    assert.equal(pareceUnCodigo(''), false);
    assert.equal(pareceUnCodigo('ABC'), false);
    assert.equal(pareceUnCodigo('ABCD2345EFGH67'), true);
    assert.equal(pareceUnCodigo('A'.repeat(30)), false);
  });

  it('un código vacío no se pinta como espacios', () => {
    assert.equal(codigoLegible(''), '');
    assert.equal(codigoLegible('   '), '');
  });
});

describe('cuántas entradas trae un pedido', () => {
  it('suma las líneas', () => {
    assert.equal(cuantasEntradas([{ quantity: 2 }, { quantity: 3 }]), 5);
  });

  it('un pedido sin líneas no trae ninguna', () => {
    assert.equal(cuantasEntradas([]), 0);
  });
});

describe('por qué no se puede pedir', () => {
  it('un pedido pagado ya no se pide', () => {
    assert.equal(motivoParaNoPedir('PAID', 600), 'pedido.yaPagado');
  });

  it('sin reserva viva tampoco', () => {
    assert.equal(motivoParaNoPedir('PENDING_PAYMENT', 0), 'pedido.reservaVencida');
  });

  it('y cuando se puede, no hay motivo', () => {
    assert.equal(motivoParaNoPedir('PENDING_PAYMENT', 600), null);
  });
});

describe('todo lo que el servidor puede decir tiene su frase', () => {
  const diccionarios = [
    ['es', es],
    ['en', en],
    ['pt', pt],
  ] as Array<[string, Record<string, string>]>;

  it('los seis estados de un pedido', () => {
    for (const estado of ESTADOS_DE_PEDIDO) {
      const clave = claveDelEstadoDePedido(estado);
      for (const [nombre, diccionario] of diccionarios) {
        assert.ok((diccionario[clave] ?? '').trim() !== '', `falta ${clave} en ${nombre}`);
      }
    }
  });

  it('los tres estados de una entrada', () => {
    for (const estado of ESTADOS_DE_ENTRADA) {
      const clave = claveDelEstadoDeEntrada(estado);
      for (const [nombre, diccionario] of diccionarios) {
        assert.ok((diccionario[clave] ?? '').trim() !== '', `falta ${clave} en ${nombre}`);
      }
    }
  });

  it('los seis resultados de la puerta', () => {
    for (const resultado of RESULTADOS_DE_ADMISION) {
      const clave = claveDelResultado(resultado);
      for (const [nombre, diccionario] of diccionarios) {
        assert.ok((diccionario[clave] ?? '').trim() !== '', `falta ${clave} en ${nombre}`);
      }
    }
  });

  it('y lo desconocido también, que es lo que se pinta si el servidor cambia', () => {
    for (const clave of [
      claveDelEstadoDePedido('LO_QUE_SEA'),
      claveDelEstadoDeEntrada('LO_QUE_SEA'),
      claveDelResultado('LO_QUE_SEA'),
    ]) {
      assert.ok(clave.endsWith('.desconocido'));
      for (const [nombre, diccionario] of diccionarios) {
        assert.ok((diccionario[clave] ?? '').trim() !== '', `falta ${clave} en ${nombre}`);
      }
    }
  });
});

describe('las pantallas no prometen lo que no hay', () => {
  const PEDIDO = sinComentarios(fuente('PedidoDeEntradasScreen.tsx'));
  const ENTRADA = sinComentarios(fuente('MiEntradaScreen.tsx'));
  const VENTAS = sinComentarios(fuente('VentasDelEventoScreen.tsx'));
  const CHECKIN = sinComentarios(fuente('CheckInScreen.tsx'));

  it('no se llama factura ni boleta a un resumen interno', () => {
    // SIN LA CLAVE QUE LO NIEGA. `pedido.noEsUnaFactura` lleva esa palabra en
    // el nombre justamente para decir que NO lo es; contarla como una promesa
    // haria que la prueba se disparase con su propio remedio.
    const NIEGA = /t\('pedido\.noEsUnaFactura'\)/g;
    for (const pantalla of [PEDIDO, ENTRADA, VENTAS]) {
      assert.ok(!/[Ff]actura|[Bb]oleta|[Ii]nvoice/.test(pantalla.replace(NIEGA, '')));
    }
  });

  it('y el texto que se ensena dice explicitamente que no lo es', () => {
    assert.ok(PEDIDO.includes("t('pedido.noEsUnaFactura')"));
    for (const [nombre, diccionario] of [
      ['es', es],
      ['en', en],
      ['pt', pt],
    ] as Array<[string, Record<string, string>]>) {
      assert.ok(
        (diccionario['pedido.noEsUnaFactura'] ?? '').trim() !== '',
        `falta en ${nombre}`,
      );
    }
  });

  it('el estado del pago sale del SERVIDOR, no de haber vuelto del navegador', () => {
    // Se pinta la clave del estado que dice el servidor; no hay ningún
    // `setPedido({...pedido, status: 'PAID'})` optimista.
    assert.ok(PEDIDO.includes('claveDelEstadoDePedido(pedido.status)'));
    assert.ok(!PEDIDO.includes("status: 'PAID'"));
  });

  it('el importe no viaja hacia el servidor en ninguna llamada', () => {
    const repo = sinComentarios(
      readFileSync(join(AQUI, '..', 'repositories', 'EventOrderRepository.ts'), 'utf8'),
    );
    assert.ok(!/amount|importe|precio/i.test(repo.split('export const')[1] ?? ''));
  });

  it('el ingreso del organizador se llama BRUTO y se explica', () => {
    assert.ok(VENTAS.includes("t('ventasDeEvento.bruto')"));
    assert.ok(VENTAS.includes("t('ventasDeEvento.brutoExplicado')"));
  });

  it('sin moneda no se escribe ningún importe', () => {
    assert.ok(VENTAS.includes('ventas.currency'));
    assert.ok(VENTAS.includes("t('ventasDeEvento.sinMoneda')"));
  });

  it('sin conexión la puerta no dice que pase', () => {
    assert.ok(CHECKIN.includes("setError(t('checkin.sinConexion'))"));
    assert.ok(CHECKIN.includes('setVeredicto(null)'));
  });

  it('dos toques no crean dos pedidos ni dos escaneos', () => {
    assert.ok(PEDIDO.includes('if (ocupadoRef.current || !id) return;'));
    assert.ok(CHECKIN.includes('if (ocupadoRef.current || !id) return;'));
  });

  it('el QR se dibuja con el valor del servidor y no se guarda', () => {
    assert.ok(ENTRADA.includes('value={credencial.credential}'));
    assert.ok(!/base64|toDataURL|saveToLibrary/i.test(ENTRADA));
  });

  it('y solo si la entrada sirve', () => {
    assert.ok(ENTRADA.includes('entradaVigente(ficha.status)'));
  });
});
