import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CommonActions, StackActions, StackRouter, TabRouter } from '@react-navigation/routers';

import { MARGEN_DE_SALIDA_MS, decidirAtras } from './atras.ts';
import { ORDEN_SECCIONES } from './secciones.ts';

/**
 * El boton Atras de Android, recorrido por recorrido.
 *
 * QUE SE ESTA COMPROBANDO, Y POR QUE ASI. El fallo que reporto el cliente
 * —«Atras cierra la aplicacion en vez de deshacer la navegacion»— no se puede
 * cazar mirando el texto del codigo con una expresion regular: depende de si en
 * ese punto del recorrido QUEDA algo detras. Asi que aqui se monta el recorrido
 * de verdad.
 *
 * LOS ROUTERS SON LOS DE LA LIBRERIA, NO UNA IMITACION. `TabRouter` y
 * `StackRouter` de `@react-navigation/routers` son funciones puras y se
 * importan tal cual, con el mismo `backBehavior="history"` y la misma lista de
 * secciones (`ORDEN_SECCIONES`) que usa `app/(tabs)/_layout.tsx`. No hay aqui
 * ningun historial escrito a mano: si mañana alguien cambia el `backBehavior`
 * o mueve una seccion, estas pruebas se enteran. Un modelo propio del historial
 * seria una segunda verdad y contaria justo lo que le apeteciera.
 *
 * Lo unico propio es `puedeVolver`, que compone las dos respuestas igual que lo
 * hace `canGoBack()` del contenedor: pregunta al navegador ENFOCADO y, si este
 * dice que no, sube al padre.
 */

/** Las rutas que viven dentro de `(tabs)`: las cinco secciones y los detalles. */
const RUTAS_DE_PESTANAS = [
  ...ORDEN_SECCIONES,
  'profile/[id]',
  'circle/[id]',
  'audio/[id]',
  'followers/[id]',
  'following/[id]',
];

/** Una muestra representativa de las rutas de la pila raiz (`app/`). */
const RUTAS_DE_LA_PILA = [
  'index',
  '(tabs)',
  'chat/[id]',
  'post/[id]',
  'comments/[id]',
  'course/[id]',
  'lesson/[id]',
  'settings',
  'reset-password',
];

type Estado = { index: number; routes: { name: string; params?: object }[] };

function crearAplicacion({ arranqueEn = '(tabs)' }: { arranqueEn?: string } = {}) {
  const opcionesDePestanas = {
    routeNames: RUTAS_DE_PESTANAS,
    routeParamList: {},
    routeGetIdList: {},
  };
  const opcionesDePila = {
    routeNames: RUTAS_DE_LA_PILA,
    routeParamList: {},
    routeGetIdList: {},
  };

  // Exactamente la configuracion de `app/(tabs)/_layout.tsx`.
  const pestanas = TabRouter({ backBehavior: 'history', initialRouteName: 'home' });
  const pila = StackRouter({ initialRouteName: arranqueEn });

  /* eslint-disable @typescript-eslint/no-explicit-any */
  let estadoDePestanas: any = pestanas.getInitialState(opcionesDePestanas as any);
  let estadoDeLaPila: any = pila.getInitialState(opcionesDePila as any);

  const cima = (): string => estadoDeLaPila.routes[estadoDeLaPila.index].name;
  /** Dentro de `(tabs)` manda el navegador de pestanas; fuera, la pila. */
  const enPestanas = (): boolean => cima() === '(tabs)';

  const puedeVolverEnPestanas = () =>
    pestanas.getStateForAction(
      estadoDePestanas,
      CommonActions.goBack() as any,
      opcionesDePestanas as any,
    ) !== null;

  const puedeVolverEnLaPila = () =>
    pila.getStateForAction(
      estadoDeLaPila,
      CommonActions.goBack() as any,
      opcionesDePila as any,
    ) !== null;

  return {
    /** Cambiar de pestana o abrir un detalle DE DENTRO de las pestanas. */
    irAPestana(nombre: string, params?: object) {
      const siguiente = pestanas.getStateForAction(
        estadoDePestanas,
        CommonActions.navigate(nombre, params) as any,
        opcionesDePestanas as any,
      );
      assert.ok(siguiente, `el TabRouter no supo ir a ${nombre}`);
      estadoDePestanas = siguiente;
    },
    /** Apilar una pantalla de la raiz (chat, publicacion, curso, ajustes). */
    apilar(nombre: string, params?: object) {
      const siguiente = pila.getStateForAction(
        estadoDeLaPila,
        StackActions.push(nombre, params) as any,
        opcionesDePila as any,
      );
      assert.ok(siguiente, `la pila no supo apilar ${nombre}`);
      estadoDeLaPila = siguiente;
    },
    /** `router.replace`: destruye la ruta de la que se sale. */
    reemplazar(nombre: string, params?: object) {
      const siguiente = pila.getStateForAction(
        estadoDeLaPila,
        StackActions.replace(nombre, params) as any,
        opcionesDePila as any,
      );
      assert.ok(siguiente, `la pila no supo reemplazar por ${nombre}`);
      estadoDeLaPila = siguiente;
    },
    /** Lo mismo que responde `canGoBack()` del contenedor de navegacion. */
    puedeVolver(): boolean {
      return enPestanas()
        ? puedeVolverEnPestanas() || puedeVolverEnLaPila()
        : puedeVolverEnLaPila();
    },
    /**
     * Una pulsacion de Atras: decide con la funcion de verdad y, si toca
     * volver, retrocede por donde corresponda.
     */
    atras(entorno: { hayCapaAbierta?: boolean; msDesdeLaUltimaPulsacion?: number | null } = {}) {
      const decision = decidirAtras({
        hayCapaAbierta: entorno.hayCapaAbierta ?? false,
        puedeVolver: this.puedeVolver(),
        msDesdeLaUltimaPulsacion: entorno.msDesdeLaUltimaPulsacion ?? null,
      });
      if (decision === 'volver') {
        if (enPestanas() && puedeVolverEnPestanas()) {
          estadoDePestanas = pestanas.getStateForAction(
            estadoDePestanas,
            CommonActions.goBack() as any,
            opcionesDePestanas as any,
          );
        } else {
          estadoDeLaPila = pila.getStateForAction(
            estadoDeLaPila,
            CommonActions.goBack() as any,
            opcionesDePila as any,
          );
        }
      }
      return decision;
    },
    /** Donde esta la persona AHORA, en una sola cadena. */
    donde(): string {
      return enPestanas() ? estadoDePestanas.routes[estadoDePestanas.index].name : cima();
    },
    parametros(): unknown {
      const estado: Estado = enPestanas() ? estadoDePestanas : estadoDeLaPila;
      return estado.routes[estado.index]?.params;
    },
    /** Para comprobar que algo NO toco la navegacion. */
    huella(): string {
      return JSON.stringify([estadoDeLaPila.history ?? null, estadoDePestanas.history]);
    },
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

describe('el recorrido se deshace paso a paso, sin pulsar rapido', () => {
  it('Inicio -> Explorar -> perfil ajeno -> Mensajes vuelve por donde vino', () => {
    /*
      ES EL RECORRIDO QUE EL CLIENTE DESCRIBIO. Cada Atras tiene que devolver
      una pantalla, y ninguno puede pedir confirmacion: el aviso de salida solo
      aparece cuando ya no queda nada detras.
    */
    const app = crearAplicacion();
    app.irAPestana('explore');
    app.irAPestana('profile/[id]', { id: 'ajeno' });
    app.irAPestana('messages');
    assert.equal(app.donde(), 'messages');

    assert.equal(app.atras(), 'volver');
    assert.equal(app.donde(), 'profile/[id]');
    assert.deepEqual(app.parametros(), { id: 'ajeno' });

    assert.equal(app.atras(), 'volver');
    assert.equal(app.donde(), 'explore');

    assert.equal(app.atras(), 'volver');
    assert.equal(app.donde(), 'home');
  });

  it('en Inicio, y solo ahi, la primera pulsacion avisa', () => {
    const app = crearAplicacion();
    app.irAPestana('explore');
    app.irAPestana('profile/[id]', { id: 'ajeno' });
    app.irAPestana('messages');
    app.atras();
    app.atras();
    app.atras();
    // Cuatro pulsaciones para tres pasos: la cuarta es la primera que avisa.
    assert.equal(app.atras(), 'avisar');
    assert.equal(app.donde(), 'home', 'avisar no puede mover la navegacion');
  });
});

describe('historial entre pestanas', () => {
  it('vuelve a la pestana anterior, no siempre a Inicio', () => {
    /*
      Con el `backBehavior` por defecto (`firstRoute`) Atras saltaba de
      cualquier pestana a Inicio y la siguiente pulsacion cerraba la
      aplicacion: dos pulsaciones para perder todo el recorrido.
    */
    const app = crearAplicacion();
    app.irAPestana('explore');
    app.irAPestana('create');
    assert.equal(app.atras(), 'volver');
    assert.equal(app.donde(), 'explore');
  });

  it('varias visitas a la misma pestana no la repiten en el historial', () => {
    /*
      LO QUE DE VERDAD HACE `backBehavior="history"`: al volver a una pestana ya
      visitada, la quita de donde estaba y la pone al final. Asi Inicio ->
      Explorar -> Inicio se deshace en UNA pulsacion, no en dos, y el historial
      no crece sin limite dando vueltas por la barra.

      Se comprueba porque es una diferencia visible para quien usa la
      aplicacion, y porque si alguien cambiara a `fullHistory` esto cambiaria
      sin que nadie se enterase.
    */
    const app = crearAplicacion();
    app.irAPestana('explore');
    app.irAPestana('home');
    assert.equal(app.atras(), 'volver');
    assert.equal(app.donde(), 'explore');
    assert.equal(app.atras(), 'avisar', 'Inicio ya no esta detras: estaba delante');
  });

  it('perfil propio y perfil ajeno son sitios distintos', () => {
    const app = crearAplicacion();
    app.irAPestana('profile/index');
    app.irAPestana('profile/[id]', { id: 'otra-persona' });
    assert.equal(app.atras(), 'volver');
    assert.equal(app.donde(), 'profile/index');
  });
});

describe('historial entre pestana y detalle', () => {
  it('un chat se cierra encima de la pestana desde la que se abrio', () => {
    const app = crearAplicacion();
    app.irAPestana('messages');
    app.apilar('chat/[id]', { id: 'c1' });
    assert.equal(app.donde(), 'chat/[id]');
    assert.equal(app.atras(), 'volver');
    assert.equal(app.donde(), 'messages');
  });

  it('publicacion y comentarios se deshacen en orden', () => {
    const app = crearAplicacion();
    app.apilar('post/[id]', { id: 'p1' });
    app.apilar('comments/[id]', { id: 'p1' });
    assert.equal(app.atras(), 'volver');
    assert.equal(app.donde(), 'post/[id]');
    assert.equal(app.atras(), 'volver');
    assert.equal(app.donde(), 'home');
  });

  it('curso y leccion se deshacen en orden', () => {
    const app = crearAplicacion();
    app.irAPestana('explore');
    app.apilar('course/[id]', { id: 'k1' });
    app.apilar('lesson/[id]', { id: 'l1' });
    assert.equal(app.atras(), 'volver');
    assert.equal(app.donde(), 'course/[id]');
    assert.equal(app.atras(), 'volver');
    assert.equal(app.donde(), 'explore');
  });

  it('desde ajustes NUNCA se sale de la aplicacion', () => {
    /*
      Una pantalla secundaria siempre tiene algo detras. Que Atras cerrara la
      aplicacion desde Ajustes es justo lo que el cliente describio.
    */
    const app = crearAplicacion();
    app.irAPestana('profile/index');
    app.apilar('settings');
    assert.equal(app.atras(), 'volver');
    assert.notEqual(app.donde(), 'settings');
  });

  it('estando en un detalle, Atras sale del detalle y no cambia de pestana', () => {
    const app = crearAplicacion();
    app.irAPestana('explore');
    app.apilar('post/[id]', { id: 'p1' });
    app.atras();
    assert.equal(app.donde(), 'explore');
  });
});

describe('rutas abiertas directamente (enlace profundo)', () => {
  it('un chat abierto desde una notificacion no deja salir de un golpe', () => {
    /*
      LA APLICACION ARRANCA EN EL CHAT: no hay nada apilado debajo. Antes, la
      primera pulsacion se encontraba sin historial y la aplicacion se cerraba
      desde una conversacion. Ahora avisa, que es lo que hace en la raiz.
    */
    const app = crearAplicacion({ arranqueEn: 'chat/[id]' });
    assert.equal(app.donde(), 'chat/[id]');
    assert.equal(app.atras(), 'avisar');
    assert.equal(app.donde(), 'chat/[id]', 'sigue en el chat: avisar no navega');
  });

  it('el enlace de recuperar contrasena tampoco se cierra a la primera', () => {
    const app = crearAplicacion({ arranqueEn: 'reset-password' });
    assert.equal(app.atras(), 'avisar');
  });

  it('tras `replace` a la raiz ya no queda pila, y aun asi hace falta confirmar', () => {
    /*
      Es el efecto de los `router.replace('/')` que usan como respaldo las
      cabeceras: destruyen la ruta anterior y dejan la pila con una sola
      entrada. No es un error por si mismo —la raiz vuelve a decidir a donde
      ir—, pero deja al usuario a una pulsacion del cierre, y por eso la
      confirmacion tiene que estar puesta.
    */
    const app = crearAplicacion({ arranqueEn: 'chat/[id]' });
    app.reemplazar('(tabs)');
    assert.equal(app.donde(), 'home');
    assert.equal(app.atras(), 'avisar');
  });
});

describe('la confirmacion de salida', () => {
  it('la primera pulsacion en la raiz NO sale', () => {
    assert.equal(
      decidirAtras({ hayCapaAbierta: false, puedeVolver: false, msDesdeLaUltimaPulsacion: null }),
      'avisar',
    );
  });

  it('la segunda dentro de 2 s SI sale', () => {
    assert.equal(
      decidirAtras({ hayCapaAbierta: false, puedeVolver: false, msDesdeLaUltimaPulsacion: 1999 }),
      'salir',
    );
  });

  it('la segunda pasados 2 s NO sale: vuelve a avisar', () => {
    assert.equal(
      decidirAtras({
        hayCapaAbierta: false,
        puedeVolver: false,
        msDesdeLaUltimaPulsacion: MARGEN_DE_SALIDA_MS,
      }),
      'avisar',
    );
    assert.equal(
      decidirAtras({ hayCapaAbierta: false, puedeVolver: false, msDesdeLaUltimaPulsacion: 5000 }),
      'avisar',
    );
  });

  it('un reloj que salta hacia atras no cuenta como confirmacion', () => {
    // Cambio de hora o sincronizacion horaria: equivocarse aqui cierra la
    // aplicacion de alguien que solo pulso una vez.
    assert.equal(
      decidirAtras({ hayCapaAbierta: false, puedeVolver: false, msDesdeLaUltimaPulsacion: -30000 }),
      'avisar',
    );
    assert.equal(
      decidirAtras({
        hayCapaAbierta: false,
        puedeVolver: false,
        msDesdeLaUltimaPulsacion: Number.NaN,
      }),
      'avisar',
    );
  });

  it('con historial detras NUNCA se sale, por rapido que se pulse', () => {
    /*
      La regla que arregla la queja: la doble pulsacion es solo para la raiz. Si
      hiciera falta confirmar en cada paso, deshacer un recorrido de cuatro
      pantallas pediria ocho pulsaciones rapidas.
    */
    assert.equal(
      decidirAtras({ hayCapaAbierta: false, puedeVolver: true, msDesdeLaUltimaPulsacion: 1 }),
      'volver',
    );
  });
});

describe('las capas se cierran antes que la pantalla', () => {
  it('un dialogo abierto se queda el Atras aunque haya historial', () => {
    assert.equal(
      decidirAtras({ hayCapaAbierta: true, puedeVolver: true, msDesdeLaUltimaPulsacion: null }),
      'cerrarCapa',
    );
  });

  it('un dialogo abierto en la raiz tampoco deja salir', () => {
    // Sin esta regla, la confirmacion de «¿borrar la cuenta?» abierta en Inicio
    // se saldria de la aplicacion en vez de cerrarse.
    assert.equal(
      decidirAtras({ hayCapaAbierta: true, puedeVolver: false, msDesdeLaUltimaPulsacion: 10 }),
      'cerrarCapa',
    );
  });

  it('estando en un detalle, la capa va primero y la pantalla despues', () => {
    const app = crearAplicacion();
    app.apilar('post/[id]', { id: 'p1' });
    // Con los comentarios abiertos: se cierran, y la publicacion sigue puesta.
    assert.equal(app.atras({ hayCapaAbierta: true }), 'cerrarCapa');
    assert.equal(app.donde(), 'post/[id]');
    // Ya sin capa: ahora si se sale de la publicacion.
    assert.equal(app.atras(), 'volver');
    assert.equal(app.donde(), 'home');
  });
});

describe('lo que NO debe tocar la navegacion', () => {
  it('un toast no crea otra entrada de historial', () => {
    /*
      El aviso «Presiona una vez más para salir de la aplicación» se pinta con el mismo toast que
      «Publicado» o «Guardado». Si un toast entrara en el historial, cada aviso
      dejaria un paso fantasma y Atras dejaria de deshacer navegacion para
      deshacer avisos.

      Se comprueba sobre el estado real de los routers: la huella del historial
      antes y despues de la pulsacion que avisa tiene que ser identica.
    */
    const app = crearAplicacion();
    const antes = app.huella();
    assert.equal(app.atras(), 'avisar');
    assert.equal(app.huella(), antes);
    // Y el segundo aviso tampoco.
    assert.equal(app.atras({ msDesdeLaUltimaPulsacion: MARGEN_DE_SALIDA_MS + 1 }), 'avisar');
    assert.equal(app.huella(), antes);
  });
});
