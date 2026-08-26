/**
 * Que los adjuntos de un chat privado no acaben siendo publicos.
 *
 * ESTO NO SE PUEDE PROBAR EJECUTANDOLO. El modulo importa `expo-image-picker` y
 * `expo-document-picker`, que solo existen dentro de la aplicacion, y lo que de
 * verdad decide la privacidad —la politica RLS del bucket— vive en PostgreSQL.
 * Asi que se comprueba sobre el TEXTO del fichero, igual que hace
 * `storage.test.mts`: no es una prueba de comportamiento, es un cerrojo sobre
 * las tres o cuatro decisiones cuya ruptura no daria ningun error.
 *
 * Y ese es exactamente el problema con esto: si alguien cambia el bucket o le
 * da la vuelta a la ruta, TODO seguiria compilando, la aplicacion seguiria
 * funcionando, las fotos se seguirian viendo... y estarian legibles por quien
 * no debe. Un fallo de privacidad no se manifiesta como un fallo.
 *
 * Se ejecutan con `npm run test` (el runner de Node, sin dependencias).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FUENTE = readFileSync(
  fileURLToPath(new URL('./messageMedia.ts', import.meta.url)),
  'utf8',
);

describe('el bucket', () => {
  it('es el privado, no el de las publicaciones', () => {
    // `post-media` deja leer a cualquier cuenta autenticada, y desde la 0018 sus
    // imagenes y videos incluso SIN cuenta. Una foto mandada por privado ahi
    // seria legible por todo el que tenga la aplicacion instalada.
    assert.ok(
      /const BUCKET = 'message-media'/.test(FUENTE),
      'El bucket de los adjuntos de chat tiene que ser message-media.',
    );
    assert.equal(
      FUENTE.includes("'post-media'"),
      false,
      'Los adjuntos privados no pueden tocar el bucket de las publicaciones.',
    );
  });
});

describe('la ruta lleva el permiso', () => {
  it('la conversacion va PRIMERO y la persona despues', () => {
    // Storage no puede consultar la tabla de adjuntos: solo sabe del nombre del
    // objeto. La politica lee la PRIMERA carpeta para comprobar la pertenencia
    // a la conversacion, y la segunda para exigir que cada uno escriba bajo su
    // propio identificador. Darle la vuelta a los dos segmentos no rompe nada
    // visible y deja la politica comprobando lo que no es.
    assert.ok(
      /\$\{conversationId\}\/\$\{uid\}\//.test(FUENTE),
      'La ruta tiene que ser <conversacion>/<quien sube>/<fichero>.',
    );
  });

  it('el identificador de quien sube sale de la sesion, no de quien llama', () => {
    // Si el uid viniera por parametro, cualquier pantalla podria mandar el de
    // otra persona y el archivo quedaria colgado de una carpeta ajena.
    assert.ok(
      /const uid = sesion\?\.user\?\.id/.test(FUENTE),
      'El uid tiene que salir de la sesion de Supabase.',
    );
  });
});

describe('las firmas', () => {
  it('no se guardan en disco', () => {
    // Las del muro si se guardan, para que el feed salga al instante al
    // reabrir. Una firma de un adjunto PRIVADO guardada en disco es un enlace a
    // contenido privado que sobrevive al cierre de sesion.
    assert.equal(
      FUENTE.includes('AsyncStorage'),
      false,
      'Las firmas de adjuntos privados no pueden persistir en el dispositivo.',
    );
  });

  it('se pueden olvidar al cerrar sesion', () => {
    assert.ok(FUENTE.includes('export function olvidarFirmasDeAdjuntos'));
  });

  it('una lista vacia no pide firmas', () => {
    // Pedir una firma de nada devuelve un error que no significa nada, y ademas
    // es una peticion de red por cada repintado de un chat sin adjuntos.
    assert.ok(
      /rutas\.length === 0\) return \{\}/.test(FUENTE),
      'Sin rutas no se debe llamar a createSignedUrls.',
    );
  });
});

describe('la subida', () => {
  it('comprueba que el archivo no esta vacio', () => {
    // En React Native un Blob informa bien su tamano pero puede viajar VACIO: es
    // lo que hacia que las fotos se subieran con 0 bytes.
    assert.ok(FUENTE.includes('local.size === 0'));
  });

  it('lee los BYTES reales en vez de fiarse del Blob', () => {
    assert.ok(
      FUENTE.includes('readLocalFile'),
      'Hay que reutilizar readLocalFile: resolvio el Blob vacio de React Native.',
    );
  });

  it('los archivos grandes van por subida reanudable', () => {
    // Un video por datos moviles no sobrevive a un cambio de wifi si va en un
    // solo POST.
    assert.ok(FUENTE.includes('RESUMABLE_THRESHOLD'));
    assert.ok(FUENTE.includes('uploadResumable'));
  });

  it('tiene su propio tope, mas bajo que el general', () => {
    // Al otro lado hay alguien con datos moviles que no ha pedido descargar un
    // video de curso de dos gigas.
    assert.ok(FUENTE.includes('MAX_ADJUNTO_BYTES'));
  });
});
