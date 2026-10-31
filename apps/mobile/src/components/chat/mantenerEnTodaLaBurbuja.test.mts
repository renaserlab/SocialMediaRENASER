import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { mantenerAccesible } from '../../lib/mantenerAccesible.ts';

/**
 * MANTENER PULSADA CUALQUIER PARTE DE UNA BURBUJA ABRE SU MENÚ.
 *
 * LO QUE SE REPORTÓ (31/10/2026): en el chat, mantener pulsado un AUDIO tenía
 * que abrir el menú del mensaje (responder, agregar a un tema, ponerle nombre,
 * borrar), pero solo respondía la franja de la hora, abajo. El resto de la
 * burbuja —el nombre del audio, su cuadrito, el relleno, el hueco entre el
 * reproductor y la hora— no hacía nada, y parecía que los audios no se podían
 * elegir. Lo mismo en un archivo (la línea de su nombre y el botón de
 * descargar, que además DESCARGABA al soltar tras mantenerlo), en el nombre de
 * un video y en el hueco entre las fotos de una burbuja con varias.
 *
 * LA CAUSA: en la burbuja no había nada pulsable que la cubriera entera. Solo
 * respondían las piezas que eran `Pressable` por su cuenta (el play, la ficha
 * del archivo, la foto) y el `Pressable` del texto y la hora. Lo demás eran
 * vistas sueltas que se quedaban con el dedo y no hacían nada con él.
 *
 * EL ARREGLO, con el patrón de la casa para no anidar botones en la web: una
 * capa pulsable DETRÁS de todo, del tamaño de la burbuja, y lo de encima que no
 * es un botón con `pointerEvents` para que el toque la atraviese. Los botones
 * de dentro conservan su toque (escuchar, abrir, descargar) y su propio
 * `onLongPress` abre el mismo menú.
 *
 * Se mira el CÓDIGO FUENTE, como el resto de pruebas de esta carpeta: no hay
 * renderizador de React Native en las pruebas.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..', '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
/** Sin comentarios: aquí se explica mucho el fallo, y por su nombre. */
const sinComentarios = (codigo: string) =>
  codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\s*\}/g, '').replace(/^\s*\/\/.*$/gm, '');

const CHAT = sinComentarios(fuente('screens/ChatScreen.tsx'));
const TEMA = sinComentarios(fuente('components/chat/BurbujaDeTema.tsx'));
const VOZ = sinComentarios(fuente('components/BurbujaDeNotaDeVoz.tsx'));
const ARCHIVO = sinComentarios(fuente('components/chat/ArchivoDeChat.tsx'));
const CABECERA = sinComentarios(fuente('components/chat/CabeceraDeAdjunto.tsx'));

/** La burbuja normal del chat: desde su `View` hasta el aviso de «no se envió». */
const BURBUJA = (() => {
  const inicio = CHAT.indexOf('styles.bubble,\n            mine ? styles.mine : styles.theirs,');
  const fin = CHAT.indexOf('{fallido ? (', inicio);
  assert.ok(inicio > 0 && fin > inicio, 'no se encuentra la burbuja normal de ChatScreen');
  return CHAT.slice(inicio, fin);
})();

/** Lo que pinta un adjunto en el chat. */
const ADJUNTO = (() => {
  const inicio = CHAT.indexOf('const pintarAdjunto = (');
  const fin = CHAT.indexOf('const mine = item.sender', inicio);
  assert.ok(inicio > 0 && fin > inicio, 'no se encuentra pintarAdjunto');
  return CHAT.slice(inicio, fin);
})();

/** La capa: un `Pressable` del tamaño de la burbuja, sin hijos. */
const CAPA_DEL_CHAT =
  /\{conAcciones \? \(\s*<Pressable\s+onLongPress=\{\(\) => abrirAcciones\(item\)\}\s+delayLongPress=\{400\}\s+style=\{StyleSheet\.absoluteFill\}\s+accessible=\{false\}\s+importantForAccessibility="no"\s+focusable=\{false\}\s*\/>\s*\) : null\}/;

describe('la burbuja del chat tiene una capa de mantener detrás de todo', () => {
  it('existe, cubre la burbuja, solo abre el menú y no lleva nada dentro', () => {
    assert.match(BURBUJA, CAPA_DEL_CHAT);
    const capa = BURBUJA.match(CAPA_DEL_CHAT)?.[0] ?? '';
    // Tocar el relleno sigue sin hacer nada: la capa no tiene `onPress`.
    assert.doesNotMatch(capa, /onPress=/);
    // Se cierra sola: un botón dentro de otro es HTML inválido en la web.
    assert.doesNotMatch(capa, /<\/Pressable>/);
  });

  it('va la PRIMERA dentro de la burbuja: lo demás queda encima y recibe antes el dedo', () => {
    const capa = BURBUJA.search(CAPA_DEL_CHAT);
    for (const pieza of [
      '{conAutor && !sinMarco ? (',
      '{item.respuestaA ? (',
      '{item.storyContext ? (',
      '{item.attachments?.length ? (',
      'onLongPress={\n              conAcciones ? () => abrirAcciones(item) : undefined\n            }',
      '{item.reacciones?.length ? (',
    ]) {
      const donde = BURBUJA.indexOf(pieza);
      assert.ok(donde > 0, `no se encuentra ${pieza}`);
      assert.ok(capa < donde, `la capa tiene que ir antes que ${pieza}`);
    }
  });

  it('solo existe donde el menú tiene algo que ofrecer (la misma regla que la franja de la hora)', () => {
    assert.match(
      CHAT,
      /const conAcciones = !item\.estado && \(mine \|\| funciones\.reacciones \|\| puedoBorrarAjenos\);/,
    );
    // La lápida de un mensaje borrado sale antes y no lleva capa.
    const lapida = CHAT.slice(CHAT.indexOf('if (item.eliminado) {'), CHAT.indexOf('if (item.sesion) {'));
    assert.doesNotMatch(lapida, /absoluteFill|onLongPress/);
  });

  it('lo que no es un botón deja pasar el dedo hasta la capa', () => {
    // El nombre de quien escribe, la historia a la que responde.
    assert.match(BURBUJA, /\{conAutor && !sinMarco \? \(\s*<View pointerEvents="none">\s*<Text/);
    assert.match(
      BURBUJA,
      /\{item\.storyContext \? \(\s*<View pointerEvents="none">\s*<RespuestaAHistoria contexto=\{item\.storyContext\} mio=\{mine\} \/>\s*<\/View>/,
    );
    // Los adjuntos y las reacciones: sus botones reciben el toque, sus huecos no.
    assert.match(BURBUJA, /<View\s+pointerEvents="box-none"\s+style=\{\[\s*styles\.adjuntos,/);
    assert.match(BURBUJA, /<View style=\{styles\.reacciones\} pointerEvents="box-none">/);
    // Un video con nombre: la cabecera y el hueco atraviesan.
    assert.match(
      ADJUNTO,
      /<View\s+key=\{adjunto\.id\}\s+pointerEvents="box-none"\s+style=\{\[styles\.videoConNombre/,
    );
  });

  it('la cita y las reacciones, que son botones, también abren el menú al mantenerlas', () => {
    const cita = BURBUJA.slice(BURBUJA.indexOf('{item.respuestaA ? ('), BURBUJA.indexOf('{item.storyContext ? ('));
    assert.match(cita, /onPress=\{\(\) => setMensajeBuscado\(item\.respuestaA\?\.id \?\? null\)\}/);
    assert.match(cita, /onLongPress=\{conAcciones \? \(\) => abrirAcciones\(item\) : undefined\}/);
    const reacciones = BURBUJA.slice(BURBUJA.indexOf('{item.reacciones?.length ? ('));
    // Tocar una reacción la pone o la quita; mantenerla ya no la cambia al soltar.
    assert.match(reacciones, /void reaccionar\(item, reaccion\.mia \? null : reaccion\.emoji\)/);
    assert.match(reacciones, /onLongPress=\{conAcciones \? \(\) => abrirAcciones\(item\) : undefined\}/);
  });

  it('la franja de la hora sigue abriendo el menú, como antes', () => {
    assert.match(
      BURBUJA,
      /<Pressable\s+onLongPress=\{\s*conAcciones \? \(\) => abrirAcciones\(item\) : undefined\s*\}\s+delayLongPress=\{400\}/,
    );
  });
});

describe('cada adjunto: mantener abre el menú y tocar hace lo de siempre', () => {
  it('el chat le pasa a cada tipo el mismo `alMantener`', () => {
    assert.match(ADJUNTO, /const alMantener = contexto\.conAcciones\s*\? \(\) => abrirAcciones\(contexto\.mensaje\)\s*: undefined;/);
    // Nota de voz y archivo de audio.
    assert.match(
      ADJUNTO,
      /<BurbujaDeNotaDeVoz[\s\S]*?alPulsar=\{\(\) => setAudioSonando\(adjunto\.id\)\}[\s\S]*?alMantener=\{alMantener\}\s+mantenerAbreElMenu\s*\/>/,
    );
    // Documento (o foto mandada como archivo).
    assert.match(
      ADJUNTO,
      /<ArchivoDeChat[\s\S]*?alVer=\{medio \? \(\) => setFotoAmpliada\(\{ \.\.\.adjunto, kind: medio \}\) : undefined\}\s+alMantener=\{alMantener\}\s+mantenerAbreElMenu/,
    );
    // Foto y video, también los de una burbuja con varios.
    assert.match(ADJUNTO, /if \(adjunto\.url\) setFotoAmpliada\(adjunto\);\s*\}\}\s+onLongPress=\{alMantener\}\s+delayLongPress=\{400\}/);
  });

  it('nota de voz: un solo botón (play, onda y duración) con los dos gestos', () => {
    const caratula = VOZ.slice(VOZ.indexOf('function Caratula('));
    assert.match(caratula, /<Pressable\s+onPress=\{alPulsar\}\s+onLongPress=\{alMantener\}\s+delayLongPress=\{400\}/);
    assert.equal((caratula.match(/<Pressable\b/g) ?? []).length, 1);
    // La onda no se queda con el dedo: es del botón.
    assert.match(caratula, /<View style=\{styles\.onda\} pointerEvents="none">/);
  });

  it('nota de voz o audio CON NOMBRE: la tarjeta y su cabecera dejan pasar el dedo', () => {
    assert.match(VOZ, /<View style=\{styles\.tarjeta\} pointerEvents="box-none">/);
    assert.match(CABECERA, /<View style=\{\[styles\.fila, style\]\} pointerEvents="none">/);
    // Y la cabecera sigue sin ser un botón.
    assert.doesNotMatch(CABECERA, /Pressable|Pulsable|onPress|onLongPress/);
  });

  it('documento: los dos botones abren el menú al mantenerlos y descargan o abren al tocarlos', () => {
    // La ficha (sin nombre) y la cabecera (con nombre): abrir o descargar.
    const fichas = ARCHIVO.match(
      /onPress=\{alVer \?\? \(\(\) => void descargar\(\)\)\}\s+onLongPress=\{alMantener\}\s+delayLongPress=\{400\}/g,
    );
    assert.equal(fichas?.length, 2, 'la ficha sin nombre y la cabecera con nombre');
    // Los dos botones de descargar: antes, mantenerlos DESCARGABA al soltar.
    const descargas = ARCHIVO.match(
      /onPress=\{\(\) => void descargar\(\)\}\s+onLongPress=\{alMantener\}\s+delayLongPress=\{400\}/g,
    );
    assert.equal(descargas?.length, 2, 'el botón de la fila y el de la tarjeta');
  });

  it('documento: lo que no es un botón deja pasar el dedo', () => {
    assert.match(ARCHIVO, /<View style=\{\[styles\.tarjeta, style\]\} pointerEvents="box-none">/);
    assert.match(ARCHIVO, /<View style=\{\[styles\.fila, style\]\} pointerEvents="box-none">/);
    assert.match(ARCHIVO, /<View style=\{\[styles\.raya, \{ backgroundColor: colorTexto \}\]\} pointerEvents="none" \/>/);
    assert.match(ARCHIVO, /<View style=\{styles\.lineaFina\} pointerEvents="box-none">/);
    assert.match(ARCHIVO, /<View style=\{styles\.detalleFino\} pointerEvents="none">\s*<Text/);
  });
});

describe('en un tema, igual que en el chat', () => {
  it('la burbuja del tema lleva la misma capa, primera y sin hijos', () => {
    const capa =
      /\{mantener && !mensaje\.eliminado \? \(\s*<Pressable\s+onLongPress=\{mantener\}\s+delayLongPress=\{400\}\s+style=\{StyleSheet\.absoluteFill\}\s+accessible=\{false\}\s+importantForAccessibility="no"\s+focusable=\{false\}\s*\/>\s*\) : null\}/;
    assert.match(TEMA, capa);
    const donde = TEMA.search(capa);
    for (const pieza of ['{conAutor ? (', '{mensaje.attachments?.length ? (', '{mensaje.reacciones?.length ? (']) {
      assert.ok(donde < TEMA.indexOf(pieza), `la capa va antes que ${pieza}`);
    }
    assert.match(TEMA, /<View style=\{styles\.adjuntos\} pointerEvents="box-none">/);
    assert.match(TEMA, /<View style=\{styles\.reacciones\} pointerEvents="box-none">/);
    assert.match(TEMA, /alMantener=\{mantener\}\s+mantenerAbreElMenu/);
  });
});

describe('quien usa lector de pantalla también puede abrir el menú', () => {
  it('sin `alMantener` no se declara ninguna acción', () => {
    assert.deepEqual(mantenerAccesible(undefined, { pista: 'p', etiqueta: 'e' }), {});
  });

  it('con `alMantener` se declara `longpress` con su etiqueta, y solo esa acción lo llama', () => {
    let llamadas = 0;
    const props = mantenerAccesible(() => (llamadas += 1), { pista: 'Mantén…', etiqueta: 'Ver acciones' });
    assert.equal(props.accessibilityHint, 'Mantén…');
    assert.deepEqual(props.accessibilityActions, [{ name: 'longpress', label: 'Ver acciones' }]);
    const evento = (actionName: string) => ({ nativeEvent: { actionName } }) as never;
    props.onAccessibilityAction?.(evento('activate'));
    assert.equal(llamadas, 0, 'el toque normal del lector no abre el menú');
    props.onAccessibilityAction?.(evento('longpress'));
    assert.equal(llamadas, 1);
  });

  it('sin pista no se añade: la franja de la hora ya la lleva en su etiqueta', () => {
    const props = mantenerAccesible(() => {}, { etiqueta: 'Ver acciones' });
    assert.equal('accessibilityHint' in props, false);
  });

  it('la capa no es un elemento para el lector; las piezas sí declaran la acción', () => {
    assert.match(BURBUJA, /accessible=\{false\}\s+importantForAccessibility="no"/);
    for (const [nombre, codigo] of [
      ['la nota de voz', VOZ],
      ['el archivo', ARCHIVO],
      ['la foto o el video', ADJUNTO],
      ['el tema', TEMA],
    ] as const) {
      assert.match(codigo, /mantenerAccesible\(/, `${nombre} tiene que declarar la acción`);
    }
    // En Contenido mantener es ELEGIR: allí no se anuncia «acciones del mensaje».
    assert.match(VOZ, /mantenerAccesible\(mantenerAbreElMenu \? alMantener : undefined,/);
    assert.match(ARCHIVO, /mantenerAccesible\(mantenerAbreElMenu \? alMantener : undefined,/);
    assert.doesNotMatch(sinComentarios(fuente('components/chat/PestanasDeContenido.tsx')), /mantenerAbreElMenu/);
  });
});
