import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  esperandoAlServidor,
  estrecharBandeja,
  filasVisibles,
} from '../lib/bandeja.ts';
import {
  TOPE_DE_LA_MEMORIA,
  VALIDEZ_DE_LA_MEMORIA_MS,
  recordar,
  recuperar,
  type MemoriaDeBusqueda,
  type RespuestaDeBusqueda,
} from '../lib/busquedaProgresiva.ts';

/**
 * LA BANDEJA Y EL BUSCADOR, TAL COMO SE PIDIERON EL 04/10/2026.
 *
 * Lo reportado, probando en el navegador:
 *   - «la vista de mensajes sigue igual… debe ser como la bandeja de Instagram»;
 *   - «el recuadro de búsqueda no tiene buen aspecto… genera otro recuadro más
 *     pequeño… quítalo… se ve muy pasado de moda»;
 *   - «se demora demasiado en buscar… la búsqueda debe ser instantánea»;
 *   - y un error en la consola al entrar en Cursos: un botón dentro de otro.
 *
 * Aquí se ejecuta lo que decide (qué filas se ven mientras el servidor
 * contesta, qué se recuerda de lo ya buscado) y se lee el código de lo que solo
 * se dibuja.
 */

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (codigo: string) =>
  codigo.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------------------------------------------------------------------------
// 1. Buscar en la bandeja: lo que hay se estrecha al instante
// ---------------------------------------------------------------------------

const FILAS = [
  { id: 'a', name: 'Jolaus Andy Meza Perez', subtitle: 'MENSAJE TEST' },
  { id: 'b', name: 'Luis Pérez', subtitle: 'Que fue bro' },
  { id: 'c', name: 'María Núñez', subtitle: 'Nos vemos mañana' },
];
const ids = (filas: readonly { id: string }[]) => filas.map((f) => f.id);

describe('estrechar lo que ya está cargado', () => {
  it('encuentra por nombre, sin importar mayúsculas ni tildes', () => {
    assert.deepEqual(ids(estrecharBandeja(FILAS, 'perez')), ['a', 'b']);
    assert.deepEqual(ids(estrecharBandeja(FILAS, 'NUÑEZ')), ['c']);
    assert.deepEqual(ids(estrecharBandeja(FILAS, 'maria nunez')), ['c']);
  });

  it('todas las palabras, en cualquier orden', () => {
    assert.deepEqual(ids(estrecharBandeja(FILAS, 'perez luis')), ['b']);
    assert.deepEqual(ids(estrecharBandeja(FILAS, 'luis andy')), []);
  });

  it('también por el último mensaje, que es lo que se ve en la fila', () => {
    assert.deepEqual(ids(estrecharBandeja(FILAS, 'bro')), ['b']);
  });

  it('sin texto no estrecha, y devuelve la MISMA lista', () => {
    assert.equal(estrecharBandeja(FILAS, ''), FILAS);
    assert.equal(estrecharBandeja(FILAS, '   '), FILAS);
  });
});

describe('qué filas se ven ahora mismo', () => {
  it('mientras el servidor no contesta a lo tecleado, lo que hay, estrechado', () => {
    assert.equal(esperandoAlServidor('lui', ''), true);
    assert.deepEqual(ids(filasVisibles(FILAS, { tecleado: 'lui', servido: '' })), ['b']);
  });

  it('cuando el servidor contesta, SU lista tal cual: no se vuelve a filtrar', () => {
    // El servidor encontró «lui» dentro de un MENSAJE de la conversación con
    // María: ni su nombre ni su último mensaje lo dicen. Tiene que verse.
    const delServidor = [FILAS[1]!, FILAS[2]!];
    assert.equal(esperandoAlServidor('lui', 'lui'), false);
    assert.equal(filasVisibles(delServidor, { tecleado: 'lui', servido: 'lui' }), delServidor);
  });

  it('seguir escribiendo estrecha la respuesta anterior sin esperar', () => {
    const delServidor = [FILAS[0]!, FILAS[1]!];
    assert.deepEqual(ids(filasVisibles(delServidor, { tecleado: 'perez lu', servido: 'perez' })), ['b']);
  });

  it('borrar la búsqueda no vacía la lista mientras llega la bandeja entera', () => {
    const delServidor = [FILAS[1]!];
    assert.equal(filasVisibles(delServidor, { tecleado: '', servido: 'lui' }), delServidor);
  });

  it('sin buscar nada, la lista no cambia de identidad', () => {
    // Si cambiara, `FlashList` daría la lista por nueva en cada render.
    assert.equal(filasVisibles(FILAS, { tecleado: '', servido: '' }), FILAS);
  });
});

describe('la pantalla de Mensajes usa eso, y solo como espera', () => {
  const PANTALLA = sinComentarios(fuente('screens/MessagesScreen.tsx'));
  const BUSCADOR = sinComentarios(fuente('components/BuscadorDeConversaciones.tsx'));

  it('pinta lo del servidor, o lo que hay estrechado mientras llega', () => {
    assert.match(PANTALLA, /if \(supabaseEnabled\) return filasVisibles\(remote, \{ tecleado, servido \}\);/);
    assert.match(PANTALLA, /const pendiente = supabaseEnabled && esperandoAlServidor\(tecleado, servido\);/);
  });

  it('lo servido es el texto de la petición que volvió, no el vigente al volver', () => {
    assert.match(PANTALLA, /const pedida = consultaRef\.current;/);
    assert.match(PANTALLA, /listConversations\(\{ consulta: pedida \}\)/);
    assert.match(PANTALLA, /setServido\(pedida\.texto\);/);
  });

  it('buscar ya no vacía la lista: solo el filtro y la etiqueta la recargan a la vista', () => {
    assert.match(
      PANTALLA,
      /const soloCambioElTexto =\s*previa\.filtro === consulta\.filtro && previa\.etiqueta === consulta\.etiqueta;/,
    );
    assert.match(PANTALLA, /void load\(soloCambioElTexto\);/);
  });

  it('sin filas y con la pregunta en vuelo dice «cargando», no «no hay ninguna»', () => {
    assert.match(PANTALLA, /: pendiente\s*\?\s*'loading'\s*: 'empty';/);
  });

  it('una búsqueda que falla no se calla', () => {
    // El refresco silencioso que falla deja lo que hay; una búsqueda no puede
    // quedarse girando sobre una lista a medias.
    assert.match(PANTALLA, /const eraUnRefresco = pedida\.texto === servidoRef\.current;/);
    assert.match(
      PANTALLA,
      /if \(silencioso && conversacionesRef\.current\.length > 0 && eraUnRefresco\) return;/,
    );
  });

  it('el buscador dice cada tecla al instante y la petición sigue con antirrebote', () => {
    const efecto = BUSCADOR.slice(BUSCADOR.indexOf('useEffect(() => {'), BUSCADOR.indexOf('return ('));
    const teclear = efecto.indexOf('alTeclear?.(termino);');
    const temporizador = efecto.indexOf('setTimeout(');
    assert.ok(teclear > 0 && teclear < temporizador, 'lo tecleado se dice antes de esperar');
    assert.match(efecto, /ESPERA_DE_TECLEO_MS/);
    // El texto crudo sigue siendo del buscador: la pantalla recibe el término.
    assert.match(BUSCADOR, /const \[texto, setTexto\] = useState\(''\);/);
    assert.match(BUSCADOR, /buscando=\{pendiente \|\| ocupado\}/);
  });

  it('el buscador va lo primero, encima de las historias', () => {
    const cabecera = PANTALLA.slice(PANTALLA.indexOf('<View style={styles.cabecera}>'));
    assert.ok(cabecera.indexOf('<BuscadorDeConversaciones') < cabecera.indexOf('<HistoriasDeLaBandeja />'));
  });

  it('el título es grande y a la izquierda, no un rótulo en mayúsculas', () => {
    assert.match(PANTALLA, /<AppHeader title=\{t\('messages\.title'\)\} grande \/>/);
    const cabecera = sinComentarios(fuente('components/AppHeader.tsx'));
    assert.match(cabecera, /grande = false,/, 'las demás pantallas siguen como estaban');
    assert.match(cabecera, /if \(grande\) \{/);
    // El mismo alto: nada de lo de debajo cambia de sitio.
    const grande = cabecera.slice(cabecera.indexOf('if (grande) {'), cabecera.indexOf('return (\n    <View style={[styles.row, { height'));
    assert.match(grande, /height: APP_HEADER_HEIGHT \+ insets\.top/);
    assert.match(grande, /accessibilityRole="header"/);
    for (const idioma of ['es', 'en', 'pt']) {
      assert.ok(fuente(`i18n/${idioma}.ts`).includes("'messages.title':"), `falta en ${idioma}.ts`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. La fila, como la de una bandeja
// ---------------------------------------------------------------------------

describe('la fila de conversación', () => {
  const FILA = sinComentarios(fuente('components/FilaDeConversacion.tsx'));

  it('sin rayas ni marco en la foto', () => {
    assert.ok(!/borderBottom/.test(FILA), 'las filas las separa el aire');
    assert.match(FILA, /avatar: \{ width: 56, height: 56, borderRadius: 28 \}/);
  });

  it('la hora va pegada al último mensaje, no en la otra punta', () => {
    const resumen = FILA.indexOf('{conversacion.subtitle}');
    const hora = FILA.indexOf('{` · ${hora}`}');
    assert.ok(resumen > 0 && hora > resumen);
    // Se recorta el mensaje, nunca la hora.
    assert.match(FILA, /resumen: \{ fontSize: 14, lineHeight: 19, flexShrink: 1 \}/);
  });

  it('lo no leído se marca con el peso de la letra y con el globo, no solo con color', () => {
    assert.match(FILA, /weight=\{sinLeer \? '800' : '600'\}/);
    assert.match(FILA, /weight=\{sinLeer \? '700' : '400'\}/);
    assert.match(FILA, /<GloboDeNoLeidos cuenta=\{conversacion\.unread\} \/>/);
  });

  it('un nombre largo se recorta en vez de empujar el globo', () => {
    assert.match(FILA, /centro: \{ flex: 1, minWidth: 0, gap: 2 \}/);
  });
});

// ---------------------------------------------------------------------------
// 3. El campo de búsqueda: una caja rellena, sin marcos
// ---------------------------------------------------------------------------

describe('el campo de búsqueda', () => {
  const CAMPO = sinComentarios(fuente('components/CampoDeBusqueda.tsx'));

  it('no deja que el navegador dibuje un recuadro dentro', () => {
    assert.match(CAMPO, /Platform\.OS === 'web' \? \(\{ outlineStyle: 'none' \}/);
    assert.match(CAMPO, /style=\{\[styles\.entrada, SIN_ANILLO_DEL_NAVEGADOR, \{ color: colors\.text \}\]\}/);
  });

  it('es una caja rellena de esquinas suaves, no una cápsula con marco', () => {
    assert.match(CAMPO, /borderRadius: radius\.md,/);
    assert.ok(!/radius\.pill/.test(CAMPO));
    // Sin foco el contorno es del color del relleno: está y no se ve. Con
    // foco, un gris tenue; nunca el blanco o el negro del texto.
    assert.match(CAMPO, /const sinFoco = relleno;/);
    assert.match(CAMPO, /const conFoco = colors\.disabled;/);
    assert.ok(!/const conFoco = colors\.text;/.test(CAMPO));
  });

  it('el borde no cambia de grosor: enfocar no da un salto', () => {
    assert.equal(CAMPO.match(/borderWidth: 1,/g)?.length, 1);
  });

  it('lo escrito sale con la letra de la aplicación', () => {
    assert.match(CAMPO, /entrada: \{ \.\.\.getTextStyle\('400'\), flex: 1, minWidth: 0,/);
  });
});

// ---------------------------------------------------------------------------
// 4. Explorar: lo ya buscado no se vuelve a preguntar
// ---------------------------------------------------------------------------

const respuesta = (nombre: string): RespuestaDeBusqueda => ({
  people: [{ id: nombre, full_name: nombre, username: null, avatar_path: null, bio: '', offer_topics: [] }],
});

describe('la memoria de lo ya buscado', () => {
  it('devuelve lo guardado mientras vale', () => {
    const memoria: MemoriaDeBusqueda = new Map();
    recordar(memoria, 'rena', respuesta('Renaser'), 1_000);
    assert.equal(recuperar(memoria, 'rena', 1_000 + 5_000)?.people?.[0]?.full_name, 'Renaser');
  });

  it('«Rena», «rena» y « rena » son la misma pregunta', () => {
    const memoria: MemoriaDeBusqueda = new Map();
    recordar(memoria, 'Rena', respuesta('Renaser'), 0);
    assert.ok(recuperar(memoria, 'rena', 1));
    assert.ok(recuperar(memoria, ' RENA ', 1));
    assert.equal(recuperar(memoria, 'ren', 1), null);
  });

  it('caduca: no es una caché de larga vida', () => {
    const memoria: MemoriaDeBusqueda = new Map();
    recordar(memoria, 'rena', respuesta('Renaser'), 0);
    assert.ok(recuperar(memoria, 'rena', VALIDEZ_DE_LA_MEMORIA_MS - 1));
    assert.equal(recuperar(memoria, 'rena', VALIDEZ_DE_LA_MEMORIA_MS), null);
    assert.equal(memoria.size, 0, 'lo caducado se borra al leerlo');
  });

  it('tiene tope, y se olvida lo más antiguo', () => {
    const memoria: MemoriaDeBusqueda = new Map();
    for (let i = 0; i < TOPE_DE_LA_MEMORIA + 5; i += 1) {
      recordar(memoria, `termino${i}`, respuesta(String(i)), i);
    }
    assert.equal(memoria.size, TOPE_DE_LA_MEMORIA);
    assert.equal(recuperar(memoria, 'termino0', 40), null);
    assert.ok(recuperar(memoria, `termino${TOPE_DE_LA_MEMORIA + 4}`, 40));
  });

  it('volver a guardar un término lo pone como el más reciente', () => {
    const memoria: MemoriaDeBusqueda = new Map();
    recordar(memoria, 'a1', respuesta('1'), 0);
    for (let i = 0; i < TOPE_DE_LA_MEMORIA - 1; i += 1) recordar(memoria, `b${i}`, respuesta('x'), 1);
    recordar(memoria, 'a1', respuesta('1 nuevo'), 2);
    recordar(memoria, 'uno-mas', respuesta('y'), 3);
    assert.equal(recuperar(memoria, 'a1', 4)?.people?.[0]?.full_name, '1 nuevo');
    assert.equal(recuperar(memoria, 'b0', 4), null, 'cayó el que era ahora el más antiguo');
  });

  it('Explorar la consulta ANTES de esperar al antirrebote', () => {
    const EXPLORAR = sinComentarios(fuente('screens/ExploreScreen.tsx'));
    const efecto = EXPLORAR.slice(EXPLORAR.indexOf('cambiar((previo) => anotarTecleo(previo, query));'));
    const memoria = efecto.indexOf('if (recuperar(memoria.current, texto, Date.now())) {');
    const temporizador = efecto.indexOf('setTimeout(() => buscar(texto, control.signal), ESPERA_DE_TECLEO_MS)');
    assert.ok(memoria > 0 && memoria < temporizador);
    assert.match(EXPLORAR, /recordar\(memoria\.current, texto, respuesta, Date\.now\(\)\);/);
  });

  it('se vacía al cambiar la sesión: el resultado depende de quién pregunta', () => {
    const EXPLORAR = sinComentarios(fuente('screens/ExploreScreen.tsx'));
    assert.match(EXPLORAR, /useEffect\(\(\) => \{\s*memoria\.current\.clear\(\);\s*\}, \[estadoDeSesion\]\);/);
  });
});

// ---------------------------------------------------------------------------
// 5. Ningún botón dentro de otro
// ---------------------------------------------------------------------------

/** Los componentes que en web acaban siendo un `<button>`. */
const PULSABLES = ['Pressable', 'Pulsable', 'TouchableOpacity'];

/**
 * Recorre el JSX de un fichero y devuelve las líneas donde se abre un pulsable
 * con otro todavía abierto.
 *
 * No es un analizador de TypeScript: sigue las etiquetas de apertura y cierre
 * de los tres componentes, saltándose lo que hay entre llaves y entre comillas
 * para que un `=>` o un `>` dentro de una propiedad no cierre la etiqueta.
 */
function pulsablesAnidados(codigo: string): number[] {
  const hallazgos: number[] = [];
  const abiertos: number[] = [];
  const patron = new RegExp(`<(/?)(${PULSABLES.join('|')})\\b`, 'g');
  let casa: RegExpExecArray | null;
  while ((casa = patron.exec(codigo)) !== null) {
    const linea = codigo.slice(0, casa.index).split('\n').length;
    if (casa[1] === '/') {
      abiertos.pop();
      continue;
    }
    // Hasta el `>` que cierra la etiqueta, fuera de llaves y de comillas.
    let i = patron.lastIndex;
    let llaves = 0;
    let comilla: string | null = null;
    for (; i < codigo.length; i += 1) {
      const c = codigo[i]!;
      if (comilla) {
        if (c === comilla && codigo[i - 1] !== '\\') comilla = null;
      } else if (c === '"' || c === "'" || c === '`') comilla = c;
      else if (c === '{') llaves += 1;
      else if (c === '}') llaves -= 1;
      else if (c === '>' && llaves === 0) break;
    }
    const seCierraSola = codigo[i - 1] === '/';
    if (abiertos.length > 0) hallazgos.push(linea);
    if (!seCierraSola) abiertos.push(linea);
    patron.lastIndex = i + 1;
  }
  return hallazgos;
}

function ficherosTsx(carpeta: string): string[] {
  const salida: string[] = [];
  for (const entrada of readdirSync(carpeta, { withFileTypes: true })) {
    const ruta = join(carpeta, entrada.name);
    if (entrada.isDirectory()) salida.push(...ficherosTsx(ruta));
    else if (entrada.name.endsWith('.tsx')) salida.push(ruta);
  }
  return salida;
}

describe('ningún botón dentro de otro', () => {
  it('el detector detecta', () => {
    // NO VACUO: si dejara de reconocer las etiquetas, la prueba de abajo
    // pasaría sin mirar nada.
    const malo = `
      <Pressable style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }]} onPress={() => abrir()}>
        <View>
          <Pressable onPress={() => guardar()} />
        </View>
      </Pressable>`;
    assert.deepEqual(pulsablesAnidados(malo), [4]);
    const bueno = `
      <View>
        <Pulsable onPress={() => (a > b ? abrir() : null)}><Text>uno</Text></Pulsable>
        <Pulsable onPress={guardar} />
      </View>`;
    assert.deepEqual(pulsablesAnidados(bueno), []);
  });

  it('en toda la aplicación no hay un pulsable escrito dentro de otro', () => {
    // En web cada uno es un <button>, y uno dentro de otro es HTML inválido:
    // React lo avisa como error de hidratación y el de dentro puede disparar
    // también al de fuera. Fue el error de la consola al entrar en Cursos.
    const ficheros = ficherosTsx(SRC);
    assert.ok(ficheros.length > 200, `solo encontré ${ficheros.length} ficheros`);
    const malos: string[] = [];
    for (const ruta of ficheros) {
      const lineas = pulsablesAnidados(sinComentarios(readFileSync(ruta, 'utf8')));
      for (const linea of lineas) malos.push(`${ruta.slice(SRC.length + 1).replace(/\\/g, '/')}:${linea}`);
    }
    assert.deepEqual(
      malos,
      [],
      'Hay un botón dentro de otro. Hazlos hermanos: el contenedor es un View y cada uno pulsa lo suyo.',
    );
  });

  it('la tarjeta de curso tiene dos botones hermanos, y el marcador cambia de dibujo', () => {
    const CURSOS = sinComentarios(fuente('screens/CursosScreen.tsx'));
    const tarjeta = CURSOS.slice(CURSOS.indexOf('<View key={curso.id} style={styles.tarjeta}>'));
    assert.ok(tarjeta.indexOf('</Pulsable>') < tarjeta.indexOf('onPress={() => void alternarGuardado(curso)}'));
    // Relleno o contorno: el estado no depende solo del color.
    assert.match(tarjeta, /<MaterialCommunityIcons name="bookmark"/);
    assert.match(tarjeta, /<Feather name="bookmark"/);
    // Y el fondo sale del tema: antes era un blanco fijo sobre el que el
    // marcador encendido, blanco en oscuro, no se veía.
    assert.ok(!/rgba\(255,255,255/.test(CURSOS));
  });
});
