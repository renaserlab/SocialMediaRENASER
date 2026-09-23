/**
 * La supervisión de políticas, ejecutada.
 *
 * Lo que se prueba aquí es lo que se rompe sin que se note mirando la
 * aplicación:
 *
 *  1. Una clave de `params` que todavía no conocemos. El servidor puede añadir
 *     una mañana: tiene que APARECER cruda, no desaparecer ni tumbar la
 *     pantalla. Lo mismo con un objeto, una lista, un ciclo o una función.
 *  2. El cero contado como hueco. `refund_bps: 0` es «no se devuelve nada»
 *     PUBLICADO; enseñarlo como «sin definir» diría que nadie lo decidió.
 *  3. Una lista vacía contada como un fallo. En «sin política» son opuestas:
 *     vacío es que nadie vende sin condiciones y error es que no lo sabemos.
 *  4. Un botón inventado. El servidor no publica NINGUNA ruta que modifique una
 *     política desde administración, y no es un olvido: una versión aceptada no
 *     se reescribe. Eso se comprueba sobre el CÓDIGO del repositorio y de la
 *     pantalla, porque no es una función: es lo que está escrito.
 *
 * NO SE MIRAN LOS DICCIONARIOS. Las claves de este panel se están escribiendo
 * en `es`, `en` y `pt` en paralelo; lo que se comprueba aquí es que las claves
 * que se piden son las que se prometen.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ESTADOS_DE_POLITICA,
  FALLOS,
  LIMITES,
  LIMITE_DEL_SERVIDOR,
  LIMITE_INICIAL,
  PARAMETROS_CONOCIDOS,
  PESTANAS,
  PESTANA_INICIAL,
  POLITICA_ELEGIBILIDAD,
  TIPOS_DEL_ORGANIZADOR,
  TIPOS_DE_POLITICA,
  agruparPorEvento,
  agruparPorOrganizador,
  cadenaDeFiltros,
  claveDeLaPestana,
  claveDelCambio,
  claveDelCuerpoDelFallo,
  claveDelEstadoDePolitica,
  claveDelFallo,
  claveDelParametro,
  claveDelTipoDePolitica,
  compararParametros,
  contarEventosSinPolitica,
  contarOrganizadoresSinPolitica,
  cuantosFiltros,
  esFalloDeConexion,
  esSupervisionNoDisponible,
  estaVigente,
  estadoDeLaLista,
  falloDesde,
  filasDeParametros,
  huellaAbreviada,
  limiteValido,
  llegoAlTope,
  loEscribeElOrganizador,
  mismaHuella,
  noDecideNada,
  ordenarPorCreacion,
  porcentajeDesdeBps,
  referenciaAbreviada,
  siguienteLimite,
  soloLosCambios,
  textoDeFiltro,
  tonoDelEstado,
  unidadDelParametro,
  valorDeParametro,
  versionAnterior,
  versionesDelMismoTipo,
  type PoliticaSupervisada,
} from './supervisionDePoliticas.ts';

const AQUI = fileURLToPath(new URL('.', import.meta.url));

function fuente(carpeta: string, nombre: string): string {
  return readFileSync(join(AQUI, '..', carpeta, nombre), 'utf8');
}

/** El código sin comentarios: lo que el fichero HACE, no lo que explica. */
function sinComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((linea) => !linea.trim().startsWith('//'))
    .join('\n');
}

function politica(cambios: Partial<PoliticaSupervisada> = {}): PoliticaSupervisada {
  return {
    id: 'p1',
    event_id: 'e1',
    policy_type: POLITICA_ELEGIBILIDAD,
    version: 'v1',
    status: 'published',
    params: {},
    body: null,
    params_sha256: 'a'.repeat(64),
    published_at: '2026-01-10T10:00:00Z',
    published_by: '11111111-2222-3333-4444-555555555555',
    created_by: '66666666-7777-8888-9999-000000000000',
    effective_from: '2026-01-10T10:00:00Z',
    effective_to: null,
    created_at: '2026-01-10T09:00:00Z',
    ...cambios,
  };
}

describe('una clave que no conocemos se enseña, no se esconde ni revienta', () => {
  it('una clave desconocida sale cruda y con etiqueta nula', () => {
    // EL FALLO QUE ESTO CIERRA: el servidor añade un parámetro, la pantalla no
    // lo reconoce y lo oculta. Se escondería una regla que sí se aplica.
    const filas = filasDeParametros({ chupacabra_setting: 'sí, claro' });
    assert.equal(filas.length, 1);
    assert.equal(filas[0]?.clave, 'chupacabra_setting');
    assert.equal(filas[0]?.etiqueta, null);
    assert.deepEqual(filas[0]?.valor, { forma: 'texto', texto: 'sí, claro' });
  });

  it('una clave desconocida no impide leer las que sí conocemos', () => {
    const filas = filasDeParametros({ refund_bps: 5000, loquesea: true });
    assert.equal(filas.length, 2);
    assert.deepEqual(
      filas.map((fila) => fila.clave),
      ['refund_bps', 'loquesea'],
    );
  });

  it('un objeto se vuelca y no rompe la fila', () => {
    const valor = valorDeParametro('raro', { a: 1, b: [2, 3] });
    assert.equal(valor.forma, 'texto');
    assert.equal(valor.forma === 'texto' ? valor.texto : '', '{"a":1,"b":[2,3]}');
  });

  it('una lista se vuelca entera', () => {
    const valor = valorDeParametro('raro', ['uno', 'dos']);
    assert.deepEqual(valor, { forma: 'texto', texto: '["uno","dos"]' });
  });

  it('una estructura cíclica se nombra en vez de tumbar la pantalla', () => {
    const ciclo: Record<string, unknown> = {};
    ciclo.yo = ciclo;
    assert.deepEqual(valorDeParametro('raro', ciclo), {
      forma: 'clave',
      clave: 'politicasAdmin.valor.noLegible',
    });
    assert.doesNotThrow(() => filasDeParametros({ raro: ciclo }));
  });

  it('algo que ni siquiera es dato tampoco rompe nada', () => {
    assert.deepEqual(valorDeParametro('raro', () => 1), {
      forma: 'clave',
      clave: 'politicasAdmin.valor.noLegible',
    });
  });

  it('un volcado larguísimo se recorta en vez de ocupar la pantalla', () => {
    const valor = valorDeParametro('raro', { texto: 'x'.repeat(500) });
    assert.equal(valor.forma, 'texto');
    assert.ok((valor.forma === 'texto' ? valor.texto : '').length <= 201);
  });

  it('`params` nulo o ausente no produce filas ni excepciones', () => {
    assert.deepEqual(filasDeParametros(null), []);
    assert.deepEqual(filasDeParametros(undefined), []);
  });

  it('lo conocido va primero y en su orden; lo demás detrás y alfabético', () => {
    const filas = filasDeParametros({
      zzz: 1,
      allow_exchange: true,
      aaa: 2,
      refund_bps: 100,
    });
    assert.deepEqual(
      filas.map((fila) => fila.clave),
      ['refund_bps', 'allow_exchange', 'aaa', 'zzz'],
    );
  });

  it('las diez claves que el servidor nombra tienen traducción', () => {
    for (const clave of PARAMETROS_CONOCIDOS) {
      assert.equal(claveDelParametro(clave), `politicasAdmin.param.${clave}`);
    }
    assert.equal(claveDelParametro('inventada'), null);
  });
});

describe('cero es cero por ciento, no un hueco', () => {
  it('`refund_bps: 0` se enseña «0 %» y NO «sin definir»', () => {
    // EL FALLO QUE ESTO CIERRA: leer un cero publicado como si nadie hubiera
    // decidido nada. Son cosas opuestas: «no se devuelve» está decidido.
    const valor = valorDeParametro('refund_bps', 0);
    assert.deepEqual(valor, { forma: 'texto', texto: '0 %' });
    assert.notDeepEqual(valor, {
      forma: 'clave',
      clave: 'politicasAdmin.valor.sinDefinir',
    });
  });

  it('los puntos básicos se cuentan como porcentaje', () => {
    assert.equal(porcentajeDesdeBps(10000), '100 %');
    assert.equal(porcentajeDesdeBps(5000), '50 %');
    assert.equal(porcentajeDesdeBps(1250), '12.5 %');
    assert.equal(porcentajeDesdeBps(1), '0.01 %');
    assert.equal(porcentajeDesdeBps(0), '0 %');
  });

  it('cualquier clave acabada en `_bps` es un porcentaje, la conozcamos o no', () => {
    assert.equal(unidadDelParametro('refund_bps'), 'porcentaje');
    assert.equal(unidadDelParametro('cancelled_event_bps'), 'porcentaje');
    assert.equal(unidadDelParametro('lo_que_sea_bps'), 'porcentaje');
    assert.deepEqual(valorDeParametro('lo_que_sea_bps', 2500), {
      forma: 'texto',
      texto: '25 %',
    });
  });

  it('las horas y los días llevan su unidad, y `0` también', () => {
    assert.deepEqual(valorDeParametro('window_hours_before_event', 48), {
      forma: 'clave',
      clave: 'politicasAdmin.valor.horas',
      params: { n: 48 },
    });
    assert.deepEqual(valorDeParametro('days_after_event', 0), {
      forma: 'clave',
      clave: 'politicasAdmin.valor.dias',
      params: { n: 0 },
    });
  });

  it('la unidad del nombre exacto gana al sufijo', () => {
    // `window_hours_before_event` no acaba en `_hours` y aun así son horas.
    assert.equal(unidadDelParametro('window_hours_before_event'), 'horas');
    assert.equal(unidadDelParametro('grace_hours'), 'horas');
    assert.equal(unidadDelParametro('hold_days'), 'dias');
    assert.equal(unidadDelParametro('allow_exchange'), null);
  });

  it('un booleano se dice sí o no, y `false` NO es «sin definir»', () => {
    assert.deepEqual(valorDeParametro('allow_exchange', true), {
      forma: 'clave',
      clave: 'politicasAdmin.valor.si',
    });
    assert.deepEqual(valorDeParametro('allow_exchange', false), {
      forma: 'clave',
      clave: 'politicasAdmin.valor.no',
    });
  });

  it('lo que no llegó sí es un hueco', () => {
    assert.deepEqual(valorDeParametro('refund_bps', null), {
      forma: 'clave',
      clave: 'politicasAdmin.valor.sinDefinir',
    });
    assert.deepEqual(valorDeParametro('refund_bps', undefined), {
      forma: 'clave',
      clave: 'politicasAdmin.valor.sinDefinir',
    });
  });

  it('un número escrito como texto sigue siendo ese número', () => {
    assert.deepEqual(valorDeParametro('refund_bps', '2500'), {
      forma: 'texto',
      texto: '25 %',
    });
    assert.deepEqual(valorDeParametro('days_after_event', '7'), {
      forma: 'clave',
      clave: 'politicasAdmin.valor.dias',
      params: { n: 7 },
    });
  });

  it('un texto vacío se dice vacío, no se pinta como una regla', () => {
    assert.deepEqual(valorDeParametro('nota', '   '), {
      forma: 'clave',
      clave: 'politicasAdmin.valor.vacio',
    });
  });

  it('un número imposible se enseña tal cual en vez de desaparecer', () => {
    assert.deepEqual(valorDeParametro('refund_bps', Number.NaN), {
      forma: 'texto',
      texto: 'NaN',
    });
  });

  it('`params` vacío es «no decide nada», que no es «todo en cero»', () => {
    assert.equal(noDecideNada({}), true);
    assert.equal(noDecideNada(null), true);
    assert.equal(noDecideNada({ refund_bps: 0 }), false);
  });
});

describe('la huella y las referencias internas', () => {
  it('la huella se abrevia y se reconoce', () => {
    assert.equal(huellaAbreviada('ABCDEF0123456789abcdef'), 'abcdef012345');
    assert.equal(huellaAbreviada('abc', 12), 'abc');
  });

  it('sin huella no se inventa ninguna', () => {
    assert.equal(huellaAbreviada(null), null);
    assert.equal(huellaAbreviada('   '), null);
    assert.equal(huellaAbreviada(undefined), null);
  });

  it('dos huellas iguales son los mismos parámetros publicados', () => {
    assert.equal(mismaHuella('ABC', 'abc'), true);
    assert.equal(mismaHuella('abc', 'abd'), false);
  });

  it('«no lo sé» no es «son iguales»', () => {
    assert.equal(mismaHuella(null, null), false);
    assert.equal(mismaHuella('abc', null), false);
  });

  it('un identificador interno se enseña abreviado, para investigar', () => {
    assert.equal(referenciaAbreviada('11111111-2222-3333'), '11111111');
    assert.equal(referenciaAbreviada(null), null);
    assert.equal(referenciaAbreviada(''), null);
  });
});

describe('mirar la historia sin reescribirla', () => {
  it('lo añadido, lo quitado, lo cambiado y lo igual se dicen distinto', () => {
    const filas = compararParametros(
      { refund_bps: 5000, allow_exchange: true, viejo: 1 },
      { refund_bps: 0, allow_exchange: true, nuevo: 2 },
    );
    const por = new Map(filas.map((fila) => [fila.clave, fila.cambio]));
    assert.equal(por.get('refund_bps'), 'distinto');
    assert.equal(por.get('allow_exchange'), 'igual');
    assert.equal(por.get('viejo'), 'quitado');
    assert.equal(por.get('nuevo'), 'anadido');
  });

  it('un parámetro que desapareció no se pinta como un cero', () => {
    const filas = compararParametros({ refund_bps: 5000 }, {});
    assert.equal(filas[0]?.cambio, 'quitado');
    assert.equal(filas[0]?.ahora, null);
    assert.deepEqual(filas[0]?.antes, { forma: 'texto', texto: '50 %' });
  });

  it('bajar a cero es un cambio, no una desaparición', () => {
    const filas = soloLosCambios(
      compararParametros({ refund_bps: 5000 }, { refund_bps: 0 }),
    );
    assert.equal(filas.length, 1);
    assert.equal(filas[0]?.cambio, 'distinto');
    assert.deepEqual(filas[0]?.ahora, { forma: 'texto', texto: '0 %' });
  });

  it('dos versiones idénticas no cuentan ningún cambio', () => {
    const iguales = { refund_bps: 100, allow_exchange: false };
    assert.deepEqual(soloLosCambios(compararParametros(iguales, { ...iguales })), []);
  });

  it('comparar contra nada no revienta', () => {
    assert.deepEqual(compararParametros(null, null), []);
    assert.equal(compararParametros(null, { a: 1 })[0]?.cambio, 'anadido');
  });

  it('las versiones del mismo tipo se ordenan de la nueva a la vieja', () => {
    const vieja = politica({ id: 'v1', created_at: '2026-01-01T00:00:00Z' });
    const nueva = politica({ id: 'v2', created_at: '2026-02-01T00:00:00Z' });
    const otroTipo = politica({ id: 'x', policy_type: 'ticket_effect' });
    const todas = versionesDelMismoTipo([vieja, nueva, otroTipo], vieja);
    assert.deepEqual(
      todas.map((p) => p.id),
      ['v2', 'v1'],
    );
  });

  it('la anterior es la de antes, y sin anterior es `null`', () => {
    const vieja = politica({ id: 'v1', created_at: '2026-01-01T00:00:00Z' });
    const nueva = politica({ id: 'v2', created_at: '2026-02-01T00:00:00Z' });
    assert.equal(versionAnterior([vieja, nueva], nueva)?.id, 'v1');
    assert.equal(versionAnterior([vieja, nueva], vieja), null);
  });

  it('una fecha ilegible no se adelanta a lo fechado', () => {
    const buena = politica({ id: 'a', created_at: '2026-01-01T00:00:00Z' });
    const rota = politica({ id: 'b', created_at: 'cuando sea' });
    assert.deepEqual(
      ordenarPorCreacion([rota, buena]).map((p) => p.id),
      ['a', 'b'],
    );
  });
});

describe('agrupar para poder hablar con alguien', () => {
  it('las políticas se agrupan por evento en el orden que llegaron', () => {
    const grupos = agruparPorEvento([
      politica({ id: '1', event_id: 'e1' }),
      politica({ id: '2', event_id: 'e2' }),
      politica({ id: '3', event_id: 'e1' }),
    ]);
    assert.equal(grupos.length, 2);
    assert.equal(grupos[0]?.eventoId, 'e1');
    assert.equal(grupos[0]?.politicas.length, 2);
  });

  it('una política de plataforma (sin evento) tiene su propio grupo', () => {
    const grupos = agruparPorEvento([
      politica({ id: '1', event_id: null }),
      politica({ id: '2', event_id: 'e1' }),
    ]);
    assert.equal(grupos[0]?.eventoId, null);
    assert.equal(grupos.length, 2);
  });

  it('los eventos sin política se agrupan por organizador', () => {
    const grupos = agruparPorOrganizador([
      { event_id: 'a', title: 'A', organizer_id: 'o1' },
      { event_id: 'b', title: 'B', organizer_id: 'o2' },
      { event_id: 'c', title: 'C', organizer_id: 'o1' },
    ]);
    assert.equal(grupos.length, 2);
    assert.deepEqual(
      grupos[0]?.eventos.map((e) => e.event_id),
      ['a', 'c'],
    );
  });

  it('un evento sin organizador registrado no se pierde', () => {
    const grupos = agruparPorOrganizador([
      { event_id: 'a', title: null, organizer_id: null },
    ]);
    assert.equal(grupos.length, 1);
    assert.equal(grupos[0]?.organizadorId, null);
  });

  it('se cuentan eventos y organizadores, sin repetir', () => {
    const filas = [
      { event_id: 'a', title: 'A', organizer_id: 'o1' },
      { event_id: 'b', title: 'B', organizer_id: 'o1' },
      { event_id: 'c', title: 'C', organizer_id: 'o2' },
    ];
    assert.equal(contarEventosSinPolitica(filas), 3);
    assert.equal(contarOrganizadoresSinPolitica(filas), 2);
  });

  it('sin eventos sin política no hay nada que contar', () => {
    assert.equal(contarEventosSinPolitica([]), 0);
    assert.equal(contarOrganizadoresSinPolitica([]), 0);
  });
});

describe('los filtros y el tope', () => {
  it('la cadena lleva todo lo puesto, en un orden fijo', () => {
    assert.equal(
      cadenaDeFiltros({
        organizadorId: 'o1',
        eventoId: 'e1',
        tipo: POLITICA_ELEGIBILIDAD,
        estado: 'published',
        limite: 100,
      }),
      'organizer_id=o1&event_id=e1&policy_type=aftersale_eligibility&estado=published&limit=100',
    );
  });

  it('lo vacío NO viaja: filtrar por lo que nadie escribió no filtra nada', () => {
    assert.equal(cadenaDeFiltros({ eventoId: '   ', estado: null }), 'limit=50');
    assert.equal(cadenaDeFiltros({}), `limit=${LIMITE_INICIAL}`);
  });

  it('lo escrito a mano se recorta antes de viajar', () => {
    assert.equal(cadenaDeFiltros({ eventoId: '  e1  ' }), 'event_id=e1&limit=50');
    assert.equal(textoDeFiltro('  e1 '), 'e1');
    assert.equal(textoDeFiltro('   '), null);
    assert.equal(textoDeFiltro(undefined), null);
  });

  it('el tope se queda dentro de lo que el servidor acepta', () => {
    assert.equal(limiteValido(0), 1);
    assert.equal(limiteValido(9999), LIMITE_DEL_SERVIDOR);
    assert.equal(limiteValido(null), LIMITE_INICIAL);
    assert.equal(limiteValido(75.6), 75);
  });

  it('se sube el tope hasta el máximo y allí se para', () => {
    assert.equal(siguienteLimite(50), 100);
    assert.equal(siguienteLimite(100), 200);
    assert.equal(siguienteLimite(200), null);
    assert.deepEqual([...LIMITES], [50, 100, 200]);
  });

  it('tantas filas como el tope significa que puede haber más', () => {
    assert.equal(llegoAlTope(50, 50), true);
    assert.equal(llegoAlTope(49, 50), false);
  });

  it('se sabe cuántos filtros hay puestos, para explicar un vacío', () => {
    assert.equal(cuantosFiltros({}), 0);
    assert.equal(cuantosFiltros({ eventoId: 'e1', estado: 'draft' }), 2);
    assert.equal(cuantosFiltros({ eventoId: '  ' }), 0);
  });
});

describe('vacío no es error', () => {
  it('una lista vacía sin fallo es «no hay ninguno», no «no lo sabemos»', () => {
    // EL FALLO QUE ESTO CIERRA: decir «ningún evento vende sin condiciones»
    // cuando en realidad la petición se cayó.
    assert.equal(estadoDeLaLista({ cargando: false, fallo: null, filas: 0 }), 'vacio');
    assert.equal(estadoDeLaLista({ cargando: false, fallo: 'red', filas: 0 }), 'error');
  });

  it('mientras se está pidiendo no se dice ni vacío ni error', () => {
    assert.equal(estadoDeLaLista({ cargando: true, fallo: null, filas: 0 }), 'cargando');
    assert.equal(
      estadoDeLaLista({ cargando: true, fallo: 'sinPermiso', filas: 0 }),
      'cargando',
    );
  });

  it('un fallo manda aunque hubiera filas viejas en pantalla', () => {
    assert.equal(estadoDeLaLista({ cargando: false, fallo: 'red', filas: 9 }), 'error');
    assert.equal(estadoDeLaLista({ cargando: false, fallo: null, filas: 9 }), 'lleno');
  });

  it('el 403 tiene su propio mensaje y no se disfraza de vacío', () => {
    assert.equal(falloDesde(403, 'forbidden'), 'sinPermiso');
    assert.notEqual(falloDesde(403, 'forbidden'), 'red');
  });

  it('el 503 de la posventa se dice «todavía no disponible»', () => {
    assert.equal(falloDesde(503, 'event_aftersale_not_available'), 'noDisponible');
    assert.equal(esSupervisionNoDisponible('event_aftersale_not_available'), true);
    assert.equal(esSupervisionNoDisponible('otra_cosa'), false);
  });

  it('sin red no es «falló el servidor»', () => {
    assert.equal(falloDesde(null, 'network_error'), 'sinConexion');
    assert.equal(falloDesde(null, 'timeout'), 'sinConexion');
    assert.equal(esFalloDeConexion('network_error'), true);
    assert.equal(esFalloDeConexion(null), false);
  });

  it('lo que no reconocemos se cuenta como un fallo de carga cualquiera', () => {
    assert.equal(falloDesde(500, 'boom'), 'red');
    assert.equal(falloDesde(null, null), 'red');
  });

  it('los cuatro fallos tienen titular y explicación propios', () => {
    const titulares = FALLOS.map((fallo) => claveDelFallo(fallo));
    const cuerpos = FALLOS.map((fallo) => claveDelCuerpoDelFallo(fallo));
    assert.equal(new Set([...titulares, ...cuerpos]).size, FALLOS.length * 2);
    assert.equal(claveDelFallo('loquesea'), 'politicasAdmin.fallo.desconocido');
  });
});

describe('los nombres de lo que se enseña', () => {
  it('los tres estados de la tabla tienen clave, y lo raro no rompe', () => {
    assert.deepEqual([...ESTADOS_DE_POLITICA], ['draft', 'published', 'superseded']);
    assert.equal(claveDelEstadoDePolitica('draft'), 'politicasAdmin.estado.draft');
    assert.equal(
      claveDelEstadoDePolitica('inventado'),
      'politicasAdmin.estado.desconocido',
    );
  });

  it('los nueve tipos del servidor tienen clave propia', () => {
    assert.equal(TIPOS_DE_POLITICA.length, 9);
    const claves = TIPOS_DE_POLITICA.map((tipo) => claveDelTipoDePolitica(tipo));
    assert.equal(new Set(claves).size, 9);
    assert.equal(claveDelTipoDePolitica('nuevo'), 'politicasAdmin.tipo.desconocido');
  });

  it('se distingue lo que escribe quien organiza de lo que escribe la empresa', () => {
    assert.deepEqual([...TIPOS_DEL_ORGANIZADOR], ['aftersale_eligibility', 'ticket_effect']);
    assert.equal(loEscribeElOrganizador(POLITICA_ELEGIBILIDAD), true);
    assert.equal(loEscribeElOrganizador('settlement_hold'), false);
  });

  it('publicada y sin fecha de fin es la que rige hoy', () => {
    assert.equal(estaVigente({ status: 'published', effective_to: null }), true);
    assert.equal(
      estaVigente({ status: 'published', effective_to: '2026-01-01T00:00:00Z' }),
      false,
    );
    assert.equal(estaVigente({ status: 'draft', effective_to: null }), false);
  });

  it('ningún estado se pinta como «aprobado»', () => {
    assert.equal(tonoDelEstado('published'), 'vigente');
    assert.equal(tonoDelEstado('draft'), 'espera');
    assert.equal(tonoDelEstado('superseded'), 'historico');
    assert.equal(tonoDelEstado('otro'), 'neutro');
  });

  it('la pestaña de «sin política» es la primera', () => {
    assert.equal(PESTANA_INICIAL, 'sinPolitica');
    assert.deepEqual([...PESTANAS], ['sinPolitica', 'publicadas']);
    assert.equal(claveDeLaPestana('publicadas'), 'politicasAdmin.pestana.publicadas');
  });

  it('los cuatro cambios tienen clave distinta', () => {
    const claves = ['igual', 'distinto', 'anadido', 'quitado'].map(claveDelCambio);
    assert.equal(new Set(claves).size, 4);
    assert.equal(claveDelCambio('otro'), 'politicasAdmin.cambio.desconocido');
  });

  it('todas las claves de este módulo cuelgan de `politicasAdmin.`', () => {
    const todas = [
      claveDelEstadoDePolitica('draft'),
      claveDelTipoDePolitica('review_window'),
      claveDelCambio('igual'),
      claveDelFallo('red'),
      claveDelCuerpoDelFallo('red'),
      claveDeLaPestana('sinPolitica'),
      claveDelParametro('refund_bps') ?? '',
    ];
    for (const clave of todas) {
      assert.ok(clave.startsWith('politicasAdmin.'), clave);
    }
  });
});

describe('desde aquí no se toca ninguna política, y está escrito', () => {
  const repositorio = sinComentarios(
    fuente('repositories', 'EventPolicyAdminRepository.ts'),
  );
  const pantalla = sinComentarios(fuente('screens', 'SupervisionDePoliticasScreen.tsx'));

  it('el repositorio no manda ni un método que escriba', () => {
    // EL FALLO QUE ESTO CIERRA: una ruta de escritura inventada. El servidor no
    // publica ninguna bajo `/admin/events/policies`, y no es un olvido.
    assert.ok(!/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(repositorio));
    assert.ok(!/\bbody:\s/.test(repositorio));
  });

  it('el repositorio solo llama a las tres rutas que existen', () => {
    assert.ok(repositorio.includes('/admin/events/policies/overview'));
    assert.ok(repositorio.includes('/admin/events/policies/missing'));
    assert.ok(repositorio.includes('/admin/events/policies/${policyId}'));
  });

  it('ni el repositorio ni la pantalla inventan aprobar, editar o borrar', () => {
    const prohibido = /aprobar|rechazar|suspender|editar|eliminar|descartar|publicarPolitica/i;
    assert.ok(!prohibido.test(repositorio), 'el repositorio ofrece algo que no existe');
    assert.ok(!prohibido.test(pantalla), 'la pantalla ofrece algo que no existe');
  });

  it('la pantalla solo usa los tres métodos de lectura', () => {
    const usos = [...pantalla.matchAll(/EventPolicyAdminRepository\.(\w+)/g)].map(
      (uso) => uso[1],
    );
    assert.ok(usos.length > 0);
    for (const uso of usos) {
      assert.ok(
        ['supervisar', 'sinPolitica', 'detalle'].includes(uso ?? ''),
        `la pantalla llama a ${uso}`,
      );
    }
  });

  it('la pantalla enseña la huella y deja abrir el evento sin política', () => {
    assert.ok(pantalla.includes('huellaAbreviada'));
    assert.ok(pantalla.includes('/eventos/${evento.event_id}'));
  });

  it('la pantalla cuenta el 403 y el 503 con mensajes propios', () => {
    assert.ok(pantalla.includes('falloDesde'));
    assert.ok(pantalla.includes('sinPermiso'));
    assert.ok(pantalla.includes('noDisponible'));
  });

  it('la pantalla distingue la lista vacía del fallo', () => {
    assert.ok(pantalla.includes('estadoDeLaLista'));
    assert.ok(pantalla.includes('politicasAdmin.sinPoliticaVacia'));
  });

  it('ningún texto de la pantalla está escrito en duro', () => {
    // Las cadenas que se pintan salen de `f('politicasAdmin.…')`.
    const claves = [...pantalla.matchAll(/f\('([^']+)'/g)].map((uso) => uso[1] ?? '');
    assert.ok(claves.length > 20);
    for (const clave of claves) {
      assert.ok(clave.startsWith('politicasAdmin.'), clave);
    }
  });
});
