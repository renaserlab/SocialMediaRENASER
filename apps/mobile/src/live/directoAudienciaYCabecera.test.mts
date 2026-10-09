import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { compartirDirecto, enlaceDeDirecto, rutaInternaDe } from '../lib/enlaces.ts';
import { estiloDeEmoji, lineaDeEmoji } from '../lib/lineaDeEmoji.ts';
import {
  ESPERA_ENTRE_INFORMES_MS,
  audienciaLegible,
  claveDeInvitado,
  contarAudiencia,
  tocaInformarDelPico,
  topicoDeAudiencia,
} from './audiencia.ts';

/**
 * EL DIRECTO, COMO SE PIDIÓ EL 07/10/2026 («Z bugs y nuevas funcionalidades»).
 *
 * Dos fallos y seis ajustes de la sala:
 *
 *   · los emojis de las reacciones salían cortados;
 *   · al terminar la emisión, quien miraba se quedaba ante una pantalla negra;
 *   · se veían ocho o nueve comentarios y deben verse cuatro;
 *   · el título baja junto al chat; arriba van la foto y el nombre de quien
 *     emite, con «Seguir» para quien mira;
 *   · a la izquierda de «EN VIVO», el ojo con las personas que están viendo;
 *   · cortar la emisión se distingue de un vistazo;
 *   · se puede compartir la sala con su enlace.
 *
 * Las cuentas se EJECUTAN. Lo que es de pantalla se comprueba sobre el código;
 * cómo queda en un teléfono solo se ve en un teléfono.
 */

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (codigo: string) =>
  codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const PANTALLA = sinComentarios(fuente('screens/LiveScreen.tsx'));
const CABECERA = sinComentarios(fuente('components/live/CabeceraDeDirecto.tsx'));
const FIN = sinComentarios(fuente('components/live/FinDeDirecto.tsx'));
const CHAT = sinComentarios(fuente('components/live/ChatDeDirecto.tsx'));
const REACCIONES = sinComentarios(fuente('components/live/ReaccionesDeDirecto.tsx'));
const SERVICIO = sinComentarios(fuente('services/directoEnVivo.ts'));
const GANCHO = sinComentarios(fuente('hooks/useAudienciaDeDirecto.ts'));

describe('cuánta gente está viendo', () => {
  it('cuenta personas, no teléfonos, y no cuenta a quien emite', () => {
    const presencia = { ana: [{}], luis: [{}, {}], anfitrion: [{}] };
    assert.equal(contarAudiencia(presencia, 'anfitrion'), 2);
    assert.equal(contarAudiencia(presencia, null), 3);
  });

  it('sin lista no hay nadie', () => {
    assert.equal(contarAudiencia(null, 'a'), 0);
    assert.equal(contarAudiencia(undefined, 'a'), 0);
    assert.equal(contarAudiencia({}, 'a'), 0);
  });

  it('el tópico es el mismo en todos los teléfonos de la sala', () => {
    assert.equal(topicoDeAudiencia('abc'), 'live-audiencia:abc');
    assert.equal(topicoDeAudiencia('abc'), topicoDeAudiencia('abc'));
    assert.notEqual(topicoDeAudiencia('abc'), topicoDeAudiencia('abd'));
  });

  it('quien mira sin cuenta tiene una clave propia, que no choca con un identificador', () => {
    assert.match(claveDeInvitado(() => 0.5), /^invitado-[0-9a-z]+$/);
    assert.notEqual(claveDeInvitado(() => 0.1), claveDeInvitado(() => 0.9));
  });

  it('el número no cambia el ancho de la cabecera con cada persona', () => {
    assert.equal(audienciaLegible(0), '0');
    assert.equal(audienciaLegible(7), '7');
    assert.equal(audienciaLegible(999), '999');
    assert.equal(audienciaLegible(1000), '1 mil');
    assert.equal(audienciaLegible(1250), '1,2 mil');
    assert.equal(audienciaLegible(34_900), '34,9 mil');
    assert.equal(audienciaLegible(2_300_000), '2,3 M');
    assert.equal(audienciaLegible(-4), '0');
    assert.equal(audienciaLegible(Number.NaN), '0');
  });

  it('el pico se informa solo cuando sube, y dejando pasar un rato', () => {
    const base = { ultimoInformado: 10, ahora: 100_000, ultimoInformeEn: 100_000 - ESPERA_ENTRE_INFORMES_MS };
    assert.equal(tocaInformarDelPico({ ...base, viendo: 11 }), true);
    assert.equal(tocaInformarDelPico({ ...base, viendo: 10 }), false, 'igual que lo informado');
    assert.equal(tocaInformarDelPico({ ...base, viendo: 4 }), false, 'una bajada no le dice nada al servidor');
    assert.equal(
      tocaInformarDelPico({ ...base, viendo: 11, ultimoInformeEn: 100_000 - 1_000 }),
      false,
      'hace un segundo que se informó',
    );
    assert.equal(tocaInformarDelPico({ viendo: 1, ultimoInformado: 0, ahora: 5, ultimoInformeEn: null }), true);
  });

  it('el canal es de PRESENCIA, con la persona como clave, y se apunta cada vez que se suscribe', () => {
    const seguir = SERVICIO.slice(SERVICIO.indexOf('export function seguirAudiencia'));
    assert.match(seguir, /cliente\.channel\(topico, \{ config: \{ presence: \{ key: clave \} \} \}\)/);
    assert.match(seguir, /\.on\('presence', \{ event: 'sync' \}/);
    assert.match(seguir, /if \(estado === 'SUBSCRIBED' && vigente\) void canal\.track\(/);
    // Sin contador en el tópico: aquí el tópico ES la sala.
    assert.ok(!/secuencia/.test(seguir.slice(0, seguir.indexOf('export type AvisosDelChat'))));
  });

  it('solo quien EMITE informa del pico, no quien puede gestionar', () => {
    assert.match(GANCHO, /const esAnfitrion = miId !== null && miId === anfitrionId;/);
    assert.match(GANCHO, /LiveRepository\.reportarEspectadores\(emisionId, viendo\)/);
  });

  it('sin saber cuántos hay no se pinta el ojo', () => {
    assert.match(CABECERA, /\{enDirecto && viendo !== null \? \(/);
    assert.match(CABECERA, /<Feather name="eye"/);
    assert.match(CABECERA, /audienciaLegible\(viendo\)/);
  });
});

describe('la cabecera: quién emite, y seguirle', () => {
  it('arriba van la foto y el nombre; el título ya no', () => {
    assert.match(CABECERA, /<Avatar size=\{36\} image=\{emision\.anfitrionAvatarUrl\} name=\{emision\.anfitrionNombre\} \/>/);
    assert.ok(!/emision\.titulo/.test(CABECERA));
    assert.match(PANTALLA, /<CabeceraDeDirecto/);
  });

  it('el ojo va ANTES de la insignia: a la izquierda de «EN VIVO»', () => {
    assert.ok(CABECERA.indexOf('name="eye"') < CABECERA.indexOf('{insignia}'));
  });

  it('«Seguir» solo para quien mira, y solo si se sabe que no le sigue', () => {
    assert.match(CABECERA, /if \(esMio \|\| loSigue !== false\) return null;/);
    assert.match(CABECERA, /requireAuth\('auth\.reasonFollow'/);
    assert.match(CABECERA, /await ProfileRepository\.follow\(emision\.anfitrionId\);/);
  });

  it('si el servidor dice que no, se deshace y se avisa', () => {
    const seguir = CABECERA.slice(CABECERA.indexOf('const seguir = useCallback'));
    assert.match(seguir, /catch \{\s*setLoSigue\(false\);\s*alFallar\(t\('live\.followFailed'\)\);/);
  });
});

describe('el chat enseña cuatro comentarios', () => {
  it('la pantalla pide filas, no puntos', () => {
    assert.match(PANTALLA, /const COMENTARIOS_A_LA_VISTA = 4;/);
    assert.match(PANTALLA, /const altoDelChat = altoDelChatPara\(COMENTARIOS_A_LA_VISTA\);/);
    assert.ok(!/PARTE_DEL_CHAT|ALTO_MAXIMO_DEL_CHAT/.test(PANTALLA));
  });

  it('lo que mide una fila sale de los mismos números que sus estilos', () => {
    assert.match(CHAT, /paddingVertical: AIRE_DE_LA_FILA,/);
    assert.match(CHAT, /paddingVertical: RELLENO_DEL_GLOBO,/);
    assert.match(CHAT, /const ALTO_DE_UNA_FILA = LINEA_DEL_TEXTO \+ RELLENO_DEL_GLOBO \* 2 \+ AIRE_DE_LA_FILA \* 2;/);
  });

  it('la línea que se cuenta es la del texto del comentario', () => {
    // `secondary` en `components/Text.tsx`: es la variante con la que se pinta.
    const texto = fuente('components/Text.tsx');
    const secundario = /secondary: \{([\s\S]*?)\}/.exec(texto)?.[1] ?? '';
    assert.match(secundario, /lineHeight: 18\.2,/);
    assert.match(CHAT, /const LINEA_DEL_TEXTO = 18\.2;/);
  });
});

describe('el tema del directo va abajo, entre el chat y las reacciones', () => {
  it('se pinta después del chat y antes de las reacciones', () => {
    const cuerpo = PANTALLA.slice(PANTALLA.indexOf('<SinTecladoDelante style={estilos.columna}>'));
    const chat = cuerpo.indexOf('<ChatDeDirecto');
    const tema = cuerpo.indexOf('<TemaDeDirecto titulo={emision.titulo} />');
    const reacciones = cuerpo.indexOf('<ReaccionesDeDirecto');
    assert.ok(chat > 0 && tema > chat && reacciones > tema);
  });

  it('se distingue de los comentarios y no se pega a nada', () => {
    const tema = /\n {2}tema: \{([\s\S]*?)\n {2}\},/.exec(PANTALLA)?.[1] ?? '';
    assert.match(tema, /backgroundColor: 'rgba\(255,255,255,0\.94\)'/, 'en claro: los comentarios van sobre velo oscuro');
    assert.match(tema, /marginTop: spacing\.md,/);
    assert.match(tema, /marginBottom: spacing\.sm,/);
    assert.match(tema, /maxWidth: '88%'/);
  });

  it('sin título no se pinta un recuadro vacío', () => {
    assert.match(PANTALLA, /const texto = titulo\.trim\(\);\s*if \(!texto\) return null;/);
  });
});

describe('cortar la emisión se distingue de un vistazo', () => {
  it('es el único botón relleno de la sala, con icono y palabra', () => {
    const boton = PANTALLA.slice(PANTALLA.indexOf('function BotonDeTerminar'), PANTALLA.indexOf('function TemaDeDirecto'));
    // El relleno es el rojo que aguanta letra blanca (`rellenoDePeligro`), no
    // el rojo claro de la paleta oscura: ver `rellenoDePeligro.test.mts`.
    assert.match(boton, /backgroundColor: rellenoDePeligro\.fondo/);
    assert.match(boton, /<Feather name="square"/);
    assert.match(boton, /accessibilityLabel=\{etiqueta\}/);
  });

  it('sigue pasando por la máquina, que es quien confirma', () => {
    assert.match(PANTALLA, /<BotonDeTerminar[\s\S]*?alPulsar=\{terminar\}/);
    assert.match(PANTALLA, /const terminar = useCallback\(\(\) => void sesion\.terminar\(\), \[sesion\]\);/);
  });
});

describe('compartir la sala', () => {
  it('el enlace lleva a ESE directo', () => {
    process.env.EXPO_PUBLIC_WEB_URL = 'https://z.example';
    assert.equal(enlaceDeDirecto('abc-123'), 'https://z.example/live/abc-123');
    const { message, url } = compartirDirecto({ emisionId: 'abc-123', anfitrion: 'Klein' });
    assert.equal(url, 'https://z.example/live/abc-123');
    assert.equal(message, 'Mira el directo de Klein en Z\nhttps://z.example/live/abc-123');
  });

  it('sin nombre la frase sigue leyéndose bien, y sin web no se inventa un dominio', () => {
    process.env.EXPO_PUBLIC_WEB_URL = 'https://z.example';
    assert.equal(compartirDirecto({ emisionId: 'a' }).message, 'Mira este directo en Z\nhttps://z.example/live/a');
    delete process.env.EXPO_PUBLIC_WEB_URL;
    assert.deepEqual(compartirDirecto({ emisionId: 'a', anfitrion: 'Klein' }), {
      message: 'Mira el directo de Klein en Z',
      url: null,
    });
  });

  it('un enlace de la propia web se abre dentro de la aplicación', () => {
    process.env.EXPO_PUBLIC_WEB_URL = 'https://z.example';
    assert.equal(rutaInternaDe('https://z.example/live/abc-123'), '/live/abc-123');
    assert.equal(rutaInternaDe('https://z.example/post/9f?ref=x'), '/post/9f');
    assert.equal(rutaInternaDe('https://z.example/live/abc/'), '/live/abc');
    // Lo que no es de la web de Z, o no se sabe abrir por ruta, sale al navegador.
    assert.equal(rutaInternaDe('https://meet.google.com/abc-defg-hij'), null);
    assert.equal(rutaInternaDe('https://z.example.evil.com/live/abc'), null);
    assert.equal(rutaInternaDe('https://z.example/admin'), null);
    assert.equal(rutaInternaDe('https://z.example/live/../admin'), null);
    delete process.env.EXPO_PUBLIC_WEB_URL;
    assert.equal(rutaInternaDe('https://z.example/live/abc'), null);
  });

  it('el botón está para quien emite y para quien mira, y solo en directo', () => {
    assert.match(PANTALLA, /\{enDirecto \? \(\s*<BotonDeControl\s*icono="share-2"/);
    assert.match(PANTALLA, /Share\.share\(\{ message \}\)\.catch\(/);
  });
});

describe('cuando el directo termina', () => {
  it('quien miraba ve un cartel que lo dice, no una pantalla negra', () => {
    assert.match(PANTALLA, /\{terminada \? \(\s*<FinDeDirecto/);
    assert.match(FIN, /t\('live\.endedViewerTitle'\)/);
    assert.match(FIN, /onPress=\{alIrAInicio\}/);
  });

  it('solo se vuelve solo si terminó delante de uno, y nunca a quien emitía', () => {
    assert.match(PANTALLA, /if \(anterior === 'live' && fila\.status === 'ended'\) setTerminoMirando\(true\);/);
    assert.match(PANTALLA, /volverSolo=\{terminoMirando && !puedeGestionar\}/);
  });

  it('la cuenta atrás se puede parar', () => {
    assert.match(FIN, /const contando = volverSolo && !seQueda;/);
    assert.match(FIN, /onPress=\{\(\) => setSeQueda\(true\)\}/);
    assert.match(FIN, /if \(restan <= 0\) \{\s*alIrAInicio\(\);/);
  });

  it('se vuelve a Inicio sin dejar la sala debajo', () => {
    assert.match(PANTALLA, /const irAInicio = useCallback\(\(\) => volverA\(router, '\/\(tabs\)\/home'\), \[router\]\);/);
  });
});

describe('los emojis no salen cortados', () => {
  it('la línea de un emoji es más alta que su tamaño de letra', () => {
    for (const tamano of [14, 20, 30, 48]) {
      assert.ok(lineaDeEmoji(tamano) >= tamano * 1.3, `${tamano}: ${lineaDeEmoji(tamano)}`);
      assert.deepEqual(estiloDeEmoji(tamano), { fontSize: tamano, lineHeight: lineaDeEmoji(tamano) });
    }
  });

  it('EL FALLO: heredaban la línea del cuerpo, 21,7, con una letra de 30', () => {
    const texto = fuente('components/Text.tsx');
    const cuerpo = /body: \{([\s\S]*?)\}/.exec(texto)?.[1] ?? '';
    assert.match(cuerpo, /lineHeight: 21\.7,/);
    assert.ok(lineaDeEmoji(30) > 21.7 && lineaDeEmoji(20) > 21.7);
  });

  it('las reacciones piden su línea, las dos', () => {
    assert.match(REACCIONES, /simbolo: estiloDeEmoji\(20\),/);
    assert.match(REACCIONES, /simboloGrande: estiloDeEmoji\(30\),/);
    assert.ok(!/simbolo(Grande)?: \{ fontSize/.test(REACCIONES));
  });
});

describe('los fondos de quien emite', () => {
  const FONDOS = fuente('live/fondosVirtuales.ts');
  const imagenes = [...FONDOS.matchAll(/require\('\.\.\/\.\.\/(assets\/live\/fondos\/[^']+)'\)/g)].map((m) => m[1] as string);
  const ids = [...FONDOS.matchAll(/\n {4}id: '([^']+)',/g)].map((m) => m[1] as string);

  it('hay pantalla verde y paisajes, además de los estudios', () => {
    for (const id of ['estudio-oscuro', 'estudio-claro', 'sala-gris', 'pantalla-verde', 'atardecer', 'montanas']) {
      assert.ok(ids.includes(id), `falta el fondo ${id}`);
    }
    assert.equal(new Set(ids).size, ids.length, 'un id no se reutiliza');
    assert.equal(imagenes.length, ids.length);
  });

  it('cada fondo trae su imagen, con nombre de recurso de Android', () => {
    for (const imagen of imagenes) {
      // Minúsculas y guion bajo: en Android la imagen se busca por su nombre.
      assert.match(imagen, /^assets\/live\/fondos\/[a-z_]+\.png$/, imagen);
      const datos = readFileSync(join(SRC, '..', imagen));
      assert.equal(datos.subarray(1, 4).toString('latin1'), 'PNG', imagen);
      // Verticales, como la cámara de quien emite.
      assert.ok(datos.readUInt32BE(20) > datos.readUInt32BE(16), `${imagen} no es vertical`);
    }
  });

  it('la pantalla verde es verde de croma, liso', () => {
    // Un PNG liso comprime a casi nada: si pesa, es que ya no es liso.
    const verde = readFileSync(join(SRC, '..', 'assets', 'live', 'fondos', 'pantalla_verde.png'));
    assert.ok(verde.length < 8 * 1024, `${verde.length} bytes`);
  });
});
