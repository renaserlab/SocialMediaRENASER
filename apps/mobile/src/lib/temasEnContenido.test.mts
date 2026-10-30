import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  FILTRO_DE_TEMA_TODOS,
  SIN_VISTAS,
  VISTA_TODO,
  categoriaDeVista,
  claveDeFiltroDeTema,
  cuentaDeCategoria,
  filtroDeTemaVigente,
  leerCuentasDeTemas,
  leerVistas,
  parametrosDeVista,
} from './vistasDeChat.ts';
import { vaSinMarco } from './mediosDeChat.ts';

/*
  La fila «Tema» de Contenido y la selección de varios (audios y temas,
  30/10/2026). El servidor filtra (`topic_id` o `sin_tema=true`) y cuenta
  (`GET /{id}/views/topics`); aquí se prueba que se le pregunte bien, que lo
  que conteste se lea sin fiarse y que un filtro que ya no existe no se quede
  puesto.
*/

const leer = (ruta: string) =>
  readFileSync(new URL(ruta, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('la consulta de una página con filtro de tema', () => {
  const AUDIOS = { tipo: 'categoria', clave: 'audio' } as const;

  it('«Todos» no manda nada: la consulta es la de siempre', () => {
    assert.equal(parametrosDeVista(VISTA_TODO), 'category=all&limit=30');
    assert.equal(
      parametrosDeVista(AUDIOS, { tema: FILTRO_DE_TEMA_TODOS }),
      'category=audio&limit=30',
    );
  });

  it('un tema manda `topic_id`, combinable con la categoría y la búsqueda', () => {
    assert.equal(
      parametrosDeVista(AUDIOS, { tema: { tipo: 'tema', id: 't 1' }, buscar: 'mañana' }),
      `category=audio&topic_id=t%201&q=${encodeURIComponent('mañana')}&limit=30`,
    );
  });

  it('«Sin tema» manda `sin_tema=true`, y nunca a la vez que un tema (422)', () => {
    const consulta = parametrosDeVista(AUDIOS, {
      tema: { tipo: 'sin' },
      cursor: { antes: '2026-10-30T09:00:00Z', antesId: 'm9' },
    });
    assert.match(consulta, /^category=audio&sin_tema=true&before=/);
    assert.doesNotMatch(consulta, /topic_id/);
  });
});

describe('las cuentas de la fila', () => {
  it('se leen sin fiarse: sin repetidos, sin filas a medias y sin negativos', () => {
    assert.deepEqual(
      leerCuentasDeTemas({
        sin_tema: 3,
        topics: [
          { id: 't1', name: 'Meditaciones', count: 3 },
          { id: 't1', name: 'Repetido', count: 9 },
          { id: 't2', name: ' Respiración ', count: 1.7 },
          { id: 't3', name: 'Rara', count: -2 },
          { id: '', name: 'Sin id', count: 1 },
          'basura',
        ],
      }),
      {
        sinTema: 3,
        temas: [
          { id: 't1', nombre: 'Meditaciones', cuantos: 3 },
          { id: 't2', nombre: 'Respiración', cuantos: 1 },
          { id: 't3', nombre: 'Rara', cuantos: 0 },
        ],
      },
    );
  });

  it('una respuesta que no se entiende es «sin fila», como una API anterior', () => {
    assert.equal(leerCuentasDeTemas(null), null);
    assert.equal(leerCuentasDeTemas({ sin_tema: 2 }), null);
    assert.equal(leerCuentasDeTemas([]), null);
    assert.deepEqual(leerCuentasDeTemas({ topics: [] }), { sinTema: 0, temas: [] });
  });

  it('«Todos · N» cuenta lo de la sección; «Media» suma fotos y videos si hace falta', () => {
    const vistas = leerVistas({
      kind: 'group',
      categories: [
        { key: 'audio', count: 6 },
        { key: 'image', count: 4 },
        { key: 'video', count: 2 },
      ],
    });
    assert.equal(cuentaDeCategoria(vistas, 'audio'), 6);
    assert.equal(cuentaDeCategoria(vistas, 'media'), 6);
    assert.equal(cuentaDeCategoria(SIN_VISTAS, 'document'), 0);
  });

  it('solo hay fila en una sección que es categoría: los filtros del grupo no se cuentan por tema', () => {
    assert.equal(categoriaDeVista({ tipo: 'categoria', clave: 'audio' }), 'audio');
    assert.equal(categoriaDeVista({ tipo: 'filtro', id: 'f1' }), null);
    assert.equal(categoriaDeVista(null), null);
  });
});

describe('el filtro que vale', () => {
  const CUENTAS = { sinTema: 3, temas: [{ id: 't1', nombre: 'Meditaciones', cuantos: 3 }] };

  it('el elegido, mientras su tema siga en la fila', () => {
    assert.deepEqual(filtroDeTemaVigente({ tipo: 'tema', id: 't1' }, CUENTAS), {
      tipo: 'tema',
      id: 't1',
    });
    assert.deepEqual(filtroDeTemaVigente({ tipo: 'sin' }, CUENTAS), { tipo: 'sin' });
  });

  it('si el tema desaparece, o no hay fila, vuelve a «Todos»', () => {
    assert.deepEqual(filtroDeTemaVigente({ tipo: 'tema', id: 'borrado' }, CUENTAS), FILTRO_DE_TEMA_TODOS);
    assert.deepEqual(filtroDeTemaVigente({ tipo: 'sin' }, null), FILTRO_DE_TEMA_TODOS);
  });

  it('cada filtro tiene su clave, y «Todos» la de siempre', () => {
    assert.equal(claveDeFiltroDeTema(FILTRO_DE_TEMA_TODOS), 'todos');
    assert.equal(claveDeFiltroDeTema({ tipo: 'sin' }), 'sin');
    assert.equal(claveDeFiltroDeTema({ tipo: 'tema', id: 't1' }), 't:t1');
  });
});

describe('un video con nombre lleva burbuja', () => {
  it('sin nombre va sin marco, como siempre; con nombre, no', () => {
    assert.ok(vaSinMarco({ adjuntos: [{ kind: 'video' }] }));
    assert.ok(vaSinMarco({ adjuntos: [{ kind: 'video', title: '   ' }] }));
    assert.ok(!vaSinMarco({ adjuntos: [{ kind: 'video', title: 'Clase 3 · Postura' }] }));
    // Una foto no lleva nombre: aunque llegara uno, sigue sin marco.
    assert.ok(vaSinMarco({ adjuntos: [{ kind: 'image', title: 'x' }] }));
  });
});

describe('la pantalla usa lo de aquí', () => {
  const pestanas = leer('../components/chat/PestanasDeContenido.tsx');
  const hook = leer('../hooks/useMensajesDeVista.ts');
  const repositorio = leer('../repositories/MessageRepository.ts');
  const ficha = leer('../screens/GrupoScreen.tsx');

  it('las cuentas se piden por categoría, y la página lleva el filtro', () => {
    assert.match(
      repositorio,
      /\/views\/topics\?category=\$\{encodeURIComponent\(categoria\)\}/,
    );
    assert.match(repositorio, /parametrosDeVista\(vista, \{\s*buscar,\s*cursor,\s*tema,\s*\}\)/);
    assert.match(pestanas, /tema: hayFilaDeTemas \? filtroVigente : FILTRO_DE_TEMA_TODOS/);
  });

  it('otro filtro de tema es otra lista: entra en la clave de la carga', () => {
    assert.match(hook, /`\$\{claveDeVista\(vista\)\}\|\$\{claveDeTema\}`/);
  });

  it('elegir varios es solo de quien administra, y va por el PUT por lotes con aviso', () => {
    assert.match(pestanas, /const puedeElegir = !!temasDelGrupo\?\.puedoAdministrar;/);
    assert.match(pestanas, /puedeElegir && !seleccionando \? \(\) => alternar\(mensaje\.id\) : undefined/);
    assert.match(pestanas, /await TemasRepository\.agregarVarios\(grupoId, tema\.id, mensajeIds\)/);
    assert.match(pestanas, /canal\.current\?\.avisar\(\);\s*alAgregar\(tema, agregados\);/);
    // Lo que se dice al terminar va DESPUÉS de cerrar la hoja (iOS).
    const alAgregar = pestanas.slice(pestanas.indexOf('const alAgregarVarios'));
    assert.ok(alAgregar.indexOf('await afterSheetClose();') < alAgregar.indexOf('toast('));
  });

  it('la fila y la selección solo existen en General de una comunidad con temas', () => {
    assert.match(
      ficha,
      /disponibilidadDeTemas\.temas && !info\.padre && !info\.tema\s*\?\s*\{ grupoId: conversationId, puedoAdministrar: info\.puedoAdministrar \}\s*:\s*null/,
    );
  });
});
