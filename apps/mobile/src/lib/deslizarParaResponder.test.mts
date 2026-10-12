import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ARRANQUE,
  DURACION_DE_VUELTA,
  TOLERANCIA_VERTICAL,
  TOPE,
  UMBRAL,
  avanceDeLaFlecha,
  desplazamientoDe,
  escalaDeLaFlecha,
  pasaElUmbral,
  posicionDeVuelta,
  sePuedeResponder,
} from './deslizarParaResponder.ts';

function leer(relativa: string): string {
  return readFileSync(fileURLToPath(new URL(relativa, import.meta.url)), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
}

describe('la burbuja sigue al dedo', () => {
  it('hacia los dos lados, y lo mismo a uno que a otro', () => {
    // Lo pedido: «deslizando el dedo a la izquierda o derecha».
    for (const dx of [10, 40, 80, 200]) {
      assert.equal(desplazamientoDe(-dx), -desplazamientoDe(dx));
      assert.equal(pasaElUmbral(-dx), pasaElUmbral(dx));
      assert.equal(avanceDeLaFlecha(-dx), avanceDeLaFlecha(dx));
    }
    assert.ok(desplazamientoDe(40) > 0);
    assert.ok(desplazamientoDe(-40) < 0);
  });

  it('con freno: avanza menos que el dedo, y nunca al revés', () => {
    assert.ok(desplazamientoDe(40) < 40);
    let anterior = 0;
    for (let dx = 0; dx <= 300; dx += 5) {
      const ahora = desplazamientoDe(dx);
      assert.ok(ahora >= anterior, `retrocede en ${dx}`);
      anterior = ahora;
    }
  });

  it('con tope: un tirón largo no se lleva la burbuja de la pantalla', () => {
    assert.equal(desplazamientoDe(1000), TOPE);
    assert.equal(desplazamientoDe(-1000), -TOPE);
  });

  it('un dato que no es un número la deja en su sitio', () => {
    assert.equal(desplazamientoDe(Number.NaN), 0);
    assert.equal(desplazamientoDe(0), 0);
    assert.equal(avanceDeLaFlecha(Number.NaN), 0);
    assert.equal(pasaElUmbral(Number.NaN), false);
  });
});

describe('cuándo soltar es responder', () => {
  it('un roce no responde; un tirón claro, sí', () => {
    assert.equal(pasaElUmbral(20), false);
    assert.equal(pasaElUmbral(60), false);
    assert.equal(pasaElUmbral(100), true);
    assert.equal(pasaElUmbral(-100), true);
  });

  it('el umbral se puede alcanzar: queda por debajo del tope', () => {
    assert.ok(UMBRAL < TOPE);
  });

  it('la flecha está entera justo cuando soltar ya responde', () => {
    // Es lo que le dice a la persona «ya, suelta».
    for (let dx = 0; dx <= 200; dx += 2) {
      assert.equal(avanceDeLaFlecha(dx) >= 1, pasaElUmbral(dx), `en ${dx}`);
    }
    assert.equal(avanceDeLaFlecha(0), 0);
    assert.equal(escalaDeLaFlecha(0), 0.6);
    assert.equal(escalaDeLaFlecha(1000), 1);
  });
});

describe('la vuelta a su sitio', () => {
  it('sale de donde estaba y acaba en cero, sin pasarse', () => {
    assert.equal(posicionDeVuelta(70, 0), 70);
    assert.equal(posicionDeVuelta(70, DURACION_DE_VUELTA), 0);
    assert.equal(posicionDeVuelta(70, DURACION_DE_VUELTA * 5), 0);
    assert.equal(posicionDeVuelta(-70, DURACION_DE_VUELTA), 0);
    let anterior = 70;
    for (let ms = 0; ms <= DURACION_DE_VUELTA; ms += 8) {
      const ahora = posicionDeVuelta(70, ms);
      // Ni rebota ni cruza al otro lado: no es un muelle.
      assert.ok(ahora <= anterior && ahora >= 0, `en ${ms} ms`);
      anterior = ahora;
    }
  });

  it('un tiempo imposible no deja la burbuja colgada', () => {
    assert.equal(posicionDeVuelta(70, Number.NaN), 0);
    assert.equal(posicionDeVuelta(Number.NaN, 10), 0);
    assert.equal(posicionDeVuelta(70, -50), 70);
  });
});

describe('a qué mensajes se les puede responder deslizando', () => {
  it('lo mismo que decide el menú', () => {
    assert.equal(sePuedeResponder({}, true), true);
    // El servidor todavía no sabe guardar respuestas: el gesto no existe.
    assert.equal(sePuedeResponder({}, false), false);
    // Aún no ha llegado al servidor, o no llegó.
    assert.equal(sePuedeResponder({ estado: 'enviando' }, true), false);
    assert.equal(sePuedeResponder({ estado: 'error' }, true), false);
    assert.equal(sePuedeResponder({ eliminado: true }, true), false);
    assert.equal(sePuedeResponder({ esSesion: true }, true), false);
  });
});

describe('el gesto no le quita nada a la lista', () => {
  const GESTO = leer('../components/chat/DeslizarParaResponder.tsx');
  const CHAT = leer('../screens/ChatScreen.tsx');

  it('empieza solo con un movimiento de lado y se rinde en vertical', () => {
    assert.match(GESTO, /\.activeOffsetX\(\[-ARRANQUE, ARRANQUE\]\)/);
    assert.match(GESTO, /\.failOffsetY\(\[-TOLERANCIA_VERTICAL, TOLERANCIA_VERTICAL\]\)/);
    // Arrancar tiene que costar algo más que el temblor de un toque, y la
    // lista tiene que ganar pronto.
    assert.ok(ARRANQUE >= 10 && TOLERANCIA_VERTICAL <= ARRANQUE);
  });

  it('en reposo no hay nada animado: la fila es una vista normal', () => {
    // La regla de `lib/movimiento.ts`. Una vista animada por fila, aunque no
    // se mueva, es lo que dejó la aplicación a tirones el 04/10.
    assert.doesNotMatch(GESTO, /Animated\.|useSharedValue|useAnimatedStyle|createAnimatedComponent/);
    assert.match(GESTO, /nodo\.setNativeProps\(\{/);
    assert.match(GESTO, /\.runOnJS\(true\)/);
  });

  it('pase lo que pase con el gesto, la burbuja vuelve a su sitio', () => {
    assert.match(GESTO, /\.onFinalize\(\(\) => volver\(\)\)/);
    // También si la celda pasa a ser de otro mensaje a media vuelta.
    assert.match(GESTO, /\}, \[clave, dejarEnSuSitio\]\);/);
    // Y sin dejar un fotograma pendiente al desmontarse.
    assert.match(GESTO, /useEffect\(\(\) => pararLaVuelta, \[pararLaVuelta\]\);/);
  });

  it('avisa en la mano una sola vez al llegar al punto de soltar', () => {
    assert.match(GESTO, /if \(!avisado\.current\) \{\s*avisado\.current = true;\s*haptics\.light\(\);/);
  });

  it('con «reducir movimiento» no hay vuelta animada', () => {
    assert.match(GESTO, /if \(reducir\) \{\s*dejarEnSuSitio\(\);\s*return;\s*\}/);
  });

  it('responder deslizando hace lo mismo que «Responder» en el menú', () => {
    assert.match(CHAT, /alResponder=\{\(\) => setRespondiendoA\(item\)\}/);
    assert.match(
      CHAT,
      /activo=\{sePuedeResponder\(\s*\{ estado: item\.estado, eliminado: item\.eliminado \},\s*funciones\.reacciones,\s*\)\}/,
    );
    // El menú sigue ahí: deslizar es otro camino, no el único.
    assert.match(CHAT, /title=\{t\('chat\.reply'\)\}/);
  });

  it('no cambia de fila al activarse: mismo árbol con gesto o sin él', () => {
    // Si se pintara otra cosa con `activo` en falso, la burbuja se volvería a
    // montar al pasar de «enviando» a enviada.
    assert.match(GESTO, /\.enabled\(activo\)/);
    assert.equal([...GESTO.matchAll(/<GestureDetector/g)].length, 1);
    assert.doesNotMatch(GESTO, /if \(!activo\) return/);
  });
});
