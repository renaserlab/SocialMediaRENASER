/**
 * La bandeja de mensajes: lo que se puede probar sin renderizador.
 *
 * Dos clases de comprobación, y la mezcla es deliberada:
 *
 *  1. **Lógica pura** (`lib/bandeja.ts`). El fusionado de páginas, el descarte
 *     de respuestas viejas y la construcción de los parámetros son justo el
 *     código que se rompe en silencio —una conversación repetida, una lista
 *     filtrada con el filtro ya quitado— y que nadie ve hasta que alguien se
 *     queja. Vive fuera del componente para poder comprobarlo aquí.
 *
 *  2. **Inspección del código fuente**, como en `explorarPideLoQuePinta` y
 *     `cuadriculaSinReproductores`. Montar la pantalla exigiría un renderizador
 *     de React Native que este proyecto no tiene en las pruebas, y lo que hay
 *     que impedir es que vuelvan a colarse las cuatro cosas concretas que la
 *     medición encontró: filtrar en el cliente, apagar la paginación al buscar,
 *     pedir las historias por el camino de cuatro saltos y repintar la lista
 *     entera en cada pulsación.
 *
 * Los números salen de `docs/Z_MEDICION_MENSAJES_EXPLORE.md`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONSULTA_VACIA,
  FILTROS_DE_BANDEJA,
  VALIDEZ_DE_LA_BANDEJA_MS,
  esVigente,
  filtrosOfrecidos,
  fusionarPaginas,
  hayConsulta,
  hayQueRecargar,
  mismaConsulta,
  parametrosDeBandeja,
  type ConsultaDeBandeja,
} from '../lib/bandeja.ts';

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

/**
 * El fichero sin comentarios.
 *
 * Hace falta para las comprobaciones que dicen «esto NO aparece»: los
 * comentarios de este trabajo explican precisamente lo que se dejó de hacer
 * —«antes se filtraba con `conversations.filter(...)`», «no se usa
 * `StoryRepository`»— y una búsqueda literal los confundiría con el código. Sin
 * esto, la única forma de que la prueba pasara sería borrar la explicación.
 */
function codigo(rel: string): string {
  return fuente(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

function consulta(parcial: Partial<ConsultaDeBandeja> = {}): ConsultaDeBandeja {
  return { ...CONSULTA_VACIA, ...parcial };
}

// ---------------------------------------------------------------------------
// 1. Los parámetros que viajan: lo vacío no se manda
// ---------------------------------------------------------------------------

test('sin consulta solo viajan limit y offset', () => {
  const params = parametrosDeBandeja(CONSULTA_VACIA, { limit: 20, offset: 0 });
  assert.equal(params, 'limit=20&offset=0');
});

test('el texto viaja como q, el filtro como filtro y la etiqueta como label_id', () => {
  const params = parametrosDeBandeja(
    consulta({ texto: 'martinez', filtro: 'unread', etiqueta: 'abc' }),
    { limit: 20, offset: 40 },
  );
  const leidos = new URLSearchParams(params);
  assert.equal(leidos.get('q'), 'martinez');
  assert.equal(leidos.get('filtro'), 'unread');
  assert.equal(leidos.get('label_id'), 'abc');
  // El offset viaja SIEMPRE: es lo que hace que buscar siga paginando.
  assert.equal(leidos.get('offset'), '40');
});

test('un texto con caracteres raros se codifica y no rompe la URL', () => {
  const params = parametrosDeBandeja(consulta({ texto: 'ana & bruno' }), {
    limit: 20,
    offset: 0,
  });
  assert.ok(!params.includes('ana & bruno'), 'el & sin codificar partiría la URL');
  assert.equal(new URLSearchParams(params).get('q'), 'ana & bruno');
});

test('hayConsulta distingue la bandeja entera de una recortada', () => {
  assert.equal(hayConsulta(CONSULTA_VACIA), false);
  assert.equal(hayConsulta(consulta({ texto: 'ana' })), true);
  assert.equal(hayConsulta(consulta({ filtro: 'unanswered' })), true);
  assert.equal(hayConsulta(consulta({ etiqueta: 'abc' })), true);
});

test('mismaConsulta compara lo que se pide, no la identidad del objeto', () => {
  assert.equal(mismaConsulta(consulta({ texto: 'ana' }), consulta({ texto: 'ana' })), true);
  assert.equal(mismaConsulta(consulta({ texto: 'ana' }), consulta({ texto: 'an' })), false);
});

// ---------------------------------------------------------------------------
// 2. Nunca un botón muerto: sin la 0044 no se ofrece el filtro de historias
// ---------------------------------------------------------------------------

test('son exactamente tres filtros y ninguno mas', () => {
  assert.deepEqual([...FILTROS_DE_BANDEJA], ['unread', 'unanswered', 'story_replies']);
});

test('sin respuestas a historias se ofrecen dos filtros, no tres', () => {
  assert.deepEqual(filtrosOfrecidos(false), ['unread', 'unanswered']);
});

test('con la 0044 aplicada se ofrecen los tres', () => {
  assert.deepEqual(filtrosOfrecidos(true), ['unread', 'unanswered', 'story_replies']);
});

// ---------------------------------------------------------------------------
// 3. Paginar sin repetir ni perder filas
// ---------------------------------------------------------------------------

test('la pagina siguiente se anade detras', () => {
  const juntas = fusionarPaginas([{ id: 'a' }, { id: 'b' }], [{ id: 'c' }]);
  assert.deepEqual(juntas.map((f) => f.id), ['a', 'b', 'c']);
});

test('una conversacion que sale en las dos paginas no se duplica', () => {
  // Pasa de verdad: entre una página y la siguiente entra un mensaje que
  // reordena la lista y una fila baja un puesto.
  const juntas = fusionarPaginas(
    [{ id: 'a' }, { id: 'b' }],
    [{ id: 'b' }, { id: 'c' }],
  );
  assert.deepEqual(juntas.map((f) => f.id), ['a', 'b', 'c']);
});

test('la version nueva de una fila repetida sustituye a la vieja', () => {
  const juntas = fusionarPaginas(
    [{ id: 'a', unread: 0 }],
    [{ id: 'a', unread: 3 }],
  );
  assert.deepEqual(juntas, [{ id: 'a', unread: 3 }]);
});

// ---------------------------------------------------------------------------
// 4. Una respuesta lenta no pisa a una mas nueva
// ---------------------------------------------------------------------------

test('solo la ultima peticion pedida puede pintar', () => {
  // Se lanza «mart» (1) y despues «martinez» (2); vuelve antes la de «mart».
  assert.equal(esVigente(1, 2), false, 'la respuesta vieja no puede pintar');
  assert.equal(esVigente(2, 2), true);
});

// ---------------------------------------------------------------------------
// 5. No recargar en cada vuelta a la pantalla
// ---------------------------------------------------------------------------

test('la primera vez siempre se carga', () => {
  assert.equal(hayQueRecargar(null, 1_000), true);
});

test('volver enseguida de un chat no vuelve a pedir la bandeja', () => {
  // El caso medido: salir a un chat y volver costaba otra peticion (~0,42 s).
  assert.equal(hayQueRecargar(1_000, 1_000 + 5_000), false);
});

test('pasado el tiempo de validez si se refresca', () => {
  assert.equal(hayQueRecargar(1_000, 1_000 + VALIDEZ_DE_LA_BANDEJA_MS), true);
});

test('dos focos en el mismo instante no piden dos veces', () => {
  assert.equal(hayQueRecargar(1_000, 1_000), false);
});

// ---------------------------------------------------------------------------
// 6. Buscar y filtrar los resuelve el SERVIDOR
// ---------------------------------------------------------------------------

test('el repositorio manda la consulta al servidor', () => {
  const repo = fuente('repositories/MessageRepository.ts');
  assert.match(
    repo,
    /parametrosDeBandeja\(consulta, \{ limit, offset \}\)/,
    'la busqueda y los filtros tienen que viajar en la peticion',
  );
});

test('la pantalla ya no filtra las conversaciones del servidor en el cliente', () => {
  const pantalla = codigo('screens/MessagesScreen.tsx');
  // El filtro local que quedaba es el de la bandeja de DEMOSTRACION, y va
  // explicitamente dentro de la rama `!supabaseEnabled`.
  const filtrosLocales = [...pantalla.matchAll(/(\w+)\.filter\(/g)].map((m) => m[1]);
  assert.deepEqual(
    filtrosLocales,
    ['demoConversations'],
    'solo la bandeja de demostracion se filtra en el telefono: no hay servidor al que preguntar',
  );
});

test('buscar NO desactiva la paginacion', () => {
  const pantalla = fuente('screens/MessagesScreen.tsx');
  assert.match(pantalla, /onEndReached=\{cargarMas\}/);
  assert.ok(
    !/onEndReached=\{searchText \? undefined/.test(pantalla),
    'con la busqueda en el servidor hay resultados de verdad por debajo',
  );
});

test('el buscador reutiliza el antirrebote que ya existe', () => {
  const buscador = fuente('components/BuscadorDeConversaciones.tsx');
  assert.match(
    buscador,
    /from '@\/lib\/busquedaProgresiva'/,
    'sin antirrebote, escribir «martinez» son ocho peticiones',
  );
  assert.match(buscador, /ESPERA_DE_TECLEO_MS/);
  assert.match(buscador, /clearTimeout/, 'cada tecla tiene que cancelar el disparo anterior');
});

test('el texto tecleado es estado del buscador, no de la pantalla', () => {
  const pantalla = fuente('screens/MessagesScreen.tsx');
  assert.ok(
    !/useState\(''\)/.test(pantalla),
    'si el texto viviera aqui, cada pulsacion repintaria la lista entera',
  );
});

// ---------------------------------------------------------------------------
// 7. Rendimiento de la lista
// ---------------------------------------------------------------------------

test('la lista sigue virtualizada', () => {
  const pantalla = fuente('screens/MessagesScreen.tsx');
  assert.match(pantalla, /FlashList/);
  assert.ok(
    !/<ScrollView/.test(pantalla),
    'un ScrollView monta las cientos de filas de golpe',
  );
});

test('data, renderItem, cabecera y refreshControl no se recrean en cada render', () => {
  const pantalla = fuente('screens/MessagesScreen.tsx');
  assert.match(pantalla, /data=\{datos\}/);
  assert.match(pantalla, /renderItem=\{renderItem\}/);
  assert.match(pantalla, /ListHeaderComponent=\{cabecera\}/);
  assert.match(pantalla, /refreshControl=\{controlDeRecarga\}/);
});

test('la fila tiene memoria propia', () => {
  const fila = fuente('components/FilaDeConversacion.tsx');
  assert.match(fila, /React\.memo\(function FilaDeConversacion/);
});

test('el avatar usa expo-image con recyclingKey', () => {
  const fila = fuente('components/FilaDeConversacion.tsx');
  assert.match(fila, /from 'expo-image'/);
  assert.match(
    fila,
    /recyclingKey=\{conversacion\.id\}/,
    'sin esto la celda reciclada enseña un instante el avatar de la fila anterior',
  );
  assert.ok(
    !/\bImage\b[^E]*from 'react-native'/.test(fila),
    'el resto de la aplicacion ya usa expo-image',
  );
});

// ---------------------------------------------------------------------------
// 8. Las historias, por el camino de UN salto y a la vez que la bandeja
// ---------------------------------------------------------------------------

test('la fila de historias de la bandeja se pide por la API, no por Supabase', () => {
  const historias = fuente('components/HistoriasDeLaBandeja.tsx');
  assert.match(
    historias,
    /\$\{API_V1\}\/stories\?feed=following&limit=\$\{AUTORES_EN_LA_FILA\}/,
    'el camino de StoryRepository son cuatro saltos encadenados (~1,7 s)',
  );
  assert.ok(
    !/StoryRepository/.test(codigo('components/HistoriasDeLaBandeja.tsx')),
    'no se monta el camino de cuatro saltos',
  );
});

test('la bandeja no construye un segundo sistema de historias', () => {
  const historias = fuente('components/HistoriasDeLaBandeja.tsx');
  assert.match(historias, /from '@\/components\/StoriesRow'/);
});

test('las burbujas no descargan los archivos de las historias', () => {
  const historias = fuente('components/HistoriasDeLaBandeja.tsx');
  assert.match(historias, /items: \[\]/, 'para una burbuja basta el avatar');
  assert.ok(
    !/signMediaUrls|createSignedUrls/.test(historias),
    'firmar las rutas de todo el mundo para no enseñar ninguna',
  );
});

test('StoriesRow solo pide al almacen cuando NO le dan los grupos', () => {
  const fila = fuente('components/StoriesRow.tsx');
  assert.match(
    fila,
    /if \(alimentadoDesdeFuera\) return;\s*\n\s*void loadStories\(\);/,
    'alimentada desde la API, no puede lanzar ademas la cascada de Supabase',
  );
});

test('la bandeja y las historias salen a la vez, no encadenadas', () => {
  const pantalla = fuente('screens/MessagesScreen.tsx');
  // Las historias se piden dentro de su propio componente: no hay ninguna forma
  // de que la pantalla las encadene detras de las conversaciones.
  assert.match(pantalla, /<HistoriasDeLaBandeja \/>/);
  assert.ok(
    !/listConversations[\s\S]{0,400}HistoriasDeLaBandeja/.test(pantalla),
    'encadenarlas serian dos saltos (~0,84 s) en vez de uno',
  );
});

// ---------------------------------------------------------------------------
// 9. El CRM montado: chips arriba, gestor desde los chips y desde la fila
// ---------------------------------------------------------------------------

test('los chips de etiquetas y el gestor estan montados en la bandeja', () => {
  const pantalla = fuente('screens/MessagesScreen.tsx');
  assert.match(pantalla, /<ChipsDeEtiquetas/);
  assert.match(pantalla, /<GestorDeEtiquetas/);
});

test('el gestor se abre desde los chips y manteniendo pulsada una conversacion', () => {
  const pantalla = fuente('screens/MessagesScreen.tsx');
  assert.match(pantalla, /alGestionar=\{abrirGestorDeLaLista\}/);
  assert.match(pantalla, /alEtiquetar=\{etiquetas\.disponible \? abrirGestorDe : undefined\}/);
  const fila = fuente('components/FilaDeConversacion.tsx');
  assert.match(fila, /onLongPress=/);
});

test('elegir una etiqueta vuelve a pedir la lista al servidor', () => {
  const pantalla = fuente('screens/MessagesScreen.tsx');
  assert.match(pantalla, /alSeleccionar=\{alEtiquetar\}/);
  // `alEtiquetar` cambia la consulta, y el efecto de `consulta` recarga.
  assert.match(pantalla, /\}, \[consulta, load\]\);/);
});

test('sin la 0045 no salen los chips ni se puede etiquetar', () => {
  const pantalla = fuente('screens/MessagesScreen.tsx');
  assert.match(pantalla, /disponible=\{etiquetas\.disponible\}/);
});

test('el filtro de respuestas a historias depende de lo que diga el servidor', () => {
  const pantalla = fuente('screens/MessagesScreen.tsx');
  assert.match(pantalla, /respuestasAHistorias=\{respuestasAHistorias\}/);
  assert.match(
    pantalla,
    /MessageRepository\.funciones\(\)/,
    'se pregunta antes de pintar el boton: nunca un boton muerto',
  );
});

// ---------------------------------------------------------------------------
// 10. Las etiquetas son privadas, y eso lo decide el servidor
// ---------------------------------------------------------------------------

test('la fila pinta las etiquetas que manda el servidor, sin filtrarlas aqui', () => {
  const fila = fuente('components/FilaDeConversacion.tsx');
  assert.match(fila, /conversacion\.labels \?\? \[\]/);
  assert.ok(
    !/owner|dueñ|propietar/i.test(fila),
    'el recorte por dueño va en el servidor: esconderlo aqui no lo haria privado',
  );
});

test('el mapeador no revienta si la API todavia no manda las etiquetas', () => {
  const mapeador = fuente('mappers/messageMapper.ts');
  assert.match(mapeador, /labels: dto\.labels \?\? \[\]/);
});

// ---------------------------------------------------------------------------
// 11. «Filtros» va a la derecha de las etiquetas (pedido el 25/09/2026)
// ---------------------------------------------------------------------------

test('el boton de filtros va a la derecha de los chips de etiquetas', () => {
  const pantalla = fuente('screens/MessagesScreen.tsx');
  const fila = pantalla.slice(pantalla.indexOf('<View style={styles.filaDeFiltros}>'));
  const chips = fila.indexOf('<ChipsDeEtiquetas');
  const filtros = fila.indexOf('<FiltrosDeBandeja');
  assert.ok(chips > 0 && filtros > 0, 'la fila de filtros ya no tiene sus dos piezas');
  assert.ok(
    chips < filtros,
    'Filtros volvio a la izquierda: se pidio a la derecha de «+ Crear etiqueta».',
  );
  // Arriba y no centrado: debajo de los chips puede ir el texto de ayuda.
  assert.match(pantalla, /filaDeFiltros: \{ flexDirection: 'row', alignItems: 'flex-start'/);
});
