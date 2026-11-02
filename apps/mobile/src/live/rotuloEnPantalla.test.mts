import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DURACION_DEL_DESLIZ_MS,
  IMAN_GRADOS,
  IMAN_PX,
  MARGEN_BAJO_LA_CABECERA,
  MARGEN_SOBRE_EL_CHAT,
  RADIO_DE_LA_PAPELERA,
  TECHO_AL_SUBIR,
  aFracciones,
  ajustarGiro,
  ajustarTamano,
  centroDeLaZona,
  colocar,
  comoCambia,
  cuantoSube,
  dedoAlEmpezar,
  desfaseDelDedo,
  enLaPapelera,
  huecoParaElTexto,
  iman,
  limitar,
  medidasDeLaPildora,
  mitadesGiradas,
  papeleraEn,
  pasoDeGiro,
  zonaLibre,
} from './rotuloEnPantalla.ts';

/*
  Dónde se pinta el rótulo del directo y qué hace el dedo (aprobado el
  02/11/2026). Las medidas son las del teléfono de la propuesta: 360 × 780,
  cabecera de 12 a 348 y de 24 a 76, chat desde 461. Así la zona libre queda
  de 80 a 453, como en la maqueta.
*/

const LIENZO = { ancho: 360, alto: 780 };
const CABECERA = { x: 12, y: 24, ancho: 336, alto: 52 };
const ZONA = zonaLibre({ cabecera: CABECERA, bordeDelChat: 461 });
const PILDORA = { ancho: 200, alto: 34 };

const cerca = (a: number, b: number, tolerancia = 1e-9) =>
  assert.ok(Math.abs(a - b) <= tolerancia, `${a} no es ${b}`);

/* ---------------------------------------------------------- la zona -- */

test('la zona va de la cabecera (+4) al chat (−8), con el margen de la cabecera', () => {
  assert.deepEqual(ZONA, { izquierda: 12, derecha: 348, arriba: 80, abajo: 453 });
  assert.equal(MARGEN_BAJO_LA_CABECERA, 4);
  assert.equal(MARGEN_SOBRE_EL_CHAT, 8);
  // La guía horizontal es el centro de la ZONA, no el de la pantalla.
  assert.deepEqual(centroDeLaZona(ZONA), { x: 180, y: 266.5 });
});

test('el texto nunca sale de la zona: ni por la cabecera ni por el chat ni por los lados', () => {
  for (const deseado of [
    { x: -500, y: -500 },
    { x: 900, y: 900 },
    { x: 180, y: 0 },
    { x: 180, y: 780 },
    { x: 0, y: 266 },
  ]) {
    const { x, y } = limitar(deseado, PILDORA, 0, ZONA);
    assert.ok(x - PILDORA.ancho / 2 >= ZONA.izquierda - 1e-9, `izquierda con ${JSON.stringify(deseado)}`);
    assert.ok(x + PILDORA.ancho / 2 <= ZONA.derecha + 1e-9, `derecha con ${JSON.stringify(deseado)}`);
    assert.ok(y - PILDORA.alto / 2 >= ZONA.arriba - 1e-9, `arriba con ${JSON.stringify(deseado)}`);
    assert.ok(y + PILDORA.alto / 2 <= ZONA.abajo + 1e-9, `abajo con ${JSON.stringify(deseado)}`);
  }
});

test('girado, lo que cuenta es la caja que ocupa girado', () => {
  const recto = mitadesGiradas(PILDORA, 0);
  assert.deepEqual(recto, { mx: 100, my: 17 });
  const de90 = mitadesGiradas(PILDORA, 90);
  cerca(de90.mx, 17);
  cerca(de90.my, 100);
  // A 90° el texto mide 200 de alto: no puede subir más allá de 80 + 100.
  cerca(limitar({ x: 180, y: 0 }, PILDORA, 90, ZONA).y, 180);
  // Y el giro negativo ocupa lo mismo que el positivo.
  assert.deepEqual(mitadesGiradas(PILDORA, -30), mitadesGiradas(PILDORA, 30));
});

test('un texto más grande que la zona se centra en ese sentido', () => {
  const enorme = { ancho: 500, alto: 600 };
  assert.deepEqual(limitar({ x: 0, y: 0 }, enorme, 0, ZONA), centroDeLaZona(ZONA));
});

test('sin posición guardada va donde iba siempre: bajo la cabecera y centrado', () => {
  const sitio = colocar({ x: null, y: null }, LIENZO, ZONA, PILDORA, 0);
  assert.equal(sitio.x, 180);
  // Su borde de arriba, justo en el borde de arriba de la zona.
  assert.equal(sitio.y - PILDORA.alto / 2, ZONA.arriba);
  // Con una sola coordenada tampoco es un sitio.
  assert.deepEqual(colocar({ x: 0.9, y: null }, LIENZO, ZONA, PILDORA, 0), sitio);
});

test('la posición viaja en fracciones y cada teléfono la encaja en su zona', () => {
  const guardada = aFracciones({ x: 200, y: 300 }, LIENZO);
  assert.deepEqual(guardada, { x: 0.5556, y: 0.3846 });
  // De vuelta en el mismo teléfono, el mismo sitio (a menos de un punto).
  const aqui = colocar(guardada, LIENZO, ZONA, PILDORA, 0);
  cerca(aqui.x, 200, 0.05);
  cerca(aqui.y, 300, 0.05);
  // En un teléfono bajo (9:16) la zona es más corta: el texto queda dentro.
  const bajo = { ancho: 360, alto: 640 };
  const zonaBaja = zonaLibre({ cabecera: CABECERA, bordeDelChat: 321 });
  const alli = colocar(guardada, bajo, zonaBaja, PILDORA, 0);
  assert.ok(alli.y + PILDORA.alto / 2 <= zonaBaja.abajo);
  assert.ok(alli.y - PILDORA.alto / 2 >= zonaBaja.arriba);
});

test('las fracciones no se salen de 0 a 1 y llevan cuatro decimales', () => {
  assert.deepEqual(aFracciones({ x: -20, y: 2000 }, LIENZO), { x: 0, y: 1 });
  assert.deepEqual(aFracciones({ x: 120, y: 260 }, LIENZO), { x: 0.3333, y: 0.3333 });
  // Sin lienzo medido no se divide por cero.
  assert.deepEqual(aFracciones({ x: 1, y: 1 }, { ancho: 0, alto: 0 }), { x: 0.5, y: 0.5 });
});

/* ------------------------------------------------------------ el imán -- */

test('a menos de 8 puntos del centro se engancha; a 8, no', () => {
  assert.equal(IMAN_PX, 8);
  const guiaY = centroDeLaZona(ZONA).y;
  const dentro = iman({ x: 180 + 7.9, y: guiaY - 7.9 }, PILDORA, 0, ZONA, LIENZO);
  assert.deepEqual(dentro, { centro: { x: 180, y: guiaY }, vertical: true, horizontal: true });
  const fuera = iman({ x: 188, y: guiaY + 8 }, PILDORA, 0, ZONA, LIENZO);
  assert.deepEqual(fuera, { centro: { x: 188, y: guiaY + 8 }, vertical: false, horizontal: false });
});

test('la guía vertical es el centro de la PANTALLA aunque la zona no esté centrada', () => {
  const torcida = { izquierda: 30, derecha: 348, arriba: 80, abajo: 453 };
  const r = iman({ x: 184, y: 200 }, PILDORA, 0, torcida, LIENZO);
  assert.equal(r.centro.x, 180);
  assert.equal(r.vertical, true);
});

test('el imán no saca el texto de la zona', () => {
  // Una píldora que solo cabe pegada a la derecha no se puede llevar al centro.
  const ancha = { ancho: 320, alto: 34 };
  const zonaEstrecha = { izquierda: 20, derecha: 348, arriba: 80, abajo: 453 };
  const pegada = limitar({ x: 999, y: 200 }, ancha, 0, zonaEstrecha);
  const r = iman(pegada, ancha, 0, zonaEstrecha, LIENZO);
  assert.equal(r.vertical, false);
  assert.deepEqual(r.centro, pegada);
});

/* ----------------------------------------------------- tamaño y giro -- */

test('el tamaño va de 70 a 240 %, de cinco en cinco', () => {
  assert.equal(ajustarTamano(100 * 1.13), 115);
  assert.equal(ajustarTamano(100 * 1.12), 110);
  assert.equal(ajustarTamano(20), 70);
  assert.equal(ajustarTamano(999), 240);
  assert.equal(ajustarTamano(Number.NaN), 100);
  for (let pellizco = 0.1; pellizco < 4; pellizco += 0.07) {
    const t = ajustarTamano(100 * pellizco);
    assert.ok(t >= 70 && t <= 240 && t % 5 === 0, String(t));
  }
});

test('el giro se endereza a menos de 5° y se queda entre -180 y 180', () => {
  assert.equal(IMAN_GRADOS, 5);
  assert.deepEqual(ajustarGiro(4.9), { giro: 0, iman: true });
  assert.deepEqual(ajustarGiro(-4.9), { giro: 0, iman: true });
  assert.deepEqual(ajustarGiro(5.2), { giro: 5, iman: false });
  assert.deepEqual(ajustarGiro(-37.6), { giro: -38, iman: false });
  // Una vuelta y media es media vuelta; 365° es casi recto.
  assert.equal(Math.abs(ajustarGiro(540).giro), 180);
  assert.deepEqual(ajustarGiro(362), { giro: 0, iman: true });
  assert.deepEqual(ajustarGiro(190), { giro: -170, iman: false });
});

test('los pasos de giro de la hoja no se pasan de media vuelta', () => {
  assert.equal(pasoDeGiro(0, 5), 5);
  assert.equal(pasoDeGiro(178, 5), 180);
  assert.equal(pasoDeGiro(-178, -5), -180);
  assert.equal(pasoDeGiro(12.4, -5), 7);
});

test('al 100 % la píldora mide lo que medía el rótulo de antes', () => {
  assert.deepEqual(medidasDeLaPildora(100), {
    letra: 13,
    linea: 18.2,
    rellenoHorizontal: 12,
    rellenoVertical: 7,
    altoMinimo: 34,
    separacion: 4,
    icono: 14,
  });
  // Y todo crece a la vez: al 200 % es el doble.
  assert.equal(medidasDeLaPildora(200).letra, 26);
});

test('la cinta solo corre si el texto no cabe en lo que deja la píldora', () => {
  // 336 de ancho: 12 + 12 de relleno, 14 de icono, 4 de separación y 2 de borde.
  assert.equal(huecoParaElTexto(336, 100), 292);
  assert.ok(huecoParaElTexto(336, 240) < huecoParaElTexto(336, 100));
  assert.equal(huecoParaElTexto(10, 240), 0);
});

/* -------------------------------------------------------- la papelera -- */

test('la papelera va arriba en el centro, a la altura de la cabecera', () => {
  assert.deepEqual(papeleraEn(LIENZO, CABECERA), { x: 180, y: 50 });
});

test('cuenta el DEDO sobre la papelera, con su radio', () => {
  assert.equal(RADIO_DE_LA_PAPELERA, 46);
  const papelera = { x: 180, y: 50 };
  assert.equal(enLaPapelera({ x: 180, y: 95 }, papelera), true);
  assert.equal(enLaPapelera({ x: 180, y: 96 }, papelera), false);
  assert.equal(enLaPapelera({ x: 214, y: 80 }, papelera), true);
});

test('quien agarra un texto por la punta lo sigue llevando por la punta', () => {
  // Tocado en la punta derecha de una píldora recta: 100 a la derecha del centro.
  assert.deepEqual(desfaseDelDedo({ x: 200, y: 17 }, PILDORA, 0), { x: 100, y: 0 });
  // Girada 90°, esa punta queda 100 por debajo del centro.
  const girada = desfaseDelDedo({ x: 200, y: 17 }, PILDORA, 90);
  cerca(girada.x, 0, 1e-9);
  cerca(girada.y, 100, 1e-9);
});

test('en el teléfono el dedo es el centro más el toque local girado con el texto', () => {
  // La vista que se arrastra: la píldora de 200 × 34 con 12 de aire por lado.
  const caja = { ancho: 224, alto: 58 };
  const base = { web: false, caja, toqueAbsoluto: { x: -1, y: -1 }, origenDeLaCapa: null };
  // Recto, tocado en la punta derecha de la píldora: 100 a la derecha del centro.
  assert.deepEqual(
    dedoAlEmpezar({ ...base, centro: { x: 180, y: 300 }, giro: 0, toqueLocal: { x: 212, y: 29 } }),
    { x: 280, y: 300 },
  );
  // Girado 40°: esa punta queda girada 40° alrededor del centro.
  const a = (40 * Math.PI) / 180;
  const girado = dedoAlEmpezar({ ...base, centro: { x: 180, y: 300 }, giro: 40, toqueLocal: { x: 212, y: 29 } });
  cerca(girado.x, 180 + 100 * Math.cos(a), 1e-9);
  cerca(girado.y, 300 + 100 * Math.sin(a), 1e-9);
});

test('en la web el dedo sale del toque en la ventana, gire lo que gire el texto', () => {
  // gesture-handler en la web divide el toque local por el coseno del giro:
  // a 40° lo da un 30 % más lejos, a 90° infinito. No se usa.
  const caja = { ancho: 300, alto: 70 };
  for (const giro of [0, 40, 90, -135]) {
    const dedo = dedoAlEmpezar({
      web: true,
      centro: { x: 180, y: 300 },
      caja,
      giro,
      toqueLocal: { x: Number.POSITIVE_INFINITY, y: Number.NaN },
      toqueAbsoluto: { x: 250, y: 410 },
      origenDeLaCapa: { x: 10, y: 60 },
    });
    assert.deepEqual(dedo, { x: 240, y: 350 }, `giro ${giro}`);
  }
  // Sin saber dónde empieza la capa, la cuenta del teléfono.
  const sinOrigen = dedoAlEmpezar({
    web: true,
    centro: { x: 180, y: 300 },
    caja,
    giro: 0,
    toqueLocal: { x: 150, y: 35 },
    toqueAbsoluto: { x: 0, y: 0 },
    origenDeLaCapa: null,
  });
  assert.deepEqual(sinOrigen, { x: 180, y: 300 });
});

test('recto, las dos cuentas dan el mismo dedo', () => {
  const caja = { ancho: 224, alto: 58 };
  // La capa empieza en (0, 47) de la ventana; el texto, centrado en (180, 300).
  const telefono = dedoAlEmpezar({
    web: false, centro: { x: 180, y: 300 }, caja, giro: 0,
    toqueLocal: { x: 60, y: 20 }, toqueAbsoluto: { x: 0, y: 0 }, origenDeLaCapa: null,
  });
  // En la ventana, la esquina de la vista está en (180 − 112, 300 − 29 + 47).
  const web = dedoAlEmpezar({
    web: true, centro: { x: 180, y: 300 }, caja, giro: 0,
    toqueLocal: { x: 60, y: 20 }, toqueAbsoluto: { x: 68 + 60, y: 318 + 20 }, origenDeLaCapa: { x: 0, y: 47 },
  });
  assert.deepEqual(web, telefono);
});

/* ------------------------------------------------- la hoja de editar -- */

test('si la hoja lo tapa, sube lo justo; si no, no se mueve', () => {
  // Centro en 400, la hoja empieza en 380: el borde de abajo (417) tiene que
  // quedar 12 por encima de 380 → sube 49.
  assert.equal(cuantoSube({ centroY: 400, medida: PILDORA, giro: 0, techoDeLaHoja: 380 }), 49);
  assert.equal(cuantoSube({ centroY: 100, medida: PILDORA, giro: 0, techoDeLaHoja: 380 }), 0);
});

test('nunca sube tanto que se meta bajo la barra de estado', () => {
  assert.equal(TECHO_AL_SUBIR, 32);
  // Con la hoja casi arriba, se queda con el borde de arriba en 32.
  const sube = cuantoSube({ centroY: 300, medida: PILDORA, giro: 0, techoDeLaHoja: 60 });
  assert.equal(300 - 17 - sube, 32);
});

/* ---------------------------------------------- lo que ve la sala -- */

test('la sala ve entrar un rótulo nuevo, deslizarse uno movido y nada si solo cambia el color', () => {
  assert.equal(DURACION_DEL_DESLIZ_MS, 250);
  const sitio = { x: 0.5, y: 0.3, tamano: 100, giro: 0 };
  assert.equal(comoCambia(null, { clave: 'a', disposicion: sitio }), 'entra');
  assert.equal(comoCambia({ clave: 'a', disposicion: sitio }, { clave: 'b', disposicion: sitio }), 'entra');
  assert.equal(
    comoCambia({ clave: 'a', disposicion: sitio }, { clave: 'a', disposicion: { ...sitio, y: 0.6 } }),
    'desliza',
  );
  assert.equal(
    comoCambia({ clave: 'a', disposicion: sitio }, { clave: 'a', disposicion: { ...sitio, tamano: 150 } }),
    'desliza',
  );
  assert.equal(
    comoCambia({ clave: 'a', disposicion: sitio }, { clave: 'a', disposicion: { ...sitio, giro: -12 } }),
    'desliza',
  );
  assert.equal(comoCambia({ clave: 'a', disposicion: sitio }, { clave: 'a', disposicion: { ...sitio } }), 'nada');
});
