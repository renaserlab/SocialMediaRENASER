import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * TEXTO ENCIMA DE UNA FOTO O DE UN VIDEO: QUE NO PUEDE VOLVER A PASAR.
 *
 * Del informe del cliente, con sus palabras: «Corregir el texto que no se vea
 * invisible al momento de querer publicar historias. Texto: "Se verá durante 24
 * horas"» y «Se muestra un mensaje SUBIENDO o CANCELAR, pero es muy difícil ver
 * todo el contenido». Los dos tenian la misma causa: letras sueltas, sin nada
 * detras, sobre un medio a pantalla completa. Sobre una foto blanca no hay
 * color de letra que funcione, asi que el arreglo NO es recolorear: es poner
 * una capa —scrim o superficie— entre la imagen y el texto.
 *
 * Estas comprobaciones miran el CODIGO FUENTE, no la pantalla, que es el estilo
 * del resto de pruebas del proyecto: montar la vista pediria un renderizador de
 * React Native que aqui no existe, y lo que hay que impedir no es un valor mal
 * calculado sino que alguien vuelva a escribir texto desnudo sobre un medio.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

/** Las pantallas que pintan un medio a pantalla completa y escriben encima. */
const SOBRE_MEDIOS = [
  'components/crear/ModoHistoria.tsx',
  'components/crear/ModoReel.tsx',
  'components/crear/ModoPublicacion.tsx',
  'components/crear/RecorteDeHistoria.tsx',
];

/** Todo lo tocado por el arreglo, para las reglas que valen en todos. */
const TODOS = [
  ...SOBRE_MEDIOS,
  'components/CapaDeContraste.tsx',
  'components/ConfirmarRecorte.tsx',
  'components/crear/ProgresoDePublicacion.tsx',
  'components/crear/PasoDeCaptura.tsx',
  'components/SelectorDeTemas.tsx',
];

/** Cuantos caracteres se miran hacia atras buscando la capa que protege. */
const VENTANA = 400;

// ---------------------------------------------------------------------------
// 1. Nadie escribe encima de un medio sin apagar la franja primero
// ---------------------------------------------------------------------------

for (const ruta of SOBRE_MEDIOS) {
  test(`${ruta} apaga la franja donde se apoya el texto`, () => {
    const texto = fuente(ruta);
    assert.ok(
      texto.includes('<ScrimDeMedio'),
      `${ruta} escribe sobre un medio sin ScrimDeMedio: sobre una foto clara el ` +
        'texto blanco es invisible por definicion.',
    );
    assert.ok(
      texto.includes("from '@/components/CapaDeContraste'"),
      `${ruta} debe sacar la capa de contraste del componente comun.`,
    );
  });
}

// ---------------------------------------------------------------------------
// 2. Los dos textos que denuncia el informe, uno por uno
// ---------------------------------------------------------------------------

test('«Se verá durante 24 horas» va sobre una superficie, no sobre la foto', () => {
  const historia = fuente('components/crear/ModoHistoria.tsx');
  const posicion = historia.indexOf("t('create.storyLasts24h')");
  assert.notEqual(posicion, -1, 'Falta el aviso de las 24 horas en ModoHistoria.');

  const antes = historia.slice(Math.max(0, posicion - VENTANA), posicion);
  assert.ok(
    antes.includes('SuperficieSobreMedio'),
    'El aviso de las 24 horas vuelve a ir suelto encima de la imagen. ' +
      'Envuelvelo en <SuperficieSobreMedio>.',
  );
  assert.ok(
    !/color=\{media\.textMuted\}[^<]*>\s*\{t\('create\.storyLasts24h'\)/.test(historia),
    'El aviso de las 24 horas usa el gris apagado: sobre un medio es lo primero ' +
      'que se pierde. Usa media.text.',
  );
});

test('el aviso de «Subiendo / Cancelar» tiene fondo propio', () => {
  const progreso = fuente('components/crear/ProgresoDePublicacion.tsx');
  /*
    La caja era `borderWidth: 1` y nada mas: un rectangulo transparente con
    letras encima del video. Ese es exactamente el «muy difícil ver todo el
    contenido» del informe.
  */
  assert.ok(
    /backgroundColor: fondo/.test(progreso),
    'La caja de progreso volvio a quedarse sin fondo: es un borde de 1 px sobre ' +
      'el video y no se lee.',
  );
  assert.ok(
    /const fondo =/.test(progreso) && progreso.includes('media.overlay'),
    'El fondo de la caja de progreso debe salir del token overlay.',
  );
});

test('«Elige hasta 3 temas» y los nombres de grupo no van desnudos', () => {
  /*
    Segunda vuelta del mismo fallo, y esta la vio el cliente en preproduccion:
    «se siguen teniendo mensajes invisibles al momento de mostrar informacion al
    querer realizar una publicacion». Eran la ayuda del selector de temas y los
    nombres de grupo —TECNOLOGIA, DINERO, OTROS—, escritos en gris apagado
    directamente sobre la foto. Sobre una pared blanca desaparecian del todo.

    Vale para publicar Y para reels: los dos montan este mismo selector con la
    variante `sobreMedia`.
  */
  const selector = fuente('components/SelectorDeTemas.tsx');
  assert.ok(
    selector.includes("from '@/components/CapaDeContraste'"),
    'El selector de temas escribe sobre un medio: la capa sale del componente comun.',
  );
  assert.match(
    selector,
    /function Rotulo\(\{ sobre, children \}[\s\S]{0,200}<SuperficieSobreMedio/,
    'El rotulo sobre un medio debe apoyarse en una superficie opaca.',
  );
  // Los dos textos del informe, DENTRO de un rotulo. Se mira el contenido del
  // bloque y no la distancia: un comentario largo no puede tumbar la prueba.
  const rotulos = [...selector.matchAll(/<Rotulo sobre=\{esSobreMedia\}>([\s\S]*?)<\/Rotulo>/g)].map(
    (m) => m[1],
  );
  assert.equal(rotulos.length, 2, 'Deben ser dos rotulos: la cabecera y el nombre de grupo.');
  for (const marca of ['Elige hasta ${maximo} temas', 'grupo.nombre.toUpperCase()']) {
    assert.ok(
      rotulos.some((bloque) => bloque.includes(marca)),
      `«${marca}» vuelve a ir suelto encima de la imagen.`,
    );
  }
  // Y el nombre del grupo deja de ir en el gris que primero se pierde.
  assert.match(selector, /color=\{esSobreMedia \? superficie\.text : superficie\.textMuted\}/);
});

test('con la variante clara no se envuelve nada', () => {
  /*
    Sobre una pantalla normal el fondo ya es opaco y el color sale del tema, que
    distingue claro de oscuro. Meter ahi una capsula oscura seria el mismo
    fallo del otro lado: un parche de modo oscuro dentro del modo claro.
  */
  const selector = fuente('components/SelectorDeTemas.tsx');
  assert.match(selector, /if \(!sobre\) return <>\{children\}<\/>;/);
});

test('el rotulo no se remonta en cada eleccion de tema', () => {
  /*
    Definido DENTRO del componente tenia identidad nueva en cada render, asi que
    React desmontaba y volvia a montar el subarbol cada vez que se elegia un
    tema. Fuera, la identidad es estable.
  */
  const selector = fuente('components/SelectorDeTemas.tsx');
  assert.ok(
    selector.indexOf('function Rotulo(') < selector.indexOf('export function SelectorDeTemas('),
    'Rotulo volvio a declararse dentro del componente.',
  );
});

// ---------------------------------------------------------------------------
// 3. Tokens del tema, nunca colores escritos a mano
// ---------------------------------------------------------------------------

for (const ruta of TODOS) {
  test(`${ruta} no escribe colores a mano`, () => {
    const texto = fuente(ruta);
    const literales = [...texto.matchAll(/#[0-9A-Fa-f]{3,8}\b|rgba?\(/g)].map((m) => m[0]);
    assert.deepEqual(
      literales,
      [],
      `${ruta} tiene colores literales (${literales.join(', ')}). ` +
        'La regla del proyecto es consumir tokens semanticos de theme/tokens.ts.',
    );
  });
}

test('la paleta de «encima de un medio» tiene un unico origen', () => {
  /*
    Cada pantalla declaraba su propio `palette('dark')`. Mientras sean iguales
    da igual, pero es justo asi como una de ellas se queda atras en el proximo
    arreglo. El origen es `sobreMedio`, en CapaDeContraste.
  */
  const culpables = TODOS.filter(
    // CapaDeContraste es el origen: es el unico que puede nombrar la paleta.
    (ruta) => ruta !== 'components/CapaDeContraste.tsx' && fuente(ruta).includes("palette('dark')"),
  );
  assert.deepEqual(
    culpables,
    [],
    'Estos archivos vuelven a declarar la paleta oscura por su cuenta: importa ' +
      '`sobreMedio` de @/components/CapaDeContraste.',
  );
});

// ---------------------------------------------------------------------------
// 4. La capa oscurece el MEDIO, no el tema, y no se come los toques
// ---------------------------------------------------------------------------

test('el scrim no captura los toques de los botones que protege', () => {
  const capa = fuente('components/CapaDeContraste.tsx');
  assert.ok(
    /pointerEvents="none"/.test(capa),
    'El scrim esta por delante del video y por detras de los botones: sin ' +
      'pointerEvents="none" no se podria pulsar nada.',
  );
});

test('el contraste sobre medios no depende del tema de la persona', () => {
  const capa = fuente('components/CapaDeContraste.tsx');
  /*
    Una historia a pantalla completa se ve igual con la aplicacion en claro que
    en oscuro. Si esto se atara a `useAppTheme`, alguien con el tema claro
    acabaria con texto oscuro sobre un video oscuro: el mismo fallo, del otro
    lado.
  */
  assert.ok(
    !capa.includes('useAppTheme'),
    'CapaDeContraste no puede depender del tema: el contexto sobre un medio es ' +
      'oscuro en los DOS temas.',
  );
  assert.ok(
    /export const sobreMedio = palette\('dark'\)/.test(capa),
    'Falta el origen unico de la paleta sobre medios.',
  );
});

// ---------------------------------------------------------------------------
// 5. El estado no se cuenta solo con color
// ---------------------------------------------------------------------------

test('el progreso se entiende sin distinguir colores', () => {
  const progreso = fuente('components/crear/ProgresoDePublicacion.tsx');
  assert.ok(
    /const ICONO/.test(progreso) && progreso.includes('alert-triangle'),
    'Cada fase debe llevar icono ademas de color: error, subida y publicacion ' +
      'no pueden distinguirse solo por el tono del texto.',
  );
});

test('las fases de subida estan traducidas', () => {
  const progreso = fuente('components/crear/ProgresoDePublicacion.tsx');
  /*
    Estaban escritas en español DENTRO del componente, asi que quien tuviera la
    aplicacion en ingles o en portugues leia «Subiendo…» igual.
  */
  for (const suelto of ['Optimizando…', 'Subiendo…', 'Publicando…']) {
    assert.ok(
      !progreso.includes(`'${suelto}'`),
      `«${suelto}» sigue escrito a mano en ProgresoDePublicacion: usa t(clave).`,
    );
  }
  assert.ok(
    /const CLAVE: Partial<Record<FaseDePublicacion, TranslationKey>>/.test(progreso),
    'Las fases deben resolverse por clave de traduccion.',
  );
});

// ---------------------------------------------------------------------------
// 6. Se conserva lo que ya se podia tocar
// ---------------------------------------------------------------------------

test('cancelar y reintentar siguen siendo botones de verdad', () => {
  const progreso = fuente('components/crear/ProgresoDePublicacion.tsx');
  /*
    Cancelar era una palabra de 11 px sin forma ni borde, con `minHeight: 32`.
    Ademas de invisible, habia que apuntar.
  */
  assert.ok(
    /minHeight: 44/.test(progreso),
    'Los botones de la caja de progreso bajaron del minimo tactil de 44 px.',
  );
  const etiquetas = (progreso.match(/accessibilityLabel=/g) ?? []).length;
  assert.ok(
    etiquetas >= 2,
    'Cancelar y Reintentar deben llevar etiqueta accesible.',
  );
});

test('los botones de volver se distinguen sobre cualquier foto', () => {
  for (const ruta of SOBRE_MEDIOS) {
    const texto = fuente(ruta);
    if (!texto.includes('styles.volver')) continue;
    const posicion = texto.indexOf('volver: {');
    assert.notEqual(posicion, -1, `${ruta}: falta el estilo del boton de volver.`);
    const bloque = texto.slice(posicion, posicion + 600);
    assert.ok(
      bloque.includes('media.overlay') && bloque.includes('borderColor'),
      `${ruta}: la flecha de volver necesita velo Y borde; sobre una esquina ` +
        'clara un icono blanco sin fondo no se ve.',
    );
  }
});
