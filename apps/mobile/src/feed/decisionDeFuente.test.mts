/**
 * El "Para ti" recomendado nunca puede dejar el Inicio en negro.
 *
 * Es una condicion de aceptacion del producto: si el recomendador falla, esta
 * apagado o no tiene todavia con que personalizar, la persona sigue viendo
 * videos. Lo unico que cambia es el orden.
 *
 * Se ejecutan con `npm run test` (el runner de Node, sin dependencias).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decidirLote } from './decisionDeFuente.ts';

describe('la primera pagina', () => {
  it('usa lo recomendado cuando lo hay', () => {
    assert.equal(
      decidirLote({ recibidas: 6, reproducibles: 6, desplazamiento: 0 }),
      'usar',
    );
  });

  it('cae al orden cronologico si no llega nada', () => {
    // La personalizacion apagada en el servidor responde exactamente asi.
    assert.equal(
      decidirLote({ recibidas: 0, reproducibles: 0, desplazamiento: 0 }),
      'respaldo',
    );
  });

  it('cae tambien si llegan publicaciones pero ninguna se puede reproducir', () => {
    // Para quien mira es lo mismo que no tener nada: la pantalla estaria vacia.
    assert.equal(
      decidirLote({ recibidas: 6, reproducibles: 0, desplazamiento: 0 }),
      'respaldo',
    );
  });

  it('con una sola reproducible, se usa: no se rellena con nada', () => {
    assert.equal(
      decidirLote({ recibidas: 6, reproducibles: 1, desplazamiento: 0 }),
      'usar',
    );
  });
});

describe('las siguientes paginas', () => {
  it('una pagina vacia es el final, no un fallo', () => {
    // Reiniciar aqui con la fuente cronologica volveria a ensenar desde arriba
    // los mismos videos que la persona acaba de ver.
    assert.equal(
      decidirLote({ recibidas: 0, reproducibles: 0, desplazamiento: 12 }),
      'fin',
    );
  });

  it('una pagina entera de descartes no rompe la paginacion', () => {
    // Se usa igualmente (sin elementos) para que el cursor avance: si se
    // cortara aqui, el contenido de mas abajo no se alcanzaria nunca.
    assert.equal(
      decidirLote({ recibidas: 6, reproducibles: 0, desplazamiento: 6 }),
      'usar',
    );
  });

  it('nunca cambia de fuente a mitad de la lista', () => {
    // Mezclar dos ordenaciones distintas repetiria y saltaria videos.
    for (const reproducibles of [0, 1, 6]) {
      assert.notEqual(
        decidirLote({ recibidas: 6, reproducibles, desplazamiento: 6 }),
        'respaldo',
      );
    }
  });
});
