import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MARGEN_PEGADO_MINIMO,
  distanciaAlFinal,
  estaPegadoAlFinal,
  queHacerConLoUltimo,
} from '../lib/chatAlFinal.ts';
import { TECLADO_CERRADO, huecoDelMarco, huecoParaElTeclado } from '../lib/huecoDelTeclado.ts';
import {
  MARCA_DE_TONO,
  PAUSA_ENTRE_TONOS_MS,
  TONOS,
  datosDelTono,
  esUnTono,
  puedeSonar,
  suenaLoQueLlega,
} from '../lib/tonosDelChat.ts';

/**
 * EL CHAT, COMO SE VIO EN TELÉFONO EL 06/10/2026.
 *
 * Cinco cosas del documento «Z bugs y problemas de vistas»:
 *
 *   1. al abrir una conversación, a veces había que deslizar hasta el final;
 *   2. con el teclado abierto, el mensaje enviado —o el que llegaba— quedaba
 *      debajo del redactor;
 *   3. al cerrar el teclado quedaba un hueco donde había estado;
 *   4. no había sonido al enviar ni al recibir;
 *   5. no se encontraba cómo borrar una nota de voz antes de enviarla.
 *
 * La lógica se EJECUTA; lo que es de pantalla se comprueba sobre el código,
 * como el resto de baterías de esta carpeta.
 */

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const RAIZ = join(SRC, '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (codigo: string) =>
  codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const CHAT = sinComentarios(fuente('screens/ChatScreen.tsx'));

describe('la conversación sigue el último mensaje', () => {
  const pantalla = { desplazado: 0, alto: 600, contenido: 600 };

  it('lo que falta por ver nunca es negativo', () => {
    assert.equal(distanciaAlFinal({ desplazado: 400, alto: 600, contenido: 1000 }), 0);
    assert.equal(distanciaAlFinal({ desplazado: 100, alto: 600, contenido: 1000 }), 300);
    // El rebote de iOS desplaza más allá del final.
    assert.equal(distanciaAlFinal({ desplazado: 450, alto: 600, contenido: 1000 }), 0);
  });

  it('con pocos mensajes, o al final, se está abajo', () => {
    assert.ok(estaPegadoAlFinal(pantalla));
    assert.ok(estaPegadoAlFinal({ desplazado: 400, alto: 600, contenido: 1000 }));
    // Una burbuja nueva de 80 puntos por debajo no es «haber subido».
    assert.ok(estaPegadoAlFinal({ desplazado: 400, alto: 600, contenido: 1080 }));
    assert.ok(MARGEN_PEGADO_MINIMO >= 100);
  });

  it('quien sube a leer el historial deja de estar abajo', () => {
    assert.ok(!estaPegadoAlFinal({ desplazado: 0, alto: 600, contenido: 2000 }));
    assert.ok(!estaPegadoAlFinal({ desplazado: 900, alto: 600, contenido: 2000 }));
  });

  it('una lista sin medir no se da por «subida»', () => {
    assert.ok(estaPegadoAlFinal({ desplazado: 0, alto: 0, contenido: 0 }));
  });

  it('al abrirse, baja sin recorrido', () => {
    assert.equal(queHacerConLoUltimo({ antes: null, ahora: 'm9', mio: false, pegado: true }), 'bajar-sin-animar');
  });

  it('lo propio baja SIEMPRE, aunque se estuviera leyendo arriba', () => {
    assert.equal(queHacerConLoUltimo({ antes: 'm9', ahora: 'tmp', mio: true, pegado: false }), 'bajar');
  });

  it('lo ajeno baja si se estaba abajo, y si no, se avisa', () => {
    assert.equal(queHacerConLoUltimo({ antes: 'm9', ahora: 'm10', mio: false, pegado: true }), 'bajar');
    assert.equal(queHacerConLoUltimo({ antes: 'm9', ahora: 'm10', mio: false, pegado: false }), 'avisar');
  });

  it('cargar historial —lo último no cambia— no mueve nada', () => {
    assert.equal(queHacerConLoUltimo({ antes: 'm9', ahora: 'm9', mio: false, pegado: true }), 'nada');
    assert.equal(queHacerConLoUltimo({ antes: null, ahora: null, mio: false, pegado: true }), 'nada');
  });

  it('la pantalla lo cablea: referencia, medidas y el botón de ir a lo último', () => {
    assert.match(CHAT, /<FlashList\s+ref=\{lista\}/);
    assert.match(CHAT, /onScroll=\{alDesplazar\}/);
    assert.match(CHAT, /onContentSizeChange=\{alCrecerElContenido\}/);
    // La zona de los mensajes lleva además el fondo que eligió la persona.
    assert.match(
      CHAT,
      /<View\s+style=\{\[\s*styles\.zonaDeMensajes,[\s\S]{0,200}?\]\}\s*onLayout=\{alMedirLaLista\}\s*>/,
    );
    // El botón solo existe cuando se ha subido, y va a lo último.
    assert.match(CHAT, /\{lejosDelFinal \? \(\s*<Pulsable\s+onPress=\{\(\) => bajarAlFinal\(true\)\}/);
    assert.match(CHAT, /accessibilityLabel=\{t\('chat\.goToLatest'\)\}/);
  });

  it('que el teclado encoja la lista no cuenta como haber subido', () => {
    // El alto a la vista cambia: si se estaba abajo, se sigue abajo…
    assert.match(
      CHAT,
      /if \(antes > 0 && Math\.abs\(alto - antes\) > 1 && pegadoAlFinal\.current\) bajarAlFinal\(false\);/,
    );
    // …y un desplazamiento que llega con otro alto no reescribe «pegado».
    const oyente = CHAT.slice(CHAT.indexOf('const alDesplazar ='), CHAT.indexOf('return (', CHAT.indexOf('const alDesplazar =')));
    const salida = oyente.indexOf('return;');
    const reescritura = oyente.indexOf('pegadoAlFinal.current = abajo;');
    assert.ok(salida > 0 && reescritura > salida, 'el cambio de alto tiene que salir ANTES de recalcular.');
  });

  it('pedir historial al llegar arriba sigue como estaba', () => {
    assert.match(CHAT, /if \(contentOffset\.y <= 24\) cargarMasHistorial\(\);/);
  });

  it('el texto del botón está en los tres idiomas', () => {
    for (const idioma of ['es', 'en', 'pt']) {
      assert.match(fuente(`i18n/${idioma}.ts`), /'chat\.goToLatest': '[^']{5,}'/, idioma);
    }
  });
});

describe('el teclado no deja hueco al cerrarse', () => {
  const APARTADO = sinComentarios(fuente('components/SinTecladoDelante.tsx'));

  it('el hueco es lo que el marco baja por debajo del teclado, y nunca negativo', () => {
    assert.equal(huecoParaElTeclado(800, 500), 300);
    assert.equal(huecoParaElTeclado(800, 800), 0);
    assert.equal(huecoParaElTeclado(800, 900), 0);
    assert.equal(huecoParaElTeclado(800.4, 500), 300);
    assert.equal(huecoParaElTeclado(Number.NaN, 500), 0);
  });

  it('en Android ya no se usa el componente que se quedaba encogido', () => {
    /*
      `KeyboardAvoidingView` con `height` hacía, al OCULTARSE el teclado, la
      misma resta que al mostrarse, con un dato que en una ventana de borde a
      borde no incluye las barras del sistema: se quedaba encogido.
    */
    assert.ok(!/android: 'height'/.test(APARTADO), 'vuelve el `height` de Android.');
    assert.match(APARTADO, /Platform\.OS === 'android' \? \(\s*<ApartadoEnAndroid/);
  });

  it('sin teclado el hueco es cero, sin hacer ninguna cuenta', () => {
    // Ya no hay un hueco GUARDADO que poner a cero al ocultarse: se deriva de
    // lo que se sabe del teclado, y con el teclado cerrado no hay nada que
    // restar. De ahí salía el que se quedaba puesto.
    assert.equal(huecoDelMarco(800, TECLADO_CERRADO), 0);
    assert.match(APARTADO, /const hueco = enabled \? huecoDelMarco\(bordeInferior, teclado\) : 0;/);
    assert.ok(!/setHueco\(/.test(APARTADO), 'vuelve a guardarse el hueco en vez de derivarse');
  });

  it('el hueco es relleno: el marco no cambia de tamaño al apartarse', () => {
    assert.match(APARTADO, /relleno !== null \? \{ paddingBottom: relleno \} : null/);
    assert.match(APARTADO, /collapsable=\{false\}/);
    assert.ok(!/height: /.test(APARTADO));
  });

  it('en iOS sigue como estaba', () => {
    assert.match(APARTADO, /behavior=\{Platform\.OS === 'ios' \? 'padding' : undefined\}/);
    assert.match(APARTADO, /keyboardVerticalOffset=\{0\}/);
  });
});

describe('borrar una nota de voz antes de enviarla', () => {
  const BOTON = sinComentarios(fuente('components/BotonDeNotaDeVoz.tsx'));

  it('la barra de la nota va DENTRO del redactor, no flotando sobre los mensajes', () => {
    const aviso = /\n {2}aviso: \{[\s\S]*?\n {2}\}/.exec(BOTON)?.[0] ?? '';
    assert.ok(aviso.length > 0);
    assert.ok(!/position: 'absolute'/.test(aviso), 'la barra vuelve a flotar fuera del redactor.');
    assert.ok(!/bottom: '100%'/.test(aviso));
    assert.match(aviso, /flex: 1/);
  });

  it('la papelera es lo primero de la barra, grabando y en la previa', () => {
    const grabando = BOTON.slice(BOTON.indexOf("{fase === 'grabando' ? ("), BOTON.indexOf('{enPrevia ? ('));
    assert.ok(grabando.indexOf('onPress={cancelar}') > 0);
    assert.ok(grabando.indexOf('onPress={cancelar}') < grabando.indexOf('<PuntoQueLate'));

    const previa = BOTON.slice(BOTON.indexOf('{enPrevia ? ('), BOTON.indexOf("{fase === 'enviando' ? ("));
    assert.ok(previa.indexOf('onPress={eliminar}') > 0);
    assert.ok(previa.indexOf('onPress={eliminar}') < previa.indexOf("t('chat.playRecording')"));
    assert.match(previa, /accessibilityLabel=\{t\('chat\.deleteRecording'\)\}/);
    assert.equal(BOTON.match(/name="trash-2"/g)?.length, 2);
  });

  it('con una nota en marcha el «+» y el campo se apartan: la fila es de la grabadora', () => {
    assert.equal(CHAT.match(/\{grabadora\.ocupada \? null : \(/g)?.length, 2);
    assert.ok(!/grabadora\.ocupada \? \(\s*<View style=\{styles\.inputContainer\} \/>/.test(CHAT));
  });

  it('lo que hace cada botón no ha cambiado', () => {
    assert.match(CHAT, /cancelar=\{\(\) => void grabadora\.cancelar\(\)\}/);
    assert.match(CHAT, /eliminar=\{\(\) => grabadora\.eliminar\(\)\}/);
    assert.match(CHAT, /enviar=\{\(\) => void grabadora\.enviar\(\)\}/);
  });
});

describe('los tonos del chat', () => {
  const AVISOS = sinComentarios(fuente('services/notifications.ts'));

  it('cada tono tiene su fichero dentro de la compilación', () => {
    const app = JSON.parse(readFileSync(join(RAIZ, 'app.json'), 'utf8')) as {
      expo: { plugins: (string | [string, { sounds?: string[] }])[] };
    };
    const avisos = app.expo.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-notifications');
    const sonidos = (Array.isArray(avisos) ? avisos[1].sounds : undefined) ?? [];
    for (const tono of Object.values(TONOS)) {
      // Android los empaqueta como recursos: minúsculas, cifras y guion bajo.
      assert.match(tono.fichero, /^[a-z0-9_]+\.wav$/);
      const ruta = `./assets/sonidos/${tono.fichero}`;
      assert.ok(sonidos.includes(ruta), `${ruta} no está en \`sounds\` de app.json`);
      assert.ok(existsSync(join(RAIZ, ruta)), `${ruta} no existe`);
      // Un tono, no una canción: por debajo de 64 KB.
      assert.ok(statSync(join(RAIZ, ruta)).size < 64 * 1024);
    }
  });

  it('un tono se distingue de un aviso de verdad', () => {
    assert.ok(esUnTono(datosDelTono('enviado')));
    assert.ok(esUnTono(datosDelTono('recibido')));
    assert.ok(!esUnTono({ type: 'message', conversationId: 'c1' }));
    assert.ok(!esUnTono({ [MARCA_DE_TONO]: 'otro' }));
    assert.ok(!esUnTono(null));
    assert.ok(!esUnTono('enviado'));
  });

  it('una ráfaga es un sonido, no cinco', () => {
    assert.ok(puedeSonar(1000, undefined));
    assert.ok(!puedeSonar(1000 + PAUSA_ENTRE_TONOS_MS - 1, 1000));
    assert.ok(puedeSonar(1000 + PAUSA_ENTRE_TONOS_MS, 1000));
  });

  it('«recibido» suena solo con lo ajeno, nuevo, de verdad y a la vista', () => {
    const base = { antes: 'm9', ahora: 'm10', mio: false, seEstaMirando: true };
    assert.ok(suenaLoQueLlega(base));
    assert.ok(!suenaLoQueLlega({ ...base, mio: true }));
    assert.ok(!suenaLoQueLlega({ ...base, seEstaMirando: false }));
    // La carga inicial no es una novedad.
    assert.ok(!suenaLoQueLlega({ ...base, antes: null }));
    assert.ok(!suenaLoQueLlega({ ...base, ahora: 'm9' }));
    // La tarjeta de una sesión que se pinta al final no es un mensaje.
    assert.ok(!suenaLoQueLlega({ ...base, ahora: 'sesion:abc' }));
  });

  it('suena y no se enseña: ni tira, ni lista, ni globo', () => {
    assert.match(
      AVISOS,
      /if \(esUnTono\(notificacion\.request\.content\.data\)\) \{\s*return \{\s*shouldShowBanner: false,\s*shouldShowList: false,\s*shouldPlaySound: true,\s*shouldSetBadge: false,\s*\};/,
    );
  });

  it('sin su canal no suena: no se cuela el sonido por defecto del teléfono', () => {
    const sonar = AVISOS.slice(AVISOS.indexOf('export async function sonarTono'), AVISOS.indexOf('export async function requestNotificationPermission'));
    assert.match(sonar, /if \(!\(await prepararTonos\(\)\)\) return;/);
    assert.ok(sonar.indexOf('prepararTonos()') < sonar.indexOf('scheduleNotificationAsync'));
    assert.match(sonar, /trigger: Platform\.OS === 'android' \? \{ channelId: TONOS\[cual\]\.canal \} : null/);
    assert.match(sonar, /if \(Platform\.OS === 'web'\) return;/);
    // Y nunca lanza.
    assert.match(sonar, /try \{[\s\S]*\} catch \{/);
  });

  it('el aviso flotante y los contadores no se enteran de un tono', () => {
    const oyente = sinComentarios(fuente('hooks/useAvisosDelPush.native.ts'));
    assert.ok(oyente.indexOf('if (esUnTono(data)) return;') > 0);
    assert.ok(oyente.indexOf('if (esUnTono(data)) return;') < oyente.indexOf('hayMensajeNuevoEn(conversacion)'));
  });

  it('«enviado» suena cuando el servidor lo ha guardado, no al tocar', () => {
    const enviar = CHAT.slice(CHAT.indexOf('const enviar = useCallback('), CHAT.indexOf('const mandar = useCallback('));
    assert.ok(enviar.indexOf("sonarTono('enviado')") > enviar.indexOf('reconciliarEnvio('));
    assert.ok(enviar.indexOf("sonarTono('enviado')") < enviar.indexOf('} catch (error) {'));
    assert.equal(CHAT.match(/sonarTono\('enviado'\)/g)?.length, 1);
    assert.equal(CHAT.match(/sonarTono\('recibido'\)/g)?.length, 1);
  });

  it('no toca la sesión de audio de la aplicación', () => {
    // La música de otra aplicación y las notas de voz no se enteran.
    for (const fichero of ['lib/tonosDelChat.ts', 'services/notifications.ts']) {
      assert.ok(!/setAudioModeAsync|createAudioPlayer|useAudioPlayer/.test(fuente(fichero)), fichero);
    }
  });
});
