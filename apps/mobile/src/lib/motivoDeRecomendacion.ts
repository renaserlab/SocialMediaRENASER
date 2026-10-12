import type { RecommendationReason } from '@/repositories/RecommendationRepository';
import type { TranslationKey } from '@/i18n';
/**
 * Cómo se traduce lo que sale de aquí.
 *
 * Lo pasa quien pinta, que es React y tiene `useTranslation`. Este módulo NO
 * puede importar el diccionario: se prueba con el runner de Node, que no
 * resuelve el alias `@/`, y un import de valor dejaría su prueba sin arrancar.
 * Sin traductor se escribe en español, que es el idioma de referencia.
 */
export type TraductorDeMotivos = (
  clave: TranslationKey,
  params?: Record<string, string | number>,
) => string;


/**
 * De codigo de motivo a frase que se entiende.
 *
 * POR QUE VIVE AQUI Y NO EN EL SERVIDOR. El backend devuelve `TOPIC_MATCH` y
 * los temas implicados, no una frase hecha: la frase depende del idioma, del
 * tono del producto y de donde se pinte (una tarjeta pequena no admite lo
 * mismo que una hoja de detalle). Mandarla ya escrita ataria el texto a un
 * despliegue del backend y a un solo idioma.
 *
 * Y por que en un fichero aparte de la pantalla: porque es logica que se puede
 * probar sin dibujar nada, y porque la usan dos sitios (la tarjeta y el «por
 * qué aparece»).
 */

/**
 * El español de cada clave.
 *
 * Es el mismo texto que hay en `i18n/es.ts`, y que no se desvíen lo comprueba
 * `i18n/diccionariosSincronizados.test.mts`.
 */
export const RESPALDOS_ES = {
  'reason.joinTwo': '{a} y {b}',
  'reason.joinMany': '{lista} y {ultimo}',
  'reason.topicMatch': 'Coincide con lo que quieres aprender: {temas}',
  'reason.teaches': 'Enseña {temas}',
  'reason.teachesGeneric': 'Enseña lo que buscas',
  'reason.canHelp': 'Puede ayudarte con {temas}',
  'reason.canHelpGeneric': 'Puede ayudarte con lo que buscas',
  'reason.experienced': 'Tiene experiencia práctica en {temas}',
  'reason.experiencedGeneric': 'Tiene experiencia práctica',
  'reason.intentMatch': 'Es el tipo de conexión que buscas',
  'reason.oneToOne': 'Ofrece sesiones 1 a 1',
  'reason.preferredFormat': 'Publica en el formato que prefieres',
  'reason.engagedBefore': 'Ya mostraste interés por su contenido',
  'reason.similarInterests': 'Tienen intereses parecidos',
  'reason.activeCreator': 'Comparte cosas a menudo',
  'reason.newVoice': 'Una voz nueva que quizá no conoces',
} as const;

/** El respaldo en español, con sus huecos ya sustituidos. */
export const enEspanol: TraductorDeMotivos = (clave, params) => {
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

/** La frase de UN motivo. Vacia si el codigo no se conoce. */
export function frasePorMotivo(
  motivo: RecommendationReason,
  traducir: TraductorDeMotivos = enEspanol,
): string {
  const t = traducir;
  const temas = lista(motivo.topics ?? [], t);
  switch (motivo.code) {
    case 'TOPIC_MATCH':
      return temas ? t('reason.topicMatch', { temas }) : '';
    case 'TEACHES':
      return temas ? t('reason.teaches', { temas }) : t('reason.teachesGeneric');
    case 'CAN_HELP':
      return temas ? t('reason.canHelp', { temas }) : t('reason.canHelpGeneric');
    case 'EXPERIENCED':
      return temas ? t('reason.experienced', { temas }) : t('reason.experiencedGeneric');
    case 'INTENT_MATCH':
      return t('reason.intentMatch');
    case 'PREFERRED_1_TO_1':
      return t('reason.oneToOne');
    case 'PREFERRED_FORMAT':
      return t('reason.preferredFormat');
    case 'YOU_ENGAGED_BEFORE':
      return t('reason.engagedBefore');
    case 'SIMILAR_INTERESTS':
      // Sin temas A PROPOSITO: nombrarlos revelaria lo que la otra persona
      // busca, y eso no es informacion publica.
      return t('reason.similarInterests');
    case 'ACTIVE_CREATOR':
      return t('reason.activeCreator');
    case 'NEW_VOICE':
      return t('reason.newVoice');
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
export function frasePrincipal(
  motivos: RecommendationReason[],
  traducir: TraductorDeMotivos = enEspanol,
): string {
  for (const motivo of motivos) {
    const frase = frasePorMotivo(motivo, traducir);
    if (frase) return frase;
  }
  return '';
}

/** Todas las frases, para el detalle de «por qué aparece». */
export function frasesDeMotivos(
  motivos: RecommendationReason[],
  traducir: TraductorDeMotivos = enEspanol,
): string[] {
  return motivos
    .map((motivo) => frasePorMotivo(motivo, traducir))
    .filter((frase) => frase.length > 0);
}
