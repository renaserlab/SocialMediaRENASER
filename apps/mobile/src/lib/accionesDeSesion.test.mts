import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  accionPrincipal,
  accionesDeSesion,
  esperaMiRespuesta,
  seccionDeLaSesion,
  sigueViva,
  type AccionDeSesion,
  type EstadoDeLaSesion,
  type PapelEnLaSesion,
} from './accionesDeSesion.ts';

/*
  LO REPORTADO (04/10/2026). «Cuando se acepta, el botón de aceptar sigue
  estando ahí… Lo ideal es que una vez ponga aceptar ya no siga apareciendo ese
  botón, de hecho puede seguir apareciendo un botón de cancelar».
*/

const AQUI = dirname(fileURLToPath(import.meta.url));
const ESTADOS: EstadoDeLaSesion[] = [
  'pending',
  'accepted',
  'rejected',
  'cancelled',
  'reschedule_requested',
  'completed',
  'expired',
];
const PAPELES: PapelEnLaSesion[] = ['provider', 'requester'];

describe('una sesión aceptada deja de ofrecer «Aceptar»', () => {
  it('a quien se la pidieron, mientras espera, se le ofrece aceptar y rechazar', () => {
    assert.deepEqual(accionesDeSesion('pending', 'provider'), ['accepted', 'rejected']);
  });

  it('una vez aceptada no se puede volver a aceptar ni rechazar: es el fallo reportado', () => {
    for (const papel of PAPELES) {
      const acciones = accionesDeSesion('accepted', papel);
      assert.ok(!acciones.includes('accepted'), `${papel} vuelve a ver «Aceptar»`);
      assert.ok(!acciones.includes('rejected'), `${papel} vuelve a ver «Rechazar»`);
    }
  });

  it('y sí se puede cancelar o dar por hecha, las dos partes', () => {
    for (const papel of PAPELES) {
      assert.deepEqual(accionesDeSesion('accepted', papel), ['completed', 'cancelled']);
    }
  });

  it('quien la pidió no se la acepta a sí mismo: solo puede retirarla', () => {
    assert.deepEqual(accionesDeSesion('pending', 'requester'), ['cancelled']);
  });

  it('lo que ya terminó no ofrece nada', () => {
    for (const estado of ['rejected', 'cancelled', 'completed', 'expired'] as const) {
      for (const papel of PAPELES) {
        assert.deepEqual(accionesDeSesion(estado, papel), [], `${estado} / ${papel}`);
      }
      assert.equal(sigueViva(estado), false);
    }
  });

  it('un estado que esta versión no conoce no ofrece nada, y no revienta', () => {
    assert.deepEqual(accionesDeSesion('algo_nuevo' as EstadoDeLaSesion, 'provider'), []);
    assert.equal(sigueViva('algo_nuevo' as EstadoDeLaSesion), false);
    assert.equal(seccionDeLaSesion('algo_nuevo' as EstadoDeLaSesion, 'provider'), 'historial');
  });
});

describe('dónde va cada sesión en la agenda', () => {
  it('lo que me piden y no he respondido es una solicitud', () => {
    assert.equal(seccionDeLaSesion('pending', 'provider'), 'solicitudes');
    assert.equal(esperaMiRespuesta('pending', 'provider'), true);
  });

  it('lo que me pidieron y YA acepté sale de solicitudes y entra en mi calendario', () => {
    // Antes se quedaba en «Solicitudes» con los botones de responder, y no
    // llegaba nunca al calendario: no se podía cancelar ni dar por hecha.
    assert.equal(seccionDeLaSesion('accepted', 'provider'), 'proximas');
    assert.equal(esperaMiRespuesta('accepted', 'provider'), false);
  });

  it('lo que pedí yo no es una solicitud mía: está en mi calendario, esperando', () => {
    assert.equal(seccionDeLaSesion('pending', 'requester'), 'proximas');
    assert.equal(esperaMiRespuesta('pending', 'requester'), false);
    assert.equal(seccionDeLaSesion('accepted', 'requester'), 'proximas');
  });

  it('lo terminado va al historial, sea de quien sea', () => {
    for (const estado of ['rejected', 'cancelled', 'completed', 'expired'] as const) {
      for (const papel of PAPELES) assert.equal(seccionDeLaSesion(estado, papel), 'historial');
    }
  });

  it('toda sesión cae en una sección, y solo las solicitudes esperan mi respuesta', () => {
    for (const estado of ESTADOS) {
      for (const papel of PAPELES) {
        const seccion = seccionDeLaSesion(estado, papel);
        assert.equal(seccion === 'solicitudes', esperaMiRespuesta(estado, papel));
        // Lo que está en el historial no tiene botones; lo demás, alguno.
        const hayBotones = accionesDeSesion(estado, papel).length > 0;
        if (seccion === 'historial') assert.equal(hayBotones, false, `${estado} / ${papel}`);
        else assert.equal(hayBotones, true, `${estado} / ${papel} está viva y no ofrece nada`);
      }
    }
  });
});

describe('cuál es el botón relleno', () => {
  it('aceptar para quien responde; dar por hecha cuando ya está acordada', () => {
    assert.equal(accionPrincipal('pending', 'provider'), 'accepted');
    assert.equal(accionPrincipal('accepted', 'requester'), 'completed');
  });

  it('cancelar nunca es la acción principal', () => {
    assert.equal(accionPrincipal('pending', 'requester'), null);
    assert.equal(accionPrincipal('completed', 'provider'), null);
  });
});

describe('la tabla del teléfono no ofrece nada que el servidor vaya a rechazar', () => {
  /*
    La tabla de verdad es la del servidor (`TRANSICIONES`). Aquí se lee tal
    cual está escrita y se compara: si alguien cambia una de las dos y no la
    otra, esto falla antes de que un botón responda «ya no es posible».
  */
  function tablaDelServidor(): Record<string, Record<string, Set<string>>> {
    const fuente = readFileSync(
      resolve(AQUI, '../../../api/app/modules/bookings/schemas.py'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const inicio = fuente.indexOf('TRANSICIONES:');
    assert.ok(inicio >= 0, 'no se encuentra TRANSICIONES en el servidor');
    const cuerpo = fuente.slice(inicio, fuente.indexOf('\n}\n', inicio));

    const tabla: Record<string, Record<string, Set<string>>> = {};
    let estado: string | null = null;
    for (const linea of cuerpo.split('\n')) {
      const final = linea.match(/^ {4}"(\w+)": \{\},/);
      if (final) {
        tabla[final[1]] = { provider: new Set(), requester: new Set() };
        estado = null;
        continue;
      }
      const cabecera = linea.match(/^ {4}"(\w+)": \{$/);
      if (cabecera) {
        estado = cabecera[1];
        tabla[estado] = { provider: new Set(), requester: new Set() };
        continue;
      }
      const papel = linea.match(/^ {8}"(provider|requester)": \{([^}]*)\},/);
      if (papel && estado) {
        tabla[estado][papel[1]] = new Set(papel[2].match(/\w+/g) ?? []);
      }
    }
    return tabla;
  }

  it('la tabla del servidor se ha leído entera', () => {
    const servidor = tablaDelServidor();
    assert.deepEqual(Object.keys(servidor).sort(), [...ESTADOS].sort());
    // Dos comprobaciones de que se han leído los conjuntos y no cáscaras.
    assert.ok(servidor.pending.provider.has('accepted'));
    assert.ok(!servidor.pending.requester.has('accepted'));
  });

  it('cada botón que se pinta es una transición que el servidor admite', () => {
    const servidor = tablaDelServidor();
    for (const estado of ESTADOS) {
      for (const papel of PAPELES) {
        for (const accion of accionesDeSesion(estado, papel)) {
          assert.ok(
            servidor[estado][papel].has(accion),
            `se ofrece «${accion}» desde ${estado} a ${papel} y el servidor lo rechaza`,
          );
        }
      }
    }
  });

  it('y lo único que el servidor admite y no se ofrece es reprogramar', () => {
    const servidor = tablaDelServidor();
    for (const estado of ESTADOS) {
      for (const papel of PAPELES) {
        const ofrecidas = new Set<string>(accionesDeSesion(estado, papel) as AccionDeSesion[]);
        const sinOfrecer = [...servidor[estado][papel]].filter((a) => !ofrecidas.has(a));
        assert.deepEqual(
          sinOfrecer.filter((a) => a !== 'reschedule_requested'),
          [],
          `${estado} / ${papel}: el servidor admite algo que la aplicación no ofrece`,
        );
      }
    }
  });
});
