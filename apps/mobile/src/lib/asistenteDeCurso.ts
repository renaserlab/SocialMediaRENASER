/**
 * La lógica del asistente de curso, sin React.
 *
 * Está aquí y no dentro de la pantalla porque es lo único que se puede probar
 * de verdad: este proyecto no monta componentes en las pruebas, así que todo lo
 * que decida algo —qué paso está completo, cuánto dura el curso, qué se le
 * enseña a quien espera una revisión— tiene que poder llamarse desde una
 * función suelta.
 *
 * LO QUE **NO** VIVE AQUÍ: las reglas para publicar. Esas las decide el
 * servidor (`_requisitos_que_faltan` en `catalog/router.py`) y la pantalla se
 * limita a enseñar lo que él responde. Repetirlas aquí garantiza que un día la
 * aplicación diga que todo está listo y el servidor diga que no.
 *
 * Lo de abajo es distinto: son PISTAS para el indicador de pasos —un punto
 * relleno o vacío— y ninguna impide avanzar. Un asistente que no deja pasar al
 * paso siguiente hasta rellenarlo entero es un formulario con más pasos.
 */

/** Los pasos, en orden. El id se usa como clave; el orden es el del array. */
export const PASOS = [
  { id: 'basico', titulo: 'Información básica', icono: 'file-text' },
  { id: 'oferta', titulo: 'Qué ofrece', icono: 'award' },
  { id: 'contenido', titulo: 'Contenido', icono: 'list' },
  { id: 'precio', titulo: 'Precio', icono: 'tag' },
  { id: 'revisar', titulo: 'Revisar y enviar', icono: 'send' },
] as const;

export type PasoId = (typeof PASOS)[number]['id'];

/** Lo que el asistente tiene en la mano mientras se edita. */
export type BorradorDeCurso = {
  title: string;
  subtitle: string;
  description: string;
  primaryTopicId: string | null;
  topicIds: string[];
  level: string | null;
  language: string;
  highlights: string[];
  targetAudience: string[];
  prerequisites: string[];
  dePago: boolean;
  /** Texto tal y como se escribe; se convierte con `lib/dinero.ts`. */
  precio: string;
};

/** Un módulo con sus lecciones, en lo mínimo que necesita el asistente. */
export type ResumenDeModulo = {
  id: string;
  lessons: Array<{ id: string; durationSeconds: number }>;
};

/**
 * La duración de todo el curso, en segundos.
 *
 * Se suma de las lecciones y NO del vídeo de presentación: quien mira quiere
 * saber cuánto dura lo que va a estudiar, no cuánto dura el anuncio.
 */
export function duracionTotal(modulos: ResumenDeModulo[]): number {
  return modulos.reduce(
    (total, modulo) =>
      total + modulo.lessons.reduce((suma, l) => suma + (l.durationSeconds || 0), 0),
    0,
  );
}

/**
 * «3 h 20 min», «45 min», «2 min».
 *
 * Nunca «0 min»: un curso sin contenido no dura cero, es que todavía no tiene
 * contenido, y son dos cosas distintas para quien lo lee.
 */
export function duracionLegible(segundos: number): string {
  if (!segundos || segundos <= 0) return 'Sin contenido todavía';
  const minutosTotales = Math.max(1, Math.round(segundos / 60));
  const horas = Math.floor(minutosTotales / 60);
  const minutos = minutosTotales % 60;
  if (horas === 0) return `${minutos} min`;
  if (minutos === 0) return `${horas} h`;
  return `${horas} h ${minutos} min`;
}

/** Cuántas lecciones tiene el curso entero. */
export function totalDeLecciones(modulos: ResumenDeModulo[]): number {
  return modulos.reduce((total, modulo) => total + modulo.lessons.length, 0);
}

/**
 * Si un paso ya tiene lo suyo. Es una PISTA para el indicador, no un permiso.
 *
 * `revisar` no se marca nunca: es el paso donde se mira todo lo demás, así que
 * decir que está «completo» no significaría nada.
 */
export function pasoCompleto(
  paso: PasoId,
  borrador: BorradorDeCurso,
  modulos: ResumenDeModulo[],
): boolean {
  switch (paso) {
    case 'basico':
      return (
        borrador.title.trim().length > 0 &&
        borrador.description.trim().length >= 30 &&
        !!borrador.primaryTopicId &&
        !!borrador.level
      );
    case 'oferta':
      return borrador.highlights.some((h) => h.trim().length > 0);
    case 'contenido':
      return modulos.length > 0 && totalDeLecciones(modulos) > 0;
    case 'precio':
      // Un curso gratuito ya está decidido: gratis es una respuesta, no un
      // hueco. Uno de pago necesita además un importe escrito.
      return !borrador.dePago || borrador.precio.trim().length > 0;
    default:
      return false;
  }
}

/** Lo que se le enseña a quien mira el estado de su revisión. */
export type AvisoDeRevision = {
  icono: 'edit-3' | 'clock' | 'check-circle' | 'alert-circle';
  titulo: string;
  detalle: string;
};

/**
 * Cómo se cuenta cada estado de la revisión.
 *
 * El color NUNCA es el único portador: cada estado lleva icono y texto propios,
 * que es la regla del sistema visual de este proyecto.
 */
export function avisoDeRevision(
  reviewStatus: string | undefined,
  motivo?: string | null,
): AvisoDeRevision {
  switch (reviewStatus) {
    case 'pending_review':
      return {
        icono: 'clock',
        titulo: 'En revisión',
        detalle: 'Alguien del equipo lo está mirando. Te avisaremos al resolverla.',
      };
    case 'approved':
      return {
        icono: 'check-circle',
        titulo: 'Aprobado',
        detalle: 'Ya puedes publicarlo cuando quieras. La decisión sigue siendo tuya.',
      };
    case 'rejected':
      return {
        icono: 'alert-circle',
        titulo: 'Revisión rechazada',
        // El motivo es lo único que permite corregir; si falta, se dice que
        // falta en vez de dejar un hueco que parece un fallo de la aplicación.
        detalle: motivo?.trim() || 'No se indicó un motivo. Escríbenos si no sabes qué corregir.',
      };
    default:
      return {
        icono: 'edit-3',
        titulo: 'Borrador',
        detalle: 'Solo lo ves tú. Cuando esté listo, envíalo a revisión.',
      };
  }
}

/**
 * Si tiene sentido ofrecer «Enviar a revisión» en vez de «Publicar».
 *
 * Sin la migración 0034 el servidor no tiene dónde guardar una revisión y
 * responde 503, así que se ofrece publicar directamente, que es lo que se hacía
 * hasta ahora. NUNCA un botón que no lleva a ninguna parte.
 */
export function accionFinal(
  reviewAvailable: boolean,
  reviewStatus: string | undefined,
): 'enviar' | 'publicar' | 'esperar' {
  if (!reviewAvailable) return 'publicar';
  if (reviewStatus === 'approved') return 'publicar';
  if (reviewStatus === 'pending_review') return 'esperar';
  return 'enviar';
}

/**
 * Cuántos temas puede elegir el autor, ADEMÁS de la categoría principal.
 *
 * Es el mismo tope que aplica el servidor (`MAX_TEMAS_POR_CURSO`).
 */
export const MAX_TEMAS_DEL_AUTOR = 5;

/**
 * Cuántos temas ofrece el selector. La categoría principal NO descuenta.
 *
 * Son 1 + 5, no 5 en total: la categoría es la categoría y estos cinco son
 * «el resto». Haciéndola contar, elegir categoría dejaba al autor con cuatro
 * huecos de golpe, sin que nada explicara por qué se le había encogido la
 * lista. La fila de la categoría se escribe igualmente en `course_topics`
 * —si no, el recomendador no vería de qué trata el curso—, pero se escribe
 * aparte y fuera del tope.
 */
export function maximoDeTemas(_principalElegida: string | null): number {
  return MAX_TEMAS_DEL_AUTOR;
}

/**
 * Los temas del autor tras elegir (o quitar) la categoría principal.
 *
 * La categoría no gasta un hueco, pero tampoco se repite: si ya estaba elegida
 * como tema, sale de esa lista para no aparecer dos veces en la ficha. Y NO se
 * recorta nada: quien tenía cinco los conserva.
 */
export function temasAlElegirCategoria(
  temas: string[],
  principal: string | null,
): string[] {
  if (!principal) return temas;
  return temas.filter((tema) => tema !== principal);
}

/**
 * Cuántas filas acabará teniendo `course_topics`: los del autor más la
 * categoría. Hasta seis.
 */
export function totalDeTemas(temas: string[], principal: string | null): number {
  return temasAlElegirCategoria(temas, principal).length + (principal ? 1 : 0);
}

/**
 * La lista de ids en el orden resultante de mover uno de sitio.
 *
 * Devuelve la MISMA lista cuando el movimiento no cambia nada (subir el
 * primero, bajar el último), para que quien llama pueda no escribir nada.
 */
export function moviendo(ids: string[], desde: number, hacia: number): string[] {
  if (desde === hacia || desde < 0 || hacia < 0) return ids;
  if (desde >= ids.length || hacia >= ids.length) return ids;
  const copia = [...ids];
  const movido = copia.splice(desde, 1)[0];
  if (movido === undefined) return ids;
  copia.splice(hacia, 0, movido);
  return copia;
}
