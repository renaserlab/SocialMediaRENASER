import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * QUE UN VIDEO NO SIGA SONANDO CUANDO YA NO SE VE.
 *
 * El fallo, visto en produccion: un video de Inicio seguia oyendose despues de
 * cambiar de seccion. La causa NO era que faltara la orden de parar, sino que
 * la unica que quedaba llegaba tarde:
 *
 *   1. Cuando la seccion deja de estar activa, el elemento del feed deja de
 *      pintar `<VideoPlayer />` y React lo DESMONTA. O sea: la forma de callar
 *      el sonido era destruir el reproductor.
 *   2. `useVideoPlayer` (expo-video) suelta el reproductor NATIVO en la
 *      limpieza de un `useEffect` propio, declarado antes que ningun otro del
 *      componente. Las limpiezas pasivas corren en orden de declaracion, asi
 *      que al desmontar se libera PRIMERO y los `player.pause()` de despues
 *      caen sobre un objeto muerto — se los traga `safely()`, que existe justo
 *      por eso.
 *   3. Con lo cual el silencio dependia entero de `release()`, y en Android
 *      esa liberacion se encola (`GlobalScope.launch(Dispatchers.Main)`) en el
 *      mismo hilo que esta montando la seccion nueva. Ese retraso es el audio
 *      que se oye por encima de Explorar o de Perfil.
 *
 * La regla que fija este fichero: la parada tiene que ocurrir MIENTRAS el
 * reproductor sigue vivo, y tiene que estar atada al ciclo de vida de ESE
 * reproductor — nada de un silenciado global que apagaria tambien los reels,
 * los cursos y las historias.
 *
 * Se comprueba sobre el CODIGO FUENTE, por lo mismo que
 * `cuadriculaSinReproductores.test.mts`: montar la vista pediria un renderizador
 * de React Native que este proyecto no tiene en las pruebas, y lo que hay que
 * impedir no es un valor mal calculado sino que alguien vuelva a confiar la
 * parada a una limpieza que corre demasiado tarde.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. La parada llega ANTES de que expo-video suelte el reproductor
// ---------------------------------------------------------------------------

test('el reproductor se para en la fase de layout, no en la pasiva', () => {
  const reproductor = fuente('components/VideoPlayer.tsx');

  assert.ok(
    reproductor.includes('useLayoutEffect'),
    'VideoPlayer ya no para el video en la fase de layout. Sin eso, la unica ' +
      'pausa al desmontar corre DESPUES del release() de expo-video y no hace nada.',
  );

  /*
    El `useLayoutEffect` de apagado tiene que existir Y devolver una limpieza
    que pause. Se busca el bloque entero para no dar por bueno un
    `useLayoutEffect` cualquiera que apareciera por otro motivo.
  */
  const apagado = /useLayoutEffect\(\(\) => \{\s*return \(\) => \{[\s\S]{0,200}?player\.pause\(\)/.test(
    reproductor,
  );
  assert.ok(
    apagado,
    'Falta la limpieza de layout que pausa el reproductor al desmontar. ' +
      'Debe ser useLayoutEffect: React ejecuta sus limpiezas en la fase de ' +
      'mutacion, antes de las pasivas, que es donde expo-video libera el objeto nativo.',
  );
});

test('la limpieza de layout tambien silencia, por el hueco hasta el release', () => {
  const reproductor = fuente('components/VideoPlayer.tsx');
  const bloque = /useLayoutEffect\(\(\) => \{\s*return \(\) => \{[\s\S]{0,300}?\}\);/.exec(reproductor);
  assert.ok(bloque, 'No se encuentra el bloque de apagado del reproductor.');
  assert.ok(
    /player\.muted = true/.test(bloque[0]),
    'Pausar es la orden, pero entre la pausa y la liberacion nativa hay unos ' +
      'milisegundos en los que un buffer ya entregado puede seguir sonando: ' +
      'el apagado tiene que silenciar ademas de pausar.',
  );
});

test('el apagado se declara despues de crear el reproductor', () => {
  /*
    Es lo que hace que la limpieza sea LA ULTIMA en registrarse por delante del
    release. Si alguien moviera este bloque encima de `useVideoPlayer` no habria
    reproductor que pausar.
  */
  const reproductor = fuente('components/VideoPlayer.tsx');
  const creacion = reproductor.indexOf('const player = useVideoPlayer(');
  const apagado = reproductor.indexOf('useLayoutEffect(() => {');
  assert.ok(creacion > 0, 'VideoPlayer ya no crea el reproductor con useVideoPlayer.');
  assert.ok(apagado > creacion, 'El apagado se declara antes de existir el reproductor.');
});

// ---------------------------------------------------------------------------
// 2. Nadie apaga el audio de toda la aplicacion para arreglar una pantalla
// ---------------------------------------------------------------------------

function ficherosDeCodigo(dir: string, encontrados: string[] = []): string[] {
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const ruta = join(dir, entrada.name);
    if (entrada.isDirectory()) ficherosDeCodigo(ruta, encontrados);
    else if (/\.tsx?$/.test(entrada.name) && !entrada.name.endsWith('.d.ts')) {
      encontrados.push(ruta);
    }
  }
  return encontrados;
}

test('el silencio no se resuelve tocando la sesion de audio del proceso', () => {
  /*
    `setAudioModeAsync` cambia el audio de TODO el proceso. Usarlo para callar
    un video apagaria tambien el podcast que se este escuchando, el audio de
    presentacion de un perfil y la leccion de un curso. Solo puede vivir donde
    se configura la sesion una vez por arranque.
  */
  const permitido = join(SRC, 'hooks', 'useBackgroundAudio.ts');
  const culpables: string[] = [];
  for (const ruta of ficherosDeCodigo(SRC)) {
    if (ruta === permitido || ruta.endsWith('.test.mts')) continue;
    if (readFileSync(ruta, 'utf8').includes('setAudioModeAsync')) {
      culpables.push(ruta.slice(SRC.length + 1));
    }
  }
  assert.deepEqual(
    culpables,
    [],
    'Estos ficheros tocan la sesion de audio del proceso. El silencio de un ' +
      'video va atado a SU reproductor, no al audio de la aplicacion entera.',
  );
});

// ---------------------------------------------------------------------------
// 3. Las tres capas siguen diciendo lo mismo sobre quien puede reproducir
// ---------------------------------------------------------------------------

test('Inicio no reproduce nada sin preguntar si se le esta mirando', () => {
  const inicio = fuente('screens/InicioScreen.tsx');
  assert.ok(
    inicio.includes("from '@/navigation/foco'") && inicio.includes('useSeccionActiva()'),
    'InicioScreen debe decidir con useSeccionActiva: estar montado no es estar activo.',
  );

  /*
    Toda superficie que reproduzca en Inicio recibe `activo` y ese `activo`
    parte de `seccionActiva`. Sin la conjuncion, cambiar de pestaña dentro de
    Inicio dejaria sonando la anterior, y cambiar de seccion las tres.
  */
  const activos = inicio.match(/activo=\{[^}]*\}/g) ?? [];
  assert.ok(activos.length >= 3, 'Faltan superficies de Inicio con la guarda `activo`.');
  const sinGuarda = activos.filter((a) => !a.includes('seccionActiva'));
  assert.deepEqual(
    sinGuarda,
    [],
    'Hay superficies de Inicio que reproducen sin mirar si la seccion esta activa.',
  );
});

test('el feed no monta reproductores cuando no le toca', () => {
  const feed = fuente('components/FeedVerticalDeVideos.tsx');
  assert.ok(
    /active=\{activo && index === indiceActivo\}/.test(feed),
    'El video visible solo reproduce si ADEMAS su feed esta activo.',
  );
  assert.ok(
    /preload=\{activo &&/.test(feed),
    'La ventana de precarga tambien depende de que el feed este activo: si no, ' +
      'una pestaña que no se ve mantendria tres reproductores nativos vivos.',
  );

  const celda = fuente('components/ShortVideoItem.tsx');
  assert.ok(
    /\{active \|\| preload \?/.test(celda),
    'La celda debe montar el reproductor solo dentro de la ventana activa; ' +
      'fuera de ella pinta el poster.',
  );
});

test('salir de la aplicacion tambien cuenta como no estar mirando', () => {
  const foco = fuente('navigation/foco.ts');
  assert.ok(foco.includes('AppState.addEventListener'), 'Falta la condicion de aplicacion en segundo plano.');
  assert.ok(foco.includes('visibilitychange'), 'Falta la condicion de pestaña del navegador.');
  assert.ok(foco.includes('useIsFocused'), 'Falta la condicion de navegacion.');

  const reproductor = fuente('components/VideoPlayer.tsx');
  assert.ok(
    /AppState\.addEventListener\('change'/.test(reproductor),
    'El reproductor tiene que pausar por su cuenta al irse la aplicacion al fondo: ' +
      'la sesion de audio esta configurada para seguir sonando en segundo plano.',
  );
});

// ---------------------------------------------------------------------------
// 8. El salto directo: Inicio -> Perfil (y Crear, y Mensajes)
// ---------------------------------------------------------------------------

/*
  LA SEGUNDA MITAD DEL MISMO FALLO, y la que sobrevivio a la primera ronda.

  Sintoma exacto del reporte: el audio de Inicio SI se cortaba al ir a
  Explorar, pero NO al ir a Crear, ni a Mensajes, ni a Perfil.

  La diferencia era la distancia entre pestanas. Con el orden

      Inicio(0)  Explorar(1)  Crear(2)  Mensajes(3)  Perfil(4)

  `SwipeTabs` congelaba todo lo que no fuera la actual ni una vecina:

      <Freeze freeze={!esActual && !esVecina}>

  Yendo a Explorar, Inicio queda a un paso: sigue siendo vecina, no se congela,
  procesa el desenfoque y para el video. Yendo a Crear, Mensajes o Perfil queda
  a dos, tres o cuatro: pasa de actual a CONGELADA en el mismo render.

  Y una seccion congelada no se entera de nada. `react-freeze` suspende el
  subarbol lanzando un thenable que no resuelve jamas:

      const infiniteThenable = { then() {} };
      if (freeze) throw infiniteThenable;

  React descarta ese render y conserva lo ultimo commiteado, asi que el
  `useIsFocused()` recien puesto a `false` nunca commitea dentro de Inicio:
  `useSeccionActiva()` se queda en `true` y el reproductor sigue sonando.

  El arreglo NO es quitar el Freeze —eso devolveria el trabajo de repintar
  veinte tarjetas al hilo que anima el arrastre— sino retrasarlo un commit: una
  seccion solo se congela cuando ya se ha pintado una vez sabiendo que no es la
  actual.
*/

const SWIPE_TABS = fuente('navigation/SwipeTabs.tsx');

test('congelar exige una tercera condicion, no solo actual/vecina', () => {
  const freeze = SWIPE_TABS.match(/<Freeze\s+freeze=\{([^}]*)\}/);
  assert.ok(freeze, 'no se encontro el <Freeze> del carrusel');
  const condicion = freeze[1];

  assert.ok(
    /congelables/.test(condicion),
    'el Freeze vuelve a decidir solo por distancia. Con `!esActual && !esVecina` ' +
      'a secas, Inicio se congela en el mismo render en que deja de verse y su ' +
      `audio sigue sonando en Crear, Mensajes y Perfil.\nCondicion: ${condicion}`,
  );
});

test('lo congelable se calcula DESPUES del commit, no durante el render', () => {
  /*
    Es la clave de que funcione: en el render del cambio la seccion que se
    abandona sigue viva —se entera y para el video— y se congela en el
    siguiente. Si esto se calculara durante el render volveria el fallo.
  */
  const indiceEstado = SWIPE_TABS.indexOf('const [congelables, setCongelables]');
  assert.notEqual(indiceEstado, -1, 'falta el estado `congelables`');

  const trozo = SWIPE_TABS.slice(indiceEstado, indiceEstado + 900);
  assert.match(
    trozo,
    /useEffect\(/,
    '`congelables` tiene que actualizarse dentro de un useEffect: los efectos ' +
      'corren despues del commit, y ahi esta la garantia de que la seccion que ' +
      'se abandona llego a pintarse una vez sabiendo que ya no es la actual.',
  );
  assert.ok(
    /setCongelables\(/.test(trozo),
    'el efecto no actualiza `congelables`',
  );
});

test('el retraso del congelado no se apoya en ningun temporizador', () => {
  /*
    Un `setTimeout` daria el mismo resultado en un movil rapido y fallaria en
    uno lento, que es justo donde el audio de mas se nota. La garantia tiene que
    venir del orden render -> commit -> efecto, no del reloj.
  */
  const indice = SWIPE_TABS.indexOf('const [congelables, setCongelables]');
  const efecto = SWIPE_TABS.slice(indice, SWIPE_TABS.indexOf('}, [paginas', indice));
  assert.ok(
    !/setTimeout|setInterval|requestAnimationFrame/.test(efecto),
    'el calculo de `congelables` usa un temporizador. Tiene que bastar con que ' +
      'el efecto corra despues del commit.',
  );
});

test('la seccion que se abandona no se congela por distancia', () => {
  /*
    La comprobacion de la aritmetica del fallo, escrita como tabla para que se
    lea el caso concreto del reporte. `congelables` se calcula sobre las
    posiciones YA commiteadas, asi que en el render del salto todavia no
    contiene a Inicio.
  */
  const congelable = (posicion: number, actual: number) => Math.abs(posicion - actual) > 1;

  // Con el criterio VIEJO, estos tres congelaban Inicio en el acto:
  assert.equal(congelable(0, 2), true, 'Inicio -> Crear');
  assert.equal(congelable(0, 3), true, 'Inicio -> Mensajes');
  assert.equal(congelable(0, 4), true, 'Inicio -> Perfil');
  // Y este no, que es por lo que Explorar era el unico que funcionaba:
  assert.equal(congelable(0, 1), false, 'Inicio -> Explorar');

  // El arreglo no cambia esa aritmetica: cambia CUANDO se aplica. Por eso la
  // prueba de verdad es que el Freeze consulte `congelables`, arriba.
  assert.match(SWIPE_TABS, /congelables\.has\(ruta\.key\)/);
});

test('sigue habiendo congelacion: no se arreglo quitando react-freeze', () => {
  // Quitar el Freeze haria desaparecer el sintoma y devolveria el trabajo de
  // repintar el muro entero al hilo que anima el arrastre.
  assert.match(SWIPE_TABS, /import \{ Freeze \} from 'react-freeze'/);
  assert.match(SWIPE_TABS, /<Freeze/);
});
