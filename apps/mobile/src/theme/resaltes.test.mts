import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { contraste } from '../lib/contrasteDeColor.ts';

/*
  Los resaltes de color (27/10/2026; esmeralda y oro desde el 30/10/2026)
  tienen que seguir leyéndose:

  - letra sobre un relleno (botón principal, globo, «EN VIVO», lápiz): 4,5 a 1;
  - un gráfico sobre el fondo (corazón, «+») o un icono sobre su círculo: 3 a 1;
  - el anillo, 3 a 1 en al menos MEDIA VUELTA y en su arranque. No en cada
    tramo: el degradado aprobado termina en oro claro, que sobre blanco no
    llega (1,5:1) y es justo lo que le da luz. Lo que hace falta es que el aro
    se reconozca como aro, y el tramo esmeralda lo dibuja;
  - el texto gris de las tarjetas grises: 4,5 a 1.

  Los colores se LEEN de `tokens.ts` (no se copian aquí): `tokens.ts` importa
  `react-native` y no se puede cargar en Node.
*/

const tokens = readFileSync(new URL('./tokens.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function bloque(inicio: string, fin: string): string {
  const desde = tokens.indexOf(inicio);
  assert.ok(desde >= 0, `no está «${inicio}»`);
  return tokens.slice(desde, tokens.indexOf(fin, desde));
}

const bases = {
  light: bloque('const light = {', '} as const'),
  dark: bloque('const dark = {', '} as const'),
};
const resaltes = {
  light: bloque('const resaltesClaros: Resaltes = {', '\n};'),
  dark: bloque('const resaltesOscuros: Resaltes = {', '\n};'),
};

type Modo = keyof typeof bases;

/** El valor de `clave`: un hex escrito tal cual o una referencia a la base (`light.text`). */
function valor(texto: string, clave: string, modo: Modo): string {
  // Hasta la primera coma: la base lleva comentarios al final de la línea.
  const casa = new RegExp(`^\\s*${clave}: ([^,\\n]+),`, 'm').exec(texto);
  assert.ok(casa, `no está ${modo}.${clave}`);
  const crudo = casa[1]!.trim();
  const hex = /^'(#[0-9A-Fa-f]{6})'$/.exec(crudo);
  if (hex) return hex[1]!;
  const referencia = /^(light|dark)\.(\w+)$/.exec(crudo);
  assert.ok(referencia, `${modo}.${clave} no es un hex ni una referencia a la base: ${crudo}`);
  return valor(bases[referencia[1] as Modo], referencia[2]!, referencia[1] as Modo);
}

const color = (modo: Modo, clave: string) => valor(resaltes[modo], clave, modo);
const base = (modo: Modo, clave: string) => valor(bases[modo], clave, modo);

function anillo(modo: Modo): string[] {
  const casa = /^\s*anillo: \[(.+)\],$/m.exec(resaltes[modo]);
  assert.ok(casa, `no está ${modo}.anillo`);
  return [...casa[1]!.matchAll(/'(#[0-9A-Fa-f]{6})'/g)].map((m) => m[1]!);
}

/** El color del degradado en `posicion` (0–1), con los tramos repartidos a partes iguales. */
function colorDelDegradado(tramos: string[], posicion: number): string {
  const x = posicion * (tramos.length - 1);
  const i = Math.min(Math.floor(x), tramos.length - 2);
  const canales = (hex: string) => [1, 3, 5].map((k) => Number.parseInt(hex.slice(k, k + 2), 16));
  const desde = canales(tramos[i]!);
  const hasta = canales(tramos[i + 1]!);
  const mezcla = desde.map((v, k) => Math.round(v + (hasta[k]! - v) * (x - i)));
  return `rgb(${mezcla.join(',')})`;
}

/*
  Parte de la vuelta del aro que destaca 3 a 1 sobre `fondo`, tal y como lo
  pinta StoriesRow: el degradado cruza la caja cuadrada del aro de
  abajo-izquierda a arriba-derecha, así que un punto del círculo a `angulo`
  cae en `0,5 + (cos − sen) / 4` de esa diagonal (el círculo solo toca del
  14,6 al 85,4 %: los extremos del degradado no llegan a verse del todo).
*/
function vueltaQueDestaca(tramos: string[], fondo: string): number {
  const pasos = 360;
  let destacan = 0;
  for (let paso = 0; paso < pasos; paso++) {
    const angulo = (2 * Math.PI * paso) / pasos;
    const posicion = 0.5 + (Math.cos(angulo) - Math.sin(angulo)) / 4;
    const razon = contraste(colorDelDegradado(tramos, posicion), fondo);
    if (razon !== null && razon >= 3) destacan++;
  }
  return destacan / pasos;
}

function categoria(modo: Modo): { color: string; suave: string } {
  const casa = /categorias: todasLasCategorias\(\{ color: ([\w.]+), suave: '(#[0-9A-Fa-f]{6})'/.exec(resaltes[modo]);
  assert.ok(casa, `no está ${modo}.categorias`);
  const [modoBase, clave] = casa[1]!.split('.') as [Modo, string];
  return { color: base(modoBase, clave), suave: casa[2]! };
}

function alMenos(razon: number | null, minimo: number, que: string) {
  assert.ok(razon !== null, `${que}: color ilegible`);
  assert.ok(razon >= minimo, `${que}: ${razon.toFixed(2)} a 1, hace falta ${minimo}`);
}

for (const modo of ['light', 'dark'] as const) {
  describe(`resaltes en ${modo === 'light' ? 'claro' : 'oscuro'}`, () => {
    it('letra sobre el botón principal, el globo y «EN VIVO»: 4,5 a 1', () => {
      for (const [fondo, letra] of [
        ['accion', 'sobreAccion'],
        ['aviso', 'sobreAviso'],
        ['envivo', 'sobreEnvivo'],
        ['editarPerfil', 'sobreEditarPerfil'],
      ] as const) {
        alMenos(contraste(color(modo, fondo), color(modo, letra)), 4.5, `${fondo}/${letra}`);
      }
    });

    it('corazón y «+» de crear sobre el fondo: 3 a 1', () => {
      const fondo = base(modo, 'background');
      alMenos(contraste(color(modo, 'meGusta'), fondo), 3, 'meGusta');
      alMenos(contraste(color(modo, 'crear'), fondo), 3, 'crear');
    });

    it('el anillo destaca 3 a 1 en al menos media vuelta, y su arranque entero', () => {
      const fondo = base(modo, 'background');
      const tramos = anillo(modo);
      assert.ok(tramos.length >= 2, `${modo}.anillo: un degradado necesita dos colores`);
      // El arranque es también el aro sólido de respaldo (`anillo[0]` en StoriesRow).
      alMenos(contraste(tramos[0], fondo), 3, `arranque del anillo ${tramos[0]}`);
      const vuelta = vueltaQueDestaca(tramos, fondo);
      assert.ok(vuelta >= 0.5, `el anillo solo destaca en el ${Math.round(vuelta * 100)} % de la vuelta; hace falta la mitad`);
    });

    it('el «+» blanco sobre `crear`: 3 a 1', () => {
      alMenos(contraste(color(modo, 'sobreCrear'), color(modo, 'crear')), 3, 'sobreCrear/crear');
    });

    it('texto gris sobre la tarjeta gris: 4,5 a 1', () => {
      alMenos(contraste(base(modo, 'textMuted'), color(modo, 'tarjetaRelleno')), 4.5, 'textMuted/tarjetaRelleno');
    });

    it('icono de categoría sobre su círculo gris: 3 a 1', () => {
      const { color: icono, suave } = categoria(modo);
      alMenos(contraste(icono, suave), 3, 'categoría');
    });
  });
}

describe('el corazón y «EN VIVO» sobre fotos y vídeos', () => {
  it('se leen de la paleta oscura y llevan su propio color, no el rojo de peligro', () => {
    assert.notEqual(color('dark', 'envivo'), base('dark', 'danger'));
    assert.notEqual(color('dark', 'meGusta'), base('dark', 'danger'));
  });
});
