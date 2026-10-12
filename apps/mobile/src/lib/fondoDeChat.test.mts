import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  CLAVE_DEL_FONDO_COMUN,
  CLAVE_DE_FONDOS,
  COLORES_DE_FONDO,
  FONDO_POR_DEFECTO,
  colorDeFondo,
  conFondo,
  escribirFondos,
  fondoDe,
  leerFondo,
  leerFondos,
  mismoFondo,
  veloSobreLaFoto,
} from './fondoDeChat.ts';

/*
  El fondo del chat (11/10/2026). Lo esencial: es del teléfono y no viaja a
  ningún sitio, lo que no se entiende se queda en «por defecto» y ningún fondo
  deja el chat sin poder leerse.

  Desde el 12/10/2026 es DE CADA CHAT. Nació como uno solo para todos, y
  cambiar el fondo de un grupo cambiaba el de todas las conversaciones.
*/

const leer = (ruta: string) =>
  readFileSync(new URL(ruta, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** Luminancia relativa (WCAG) de un color `#RRGGBB`. */
function luminancia(hex: string): number {
  const canal = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * canal(0) + 0.7152 * canal(1) + 0.0722 * canal(2);
}

const contraste = (a: string, b: string) => {
  const [claro, oscuro] = [luminancia(a), luminancia(b)].sort((x, y) => y - x) as [number, number];
  return (claro + 0.05) / (oscuro + 0.05);
};

test('lo guardado se lee sin fiarse de nada', () => {
  assert.deepEqual(leerFondo(JSON.stringify({ tipo: 'color', id: 'menta' })), { tipo: 'color', id: 'menta' });
  assert.deepEqual(leerFondo(JSON.stringify({ tipo: 'foto', uri: 'file:///f.jpg' })), {
    tipo: 'foto',
    uri: 'file:///f.jpg',
  });
  assert.deepEqual(leerFondo(JSON.stringify(FONDO_POR_DEFECTO)), FONDO_POR_DEFECTO);
  // Lo que no se entiende es «por defecto»: el chat nunca se queda en blanco.
  for (const raro of [
    null,
    undefined,
    '',
    'no es json',
    '[]',
    '7',
    '{"tipo":"color","id":"un-color-que-ya-no-existe"}',
    '{"tipo":"color"}',
    '{"tipo":"foto","uri":"   "}',
    '{"tipo":"video","uri":"x"}',
    { tipo: 'foto', uri: 7 },
  ]) {
    assert.deepEqual(leerFondo(raro), FONDO_POR_DEFECTO, JSON.stringify(raro));
  }
});

const GRUPO = 'aaaaaaaa-0000-4000-8000-000000000003';
const OTRO = 'bbbbbbbb-0000-4000-8000-000000000004';

test('cambiar el fondo de un chat no toca el de ningún otro', () => {
  // Lo que se reportó el 12/10: se le puso una foto a un grupo y salió
  // detrás de todas las conversaciones.
  const conFoto = conFondo({}, GRUPO, { tipo: 'foto', uri: 'file:///equipo.jpg' });
  assert.deepEqual(fondoDe(conFoto, GRUPO), { tipo: 'foto', uri: 'file:///equipo.jpg' });
  assert.deepEqual(fondoDe(conFoto, OTRO), FONDO_POR_DEFECTO);

  // Cada chat con el suyo, y cambiar uno deja el otro como estaba.
  const losDos = conFondo(conFoto, OTRO, { tipo: 'color', id: 'menta' });
  assert.deepEqual(fondoDe(losDos, GRUPO), { tipo: 'foto', uri: 'file:///equipo.jpg' });
  assert.deepEqual(fondoDe(losDos, OTRO), { tipo: 'color', id: 'menta' });
  const cambiado = conFondo(losDos, GRUPO, { tipo: 'color', id: 'rosa' });
  assert.deepEqual(fondoDe(cambiado, GRUPO), { tipo: 'color', id: 'rosa' });
  assert.deepEqual(fondoDe(cambiado, OTRO), { tipo: 'color', id: 'menta' });

  // No se cambia la lista que se recibió: es el estado que hay en pantalla.
  assert.deepEqual(conFoto, { [GRUPO]: { tipo: 'foto', uri: 'file:///equipo.jpg' } });

  // Volver al de siempre quita ese chat de la lista, y solo ese.
  const sinGrupo = conFondo(cambiado, GRUPO, FONDO_POR_DEFECTO);
  assert.deepEqual(sinGrupo, { [OTRO]: { tipo: 'color', id: 'menta' } });
  assert.deepEqual(fondoDe(sinGrupo, GRUPO), FONDO_POR_DEFECTO);

  // Sin conversación no se guarda nada, y un identificador raro no saca
  // nada heredado del objeto.
  assert.deepEqual(conFondo(losDos, '', { tipo: 'color', id: 'rosa' }), losDos);
  for (const raro of ['', 'constructor', 'toString', '__proto__']) {
    assert.deepEqual(fondoDe(losDos, raro), FONDO_POR_DEFECTO, raro);
  }
});

test('la lista de fondos se guarda y se lee entera, sin fiarse de nada', () => {
  const fondos = {
    [GRUPO]: { tipo: 'foto', uri: 'file:///equipo.jpg' },
    [OTRO]: { tipo: 'color', id: 'menta' },
  } as const;
  assert.deepEqual(leerFondos(escribirFondos(fondos)), fondos);

  // Lo que no es un fondo de verdad no entra: ese chat se ve como siempre.
  assert.deepEqual(
    leerFondos(
      JSON.stringify({
        [GRUPO]: { tipo: 'color', id: 'un-color-que-ya-no-existe' },
        [OTRO]: { tipo: 'color', id: 'menta' },
        '  ': { tipo: 'color', id: 'rosa' },
        tercero: { tipo: 'defecto' },
        cuarto: 7,
      }),
    ),
    { [OTRO]: { tipo: 'color', id: 'menta' } },
  );

  // Un guardado estropeado entero es «ningún chat tiene fondo».
  for (const raro of [null, undefined, '', 'no es json', '[]', '7', '"texto"', 7, []]) {
    assert.deepEqual(leerFondos(raro), {}, JSON.stringify(raro));
  }

  // El fondo de cuando era uno solo NO se lee como lista: se queda en nada.
  assert.deepEqual(leerFondos(JSON.stringify({ tipo: 'foto', uri: 'file:///viejo.jpg' })), {});
  assert.notEqual(CLAVE_DE_FONDOS, CLAVE_DEL_FONDO_COMUN);
});

test('cada color tiene su tono para el tema claro y para el oscuro', () => {
  assert.ok(COLORES_DE_FONDO.length >= 6);
  assert.equal(new Set(COLORES_DE_FONDO.map((c) => c.id)).size, COLORES_DE_FONDO.length);
  for (const color of COLORES_DE_FONDO) {
    assert.match(color.claro, /^#[0-9A-F]{6}$/, color.id);
    assert.match(color.oscuro, /^#[0-9A-F]{6}$/, color.id);
    assert.equal(colorDeFondo({ tipo: 'color', id: color.id }, false, '#FFFFFF'), color.claro);
    assert.equal(colorDeFondo({ tipo: 'color', id: color.id }, true, '#000000'), color.oscuro);
  }
  // Sin color elegido —o con una foto— queda el fondo de siempre.
  assert.equal(colorDeFondo(FONDO_POR_DEFECTO, false, '#FFFFFF'), '#FFFFFF');
  assert.equal(colorDeFondo({ tipo: 'foto', uri: 'x' }, true, '#000000'), '#000000');
  assert.equal(colorDeFondo({ tipo: 'color', id: 'inventado' }, false, '#FFFFFF'), '#FFFFFF');
});

test('ningún color deja sin leer lo que se pinta fuera de las burbujas', () => {
  // Sobre el fondo va texto sin burbuja: la hora de un sticker, el nombre de
  // quien escribe. Tiene que leerse con el texto de cada tema (AA, 4.5:1) y
  // con el texto apagado al menos como texto grande (3:1).
  const tokens = leer('../theme/tokens.ts');
  const temas = [...tokens.matchAll(/text: '(#[0-9A-Fa-f]{6})'/g)].map((m) => m[1] as string);
  const apagados = [...tokens.matchAll(/textMuted: '(#[0-9A-Fa-f]{6})'/g)].map((m) => m[1] as string);
  assert.equal(temas.length, 2, 'se esperaba un color de texto por tema');
  assert.equal(apagados.length, 2, 'se esperaba un color apagado por tema');
  const [textoClaro, textoOscuro] = temas as [string, string];
  const [apagadoClaro, apagadoOscuro] = apagados as [string, string];
  for (const color of COLORES_DE_FONDO) {
    assert.ok(contraste(textoClaro, color.claro) >= 4.5, `${color.id} claro`);
    assert.ok(contraste(textoOscuro, color.oscuro) >= 4.5, `${color.id} oscuro`);
    assert.ok(contraste(apagadoClaro, color.claro) >= 3, `${color.id} claro, apagado`);
    assert.ok(contraste(apagadoOscuro, color.oscuro) >= 3, `${color.id} oscuro, apagado`);
  }
});

test('sobre una foto va un velo del tono del tema', () => {
  assert.match(veloSobreLaFoto(false), /^rgba\(255,255,255,0\.\d+\)$/);
  assert.match(veloSobreLaFoto(true), /^rgba\(0,0,0,0\.\d+\)$/);
});

test('se sabe cuál es el fondo elegido', () => {
  assert.ok(mismoFondo(FONDO_POR_DEFECTO, { tipo: 'defecto' }));
  assert.ok(mismoFondo({ tipo: 'color', id: 'rosa' }, { tipo: 'color', id: 'rosa' }));
  assert.ok(!mismoFondo({ tipo: 'color', id: 'rosa' }, { tipo: 'color', id: 'gris' }));
  assert.ok(!mismoFondo({ tipo: 'color', id: 'rosa' }, FONDO_POR_DEFECTO));
  assert.ok(mismoFondo({ tipo: 'foto', uri: 'a' }, { tipo: 'foto', uri: 'a' }));
  assert.ok(!mismoFondo({ tipo: 'foto', uri: 'a' }, { tipo: 'foto', uri: 'b' }));
});

test('cada color tiene su nombre en los tres idiomas', () => {
  for (const idioma of ['es', 'en', 'pt']) {
    const diccionario = leer(`../i18n/${idioma}.ts`);
    for (const color of COLORES_DE_FONDO) {
      assert.ok(
        diccionario.includes(`'chatBackground.color.${color.id}':`),
        `${idioma}: falta chatBackground.color.${color.id}`,
      );
    }
  }
});

test('el fondo es del teléfono: se guarda aquí y no viaja a ningún sitio', () => {
  const almacen = leer('../store/useFondoDeChatStore.ts');
  assert.match(almacen, /AsyncStorage\.setItem\(CLAVE_DE_FONDOS, escribirFondos\(fondos\)\)/);
  assert.doesNotMatch(almacen, /apiRequest|fetch\(|supabase/);
  // Una foto se COPIA a la carpeta de la aplicación: la ruta de la caché no dura.
  assert.match(almacen, /new File\(Paths\.document,/);
  assert.match(almacen, /new File\(uri\)\.copy\(destino\);/);
  // Y la anterior DE ESE CHAT se borra al cambiarla.
  assert.match(almacen, /const anterior = fondoDe\(get\(\)\.fondos, conversacionId\);/);
  assert.match(almacen, /if \(anterior\.tipo === 'foto' &&[^)]*\)\) \{\s*borrarCopia\(anterior\.uri\);/);
  // En web la ruta de una foto no sobrevive a recargar: no se ofrece.
  assert.match(almacen, /export const FONDO_CON_FOTO = Platform\.OS !== 'web';/);
  assert.match(leer('../components/chat/HojaDeFondoDeChat.tsx'), /\{FONDO_CON_FOTO \? \(\s*<ListRow/);
});

test('el fondo se elige y se pinta para la conversación abierta, no para todas', () => {
  const almacen = leer('../store/useFondoDeChatStore.ts');
  const chat = leer('../screens/ChatScreen.tsx');
  const hoja = leer('../components/chat/HojaDeFondoDeChat.tsx');

  // El chat pinta SU fondo, y la hoja cambia el de ESE chat.
  assert.match(
    chat,
    /const fondoDelChat = useFondoDeChatStore\(\(estado\) => fondoDe\(estado\.fondos, params\.id \?\? ''\)\);/,
  );
  assert.match(chat, /<HojaDeFondoDeChat\s+conversacionId=\{params\.id \?\? ''\}/);
  assert.match(hoja, /useFondoDeChatStore\(\(estado\) => fondoDe\(estado\.fondos, conversacionId\)\)/);
  assert.match(hoja, /void elegir\(conversacionId, nuevo\);/);
  assert.match(hoja, /await elegirFoto\(conversacionId, elegida\.uri\)/);
  // Ya no existe un fondo suelto que valga para todos.
  for (const fuente of [almacen, chat, hoja]) assert.doesNotMatch(fuente, /estado\.fondo\b(?!s)/);

  // Lo que se guarda es la lista entera: antes de cambiar un chat hay que
  // haberla leído, o guardar borraría los fondos de los demás.
  const elegir = almacen.slice(almacen.indexOf('async elegir('), almacen.indexOf('async elegirFoto('));
  assert.ok(
    elegir.indexOf('await get().leer();') > 0 &&
      elegir.indexOf('await get().leer();') < elegir.indexOf('conFondo(get().fondos, conversacionId, fondo)'),
  );
  // Y dos lecturas a la vez son la misma.
  assert.match(almacen, /leyendo \?\?= leerDelDisco\(\)/);

  // El fondo de cuando era uno solo se retira; no se le pone a ningún chat.
  const retirar = almacen.slice(
    almacen.indexOf('async function retirarElFondoComun'),
    almacen.indexOf('async function leerDelDisco'),
  );
  assert.match(retirar, /AsyncStorage\.getItem\(CLAVE_DEL_FONDO_COMUN\)/);
  assert.match(retirar, /if \(comun\.tipo === 'foto'\) borrarCopia\(comun\.uri\);/);
  assert.match(retirar, /AsyncStorage\.removeItem\(CLAVE_DEL_FONDO_COMUN\)/);
  assert.doesNotMatch(retirar, /set\(|conFondo|guardar\(/);

  // Y se le dice a la persona en los tres idiomas.
  assert.match(leer('../i18n/es.ts'), /'chatBackground\.hint': 'Cambia solo este chat y solo en este teléfono\./);
  for (const idioma of ['es', 'en', 'pt']) {
    assert.doesNotMatch(
      leer(`../i18n/${idioma}.ts`),
      /'chatBackground\.hint': '[^']*(todos tus chats|all your chats|todos os seus chats)/,
      idioma,
    );
  }
});

test('el fondo se pinta detrás de los mensajes y no recibe toques', () => {
  const chat = leer('../screens/ChatScreen.tsx');
  assert.match(chat, /backgroundColor: colorDeFondo\(fondoDelChat, mode === 'dark', colors\.background\)/);
  assert.match(
    chat,
    /\{fondoDelChat\.tipo === 'foto' \? \(\s*<View pointerEvents="none" style=\{StyleSheet\.absoluteFill\}>/,
  );
  assert.match(chat, /backgroundColor: veloSobreLaFoto\(mode === 'dark'\)/);
  // Va en la zona de los mensajes: la cabecera y el cuadro de texto no cambian.
  assert.ok(chat.indexOf('styles.zonaDeMensajes,') < chat.indexOf("fondoDelChat.tipo === 'foto' ? ("));
});
