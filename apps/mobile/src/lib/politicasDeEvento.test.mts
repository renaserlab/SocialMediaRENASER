/**
 * Las condiciones que escribe quien organiza, ejecutadas.
 *
 * Lo que se prueba aquí es lo que se rompe sin que se note mirando la
 * aplicación, y lo que cuesta dinero de otra persona cuando se rompe:
 *
 *  1. UN BOTÓN DE EDITAR SOBRE ALGO PUBLICADO. El disparador de la 0069 no
 *     admite ningún `UPDATE` sobre una fila publicada que no sea marcarla
 *     superada, así que ese botón acaba siempre en 409; pero antes de eso ya ha
 *     hecho creer que lo que aceptaron unas compras se puede reescribir. Se
 *     comprueba estado por estado.
 *  2. UN CAMPO CON VALOR DE PARTIDA. `refund_bps: 0` precargado es «no se
 *     devuelve nada», decidido por la aplicación y firmado por quien organiza
 *     sin enterarse. Se comprueba que el formulario nace vacío, que un sí/no
 *     sin contestar NO viaja, y que lo que nadie escribió no aparece en
 *     `params`.
 *  3. UN VALIDADOR QUE NO COINCIDE CON EL SERVIDOR. Si aquí se acepta lo que
 *     allí se rechaza, la persona escribe un formulario entero para que se lo
 *     tiren; si aquí se rechaza lo que allí se acepta, nos hemos inventado una
 *     regla de negocio. La tabla está transcrita de
 *     `_exigir_parametros_sensatos` y `_validar_contradicciones`.
 *  4. «SIN CONFIGURAR» CONTADO COMO «NO SE DEVUELVE». Es la decisión que más
 *     perjudica a quien compró, tomada por nadie.
 *  5. UNA CANCELACIÓN QUE PROMETE UN ABONO. `cancelacion.py` no devuelve nada:
 *     retiene y abre expediente. Ninguna fila del resultado puede decir otra
 *     cosa.
 *
 * Las tres últimas se comprueban además sobre el CÓDIGO de la pantalla, porque
 * no son funciones: son lo que está escrito.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ACCIONES_DE_POLITICA,
  CLAVES_CON_SENTIDO,
  CLAVES_DEL_ORGANIZADOR,
  CLAVES_MAXIMAS,
  COTAS,
  ESTADOS_DE_POLITICA,
  LARGO_DEL_TEXTO,
  LARGO_MAXIMO_DEL_MOTIVO,
  LARGO_MAXIMO_DE_LA_VERSION,
  REGLAS_DE_CANCELACION,
  TIPOS_DEL_ORGANIZADOR,
  accionesDePolitica,
  borradorDelTipo,
  borradorDesdeLaVigente,
  claveDeAccion,
  claveDeAyudaDelParametro,
  claveDeErrorDePolitica,
  claveDeErrorPorEstado,
  claveDeFallo,
  claveDeRegla,
  claveDelCuerpoDeLaRegla,
  claveDelCuerpoDelResumen,
  claveDelEstado,
  claveDelParametro,
  claveDelResumen,
  claveDelTipo,
  cotaDe,
  detectarContradicciones,
  esClaveBooleana,
  esClaveNumerica,
  esPoliticasApagadas,
  esTipoDelOrganizador,
  estadoDeConfiguracion,
  etiquetaDeVersion,
  fechaLegible,
  filasDelResultado,
  formularioDesde,
  formularioVacio,
  hayCondiciones,
  hayQueRecargar,
  historialDelTipo,
  momentoLegible,
  motivoDeCancelacionUtil,
  paramsDesdeFormulario,
  paresDeParametros,
  sePuedeEditar,
  sePuedePublicar,
  textoUtil,
  tiposOfrecidos,
  tiposSinVigente,
  validarBorrador,
  validarParametros,
  validarPublicacion,
  valorLiteral,
  versionUtil,
  vigenciaLegible,
  vigenteDelTipo,
  type EstadoDeLasPoliticas,
  type Fallo,
  type Politica,
} from './politicasDeEvento.ts';

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

const ELEGIBILIDAD = 'aftersale_eligibility';
const EFECTO = 'ticket_effect';

function politica(campos: Partial<Politica> & { policy_type: string; status: string }): Politica {
  return {
    id: `${campos.policy_type}-${campos.status}`,
    event_id: 'evento-1',
    version: 'primera',
    params: {},
    body: null,
    params_sha256: 'huella',
    published_at: null,
    published_by: null,
    created_by: null,
    effective_from: null,
    effective_to: null,
    created_at: '2026-01-01T00:00:00Z',
    ...campos,
  };
}

function estadoCon(parcial: Partial<EstadoDeLasPoliticas>): EstadoDeLasPoliticas {
  return {
    event_id: 'evento-1',
    tipos: [...TIPOS_DEL_ORGANIZADOR],
    configurada: false,
    vigentes: [],
    borradores: [],
    historial: [],
    ...parcial,
  };
}

const codigosDe = (fallos: Fallo[]) => fallos.map((x) => x.codigo).sort();

/* ========================================================================== */
describe('lo publicado no se edita', () => {
  it('una publicada NUNCA ofrece «editar»', () => {
    // Si esto cae, hay un botón que acaba en 409 `event_policy_not_editable` y
    // que antes ya ha prometido reescribir lo que unas compras aceptaron.
    assert.ok(!accionesDePolitica('published').includes('editar'));
    assert.equal(sePuedeEditar('published'), false);
  });

  it('una superada tampoco: el historial SE LEE', () => {
    assert.deepEqual(accionesDePolitica('superseded'), []);
    assert.equal(sePuedeEditar('superseded'), false);
  });

  it('solo el borrador se edita, se publica y se descarta', () => {
    assert.deepEqual(accionesDePolitica('draft'), ['editar', 'publicar', 'descartar']);
    assert.equal(sePuedeEditar('draft'), true);
  });

  it('lo que la publicada ofrece es sacar otra VERSIÓN, no tocar esta', () => {
    assert.deepEqual(accionesDePolitica('published'), ['nuevaVersion']);
  });

  it('un estado que no conocemos no ofrece nada', () => {
    for (const raro of ['', 'PUBLISHED', 'archivada', 'pending']) {
      assert.deepEqual(accionesDePolitica(raro), [], raro);
      assert.equal(sePuedeEditar(raro), false, raro);
    }
  });

  it('ningún estado salvo `draft` deja escribir sobre la política', () => {
    const escriben = ['editar', 'publicar', 'descartar'];
    for (const estado of ESTADOS_DE_POLITICA) {
      if (estado === 'draft') continue;
      for (const accion of accionesDePolitica(estado)) {
        assert.ok(!escriben.includes(accion), `${estado} ofrece ${accion}`);
      }
    }
  });

  it('cada acción ofrecida existe en la lista de acciones', () => {
    for (const estado of ESTADOS_DE_POLITICA) {
      for (const accion of accionesDePolitica(estado)) {
        assert.ok((ACCIONES_DE_POLITICA as readonly string[]).includes(accion));
      }
    }
  });

  it('cada acción tiene su propio texto, y lo desconocido cae aparte', () => {
    const claves = ACCIONES_DE_POLITICA.map(claveDeAccion);
    assert.equal(new Set(claves).size, claves.length);
    assert.equal(claveDeAccion('borrarTodo'), 'politicasEvento.accion.desconocido');
  });
});

/* ========================================================================== */
describe('la versión nueva nace de la vigente', () => {
  const vigente = politica({
    policy_type: ELEGIBILIDAD,
    status: 'published',
    version: 'condiciones-2026',
    params: { refund_bps: 5000, allow_exchange: true, days_after_event: 7 },
    body: 'Se puede pedir el cambio hasta una semana después.',
  });

  it('copia los parámetros de la vigente', () => {
    const nuevo = borradorDesdeLaVigente(vigente);
    assert.equal(nuevo.numeros.refund_bps, '5000');
    assert.equal(nuevo.numeros.days_after_event, '7');
    assert.equal(nuevo.booleanos.allow_exchange, 'si');
  });

  it('copia el texto tal cual', () => {
    assert.equal(borradorDesdeLaVigente(vigente).texto, vigente.body);
  });

  it('DEJA LA VERSIÓN EN BLANCO: el nombre lo pone quien organiza', () => {
    // Inventar «v2» le pone a su documento un nombre que no eligió, y repetir
    // el de la vigente devuelve `event_policy_version_taken`.
    assert.equal(borradorDesdeLaVigente(vigente).version, '');
  });

  it('la copia no comparte objeto con la vigente', () => {
    const nuevo = borradorDesdeLaVigente(vigente);
    nuevo.numeros.refund_bps = '10000';
    assert.equal(vigente.params.refund_bps, 5000);
  });

  it('una vigente sin texto produce un texto vacío, no un «null» escrito', () => {
    const sinTexto = politica({ policy_type: EFECTO, status: 'published', body: null });
    assert.equal(borradorDesdeLaVigente(sinTexto).texto, '');
  });

  it('publicar con la versión de la vigente se rechaza aquí, no en el servidor', () => {
    const formulario = formularioDesde(ELEGIBILIDAD, {
      version: 'condiciones-2026',
      params: { refund_bps: 5000 },
      body: 'algo',
    });
    const fallos = validarPublicacion(
      ELEGIBILIDAD,
      formulario,
      { refund_bps: 5000 },
      vigente,
    );
    assert.ok(fallos.some((x) => x.codigo === 'event_policy_version_taken'));
  });

  it('con OTRA versión, la misma publicación pasa', () => {
    const formulario = formularioDesde(ELEGIBILIDAD, {
      version: 'condiciones-2027',
      params: { refund_bps: 5000 },
      body: 'algo',
    });
    assert.equal(
      sePuedePublicar(ELEGIBILIDAD, formulario, { refund_bps: 5000 }, vigente),
      true,
    );
  });
});

/* ========================================================================== */
describe('ningún campo tiene valor por defecto', () => {
  it('los números nacen vacíos, no en cero', () => {
    const vacio = formularioVacio(ELEGIBILIDAD);
    for (const clave of Object.keys(vacio.numeros)) {
      assert.equal(vacio.numeros[clave], '', clave);
    }
    assert.ok(Object.keys(vacio.numeros).length > 0);
  });

  it('los sí/no nacen SIN DECIDIR, que no es «no»', () => {
    for (const tipo of TIPOS_DEL_ORGANIZADOR) {
      const vacio = formularioVacio(tipo);
      for (const clave of Object.keys(vacio.booleanos)) {
        assert.equal(vacio.booleanos[clave], 'sinDecidir', `${tipo}.${clave}`);
      }
    }
  });

  it('ni la versión ni el texto traen nada escrito', () => {
    for (const tipo of TIPOS_DEL_ORGANIZADOR) {
      assert.equal(formularioVacio(tipo).version, '');
      assert.equal(formularioVacio(tipo).texto, '');
    }
  });

  it('un formulario en blanco NO manda ni un cero ni un `false`', () => {
    for (const tipo of TIPOS_DEL_ORGANIZADOR) {
      const { params, fallos } = paramsDesdeFormulario(tipo, formularioVacio(tipo));
      assert.deepEqual(params, {}, tipo);
      assert.deepEqual(fallos, [], tipo);
    }
  });

  it('lo que sigue «sin decidir» no viaja, aunque lo demás sí', () => {
    const formulario = formularioVacio(EFECTO);
    formulario.booleanos.revoke_on_refund = 'si';
    const { params } = paramsDesdeFormulario(EFECTO, formulario);
    assert.deepEqual(params, { revoke_on_refund: true });
    assert.ok(!('hold_on_dispute' in params));
  });

  it('un «no» SÍ viaja: es una respuesta escrita', () => {
    const formulario = formularioVacio(EFECTO);
    formulario.booleanos.hold_on_dispute = 'no';
    const { params } = paramsDesdeFormulario(EFECTO, formulario);
    assert.deepEqual(params, { hold_on_dispute: false });
  });

  it('cargar una política no rellena lo que esa política no trae', () => {
    const formulario = formularioDesde(ELEGIBILIDAD, {
      version: 'uno',
      params: { refund_bps: 2500 },
      body: null,
    });
    assert.equal(formulario.numeros.refund_bps, '2500');
    assert.equal(formulario.numeros.days_after_event, '');
    assert.equal(formulario.booleanos.allow_buyer_cancellation, 'sinDecidir');
    assert.equal(formulario.texto, '');
  });

  it('un valor del servidor que no es número ni booleano no decide nada', () => {
    const formulario = formularioDesde(ELEGIBILIDAD, {
      version: 'uno',
      params: { refund_bps: 'la mitad', allow_exchange: 'quizá' },
      body: null,
    });
    assert.equal(formulario.numeros.refund_bps, '');
    assert.equal(formulario.booleanos.allow_exchange, 'sinDecidir');
  });

  it('ida y vuelta: lo cargado es exactamente lo que se vuelve a mandar', () => {
    const originales = { refund_bps: 5000, allow_buyer_cancellation: true, days_after_event: 3 };
    const formulario = formularioDesde(ELEGIBILIDAD, {
      version: 'uno',
      params: originales,
      body: null,
    });
    assert.deepEqual(paramsDesdeFormulario(ELEGIBILIDAD, formulario).params, originales);
  });
});

/* ========================================================================== */
describe('el validador local dice lo mismo que el servidor', () => {
  // Transcrito de `politicas.COTAS` y `_exigir_parametros_sensatos`.
  const TABLA: Array<[string, Record<string, unknown>, string[]]> = [
    ['vacío no tiene cotas que romper', {}, []],
    ['el mínimo es válido', { refund_bps: 0 }, []],
    ['el máximo es válido', { refund_bps: 10000 }, []],
    ['por debajo', { refund_bps: -1 }, ['event_policy_param_out_of_range']],
    ['por encima', { refund_bps: 10001 }, ['event_policy_param_out_of_range']],
    ['texto', { refund_bps: '5000' }, ['event_policy_param_not_a_number']],
    ['booleano', { refund_bps: true }, ['event_policy_param_not_a_number']],
    ['nulo', { refund_bps: null }, ['event_policy_param_not_a_number']],
    ['horas al máximo', { window_hours_before_event: 24 * 365 }, []],
    [
      'horas pasadas',
      { window_hours_before_event: 24 * 365 + 1 },
      ['event_policy_param_out_of_range'],
    ],
    ['días al máximo', { days_after_event: 365 }, []],
    ['días pasados', { days_after_event: 366 }, ['event_policy_param_out_of_range']],
    ['cancelado al máximo', { cancelled_event_bps: 10000 }, []],
    [
      'dos claves rotas, dos fallos',
      { refund_bps: 99999, days_after_event: -5 },
      ['event_policy_param_out_of_range', 'event_policy_param_out_of_range'],
    ],
    [
      'una rota de cada clase',
      { refund_bps: 'mitad', days_after_event: 900 },
      ['event_policy_param_not_a_number', 'event_policy_param_out_of_range'],
    ],
    ['una clave sin cota no se juzga', { allow_exchange: true }, []],
  ];

  for (const [nombre, params, esperado] of TABLA) {
    it(`cotas · ${nombre}`, () => {
      assert.deepEqual(codigosDe(validarParametros(params)), esperado.slice().sort());
    });
  }

  it('la cota se mira sobre el entero truncado, como hace `int()`', () => {
    assert.deepEqual(validarParametros({ refund_bps: 10000.9 }), []);
    assert.deepEqual(codigosDe(validarParametros({ refund_bps: -0.5 })), []);
    assert.deepEqual(codigosDe(validarParametros({ refund_bps: 10001.2 })), [
      'event_policy_param_out_of_range',
    ]);
  });

  it('un booleano NO es un número, y se comprueba antes que la cota', () => {
    // `isinstance(valor, bool)` va primero en el servidor: `True` valdría 1 y
    // pasaría la cota sin quejarse.
    const fallos = validarParametros({ refund_bps: true });
    assert.equal(fallos[0]?.codigo, 'event_policy_param_not_a_number');
  });

  it('las cotas son EXACTAMENTE las del servidor', () => {
    assert.deepEqual(COTAS.refund_bps, [0, 10_000]);
    assert.deepEqual(COTAS.cancelled_event_bps, [0, 10_000]);
    assert.deepEqual(COTAS.window_hours_before_event, [0, 8_760]);
    assert.deepEqual(COTAS.days_after_event, [0, 365]);
  });

  it('más claves de las que caben se rechaza con su propio código', () => {
    const muchas: Record<string, unknown> = {};
    for (let i = 0; i <= CLAVES_MAXIMAS; i += 1) muchas[`clave_${i}`] = 1;
    assert.ok(
      validarParametros(muchas).some((x) => x.codigo === 'event_policy_params_too_many'),
    );
  });

  it('el fallo de rango dice cuál era el rango', () => {
    const fallo = validarParametros({ days_after_event: 900 })[0];
    assert.equal(fallo?.min, 0);
    assert.equal(fallo?.max, 365);
  });
});

/* ========================================================================== */
describe('las contradicciones se ven antes de llamar al servidor', () => {
  it('revocar en la parcial sin revocar en la total', () => {
    const fallos = detectarContradicciones(EFECTO, { revoke_on_partial_refund: true });
    assert.ok(fallos.some((x) => x.codigo === 'event_policy_contradictory'));
    assert.deepEqual(fallos[0]?.claves, [
      'revoke_on_partial_refund',
      'revoke_on_refund',
    ]);
  });

  it('revocar en las dos es perfectamente coherente', () => {
    assert.deepEqual(
      detectarContradicciones(EFECTO, {
        revoke_on_partial_refund: true,
        revoke_on_refund: true,
      }),
      [],
    );
  });

  it('revocar en la total y no en la parcial también lo es', () => {
    assert.deepEqual(
      detectarContradicciones(EFECTO, {
        revoke_on_refund: true,
        revoke_on_partial_refund: false,
      }),
      [],
    );
  });

  it('permitir cancelar sin decir hasta cuándo', () => {
    const fallos = detectarContradicciones(ELEGIBILIDAD, {
      allow_buyer_cancellation: true,
    });
    assert.ok(fallos.some((x) => x.codigo === 'event_policy_contradictory'));
    assert.deepEqual(fallos[0]?.claves, [
      'window_hours_before_event',
      'days_after_event',
    ]);
  });

  it('con ventana basta', () => {
    assert.deepEqual(
      detectarContradicciones(ELEGIBILIDAD, {
        allow_buyer_cancellation: true,
        window_hours_before_event: 48,
      }),
      [],
    );
  });

  it('con plazo después del evento también basta', () => {
    assert.deepEqual(
      detectarContradicciones(ELEGIBILIDAD, {
        allow_buyer_cancellation: true,
        days_after_event: 14,
      }),
      [],
    );
  });

  it('un `null` explícito cuenta como no decir nada, igual que en el servidor', () => {
    const fallos = detectarContradicciones(ELEGIBILIDAD, {
      allow_buyer_cancellation: true,
      window_hours_before_event: null,
      days_after_event: null,
    });
    assert.ok(fallos.some((x) => x.codigo === 'event_policy_contradictory'));
  });

  it('no permitir cancelar no exige ninguna ventana', () => {
    assert.deepEqual(
      detectarContradicciones(ELEGIBILIDAD, { allow_buyer_cancellation: false }),
      [],
    );
  });

  it('una política que no decide nada de su tipo es una política vacía', () => {
    const fallos = detectarContradicciones(ELEGIBILIDAD, { reserve_bps: 100 });
    assert.ok(fallos.some((x) => x.codigo === 'event_policy_empty'));
  });

  it('la vacía dice cuáles serían las claves con sentido', () => {
    const fallo = detectarContradicciones(EFECTO, {}).find(
      (x) => x.codigo === 'event_policy_empty',
    );
    assert.deepEqual(fallo?.claves, [...(CLAVES_CON_SENTIDO[EFECTO] ?? [])]);
  });

  it('con una sola clave con sentido ya no está vacía', () => {
    assert.ok(
      !detectarContradicciones(EFECTO, { hold_on_dispute: false }).some(
        (x) => x.codigo === 'event_policy_empty',
      ),
    );
  });
});

/* ========================================================================== */
describe('guardar un borrador y publicarlo no se validan igual', () => {
  const conVersion = (version: string, texto = '') => {
    const formulario = formularioVacio(EFECTO);
    formulario.version = version;
    formulario.texto = texto;
    return formulario;
  };

  it('guardar NO mira contradicciones: un borrador a medias es lo normal', () => {
    const codigos = codigosDe(
      validarBorrador(EFECTO, conVersion('uno'), { revoke_on_partial_refund: true }),
    );
    assert.ok(!codigos.includes('event_policy_contradictory'));
    assert.ok(!codigos.includes('event_policy_empty'));
  });

  it('guardar SÍ mira las cotas: nueve millones no es «a medias»', () => {
    assert.ok(
      codigosDe(validarBorrador(ELEGIBILIDAD, conVersion('uno'), { refund_bps: 9e6 })).includes(
        'event_policy_param_out_of_range',
      ),
    );
  });

  it('sin versión no se guarda, y se dice cuál falta', () => {
    const fallo = validarBorrador(EFECTO, conVersion('  '), {}).find(
      (x) => x.campo === 'version',
    );
    assert.equal(fallo?.codigo, 'event_policy_version_missing');
  });

  it('una versión más larga de lo que cabe se corta antes de mandarla', () => {
    const fallo = validarBorrador(EFECTO, conVersion('x'.repeat(33)), {}).find(
      (x) => x.campo === 'version',
    );
    assert.equal(fallo?.codigo, 'event_policy_version_too_long');
    assert.equal(fallo?.max, LARGO_MAXIMO_DE_LA_VERSION);
  });

  it('un texto más largo del que el servidor guarda se avisa aquí', () => {
    const fallo = validarBorrador(EFECTO, conVersion('uno', 'x'.repeat(LARGO_DEL_TEXTO + 1)), {
      hold_on_dispute: true,
    }).find((x) => x.campo === 'texto');
    assert.equal(fallo?.codigo, 'event_policy_body_too_long');
  });

  it('un tipo que no es del organizador no se guarda', () => {
    assert.ok(
      codigosDe(validarBorrador('refund_execution', conVersion('uno'), {})).includes(
        'event_policy_type_not_allowed',
      ),
    );
  });

  it('publicar SÍ mira las contradicciones', () => {
    assert.ok(
      codigosDe(
        validarPublicacion(EFECTO, conVersion('uno'), { revoke_on_partial_refund: true }),
      ).includes('event_policy_contradictory'),
    );
  });

  it('no se publica una política sin parámetros y sin texto', () => {
    assert.ok(
      codigosDe(validarPublicacion(EFECTO, conVersion('uno'), {})).includes(
        'event_policy_empty',
      ),
    );
  });

  it('la vacía se cuenta una sola vez, no dos', () => {
    const vacias = validarPublicacion(EFECTO, conVersion('uno'), {}).filter(
      (x) => x.codigo === 'event_policy_empty',
    );
    assert.equal(vacias.length, 1);
  });

  it('con todo escrito, se puede publicar', () => {
    const formulario = conVersion('condiciones-1');
    formulario.booleanos.revoke_on_refund = 'si';
    formulario.texto = 'Si devolvemos el importe, la entrada deja de valer.';
    const { params } = paramsDesdeFormulario(EFECTO, formulario);
    assert.equal(sePuedePublicar(EFECTO, formulario, params, null), true);
  });
});

/* ========================================================================== */
describe('lo que se escribe en los campos', () => {
  it('lo que no es un número se rechaza con el código del servidor', () => {
    const formulario = formularioVacio(ELEGIBILIDAD);
    formulario.numeros.refund_bps = 'la mitad';
    const { params, fallos } = paramsDesdeFormulario(ELEGIBILIDAD, formulario);
    assert.equal(fallos[0]?.codigo, 'event_policy_param_not_a_number');
    assert.ok(!('refund_bps' in params));
  });

  it('los espacios sobrantes no convierten un campo vacío en un cero', () => {
    const formulario = formularioVacio(ELEGIBILIDAD);
    formulario.numeros.refund_bps = '   ';
    assert.deepEqual(paramsDesdeFormulario(ELEGIBILIDAD, formulario).params, {});
  });

  it('la coma decimal se lee como la escribe medio mundo', () => {
    const formulario = formularioVacio(ELEGIBILIDAD);
    formulario.numeros.days_after_event = '7,5';
    assert.equal(paramsDesdeFormulario(ELEGIBILIDAD, formulario).params.days_after_event, 7.5);
  });

  it('un número fuera de cota se devuelve con su rango', () => {
    const formulario = formularioVacio(ELEGIBILIDAD);
    formulario.numeros.refund_bps = '20000';
    const fallo = paramsDesdeFormulario(ELEGIBILIDAD, formulario).fallos[0];
    assert.equal(fallo?.codigo, 'event_policy_param_out_of_range');
    assert.equal(fallo?.max, 10_000);
  });

  it('una versión vacía no viaja; una escrita viaja sin espacios', () => {
    assert.equal(versionUtil('   '), null);
    assert.equal(versionUtil(null), null);
    assert.equal(versionUtil('  condiciones-1 '), 'condiciones-1');
  });

  it('un texto en blanco viaja como `null`, no como cadena vacía', () => {
    assert.equal(textoUtil('  \n '), null);
    assert.equal(textoUtil('Hasta 48 horas antes.'), 'Hasta 48 horas antes.');
  });
});

/* ========================================================================== */
describe('sin condiciones NO es «no se devuelve»', () => {
  it('sin ninguna vigente, el punto es «sin configurar»', () => {
    assert.equal(estadoDeConfiguracion(estadoCon({})), 'sinConfigurar');
  });

  it('con una de dos, está a medias', () => {
    const estado = estadoCon({
      vigentes: [politica({ policy_type: ELEGIBILIDAD, status: 'published' })],
    });
    assert.equal(estadoDeConfiguracion(estado), 'aMedias');
    assert.deepEqual(tiposSinVigente(estado), [EFECTO]);
  });

  it('con las dos, está completa', () => {
    const estado = estadoCon({
      vigentes: [
        politica({ policy_type: ELEGIBILIDAD, status: 'published' }),
        politica({ policy_type: EFECTO, status: 'published' }),
      ],
    });
    assert.equal(estadoDeConfiguracion(estado), 'completa');
    assert.deepEqual(tiposSinVigente(estado), []);
  });

  it('ninguna clave del resumen habla de negar una devolución', () => {
    // El texto se escribe en las tablas de idiomas; la CLAVE ya deja dicho que
    // lo que falta es la definición, no el derecho.
    for (const punto of ['sinConfigurar', 'aMedias', 'completa'] as const) {
      for (const clave of [claveDelResumen(punto), claveDelCuerpoDelResumen(punto)]) {
        assert.ok(clave.startsWith('politicasEvento.'), clave);
        for (const prohibida of ['sinDevolucion', 'noSeDevuelve', 'noRefund']) {
          assert.ok(!clave.includes(prohibida), `${clave} decide por quien organiza`);
        }
      }
    }
  });

  it('los tipos que se ofrecen son los que manda el servidor, filtrados', () => {
    const estado = estadoCon({ tipos: [ELEGIBILIDAD, 'refund_execution', EFECTO] });
    assert.deepEqual(tiposOfrecidos(estado), [ELEGIBILIDAD, EFECTO]);
  });

  it('sin estado leído no se ofrece ningún tipo', () => {
    assert.deepEqual(tiposOfrecidos(null), []);
  });
});

/* ========================================================================== */
describe('encontrar lo de cada tipo', () => {
  const estado = estadoCon({
    configurada: true,
    vigentes: [politica({ policy_type: ELEGIBILIDAD, status: 'published', version: 'dos' })],
    borradores: [politica({ policy_type: EFECTO, status: 'draft', version: 'uno' })],
    historial: [
      politica({ policy_type: ELEGIBILIDAD, status: 'superseded', version: 'una' }),
      politica({ policy_type: EFECTO, status: 'superseded', version: 'cero' }),
    ],
  });

  it('la vigente de un tipo, y `null` cuando no la hay', () => {
    assert.equal(vigenteDelTipo(estado, ELEGIBILIDAD)?.version, 'dos');
    assert.equal(vigenteDelTipo(estado, EFECTO), null);
  });

  it('el borrador de un tipo, y `null` cuando no lo hay', () => {
    assert.equal(borradorDelTipo(estado, EFECTO)?.version, 'uno');
    assert.equal(borradorDelTipo(estado, ELEGIBILIDAD), null);
  });

  it('el historial se filtra por tipo y no arrastra el del otro', () => {
    assert.deepEqual(
      historialDelTipo(estado, ELEGIBILIDAD).map((p) => p.version),
      ['una'],
    );
  });

  it('nada de lo que sale del historial ofrece una acción de escritura', () => {
    for (const p of historialDelTipo(estado, EFECTO)) {
      assert.deepEqual(accionesDePolitica(p.status), []);
    }
  });
});

/* ========================================================================== */
describe('cada cosa se llama por su nombre', () => {
  it('los dos tipos del organizador, y solo esos', () => {
    assert.deepEqual([...TIPOS_DEL_ORGANIZADOR], [ELEGIBILIDAD, EFECTO]);
    assert.equal(esTipoDelOrganizador('refund_execution'), false);
    assert.equal(esTipoDelOrganizador('settlement_hold'), false);
    assert.equal(esTipoDelOrganizador(ELEGIBILIDAD), true);
  });

  it('las claves con sentido son las del servidor, tipo por tipo', () => {
    assert.deepEqual(
      [...(CLAVES_CON_SENTIDO[ELEGIBILIDAD] ?? [])],
      [
        'window_hours_before_event',
        'days_after_event',
        'refund_bps',
        'cancelled_event_bps',
        'allow_buyer_cancellation',
        'allow_exchange',
      ],
    );
    assert.deepEqual(
      [...(CLAVES_CON_SENTIDO[EFECTO] ?? [])],
      [
        'revoke_on_refund',
        'revoke_on_partial_refund',
        'hold_on_dispute',
        'restore_on_rejected_refund',
      ],
    );
  });

  it('lo que tiene cota es número y lo demás del tipo es sí/no', () => {
    assert.equal(esClaveNumerica('refund_bps'), true);
    assert.equal(esClaveNumerica('allow_exchange'), false);
    assert.equal(esClaveBooleana(ELEGIBILIDAD, 'allow_exchange'), true);
    assert.equal(esClaveBooleana(ELEGIBILIDAD, 'refund_bps'), false);
    assert.equal(esClaveBooleana(EFECTO, 'allow_exchange'), false);
    assert.equal(cotaDe('allow_exchange'), null);
  });

  it('cada parámetro tiene su nombre y su ayuda, y no se repiten', () => {
    const nombres = CLAVES_DEL_ORGANIZADOR.map(claveDelParametro);
    const ayudas = CLAVES_DEL_ORGANIZADOR.map(claveDeAyudaDelParametro);
    assert.equal(new Set(nombres).size, nombres.length);
    assert.equal(new Set(ayudas).size, ayudas.length);
    assert.equal(claveDelParametro('reserve_bps'), 'politicasEvento.param.desconocido');
  });

  it('los tres estados y los dos tipos tienen texto propio', () => {
    const estados = ESTADOS_DE_POLITICA.map(claveDelEstado);
    assert.equal(new Set(estados).size, 3);
    assert.equal(claveDelEstado('lo-que-sea'), 'politicasEvento.estado.desconocido');
    assert.equal(claveDelTipo('refund_execution'), 'politicasEvento.tipo.desconocido');
  });
});

/* ========================================================================== */
describe('cuando algo sale mal', () => {
  const CODIGOS = [
    'event_policy_empty',
    'event_policy_contradictory',
    'event_policy_param_out_of_range',
    'event_policy_param_not_a_number',
    'event_policy_type_not_allowed',
    'event_policy_not_editable',
    'event_policy_version_taken',
    'event_policy_not_found',
    'event_policies_not_available',
  ];

  it('cada código pedido tiene su propio mensaje, y ninguno se repite', () => {
    const claves = CODIGOS.map((codigo) => claveDeErrorDePolitica(codigo));
    for (const [indice, clave] of claves.entries()) {
      assert.ok(clave !== null, `${CODIGOS[indice]} no tiene mensaje`);
    }
    assert.equal(new Set(claves).size, claves.length);
  });

  it('un código que no conocemos deja hablar al servidor', () => {
    assert.equal(claveDeErrorDePolitica('lo_que_sea'), null);
    assert.equal(claveDeErrorDePolitica(null), null);
    assert.equal(claveDeErrorDePolitica(undefined), null);
  });

  it('401, 403, 404 y 409 se cuentan distinto entre sí', () => {
    const claves = [401, 403, 404, 409].map(claveDeErrorPorEstado);
    assert.ok(claves.every((x) => x !== null));
    assert.equal(new Set(claves).size, 4);
    assert.equal(claveDeErrorPorEstado(500), null);
  });

  it('un 409 se recupera recargando, no se muestra y se olvida', () => {
    assert.equal(hayQueRecargar(409, null), true);
    assert.equal(hayQueRecargar(null, 'event_policy_not_editable'), true);
    assert.equal(hayQueRecargar(null, 'event_policy_version_taken'), true);
    assert.equal(hayQueRecargar(null, 'event_policy_not_found'), true);
    assert.equal(hayQueRecargar(500, 'otro'), false);
  });

  it('los DOS códigos de «todavía no está desplegado» se tratan igual', () => {
    // Las rutas de políticas llaman a `exigir_posventa`, que contesta
    // `event_aftersale_not_available`; `event_policies_not_available` está
    // escrito en `exigir_aceptaciones`. Ignorar uno deja la pantalla muda.
    assert.equal(esPoliticasApagadas('event_policies_not_available'), true);
    assert.equal(esPoliticasApagadas('event_aftersale_not_available'), true);
    assert.equal(esPoliticasApagadas('network_error'), false);
    assert.equal(esPoliticasApagadas(null), false);
  });

  it('un fallo local se cuenta con el mismo mensaje que el del servidor', () => {
    assert.equal(
      claveDeFallo({ campo: 'refund_bps', codigo: 'event_policy_param_out_of_range' }),
      claveDeErrorDePolitica('event_policy_param_out_of_range'),
    );
    assert.equal(
      claveDeFallo({ campo: 'politica', codigo: 'inventado' }),
      'politicasEvento.error.desconocido',
    );
  });
});

/* ========================================================================== */
describe('cancelar el evento no devuelve nada', () => {
  const resultado = {
    regla: 'pending_business_decision',
    expedientes: 12,
    saldos_bloqueados: 9,
    sin_saldo: 3,
    avisos: 24,
  };

  it('las tres reglas del servidor tienen texto propio', () => {
    const claves = REGLAS_DE_CANCELACION.map(claveDeRegla);
    assert.equal(new Set(claves).size, 3);
    assert.equal(claveDeRegla('otra'), 'politicasEvento.regla.desconocido');
    assert.equal(
      claveDelCuerpoDeLaRegla('otra'),
      'politicasEvento.reglaCuerpo.desconocido',
    );
  });

  it('NINGUNA fila del resultado dice que se devolvió nada', () => {
    for (const fila of filasDelResultado(resultado)) {
      for (const prohibida of ['devuel', 'reembols', 'abonad', 'refund']) {
        assert.ok(!fila.clave.toLowerCase().includes(prohibida), fila.clave);
      }
    }
  });

  it('se cuenta lo que el servidor mandó, tal cual y sin sumar nada', () => {
    const filas = filasDelResultado(resultado);
    assert.deepEqual(
      filas.map((x) => x.valor),
      [12, 9, 3, 24],
    );
    assert.equal(new Set(filas.map((x) => x.clave)).size, 4);
  });

  it('un cero se enseña como cero: no hay filas que desaparezcan', () => {
    const filas = filasDelResultado({
      regla: 'pending_business_decision',
      expedientes: 0,
      saldos_bloqueados: 0,
      sin_saldo: 0,
      avisos: 0,
    });
    assert.equal(filas.length, 4);
    assert.ok(filas.every((x) => x.valor === 0));
  });

  it('sin motivo escrito no se cancela', () => {
    assert.equal(motivoDeCancelacionUtil(''), null);
    assert.equal(motivoDeCancelacionUtil('   \n  '), null);
    assert.equal(motivoDeCancelacionUtil(null), null);
    assert.equal(motivoDeCancelacionUtil(undefined), null);
  });

  it('el motivo viaja limpio y recortado a lo que el servidor admite', () => {
    assert.equal(motivoDeCancelacionUtil('  se inundó el local  '), 'se inundó el local');
    assert.equal(
      motivoDeCancelacionUtil('x'.repeat(LARGO_MAXIMO_DEL_MOTIVO + 500))?.length,
      LARGO_MAXIMO_DEL_MOTIVO,
    );
  });
});

/* ========================================================================== */
describe('la previsualización es literal', () => {
  it('los parámetros salen en crudo y ordenados, sin traducirlos', () => {
    assert.deepEqual(paresDeParametros({ refund_bps: 5000, allow_exchange: true }), [
      ['allow_exchange', 'true'],
      ['refund_bps', '5000'],
    ]);
  });

  it('cada valor se enseña como es, sin interpretarlo', () => {
    assert.equal(valorLiteral(5000), '5000');
    assert.equal(valorLiteral(true), 'true');
    assert.equal(valorLiteral(false), 'false');
    assert.equal(valorLiteral('hasta el jueves'), 'hasta el jueves');
    assert.equal(valorLiteral(null), 'null');
    assert.equal(valorLiteral(undefined), '');
    assert.equal(valorLiteral({ a: 1 }), '{"a":1}');
  });

  it('un objeto de parámetros vacío no produce ninguna línea inventada', () => {
    assert.deepEqual(paresDeParametros({}), []);
  });

  it('sin condiciones no hay nada que enseñar, y no es un error', () => {
    assert.equal(hayCondiciones({ configurada: false, condiciones: [] }), false);
    assert.equal(hayCondiciones(null), false);
    assert.equal(
      hayCondiciones({
        configurada: true,
        condiciones: [{ policy_type: EFECTO, version: 'uno', body: null, params: {} }],
      }),
      true,
    );
  });
});

/* ========================================================================== */
describe('el formato no añade nada que no se escribiera', () => {
  it('la versión se enseña como se escribió: sin «v» y sin «1.0»', () => {
    assert.equal(etiquetaDeVersion('  condiciones-2026 '), 'condiciones-2026');
    assert.equal(etiquetaDeVersion('1'), '1');
    assert.equal(etiquetaDeVersion(''), '');
    assert.equal(etiquetaDeVersion(null), '');
    assert.equal(etiquetaDeVersion(undefined), '');
  });

  it('una fecha que no se puede leer se queda vacía, no pone «hoy»', () => {
    assert.equal(fechaLegible(null), '');
    assert.equal(fechaLegible(''), '');
    assert.equal(fechaLegible('mañana'), '');
    assert.notEqual(fechaLegible('2026-03-01T10:00:00Z'), '');
  });

  it('el momento del historial lleva hora, y lo ilegible sigue vacío', () => {
    assert.equal(momentoLegible('no-es-una-fecha'), '');
    assert.ok(momentoLegible('2026-03-01T10:00:00Z').includes('·'));
  });

  it('la vigencia de una superada dice desde cuándo y hasta cuándo', () => {
    const superada = politica({
      policy_type: EFECTO,
      status: 'superseded',
      effective_from: '2026-01-01T00:00:00Z',
      effective_to: '2026-06-01T00:00:00Z',
    });
    assert.ok(vigenciaLegible(superada).includes('—'));
  });

  it('la vigente no pone ninguna fecha de fin que todavía no existe', () => {
    const vigente = politica({
      policy_type: EFECTO,
      status: 'published',
      effective_from: '2026-01-01T00:00:00Z',
      published_at: '2026-01-01T00:00:00Z',
    });
    assert.ok(!vigenciaLegible(vigente).includes('—'));
  });

  it('sin ninguna fecha no se enseña una raya suelta', () => {
    assert.equal(vigenciaLegible(politica({ policy_type: EFECTO, status: 'draft' })), '');
  });
});

/* ========================================================================== */
describe('lo que la pantalla y el repositorio tienen escrito', () => {
  const pantalla = sinComentarios(fuente('screens', 'PoliticasDelEventoScreen.tsx'));
  const repositorio = sinComentarios(
    fuente('repositories', 'EventPolicyRepository.ts'),
  );

  it('la pantalla no precarga ningún parámetro con un valor', () => {
    // Un `refund_bps: 0` escrito aquí sería una condición de venta decidida por
    // la aplicación. El formulario nace del módulo, y nace vacío.
    for (const clave of CLAVES_DEL_ORGANIZADOR) {
      assert.ok(!pantalla.includes(`${clave}:`), `${clave} lleva un valor escrito`);
    }
    assert.ok(pantalla.includes('formularioVacio('));
  });

  it('publicar pasa por una confirmación explícita', () => {
    const publicar = pantalla.slice(pantalla.indexOf('const publicar'));
    const hastaElFinal = publicar.slice(0, publicar.indexOf('const descartar'));
    assert.ok(hastaElFinal.includes('confirm('), 'un toque no publica');
    assert.ok(
      hastaElFinal.includes('politicasEvento.publicarAviso'),
      'falta el aviso de que no es retroactivo',
    );
    assert.ok(hastaElFinal.indexOf('confirm(') < hastaElFinal.indexOf('.publicar('));
  });

  it('cancelar exige motivo y una confirmación destructiva', () => {
    const cancelar = pantalla.slice(pantalla.indexOf('const cancelarEvento'));
    assert.ok(cancelar.includes('motivoDeCancelacionUtil('));
    assert.ok(cancelar.includes('destructive: true'));
    assert.ok(cancelar.indexOf('confirm(') < cancelar.indexOf('.cancelarEvento('));
  });

  it('el cerrojo se cierra ANTES del primer await', () => {
    const cerrojo = pantalla.slice(pantalla.indexOf('const conCerrojo'));
    const hasta = cerrojo.slice(0, cerrojo.indexOf('await trabajo()'));
    assert.ok(hasta.includes('if (ocupadoRef.current) return;'));
    assert.ok(!hasta.includes('await '), 'hay un await antes del cerrojo');
  });

  it('la pantalla no llama a ninguna ruta de administración', () => {
    assert.ok(!pantalla.includes('/admin/'));
    assert.ok(!pantalla.includes('EventAftersaleAdminRepository'));
    assert.ok(!pantalla.includes('EventFinanceAdminRepository'));
    assert.ok(!repositorio.includes('/admin/'));
  });

  it('el repositorio no sabe editar una política publicada', () => {
    for (const prohibido of ['actualizar(', 'editarPolitica(', 'reescribir(']) {
      assert.ok(!repositorio.includes(prohibido), prohibido);
    }
    // Lo único que se escribe es el borrador.
    assert.ok(repositorio.includes('/policies/draft'));
    assert.ok(repositorio.includes('/publish'));
  });

  it('la previsualización sale de `/terms`, no se reconstruye', () => {
    assert.ok(repositorio.includes('/policies/terms'));
    assert.ok(pantalla.includes('EventPolicyRepository.condiciones('));
    assert.ok(pantalla.includes('paresDeParametros('));
  });

  it('ningún texto en duro: todo pasa por el traductor', () => {
    for (const atributo of ['label="', 'title="', 'description="', 'placeholder="']) {
      assert.ok(!pantalla.includes(atributo), `${atributo} lleva texto en duro`);
    }
  });

  it('la pantalla tiene los estados completos, incluido el 503', () => {
    for (const trozo of [
      'state="loading"',
      'state="empty"',
      'onRetry',
      'esPoliticasApagadas(',
      'esFalloDeRed(',
      'error.status === 403',
      'error.status === 401',
    ]) {
      assert.ok(pantalla.includes(trozo), `falta ${trozo}`);
    }
  });

  it('la pantalla nunca ofrece editar sin preguntar por el estado', () => {
    // El único camino al editor pasa por `accionesDePolitica`, que es donde
    // está la regla; un `status === 'published'` suelto la esquivaría.
    assert.ok(pantalla.includes('accionesDePolitica('));
    assert.ok(!pantalla.includes("=== 'published'"));
    assert.ok(!pantalla.includes("!== 'draft'"));
  });

  it('el enlace desde el evento usa la clave acordada y la ruta nueva', () => {
    const editar = sinComentarios(fuente('screens', 'EditarEventoScreen.tsx'));
    assert.ok(editar.includes('politicasEvento.enlaceDesdeElEvento'));
    assert.ok(editar.includes('/politicas/${id}'));
  });
});
