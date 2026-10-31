import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fotos, videos y archivos del chat: que carguen rápido, que un video tenga
 * portada, que un archivo se descargue sin salir de la aplicación y que una
 * foto no lleve marco.
 *
 * LO QUE SE VIO EN TELÉFONO EL 12/10/2026, y la raíz de cada cosa:
 *
 *  - Las fotos tardaban en aparecer → el chat subía el original de la cámara
 *    (las publicaciones llevaban meses comprimiéndose; el chat, no) y cada
 *    apertura volvía a bajarlo, porque se guardaba en disco con la dirección
 *    firmada como clave y esa dirección cambia cada vez.
 *  - El video era un cuadro negro → nadie generaba su portada, y a la burbuja
 *    se le daba la dirección del video como si fuera una imagen.
 *  - El archivo se abría en Chrome → tocarlo abría su dirección firmada.
 *  - La foto llevaba un marco negro → iba dentro de la burbuja propia.
 *
 * Casi nada de esto se puede ejecutar aquí —son módulos del teléfono—, así que
 * se cuida sobre el TEXTO de los ficheros, como en el resto del chat: son los
 * cerrojos de decisiones cuya ruptura no daría ningún error, solo un chat más
 * lento. Lo que sí es lógica pura está en `lib/mediosDeChat.test.mts`.
 */

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
}

const ENVIO = fuente('services/messageMedia.ts');
const COPIAS = fuente('services/copiasDeChat.ts');
const REPOSITORIO = fuente('repositories/MessageRepository.ts');
const MEDIO = fuente('components/chat/MedioDeChat.tsx');
const ARCHIVO = fuente('components/chat/ArchivoDeChat.tsx');
const DESCARGA = fuente('services/descargarArchivo.ts');
const CHAT = fuente('screens/ChatScreen.tsx');
const PESTANAS = fuente('components/chat/PestanasDeContenido.tsx');

describe('antes de enviar', () => {
  const subir = ENVIO.slice(ENVIO.indexOf('export async function subirAdjunto('));

  it('una foto y un video se achican en el teléfono; un archivo no', () => {
    // Qué se comprime lo decide `seComprime`, que deja pasar tal cual lo que
    // se manda como «Archivo».
    assert.match(
      subir,
      /compressionAvailable && seComprime\(adjunto\.kind, adjunto\.mimeType, adjunto\.name\)/,
    );
    assert.match(subir, /await compressVideo\(adjunto\.uri, \(ratio\) => avisar\('comprimiendo', ratio\)\)/);
    assert.match(subir, /await compressImage\(adjunto\.uri\)/);
    // Lo que se sube es el resultado, no el original.
    assert.match(subir, /const local = await readLocalFile\(uri\);/);
  });

  it('si comprimir falla, se manda el original: no es condición para enviar', () => {
    assert.match(subir, /\} catch \{\s*uri = adjunto\.uri;\s*\}/);
  });

  it('el video sube su portada a su misma carpeta, antes que el video', () => {
    const portada = ENVIO.slice(ENVIO.indexOf('async function subirPortada('), ENVIO.indexOf('export async function subirAdjunto('));
    assert.match(portada, /\.from\(BUCKET\)\s*\.upload\(rutaDePortada\(rutaDelVideo\),/);
    assert.match(portada, /contentType: 'image\/jpeg'/);
    // Nunca tumba el envío.
    assert.match(portada, /\} catch \{\s*\/\/ Sin portada no se pierde el envío\.\s*\}/);
    assert.ok(
      subir.indexOf('await subirPortada(ruta, uri)') < subir.indexOf('uploadResumable({'),
      'La portada va antes: cuando alguien recibe el mensaje ya tiene que estar.',
    );
  });

  it('lo recién enviado se recuerda: la burbuja no lo vuelve a bajar', () => {
    assert.match(subir, /if \(adjunto\.kind === 'image' \|\| esVideo\) recordarCopia\(ruta, uri\);/);
  });

  it('la barra de envío recibe el avance de todo, comprimir incluido', () => {
    assert.match(subir, /ratio: avanceDelEnvio\(fase, ratio, comprime && esVideo\)/);
    assert.doesNotMatch(subir, /onProgress\?\.\(\{ phase: 'uploading', ratio \}\)/);
  });
});

describe('las firmas', () => {
  it('la portada de un video se firma en la misma llamada que el video', () => {
    assert.match(
      REPOSITORIO,
      /adjunto\.kind === 'video'\s*\? \[adjunto\.storagePath, rutaDePortada\(adjunto\.storagePath\)\]\s*: \[adjunto\.storagePath\]/,
    );
    assert.match(REPOSITORIO, /posterUrl:\s*adjunto\.kind === 'video' \? firmas\[rutaDePortada\(adjunto\.storagePath\)\] : undefined/);
    // En los dos sitios que traen mensajes: el chat y las pestañas de contenido.
    assert.equal([...REPOSITORIO.matchAll(/conFirmas\(/g)].length, 2);
  });

  it('una portada que no existe no se vuelve a pedir; un adjunto de verdad, sí', () => {
    // Los videos anteriores no la tienen: sin apuntarlo, cada página haría
    // una petición de más, para siempre.
    assert.match(ENVIO, /else if \(!portadasQueNoEstan\.has\(ruta\)\) faltan\.push\(ruta\);/);
    assert.match(ENVIO, /if \(!mapa\[ruta\] && esRutaDePortada\(ruta\)\) portadasQueNoEstan\.add\(ruta\);/);
    // Solo se apunta cuando el almacén CONTESTÓ: un corte de red no es «no existe».
    const firmar = ENVIO.slice(ENVIO.indexOf('export async function firmarAdjuntos('));
    assert.ok(firmar.indexOf('if (error || !data) return mapa;') < firmar.indexOf('portadasQueNoEstan.add(ruta)'));
  });

  it('al cerrar sesión no queda nada de la cuenta que se va', () => {
    assert.match(ENVIO, /firmas\.clear\(\);\s*portadasQueNoEstan\.clear\(\);\s*olvidarCopiasDeChat\(\);/);
    assert.match(COPIAS, /void ExpoImage\.clearDiskCache\(\)\.catch\(\(\) => \{\}\);/);
    assert.match(COPIAS, /void clearVideoPosters\(\);/);
  });
});

describe('cómo se pinta una foto o un video', () => {
  it('primero lo que ya está en el teléfono; si no, del disco, con la RUTA como clave', () => {
    assert.match(MEDIO, /const local = esVideo \? portadaGuardada\(clave\) : copiaDe\(ruta\);/);
    // La dirección firmada cambia en cada arranque: con ella de clave, la
    // misma foto se bajaba entera cada vez que se abría el chat.
    assert.match(MEDIO, /\? \{ uri: adjunto\.url, cacheKey: ruta \}/);
    assert.match(MEDIO, /\? \{ uri: adjunto\.posterUrl, cacheKey: rutaDePortada\(ruta\) \}/);
    assert.match(MEDIO, /cachePolicy="disk"/);
    assert.match(MEDIO, /fuente: local \? \{ uri: local \} : remota,/);
  });

  it('de un video se pinta su portada, nunca el video como si fuera una imagen', () => {
    // El fallo de origen: `<Image source={{ uri: adjunto.url }}>` con un video.
    assert.doesNotMatch(CHAT, /<Image source=\{\{ uri: adjunto\.url \}\}/);
    assert.match(MEDIO, /const hayQueSacarla = esVideo && !local && !remota && !!adjunto\.url;/);
    assert.match(MEDIO, /void generarPortada\(clave, origen\)\.then\(/);
  });

  it('sacar portadas va de dos en dos, cada video una vez, y nunca lanza', () => {
    assert.match(COPIAS, /const A_LA_VEZ = 2;/);
    assert.match(COPIAS, /const pendiente = enVuelo\.get\(rutaDelVideo\);\s*if \(pendiente\) return pendiente;/);
    assert.match(COPIAS, /\} catch \{\s*sinPortada\.add\(rutaDelVideo\);\s*return null;\s*\} finally \{\s*soltar\(\);/);
  });

  it('si la copia local ya no está, se pasa a la del servidor', () => {
    assert.match(MEDIO, /else descartarCopia\(ruta\);\s*repintar\(/);
    assert.match(MEDIO, /onError=\{alFallar\}/);
  });

  it('la celda reciclada no enseña la foto del mensaje anterior', () => {
    assert.match(MEDIO, /recyclingKey=\{adjunto\.id\}/);
  });

  it('el chat, lo elegido sin enviar y «Media» usan la misma pieza', () => {
    assert.match(CHAT, /<MedioDeChat adjunto=\{adjunto\} style=\{StyleSheet\.absoluteFill\}>/);
    assert.match(CHAT, /<MedioDeChat\s+compacto\s+style=\{styles\.previaImagen\}/);
    assert.equal([...PESTANAS.matchAll(/<MedioDeChat\b/g)].length, 2);
    assert.doesNotMatch(PESTANAS, /<Image source=/);
  });

  it('a pantalla completa se usa la misma clave de disco que en la burbuja', () => {
    const visor = fuente('components/chat/VisorDeAdjunto.tsx');
    assert.match(visor, /claveDeCache=\{/);
    assert.match(fuente('components/ImageViewer.tsx'), /source=\{claveDeCache \? \{ uri, cacheKey: claveDeCache \} : \{ uri \}\}/);
  });
});

describe('una foto sola va sin marco', () => {
  it('la burbuja se queda sin fondo, sin relleno y sin borde', () => {
    assert.match(CHAT, /const sinMarco = vaSinMarco\(\{/);
    assert.match(CHAT, /const sinFondo = comoSticker \|\| sinMarco;/);
    assert.match(CHAT, /backgroundColor: sinFondo\s*\? 'transparent'/);
    assert.match(CHAT, /sinMarco && styles\.bubbleSinMarco,/);
    assert.match(CHAT, /bubbleSinMarco: \{ paddingVertical: 0, paddingHorizontal: 0, borderWidth: 0 \}/);
  });

  it('la hora y el nombre van encima de la imagen, no en una franja aparte', () => {
    assert.match(CHAT, /\{indice === todos\.length - 1 && mostrarHora \? \(/);
    assert.match(CHAT, /\{mostrarHora && !sinMarco \? \(/);
  });

  it('mantener presionada la foto abre el menú: ya no hay franja debajo', () => {
    const pintar = CHAT.slice(CHAT.indexOf('const pintarAdjunto = ('));
    assert.match(pintar, /const alMantener = contexto\.conAcciones\s*\? \(\) => abrirAcciones\(contexto\.mensaje\)\s*: undefined;/);
    assert.match(pintar, /onLongPress=\{alMantener\}\s*delayLongPress=\{400\}/);
  });

  it('con texto la burbuja se queda y la foto la llena con un marco fino', () => {
    assert.match(CHAT, /const alRas =\s*!sinMarco && !item\.eliminado && soloLlevaMedios\(item\.attachments\);/);
    assert.match(CHAT, /adjuntosAlRas: \{ marginHorizontal: -\(RELLENO_H - MARCO_FINO\) \}/);
    assert.match(CHAT, /const MARCO_FINO = 3;/);
  });
});

describe('un archivo se descarga dentro de la aplicación', () => {
  it('el botón de descargar va AL LADO, no dentro de la fila', () => {
    // En la web cada zona que se toca es un botón, y un botón dentro de otro
    // es HTML inválido.
    const fila = ARCHIVO.slice(ARCHIVO.indexOf('<View style={[styles.fila, style]} pointerEvents="box-none">'));
    assert.ok(fila.length < ARCHIVO.length, 'la fila del archivo sin nombre tiene que existir');
    const cierreDeLaFila = fila.indexOf('</Pulsable>');
    const boton = fila.indexOf("<Feather name={hecho ? 'check' : 'download'}");
    assert.ok(cierreDeLaFila > 0 && boton > cierreDeLaFila);
  });

  it('antes del selector de carpetas, se explica', () => {
    assert.match(ARCHIVO, /if \(await hayQueElegirCarpeta\(adjunto\.mimeType, adjunto\.fileName\)\) \{\s*const seguir = await confirm\(\{/);
    assert.match(ARCHIVO, /if \(!seguir\) return;/);
  });

  it('enseña el avance, y no deja lanzar dos descargas del mismo archivo', () => {
    assert.match(ARCHIVO, /if \(!disponible \|\| !adjunto\.url \|\| enCurso\.current\) return;/);
    assert.match(ARCHIVO, /t\('chat\.downloading', \{ porcentaje: Math\.round\(\(avance \?\? 0\) \* 100\) \}\)/);
    assert.match(ARCHIVO, /\} finally \{\s*enCurso\.current = false;\s*setAvance\(null\);/);
  });

  it('una foto o un video van a la galería; lo demás, a la carpeta elegida', () => {
    assert.match(DESCARGA, /if \(destinoDeDescarga\(mimeType, pedido\.nombre\) === 'galeria'\) \{/);
    assert.match(DESCARGA, /await MediaLibrary\.saveToLibraryAsync\(temporal\);/);
    assert.match(DESCARGA, /destino\.createFile\(nombre, tipo\)\.write\(contenido\);/);
  });

  it('la carpeta se pide ANTES de bajar nada, y se recuerda', () => {
    const android = DESCARGA.slice(DESCARGA.indexOf('// --- Lo demás, en Android'));
    assert.ok(android.indexOf('await elegirCarpeta()') < android.indexOf('temporal = await bajar('));
    assert.match(DESCARGA, /await AsyncStorage\.setItem\(CLAVE_DE_CARPETA, elegida\.uri\)/);
  });

  it('lo muy grande se rechaza antes de intentarlo', () => {
    const android = DESCARGA.slice(DESCARGA.indexOf('// --- Lo demás, en Android'));
    assert.ok(android.indexOf("if (!cabeEnLaCarpeta(bytes)) return { estado: 'demasiado_grande' };") < android.indexOf('temporal = await bajar('));
  });

  it('la copia temporal se borra siempre, también si algo falla', () => {
    assert.match(DESCARGA, /\} finally \{\s*await borrar\(temporal\);\s*\}/);
  });

  it('las pestañas de contenido descargan igual: nada se abre fuera', () => {
    assert.equal([...PESTANAS.matchAll(/<ArchivoDeChat\b/g)].length, 2);
    assert.doesNotMatch(PESTANAS, /abrirArchivo/);
  });
});

/*
  Recortar una foto antes de enviarla (12/10/2026).

  Pedido: «recorte de fotos en chats para mayor personalización». El recorte es
  el del TELÉFONO: no hay biblioteca de edición instalada, y lo que se vigila
  aquí es que la opción exista, que no rompa la de elegir varias y que una foto
  recortada siga el mismo camino que cualquier otra.
*/
describe('Recortar una foto antes de enviarla', () => {
  const funcion = ENVIO.slice(
    ENVIO.indexOf('export async function elegirFotoRecortada('),
    ENVIO.indexOf('export async function hacerFoto('),
  );

  it('abre el recortador del teléfono con UNA foto', () => {
    assert.ok(funcion.length > 0, 'no está elegirFotoRecortada');
    assert.match(funcion, /mediaTypes: \['images'\],\s*allowsEditing: true,/);
    // Elegir varias y recortar se excluyen: con las dos, el sistema no recorta.
    assert.doesNotMatch(funcion, /allowsMultipleSelection|selectionLimit/);
    // Un video no pasa por aquí.
    assert.doesNotMatch(funcion, /'videos'/);
  });

  it('un permiso denegado se explica, igual que en las otras opciones', () => {
    assert.match(funcion, /if \(!permiso\.granted\) throw new PermisoDenegadoError\(AVISO_FOTOS\);/);
    assert.match(funcion, /if \(resultado\.canceled\) return null;/);
  });

  it('la foto recortada es un adjunto como cualquier otro: se achica y se sube igual', () => {
    assert.match(funcion, /return asset \? desdeAsset\(asset\) : null;/);
  });

  it('«Fotos y videos» sigue dejando elegir varias, sin recorte', () => {
    const varias = ENVIO.slice(
      ENVIO.indexOf('export async function elegirFotosOVideos('),
      ENVIO.indexOf('export async function elegirFotoRecortada('),
    );
    assert.match(varias, /allowsMultipleSelection: maximo > 1,/);
    assert.doesNotMatch(varias, /allowsEditing:/);
  });

  it('está en el menú de adjuntar, aparte y con su explicación', () => {
    const menu = CHAT.slice(
      CHAT.indexOf('<BottomSheet visible={menuAbierto}'),
      CHAT.indexOf('{/* El menú de acciones de una burbuja. */}'),
    );
    assert.match(
      menu,
      /title=\{t\('chat\.cropPhoto'\)\}\s*subtitle=\{t\('chat\.cropPhotoHint'\)\}\s*leftIcon="crop"\s*onPress=\{\(\) => void elegirCon\(elegirFotoRecortada\)\}/,
    );
    // Las cuatro opciones, en este orden.
    const orden = ['chat.photosAndVideos', 'chat.cropPhoto', 'chat.camera', 'chat.file'].map((clave) =>
      menu.indexOf(`t('${clave}')`),
    );
    assert.ok(orden.every((posicion) => posicion >= 0), 'falta una opción del menú');
    assert.deepEqual([...orden].sort((a, b) => a - b), orden);
  });

  it('tiene sus textos en los tres idiomas', () => {
    for (const idioma of ['es', 'en', 'pt']) {
      const diccionario = fuente(`i18n/${idioma}.ts`);
      for (const clave of ['chat.cropPhoto', 'chat.cropPhotoHint']) {
        assert.ok(diccionario.includes(`'${clave}':`), `${idioma}: falta ${clave}`);
      }
    }
  });
});
