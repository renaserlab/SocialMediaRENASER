import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { alSoltarElDisparadorDeVideo, MANTENER_MS } from './disparadorDeVideo.ts';

/*
  Lo que se vio: en Crear › Reel, un toque en el disparador hacia una FOTO, y
  el paso siguiente intentaba reproducirla como video. El modo pedia «solo
  video», pero la peticion se quedaba en el carrete: la camara no la recibia.

  Dos mitades. La regla del disparador, ejecutada. Y la custodia de que la
  peticion llega de verdad hasta la camara, que es justo lo que faltaba.
*/

const leer = (ruta: string) =>
  readFileSync(new URL(ruta, import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    // Sin comentarios: un comentario que nombre una prop no es pasarla.
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

test('un toque empieza a grabar y NO termina al levantar el dedo', () => {
  assert.equal(
    alSoltarElDisparadorDeVideo({ grabando: true, yaGrababa: false, duroMs: 90 }),
    'seguir',
  );
});

test('el segundo toque termina, dure lo que dure', () => {
  for (const duroMs of [40, MANTENER_MS, 2_000]) {
    assert.equal(
      alSoltarElDisparadorDeVideo({ grabando: true, yaGrababa: true, duroMs }),
      'parar',
    );
  }
});

test('mantener graba mientras se mantiene: al soltar, termina', () => {
  assert.equal(
    alSoltarElDisparadorDeVideo({ grabando: true, yaGrababa: false, duroMs: MANTENER_MS }),
    'parar',
  );
  assert.equal(
    alSoltarElDisparadorDeVideo({ grabando: true, yaGrababa: false, duroMs: 45_000 }),
    'parar',
  );
});

test('justo por debajo del umbral sigue siendo un toque', () => {
  assert.equal(
    alSoltarElDisparadorDeVideo({ grabando: true, yaGrababa: false, duroMs: MANTENER_MS - 1 }),
    'seguir',
  );
});

test('soltar antes de que la grabacion empiece no la cancela', () => {
  // El caso del dialogo del microfono: el sistema se lleva el gesto y «suelta»
  // por nosotros, mucho despues. Si eso cancelara, el primer toque de la
  // primera vez no haria nada.
  for (const duroMs of [10, 5_000]) {
    assert.equal(
      alSoltarElDisparadorDeVideo({ grabando: false, yaGrababa: false, duroMs }),
      'seguir',
    );
  }
});

/* ------------------------------------------------------------ custodia --- */

test('Reel pide solo video y la peticion llega hasta la camara', () => {
  const reel = leer('../components/crear/ModoReel.tsx');
  assert.match(reel, /<PasoDeCaptura\s+soloVideo\b/);

  const paso = leer('../components/crear/PasoDeCaptura.tsx');
  const camara = paso.slice(paso.indexOf('<StoryCaptureScreen'));
  assert.match(camara.slice(0, camara.indexOf('/>')), /soloVideo=\{soloVideo\}/);
});

test('la camara que solo graba no puede hacer una foto', () => {
  const camara = leer('../screens/StoryCaptureScreen.tsx');

  // Arranca ya en modo video: no hay cambio de modo que esperar al tocar.
  assert.match(camara, /useState<CameraMode>\(soloVideo \? 'video' : 'picture'\)/);

  // En los dos gestos, la rama de solo video sale ANTES de llegar a la foto.
  const alApoyar = camara.slice(camara.indexOf('const onPressIn'), camara.indexOf('const onPressOut'));
  assert.match(alApoyar, /if \(soloVideo\) \{[\s\S]*?return;\s*\}/);

  const alSoltar = camara.slice(camara.indexOf('const onPressOut'), camara.indexOf('const acciones'));
  const rama = alSoltar.slice(alSoltar.indexOf('if (soloVideo)'), alSoltar.indexOf('takePhoto'));
  assert.match(rama, /alSoltarElDisparadorDeVideo/);
  assert.match(rama, /return;\s*\}/);
  assert.ok(alSoltar.indexOf('if (soloVideo)') < alSoltar.indexOf('takePhoto'));
});

test('la camara de historias sigue como estaba: toque foto, mantener video', () => {
  const camara = leer('../screens/StoryCaptureScreen.tsx');
  const alSoltar = camara.slice(camara.indexOf('const onPressOut'), camara.indexOf('const acciones'));
  assert.match(alSoltar, /if \(holdFired\.current\) return;\s*void takePhoto\(\);/);
  // Y vuelve a modo foto al terminar de grabar (el reposo depende del modo).
  assert.match(camara, /const modoEnReposo: CameraMode = soloVideo \? 'video' : 'picture';/);
  assert.match(camara, /setMode\(modoEnReposo\)/);
});

test('la pista y la etiqueta dicen lo que hace el disparador en cada camara', () => {
  const camara = leer('../screens/StoryCaptureScreen.tsx');
  assert.match(camara, /t\(soloVideo \? 'camera\.hintVideo' : 'camera\.hint'\)/);
  assert.match(camara, /t\(soloVideo \? 'camera\.shutterVideoA11y' : 'camera\.shutterA11y'\)/);
});
