import type { RecommendationReason } from '@/repositories/RecommendationRepository';

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

function lista(temas: string[]): string {
  if (temas.length === 0) return '';
  if (temas.length === 1) return temas[0]!;
  if (temas.length === 2) return `${temas[0]} y ${temas[1]}`;
  return `${temas.slice(0, -1).join(', ')} y ${temas[temas.length - 1]}`;
}

/** La frase de UN motivo. Vacia si el codigo no se conoce. */
export function frasePorMotivo(motivo: RecommendationReason): string {
  const temas = lista(motivo.topics ?? []);
  switch (motivo.code) {
    case 'TOPIC_MATCH':
      return temas ? `Coincide con lo que quieres aprender: ${temas}` : '';
    case 'TEACHES':
      return temas ? `Enseña ${temas}` : 'Enseña lo que buscas';
    case 'CAN_HELP':
      return temas ? `Puede ayudarte con ${temas}` : 'Puede ayudarte con lo que buscas';
    case 'EXPERIENCED':
      return temas ? `Tiene experiencia práctica en ${temas}` : 'Tiene experiencia práctica';
    case 'INTENT_MATCH':
      return 'Es el tipo de conexión que buscas';
    case 'PREFERRED_1_TO_1':
      return 'Ofrece sesiones 1 a 1';
    case 'PREFERRED_FORMAT':
      return 'Publica en el formato que prefieres';
    case 'YOU_ENGAGED_BEFORE':
      return 'Ya mostraste interés por su contenido';
    case 'SIMILAR_INTERESTS':
      // Sin temas A PROPOSITO: nombrarlos revelaria lo que la otra persona
      // busca, y eso no es informacion publica.
      return 'Tenéis intereses parecidos';
    case 'ACTIVE_CREATOR':
      return 'Comparte cosas a menudo';
    case 'NEW_VOICE':
      return 'Una voz nueva que quizá no conoces';
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
export function frasePrincipal(motivos: RecommendationReason[]): string {
  for (const motivo of motivos) {
    const frase = frasePorMotivo(motivo);
    if (frase) return frase;
  }
  return '';
}

/** Todas las frases, para el detalle de «por qué aparece». */
export function frasesDeMotivos(motivos: RecommendationReason[]): string[] {
  return motivos.map(frasePorMotivo).filter((frase) => frase.length > 0);
}
