import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAXIMO_DE_BURBUJAS,
  TIC_DE_BURBUJAS_MS,
  crearPistaDeBurbujas,
  type Burbuja,
} from './burbujas.ts';
import { asentar, crearRedDeBroadcast, crearReloj, type Reloj } from './dobles/enMemoria.mts';
import {
  CADUCIDAD_DE_PENDIENTES_MS,
  LIMITE_DE_RESUMEN,
  MAXIMO_POR_MENSAJE,
  REACCIONES,
  TOPE_DE_PENDIENTES,
  VENTANA_DE_ENVIO_MS,
  acotarResumen,
  conciliarConElServidor,
  crearCanalDeReacciones,
  cuantasHay,
  esReaccion,
  leerReaccionRemota,
  reaccionesVacias,
  sumarReacciones,
  topicoDeReacciones,
  type ConteoDeReacciones,
  type TipoDeReaccion,
  type TransporteDeBroadcast,
} from './reaccionesEnVivo.ts';

/**
 * LAS REACCIONES ENTRE VARIOS TELEFONOS.
 *
 * EL DEFECTO QUE MOTIVO ESTO (04/10/2026): cada telefono abria el canal de
 * reacciones con un contador LOCAL en el topico, asi que anfitrion y
 * espectadores estaban en topicos distintos. Quien pulsaba veia su corazon
 * —no pasa por la red— y los demas no veian nada.
 *
 * NADA DE ESTO BUSCA TEXTO EN UN FICHERO. Se montan varios clientes sobre una
 * red en memoria que reparte por topico, y se comprueba lo que RECIBE cada
 * uno. La primera bateria reproduce el defecto tal cual era, para que conste
 * que esta red lo habria cazado.
 *
 * Aqui la red es un doble a la altura del TRANSPORTE. Que el transporte de
 * verdad se comporte asi sobre Supabase Realtime se comprueba aparte, con el
 * cliente instalado: `reaccionesConElClienteReal.test.mts`.
 */

const INTERVALO_DE_RESUMEN_MS = 5_000;
const DURACION_DE_BURBUJA_MS = 1_400;

type Telefono = {
  /** Lo que hace `ReaccionesDeDirecto` cuando se pulsa un boton. */
  pulsar: (tipo: TipoDeReaccion) => void;
  salir: () => void;
  contador: () => ConteoDeReacciones;
  enPantalla: () => number;
  picoEnPantalla: () => number;
  resumenes: Partial<ConteoDeReacciones>[];
  canal: ReturnType<typeof crearCanalDeReacciones>;
  pista: ReturnType<typeof crearPistaDeBurbujas<TipoDeReaccion>>;
};

/**
 * Un telefono dentro de una emision: canal, pista de burbujas y contador,
 * cableados como los cablea `components/live/ReaccionesDeDirecto.tsx`.
 */
function telefono(
  transporte: TransporteDeBroadcast | null,
  reloj: Reloj,
  emisionId: string,
  opciones: {
    totales?: ConteoDeReacciones;
    /** Lo que contesta el servidor al resumen. */
    servidor?: (lote: Partial<ConteoDeReacciones>) => ConteoDeReacciones | void;
  } = {},
): Telefono {
  let contador = opciones.totales ?? reaccionesVacias();
  let visibles: readonly Burbuja<TipoDeReaccion>[] = [];
  let pico = 0;
  const resumenes: Partial<ConteoDeReacciones>[] = [];
  const conocidas = new Set<number>();

  const pista = crearPistaDeBurbujas<TipoDeReaccion>({
    programar: reloj.programar,
    alCambiar: (lista) => {
      visibles = lista;
      if (lista.length > pico) pico = lista.length;
      // Cada burbuja nueva se quita sola al acabar de subir, como en pantalla.
      for (const burbuja of lista) {
        if (conocidas.has(burbuja.clave)) continue;
        conocidas.add(burbuja.clave);
        reloj.programar(() => pista.quitar(burbuja.clave), DURACION_DE_BURBUJA_MS);
      }
    },
    alSumar: (conteos) => {
      contador = sumarReacciones(contador, conteos);
    },
  });

  const canal = crearCanalDeReacciones({
    emisionId,
    transporte,
    resumir: async (lote) => {
      resumenes.push(lote);
      return opciones.servidor?.(lote);
    },
    esCierreDeReacciones: (error) =>
      (error as { code?: string } | null)?.code === 'live_reactions_closed',
    intervaloDeResumenMs: INTERVALO_DE_RESUMEN_MS,
    programar: reloj.programar,
    ahora: reloj.ahora,
    alResumir: (totales) => {
      contador = conciliarConElServidor(contador, totales);
    },
  });
  const dejar = canal.alRecibir((conteos) => pista.recibir(conteos));

  return {
    pulsar(tipo) {
      pista.soltarPropia(tipo);
      contador = sumarReacciones(contador, { [tipo]: 1 });
      canal.enviar(tipo);
    },
    salir() {
      dejar();
      canal.cerrar();
      pista.destruir();
    },
    contador: () => contador,
    enPantalla: () => visibles.length,
    picoEnPantalla: () => pico,
    resumenes,
    canal,
    pista,
  };
}

/** Una sala con anfitrion y dos espectadores en la misma emision. */
function sala(emisionId = 'e1') {
  const red = crearRedDeBroadcast();
  const reloj = crearReloj();
  const anfitrion = telefono(red.telefono('anfitrion'), reloj, emisionId);
  const ana = telefono(red.telefono('ana'), reloj, emisionId);
  const luis = telefono(red.telefono('luis'), reloj, emisionId);
  return { red, reloj, anfitrion, ana, luis };
}

/* ========================================================================= */

describe('EL DEFECTO ORIGINAL: un contador local en el topico', () => {
  /**
   * El transporte tal y como estaba: cada telefono le pega al topico su
   * propio contador, que vale lo que valga segun cuantos canales haya abierto
   * antes ese telefono.
   */
  function conContadorLocal(
    transporte: TransporteDeBroadcast,
    canalesAbiertosAntes: number,
  ): TransporteDeBroadcast {
    let secuencia = canalesAbiertosAntes;
    return {
      abrir(topico, oyente) {
        secuencia += 1;
        return transporte.abrir(`${topico}:${secuencia}`, oyente);
      },
    };
  }

  it('con el contador, quien pulsa se ve y los demas no ven nada', () => {
    const red = crearRedDeBroadcast();
    const reloj = crearReloj();
    // Ana ha abierto 3 canales antes de entrar; el anfitrion, 7.
    const ana = telefono(conContadorLocal(red.telefono('ana'), 3), reloj, 'e1');
    const anfitrion = telefono(conContadorLocal(red.telefono('anfitrion'), 7), reloj, 'e1');

    ana.pulsar('corazon');
    reloj.avanzar(TIC_DE_BURBUJAS_MS * 2);

    assert.notEqual(red.topicosDe('ana')[0], red.topicosDe('anfitrion')[0]);
    // El sintoma exacto que se vio en los telefonos:
    assert.equal(ana.enPantalla(), 1, 'la propia se ve: no pasa por la red');
    assert.equal(anfitrion.enPantalla(), 0, 'el anfitrion no ve nada');
    assert.equal(anfitrion.contador().corazon, 0);
    assert.equal(red.cuenta.entregas, 0, 'el mensaje salio y no lo recibio nadie');
  });

  it('con el topico canonico, dos telefonos con historias distintas coinciden', () => {
    const red = crearRedDeBroadcast();
    const reloj = crearReloj();
    // Antes de entrar en `e1`, cada uno ha pasado por otras emisiones.
    for (const otra of ['a', 'b', 'c']) telefono(red.telefono('ana'), reloj, otra).salir();
    for (const otra of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      telefono(red.telefono('anfitrion'), reloj, otra).salir();
    }
    telefono(red.telefono('ana'), reloj, 'e1');
    telefono(red.telefono('anfitrion'), reloj, 'e1');

    const deAna = red.topicosDe('ana').at(-1);
    const delAnfitrion = red.topicosDe('anfitrion').at(-1);
    assert.equal(deAna, 'live-reacciones:e1');
    assert.equal(deAna, delAnfitrion, 'no comparten topico: no comparten sala');
  });

  it('el topico solo depende de la emision', () => {
    assert.equal(topicoDeReacciones('abc'), 'live-reacciones:abc');
    // Llamarlo muchas veces no cambia nada: no hay estado detras.
    for (let i = 0; i < 10; i += 1) assert.equal(topicoDeReacciones('abc'), 'live-reacciones:abc');
    assert.notEqual(topicoDeReacciones('abc'), topicoDeReacciones('abd'));
  });
});

describe('anfitrion y espectadores en la misma emision', () => {
  it('lo que pulsa un espectador lo recibe el otro espectador', () => {
    const { reloj, ana, luis } = sala();
    ana.pulsar('fuego');
    reloj.avanzar(TIC_DE_BURBUJAS_MS);
    assert.equal(luis.contador().fuego, 1);
    assert.equal(luis.enPantalla(), 1);
  });

  it('lo que pulsa un espectador lo recibe el anfitrion', () => {
    const { reloj, ana, anfitrion } = sala();
    ana.pulsar('aplauso');
    reloj.avanzar(TIC_DE_BURBUJAS_MS);
    assert.equal(anfitrion.contador().aplauso, 1);
    assert.equal(anfitrion.enPantalla(), 1);
  });

  it('lo que pulsa el anfitrion lo reciben los dos espectadores', () => {
    const { reloj, ana, luis, anfitrion } = sala();
    anfitrion.pulsar('risa');
    reloj.avanzar(TIC_DE_BURBUJAS_MS);
    assert.equal(ana.contador().risa, 1);
    assert.equal(luis.contador().risa, 1);
  });

  it('quien pulsa NO recibe su propia reaccion: la ve una vez y la cuenta una vez', () => {
    const { red, reloj, ana } = sala();
    ana.pulsar('corazon');
    reloj.avanzar(TIC_DE_BURBUJAS_MS * 3);
    assert.equal(ana.canal.diagnostico().recibidos, 0, 'le ha vuelto su propio mensaje');
    assert.equal(ana.contador().corazon, 1);
    assert.equal(ana.pista.diagnostico().pintadas, 1);
    // Un envio, dos entregas (anfitrion y Luis), ninguna a Ana.
    assert.equal(red.cuenta.enviados, 1);
    assert.equal(red.cuenta.entregas, 2);
  });

  it('quien se va deja de recibir, y no deja canal detras', () => {
    const { red, reloj, ana, luis, anfitrion } = sala();
    luis.salir();
    assert.equal(red.abiertos('live-reacciones:e1'), 2);

    ana.pulsar('corazon');
    reloj.avanzar(TIC_DE_BURBUJAS_MS);
    assert.equal(luis.contador().corazon, 0);
    assert.equal(luis.enPantalla(), 0);
    assert.equal(anfitrion.contador().corazon, 1, 'los que siguen dentro siguen recibiendo');
    assert.equal(red.cuenta.entregas, 1);
  });

  it('una emision nunca recibe las reacciones de otra', () => {
    const red = crearRedDeBroadcast();
    const reloj = crearReloj();
    const enUna = telefono(red.telefono('ana'), reloj, 'e1');
    const enOtra = telefono(red.telefono('luis'), reloj, 'e2');
    const tambienEnOtra = telefono(red.telefono('marta'), reloj, 'e2');

    enUna.pulsar('corazon');
    reloj.avanzar(TIC_DE_BURBUJAS_MS);
    assert.deepEqual(enOtra.contador(), reaccionesVacias());
    assert.equal(enOtra.enPantalla(), 0);

    enOtra.pulsar('fuego');
    reloj.avanzar(TIC_DE_BURBUJAS_MS);
    assert.equal(tambienEnOtra.contador().fuego, 1);
    assert.equal(enUna.contador().fuego, 0);
  });

  it('salir y volver a entrar: recibe otra vez, y una sola vez', () => {
    const { red, reloj, ana } = sala();
    const primera = telefono(red.telefono('marta'), reloj, 'e1');
    primera.salir();
    const segunda = telefono(red.telefono('marta'), reloj, 'e1');

    ana.pulsar('corazon');
    reloj.avanzar(TIC_DE_BURBUJAS_MS);
    assert.equal(primera.contador().corazon, 0, 'la pantalla que se cerro sigue escuchando');
    assert.equal(segunda.contador().corazon, 1);
    assert.equal(segunda.pista.diagnostico().pintadas, 1);
  });
});

describe('lo que llega por el canal lo ha escrito OTRO: se valida', () => {
  const INVALIDOS: unknown[] = [
    null,
    undefined,
    'corazon',
    42,
    true,
    [],
    ['corazon'],
    {},
    { tipo: 'bomba' },
    { tipo: 7 },
    { conteos: null },
    { conteos: 'muchos' },
    { conteos: [] },
    { conteos: {} },
    { conteos: { inventada: 5 } },
    { conteos: { corazon: 'tres' } },
    { conteos: { corazon: 0 } },
    { conteos: { corazon: -3 } },
    { conteos: { corazon: Number.NaN } },
    { conteos: { corazon: 0.4 } },
  ];

  it('un payload deforme se ignora y no lanza', () => {
    for (const carga of INVALIDOS) {
      assert.doesNotThrow(() => leerReaccionRemota(carga));
      assert.equal(leerReaccionRemota(carga), null, JSON.stringify(carga));
    }
  });

  it('solo cuentan los cinco tipos de REACCIONES', () => {
    assert.deepEqual([...REACCIONES], ['corazon', 'aplauso', 'fuego', 'asombro', 'risa']);
    assert.deepEqual(leerReaccionRemota({ conteos: { corazon: 2, inventada: 9, risa: 1 } }), {
      corazon: 2,
      risa: 1,
    });
    assert.equal(esReaccion('corazon'), true);
    assert.equal(esReaccion('Corazon'), false);
    assert.equal(esReaccion(null), false);
  });

  it('un toque suelto (`{ tipo }`) tambien se entiende', () => {
    assert.deepEqual(leerReaccionRemota({ tipo: 'fuego' }), { fuego: 1 });
  });

  it('una cantidad desorbitada se RECORTA: nadie pone un millon de corazones de un mensaje', () => {
    assert.deepEqual(leerReaccionRemota({ conteos: { corazon: 1_000_000 } }), {
      corazon: MAXIMO_POR_MENSAJE,
    });
    assert.deepEqual(leerReaccionRemota({ conteos: { corazon: Number.POSITIVE_INFINITY } }), null);
    assert.deepEqual(leerReaccionRemota({ conteos: { corazon: 2.9 } }), { corazon: 2 });
  });

  it('en la sala: lo deforme no pinta, no cuenta y no rompe a nadie', () => {
    const { red, reloj, ana } = sala();
    for (const carga of INVALIDOS) {
      assert.doesNotThrow(() => red.inyectar('live-reacciones:e1', carga));
    }
    reloj.avanzar(TIC_DE_BURBUJAS_MS * 3);
    assert.deepEqual(ana.contador(), reaccionesVacias());
    assert.equal(ana.enPantalla(), 0);
    assert.equal(ana.canal.diagnostico().invalidos, INVALIDOS.length);
    assert.equal(ana.canal.diagnostico().recibidos, 0);
  });

  it('un oyente que revienta no sale hacia la red ni corta a los demas', () => {
    const red = crearRedDeBroadcast();
    const reloj = crearReloj();
    const ana = telefono(red.telefono('ana'), reloj, 'e1');
    let recibidas = 0;
    ana.canal.alRecibir(() => {
      throw new Error('un componente roto');
    });
    ana.canal.alRecibir(() => {
      recibidas += 1;
    });
    assert.doesNotThrow(() => red.inyectar('live-reacciones:e1', { conteos: { corazon: 1 } }));
    assert.equal(recibidas, 1);
  });
});

describe('antes de `SUBSCRIBED`: no se pierde todo, y no se guarda sin limite', () => {
  it('lo pulsado antes de suscribirse sale junto, UNA vez, al confirmar', () => {
    const red = crearRedDeBroadcast();
    const reloj = crearReloj();
    const luis = telefono(red.telefono('luis'), reloj, 'e1');
    const ana = telefono(red.telefono('ana', { suscribeSolo: false }), reloj, 'e1');

    ana.pulsar('corazon');
    ana.pulsar('corazon');
    ana.pulsar('fuego');
    reloj.avanzar(VENTANA_DE_ENVIO_MS * 3);
    // La animacion propia no espera a nadie.
    assert.equal(ana.contador().corazon, 2);
    // Y a la red no se le ha dado nada: ni entregado ni rechazado.
    assert.equal(red.cuenta.enviados, 0);
    assert.equal(red.cuenta.rechazados, 0, 'se intento enviar sin suscripcion');
    assert.equal(ana.canal.diagnostico().pendientes, 3);

    red.confirmar('ana');
    reloj.avanzar(TIC_DE_BURBUJAS_MS);
    assert.equal(red.cuenta.enviados, 1, 'tres toques, un mensaje');
    assert.equal(luis.contador().corazon, 2);
    assert.equal(luis.contador().fuego, 1);
    assert.equal(ana.canal.diagnostico().pendientes, 0);

    // Y no vuelve a salir.
    reloj.avanzar(VENTANA_DE_ENVIO_MS * 10);
    assert.equal(red.cuenta.enviados, 1);
  });

  it('la cola de pendientes tiene tope: lo que pasa de ahi se descarta', () => {
    const red = crearRedDeBroadcast();
    const reloj = crearReloj();
    const ana = telefono(red.telefono('ana', { suscribeSolo: false }), reloj, 'e1');
    for (let i = 0; i < 500; i += 1) ana.pulsar('corazon');
    const diagnostico = ana.canal.diagnostico();
    assert.equal(diagnostico.pendientes, TOPE_DE_PENDIENTES);
    assert.equal(diagnostico.colaMaxima, TOPE_DE_PENDIENTES);
    assert.equal(diagnostico.descartados, 500 - TOPE_DE_PENDIENTES);
  });

  it('una reaccion que tarda demasiado en poder salir ya no sale', () => {
    const red = crearRedDeBroadcast();
    const reloj = crearReloj();
    const luis = telefono(red.telefono('luis'), reloj, 'e1');
    const ana = telefono(red.telefono('ana', { suscribeSolo: false }), reloj, 'e1');
    ana.pulsar('corazon');
    ana.pulsar('corazon');
    reloj.avanzar(CADUCIDAD_DE_PENDIENTES_MS + 1);

    red.confirmar('ana');
    reloj.avanzar(TIC_DE_BURBUJAS_MS);
    assert.equal(red.cuenta.enviados, 0, 'salieron corazones de hace diez segundos');
    assert.equal(luis.contador().corazon, 0);
    assert.equal(ana.canal.diagnostico().descartados, 2);
    assert.equal(ana.canal.diagnostico().pendientes, 0);
  });

  it('sin tiempo real: se cuenta para el servidor, y no se reparte', () => {
    const reloj = crearReloj();
    const ana = telefono(null, reloj, 'e1');
    ana.pulsar('corazon');
    reloj.avanzar(INTERVALO_DE_RESUMEN_MS);
    assert.deepEqual(ana.resumenes, [{ corazon: 1 }]);
    assert.equal(ana.canal.diagnostico().pendientes, 0);
    assert.equal(ana.canal.diagnostico().enviados, 0);
  });
});

describe('RAFAGAS: el control de carga', () => {
  it('un toque suelto sale al momento, sin esperar a ninguna ventana', () => {
    const { red, ana } = sala();
    ana.pulsar('corazon');
    assert.equal(red.cuenta.enviados, 1);
  });

  it('una rafaga viaja agrupada: tipo y cantidad, no un mensaje por toque', () => {
    const { red, reloj, ana, luis } = sala();
    for (let i = 0; i < 9; i += 1) ana.pulsar('corazon');
    ana.pulsar('fuego');
    assert.equal(red.cuenta.enviados, 1, 'el primero sale; los demas esperan la ventana');

    reloj.avanzar(VENTANA_DE_ENVIO_MS);
    assert.equal(red.cuenta.enviados, 2, 'diez toques: dos mensajes');

    reloj.avanzar(TIC_DE_BURBUJAS_MS);
    // El contador de quien mira lleva la cuenta ENTERA, no la de mensajes.
    assert.equal(luis.contador().corazon, 9);
    assert.equal(luis.contador().fuego, 1);
  });

  it('500 toques no son 500 mensajes ni 500 burbujas, y la cola vuelve a cero', () => {
    const { red, reloj, ana, luis } = sala();
    for (let i = 0; i < 500; i += 1) ana.pulsar('corazon');

    // QUIEN PULSA: respuesta inmediata, y nunca mas burbujas que el tope.
    assert.equal(ana.contador().corazon, 500);
    assert.equal(ana.enPantalla(), MAXIMO_DE_BURBUJAS);
    assert.equal(ana.picoEnPantalla(), MAXIMO_DE_BURBUJAS);

    // LA RED: un mensaje ya, y el resto en ventanas de `MAXIMO_POR_MENSAJE`.
    let pico = 0;
    for (let t = 0; t < 40; t += 1) {
      reloj.avanzar(TIC_DE_BURBUJAS_MS);
      pico = Math.max(pico, luis.enPantalla());
    }
    const diagnostico = ana.canal.diagnostico();
    const esperados = 1 + Math.ceil(TOPE_DE_PENDIENTES / MAXIMO_POR_MENSAJE);
    assert.equal(red.cuenta.enviados, esperados, 'mensajes de Broadcast para 500 toques');
    assert.ok(red.cuenta.enviados < 10);
    assert.equal(diagnostico.pendientes, 0, 'la cola de salida no volvio a cero');
    assert.equal(diagnostico.descartados, 500 - 1 - TOPE_DE_PENDIENTES);
    assert.equal(diagnostico.colaMaxima, TOPE_DE_PENDIENTES);

    // QUIEN MIRA: una muestra, nunca por encima del tope, y la cola se vacia.
    assert.ok(pico <= MAXIMO_DE_BURBUJAS, `llego a haber ${pico} burbujas`);
    assert.ok(luis.picoEnPantalla() <= MAXIMO_DE_BURBUJAS);
    assert.equal(luis.contador().corazon, 1 + TOPE_DE_PENDIENTES);
    reloj.avanzar(DURACION_DE_BURBUJA_MS * 3);
    assert.equal(luis.pista.diagnostico().enEspera, 0);
    assert.equal(luis.enPantalla(), 0);
    assert.equal(ana.enPantalla(), 0);
  });

  it('el resumen al servidor lleva lo pulsado, hasta lo que el servidor admite', () => {
    const { reloj, ana } = sala();
    for (let i = 0; i < 500; i += 1) ana.pulsar('corazon');
    reloj.avanzar(INTERVALO_DE_RESUMEN_MS);
    assert.equal(ana.resumenes.length, 1, 'un resumen, no uno por toque');
    assert.equal(cuantasHay(ana.resumenes[0] ?? {}), LIMITE_DE_RESUMEN);
  });

  it('acotar el resumen recorta en el orden del servidor y no inventa', () => {
    assert.deepEqual(acotarResumen({ corazon: 150, fuego: 100, risa: 30 }), {
      corazon: 150,
      fuego: 50,
    });
    assert.deepEqual(acotarResumen({ corazon: 3 }), { corazon: 3 });
    assert.deepEqual(acotarResumen({ corazon: 0, fuego: -2 }), {});
  });

  it('pocos toques: el resumen lleva exactamente esos, y solo cada cinco segundos', () => {
    const { reloj, ana } = sala();
    ana.pulsar('corazon');
    ana.pulsar('risa');
    reloj.avanzar(INTERVALO_DE_RESUMEN_MS - 1);
    assert.equal(ana.resumenes.length, 0);
    reloj.avanzar(1);
    assert.deepEqual(ana.resumenes, [{ corazon: 1, risa: 1 }]);
    // Sin toques nuevos no hay mas resumenes.
    reloj.avanzar(INTERVALO_DE_RESUMEN_MS * 4);
    assert.equal(ana.resumenes.length, 1);
  });

  it('salir manda lo que quedaba por resumir', () => {
    const { ana } = sala();
    ana.pulsar('corazon');
    ana.salir();
    assert.deepEqual(ana.resumenes, [{ corazon: 1 }]);
  });

  it('si el servidor dice que las reacciones estan cerradas, deja de preguntar', async () => {
    const reloj = crearReloj();
    let peticiones = 0;
    const canal = crearCanalDeReacciones({
      emisionId: 'e1',
      transporte: null,
      resumir: async () => {
        peticiones += 1;
        throw { code: 'live_reactions_closed' };
      },
      esCierreDeReacciones: (error) => (error as { code?: string }).code === 'live_reactions_closed',
      intervaloDeResumenMs: INTERVALO_DE_RESUMEN_MS,
      programar: reloj.programar,
      ahora: reloj.ahora,
    });
    canal.enviar('corazon');
    reloj.avanzar(INTERVALO_DE_RESUMEN_MS);
    await asentar();
    canal.enviar('corazon');
    reloj.avanzar(INTERVALO_DE_RESUMEN_MS * 3);
    await asentar();
    assert.equal(peticiones, 1);
  });
});

describe('el contador: cada reaccion cuenta una vez', () => {
  it('la propia suma una, la ajena suma una', () => {
    const { reloj, ana, luis } = sala();
    ana.pulsar('corazon');
    luis.pulsar('corazon');
    reloj.avanzar(VENTANA_DE_ENVIO_MS);
    reloj.avanzar(TIC_DE_BURBUJAS_MS);
    assert.equal(ana.contador().corazon, 2);
    assert.equal(luis.contador().corazon, 2);
  });

  it('lo que contesta el servidor NO se suma encima de lo ya contado', () => {
    const base = { ...reaccionesVacias(), corazon: 5 };
    // El servidor confirma los mismos cinco: nada cambia, ni la referencia.
    assert.equal(conciliarConElServidor(base, { ...reaccionesVacias(), corazon: 5 }), base);
    // El servidor sabe de dos mas que aqui no llegaron: se toma su numero.
    assert.equal(
      conciliarConElServidor(base, { ...reaccionesVacias(), corazon: 7 }).corazon,
      7,
      'se ha sumado en vez de conciliar',
    );
    // El servidor va por detras: el numero no retrocede.
    assert.equal(conciliarConElServidor(base, { ...reaccionesVacias(), corazon: 3 }), base);
  });

  it('en la sala: tras el resumen, el contador sigue siendo el mismo', async () => {
    const red = crearRedDeBroadcast();
    const reloj = crearReloj();
    // Un servidor que suma lo que recibe, como el de verdad.
    let persistido = { ...reaccionesVacias(), corazon: 10 };
    const servidor = (lote: Partial<ConteoDeReacciones>) => {
      persistido = sumarReacciones(persistido, lote);
      return persistido;
    };
    const ana = telefono(red.telefono('ana'), reloj, 'e1', { totales: { ...persistido }, servidor });
    const luis = telefono(red.telefono('luis'), reloj, 'e1', { totales: { ...persistido }, servidor });

    ana.pulsar('corazon');
    ana.pulsar('corazon');
    luis.pulsar('corazon');
    reloj.avanzar(VENTANA_DE_ENVIO_MS);
    reloj.avanzar(TIC_DE_BURBUJAS_MS);
    assert.equal(ana.contador().corazon, 13);
    assert.equal(luis.contador().corazon, 13);

    reloj.avanzar(INTERVALO_DE_RESUMEN_MS);
    await asentar();
    assert.equal(persistido.corazon, 13);
    assert.equal(ana.contador().corazon, 13, 'el resumen ha contado dos veces');
    assert.equal(luis.contador().corazon, 13, 'el resumen ha contado dos veces');
  });

  it('sumar no toca el objeto que recibe: es estado de React', () => {
    const antes = reaccionesVacias();
    const despues = sumarReacciones(antes, { corazon: 2 });
    assert.equal(antes.corazon, 0);
    assert.equal(despues.corazon, 2);
    assert.notEqual(antes, despues);
  });
});

describe('caidas y reconexiones', () => {
  it('una caida no provoca un reenvio doble', () => {
    const { red, reloj, ana, luis } = sala();
    ana.pulsar('corazon');
    assert.equal(red.cuenta.enviados, 1);

    red.cortar('ana');
    ana.pulsar('corazon');
    ana.pulsar('corazon');
    reloj.avanzar(VENTANA_DE_ENVIO_MS * 2);
    assert.equal(red.cuenta.enviados, 1, 'salio algo sin canal');
    assert.equal(red.cuenta.rechazados, 0);

    red.restablecer('ana');
    reloj.avanzar(VENTANA_DE_ENVIO_MS * 5);
    reloj.avanzar(TIC_DE_BURBUJAS_MS);
    assert.equal(red.cuenta.enviados, 2, 'lo pendiente sale una vez');
    assert.equal(luis.contador().corazon, 3, 'tres toques, tres reacciones: ni dos ni cuatro');
    assert.equal(ana.canal.diagnostico().reconexiones, 1);
  });

  it('quien se reconecta sigue recibiendo, en el mismo topico', () => {
    const { red, reloj, ana, luis } = sala();
    red.cortar('luis');
    ana.pulsar('corazon');
    reloj.avanzar(TIC_DE_BURBUJAS_MS);
    assert.equal(luis.contador().corazon, 0, 'sin red no llega: es efimero');

    red.restablecer('luis');
    reloj.avanzar(VENTANA_DE_ENVIO_MS);
    ana.pulsar('fuego');
    reloj.avanzar(TIC_DE_BURBUJAS_MS);
    assert.equal(luis.contador().fuego, 1);
    assert.deepEqual(new Set(red.topicosDe('luis')), new Set(['live-reacciones:e1']));
  });
});

describe('cerrar', () => {
  it('cerrar dos veces no falla ni manda dos resumenes', () => {
    const { red, reloj, ana } = sala();
    ana.pulsar('corazon');
    assert.doesNotThrow(() => {
      ana.canal.cerrar();
      ana.canal.cerrar();
    });
    assert.equal(ana.resumenes.length, 1);
    assert.equal(red.abiertos('live-reacciones:e1'), 2);
    // Cerrado, ya no hace nada.
    ana.canal.enviar('corazon');
    reloj.avanzar(INTERVALO_DE_RESUMEN_MS * 2);
    assert.equal(ana.resumenes.length, 1);
    assert.equal(red.cuenta.enviados, 1);
  });

  it('montar y desmontar muchas veces no deja canales ni temporizadores', () => {
    const red = crearRedDeBroadcast();
    const reloj = crearReloj();
    for (let i = 0; i < 200; i += 1) {
      const uno = telefono(red.telefono('ana'), reloj, 'e1');
      uno.pulsar('corazon');
      uno.salir();
    }
    reloj.avanzar(DURACION_DE_BURBUJA_MS + INTERVALO_DE_RESUMEN_MS);
    assert.equal(red.abiertos(), 0, 'quedan canales huerfanos');
    assert.equal(reloj.vivos(), 0, 'quedan temporizadores vivos');
  });
});
