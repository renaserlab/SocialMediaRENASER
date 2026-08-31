/**
 * Las decisiones del CRM de etiquetas cuya ruptura NO daría ningún error.
 *
 * ESTO NO SE PUEDE PROBAR EJECUTÁNDOLO, igual que `messageMedia.test.mts`: los
 * módulos importan React Native y las pruebas de este proyecto corren con el
 * runner de Node, sin renderizador. Así que se comprueba sobre el TEXTO de los
 * ficheros. No es una prueba de comportamiento: es un cerrojo sobre cuatro
 * decisiones que, si alguien las deshace, dejarían todo compilando, todo
 * funcionando y la aplicación entera con el mismo aspecto.
 *
 * Y ése es exactamente el problema con las tres primeras: un fallo de
 * privacidad no se manifiesta como un fallo. Nadie ve una pantalla rota; lo que
 * pasa es que la persona al otro lado se entera de que para mí es un
 * «Pendiente».
 *
 * Lo que de verdad garantiza la privacidad está en el servidor —cada consulta
 * filtra por `owner_id`, y la RLS de la 0045 lo dice otra vez—. Esto cubre la
 * mitad del teléfono: que nadie vuelva a traerse las etiquetas por otro camino
 * ni a guardarlas donde no deben.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

const REPOSITORIO = fuente('repositories/EtiquetasRepository.ts');
const CHIPS = fuente('components/ChipsDeEtiquetas.tsx');
const GESTOR = fuente('components/GestorDeEtiquetas.tsx');

// ---------------------------------------------------------------------------
// 1. Las etiquetas no se guardan en el teléfono
// ---------------------------------------------------------------------------
describe('dónde viven las etiquetas', () => {
  it('no se guardan en el disco del dispositivo', () => {
    // Una etiqueta es trabajo de organización, no una preferencia de pantalla:
    // tiene que seguir ahí al reinstalar, en otro teléfono y en la web. Una
    // copia en AsyncStorage además sobreviviría al cierre de sesión, y lo que
    // quedaría en el disco es una lista de juicios sobre personas.
    // Se busca el USO, no la palabra: la cabecera del repositorio explica
    // precisamente por qué no se usa, y una prueba que fallara por leer su
    // propia explicación obligaría a borrar el motivo para pasar.
    for (const [nombre, texto] of [
      ['EtiquetasRepository.ts', REPOSITORIO],
      ['ChipsDeEtiquetas.tsx', CHIPS],
      ['GestorDeEtiquetas.tsx', GESTOR],
    ] as const) {
      assert.equal(
        /async-storage/.test(texto) || /AsyncStorage\s*\./.test(texto),
        false,
        `${nombre} no puede guardar etiquetas en el dispositivo: tienen que ` +
          'sobrevivir a cerrar la aplicación, a otro teléfono y a la web.',
      );
    }
  });

  it('todas las peticiones van al backend, no a Supabase directamente', () => {
    // La política completa —incluida la pertenencia a la conversación— vive en
    // un solo sitio, el backend. Hablar con Supabase desde aquí dejaría esa
    // regla dependiendo sólo de la RLS, que es la segunda cerradura y no la
    // primera.
    assert.equal(
      REPOSITORIO.includes('supabase'),
      false,
      'Las etiquetas se piden por la API, para que la política viva en un sitio.',
    );
    assert.ok(
      /apiRequest</.test(REPOSITORIO),
      'El repositorio tiene que usar `apiRequest`.',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Filtrar es cosa del servidor
// ---------------------------------------------------------------------------
describe('el filtro por etiqueta', () => {
  it('la fila de chips no filtra conversaciones por su cuenta', () => {
    // Con doscientas conversaciones, filtrar las veinte que hay en memoria es
    // mentirle a quien busca: faltarían las que aún no se han bajado y la
    // paginación devolvería páginas medio vacías. El componente sólo avisa de
    // qué se ha elegido; quien vuelve a preguntar al servidor es la pantalla.
    assert.equal(
      /conversaciones\s*[.\s]*\.filter\(/.test(CHIPS),
      false,
      'ChipsDeEtiquetas no puede filtrar la lista de conversaciones en el teléfono.',
    );
    assert.ok(
      /alSeleccionar:\s*\(id: string \| null\) => void/.test(CHIPS),
      'La fila de chips sólo avisa de la etiqueta elegida.',
    );
  });

  it('no guarda dentro cuál está elegida', () => {
    // Si el componente se quedara «la elegida», discreparía de lo que se está
    // mostrando en cuanto la pantalla recargara: el estado tiene que vivir
    // donde se lanza la consulta que filtra.
    assert.equal(
      /useState/.test(CHIPS),
      false,
      'La etiqueta elegida vive en la pantalla, que es quien consulta al servidor.',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Nunca un botón muerto
// ---------------------------------------------------------------------------
describe('sin la migración 0045', () => {
  it('la carga no puede lanzar y deja la función apagada', () => {
    // La bandeja tiene que abrirse aunque el CRM no conteste: la lista de
    // conversaciones y la de etiquetas son dos peticiones distintas, y que la
    // segunda falle no puede dejar a nadie sin sus mensajes.
    assert.ok(
      /export async function cargarEtiquetas\(\): Promise<EstadoDeEtiquetas>/.test(
        REPOSITORIO,
      ),
      'Tiene que existir `cargarEtiquetas`, que es la que no falla.',
    );
    assert.ok(
      /return \{ disponible: false, etiquetas: \[\] \}/.test(REPOSITORIO),
      'Un fallo al cargar tiene que apagar la función, no propagarse.',
    );
  });

  it('la fila de chips desaparece en vez de dejar un botón que no hace nada', () => {
    assert.ok(
      /if \(!disponible\) return null;/.test(CHIPS),
      'Sin la 0045 no se ofrece la función: nunca un botón muerto.',
    );
  });

  it('el 503 de la migración se distingue de un fallo de verdad', () => {
    // Por código y no por el estado 503 a secas: un 503 también puede venir de
    // un despliegue a medias o de un proxy, y entonces lo que toca es avisar,
    // no esconder una función que sí existe.
    assert.ok(
      REPOSITORIO.includes("'conversation_labels_not_available'"),
      'Hace falta el código propio del backend para distinguirlo.',
    );
    assert.ok(
      /error\.code === ETIQUETAS_NO_DISPONIBLES/.test(REPOSITORIO),
      'Se compara el código del error, no sólo el estado HTTP.',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. El gesto horizontal no se lleva la pantalla
// ---------------------------------------------------------------------------
describe('la fila horizontal', () => {
  it('está blindada frente al cambio de sección', () => {
    // Sin esto, arrastrar la fila de etiquetas se llevaría la pestaña entera a
    // la de al lado. Es la regla de todo scroll horizontal dentro de las
    // secciones (ver `navigation/tabSwipe.tsx`).
    assert.ok(
      CHIPS.includes('SinCambioDeSeccion'),
      'La fila de chips tiene que ir dentro de `SinCambioDeSeccion`.',
    );
    const dentro = CHIPS.indexOf('<SinCambioDeSeccion>');
    const scroll = CHIPS.indexOf('<ScrollView');
    assert.ok(
      dentro !== -1 && scroll > dentro,
      'El ScrollView horizontal tiene que ir DENTRO de `SinCambioDeSeccion`.',
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Que se sepa que son privadas
// ---------------------------------------------------------------------------
describe('lo que se le dice a quien etiqueta', () => {
  it('el gestor dice a la vista que sólo las ve él', () => {
    // Quien va a etiquetar a alguien como «Interesado» tiene que saberlo ANTES
    // de escribirlo. Si no lo sabe, o no lo usa por miedo a ofender, o lo usa
    // creyendo que es compartido. Las dos cosas son peores que una línea.
    assert.ok(
      GESTOR.includes("t('label.explain')"),
      'El gestor tiene que explicar que las etiquetas son privadas.',
    );
    assert.ok(
      GESTOR.includes("t('label.onlyYou')"),
      'Al poner una etiqueta en un chat también se dice que sólo la ve uno.',
    );
  });

  it('borrar una etiqueta avisa de que no se borra ninguna conversación', () => {
    // Es lo que más miedo da al pulsarlo, y la respuesta es que no pasa: se
    // quita la etiqueta y nada más.
    assert.ok(
      GESTOR.includes("t('label.deleteKeepsChats'"),
      'La confirmación tiene que decir que no se borra ninguna conversación.',
    );
  });
});
