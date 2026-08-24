/**
 * A donde va la aplicacion al abrirse, y en que ORDEN se decide.
 *
 * La prueba que mas importa de este fichero es la de la recuperacion de
 * contrasena. Al pulsar el enlace del correo, Supabase abre sesion; si
 * cualquier comprobacion que mire «¿hay sesion?» se cuela por delante, el
 * usuario aterriza en el feed con la contrasena vieja intacta y sin llegar a
 * cambiarla. Ya paso una vez, y anadir el cuestionario delante habria sido la
 * forma mas facil de repetirlo.
 *
 * Se ejecutan con `npm run test` (el runner de Node, sin dependencias).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rutaDeArranque, type EstadoDeArranque } from './rutaDeArranque.ts';

const BASE: EstadoDeArranque = {
  hidratado: true,
  conBackend: true,
  sesion: 'sinCuenta',
  recuperandoContrasena: false,
  cuestionario: 'desconocido',
  idiomaElegido: true,
};

const estado = (parcial: Partial<EstadoDeArranque>): EstadoDeArranque => ({
  ...BASE,
  ...parcial,
});

describe('recuperar la contrasena manda sobre todo lo demas', () => {
  it('lleva a fijar la contrasena aunque haya sesion abierta', () => {
    assert.equal(
      rutaDeArranque(estado({ sesion: 'conCuenta', recuperandoContrasena: true })),
      '/reset-password',
    );
  });

  it('el cuestionario NO intercepta una sesion de recuperacion', () => {
    // El caso que romperia el acceso de alguien que perdio su contrasena.
    assert.equal(
      rutaDeArranque(
        estado({
          sesion: 'conCuenta',
          recuperandoContrasena: true,
          cuestionario: 'pendiente',
        }),
      ),
      '/reset-password',
    );
  });

  it('tampoco lo intercepta el selector de idioma', () => {
    assert.equal(
      rutaDeArranque(
        estado({ recuperandoContrasena: true, idiomaElegido: false, sesion: 'conCuenta' }),
      ),
      '/reset-password',
    );
  });
});

describe('primer acceso de alguien con cuenta', () => {
  it('ensena el cuestionario cuando esta pendiente', () => {
    assert.equal(
      rutaDeArranque(estado({ sesion: 'conCuenta', cuestionario: 'pendiente' })),
      '/onboarding',
    );
  });

  it('no lo vuelve a ensenar a quien ya paso por el', () => {
    assert.equal(
      rutaDeArranque(estado({ sesion: 'conCuenta', cuestionario: 'visto' })),
      '/(tabs)/home',
    );
  });

  it('no interrumpe a nadie cuando no se pudo preguntar', () => {
    // Servidor caido, o personalizacion apagada. Ante la duda, no se molesta.
    assert.equal(
      rutaDeArranque(estado({ sesion: 'conCuenta', cuestionario: 'noDisponible' })),
      '/(tabs)/home',
    );
  });

  it('espera —poco— mientras no se sabe', () => {
    assert.equal(
      rutaDeArranque(estado({ sesion: 'conCuenta', cuestionario: 'desconocido' })),
      null,
    );
  });

  it('en modo demo no espera a un cuestionario que no existe', () => {
    assert.equal(
      rutaDeArranque(
        estado({ conBackend: false, sesion: 'conCuenta', cuestionario: 'desconocido' }),
      ),
      '/(tabs)/home',
    );
  });
});

describe('sin cuenta se puede mirar', () => {
  it('entra al muro sin pedir nada', () => {
    assert.equal(rutaDeArranque(estado({ sesion: 'sinCuenta' })), '/(tabs)/home');
  });

  it('pero pregunta el idioma la primera vez', () => {
    assert.equal(
      rutaDeArranque(estado({ sesion: 'sinCuenta', idiomaElegido: false })),
      '/language',
    );
  });

  it('a quien no tiene cuenta no se le ensena el cuestionario', () => {
    // No hay donde guardar lo que responda, y ademas seria pedirle datos antes
    // de que entienda para que sirve la aplicacion.
    assert.equal(
      rutaDeArranque(estado({ sesion: 'sinCuenta', cuestionario: 'pendiente' })),
      '/(tabs)/home',
    );
  });
});

describe('mientras no se sabe, no se decide', () => {
  it('espera a que el store local se lea del disco', () => {
    assert.equal(rutaDeArranque(estado({ hidratado: false })), null);
  });

  it('espera a resolver la sesion', () => {
    assert.equal(rutaDeArranque(estado({ sesion: 'resolviendo' })), null);
  });

  it('en modo demo no espera a ninguna sesion', () => {
    assert.equal(
      rutaDeArranque(estado({ conBackend: false, sesion: 'resolviendo' })),
      '/(tabs)/home',
    );
  });
});
