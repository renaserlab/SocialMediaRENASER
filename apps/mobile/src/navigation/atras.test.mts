import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  MARGEN_DE_SALIDA_MS,
  hayAtrasInstalado,
  instalarAtras,
  type EntornoDeAtras,
} from './atras.ts';
import {
  cerrarCapaSuperior,
  hayCapaAbierta,
  olvidarCapasAbiertas,
  registrarCapaAbierta,
} from './capasAbiertas.ts';

/**
 * La maquina del boton Atras: temporizadores, oyentes y limpieza.
 *
 * `decidirAtras` ya dice QUE hacer con cada pulsacion. Lo que se comprueba aqui
 * es lo otro, que es donde estaban los fallos de verdad: quien se queda el
 * evento, cuando se arma y cuando se olvida la confirmacion, y si al desmontar
 * queda algo vivo. Nada de esto se puede ver leyendo el codigo, y montar la
 * aplicacion entera para verlo es justo lo que hizo que nunca se comprobara.
 *
 * El entorno se INYECTA: el reloj, el temporizador y la suscripcion son
 * dobles. Asi los dos segundos del margen se controlan a mano en vez de
 * esperarlos, y se puede afirmar que el temporizador quedo cancelado —no solo
 * que probablemente si—.
 */

/** Un entorno de mentira con contadores, para preguntarle que paso. */
function crearEntorno(opciones: { puedeVolver?: boolean } = {}) {
  const registro = {
    suscripciones: 0,
    desuscripciones: 0,
    temporizadoresVivos: 0,
    avisos: 0,
    vueltas: 0,
    cierresDeCapa: 0,
  };

  let manejador: (() => boolean) | null = null;
  let reloj = 1_000_000;
  let olvidoPendiente: (() => void) | null = null;
  let puedeVolver = opciones.puedeVolver ?? false;

  const entorno: EntornoDeAtras = {
    suscribir: (fn) => {
      registro.suscripciones += 1;
      manejador = fn;
      return () => {
        registro.desuscripciones += 1;
        manejador = null;
      };
    },
    ahora: () => reloj,
    programar: (fn) => {
      registro.temporizadoresVivos += 1;
      olvidoPendiente = fn;
      return () => {
        registro.temporizadoresVivos -= 1;
        olvidoPendiente = null;
      };
    },
    hayCapaAbierta,
    cerrarCapa: () => {
      registro.cierresDeCapa += 1;
      cerrarCapaSuperior();
    },
    puedeVolver: () => puedeVolver,
    volver: () => {
      registro.vueltas += 1;
    },
    avisar: () => {
      registro.avisos += 1;
    },
  };

  return {
    entorno,
    registro,
    /** Pulsar Atras. Devuelve si el evento se consumio (`false` = cerrar app). */
    pulsar(): boolean {
      assert.ok(manejador, 'no hay ningun manejador suscrito');
      return manejador();
    },
    hayManejador: () => manejador !== null,
    /** Adelantar el reloj y, si el margen ya paso, disparar el olvido. */
    avanzar(ms: number) {
      reloj += ms;
      if (olvidoPendiente && ms >= MARGEN_DE_SALIDA_MS) {
        const disparar = olvidoPendiente;
        registro.temporizadoresVivos -= 1;
        olvidoPendiente = null;
        disparar();
      }
    },
    fijarPuedeVolver(valor: boolean) {
      puedeVolver = valor;
    },
  };
}

/**
 * `instalarAtras` guarda si hay algo instalado en el modulo, asi que una prueba
 * que se deje una instalacion puesta haria fallar a la siguiente por un motivo
 * que no tiene nada que ver. Se limpia siempre.
 */
const pendientesDeDesinstalar: (() => void)[] = [];

function instalar(entorno: EntornoDeAtras): () => void {
  const desinstalar = instalarAtras(entorno);
  pendientesDeDesinstalar.push(desinstalar);
  return desinstalar;
}

afterEach(() => {
  while (pendientesDeDesinstalar.length) pendientesDeDesinstalar.pop()?.();
  olvidarCapasAbiertas();
});

describe('se instala una sola vez', () => {
  it('un segundo montaje no anade un segundo oyente', () => {
    /*
      EL FALLO QUE EVITA. Con dos oyentes sobre la misma tecla, el aviso salia
      dos veces y la confirmacion se contaba en dos sitios: hacian falta cuatro
      pulsaciones para cerrar, o dos para retroceder un paso. Pasa solo con la
      recarga en caliente o si alguien anade el hook a un segundo layout, que es
      exactamente cuando nadie lo esta mirando.
    */
    const uno = crearEntorno();
    const dos = crearEntorno();
    instalar(uno.entorno);
    instalar(dos.entorno);

    assert.equal(uno.registro.suscripciones, 1);
    assert.equal(dos.registro.suscripciones, 0, 'la segunda instalacion no debe suscribir');
    assert.equal(dos.hayManejador(), false);
  });

  it('la limpieza de la instalacion ignorada no desmonta a la primera', () => {
    const uno = crearEntorno();
    const dos = crearEntorno();
    instalar(uno.entorno);
    const desinstalarLaIgnorada = instalar(dos.entorno);

    desinstalarLaIgnorada();

    assert.equal(uno.registro.desuscripciones, 0);
    assert.equal(uno.hayManejador(), true, 'la instalacion buena sigue viva');
  });

  it('tras desmontar se puede volver a instalar', () => {
    // Es el ciclo montar / desmontar / montar de la recarga en caliente y del
    // modo estricto de React.
    const primera = crearEntorno();
    instalarAtras(primera.entorno)();
    assert.equal(hayAtrasInstalado(), false);

    const segunda = crearEntorno();
    instalar(segunda.entorno);
    assert.equal(segunda.registro.suscripciones, 1);
  });
});

describe('al desmontar no queda nada vivo', () => {
  it('quita el oyente y cancela el temporizador pendiente', () => {
    const app = crearEntorno();
    const desinstalar = instalar(app.entorno);

    app.pulsar(); // avisa y arma el reloj de los 2 s
    assert.equal(app.registro.temporizadoresVivos, 1);

    desinstalar();

    assert.equal(app.registro.desuscripciones, 1, 'el oyente tiene que irse');
    assert.equal(app.registro.temporizadoresVivos, 0, 'el temporizador tambien');
    assert.equal(hayAtrasInstalado(), false);
  });

  it('desinstalar dos veces no vuelve a tocar nada', () => {
    const app = crearEntorno();
    const desinstalar = instalar(app.entorno);
    desinstalar();
    desinstalar();
    assert.equal(app.registro.desuscripciones, 1);
  });
});

describe('la doble pulsacion en la raiz', () => {
  it('la primera avisa y se queda el evento', () => {
    const app = crearEntorno({ puedeVolver: false });
    instalar(app.entorno);

    const consumido = app.pulsar();

    assert.equal(consumido, true, 'devolver false aqui cerraria la aplicacion');
    assert.equal(app.registro.avisos, 1);
    assert.equal(app.registro.vueltas, 0, 'avisar no navega');
  });

  it('la segunda dentro de 2 s deja salir', () => {
    const app = crearEntorno({ puedeVolver: false });
    instalar(app.entorno);

    app.pulsar();
    app.avanzar(1500);

    assert.equal(app.pulsar(), false, 'devolver false es lo que cierra la aplicacion');
    assert.equal(app.registro.avisos, 1, 'no se avisa dos veces');
  });

  it('pasados 2 s la confirmacion se olvida y vuelve a avisar', () => {
    const app = crearEntorno({ puedeVolver: false });
    instalar(app.entorno);

    app.pulsar();
    app.avanzar(MARGEN_DE_SALIDA_MS + 1); // dispara el olvido programado

    assert.equal(app.pulsar(), true, 'la aplicacion NO puede cerrarse aqui');
    assert.equal(app.registro.avisos, 2);
  });

  it('retroceder por el medio cancela la confirmacion pendiente', () => {
    /*
      EL CASO QUE CIERRA APLICACIONES POR SORPRESA. Se pulsa Atras en Inicio
      (sale el aviso), se toca una pestana y se pulsa Atras otra vez: esa
      segunda pulsacion tiene que RETROCEDER, no arrastrar la confirmacion de
      hace un segundo. Y la siguiente, ya sin historial, tiene que volver a
      avisar en vez de cerrar.
    */
    const app = crearEntorno({ puedeVolver: false });
    instalar(app.entorno);

    app.pulsar(); // aviso puesto
    app.fijarPuedeVolver(true);
    assert.equal(app.pulsar(), true);
    assert.equal(app.registro.vueltas, 1);
    assert.equal(app.registro.temporizadoresVivos, 0, 'el reloj de salida se cancela');

    app.fijarPuedeVolver(false);
    assert.equal(app.pulsar(), true, 'vuelve a empezar: avisa, no cierra');
    assert.equal(app.registro.avisos, 2);
  });
});

describe('mientras haya donde volver, se vuelve', () => {
  it('retrocede sin pedir confirmacion por rapido que se pulse', () => {
    const app = crearEntorno({ puedeVolver: true });
    instalar(app.entorno);

    assert.equal(app.pulsar(), true);
    assert.equal(app.pulsar(), true);
    assert.equal(app.registro.vueltas, 2);
    assert.equal(app.registro.avisos, 0, 'el aviso de salida no aparece a mitad del recorrido');
  });

  it('se retrocede AQUI, sin depender de quien escuche despues', () => {
    /*
      La version anterior devolvia `false` en este caso para que retrocediera el
      manejador de expo-router, dando por hecho que este oyente se registra
      DESPUES. Es al reves —el contenedor de expo-router es ancestro del layout
      raiz y sus efectos corren despues—, asi que aquel `false` funcionaba por
      casualidad. Se comprueba que el evento se consume y que se llama a volver.
    */
    const app = crearEntorno({ puedeVolver: true });
    instalar(app.entorno);
    assert.equal(app.pulsar(), true);
    assert.equal(app.registro.vueltas, 1);
  });
});

describe('una capa abierta se queda el Atras', () => {
  it('cierra la capa y no toca la navegacion', () => {
    const app = crearEntorno({ puedeVolver: true });
    instalar(app.entorno);

    let cerrada = false;
    registrarCapaAbierta(() => {
      cerrada = true;
    });

    assert.equal(app.pulsar(), true);
    assert.equal(cerrada, true);
    assert.equal(app.registro.vueltas, 0, 'la pantalla de debajo no se mueve');
  });

  it('con dos capas apiladas se cierra la de arriba', () => {
    const app = crearEntorno({ puedeVolver: true });
    instalar(app.entorno);

    const cerradas: string[] = [];
    registrarCapaAbierta(() => cerradas.push('hoja'));
    registrarCapaAbierta(() => cerradas.push('dialogo'));

    app.pulsar();
    assert.deepEqual(cerradas, ['dialogo']);
  });

  it('en la raiz, una capa abierta impide cerrar la aplicacion', () => {
    const app = crearEntorno({ puedeVolver: false });
    instalar(app.entorno);
    registrarCapaAbierta(() => {});

    assert.equal(app.pulsar(), true);
    assert.equal(app.pulsar(), true, 'ni siquiera dos pulsaciones seguidas cierran');
    assert.equal(app.registro.avisos, 0);
  });

  it('una capa retirada deja de contar', () => {
    // Es lo que ocurre al desmontarse la hoja: si el registro no se vaciara,
    // el Atras se quedaria atascado cerrando algo que ya no existe.
    const app = crearEntorno({ puedeVolver: true });
    instalar(app.entorno);

    const retirar = registrarCapaAbierta(() => {});
    assert.equal(hayCapaAbierta(), true);
    retirar();
    retirar(); // retirar dos veces no puede descolocar el registro
    assert.equal(hayCapaAbierta(), false);

    assert.equal(app.pulsar(), true);
    assert.equal(app.registro.vueltas, 1);
  });
});

describe('el arranque no es una invitacion a cerrar', () => {
  it('con la navegacion aun sin montar, la primera pulsacion avisa', () => {
    /*
      EL FALLO CONCRETO. El layout raiz devuelve `null` hasta que hidrata (hasta
      3 s en un telefono lento). En esa ventana no hay navegacion, `canGoBack()`
      es falso y el manejador anterior devolvia `false`: la aplicacion se
      cerraba durante la carga. Ahora ese caso es indistinguible de estar en la
      raiz, que es lo correcto: se puede salir, pero haciendolo a proposito.
    */
    const app = crearEntorno({ puedeVolver: false });
    instalar(app.entorno);

    assert.equal(app.pulsar(), true);
    assert.equal(app.registro.avisos, 1);
  });
});
