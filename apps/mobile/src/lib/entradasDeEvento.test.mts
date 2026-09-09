/**
 * Las reglas de la selección de entradas, ejecutadas.
 *
 * Las dos que más importan: que el dinero no toque un flotante en ningún punto,
 * y que la pantalla nunca llame «total» a lo que es un subtotal. Lo segundo no
 * es una cuestión de estilo: faltan comisión e impuestos que la empresa no ha
 * definido, y un total es una cifra que alguien va a pagar.
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
  MODOS_DE_ACCESO,
  MODOS_OFRECIDOS,
  cantidadPosible,
  claveDelEstadoDeReserva,
  claveDelModo,
  comoReloj,
  cuantasElegidas,
  enteroEscrito,
  hayExistencias,
  motivoParaNoGuardarTipo,
  motivoParaNoReservar,
  precioDesde,
  segundosRestantes,
  sigueEnPie,
  subtotal,
  subtotalDe,
  topeDe,
  vendeEntradas,
  type TipoDeEntrada,
} from './entradasDeEvento.ts';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

/**
 * El código sin comentarios.
 *
 * Hace falta para lo que se busca aquí: un comentario que dice «ni un `toFixed`
 * en mitad de una cuenta» contiene la palabra `toFixed`, y una prueba que busca
 * la cadena a secas se pone roja por la explicación de por qué no está. Lo que
 * hay que mirar es lo que se EJECUTA.
 */
const BLOQUE = new RegExp('/\\*[\\s\\S]*?\\*/', 'g');
const LINEA = new RegExp('//[^\\n]*', 'g');
const codigo = (rel: string) =>
  fuente(rel).replace(BLOQUE, ' ').replace(LINEA, ' ');

const tipo = (extra: Partial<TipoDeEntrada> = {}): TipoDeEntrada => ({
  id: 't1',
  name: 'General',
  description: '',
  price_minor: 4900,
  currency: 'PEN',
  min_per_order: 1,
  max_per_order: 4,
  inclusions: [],
  restrictions: [],
  sort_order: 0,
  disponibles: 10,
  ...extra,
});

describe('el dinero, en enteros', () => {
  it('el subtotal de un tipo es una multiplicación', () => {
    assert.equal(subtotalDe(tipo({ price_minor: 4900 }), 3), 14700);
  });

  it('con precio cero sigue siendo cero', () => {
    // Una cortesía dentro de un evento con entradas es un caso real.
    assert.equal(subtotalDe(tipo({ price_minor: 0 }), 5), 0);
  });

  it('media entrada no existe', () => {
    assert.equal(subtotalDe(tipo({ price_minor: 4900 }), 1.5), 4900);
  });

  it('una cantidad negativa no resta dinero', () => {
    assert.equal(subtotalDe(tipo({ price_minor: 4900 }), -2), 0);
  });

  it('el subtotal de varios tipos suma enteros', () => {
    const tipos = [
      tipo({ id: 'a', price_minor: 1000 }),
      tipo({ id: 'b', price_minor: 25000 }),
    ];
    assert.equal(subtotal(tipos, { a: 3, b: 2 }), 3 * 1000 + 2 * 25000);
  });

  it('NINGUNA cuenta de dinero pasa por un flotante', () => {
    /*
      Ni una división, ni un `toFixed`, ni un `parseFloat`: un flotante en
      dinero es un descuadre con fecha.

      SE MIRA SOLO EL TRAMO DEL DINERO, no el fichero entero. Más abajo hay una
      división legítima —milisegundos a segundos, para la cuenta atrás— y
      prohibirla también convertiría esta prueba en un obstáculo que se termina
      desactivando. Lo que no puede dividirse son los céntimos.
    */
    const reglas = codigo('lib/entradasDeEvento.ts');
    const desde = reglas.indexOf('export function subtotalDe');
    const hasta = reglas.indexOf('export function motivoParaNoReservar');
    assert.ok(desde !== -1 && hasta > desde, 'no se encontró el tramo del dinero');
    const dinero = reglas.slice(desde, hasta);
    for (const prohibido of ['toFixed', 'parseFloat', '/', '* 0.', 'Number(']) {
      assert.ok(!dinero.includes(prohibido), prohibido);
    }
  });
});

describe('cuántas se pueden pedir', () => {
  it('no más de las que quedan', () => {
    assert.equal(topeDe(tipo({ disponibles: 2 }), {}, null), 2);
  });

  it('ni más del máximo por operación', () => {
    assert.equal(topeDe(tipo({ disponibles: 50, max_per_order: 4 }), {}, null), 4);
  });

  it('ni más de lo que cabe en el evento, contando los otros tipos', () => {
    // Dos tipos que suman más que el aforo es exactamente el caso que hace
    // vender entradas para una sala en la que no caben.
    const t = tipo({ id: 'a', disponibles: 50, max_per_order: 10 });
    assert.equal(topeDe(t, { b: 3 }, 5), 2);
  });

  it('sin aforo general solo mandan los otros dos topes', () => {
    assert.equal(topeDe(tipo({ disponibles: 7, max_per_order: 4 }), { b: 100 }, null), 4);
  });

  it('nunca negativo', () => {
    assert.equal(topeDe(tipo(), { b: 99 }, 5), 0);
  });
});

describe('la cantidad ajustada', () => {
  it('recorta al tope en vez de rechazar', () => {
    // Quien pulsa «+» en el máximo no se está equivocando: no hay nada que
    // avisar, simplemente no sube.
    assert.equal(cantidadPosible(tipo({ max_per_order: 4 }), 9, {}, null), 4);
  });

  it('nunca baja de cero', () => {
    assert.equal(cantidadPosible(tipo(), -3, {}, null), 0);
  });

  it('no admite decimales', () => {
    assert.equal(cantidadPosible(tipo(), 2.9, {}, null), 2);
  });

  it('un valor que no es un número es cero', () => {
    assert.equal(cantidadPosible(tipo(), Number.NaN, {}, null), 0);
  });
});

describe('el precio «desde»', () => {
  it('es el más barato de los que quedan', () => {
    const tipos = [
      tipo({ id: 'a', price_minor: 9000 }),
      tipo({ id: 'b', price_minor: 2500 }),
    ];
    assert.equal(precioDesde(tipos), 2500);
  });

  it('no cuenta los agotados', () => {
    const tipos = [
      tipo({ id: 'a', price_minor: 9000, disponibles: 5 }),
      tipo({ id: 'b', price_minor: 1000, disponibles: 0 }),
    ];
    assert.equal(precioDesde(tipos), 9000);
  });

  it('sin existencias NO hay precio', () => {
    // «Desde» sobre una lista vacía sería un precio inventado.
    assert.equal(precioDesde([tipo({ disponibles: 0 })]), null);
    assert.equal(precioDesde([]), null);
  });
});

describe('cuándo no se puede apartar', () => {
  it('sin elegir nada', () => {
    assert.equal(motivoParaNoReservar([tipo()], {}), 'entradas.eligeAlMenosUna');
  });

  it('por debajo del mínimo del tipo', () => {
    assert.equal(
      motivoParaNoReservar([tipo({ min_per_order: 2 })], { t1: 1 }),
      'entradas.pordebajoDelMinimo',
    );
  });

  it('por encima del máximo', () => {
    assert.equal(
      motivoParaNoReservar([tipo({ max_per_order: 2 })], { t1: 3 }),
      'entradas.porEncimaDelMaximo',
    );
  });

  it('más de las que quedan', () => {
    assert.equal(
      motivoParaNoReservar([tipo({ disponibles: 1, max_per_order: 5 })], { t1: 2 }),
      'entradas.sinExistencias',
    );
  });

  it('con todo en orden, nada', () => {
    assert.equal(motivoParaNoReservar([tipo()], { t1: 2 }), null);
  });

  it('cuenta las elegidas de todos los tipos', () => {
    assert.equal(cuantasElegidas({ a: 2, b: 3 }), 5);
  });

  it('sin existencias en ninguno, no hay nada que elegir', () => {
    assert.equal(hayExistencias([tipo({ disponibles: 0 })]), false);
    assert.equal(hayExistencias([tipo({ disponibles: 1 })]), true);
  });
});

describe('la cuenta atrás', () => {
  const ahora = new Date('2026-11-20T19:00:00Z');

  it('los segundos que faltan', () => {
    assert.equal(segundosRestantes('2026-11-20T19:10:00Z', ahora), 600);
  });

  it('vencida es cero, no un número negativo', () => {
    assert.equal(segundosRestantes('2026-11-20T18:00:00Z', ahora), 0);
  });

  it('una fecha rota es cero', () => {
    assert.equal(segundosRestantes('mañana', ahora), 0);
  });

  it('se lee como un reloj', () => {
    assert.equal(comoReloj(600), '10:00');
    assert.equal(comoReloj(65), '1:05');
    assert.equal(comoReloj(9), '0:09');
    assert.equal(comoReloj(-5), '0:00');
  });

  it('una reserva en pie es ACTIVA y con tiempo', () => {
    assert.equal(sigueEnPie('ACTIVE', 30), true);
    assert.equal(sigueEnPie('ACTIVE', 0), false);
    assert.equal(sigueEnPie('RELEASED', 30), false);
    assert.equal(sigueEnPie('EXPIRED', 30), false);
  });

  it('un estado que no existe no se inventa', () => {
    assert.equal(claveDelEstadoDeReserva('CASI'), 'reserva.estado.desconocido');
  });
});

describe('los modos de acceso', () => {
  it('son los tres del contrato', () => {
    assert.deepEqual([...MODOS_DE_ACCESO], [
      'FREE_RSVP',
      'TICKETED',
      'INVITATION_ONLY',
    ]);
  });

  it('la aplicación NO ofrece «solo por invitación»', () => {
    // Está en el contrato y no tiene flujo. Un modo que la base admite y la
    // interfaz no enseña es honesto; uno que la interfaz enseña sin flujo
    // detrás, no.
    assert.ok(!MODOS_OFRECIDOS.includes('INVITATION_ONLY'));
    assert.deepEqual(MODOS_OFRECIDOS, ['FREE_RSVP', 'TICKETED']);
  });

  it('solo TICKETED vende entradas', () => {
    assert.equal(vendeEntradas('TICKETED'), true);
    assert.equal(vendeEntradas('FREE_RSVP'), false);
    assert.equal(vendeEntradas('INVITATION_ONLY'), false);
  });

  it('«no se preguntó» NO es «vende entradas»', () => {
    // `null` llega del listado, que no trae el modo. Tratarlo como TICKETED
    // ofrecería un carrito sobre un evento gratuito.
    assert.equal(vendeEntradas(null), false);
    assert.equal(vendeEntradas(undefined), false);
  });

  it('un modo inventado no se traduce como si existiera', () => {
    assert.equal(claveDelModo('GRATIS_PARA_AMIGOS'), 'modoDeAcceso.desconocido');
  });
});

describe('los números que escribe el organizador', () => {
  it('un entero normal', () => {
    assert.equal(enteroEscrito('4900'), 4900);
  });

  it('vacío NO es cero', () => {
    assert.equal(enteroEscrito(''), null);
    assert.equal(enteroEscrito('  '), null);
  });

  it('lo que no es un número no se convierte en cero', () => {
    // Devolver cero por un descuido lo convertiría en un precio.
    assert.equal(enteroEscrito('muchos'), null);
    assert.equal(enteroEscrito('49.90'), null);
    assert.equal(enteroEscrito('-5'), null);
  });

  it('cero sí es cero: una entrada de cortesía', () => {
    assert.equal(enteroEscrito('0'), 0);
  });
});

describe('cuándo no se puede guardar un tipo', () => {
  const bueno = {
    nombre: 'General',
    precio: '4900',
    cupo: '50',
    minimo: '1',
    maximo: '4',
  };

  it('con todo puesto, nada', () => {
    assert.equal(motivoParaNoGuardarTipo(bueno), null);
  });

  it('sin nombre', () => {
    assert.equal(
      motivoParaNoGuardarTipo({ ...bueno, nombre: ' ' }),
      'entradas.faltaNombre',
    );
  });

  it('con un precio que no es un entero', () => {
    assert.equal(
      motivoParaNoGuardarTipo({ ...bueno, precio: '49.90' }),
      'entradas.precioInvalido',
    );
  });

  it('con cupo cero', () => {
    // Cero no es un cupo: es un tipo que no existe. Para eso está «retirado».
    assert.equal(
      motivoParaNoGuardarTipo({ ...bueno, cupo: '0' }),
      'entradas.cupoInvalido',
    );
  });

  it('con el máximo por debajo del mínimo', () => {
    assert.equal(
      motivoParaNoGuardarTipo({ ...bueno, minimo: '4', maximo: '2' }),
      'entradas.maximoMenorQueMinimo',
    );
  });

  it('un precio de cero SÍ se puede guardar', () => {
    assert.equal(motivoParaNoGuardarTipo({ ...bueno, precio: '0' }), null);
  });
});

describe('el cliente no decide precios', () => {
  it('el repositorio manda tipo y cantidad, y nada más', () => {
    const repo = fuente('repositories/EventTicketRepository.ts');
    const apartar = repo.slice(repo.indexOf('async apartar('), repo.indexOf('async leerReserva('));
    assert.ok(apartar.includes('ticket_type_id'));
    assert.ok(apartar.includes('quantity'));
    for (const prohibido of ['price', 'currency', 'subtotal', 'total']) {
      assert.ok(!apartar.includes(prohibido), prohibido);
    }
  });

  it('y manda la clave de idempotencia', () => {
    const repo = fuente('repositories/EventTicketRepository.ts');
    assert.ok(repo.includes("'Idempotency-Key': clave"));
  });
});

describe('la pantalla no promete una compra', () => {
  const ELEGIR = codigo('screens/ElegirEntradasScreen.tsx');
  const RESERVA = codigo('screens/ReservaDeEntradasScreen.tsx');

  it('no hay ningún botón de pagar, ni siquiera apagado', () => {
    // Un botón deshabilitado sugiere que llega en un minuto, y lo que falta no
    // es un botón: son la comisión, los impuestos y el vendedor de registro.
    for (const pantalla of [ELEGIR, RESERVA]) {
      for (const prohibido of ['Pagar', 'pagar(', 'checkout', 'Stripe', 'payment']) {
        assert.ok(!pantalla.includes(prohibido), prohibido);
      }
    }
  });

  it('se dice SUBTOTAL, nunca total', () => {
    for (const pantalla of [ELEGIR, RESERVA]) {
      assert.ok(pantalla.includes("t('entradas.subtotal')"));
      assert.ok(!pantalla.includes("'entradas.total'"));
    }
  });

  it('se avisa de que los cargos finales faltan', () => {
    for (const pantalla of [ELEGIR, RESERVA]) {
      assert.ok(pantalla.includes("t('entradas.avisoDeCargos')"));
    }
  });

  it('y de que apartar no es comprar', () => {
    assert.ok(ELEGIR.includes("t('entradas.noEsUnaCompra')"));
    assert.ok(RESERVA.includes("t('reserva.noEsUnaCompra')"));
  });

  it('dos toques no mandan dos reservas', () => {
    const cuerpo = ELEGIR.slice(ELEGIR.indexOf('const apartar ='));
    assert.ok(cuerpo.includes('if (!id || apartandoRef.current) return;'));
  });

  it('la clave de idempotencia se genera una vez por pantalla', () => {
    // Una por pulsación haría que un reintento apartara otras tantas entradas.
    assert.ok(ELEGIR.includes('const claveRef = useRef('));
  });

  it('la disponibilidad se vuelve a pedir cuando el servidor dice que no', () => {
    const cuerpo = ELEGIR.slice(ELEGIR.indexOf('const apartar ='));
    assert.ok(cuerpo.includes('void cargar();'));
  });

  it('el contador parte del número del SERVIDOR', () => {
    assert.ok(RESERVA.includes('setRestantes(datos.segundos_restantes)'));
  });

  it('al llegar a cero se pregunta, no se decide', () => {
    assert.ok(RESERVA.includes('yaPreguntadoRef'));
  });
});

describe('los dos flujos no conviven en la ficha', () => {
  it('un evento con entradas ofrece elegirlas, no reservar', () => {
    const ficha = fuente('screens/EventoScreen.tsx');
    assert.ok(ficha.includes('vendeEntradas(evento.accessMode)'));
    assert.ok(ficha.includes("t('evento.elegirEntradas')"));
  });

  it('«no se preguntó» conserva el comportamiento de siempre', () => {
    const mapper = fuente('mappers/catalogMapper.ts');
    assert.ok(mapper.includes('accessMode: dto.access_mode ?? null'));
    assert.ok(!mapper.includes("access_mode ?? 'FREE_RSVP'"));
  });
});

describe('los tres idiomas dicen todo lo que las entradas preguntan', () => {
  it('ninguna clave usada aquí falta en es, en o pt', () => {
    const usadas = [
      ...new Set(
        [
          fuente('screens/ElegirEntradasScreen.tsx'),
          fuente('screens/ReservaDeEntradasScreen.tsx'),
          fuente('screens/ConfigurarEntradasScreen.tsx'),
          fuente('lib/entradasDeEvento.ts'),
        ]
          .join('\n')
          .match(new RegExp("'(entradas\\.[a-zA-Z._]+|reserva\\.[a-zA-Z._]+)'", 'g')) ?? [],
      ),
    ].map((m) => m.slice(1, -1));

    assert.ok(usadas.length > 30, `se encontraron ${usadas.length} claves`);
    for (const [nombre, diccionario] of [
      ['es', es],
      ['en', en],
      ['pt', pt],
    ] as Array<[string, Record<string, string>]>) {
      for (const clave of usadas) {
        assert.ok((diccionario[clave] ?? '').trim() !== '', `falta ${clave} en ${nombre}`);
      }
    }
  });

  it('y las construidas al vuelo también', () => {
    const construidas = [
      ...MODOS_DE_ACCESO.map((m) => `modoDeAcceso.${m}`),
      'modoDeAcceso.desconocido',
      ...['ACTIVE', 'EXPIRED', 'RELEASED', 'CONSUMED'].map(
        (e) => `reserva.estado.${e}`,
      ),
      ...['draft', 'on_sale', 'paused', 'retired'].map((e) => `entradas.estado.${e}`),
    ];
    for (const [nombre, diccionario] of [
      ['es', es],
      ['en', en],
      ['pt', pt],
    ] as Array<[string, Record<string, string>]>) {
      for (const clave of construidas) {
        assert.ok((diccionario[clave] ?? '').trim() !== '', `falta ${clave} en ${nombre}`);
      }
    }
  });
});
