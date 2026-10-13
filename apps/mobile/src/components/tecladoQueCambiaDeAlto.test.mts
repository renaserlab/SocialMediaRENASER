import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  TECLADO_ABIERTO,
  TECLADO_ABRIENDOSE,
  TECLADO_CERRADO,
  altoQueSeAvisa,
  huecoDelMarco,
  margenInferiorConTeclado,
  rellenoInferior,
  tecladoALaVista,
  type EstadoDelTeclado,
} from '../lib/huecoDelTeclado.ts';

/**
 * EL TECLADO TAPABA EL CAMPO DONDE SE ESCRIBE (teléfono, 06–07/10/2026).
 *
 * En el directo, en los comentarios de una publicación y en la descripción al
 * publicar: con el teclado abierto, el campo quedaba medio tapado.
 *
 * LA CAUSA, leída en React Native 0.81 (`ReactRootView.checkForKeyboardEvents`):
 * en Android 11 o superior solo se avisa cuando el teclado APARECE o
 * DESAPARECE. Si cambia de alto estando abierto —la fila de sugerencias que
 * sale al empezar a escribir— no avisa nadie, y lo que se había apartado se
 * queda corto justo en lo que creció el teclado.
 *
 * Y UNA SEGUNDA, AL BUSCARLA: 49 pantallas con campos no apartaban nada.
 * `AppScreen` solo lo hacía si se le pedía.
 *
 * Las cuentas se EJECUTAN; lo que es de pantalla se comprueba sobre el código.
 * Que el campo quede a la vista en un teléfono solo se ve en un teléfono.
 */

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const RAIZ = join(SRC, '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (codigo: string) =>
  codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Un teléfono de 800 de alto con un teclado que empieza en 500. */
const VENTANA = 800;
const conTeclado = (parte: Partial<EstadoDelTeclado>): EstadoDelTeclado => ({
  ...TECLADO_CERRADO,
  altoDeLaVentana: VENTANA,
  ...parte,
});

describe('cuánto se aparta un marco', () => {
  it('sin medir el marco no se aparta nada', () => {
    assert.equal(huecoDelMarco(null, conTeclado({ visible: true, bordeSegunElAviso: 500, altoAsentado: 300 })), 0);
  });

  it('con el teclado cerrado, cero', () => {
    assert.equal(huecoDelMarco(800, conTeclado({})), 0);
  });

  it('mientras se abre manda el aviso de React Native, que llega antes', () => {
    assert.equal(huecoDelMarco(800, conTeclado({ visible: true, bordeSegunElAviso: 500 })), 300);
  });

  it('EL FALLO: el teclado crece 44 con la fila de sugerencias y el aviso no cambia', () => {
    // El aviso sigue diciendo 500; el teclado ya empieza en 456.
    const estado = conTeclado({ visible: true, bordeSegunElAviso: 500, altoAsentado: 344 });
    assert.equal(huecoDelMarco(800, estado), 344, 'el campo vuelve a quedar 44 por debajo del teclado');
  });

  it('y si el teclado ENCOGE estando abierto, no deja un hueco de más', () => {
    const estado = conTeclado({ visible: true, bordeSegunElAviso: 456, altoAsentado: 300 });
    assert.equal(huecoDelMarco(800, estado), 300);
  });

  it('un marco que no llega al borde de la ventana aparta solo lo que le tapan', () => {
    // Acaba en 752: debajo quedan 48 de la barra del sistema.
    assert.equal(huecoDelMarco(752, conTeclado({ visible: true, bordeSegunElAviso: 500, altoAsentado: 300 })), 252);
    // Y uno que acaba por encima del teclado, nada.
    assert.equal(huecoDelMarco(480, conTeclado({ visible: true, bordeSegunElAviso: 500, altoAsentado: 300 })), 0);
  });

  it('sin el alto de la ventana no se usa el alto asentado: vale el aviso', () => {
    const estado: EstadoDelTeclado = { visible: true, bordeSegunElAviso: 500, altoAsentado: 344, altoDeLaVentana: 0 };
    assert.equal(huecoDelMarco(800, estado), 300);
  });

  it('si React Native no llegó a avisar pero la ventana sí, se aparta igual', () => {
    assert.equal(huecoDelMarco(800, conTeclado({ visible: false, bordeSegunElAviso: null, altoAsentado: 300 })), 300);
  });
});

describe('el relleno de la pantalla y el del teclado no se suman', () => {
  it('sin teclado no se toca el relleno de la pantalla', () => {
    assert.equal(rellenoInferior(0, 96), null);
  });

  it('con teclado se queda el mayor de los dos', () => {
    // Una pantalla que reserva 96 para la barra de pestañas: el teclado ya la tapa.
    assert.equal(rellenoInferior(300, 96), 300);
    assert.equal(rellenoInferior(40, 96), 96);
    assert.equal(rellenoInferior(300, 0), 300);
  });
});

describe('qué se le dice a JavaScript del alto del teclado', () => {
  it('abierto: su alto; abriéndose: nada todavía; lo demás: cero', () => {
    assert.equal(altoQueSeAvisa(TECLADO_ABIERTO, 300.4), 300);
    assert.equal(altoQueSeAvisa(TECLADO_ABRIENDOSE, 120), -1);
    for (const estado of [0, 3, 4]) assert.equal(altoQueSeAvisa(estado, 300), 0);
  });

  it('los números de estado son los de Reanimated', () => {
    const tipos = readFileSync(
      join(RAIZ, '..', '..', 'node_modules', 'react-native-reanimated', 'src', 'commonTypes.ts'),
      'utf8',
    );
    const enumerado = /export enum KeyboardState \{([\s\S]*?)\}/.exec(tipos)?.[1] ?? '';
    assert.match(enumerado, new RegExp(`OPENING = ${TECLADO_ABRIENDOSE},`));
    assert.match(enumerado, new RegExp(`OPEN = ${TECLADO_ABIERTO},`));
  });

  it('React Native sigue sin avisar de los cambios de alto: por eso hace falta lo demás', () => {
    // Si esto deja de ser cierto, el aviso bastaría y sobra la mitad de este diseño.
    const raiz = readFileSync(
      join(RAIZ, '..', '..', 'node_modules', 'react-native', 'ReactAndroid', 'src', 'main', 'java', 'com', 'facebook', 'react', 'ReactRootView.java'),
      'utf8',
    );
    const moderno = raiz.slice(raiz.indexOf('private void checkForKeyboardEvents()'), raiz.indexOf('private void checkForKeyboardEventsLegacy()'));
    assert.match(moderno, /if \(keyboardIsVisible != mKeyboardIsVisible\) \{/);
    assert.ok(!/mKeyboardHeight/.test(moderno), 'el camino moderno ya compara alturas');
  });
});

describe('el proveedor, en la raíz y una sola vez', () => {
  const PROVEEDOR = sinComentarios(fuente('components/teclado.tsx'));
  const LAYOUT = sinComentarios(readFileSync(join(RAIZ, 'app', '_layout.tsx'), 'utf8'));

  it('declara translúcidas las dos barras: la aplicación es de borde a borde', () => {
    assert.match(PROVEEDOR, /useAnimatedKeyboard\(\{\s*isStatusBarTranslucentAndroid: true,\s*isNavigationBarTranslucentAndroid: true,\s*\}\)/);
  });

  it('no avisa a JavaScript mientras el teclado se abre, ni dos veces de lo mismo', () => {
    assert.match(PROVEEDOR, /if \(ahora === antes \|\| ahora < 0\) return;\s*runOnJS\(alAsentarse\)\(ahora\);/);
  });

  it('no anima nada: lo que se aparta es estado de React', () => {
    assert.ok(!/useAnimatedStyle|Animated\.View/.test(PROVEEDOR));
    assert.ok(!/useAnimatedStyle|Animated\.View/.test(sinComentarios(fuente('components/SinTecladoDelante.tsx'))));
  });

  it('al ocultarse el teclado olvida también el alto asentado', () => {
    const alOcultar = PROVEEDOR.slice(PROVEEDOR.indexOf("'keyboardDidHide'"), PROVEEDOR.indexOf('if (Keyboard.isVisible())'));
    assert.match(alOcultar, /setVisible\(false\);/);
    assert.match(alOcultar, /setAltoAsentado\(0\);/);
  });

  it('solo se engancha en Android', () => {
    assert.match(PROVEEDOR, /Platform\.OS === 'android' \? ProveedorEnAndroid : ProveedorSinTeclado/);
  });

  it('envuelve la aplicación por FUERA de la zona segura', () => {
    const dentro = LAYOUT.slice(LAYOUT.indexOf('<ProveedorDelTeclado>'), LAYOUT.indexOf('</ProveedorDelTeclado>'));
    assert.ok(dentro.includes('<SafeAreaProvider'), 'la regla de la ventana tiene que incluir los bordes');
    assert.ok(dentro.includes('<Stack'));
  });
});

describe('uno dentro de otro: aparta el de más adentro', () => {
  const APARTADO = sinComentarios(fuente('components/SinTecladoDelante.tsx'));

  it('el de dentro se apunta en el de fuera, y el de fuera cede', () => {
    assert.match(APARTADO, /return deFuera\.anidar\(\);/);
    assert.match(APARTADO, /const aparta = enabled && anidados === 0;/);
  });

  it('apagado, o en otra ventana, no hace ceder a nadie', () => {
    assert.match(APARTADO, /if \(!enabled \|\| ventanaPropia \|\| !deFuera\) return;/);
  });

  it('la hoja inferior es otra ventana y lo dice', () => {
    assert.match(sinComentarios(fuente('components/BottomSheet.tsx')), /<SinTecladoDelante style=\{styles\.modalContainer\} ventanaPropia>/);
  });

  it('el relleno de la pantalla se respeta: se queda el mayor', () => {
    assert.match(APARTADO, /const relleno = rellenoInferior\(hueco, rellenoDeLaPantalla\(style\)\);/);
  });
});

describe('ninguna pantalla con campos se queda sin apartar el teclado', () => {
  /**
   * Las que tienen el campo ARRIBA, donde el teclado no llega, y nada más:
   * la búsqueda de Explorar. Lo demás que hay en ella va en hojas o en el muro,
   * que traen su propio apartado.
   */
  const CAMPO_ARRIBA = new Set(['ExploreScreen']);

  const pantallas = readdirSync(join(SRC, 'screens'))
    .filter((nombre) => nombre.endsWith('Screen.tsx'))
    .map((nombre) => [nombre.replace('.tsx', ''), sinComentarios(fuente(`screens/${nombre}`))] as const);

  it('las que tienen campos usan AppScreen, un apartado propio o una hoja', () => {
    const conCampos = pantallas.filter(([, codigo]) => /<(Input|TextInput|CampoDeContrasena)\b/.test(codigo));
    assert.ok(conCampos.length >= 70, `se esperaban al menos 70 pantallas con campos y hay ${conCampos.length}`);
    const tapadas = conCampos
      .filter(([nombre]) => !CAMPO_ARRIBA.has(nombre))
      .filter(([, codigo]) => !/<AppScreen\b|<SinTecladoDelante\b|<BottomSheet\b/.test(codigo))
      .map(([nombre]) => nombre);
    assert.deepEqual(tapadas, [], 'En estas pantallas el teclado tapa lo que se escribe.');
  });

  it('ninguna apaga el apartado de AppScreen', () => {
    const apagadas = pantallas.filter(([, codigo]) => /<AppScreen[^>]*teclado=\{false\}/.test(codigo)).map(([n]) => n);
    assert.deepEqual(apagadas, []);
  });
});

describe('la caja del directo, debajo del teclado (teléfono, varias veces; la última el 12/10/2026)', () => {
  /*
    Los números del teléfono de la captura: pantalla de 800, barra de estado de
    40, barra de botones de 48, teclado de 277 contado desde abajo (empieza en
    523). En el directo la zona segura va por FUERA del marco, así que el marco
    acaba en 752.
  */
  const ESTADO = 40;
  const BOTONES = 48;
  const teclado = conTeclado({ visible: true, bordeSegunElAviso: 523, altoAsentado: 277 });
  const marcoDelDirecto = VENTANA - BOTONES;

  it('medido desde la raíz de la pantalla, el campo queda justo encima del teclado', () => {
    assert.equal(huecoDelMarco(marcoDelDirecto, teclado), 229);
    assert.equal(marcoDelDirecto - huecoDelMarco(marcoDelDirecto, teclado), 523);
  });

  it('EL FALLO: con la medida que descuenta la barra de estado, queda corto en ese alto', () => {
    // `measureInWindow` daba 712 en vez de 752: cuarenta de menos de relleno,
    // y la caja cuarenta por debajo del borde del teclado.
    const conLaOtraMedida = huecoDelMarco(marcoDelDirecto - ESTADO, teclado);
    assert.equal(conLaOtraMedida, 189);
    assert.equal(229 - conLaOtraMedida, ESTADO);
  });

  it('por eso el marco se mide con `measure` y su `pageY`, nunca con `measureInWindow`', () => {
    const marco = sinComentarios(fuente('components/SinTecladoDelante.tsx'));
    assert.match(marco, /marco\.current\?\.measure\(\(_x, _y, _ancho, alto, _enX, enY\) => \{\s*const borde = enY \+ alto;/);
    assert.doesNotMatch(marco, /measureInWindow/);
    // Nadie más en la aplicación mezcla esa medida con la del teclado.
    assert.doesNotMatch(sinComentarios(fuente('components/teclado.tsx')), /measureInWindow/);
  });

  it('en el chat el error estaba tapado por el margen del teléfono: por eso no se veía', () => {
    // El marco del chat llega al borde (800) y su barra suma por dentro el
    // margen de los botones. Con la medida vieja: 48 de margen menos 40 de error.
    const viejo = huecoDelMarco(VENTANA - ESTADO, teclado);
    assert.equal(VENTANA - viejo - BOTONES, 523 - 8, 'ocho por encima del teclado, de casualidad');
  });
});

describe('con el teclado abierto no se suma el margen inferior del teléfono', () => {
  it('hay teclado si lo dice el aviso o si lo dice su alto', () => {
    assert.equal(tecladoALaVista(TECLADO_CERRADO), false);
    assert.equal(tecladoALaVista(conTeclado({ visible: true })), true);
    assert.equal(tecladoALaVista(conTeclado({ altoAsentado: 277 })), true);
  });

  it('cerrado, el margen de siempre; abierto, cero', () => {
    assert.equal(margenInferiorConTeclado(48, TECLADO_CERRADO), 48);
    assert.equal(margenInferiorConTeclado(48, conTeclado({ visible: true, bordeSegunElAviso: 523 })), 0);
    assert.equal(margenInferiorConTeclado(0, TECLADO_CERRADO), 0);
  });

  it('así el chat queda igual de pegado al teclado que antes, ya sin depender del error', () => {
    const teclado = conTeclado({ visible: true, bordeSegunElAviso: 523, altoAsentado: 277 });
    const hueco = huecoDelMarco(VENTANA, teclado);
    assert.equal(VENTANA - hueco - margenInferiorConTeclado(48, teclado), 523);
  });

  it('el chat y los comentarios piden ese margen al gancho del teclado', () => {
    const chat = sinComentarios(fuente('screens/ChatScreen.tsx'));
    assert.match(chat, /const margenInferior = useMargenInferior\(\);/);
    assert.match(chat, /paddingBottom: spacing\.lg \+ margenInferior,/);
    assert.doesNotMatch(chat, /insets\.bottom/);
    const comentarios = sinComentarios(fuente('screens/CommentsScreen.tsx'));
    assert.match(comentarios, /paddingInferior=\{margenInferior\}/);
  });

  it('`AppScreen` y las historias sueltan el borde inferior mientras hay teclado', () => {
    const app = sinComentarios(fuente('components/AppScreen.tsx'));
    assert.match(app, /teclado && tecladoAbierto \? bordes\.filter\(\(borde\) => borde !== 'bottom'\) : bordes;/);
    assert.match(app, /edges=\{bordesAhora\}/);
    // La reserva para `useEspacioInferior` sigue saliendo de los bordes de siempre.
    assert.match(app, /bordes\.includes\('bottom'\) \? <ReservaDeZonaSegura>/);
    const historias = sinComentarios(fuente('screens/StoriesScreen.tsx'));
    assert.match(historias, /edges=\{tecladoAbierto \? BORDES_CON_TECLADO : BORDES_SIN_TECLADO\}/);
    assert.match(historias, /const BORDES_CON_TECLADO = \['top', 'right', 'left'\] as const;/);
  });

  it('en iPhone no cambia nada: allí el proveedor no dice que haya teclado', () => {
    const proveedor = sinComentarios(fuente('components/teclado.tsx'));
    assert.match(proveedor, /Platform\.OS === 'android' \? ProveedorEnAndroid : ProveedorSinTeclado/);
    assert.match(proveedor, /return margenInferiorConTeclado\(bottom, useContext\(Contexto\)\);/);
  });

  it('la sala del directo sigue con la zona segura por fuera del marco', () => {
    const sala = sinComentarios(fuente('screens/LiveScreen.tsx'));
    assert.match(sala, /<SafeAreaView style=\{estilos\.seguro\}>\s*<SinTecladoDelante style=\{estilos\.columna\}>/);
  });
});
