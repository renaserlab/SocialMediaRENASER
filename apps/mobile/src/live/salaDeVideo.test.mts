import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  PAPELES_EN_SALA,
  crearSalaDeVideo,
  crearSalaFalsa,
  elegirPistaPrincipal,
  esSalaNoDisponible,
  hayProveedorDeVideo,
  hayVideoEnLaCredencial,
  leerCredencial,
  registrarFabricaDeSala,
  SalaNoDisponible,
  type CredencialDeVideo,
  type EventoDeSala,
  type PistaDeVideo,
  type SalaDeVideo,
} from './salaDeVideo.ts';

/**
 * EL PUNTO POR DONDE ENTRARA EL SDK, comprobado ANTES de que exista el SDK.
 *
 * Aqui se prueban las dos mitades que no dependen del proveedor y que, si estan
 * mal, van a estar mal el dia que se enchufe el paquete de verdad:
 *
 *  1. LA LECTURA DE LA CREDENCIAL. Es la frontera con el backend. Un campo que
 *     se lee mal aqui —`can_publish` sobre todo— pone a emitir a quien el
 *     servidor no autorizo, o deja sin controles a quien si.
 *
 *  2. LA SALA FALSA. No es un adorno: es la implementacion que corre HOY en
 *     todos los telefonos. Tiene que rechazar `unirse` de forma clasificable
 *     —no con un error generico— y tiene que soltar sus oyentes al destruirse,
 *     que es lo que la pantalla usa para no dejar nada vivo al desmontar.
 */

afterEach(() => {
  // El registro es de MODULO: una prueba que deja una fabrica puesta se la
  // pasaria a la siguiente.
  registrarFabricaDeSala(null);
});

/** Una credencial valida completa, para partir de ella y estropear un campo. */
function credencialCruda(): Record<string, unknown> {
  return {
    provider: '100ms',
    token: 'jwt.de.mentira',
    url: '',
    expires_in: 3600,
    can_publish: true,
    role: 'host',
    room_id: 'sala-1',
  };
}

describe('leer la credencial que manda el backend', () => {
  it('traduce los siete campos del contrato', () => {
    const leida = leerCredencial(credencialCruda());
    assert.deepEqual(leida, {
      proveedor: '100ms',
      token: 'jwt.de.mentira',
      url: '',
      expiraEnSegundos: 3600,
      puedePublicar: true,
      papel: 'host',
      salaId: 'sala-1',
    } satisfies CredencialDeVideo);
  });

  it('sin `provider` no hay credencial que valga', () => {
    // Es el unico campo obligatorio: sin el no se sabe ni si hay video.
    const sinProveedor = { ...credencialCruda(), provider: '' };
    assert.equal(leerCredencial(sinProveedor), null);
    assert.equal(leerCredencial({ ...credencialCruda(), provider: 42 }), null);
  });

  it('lo que no es un objeto no es una credencial', () => {
    // Un proxy que devuelve HTML, una respuesta vacia, una lista: todo eso
    // llega como 200 y no es un error HTTP. Tiene que distinguirse.
    for (const basura of [null, undefined, 'ok', 7, [], [credencialCruda()]]) {
      assert.equal(leerCredencial(basura), null, `deberia rechazar ${JSON.stringify(basura)}`);
    }
  });

  it('`can_publish` solo es verdad si llega EXACTAMENTE en true', () => {
    /*
      El fallo que esto impide: `Boolean("false")` es `true`. Un backend que
      serializara el booleano como texto ascenderia a emisor a cualquiera que
      abriera la sala, con su camara y su microfono encendidos.
    */
    for (const valor of ['true', 'false', 1, 'si', {}, [], null, undefined]) {
      const leida = leerCredencial({ ...credencialCruda(), can_publish: valor });
      assert.equal(leida?.puedePublicar, false, `can_publish=${JSON.stringify(valor)}`);
    }
    assert.equal(leerCredencial({ ...credencialCruda(), can_publish: true })?.puedePublicar, true);
  });

  it('un papel que no existe se degrada a espectador', () => {
    // Hacia abajo siempre: un papel desconocido no puede conceder mas de lo que
    // concede el que menos concede.
    const leida = leerCredencial({ ...credencialCruda(), role: 'superadmin' });
    assert.equal(leida?.papel, 'viewer');
    for (const papel of PAPELES_EN_SALA) {
      assert.equal(leerCredencial({ ...credencialCruda(), role: papel })?.papel, papel);
    }
  });

  it('una caducidad que no es un numero positivo se queda en cero', () => {
    for (const valor of [-1, 0, 'mucho', null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const leida = leerCredencial({ ...credencialCruda(), expires_in: valor });
      assert.equal(leida?.expiraEnSegundos, 0, `expires_in=${String(valor)}`);
    }
    assert.equal(leerCredencial({ ...credencialCruda(), expires_in: 90.7 })?.expiraEnSegundos, 90);
  });

  it('la url vacia de 100ms es valida: la sala va dentro del token', () => {
    const leida = leerCredencial({ ...credencialCruda(), url: undefined });
    assert.equal(leida?.url, '');
    assert.equal(hayVideoEnLaCredencial(leida!), true);
  });
});

describe('cuando una credencial NO da video', () => {
  it('`provider: "none"` es un 200 que significa «no hay video»', () => {
    const leida = leerCredencial({ ...credencialCruda(), provider: 'none', token: '' });
    // Se lee bien —no es un error— pero no hay nada que reproducir.
    assert.equal(leida?.proveedor, 'none');
    assert.equal(hayVideoEnLaCredencial(leida!), false);
  });

  it('un proveedor de verdad sin token tampoco sirve', () => {
    const leida = leerCredencial({ ...credencialCruda(), token: '' });
    assert.equal(hayVideoEnLaCredencial(leida!), false);
  });
});

describe('la sala falsa, que es la que corre hoy', () => {
  it('rechaza unirse con un fallo CLASIFICABLE, no con un error cualquiera', async () => {
    const sala = crearSalaFalsa();
    const error = await sala.unirse(leerCredencial(credencialCruda())!, { publicar: true }).then(
      () => null,
      (fallo: unknown) => fallo,
    );
    assert.ok(error instanceof SalaNoDisponible);
    // Se compara la CLASE y no el nombre ni el mensaje: el minificador reescribe
    // los nombres de clase y el mensaje es texto que alguien va a corregir.
    assert.equal(esSalaNoDisponible(error), true);
    assert.equal((error as SalaNoDisponible).clase, 'sin_proveedor');
  });

  it('no finge encender lo que no puede encender', async () => {
    const sala = crearSalaFalsa();
    const tras = await sala.alternarCamara(true);
    assert.equal(tras.camara, false, 'no hay pista que encender sin proveedor');
    assert.equal((await sala.alternarMicrofono(true)).microfono, false);
    assert.deepEqual(sala.medios(), {
      camara: false,
      microfono: false,
      camaraFrontal: true,
      publicando: false,
    });
  });

  it('salir siempre resuelve, aunque nunca se entrara', async () => {
    // Salir tiene que poder ocurrir SIEMPRE: es lo que corre al desmontar, y
    // una promesa rechazada ahi acaba en un fallo sin capturar.
    await crearSalaFalsa().salir();
  });

  it('los medios que devuelve son una COPIA: nadie puede escribir en ella', () => {
    const sala = crearSalaFalsa();
    const primera = sala.medios();
    primera.camara = true;
    assert.equal(sala.medios().camara, false);
  });
});

describe('la limpieza de la sala', () => {
  it('quitar un oyente lo quita, y destruir los quita todos', () => {
    const sala = crearSalaFalsa();
    const recibidos: EventoDeSala[] = [];
    const quitar = sala.alOcurrir((evento) => recibidos.push(evento));

    quitar();
    // Quitar dos veces no puede romper: el desmontaje puede correr dos veces.
    quitar();

    sala.destruir();
    // Y despues de destruir ya no se admite a nadie nuevo, para que un efecto
    // que llegue tarde no deje un oyente colgado de una sala muerta.
    const quitarTarde = sala.alOcurrir(() => recibidos.push({ tipo: 'conectado' }));
    quitarTarde();
    assert.deepEqual(recibidos, []);
  });

  it('destruir es idempotente', () => {
    const sala = crearSalaFalsa();
    sala.destruir();
    sala.destruir();
  });
});

describe('el registro: como entrara el SDK sin tocar nada mas', () => {
  it('sin fabrica registrada se sirve la falsa', () => {
    assert.equal(hayProveedorDeVideo(), false);
    assert.equal(crearSalaDeVideo().proveedor, 'ninguno');
  });

  it('con fabrica registrada se sirve la de verdad', () => {
    const falsoSdk: SalaDeVideo = {
      ...crearSalaFalsa(),
      proveedor: '100ms',
      unirse: () => Promise.resolve(),
    };
    registrarFabricaDeSala(() => falsoSdk);

    assert.equal(hayProveedorDeVideo(), true);
    assert.equal(crearSalaDeVideo().proveedor, '100ms');
  });

  it('cada llamada fabrica una sala NUEVA', () => {
    // Dos pantallas de directo abiertas a la vez —o una recarga en caliente—
    // no pueden compartir la misma sala: la segunda desconectaria a la primera.
    let fabricadas = 0;
    registrarFabricaDeSala(() => {
      fabricadas += 1;
      return crearSalaFalsa();
    });
    const a = crearSalaDeVideo();
    const b = crearSalaDeVideo();
    assert.equal(fabricadas, 2);
    assert.notEqual(a, b);
  });

  it('retirar la fabrica vuelve a la falsa', () => {
    registrarFabricaDeSala(() => ({ ...crearSalaFalsa(), proveedor: '100ms' }));
    registrarFabricaDeSala(null);
    assert.equal(hayProveedorDeVideo(), false);
    assert.equal(crearSalaDeVideo().proveedor, 'ninguno');
  });
});

describe('que pista ocupa el panel grande', () => {
  const pista = (p: Partial<PistaDeVideo> & { id: string }): PistaDeVideo => ({
    local: false,
    papel: 'viewer',
    silenciada: false,
    ...p,
  });
  const propia = pista({ id: 'mia', local: true, papel: 'host' });
  const anfitrion = pista({ id: 'anfitrion', papel: 'host' });
  const moderadora = pista({ id: 'moderadora', papel: 'moderator' });

  it('quien EMITE ve su propia camara, que es con la que se encuadra', () => {
    assert.equal(elegirPistaPrincipal([anfitrion, propia], { emito: true })?.id, 'mia');
  });

  it('quien MIRA ve al anfitrion, nunca su propia pista', () => {
    assert.equal(elegirPistaPrincipal([propia, moderadora, anfitrion], { emito: false })?.id, 'anfitrion');
  });

  it('con la camara del anfitrion apagada, quien mas emita con imagen antes que negro', () => {
    const apagado = { ...anfitrion, silenciada: true };
    assert.equal(elegirPistaPrincipal([apagado, moderadora], { emito: false })?.id, 'moderadora');
  });

  it('sin nadie con imagen, null: la pantalla pinta el cartel del estado', () => {
    assert.equal(elegirPistaPrincipal([], { emito: false }), null);
    assert.equal(elegirPistaPrincipal([{ ...anfitrion, silenciada: true }], { emito: false }), null);
    assert.equal(elegirPistaPrincipal([{ ...propia, silenciada: true }], { emito: true }), null);
  });

  it('la sala falsa no inventa pistas ni sabe dibujarlas', () => {
    const sala = crearSalaFalsa();
    assert.deepEqual(sala.pistas(), { video: [], hayMediosAjenos: false });
    assert.equal(sala.VistaDePista, null);
  });
});
