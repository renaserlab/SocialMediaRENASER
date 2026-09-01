import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Salir del chat cerraba la aplicación. Que no vuelva a pasar.
 *
 * EL FALLO, visto en un teléfono de verdad con la versión de Play Console:
 *
 *     The 1st argument cannot be cast to type expo.modules.audio.AudioRecorder
 *     (received class java.lang.Integer)
 *     → Caused by: Cannot use shared object that was already released
 *
 * Ocurría **siempre** al pulsar atrás en un chat, se hubiera grabado o no.
 *
 * LA CAUSA. `useGrabadoraDeVoz` terminaba con esta limpieza:
 *
 *     useEffect(() => () => { if (grabador.isRecording) void cerrar(); }, [...]);
 *
 * `isRecording` es una propiedad del objeto NATIVO. Y `useAudioRecorder` se
 * apoya en `useReleasingSharedObject`, cuya limpieza llama a `release()` al
 * desmontar. React ejecuta las limpiezas **en el orden en que se declararon los
 * efectos**, y `useAudioRecorder` es la primera línea del hook: para cuando
 * corría aquella limpieza —la última—, el objeto ya estaba liberado. El puente
 * pasaba entonces el ID en lugar del objeto, y de ahí el error de casteo.
 *
 * LA REGLA QUE FIJA ESTE FICHERO: **en el desmontaje no se toca nada nativo.**
 * El resto del repositorio ya la seguía —`VideoPlayer` envuelve sus limpiezas en
 * `safely()` y `AudioPlayer` en `try/catch`, con el comentario «el reproductor
 * ya se liberó al desmontarse»—. Este hook era el único que no.
 *
 * Se mira el CÓDIGO FUENTE, como en `cuadriculaSinReproductores.test.mts`:
 * montar la pantalla pediría un renderizador de React Native que este proyecto
 * no tiene en las pruebas, y lo que hay que impedir no es un valor mal calculado
 * sino una línea que vuelva a colarse donde ya causó una caída.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

/** El código sin comentarios: aquí se habla mucho del fallo, y por su nombre. */
function sinComentarios(codigo: string): string {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const GRABADORA = sinComentarios(fuente('hooks/useGrabadoraDeVoz.ts'));

// ---------------------------------------------------------------------------
// 1. La causa exacta
// ---------------------------------------------------------------------------

test('la limpieza de desmontaje no lee ninguna propiedad del grabador', () => {
  // Los bloques `return () => { ... }` de este fichero, que son las limpiezas.
  const limpiezas = [...GRABADORA.matchAll(/return \(\) => \{([\s\S]*?)\n {4}\};/g)].map(
    (m) => m[1],
  );
  assert.ok(limpiezas.length > 0, 'no se encontró ninguna limpieza que revisar');

  for (const cuerpo of limpiezas) {
    assert.ok(
      !/grabador\./.test(cuerpo),
      'una limpieza toca `grabador.`: al desmontar ya está liberado y revienta.\n' +
        `Bloque:\n${cuerpo}`,
    );
  }
});

test('no queda ni rastro de `grabador.isRecording`', () => {
  // Era la línea exacta que cerraba la aplicación.
  assert.ok(!/grabador\.isRecording/.test(GRABADORA));
});

// ---------------------------------------------------------------------------
// 2. La otra mitad: el sondeo permanente
// ---------------------------------------------------------------------------

test('no se usa `useAudioRecorderState`, que sondea el micrófono sin parar', () => {
  /*
    Ese hook de `expo-audio` monta un `setInterval` que llama a
    `recorder.getStatus()` cada 200 ms **se esté grabando o no**: cada chat
    abierto tenía un sondeo permanente contra el objeto nativo sin motivo, y era
    la otra pieza que podía tocarlo justo después de liberarse.
  */
  assert.ok(!/useAudioRecorderState/.test(GRABADORA));
});

test('el contador solo corre mientras se está grabando', () => {
  const indiceGuarda = GRABADORA.indexOf("if (fase !== 'grabando') return;");
  const indiceReloj = GRABADORA.indexOf('setInterval');
  assert.notEqual(indiceGuarda, -1, 'falta la guarda de fase antes del contador');
  assert.notEqual(indiceReloj, -1, 'falta el contador propio');
  assert.ok(
    indiceGuarda < indiceReloj,
    'el `setInterval` tiene que estar detrás de la guarda: si no, vuelve a ser ' +
      'un sondeo permanente',
  );
});

test('el contador lee del nativo con red debajo', () => {
  // Aunque la limpieza lo pare, un tic puede coincidir con la liberación.
  const reloj = GRABADORA.slice(GRABADORA.indexOf('setInterval'));
  assert.match(reloj.slice(0, 400), /try \{/);
});

// ---------------------------------------------------------------------------
// 3. Lo que sí hay que deshacer al salir
// ---------------------------------------------------------------------------

test('al salir grabando se devuelve la sesión de audio', () => {
  /*
    `release()` ya cierra el micrófono: eso lo hace `expo-audio`. Lo que NO
    deshace es la sesión de audio del proceso, que no es del grabador. Si se
    queda en modo grabación, en iOS baja el volumen de TODA la aplicación hasta
    que se cierre.

    Y se sabe si se estaba grabando por una referencia propia, no preguntándoselo
    al objeto nativo: ése era justo el fallo.
  */
  assert.match(GRABADORA, /grabandoAhora\.current/);
  assert.match(GRABADORA, /permitirGrabar\(false\)/);
});

// ---------------------------------------------------------------------------
// 4. La regla, en los demás
// ---------------------------------------------------------------------------

test('quien ya tocaba nativo en una limpieza sigue teniendo su guarda', () => {
  /*
    Estos dos ya lo hacían bien antes de esta ronda, y la prueba está aquí para
    que nadie les quite la guarda pensando que sobra. Es la misma lección, y este
    repositorio ya la había aprendido: el hook de la grabadora era el único que
    no la seguía.
  */
  const video = fuente('components/VideoPlayer.tsx');
  assert.match(video, /safely\(\(\) => \{\s*player\.pause\(\);/);

  const audio = fuente('components/AudioPlayer.tsx');
  assert.match(audio, /try \{\s*player\.setActiveForLockScreen\(false\);/);

  const nota = fuente('components/BurbujaDeNotaDeVoz.tsx');
  assert.match(nota, /try \{\s*reproductor\.muted = true;/);
});
