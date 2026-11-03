import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * QUE LA PANTALLA USE LO QUE ESTA PROBADO.
 *
 * Las reglas de las reacciones, del chat, de los efectos y de la calidad se
 * EJECUTAN en `reaccionesEnVivo.test.mts`, `burbujasYChat.test.mts`,
 * `efectosYCalidad.test.mts` y `directoEntreTresTelefonos.test.mts`. Lo que no
 * se puede ejecutar con `node --test` es un componente de React Native ni el
 * adaptador del SDK, y ahi queda la pregunta de siempre: ¿siguen llamando a
 * esas piezas, o alguien ha vuelto a escribir la logica dentro?
 *
 * Esta bateria mira el CODIGO FUENTE. No sustituye a las de comportamiento:
 * las custodia. Por eso cada comprobacion de aqui nombra el defecto concreto
 * que dejaria pasar si desapareciera.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');
const MOVIL = join(SRC, '..');

function fuente(rel: string): string {
  // CRLF fuera: en Windows el repositorio se descarga con `autocrlf`.
  return readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
}

/** Sin comentarios: lo que se comprueba es lo que se EJECUTA. */
function sinComentarios(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const SERVICIO = sinComentarios(fuente('services/directoEnVivo.ts'));
const PANTALLA = sinComentarios(fuente('screens/LiveScreen.tsx'));
const CHAT = sinComentarios(fuente('components/live/ChatDeDirecto.tsx'));
const REACCIONES = sinComentarios(fuente('components/live/ReaccionesDeDirecto.tsx'));
const HOJA_DE_EFECTOS = sinComentarios(fuente('components/live/HojaDeEfectos.tsx'));
const ADAPTADOR = sinComentarios(fuente('live/salaDeVideo100ms.ts'));
const HOOK = sinComentarios(fuente('hooks/useSesionDeDirecto.ts'));
const FONDOS = sinComentarios(fuente('live/fondosVirtuales.ts'));

describe('el topico de reacciones no vuelve a llevar nada local', () => {
  it('el servicio no escribe el topico: lo calcula el modulo probado', () => {
    assert.doesNotMatch(SERVICIO, /live-reacciones/, 'el topico se ha vuelto a escribir a mano');
    assert.match(SERVICIO, /crearCanalDeReacciones\(/);
  });

  it('el contador local solo aparece en canales de `postgres_changes`', () => {
    const usos = [...SERVICIO.matchAll(/`([^`]*)\$\{secuencia\}`/g)].map((m) => m[1]);
    assert.deepEqual(
      usos.sort(),
      ['live-chat:${emisionId}:', 'live-sala:${emisionId}:'],
      'el contador local ha entrado en un topico que no es de la base',
    );
  });

  it('hay UN transporte de Broadcast para todo el proceso', () => {
    // Es el transporte quien recuerda que canales hay y cuales se cierran. Uno
    // por pantalla volveria a dejar el canal muerto al remontar.
    assert.equal((SERVICIO.match(/crearTransporteDeRealtime\(/g) ?? []).length, 1);
    assert.match(SERVICIO, /^const transporte[^=]*=\s*supabase\s*\?\s*crearTransporteDeRealtime\(/m);
    // Con que programar: sin eso no se remonta un canal que cierre el servidor.
    assert.match(SERVICIO, /crearTransporteDeRealtime\([^)]*\{ programar \}\)/);
    const dentro = SERVICIO.slice(SERVICIO.indexOf('export function canalDeReacciones'));
    assert.doesNotMatch(dentro, /crearTransporteDeRealtime\(/);
  });

  it('el servicio no llama a `send` ni a `httpSend`: lo decide el transporte', () => {
    assert.doesNotMatch(SERVICIO, /\.(send|httpSend)\(/);
  });
});

describe('las reacciones en pantalla usan la pista y el canal probados', () => {
  it('la propia: burbuja, +1 y envio, una vez cada cosa', () => {
    const gesto = REACCIONES.slice(
      REACCIONES.indexOf('const reaccionar'),
      REACCIONES.indexOf('const quitar'),
    );
    assert.equal((gesto.match(/soltarPropia\(tipo\)/g) ?? []).length, 1);
    assert.equal((gesto.match(/sumarReacciones\(previos, \{ \[tipo\]: 1 \}\)/g) ?? []).length, 1);
    assert.equal((gesto.match(/\.enviar\(tipo\)/g) ?? []).length, 1);
  });

  it('la ajena entra por la pista, que es quien la cuenta: no se suma aparte', () => {
    assert.match(REACCIONES, /alRecibir\(\(conteos\) => \{\s*pista\.current\?\.recibir\(conteos\);\s*\}\)/);
    // Solo cuatro sitios cambian el contador: la ficha, el gesto propio, el tic
    // de la pista y la conciliacion. Un quinto seria contar algo dos veces.
    assert.equal((REACCIONES.match(/setTotales\(/g) ?? []).length, 4);
    assert.match(REACCIONES, /alSumar: \(conteos\) => setTotales\(\(previos\) => sumarReacciones\(previos, conteos\)\)/);
  });

  it('lo que contesta el servidor se concilia, no se suma', () => {
    assert.match(REACCIONES, /setTotales\(\(previos\) => conciliarConElServidor\(previos, delServidor\)\)/);
  });

  it('recargar la emision sustituye el contador por lo persistido', () => {
    assert.match(REACCIONES, /useEffect\(\(\) => \{\s*setTotales\(totalesDelServidor\);\s*\}, \[totalesDelServidor\]\)/);
    assert.match(PANTALLA, /totalesDelServidor=\{emision\.reacciones\}/);
  });

  it('al desmontar se cierra el canal y se destruye la pista', () => {
    assert.match(REACCIONES, /dejarDeEscuchar\(\);\s*abiertoAhora\.cerrar\(\);/);
    assert.match(REACCIONES, /nueva\.destruir\(\);/);
  });

  it('la sala de Broadcast sale del identificador que da el SERVIDOR, no de la ruta', () => {
    // REVISION 04/10. Un enlace con el identificador en mayusculas abria la
    // emision y el chat, pero caia en otro topico: otra vez cada uno en su sala.
    assert.match(PANTALLA, /<ReaccionesDeDirecto\s+emisionId=\{emision\.id\}/);
    assert.match(PANTALLA, /<ChatDeDirecto\s+ref=\{chat\}\s+emisionId=\{emision\.id\}/);
  });

  it('fuera de directo no se abre canal', () => {
    assert.match(REACCIONES, /if \(!emisionId \|\| !abierto\) return;/);
  });

  it('la pantalla del directo ya no lleva burbujas ni totales en su estado', () => {
    assert.doesNotMatch(PANTALLA, /setBurbujas|setTotales|canalDeReacciones\(/);
    assert.match(PANTALLA, /<ReaccionesDeDirecto/);
  });
});

describe('el chat es una lista virtualizada con ventana', () => {
  it('usa FlashList, con claves estables y fila memorizada', () => {
    assert.match(CHAT, /from '@shopify\/flash-list'/);
    assert.match(CHAT, /<FlashList/);
    assert.match(CHAT, /keyExtractor=\{claveDeMensaje\}/);
    assert.match(CHAT, /const claveDeMensaje = \(mensaje: MensajeDeEmision\) => mensaje\.id;/);
    assert.match(CHAT, /const FilaDeChat = React\.memo\(/);
  });

  it('no queda un ScrollView con un map sobre los mensajes, ni en el chat ni en la pantalla', () => {
    for (const [nombre, texto] of [
      ['el chat', CHAT],
      ['la pantalla', PANTALLA],
    ] as const) {
      assert.doesNotMatch(texto, /\bScrollView\b/, `${nombre} vuelve a usar ScrollView`);
      assert.doesNotMatch(texto, /visibles\.map\(|mensajes\.map\(/, `${nombre} pinta todas las filas`);
    }
  });

  it('las reglas del chat vienen del modulo probado, no del componente', () => {
    assert.match(CHAT, /crearChatEnVivo\(\{/);
    assert.doesNotMatch(CHAT, /new Map</, 'el mapa de autores ha vuelto al componente');
    assert.doesNotMatch(CHAT, /setTimeout\([^)]*cargar/, 'la recarga agrupada se ha reescrito aqui');
  });

  it('sigue el final sin arrastrar a quien lee, y ofrece los mensajes nuevos', () => {
    assert.match(CHAT, /maintainVisibleContentPosition=\{seguirElFinal\}/);
    assert.match(CHAT, /autoscrollToBottomThreshold/);
    assert.match(CHAT, /startRenderingFromBottom: true/);
    assert.match(CHAT, /seguimiento\.nuevos > 0/);
    assert.match(CHAT, /live\.newMessages/);
    // Al crecer la lista se sigue el final SOLO si la persona estaba al
    // final. Un `scrollToEnd` sin esa condicion es el defecto de antes:
    // arrastraba abajo a quien habia subido a leer.
    assert.match(CHAT, /onContentSizeChange=\{alCrecerLaLista\}/);
    assert.match(
      CHAT,
      /const alCrecerLaLista = useCallback\(\(\) => \{\s*if \(alFinal\.current\) listaRef\.current\?\.scrollToEnd\(/,
    );
    assert.match(CHAT, /alFinal\.current = distancia <= UMBRAL_DEL_FINAL;/);
    assert.doesNotMatch(CHAT, /onContentSizeChange=\{\(\) =>/, 'un scrollToEnd sin condicion');
  });

  it('con «reducir movimiento» no anima el desplazamiento', () => {
    assert.match(CHAT, /animateAutoScrollToBottom: !reduceMotion/);
    assert.match(CHAT, /scrollToEnd\(\{ animated: !reduceMotion \}\)/);
  });

  it('dice el estado del chat y deja reintentar', () => {
    assert.match(CHAT, /estadoDelChat\(\{/);
    for (const clave of ['live.chatConnecting', 'live.chatReconnecting', 'chat.loadFailed', 'live.retry']) {
      assert.ok(CHAT.includes(`'${clave}'`), `falta ${clave}`);
    }
  });

  it('al volver el canal pide una lectura, y al desmontar lo suelta todo', () => {
    assert.match(CHAT, /if \(seConectoAntes\.current\) enVivo\.volvioElCanal\(\);/);
    const limpieza = CHAT.slice(CHAT.indexOf('return () => {'));
    assert.match(limpieza, /dejarChat\(\);/);
    assert.match(limpieza, /avisosDeEsteChat\.cerrar\(\);/);
    assert.match(limpieza, /enVivo\.destruir\(\);/);
  });

  it('moderar avisa a los demas, que no lo reciben por la base', () => {
    // REVISION 04/10. La tabla solo entrega el cambio a quien modera y al
    // autor; sin el aviso, el mensaje se quedaba en la pantalla del publico.
    assert.match(CHAT, /avisosDelChat\(emisionId, \(\) => enVivo\.seModero\(\)\)/);
    const ocultar = CHAT.slice(CHAT.indexOf('const ocultar = useCallback'));
    const esconder = ocultar.indexOf('LiveRepository.ocultarMensaje(mensaje.id)');
    // La frase entera: el aviso SALE, y solo si no pudo salir se reintenta.
    const avisar = ocultar.indexOf('if (emisor && !emisor.avisar()) {');
    assert.ok(esconder >= 0, 'no se esconde en el servidor');
    assert.ok(avisar > esconder, 'no se avisa, o se avisa antes de que el servidor lo haya escondido');
    // El servicio no manda QUE esconder: el aviso no tiene autoridad.
    assert.match(SERVICIO, /avisar: \(\) => conexion\.enviar\(\{ v: 1 \}\)/);
    assert.match(SERVICIO, /alRecibir: \(\) => alAvisar\(\)/);
  });

  it('el chat, la sala y la audiencia no se quedan con un canal muerto si lo cierra el servidor', () => {
    // Tres desde el 07/10/2026: se añadió la presencia de quienes miran.
    assert.equal((SERVICIO.match(/mantenerSuscripcion\(\{/g) ?? []).length, 3);
  });

  it('moderar sigue siendo mantener pulsado, solo para quien puede', () => {
    assert.match(CHAT, /onLongPress=\{\(\) => alMantener\(mensaje\)\}/);
    assert.match(CHAT, /if \(!puedeModerar\) \{/);
    assert.match(CHAT, /accessibilityHint=\{pista\}/);
  });

  it('cada fila se lee entera: nombre y texto', () => {
    assert.match(CHAT, /const etiqueta = `\$\{mensaje\.usuarioNombre\}: \$\{mensaje\.cuerpo\}`;/);
    assert.equal((CHAT.match(/accessibilityLabel=\{etiqueta\}/g) ?? []).length, 2);
  });

  it('escribir no repinta la pantalla: el texto vive en su componente', () => {
    const pantalla = PANTALLA.slice(PANTALLA.indexOf('export function LiveScreen'));
    assert.doesNotMatch(pantalla, /setTexto\(|useState\(''\)/);
    assert.match(PANTALLA, /function EscribirEnElChat\(/);
  });
});

describe('los efectos son de la pista que sale, y solo de quien emite', () => {
  it('el adaptador usa el complemento de 100ms y las reglas probadas', () => {
    assert.match(ADAPTADOR, /new HMSVirtualBackgroundPlugin\(\)/);
    assert.match(ADAPTADOR, /crearGestorDeEfectos\(\{/);
    for (const verbo of ['complemento.enable()', 'complemento.disable()', 'complemento.setBlur(radio)']) {
      assert.ok(ADAPTADOR.includes(verbo), `falta ${verbo}`);
    }
    assert.match(ADAPTADOR, /complemento\.setBackground\(fondo\.imagen\)/);
  });

  it('en iOS el complemento se pasa al construir el SDK, que es donde lo lee', () => {
    assert.match(ADAPTADOR, /new HMSVideoTrackSettings\(\{ videoPlugin: complemento/);
    assert.match(ADAPTADOR, /HMSSDK\.build\(\{ trackSettings: ajustesDePista \}\)/);
  });

  it('quien solo mira no crea el complemento', () => {
    const preparar = ADAPTADOR.slice(
      ADAPTADOR.indexOf('private prepararEfectos'),
      ADAPTADOR.indexOf('private async reponerEfecto'),
    );
    assert.match(preparar, /if \(!publicar\) \{\s*this\.motivoSinEfectos = 'no_publica';\s*return undefined;/);
    assert.ok(
      preparar.indexOf("'no_publica'") < preparar.indexOf('new HMSVirtualBackgroundPlugin()'),
      'el complemento se crea antes de saber si esta persona publica',
    );
  });

  it('un fondo solo puede ser una imagen de la aplicacion', () => {
    assert.match(ADAPTADOR, /const fondo = fondoPorId\(fondoId\);/);
    assert.doesNotMatch(ADAPTADOR, /uri:|https?:\/\//, 'el adaptador acepta una direccion como fondo');
    assert.doesNotMatch(FONDOS, /uri:|https?:\/\//);
    const imagenes = [...FONDOS.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1] as string);
    assert.ok(imagenes.length >= 1);
    for (const ruta of imagenes) {
      // Minusculas y guion bajo: en Android la imagen se busca como recurso.
      assert.match(ruta, /^\.\.\/\.\.\/assets\/live\/fondos\/[a-z0-9_]+\.png$/);
      assert.ok(existsSync(join(MOVIL, ruta.replace('../../', ''))), `no existe ${ruta}`);
    }
  });

  it('al salir: PRIMERO se apaga la camara, luego se quita el efecto, luego se deja la sala', () => {
    /*
      REVISION 04/10. El orden era efecto -> camara -> sala: el desenfoque se
      quitaba con la camara todavia emitiendo, y quien miraba recibia el fondo
      real hasta que entraba el silencio. Comprobar solo que el efecto se quita
      «antes de dejar la sala» pasaba con ese orden.
    */
    const soltar = ADAPTADOR.slice(
      ADAPTADOR.indexOf('private async soltar'),
      ADAPTADOR.indexOf('async alternarCamara'),
    );
    const apagar = soltar.indexOf('this.silenciarEn(sdk)');
    const quitar = soltar.indexOf('apagarParaSalir()');
    const dejar = soltar.indexOf('sdk.leave()');
    assert.ok(apagar >= 0 && quitar >= 0 && dejar >= 0);
    assert.ok(apagar < quitar, 'el efecto se quita con la camara todavia encendida');
    assert.ok(quitar < dejar);
  });

  it('entrar suelta la instancia anterior ANTES de construir otra, y la que falla al entrar', () => {
    /*
      REVISION 04/10. La maquina reintenta llamando a `unirse` otra vez, sin
      `salir` antes. El complemento de efectos habla siempre con la instancia
      de identificador fijo del SDK; si la anterior sigue viva, la nueva recibe
      otro identificador y el efecto se aplicaria a una pista que ya no es la
      que sale. Y sin soltar, la anterior se queda con camara y microfono.
    */
    const entrar = ADAPTADOR.slice(
      ADAPTADOR.indexOf('private async entrar'),
      ADAPTADOR.indexOf('private async refrescarPistas'),
    );
    const soltarAnterior = entrar.indexOf('if (this.sdk) await this.salir();');
    const preguntar = entrar.indexOf('hayQueReponer()');
    const construir = entrar.indexOf('HMSSDK.build');
    assert.ok(soltarAnterior >= 0, 'no se suelta la instancia anterior');
    assert.ok(soltarAnterior < preguntar, 'se pregunta si hay que reponer antes de haber salido');
    assert.ok(preguntar < construir);
    // Un `join` que falla no deja la instancia viva.
    assert.match(entrar, /\} catch \(fallo\) \{\s*await this\.salir\(\);\s*throw fallo;/);
  });

  it('si la instancia del SDK no es la que conoce el complemento, no se ofrecen efectos', () => {
    assert.match(ADAPTADOR, /const ID_DEL_COMPLEMENTO = '12345';/);
    assert.match(ADAPTADOR, /this\.complementoAlcanzable = sdk\.id === ID_DEL_COMPLEMENTO;/);
    const capacidad = ADAPTADOR.slice(
      ADAPTADOR.indexOf('efectos(): CapacidadDeEfectos'),
      ADAPTADOR.indexOf('estadoDeEfectos(): EstadoDeEfectos'),
    );
    assert.match(capacidad, /this\.complementoAlcanzable/);
  });

  it('con un efecto por reponer la camara nace apagada y solo se enciende si el efecto volvio', () => {
    assert.match(ADAPTADOR, /initialState: HMSTrackSettingsInitState\.MUTED/);
    assert.match(ADAPTADOR, /camara: publicar && !reponer/);
    const reponer = ADAPTADOR.slice(
      ADAPTADOR.indexOf('private async reponerEfecto'),
      ADAPTADOR.indexOf('private async entrar'),
    );
    assert.match(reponer, /if \(estado\.error !== null \|\| estado\.efecto\.tipo === 'ninguno'\) return;/);
    assert.ok(reponer.indexOf('return;') < reponer.indexOf('alternarCamara(true)'));
  });

  it('cambiar de camara no toca el efecto', () => {
    const girar = ADAPTADOR.slice(
      ADAPTADOR.indexOf('async cambiarCamara'),
      ADAPTADOR.indexOf('medios(): EstadoDeMedios'),
    );
    assert.doesNotMatch(girar, /efectosDeLaSala|complemento/);
  });

  it('el control de efectos es de quien publica, y dice por que no esta cuando no esta', () => {
    // Los fondos o «Mejorar»: con cualquiera de los dos, el botón está vivo.
    assert.match(
      PANTALLA,
      /hayEfectos=\{efectos\.capacidad\.admitidos \|\| mejoras\.capacidad\.admitida\}/,
    );
    assert.match(PANTALLA, /if \(!vista\.puedePublicar\) return null;/);
    // Quien publica lo ve siempre; si este telefono no admite efectos sale
    // atenuado, y la hoja explica por que. Esconderlo dejaba esa explicacion
    // donde nadie podia llegar.
    assert.match(PANTALLA, /atenuado=\{!hayEfectos\}/);
    assert.doesNotMatch(PANTALLA, /\{hayEfectos \? \(/);
  });

  it('la hoja pinta lo que dice la sala: no importa el SDK ni decide nada', () => {
    assert.doesNotMatch(HOJA_DE_EFECTOS, /@100mslive|enable\(|setBlur\(/);
    assert.match(HOJA_DE_EFECTOS, /alElegir\(efecto\)/);
    // «Ninguno» se puede pulsar aunque se este aplicando otra cosa.
    assert.match(HOJA_DE_EFECTOS, /const apagada = estado\.aplicando && !siempre;/);
    assert.match(HOJA_DE_EFECTOS, /\{ tipo: 'ninguno' \},\s*t\('live\.effectNone'\),[\s\S]*?true,\s*\)/);
  });

  it('un efecto que se apaga solo se avisa aunque la hoja este cerrada', () => {
    assert.match(HOOK, /if \(evento\.estado\.error === 'se_apago'\) \{/);
    assert.match(HOOK, /live\.effectTurnedOff/);
  });
});

describe('la calidad sale del SDK, no de un boton', () => {
  it('«conexion lenta» se emite con la nota de red y la degradacion de pista', () => {
    assert.match(ADAPTADOR, /sdk\.enableNetworkQualityUpdates\(\)/);
    assert.match(ADAPTADOR, /HMSPeerUpdate\.NETWORK_QUALITY_UPDATED/);
    assert.match(ADAPTADOR, /this\.vigia\.nota\(dato\.peer\.networkQuality\?\.downlinkQuality\)/);
    assert.match(ADAPTADOR, /HMSTrackUpdate\.TRACK_DEGRADED/);
    assert.match(ADAPTADOR, /HMSTrackUpdate\.TRACK_RESTORED/);
    assert.match(ADAPTADOR, /this\.avisar\(\{ tipo: 'calidad', buena \}\)/);
    assert.match(HOOK, /maquina\.laSalaCambioDeCalidad\(evento\.buena\)/);
  });

  it('la nota de red no recalcula las pistas: llega una por participante', () => {
    const escuchar = ADAPTADOR.slice(ADAPTADOR.indexOf('private escuchar'));
    const rama = escuchar.slice(
      escuchar.indexOf('NETWORK_QUALITY_UPDATED'),
      escuchar.indexOf('HMSUpdateListenerActions.RECONNECTING'),
    );
    assert.ok(rama.indexOf('return;') < rama.indexOf('this.refrescarPistas()'));
  });

  it('las capas se leen y se fijan con la API del SDK, sin `any`', () => {
    assert.match(ADAPTADOR, /sdk\.getRemoteVideoTrackFromTrackId\(pistaId\)/);
    assert.match(ADAPTADOR, /pista\.getLayerDefinition\(\)/);
    assert.match(ADAPTADOR, /pista\.setLayer\(CAPA_DEL_SDK\[capa\]\)/);
    assert.match(ADAPTADOR, /autoSimulcast: capaAutomatica !== false/);
    assert.doesNotMatch(ADAPTADOR, /\bas any\b/, 'un `as any` puede esconder un metodo que no existe');
  });

  it('quien publica no tiene pista a la que pedirle capa', () => {
    assert.match(
      ADAPTADOR,
      /const principal = this\.estado\.publicando\s*\? null\s*: elegirPistaPrincipal\(video, \{ emito: false \}\);/,
    );
  });

  it('sin capas no hay boton de calidad, ni hoja', () => {
    assert.match(PANTALLA, /\{calidad\.estado\.opciones\.length > 0 \? \(/);
    assert.match(PANTALLA, /visible=\{hojaDeCalidad && calidad\.estado\.opciones\.length > 0\}/);
    assert.match(PANTALLA, /capaAutomatica=\{calidad\.estado\.elegida === 'automatica'\}/);
  });

  it('en ningun texto se promete «HD»', () => {
    for (const idioma of ['es', 'en', 'pt']) {
      const claves = [...fuente(`i18n/${idioma}.ts`).matchAll(/'live\.quality[A-Za-z]*':\s*\n?\s*'([^']*)'/g)];
      assert.ok(claves.length >= 8, `faltan claves de calidad en ${idioma}`);
      for (const [, texto] of claves) {
        assert.doesNotMatch(texto ?? '', /\bHD\b|1080|4K/i, `${idioma}: «${texto}»`);
      }
    }
  });
});

describe('web sigue sin SDK', () => {
  it('el registro de web no nombra ni el adaptador ni el complemento', () => {
    const web = sinComentarios(fuente('live/registro100ms.ts'));
    assert.doesNotMatch(web, /salaDeVideo100ms|@100mslive/);
  });

  it('la pantalla y las hojas no importan el adaptador', () => {
    for (const texto of [PANTALLA, CHAT, REACCIONES, HOJA_DE_EFECTOS, HOOK]) {
      assert.doesNotMatch(texto, /salaDeVideo100ms/);
    }
  });
});
