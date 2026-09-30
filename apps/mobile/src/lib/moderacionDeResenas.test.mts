/**
 * Moderar una reseña, ejecutado.
 *
 * Lo que se prueba aquí es lo que se rompe sin que se note mirando la
 * aplicación:
 *
 *  1. Ocultar contado como borrar. Son dos cosas distintas y solo una existe;
 *     la otra es irreversible y nadie la ha decidido. Se comprueba que NINGUNA
 *     función de este módulo puede producir una acción de borrado, ni siquiera
 *     dándole basura, y que ni el repositorio ni la pantalla la nombran.
 *  2. Una reseña escondida sin motivo. El servidor acepta `reason: null` al
 *     esconder, así que si el cliente no lo exige nadie lo exige: se comprueba
 *     que ocultar sin motivo se rechaza AQUÍ, antes de llamar a nadie.
 *  3. El autor y la puntuación editados. Moderar no los toca; se comprueba que
 *     no hay ninguna función que los transforme ni ningún método que los mande.
 *  4. Un estado que no se conoce reventando la pantalla. La base admite también
 *     `draft` y mañana puede admitir otro: se recorre todo el módulo con
 *     estados inventados y nada lanza ni devuelve una acción.
 *
 * Las que no son funciones —el cerrojo, el botón apagado, la confirmación, la
 * recarga— se comprueban sobre el CÓDIGO de la pantalla, porque ahí es donde
 * están escritas.
 *
 * NO SE MIRAN LOS DICCIONARIOS. Las claves de esta pantalla se están escribiendo
 * en `es.ts`, `en.ts` y `pt.ts` en otro sitio: comprobarlas aquí haría fallar la
 * suite por un fichero que no es de este trabajo.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ACCIONES,
  ESTADOS_DE_RESENA,
  ESTADOS_QUE_SE_FILTRAN,
  LARGO_DEL_RESUMEN,
  LARGO_DE_LA_REFERENCIA,
  LARGO_MAXIMO_DEL_MOTIVO,
  LIMITES_DE_LA_LISTA,
  LIMITE_INICIAL,
  LIMITE_MAXIMO,
  PASOS_DE_MODERACION,
  abreviarIdentificador,
  accionDelPaso,
  accionQueOfrece,
  cadenaDeFiltros,
  claveDeAccion,
  claveDeErrorDeModeracion,
  claveDelCuerpoDelFallo,
  claveDelEstadoDeResena,
  claveDelFallo,
  claveDelPaso,
  contarPorEstado,
  esConflictoDeResena,
  esEstadoDeFiltroInvalido,
  esResenasApagadas,
  estadoConocido,
  falloDeCarga,
  filaTrasModerar,
  filtroDeEvento,
  limiteValido,
  llegoAlTope,
  motivoObligatorio,
  puntuacionLegible,
  puntuacionValida,
  resumenDelComentario,
  revisarMotivo,
  seReintenta,
  siguienteLimite,
  textoUtil,
  tonoDelEstado,
  valorDeHide,
} from './moderacionDeResenas.ts';

const AQUI = fileURLToPath(new URL('.', import.meta.url));

function fuente(...partes: string[]): string {
  // Sin `\r`: con `core.autocrlf` en Windows el fuente llega con CRLF.
  return readFileSync(join(AQUI, '..', ...partes), 'utf8').replace(/\r\n/g, '\n');
}

/** El código sin comentarios: lo que el fichero HACE, no lo que explica. */
function sinComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((linea) => !linea.trim().startsWith('//'))
    .join('\n');
}

const PANTALLA = fuente('screens', 'ModeracionDeResenasScreen.tsx');
const REPOSITORIO = fuente('repositories', 'EventReviewModerationRepository.ts');
const MODULO = fuente('lib', 'moderacionDeResenas.ts');

/** Las palabras con las que se promete algo irreversible. */
const PALABRAS_DE_BORRADO = [
  'borrar',
  'borrado',
  'eliminar',
  'eliminado',
  'delete',
  'destruir',
  'purgar',
  'remove',
];

/** Todo lo que el módulo exporta y se puede llamar, con entradas de todo tipo. */
const BASURA: unknown[] = [
  null,
  undefined,
  '',
  '   ',
  'visible',
  'hidden',
  'draft',
  'lo_que_sea',
  'DELETE',
  0,
  -1,
  3,
  999,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  true,
  {},
  [],
];

describe('ocultar no es borrar, y no hay forma de que lo parezca', () => {
  it('solo existen dos acciones, y ninguna borra', () => {
    assert.deepEqual([...ACCIONES], ['ocultar', 'restaurar']);
  });

  it('cada acción se traduce a `hide`, que es lo único que el servidor acepta', () => {
    assert.equal(valorDeHide('ocultar'), true);
    assert.equal(valorDeHide('restaurar'), false);
  });

  it('una acción que no se conoce no se convierte en `false` por descuido', () => {
    // Devolver `false` escondería lo contrario de lo que se pidió.
    assert.equal(valorDeHide('lo_que_sea'), null);
    assert.equal(valorDeHide(''), null);
    assert.equal(valorDeHide('borrar'), null);
  });

  it('ninguna función del módulo produce una acción de borrado', () => {
    const salidas: string[] = [];
    for (const fn of [
      claveDelEstadoDeResena,
      claveDeAccion,
      claveDelPaso,
      claveDelFallo,
      claveDelCuerpoDelFallo,
    ] as Array<(valor: string) => string>) {
      for (const entrada of BASURA) {
        salidas.push(fn(entrada as string));
      }
    }
    for (const entrada of BASURA) {
      const accion = accionQueOfrece(entrada as string);
      assert.ok(
        accion === null || accion === 'ocultar' || accion === 'restaurar',
        `acción inventada a partir de ${String(entrada)}`,
      );
      salidas.push(String(accion));
      salidas.push(String(claveDeErrorDeModeracion(entrada as string)));
    }
    for (const salida of salidas) {
      for (const palabra of PALABRAS_DE_BORRADO) {
        assert.ok(
          !salida.toLowerCase().includes(palabra),
          `«${salida}» promete un borrado`,
        );
      }
    }
  });

  it('el módulo no exporta nada que suene a borrar', () => {
    const exportadas = [...MODULO.matchAll(/export (?:function|const) (\w+)/g)].map(
      (m) => m[1].toLowerCase(),
    );
    assert.ok(exportadas.length > 20, 'el módulo debería exportar bastante');
    for (const nombre of exportadas) {
      for (const palabra of PALABRAS_DE_BORRADO) {
        assert.ok(!nombre.includes(palabra), `«${nombre}» suena a borrado`);
      }
    }
  });

  it('el repositorio no tiene ningún método de borrado', () => {
    const codigo = sinComentarios(REPOSITORIO).toLowerCase();
    for (const palabra of PALABRAS_DE_BORRADO) {
      assert.ok(!codigo.includes(palabra), `el repositorio nombra «${palabra}»`);
    }
    assert.ok(!/method:\s*'DELETE'/i.test(REPOSITORIO));
  });

  it('el repositorio solo llama a las tres rutas del contrato', () => {
    const rutas = [...REPOSITORIO.matchAll(/\$\{API_V1\}(\/[^`?]*)/g)].map((m) => m[1]);
    assert.deepEqual(new Set(rutas), new Set([
      '/admin/events/reviews',
      '/admin/events/reviews/${reviewId}/moderation',
      '/events/reviews/${reviewId}/moderate',
    ]));
  });

  it('la pantalla no nombra ningún borrado', () => {
    const codigo = sinComentarios(PANTALLA).toLowerCase();
    for (const palabra of PALABRAS_DE_BORRADO) {
      assert.ok(!codigo.includes(palabra), `la pantalla nombra «${palabra}»`);
    }
  });

  it('la pantalla dice, en su propio texto, que ocultar no borra', () => {
    assert.ok(PANTALLA.includes('moderacionResenas.ocultarNoBorraTitulo'));
    assert.ok(PANTALLA.includes('moderacionResenas.ocultarNoBorraCuerpo'));
    // Y también dentro de la confirmación, que es donde se decide.
    assert.ok(PANTALLA.includes('moderacionResenas.confirmarOcultarCuerpo'));
  });
});

describe('el autor y la puntuación se leen, y nada más', () => {
  it('el repositorio no manda ni la nota ni el autor', () => {
    const cuerpos = [...REPOSITORIO.matchAll(/JSON\.stringify\(([^)]*)\)/g)].map(
      (m) => m[1],
    );
    assert.equal(cuerpos.length, 2, 'solo ocultar y restaurar mandan cuerpo');
    for (const cuerpo of cuerpos) {
      assert.ok(cuerpo.includes('hide'));
      assert.ok(cuerpo.includes('reason'));
      assert.ok(!cuerpo.includes('overall'));
      assert.ok(!cuerpo.includes('author'));
      assert.ok(!cuerpo.includes('comment'));
    }
  });

  it('la pantalla no tiene ningún campo editable de la reseña', () => {
    const codigo = sinComentarios(PANTALLA);
    const campos = [...codigo.matchAll(/onChangeText=\{([\s\S]*?)\}\n/g)];
    assert.ok(campos.length >= 2, 'debería haber campos de filtro y de motivo');
    for (const campo of campos) {
      const texto = campo[1];
      assert.ok(!texto.includes('overall'), 'la nota no se escribe');
      assert.ok(!texto.includes('comment'), 'el comentario no se escribe');
      assert.ok(!texto.includes('author'), 'el autor no se escribe');
    }
    // Lo único que se escribe: el filtro de evento y el motivo de la acción.
    assert.ok(codigo.includes('setMotivo('));
    assert.ok(codigo.includes('setEventoEscrito'));
  });

  it('la puntuación se formatea, no se transforma en algo que mandar', () => {
    assert.equal(puntuacionLegible(1), '1/5');
    assert.equal(puntuacionLegible(5), '5/5');
    assert.equal(puntuacionLegible(4), '4/5');
  });

  it('lo que no es una nota válida no se dibuja como si lo fuera', () => {
    assert.equal(puntuacionLegible(0), null);
    assert.equal(puntuacionLegible(6), null);
    assert.equal(puntuacionLegible(-2), null);
    assert.equal(puntuacionLegible(3.5), null);
    assert.equal(puntuacionLegible('4'), null);
    assert.equal(puntuacionLegible(null), null);
    assert.equal(puntuacionLegible(undefined), null);
    assert.equal(puntuacionLegible(Number.NaN), null);
  });

  it('`puntuacionValida` es exactamente el 1 al 5 del servidor', () => {
    for (const nota of [1, 2, 3, 4, 5]) assert.equal(puntuacionValida(nota), true);
    for (const nota of [0, 6, -1, 1.5, '3', null, undefined, {}]) {
      assert.equal(puntuacionValida(nota), false, String(nota));
    }
  });
});

describe('el motivo es obligatorio para ocultar, y se comprueba en el cliente', () => {
  it('ocultar sin motivo se rechaza AQUÍ, sin llamar a nadie', () => {
    assert.deepEqual(revisarMotivo('ocultar', ''), { estado: 'falta' });
    assert.deepEqual(revisarMotivo('ocultar', null), { estado: 'falta' });
    assert.deepEqual(revisarMotivo('ocultar', undefined), { estado: 'falta' });
  });

  it('un motivo de solo espacios tampoco es un motivo', () => {
    assert.deepEqual(revisarMotivo('ocultar', '    \n\t  '), { estado: 'falta' });
  });

  it('ocultar con motivo pasa, y el texto viaja recortado de los bordes', () => {
    assert.deepEqual(revisarMotivo('ocultar', '  insultos directos  '), {
      estado: 'listo',
      motivo: 'insultos directos',
    });
  });

  it('restaurar sin motivo es legítimo: devuelve algo, no lo quita', () => {
    assert.deepEqual(revisarMotivo('restaurar', ''), { estado: 'listo', motivo: null });
    assert.deepEqual(revisarMotivo('restaurar', '   '), {
      estado: 'listo',
      motivo: null,
    });
  });

  it('restaurar con motivo lo manda', () => {
    assert.deepEqual(revisarMotivo('restaurar', 'se revisó y no incumplía'), {
      estado: 'listo',
      motivo: 'se revisó y no incumplía',
    });
  });

  it('el tope del servidor se mira antes de mandar, no después del 422', () => {
    const largo = 'a'.repeat(LARGO_MAXIMO_DEL_MOTIVO + 1);
    assert.deepEqual(revisarMotivo('ocultar', largo), {
      estado: 'largo',
      maximo: LARGO_MAXIMO_DEL_MOTIVO,
    });
  });

  it('justo en el tope sí pasa', () => {
    const justo = 'a'.repeat(LARGO_MAXIMO_DEL_MOTIVO);
    assert.deepEqual(revisarMotivo('ocultar', justo), {
      estado: 'listo',
      motivo: justo,
    });
  });

  it('el tope es el del contrato (`max_length=500`)', () => {
    assert.equal(LARGO_MAXIMO_DEL_MOTIVO, 500);
  });

  it('solo ocultar exige motivo', () => {
    assert.equal(motivoObligatorio('ocultar'), true);
    assert.equal(motivoObligatorio('restaurar'), false);
    assert.equal(motivoObligatorio('lo_que_sea'), false);
    assert.equal(motivoObligatorio(''), false);
  });

  it('una acción desconocida no convierte el motivo en obligatorio ni lo inventa', () => {
    assert.deepEqual(revisarMotivo('lo_que_sea', ''), { estado: 'listo', motivo: null });
  });

  it('`textoUtil` recorta al tope y devuelve `null` cuando no hay nada', () => {
    assert.equal(textoUtil('  '), null);
    assert.equal(textoUtil(null), null);
    assert.equal(textoUtil('  hola  '), 'hola');
    assert.equal(textoUtil('a'.repeat(600))?.length, 500);
    assert.equal(textoUtil('hola', 2), 'ho');
    assert.equal(textoUtil('hola', 0), '');
  });

  it('la pantalla comprueba el motivo ANTES de llamar al repositorio', () => {
    const codigo = sinComentarios(PANTALLA);
    const revisa = codigo.indexOf('revisarMotivo(');
    const llama = codigo.indexOf('EventReviewModerationRepository.ocultar');
    assert.ok(revisa > 0, 'la pantalla no revisa el motivo');
    assert.ok(llama > revisa, 'llama antes de revisar');
    // Y se sale sin mandar nada cuando falta.
    assert.ok(/estado === 'falta'[\s\S]{0,200}return;/.test(codigo));
  });

  it('la pantalla pide el motivo antes de confirmar, no después', () => {
    const codigo = sinComentarios(PANTALLA);
    const revisa = codigo.indexOf('revisarMotivo(');
    const confirma = codigo.indexOf('await confirm(');
    assert.ok(confirma > revisa, 'confirma antes de tener el motivo');
  });
});

describe('cada estado ofrece lo suyo, y lo que no se conoce no ofrece nada', () => {
  it('lo visible se puede ocultar', () => {
    assert.equal(accionQueOfrece('visible'), 'ocultar');
  });

  it('lo oculto se puede volver a mostrar', () => {
    assert.equal(accionQueOfrece('hidden'), 'restaurar');
  });

  it('un borrador no se modera: no está publicado', () => {
    assert.equal(accionQueOfrece('draft'), null);
  });

  it('un estado desconocido no ofrece ninguna acción inventada', () => {
    assert.equal(accionQueOfrece('lo_que_sea'), null);
    assert.equal(accionQueOfrece(''), null);
    assert.equal(accionQueOfrece(null), null);
    assert.equal(accionQueOfrece(undefined), null);
  });

  it('la pantalla dice por qué no hay botón en vez de dejar la fila muda', () => {
    assert.ok(PANTALLA.includes('moderacionResenas.sinAccion'));
  });

  it('el texto del botón sale de la acción, y lo raro cae en «desconocida»', () => {
    assert.equal(claveDeAccion('ocultar'), 'moderacionResenas.accion.ocultar');
    assert.equal(claveDeAccion('restaurar'), 'moderacionResenas.accion.restaurar');
    assert.equal(claveDeAccion('lo_que_sea'), 'moderacionResenas.accion.desconocido');
  });
});

describe('los estados se leen, incluidos los que no se conocen', () => {
  it('los tres del servidor tienen su clave', () => {
    assert.equal(claveDelEstadoDeResena('visible'), 'moderacionResenas.estado.visible');
    assert.equal(claveDelEstadoDeResena('hidden'), 'moderacionResenas.estado.hidden');
    assert.equal(claveDelEstadoDeResena('draft'), 'moderacionResenas.estado.draft');
  });

  it('uno inventado no revienta: cae en «desconocido»', () => {
    assert.equal(
      claveDelEstadoDeResena('lo_que_sea'),
      'moderacionResenas.estado.desconocido',
    );
    assert.equal(claveDelEstadoDeResena(''), 'moderacionResenas.estado.desconocido');
  });

  it('se filtra por lo que se lee y por lo que está escondido', () => {
    // SIN LAS OCULTAS RESTAURAR SERÍA IMPOSIBLE.
    assert.deepEqual([...ESTADOS_QUE_SE_FILTRAN], ['visible', 'hidden']);
    assert.ok(ESTADOS_DE_RESENA.includes('hidden'));
  });

  it('`estadoConocido` no se deja engañar', () => {
    assert.equal(estadoConocido('visible'), true);
    assert.equal(estadoConocido('draft'), true);
    assert.equal(estadoConocido('lo_que_sea'), false);
    assert.equal(estadoConocido(null), false);
    assert.equal(estadoConocido(undefined), false);
  });

  it('escondida se pinta aparte, y lo desconocido en neutro', () => {
    assert.equal(tonoDelEstado('visible'), 'visible');
    assert.equal(tonoDelEstado('hidden'), 'oculto');
    assert.equal(tonoDelEstado('draft'), 'neutro');
    assert.equal(tonoDelEstado('lo_que_sea'), 'neutro');
  });

  it('se cuentan las dos cosas por separado, y lo demás aparte', () => {
    assert.deepEqual(
      contarPorEstado([
        { status: 'visible' },
        { status: 'visible' },
        { status: 'hidden' },
        { status: 'draft' },
        { status: null },
        {},
      ]),
      { visibles: 2, ocultas: 1, otras: 3 },
    );
  });

  it('una lista vacía cuenta cero, no revienta', () => {
    assert.deepEqual(contarPorEstado([]), { visibles: 0, ocultas: 0, otras: 0 });
  });
});

describe('el historial se lee y nunca se edita', () => {
  it('los pasos del contrato tienen su clave', () => {
    assert.equal(claveDelPaso('hidden'), 'moderacionResenas.paso.hidden');
    assert.equal(claveDelPaso('visible'), 'moderacionResenas.paso.visible');
    assert.deepEqual([...PASOS_DE_MODERACION], ['visible', 'hidden']);
  });

  it('un paso que no se conoce se dice desconocido', () => {
    assert.equal(claveDelPaso('lo_que_sea'), 'moderacionResenas.paso.desconocido');
    assert.equal(claveDelPaso(''), 'moderacionResenas.paso.desconocido');
  });

  it('el repositorio solo LEE el historial', () => {
    const codigo = sinComentarios(REPOSITORIO);
    const trozo = codigo.slice(codigo.indexOf('async historial('));
    const cuerpo = trozo.slice(0, trozo.indexOf('},'));
    assert.ok(!cuerpo.includes('method'), 'el historial se pide con un GET');
    assert.ok(!cuerpo.includes('body'));
  });

  it('la pantalla enseña el motivo y la fecha de cada paso', () => {
    assert.ok(PANTALLA.includes('moderacionResenas.pasoMotivo'));
    assert.ok(PANTALLA.includes('moderacionResenas.pasoSinMotivo'));
  });

  it('la acción de un paso se lee de su DESTINO, no de un verbo aparte', () => {
    // El contrato no manda ningún `action`: manda dónde quedó la reseña.
    assert.equal(accionDelPaso('hidden'), 'ocultar');
    assert.equal(accionDelPaso('visible'), 'restaurar');
    assert.ok(!PANTALLA.includes('paso.action'));
    assert.ok(PANTALLA.includes('claveDelPaso(paso.to_status)'));
  });

  it('un destino que no se entiende no inventa una acción', () => {
    assert.equal(accionDelPaso('draft'), null);
    assert.equal(accionDelPaso('lo_que_sea'), null);
    assert.equal(accionDelPaso(''), null);
    assert.equal(accionDelPaso(null), null);
    assert.equal(accionDelPaso(undefined), null);
  });

  it('leer el destino dice lo mismo que ofrecer la acción, al revés', () => {
    // `accionQueOfrece('visible')` es «se puede ocultar»; `accionDelPaso('hidden')`
    // es «se ocultó». Si una se relaja, la otra la delata.
    assert.equal(accionDelPaso('hidden'), accionQueOfrece('visible'));
    assert.equal(accionDelPaso('visible'), accionQueOfrece('hidden'));
  });

  it('el repositorio pide el paso con los campos del contrato', () => {
    assert.ok(REPOSITORIO.includes('from_status: string | null'));
    assert.ok(REPOSITORIO.includes('to_status: string'));
    assert.ok(!REPOSITORIO.includes('action: string'));
  });

  it('la pantalla dice de dónde venía cuando el servidor lo manda', () => {
    assert.ok(PANTALLA.includes('moderacionResenas.pasoDesde'));
    assert.ok(PANTALLA.includes('paso.from_status !== null'));
  });
});

describe('la fila se repinta con la respuesta, sin heredar datos viejos', () => {
  const FILA = {
    id: 'r1',
    event_id: 'e1',
    author_id: 'a1',
    overall: 4,
    comment: 'estuvo bien',
    status: 'visible',
    moderation_reason: null as string | null,
    moderated_by: null as string | null,
    moderated_at: null as string | null,
    created_at: '2026-01-01T10:00:00Z',
  };

  it('el estado nuevo lo manda la respuesta, no lo que creíamos haber hecho', () => {
    const fila = filaTrasModerar(FILA, { status: 'hidden' }, 'insultos');
    assert.equal(fila.status, 'hidden');
  });

  it('al ocultar se guarda el motivo que se acaba de mandar', () => {
    const fila = filaTrasModerar(FILA, { status: 'hidden' }, 'insultos directos');
    assert.equal(fila.moderation_reason, 'insultos directos');
  });

  it('si la respuesta trae su propio motivo, manda el del servidor', () => {
    const fila = filaTrasModerar(
      FILA,
      { status: 'hidden', moderation_reason: 'lo que guardó el servidor' },
      'lo que escribí',
    );
    assert.equal(fila.moderation_reason, 'lo que guardó el servidor');
  });

  it('lo que la respuesta NO trae se queda vacío, no hereda lo anterior', () => {
    // `moderated_by` de una moderación vieja contado como el de ahora sería un
    // dato falso sobre quién decidió esto.
    const yaOculta = {
      ...FILA,
      status: 'hidden',
      moderated_by: 'alguien-de-antes',
      moderated_at: '2025-01-01T00:00:00Z',
    };
    const fila = filaTrasModerar(yaOculta, { status: 'hidden' }, 'otro motivo');
    assert.equal(fila.moderated_by, null);
    assert.equal(fila.moderated_at, null);
  });

  it('si la respuesta trae quién y cuándo, se usan', () => {
    const fila = filaTrasModerar(
      FILA,
      { status: 'hidden', moderated_by: 'mod-1', moderated_at: '2026-02-02T00:00:00Z' },
      'motivo',
    );
    assert.equal(fila.moderated_by, 'mod-1');
    assert.equal(fila.moderated_at, '2026-02-02T00:00:00Z');
  });

  it('al restaurar se vacían los tres, que es lo que escribe el servidor', () => {
    const yaOculta = {
      ...FILA,
      status: 'hidden',
      moderation_reason: 'lo que fuera',
      moderated_by: 'mod-1',
      moderated_at: '2026-02-02T00:00:00Z',
    };
    const fila = filaTrasModerar(yaOculta, { status: 'visible' }, null);
    assert.equal(fila.status, 'visible');
    assert.equal(fila.moderation_reason, null);
    assert.equal(fila.moderated_by, null);
    assert.equal(fila.moderated_at, null);
  });

  it('NI LA NOTA NI EL AUTOR NI EL COMENTARIO se tocan al repintar', () => {
    const fila = filaTrasModerar(FILA, { status: 'hidden' }, 'motivo');
    assert.equal(fila.overall, FILA.overall);
    assert.equal(fila.author_id, FILA.author_id);
    assert.equal(fila.comment, FILA.comment);
    assert.equal(fila.id, FILA.id);
    assert.equal(fila.event_id, FILA.event_id);
    assert.equal(fila.created_at, FILA.created_at);
  });

  it('una respuesta sin estado deja la fila como estaba', () => {
    assert.equal(filaTrasModerar(FILA, null, 'x').status, 'visible');
    assert.equal(filaTrasModerar(FILA, undefined, 'x').status, 'visible');
    assert.equal(filaTrasModerar(FILA, {}, 'x').status, 'visible');
    assert.equal(filaTrasModerar(FILA, { status: '' }, 'x').status, 'visible');
  });

  it('un estado raro en la respuesta se copia tal cual, sin tocar lo demás', () => {
    const fila = filaTrasModerar(FILA, { status: 'shadow_banned' }, 'x');
    assert.equal(fila.status, 'shadow_banned');
    assert.equal(fila.moderation_reason, null);
    assert.equal(accionQueOfrece(fila.status), null);
  });

  it('no muta la fila que recibe', () => {
    const original = { ...FILA };
    filaTrasModerar(FILA, { status: 'hidden' }, 'motivo');
    assert.deepEqual(FILA, original);
  });
});

describe('las referencias internas, sin inventar nombres', () => {
  it('un identificador largo se acorta y se marca', () => {
    assert.equal(
      abreviarIdentificador('0f2b7c91-4d3a-4a1e-9f11-9c2d5b7a8e01'),
      '0f2b7c91…',
    );
  });

  it('uno corto se enseña entero, sin puntos suspensivos', () => {
    assert.equal(abreviarIdentificador('abc'), 'abc');
    assert.equal(abreviarIdentificador('0f2b7c91'), '0f2b7c91');
  });

  it('sin identificador no se enseña nada: no se inventa una referencia', () => {
    assert.equal(abreviarIdentificador(null), null);
    assert.equal(abreviarIdentificador(undefined), null);
    assert.equal(abreviarIdentificador(''), null);
    assert.equal(abreviarIdentificador('   '), null);
  });

  it('el largo se puede pedir, y nunca es cero', () => {
    assert.equal(abreviarIdentificador('abcdefghij', 4), 'abcd…');
    assert.equal(abreviarIdentificador('abcdefghij', 0), 'a…');
    assert.equal(abreviarIdentificador('abcdefghij', -5), 'a…');
    assert.equal(LARGO_DE_LA_REFERENCIA, 8);
  });

  it('la pantalla no pide ningún perfil ni enseña nada fuera del contrato', () => {
    const codigo = sinComentarios(PANTALLA);
    assert.ok(!codigo.includes('Profile'));
    assert.ok(!codigo.includes('perfil'));
    assert.ok(!codigo.includes('avatar'));
    assert.ok(!codigo.includes('display_name'));
    assert.ok(!codigo.includes('username'));
    // Lo que sí: la referencia abreviada, dicha como tal.
    assert.ok(codigo.includes('abreviarIdentificador(resena.author_id)'));
  });
});

describe('el comentario se recorta para la lista sin partir palabras', () => {
  it('lo que cabe se enseña entero', () => {
    assert.equal(resumenDelComentario('estuvo bien'), 'estuvo bien');
  });

  it('sin comentario no hay resumen', () => {
    assert.equal(resumenDelComentario(null), null);
    assert.equal(resumenDelComentario(undefined), null);
    assert.equal(resumenDelComentario(''), null);
    assert.equal(resumenDelComentario('   \n  '), null);
  });

  it('los saltos de línea y los espacios de más se juntan en uno', () => {
    assert.equal(resumenDelComentario('hola\n\n   mundo  '), 'hola mundo');
  });

  it('lo largo se corta en un espacio, NUNCA a mitad de palabra', () => {
    const texto = `${'palabra '.repeat(30)}final`;
    const corto = resumenDelComentario(texto, 20) as string;
    assert.ok(corto.endsWith('…'));
    const util = corto.slice(0, -1);
    assert.ok(util.length <= 20);
    // Lo que queda son palabras enteras: el original empieza por ahí y lo
    // siguiente es un espacio.
    assert.ok(texto.startsWith(util));
    assert.equal(texto[util.length], ' ');
  });

  it('una palabra sola más larga que el tope se corta igual: es lo único que hay', () => {
    const corto = resumenDelComentario('a'.repeat(300), 10) as string;
    assert.equal(corto, `${'a'.repeat(10)}…`);
  });

  it('el tope por defecto es el de la fila', () => {
    assert.equal(LARGO_DEL_RESUMEN, 160);
    const largo = resumenDelComentario('ab '.repeat(200)) as string;
    assert.ok(largo.length <= LARGO_DEL_RESUMEN + 1);
  });

  it('la pantalla enseña el texto entero al abrir la ficha', () => {
    // El resumen es la fila; esconder el texto completo obligaría a decidir a
    // ciegas.
    assert.ok(PANTALLA.includes('estaAbierta ? (resena.comment as string) : resumen'));
  });
});

describe('la cadena de filtros es la del contrato', () => {
  it('siempre lleva el tope, para poder decirlo', () => {
    assert.equal(cadenaDeFiltros(), `limit=${LIMITE_INICIAL}`);
    assert.equal(cadenaDeFiltros({}), `limit=${LIMITE_INICIAL}`);
  });

  it('el estado y el evento van cuando hay algo que filtrar', () => {
    assert.equal(
      cadenaDeFiltros({ estado: 'hidden', eventoId: 'ev-1', limite: 100 }),
      'limit=100&estado=hidden&event_id=ev-1',
    );
  });

  it('lo vacío NO viaja: filtraría por la cadena vacía', () => {
    assert.equal(
      cadenaDeFiltros({ estado: '   ', eventoId: '  ', limite: 50 }),
      'limit=50',
    );
    assert.equal(cadenaDeFiltros({ estado: null, eventoId: null }), 'limit=50');
  });

  it('lo escrito a mano se escapa', () => {
    assert.equal(
      cadenaDeFiltros({ eventoId: 'a b&c=d' }),
      'limit=50&event_id=a%20b%26c%3Dd',
    );
  });

  it('un tope imposible se corrige a uno que el servidor acepte', () => {
    assert.equal(limiteValido(undefined), LIMITE_INICIAL);
    assert.equal(limiteValido(null), LIMITE_INICIAL);
    assert.equal(limiteValido(Number.NaN), LIMITE_INICIAL);
    assert.equal(limiteValido(0), 1);
    assert.equal(limiteValido(-10), 1);
    assert.equal(limiteValido(5000), LIMITE_MAXIMO);
    assert.equal(limiteValido(77.9), 77);
  });

  it('el identificador del evento se limpia antes de filtrar', () => {
    assert.equal(filtroDeEvento('  ev-1 '), 'ev-1');
    assert.equal(filtroDeEvento('   '), null);
    assert.equal(filtroDeEvento(null), null);
    assert.equal(filtroDeEvento(undefined), null);
  });
});

describe('no hay cursor, y se dice', () => {
  it('los topes son los que el servidor admite', () => {
    assert.deepEqual([...LIMITES_DE_LA_LISTA], [50, 100, 200]);
    assert.equal(LIMITE_MAXIMO, 200);
    assert.equal(LIMITE_INICIAL, 50);
  });

  it('se sube de tope hasta el máximo y ahí se para', () => {
    assert.equal(siguienteLimite(50), 100);
    assert.equal(siguienteLimite(100), 200);
    assert.equal(siguienteLimite(200), null);
    assert.equal(siguienteLimite(999), null);
  });

  it('tantos resultados como el tope significa que puede haber más', () => {
    assert.equal(llegoAlTope(50, 50), true);
    assert.equal(llegoAlTope(49, 50), false);
    assert.equal(llegoAlTope(0, 50), false);
  });

  it('la pantalla avisa del tope en vez de fingir que están todas', () => {
    assert.ok(PANTALLA.includes('moderacionResenas.tope'));
    assert.ok(PANTALLA.includes('moderacionResenas.verMas'));
  });
});

describe('el 401, el 403, el 404, el 409 y el 422 no son lo mismo', () => {
  it('cada estado tiene su propio fallo', () => {
    assert.equal(falloDeCarga(401, null), 'sinSesion');
    assert.equal(falloDeCarga(403, null), 'sinPermiso');
    assert.equal(falloDeCarga(404, null), 'noEncontrada');
    assert.equal(falloDeCarga(422, null), 'datosInvalidos');
    assert.equal(falloDeCarga(503, null), 'noDisponible');
    assert.equal(falloDeCarga(500, null), 'red');
    assert.equal(falloDeCarga(null, null), 'red');
  });

  it('un filtro de estado rechazado NO se cuenta como «no hay ninguna»', () => {
    // Antes un estado inventado devolvía la lista vacía y se leía como que no
    // había reseñas; ahora el servidor lo rechaza y se dice qué está mal.
    assert.equal(esEstadoDeFiltroInvalido('event_review_status_invalid'), true);
    assert.equal(esEstadoDeFiltroInvalido('otra_cosa'), false);
    assert.equal(esEstadoDeFiltroInvalido(null), false);
    assert.equal(esEstadoDeFiltroInvalido(undefined), false);
    assert.equal(falloDeCarga(422, 'event_review_status_invalid'), 'estadoInvalido');
  });

  it('el código manda sobre el número: no todos los 422 son lo mismo', () => {
    assert.equal(falloDeCarga(422, 'otra_cosa'), 'datosInvalidos');
    assert.notEqual(
      falloDeCarga(422, 'event_review_status_invalid'),
      falloDeCarga(422, 'otra_cosa'),
    );
  });

  it('el estado inválido tiene su propio texto y no se reintenta', () => {
    assert.equal(
      claveDelFallo('estadoInvalido'),
      'moderacionResenas.fallo.estadoInvalido',
    );
    assert.equal(
      claveDelCuerpoDelFallo('estadoInvalido'),
      'moderacionResenas.falloCuerpo.estadoInvalido',
    );
    assert.equal(seReintenta('estadoInvalido'), false);
  });

  it('los chips solo ofrecen estados que el servidor acepta', () => {
    // Así el 422 de filtro no se puede provocar desde la propia pantalla.
    for (const valor of ESTADOS_QUE_SE_FILTRAN) {
      assert.ok(['visible', 'hidden'].includes(valor));
    }
  });

  it('un corte de red se dice corte de red, y se reintenta', () => {
    assert.equal(falloDeCarga(0, 'network_error'), 'sinConexion');
    assert.equal(falloDeCarga(0, 'timeout'), 'sinConexion');
    assert.equal(seReintenta('sinConexion'), true);
    assert.equal(seReintenta('red'), true);
  });

  it('un permiso denegado NO se reintenta: reintentarlo no cambia nada', () => {
    assert.equal(seReintenta('sinPermiso'), false);
    assert.equal(seReintenta('sinSesion'), false);
    assert.equal(seReintenta('noDisponible'), false);
    assert.equal(seReintenta('noEncontrada'), false);
    assert.equal(seReintenta('datosInvalidos'), false);
  });

  it('las reseñas apagadas mandan sobre el estado HTTP', () => {
    assert.equal(falloDeCarga(403, 'event_reviews_not_available'), 'noDisponible');
    assert.equal(esResenasApagadas('event_reviews_not_available'), true);
    assert.equal(esResenasApagadas('otra_cosa'), false);
    assert.equal(esResenasApagadas(null), false);
  });

  it('cada fallo tiene su titular y su explicación, y lo raro cae en desconocido', () => {
    for (const fallo of [
      'sinSesion',
      'sinPermiso',
      'noDisponible',
      'noEncontrada',
      'estadoInvalido',
      'datosInvalidos',
    ]) {
      assert.equal(claveDelFallo(fallo), `moderacionResenas.fallo.${fallo}`);
      assert.equal(claveDelCuerpoDelFallo(fallo), `moderacionResenas.falloCuerpo.${fallo}`);
    }
    assert.equal(claveDelFallo('red'), 'moderacionResenas.fallo.desconocido');
    assert.equal(
      claveDelCuerpoDelFallo('lo_que_sea'),
      'moderacionResenas.falloCuerpo.desconocido',
    );
  });

  it('el 403 tiene su propio mensaje, distinto del vacío', () => {
    // Convertir «esto no es para ti» en «no hay nada» dice otra cosa.
    assert.ok(PANTALLA.includes('claveDelFallo(fallo)'));
    assert.ok(PANTALLA.includes('moderacionResenas.listaVacia'));
    assert.ok(PANTALLA.includes("icon={"));
  });

  it('el 409 es «alguien se adelantó», no un error seco', () => {
    assert.equal(esConflictoDeResena('event_review_changed'), true);
    assert.equal(esConflictoDeResena('event_case_changed'), false);
    assert.equal(esConflictoDeResena(null), false);
    assert.equal(esConflictoDeResena(undefined), false);
  });

  it('los códigos conocidos se traducen, y los demás dejan hablar al servidor', () => {
    assert.equal(
      claveDeErrorDeModeracion('event_review_changed'),
      'moderacionResenas.conflictoCuerpo',
    );
    assert.equal(
      claveDeErrorDeModeracion('event_review_not_found'),
      'moderacionResenas.error.noEncontrada',
    );
    assert.equal(
      claveDeErrorDeModeracion('event_reviews_not_available'),
      'moderacionResenas.error.noDisponible',
    );
    assert.equal(
      claveDeErrorDeModeracion('event_review_status_invalid'),
      'moderacionResenas.falloCuerpo.estadoInvalido',
    );
    assert.equal(claveDeErrorDeModeracion('lo_que_sea'), null);
    assert.equal(claveDeErrorDeModeracion(null), null);
    assert.equal(claveDeErrorDeModeracion(undefined), null);
  });

  it('la pantalla recarga tras un conflicto en vez de mandar a salir y entrar', () => {
    const codigo = sinComentarios(PANTALLA);
    assert.ok(/esConflictoDeResena\(error\.code\)[\s\S]{0,160}await cargar\(\)/.test(codigo));
    assert.ok(codigo.includes('moderacionResenas.conflictoTitulo'));
  });
});

describe('un estado desconocido no revienta la pantalla', () => {
  it('el módulo entero aguanta estados inventados sin lanzar', () => {
    const raros = ['', ' ', 'deleted', 'shadow_banned', 'DRAFT', '1', 'null'];
    for (const raro of raros) {
      assert.doesNotThrow(() => {
        claveDelEstadoDeResena(raro);
        claveDeAccion(raro);
        claveDelPaso(raro);
        claveDelFallo(raro);
        claveDelCuerpoDelFallo(raro);
        accionQueOfrece(raro);
        valorDeHide(raro);
        motivoObligatorio(raro);
        revisarMotivo(raro, 'algo');
        tonoDelEstado(raro);
        estadoConocido(raro);
        contarPorEstado([{ status: raro }]);
        cadenaDeFiltros({ estado: raro });
      }, raro);
    }
  });

  it('una fila con un estado raro se cuenta aparte y no ofrece nada', () => {
    assert.deepEqual(contarPorEstado([{ status: 'shadow_banned' }]), {
      visibles: 0,
      ocultas: 0,
      otras: 1,
    });
    assert.equal(accionQueOfrece('shadow_banned'), null);
    assert.equal(
      claveDelEstadoDeResena('shadow_banned'),
      'moderacionResenas.estado.desconocido',
    );
  });

  it('la pantalla no indexa nada con el estado del servidor', () => {
    // Un `TEXTOS[resena.status]` sería `undefined` pintado en pantalla.
    const codigo = sinComentarios(PANTALLA);
    assert.ok(!/\[resena\.status\]/.test(codigo));
    assert.ok(!/\[paso\.to_status\]/.test(codigo));
  });
});

describe('dos toques no mandan dos veces la misma decisión', () => {
  it('el cerrojo se echa ANTES del primer `await`', () => {
    const codigo = sinComentarios(PANTALLA);
    const cerrojo = codigo.indexOf('ocupadoRef.current = true');
    const salida = codigo.indexOf('if (ocupadoRef.current) return;');
    const primerAwait = codigo.indexOf('await trabajo()');
    assert.ok(salida >= 0 && salida < cerrojo, 'no se comprueba antes de echarlo');
    assert.ok(cerrojo < primerAwait, 'el cerrojo llega después del primer await');
  });

  it('el cerrojo es una referencia, no un estado: un `setState` llega tarde', () => {
    assert.ok(PANTALLA.includes('const ocupadoRef = useRef(false)'));
  });

  it('el cerrojo se suelta pase lo que pase', () => {
    const codigo = sinComentarios(PANTALLA);
    assert.ok(/finally \{[\s\S]{0,120}ocupadoRef\.current = false/.test(codigo));
  });

  it('el diálogo de confirmación queda DENTRO del cerrojo', () => {
    const codigo = sinComentarios(PANTALLA);
    const conCerrojo = codigo.indexOf('void conCerrojo(async () => {');
    const confirma = codigo.indexOf('await confirm(');
    assert.ok(conCerrojo > 0 && confirma > conCerrojo);
  });

  it('los botones se apagan mientras va', () => {
    const codigo = sinComentarios(PANTALLA);
    const apagados = codigo.match(/disabled=\{ocupado/g) ?? [];
    assert.ok(apagados.length >= 6, `solo ${apagados.length} controles se apagan`);
    assert.ok(codigo.includes('loading={ocupado}'));
  });

  it('restaurar también confirma antes de hacerse', () => {
    assert.ok(PANTALLA.includes('moderacionResenas.confirmarRestaurarTitulo'));
    assert.ok(PANTALLA.includes('moderacionResenas.confirmarRestaurarCuerpo'));
  });

  it('tras moderar se repinta la fila con lo que contestó el servidor', () => {
    const codigo = sinComentarios(PANTALLA);
    const trozo = codigo.slice(codigo.indexOf('const enviar ='));
    assert.ok(trozo.includes('filaTrasModerar(fila, actualizada, revisado.motivo)'));
    // Y NO se recarga la lista entera: movería todo bajo el dedo de quien decide.
    const hasta = trozo.indexOf('const aplicarEvento');
    assert.ok(!trozo.slice(0, hasta).includes('await cargar()'));
  });
});

describe('la pantalla se puede usar, y en los dos modos', () => {
  it('no hay ni un texto en duro dentro del JSX', () => {
    const codigo = sinComentarios(PANTALLA);
    const sueltos = [...codigo.matchAll(/[^=]>\s*\n?\s*[A-Za-zÁÉÍÓÚÑáéíóúñ¿¡]/g)];
    assert.deepEqual(
      sueltos.map((m) => m[0]),
      [],
      'hay texto escrito directamente en el JSX',
    );
  });

  it('todos los colores salen del tema, ninguno escrito a mano', () => {
    const codigo = sinComentarios(PANTALLA);
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(codigo), 'hay un color escrito a mano');
    assert.ok(!/rgba?\(/.test(codigo));
    assert.ok(codigo.includes('useAppTheme()'));
  });

  it('lo que se pulsa llega a los 44 puntos', () => {
    assert.ok(PANTALLA.includes('minHeight: 44'));
  });

  it('lo que se pulsa se anuncia', () => {
    const codigo = sinComentarios(PANTALLA);
    assert.ok(codigo.includes("accessibilityRole=\"button\""));
    assert.ok(codigo.includes('accessibilityLabel='));
    assert.ok(codigo.includes('accessibilityState={{ expanded: estaAbierta }}'));
  });

  it('los filtros de estado se anuncian como elección única', () => {
    const codigo = sinComentarios(PANTALLA);
    const radios = codigo.match(/rol="radio"/g) ?? [];
    assert.ok(radios.length >= 2, 'los chips de estado deberían ser de opción única');
  });

  it('están los cuatro estados de la pantalla: cargando, vacío, error y sin permiso', () => {
    assert.ok(PANTALLA.includes('state="loading"'));
    assert.ok(PANTALLA.includes('state="empty"'));
    assert.ok(PANTALLA.includes("'offline' : 'error'"));
    assert.ok(PANTALLA.includes('onRetry={() => void cargar()}'));
  });

  it('el historial tiene sus propios estados y no tumba la pantalla', () => {
    const codigo = sinComentarios(PANTALLA);
    assert.ok(codigo.includes('setHistorialFallo(true)'));
    assert.ok(codigo.includes('moderacionResenas.historialNoSePudo'));
    assert.ok(codigo.includes('moderacionResenas.historialVacio'));
  });

  it('todas las claves se traducen con `t` o con el envoltorio `f`', () => {
    const codigo = sinComentarios(PANTALLA);
    const claves = [...codigo.matchAll(/'moderacionResenas\.[a-zA-Z.]+'/g)];
    assert.ok(claves.length > 40, 'deberían usarse muchas claves');
    for (const clave of claves) {
      const antes = codigo.slice(Math.max(0, clave.index - 3), clave.index);
      assert.ok(
        antes.endsWith('f(') || antes.endsWith('t(') || antes.endsWith("= '"),
        `la clave ${clave[0]} no pasa por el traductor`,
      );
    }
  });

  it('no se habla con Supabase ni con ningún mock: todo por el repositorio', () => {
    const codigo = sinComentarios(PANTALLA);
    assert.ok(!codigo.includes('supabase'));
    assert.ok(!codigo.includes('fetch('));
    assert.ok(!codigo.includes('mock'));
    assert.ok(codigo.includes('EventReviewModerationRepository'));
  });

  it('el repositorio pasa por `apiRequest`, no por otra cosa', () => {
    const codigo = sinComentarios(REPOSITORIO);
    assert.ok(codigo.includes("from '@/services/api'"));
    assert.ok(!codigo.includes('supabase'));
    assert.ok(!codigo.includes('fetch('));
    const llamadas = codigo.match(/apiRequest</g) ?? [];
    assert.equal(llamadas.length, 4);
  });

  it('la cola de administración lleva a esta pantalla', () => {
    const cola = fuente('screens', 'AdminEventosScreen.tsx');
    assert.ok(cola.includes("'/admin/resenas'"));
    assert.ok(cola.includes('moderacionResenas.tituloPanel'));
  });
});
