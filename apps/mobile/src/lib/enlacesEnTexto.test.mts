import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ENLACE_SOBRE_CLARO,
  ENLACE_SOBRE_OSCURO,
  colorDelEnlace,
  direccionDe,
  partirEnEnlaces,
  tieneEnlaces,
} from './enlacesEnTexto.ts';

/**
 * LOS ENLACES DE UN MENSAJE SE PUEDEN TOCAR (pedido el 07/10/2026).
 *
 * «Cuando una persona agrega un link, como un meet por ejemplo, que la casilla
 * del mensaje pueda soportar links (es decir, que se pinte de celeste y se
 * subraye tal cual pasa en whatsapp y que con una simple pulsación pueda
 * acceder a ese link».
 *
 * Qué es un enlace y qué no se EJECUTA aquí. Cómo se pinta se comprueba sobre
 * el código.
 */

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (codigo: string) =>
  codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const enlaces = (texto: string) =>
  partirEnEnlaces(texto).flatMap((trozo) => (trozo.tipo === 'enlace' ? [trozo.direccion] : []));

describe('qué se reconoce como enlace', () => {
  it('el caso pedido: el enlace de una reunión', () => {
    const trozos = partirEnEnlaces('Nos vemos aquí: https://meet.google.com/abc-defg-hij a las 5');
    assert.deepEqual(trozos, [
      { tipo: 'texto', texto: 'Nos vemos aquí: ' },
      { tipo: 'enlace', texto: 'https://meet.google.com/abc-defg-hij', direccion: 'https://meet.google.com/abc-defg-hij' },
      { tipo: 'texto', texto: ' a las 5' },
    ]);
  });

  it('un mensaje que es solo el enlace', () => {
    assert.deepEqual(enlaces('https://zoom.us/j/123456789?pwd=AbC'), ['https://zoom.us/j/123456789?pwd=AbC']);
  });

  it('con `www.` y con el dominio suelto, que se abren por https', () => {
    assert.deepEqual(enlaces('entra a www.ejemplo.pe/cursos'), ['https://www.ejemplo.pe/cursos']);
    assert.deepEqual(enlaces('meet.google.com/abc-defg-hij'), ['https://meet.google.com/abc-defg-hij']);
    assert.deepEqual(enlaces('la web es empresa.com.pe'), ['https://empresa.com.pe']);
  });

  it('varios enlaces en un mismo mensaje', () => {
    assert.deepEqual(enlaces('uno https://a.com y otro http://b.org/x'), ['https://a.com', 'http://b.org/x']);
  });

  it('la puntuación de después no es parte del enlace', () => {
    assert.deepEqual(enlaces('Mira https://a.com/x.'), ['https://a.com/x']);
    assert.deepEqual(enlaces('¿Viste https://a.com/x?'), ['https://a.com/x']);
    assert.deepEqual(enlaces('(ver https://a.com/x)'), ['https://a.com/x']);
    assert.deepEqual(enlaces('«https://a.com/x», dijo'), ['https://a.com/x']);
  });

  it('pero un paréntesis que es de la dirección se respeta', () => {
    assert.deepEqual(enlaces('https://es.wikipedia.org/wiki/Lima_(ciudad)'), [
      'https://es.wikipedia.org/wiki/Lima_(ciudad)',
    ]);
  });

  it('el texto se conserva entero: juntando los trozos sale lo que se escribió', () => {
    for (const texto of [
      'Nos vemos aquí: https://meet.google.com/abc-defg-hij a las 5.',
      'sin enlaces',
      'https://a.com',
      'a www.b.com, c https://d.org/e) f',
    ]) {
      assert.equal(partirEnEnlaces(texto).map((trozo) => trozo.texto).join(''), texto);
    }
  });
});

describe('qué NO es un enlace', () => {
  it('un correo no se parte en dos', () => {
    assert.deepEqual(enlaces('escríbeme a nombre@gmail.com'), []);
    assert.equal(tieneEnlaces('nombre.apellido@empresa.com.pe'), false);
  });

  it('una frase sin espacio tras el punto no sale subrayada', () => {
    for (const frase of ['ok.me avisas', 'listo.es tarde', 'ya.co', 'hola.Como estás', 'fin.ar']) {
      assert.deepEqual(enlaces(frase), [], frase);
    }
  });

  it('un número con decimales o una hora tampoco', () => {
    assert.deepEqual(enlaces('cuesta 49.90 y es a las 5.30'), []);
  });

  it('un texto vacío no tiene trozos', () => {
    assert.deepEqual(partirEnEnlaces(''), []);
    assert.equal(tieneEnlaces('hola'), false);
  });
});

describe('a dónde lleva', () => {
  it('lo que no trae esquema se abre por https', () => {
    assert.equal(direccionDe('www.a.com'), 'https://www.a.com');
    assert.equal(direccionDe('HTTP://a.com'), 'HTTP://a.com');
  });

  it('un texto no puede lanzar una llamada ni otro esquema', () => {
    for (const texto of ['tel:+51999999999', 'javascript:alert(1)', 'sms:123', 'intent://x#Intent;end', 'file:///etc/passwd']) {
      for (const direccion of enlaces(texto)) {
        assert.match(direccion, /^https?:\/\//i, `${texto} -> ${direccion}`);
      }
    }
    assert.deepEqual(enlaces('tel:+51999999999'), []);
    assert.deepEqual(enlaces('javascript:alert(1)'), []);
  });
});

describe('cómo se ve', () => {
  it('celeste sobre la burbuja oscura y azul sobre la clara', () => {
    assert.equal(colorDelEnlace('#FFFFFF'), ENLACE_SOBRE_OSCURO);
    assert.equal(colorDelEnlace('#fff'), ENLACE_SOBRE_OSCURO);
    assert.equal(colorDelEnlace('#000000'), ENLACE_SOBRE_CLARO);
    assert.equal(colorDelEnlace('#111111'), ENLACE_SOBRE_CLARO);
    // Un color que no se entiende se trata como letra oscura.
    assert.equal(colorDelEnlace('rgba(0,0,0,0.8)'), ENLACE_SOBRE_CLARO);
    assert.equal(colorDelEnlace(undefined), ENLACE_SOBRE_CLARO);
  });

  it('subrayado, y con el color del enlace encima del del texto', () => {
    const componente = sinComentarios(fuente('components/TextoConEnlaces.tsx'));
    assert.match(componente, /style=\{\[style, \{ color: colorDeEnlace, textDecorationLine: 'underline' \}\]\}/);
    assert.match(componente, /onPress=\{\(\) => abrir\(trozo\.direccion\)\}/);
  });

  it('sin enlaces se pinta lo de antes: un solo texto', () => {
    const componente = sinComentarios(fuente('components/TextoConEnlaces.tsx'));
    assert.match(componente, /if \(!hayEnlaces\) return <Text style=\{style\}>\{texto\}<\/Text>;/);
  });

  it('un enlace de la propia web se abre dentro; el resto, con el teléfono', () => {
    const componente = sinComentarios(fuente('components/TextoConEnlaces.tsx'));
    const abrir = componente.slice(componente.indexOf('const abrir = useCallback'), componente.indexOf('if (!hayEnlaces)'));
    assert.match(abrir, /const ruta = rutaInternaDe\(direccion\);\s*if \(ruta\) \{\s*router\.push\(ruta as never\);\s*return;/);
    assert.match(abrir, /Linking\.openURL\(direccion\)\.catch\(/);
  });

  it('el chat lo usa en el texto de cada mensaje', () => {
    const chat = sinComentarios(fuente('screens/ChatScreen.tsx'));
    assert.match(chat, /<TextoConEnlaces\s*texto=\{item\.text\}\s*colorDelTexto=\{mine \? colors\.onPrimary : colors\.text\}/);
  });
});
