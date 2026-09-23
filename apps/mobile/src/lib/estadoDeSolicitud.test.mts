/**
 * Los ocho estados del expediente traducidos a los tres pasos que se pintan.
 *
 * La prueba que de verdad importa es la última: `approved` NO es «reembolsado».
 * Confundirlos deja a alguien creyendo que ya perdió el curso y que el dinero
 * está en su cuenta, cuando no ha pasado ninguna de las dos cosas.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { en } from '../i18n/en.ts';
import { es } from '../i18n/es.ts';
import { pt } from '../i18n/pt.ts';
import {
  claveDelEstado,
  estaCerrada,
  estaReembolsada,
  pasoDe,
  pasosCumplidos,
  sePuedeCancelar,
  type EstadoDeSolicitud,
} from './estadoDeSolicitud.ts';

const TODOS: EstadoDeSolicitud[] = [
  'requested',
  'under_review',
  'approved',
  'refund_processing',
  'refunded',
  'rejected',
  'failed',
  'cancelled',
];

describe('en qué paso está una solicitud', () => {
  it('recién pedida, en el primero', () => {
    assert.equal(pasoDe('requested'), 'recibida');
    assert.equal(pasosCumplidos('requested'), 1);
  });

  it('en revisión, en el segundo', () => {
    assert.equal(pasoDe('under_review'), 'revision');
    assert.equal(pasosCumplidos('under_review'), 2);
  });

  it('rechazada TAMBIÉN llega al tercero', () => {
    // Una solicitud rechazada terminó. Dejarla en «en revisión» para siempre
    // sería mentir por omisión.
    assert.equal(pasoDe('rejected'), 'resolucion');
    assert.equal(pasosCumplidos('rejected'), 3);
  });

  it('los ocho estados caen en alguno de los tres pasos', () => {
    for (const estado of TODOS) {
      assert.ok(['recibida', 'revision', 'resolucion'].includes(pasoDe(estado)));
      assert.ok([1, 2, 3].includes(pasosCumplidos(estado)));
    }
  });
});

describe('cuándo ha terminado', () => {
  it('las cuatro finales están cerradas', () => {
    for (const estado of ['refunded', 'rejected', 'failed', 'cancelled'] as const) {
      assert.equal(estaCerrada(estado), true, estado);
    }
  });

  it('y las que siguen vivas, no', () => {
    for (const estado of [
      'requested',
      'under_review',
      'approved',
      'refund_processing',
    ] as const) {
      assert.equal(estaCerrada(estado), false, estado);
    }
  });
});

describe('cuándo se devolvió el dinero de verdad', () => {
  it('solo `refunded`', () => {
    assert.equal(estaReembolsada('refunded'), true);
  });

  it('aprobar NO es haber pagado', () => {
    // Es la diferencia entre «te lo vamos a devolver» y «está en tu cuenta».
    assert.equal(estaReembolsada('approved'), false);
    assert.equal(estaReembolsada('refund_processing'), false);
  });

  it('y ninguno de los demás lo es', () => {
    for (const estado of TODOS.filter((e) => e !== 'refunded')) {
      assert.equal(estaReembolsada(estado), false, estado);
    }
  });
});

describe('cuándo se puede cancelar', () => {
  it('mientras nadie la ha resuelto', () => {
    assert.equal(sePuedeCancelar('requested'), true);
    assert.equal(sePuedeCancelar('under_review'), true);
  });

  it('una vez aprobada o cerrada, ya no', () => {
    for (const estado of [
      'approved',
      'refund_processing',
      'refunded',
      'rejected',
      'cancelled',
    ] as const) {
      assert.equal(sePuedeCancelar(estado), false, estado);
    }
  });
});

describe('los ocho estados tienen texto en los tres idiomas', () => {
  it('ninguno se queda sin traducir', () => {
    for (const [nombre, diccionario] of [
      ['es', es],
      ['en', en],
      ['pt', pt],
    ] as Array<[string, Record<string, string>]>) {
      for (const estado of TODOS) {
        const clave = claveDelEstado(estado);
        assert.ok(
          (diccionario[clave] ?? '').trim() !== '',
          `falta ${clave} en ${nombre}`,
        );
      }
    }
  });
});

describe('lo que la pantalla del expediente sostiene', () => {
  const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const BLOQUE = new RegExp('/\\*[\\s\\S]*?\\*/', 'g');
  const LINEA = new RegExp('//[^\\n]*', 'g');
  const PANTALLA = readFileSync(join(SRC, 'screens/DetalleDeSolicitudScreen.tsx'), 'utf8')
    .replace(BLOQUE, ' ')
    .replace(LINEA, ' ');
  const AYUDA = readFileSync(join(SRC, 'screens/AyudaDelCursoScreen.tsx'), 'utf8')
    .replace(BLOQUE, ' ')
    .replace(LINEA, ' ');

  it('no enseña identificadores técnicos', () => {
    // La misma regla que ya fija `ComprasYDevolucionesScreen`.
    assert.ok(!PANTALLA.includes('{solicitud.id}'));
    assert.ok(!PANTALLA.includes('solicitud.orderId}<'));
  });

  it('el aviso de acceso retirado solo con el dinero devuelto', () => {
    assert.ok(PANTALLA.includes('estaReembolsada('));
    const aviso = PANTALLA.indexOf("t('solicitud.accesoTitulo')");
    const condicion = PANTALLA.indexOf('reembolsada ? (');
    assert.ok(condicion !== -1 && condicion < aviso);
  });

  it('cancelar pide confirmación y no se dispara dos veces', () => {
    const cuerpo = PANTALLA.slice(PANTALLA.indexOf('const cancelar ='));
    assert.ok(cuerpo.includes('destructive: true'));
    const cerrojo = cuerpo.indexOf('cancelandoRef.current = true');
    assert.ok(cerrojo !== -1 && cerrojo < cuerpo.indexOf('await'));
  });

  it('la ayuda no monta un sistema de soporte nuevo', () => {
    // Cada opción lleva a algo que YA existe.
    for (const destino of ["'/support'", "'/compras'", '/course/']) {
      assert.ok(AYUDA.includes(destino), `falta el destino ${destino}`);
    }
    assert.ok(!AYUDA.includes('crearTicket'));
    assert.ok(!AYUDA.includes('TicketRepository'));
  });

  it('y los cuatro destinos no son el mismo', () => {
    // Un menú donde todo acaba en el mismo formulario no es ayuda.
    const destinos = AYUDA.match(new RegExp("router.push\\('[^']+'", 'g')) ?? [];
    assert.ok(new Set(destinos).size >= 2, 'las opciones llevan al mismo sitio');
  });
});
