/**
 * Pruebas de la eleccion y subida de archivos.
 *
 * Es la ruta que mas fallos SILENCIOSOS ha dado: el boton se pulsaba, no pasaba
 * nada, y no habia ni error ni pista de por que. Todos compilaban perfectamente.
 *
 * Lo que se fija aqui:
 *
 * 1. Un permiso denegado LANZA, no devuelve null. Confundirlo con "la persona
 *    cancelo" es lo que dejaba el boton mudo.
 * 2. `aspect` solo se envia en Android. Mandarlo en iOS impedia que el selector
 *    llegara a abrirse.
 * 3. En nativo se leen los BYTES del archivo. Un Blob de React Native informa
 *    bien su tamano pero viaja vacio, y las fotos se guardaban con 0 bytes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FUENTE = readFileSync(
  fileURLToPath(new URL('./storage.ts', import.meta.url)),
  'utf8',
);

// ---------------------------------------------------------------------------
// 1. El permiso denegado no puede fallar en silencio
// ---------------------------------------------------------------------------

test('un permiso denegado lanza, no devuelve null', () => {
  // `null` ya significa "la persona cancelo". Si el permiso denegado devolviera
  // lo mismo, quien llama no puede distinguir un caso del otro y no tiene nada
  // que contarle al usuario.
  assert.equal(
    /if \(!permission\.granted\) return null/.test(FUENTE),
    false,
    'Hay un permiso que se rinde devolviendo null: el boton quedaria mudo.',
  );
  assert.ok(
    FUENTE.includes('throw new PermisoDenegadoError'),
    'Falta lanzar PermisoDenegadoError al denegarse el permiso.',
  );
});

test('el aviso dice donde activar el permiso', () => {
  // "No se pudo abrir el selector" no ayuda: en iOS el sistema solo pregunta
  // UNA vez, asi que la unica salida es ir a los ajustes del telefono.
  assert.ok(
    /Ajustes del/.test(FUENTE),
    'El mensaje de permiso denegado debe indicar donde activarlo.',
  );
});

test('cada selector comprueba su propio permiso', () => {
  // La camara y la galeria son permisos DISTINTOS: pedir el equivocado deja
  // pasar a quien no debe, o bloquea a quien si tiene el que hace falta.
  assert.ok(FUENTE.includes('requestMediaLibraryPermissionsAsync'));
  assert.ok(FUENTE.includes('requestCameraPermissionsAsync'));
});

// ---------------------------------------------------------------------------
// 2. `aspect` solo en Android
// ---------------------------------------------------------------------------

test('aspect no se envia en iOS', () => {
  // iOS lo ignora —su recorte siempre es cuadrado— pero ademas enviarlo impedia
  // que el selector se abriera: historias y foto de perfil no hacian nada.
  assert.ok(
    FUENTE.includes("Platform.OS !== 'android'"),
    'Falta la guarda que evita enviar aspect fuera de Android.',
  );
  assert.equal(
    /^\s+aspect,$/m.test(FUENTE),
    false,
    'Hay una llamada que pasa `aspect` sin filtrar por plataforma.',
  );
});

// ---------------------------------------------------------------------------
// 3. En nativo se leen los bytes, no un Blob
// ---------------------------------------------------------------------------

test('en nativo se leen los bytes reales del archivo', () => {
  // `fetch(uri).blob()` informa bien `size` en React Native, pero el cuerpo
  // viaja VACIO cuando supabase-js lo sube: las fotos se guardaban con 0 bytes.
  assert.ok(
    FUENTE.includes('arrayBuffer()'),
    'La subida nativa debe leer los bytes con File.arrayBuffer().',
  );
  assert.ok(
    FUENTE.includes("from 'expo-file-system'"),
    'Falta expo-file-system, que es quien lee el archivo en nativo.',
  );
});

test('las tres subidas usan el mismo lector', () => {
  // Publicaciones, foto de perfil y material de curso. Si una se quedara con el
  // Blob volveria a subir archivos vacios, y solo en esa.
  const usos = FUENTE.match(/readLocalFile\(/g) ?? [];
  assert.ok(
    usos.length >= 4, // la definicion + los tres usos
    `readLocalFile aparece ${usos.length} veces; deberia usarse en las tres subidas.`,
  );
});

test('se comprueba que el archivo no esta vacio antes de subirlo', () => {
  // Gastar una subida entera para acabar guardando 0 bytes es lo que ya paso.
  assert.ok(FUENTE.includes('size === 0'));
});

// ---------------------------------------------------------------------------
// Limites: fallar pronto y con un mensaje que se entienda
// ---------------------------------------------------------------------------

test('el tamano maximo se comprueba antes de subir', () => {
  assert.ok(FUENTE.includes('MAX_UPLOAD_BYTES'));
  // El mensaje dice cuanto pesa y cuanto se admite: "archivo demasiado grande"
  // a secas no dice si sobran dos megas o doscientos.
  assert.ok(/formatMb/.test(FUENTE));
});

test('los archivos grandes van por subida reanudable', () => {
  // Un movil pierde cobertura constantemente: sin reanudar, un video de 300 MB
  // vuelve a empezar de cero cada vez.
  assert.ok(FUENTE.includes('RESUMABLE_THRESHOLD'));
  assert.ok(FUENTE.includes('uploadResumable'));
});

test('cada archivo se guarda bajo la carpeta de su dueno', () => {
  // La RLS del bucket exige la ruta `uid/...`. Sin ese prefijo el INSERT falla,
  // y si se relajara, cualquiera escribiria en la carpeta de otro.
  assert.ok(
    /\$\{uid\}\//.test(FUENTE),
    'Las rutas de subida deben empezar por el id del usuario.',
  );
});

// ---------------------------------------------------------------------------
// 4. Una misma ruta no se firma dos veces a la vez
// ---------------------------------------------------------------------------
//
// Estas dos son ESTRUCTURALES —miran el texto del fichero, como el resto de
// este archivo— porque `storage.ts` necesita las claves de Supabase para poder
// importarse siquiera. No prueban el comportamiento; sirven para que quitar la
// deduplicacion no pase desapercibido.

test('las firmas en vuelo se deduplican por ruta', () => {
  // Al arrancar hay tres llamadas a la vez con rutas que se solapan (la
  // instantanea del feed, la primera pagina de red y el feed de video). Sin
  // esto, las tres firmaban las mismas rutas por separado.
  //
  // Y cada firma devuelve una URL DISTINTA, que es lo grave: expo-image y
  // expo-video cachean POR URL, asi que tres firmas del mismo video son tres
  // descargas del mismo video (medido en la web desplegada).
  assert.ok(
    FUENTE.includes('firmasEnVuelo'),
    'Sin el mapa de firmas en vuelo, la misma ruta se firma varias veces a la vez.',
  );
  assert.ok(
    /firmasEnVuelo\.has\(/.test(FUENTE),
    'Hay que CONSULTAR el mapa antes de pedir una firma nueva.',
  );
});

test('una firma fallida no deja la ruta bloqueada para siempre', () => {
  // Si una entrada se quedara marcada como «en vuelo» tras fallar, esa imagen
  // no se volveria a pedir en toda la sesion.
  assert.ok(
    /firmasEnVuelo\.delete\(/.test(FUENTE),
    'Las firmas en vuelo deben soltarse al terminar, tambien si fallan.',
  );
});
