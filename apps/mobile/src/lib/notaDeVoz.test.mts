import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decidirDesenlace,
  duracionEnSegundos,
  formatearDuracion,
  llegoAlTope,
  MAX_DURACION_S,
  MIN_DURACION_S,
  MS_PARA_EMPEZAR,
} from './notaDeVoz.ts';

/**
 * Las reglas de una nota de voz, probadas sin micrófono.
 *
 * Todo lo demás de grabar es llamar al sistema y no se puede probar sin un
 * teléfono. Lo que SI tiene reglas —y reglas que se equivocan en silencio— es
 * decidir qué hacer con lo grabado: si se manda, si se tira, y si se tira, si
 * hay que explicarlo. Eso es lo que hay aquí.
 */

describe('qué hacer al soltar el dedo', () => {
  it('una nota normal se manda', () => {
    assert.equal(decidirDesenlace({ ms: 4200, cancelada: false }), 'enviar');
  });

  it('cancelar gana SIEMPRE, incluso sobre una nota larga y buena', () => {
    /*
      Es la regla que más fácil se rompe al reordenar las condiciones: quien
      desliza para cancelar ya ha decidido, y mandarla igual porque «duraba lo
      suficiente» es ignorarle. Una nota de dos minutos cancelada se tira.
    */
    assert.equal(decidirDesenlace({ ms: 120_000, cancelada: true }), 'descartar');
  });

  it('un roce se tira, pero se explica', () => {
    /*
      La diferencia con cancelar no es cosmética. Quien cancela sabe por qué no
      ha pasado nada; quien roza el micrófono, no — y sin decírselo, el botón
      parece roto. Por eso son dos desenlaces y no uno.
    */
    assert.equal(decidirDesenlace({ ms: 300, cancelada: false }), 'demasiado-corta');
    assert.notEqual(
      decidirDesenlace({ ms: 300, cancelada: false }),
      decidirDesenlace({ ms: 300, cancelada: true }),
      'tirar por roce y tirar por cancelación no pueden ser el mismo caso',
    );
  });

  it('justo en el mínimo ya vale', () => {
    assert.equal(
      decidirDesenlace({ ms: MIN_DURACION_S * 1000, cancelada: false }),
      'enviar',
    );
  });

  it('una duración que no es un número se trata como un roce, no como una nota', () => {
    /*
      El grabador puede devolver `NaN` si algo falló al cerrar el fichero.
      Mandarlo produciría una burbuja de audio que al pulsarla no suena nada, y
      el backend la rechazaría con un 422 después de subir el fichero entero.
    */
    assert.equal(decidirDesenlace({ ms: Number.NaN, cancelada: false }), 'demasiado-corta');
  });
});

describe('la duración que se manda al servidor', () => {
  it('va en segundos con una décima', () => {
    assert.equal(duracionEnSegundos(4530), 4.5);
  });

  it('REDONDEA HACIA ABAJO, para no cruzar el tope por una décima inventada', () => {
    /*
      El backend rechaza lo que pase del máximo. Redondeando al más cercano, una
      nota de 300,04 s se convertiría en 300,1 y podría acabar rechazada por una
      décima que nadie ha grabado. Perder una centésima no se nota; perder la
      nota entera, sí.
    */
    assert.equal(duracionEnSegundos(4599), 4.5);
    assert.equal(duracionEnSegundos(MAX_DURACION_S * 1000 + 40), MAX_DURACION_S);
  });

  it('nunca devuelve algo que el servidor rechace por no ser un número', () => {
    assert.equal(duracionEnSegundos(Number.NaN), 0);
    assert.equal(duracionEnSegundos(-100), 0);
  });
});

describe('el reloj', () => {
  it('pone siempre dos cifras en los segundos', () => {
    /*
      Sin esto el contador salta de `0:9` a `0:10`, el ancho del texto cambia y
      la fila entera da un tirón cada diez segundos mientras alguien graba
      mirándola.
    */
    assert.equal(formatearDuracion(9), '0:09');
    assert.equal(formatearDuracion(64), '1:04');
    assert.equal(formatearDuracion(0), '0:00');
  });

  it('no escribe basura con un valor imposible', () => {
    assert.equal(formatearDuracion(Number.NaN), '0:00');
    assert.equal(formatearDuracion(-5), '0:00');
  });
});

describe('el tope', () => {
  it('avisa justo al llegar, no después', () => {
    assert.equal(llegoAlTope(MAX_DURACION_S * 1000 - 1), false);
    assert.equal(llegoAlTope(MAX_DURACION_S * 1000), true);
  });

  it('el máximo del móvil es el MISMO que el del backend', () => {
    /*
      `audio.MAX_DURACION_S` del backend son 5 minutos. Si aquí fuera mayor, la
      nota se grabaría entera, se subiría entera —gastando los datos de quien la
      manda— y el servidor la rechazaría al final con un 422. Si fuera menor, se
      estaría recortando sin motivo.

      No hay forma de importar el valor de Python desde aquí, así que se fija el
      número y se explica: si alguien cambia uno de los dos, esta prueba obliga a
      mirar el otro.
    */
    assert.equal(MAX_DURACION_S, 5 * 60);
  });
});

describe('mantener pulsado no es tocar', () => {
  it('hay un umbral antes de empezar a grabar', () => {
    /*
      Es un requisito, no un ajuste fino: un toque simple NO puede grabar. Sin
      umbral, rozar el micrófono al ir a escribir dejaba una grabación empezada
      con su aviso rojo, y la aplicación parecía tener vida propia.
    */
    assert.ok(MS_PARA_EMPEZAR > 0, 'sin umbral, un toque abre el micrófono');
    assert.ok(
      MS_PARA_EMPEZAR >= 200 && MS_PARA_EMPEZAR <= 500,
      'por debajo de 200 ms el roce vuelve a colarse; por encima de 500 el ' +
        'botón parece que no responde',
    );
  });

  it('el umbral del dedo y el mínimo del audio son cosas distintas', () => {
    /*
      Uno mide el DEDO antes de grabar; el otro mide el AUDIO ya grabado.
      Confundirlos —usar el mismo número para los dos— haría que mantener
      pulsado 300 ms empezara a grabar y produjera una nota que después se tira,
      que es la peor de las dos opciones: gasta el gesto y no manda nada.
    */
    assert.ok(MIN_DURACION_S * 1000 > MS_PARA_EMPEZAR);
  });
});
