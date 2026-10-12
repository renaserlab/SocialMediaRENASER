import type { RecommendationReason } from '@/repositories/RecommendationRepository';
import type { TraductorDeMotivos } from '@/lib/motivoDeRecomendacion';

/**
 * De codigo de motivo de un CURSO a frase que se entiende.
 *
 * POR QUE VIVE AQUI Y NO EN EL SERVIDOR. El backend devuelve
 * `COURSE_TOPIC_MATCH` y los temas implicados, no una frase hecha: la frase
 * depende del idioma, del tono del producto y de donde se pinte. Mandarla ya
 * escrita ataria el texto a un despliegue del backend y a un solo idioma.
 *
 * POR QUE ES UN FICHERO APARTE DE `motivoDeRecomendacion` Y NO UN `case` MAS.
 * Son dos vocabularios distintos —`TEACHES` no le pasa a un curso,
 * `NEW_COURSE` no le pasa a una persona— y, sobre todo, los temas NO llegan
 * igual: en las personas vienen ya con NOMBRE y en los cursos vienen como
 * IDENTIFICADOR. Mezclarlos en una sola funcion habria significado que el tipo
 * de `topics` dependiera de quien llama, que es la clase de detalle que se
 * olvida y acaba pintando un uuid en pantalla.
 *
 * LA REGLA QUE NO SE PUEDE ROMPER: la frase tiene que ser VERDAD y tiene que
 * ser legible. Un identificador dentro de una frase no es ninguna de las dos
 * cosas, asi que cuando un tema no se sabe traducir se degrada a la version sin
 * tema en vez de ensenarlo en crudo.
 */

/**
 * Nombres de tema por identificador, tal y como sale del catalogo
 * (`RecommendationRepository.listTopics('curso')`).
 *
 * Puede llegar VACIO y no es un error: el catalogo responde una lista vacia
 * mientras el servidor no pueda guardar los temas de los cursos. Entonces todas
 * las frases caen a su version sin tema y la seccion sigue funcionando.
 */
export type NombresDeTema = Readonly<Record<string, string>>;

/**
 * El español de cada clave.
 *
 * Es el mismo texto que hay en `i18n/es.ts`, y que no se desvíen lo comprueba
 * `i18n/diccionariosSincronizados.test.mts`. Vive aquí y no se importa del
 * diccionario por lo mismo que en `motivoDeRecomendacion`: este módulo se
 * prueba con el runner de Node, que no resuelve el alias `@/`.
 */
export const RESPALDOS_ES = {
  'courseReason.topicMatch': 'Porque quieres aprender {temas}',
  'courseReason.topicMatchGeneric': 'Porque trata de algo que quieres aprender',
  'courseReason.learningGoal': 'Encaja con lo que buscas: aprender',
  'courseReason.preferredFormat': 'Prefieres aprender en formato curso',
  'courseReason.creatorAffinity': 'De alguien cuyo contenido ya te interesa',
  'courseReason.recentInterest': 'Por lo que has estado viendo últimamente',
  'courseReason.newCourse': 'Se publicó hace poco',
  'courseReason.worthALook': 'Todavía no lo ha visto mucha gente',
  // Las mismas dos que en `motivoDeRecomendacion`: se repiten aquí porque no se
  // puede importar de allí un valor sin romper la prueba de este módulo (el
  // runner de Node no resuelve el alias `@/`). La prueba de diccionarios
  // comprueba que las dos copias digan lo mismo que `i18n/es.ts`.
  'reason.joinTwo': '{a} y {b}',
  'reason.joinMany': '{lista} y {ultimo}',
} as const;

/** El respaldo en español. */
const respaldo: TraductorDeMotivos = (clave, params) => {
  let texto: string = RESPALDOS_ES[clave as keyof typeof RESPALDOS_ES] ?? '';
  for (const [nombre, valor] of Object.entries(params ?? {})) {
    texto = texto.replace(`{${nombre}}`, String(valor));
  }
  return texto;
};

function lista(temas: string[], t: TraductorDeMotivos): string {
  if (temas.length === 0) return '';
  if (temas.length === 1) return temas[0]!;
  if (temas.length === 2) return t('reason.joinTwo', { a: temas[0]!, b: temas[1]! });
  return t('reason.joinMany', {
    lista: temas.slice(0, -1).join(', '),
    ultimo: temas[temas.length - 1]!,
  });
}

/**
 * De identificadores a nombres, TIRANDO lo que no se sepa traducir.
 *
 * Un id sin nombre puede ser un tema anadido despues de que se cargara el
 * catalogo, o el catalogo entero sin llegar. En ninguno de los dos casos se
 * puede ensenar el id: se descarta y la frase se queda con los que si tienen
 * nombre, o sin ninguno.
 */
function nombresDe(ids: string[] | undefined, nombres: NombresDeTema): string[] {
  return (ids ?? [])
    .map((id) => nombres[id])
    .filter((nombre): nombre is string => typeof nombre === 'string' && nombre.trim() !== '');
}

/** La frase de UN motivo. Vacia si el codigo no se conoce. */
export function frasePorMotivoDeCurso(
  motivo: RecommendationReason,
  nombres: NombresDeTema = {},
  traducir: TraductorDeMotivos = respaldo,
): string {
  const t = traducir;
  const temas = lista(nombresDe(motivo.topics, nombres), t);
  switch (motivo.code) {
    case 'COURSE_TOPIC_MATCH':
      // Con tema es mucho mas util, pero sin el sigue siendo cierto: el motivo
      // por el que aparece es que trata de algo que esta persona quiere
      // aprender, se pueda nombrar o no.
      return temas
        ? t('courseReason.topicMatch', { temas })
        : t('courseReason.topicMatchGeneric');
    case 'LEARNING_GOAL_MATCH':
      return t('courseReason.learningGoal');
    case 'PREFERRED_COURSE_FORMAT':
      return t('courseReason.preferredFormat');
    case 'CREATOR_AFFINITY':
      // «Cuyo contenido ya te interesa» y no «a quien sigues»: el motivo tambien
      // se dispara por consumo sin seguimiento, y afirmar lo segundo seria
      // falso la mitad de las veces.
      return t('courseReason.creatorAffinity');
    case 'RECENT_INTEREST':
      return t('courseReason.recentInterest');
    case 'NEW_COURSE':
      return t('courseReason.newCourse');
    case 'WORTH_A_LOOK':
      // Sale por exploracion, sin nada a su favor todavia. Se dice en voz alta
      // en vez de disfrazarlo de coincidencia: presentar un descubrimiento como
      // si encajara con lo que alguien busca ensena a desconfiar del resto.
      return t('courseReason.worthALook');
    default:
      // Un codigo que esta version de la aplicacion no conoce no se inventa ni
      // se pinta en crudo: simplemente no se dice nada de el.
      return '';
  }
}

/**
 * La frase que va en la tarjeta: la del motivo mas informativo, que es el
 * primero (el servidor los ordena de mas a menos explicativo).
 */
export function frasePrincipalDeCurso(
  motivos: RecommendationReason[],
  nombres: NombresDeTema = {},
  traducir: TraductorDeMotivos = respaldo,
): string {
  for (const motivo of motivos) {
    const frase = frasePorMotivoDeCurso(motivo, nombres, traducir);
    if (frase) return frase;
  }
  return '';
}

/** Todas las frases, para el detalle de «por qué aparece». */
export function frasesDeMotivosDeCurso(
  motivos: RecommendationReason[],
  nombres: NombresDeTema = {},
  traducir: TraductorDeMotivos = respaldo,
): string[] {
  return motivos
    .map((motivo) => frasePorMotivoDeCurso(motivo, nombres, traducir))
    .filter((frase) => frase.length > 0);
}
