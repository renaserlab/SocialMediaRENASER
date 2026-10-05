import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { accionesDeSesion } from './accionesDeSesion.ts';
import {
  estadosVigentes,
  fraseDelHecho,
  iconoDelHecho,
  loQueSigueHaciendoFalta,
} from './sesionesDelChat.ts';
import { es } from '../i18n/es.ts';
import { en } from '../i18n/en.ts';
import { pt } from '../i18n/pt.ts';

/*
  LO REPORTADO (04/10/2026). «Debería aparecer como una opción de botón en
  mensajes y que aparezca también si acepté o no. Eso también debe quedar
  registrado ahí».
*/

type Hecho = 'requested' | 'accepted' | 'rejected' | 'cancelled' | 'reschedule_requested' | 'completed';
type Estado = 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'reschedule_requested' | 'completed' | 'expired';

function mensaje(hecho: Hecho, estado: Estado, actualizadaIso: string | null, sesionId = 's1') {
  return {
    sesion: {
      sesionId,
      hecho,
      estado,
      tema: 'Mi portafolio',
      nota: '',
      cuandoIso: null,
      miPapel: 'provider' as const,
      actualizadaIso,
    },
  };
}

const T0 = '2026-10-04T21:41:00.000000+00:00';
const T1 = '2026-10-04T21:43:10.123456+00:00';
const T2 = '2026-10-04T21:50:00.000000+00:00';

describe('la tarjeta de la solicitud dice cómo está la sesión HOY', () => {
  it('con solo la solicitud, está pendiente y ofrece aceptar', () => {
    const vigente = estadosVigentes([mensaje('requested', 'pending', T0)]);
    assert.equal(vigente.get('s1'), 'pending');
    assert.deepEqual(accionesDeSesion(vigente.get('s1')!, 'provider'), ['accepted', 'rejected']);
  });

  it('cuando llega la respuesta, la solicitud VIEJA deja de ofrecer «Aceptar»', () => {
    // La solicitud se cargó antes y todavía dice «pendiente». La respuesta,
    // que acaba de llegar, dice «aceptada». Manda la más reciente.
    const vigente = estadosVigentes([
      mensaje('requested', 'pending', T0),
      mensaje('accepted', 'accepted', T1),
    ]);
    assert.equal(vigente.get('s1'), 'accepted');
    const acciones = accionesDeSesion(vigente.get('s1')!, 'provider');
    assert.ok(!acciones.includes('accepted'), 'la tarjeta sigue ofreciendo «Aceptar»');
    assert.ok(acciones.includes('cancelled'), 'ya aceptada, se tiene que poder cancelar');
  });

  it('manda la fecha del servidor, no el orden en que llegan', () => {
    // Una página vieja del historial llega DESPUÉS que la respuesta.
    const vigente = estadosVigentes([
      mensaje('accepted', 'accepted', T1),
      mensaje('requested', 'pending', T0),
    ]);
    assert.equal(vigente.get('s1'), 'accepted');
  });

  it('se leen los microsegundos de PostgreSQL: dos cambios en el mismo segundo no empatan', () => {
    const vigente = estadosVigentes([
      mensaje('cancelled', 'cancelled', '2026-10-04T21:43:10.900000+00:00'),
      mensaje('accepted', 'accepted', '2026-10-04T21:43:10.100000+00:00'),
    ]);
    assert.equal(vigente.get('s1'), 'cancelled');
  });

  it('una fecha que no se entiende pierde contra cualquiera que sí', () => {
    const vigente = estadosVigentes([
      mensaje('accepted', 'accepted', T1),
      mensaje('requested', 'pending', null),
      mensaje('requested', 'pending', 'no es una fecha'),
    ]);
    assert.equal(vigente.get('s1'), 'accepted');
  });

  it('cada sesión de la conversación lleva su propio estado', () => {
    const vigente = estadosVigentes([
      mensaje('requested', 'pending', T0, 's1'),
      mensaje('cancelled', 'cancelled', T1, 's1'),
      mensaje('requested', 'pending', T2, 's2'),
    ]);
    assert.equal(vigente.get('s1'), 'cancelled');
    assert.equal(vigente.get('s2'), 'pending');
  });

  it('los mensajes normales no cuentan', () => {
    assert.equal(estadosVigentes([{}, { sesion: undefined }]).size, 0);
  });
});

describe('lo que responde el servidor al pulsar un botón se sabe antes que su mensaje', () => {
  it('el botón deja de ofrecerse sin esperar a que llegue el registro', () => {
    const vigente = estadosVigentes(
      [mensaje('requested', 'pending', T0)],
      [{ sesionId: 's1', estado: 'accepted', actualizadaIso: T1 }],
    );
    assert.equal(vigente.get('s1'), 'accepted');
  });

  it('pero no pisa algo más nuevo que ya haya llegado', () => {
    // Acepté; la otra persona canceló después y su mensaje ya está aquí.
    const vigente = estadosVigentes(
      [mensaje('requested', 'pending', T0), mensaje('cancelled', 'cancelled', T2)],
      [{ sesionId: 's1', estado: 'accepted', actualizadaIso: T1 }],
    );
    assert.equal(vigente.get('s1'), 'cancelled');
  });

  it('a igual versión, lo sabido por el botón no pierde el empate', () => {
    const vigente = estadosVigentes(
      [mensaje('requested', 'pending', T1)],
      [{ sesionId: 's1', estado: 'accepted', actualizadaIso: T1 }],
    );
    assert.equal(vigente.get('s1'), 'accepted');
  });

  it('en cuanto un mensaje trae esa versión, deja de recordarse', () => {
    const sabidas = [{ sesionId: 's1', estado: 'accepted' as const, actualizadaIso: T1 }];
    assert.deepEqual(loQueSigueHaciendoFalta([mensaje('requested', 'pending', T0)], sabidas), sabidas);
    assert.deepEqual(
      loQueSigueHaciendoFalta(
        [mensaje('requested', 'pending', T0), mensaje('accepted', 'accepted', T1)],
        sabidas,
      ),
      [],
    );
  });
});

describe('cada hecho se cuenta con su frase, distinta si lo hice yo', () => {
  const HECHOS: Hecho[] = ['requested', 'accepted', 'rejected', 'cancelled', 'completed', 'reschedule_requested'];

  it('doce frases distintas, y todas existen en los tres idiomas', () => {
    const claves = new Set<string>();
    for (const hecho of HECHOS) {
      for (const mio of [true, false]) claves.add(fraseDelHecho(hecho, mio));
    }
    assert.equal(claves.size, 12);
    for (const clave of claves) {
      for (const [idioma, diccionario] of [['es', es], ['en', en], ['pt', pt]] as const) {
        const texto = (diccionario as Record<string, string>)[clave];
        assert.ok(texto, `falta ${clave} en ${idioma}`);
      }
    }
  });

  it('la que habla de la otra persona lleva su nombre; la mía, no', () => {
    for (const hecho of HECHOS) {
      for (const diccionario of [es, en, pt]) {
        const mia = (diccionario as Record<string, string>)[fraseDelHecho(hecho, true)];
        const suya = (diccionario as Record<string, string>)[fraseDelHecho(hecho, false)];
        assert.ok(!mia.includes('{nombre}'), `${hecho}: la frase propia pide un nombre`);
        assert.ok(suya.includes('{nombre}'), `${hecho}: la frase ajena no dice quién`);
      }
    }
  });

  it('un hecho que esta versión no conoce no revienta la burbuja', () => {
    assert.equal(fraseDelHecho('algo_nuevo' as Hecho, true), 'chat.sessionYouRequested');
    assert.equal(iconoDelHecho('algo_nuevo' as Hecho), 'calendar');
  });

  it('aceptar y rechazar no comparten icono', () => {
    assert.notEqual(iconoDelHecho('accepted'), iconoDelHecho('rejected'));
    assert.notEqual(iconoDelHecho('accepted'), iconoDelHecho('cancelled'));
  });
});
