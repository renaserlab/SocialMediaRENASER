import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { contraste } from '../lib/contrasteDeColor.ts';

/*
  Los resaltes de color (27/10/2026) tienen que seguir leyéndose:

  - letra sobre un relleno de color (botón principal, globo, «EN VIVO»): 4,5 a 1;
  - un gráfico sobre el fondo (corazón, «+», anillo) o un icono sobre su
    círculo: 3 a 1;
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

    it('corazón, «+» de crear y anillo sobre el fondo: 3 a 1', () => {
      const fondo = base(modo, 'background');
      alMenos(contraste(color(modo, 'meGusta'), fondo), 3, 'meGusta');
      alMenos(contraste(color(modo, 'crear'), fondo), 3, 'crear');
      for (const tramo of anillo(modo)) alMenos(contraste(tramo, fondo), 3, `anillo ${tramo}`);
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
