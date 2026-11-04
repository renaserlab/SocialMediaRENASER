import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';

import { contraste } from '../lib/contrasteDeColor.ts';
import {
  COLORES_DE_ROTULO,
  FONDOS_DE_ROTULO,
  GIRO_MAXIMO,
  LETRAS_DE_ROTULO,
  PASO_DE_TAMANO,
  PRESENTACION_POR_OMISION,
  TAMANO_MAXIMO,
  TAMANO_MINIMO,
  TAMANO_POR_OMISION,
  claveDelRotulo,
  cuerpoDeLaDisposicion,
  cuerpoDelRotulo,
  leerDestacado,
  leerPresentacion,
  leerRotulo,
} from './destacado.ts';

/*
  El rótulo editable del directo (aprobado el 02/11/2026; migración 0114).

  Cuatro mitades. Leer lo que manda el servidor sin fiarse. Que la aplicación,
  el servidor y la base digan lo mismo —paleta, fondos, letras, rangos—. Que
  los colores salgan de los tokens y se lean. Y el cableado: que al arrastrar
  no se mande nada hasta soltar, que las letras se carguen solo cuando hacen
  falta y que la sala no vea nada antes de tiempo.
*/

const leer = (ruta: string) =>
  readFileSync(new URL(ruta, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const sinComentarios = (fuente: string) =>
  fuente
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const aMensaje = (dto: { id: string }) => ({ id: dto.id });

/* ------------------------------------------- leer lo que manda el servidor -- */

test('la presentación se lee entera', () => {
  const rotulo = leerRotulo({
    text: 'Sorteo',
    style: 'slide',
    set_at: '2026-11-02T10:00:00Z',
    x: 0.25,
    y: 0.6,
    scale: 150,
    rotation: -12,
    color: 'oro',
    background: 'solido',
    font: 'fuerte',
  });
  assert.deepEqual(rotulo?.presentacion, {
    x: 0.25,
    y: 0.6,
    tamano: 150,
    giro: -12,
    color: 'oro',
    fondo: 'solido',
    letra: 'fuerte',
  });
});

test('un servidor sin la 0114 no manda presentación: se pinta como siempre', () => {
  assert.deepEqual(leerPresentacion({ text: 'Hola', style: 'slide' }), PRESENTACION_POR_OMISION);
  assert.deepEqual(PRESENTACION_POR_OMISION, {
    x: null,
    y: null,
    tamano: 100,
    giro: 0,
    color: 'blanco',
    fondo: 'velo',
    letra: 'clasica',
  });
});

test('lo que esta versión no conoce se pinta como siempre, campo a campo', () => {
  const leida = leerPresentacion({
    x: 1.5,
    y: 0.5,
    scale: 101.5,
    rotation: 999,
    color: 'violeta',
    background: 'degradado',
    font: 'Comic Sans',
  });
  assert.deepEqual(leida, PRESENTACION_POR_OMISION);
  // Una sola coordenada no es un sitio.
  assert.deepEqual(leerPresentacion({ x: 0.5, y: null }).x, null);
  assert.deepEqual(leerPresentacion({ x: Number.NaN, y: 0.5 }).y, null);
  // Lo que sí conoce se conserva aunque otro campo venga mal.
  assert.equal(leerPresentacion({ color: 'rosa', font: 'nada' }).color, 'rosa');
});

test('`banner_layout` dice si se puede mover, y solo si es exactamente true', () => {
  const con = leerDestacado({ pinned: null, banner: null, can_manage: true, banner_layout: true }, aMensaje);
  assert.equal(con?.rotuloEditable, true);
  for (const valor of [false, 'true', 1, null, undefined]) {
    const sin = leerDestacado({ pinned: null, banner: null, can_manage: true, banner_layout: valor }, aMensaje);
    assert.equal(sin?.rotuloEditable, false, String(valor));
  }
});

test('moverlo o cambiarle el color no lo hace entrar otra vez', () => {
  const base = { text: 'Hola', style: 'pulse', set_at: '2026-11-02T10:00:00Z' };
  const antes = leerRotulo({ ...base, x: 0.5, y: 0.2, color: 'blanco' });
  const despues = leerRotulo({ ...base, x: 0.1, y: 0.7, scale: 200, rotation: 30, color: 'oro' });
  assert.equal(claveDelRotulo(antes), claveDelRotulo(despues));
});

/* ------------------------------------------------- lo que se manda -- */

test('al poner el texto se manda la presentación entera (o nada, sin la 0114)', () => {
  assert.deepEqual(cuerpoDelRotulo('Hola', 'slide', null), { text: 'Hola', style: 'slide' });
  assert.deepEqual(
    cuerpoDelRotulo('Hola', 'ticker', {
      x: null,
      y: null,
      tamano: 120,
      giro: 15,
      color: 'azul',
      fondo: 'ninguno',
      letra: 'maquina',
    }),
    {
      text: 'Hola',
      style: 'ticker',
      x: null,
      y: null,
      scale: 120,
      rotation: 15,
      color: 'azul',
      background: 'ninguno',
      font: 'maquina',
    },
  );
});

test('la hoja no manda la posición: no pisa un soltar que aún no ha llegado', () => {
  const p = { x: 0.2, y: 0.3, tamano: 100, giro: 0, color: 'oro', fondo: 'velo', letra: 'clasica' } as const;
  const cuerpo = cuerpoDelRotulo('Hola', 'slide', p, false);
  assert.ok(!('x' in cuerpo) && !('y' in cuerpo));
  assert.equal(cuerpo.color, 'oro');
  // «Deshacer» sí la manda.
  assert.deepEqual([cuerpoDelRotulo('Hola', 'slide', p).x, cuerpoDelRotulo('Hola', 'slide', p).y], [0.2, 0.3]);
});

test('al soltar se mandan solo el sitio, el tamaño y el giro', () => {
  assert.deepEqual(cuerpoDeLaDisposicion({ x: 0.3, y: 0.4, tamano: 135, giro: -7 }), {
    x: 0.3,
    y: 0.4,
    scale: 135,
    rotation: -7,
  });
});

/* ------------------------------ la aplicación, el servidor y la base -- */

const servidor = leer('../../../api/app/modules/live/destacado.py');
const migracion = leer('../../../../supabase/migrations/0114_rotulo_editable.sql').replace(/--[^\n]*/g, '');

function tupla(nombre: string): string[] {
  const casa = new RegExp(`^${nombre} = \\(([^)]*)\\)`, 'm').exec(servidor);
  assert.ok(casa, nombre);
  return casa[1]!.split(',').map((e) => e.trim().replace(/"/g, '')).filter(Boolean);
}

function check(columna: string): string[] {
  const casa = new RegExp(`check \\(${columna} in \\(([^)]*)\\)\\)`).exec(migracion.replace(/\s+/g, ' '));
  assert.ok(casa, columna);
  return casa[1]!.split(',').map((e) => e.trim().replace(/'/g, ''));
}

test('la paleta, los fondos y las letras son los mismos en los tres sitios', () => {
  assert.deepEqual(tupla('COLORES'), [...COLORES_DE_ROTULO]);
  assert.deepEqual(tupla('FONDOS'), [...FONDOS_DE_ROTULO]);
  assert.deepEqual(tupla('LETRAS'), [...LETRAS_DE_ROTULO]);
  assert.deepEqual(check('banner_color'), [...COLORES_DE_ROTULO]);
  assert.deepEqual(check('banner_background'), [...FONDOS_DE_ROTULO]);
  assert.deepEqual(check('banner_font'), [...LETRAS_DE_ROTULO]);
});

test('los rangos de tamaño y giro son los mismos en los tres sitios', () => {
  for (const [nombre, valor] of [
    ['TAMANO_MINIMO', TAMANO_MINIMO],
    ['TAMANO_MAXIMO', TAMANO_MAXIMO],
    ['PASO_DE_TAMANO', PASO_DE_TAMANO],
    ['TAMANO_POR_OMISION', TAMANO_POR_OMISION],
    ['GIRO_MAXIMO', GIRO_MAXIMO],
  ] as const) {
    assert.match(servidor, new RegExp(`^${nombre} = ${valor}$`, 'm'), nombre);
  }
  const sql = migracion.replace(/\s+/g, ' ');
  assert.ok(
    sql.includes(
      `banner_scale between ${TAMANO_MINIMO} and ${TAMANO_MAXIMO} and banner_scale % ${PASO_DE_TAMANO} = 0`,
    ),
  );
  assert.ok(sql.includes(`banner_rotation between -${GIRO_MAXIMO} and ${GIRO_MAXIMO}`));
  assert.ok(sql.includes(`banner_scale smallint not null default ${TAMANO_POR_OMISION}`));
});

/* ---------------------------------------------------- los colores -- */

const tokens = leer('../theme/tokens.ts');
const bloqueDelRotulo = tokens.slice(
  tokens.indexOf('export const rotuloDeDirecto = {'),
  tokens.indexOf('} as const;', tokens.indexOf('export const rotuloDeDirecto = {')),
);

function tintas(color: string): { texto: string; relleno: string; sobreRelleno: string } {
  const casa = new RegExp(
    `${color}: \\{ texto: '(#[0-9A-F]{6})', relleno: '(#[0-9A-F]{6})', sobreRelleno: '(#[0-9A-F]{6})' \\}`,
  ).exec(bloqueDelRotulo);
  assert.ok(casa, `sin tintas para ${color} en tokens.ts`);
  return { texto: casa[1]!, relleno: casa[2]!, sobreRelleno: casa[3]! };
}

test('cada color de la paleta tiene sus tres tintas en los tokens, y ninguno más', () => {
  const nombres = [...bloqueDelRotulo.matchAll(/^\s{4}(\w+): \{ texto:/gm)].map((m) => m[1]);
  assert.deepEqual(nombres, [...COLORES_DE_ROTULO]);
  // Esmeralda y oro son los de la marca.
  assert.equal(tintas('esmeralda').relleno, '#0F7B6C');
  assert.equal(tintas('esmeralda').texto, '#149F8C');
  assert.equal(tintas('oro').relleno, '#C9A24E');
});

test('con fondo sólido, la letra se lee 4,5 a 1 sobre su relleno', () => {
  for (const color of COLORES_DE_ROTULO) {
    const { relleno, sobreRelleno } = tintas(color);
    const razon = contraste(relleno, sobreRelleno);
    assert.ok(razon !== null && razon >= 4.5, `${color}: ${razon?.toFixed(2)} a 1`);
  }
});

test('sin fondo o con velo, la letra se lee 4,5 a 1 sobre oscuro (la negra, sobre claro)', () => {
  for (const color of COLORES_DE_ROTULO) {
    const { texto } = tintas(color);
    const fondo = color === 'negro' ? '#FFFFFF' : '#000000';
    const razon = contraste(texto, fondo);
    assert.ok(razon !== null && razon >= 4.5, `${color}: ${razon?.toFixed(2)} a 1`);
  }
});

const COMPONENTES = [
  '../components/live/CapaDelRotulo.tsx',
  '../components/live/RotuloDeDirecto.tsx',
  '../components/live/HojaDeRotulo.tsx',
  '../components/live/ReglaFina.tsx',
];

test('los componentes del rótulo no escriben colores a mano', () => {
  for (const ruta of COMPONENTES) {
    const literales = [...sinComentarios(leer(ruta)).matchAll(/#[0-9A-Fa-f]{3,8}\b|rgba?\(/g)].map((m) => m[0]);
    assert.deepEqual(literales, [], ruta);
  }
});

/* ------------------------------------------------------- las letras -- */

test('las dos letras propias son TrueType de verdad y llevan su licencia OFL', () => {
  for (const [fichero, licencia] of [
    ['Anton-Regular.ttf', 'Anton-OFL.txt'],
    ['CourierPrime-Bold.ttf', 'CourierPrime-OFL.txt'],
  ]) {
    const ruta = new URL(`../../assets/fonts/${fichero}`, import.meta.url);
    const cabecera = readFileSync(ruta).subarray(0, 4);
    assert.deepEqual([...cabecera], [0, 1, 0, 0], `${fichero} no empieza como un TTF`);
    assert.ok(statSync(ruta).size < 250_000, `${fichero} pesa demasiado`);
    const texto = readFileSync(new URL(`../../assets/fonts/${licencia}`, import.meta.url), 'utf8');
    assert.match(texto, /SIL OPEN FONT LICENSE Version 1\.1/i, licencia);
  }
});

test('se cargan cuando hacen falta, no al arrancar', () => {
  const gancho = sinComentarios(leer('../hooks/useLetrasDelRotulo.ts'));
  assert.match(gancho, /Font\.loadAsync\(/);
  assert.match(gancho, /require\('\.\.\/\.\.\/assets\/fonts\/Anton-Regular\.ttf'\)/);
  assert.match(gancho, /require\('\.\.\/\.\.\/assets\/fonts\/CourierPrime-Bold\.ttf'\)/);
  // Nadie más las pide: ni el arranque ni otra pantalla.
  const arranque = leer('../../app/_layout.tsx');
  assert.doesNotMatch(arranque, /Anton|CourierPrime/);
  for (const ruta of COMPONENTES) {
    assert.doesNotMatch(sinComentarios(leer(ruta)), /\.ttf'/, ruta);
  }
});

/* ------------------------------------------------------- el cableado -- */

test('arrastrando no se manda nada: solo al soltar', () => {
  const capa = sinComentarios(leer('../components/live/CapaDelRotulo.tsx'));
  // `alSoltar` solo se llama en un sitio: al terminar el gesto.
  assert.equal((capa.match(/\bsoltar\(sitio\)/g) ?? []).length, 1);
  const terminar = capa.slice(capa.indexOf('function terminar('), capa.indexOf('const gestos = useMemo'));
  assert.match(terminar, /soltar\(sitio\)/);
  const recalcular = capa.slice(capa.indexOf('function recalcular('), capa.indexOf('function empezar('));
  assert.doesNotMatch(recalcular, /alSoltar|soltar\(|LiveRepository|apiRequest/);
});

test('el imán y la papelera dan un toque en la mano, y no hay vibración sin `haptics`', () => {
  const capa = sinComentarios(leer('../components/live/CapaDelRotulo.tsx'));
  assert.match(capa, /from '@\/lib\/haptics'/);
  assert.ok((capa.match(/haptics\.(light|medium)\(\)/g) ?? []).length >= 3);
  assert.doesNotMatch(capa, /Vibration/);
});

test('soltar no pasa por el freno de los botones, y dos soltares no van a la vez', () => {
  const gancho = sinComentarios(leer('../hooks/useDestacadoDeDirecto.ts'));
  const mover = gancho.slice(gancho.indexOf('const moverRotulo = useCallback('));
  assert.match(mover, /mandar\(\(\) => LiveRepository\.moverRotulo\(emisionId, ahora\)\)/);
  assert.doesNotMatch(mover.slice(0, mover.indexOf('const quitarRotulo')), /\bgesto\(/);
  assert.match(mover, /siguienteSitio\.current = disposicion;/);
});

test('la pantalla mide la cabecera y el chat, y el rótulo va debajo de los botones', () => {
  const pantalla = sinComentarios(leer('../screens/LiveScreen.tsx'));
  const columna = pantalla.slice(pantalla.indexOf('<SinTecladoDelante style={estilos.columna}>'));
  // La capa va DESPUÉS del hueco de la imagen (por encima del cartel de «no
  // hay video», que si no se quedaba con el toque) y ANTES del chat y los
  // botones, que quedan por encima.
  const capa = columna.indexOf('<CapaDelRotulo');
  assert.ok(columna.indexOf('<CartelDeVideo') < capa, 'el cartel tapaba el texto');
  assert.ok(capa < columna.indexOf('<ChatDeDirecto'));
  assert.ok(capa < columna.indexOf('<ControlesDeAnfitrion'));
  assert.match(pantalla, /medirParte\('cabecera'/);
  assert.match(pantalla, /medirParte\('fila'/);
  assert.match(pantalla, /medirParte\('chat'/);
  assert.match(pantalla, /zonaLibre\(\{ cabecera: enLaCapa, bordeDelChat: fila \+ chat - lienzo\.y \}\)/);
  // Solo mueve quien gestiona, y solo con la 0114.
  assert.match(pantalla, /puedeMoverRotulo = puedeDestacar && destacar\.destacado\.rotuloEditable/);
  // Ya no hay un rótulo fijo en el flujo de la columna.
  assert.doesNotMatch(pantalla, /<RotuloDeDirecto\b/);
});

test('la sala no ve el borrador: solo la hoja del host lo pinta', () => {
  const pantalla = sinComentarios(leer('../screens/LiveScreen.tsx'));
  assert.match(pantalla, /const editandoRotulo = hojaDeRotulo && puedeDestacar && borrador !== null;/);
  // Lo que se manda a la sala sale de «Actualizar el texto», en la hoja.
  const hoja = sinComentarios(leer('../components/live/HojaDeRotulo.tsx'));
  // Sin la posición: la hoja no lo mueve.
  assert.match(hoja, /destacar\.ponerRotulo\(limpio, estilo, editable \? presentacion : null, false\)/);
  assert.equal((hoja.match(/destacar\.ponerRotulo\(/g) ?? []).length, 1);
});

test('tamaño y giro van con la barra fina, que se mueve con el lector de pantalla y en la web con las flechas', () => {
  const hoja = sinComentarios(leer('../components/live/HojaDeRotulo.tsx'));
  assert.match(hoja, /<ReglaFina\s+regla=\{REGLA_DE_TAMANO\}[\s\S]*?etiqueta=\{t\('live\.bannerSize'\)\}/);
  assert.match(hoja, /<ReglaFina\s+regla=\{REGLA_DE_GIRO\}[\s\S]*?etiqueta=\{t\('live\.bannerRotation'\)\}/);
  const regla = sinComentarios(leer('../components/live/ReglaFina.tsx'));
  assert.match(regla, /accessibilityRole="adjustable"/);
  assert.match(regla, /name: 'increment'/);
  assert.match(regla, /name: 'decrement'/);
  assert.match(regla, /onKeyDown:/);
  assert.match(regla, /tabIndex: 0/);
  // En la web el valor va en aria-valuenow: `accessibilityValue` ya no llega al DOM.
  assert.match(regla, /aria-valuenow=\{valor\}/);
});

test('la hoja del texto es la translúcida de los efectos, sin velo, y las demás hojas no cambian', () => {
  const hoja = sinComentarios(leer('../components/live/HojaDeRotulo.tsx'));
  assert.doesNotMatch(hoja, /<BottomSheet/);
  assert.match(hoja, /backgroundColor: tinta\.velo/);
  assert.match(hoja, /Platform\.OS === 'android' \? tinta\.hojaSinDesenfoque : tinta\.hoja/);
  // El teclado no tapa el campo: la hoja es otra ventana y se aparta sola.
  assert.match(hoja, /<SinTecladoDelante style=\{estilos\.pantalla\} ventanaPropia>/);
  // El 80 % se mide contra la pantalla (la caja), no contra la hoja: si no,
  // la hoja se recorta a sí misma y el botón de mandar queda fuera.
  assert.match(hoja, /caja: \{ alignItems: 'stretch', maxHeight: '80%' \}/);
  assert.doesNotMatch(hoja, /hoja: \{\s*maxHeight/);
  const tokens = sinComentarios(leer('../theme/tokens.ts'));
  assert.match(tokens, /export const hojaDelRotulo = \{\s*\.\.\.efectosDeCamara,/);
  assert.match(tokens, /export const efectosDeCamara = \{\s*velo: 'transparent',/);
  const base = sinComentarios(leer('../components/BottomSheet.tsx'));
  assert.match(base, /backgroundColor: colorDelVelo \?\? colors\.overlay/);
});

test('con la hoja del texto abierta el chat y los botones se apartan, como con la de efectos', () => {
  const pantalla = sinComentarios(leer('../screens/LiveScreen.tsx'));
  assert.match(pantalla, /const hojaSobreLaImagen = hojaDeEfectos \|\| hojaDeRotulo;/);
  assert.match(pantalla, /toValue: hojaSobreLaImagen \? 0 : 1/);
  assert.equal((pantalla.match(/pointerEvents=\{hojaSobreLaImagen \? 'none' : 'box-none'\}/g) ?? []).length, 2);
});
