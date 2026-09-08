/**
 * Valoraciones de un curso: lo que se decide antes de pintar nada.
 *
 * LO QUE ESTAS PRUEBAS PROTEGEN, y es una sola cosa dicha de varias formas:
 * que un curso SIN valorar no se presente como un curso MAL valorado. El
 * servidor manda `average: null` a proposito; basta con un `?? 0` en cualquier
 * punto del camino para que debajo del titulo aparezca «0.0», y eso no es un
 * detalle de formato: es una acusacion sobre el trabajo de alguien.
 *
 * Se ejecutan con `npm test` (el runner de Node, sin dependencias).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_COMENTARIO,
  anchoDeBarra,
  anuncioDelResumen,
  codigoDeFallo,
  comentarioParaEnviar,
  etiquetaDeDistribucion,
  etiquetaDePuntuacion,
  fusionarPaginas,
  hayMasPaginas,
  hayMedia,
  mensajeDeErrorDeValoracion,
  miValoracion,
  motivoParaNoEnviar,
  normalizaResumen,
  proporcionDeBarra,
  puntuacionValida,
  seccionNoMontada,
  textoDeMedia,
  textoDelTotal,
  type Traductor,
} from './valoracionesDeCurso.ts';

/** Un traductor que devuelve la clave: sirve para ver DE DONDE sale el texto. */
const claves: Traductor = (clave) => clave;

/** El resumen tal y como lo manda el servidor cuando ya hay opiniones. */
const CON_OPINIONES = {
  average: 4.33,
  total: 12,
  distribution: { '1': 1, '2': 0, '3': 2, '4': 0, '5': 9 },
};

describe('el resumen que llega del servidor', () => {
  it('sin ninguna valoracion, la media es NULL y no cero', () => {
    const resumen = normalizaResumen({
      average: null,
      total: 0,
      distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
    });
    assert.equal(resumen.media, null);
    assert.equal(resumen.total, 0);
    assert.equal(hayMedia(resumen), false);
  });

  it('un `average` en cero CON total en cero tampoco se convierte en media', () => {
    /*
      Es el caso que rompia todo: `average ?? 0` y `average === 0` se leen
      igual desde el componente, y uno de los dos significa «sin valorar».
    */
    const resumen = normalizaResumen({ average: 0, total: 0 });
    assert.equal(resumen.media, null);
  });

  it('rellena a cero los cajones que falten, porque el servidor manda los cinco', () => {
    const resumen = normalizaResumen({ average: 5, total: 2, distribution: { '5': 2 } });
    assert.deepEqual(resumen.distribucion, { '1': 0, '2': 0, '3': 0, '4': 0, '5': 2 });
  });

  it('un resumen ausente no revienta ni inventa nada', () => {
    const resumen = normalizaResumen(null);
    assert.equal(resumen.media, null);
    assert.equal(resumen.total, 0);
    assert.deepEqual(resumen.distribucion, { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 });
  });

  it('conserva la media cuando de verdad la hay', () => {
    const resumen = normalizaResumen(CON_OPINIONES);
    assert.equal(resumen.media, 4.33);
    assert.equal(resumen.total, 12);
    assert.equal(hayMedia(resumen), true);
  });

  it('los conteos raros (negativos, texto, NaN) se leen como cero', () => {
    const resumen = normalizaResumen({
      average: Number.NaN,
      total: -3,
      distribution: { '5': -1, '4': Number.NaN, '3': null },
    });
    assert.equal(resumen.media, null);
    assert.equal(resumen.total, 0);
    assert.deepEqual(resumen.distribucion, { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 });
  });
});

describe('lo que se ESCRIBE de la media', () => {
  it('es la media con UN decimal', () => {
    assert.equal(textoDeMedia(normalizaResumen(CON_OPINIONES)), '4.3');
    assert.equal(textoDeMedia(normalizaResumen({ average: 5, total: 4 })), '5.0');
  });

  it('sin valoraciones dice «Sin valoraciones», y JAMAS un cero', () => {
    for (const dto of [
      { average: null, total: 0 },
      { average: null, total: 3 },
      { average: 0, total: 0 },
      null,
    ]) {
      const texto = textoDeMedia(normalizaResumen(dto));
      assert.equal(texto, 'Sin valoraciones');
      assert.doesNotMatch(texto, /\d/, `«${texto}» ensena un numero donde no hay media`);
    }
  });

  it('el texto sale del diccionario, no del codigo', () => {
    assert.equal(
      textoDeMedia(normalizaResumen({ average: null, total: 0 }), claves),
      'valoracion.sinValoraciones',
    );
  });
});

describe('cuantas valoraciones hay', () => {
  it('ninguna se dice «Sin valoraciones», no «0 valoraciones»', () => {
    assert.equal(textoDelTotal(0), 'Sin valoraciones');
  });

  it('una va en singular', () => {
    assert.equal(textoDelTotal(1), '1 valoración');
  });

  it('varias llevan el numero', () => {
    assert.equal(textoDelTotal(12), '12 valoraciones');
  });
});

describe('lo que oye quien no ve las estrellas', () => {
  it('una puntuacion se anuncia como «N de 5»', () => {
    assert.equal(etiquetaDePuntuacion(4), '4 de 5');
    assert.equal(etiquetaDePuntuacion(1), '1 de 5');
  });

  it('el resumen se anuncia con su media Y su total, en una sola frase', () => {
    const anuncio = anuncioDelResumen(normalizaResumen(CON_OPINIONES));
    assert.match(anuncio, /4\.3/, 'falta la media');
    assert.match(anuncio, /12 valoraciones/, 'falta el total');
  });

  it('sin valoraciones el resumen no anuncia ninguna media', () => {
    const anuncio = anuncioDelResumen(normalizaResumen({ average: null, total: 0 }));
    assert.equal(anuncio, 'Sin valoraciones');
  });

  it('cada barra dice su nota y cuantas la eligieron, incluso si son cero', () => {
    assert.equal(etiquetaDeDistribucion(5, 9), '5 de 5: 9 valoraciones');
    assert.equal(etiquetaDeDistribucion(2, 1), '2 de 5: 1 valoración');
    // Aqui el cero SI se dice: es el tamaño de un cajon, no la nota del curso.
    assert.equal(etiquetaDeDistribucion(2, 0), '2 de 5: 0 valoraciones');
  });
});

describe('las barras de la distribucion', () => {
  it('sin total no ocupan nada, y no se dividen por cero', () => {
    assert.equal(proporcionDeBarra(0, 0), 0);
    assert.equal(anchoDeBarra(0, 0), '0%');
  });

  it('son proporcionales al total', () => {
    assert.equal(anchoDeBarra(3, 12), '25%');
    assert.equal(anchoDeBarra(12, 12), '100%');
  });

  it('nunca se pasan del carril aunque los numeros no cuadren', () => {
    assert.equal(anchoDeBarra(30, 12), '100%');
  });
});

describe('la paginacion', () => {
  it('una pagina llena deja abierta la puerta a la siguiente', () => {
    assert.equal(hayMasPaginas(10, 10), true);
    assert.equal(hayMasPaginas(4, 10), false);
    assert.equal(hayMasPaginas(0, 10), false);
  });

  it('no repite una valoracion que llega dos veces', () => {
    /*
      La paginacion va por posicion: publicar una valoracion entre dos
      peticiones desplaza a las demas y alguna vuelve a llegar.
    */
    const previas = [{ id: 'a' }, { id: 'b' }];
    const nuevas = [{ id: 'b' }, { id: 'c' }];
    assert.deepEqual(fusionarPaginas(previas, nuevas), [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ]);
  });

  it('encuentra la propia entre las cargadas, y no se inventa una si no esta', () => {
    const lista = [
      { id: 'a', esMia: false },
      { id: 'b', esMia: true },
    ];
    assert.equal(miValoracion(lista)?.id, 'b');
    assert.equal(miValoracion([{ id: 'a', esMia: false }]), null);
    assert.equal(miValoracion([]), null);
  });
});

describe('lo que se puede enviar', () => {
  it('la puntuacion es un entero del 1 al 5', () => {
    for (const buena of [1, 2, 3, 4, 5]) assert.equal(puntuacionValida(buena), true);
    for (const mala of [0, 6, -1, 3.5, Number.NaN]) {
      assert.equal(puntuacionValida(mala), false, `${mala} no es una puntuacion`);
    }
  });

  it('sin puntuacion no se manda nada, y se dice por que', () => {
    assert.equal(motivoParaNoEnviar(0, '', claves), 'valoracion.eligePuntuacion');
  });

  it('un comentario mas largo del tope se para AQUI, no en un 422', () => {
    assert.equal(
      motivoParaNoEnviar(4, 'x'.repeat(MAX_COMENTARIO + 1), claves),
      'valoracion.comentarioLargo',
    );
    assert.equal(motivoParaNoEnviar(4, 'x'.repeat(MAX_COMENTARIO), claves), null);
  });

  it('con puntuacion y sin comentario se puede enviar: el comentario es opcional', () => {
    assert.equal(motivoParaNoEnviar(5, '', claves), null);
  });

  it('un comentario en blanco viaja como null, que es como se borra', () => {
    assert.equal(comentarioParaEnviar('   '), null);
    assert.equal(comentarioParaEnviar(''), null);
    assert.equal(comentarioParaEnviar(null), null);
    assert.equal(comentarioParaEnviar('  me sirvió  '), 'me sirvió');
  });
});

describe('los fallos del servidor, traducidos a algo que se pueda hacer', () => {
  const fallo = (code: string) => Object.assign(new Error('mensaje del servidor'), { code });

  it('cada codigo tiene su explicacion, y ninguna es el mensaje crudo', () => {
    const casos: [string, string][] = [
      ['review_purchase_required', 'valoracion.necesitaCompra'],
      ['review_access_required', 'valoracion.necesitaAcceso'],
      ['review_owner_not_allowed', 'valoracion.esTuCurso'],
      ['course_review_exists', 'valoracion.yaValoraste'],
      ['course_reviews_not_available', 'valoracion.noDisponible'],
    ];
    for (const [code, clave] of casos) {
      assert.equal(mensajeDeErrorDeValoracion(fallo(code), claves), clave, code);
    }
  });

  it('«ya valoraste» dice que hay que EDITAR, no que se reintente', () => {
    // Es la diferencia entre una salida y un muro: reintentar da otro 409.
    assert.match(mensajeDeErrorDeValoracion(fallo('course_review_exists')), /Edita/);
  });

  it('un codigo desconocido deja hablar al servidor', () => {
    assert.equal(
      mensajeDeErrorDeValoracion(fallo('algo_que_no_conocemos'), claves),
      'mensaje del servidor',
    );
  });

  it('y sin mensaje ninguno, se dice algo util en vez de nada', () => {
    assert.equal(mensajeDeErrorDeValoracion({ code: 'raro' }, claves), 'common.tryAgain');
    assert.equal(mensajeDeErrorDeValoracion(undefined, claves), 'common.tryAgain');
  });

  it('el codigo se lee de la propiedad, no de la clase del error', () => {
    assert.equal(codigoDeFallo(fallo('x')), 'x');
    assert.equal(codigoDeFallo({ code: 'y' }), 'y');
    assert.equal(codigoDeFallo({ code: '' }), null);
    assert.equal(codigoDeFallo(new Error('sin codigo')), null);
    assert.equal(codigoDeFallo(null), null);
  });
});

describe('cuando la funcion todavia no existe en esta instalacion', () => {
  it('el 503 de la migracion 0056 se reconoce como «no montada»', () => {
    const fallo = Object.assign(new Error('no disponible'), {
      status: 503,
      code: 'course_reviews_not_available',
    });
    assert.equal(seccionNoMontada(fallo), true);
  });

  it('y NINGUN otro fallo se confunde con eso', () => {
    /*
      Importa: confundirlos hace desaparecer la seccion cuando lo que hay es un
      corte de red, y entonces nadie puede ni reintentar ni saber que paso.
    */
    for (const otro of [
      Object.assign(new Error('sin red'), { code: 'network_error' }),
      Object.assign(new Error('tarda'), { code: 'timeout' }),
      Object.assign(new Error('caido'), { status: 503, code: 'http_error' }),
      new Error('a secas'),
      null,
    ]) {
      assert.equal(seccionNoMontada(otro), false);
    }
  });
});
