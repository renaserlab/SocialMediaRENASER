import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ALTO_SELECTOR, alturasDeCamara } from '../../lib/controlesDeCamara.ts';
import { ORDEN_SECCIONES, traeSuPropiaBarra } from '../../navigation/secciones.ts';

/**
 * LA BARRA DE CREAR, COMO SE PIDIÓ EL 07/10/2026 («Cambio de vista Z»).
 *
 * Con sus palabras: «cuando el usuario pulse en crear, que las opciones de
 * publicación – Historia – Reel – vivo estén en una barra inferior similar a la
 * barra de navegación (la barra no debe ser la misma puesto que el usuario se
 * puede confundir, lo ideal es que sea similar, pero más ancha […] siempre
 * cuidando de que no se sobreponga información) (las letras de color negro y el
 * fondo blanco y viceversa si estamos en modo oscuro) […] Solo en esta vista
 * que desaparezca la barra de navegación». Y de la segunda captura: «se tiene
 * texto, información que no se logra distinguir».
 *
 * Lo que tiene reglas se EJECUTA. Lo que es de pantalla se comprueba sobre el
 * código; cómo queda en un teléfono solo se ve en un teléfono.
 */

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const APP = join(SRC, '..', 'app');
const leer = (ruta: string) => readFileSync(ruta, 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (codigo: string) =>
  codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const fuente = (rel: string) => sinComentarios(leer(join(SRC, rel)));

const LAYOUT = sinComentarios(leer(join(APP, '(tabs)', '_layout.tsx')));
const CREAR = fuente('screens/CrearScreen.tsx');
const BARRA = fuente('components/crear/SelectorDeModo.tsx');
const SECCIONES = fuente('components/FloatingGlassTabBar.tsx');
const HUECO = fuente('components/espacioInferior.tsx');
const CAPTURA = fuente('components/crear/PasoDeCaptura.tsx');
const CAMARA = fuente('screens/StoryCaptureScreen.tsx');
const CARRETE = fuente('screens/StoryGalleryScreen.tsx');
const VIVO = fuente('components/crear/ModoVivo.tsx');

const veces = (codigo: string, patron: RegExp) => [...codigo.matchAll(patron)].length;

describe('la barra de secciones se retira en Crear, y solo en Crear', () => {
  it('de las cinco secciones, solo Crear trae su propia barra', () => {
    assert.deepEqual(ORDEN_SECCIONES.filter(traeSuPropiaBarra), ['create']);
  });

  it('un destino que no es sección (el perfil de otra persona) conserva la barra', () => {
    assert.equal(traeSuPropiaBarra('profile/[id]'), false);
    assert.equal(traeSuPropiaBarra(undefined), false);
  });

  it('el layout no pinta la cápsula en esa sección', () => {
    assert.match(
      LAYOUT,
      /traeSuPropiaBarra\(props\.state\.routes\[props\.state\.index\]\?\.name\) && !haceFaltaCuenta \? null : \(\s*<FloatingGlassTabBar/,
    );
  });

  it('sin cuenta la cápsula se queda: Crear enseña la invitación, no su barra', () => {
    /*
      Las dos partes se hacen la MISMA pregunta. Si cada una tuviera la suya,
      bastaría un cambio en una para que se quitara una barra sin aparecer la
      otra, y en un iPhone —sin botón de atrás— no habría por dónde salir.
    */
    assert.match(LAYOUT, /const haceFaltaCuenta = useHaceFaltaCuenta\(\);/);
    assert.match(CREAR, /const haceFaltaCuenta = useHaceFaltaCuenta\(\);/);
    assert.match(CREAR, /if \(haceFaltaCuenta\) \{/);
  });

  it('lo de dentro de Crear deja libre el margen, no el hueco de una barra que ya no está', () => {
    assert.match(CREAR, /<SinBarraDeSecciones>/);
    assert.match(
      HUECO,
      /export function SinBarraDeSecciones[\s\S]*?<EspacioDeLaBarra\.Provider value=\{margenDeBarraFlotante\(insets\.bottom\)\}>/,
    );
  });
});

describe('la barra de tipos de publicación ocupa el sitio de la de secciones', () => {
  it('las dos flotan a la misma distancia del borde', () => {
    // La de secciones, en su propio estilo; la de Crear, por lo que le publica
    // `SinBarraDeSecciones`. Una sola función para las dos.
    assert.match(SECCIONES, /bottom: margenDeBarraFlotante\(insets\.bottom\),/);
    assert.match(HUECO, /value=\{margenDeBarraFlotante\(insets\.bottom\)\}/);
  });

  it('en la cámara es la capa de más abajo', () => {
    assert.match(CAMARA, /const alturas = alturasDeCamara\(espacioInferior\);/);
    assert.match(CAMARA, /<View style=\{\[styles\.pie, \{ bottom: alturas\.selector \}\]\}/);
    assert.equal(alturasDeCamara(16).selector, 16);
  });

  it('mientras se resuelve el permiso está a la misma altura que en la cámara', () => {
    assert.match(CAPTURA, /bottom: alturasDeCamara\(espacioInferior\)\.selector/);
  });

  it('en el carrete, en el aviso de permiso y en la web también cae en el margen', () => {
    assert.equal(veces(CARRETE, /<View style=\{\[styles\.pie, \{ bottom: espacioInferior \}\]\}/g), 2);
    assert.equal(veces(CAPTURA, /styles\.pieWeb, \{ paddingBottom: espacioInferior \}/g), 2);
  });

  it('en Vivo no lleva aire de más por debajo: no salta al cambiar de modo', () => {
    assert.equal(veces(VIVO, /paddingBottom: espacioInferior/g), 3);
    assert.doesNotMatch(VIVO, /styles\.pie\b/);
    // Suelta en su línea, sin envoltorio que le añada relleno, en los tres estados.
    assert.equal(veces(VIVO, /^\s*\{pie\}\s*$/gm), 3);
  });

  it('en el carrete sigue ahí mientras carga y cuando falta el permiso', () => {
    // Sin la de secciones debajo, el borde de abajo se quedaba vacío un momento
    // y la barra reaparecía después.
    assert.match(CARRETE, /const barraSola = pie \? \(/);
    assert.equal(veces(CARRETE, /^\s*\{barraSola\}\s*$/gm), 2);
  });

  it('las últimas fotos del carrete no se quedan debajo de la barra', () => {
    assert.match(CARRETE, /\(pie \? ALTO_SELECTOR : 0\)/);
    assert.match(CARRETE, /contentContainerStyle=\{\{ paddingBottom: finDeLaCuadricula \}\}/);
  });
});

describe('parecida a la de secciones, pero no la misma', () => {
  it('es más alta', () => {
    const alto = Number(/const BAR_HEIGHT = (\d+);/.exec(SECCIONES)?.[1]);
    assert.ok(alto > 0, 'no se encuentra el alto de la barra de secciones');
    assert.ok(ALTO_SELECTOR > alto, `mide ${ALTO_SELECTOR} y la de secciones ${alto}`);
    assert.match(BARRA, /height: ALTO_SELECTOR,/);
  });

  it('llega más cerca de los bordes', () => {
    assert.match(BARRA, /host: \{[^}]*paddingHorizontal: spacing\.sm,/);
    assert.match(SECCIONES, /host: \{[^}]*paddingHorizontal: spacing\.lg,/);
  });

  it('marca la opción activa con la misma cápsula animada, no con una copia', () => {
    assert.match(BARRA, /<PildoraActiva activa=\{seleccionado\}/);
    assert.match(SECCIONES, /<PildoraActiva activa=\{focused\}/);
  });

  it('enseña los cuatro tipos a la vez, sin fila que se desliza ni recorta', () => {
    assert.doesNotMatch(BARRA, /react-native-reanimated/);
    assert.doesNotMatch(BARRA, /translateX/);
    assert.match(BARRA, /MODOS\.map\(/);
  });
});

describe('se lee con cualquier cosa detrás', () => {
  it('lleva fondo propio y sigue el tema: claro con letra oscura, y al revés', () => {
    assert.match(BARRA, /const \{ colors \} = useAppTheme\(\);/);
    // Opaca: con el vidrio translúcido de la de secciones, el blanco se volvía
    // gris sobre un fondo oscuro.
    assert.match(BARRA, /backgroundColor: colors\.surface,/);
    assert.doesNotMatch(BARRA, /glassSurface/);
    assert.match(BARRA, /<Rotulo texto=\{etiqueta\} color=\{colors\.text\} \/>/);
    // Ya no son letras sueltas sobre la imagen con un velo detrás.
    assert.doesNotMatch(BARRA, /ScrimDeMedio|SOMBRA_DE_TEXTO|palette\('dark'\)/);
  });

  it('la opción elegida va en negativo, y su nombre aparece con la cápsula', () => {
    assert.match(
      BARRA,
      /<PildoraActiva activa=\{seleccionado\} color=\{colors\.primary\}[^>]*>\s*<Rotulo texto=\{etiqueta\} color=\{colors\.onPrimary\} \/>/,
    );
  });

  it('no se ve mientras Crear no es la sección que se está mirando', () => {
    // Al llegar arrastrando desde la sección de al lado la de secciones sigue
    // puesta: sin esto se verían las dos, una asomando por detrás de la otra.
    assert.match(CREAR, /<SelectorDeModo activo=\{modo\} alCambiar=\{irA\} visible=\{enfocada\} \/>/);
    assert.match(BARRA, /visible \? null : styles\.oculta/);
    assert.match(BARRA, /pointerEvents=\{visible \? 'box-none' : 'none'\}/);
  });

  it('la pista de la cámara va sobre una superficie, con letra clara y márgenes', () => {
    assert.match(
      CAMARA,
      /<SuperficieSobreMedio forma="pildora"[^>]*>\s*<Text[^>]*color=\{media\.text\}[^>]*numberOfLines=\{2\}[^>]*>\s*\{t\(soloVideo \? 'camera\.hintVideo' : 'camera\.hint'\)\}/,
    );
    // Antes: gris, sin fondo y sin tope de ancho, así que se salía por los lados.
    assert.doesNotMatch(CAMARA, /color=\{media\.textMuted\}[^<]*>\s*\{t\((?:soloVideo \? 'camera\.hintVideo' : )?'camera\.hint'\)\}/);
    assert.match(CAMARA, /hint: \{[^}]*left: spacing\.lg,\s*right: spacing\.lg,\s*height: ALTO_PISTA,/);
  });

  it('el enlace que va encima de las fotos del carrete tiene fondo', () => {
    assert.match(CARRETE, /alternativa: \{[^}]*backgroundColor: media\.overlay,/);
  });
});

describe('sin barra de secciones, cada paso de Crear tiene por dónde salir', () => {
  it('Crear le da la salida a los cuatro modos', () => {
    assert.equal(veces(CREAR, /alSalir=\{salir\}/g), 4);
  });

  it('la cámara y el carrete ya traían su X', () => {
    assert.match(CAMARA, /<Pressable onPress=\{onClose\}/);
    assert.match(CARRETE, /<Pressable onPress=\{onClose\}/);
  });

  it('los pasos sin cámara —web, permiso denegado, permiso pendiente— la tienen', () => {
    assert.equal(veces(CAPTURA, /<SalirDeCrear alSalir=\{alCerrar\} \/>/g), 3);
  });

  it('el modo Vivo la tiene en sus tres estados', () => {
    assert.equal(veces(VIVO, /<SalirDeCrear alSalir=\{alSalir\} \/>/g), 3);
  });

  it('arrastrar de lado sigue cambiando de tipo de publicación, no de sección', () => {
    assert.match(CREAR, /pan = pan\.blocksExternalGesture\(gestoDeSeccion\)/);
    assert.match(CREAR, /runOnJS\(cambiarPorGesto\)\(evento\.translationX < 0 \? 1 : -1\)/);
  });
});
