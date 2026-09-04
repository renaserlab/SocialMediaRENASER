import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CLASES_SIN_REINTENTO,
  ESPERA_BASE_MS,
  ESPERA_MAXIMA_MS,
  ESPERA_MINIMA_TRAS_LIMITE_MS,
  ESPERA_SUGERIDA_MAXIMA_MS,
  MAXIMO_DE_REINTENTOS,
  esperaAntesDeReintentar,
  planificarReintento,
} from './reintentos.ts';
import { CLASES_DE_FALLO, type ClaseDeFallo } from './maquinaDeDirecto.ts';

/**
 * CUANTAS VECES SE INSISTE Y CUANDO SE PARA.
 *
 * Lo que se comprueba es lo que cuesta dinero o bateria si esta mal:
 *
 *  - Que un 503 de «no hay proveedor» NO se reintente ni una vez. Es el estado
 *    de hoy en produccion: un bucle contra ese 503 seria una peticion cada dos
 *    segundos, en cada telefono, durante todo el rato que alguien deje la
 *    pantalla abierta.
 *  - Que un 429 espere de verdad, y obedezca al servidor si el servidor dice
 *    cuanto. Volver al segundo siguiente alarga el castigo.
 *  - Que el corte EXISTA. Sin la ultima prueba de este fichero, «nada de
 *    reintentos infinitos» es una frase en un comentario.
 *
 * `azar` se inyecta para poder afirmar milisegundos exactos: sin eso, una
 * prueba sobre esperas dispersas solo puede comprobar intervalos, y un
 * intervalo lo cumple tambien un calculo equivocado.
 */

/** Sin dispersion: el factor queda en 1 y la espera es la calculada. */
const SIN_AZAR = () => 0.5;

describe('lo que no se arregla insistiendo', () => {
  for (const clase of CLASES_SIN_REINTENTO) {
    it(`\`${clase}\` se para en seco, incluso en el primer fallo`, () => {
      const plan = planificarReintento({ intentosHechos: 0, clase });
      assert.deepEqual(plan, { reintentar: false, motivo: 'definitivo' });
    });
  }

  it('no depende del contador: ni con cero intentos hechos', () => {
    // Es la diferencia con «agotado»: un fallo definitivo no gasta intentos, se
    // salta la escalera entera.
    for (const clase of CLASES_SIN_REINTENTO) {
      for (const hechos of [0, 1, 2, 99]) {
        assert.equal(planificarReintento({ intentosHechos: hechos, clase }).reintentar, false);
      }
    }
  });

  it('las clases que SI se reintentan son las otras tres, y ninguna se olvida', () => {
    /*
      Cruce de verdad entre los dos ficheros: `maquinaDeDirecto.ts` declara las
      clases y `reintentos.ts` declara cuales descarta. Sin esta comprobacion,
      añadir una clase nueva a la maquina la dejaria callada aqui —se
      reintentaria sin que nadie lo hubiera decidido— y no fallaria nada.
    */
    const descartadas = new Set<string>(CLASES_SIN_REINTENTO);
    for (const clase of CLASES_SIN_REINTENTO) {
      assert.ok(
        (CLASES_DE_FALLO as readonly string[]).includes(clase),
        `\`${clase}\` no es una clase de fallo de la maquina`,
      );
    }
    const reintentables = CLASES_DE_FALLO.filter((c) => !descartadas.has(c));
    assert.deepEqual([...reintentables], ['limitado', 'red', 'desconocido']);
    for (const clase of reintentables) {
      assert.equal(
        planificarReintento({ intentosHechos: 0, clase }).reintentar,
        true,
        `\`${clase}\` deberia reintentarse`,
      );
    }
  });

  it('una clase que nadie ha clasificado cae del lado de reintentar', () => {
    // Equivocarse hacia aqui cuesta tres peticiones; hacia el otro lado, dejar
    // muerta una pantalla que se habria recuperado sola.
    assert.equal(planificarReintento({ intentosHechos: 0, clase: 'inventada' }).reintentar, true);
  });
});

describe('la escalera de esperas', () => {
  it('se duplica en cada intento', () => {
    const esperas = [0, 1, 2].map((hechos) => {
      const plan = planificarReintento({ intentosHechos: hechos, clase: 'red', azar: SIN_AZAR });
      assert.equal(plan.reintentar, true);
      return plan.reintentar ? plan.enMs : -1;
    });
    assert.deepEqual(esperas, [ESPERA_BASE_MS, ESPERA_BASE_MS * 2, ESPERA_BASE_MS * 4]);
  });

  it('numera los intentos desde uno', () => {
    const plan = planificarReintento({ intentosHechos: 0, clase: 'red' });
    assert.equal(plan.reintentar && plan.intento, 1);
    const segundo = planificarReintento({ intentosHechos: 1, clase: 'red' });
    assert.equal(segundo.reintentar && segundo.intento, 2);
  });

  it('la dispersion se mueve entre el 75 % y el 125 %, y nunca mas', () => {
    /*
      Cuando un directo se cae, se cae para todo el mundo a la vez. Sin
      dispersion, mil telefonos vuelven a pedir credencial en el mismo
      milisegundo y tiran el endpoint justo cuando intenta levantarse.
    */
    const base = ESPERA_BASE_MS;
    const minimo = planificarReintento({ intentosHechos: 0, clase: 'red', azar: () => 0 });
    const maximo = planificarReintento({ intentosHechos: 0, clase: 'red', azar: () => 0.999999 });
    assert.equal(minimo.reintentar && minimo.enMs, Math.round(base * 0.75));
    assert.ok(maximo.reintentar && maximo.enMs <= Math.round(base * 1.25));
    assert.ok(maximo.reintentar && maximo.enMs > minimo.reintentar && minimo.enMs > 0);
  });

  it('una fuente de azar rota no rompe la espera', () => {
    // `NaN`, negativos o valores fuera de rango se ignoran y queda la espera
    // calculada: una espera de `NaN` en un `setTimeout` dispara al instante.
    for (const roto of [Number.NaN, -1, 1, 7, Number.POSITIVE_INFINITY]) {
      const plan = planificarReintento({ intentosHechos: 0, clase: 'red', azar: () => roto });
      assert.equal(plan.reintentar && plan.enMs, ESPERA_BASE_MS, `azar=${String(roto)}`);
    }
  });

  it('un contador roto se trata como «ninguno todavia», nunca como agotado', () => {
    // Un `NaN` por una resta con `undefined` no puede cortar un reintento
    // legitimo.
    for (const roto of [Number.NaN, -5, Number.POSITIVE_INFINITY * 0]) {
      const plan = planificarReintento({ intentosHechos: roto, clase: 'red', azar: SIN_AZAR });
      assert.equal(plan.reintentar, true, `intentosHechos=${String(roto)}`);
      assert.equal(plan.reintentar && plan.enMs, ESPERA_BASE_MS);
    }
  });

  it('nunca pasa del tope aunque el exponente se dispare', () => {
    // Se comprueba con la escalera desactivada por el tope, no con el numero
    // magico: si mañana el maximo sube, esta prueba sigue diciendo la verdad.
    const casi = MAXIMO_DE_REINTENTOS - 1;
    const plan = planificarReintento({ intentosHechos: casi, clase: 'red', azar: () => 0.999999 });
    assert.ok(plan.reintentar && plan.enMs <= Math.round(ESPERA_MAXIMA_MS * 1.25));
  });
});

describe('el limite de ritmo (429) tiene sus propias reglas', () => {
  it('espera bastante mas que un fallo de red normal', () => {
    const red = planificarReintento({ intentosHechos: 0, clase: 'red', azar: SIN_AZAR });
    const limite = planificarReintento({ intentosHechos: 0, clase: 'limitado', azar: SIN_AZAR });
    assert.equal(limite.reintentar && limite.enMs, ESPERA_MINIMA_TRAS_LIMITE_MS);
    assert.ok(limite.reintentar && red.reintentar && limite.enMs > red.enMs);
  });

  it('obedece al servidor cuando el servidor dice cuanto esperar', () => {
    const plan = planificarReintento({
      intentosHechos: 0,
      clase: 'limitado',
      esperaSugeridaMs: 12_000,
      azar: () => 0,
    });
    // Ni dispersado hacia abajo ni recortado: volver antes de lo que pide el
    // servidor es ganarse otro 429 y gastar un intento para nada.
    assert.equal(plan.reintentar && plan.enMs, 12_000);
  });

  it('si la sugerencia es menor que el piso, manda el piso', () => {
    const plan = planificarReintento({
      intentosHechos: 0,
      clase: 'limitado',
      esperaSugeridaMs: 200,
      azar: SIN_AZAR,
    });
    assert.equal(plan.reintentar && plan.enMs, ESPERA_MINIMA_TRAS_LIMITE_MS);
  });

  it('una sugerencia absurda se lee como «vuelve mas tarde» y se para', () => {
    // Dejar la pantalla esperando minutos sin nada que mirar no es reintentar:
    // es colgarse en silencio. Se para y decide la persona.
    const plan = planificarReintento({
      intentosHechos: 0,
      clase: 'limitado',
      esperaSugeridaMs: ESPERA_SUGERIDA_MAXIMA_MS + 1,
    });
    assert.deepEqual(plan, { reintentar: false, motivo: 'agotado' });
  });

  it('una sugerencia que no es un numero util se ignora', () => {
    for (const basura of [0, -1, Number.NaN, null, undefined]) {
      const plan = planificarReintento({
        intentosHechos: 0,
        clase: 'limitado',
        esperaSugeridaMs: basura as number | null | undefined,
        azar: SIN_AZAR,
      });
      assert.equal(plan.reintentar && plan.enMs, ESPERA_MINIMA_TRAS_LIMITE_MS);
    }
  });

  it('la sugerencia NO se aplica a un fallo que no es de ritmo', () => {
    // `Retry-After` sobre un 500 no significa lo mismo, y respetarlo alargaria
    // sin motivo una recuperacion que suele ser inmediata.
    const plan = planificarReintento({
      intentosHechos: 0,
      clase: 'red',
      esperaSugeridaMs: 12_000,
      azar: SIN_AZAR,
    });
    assert.equal(plan.reintentar && plan.enMs, ESPERA_BASE_MS);
  });
});

describe('EL CORTE: no hay reintentos infinitos', () => {
  it(`al reintento numero ${MAXIMO_DE_REINTENTOS} se acaba`, () => {
    const plan = planificarReintento({ intentosHechos: MAXIMO_DE_REINTENTOS, clase: 'red' });
    assert.deepEqual(plan, { reintentar: false, motivo: 'agotado' });
  });

  it('un bucle que siga el plan TERMINA, y termina donde dice el tope', () => {
    /*
      Esta es la prueba que de verdad importa, y no compara ninguna constante:
      se ejecuta el bucle que ejecutaria la maquina y se cuenta cuantas veces
      da la vuelta. Si alguien rompiera la condicion de parada, esto no
      terminaria —y el limite de vueltas lo delataria— en vez de pasar callando.
    */
    let hechos = 0;
    let vueltas = 0;
    const esperas: number[] = [];
    while (vueltas < 1000) {
      vueltas += 1;
      const espera = esperaAntesDeReintentar(hechos, 'red');
      if (espera === null) break;
      esperas.push(espera);
      hechos += 1;
    }
    assert.ok(vueltas < 1000, 'el bucle de reintentos no termina');
    assert.equal(esperas.length, MAXIMO_DE_REINTENTOS);
    assert.equal(esperaAntesDeReintentar(hechos, 'red'), null);
  });

  it('y con un fallo definitivo el bucle no da ni una vuelta', () => {
    assert.equal(esperaAntesDeReintentar(0, 'sin_proveedor'), null);
  });

  it('el adaptador dice lo mismo que el plan completo', () => {
    // `esperaAntesDeReintentar` es lo que consume la maquina. Si se desviara
    // del plan, la maquina reintentaria segun otras reglas que las probadas.
    for (const clase of CLASES_DE_FALLO as readonly ClaseDeFallo[]) {
      for (const hechos of [0, 1, 2, 3, 4]) {
        const plan = planificarReintento({ intentosHechos: hechos, clase });
        const corto = esperaAntesDeReintentar(hechos, clase);
        assert.equal(corto, plan.reintentar ? plan.enMs : null, `${clase}/${hechos}`);
      }
    }
  });
});
