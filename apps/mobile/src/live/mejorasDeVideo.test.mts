import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { asentar, crearReloj } from './dobles/enMemoria.mts';
import {
  ESPERA_AL_SALIR_MS,
  ESPERA_DE_EFECTO_MS,
  RADIO_DE_DESENFOQUE,
  RADIO_DE_DESENFOQUE_SUAVE,
  crearGestorDeEfectos,
  mismoEfecto,
  type ComplementoDeEfectos,
} from './efectosDeVideo.ts';
import {
  CLAVE_DE_MEJORAS,
  ESCALA_ANDROID,
  ESCALA_IOS,
  ESPERA_DE_MEJORA_AL_SALIR_MS,
  ESPERA_DE_MEJORA_MS,
  ESPERA_PARA_QUITAR_EN_CERO_MS,
  INTERVALO_DE_ENVIO_MS,
  MEJORAR_Y_FONDO_A_LA_VEZ,
  MEJORAS,
  ajusteDeAndroid,
  conIman,
  crearGestorDeMejoras,
  crearLimitador,
  estadoSinMejoras,
  guardarMejoras,
  hayMejora,
  mejoraPuesta,
  mejorasGuardadas,
  normalizarValores,
  parametrosDeAndroid,
  parametrosDeIos,
  protegerFondoConMejoras,
  valoresEnCero,
  type ComplementoDeMejoras,
  type EstadoDeMejoras,
  type IdDeMejora,
  type ValoresDeMejora,
} from './mejorasDeVideo.ts';

/**
 * «MEJORAR» SIN SDK DELANTE (02/11/2026).
 *
 * Prueba las REGLAS: cuánto es cada número en cada plataforma, cuántas veces
 * se llama al SDK mientras se arrastra, en qué orden se quita el filtro para
 * poner un fondo, qué pasa si falla o no contesta y qué se recuerda. NO prueba
 * cómo se ve: eso solo se sabe con un teléfono y quien mire desde otro.
 */

function con(parcial: Partial<ValoresDeMejora>): ValoresDeMejora {
  return { ...valoresEnCero(), ...parcial };
}

const lista = (v: ValoresDeMejora) => MEJORAS.map((id) => v[id]).join(',');

/* ------------------------------------------------------------ Conversión --- */

describe('de 0–100 a lo que pide cada plataforma', () => {
  it('0 es el valor neutro del SDK en las dos: sin efecto', () => {
    assert.deepEqual(parametrosDeAndroid(valoresEnCero()), {
      smoothness: 0,
      brightness: 0.5,
      contrast: 0.5,
      sharpness: 0.5,
      redness: 0,
    });
    assert.deepEqual(parametrosDeIos(valoresEnCero()), {
      smoothness: 0,
      brightness: 0.5,
      contrast: 1,
      sharpness: 0,
      redness: 1,
    });
  });

  it('los máximos de la maqueta: piel 0–0,8 y luz +0,3 sobre el neutro', () => {
    const todo = con({ piel: 100, luz: 100, contraste: 100, nitidez: 100, rubor: 100 });
    const android = parametrosDeAndroid(todo);
    const ios = parametrosDeIos(todo);
    assert.equal(android.smoothness, 0.8);
    assert.equal(ios.smoothness, 0.8);
    assert.equal(android.brightness, 0.5 + 0.3);
    assert.equal(ios.brightness, 0.5 + 0.3);
  });

  it('contraste, nitidez y rubor llegan a lo razonable, y lo mismo en las dos', () => {
    const todo = parametrosDeAndroid(con({ contraste: 100, nitidez: 100, rubor: 100 }));
    // Pasado a la escala de GPUImage del filtro de Android (leída en sus
    // clases): contraste 0…2, nitidez −4…4, rojo ×1…×1,5.
    const gpu = {
      contraste: todo.contrast * 2,
      nitidez: -4 + 8 * todo.sharpness,
      rojo: 1 + 0.5 * todo.redness,
    };
    assert.equal(gpu.contraste, 1.4);
    assert.equal(gpu.nitidez, 1);
    assert.equal(gpu.rojo, 1.2);
    // iOS persigue el mismo resultado en su escala.
    const ios = parametrosDeIos(con({ contraste: 100, nitidez: 100, rubor: 100 }));
    assert.equal(ios.contrast, gpu.contraste);
    assert.equal(ios.sharpness, gpu.nitidez);
    assert.equal(ios.redness, gpu.rojo);
  });

  it('a mitad de barra, mitad de camino; y nunca sale del rango del SDK', () => {
    const mitad = parametrosDeAndroid(con({ piel: 50, luz: 50, contraste: 50, nitidez: 50, rubor: 50 }));
    assert.deepEqual(mitad, {
      smoothness: 0.4,
      brightness: 0.65,
      contrast: 0.6,
      sharpness: 0.5625,
      redness: 0.2,
    });
    for (let v = 0; v <= 100; v += 1) {
      const p = parametrosDeAndroid(con({ piel: v, luz: v, contraste: v, nitidez: v, rubor: v }));
      for (const valor of Object.values(p)) assert.ok(valor >= 0 && valor <= 1, `${valor} fuera de 0–1`);
    }
  });

  it('cada efecto mueve SU parámetro, y solo ese', () => {
    const esperado: Record<IdDeMejora, string> = {
      piel: 'smoothness',
      luz: 'brightness',
      contraste: 'contrast',
      nitidez: 'sharpness',
      rubor: 'redness',
    };
    const neutro = parametrosDeAndroid(valoresEnCero());
    for (const id of MEJORAS) {
      assert.equal(ESCALA_ANDROID[id].parametro, esperado[id]);
      assert.equal(ESCALA_IOS[id].parametro, esperado[id]);
      const movido = parametrosDeAndroid(con({ [id]: 100 }));
      const cambiados = Object.keys(movido).filter(
        (k) => movido[k as keyof typeof movido] !== neutro[k as keyof typeof neutro],
      );
      assert.deepEqual(cambiados, [esperado[id]]);
    }
  });

  it('lo que no es un 0–100 se recorta, y lo que no es un número es 0', () => {
    assert.deepEqual(
      normalizarValores({ piel: 140, luz: -3, contraste: 'mucho', nitidez: Number.NaN, rubor: 33.6 }),
      con({ piel: 100, luz: 0, contraste: 0, nitidez: 0, rubor: 34 }),
    );
  });

  it('al filtro de Android no se le manda un efecto en 0 que nunca se tocó', () => {
    const primero = ajusteDeAndroid(con({ luz: 40 }), new Set());
    assert.deepEqual(primero.parametros, {
      smoothness: null,
      brightness: 0.62,
      contrast: null,
      sharpness: null,
      redness: null,
    });
    // Ya tocado: volver a 0 SÍ se manda, con su neutro, para que deje de notarse.
    const segundo = ajusteDeAndroid(con({ piel: 10 }), primero.tocados);
    assert.equal(segundo.parametros.brightness, 0.5);
    assert.equal(segundo.parametros.smoothness, 0.08);
    assert.equal(segundo.parametros.sharpness, null);
    assert.deepEqual([...segundo.tocados].sort(), ['luz', 'piel']);
  });
});

/* ------------------------------------------------------------- La barra --- */

describe('la barra: imán en 0 y en 50', () => {
  it('a tres puntos se engancha; a cuatro, no', () => {
    assert.deepEqual(
      [0, 2, 3, 4, 46, 47, 50, 53, 54, 100, 104, -2].map(conIman),
      [0, 0, 0, 4, 46, 50, 50, 50, 54, 100, 100, 0],
    );
  });
});

describe('la barra: como mucho un valor cada 100 ms, y el último al soltar', () => {
  function limitador() {
    const reloj = crearReloj();
    const enviados: { t: number; v: number }[] = [];
    const l = crearLimitador<number>({
      intervaloMs: INTERVALO_DE_ENVIO_MS,
      ahora: reloj.ahora,
      programar: reloj.programar,
      enviar: (v) => enviados.push({ t: reloj.ahora(), v }),
    });
    return { l, reloj, enviados };
  }

  it('el intervalo es de 100 ms', () => {
    assert.equal(INTERVALO_DE_ENVIO_MS, 100);
  });

  it('el primero sale en el acto; los de en medio, como mucho uno por intervalo', () => {
    const { l, reloj, enviados } = limitador();
    l.empujar(1);
    assert.deepEqual(enviados.map((e) => e.v), [1]);
    reloj.avanzar(30);
    l.empujar(2);
    reloj.avanzar(30);
    l.empujar(3);
    assert.equal(enviados.length, 1, 'no sale nada antes de los 100 ms');
    reloj.avanzar(40);
    assert.deepEqual(enviados.map((e) => e.v), [1, 3], 'sale el ÚLTIMO, no el 2');
  });

  it('arrastrar un segundo a 60 fps manda a lo sumo 11 valores, y el último es el de soltar', () => {
    const { l, reloj, enviados } = limitador();
    let v = 0;
    for (let t = 0; t < 1000; t += 16) {
      v = Math.round(t / 10);
      l.empujar(v);
      reloj.avanzar(16);
    }
    l.soltar();
    assert.ok(enviados.length <= 12, `${enviados.length} envíos`);
    for (let i = 1; i < enviados.length - 1; i += 1) {
      assert.ok(enviados[i]!.t - enviados[i - 1]!.t >= 100, 'dos envíos a menos de 100 ms');
    }
    assert.equal(enviados.at(-1)!.v, v);
  });

  it('soltar manda lo pendiente sin esperar; sin nada pendiente, no manda nada', () => {
    const { l, reloj, enviados } = limitador();
    l.empujar(10);
    reloj.avanzar(20);
    l.empujar(20);
    l.soltar();
    assert.deepEqual(enviados.map((e) => [e.t - enviados[0]!.t, e.v]), [
      [0, 10],
      [20, 20],
    ]);
    l.soltar();
    reloj.avanzar(500);
    assert.equal(enviados.length, 2);
  });

  it('cancelar descarta lo pendiente (la hoja se cierra a mitad)', () => {
    const { l, reloj, enviados } = limitador();
    l.empujar(1);
    l.empujar(2);
    l.cancelar();
    reloj.avanzar(500);
    assert.deepEqual(enviados.map((e) => e.v), [1]);
    assert.equal(reloj.vivos(), 0);
  });
});

/* ------------------------------------------------- Lo que se recuerda ------ */

describe('lo que se recuerda en el teléfono', () => {
  it('se guarda por cuenta y se lee igual', () => {
    const crudo = guardarMejoras(null, 'ana', con({ piel: 40, luz: 20 }));
    assert.deepEqual(mejorasGuardadas(crudo, 'ana'), con({ piel: 40, luz: 20 }));
    // Otra cuenta en el mismo teléfono empieza en 0.
    assert.deepEqual(mejorasGuardadas(crudo, 'beto'), valoresEnCero());
  });

  it('guardar una cuenta no toca las demás, y todo en 0 no deja rastro', () => {
    let crudo = guardarMejoras(null, 'ana', con({ piel: 40 }));
    crudo = guardarMejoras(crudo, 'beto', con({ nitidez: 70 }));
    crudo = guardarMejoras(crudo, 'ana', valoresEnCero());
    assert.deepEqual(JSON.parse(crudo), { cuentas: { beto: con({ nitidez: 70 }) } });
  });

  it('lo que no se entiende es 0, y lo que se pasa de 0–100 se recorta', () => {
    assert.deepEqual(mejorasGuardadas('{roto', 'ana'), valoresEnCero());
    assert.deepEqual(mejorasGuardadas('[1,2]', 'ana'), valoresEnCero());
    assert.deepEqual(mejorasGuardadas(undefined, 'ana'), valoresEnCero());
    const raro = JSON.stringify({ cuentas: { ana: { piel: 900, luz: '5', rubor: 12.4 } } });
    assert.deepEqual(mejorasGuardadas(raro, 'ana'), con({ piel: 100, rubor: 12 }));
  });

  it('la clave lleva versión, para poder cambiar el formato sin leer basura', () => {
    assert.match(CLAVE_DE_MEJORAS, /\.v\d+$/);
  });
});

/* --------------------------------------------------------------- Gestor ---- */

/** Un filtro que apunta lo que se le pide, en un registro que puede compartir. */
function filtroDePrueba(llamadas: string[] = []) {
  const fallar = new Set<keyof ComplementoDeMejoras>();
  const colgar = new Set<keyof ComplementoDeMejoras>();
  const tardias: (() => void)[] = [];

  function hacer(verbo: keyof ComplementoDeMejoras, texto: string): Promise<unknown> {
    llamadas.push(texto);
    if (colgar.has(verbo)) return new Promise((resolver) => tardias.push(() => resolver(true)));
    if (fallar.has(verbo)) return Promise.reject(new Error(`${verbo} falló`));
    return Promise.resolve(true);
  }

  const complemento: ComplementoDeMejoras = {
    encender: () => hacer('encender', 'mejora.encender'),
    ajustar: (v) => hacer('ajustar', `mejora.ajustar(${lista(v)})`),
    apagar: () => hacer('apagar', 'mejora.apagar'),
  };
  return {
    complemento,
    llamadas,
    queFalle: (...verbos: (keyof ComplementoDeMejoras)[]) => {
      fallar.clear();
      for (const v of verbos) fallar.add(v);
    },
    queSeCuelgue: (...verbos: (keyof ComplementoDeMejoras)[]) => {
      colgar.clear();
      for (const v of verbos) colgar.add(v);
    },
    contestarTarde: () => {
      for (const t of tardias.splice(0)) t();
    },
  };
}

function gestorDeMejoras(
  complemento: ComplementoDeMejoras | null,
  reloj = crearReloj(),
) {
  const avisos: EstadoDeMejoras[] = [];
  const g = crearGestorDeMejoras({
    complemento,
    programar: reloj.programar,
    alCambiar: (estado) => avisos.push(estado),
  });
  return { g, reloj, avisos };
}

describe('mejorar: lo que se le pide al SDK', () => {
  it('los límites de tiempo son los mismos que los de los fondos', () => {
    assert.equal(ESPERA_DE_MEJORA_MS, ESPERA_DE_EFECTO_MS);
    assert.equal(ESPERA_DE_MEJORA_AL_SALIR_MS, ESPERA_AL_SALIR_MS);
  });

  it('todo empieza en 0, y en 0 el filtro ni se engancha', async () => {
    const f = filtroDePrueba();
    const { g } = gestorDeMejoras(f.complemento);
    assert.deepEqual(g.estado(), estadoSinMejoras());
    await g.laPistaEsNueva();
    assert.deepEqual(f.llamadas, []);
  });

  it('lo recordado se da antes de entrar y se pone al estrenar pista: encender y DESPUÉS ajustar', async () => {
    const f = filtroDePrueba();
    const { g } = gestorDeMejoras(f.complemento);
    await g.cambiar(con({ piel: 40, luz: 20 }));
    assert.deepEqual(f.llamadas, [], 'sin pista no se toca el SDK');
    await g.laPistaEsNueva();
    // El orden importa: lo que llega al filtro antes de encenderse se pierde.
    assert.deepEqual(f.llamadas, ['mejora.encender', 'mejora.ajustar(40,20,0,0,0)']);
  });

  it('mientras se arrastra manda la ÚLTIMA: no deja una cola de valores viejos', async () => {
    const f = filtroDePrueba();
    const { g } = gestorDeMejoras(f.complemento);
    await g.laPistaEsNueva();
    const a = g.cambiar(con({ luz: 10 }));
    const b = g.cambiar(con({ luz: 30 }));
    const c = g.cambiar(con({ luz: 60 }));
    await Promise.all([a, b, c]);
    assert.equal(f.llamadas[0], 'mejora.encender');
    assert.equal(f.llamadas.at(-1), 'mejora.ajustar(0,60,0,0,0)');
    assert.ok(f.llamadas.length <= 3, f.llamadas.join(' | '));
    assert.equal(g.estado().aplicando, false);
  });

  it('el ojo pone todo a 0 en el filtro —lo ve el público— y al soltar vuelve; no lo quita', async () => {
    const f = filtroDePrueba();
    const { g } = gestorDeMejoras(f.complemento);
    await g.laPistaEsNueva();
    await g.cambiar(con({ piel: 40 }));
    f.llamadas.length = 0;
    await g.comparar(true);
    assert.equal(g.estado().comparando, true);
    await g.comparar(false);
    assert.deepEqual(f.llamadas, ['mejora.ajustar(0,0,0,0,0)', 'mejora.ajustar(40,0,0,0,0)']);
    assert.deepEqual(g.estado().valores, con({ piel: 40 }), 'comparar no cambia lo elegido');
  });

  it('sin nada puesto, el ojo no hace nada', async () => {
    const f = filtroDePrueba();
    const { g } = gestorDeMejoras(f.complemento);
    await g.laPistaEsNueva();
    await g.comparar(true);
    assert.equal(g.estado().comparando, false);
    assert.deepEqual(f.llamadas, []);
  });

  it('todo en 0 (Restablecer) no lo quita al momento: espera 3 s por si se vuelve a subir', async () => {
    const f = filtroDePrueba();
    const { g, reloj } = gestorDeMejoras(f.complemento);
    await g.laPistaEsNueva();
    await g.cambiar(con({ nitidez: 30 }));
    await g.cambiar(valoresEnCero());
    assert.equal(f.llamadas.at(-1), 'mejora.ajustar(0,0,0,0,0)');
    reloj.avanzar(ESPERA_PARA_QUITAR_EN_CERO_MS - 1);
    await asentar();
    assert.ok(!f.llamadas.includes('mejora.apagar'));
    reloj.avanzar(1);
    await asentar();
    assert.equal(f.llamadas.at(-1), 'mejora.apagar');
  });

  it('volver a subir antes de los 3 s cancela el quitarlo', async () => {
    const f = filtroDePrueba();
    const { g, reloj } = gestorDeMejoras(f.complemento);
    await g.laPistaEsNueva();
    await g.cambiar(con({ nitidez: 30 }));
    await g.cambiar(valoresEnCero());
    reloj.avanzar(1000);
    await g.cambiar(con({ nitidez: 10 }));
    reloj.avanzar(10_000);
    await asentar();
    assert.ok(!f.llamadas.includes('mejora.apagar'), f.llamadas.join(' | '));
    assert.equal(reloj.vivos(), 0);
  });

  it('si falla, se apaga sola, con todo en 0, y se queda así en esta sala', async () => {
    const f = filtroDePrueba();
    f.queFalle('ajustar');
    const { g, avisos } = gestorDeMejoras(f.complemento);
    await g.laPistaEsNueva();
    const estado = await g.cambiar(con({ piel: 50 }));
    assert.deepEqual(f.llamadas, ['mejora.encender', 'mejora.ajustar(50,0,0,0,0)', 'mejora.apagar']);
    assert.equal(estado.averiada, true);
    assert.deepEqual(estado.valores, valoresEnCero(), 'en 0: no se recuerda lo que no funcionó');
    assert.equal(avisos.at(-1)?.averiada, true);
    f.queFalle();
    await g.cambiar(con({ piel: 10 }));
    assert.equal(f.llamadas.length, 3, 'averiada: no se vuelve a intentar en esta sala');
  });

  it('si no contesta, a los 8 s se da por apagada; y si aparece tarde, se quita', async () => {
    const f = filtroDePrueba();
    f.queSeCuelgue('encender');
    const { g, reloj } = gestorDeMejoras(f.complemento);
    await g.laPistaEsNueva();
    const promesa = g.cambiar(con({ luz: 50 }));
    await asentar();
    assert.equal(g.estado().aplicando, true);
    reloj.avanzar(ESPERA_DE_MEJORA_MS);
    const estado = await promesa;
    assert.equal(estado.averiada, true);
    assert.equal(estado.aplicando, false, 'el control no se queda girando');
    const antes = f.llamadas.filter((l) => l === 'mejora.apagar').length;
    f.contestarTarde();
    await asentar();
    assert.equal(f.llamadas.filter((l) => l === 'mejora.apagar').length, antes + 1);
  });

  it('salir lo quita con el límite corto y RECUERDA los valores; al volver se repone', async () => {
    const f = filtroDePrueba();
    const { g } = gestorDeMejoras(f.complemento);
    await g.laPistaEsNueva();
    await g.cambiar(con({ rubor: 25 }));
    f.llamadas.length = 0;
    await g.apagarParaSalir();
    assert.deepEqual(f.llamadas, ['mejora.apagar']);
    assert.deepEqual(g.estado().valores, con({ rubor: 25 }));
    await g.laPistaEsNueva();
    assert.deepEqual(f.llamadas, ['mejora.apagar', 'mejora.encender', 'mejora.ajustar(0,0,0,0,25)']);
  });

  it('salir con un filtro que no contesta no se queda esperando más de 1,5 s', async () => {
    const f = filtroDePrueba();
    const { g, reloj } = gestorDeMejoras(f.complemento);
    await g.laPistaEsNueva();
    await g.cambiar(con({ rubor: 25 }));
    f.queSeCuelgue('apagar');
    let salio = false;
    void g.apagarParaSalir().then(() => {
      salio = true;
    });
    reloj.avanzar(ESPERA_DE_MEJORA_AL_SALIR_MS);
    await asentar();
    assert.equal(salio, true);
  });

  it('sin complemento (iOS, web, binario viejo) no se ofrece y nada lanza', async () => {
    const { g } = gestorDeMejoras(null);
    assert.deepEqual(g.capacidad(), { admitida: false });
    await g.laPistaEsNueva();
    await g.cambiar(con({ piel: 30 }));
    await g.comparar(true);
    assert.equal(await g.bloquear(true), true);
    await g.apagarParaSalir();
    g.destruir();
  });

  it('el punto del botón de efectos solo se enciende si la mejora se está aplicando', () => {
    const puesto: EstadoDeMejoras = { ...estadoSinMejoras(), valores: con({ luz: 5 }) };
    assert.equal(mejoraPuesta(puesto), true);
    assert.equal(mejoraPuesta({ ...puesto, bloqueada: true }), false);
    assert.equal(mejoraPuesta({ ...puesto, averiada: true }), false);
    assert.equal(mejoraPuesta(estadoSinMejoras()), false);
    assert.equal(hayMejora(con({ rubor: 1 })), true);
  });
});

/* --------------------------------------------- Mejorar y fondo, juntos ---- */

/** Un fondo virtual que apunta en el MISMO registro que el filtro. */
function fondoDePrueba(llamadas: string[]) {
  const fallar = new Set<keyof ComplementoDeEfectos>();
  function hacer(verbo: keyof ComplementoDeEfectos, texto: string): Promise<unknown> {
    llamadas.push(texto);
    if (fallar.has(verbo)) return Promise.reject(new Error(`${verbo} falló`));
    return Promise.resolve(true);
  }
  const complemento: ComplementoDeEfectos = {
    activar: () => hacer('activar', 'fondo.activar'),
    desactivar: () => hacer('desactivar', 'fondo.desactivar'),
    desenfocar: (radio) => hacer('desenfocar', `fondo.desenfocar(${radio})`),
    ponerFondo: (id) => hacer('ponerFondo', `fondo.poner(${id})`),
  };
  return {
    complemento,
    queFalle: (...verbos: (keyof ComplementoDeEfectos)[]) => {
      fallar.clear();
      for (const v of verbos) fallar.add(v);
    },
  };
}

function salaConLosDos(opciones: { dosDesenfoques?: boolean } = {}) {
  const llamadas: string[] = [];
  const reloj = crearReloj();
  const filtro = filtroDePrueba(llamadas);
  const fondo = fondoDePrueba(llamadas);
  const { g: mejoras } = gestorDeMejoras(filtro.complemento, reloj);
  const fondos = crearGestorDeEfectos({
    complemento: protegerFondoConMejoras(fondo.complemento, mejoras),
    fondos: ['estudio-oscuro', 'sala-gris'],
    dosDesenfoques: opciones.dosDesenfoques,
    programar: reloj.programar,
    alCambiar: () => {},
  });
  return { llamadas, reloj, filtro, fondo, mejoras, fondos };
}

describe('mejorar y un fondo no van a la vez', () => {
  it('así lo dice el SDK de Android 2.9.84: no se combinan', () => {
    assert.equal(MEJORAR_Y_FONDO_A_LA_VEZ, false);
  });

  it('al elegir un fondo, el filtro se quita ANTES de encender el fondo', async () => {
    const s = salaConLosDos();
    await s.mejoras.laPistaEsNueva();
    await s.mejoras.cambiar(con({ piel: 40 }));
    s.llamadas.length = 0;
    const estado = await s.fondos.aplicar({ tipo: 'desenfoque' });
    assert.deepEqual(s.llamadas, ['mejora.apagar', 'fondo.activar', `fondo.desenfocar(${RADIO_DE_DESENFOQUE})`]);
    assert.deepEqual(estado.efecto, { tipo: 'desenfoque' });
    assert.equal(s.mejoras.estado().bloqueada, true, '«Apagado con un fondo»');
    assert.deepEqual(s.mejoras.estado().valores, con({ piel: 40 }), 'los valores se guardan');
  });

  it('con el fondo puesto, mover las barras no toca el filtro; al volver a «Ninguno» vuelve con lo último', async () => {
    const s = salaConLosDos();
    await s.mejoras.laPistaEsNueva();
    await s.mejoras.cambiar(con({ piel: 40 }));
    await s.fondos.aplicar({ tipo: 'fondo', fondoId: 'sala-gris' });
    s.llamadas.length = 0;
    await s.mejoras.cambiar(con({ piel: 40, luz: 15 }));
    await s.mejoras.comparar(true);
    assert.deepEqual(s.llamadas, []);
    await s.fondos.aplicar({ tipo: 'ninguno' });
    await asentar();
    assert.deepEqual(s.llamadas, ['fondo.desactivar', 'mejora.encender', 'mejora.ajustar(40,15,0,0,0)']);
    assert.equal(s.mejoras.estado().bloqueada, false);
  });

  it('cambiar de un fondo a otro no vuelve a tocar el filtro', async () => {
    const s = salaConLosDos();
    await s.mejoras.laPistaEsNueva();
    await s.mejoras.cambiar(con({ luz: 40 }));
    await s.fondos.aplicar({ tipo: 'desenfoque' });
    s.llamadas.length = 0;
    await s.fondos.aplicar({ tipo: 'fondo', fondoId: 'estudio-oscuro' });
    assert.deepEqual(s.llamadas, ['fondo.poner(estudio-oscuro)']);
  });

  it('si el filtro no se deja quitar, el fondo NO se pone: nunca los dos a la vez', async () => {
    const s = salaConLosDos();
    await s.mejoras.laPistaEsNueva();
    await s.mejoras.cambiar(con({ piel: 40 }));
    s.filtro.queFalle('apagar');
    s.llamadas.length = 0;
    const estado = await s.fondos.aplicar({ tipo: 'desenfoque' });
    assert.ok(!s.llamadas.includes('fondo.activar'), s.llamadas.join(' | '));
    assert.equal(estado.error, 'no_se_pudo');
    assert.deepEqual(estado.efecto, { tipo: 'ninguno' });
    assert.equal(s.mejoras.estado().averiada, true);
  });

  it('si el fondo no se pudo poner, «Mejorar» vuelve', async () => {
    const s = salaConLosDos();
    await s.mejoras.laPistaEsNueva();
    await s.mejoras.cambiar(con({ contraste: 20 }));
    s.fondo.queFalle('activar');
    s.llamadas.length = 0;
    const estado = await s.fondos.aplicar({ tipo: 'desenfoque' });
    await asentar();
    assert.equal(estado.error, 'no_se_pudo');
    assert.deepEqual(s.llamadas, [
      'mejora.apagar',
      'fondo.activar',
      'mejora.encender',
      'mejora.ajustar(0,0,20,0,0)',
    ]);
    assert.equal(s.mejoras.estado().bloqueada, false);
  });

  it('si el fondo no se deja quitar, «Mejorar» se queda apagado (el fondo puede seguir puesto)', async () => {
    const s = salaConLosDos();
    await s.mejoras.laPistaEsNueva();
    await s.mejoras.cambiar(con({ contraste: 20 }));
    await s.fondos.aplicar({ tipo: 'desenfoque' });
    s.fondo.queFalle('desactivar');
    s.llamadas.length = 0;
    await s.fondos.aplicar({ tipo: 'ninguno' });
    await asentar();
    assert.ok(!s.llamadas.some((l) => l.startsWith('mejora.')), s.llamadas.join(' | '));
    assert.equal(s.mejoras.estado().bloqueada, true);
  });

  it('sin filtro puesto, el fondo entra sin más', async () => {
    const s = salaConLosDos();
    await s.mejoras.laPistaEsNueva();
    await s.fondos.aplicar({ tipo: 'desenfoque' });
    assert.deepEqual(s.llamadas, ['fondo.activar', `fondo.desenfocar(${RADIO_DE_DESENFOQUE})`]);
  });
});

describe('desenfoque suave y fuerte (Android)', () => {
  it('suave es el radio 40; fuerte —o sin decir—, el 75 de siempre', async () => {
    const s = salaConLosDos({ dosDesenfoques: true });
    await s.fondos.aplicar({ tipo: 'desenfoque', fuerza: 'suave' });
    await s.fondos.aplicar({ tipo: 'desenfoque', fuerza: 'fuerte' });
    assert.deepEqual(s.llamadas, [
      'fondo.activar',
      `fondo.desenfocar(${RADIO_DE_DESENFOQUE_SUAVE})`,
      `fondo.desenfocar(${RADIO_DE_DESENFOQUE})`,
    ]);
    assert.equal(RADIO_DE_DESENFOQUE_SUAVE, 40);
    assert.equal(RADIO_DE_DESENFOQUE, 75);
    assert.deepEqual(s.fondos.capacidad(), {
      admitidos: true,
      fondos: ['estudio-oscuro', 'sala-gris'],
      dosDesenfoques: true,
    });
  });

  it('suave y fuerte son efectos distintos; fuerte y «sin decir», el mismo', () => {
    assert.equal(mismoEfecto({ tipo: 'desenfoque', fuerza: 'suave' }, { tipo: 'desenfoque' }), false);
    assert.equal(mismoEfecto({ tipo: 'desenfoque', fuerza: 'fuerte' }, { tipo: 'desenfoque' }), true);
  });

  it('donde hay un solo desenfoque (iOS), pedir el suave no se finge', async () => {
    const s = salaConLosDos();
    const estado = await s.fondos.aplicar({ tipo: 'desenfoque', fuerza: 'suave' });
    assert.equal(estado.error, 'no_se_pudo');
    assert.deepEqual(s.llamadas, []);
  });
});
