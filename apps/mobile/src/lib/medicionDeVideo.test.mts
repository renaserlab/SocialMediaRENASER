import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  crearMedicion,
  MS_MAXIMO,
  TOPE_DE_EVENTOS,
  VENTANA_DEL_GESTO_MS,
  type DependenciasDeMedicion,
  type LoteDeMedicion,
} from './medicionDeVideo.ts';

/*
  La medicion de video corre en el telefono de quien usa la app. Lo que se
  custodia aqui es justo lo que no puede fallar: que mida lo que dice, que
  mande UNA sola vez, que respete el tope y el muestreo, y que un fallo de red
  (o de lo que sea) no llegue nunca a la interfaz.
*/

const CONTEXTO = {
  plataforma: 'ios' as const,
  version_app: '1.2.4',
  build: 'embebido',
  modelo: 'iPhone 13',
  sistema: 'iOS 18.1',
  red: null,
};

/** Un telefono de mentira: reloj a mano, temporizador a mano, envio grabado. */
function banco(extra: Partial<DependenciasDeMedicion> = {}) {
  let reloj = 1_000;
  const enviados: string[] = [];
  const temporizadores: Array<{ accion: () => void; ms: number }> = [];
  let empezadas = 0;
  const medicion = crearMedicion({
    ahora: () => reloj,
    origen: 1_000,
    azar: () => 0.5,
    contexto: () => CONTEXTO,
    enviar: (cuerpo) => {
      enviados.push(cuerpo);
    },
    programar: (accion, ms) => {
      temporizadores.push({ accion, ms });
    },
    alEmpezar: () => {
      empezadas += 1;
    },
    ...extra,
  });
  return {
    medicion,
    enviados,
    temporizadores,
    empezadas: () => empezadas,
    avanzar: (ms: number) => {
      reloj += ms;
    },
    lote: (i = 0) => JSON.parse(enviados[i]!) as LoteDeMedicion,
  };
}

test('mide la primera carga de Inicio de punta a punta', () => {
  const b = banco();
  const m = b.medicion;
  b.avanzar(400);
  m.hito('feed_pedido');
  b.avanzar(600);
  m.hito('feed_respuesta');
  b.avanzar(200);
  m.hito('urls_firmadas');
  m.videoActivo('v1', { hls: false, bytes: 2_500_000 });
  b.avanzar(900);
  m.primerFotograma('v1');
  b.avanzar(100);
  m.reproduciendo('v1');
  m.aSegundoPlano();

  const lote = b.lote();
  assert.deepEqual(lote.hitos, {
    feed_pedido: 400,
    feed_respuesta: 1_000,
    urls_firmadas: 1_200,
    primer_fotograma: 2_100,
    primera_reproduccion: 2_200,
  });
  assert.equal(lote.tramos.length, 1);
  assert.deepEqual(lote.tramos[0], {
    tipo: 'primer_video',
    hasta_reproducir_ms: 1_000,
    hasta_fotograma_ms: 900,
    esperas: 0,
    espera_ms: 0,
    formato: 'mp4',
    bytes: 2_500_000,
    error: false,
  });
  assert.equal(lote.sesion.length, 16);
  assert.deepEqual(lote.contexto, CONTEXTO);
});

test('deslizar mide desde el GESTO hasta que el siguiente reproduce, con sus esperas', () => {
  const b = banco();
  const m = b.medicion;
  m.videoActivo('v1', { hls: true });
  m.reproduciendo('v1');
  b.avanzar(5_000);
  m.inicioDeGesto();
  b.avanzar(250);
  m.videoActivo('v2', { hls: true, bytes: 999 });
  b.avanzar(650);
  m.reproduciendo('v2');
  // Se queda sin datos dos veces despues de arrancar.
  b.avanzar(1_000);
  m.estado('v2', 'loading');
  b.avanzar(300);
  m.reproduciendo('v2');
  b.avanzar(1_000);
  m.estado('v2', 'loading');
  b.avanzar(200);
  m.estado('v2', 'readyToPlay');
  m.reproduciendo('v2');
  m.aSegundoPlano();

  const [, segundo] = b.lote().tramos;
  assert.equal(segundo!.tipo, 'deslizamiento');
  assert.equal(segundo!.hasta_reproducir_ms, 900);
  assert.equal(segundo!.esperas, 2);
  assert.equal(segundo!.espera_ms, 500);
  assert.equal(segundo!.formato, 'hls');
  // Un HLS no tiene un archivo que pesar: el peso se descarta.
  assert.equal(segundo!.bytes, null);
});

test('la carga inicial NO cuenta como espera, y un gesto viejo no es un deslizamiento', () => {
  const b = banco();
  const m = b.medicion;
  m.videoActivo('v1', { hls: false });
  m.estado('v1', 'loading');
  m.reproduciendo('v1');
  m.inicioDeGesto();
  b.avanzar(VENTANA_DEL_GESTO_MS + 1);
  m.videoActivo('v2', { hls: false });
  m.aSegundoPlano();
  const [primero, segundo] = b.lote().tramos;
  assert.equal(primero!.esperas, 0);
  assert.equal(segundo!.tipo, 'otro');
  // Nunca llego a reproducir: queda `null`, no un cero que mentiria.
  assert.equal(segundo!.hasta_reproducir_ms, null);
});

test('los avisos de un reproductor que no es el activo se ignoran (el vecino precargado)', () => {
  const b = banco();
  const m = b.medicion;
  m.videoActivo('v1', { hls: false });
  b.avanzar(100);
  m.primerFotograma('v2');
  m.reproduciendo('v2');
  m.estado('v2', 'error');
  m.aSegundoPlano();
  const lote = b.lote();
  assert.equal(lote.tramos.length, 1);
  assert.equal(lote.tramos[0]!.hasta_reproducir_ms, null);
  assert.equal(lote.tramos[0]!.error, false);
  assert.equal(lote.hitos.primera_reproduccion, undefined);
});

test('los hitos van en orden: una respuesta sin peticion no cuenta, y cada uno vale una vez', () => {
  const b = banco();
  const m = b.medicion;
  m.hito('feed_respuesta'); // otra pantalla listando videos antes de Inicio
  m.hito('urls_firmadas');
  b.avanzar(100);
  m.hito('feed_pedido');
  b.avanzar(100);
  m.hito('feed_respuesta');
  b.avanzar(5_000);
  m.hito('feed_respuesta'); // la segunda pagina
  m.aSegundoPlano();
  assert.deepEqual(b.lote().hitos, { feed_pedido: 100, feed_respuesta: 200 });
});

test('envia UNA sola vez: segundo plano, temporizador y mas segundos planos no repiten', () => {
  const b = banco();
  const m = b.medicion;
  m.hito('feed_pedido');
  assert.equal(b.temporizadores.length, 1);
  assert.equal(b.temporizadores[0]!.ms, 60_000);
  m.aSegundoPlano();
  m.aSegundoPlano();
  b.temporizadores[0]!.accion();
  assert.equal(b.enviados.length, 1);
  assert.equal(m.enviado, true);
  // Y despues de enviar ya no se mide nada (ni se acumula memoria).
  m.videoActivo('v9', { hls: false });
  assert.equal(m.lote().tramos.length, 0);
});

test('el temporizador del minuto manda el lote si nadie sale antes', () => {
  const b = banco();
  b.medicion.hito('feed_pedido');
  b.temporizadores[0]!.accion();
  assert.equal(b.enviados.length, 1);
});

test('el temporizador y el oyente se ponen con la PRIMERA medicion, y una sola vez', () => {
  const b = banco();
  assert.equal(b.temporizadores.length, 0);
  assert.equal(b.empezadas(), 0);
  b.medicion.hito('feed_pedido');
  b.medicion.videoActivo('v1', { hls: false });
  b.medicion.videoActivo('v2', { hls: false });
  assert.equal(b.temporizadores.length, 1);
  assert.equal(b.empezadas(), 1);
});

test('sin nada medido no se manda nada', () => {
  const b = banco();
  b.medicion.aSegundoPlano();
  assert.equal(b.enviados.length, 0);
});

test('respeta el tope de tramos por sesion', () => {
  const b = banco();
  const m = b.medicion;
  for (let i = 0; i < TOPE_DE_EVENTOS + 15; i++) {
    m.inicioDeGesto();
    b.avanzar(10);
    m.videoActivo(`v${i}`, { hls: false });
    m.reproduciendo(`v${i}`);
  }
  m.aSegundoPlano();
  assert.equal(b.lote().tramos.length, TOPE_DE_EVENTOS);
});

test('el muestreo decide UNA vez por arranque: fuera de muestra no se mide ni se envia', () => {
  const fuera = banco({ muestreo: 0.1, azar: () => 0.5 });
  assert.equal(fuera.medicion.midiendo, false);
  fuera.medicion.hito('feed_pedido');
  fuera.medicion.videoActivo('v1', { hls: false });
  fuera.medicion.aSegundoPlano();
  assert.equal(fuera.enviados.length, 0);
  assert.equal(fuera.temporizadores.length, 0);

  const dentro = banco({ muestreo: 0.1, azar: () => 0.05 });
  assert.equal(dentro.medicion.midiendo, true);
});

test('el interruptor apaga todo', () => {
  const b = banco({ encendida: false });
  b.medicion.hito('feed_pedido');
  b.medicion.aSegundoPlano();
  assert.equal(b.enviados.length, 0);
  assert.equal(b.medicion.midiendo, false);
});

test('un fallo de red no rompe nada: ni el envio que lanza ni la promesa que se rechaza', async () => {
  const lanza = banco({
    enviar: () => {
      throw new Error('sin red');
    },
  });
  lanza.medicion.hito('feed_pedido');
  assert.doesNotThrow(() => lanza.medicion.aSegundoPlano());

  let rechazos = 0;
  const onRechazo = () => {
    rechazos += 1;
  };
  process.on('unhandledRejection', onRechazo);
  try {
    const rechaza = banco({ enviar: () => Promise.reject(new Error('timeout')) });
    rechaza.medicion.hito('feed_pedido');
    assert.doesNotThrow(() => rechaza.medicion.aSegundoPlano());
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(rechazos, 0);
    // Sin reintentos: ni se vuelve a intentar al salir otra vez.
    rechaza.medicion.aSegundoPlano();
    assert.equal(rechaza.medicion.enviado, true);
  } finally {
    process.off('unhandledRejection', onRechazo);
  }
});

test('un equipo que no se deja leer tampoco rompe nada', () => {
  const b = banco({
    contexto: () => {
      throw new Error('expo-device no esta');
    },
  });
  b.medicion.hito('feed_pedido');
  assert.doesNotThrow(() => b.medicion.aSegundoPlano());
  assert.equal(b.enviados.length, 0);
});

test('los valores fuera de rango no se mandan: Inicio abierto a los cinco minutos no es un hito', () => {
  const b = banco();
  b.avanzar(MS_MAXIMO + 1);
  b.medicion.hito('feed_pedido');
  b.medicion.videoActivo('v1', { hls: false, bytes: -5 });
  b.medicion.aSegundoPlano();
  const lote = b.lote();
  assert.equal(lote.hitos.feed_pedido, undefined);
  assert.equal(lote.tramos[0]!.bytes, null);
});

test('no hay datos personales en el lote: ni ids de publicacion ni de usuario', () => {
  const b = banco();
  b.medicion.hito('feed_pedido');
  b.medicion.videoActivo('7c0e4a52-1b1f-4f5e-9d9e-3a3b2f0c0d11', { hls: false });
  b.medicion.aSegundoPlano();
  assert.ok(!b.enviados[0]!.includes('7c0e4a52'));
  // Las claves son exactamente estas: no hay hueco por donde cuele nada mas.
  const lote = b.lote();
  assert.deepEqual(Object.keys(lote).sort(), ['contexto', 'hitos', 'sesion', 'tramos']);
  assert.deepEqual(Object.keys(lote.contexto).sort(), [
    'build',
    'modelo',
    'plataforma',
    'red',
    'sistema',
    'version_app',
  ]);
});

test('un lote tipico pesa pocos KB (30 tramos)', () => {
  const b = banco();
  const m = b.medicion;
  for (const h of ['feed_pedido', 'feed_respuesta', 'urls_firmadas'] as const) {
    b.avanzar(500);
    m.hito(h);
  }
  for (let i = 0; i < TOPE_DE_EVENTOS; i++) {
    m.inicioDeGesto();
    b.avanzar(812);
    m.videoActivo(`v${i}`, { hls: i % 2 === 0, bytes: 12_345_678 });
    m.primerFotograma(`v${i}`);
    m.reproduciendo(`v${i}`);
  }
  m.aSegundoPlano();
  const bytes = Buffer.byteLength(b.enviados[0]!, 'utf8');
  console.log(`  lote de ${TOPE_DE_EVENTOS} tramos: ${bytes} bytes`);
  assert.ok(bytes < 8_000, `el lote pesa ${bytes} bytes`);
});

/*
  CUSTODIA DE LA CONEXION. Lo de arriba prueba la logica; esto, que esta
  enganchada donde dice y que no cuesta un render.
*/
const leer = (ruta: string) =>
  readFileSync(new URL(ruta, import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

test('el reproductor nativo mide con playingChange y statusChange, sin estado de React', () => {
  const fuente = leer('../components/VideoPlayer.tsx');
  assert.match(fuente, /medicionDeVideo\.reproduciendo\(/);
  assert.match(fuente, /useEventListener\(player, 'statusChange'/);
  assert.match(fuente, /medicionDeVideo\.primerFotograma\(/);
  assert.match(fuente, /medicionDeVideo\.videoActivo\(/);
  assert.doesNotMatch(fuente, /useState[^;]*medici/i);
});

test('el feed de Inicio marca el gesto y enciende la medicion; los reels sueltos no', () => {
  const feed = leer('../components/FeedVerticalDeVideos.tsx');
  assert.match(feed, /onScrollBeginDrag=\{medicionDeVideo\.inicioDeGesto\}/);
  assert.match(feed, /\n\s+medir\n/);
  const reels = leer('../../app/reels.tsx');
  assert.doesNotMatch(reels, /medir/);
});

test('sin EXPO_PUBLIC_API_URL la medicion se apaga en lugar de llamar a localhost', () => {
  const app = leer('./medicionDeVideoEnApp.ts');
  assert.match(app, /const API = process\.env\.EXPO_PUBLIC_API_URL;/);
  assert.match(app, /encendida: MEDICION_ENCENDIDA && Boolean\(API\)/);
  assert.match(app, /keepalive: true/);
  assert.match(app, /ESPERA_DEL_ENVIO_MS/);
});
