/**
 * Las reglas de las reseñas de evento, ejecutadas.
 *
 * Las que más importan son cuatro, y las cuatro se pueden romper sin que se
 * note mirando la aplicación:
 *
 *  1. `null` convertido en cero. Un evento sin reseñas enseñado como «0,0» con
 *     cinco estrellas vacías dice que está mal valorado; lo cierto es que
 *     todavía no lo ha valorado nadie. Igual con `recomiendan_bps` —«0 %» donde
 *     nadie contestó— y con cada eje por separado.
 *  2. El sello inventado. «Asistencia verificada» lo afirma el servidor en
 *     `asistencia_verificada`; deducirlo del hecho de que la reseña exista es
 *     ponerle un sello a un dato que no se ha comprobado.
 *  3. La puntuación general calculada como media de los ejes. Son dos preguntas
 *     distintas, y promediarlas exigiría decidir cuánto pesa cada eje, que no
 *     lo ha decidido nadie.
 *  4. Botones que la pantalla se inventa. Quién puede escribir lo dice
 *     `can-review`, y responder en público lo habilita una política publicada.
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
  anchoDeBarra,
  asistenciaVerificada,
  claveDeErrorDeResena,
  claveDelEje,
  claveDelMotivoParaResenar,
  comentarioParaEnviar,
  cuerpoDeResena,
  cursorDeLaPagina,
  ejesDelResumen,
  ejesParaEnviar,
  elServidorDiceQueOrganiza,
  esResenasApagadas,
  esRespuestaApagada,
  estaEscondida,
  fusionarPaginas,
  hayMasPaginas,
  hayValoraciones,
  histogramaOrdenado,
  largoDelComentario,
  motivoDelRechazo,
  motivoParaNoEnviar,
  motivoParaNoResenar,
  porcentajeLegible,
  porcentajeQueRecomienda,
  promedioLegible,
  proporcionDeBarra,
  puedeEscribir,
  puedeOfrecerResponder,
  puntuacionValida,
  respuestaParaEnviar,
  tieneRespuesta,
  valorDelEje,
  type ResumenDeResenas,
} from './resenasDeEventos.ts';

const AQUI = fileURLToPath(new URL('.', import.meta.url));
const PANTALLAS = join(AQUI, '..', 'screens');
const REPOSITORIOS = join(AQUI, '..', 'repositories');

function fuente(carpeta: string, nombre: string): string {
  return readFileSync(join(carpeta, nombre), 'utf8');
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

/** Un resumen como el que manda el servidor, con lo que haga falta encima. */
function resumen(parcial: Partial<ResumenDeResenas> = {}): ResumenDeResenas {
  return {
    total: 0,
    promedio: null,
    histograma: {},
    recomiendan_bps: null,
    por_eje: { content: null, organization: null, venue: null, safety: null, value: null },
    ...parcial,
  };
}

describe('`null` no es cero: el evento que nadie ha valorado', () => {
  it('sin reseñas no se escribe ninguna puntuación', () => {
    // El fallo que esto cierra: «0.0» y cinco estrellas vacías debajo del
    // título de un evento al que nadie ha ido todavía a opinar.
    assert.equal(promedioLegible(resumen()), null);
    assert.equal(promedioLegible(null), null);
    assert.equal(promedioLegible(undefined), null);
  });

  it('un promedio que llegue con total cero tampoco se pinta', () => {
    // Defensa contra un servidor que mande media sin reseñas: una media sobre
    // cero opiniones no es una media.
    assert.equal(promedioLegible(resumen({ total: 0, promedio: 4.5 })), null);
  });

  it('un promedio que no es un número no se convierte en cero', () => {
    assert.equal(promedioLegible(resumen({ total: 3, promedio: Number.NaN })), null);
    assert.equal(
      promedioLegible(resumen({ total: 3, promedio: Number.POSITIVE_INFINITY })),
      null,
    );
  });

  it('con reseñas se escribe con UN decimal', () => {
    assert.equal(promedioLegible(resumen({ total: 4, promedio: 4 })), '4.0');
    assert.equal(promedioLegible(resumen({ total: 4, promedio: 4.5 })), '4.5');
    assert.equal(promedioLegible(resumen({ total: 9, promedio: 3.333 })), '3.3');
  });

  it('«hay valoraciones» lo decide el total, no que venga un número', () => {
    assert.equal(hayValoraciones(resumen()), false);
    assert.equal(hayValoraciones(resumen({ total: 0, promedio: 5 })), false);
    assert.equal(hayValoraciones(resumen({ total: 1, promedio: 5 })), true);
    assert.equal(hayValoraciones(null), false);
  });
});

describe('`null` no es cero: la pregunta que nadie contestó', () => {
  it('sin respuestas no hay porcentaje que enseñar', () => {
    // El fallo que esto cierra: «0 % lo recomienda» donde lo cierto es que
    // nadie contestó a esa pregunta.
    assert.equal(porcentajeQueRecomienda(null), null);
    assert.equal(porcentajeQueRecomienda(undefined), null);
    assert.equal(porcentajeLegible(null), null);
  });

  it('cero SÍ se escribe: es una respuesta dada, no una ausencia', () => {
    assert.equal(porcentajeQueRecomienda(0), 0);
    assert.equal(porcentajeLegible(0), '0%');
  });

  it('cero y «nadie contestó» no son el mismo valor', () => {
    assert.notEqual(porcentajeQueRecomienda(0), porcentajeQueRecomienda(null));
  });

  it('los puntos básicos se convierten a porcentaje entero', () => {
    assert.equal(porcentajeLegible(10000), '100%');
    assert.equal(porcentajeLegible(5000), '50%');
    assert.equal(porcentajeLegible(8750), '88%');
  });

  it('un valor fuera de rango no desborda el porcentaje', () => {
    assert.equal(porcentajeQueRecomienda(-500), 0);
    assert.equal(porcentajeQueRecomienda(99999), 100);
    assert.equal(porcentajeQueRecomienda(Number.NaN), null);
  });
});

describe('`null` no es cero: el eje que nadie puntuó', () => {
  it('un eje sin nota devuelve `null`, no 0', () => {
    assert.equal(valorDelEje(resumen({ total: 5 }), 'content'), null);
    assert.equal(valorDelEje(resumen({ total: 5 }), 'safety'), null);
  });

  it('un eje con nota la devuelve tal cual', () => {
    const r = resumen({ total: 5, por_eje: { content: 4.2, venue: null } });
    assert.equal(valorDelEje(r, 'content'), 4.2);
    assert.equal(valorDelEje(r, 'venue'), null);
  });

  it('sin reseñas ningún eje tiene nota, venga lo que venga', () => {
    assert.equal(valorDelEje(resumen({ total: 0, por_eje: { content: 5 } }), 'content'), null);
  });

  it('los cinco ejes salen siempre, y los vacíos salen vacíos', () => {
    const filas = ejesDelResumen(resumen({ total: 2, por_eje: { content: 3.5 } }));
    assert.deepEqual(
      filas.map((f) => f.eje),
      [...EJES],
    );
    assert.equal(filas[0].texto, '3.5');
    assert.equal(filas[1].texto, null);
    assert.equal(filas[1].valor, null);
  });

  it('un eje desconocido no se cuela con un texto inventado', () => {
    assert.equal(claveDelEje('precio_del_parking'), 'resenas.eje.desconocido');
    assert.equal(claveDelEje('venue'), 'resenas.eje.venue');
  });
});

describe('el histograma', () => {
  it('sin reseñas no se pintan cinco barras a cero', () => {
    assert.deepEqual(histogramaOrdenado(resumen()), []);
    assert.deepEqual(histogramaOrdenado(null), []);
  });

  it('sale de la mejor nota a la peor', () => {
    const filas = histogramaOrdenado(
      resumen({ total: 4, histograma: { '5': 3, '3': 1 } }),
    );
    assert.deepEqual(
      filas.map((f) => f.puntuacion),
      [...PUNTUACIONES],
    );
  });

  it('un cajón que el servidor no manda vale cero: nadie puso esa nota', () => {
    const filas = histogramaOrdenado(
      resumen({ total: 4, histograma: { '5': 3, '3': 1 } }),
    );
    assert.equal(filas[0].cuantas, 3);
    assert.equal(filas[1].cuantas, 0);
    assert.equal(filas[2].cuantas, 1);
  });

  it('la barra ocupa lo que le toca, y sin total no ocupa nada', () => {
    assert.equal(proporcionDeBarra(3, 4), 0.75);
    assert.equal(proporcionDeBarra(0, 4), 0);
    assert.equal(proporcionDeBarra(4, 0), 0);
    assert.equal(anchoDeBarra(3, 4), '75%');
    assert.equal(anchoDeBarra(0, 0), '0%');
  });
});

describe('el sello no se decide en el cliente', () => {
  it('«asistencia verificada» solo cuando el servidor lo afirma', () => {
    assert.equal(asistenciaVerificada({ id: 'a', created_at: 'x', asistencia_verificada: true }), true);
  });

  it('un campo ausente NO es un sello', () => {
    // El fallo que esto cierra: dar por verificada toda reseña que exista, que
    // es exactamente deducir en el móvil lo que comprueba el servidor.
    assert.equal(asistenciaVerificada({ id: 'a', created_at: 'x' }), false);
    assert.equal(asistenciaVerificada(null), false);
    assert.equal(asistenciaVerificada(undefined), false);
  });

  it('un valor que no es `true` tampoco lo es', () => {
    assert.equal(
      asistenciaVerificada({
        id: 'a',
        created_at: 'x',
        asistencia_verificada: 'sí' as unknown as boolean,
      }),
      false,
    );
  });

  it('la moderación se reconoce por el estado, y solo viaja en la propia', () => {
    assert.equal(estaEscondida({ id: 'a', created_at: 'x', status: 'hidden' }), true);
    assert.equal(estaEscondida({ id: 'a', created_at: 'x', status: 'visible' }), false);
    assert.equal(estaEscondida({ id: 'a', created_at: 'x' }), false);
  });
});

describe('quién puede escribir lo dice `can-review`', () => {
  it('solo `puede: true` deja escribir', () => {
    assert.equal(puedeEscribir({ puede: true, motivo: 'ok' }), true);
    assert.equal(puedeEscribir({ puede: false, motivo: 'no_check_in' }), false);
    assert.equal(puedeEscribir(null), false);
    assert.equal(puedeEscribir(undefined), false);
  });

  it('la negativa se explica con SU motivo, traducido', () => {
    assert.equal(
      motivoParaNoResenar({ puede: false, motivo: 'no_check_in' }),
      'resenas.motivo.no_check_in',
    );
    assert.equal(
      motivoParaNoResenar({ puede: false, motivo: 'event_not_finished' }),
      'resenas.motivo.event_not_finished',
    );
  });

  it('cuando sí se puede no hay impedimento que enseñar', () => {
    assert.equal(motivoParaNoResenar({ puede: true, motivo: 'ok' }), null);
    assert.equal(motivoParaNoResenar(null), null);
  });

  it('un motivo que nadie ha visto no deja la pantalla muda', () => {
    assert.equal(
      motivoParaNoResenar({ puede: false, motivo: 'lo_que_sea' }),
      'resenas.motivo.desconocido',
    );
  });

  it('«sin política» NO se cuenta con la frase de una negativa', () => {
    // No es un «no puedes»: es que la empresa todavía no ha publicado las
    // reglas, y las dos cosas se dicen distinto.
    assert.notEqual(
      es['resenas.motivo.policy_not_configured'],
      es['resenas.motivo.desconocido'],
    );
    assert.notEqual(
      es['resenas.motivo.policy_not_configured'],
      es['resenas.motivo.no_check_in'],
    );
  });
});

describe('quién organiza lo dice el servidor', () => {
  it('`own_event` es la afirmación de que este evento es suyo', () => {
    assert.equal(elServidorDiceQueOrganiza({ puede: false, motivo: 'own_event' }), true);
  });

  it('ningún otro motivo convierte a nadie en organizador', () => {
    assert.equal(elServidorDiceQueOrganiza({ puede: false, motivo: 'no_check_in' }), false);
    assert.equal(elServidorDiceQueOrganiza({ puede: true, motivo: 'ok' }), false);
    assert.equal(elServidorDiceQueOrganiza(null), false);
  });

  it('la caja de responder pide organizar Y que no haya respuesta ya', () => {
    const sinRespuesta = { id: 'r1', created_at: 'x' };
    const conRespuesta = { id: 'r1', created_at: 'x', respuesta: { id: 'p1' } };
    assert.equal(puedeOfrecerResponder(sinRespuesta, true), true);
    assert.equal(puedeOfrecerResponder(conRespuesta, true), false);
    assert.equal(puedeOfrecerResponder(sinRespuesta, false), false);
    assert.equal(puedeOfrecerResponder(null, true), false);
  });

  it('una respuesta se reconoce por el objeto, no por el hueco', () => {
    assert.equal(tieneRespuesta({ id: 'r', created_at: 'x', respuesta: { id: 'p' } }), true);
    assert.equal(tieneRespuesta({ id: 'r', created_at: 'x', respuesta: null }), false);
    assert.equal(tieneRespuesta({ id: 'r', created_at: 'x' }), false);
  });
});

describe('el cuerpo que se manda', () => {
  it('sin puntuación general no se manda nada', () => {
    assert.equal(motivoParaNoEnviar({ overall: null }), 'resenas.eligePuntuacion');
    assert.equal(motivoParaNoEnviar({ overall: 0 }), 'resenas.eligePuntuacion');
    assert.equal(motivoParaNoEnviar({ overall: 6 }), 'resenas.eligePuntuacion');
    assert.equal(motivoParaNoEnviar({ overall: 3.5 }), 'resenas.eligePuntuacion');
  });

  it('con una puntuación válida no hay impedimento', () => {
    assert.equal(motivoParaNoEnviar({ overall: 3, comentario: 'bien' }), null);
  });

  it('un comentario más largo que el tope se avisa antes de mandarlo', () => {
    assert.equal(
      motivoParaNoEnviar({
        overall: 4,
        comentario: 'a'.repeat(LARGO_MAXIMO_DEL_COMENTARIO + 1),
      }),
      'resenas.comentarioLargo',
    );
  });

  it('el tope del comentario es el del contrato del backend', () => {
    assert.equal(LARGO_MAXIMO_DEL_COMENTARIO, 1000);
    assert.equal(LARGO_MAXIMO_DE_LA_RESPUESTA, 1000);
  });

  it('la puntuación general NO se calcula a partir de los ejes', () => {
    // Son dos preguntas distintas. Si se calculara, este cuerpo saldría con un
    // `overall` de 5 en vez del 2 que puso la persona.
    const cuerpo = cuerpoDeResena({
      overall: 2,
      ejes: { content: 5, organization: 5, venue: 5, safety: 5, value: 5 },
    });
    assert.equal(cuerpo.overall, 2);
  });

  it('un eje sin puntuar no viaja con un cero', () => {
    const cuerpo = cuerpoDeResena({
      overall: 4,
      ejes: { content: 4, venue: 0, safety: null, value: undefined },
    });
    assert.deepEqual(cuerpo.ejes, { content: 4 });
  });

  it('sin ningún eje puntuado el campo viaja vacío, no se omite', () => {
    // Al editar, el servidor solo toca los ejes cuando el campo llega: omitirlo
    // al quitar la última nota dejaría las cinco anteriores puestas.
    const cuerpo = cuerpoDeResena({ overall: 4, ejes: {} });
    assert.deepEqual(cuerpo.ejes, {});
    assert.equal(ejesParaEnviar({}), null);
    assert.equal(ejesParaEnviar(null), null);
  });

  it('«prefiero no contestar» viaja como `null`, no como un «no»', () => {
    assert.equal(cuerpoDeResena({ overall: 4 }).recommends, null);
    assert.equal(cuerpoDeResena({ overall: 4, recomienda: false }).recommends, false);
    assert.equal(cuerpoDeResena({ overall: 4, recomienda: true }).recommends, true);
  });

  it('el comentario viaja como cadena, para que se pueda BORRAR al editar', () => {
    // El servidor solo toca el comentario cuando el campo no es `None`: con
    // `null` se quedaría el de antes, y quien lo borra lo vería seguir ahí.
    assert.equal(comentarioParaEnviar(''), '');
    assert.equal(comentarioParaEnviar('   '), '');
    assert.equal(comentarioParaEnviar(null), '');
    assert.equal(comentarioParaEnviar('  hola  '), 'hola');
  });

  it('un comentario larguísimo se recorta al tope del servidor', () => {
    const largo = 'a'.repeat(LARGO_MAXIMO_DEL_COMENTARIO + 200);
    assert.equal(comentarioParaEnviar(largo).length, LARGO_MAXIMO_DEL_COMENTARIO);
  });

  it('el contador cuenta lo escrito, sin limpiar ni recortar', () => {
    assert.equal(largoDelComentario('  hola  '), 8);
    assert.equal(largoDelComentario(null), 0);
  });

  it('un borrador inválido no se convierte en cuerpo', () => {
    assert.throws(() => cuerpoDeResena({ overall: null }));
    assert.throws(() => cuerpoDeResena({ overall: 7 }));
  });

  it('la puntuación válida es un entero del 1 al 5', () => {
    for (const n of ESTRELLAS) assert.equal(puntuacionValida(n), true, String(n));
    for (const n of [0, 6, -1, 2.5, Number.NaN]) {
      assert.equal(puntuacionValida(n), false, String(n));
    }
    assert.equal(puntuacionValida('4'), false);
  });
});

describe('la respuesta del organizador', () => {
  it('una caja vacía no es una respuesta', () => {
    // El servidor pide `min_length=1`: mandarla sería recoger un 422 sobre algo
    // que se podía ver antes de salir del teléfono.
    assert.equal(respuestaParaEnviar(''), null);
    assert.equal(respuestaParaEnviar('   \n '), null);
    assert.equal(respuestaParaEnviar(null), null);
  });

  it('lo escrito viaja limpio y recortado al tope', () => {
    assert.equal(respuestaParaEnviar('  gracias  '), 'gracias');
    assert.equal(
      respuestaParaEnviar('b'.repeat(LARGO_MAXIMO_DE_LA_RESPUESTA + 50))?.length,
      LARGO_MAXIMO_DE_LA_RESPUESTA,
    );
  });

  it('«todavía no está habilitado» tiene su propio código y su propio texto', () => {
    assert.equal(esRespuestaApagada('event_reply_not_configured'), true);
    assert.equal(esRespuestaApagada('event_reply_already_exists'), false);
    assert.equal(esRespuestaApagada(null), false);
    assert.notEqual(
      es['resenas.error.respuestaNoConfigurada'],
      es['resenas.error.sinPermiso'],
    );
  });
});

describe('la paginación por cursor', () => {
  const fila = (id: string) => ({ id, created_at: '2026-09-01T10:00:00Z' });

  it('una página corta significa que se acabó', () => {
    assert.equal(cursorDeLaPagina([fila('a'), fila('b')], 20), null);
    assert.equal(cursorDeLaPagina([], 20), null);
  });

  it('una página llena deja cursor para seguir', () => {
    const pagina = [fila('a'), fila('b')];
    assert.equal(cursorDeLaPagina(pagina, 2), '2026-09-01T10:00:00+00:00|b');
  });

  it('la «Z» se escribe «+00:00»: es el mismo instante y el servidor lo parsea', () => {
    // `datetime.fromisoformat` no aceptó la «Z» hasta Python 3.11, y un cursor
    // que no parsea se contesta con un 400 en mitad de la lista.
    const cursor = cursorDeLaPagina([{ id: 'z', created_at: '2026-09-01T10:00:00Z' }], 1);
    assert.equal(cursor?.includes('Z|'), false);
    assert.ok(cursor?.startsWith('2026-09-01T10:00:00+00:00|'));
  });

  it('sin identificador no se construye un cursor a medias', () => {
    assert.equal(cursorDeLaPagina([{ id: '', created_at: '2026-09-01T10:00:00Z' }], 1), null);
    assert.equal(cursorDeLaPagina([{ id: 'a', created_at: '' }], 1), null);
  });

  it('el tamaño de página es el que se pide por defecto', () => {
    assert.equal(POR_PAGINA, 20);
    assert.equal(hayMasPaginas(20, 20), true);
    assert.equal(hayMasPaginas(19, 20), false);
  });

  it('unir páginas no repite lo que ya estaba', () => {
    const previas = [{ id: 'a' }, { id: 'b' }];
    assert.deepEqual(fusionarPaginas(previas, [{ id: 'b' }, { id: 'c' }]), [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ]);
  });
});

describe('los códigos del servidor se traducen, no se pintan crudos', () => {
  it('las reseñas apagadas se reconocen por su código', () => {
    assert.equal(esResenasApagadas('event_reviews_not_available'), true);
    assert.equal(esResenasApagadas('event_review_not_found'), false);
    assert.equal(esResenasApagadas(null), false);
  });

  it('los errores conocidos tienen clave propia', () => {
    assert.equal(
      claveDeErrorDeResena('event_review_already_exists'),
      'resenas.error.yaExiste',
    );
    assert.equal(
      claveDeErrorDeResena('event_reply_not_configured'),
      'resenas.error.respuestaNoConfigurada',
    );
    assert.equal(
      claveDeErrorDeResena('event_review_cursor_invalid'),
      'resenas.error.cursorInvalido',
    );
  });

  it('un 403 y un 429 no invitan a reintentar con la frase de un fallo', () => {
    assert.equal(claveDeErrorDeResena('forbidden'), 'resenas.error.sinPermiso');
    assert.equal(
      claveDeErrorDeResena('rate_limited'),
      'errorDeEntradas.demasiadosIntentos',
    );
  });

  it('un código desconocido devuelve `null` para usar el texto del servidor', () => {
    assert.equal(claveDeErrorDeResena('algo_que_nadie_ha_visto'), null);
    assert.equal(claveDeErrorDeResena(undefined), null);
  });

  it('el rechazo se explica con el motivo que trae dentro', () => {
    // Sin mirar `details.reason`, quien no hizo check-in y quien llega tarde
    // leen exactamente la misma frase.
    assert.equal(
      motivoDelRechazo({ reason: 'no_check_in' }),
      'resenas.motivo.no_check_in',
    );
    assert.equal(motivoDelRechazo({ reason: 'raro' }), 'resenas.motivo.desconocido');
    assert.equal(motivoDelRechazo({}), null);
    assert.equal(motivoDelRechazo(null), null);
    assert.equal(motivoDelRechazo('no_check_in'), null);
  });
});

describe('cada valor del servidor tiene su texto en los tres idiomas', () => {
  const familias: Array<[readonly string[], (v: string) => string]> = [
    [MOTIVOS_PARA_RESENAR, claveDelMotivoParaResenar],
    [EJES, claveDelEje],
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

    it(`${idioma} tiene el texto de todos los errores traducibles`, () => {
      const codigos = [
        'event_reviews_not_available',
        'event_review_not_allowed',
        'event_review_already_exists',
        'event_review_not_found',
        'event_review_changed',
        'event_review_cursor_invalid',
        'event_reply_not_configured',
        'event_reply_already_exists',
        'forbidden',
        'rate_limited',
      ];
      const faltan = codigos
        .map((codigo) => claveDeErrorDeResena(codigo))
        .filter((clave): clave is string => clave !== null && !(clave in diccionario));
      assert.deepEqual(faltan, [], `sin texto en ${idioma}: ${faltan.join(', ')}`);
    });
  }

  it('los tres diccionarios tienen EXACTAMENTE las mismas claves `resenas.`', () => {
    const claves = (d: Record<string, string>) =>
      Object.keys(d).filter((k) => k.startsWith('resenas.')).sort();
    const referencia = claves(es as unknown as Record<string, string>);
    assert.ok(referencia.length > 0, 'no se añadió ninguna clave');
    assert.deepEqual(claves(en as unknown as Record<string, string>), referencia);
    assert.deepEqual(claves(pt as unknown as Record<string, string>), referencia);
  });
});

describe('lo que las pantallas tienen escrito', () => {
  const lista = fuente(PANTALLAS, 'ResenasDelEventoScreen.tsx');
  const formulario = fuente(PANTALLAS, 'ResenaDelEventoScreen.tsx');
  const repositorio = fuente(REPOSITORIOS, 'EventReviewRepository.ts');
  const todas = [
    ['ResenasDelEventoScreen', lista],
    ['ResenaDelEventoScreen', formulario],
  ] as const;

  it('el cerrojo contra el doble toque está antes del primer `await`', () => {
    for (const [nombre, codigo] of todas) {
      assert.ok(
        sinComentarios(codigo).includes('ocupadoRef.current'),
        `${nombre} publicaría dos veces con dos toques rápidos`,
      );
    }
  });

  it('ninguna pantalla trae datos de ejemplo ni habla con Supabase', () => {
    for (const [nombre, codigo] of todas) {
      const limpio = sinComentarios(codigo);
      assert.ok(!/mockData|datosDeEjemplo/i.test(limpio), nombre);
      assert.ok(!/supabase/i.test(limpio), nombre);
    }
  });

  it('las dos pantallas saben quedarse sin conexión y sin servicio', () => {
    for (const [nombre, codigo] of todas) {
      const limpio = sinComentarios(codigo);
      assert.ok(limpio.includes('esFalloDeRed'), `${nombre} no distingue el sin red`);
      assert.ok(
        limpio.includes('esResenasApagadas'),
        `${nombre} no distingue el 503 de las reseñas apagadas`,
      );
      assert.ok(limpio.includes('onRetry'), `${nombre} no ofrece reintentar`);
    }
  });

  it('Atrás siempre tiene un respaldo a una ruta que existe', () => {
    for (const [nombre, codigo] of todas) {
      const limpio = sinComentarios(codigo);
      assert.ok(limpio.includes('router.canGoBack()'), nombre);
      assert.ok(limpio.includes('router.replace('), nombre);
    }
  });

  it('la lista no pinta una puntuación que nadie ha puesto', () => {
    const limpio = sinComentarios(lista);
    assert.ok(limpio.includes('promedioLegible('), 'falta el formateo honesto');
    assert.ok(limpio.includes('hayValoraciones('), 'falta la comprobación del total');
    assert.ok(
      limpio.includes("t('resenas.sinValoraciones')"),
      'sin reseñas hay que decirlo, no pintar un cero',
    );
    assert.ok(!/['"]0\.0['"]/.test(limpio), 'hay un «0.0» escrito a mano');
  });

  it('la lista distingue «nadie contestó» de «nadie lo recomienda»', () => {
    const limpio = sinComentarios(lista);
    assert.ok(limpio.includes('porcentajeLegible('), 'falta la conversión honesta');
    assert.ok(
      limpio.includes("t('resenas.recomiendanSinDatos')"),
      'falta el texto para cuando nadie contestó',
    );
  });

  it('el sello sale del servidor y no hay ningún otro inventado', () => {
    const limpio = sinComentarios(lista);
    assert.ok(limpio.includes('asistenciaVerificada('), 'el sello no se comprueba');
    assert.ok(
      !/compra verificada|compraVerificada/i.test(limpio),
      'se ha colado un sello que este dominio no tiene',
    );
    assert.ok(
      !limpio.includes("'Asistencia verificada'"),
      'el texto del sello tiene que salir del diccionario',
    );
  });

  it('la caja de responder sale de lo que dice el servidor', () => {
    const limpio = sinComentarios(lista);
    assert.ok(limpio.includes('elServidorDiceQueOrganiza('), 'falta la comprobación');
    assert.ok(limpio.includes('puedeOfrecerResponder('), 'falta la comprobación');
    assert.ok(
      limpio.includes('esRespuestaApagada('),
      'sin esto, «todavía no está habilitado» se enseña como un error genérico',
    );
  });

  it('el formulario no ofrece escribir a quien el servidor no deja', () => {
    const limpio = sinComentarios(formulario);
    assert.ok(limpio.includes('puedeEscribir('), 'falta la comprobación de permiso');
    assert.ok(limpio.includes('motivoParaNoResenar('), 'falta el motivo traducido');
    assert.ok(limpio.includes('disabled'), 'el botón tiene que poder desactivarse');
  });

  it('el formulario dice que la general no es la media de los ejes', () => {
    const limpio = sinComentarios(formulario);
    assert.ok(limpio.includes("t('resenas.generalNoEsMedia')"), 'falta el aviso');
    assert.ok(limpio.includes('cuerpoDeResena('), 'el cuerpo tiene que salir de la librería');
  });

  it('la aplicación no puede moderar reseñas desde el repositorio', () => {
    // Esconder una opinión es de administración: un método aquí sería una
    // invitación a llamarlo desde una pantalla.
    const limpio = sinComentarios(repositorio);
    assert.ok(!limpio.includes('/moderate'), 'el repositorio expone moderación');
    assert.ok(!/\bmoderar\b/.test(limpio), 'hay un método de moderación');
  });

  it('todo el texto de las pantallas pasa por el diccionario', () => {
    for (const [nombre, codigo] of todas) {
      const limpio = sinComentarios(codigo);
      // Cada `resenas.` que se usa tiene que existir en los tres idiomas.
      const usadas = [...limpio.matchAll(/'(resenas\.[A-Za-z0-9_.]+)'/g)].map((m) => m[1]);
      assert.ok(usadas.length > 0, `${nombre} no usa ninguna clave`);
      for (const [idioma, diccionario] of DICCIONARIOS) {
        const faltan = usadas.filter((clave) => !(clave in diccionario));
        assert.deepEqual(faltan, [], `${nombre}: sin texto en ${idioma}: ${faltan.join(', ')}`);
      }
    }
  });
});
