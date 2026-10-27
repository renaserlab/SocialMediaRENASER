import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { describe, it } from 'node:test';

/*
  «Leído» y los enlaces de la burbuja propia se eligen por CONTRASTE con la
  burbuja, no por el modo. Lo que se vigila:

  1. Con la burbuja de siempre (negra en claro, blanca en oscuro) sale
     exactamente lo de antes.
  2. Con una burbuja de color, el color elegido se lee (al menos 3 a 1) y
     «leído» nunca coincide con «entregado».

  `colorSobreBurbuja.ts` importa valores por el alias `@/`; como en
  `carrito.test.mts`, se registra un resolutor y se importa en dinámico.
*/
registerHooks({
  resolve(especificador, contexto, siguiente) {
    if (especificador.startsWith('@/')) {
      return {
        url: new URL(`../${especificador.slice(2)}.ts`, import.meta.url).href,
        shortCircuit: true,
      };
    }
    return siguiente(especificador, contexto);
  },
});

const { colorDeLeidoSobre, colorDelEnlaceSobre } = await import('./colorSobreBurbuja.ts');
const { contraste, tintaSobre } = await import('./contrasteDeColor.ts');
const { COLOR_DE_LEIDO } = await import('./lecturaDeMensajes.ts');
const { ENLACE_SOBRE_CLARO, ENLACE_SOBRE_OSCURO } = await import('./enlacesEnTexto.ts');

describe('con la burbuja de siempre, lo de antes', () => {
  it('«leído»: celeste sobre la negra, azul sobre la blanca', () => {
    assert.equal(colorDeLeidoSobre('#000000', '#FFFFFF'), COLOR_DE_LEIDO.sobreOscuro);
    assert.equal(colorDeLeidoSobre('#FFFFFF', '#000000'), COLOR_DE_LEIDO.sobreClaro);
  });

  it('enlaces: celeste sobre la negra, azul sobre la blanca', () => {
    assert.equal(colorDelEnlaceSobre('#000000', '#FFFFFF'), ENLACE_SOBRE_OSCURO);
    assert.equal(colorDelEnlaceSobre('#FFFFFF', '#000000'), ENLACE_SOBRE_CLARO);
  });
});

describe('con una burbuja de color, se sigue leyendo', () => {
  for (const burbuja of ['#5CC8FF', '#0B74D1', '#FF00FF', '#7C3AED', '#22C55E', '#F59E0B']) {
    it(`«leído» sobre ${burbuja}`, () => {
      const entregado = tintaSobre(burbuja);
      const leido = colorDeLeidoSobre(burbuja, entregado);
      assert.ok(leido, 'devuelve un color');
      assert.notEqual(leido!.toLowerCase(), entregado.toLowerCase(), 'leído no puede ser igual que entregado');
      assert.ok((contraste(burbuja, leido) ?? 0) >= 3, `${leido} sobre ${burbuja} no llega a 3:1`);
    });

    it(`enlace sobre ${burbuja}`, () => {
      const letra = tintaSobre(burbuja);
      const enlace = colorDelEnlaceSobre(burbuja, letra)!;
      assert.ok(enlace === letra || (contraste(burbuja, enlace) ?? 0) >= 3);
    });
  }

  it('el celeste de «leído» ya no se elige sobre una burbuja celeste', () => {
    assert.notEqual(colorDeLeidoSobre('#5CC8FF', '#000000'), COLOR_DE_LEIDO.sobreOscuro);
  });

  it('un fondo que no se entiende devuelve null (quien llama usa lo de antes)', () => {
    assert.equal(colorDeLeidoSobre('transparent'), null);
    assert.equal(colorDelEnlaceSobre('var(--x)', '#000'), null);
  });
});
