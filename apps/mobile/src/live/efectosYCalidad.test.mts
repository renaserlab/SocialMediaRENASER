import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LECTURAS_PARA_CAMBIAR,
  calidadSinOpciones,
  crearGestorDeCalidad,
  crearVigiaDeConexion,
  opcionesDeCalidad,
  type CapaDeVideo,
  type DefinicionDeCapa,
  type EstadoDeCalidad,
} from './calidadDeVideo.ts';
import { asentar, crearReloj } from './dobles/enMemoria.mts';
import {
  ESPERA_AL_SALIR_MS,
  ESPERA_DE_EFECTO_MS,
  RADIO_DE_DESENFOQUE,
  crearGestorDeEfectos,
  estadoSinEfectos,
  mismoEfecto,
  type ComplementoDeEfectos,
  type EstadoDeEfectos,
} from './efectosDeVideo.ts';
import { crearSalaFalsa } from './salaDeVideo.ts';

/**
 * LOS EFECTOS DE CAMARA Y LA CALIDAD DE IMAGEN, sin SDK delante.
 *
 * LO QUE ESTO PRUEBA Y LO QUE NO. Prueba las REGLAS: que orden de llamadas
 * recibe el SDK, que pasa si falla o no contesta, que nunca se queda el control
 * bloqueado, que no se ofrece una calidad que no existe. NO prueba que el
 * desenfoque se vea, ni que lo reciba otro telefono: eso solo se puede ver con
 * dos aparatos y esta en `docs/Z_QA_FISICO_PENDIENTE.md`.
 */

const FONDOS = ['estudio-oscuro', 'sala-gris'];

/** Un complemento que apunta lo que se le pide y falla cuando se le dice. */
function complementoDePrueba() {
  const llamadas: string[] = [];
  let fallar: Partial<Record<keyof ComplementoDeEfectos, boolean>> = {};
  let colgar: Partial<Record<keyof ComplementoDeEfectos, boolean>> = {};
  let lanzarAlTocar = false;
  const pendientes: (() => void)[] = [];

  function hacer(verbo: keyof ComplementoDeEfectos, texto: string): Promise<unknown> {
    if (lanzarAlTocar) throw new Error('el modulo nativo no esta enlazado');
    llamadas.push(texto);
    if (colgar[verbo]) return new Promise(() => {});
    if (fallar[verbo]) return Promise.reject(new Error(`${verbo} fallo`));
    return Promise.resolve(true);
  }

  const complemento: ComplementoDeEfectos = {
    activar: () => hacer('activar', 'activar'),
    desactivar: () => hacer('desactivar', 'desactivar'),
    desenfocar: (radio) => hacer('desenfocar', `desenfocar(${radio})`),
    ponerFondo: (id) => hacer('ponerFondo', `fondo(${id})`),
  };
  return {
    complemento,
    llamadas,
    pendientes,
    queFalle: (verbos: (keyof ComplementoDeEfectos)[]) => {
      fallar = Object.fromEntries(verbos.map((v) => [v, true]));
    },
    queSeCuelgue: (verbos: (keyof ComplementoDeEfectos)[]) => {
      colgar = Object.fromEntries(verbos.map((v) => [v, true]));
    },
    queLanceAlTocarlo: (valor: boolean) => {
      lanzarAlTocar = valor;
    },
  };
}

function gestor(complemento: ComplementoDeEfectos | null = complementoDePrueba().complemento) {
  const reloj = crearReloj();
  const avisos: EstadoDeEfectos[] = [];
  const g = crearGestorDeEfectos({
    complemento,
    fondos: FONDOS,
    programar: reloj.programar,
    alCambiar: (estado) => avisos.push(estado),
  });
  return { g, reloj, avisos };
}

/* -------------------------------------------------------------- Efectos --- */

describe('efectos: lo que se le pide al SDK', () => {
  it('desenfoque: activa el procesado y luego desenfoca', async () => {
    const doble = complementoDePrueba();
    const { g } = gestor(doble.complemento);
    const estado = await g.aplicar({ tipo: 'desenfoque' });
    assert.deepEqual(doble.llamadas, ['activar', `desenfocar(${RADIO_DE_DESENFOQUE})`]);
    assert.deepEqual(estado, { efecto: { tipo: 'desenfoque' }, aplicando: false, error: null });
  });

  it('cambiar de desenfoque a fondo no vuelve a activar', async () => {
    const doble = complementoDePrueba();
    const { g } = gestor(doble.complemento);
    await g.aplicar({ tipo: 'desenfoque' });
    await g.aplicar({ tipo: 'fondo', fondoId: 'sala-gris' });
    assert.deepEqual(doble.llamadas, [
      'activar',
      `desenfocar(${RADIO_DE_DESENFOQUE})`,
      'fondo(sala-gris)',
    ]);
    assert.deepEqual(g.estado().efecto, { tipo: 'fondo', fondoId: 'sala-gris' });
  });

  it('quitar: desactiva, y la pista vuelve a ser la camara tal cual', async () => {
    const doble = complementoDePrueba();
    const { g } = gestor(doble.complemento);
    await g.aplicar({ tipo: 'fondo', fondoId: 'estudio-oscuro' });
    await g.aplicar({ tipo: 'ninguno' });
    assert.deepEqual(doble.llamadas, ['activar', 'fondo(estudio-oscuro)', 'desactivar']);
    assert.deepEqual(g.estado(), estadoSinEfectos());
  });

  it('pedir lo que ya esta puesto no llama al SDK', async () => {
    const doble = complementoDePrueba();
    const { g } = gestor(doble.complemento);
    await g.aplicar({ tipo: 'ninguno' });
    assert.deepEqual(doble.llamadas, []);
    await g.aplicar({ tipo: 'desenfoque' });
    await g.aplicar({ tipo: 'desenfoque' });
    assert.equal(doble.llamadas.length, 2);
  });

  it('un fondo que la aplicacion no trae NO llega al SDK', async () => {
    const doble = complementoDePrueba();
    const { g } = gestor(doble.complemento);
    const estado = await g.aplicar({ tipo: 'fondo', fondoId: 'https://ejemplo.test/foto.jpg' });
    assert.deepEqual(doble.llamadas, [], 'se ha mandado al SDK un fondo arbitrario');
    assert.equal(estado.error, 'no_se_pudo');
    assert.deepEqual(estado.efecto, { tipo: 'ninguno' });
  });

  it('mismoEfecto distingue los fondos entre si', () => {
    assert.equal(mismoEfecto({ tipo: 'fondo', fondoId: 'a' }, { tipo: 'fondo', fondoId: 'a' }), true);
    assert.equal(mismoEfecto({ tipo: 'fondo', fondoId: 'a' }, { tipo: 'fondo', fondoId: 'b' }), false);
    assert.equal(mismoEfecto({ tipo: 'desenfoque' }, { tipo: 'ninguno' }), false);
  });
});

describe('efectos: cuando el SDK falla', () => {
  it('si no se puede aplicar, vuelve a «ninguno» y lo dice', async () => {
    const doble = complementoDePrueba();
    doble.queFalle(['desenfocar']);
    const { g } = gestor(doble.complemento);
    const estado = await g.aplicar({ tipo: 'desenfoque' });
    // Activo, no pudo desenfocar, y lo QUITO: no deja el procesado a medias.
    assert.deepEqual(doble.llamadas, ['activar', `desenfocar(${RADIO_DE_DESENFOQUE})`, 'desactivar']);
    assert.deepEqual(estado, { efecto: { tipo: 'ninguno' }, aplicando: false, error: 'no_se_pudo' });
  });

  it('despues de un fallo se puede volver a intentar: el control no queda bloqueado', async () => {
    const doble = complementoDePrueba();
    doble.queFalle(['activar']);
    const { g } = gestor(doble.complemento);
    assert.equal((await g.aplicar({ tipo: 'desenfoque' })).error, 'no_se_pudo');
    assert.equal(g.estado().aplicando, false);

    doble.queFalle([]);
    const estado = await g.aplicar({ tipo: 'desenfoque' });
    assert.deepEqual(estado, { efecto: { tipo: 'desenfoque' }, aplicando: false, error: null });
  });

  it('un SDK que no contesta no deja el control girando para siempre', async () => {
    const doble = complementoDePrueba();
    doble.queSeCuelgue(['activar']);
    const { g, reloj } = gestor(doble.complemento);
    const promesa = g.aplicar({ tipo: 'desenfoque' });
    await asentar();
    assert.equal(g.estado().aplicando, true);

    reloj.avanzar(ESPERA_DE_EFECTO_MS);
    const estado = await promesa;
    assert.deepEqual(estado, { efecto: { tipo: 'ninguno' }, aplicando: false, error: 'no_se_pudo' });
    assert.equal(reloj.vivos(), 0, 'queda un temporizador de espera vivo');
  });

  it('un modulo sin enlazar, que LANZA al tocarlo, no revienta: lo dice', async () => {
    const doble = complementoDePrueba();
    doble.queLanceAlTocarlo(true);
    const { g } = gestor(doble.complemento);
    const estado = await g.aplicar({ tipo: 'desenfoque' });
    assert.equal(estado.error, 'no_se_pudo');
    assert.deepEqual(estado.efecto, { tipo: 'ninguno' });
    assert.equal(estado.aplicando, false);
  });

  it('`aplicar` no rechaza nunca', async () => {
    const doble = complementoDePrueba();
    doble.queFalle(['activar', 'desactivar', 'desenfocar', 'ponerFondo']);
    const { g } = gestor(doble.complemento);
    await assert.doesNotReject(g.aplicar({ tipo: 'fondo', fondoId: 'sala-gris' }));
    await assert.doesNotReject(g.aplicar({ tipo: 'ninguno' }));
  });
});

describe('efectos: una operacion a la vez, y manda la ultima', () => {
  it('tres peticiones seguidas: el SDK no recibe llamadas encimadas y queda la ultima', async () => {
    const doble = complementoDePrueba();
    const { g } = gestor(doble.complemento);
    const todas = Promise.all([
      g.aplicar({ tipo: 'desenfoque' }),
      g.aplicar({ tipo: 'fondo', fondoId: 'sala-gris' }),
      g.aplicar({ tipo: 'fondo', fondoId: 'estudio-oscuro' }),
    ]);
    const estados = await todas;
    assert.deepEqual(g.estado().efecto, { tipo: 'fondo', fondoId: 'estudio-oscuro' });
    // Las tres promesas resuelven con el estado FINAL, no con uno intermedio.
    for (const estado of estados) assert.deepEqual(estado.efecto, g.estado().efecto);
    // El fondo intermedio se salto: nunca llego a pedirse.
    assert.equal(doble.llamadas.includes('fondo(sala-gris)'), false);
    assert.equal(doble.llamadas.filter((llamada) => llamada === 'activar').length, 1);
  });

  it('«ninguno» se puede pedir a mitad de otra operacion, y gana', async () => {
    const doble = complementoDePrueba();
    const { g } = gestor(doble.complemento);
    const primera = g.aplicar({ tipo: 'desenfoque' });
    const segunda = g.aplicar({ tipo: 'ninguno' });
    await Promise.all([primera, segunda]);
    assert.deepEqual(g.estado(), estadoSinEfectos());
    assert.equal(doble.llamadas.at(-1), 'desactivar');
  });

  it('avisa al empezar y al terminar, con `aplicando` bien puesto', async () => {
    const doble = complementoDePrueba();
    const { g, avisos } = gestor(doble.complemento);
    await g.aplicar({ tipo: 'desenfoque' });
    assert.equal(avisos[0]?.aplicando, true);
    assert.deepEqual(avisos.at(-1), {
      efecto: { tipo: 'desenfoque' },
      aplicando: false,
      error: null,
    });
  });
});

describe('efectos: salir, volver a entrar y reponer', () => {
  it('al salir se quita el procesado y se recuerda que habia', async () => {
    const doble = complementoDePrueba();
    const { g } = gestor(doble.complemento);
    await g.aplicar({ tipo: 'desenfoque' });

    await g.apagarParaSalir();
    assert.equal(doble.llamadas.at(-1), 'desactivar');
    assert.deepEqual(g.estado(), estadoSinEfectos());
    assert.equal(g.hayQueReponer(), true);
  });

  it('salir sin efecto no toca el SDK ni pide reponer nada', async () => {
    const doble = complementoDePrueba();
    const { g } = gestor(doble.complemento);
    await g.apagarParaSalir();
    assert.deepEqual(doble.llamadas, []);
    assert.equal(g.hayQueReponer(), false);
  });

  it('salir no espera de mas a un SDK que no contesta, y no lanza', async () => {
    const doble = complementoDePrueba();
    const { g, reloj } = gestor(doble.complemento);
    await g.aplicar({ tipo: 'desenfoque' });
    doble.queSeCuelgue(['desactivar']);
    const salida = g.apagarParaSalir();
    reloj.avanzar(ESPERA_AL_SALIR_MS);
    await assert.doesNotReject(salida);
    assert.ok(ESPERA_AL_SALIR_MS < ESPERA_DE_EFECTO_MS);
  });

  it('al volver a entrar se repone el efecto sobre la pista nueva', async () => {
    const doble = complementoDePrueba();
    const { g } = gestor(doble.complemento);
    await g.aplicar({ tipo: 'fondo', fondoId: 'sala-gris' });
    await g.apagarParaSalir();
    doble.llamadas.length = 0;

    const estado = await g.laPistaEsNueva();
    assert.deepEqual(doble.llamadas, ['activar', 'fondo(sala-gris)']);
    assert.deepEqual(estado, {
      efecto: { tipo: 'fondo', fondoId: 'sala-gris' },
      aplicando: false,
      error: null,
    });
    // Repuesto y puesto: si la pista volviera a cambiar, habria que reponerlo
    // otra vez.
    assert.equal(g.hayQueReponer(), true);
    await g.aplicar({ tipo: 'ninguno' });
    assert.equal(g.hayQueReponer(), false, 'sin efecto no queda nada que reponer');
  });

  it('si no se puede reponer, queda SIN efecto y dice que se apago', async () => {
    const doble = complementoDePrueba();
    const { g } = gestor(doble.complemento);
    await g.aplicar({ tipo: 'desenfoque' });
    await g.apagarParaSalir();
    doble.queFalle(['activar']);

    const estado = await g.laPistaEsNueva();
    assert.deepEqual(estado, { efecto: { tipo: 'ninguno' }, aplicando: false, error: 'se_apago' });
  });

  it('una pista nueva sin nada que reponer no llama al SDK', async () => {
    const doble = complementoDePrueba();
    const { g } = gestor(doble.complemento);
    await g.laPistaEsNueva();
    assert.deepEqual(doble.llamadas, []);
  });

  it('destruido, ya no avisa ni aplica', async () => {
    const doble = complementoDePrueba();
    const { g, avisos } = gestor(doble.complemento);
    g.destruir();
    g.destruir();
    await g.aplicar({ tipo: 'desenfoque' });
    assert.deepEqual(doble.llamadas, []);
    assert.deepEqual(avisos, []);
    assert.equal(g.hayQueReponer(), false);
  });
});

describe('efectos: una sala que no los admite lo dice, y no finge', () => {
  it('sin complemento: capacidad con su motivo, y aplicar no cambia nada', async () => {
    const reloj = crearReloj();
    const g = crearGestorDeEfectos({
      complemento: null,
      motivo: 'sistema_antiguo',
      fondos: FONDOS,
      programar: reloj.programar,
      alCambiar: () => {},
    });
    assert.deepEqual(g.capacidad(), { admitidos: false, motivo: 'sistema_antiguo', fondos: [] });
    const estado = await g.aplicar({ tipo: 'desenfoque' });
    assert.deepEqual(estado, { efecto: { tipo: 'ninguno' }, aplicando: false, error: 'no_se_pudo' });
    // Pedir «ninguno» sin complemento no es un error.
    const limpio = crearGestorDeEfectos({
      complemento: null,
      fondos: [],
      programar: reloj.programar,
      alCambiar: () => {},
    });
    assert.equal((await limpio.aplicar({ tipo: 'ninguno' })).error, null);
  });

  it('con complemento: admitidos, con los fondos de la aplicacion', () => {
    const { g } = gestor();
    assert.deepEqual(g.capacidad(), { admitidos: true, fondos: FONDOS });
  });

  it('LA SALA FALSA informa de que no admite efectos y no simula aplicarlos', async () => {
    const sala = crearSalaFalsa();
    assert.deepEqual(sala.efectos(), { admitidos: false, motivo: 'sin_proveedor', fondos: [] });
    assert.deepEqual(sala.estadoDeEfectos(), estadoSinEfectos());

    const estado = await sala.aplicarEfecto({ tipo: 'desenfoque' });
    assert.deepEqual(estado.efecto, { tipo: 'ninguno' }, 'la sala falsa finge que aplica un efecto');
    assert.equal(estado.error, 'no_se_pudo');
    assert.equal((await sala.aplicarEfecto({ tipo: 'ninguno' })).error, null);
    assert.deepEqual(sala.estadoDeEfectos(), estadoSinEfectos());
  });

  it('LA SALA FALSA no ofrece calidades', async () => {
    const sala = crearSalaFalsa();
    assert.deepEqual(sala.calidad(), calidadSinOpciones());
    assert.deepEqual(await sala.elegirCalidad('alta'), calidadSinOpciones());
  });
});

/* -------------------------------------------------------------- Calidad --- */

const TRES_CAPAS: DefinicionDeCapa[] = [
  { capa: 'alta', ancho: 720, alto: 1280 },
  { capa: 'baja', ancho: 180, alto: 320 },
  { capa: 'media', ancho: 360, alto: 640 },
];

describe('calidad: solo se ofrece lo que existe', () => {
  it('una pista sin capas no ofrece nada', () => {
    assert.deepEqual(opcionesDeCalidad([]), []);
  });

  it('una sola capa tampoco: no hay nada entre lo que elegir', () => {
    assert.deepEqual(opcionesDeCalidad([{ capa: 'alta', ancho: 720, alto: 1280 }]), []);
    // La misma capa repetida sigue siendo una.
    assert.deepEqual(
      opcionesDeCalidad([
        { capa: 'alta', ancho: 720, alto: 1280 },
        { capa: 'alta', ancho: 720, alto: 1280 },
      ]),
      [],
    );
  });

  it('con baja, media y alta: automatica, ahorro (la mas baja) y alta (la mas alta)', () => {
    assert.deepEqual(opcionesDeCalidad(TRES_CAPAS), [
      { preferencia: 'automatica', capa: null, ancho: 0, alto: 0 },
      { preferencia: 'ahorro', capa: 'baja', ancho: 180, alto: 320 },
      { preferencia: 'alta', capa: 'alta', ancho: 720, alto: 1280 },
    ]);
  });

  it('con solo media y alta, «ahorro» es la media: la mas baja QUE HAY', () => {
    const opciones = opcionesDeCalidad([
      { capa: 'alta', ancho: 540, alto: 960 },
      { capa: 'media', ancho: 270, alto: 480 },
    ]);
    assert.equal(opciones[1]?.capa, 'media');
    assert.equal(opciones[2]?.capa, 'alta');
    // «Alta» enseña la medida real, no promete una.
    assert.equal(opciones[2]?.ancho, 540);
  });

  it('capas que el SDK devuelve mal formadas se ignoran', () => {
    const rotas = [
      { capa: 'ultra', ancho: 1, alto: 1 },
      null,
      { capa: 'alta', ancho: Number.NaN, alto: -5 },
      { capa: 'baja', ancho: 180, alto: 320 },
    ] as unknown as DefinicionDeCapa[];
    const opciones = opcionesDeCalidad(rotas);
    assert.equal(opciones.length, 3);
    assert.deepEqual(opciones[2], { preferencia: 'alta', capa: 'alta', ancho: 0, alto: 0 });
  });
});

function calidad(capas: DefinicionDeCapa[] | (() => Promise<DefinicionDeCapa[]>) = TRES_CAPAS) {
  const fijadas: { pista: string; capa: CapaDeVideo }[] = [];
  const avisos: EstadoDeCalidad[] = [];
  let falla = false;
  const g = crearGestorDeCalidad({
    leerCapas: async () => (typeof capas === 'function' ? capas() : capas),
    fijarCapa: async (pista, capa) => {
      if (falla) throw new Error('el SDK no acepto la capa');
      fijadas.push({ pista, capa });
    },
    alCambiar: (estado) => avisos.push(estado),
  });
  return {
    g,
    fijadas,
    avisos,
    queFalle: (valor: boolean) => {
      falla = valor;
    },
  };
}

describe('calidad: elegir', () => {
  it('sin pista no hay opciones, y elegir no hace nada', async () => {
    const { g, fijadas } = calidad();
    assert.deepEqual(g.estado(), calidadSinOpciones());
    await g.elegir('alta');
    assert.deepEqual(fijadas, []);
    assert.equal(g.estado().elegida, 'automatica');
  });

  it('al aparecer una pista con capas, se ofrecen; de partida, automatica', async () => {
    const { g, fijadas } = calidad();
    await g.cambioLaPista('p1');
    assert.equal(g.estado().opciones.length, 3);
    assert.equal(g.estado().elegida, 'automatica');
    assert.equal(g.capaAutomatica(), true);
    assert.deepEqual(fijadas, [], 'en automatica no se fija ninguna capa');
  });

  it('ahorro pide la capa baja; alta, la alta; y deja de ser automatica', async () => {
    const { g, fijadas } = calidad();
    await g.cambioLaPista('p1');
    await g.elegir('ahorro');
    assert.deepEqual(fijadas, [{ pista: 'p1', capa: 'baja' }]);
    assert.equal(g.capaAutomatica(), false);

    await g.elegir('alta');
    assert.deepEqual(fijadas.at(-1), { pista: 'p1', capa: 'alta' });
    assert.equal(g.estado().elegida, 'alta');
  });

  it('volver a automatica devuelve la eleccion al proveedor', async () => {
    const { g, fijadas } = calidad();
    await g.cambioLaPista('p1');
    await g.elegir('ahorro');
    await g.elegir('automatica');
    assert.equal(g.capaAutomatica(), true);
    // Vuelve a la capa de partida del proveedor, que es la mas alta.
    assert.deepEqual(fijadas.at(-1), { pista: 'p1', capa: 'alta' });
  });

  it('si el SDK falla, se dice y se sigue marcando lo que de verdad se recibe', async () => {
    const { g, queFalle } = calidad();
    await g.cambioLaPista('p1');
    await g.elegir('ahorro');
    queFalle(true);
    const estado = await g.elegir('alta');
    assert.equal(estado.elegida, 'ahorro', 'marca una calidad que no se aplico');
    assert.equal(estado.fallo, true);
    assert.equal(estado.aplicando, false);
  });

  it('elegir no rechaza nunca', async () => {
    const { g, queFalle } = calidad();
    await g.cambioLaPista('p1');
    queFalle(true);
    await assert.doesNotReject(g.elegir('alta'));
  });

  it('una opcion que no existe para esta pista no se pide', async () => {
    const { g, fijadas } = calidad([]);
    await g.cambioLaPista('p1');
    await g.elegir('alta');
    assert.deepEqual(fijadas, []);
    assert.equal(g.estado().elegida, 'automatica');
  });

  it('un SDK que no sabe decir las capas es una pista sin capas', async () => {
    const { g } = calidad(async () => {
      throw new Error('getLayerDefinition no disponible');
    });
    await assert.doesNotReject(g.cambioLaPista('p1'));
    assert.deepEqual(g.estado().opciones, []);
  });
});

describe('calidad: la pista cambia durante la emision', () => {
  it('tras una reconexion (pista nueva) se vuelve a pedir lo elegido', async () => {
    const { g, fijadas } = calidad();
    await g.cambioLaPista('p1');
    await g.elegir('ahorro');
    await g.cambioLaPista('p2');
    assert.deepEqual(fijadas.at(-1), { pista: 'p2', capa: 'baja' }, '«ahorro» se perdio al reconectar');
    assert.equal(g.estado().elegida, 'ahorro');
  });

  it('si la pista desaparece, desaparecen las opciones; al volver, vuelven', async () => {
    const { g } = calidad();
    await g.cambioLaPista('p1');
    await g.cambioLaPista(null);
    assert.deepEqual(g.estado().opciones, []);
    await g.cambioLaPista('p3');
    assert.equal(g.estado().opciones.length, 3);
  });

  it('una lectura de capas vieja que llega tarde no pisa a la nueva', async () => {
    let resolverVieja: ((capas: DefinicionDeCapa[]) => void) | null = null;
    let llamada = 0;
    const { g } = calidad(() => {
      llamada += 1;
      if (llamada === 1) {
        return new Promise<DefinicionDeCapa[]>((resolver) => {
          resolverVieja = resolver;
        });
      }
      return Promise.resolve([]);
    });
    const vieja = g.cambioLaPista('p1');
    await g.cambioLaPista('p2');
    assert.deepEqual(g.estado().opciones, []);
    (resolverVieja as unknown as (capas: DefinicionDeCapa[]) => void)(TRES_CAPAS);
    await vieja;
    assert.deepEqual(g.estado().opciones, [], 'las capas de la pista anterior han pisado a la actual');
  });

  it('destruido, no avisa mas', async () => {
    const { g, avisos } = calidad();
    await g.cambioLaPista('p1');
    const antes = avisos.length;
    g.destruir();
    await g.cambioLaPista('p2');
    await g.elegir('alta');
    assert.equal(avisos.length, antes);
  });
});

/* ------------------------------------------------------ Conexion lenta ---- */

describe('conexion lenta: se emite, y sin parpadear', () => {
  function vigia() {
    const avisos: boolean[] = [];
    return { v: crearVigiaDeConexion((buena) => avisos.push(buena)), avisos };
  }

  it('empieza en buena y no avisa mientras no cambie', () => {
    const { v, avisos } = vigia();
    assert.equal(v.buena(), true);
    v.nota(5);
    v.nota(4);
    v.nota(3);
    assert.deepEqual(avisos, []);
  });

  it('una sola lectura mala es un bache: no avisa', () => {
    const { v, avisos } = vigia();
    v.nota(1);
    v.nota(5);
    assert.deepEqual(avisos, []);
  });

  it('varias malas seguidas: conexion lenta. Varias buenas seguidas: recuperada', () => {
    const { v, avisos } = vigia();
    for (let i = 0; i < LECTURAS_PARA_CAMBIAR; i += 1) v.nota(2);
    assert.deepEqual(avisos, [false]);
    assert.equal(v.buena(), false);

    v.nota(4);
    assert.deepEqual(avisos, [false], 'una buena suelta no es recuperarse');
    for (let i = 0; i < LECTURAS_PARA_CAMBIAR; i += 1) v.nota(4);
    assert.deepEqual(avisos, [false, true]);
  });

  it('«todavia no se sabe» (-1) y «no se pudo medir» (0) no deciden nada', () => {
    const { v, avisos } = vigia();
    for (const nota of [-1, 0, -1, 0, 0]) v.nota(nota);
    v.nota(undefined);
    v.nota('mala');
    v.nota(Number.NaN);
    assert.deepEqual(avisos, []);
    assert.equal(v.buena(), true);
  });

  it('una pista degradada avisa en el momento, sin esperar lecturas', () => {
    const { v, avisos } = vigia();
    v.pistaDegradada(true);
    assert.deepEqual(avisos, [false]);
    v.pistaDegradada(true);
    assert.deepEqual(avisos, [false], 'repite el mismo aviso');
    v.pistaDegradada(false);
    assert.deepEqual(avisos, [false, true]);
  });

  it('con la red mala, que la pista se restaure no basta para decir que va bien', () => {
    const { v, avisos } = vigia();
    for (let i = 0; i < LECTURAS_PARA_CAMBIAR; i += 1) v.nota(1);
    v.pistaDegradada(true);
    v.pistaDegradada(false);
    assert.deepEqual(avisos, [false]);
    assert.equal(v.buena(), false);
  });

  it('reiniciar vuelve al principio sin avisar', () => {
    const { v, avisos } = vigia();
    v.pistaDegradada(true);
    v.reiniciar();
    assert.equal(v.buena(), true);
    assert.deepEqual(avisos, [false]);
  });
});

describe('REVISION 04/10: efectos', () => {
  it('con un efecto puesto, una pista nueva hay que reponerla AUNQUE nadie haya llamado a salir', async () => {
    /*
      La maquina de directo reintenta entrando otra vez, sin salir antes. Si
      «hay que reponer» dependiera de haber salido, la camara naceria encendida
      y sin efecto: quien tapaba su fondo lo enseñaria.
    */
    const doble = complementoDePrueba();
    const { g } = gestor(doble.complemento);
    await g.aplicar({ tipo: 'desenfoque' });
    assert.equal(g.hayQueReponer(), true, 'no avisa de que hay un efecto que reponer');

    doble.llamadas.length = 0;
    const estado = await g.laPistaEsNueva();
    assert.deepEqual(doble.llamadas, ['activar', `desenfocar(${RADIO_DE_DESENFOQUE})`]);
    assert.deepEqual(estado.efecto, { tipo: 'desenfoque' });
  });

  it('sin efecto no hay nada que reponer', async () => {
    const { g } = gestor();
    assert.equal(g.hayQueReponer(), false);
    await g.aplicar({ tipo: 'desenfoque' });
    await g.aplicar({ tipo: 'ninguno' });
    assert.equal(g.hayQueReponer(), false);
  });

  it('si `activar` contesta TARDE, el efecto que aparece se quita solo', async () => {
    /*
      Android lento: cargar el modelo tarda mas que el limite. La hoja ya dijo
      «no se pudo»; un segundo despues el desenfoque aparece igual. Sin esto se
      quedaba puesto y «Ninguno» no hacia nada, porque para la aplicacion ya
      estaba en «ninguno».
    */
    const llamadas: string[] = [];
    let resolverActivar: (() => void) | null = null;
    const reloj = crearReloj();
    const g = crearGestorDeEfectos({
      complemento: {
        activar: () =>
          new Promise<void>((resolver) => {
            llamadas.push('activar');
            resolverActivar = resolver;
          }),
        desactivar: async () => void llamadas.push('desactivar'),
        desenfocar: async () => void llamadas.push('desenfocar'),
        ponerFondo: async () => void llamadas.push('fondo'),
      },
      fondos: FONDOS,
      programar: reloj.programar,
      alCambiar: () => {},
    });

    const pedido = g.aplicar({ tipo: 'desenfoque' });
    await asentar();
    reloj.avanzar(ESPERA_DE_EFECTO_MS);
    const estado = await pedido;
    assert.equal(estado.error, 'no_se_pudo');

    // «Ninguno» en ese momento SI llama al SDK: puede estar puesto.
    llamadas.length = 0;
    await g.aplicar({ tipo: 'ninguno' });
    assert.deepEqual(llamadas, ['desactivar'], '«Ninguno» no ha hecho nada');

    // Y cuando por fin contesta, se quita lo que haya aparecido.
    llamadas.length = 0;
    (resolverActivar as unknown as () => void)();
    await asentar();
    assert.deepEqual(llamadas, ['desactivar'], 'el efecto que llego tarde se ha quedado puesto');
    assert.equal(g.estado().efecto.tipo, 'ninguno');
  });

  it('salir quita el efecto aunque solo «pueda» estar puesto', async () => {
    const llamadas: string[] = [];
    const reloj = crearReloj();
    const g = crearGestorDeEfectos({
      complemento: {
        activar: () => new Promise<void>(() => void llamadas.push('activar')),
        desactivar: async () => void llamadas.push('desactivar'),
        desenfocar: async () => {},
        ponerFondo: async () => {},
      },
      fondos: FONDOS,
      programar: reloj.programar,
      alCambiar: () => {},
    });
    const pedido = g.aplicar({ tipo: 'desenfoque' });
    await asentar();
    reloj.avanzar(ESPERA_DE_EFECTO_MS);
    await pedido;
    llamadas.length = 0;
    await g.apagarParaSalir();
    assert.deepEqual(llamadas, ['desactivar']);
  });
});

describe('REVISION 04/10: las capas se preguntan una segunda vez, y solo una', () => {
  /*
    Las capas se leen en el momento en que aparece la pista. No se ha podido
    comprobar en un telefono si el proveedor ya las tiene anunciadas en ese
    instante; si no, sin esto el selector no saldria en toda la emision.
  */
  function conRelectura() {
    const reloj = crearReloj();
    let lecturas = 0;
    let capas: DefinicionDeCapa[] = [];
    const g = crearGestorDeCalidad({
      leerCapas: async () => {
        lecturas += 1;
        return capas;
      },
      fijarCapa: async () => {},
      alCambiar: () => {},
      programar: reloj.programar,
      esperaParaReleerMs: 4_000,
    });
    return {
      g,
      reloj,
      lecturas: () => lecturas,
      yaHayCapas: () => {
        capas = TRES_CAPAS;
      },
    };
  }

  it('una pista que aparece sin capas y las tiene poco despues acaba ofreciendolas', async () => {
    const { g, reloj, lecturas, yaHayCapas } = conRelectura();
    await g.cambioLaPista('p1');
    assert.equal(lecturas(), 1);
    assert.deepEqual(g.estado().opciones, []);

    yaHayCapas();
    reloj.avanzar(3_999);
    await asentar();
    assert.equal(lecturas(), 1, 'ha releido antes de tiempo');
    reloj.avanzar(1);
    await asentar();
    assert.equal(lecturas(), 2);
    assert.equal(g.estado().opciones.length, 3, 'el selector no saldria en toda la emision');
  });

  it('si sigue sin capas no insiste: una segunda lectura, y ninguna mas', async () => {
    const { g, reloj, lecturas } = conRelectura();
    await g.cambioLaPista('p1');
    for (let i = 0; i < 20; i += 1) {
      reloj.avanzar(4_000);
      await asentar();
    }
    assert.equal(lecturas(), 2, 'pregunta por las capas una y otra vez');
    assert.equal(reloj.vivos(), 0);
    assert.deepEqual(g.estado().opciones, []);
  });

  it('con capas a la primera no hay segunda lectura', async () => {
    const { g, reloj, lecturas, yaHayCapas } = conRelectura();
    yaHayCapas();
    await g.cambioLaPista('p1');
    reloj.avanzar(60_000);
    await asentar();
    assert.equal(lecturas(), 1);
    assert.equal(reloj.vivos(), 0);
  });

  it('si la pista desaparece o se destruye antes, la relectura se cancela', async () => {
    const uno = conRelectura();
    await uno.g.cambioLaPista('p1');
    await uno.g.cambioLaPista(null);
    uno.reloj.avanzar(60_000);
    await asentar();
    assert.equal(uno.lecturas(), 1);
    assert.equal(uno.reloj.vivos(), 0);

    const dos = conRelectura();
    await dos.g.cambioLaPista('p1');
    dos.g.destruir();
    dos.reloj.avanzar(60_000);
    await asentar();
    assert.equal(dos.lecturas(), 1);
    assert.equal(dos.reloj.vivos(), 0);
  });
});
