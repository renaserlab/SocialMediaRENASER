import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { accionesDeSesion } from './accionesDeSesion.ts';
import {
  comoSolicitud,
  estadosVigentes,
  fraseDelHecho,
  iconoDelHecho,
  loQueSigueHaciendoFalta,
  sesionesSinTarjeta,
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

describe('una sesión cuya tarjeta no está en pantalla se puede responder igual', () => {
  /*
    La tarjeta es el mensaje de la solicitud, y puede no estar: más arriba en
    el historial, de antes de este cambio, o texto normal mientras el servidor
    no guarde de qué sesión habla cada mensaje. Entonces se pinta una al final.
  */
  const sesion = (id: string, estado: Estado, creadaIso = T0) => ({
    id,
    tema: 'Mi portafolio',
    nota: '',
    estado,
    cuandoIso: null,
    creadaIso,
    actualizadaIso: creadaIso,
    miRol: 'provider' as const,
  });
  const vigentes = (...pares: [string, Estado][]) => new Map<string, Estado>(pares);

  it('sin tarjeta entre los mensajes, la sesión pendiente sale al final', () => {
    const texto = [{}, {}]; // la solicitud llegó como texto normal
    const salida = sesionesSinTarjeta([sesion('s1', 'pending')], texto, vigentes());
    assert.deepEqual(salida.map((s) => s.id), ['s1']);
  });

  it('con su tarjeta en pantalla NO se repite', () => {
    const salida = sesionesSinTarjeta(
      [sesion('s1', 'pending')],
      [mensaje('requested', 'pending', T0, 's1')],
      vigentes(),
    );
    assert.deepEqual(salida, []);
  });

  it('una línea de registro no es la tarjeta: si solo está el «aceptó», falta la tarjeta', () => {
    // Una sesión de antes: se aceptó y eso sí quedó escrito, pero nunca tuvo
    // tarjeta. Sigue viva (se puede cancelar o dar por hecha) y sin botones.
    const salida = sesionesSinTarjeta(
      [sesion('s1', 'accepted')],
      [mensaje('accepted', 'accepted', T1, 's1')],
      vigentes(['s1', 'accepted']),
    );
    assert.deepEqual(salida.map((s) => s.id), ['s1']);
  });

  it('lo que ya terminó no sale: no hay nada que responder', () => {
    for (const estado of ['rejected', 'cancelled', 'completed', 'expired'] as const) {
      assert.deepEqual(sesionesSinTarjeta([sesion('s1', estado)], [], vigentes()), [], estado);
    }
  });

  it('manda el estado de hoy: la lista dice pendiente y un mensaje más nuevo, cancelada', () => {
    const salida = sesionesSinTarjeta([sesion('s1', 'pending')], [], vigentes(['s1', 'cancelled']));
    assert.deepEqual(salida, []);
  });

  it('varias, en el orden en que se pidieron', () => {
    const salida = sesionesSinTarjeta(
      [sesion('nueva', 'pending', T2), sesion('vieja', 'accepted', T0)],
      [],
      vigentes(),
    );
    assert.deepEqual(salida.map((s) => s.id), ['vieja', 'nueva']);
  });

  it('la tarjeta del final ofrece los mismos botones que la de un mensaje', () => {
    const solicitud = comoSolicitud(sesion('s1', 'pending'));
    assert.equal(solicitud.hecho, 'requested');
    assert.equal(solicitud.sesionId, 's1');
    assert.deepEqual(accionesDeSesion(solicitud.estado, solicitud.miPapel), ['accepted', 'rejected']);
  });
});

describe('lo que encontró la revisión independiente, enchufado', () => {
  const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
  const CHAT = fuente('screens/ChatScreen.tsx');
  const HOJA = fuente('components/BookSessionSheet.tsx');
  const REPOSITORIO = fuente('repositories/BookingRepository.ts');
  const RESPONDER = fuente('hooks/useResponderSesion.ts');

  it('al volver al chat las sesiones se releen: aceptar en la agenda no deja «Aceptar» aquí', () => {
    assert.match(
      CHAT,
      /useFocusEffect\(\s*useCallback\(\(\) => \{[^}]*if \(enfocadaAntes\.current\) leerSesiones\(\);/,
    );
  });

  it('las tarjetas del final son elementos de la lista, no un pie que queda bajo el borde', () => {
    assert.match(CHAT, /data=\{elementos\}/);
    assert.ok(!/ListFooterComponent/.test(CHAT), 'vuelve a haber un pie');
    assert.match(CHAT, /id: `sesion:\$\{sesion\.id\}`/);
    assert.match(CHAT, /sesion: comoSolicitud\(sesion\)/);
  });

  it('las sesiones del chat se piden por su ruta propia, sin filtrar aquí', () => {
    // Un filtro que una API anterior ignorase traería a este chat las
    // sesiones que la persona tiene con otros.
    assert.match(REPOSITORIO, /\/bookings\/conversation\/\$\{encodeURIComponent\(conversacionId\)\}/);
    assert.ok(!/conversation_id=\$\{/.test(REPOSITORIO));
  });

  it('pedir una sesión: un toque es una petición, y la solicitud la escribe el servidor', () => {
    // El cerrojo se toma ANTES de la primera espera.
    const pedir = HOJA.slice(HOJA.indexOf('const handleBook'));
    const cerrojo = pedir.indexOf('ocupado.current = true;');
    const espera = pedir.indexOf('await requireAuth(');
    assert.ok(cerrojo !== -1 && espera !== -1 && cerrojo < espera, 'el cerrojo llega tarde');
    assert.match(pedir, /finally \{\s*ocupado\.current = false;/);
    assert.match(REPOSITORIO, /announce_in_chat: true,/);
    // Y el texto de antes solo se manda si el servidor no dejó la solicitud.
    assert.match(HOJA, /if \(!sesion\.conversacionId\) \{/);
  });

  it('cancelar: un segundo toque no encola otro «¿seguro?»', () => {
    assert.match(RESPONDER, /if \(cerrojo\.current \|\| preguntando\.current\) return;/);
    assert.match(RESPONDER, /finally \{\s*preguntando\.current = false;/);
  });
});
