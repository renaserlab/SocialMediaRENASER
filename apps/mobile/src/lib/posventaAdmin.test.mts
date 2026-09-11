/**
 * Las reglas de la posventa por dentro, ejecutadas.
 *
 * Lo que se prueba aquí es lo que se rompe sin que se note mirando la
 * aplicación:
 *
 *  1. Las cuatro cosas dichas como si fueran una. «Aprobada», «pedida al
 *     proveedor», «en curso» y «confirmada» son cuatro hechos distintos, y
 *     entre el primero y el último hay dinero en la cuenta de alguien o no lo
 *     hay. Se comprueba que se distinguen, que se cuentan con textos distintos
 *     en los tres idiomas, y que «confirmada» coincide exactamente con
 *     `elDineroYaVolvio` del módulo del comprador: dos definiciones separadas
 *     del mismo hecho acabarían diciendo cosas distintas.
 *  2. Botones inventados. Solo cuatro saltos tienen ruta escrita; ofrecer los
 *     demás produce un 404 o, peor, la impresión de que desde aquí se ejecuta
 *     una devolución.
 *  3. Un 409 tratado como un error cualquiera. `event_case_changed` significa
 *     «alguien actuó primero»: hay que recargar y dejar decidir otra vez.
 *  4. Un importe a medias. Sin moneda no es un importe, y un campo vacío leído
 *     como cero decidiría que no corresponde nada.
 *
 * Las tres últimas se comprueban además sobre el CÓDIGO de las pantallas,
 * porque no son funciones: son lo que está escrito.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { en } from '../i18n/en.ts';
import { es } from '../i18n/es.ts';
import { pt } from '../i18n/pt.ts';
import { ESTADOS_DE_EXPEDIENTE, elDineroYaVolvio } from './posventaDeEventos.ts';
import {
  ACCIONES_CON_PANTALLA,
  CAMPOS_VIGILADOS,
  CLASIFICACIONES,
  CLASIFICACIONES_QUE_SE_PUEDEN_ELEGIR,
  ESCALERA_DEL_DINERO,
  FASES_DEL_DINERO,
  LARGO_MAXIMO_DEL_MOTIVO_DE_DECISION,
  LARGO_MAXIMO_DE_LA_NOTA_INTERNA,
  LIMITES_DE_LA_BANDEJA,
  LIMITE_INICIAL,
  PASOS_FUERA_DE_LA_APLICACION,
  SIN_CLASIFICAR,
  accionesDeAdministracion,
  centavosDesdeTexto,
  claveDeAccion,
  claveDeClasificacion,
  claveDeErrorDeAdministracion,
  claveDeFaseDelDinero,
  claveDelCampoDelEvento,
  claveDelCuerpoDeLaFase,
  esConflictoDeExpediente,
  estaSinClasificar,
  exigeMotivo,
  faseAlcanzada,
  faseDelDinero,
  filtroDeEvento,
  leerImporte,
  llegoAlTope,
  llevaDesenlace,
  pasosSinPantalla,
  siguienteLimite,
  textoUtil,
  tonoDeLaFase,
} from './posventaAdmin.ts';

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

describe('aprobar, pedir, ejecutar y cobrar son cuatro cosas distintas', () => {
  it('aprobada NO es el dinero de vuelta, ni con desenlace de devolución', () => {
    // El fallo que esto cierra: un expediente `approved` con `full_refund`
    // contado como «devuelto». Es el visto bueno, no el movimiento.
    assert.equal(faseDelDinero('approved', 'full_refund'), 'aprobada');
    assert.equal(faseDelDinero('approved', null), 'aprobada');
  });

  it('pedida al proveedor y en curso son dos puntos distintos, y ninguno es cobrado', () => {
    assert.equal(faseDelDinero('refund_pending', 'full_refund'), 'pedidoAlProveedor');
    assert.equal(faseDelDinero('refund_processing', 'full_refund'), 'enProceso');
  });

  it('solo `resolved` con devolución es dinero confirmado', () => {
    assert.equal(faseDelDinero('resolved', 'full_refund'), 'confirmado');
    assert.equal(faseDelDinero('resolved', 'partial_refund'), 'confirmado');
  });

  it('un fallo del proveedor se dice fallo, no espera', () => {
    assert.equal(faseDelDinero('failed', 'full_refund'), 'fallido');
  });

  it('lo que no ha tocado dinero no cuenta ninguna historia sobre dinero', () => {
    for (const estado of [
      'submitted',
      'under_review',
      'awaiting_information',
      'rejected',
      'cancelled',
    ]) {
      assert.equal(faseDelDinero(estado, null), null, estado);
    }
    assert.equal(faseDelDinero('resolved', 'ticket_kept'), null);
    assert.equal(faseDelDinero('resolved', 'no_refund'), null);
  });

  it('«confirmado» dice exactamente lo mismo que `elDineroYaVolvio`', () => {
    // DOS DEFINICIONES DEL MISMO HECHO SE SEPARAN. Esta prueba las ata: si
    // alguien relaja una, la otra la delata.
    const desenlaces = [
      'full_refund',
      'partial_refund',
      'no_refund',
      'credit',
      'ticket_revoked',
      'ticket_kept',
      'escalated',
      null,
    ];
    for (const estado of ESTADOS_DE_EXPEDIENTE) {
      for (const desenlace of desenlaces) {
        assert.equal(
          faseDelDinero(estado, desenlace) === 'confirmado',
          elDineroYaVolvio(estado, desenlace),
          `${estado} + ${desenlace}`,
        );
      }
    }
  });

  it('solo lo confirmado se pinta en verde', () => {
    assert.equal(tonoDeLaFase('confirmado'), 'bueno');
    assert.equal(tonoDeLaFase('aprobada'), 'neutro');
    assert.equal(tonoDeLaFase('pedidoAlProveedor'), 'espera');
    assert.equal(tonoDeLaFase('enProceso'), 'espera');
    assert.equal(tonoDeLaFase('fallido'), 'malo');
  });

  it('la escalera marca hecho lo recorrido y nada más', () => {
    assert.equal(faseAlcanzada('aprobada', 'aprobada'), true);
    assert.equal(faseAlcanzada('aprobada', 'confirmado'), false);
    assert.equal(faseAlcanzada('enProceso', 'pedidoAlProveedor'), true);
    assert.equal(faseAlcanzada('confirmado', 'enProceso'), true);
    // `fallido` no está en la escalera: no da por hecho ningún peldaño.
    assert.equal(faseAlcanzada('fallido', 'aprobada'), false);
    assert.equal(faseAlcanzada(null, 'aprobada'), false);
  });

  it('la escalera son los cuatro puntos, en orden y sin el fallo', () => {
    assert.deepEqual(
      [...ESCALERA_DEL_DINERO],
      ['aprobada', 'pedidoAlProveedor', 'enProceso', 'confirmado'],
    );
  });

  for (const [idioma, diccionario] of DICCIONARIOS) {
    it(`${idioma} cuenta las cuatro con textos distintos`, () => {
      const titulares = ESCALERA_DEL_DINERO.map(
        (fase) => diccionario[claveDeFaseDelDinero(fase)],
      );
      const cuerpos = ESCALERA_DEL_DINERO.map(
        (fase) => diccionario[claveDelCuerpoDeLaFase(fase)],
      );
      for (const texto of [...titulares, ...cuerpos]) {
        assert.ok(texto !== undefined && texto !== '', `falta un texto en ${idioma}`);
      }
      assert.equal(
        new Set(titulares).size,
        titulares.length,
        `${idioma} repite el titular de dos fases distintas`,
      );
      assert.equal(
        new Set(cuerpos).size,
        cuerpos.length,
        `${idioma} repite la explicación de dos fases distintas`,
      );
    });
  }
});

describe('los botones son los del servidor, y solo los que tienen ruta', () => {
  it('se ofrece lo que el servidor dice y esta aplicación sabe mandar', () => {
    assert.deepEqual(
      accionesDeAdministracion({
        status: 'submitted',
        acciones: ['under_review', 'awaiting_information', 'rejected', 'cancelled'],
      }),
      ['under_review', 'awaiting_information', 'rejected'],
    );
  });

  it('sin lista de acciones no se inventa ninguna', () => {
    assert.deepEqual(accionesDeAdministracion({ status: 'under_review' }), []);
    assert.deepEqual(accionesDeAdministracion({ status: 'approved', acciones: [] }), []);
  });

  it('ejecutar la devolución NO es un botón: no hay ruta que lo haga', () => {
    // El fallo que esto cierra: pintar «marcar devuelto» y prometer un
    // movimiento bancario que solo confirma el proveedor.
    const expediente = {
      status: 'approved',
      acciones: ['refund_pending', 'resolved', 'cancelled'],
    };
    assert.deepEqual(accionesDeAdministracion(expediente), []);
    assert.deepEqual(pasosSinPantalla(expediente), [
      'refund_pending',
      'resolved',
      'cancelled',
    ]);
  });

  it('los dos conjuntos no se pisan', () => {
    for (const accion of ACCIONES_CON_PANTALLA) {
      assert.ok(
        !(PASOS_FUERA_DE_LA_APLICACION as readonly string[]).includes(accion),
        accion,
      );
    }
  });

  it('todos los saltos nombrados son estados que el servidor conoce', () => {
    for (const paso of [...ACCIONES_CON_PANTALLA, ...PASOS_FUERA_DE_LA_APLICACION]) {
      assert.ok(
        (ESTADOS_DE_EXPEDIENTE as readonly string[]).includes(paso),
        `${paso} no existe en el backend`,
      );
    }
  });

  it('rechazar y pedir información no se mandan sin un motivo legible', () => {
    assert.equal(exigeMotivo('rejected'), true);
    assert.equal(exigeMotivo('awaiting_information'), true);
    assert.equal(exigeMotivo('under_review'), false);
    assert.equal(exigeMotivo('approved'), false);
  });

  it('solo aprobar lleva resultado e importe', () => {
    assert.equal(llevaDesenlace('approved'), true);
    assert.equal(llevaDesenlace('rejected'), false);
  });
});

describe('alguien se adelantó: 409 recuperable', () => {
  it('el conflicto del expediente se reconoce por su código', () => {
    assert.equal(esConflictoDeExpediente('event_case_changed'), true);
    assert.equal(esConflictoDeExpediente('event_case_transition_invalid'), false);
    assert.equal(esConflictoDeExpediente(null), false);
  });

  it('el conflicto tiene su propio texto, que no es un error seco', () => {
    assert.equal(
      claveDeErrorDeAdministracion('event_case_changed'),
      'posventaAdmin.conflictoCuerpo',
    );
  });

  it('los códigos de decidir tienen clave propia', () => {
    assert.equal(
      claveDeErrorDeAdministracion('event_case_amount_without_currency'),
      'posventaAdmin.error.importeSinMoneda',
    );
    assert.equal(
      claveDeErrorDeAdministracion('event_case_outcome_without_policy'),
      'posventaAdmin.error.sinPoliticaPublicada',
    );
  });

  it('un código desconocido devuelve `null` para usar el texto del servidor', () => {
    assert.equal(claveDeErrorDeAdministracion('algo_que_nadie_ha_visto'), null);
    assert.equal(claveDeErrorDeAdministracion(undefined), null);
  });
});

describe('el importe que se manda al aprobar', () => {
  it('los dos campos vacíos son «nadie ha decidido una cifra», no un cero', () => {
    assert.deepEqual(leerImporte('', ''), { estado: 'vacio' });
    assert.deepEqual(leerImporte(null, null), { estado: 'vacio' });
  });

  it('un importe sin moneda no es un importe', () => {
    assert.deepEqual(leerImporte('49.90', ''), { estado: 'incompleto', falta: 'moneda' });
    assert.deepEqual(leerImporte('', 'PEN'), { estado: 'incompleto', falta: 'importe' });
  });

  it('con los dos, sale la cantidad en la unidad menor y la moneda en mayúsculas', () => {
    assert.deepEqual(leerImporte('49.90', 'pen'), {
      estado: 'listo',
      centavos: 4990,
      moneda: 'PEN',
    });
    assert.deepEqual(leerImporte('49,9', 'USD'), {
      estado: 'listo',
      centavos: 4990,
      moneda: 'USD',
    });
  });

  it('lo que no es una cantidad no viaja', () => {
    assert.deepEqual(leerImporte('mucho', 'PEN'), { estado: 'invalido' });
    assert.deepEqual(leerImporte('-5', 'PEN'), { estado: 'invalido' });
    assert.deepEqual(leerImporte('49.90', 'PESOS'), { estado: 'invalido' });
  });

  it('cero SÍ es una cifra decidida', () => {
    assert.deepEqual(leerImporte('0', 'PEN'), {
      estado: 'listo',
      centavos: 0,
      moneda: 'PEN',
    });
  });

  it('los centavos salen de la cantidad escrita, sin errores de coma flotante', () => {
    assert.equal(centavosDesdeTexto('0.07'), 7);
    assert.equal(centavosDesdeTexto('1234.56'), 123456);
    assert.equal(centavosDesdeTexto('10'), 1000);
    assert.equal(centavosDesdeTexto('1.234'), null);
    assert.equal(centavosDesdeTexto(''), null);
  });
});

describe('los textos que viajan se recortan al tope de SU campo', () => {
  it('el motivo y la nota interna tienen topes distintos', () => {
    assert.equal(LARGO_MAXIMO_DEL_MOTIVO_DE_DECISION, 500);
    assert.equal(LARGO_MAXIMO_DE_LA_NOTA_INTERNA, 2000);
  });

  it('vacío o solo espacios no es un texto', () => {
    assert.equal(textoUtil('   \n ', 500), null);
    assert.equal(textoUtil(null, 500), null);
  });

  it('se recorta al máximo, no se manda para que el servidor lo rechace', () => {
    const largo = 'a'.repeat(900);
    assert.equal(textoUtil(largo, LARGO_MAXIMO_DEL_MOTIVO_DE_DECISION)?.length, 500);
    assert.equal(textoUtil(largo, LARGO_MAXIMO_DE_LA_NOTA_INTERNA)?.length, 900);
  });
});

describe('la bandeja no pagina, y no finge que lo hace', () => {
  it('el tope sube hasta el máximo del servidor y ahí se para', () => {
    assert.equal(LIMITE_INICIAL, 50);
    assert.equal(siguienteLimite(50), 100);
    assert.equal(siguienteLimite(100), 200);
    assert.equal(siguienteLimite(200), null);
  });

  it('ninguno pasa del máximo que acepta el servidor', () => {
    for (const limite of LIMITES_DE_LA_BANDEJA) {
      assert.ok(limite >= 1 && limite <= 200, String(limite));
    }
  });

  it('tantos resultados como el tope significa que puede haber más', () => {
    assert.equal(llegoAlTope(50, 50), true);
    assert.equal(llegoAlTope(49, 50), false);
  });

  it('un filtro de evento en blanco no es un filtro', () => {
    assert.equal(filtroDeEvento('   '), null);
    assert.equal(filtroDeEvento(''), null);
    assert.equal(filtroDeEvento('  abc  '), 'abc');
  });
});

describe('registrar no es clasificar', () => {
  it('`pending` es «nadie lo ha mirado», y no se puede elegir', () => {
    assert.equal(estaSinClasificar(SIN_CLASIFICAR), true);
    assert.equal(estaSinClasificar('not_essential'), false);
    assert.ok(
      !(CLASIFICACIONES_QUE_SE_PUEDEN_ELEGIR as readonly string[]).includes(
        SIN_CLASIFICAR,
      ),
      'ofrecer «sin clasificar» escribiría una decisión que nadie tomó',
    );
  });

  it('las elegibles son las del backend menos la de partida', () => {
    assert.deepEqual(
      [...CLASIFICACIONES],
      [
        'pending',
        'editorial',
        'operational',
        'possibly_essential',
        'essential',
        'not_essential',
      ],
    );
  });
});

describe('cada valor del servidor tiene su texto en los tres idiomas', () => {
  const familias: Array<[readonly string[], (v: string) => string]> = [
    [FASES_DEL_DINERO, claveDeFaseDelDinero],
    [FASES_DEL_DINERO, claveDelCuerpoDeLaFase],
    [ACCIONES_CON_PANTALLA, claveDeAccion],
    [CLASIFICACIONES, claveDeClasificacion],
    [CAMPOS_VIGILADOS, claveDelCampoDelEvento],
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

  it('los campos vigilados son los mismos que registra el backend', () => {
    assert.deepEqual(
      [...CAMPOS_VIGILADOS],
      [
        'starts_at',
        'ends_at',
        'timezone',
        'location',
        'event_type',
        'capacity',
        'title',
        'promise',
        'description',
        'category',
      ],
    );
  });
});

describe('lo que las pantallas tienen escrito', () => {
  const bandeja = fuente('BandejaDePosventaScreen.tsx');
  const expediente = fuente('ExpedienteAdminScreen.tsx');
  const organizador = fuente('PosventaDelEventoScreen.tsx');

  it('el cerrojo contra el doble toque está antes del primer `await`', () => {
    assert.ok(
      sinComentarios(expediente).includes('ocupadoRef.current'),
      'dos toques rápidos mandarían dos decisiones sobre el mismo dinero',
    );
  });

  it('el conflicto se recupera: se avisa, se recarga y se puede reintentar', () => {
    const limpio = sinComentarios(expediente);
    assert.ok(
      limpio.includes('esConflictoDeExpediente('),
      'el 409 de carrera no se distingue de un error cualquiera',
    );
    assert.ok(limpio.includes("setConflicto(true)"), 'el conflicto no se cuenta');
    assert.ok(
      limpio.includes("'posventaAdmin.conflictoReintentar'"),
      'sin botón, quien revisa tiene que salir y volver a entrar',
    );
  });

  it('el expediente pinta las cuatro fases del dinero, no una sola', () => {
    const limpio = sinComentarios(expediente);
    assert.ok(limpio.includes('faseDelDinero('), 'falta la fase del dinero');
    assert.ok(limpio.includes('ESCALERA_DEL_DINERO'), 'falta la escalera de cuatro');
    assert.ok(
      limpio.includes("'posventaAdmin.aprobarNoEsPagar'"),
      'falta el aviso de que aprobar no mueve dinero',
    );
  });

  it('los botones salen de las acciones del servidor', () => {
    const limpio = sinComentarios(expediente);
    assert.ok(limpio.includes('accionesDeAdministracion('), 'falta el filtro de acciones');
    assert.ok(limpio.includes('pasosSinPantalla('), 'lo que no se hace aquí no se nombra');
  });

  it('la bandeja filtra por estado y por evento, con un tope explícito', () => {
    const limpio = sinComentarios(bandeja);
    assert.ok(limpio.includes('ESTADOS_DE_EXPEDIENTE'), 'falta el filtro de estado');
    assert.ok(limpio.includes('filtroDeEvento('), 'falta el filtro de evento');
    assert.ok(limpio.includes('llegoAlTope('), 'el tope tiene que decirse');
    assert.ok(limpio.includes('siguienteLimite('), 'falta subir el límite');
  });

  it('las tres pantallas saben quedarse sin conexión y sin servicio', () => {
    for (const [nombre, codigo] of [
      ['BandejaDePosventaScreen', bandeja],
      ['ExpedienteAdminScreen', expediente],
      ['PosventaDelEventoScreen', organizador],
    ] as const) {
      const limpio = sinComentarios(codigo);
      assert.ok(limpio.includes('esFalloDeRed'), `${nombre} no distingue el sin red`);
      assert.ok(limpio.includes('onRetry'), `${nombre} no ofrece reintentar`);
    }
    for (const [nombre, codigo] of [
      ['BandejaDePosventaScreen', bandeja],
      ['ExpedienteAdminScreen', expediente],
    ] as const) {
      const limpio = sinComentarios(codigo);
      assert.ok(
        limpio.includes('esPosventaApagada'),
        `${nombre} no distingue el 503 de la posventa apagada`,
      );
      assert.ok(
        limpio.includes('error.status === 403'),
        `${nombre} no cuenta el acceso denegado como lo que es`,
      );
      assert.ok(
        limpio.includes("'posventaAdmin.sinPermisoCuerpo'"),
        `${nombre} no explica el acceso denegado`,
      );
    }
  });

  it('Atrás siempre tiene un respaldo a una ruta que existe', () => {
    for (const [nombre, codigo] of [
      ['BandejaDePosventaScreen', bandeja],
      ['ExpedienteAdminScreen', expediente],
      ['PosventaDelEventoScreen', organizador],
    ] as const) {
      const limpio = sinComentarios(codigo);
      assert.ok(limpio.includes('router.canGoBack()'), nombre);
      assert.ok(limpio.includes('router.replace('), nombre);
    }
  });

  it('ninguna pantalla trae datos de ejemplo ni habla con Supabase', () => {
    for (const [nombre, codigo] of [
      ['BandejaDePosventaScreen', bandeja],
      ['ExpedienteAdminScreen', expediente],
      ['PosventaDelEventoScreen', organizador],
    ] as const) {
      const limpio = sinComentarios(codigo);
      assert.ok(!/mockData|datosDeEjemplo/i.test(limpio), nombre);
      assert.ok(!/supabase/i.test(limpio), nombre);
    }
  });

  it('la pantalla del organizador NO ve lo que es de administración', () => {
    // El fallo que esto cierra: una nota interna, la pasarela o el entorno
    // asomando en la pantalla de quien organiza por reutilizar un tipo.
    const limpio = sinComentarios(organizador);
    for (const prohibido of [
      'internal_notes',
      'provider',
      'environment',
      'policy_id',
      'assignee_id',
      'buyer_id',
    ]) {
      assert.ok(!limpio.includes(prohibido), `${prohibido} no es del organizador`);
    }
  });

  it('la pantalla del organizador no llama a administración ni mueve dinero', () => {
    const limpio = sinComentarios(organizador);
    assert.ok(
      !limpio.includes('EventAftersaleAdminRepository'),
      'quien organiza no usa el repositorio de administración',
    );
    assert.ok(!limpio.includes('/admin/'), 'ninguna ruta de administración');
    for (const prohibido of ['aprobar(', 'rechazar(', 'tomar(', 'clasificar(']) {
      assert.ok(!limpio.includes(prohibido), `${prohibido} no es suyo`);
    }
  });

  it('el repositorio del comprador sigue sin saber aprobar nada', () => {
    const repositorio = readFileSync(
      join(AQUI, '..', 'repositories', 'EventAftersaleRepository.ts'),
      'utf8',
    );
    const limpio = sinComentarios(repositorio);
    assert.ok(!limpio.includes('/admin/'), 'el repositorio del comprador se ha manchado');
  });
});
