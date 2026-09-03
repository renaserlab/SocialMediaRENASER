import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CONFIRMAR LA FOTO ES UNA PANTALLA, NO UNA CAPA.
 *
 * EL FALLO QUE ESTO IMPIDE. La confirmacion se montaba como PRIMER hermano
 * dentro del `<View>` del perfil y se estiraba con `absoluteFillObject`. En
 * React Native, entre hermanos sin `zIndex` gana el que se pinta DESPUES: la
 * cabecera y el contenido del perfil quedaban por delante de una pantalla que
 * se suponia exclusiva y se quedaban los toques. Subir un `zIndex` lo tapa un
 * rato; lo que lo cierra es no montar el perfil.
 *
 * De ahi que aqui se exija una DEVOLUCION TEMPRANA, y que esa devolucion vaya
 * despues de todos los hooks: sacarla arriba cambiaria el numero de hooks entre
 * renders, que es exactamente el error que React no perdona.
 *
 * Se mira el CODIGO FUENTE, como el resto de pruebas de esta carpeta: montar la
 * vista pediria un renderizador de React Native que este proyecto no tiene.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

function sinComentarios(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const PERFIL_CRUDO = fuente('screens/ProfileScreen.tsx');
const CONFIRMAR_CRUDO = fuente('components/ConfirmarRecorte.tsx');
const PERFIL = sinComentarios(PERFIL_CRUDO);
const CONFIRMAR = sinComentarios(CONFIRMAR_CRUDO);

/** El cuerpo de `ProfileScreen`, sin los componentes auxiliares del final. */
const CUERPO = (() => {
  const inicio = PERFIL.indexOf('export function ProfileScreen()');
  const fin = PERFIL.indexOf('\nfunction EsqueletoDePerfil', inicio);
  assert.ok(inicio >= 0 && fin > inicio, 'no se encuentra el cuerpo de ProfileScreen');
  return PERFIL.slice(inicio, fin);
})();

const GUARDA = 'if (porConfirmar) {';

// ---------------------------------------------------------------------------
// 1. Exclusividad: durante la confirmacion no hay perfil debajo
// ---------------------------------------------------------------------------

test('la confirmacion se DEVUELVE, no se apila sobre el perfil', () => {
  const guarda = CUERPO.indexOf(GUARDA);
  assert.ok(guarda > 0, 'no hay devolucion temprana para `porConfirmar`');

  const bloque = CUERPO.slice(guarda, CUERPO.indexOf('\n  }', guarda));
  assert.match(bloque, /return \(\s*<ConfirmarRecorte/, 'la guarda no devuelve la confirmacion');
});

test('mientras se confirma NO se monta la cabecera ni el contenido del perfil', () => {
  const guarda = CUERPO.indexOf(GUARDA);
  const bloque = CUERPO.slice(guarda, CUERPO.indexOf('\n  }', guarda));
  for (const ajeno of ['AppHeader', 'AppScreen', 'ProfileGallery', 'BottomSheet']) {
    assert.doesNotMatch(bloque, new RegExp(ajeno), `la confirmacion sigue montando ${ajeno}`);
  }
});

test('la confirmacion ya no es un hermano del perfil', () => {
  // Un `{porConfirmar ? <ConfirmarRecorte/> : null}` dentro del JSX del perfil
  // es justo el apilado que producia el fallo.
  assert.doesNotMatch(PERFIL, /\{porConfirmar \?/);
  assert.equal(
    (PERFIL.match(/<ConfirmarRecorte/g) ?? []).length,
    1,
    'la confirmacion se pinta desde mas de un sitio',
  );
  // Y se pinta ANTES que la cabecera del perfil, que es la devolucion normal.
  assert.ok(
    CUERPO.indexOf('<ConfirmarRecorte') < CUERPO.indexOf('<AppHeader'),
    'la confirmacion se devuelve despues de la pantalla normal',
  );
});

test('la confirmacion es la raiz de la pantalla, no una capa estirada', () => {
  assert.match(CONFIRMAR, /raiz: \{ flex: 1,/);
  assert.doesNotMatch(
    CONFIRMAR,
    /raiz: \{ \.\.\.StyleSheet\.absoluteFillObject/,
    'la raiz vuelve a depender del orden de pintado de sus hermanos',
  );
});

// ---------------------------------------------------------------------------
// 2. Las reglas de los hooks siguen intactas
// ---------------------------------------------------------------------------

test('la devolucion temprana va DESPUES de todos los hooks', () => {
  const guarda = CUERPO.indexOf(GUARDA);
  const despues = CUERPO.slice(guarda);
  const colados = [...despues.matchAll(/\buse[A-Z]\w*\(/g)].map((m) => m[0]);
  assert.deepEqual(
    colados,
    [],
    `hay hooks despues de la devolucion temprana (${colados.join(', ')}): el ` +
      'numero de hooks cambiaria entre renders.',
  );
});

test('las otras devoluciones tempranas siguen detras de la de la confirmacion', () => {
  // Si el perfil pudiera devolver su esqueleto antes, la confirmacion no seria
  // exclusiva: dependeria de que el perfil hubiera terminado de cargar.
  const guarda = CUERPO.indexOf(GUARDA);
  assert.ok(guarda > 0);
  assert.ok(
    guarda < CUERPO.indexOf('if (!id && supabaseEnabled && !currentUser)'),
    'la confirmacion se decide despues del estado de carga del perfil',
  );
});

// ---------------------------------------------------------------------------
// 3. Zonas seguras, ida y vuelta
// ---------------------------------------------------------------------------

test('la pantalla completa respeta las zonas seguras', () => {
  assert.match(CONFIRMAR, /useSafeAreaInsets/);
  assert.match(CONFIRMAR, /insets\.top/);
  assert.match(CONFIRMAR, /insets\.bottom/);
  // El marco tampoco puede quedar debajo de la cabecera o del pie flotantes.
  assert.match(CONFIRMAR, /paddingTop: huecoArriba, paddingBottom: huecoAbajo/);
});

test('el hueco del marco se MIDE, no se supone', () => {
  /*
    Cabecera y pie flotan sobre la foto y crecen con el tamano de letra del
    sistema. Con las alturas fijas que habia, la letra grande de accesibilidad
    subia el boton de guardar por encima del marco y tapaba justo lo que hay
    que mirar antes de decidir. Las constantes solo valen para el primer
    fotograma, hasta que hay medida.
  */
  assert.match(CONFIRMAR, /const \[altoCabecera, setAltoCabecera\] = useState<number \| null>\(null\)/);
  assert.match(CONFIRMAR, /const \[altoPie, setAltoPie\] = useState<number \| null>\(null\)/);
  assert.match(CONFIRMAR, /huecoArriba = altoCabecera \?\? insets\.top \+ ALTO_CABECERA_MINIMO/);
  assert.match(CONFIRMAR, /huecoAbajo = altoPie \?\? insets\.bottom \+ ALTO_PIE_MINIMO/);
  // Dos `onLayout`, uno por bloque flotante.
  assert.equal((CONFIRMAR.match(/onLayout=\{\(evento\)/g) ?? []).length, 2);
  // Y no se reescribe el estado con el mismo valor: seria un bucle de medidas.
  assert.equal(
    (CONFIRMAR.match(/\(previo\) => \(previo === alto \? previo : alto\)/g) ?? []).length,
    2,
  );
  // El degradado de contraste cubre lo que ocupen los controles, no 160 fijos.
  assert.match(CONFIRMAR, /alto=\{Math\.max\(160, huecoArriba \+ 40\)\}/);
  assert.match(CONFIRMAR, /alto=\{Math\.max\(240, huecoAbajo \+ 40\)\}/);
});

test('cancelar devuelve al selector de foto, no al perfil a secas', () => {
  const guarda = CUERPO.indexOf(GUARDA);
  const bloque = CUERPO.slice(guarda, CUERPO.indexOf('\n  }', guarda));
  assert.match(bloque, /setPorConfirmar\(null\)/);
  assert.match(bloque, /setEditingPhoto\(porConfirmar\.kind\)/);
});

test('el boton fisico Atras cancela en vez de salir del perfil', () => {
  assert.match(CONFIRMAR, /BackHandler\.addEventListener\('hardwareBackPress'/);
  assert.match(CONFIRMAR, /if \(!ocupado\) alCancelar\(\);/);
});

// ---------------------------------------------------------------------------
// 4. Guardar sube UNA vez
// ---------------------------------------------------------------------------

test('el cerrojo de la subida es sincrono, no el estado', () => {
  // `subiendoFoto` no esta puesto hasta el siguiente render: dos toques rapidos
  // caben de sobra en ese hueco y subirian la foto dos veces.
  assert.match(PERFIL, /if \(subiendoRef\.current \|\| !porConfirmar\) return;/);
  const confirmar = PERFIL.slice(PERFIL.indexOf('const confirmarFoto'));
  const cerrojo = confirmar.indexOf('subiendoRef.current = true');
  const subida = confirmar.indexOf('setProfileImage(');
  assert.ok(cerrojo > 0 && subida > cerrojo, 'se sube antes de cerrar el paso');
});

test('el cerrojo se suelta pase lo que pase', () => {
  assert.match(PERFIL, /finally \{[\s\S]{0,120}subiendoRef\.current = false/);
});

test('mientras sube, ningun control de la confirmacion acepta pulsaciones', () => {
  const ocupados = (CONFIRMAR.match(/disabled=\{ocupado\}/g) ?? []).length;
  const pulsables = (CONFIRMAR.match(/<Pressable/g) ?? []).length;
  assert.ok(
    ocupados >= pulsables + 1,
    'hay controles que siguen vivos durante la subida (los Pressables y el boton ' +
      'de guardar tienen que apagarse todos)',
  );
  assert.match(CONFIRMAR, /accessibilityState=\{\{ disabled: ocupado \}\}/);
  assert.match(CONFIRMAR, /loading=\{ocupado\}/);
});

// ---------------------------------------------------------------------------
// 5. La vista previa no miente
// ---------------------------------------------------------------------------

test('el avatar se ve 1:1 y la portada 16:9, con cover', () => {
  assert.match(CONFIRMAR, /avatar: 1,/);
  assert.match(CONFIRMAR, /portada: 16 \/ 9,/);
  assert.match(CONFIRMAR, /aspectRatio: PROPORCION\[forma\]/);
  assert.match(CONFIRMAR, /contentFit="cover"/);
});

// ---------------------------------------------------------------------------
// 6. Ningun comentario se apunta un merito imposible
// ---------------------------------------------------------------------------

/** Verbos de «esto lo hemos arreglado nosotros». */
const ARREGLO = /(arregl|corrig|corregi|tematiz|recolore|reestiliz|modific|cambi|mejor)\w*/i;
/** Lo que dibuja el sistema operativo y NO se puede tocar desde la aplicacion. */
const RECORTADOR =
  /(recortador|editor)\s+(nativo|del sistema)|controles\s+(nativos|del sistema)|image-?picker/i;
/** Marcas de que la frase NIEGA. Es la unica forma admisible de nombrarlo. */
const NIEGA = /\b(no|ni|nunca|sin|ningun|ninguna|imposible|falsa|falso|tal cual)\b/i;

function frasesComentadas(texto: string): string[] {
  const bloques = [...texto.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)].map((m) => m[0]);
  return bloques
    .join('\n')
    .split(/[.;\n]/)
    .map((frase) => frase.replace(/^[\s*/]+/, '').trim())
    .filter(Boolean);
}

test('ningun comentario afirma haber cambiado el recortador del sistema', () => {
  // El editor de recorte lo dibuja iOS o Android: sus iconos y su tijera no se
  // pueden tematizar desde aqui. Prometerlo en un comentario es mentir en el
  // sitio donde otro lo va a creer.
  for (const [ruta, texto] of [
    ['ProfileScreen.tsx', PERFIL_CRUDO],
    ['ConfirmarRecorte.tsx', CONFIRMAR_CRUDO],
  ] as const) {
    for (const frase of frasesComentadas(texto)) {
      if (!RECORTADOR.test(frase)) continue;
      if (!ARREGLO.test(frase)) continue;
      assert.ok(
        NIEGA.test(frase),
        `${ruta} se atribuye un cambio en el recortador nativo: «${frase}»`,
      );
    }
  }
});

test('sigue escrito que el recorte es del sistema y que no se toco', () => {
  assert.match(CONFIRMAR_CRUDO, /NO ES NUESTRA|editor del SISTEMA OPERATIVO/);
  assert.match(CONFIRMAR_CRUDO, /no se pueden tematizar|NO se han tocado/);
});
