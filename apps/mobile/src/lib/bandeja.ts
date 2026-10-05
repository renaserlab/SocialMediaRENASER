/**
 * La lógica de la bandeja de mensajes, separada de cómo se pinta.
 *
 * POR QUÉ VIVE AQUÍ Y NO DENTRO DE `MessagesScreen`. Porque es lo único de la
 * pantalla que se puede probar: las pruebas de móvil de este repositorio son
 * `node --test` sobre ficheros `.mts`, sin renderizador de React Native. Un
 * fusionado de páginas escrito dentro del componente no lo comprueba nadie, y es
 * justo la clase de código que se rompe en silencio —una conversación repetida,
 * una página que se salta filas— y no se nota hasta que alguien se queja.
 *
 * NO IMPORTA NADA A PROPÓSITO. Este fichero se carga desde el runner de Node,
 * que no resuelve el alias `@/`. El antirrebote y la normalización del texto sí
 * se reutilizan de `lib/busquedaProgresiva.ts` —está escrito y probado— pero se
 * usan desde el componente del buscador, que es donde de verdad corre el
 * temporizador y que Node nunca carga.
 */

/**
 * Los filtros de la bandeja. SON EXACTAMENTE TRES.
 *
 * La bandeja de Instagram ofrece además «perfiles verificados» y «más de 10 000
 * seguidores». No se copian: no responden a ninguna pregunta que se haga quien
 * atiende su bandeja aquí, y un filtro que nadie usa ocupa el sitio de los que
 * sí.
 *
 * SON ESTADOS DERIVADOS, no etiquetas: se calculan de los mensajes y cambian
 * solos. Por eso viajan en un parámetro distinto del de las etiquetas del CRM,
 * que son categorías que pone una persona a mano. Se pueden combinar; no se
 * mezclan. Guardar «no leído» como una etiqueta manual sería convertir el CRM en
 * un cajón de sastre: nadie vuelve a desmarcarla, así que a los dos días miente.
 */
export type FiltroDeBandeja = 'unread' | 'unanswered' | 'story_replies';

export const FILTROS_DE_BANDEJA: readonly FiltroDeBandeja[] = [
  'unread',
  'unanswered',
  'story_replies',
];

/** Lo que la pantalla le está pidiendo al servidor ahora mismo. */
export type ConsultaDeBandeja = {
  /** El término ya listo para viajar. Cadena vacía = no se está buscando. */
  texto: string;
  filtro: FiltroDeBandeja | null;
  /** Identificador de la etiqueta del CRM, o `null` para «Todos». */
  etiqueta: string | null;
};

export const CONSULTA_VACIA: ConsultaDeBandeja = {
  texto: '',
  filtro: null,
  etiqueta: null,
};

/** Si hay algo que recortar la lista, sea lo que sea. */
export function hayConsulta(consulta: ConsultaDeBandeja): boolean {
  return (
    consulta.texto.length > 0 || consulta.filtro !== null || consulta.etiqueta !== null
  );
}

/**
 * Si dos consultas piden lo MISMO.
 *
 * Sirve para no relanzar la petición cuando lo único que ha cambiado es la
 * identidad del objeto —React crea uno nuevo en cada render— y para saber si una
 * respuesta que llega tarde sigue correspondiendo a lo que hay en pantalla.
 */
export function mismaConsulta(a: ConsultaDeBandeja, b: ConsultaDeBandeja): boolean {
  return a.texto === b.texto && a.filtro === b.filtro && a.etiqueta === b.etiqueta;
}

/**
 * Los parámetros de `GET /conversations` para una consulta y una página.
 *
 * LO QUE ESTÁ VACÍO NO VIAJA. Mandar `q=` o `filtro=` en blanco no es inofensivo:
 * el servidor tendría que decidir si una cadena vacía significa «todo» o «nada»,
 * y esa clase de decisión duplicada en dos sitios acaba divergiendo. Si no se
 * busca, no hay `q`.
 */
export function parametrosDeBandeja(
  consulta: ConsultaDeBandeja,
  { limit, offset }: { limit: number; offset: number },
): string {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (consulta.texto) params.set('q', consulta.texto);
  if (consulta.filtro) params.set('filtro', consulta.filtro);
  if (consulta.etiqueta) params.set('label_id', consulta.etiqueta);
  return params.toString();
}

/**
 * Qué filtros se pueden OFRECER hoy. Nunca un botón muerto.
 *
 * «Respuestas a historias» necesita la tabla `message_story_context`, que crea la
 * migración 0044. Mientras no esté aplicada, el servidor responde siempre una
 * lista vacía —lo cual es la verdad— y ofrecer el botón sería prometer un filtro
 * que no puede encontrar nada. La pantalla lo pregunta antes por
 * `MessageRepository.funciones()`.
 */
export function filtrosOfrecidos(respuestasAHistorias: boolean): FiltroDeBandeja[] {
  return FILTROS_DE_BANDEJA.filter(
    (filtro) => filtro !== 'story_replies' || respuestasAHistorias,
  );
}

/**
 * Si una respuesta que acaba de llegar sigue siendo la que se está esperando.
 *
 * EL FALLO QUE EVITA, que es el mismo que ya resuelve `busquedaProgresiva` para
 * la pantalla de buscar: escribir «mart» y después «martinez» lanza dos
 * peticiones, y nada garantiza que vuelvan en ese orden. Si la de «mart» llega
 * la última, pinta sus resultados encima de los de «martinez» y quien busca ve
 * una lista que no corresponde con lo que tiene escrito. No da error, no aparece
 * en los registros y no se reproduce en una red buena.
 *
 * Se compara con un sello creciente: solo la última pedida puede pintar.
 */
export function esVigente(sello: number, ultimoPedido: number): boolean {
  return sello === ultimoPedido;
}

/**
 * Junta la página nueva con lo que ya había, SIN REPETIR.
 *
 * Por identificador y no concatenando a secas: entre una página y la siguiente
 * puede entrar un mensaje que reordene la lista, y entonces una conversación
 * sale en las dos páginas. Concatenar dejaría dos filas iguales y, con
 * `keyExtractor` por id, una advertencia de claves repetidas y una fila que no
 * se puede pulsar.
 *
 * GANA LA VERSIÓN NUEVA de una fila que ya estaba: trae el último mensaje y el
 * contador más recientes.
 */
export function fusionarPaginas<T extends { id: string }>(
  previas: readonly T[],
  nuevas: readonly T[],
): T[] {
  const porId = new Map(nuevas.map((fila) => [fila.id, fila]));
  const fusionadas = previas.map((fila) => porId.get(fila.id) ?? fila);
  const vistas = new Set(previas.map((fila) => fila.id));
  return [...fusionadas, ...nuevas.filter((fila) => !vistas.has(fila.id))];
}

/**
 * Cuánto vale una carga de la bandeja antes de volver a pedirla al enfocar.
 *
 * Medido (`docs/Z_MEDICION_MENSAJES_EXPLORE.md`, §2.4b): hoy `useFocusEffect`
 * recarga en CADA vuelta a la pantalla, sin condición. Salir a un chat y volver
 * son otra petición y ~0,42 s. Treinta segundos es más de lo que dura ese viaje
 * de ida y vuelta —que es cuando la recarga no aporta nada— y bastante menos que
 * el tiempo tras el que uno espera ver mensajes nuevos.
 *
 * No es una caché: lo cargado se sigue viendo. Lo único que se decide aquí es si
 * hace falta ir a preguntar otra vez.
 */
export const VALIDEZ_DE_LA_BANDEJA_MS = 30_000;

/**
 * Si toca volver a pedir la bandeja al enfocar la pantalla.
 *
 * `ultimaCarga` a `null` significa «todavía no se ha cargado nada»: entonces
 * siempre toca, o la pantalla se quedaría vacía para siempre.
 */
export function hayQueRecargar(
  ultimaCarga: number | null,
  ahora: number,
  validezMs: number = VALIDEZ_DE_LA_BANDEJA_MS,
): boolean {
  if (ultimaCarga === null) return true;
  // Justo al cumplirse la validez SÍ se recarga (`>=`): el caso de borde que
  // importa es el contrario —dos focos en el mismo instante— y ahí la resta da
  // cero, así que no se pide dos veces lo mismo.
  return ahora - ultimaCarga >= validezMs;
}

/** Minúsculas y sin tildes: «Pérez» y «perez» son lo mismo para quien busca. */
function plegar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * De las filas que YA hay, las que casan con lo tecleado.
 *
 * NO ES LA RESPUESTA: es lo que se enseña mientras llega. El servidor busca en
 * toda la bandeja —y dentro de los mensajes—; esto solo mira el nombre y el
 * último mensaje de lo que está cargado. Por eso nunca se usa como resultado
 * final (ver `filasVisibles`).
 *
 * Todas las palabras tienen que estar, en cualquier orden: «perez luis»
 * encuentra a «Luis Pérez».
 */
export function estrecharBandeja<T extends { name: string; subtitle?: string }>(
  filas: readonly T[],
  texto: string,
): T[] {
  const palabras = plegar(texto).split(/\s+/).filter(Boolean);
  if (palabras.length === 0) return filas as T[];
  return filas.filter((fila) => {
    const pajar = plegar(`${fila.name} ${fila.subtitle ?? ''}`);
    return palabras.every((palabra) => pajar.includes(palabra));
  });
}

/**
 * Si lo tecleado todavía no tiene respuesta del servidor.
 *
 * `servido` es el texto de la última respuesta que se pintó. Mientras difiere
 * de lo tecleado hay una pregunta por salir o en vuelo.
 */
export function esperandoAlServidor(tecleado: string, servido: string): boolean {
  return tecleado !== servido;
}

/**
 * Las filas que se enseñan AHORA.
 *
 * LO QUE ARREGLA (reportado el 04/10/2026: «se demora demasiado en buscar»).
 * Buscar esperaba al antirrebote, vaciaba la lista, pintaba un indicador y
 * esperaba la respuesta: con cuatro conversaciones delante, encontrar una de
 * ellas tardaba lo que tardara la red. Ahora cada tecla estrecha al instante
 * lo que ya está en pantalla, y la respuesta del servidor —que es la que
 * manda— lo sustituye cuando llega.
 *
 * LO QUE NO VUELVE: filtrar en el teléfono como respuesta. Eso era el fallo de
 * la versión anterior —buscaba entre las veinte cargadas y callaba el resto—.
 * Aquí, en cuanto el servidor contesta a lo tecleado, se pinta SU lista tal
 * cual, sin tocar: trae lo que no estaba cargado y lo que casa por el texto de
 * un mensaje.
 *
 * Devuelve el MISMO array cuando no estrecha, para que la lista no crea que
 * sus datos han cambiado.
 */
export function filasVisibles<T extends { name: string; subtitle?: string }>(
  filas: T[],
  { tecleado, servido }: { tecleado: string; servido: string },
): T[] {
  if (!esperandoAlServidor(tecleado, servido)) return filas;
  // Borrar la búsqueda no estrecha nada: se ve lo que hay hasta que llegue la
  // bandeja entera.
  if (tecleado === '') return filas;
  return estrecharBandeja(filas, tecleado);
}

/*
  LO LEÍDO SE VE LEÍDO AL VOLVER (05/10/2026).

  Reportado: «alguien me envió mensaje y entré directamente a su chat; cuando
  salí seguía apareciendo como si no lo hubiese visto». El servidor lo tenía
  leído y el globo de la barra lo decía bien; lo que seguía viejo era la fila de
  la bandeja, que con la validez de arriba no se vuelve a pedir en treinta
  segundos. Entrando desde la propia bandeja no se notaba tanto; entrando desde
  una notificación, siempre.

  No se arregla recargando en cada foco —eso es lo que la validez quitó, con
  razón—: se arregla diciéndole a la bandeja lo que ya se sabe, sin pedir nada.
*/

/**
 * La bandeja con una conversación recién leída: su fila, sin nada pendiente.
 *
 * Devuelve LA MISMA lista si no hay nada que cambiar, para no repintar.
 */
export function sinLeerEn<T extends { id: string; unread?: number }>(
  lista: readonly T[],
  conversacionId: string,
): readonly T[] {
  if (!lista.some((c) => c.id === conversacionId && (c.unread ?? 0) > 0)) return lista;
  return lista.map((c) => (c.id === conversacionId ? { ...c, unread: 0 } : c));
}

/**
 * La bandeja puesta al día con una lectura fresca que hizo otro (el contador
 * común la pide al salir de un chat y al llegar un mensaje).
 *
 * - En la PORTADA (sin búsqueda ni filtro) lo fresco ES la primera página: se
 *   adopta entera, con su orden, y detrás se conserva lo que ya se había bajado
 *   de páginas siguientes.
 * - Con una búsqueda o un filtro puestos lo fresco es otra lista: solo se
 *   actualizan las filas que coinciden, sin tocar el orden ni añadir ninguna.
 */
export function bandejaAlDia<T extends { id: string }>(
  actuales: readonly T[],
  frescas: readonly T[],
  esLaPortada: boolean,
): readonly T[] {
  if (frescas.length === 0) return actuales;
  const porId = new Map(frescas.map((c) => [c.id, c] as const));
  if (!esLaPortada) return actuales.map((c) => porId.get(c.id) ?? c);
  return [...frescas, ...actuales.filter((c) => !porId.has(c.id))];
}
