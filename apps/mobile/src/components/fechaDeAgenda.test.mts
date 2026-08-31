/**
 * Que la agenda no ofrezca fechas que ya pasaron.
 *
 * EL FALLO: se podia proponer una sesion para el martes pasado. El calendario
 * dejaba elegir cualquier dia, el formulario lo aceptaba, la fila se creaba y
 * salia en la agenda de las dos partes.
 *
 * DONDE SE ARREGLA DE VERDAD: en el backend, con el reloj del SERVIDOR
 * (`es_momento_futuro`, en `apps/api/app/modules/bookings/schemas.py`). El reloj
 * del telefono lo elige quien lo lleva: atrasarlo un dia bastaria para colar una
 * fecha pasada si la comprobacion viviera solo aqui.
 *
 * LO QUE SE PRUEBA EN ESTE FICHERO es lo otro: que la interfaz no OFREZCA lo
 * que se va a rechazar. Un calendario que deja elegir el martes pasado para
 * despues decir que no vale se equivoca a proposito.
 *
 * Y sobre todo, que la comparacion sea de INSTANTES y no de CADENAS. «02/09/2026»
 * y «2026-09-02» son la misma fecha y dos textos distintos, y `'10:00' < '9:00'`
 * es cierto como texto: comparar fechas escritas es un fallo que parece
 * funcionar hasta que cambia el formato o llega otra zona horaria.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fromDisplay, hoyANoche, toDisplay, toIsoDate } from './DateField.types.ts';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. El limite que se le pasa al calendario
// ---------------------------------------------------------------------------
describe('el primer dia que se puede elegir', () => {
  it('es HOY, no ayer', () => {
    const hoy = new Date();
    const limite = hoyANoche();
    assert.equal(limite.getFullYear(), hoy.getFullYear());
    assert.equal(limite.getMonth(), hoy.getMonth());
    assert.equal(limite.getDate(), hoy.getDate());
  });

  it('es MEDIANOCHE y no «ahora mismo»', () => {
    /*
      Con la hora actual como limite, el dia de HOY dejaria de poder elegirse en
      cuanto pasara un minuto —el selector de dia no lleva hora—, y una sesion
      para esta tarde es lo mas normal del mundo. Que la HORA elegida tampoco
      haya pasado se comprueba aparte, ya con fecha y hora juntas.
    */
    const limite = hoyANoche();
    assert.equal(limite.getHours(), 0);
    assert.equal(limite.getMinutes(), 0);
    assert.equal(limite.getSeconds(), 0);
    assert.equal(limite.getMilliseconds(), 0);
  });

  it('no arrastra el limite de una llamada a la siguiente', () => {
    // Devolver siempre el MISMO objeto `Date` seria un error dificil de ver: un
    // `setHours` en cualquier sitio lo cambiaria para toda la aplicacion.
    assert.notEqual(hoyANoche(), hoyANoche());
    assert.equal(hoyANoche().getTime(), hoyANoche().getTime());
  });
});

// ---------------------------------------------------------------------------
// 2. El formato que entiende `<input type="date">`
// ---------------------------------------------------------------------------
describe('toIsoDate', () => {
  it('escribe aaaa-mm-dd con ceros a la izquierda', () => {
    assert.equal(toIsoDate(new Date(2026, 0, 5)), '2026-01-05');
    assert.equal(toIsoDate(new Date(2026, 11, 31)), '2026-12-31');
  });

  it('usa el dia LOCAL y no el de UTC', () => {
    /*
      Con `toISOString().slice(0,10)` —la forma corta y tentadora— una fecha de
      madrugada en una zona al este de Greenwich sale con el dia ANTERIOR, y el
      calendario dejaria elegir un dia que la aplicacion ya considera pasado.
    */
    const primeroDeMes = new Date(2026, 8, 1, 0, 30);
    assert.equal(toIsoDate(primeroDeMes), '2026-09-01');
  });
});

// ---------------------------------------------------------------------------
// 3. Ida y vuelta del formato del formulario
// ---------------------------------------------------------------------------
describe('dd/mm/aaaa', () => {
  it('sobrevive a la ida y la vuelta', () => {
    assert.equal(toDisplay(fromDisplay('02/09/2026')!), '02/09/2026');
  });

  it('rechaza una fecha imposible en vez de moverla en silencio', () => {
    // `new Date(2026, 1, 31)` es el 3 de marzo sin avisar. Aceptarlo pondria en
    // la agenda un dia que nadie eligio.
    assert.equal(fromDisplay('31/02/2026'), null);
  });
});

// ---------------------------------------------------------------------------
// 4. Que la pantalla haga lo que dice
// ---------------------------------------------------------------------------
describe('la hoja de pedir una sesion', () => {
  const hoja = fuente('components/BookSessionSheet.tsx');

  it('limita el calendario a partir de hoy', () => {
    assert.ok(
      /minDate=\{hoyANoche\(\)\}/.test(hoja),
      'El campo de fecha tiene que recibir `minDate`: sin el, el calendario ' +
        'sigue ofreciendo dias que el servidor va a rechazar.',
    );
  });

  it('compara instantes, nunca cadenas de fecha', () => {
    assert.ok(
      hoja.includes('momento.getTime() <= Date.now()'),
      'La comprobacion de «ya paso» tiene que ser entre instantes.',
    );
    assert.ok(
      !/date\s*[<>]=?\s*['"`]/.test(hoja),
      'Hay una comparacion de la fecha contra un texto: «10:00» < «9:00» es ' +
        'cierto como cadena, y eso deja pasar fechas pasadas.',
    );
  });

  it('no deja confirmar una sesion en el pasado', () => {
    assert.ok(
      /const listo = .*!yaPaso/.test(hoja),
      'El boton de confirmar tiene que apagarse si el momento ya paso.',
    );
    assert.ok(
      hoja.includes("if (yaPaso) {"),
      'Y ademas cortarlo al pulsar: el estado del boton no es una garantia.',
    );
  });
});

describe('el campo de fecha', () => {
  it('pasa el limite al selector nativo', () => {
    assert.ok(
      /minimumDate=\{minDate\}/.test(fuente('components/DateField.tsx')),
      'DateTimePicker necesita `minimumDate` para atenuar los dias pasados.',
    );
  });

  it('y al del navegador', () => {
    assert.ok(
      /min=\{minDate \? toIsoDate\(minDate\) : undefined\}/.test(
        fuente('components/DateField.web.tsx'),
      ),
      '<input type="date"> necesita `min` para lo mismo en web.',
    );
  });
});
