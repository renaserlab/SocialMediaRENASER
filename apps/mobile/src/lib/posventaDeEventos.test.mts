/**
 * Las reglas de la posventa, ejecutadas.
 *
 * Las que más importan son tres, y las tres se pueden romper sin que se note
 * mirando la aplicación:
 *
 *  1. `null` convertido en cero. Un porcentaje ausente enseñado como «0 %» le
 *     dice a alguien que no le corresponde nada, cuando lo cierto es que nadie
 *     lo ha decidido todavía.
 *  2. «Aprobada» leída como «pagada». Son dos hechos distintos y la diferencia
 *     es dinero que está o no está en la cuenta de una persona.
 *  3. Botones inventados. Si la pantalla deduce por su cuenta qué se puede
 *     hacer, ofrecerá pasos que el servidor contesta con un 403.
 *
 * Las dos últimas se comprueban además sobre el CÓDIGO de las pantallas, porque
 * no son funciones: son lo que está escrito.
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
  ACTORES,
  DESENLACES,
  EFECTOS_DE_ENTRADA,
  ESTADOS_DE_EXPEDIENTE,
  LARGO_MAXIMO_DEL_MOTIVO,
  MOTIVOS_DE_ELEGIBILIDAD,
  TIPOS_DE_EXPEDIENTE,
  TIPOS_QUE_SE_PUEDEN_PEDIR,
  VEREDICTOS,
  claveDeErrorDePosventa,
  claveDelActor,
  claveDelDesenlace,
  claveDelEfecto,
  claveDelEstadoDeEntradaAfectada,
  claveDelEstadoDeExpediente,
  claveDelMotivo,
  claveDelTipoDeExpediente,
  claveDelVeredicto,
  elDineroYaVolvio,
  esPosventaApagada,
  expedienteCerrado,
  importeDeLaDevolucion,
  largoDelMotivo,
  motivoParaNoPedir,
  motivoUtil,
  porcentajeDePolitica,
  puedeResponder,
  puedeRetirar,
  tonoDelEstado,
} from './posventaDeEventos.ts';

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

const DICCIONARIOS: Array<[string, Record<string, string>]> = [
  ['es', es as unknown as Record<string, string>],
  ['en', en as unknown as Record<string, string>],
  ['pt', pt as unknown as Record<string, string>],
];

describe('`null` no es cero: el porcentaje que nadie ha decidido', () => {
  it('sin número no se escribe ninguna cifra', () => {
    // El fallo que esto cierra: `porcentaje_bps` nulo pintado como «0 %», que
    // se lee como una negativa que la empresa no ha dado.
    assert.equal(porcentajeDePolitica(null), null);
    assert.equal(porcentajeDePolitica(undefined), null);
  });

  it('un valor que no es un número tampoco se convierte en cero', () => {
    assert.equal(porcentajeDePolitica(Number.NaN), null);
    assert.equal(porcentajeDePolitica(Number.POSITIVE_INFINITY), null);
  });

  it('cero SÍ se escribe: es una decisión tomada, no una ausencia', () => {
    assert.equal(porcentajeDePolitica(0), '0%');
  });

  it('los puntos básicos se convierten a porcentaje, con sus decimales', () => {
    assert.equal(porcentajeDePolitica(10000), '100%');
    assert.equal(porcentajeDePolitica(5000), '50%');
    assert.equal(porcentajeDePolitica(1250), '12.5%');
    assert.equal(porcentajeDePolitica(1205), '12.05%');
  });
});

describe('el importe se escribe solo cuando hay importe Y moneda', () => {
  it('sin importe no hay cifra', () => {
    assert.equal(importeDeLaDevolucion(null, 'PEN'), null);
    assert.equal(importeDeLaDevolucion(undefined, 'PEN'), null);
  });

  it('sin moneda tampoco: «$» es dólar y peso a la vez', () => {
    assert.equal(importeDeLaDevolucion(4990, null), null);
    assert.equal(importeDeLaDevolucion(4990, '   '), null);
  });

  it('con las dos cosas sale la cifra con su código', () => {
    assert.equal(importeDeLaDevolucion(4990, 'PEN'), 'S/ 49.90 PEN');
    assert.equal(importeDeLaDevolucion(4990, 'usd'), '$ 49.90 USD');
  });

  it('una moneda sin símbolo conocido sale con su código y sin inventarse uno', () => {
    assert.equal(importeDeLaDevolucion(1000, 'EUR'), '10.00 EUR');
  });

  it('cero con moneda SÍ se escribe: es un importe decidido', () => {
    assert.equal(importeDeLaDevolucion(0, 'PEN'), 'S/ 0.00 PEN');
  });
});

describe('aprobar no es haber pagado', () => {
  it('`approved` NO dice que el dinero haya vuelto', () => {
    // El fallo que esto cierra: escribir «te devolvimos el dinero» sobre un
    // expediente que solo tiene el visto bueno de administración.
    assert.equal(elDineroYaVolvio('approved', 'full_refund'), false);
  });

  it('ni en la cola ni ejecutándose: eso tampoco es haber cobrado', () => {
    assert.equal(elDineroYaVolvio('refund_pending', 'full_refund'), false);
    assert.equal(elDineroYaVolvio('refund_processing', 'partial_refund'), false);
  });

  it('solo `resolved` con un desenlace de devolución', () => {
    assert.equal(elDineroYaVolvio('resolved', 'full_refund'), true);
    assert.equal(elDineroYaVolvio('resolved', 'partial_refund'), true);
  });

  it('`resolved` sin devolución NO es dinero de vuelta', () => {
    // Un expediente puede cerrarse manteniendo la entrada: ahí no hay
    // movimiento ninguno que anunciar.
    assert.equal(elDineroYaVolvio('resolved', 'ticket_kept'), false);
    assert.equal(elDineroYaVolvio('resolved', 'no_refund'), false);
    assert.equal(elDineroYaVolvio('resolved', null), false);
  });

  it('«aprobada» y «resuelta» no se cuentan con el mismo texto', () => {
    assert.notEqual(es['posventa.estado.approved'], es['posventa.estado.resolved']);
    assert.notEqual(en['posventa.estado.approved'], en['posventa.estado.resolved']);
    assert.notEqual(pt['posventa.estado.approved'], pt['posventa.estado.resolved']);
  });
});

describe('las acciones las dicta el servidor', () => {
  it('se retira lo que el servidor dice que se puede retirar', () => {
    assert.equal(puedeRetirar({ status: 'submitted', acciones: ['cancelled'] }), true);
  });

  it('sin esa acción no se ofrece el botón, aunque el estado lo sugiera', () => {
    // Es exactamente el caso que produce un 403: la pantalla dedujo que un
    // expediente «enviado» siempre se puede retirar.
    assert.equal(puedeRetirar({ status: 'submitted', acciones: [] }), false);
    assert.equal(puedeRetirar({ status: 'approved', acciones: ['resolved'] }), false);
  });

  it('sin lista de acciones no se inventa ninguna', () => {
    assert.equal(puedeRetirar({ status: 'submitted' }), false);
    assert.equal(puedeResponder({ status: 'awaiting_information' }), false);
  });

  it('responder exige estar esperando información Y tener el paso', () => {
    assert.equal(
      puedeResponder({
        status: 'awaiting_information',
        acciones: ['under_review', 'cancelled'],
      }),
      true,
    );
  });

  it('el mismo destino en otro estado NO abre el formulario de respuesta', () => {
    // `under_review` es el destino de varios saltos; sin comprobar el estado
    // de partida, la pantalla pediría una respuesta donde no toca.
    assert.equal(
      puedeResponder({ status: 'submitted', acciones: ['under_review'] }),
      false,
    );
  });
});

describe('un expediente cerrado se dice cerrado', () => {
  it('resuelto, rechazado y retirado ya no se mueven', () => {
    for (const estado of ['resolved', 'rejected', 'cancelled']) {
      assert.equal(expedienteCerrado(estado), true, estado);
    }
  });

  it('lo demás sigue vivo', () => {
    for (const estado of [
      'submitted',
      'under_review',
      'awaiting_information',
      'approved',
      'refund_pending',
      'refund_processing',
      'failed',
    ]) {
      assert.equal(expedienteCerrado(estado), false, estado);
    }
  });

  it('el tono separa lo bueno de lo malo y de lo que espera', () => {
    assert.equal(tonoDelEstado('resolved'), 'bueno');
    assert.equal(tonoDelEstado('rejected'), 'malo');
    assert.equal(tonoDelEstado('failed'), 'malo');
    assert.equal(tonoDelEstado('awaiting_information'), 'espera');
    assert.equal(tonoDelEstado('approved'), 'neutro');
  });
});

describe('sin condiciones publicadas no se da una negativa', () => {
  it('`policy_not_configured` tiene su propia explicación, no un «no»', () => {
    assert.equal(
      motivoParaNoPedir({
        resultado: 'policy_not_configured',
        motivos: ['policy_not_configured'],
        puede_pedir: false,
      }),
      'posventa.sinPoliticaCuerpo',
    );
  });

  it('cuando sí se puede pedir no hay impedimento que enseñar', () => {
    assert.equal(
      motivoParaNoPedir({ resultado: 'eligible', motivos: [], puede_pedir: true }),
      null,
    );
    assert.equal(
      motivoParaNoPedir({
        resultado: 'needs_review',
        motivos: ['change_unclassified'],
        puede_pedir: true,
      }),
      null,
    );
  });

  it('una negativa se explica con SU motivo, traducido', () => {
    assert.equal(
      motivoParaNoPedir({
        resultado: 'not_eligible',
        motivos: ['window_closed', 'checked_in'],
        puede_pedir: false,
      }),
      'posventa.motivo.window_closed',
    );
  });

  it('una negativa sin motivos no se queda muda', () => {
    assert.equal(
      motivoParaNoPedir({ resultado: 'not_eligible', motivos: [], puede_pedir: false }),
      'posventa.noSePuedePedir',
    );
  });
});

describe('el motivo que se manda', () => {
  it('vacío o solo espacios no es un motivo', () => {
    assert.equal(motivoUtil(''), null);
    assert.equal(motivoUtil('   \n  '), null);
    assert.equal(motivoUtil(null), null);
  });

  it('se recorta al máximo que el servidor acepta', () => {
    const largo = 'a'.repeat(LARGO_MAXIMO_DEL_MOTIVO + 50);
    assert.equal(motivoUtil(largo)?.length, LARGO_MAXIMO_DEL_MOTIVO);
  });

  it('el máximo es el del contrato del backend', () => {
    assert.equal(LARGO_MAXIMO_DEL_MOTIVO, 1000);
  });

  it('el contador cuenta lo escrito, sin recortar ni limpiar', () => {
    assert.equal(largoDelMotivo('  hola  '), 8);
    assert.equal(largoDelMotivo(null), 0);
  });
});

describe('los códigos del servidor se traducen, no se pintan crudos', () => {
  it('la posventa apagada se reconoce por su código', () => {
    assert.equal(esPosventaApagada('event_aftersale_not_available'), true);
    assert.equal(esPosventaApagada('event_case_not_found'), false);
    assert.equal(esPosventaApagada(null), false);
  });

  it('los errores conocidos tienen clave propia', () => {
    assert.equal(
      claveDeErrorDePosventa('event_case_transition_invalid'),
      'posventa.error.pasoInvalido',
    );
    assert.equal(
      claveDeErrorDePosventa('event_case_policy_not_configured'),
      'posventa.error.sinPolitica',
    );
  });

  it('un 403 y un 429 no invitan a reintentar con la frase de un fallo', () => {
    assert.equal(claveDeErrorDePosventa('forbidden'), 'posventa.error.sinPermiso');
    assert.equal(
      claveDeErrorDePosventa('rate_limited'),
      'errorDeEntradas.demasiadosIntentos',
    );
  });

  it('un código desconocido devuelve `null` para usar el texto del servidor', () => {
    assert.equal(claveDeErrorDePosventa('algo_que_nadie_ha_visto'), null);
    assert.equal(claveDeErrorDePosventa(undefined), null);
  });
});

describe('cada valor del servidor tiene su texto en los tres idiomas', () => {
  const familias: Array<[readonly string[], (v: string) => string]> = [
    [ESTADOS_DE_EXPEDIENTE, claveDelEstadoDeExpediente],
    [TIPOS_DE_EXPEDIENTE, claveDelTipoDeExpediente],
    [VEREDICTOS, claveDelVeredicto],
    [MOTIVOS_DE_ELEGIBILIDAD, claveDelMotivo],
    [DESENLACES, claveDelDesenlace],
    [EFECTOS_DE_ENTRADA, claveDelEfecto],
    [ACTORES, claveDelActor],
    [['VALID', 'USED', 'REVOKED'], claveDelEstadoDeEntradaAfectada],
  ];

  for (const [idioma, diccionario] of DICCIONARIOS) {
    it(`${idioma} traduce todos los valores y todos los «desconocido»`, () => {
      const faltan: string[] = [];
      for (const [valores, aClave] of familias) {
        for (const valor of valores) {
          const clave = aClave(valor);
          if (clave.endsWith('.desconocido')) faltan.push(`${valor} cae en desconocido`);
          if (!(clave in diccionario)) faltan.push(clave);
        }
        const respaldo = aClave('lo_que_sea_que_no_existe');
        assert.ok(respaldo.endsWith('.desconocido'), respaldo);
        if (!(respaldo in diccionario)) faltan.push(respaldo);
      }
      assert.deepEqual(faltan, [], `sin texto en ${idioma}: ${faltan.join(', ')}`);
    });
  }

  it('los tipos que se ofrecen son un subconjunto de los que la base admite', () => {
    for (const tipo of TIPOS_QUE_SE_PUEDEN_PEDIR) {
      assert.ok(
        (TIPOS_DE_EXPEDIENTE as readonly string[]).includes(tipo),
        `${tipo} no existe en el backend`,
      );
    }
  });

  it('la aplicación NO ofrece abrir lo que decide el sistema', () => {
    // `event_cancelled`, `event_rescheduled` y `dispute` salen de hechos
    // registrados, no de lo que alguien escriba en un formulario.
    for (const prohibido of ['event_cancelled', 'event_rescheduled', 'dispute']) {
      assert.ok(
        !(TIPOS_QUE_SE_PUEDEN_PEDIR as readonly string[]).includes(prohibido),
        prohibido,
      );
    }
  });
});

describe('lo que las pantallas tienen escrito', () => {
  const solicitar = fuente('SolicitarPosventaScreen.tsx');
  const expediente = fuente('ExpedienteScreen.tsx');
  const lista = fuente('MisSolicitudesScreen.tsx');
  const entrada = fuente('MiEntradaScreen.tsx');

  it('el cerrojo contra el doble toque está antes del primer `await`', () => {
    for (const [nombre, codigo] of [
      ['SolicitarPosventaScreen', solicitar],
      ['ExpedienteScreen', expediente],
    ] as const) {
      assert.ok(
        sinComentarios(codigo).includes('ocupadoRef.current'),
        `${nombre} abriría dos expedientes con dos toques rápidos`,
      );
    }
  });

  it('ninguna pantalla trae datos de ejemplo ni habla con Supabase', () => {
    for (const [nombre, codigo] of [
      ['SolicitarPosventaScreen', solicitar],
      ['ExpedienteScreen', expediente],
      ['MisSolicitudesScreen', lista],
    ] as const) {
      const limpio = sinComentarios(codigo);
      assert.ok(!/mockData|datosDeEjemplo/i.test(limpio), nombre);
      assert.ok(!/supabase/i.test(limpio), nombre);
    }
  });

  it('las tres pantallas saben quedarse sin conexión y sin servicio', () => {
    for (const [nombre, codigo] of [
      ['SolicitarPosventaScreen', solicitar],
      ['ExpedienteScreen', expediente],
      ['MisSolicitudesScreen', lista],
    ] as const) {
      const limpio = sinComentarios(codigo);
      assert.ok(limpio.includes('esFalloDeRed'), `${nombre} no distingue el sin red`);
      assert.ok(
        limpio.includes('esPosventaApagada'),
        `${nombre} no distingue el 503 de la posventa apagada`,
      );
      assert.ok(limpio.includes('onRetry'), `${nombre} no ofrece reintentar`);
    }
  });

  it('Atrás siempre tiene un respaldo a una ruta que existe', () => {
    for (const [nombre, codigo] of [
      ['SolicitarPosventaScreen', solicitar],
      ['ExpedienteScreen', expediente],
      ['MisSolicitudesScreen', lista],
    ] as const) {
      const limpio = sinComentarios(codigo);
      assert.ok(limpio.includes('router.canGoBack()'), nombre);
      assert.ok(limpio.includes('router.replace('), nombre);
    }
  });

  it('el expediente no promete dinero devuelto por estar aprobado', () => {
    const limpio = sinComentarios(expediente);
    assert.ok(
      limpio.includes('elDineroYaVolvio('),
      'el color y el texto del desenlace tienen que salir de la comprobación honesta',
    );
    assert.ok(
      limpio.includes("'posventa.aprobadaNoEsPagada'"),
      'falta el aviso de que aprobado no es cobrado',
    );
    assert.ok(
      limpio.includes("'posventa.sinPlazos'"),
      'falta el aviso de que no se prometen fechas',
    );
  });

  it('la solicitud enseña el porcentaje solo cuando el servidor lo manda', () => {
    const limpio = sinComentarios(solicitar);
    assert.ok(limpio.includes('porcentajeDePolitica('), 'falta el formateo honesto');
    assert.ok(
      limpio.includes("'posventa.porcentajeSinDefinir'"),
      'sin número hay que decir que está pendiente, no pintar un cero',
    );
  });

  it('el expediente pinta los botones que manda el servidor, no los suyos', () => {
    const limpio = sinComentarios(expediente);
    assert.ok(limpio.includes('puedeResponder('), 'falta la comprobación de acciones');
    assert.ok(limpio.includes('puedeRetirar('), 'falta la comprobación de acciones');
  });

  it('la entrada lleva la tarjeta de ayuda al pedido de esa entrada', () => {
    const limpio = sinComentarios(entrada);
    assert.ok(limpio.includes("'posventa.ayudaTitulo'"), 'falta la tarjeta de ayuda');
    assert.ok(
      limpio.includes('/posventa/nueva/${entrada.order_id}'),
      'la tarjeta tiene que llevar al pedido de ESTA entrada',
    );
  });

  it('el QR sigue intacto: la tarjeta se añadió, no reemplazó nada', () => {
    const limpio = sinComentarios(entrada);
    assert.ok(limpio.includes('<QRCode'), 'el QR es para lo que se abre esta pantalla');
    assert.ok(limpio.includes('quietZone={16}'), 'la zona tranquila del QR se ha perdido');
  });
});
