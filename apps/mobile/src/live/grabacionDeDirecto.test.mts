import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { duracionLegible, leerGrabacion, tamanoLegible } from './grabacion.ts';

/*
  La grabación de un directo (prototipo, 09/10/2026). Lo esencial: no se ofrece
  una descarga que no existe, no se abre un enlace que no sea `https`, y solo la
  ve quien emitió.
*/

const leer = (ruta: string) =>
  readFileSync(new URL(ruta, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const ENLACE = 'https://grabaciones.example/directo.mp4?firma=abc';

test('un servidor sin la función, o cualquier otra cosa, no enseña nada', () => {
  for (const bruto of [null, undefined, 'x', [], {}, { available: false }, { available: 'true' }]) {
    assert.equal(leerGrabacion(bruto).estado, 'sin_funcion', JSON.stringify(bruto));
  }
});

test('con la función pero sin grabación, está pendiente y sin enlace', () => {
  assert.deepEqual(leerGrabacion({ available: true, ready: false, url: null }), {
    estado: 'pendiente',
    url: null,
    duracionS: null,
    tamanoBytes: null,
  });
});

test('la grabación lista trae su enlace, su duración y su tamaño', () => {
  assert.deepEqual(
    leerGrabacion({
      available: true,
      ready: true,
      url: ENLACE,
      duration_seconds: 754,
      size_bytes: 13933649,
    }),
    { estado: 'lista', url: ENLACE, duracionS: 754, tamanoBytes: 13933649 },
  );
});

test('un enlace que no es https no se ofrece, diga lo que diga el servidor', () => {
  for (const url of ['http://x.example/v.mp4', 'javascript:alert(1)', 'file:///x', '', null, 7]) {
    const leida = leerGrabacion({ available: true, ready: true, url });
    assert.equal(leida.estado, 'pendiente', String(url));
    assert.equal(leida.url, null);
  }
});

test('una duración o un tamaño que no son números no se pintan', () => {
  const leida = leerGrabacion({
    available: true,
    ready: true,
    url: ENLACE,
    duration_seconds: 'mucho',
    size_bytes: -4,
  });
  assert.deepEqual([leida.duracionS, leida.tamanoBytes], [null, null]);
});

test('la duración y el tamaño se dicen en corto', () => {
  assert.equal(duracionLegible(754), '13 min');
  assert.equal(duracionLegible(20), '1 min');
  assert.equal(duracionLegible(3600), '1 h');
  assert.equal(duracionLegible(3900), '1 h 5 min');
  assert.equal(duracionLegible(null), null);
  assert.equal(duracionLegible(0), null);

  assert.equal(tamanoLegible(13933649), '13 MB');
  assert.equal(tamanoLegible(100), '1 MB');
  assert.equal(tamanoLegible(1.2 * 1024 * 1024 * 1024), '1,2 GB');
  assert.equal(tamanoLegible(null), null);
});

test('pedir la grabación nunca falla hacia la pantalla', () => {
  const repositorio = leer('../repositories/LiveRepository.ts');
  const funcion = repositorio.slice(repositorio.indexOf('async grabacion('));
  assert.match(funcion.slice(0, 500), /\/recording`/);
  assert.match(funcion.slice(0, 500), /catch \{\s*return leerGrabacion\(null\);\s*\}/);
});

test('solo la ve quien emitió, y solo con la emisión terminada', () => {
  const pantalla = leer('../screens/LiveScreen.tsx');
  assert.match(
    pantalla,
    /\{terminada && puedeGestionar \? \(\s*<DescargaDeGrabacion emisionId=\{emision\.id\} alFallar=\{setAviso\} \/>\s*\) : null\}/,
  );
});

test('sin la función no se pinta nada, y lo pendiente no promete una descarga', () => {
  const componente = leer('../components/live/DescargaDeGrabacion.tsx');
  assert.match(componente, /if \(!grabacion \|\| grabacion\.estado === 'sin_funcion'\) return null;/);
  // El botón de descargar solo existe en el estado «lista».
  const pendiente = componente.slice(
    componente.indexOf("grabacion.estado === 'pendiente'"),
    componente.indexOf('const detalle'),
  );
  assert.doesNotMatch(pendiente, /recordingDownload|openURL/);
});

test('la aplicación lee lo mismo que manda el servidor', () => {
  const esquemas = leer('../../../api/app/modules/live/schemas.py');
  const clase = esquemas.slice(esquemas.indexOf('class LiveRecordingRead'));
  const cuerpo = clase.slice(0, clase.indexOf('\nclass ', 10));
  for (const campo of ['available', 'ready', 'url', 'duration_seconds', 'size_bytes']) {
    assert.match(cuerpo, new RegExp(`^    ${campo}: `, 'm'), campo);
  }
});
