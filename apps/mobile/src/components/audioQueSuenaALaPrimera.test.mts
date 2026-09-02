import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * QUE EL AUDIO SUENE A LA PRIMERA, Y QUE SOLO SUENE UNO.
 *
 * Tres fallos vistos por el cliente, con la misma raiz en dos de ellos: se daba
 * una orden a un objeto nativo que todavia no estaba en condiciones de
 * cumplirla, y el objeto ni sonaba ni se quejaba.
 *
 * ## 10.3 — «Se presiona play y la primera vez no funciona»
 *
 * `AudioDePresentacion` firmaba la URL al tocar y reproducia acto seguido:
 *
 *     const reproductor = useAudioPlayer(urlFirmada ? { uri: urlFirmada } : null);
 *     ...
 *     const url = await asegurarUrl();   // guarda la firma en el estado
 *     reproductor.play();                // el reproductor de ESTE render
 *
 * `useAudioPlayer` se apoya en `useReleasingSharedObject`: el objeto NATIVO se
 * construye con la fuente que haya en el momento de crearlo y solo se sustituye
 * por otro cuando la fuente cambia, o sea en el RENDER SIGUIENTE. La funcion de
 * la pulsacion tenia capturado el reproductor creado con `null`, y `play()`
 * sobre un reproductor sin fuente no suena ni lanza. Al segundo toque ya existia
 * el bueno: «a la segunda, o incluso a la tercera».
 *
 * ## 10.8 — «AudioRecorder has already been prepared»
 *
 * En el mismo componente. `empezar()` llamaba a `prepareToRecordAsync()` sin
 * ninguna guarda sincrona, y el unico dato que decia si ya se estaba grabando
 * venia de `useAudioRecorderState`, que SONDEA cada 250 ms. Dos toques seguidos
 * —o el corte automatico del minuto solapado con un toque— entraban los dos, y
 * el segundo preparaba una grabadora ya preparada. Eso es literalmente ese
 * error.
 *
 * ## 10.4 — El podcast pedia dos pulsaciones
 *
 * La lista abria el reproductor en linea con el primer toque, pero el
 * reproductor nacia en pausa: hacia falta un segundo toque DENTRO para que
 * sonara.
 *
 * Se comprueba sobre el CODIGO FUENTE, por lo mismo que
 * `audioDelReproductor.test.mts`: montar estas vistas pediria un renderizador de
 * React Native que este proyecto no tiene en las pruebas, y lo que hay que
 * impedir no es un valor mal calculado sino que alguien vuelva a dar la orden
 * antes de que haya quien la cumpla.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

/** El codigo sin comentarios: aqui se habla mucho del fallo, y por su nombre. */
function sinComentarios(codigo: string): string {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const HOOK = sinComentarios(fuente('hooks/useReproductorUnico.ts'));
const INTRO = sinComentarios(fuente('components/AudioDePresentacion.tsx'));
const REPRODUCTOR = sinComentarios(fuente('components/AudioPlayer.tsx'));
const LISTA = sinComentarios(fuente('components/PodcastList.tsx'));

/** El cuerpo de una funcion declarada con `const nombre = useCallback(`. */
function cuerpoDe(codigo: string, nombre: string): string {
  const inicio = codigo.indexOf(`const ${nombre} = useCallback(`);
  assert.notEqual(inicio, -1, `no se encontro \`${nombre}\``);
  const resto = codigo.slice(inicio);
  // Hasta la siguiente declaracion de primer nivel, que basta para aislarla.
  const fin = resto.indexOf('\n  const ', 1);
  return fin === -1 ? resto : resto.slice(0, fin);
}

// ---------------------------------------------------------------------------
// 1. 10.3 — La reproduccion se APUNTA y se dispara cuando hay con que
// ---------------------------------------------------------------------------

test('existe la reproduccion diferida, y espera a que la fuente este cargada', () => {
  assert.match(
    HOOK,
    /export function useReproduccionDiferida\(/,
    'falta el autoplay diferido: es lo unico que hace que la PRIMERA pulsacion ' +
      'suene cuando la URL firmada llega despues.',
  );

  /*
    El disparo tiene que estar dentro de un efecto y depender de las dos cosas
    que faltaban: el reproductor (que cambia de identidad al cambiar la fuente)
    y `listo`. Si dependiera solo de una, volveria el fallo.
  */
  const efecto = /useEffect\(\(\) => \{\s*if \(!pendiente \|\| !reproductor \|\| !listo\) return;[\s\S]{0,300}?\}, \[pendiente, reproductor, listo\]\);/.test(
    HOOK,
  );
  assert.ok(
    efecto,
    'el disparo de la reproduccion pendiente ya no depende del reproductor Y de ' +
      '`listo`. Sin las dos condiciones se vuelve a reproducir sobre un objeto ' +
      'que aun no tiene fuente, que es justo el fallo 10.3.',
  );
});

test('la espera no se queda colgada para siempre', () => {
  // Una firma caducada o un archivo borrado no cargan nunca: sin tope, la rueda
  // giraria hasta que la persona cerrara el perfil.
  assert.match(HOOK, /ESPERA_MAXIMA_MS/);
  assert.match(HOOK, /setTimeout\(/);

  /*
    Y al agotarse se intenta igual, a ciegas. Es lo que hacia el codigo viejo en
    todos los casos: si algun dia `isLoaded` no llegara a ser cierto en alguna
    plataforma, este ultimo recurso evita que la espera empeore lo que habia.
  */
  const espera = HOOK.slice(HOOK.indexOf('const reloj = setTimeout('));
  assert.match(espera.slice(0, 400), /conCuidado\(\(\) => reproductor\.play\(\)\);/);
});

test('AudioDePresentacion ya no reproduce justo despues de firmar', () => {
  const alternar = cuerpoDe(INTRO, 'alternarReproduccion');

  assert.ok(
    !/await asegurarUrl\(\)[\s\S]{0,200}reproductor\.play\(\)/.test(alternar),
    'vuelve a haber un `reproductor.play()` detras del `await asegurarUrl()`. ' +
      'Ese reproductor es el del render actual, creado con la fuente `null`: no ' +
      'suena y no lanza. Es EL fallo 10.3.',
  );
  assert.ok(
    !/\breproductor\.play\(\)/.test(INTRO),
    'la reproduccion tiene que pasar por `useReproduccionDiferida`, que es quien ' +
      'sabe si hay fuente. Un `play()` suelto se salta esa comprobacion.',
  );
  assert.match(
    alternar,
    /pedir\(\);/,
    'la pulsacion tiene que APUNTAR la reproduccion antes de pedir la firma.',
  );
});

test('la senal de «se puede reproducir» es la fuente cargada, no la URL a secas', () => {
  assert.match(
    INTRO,
    /const listo = !!urlFirmada && \(estado\?\.isLoaded \?\? false\);/,
    'tener la URL no basta: el objeto nativo se crea en el render siguiente y ' +
      'ademas tarda en abrir el archivo. `isLoaded` es la unica senal fiable.',
  );
});

test('el doble toque cancela la espera en vez de encolar otra reproduccion', () => {
  for (const [nombre, alternar] of [
    ['AudioDePresentacion', cuerpoDe(INTRO, 'alternarReproduccion')],
    ['AudioPlayer', cuerpoDe(REPRODUCTOR, 'toggle')],
  ] as const) {
    assert.ok(
      /if \(pendiente\) \{\s*cancelar\(\);\s*return;\s*\}/.test(alternar),
      `${nombre} no corta el segundo toque mientras se espera: dos pulsaciones ` +
        'seguidas dejarian dos ordenes de reproducir en carrera.',
    );
  }
});

test('al terminar se rebobina, para poder volver a escucharlo', () => {
  // Sin esto, el reproductor se queda al final y el toque siguiente no suena.
  assert.match(INTRO, /seekTo\(0\)/);
  assert.match(REPRODUCTOR, /seekTo\(0\)/);
});

test('cambiar de perfil o salir de la pantalla limpia el audio anterior', () => {
  // La firma vieja apunta a otro archivo.
  assert.match(INTRO, /useEffect\(\(\) => \{\s*setUrlFirmada\(null\);\s*\}, \[rutaDelAudio\]\);/);
  // Y la salida del carrusel cancela ademas la reproduccion pendiente: si no,
  // la firma llegaria con el perfil ya cerrado y el audio arrancaria solo.
  const salida = INTRO.slice(INTRO.indexOf('alSalir.current = ()'));
  assert.match(salida.slice(0, 300), /cancelar\(\);/);
  assert.match(salida.slice(0, 300), /reproductor\.pause\(\)/);
});

// ---------------------------------------------------------------------------
// 2. 10.8 — La grabadora no se prepara dos veces
// ---------------------------------------------------------------------------

test('empezar a grabar esta detras de un cerrojo SINCRONO', () => {
  const empezar = cuerpoDe(INTRO, 'empezar');
  assert.match(
    empezar,
    /^[\s\S]{0,200}if \(enCurso\.current\) return;/,
    'la guarda tiene que ser lo primero y tiene que ser una referencia: con ' +
      'estado, dos toques en el mismo instante leen el valor viejo y los dos ' +
      'llaman a `prepareToRecordAsync`.',
  );
  assert.match(empezar, /enCurso\.current = true;/);
});

test('no se prepara una grabadora que ya estaba preparada', () => {
  const empezar = cuerpoDe(INTRO, 'empezar');
  const soltar = empezar.indexOf('await soltarGrabadora();');
  const preparar = empezar.indexOf('await grabadora.prepareToRecordAsync();');

  assert.notEqual(soltar, -1, 'falta deshacer una preparacion anterior antes de preparar.');
  assert.notEqual(preparar, -1, 'ya no se prepara la grabadora.');
  assert.ok(
    soltar < preparar,
    'la preparacion anterior tiene que deshacerse ANTES de volver a preparar; ' +
      'al reves sale «AudioRecorder has already been prepared».',
  );

  // `stop()` es la unica via para deshacer una preparacion: no hay «unprepare».
  const soltarGrabadora = cuerpoDe(INTRO, 'soltarGrabadora');
  assert.match(soltarGrabadora, /if \(!preparada\.current\) return;/);
  assert.match(
    soltarGrabadora,
    /preparada\.current = false;[\s\S]{0,120}await grabadora\.stop\(\);/,
    'la bandera se baja ANTES de esperar: si `stop()` falla, la grabadora no ' +
      'puede quedar marcada como preparada para siempre.',
  );

  assert.equal(
    (INTRO.match(/prepareToRecordAsync/g) ?? []).length,
    1,
    'hay mas de una llamada a `prepareToRecordAsync` en el componente.',
  );
});

test('la sesion de audio se pone en modo grabacion ANTES de preparar', () => {
  // En iOS `prepareToRecordAsync` falla si la categoria de la sesion no admite
  // grabar. Es la misma secuencia que sigue `useGrabadoraDeVoz`.
  const empezar = cuerpoDe(INTRO, 'empezar');
  const sesion = empezar.indexOf('await permitirGrabar(true);');
  const preparar = empezar.indexOf('await grabadora.prepareToRecordAsync();');
  assert.notEqual(sesion, -1, 'no se pide la sesion de grabacion.');
  assert.ok(sesion < preparar, 'la sesion tiene que estar puesta antes de preparar.');

  // Y se devuelve siempre: dejarla en modo grabacion baja el volumen de toda la
  // aplicacion en iOS hasta que se cierre.
  assert.match(INTRO, /await permitirGrabar\(false\);/);
});

test('parar comparte el mismo cerrojo que empezar', () => {
  /*
    El corte automatico al llegar al minuto se dispara desde un efecto que se
    reevalua con cada tic del reloj. Sin cerrojo compartido, el mismo audio se
    subia dos veces y el perfil se guardaba dos veces.
  */
  const parar = cuerpoDe(INTRO, 'parar');
  assert.match(parar, /if \(enCurso\.current\) return;/);
  assert.match(parar, /preparada\.current = false;/);
});

test('el microfono no se sondea en cada perfil que se visita', () => {
  /*
    `useAudioRecorderState` monta un `setInterval` que llama al objeto NATIVO se
    este grabando o no. Puesto en el audio de presentacion, eso era un sondeo
    permanente contra el microfono en CADA perfil abierto — y un valor con 250 ms
    de retraso, que es lo que dejaba pasar el segundo toque de 10.8.
  */
  assert.ok(
    !/useAudioRecorderState/.test(INTRO),
    'vuelve a usarse `useAudioRecorderState`: sondea el microfono sin parar y su ' +
      'retraso es lo que permitia la doble preparacion.',
  );
  const indiceGuarda = INTRO.indexOf("if (fase !== 'grabando') return;");
  const indiceReloj = INTRO.indexOf('setInterval');
  assert.notEqual(indiceGuarda, -1, 'falta la guarda de fase antes del contador');
  assert.notEqual(indiceReloj, -1, 'falta el contador propio');
  assert.ok(indiceGuarda < indiceReloj, 'el contador solo puede correr mientras se graba');
});

test('al desmontar no se le pregunta nada a la grabadora', () => {
  /*
    `useAudioRecorder` libera el objeto en la limpieza de su propio efecto, que
    se declaro ANTES que este y por tanto corre antes. Leer o llamar cualquier
    cosa aqui reventaba la aplicacion; la leccion completa esta en
    `hooks/grabadoraNoTocaLoLiberado.test.mts`.
  */
  const desmontaje = INTRO.slice(INTRO.indexOf('const grabandoAhora = useRef(false);'));
  const bloque = desmontaje.slice(0, desmontaje.indexOf('};') + 2);
  assert.ok(
    !/grabadora\./.test(bloque),
    `la limpieza de desmontaje toca la grabadora ya liberada.\nBloque:\n${bloque}`,
  );
  assert.match(
    bloque,
    /grabandoAhora\.current/,
    'si se estaba grabando hay que devolver la sesion de audio, y se sabe por una ' +
      'referencia propia, no preguntandole al objeto nativo.',
  );
});

test('lo que se le ensena a la persona esta traducido, nunca el error nativo', () => {
  /*
    `describeError` devuelve el mensaje NATIVO —«AudioRecorder has already been
    prepared»—, que era justo lo que aparecia en pantalla. El motivo tecnico va
    al registro; a quien mira, una clave del diccionario.
  */
  assert.ok(
    !/describeError/.test(INTRO),
    'vuelve a usarse `describeError` para lo que se ve: eso es enseñar el error ' +
      'nativo crudo.',
  );
  /*
    Cada `setAviso(...)` tiene que llevar dentro una clave del diccionario (o
    `null`, que es limpiar el aviso). Se mira un trozo generoso detras de la
    llamada porque algunos son un ternario de dos claves.
  */
  const sinTraducir: string[] = [];
  for (const encontrado of INTRO.matchAll(/setAviso\(/g)) {
    const trozo = INTRO.slice(encontrado.index, encontrado.index + 160);
    if (!/setAviso\(null\)/.test(trozo) && !/t\('/.test(trozo)) sinTraducir.push(trozo);
  }
  assert.deepEqual(sinTraducir, [], 'hay avisos que no salen del diccionario.');
});

// ---------------------------------------------------------------------------
// 3. 10.4 — Un solo reproductor, en linea, y con una sola pulsacion
// ---------------------------------------------------------------------------

test('la lista monta UN reproductor, el del episodio elegido', () => {
  assert.equal(
    (LISTA.match(/<AudioPlayer/g) ?? []).length,
    1,
    'hay mas de un `<AudioPlayer>` en la lista. Montar uno por fila deja treinta ' +
      'decodificadores nativos abiertos.',
  );
  assert.match(
    LISTA,
    /\{isPlaying \? \(\s*<AudioPlayer/,
    'el reproductor tiene que colgar del episodio activo.',
  );
  // Un solo identificador activo: elegir otro episodio desmonta el anterior.
  assert.match(LISTA, /const \[playingId, setPlayingId\] = useState<string \| null>\(null\);/);
  assert.match(LISTA, /setPlayingId\(isPlaying \? null : episode!\.id\)/);
});

test('una sola pulsacion: el episodio empieza a sonar solo', () => {
  assert.match(
    LISTA,
    /<AudioPlayer[\s\S]{0,200}autoPlay/,
    'sin `autoPlay` el reproductor se abre en pausa y hace falta un segundo ' +
      'toque dentro, que es el fallo 10.4.',
  );
  // Y ese autoPlay pasa por la reproduccion diferida, no por un `play()` a ciegas.
  assert.match(
    REPRODUCTOR,
    /useEffect\(\(\) => \{\s*if \(autoPlay\) pedir\(\);\s*\}, \[autoPlay, pedir, player\]\);/,
    'el arranque automatico tiene que apuntarse y dispararse cuando la fuente ' +
      'cargue; un `play()` inmediato se pierde igual que en 10.3.',
  );
});

test('el reproductor se despliega EN LINEA, no en una bandeja ni otra pantalla', () => {
  assert.ok(
    !/Modal|BottomSheet|router\.push/.test(LISTA),
    'la lista abre algo que no es el reproductor en linea bajo el episodio.',
  );
  assert.match(LISTA, /variante="lista"/);
  // Bordes redondeados, como el resto de las tarjetas.
  assert.match(REPRODUCTOR, /card: \{[\s\S]{0,160}borderRadius: radius\.lg/);
});

test('el reproductor en linea trae barra arrastrable, tiempos y saltos', () => {
  assert.match(REPRODUCTOR, /<AudioScrubber/, 'la barra se reutiliza, no se duplica.');
  assert.equal(
    (REPRODUCTOR.match(/<AudioScrubber/g) ?? []).length,
    1,
    'la barra se declara una sola vez y se comparte entre las dos variantes.',
  );
  assert.match(REPRODUCTOR, /formatTime\(scrubTime \?\? current\)/, 'falta el tiempo transcurrido');
  assert.match(REPRODUCTOR, /const total = formatTime\(duration\)/, 'falta la duracion total');
  assert.match(REPRODUCTOR, /saltar\(-SALTO_S\)/, 'falta retroceder');
  assert.match(REPRODUCTOR, /saltar\(SALTO_S\)/, 'falta adelantar');
  assert.match(REPRODUCTOR, /name={playing \? 'pause' : 'play'}/, 'falta el play/pausa');
});

test('el salto no se sale del audio', () => {
  const saltar = cuerpoDe(REPRODUCTOR, 'saltar');
  assert.match(saltar, /Math\.min\(Math\.max\(0, current \+ delta\), tope\)/);
});

// ---------------------------------------------------------------------------
// 4. Solo un audio sonando, y se libera al desmontar
// ---------------------------------------------------------------------------

test('empezar a sonar calla a quien estuviera sonando', () => {
  assert.match(HOOK, /export function reclamarSonido\(/);
  assert.match(
    HOOK,
    /reclamarSonido\(reproductor\);\s*conCuidado\(\(\) => reproductor\.play\(\)\);/,
    'el turno se reclama ANTES de arrancar: al reves los dos suenan a la vez.',
  );
  assert.match(
    HOOK,
    /if \(anterior && anterior !== reproductor\) conCuidado\(\(\) => anterior\.pause\(\)\);/,
    'reclamar el turno tiene que pausar al anterior mientras sigue vivo.',
  );
});

test('la parada corre en la fase de layout, antes de que expo-audio libere', () => {
  /*
    Misma leccion que `audioDelReproductor.test.mts` para el video: React ejecuta
    las limpiezas de layout en la fase de mutacion, antes que las pasivas, y la
    pasiva de `useReleasingSharedObject` es la que suelta el objeto nativo. Con
    un `useEffect` normal la pausa caeria sobre algo ya muerto y el silencio
    dependeria de una liberacion que en Android se encola.
  */
  assert.match(HOOK, /export function useSilencioAlDesmontar\(/);
  const apagado = /useLayoutEffect\(\(\) => \{[\s\S]{0,120}?return \(\) => \{[\s\S]{0,300}?reproductor\.pause\(\);/.test(
    HOOK,
  );
  assert.ok(apagado, 'la limpieza que pausa ya no es de layout.');
  assert.match(
    HOOK,
    /reproductor\.muted = true;/,
    'entre la pausa y la liberacion nativa un buffer ya entregado puede seguir ' +
      'oyendose: hay que silenciar ademas de pausar.',
  );
  assert.match(HOOK, /soltarSonido\(reproductor\);/, 'hay que devolver el turno al desmontar.');
});

test('los dos reproductores se apuntan a la limpieza', () => {
  assert.match(REPRODUCTOR, /useSilencioAlDesmontar\(player\);/);
  assert.match(INTRO, /useSilencioAlDesmontar\(reproductor\);/);
});

test('la limpieza se rehace cuando cambia el reproductor, no solo al desmontar', () => {
  /*
    Cambiar de perfil o de episodio sustituye el objeto nativo por otro. Si la
    dependencia fuera `[]`, la limpieza se quedaria atada al primero y el
    saliente seguiria sonando.
  */
  const bloque = HOOK.slice(HOOK.indexOf('export function useSilencioAlDesmontar('));
  assert.match(bloque, /\}, \[reproductor\]\);/);
});

test('nadie apaga el audio del proceso para callar una pantalla', () => {
  // `setAudioModeAsync` es global: solo puede vivir en `useBackgroundAudio`.
  for (const [nombre, codigo] of [
    ['useReproductorUnico', HOOK],
    ['AudioPlayer', REPRODUCTOR],
    ['AudioDePresentacion', INTRO],
    ['PodcastList', LISTA],
  ] as const) {
    assert.ok(!/setAudioModeAsync/.test(codigo), `${nombre} toca la sesion de audio del proceso.`);
  }
});

// ---------------------------------------------------------------------------
// 5. Lo que ya funcionaba y no se puede perder
// ---------------------------------------------------------------------------

test('la lista sigue respetando candados, membresia y publicacion programada', () => {
  assert.match(LISTA, /const gate = gateFor\(index\);/);
  assert.match(LISTA, /const playable = gate\.state === 'open' && !!episode\?\.mediaUrl;/);
  assert.match(
    LISTA,
    /const isPlaying = playable && playingId === episode!\.id;/,
    'solo puede sonar un episodio abierto: sin `playable` se reproduciria uno ' +
      'bloqueado o todavia en cuenta atras.',
  );
  assert.match(LISTA, /gate\.state === 'waiting'/);
  assert.match(LISTA, /gate\.state === 'membership'/);
});

test('el reproductor sigue cediendo la pantalla de bloqueo al desmontarse', () => {
  // Solo un reproductor puede ocupar los controles del sistema.
  assert.match(REPRODUCTOR, /try \{\s*player\.setActiveForLockScreen\(false\);/);
});
