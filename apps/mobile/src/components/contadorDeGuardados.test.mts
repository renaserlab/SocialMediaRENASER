import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { contadorOptimista } from '../lib/intencionFinal.ts';

/**
 * EL MARCADOR SE PINTA, Y DICE CUANTA GENTE LA GUARDO.
 *
 * LO QUE SE REPORTO. «A pesar de que aparece una notificacion de que la
 * publicacion fue guardada, el icono de guardar no se pinta; debe pintarse
 * completamente», y «cuando se quiere quitar de guardados, que se despinte».
 *
 * El aviso ya estaba (lo fijo `feedbackDeGuardarYRepost`); lo que faltaba era
 * el icono. Y faltaba antes de eso una cosa mas basica: `Feather` solo dibuja
 * contornos, asi que su `bookmark` NO puede rellenarse. Cambiar el color era
 * todo lo que se podia hacer con esa familia, y el color solo no basta: en un
 * movil al sol, o para quien no separa bien los tonos, guardada y no guardada
 * se veian igual.
 *
 * Y junto al icono, el numero: cuanta gente la ha guardado. Solo el numero.
 * Quien la guardo no se enseña ni se puede pedir: guardar es privado.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

/** El codigo sin comentarios: aqui se habla de lo que NO se hace. */
function sinComentarios(codigo: string): string {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const POST_CARD = fuente('components/PostCard.tsx');
const ACCION = fuente('components/AccionDePublicacion.tsx');
const STORE = fuente('store/useAppStore.ts');
const MAPPER = fuente('mappers/postMapper.ts');
const REPO = fuente('repositories/PostRepository.ts');
const TIPOS = fuente('types/index.ts');
const PAQUETE = readFileSync(join(SRC, '..', 'package.json'), 'utf8');

// ---------------------------------------------------------------------------
// 1. El estado se ve en la FORMA, no solo en el color
// ---------------------------------------------------------------------------

test('el boton acepta una variante rellena para el estado encendido', () => {
  assert.match(
    ACCION,
    /iconoRelleno\?: keyof typeof MaterialCommunityIcons\.glyphMap/,
    'sin esta propiedad el estado solo podria cambiar de color',
  );
});

test('encendido dibuja OTRO icono, no el mismo con otro tono', () => {
  const codigo = sinComentarios(ACCION);
  assert.match(
    codigo,
    /\{activo && iconoRelleno \?[\s\S]{0,200}?<MaterialCommunityIcons[\s\S]{0,200}?<Feather/,
    'el encendido tiene que elegir el dibujo relleno y el apagado el de contorno',
  );
});

test('la tarjeta pide el marcador relleno al guardar', () => {
  assert.match(
    POST_CARD,
    /icono="bookmark"[\s\S]{0,400}?iconoRelleno="bookmark"/,
    'el boton de guardar tiene que declarar su version rellena',
  );
});

test('el color sigue estando, pero acompañando', () => {
  // No se quita `colorActivo`: la forma dice el estado y el color lo refuerza.
  assert.match(POST_CARD, /icono="bookmark"[\s\S]{0,600}?colorActivo=\{colors\.primary\}/);
});

test('la familia rellena sale del paquete de iconos que ya estaba', () => {
  assert.match(ACCION, /import \{ Feather, MaterialCommunityIcons \} from '@expo\/vector-icons'/);
  // Nada de una libreria de iconos nueva por un marcador relleno.
  assert.ok(
    !/react-native-vector-icons|lucide|@iconify|phosphor/i.test(PAQUETE),
    'no se añade ninguna dependencia de iconos',
  );
});

// ---------------------------------------------------------------------------
// 2. El aviso de antes SE CONSERVA
// ---------------------------------------------------------------------------

test('sigue avisando al guardar, con salida a la lista', () => {
  /*
    Se pidio explicitamente que no se quitara: el icono relleno es un añadido
    al aviso, no su sustituto.
  */
  assert.match(POST_CARD, /toastConAccion\(\s*t\('post\.savedToast'\)/);
  assert.match(POST_CARD, /etiqueta: t\('post\.viewSavedList'\)/);
  // Quitar tambien avisa, y ahora ofrece deshacerlo.
  assert.match(POST_CARD, /toastConAccion\(t\('post\.unsavedToast'\), \{/);
});

// ---------------------------------------------------------------------------
// 3. El contador
// ---------------------------------------------------------------------------

test('el numero viene del servidor y llega hasta la tarjeta', () => {
  assert.match(MAPPER, /saves_count\?: number/, 'el DTO trae el contador');
  assert.match(MAPPER, /savesCount: dto\.saves_count \?\? 0/, 'y se mapea al modelo de vista');
  assert.match(TIPOS, /savesCount\?: number/, 'el tipo Post lo declara');
});

test('se pinta junto al marcador, y sin enseñar un cero', () => {
  // Mismo criterio que republicar: el nombre del boton ya explica para que es.
  assert.match(
    POST_CARD,
    /iconoRelleno="bookmark"[\s\S]{0,300}?contador=\{savesCount > 0 \? savesCount : undefined\}/,
  );
});

test('el contador se lee del mismo sitio donde se actualiza', () => {
  /*
    Si la tarjeta se guardara el numero en un `useState` propio, guardar desde
    el menu de la publicacion —que llama al store— no lo movería.
  */
  assert.match(
    POST_CARD,
    /useAppStore\(\(state\) => state\.saveCounts\[post\.id\] \?\? post\.savesCount \?\? 0\)/,
  );
  assert.ok(
    !/useState\([^)]*savesCount/.test(POST_CARD),
    'nada de una segunda copia del numero dentro de la tarjeta',
  );
});

// ---------------------------------------------------------------------------
// 4. Optimista, con vuelta atras, sin negativos y sin sumar dos veces
// ---------------------------------------------------------------------------

/** El cuerpo de `toggleSavePost`, que es donde vive todo esto. */
const INICIO_GUARDAR = STORE.indexOf('toggleSavePost: async');
const GUARDAR = STORE.slice(INICIO_GUARDAR, STORE.indexOf('addComment: async', INICIO_GUARDAR));

test('el contador se pinta antes de que el servidor conteste', () => {
  const iOptimista = GUARDAR.indexOf('pintar(guardada, contadorOptimista(contador, confirmado, guardada))');
  const iEspera = GUARDAR.indexOf('await peticion.asentada');
  assert.ok(iOptimista !== -1 && iEspera !== -1);
  assert.ok(iOptimista < iEspera, 'primero se pinta, despues se espera al servidor');
});

test('el contador nunca baja de cero', () => {
  // La cuenta vive en `lib/intencionFinal` y aqui se EJECUTA.
  assert.equal(contadorOptimista(0, true, false), 0);
  assert.equal(contadorOptimista(1, true, false), 0);
});

test('guardar dos veces no suma dos', () => {
  /*
    El signo sale de `wasSaved`, exactamente igual que `guardada`: si ya estaba
    en la lista, la segunda pulsacion RESTA. Y el numero se calcula siempre
    desde el contador DE PARTIDA de la rafaga, no sumando sobre lo ya pintado:
    diez toques seguidos no pueden dejar un «+10».
  */
  assert.match(GUARDAR, /const wasSaved = estado\.savedPostIds\.includes\(postId\)/);
  assert.match(GUARDAR, /const guardada = !wasSaved/);
  assert.equal(contadorOptimista(3, false, true), 4, 'guardar: uno mas');
  assert.equal(contadorOptimista(3, false, false), 3, 'guardar y quitar: el de partida');
  assert.equal(contadorOptimista(3, false, true), 4, 'y volver a guardar: uno mas, no dos');
});

test('si el servidor rechaza, el numero vuelve al valor exacto de antes', () => {
  const fallo = GUARDAR.slice(GUARDAR.indexOf('if (!final.ok) {'));
  assert.match(
    fallo,
    /pintar\(final\.valor, contadorOptimista\(contador, confirmado, final\.valor\)\)/,
    'vuelve a lo que el servidor confirmo, con el contador de partida',
  );
  assert.match(
    GUARDAR,
    /return \{ guardada: final\.valor, ok: final\.ok, absorbida: false \}/,
    'y se dice que fallo',
  );
});

test('la lista y el numero se deshacen juntos', () => {
  // Un icono despintado con el numero todavia subido seria peor que no pintar:
  // `pintar` mueve las tres cosas en el MISMO `set`.
  const pintar = GUARDAR.slice(GUARDAR.indexOf('const pintar ='), GUARDAR.indexOf('const partida ='));
  assert.match(pintar, /savedPostIds:/);
  assert.match(pintar, /saveCounts: \{ \.\.\.state\.saveCounts, \[postId\]: contador \}/);
  assert.match(pintar, /savesCount: contador/, 'y tambien en la publicacion del muro');
  assert.equal(pintar.match(/set\(/g)?.length, 1);
});

test('el numero de guardados no se guarda en disco', () => {
  /*
    Es una foto del servidor, no una preferencia: persistirlo solo serviria
    para enseñar un numero viejo al abrir.
  */
  const persistidos = STORE.slice(STORE.indexOf('partialize: (state: AppState)'));
  assert.ok(!/saveCounts/.test(persistidos.slice(0, 700)), 'saveCounts fuera de partialize');
});

// ---------------------------------------------------------------------------
// 5. Se cuenta, pero NO se dice quien
// ---------------------------------------------------------------------------

test('no hay ninguna ruta que pida quien guardo', () => {
  const codigo = sinComentarios(REPO);
  assert.ok(
    !/saved-posts\/[^'`\s]*\/(users|people|savers)|saves\/users|\/savers|savedBy/i.test(codigo),
    'el repositorio no puede tener por donde pedir la lista de quien guardo',
  );
  // `saved-posts` sigue existiendo, pero es MI lista, no la de los demas.
  assert.match(codigo, /\$\{API_V1\}\/saved-posts\?/);
});

test('ni el DTO ni el modelo traen personas que guardaron', () => {
  const codigo = sinComentarios(MAPPER + TIPOS);
  assert.ok(
    !/saved_by\b|saved_by_users|savers|savedByUsers|whoSaved/i.test(codigo),
    'del guardado ajeno solo viaja el numero',
  );
  // `saved_by_me` es otra cosa: si lo guarde YO, que es lo que pinta mi icono.
  assert.match(codigo, /saved_by_me: boolean/);
});

test('el store guarda un numero, no una lista de gente', () => {
  assert.match(STORE, /saveCounts: Record<string, number>/);
});

test('la tarjeta no ofrece abrir «quien lo guardo»', () => {
  /*
    En «me gusta» el numero es un segundo boton que abre la lista de quien
    reacciono. Aqui NO puede serlo: esa lista no existe y no debe existir.
  */
  const guardar = POST_CARD.slice(POST_CARD.indexOf('iconoRelleno="bookmark"'));
  const bloque = guardar.slice(0, guardar.indexOf('/>'));
  assert.ok(!/alPulsarContador/.test(bloque), 'el numero de guardados no lleva a ninguna lista');
});
