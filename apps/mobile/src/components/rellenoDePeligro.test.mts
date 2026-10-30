import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/*
  Lo que se vio: «EN VIVO» y «Terminar» eran letra BLANCA sobre el rojo claro
  de la paleta oscura (#FF8A80), que esta pensado para ser letra sobre negro.
  2,3 a 1. Son los dos rotulos que no pueden leerse mal dentro de la sala.

  Aqui se mide el par que se usa ahora, con los colores LEIDOS de los tokens
  —no copiados—, y se vigila que nadie vuelva a rellenar con el rojo claro.
*/

const leer = (ruta: string) =>
  readFileSync(new URL(ruta, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const tokens = leer('../theme/tokens.ts');

/** El valor de una clave dentro de `const <paleta> = { ... }`. */
function color(paleta: 'light' | 'dark', clave: string): string {
  const desde = tokens.indexOf(`const ${paleta} = {`);
  assert.ok(desde >= 0, `no esta la paleta ${paleta}`);
  const bloque = tokens.slice(desde, tokens.indexOf('} as const', desde));
  const casa = new RegExp(`^\\s*${clave}: '(#[0-9A-Fa-f]{6})'`, 'm').exec(bloque);
  assert.ok(casa, `no esta ${paleta}.${clave}`);
  return casa[1];
}

function luminancia(hex: string): number {
  const canal = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * canal(1) + 0.7152 * canal(3) + 0.0722 * canal(5);
}

function contraste(a: string, b: string): number {
  const [clara, oscura] = [luminancia(a), luminancia(b)].sort((x, y) => y - x);
  return (clara + 0.05) / (oscura + 0.05);
}

test('el relleno de peligro sale de los tokens, no de un color escrito a mano', () => {
  const capa = leer('./CapaDeContraste.tsx');
  assert.match(capa, /rellenoDePeligro = \{\s*fondo: palette\('light'\)\.danger,\s*texto: palette\('light'\)\.onPrimary,\s*\} as const/);
});

test('letra sobre el relleno de peligro: al menos 4,5 a 1', () => {
  const razon = contraste(color('light', 'danger'), color('light', 'onPrimary'));
  assert.ok(razon >= 4.5, `se queda en ${razon.toFixed(2)} a 1`);
});

test('el par de antes no llegaba: por eso se cambio', () => {
  // Si alguien «arregla» el token oscuro y esto deja de cumplirse, la prueba
  // avisa de que la explicacion de `CapaDeContraste` ya no es verdad.
  const razon = contraste(color('dark', 'danger'), color('dark', 'text'));
  assert.ok(razon < 3, `ahora da ${razon.toFixed(2)} a 1`);
});

test('nadie rellena con el rojo claro de la paleta oscura', () => {
  // «EN VIVO» va con `rellenoDeEnVivo` (tokens de resalte `envivo`); «Terminar»
  // sigue con `rellenoDePeligro`. Los dos son rellenos opacos con su letra.
  for (const ruta of [
    '../screens/LiveScreen.tsx',
    './SeccionLive.tsx',
    './AvisoDeDirectoSeguido.tsx',
  ]) {
    const fuente = leer(ruta);
    assert.doesNotMatch(fuente, /backgroundColor: media\.danger/, ruta);
    assert.match(fuente, /backgroundColor: rellenoDe(Peligro|EnVivo)\.fondo/, ruta);
    assert.match(fuente, /rellenoDe(Peligro|EnVivo)\.texto/, ruta);
  }
});

test('«EN VIVO» sale de su token de resalte, no del rojo de peligro', () => {
  const capa = leer('./CapaDeContraste.tsx');
  assert.match(capa, /rellenoDeEnVivo = \{\s*fondo: sobreMedio\.envivo,\s*texto: sobreMedio\.sobreEnvivo,\s*\} as const/);
  // Su contraste (letra blanca sobre el esmeralda) lo mide `theme/resaltes.test.mts`.
});
