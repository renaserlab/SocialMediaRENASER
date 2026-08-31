/**
 * La maquina de estados de la pantalla de buscar: que peticion se manda, cual
 * de las respuestas que llegan se pinta y cual se tira.
 *
 * POR QUE ESTO NO VIVE DENTRO DE LA PANTALLA. Quien escribe «carpinteria»
 * dispara varias busquedas, una por cada pausa al teclear, y las respuestas NO
 * vuelven en el orden en que salieron: la de «carp» puede tardar dos segundos y
 * la de «carpinteria» trescientos milisegundos. Pintar «lo ultimo que llego»
 * deja entonces en pantalla los resultados de un termino que ya nadie esta
 * buscando. Ese fallo es ademas invisible probando a mano: en una red rapida
 * las respuestas casi siempre vuelven en orden, asi que aparece en el movil de
 * otra persona, con peor cobertura, y ahi se lee como «la busqueda no
 * funciona».
 *
 * LA REGLA, ENTERA: cada peticion sale con un numero de orden creciente
 * (`Sello.id`) y solo se acepta la respuesta cuyo sello sigue siendo el ultimo
 * lanzado; todo lo demas se descarta sin tocar el estado. Vaciar el buscador
 * TAMBIEN gasta un numero, para que una respuesta en vuelo no vuelva a llenar
 * una lista que la persona acaba de dejar vacia.
 *
 * SE PINTA POR GRUPOS. La respuesta viene separada en personas, publicaciones,
 * etiquetas, cursos y eventos, y el backend degrada grupo a grupo: si los
 * cursos revientan, esa lista viene vacia y las demas llegan igual. `aplicar`
 * respeta eso —pinta lo que haya— y `ampliar` pide la pagina siguiente de UN
 * grupo sin tocar los otros.
 *
 * DOS TERMINOS Y NO UNO. `tecleado` es lo que hay escrito; `termino` es el de
 * la ultima peticion lanzada. Mientras difieren hay una busqueda por salir, y
 * eso es lo unico que distingue «no hay resultados» de «todavia no se ha
 * preguntado». Con un solo termino, quien teclea rapido ve un «Sin resultados»
 * parpadeando entre letra y letra.
 *
 * Vive en `lib/` y no en la pantalla porque asi se prueba sin montar React ni
 * red: el runner de Node no resuelve el alias `@/`, de modo que este fichero no
 * importa nada.
 */

/** Los grupos que devuelve `GET /api/v1/search`. Mismo vocabulario que `TIPOS`. */
export type Grupo = 'people' | 'posts' | 'hashtags' | 'courses' | 'events';

/**
 * El orden en que se pintan. Personas primero porque casi siempre se busca a
 * alguien; las etiquetas antes que las publicaciones sueltas porque una
 * etiqueta es un atajo a muchas publicaciones.
 */
export const GRUPOS: readonly Grupo[] = ['people', 'hashtags', 'posts', 'courses', 'events'];

/** Un tema de la taxonomia que la consulta activo. */
export type TemaDto = { id: string; slug: string; name: string };

/** Una persona, con lo que declara PODER APORTAR. Nunca lo que quiere aprender. */
export type PersonaDto = {
  id: string;
  full_name: string;
  username: string | null;
  avatar_path: string | null;
  bio: string;
  offer_topics: string[];
};

/** Una publicacion, recortada: lo justo para decidir si abrirla. */
export type PublicacionDto = {
  id: string;
  body: string;
  author_id: string;
  author_name: string;
  author_username: string | null;
  author_avatar_path: string | null;
  created_at: string | null;
  topics: string[];
};

/** Una etiqueta y cuantas publicaciones PUBLICADAS tiene de verdad. */
export type EtiquetaDto = { tag: string; display_tag: string; posts_count: number };

/** Un curso del catalogo visible para quien pregunta. */
export type CursoDto = {
  id: string;
  title: string;
  subtitle: string | null;
  level: string | null;
  cover_path: string | null;
  price_minor: number;
  currency: string;
  coming_soon: boolean;
  author_id: string;
  author_name: string;
  topics: string[];
};

/** Un evento publicado. */
export type EventoDto = {
  id: string;
  title: string;
  starts_at: string | null;
  location: string | null;
  cover_path: string | null;
};

/**
 * La respuesta del endpoint.
 *
 * Los grupos son opcionales a proposito: `next_offset` solo trae los que se
 * pidieron, y un backend mas viejo que el movil puede no mandar un grupo que
 * aqui ya existe. Leerlos con `?? []` no cuesta nada y evita que una busqueda
 * entera reviente por una clave que falta.
 */
export type RespuestaDeBusqueda = {
  query?: string;
  topics?: TemaDto[];
  people?: PersonaDto[];
  posts?: PublicacionDto[];
  hashtags?: EtiquetaDto[];
  courses?: CursoDto[];
  events?: EventoDto[];
  next_offset?: Partial<Record<Grupo, number | null>>;
};

/** Lo encontrado, ya por grupos, mas por donde sigue cada uno. */
export type ResultadosDeBusqueda = {
  temas: TemaDto[];
  people: PersonaDto[];
  posts: PublicacionDto[];
  hashtags: EtiquetaDto[];
  courses: CursoDto[];
  events: EventoDto[];
  /** Por grupo, el `offset` de la pagina siguiente. `null` = no queda nada. */
  siguiente: Partial<Record<Grupo, number | null>>;
};

export type EstadoDeBusqueda = {
  /** Lo que hay escrito en el buscador, sin espacios sobrantes. */
  tecleado: string;
  /** El termino de la ultima peticion lanzada. */
  termino: string;
  /** Numero de la ultima peticion lanzada. Es lo que decide que respuesta vale. */
  secuencia: number;
  /** Hay una peticion en vuelo. */
  cargando: boolean;
  /** El grupo que esta pidiendo su pagina siguiente, si alguno. */
  ampliando: Grupo | null;
  /** La ultima busqueda vigente fallo entera. */
  fallo: boolean;
  resultados: ResultadosDeBusqueda;
};

/**
 * El resguardo de una peticion. Viaja con ella y vuelve con su respuesta: es lo
 * unico que permite saber si lo que acaba de llegar sigue interesando.
 *
 * `grupo` es `null` en una busqueda nueva —se piden los cinco de una vez— y
 * lleva el grupo cuando es un «ver mas».
 */
export type Sello = { id: number; termino: string; grupo: Grupo | null; salto: number };

/**
 * Cuantas letras hacen falta para buscar.
 *
 * Con una sola letra la respuesta es «casi todo», que no ayuda a nadie y cuesta
 * cinco recorridos de tabla por tecla.
 */
export const MINIMO_DE_TERMINO = 2;

/**
 * Cuanto se espera desde la ultima tecla antes de preguntar.
 *
 * Sin espera se manda una busqueda por letra: escribir «carpinteria» son once
 * peticiones de las que solo importa la ultima. 250 ms es menos de lo que se
 * tarda en encadenar dos teclas escribiendo normal, asi que no se nota.
 */
export const ESPERA_DE_TECLEO_MS = 250;

/** Cuantos resultados trae cada grupo por pagina. Es el defecto del backend. */
export const LIMITE_POR_GRUPO = 10;

function resultadosVacios(): ResultadosDeBusqueda {
  return { temas: [], people: [], posts: [], hashtags: [], courses: [], events: [], siguiente: {} };
}

export function estadoInicial(): EstadoDeBusqueda {
  return {
    tecleado: '',
    termino: '',
    secuencia: 0,
    cargando: false,
    ampliando: null,
    fallo: false,
    resultados: resultadosVacios(),
  };
}

/** El termino tal y como viaja a la API: sin espacios sobrantes. */
export function normalizarTermino(termino: string): string {
  return termino.trim();
}

/** Si merece la pena preguntar por este termino. */
export function esBuscable(termino: string): boolean {
  return normalizarTermino(termino).length >= MINIMO_DE_TERMINO;
}

/**
 * Deja el estado como si nunca se hubiera buscado.
 *
 * GASTA UN NUMERO DE SECUENCIA, y esa es toda la gracia: si alguien escribe y
 * borra de golpe, la respuesta que ya iba en camino llega con un sello viejo y
 * se tira, en vez de repintar resultados sobre un buscador vacio.
 */
export function limpiar(estado: EstadoDeBusqueda): EstadoDeBusqueda {
  return { ...estadoInicial(), secuencia: estado.secuencia + 1 };
}

/**
 * Apunta lo que se acaba de escribir, sin mandar nada todavia.
 *
 * Es lo que hace que la pantalla sepa que hay una busqueda pendiente durante la
 * espera del tecleo. Si el texto se queda por debajo del minimo, equivale a
 * limpiar: nadie quiere ver los resultados de «carpinteria» debajo de una «c»
 * suelta.
 */
export function anotarTecleo(estado: EstadoDeBusqueda, texto: string): EstadoDeBusqueda {
  const limpio = normalizarTermino(texto);
  if (!esBuscable(limpio)) {
    return estado.tecleado === '' && estado.termino === '' ? estado : limpiar(estado);
  }
  if (limpio === estado.tecleado) return estado;
  return { ...estado, tecleado: limpio };
}

/** Si hay una busqueda escrita que todavia no se ha lanzado. */
export function hayBusquedaPendiente(estado: EstadoDeBusqueda): boolean {
  return esBuscable(estado.tecleado) && estado.tecleado !== estado.termino;
}

/** Si la pantalla debe enseñar que esta trabajando. */
export function estaOcupado(estado: EstadoDeBusqueda): boolean {
  return estado.cargando || hayBusquedaPendiente(estado);
}

/**
 * Anota una busqueda nueva y devuelve el sello con el que mandarla.
 *
 * NO BORRA lo que ya hay en pantalla: mientras llega la respuesta se siguen
 * viendo los resultados anteriores junto al indicador de carga. Vaciar la lista
 * en cada tecla convierte escribir en un parpadeo, y ademas quita de la vista
 * justo el resultado que a lo mejor se buscaba.
 */
export function lanzar(
  estado: EstadoDeBusqueda,
  termino: string,
): { estado: EstadoDeBusqueda; sello: Sello } {
  const limpio = normalizarTermino(termino);
  const id = estado.secuencia + 1;
  return {
    estado: {
      ...estado,
      tecleado: limpio,
      termino: limpio,
      secuencia: id,
      cargando: true,
      ampliando: null,
      fallo: false,
    },
    sello: { id, termino: limpio, grupo: null, salto: 0 },
  };
}

/**
 * Pide la pagina siguiente de UN grupo.
 *
 * Devuelve `null` cuando ese grupo no tiene mas paginas: el backend calcula
 * «hay mas» pidiendo un resultado de mas y mirando si llego, asi que aqui es un
 * hecho comprobado y no una suposicion del cliente.
 */
export function ampliar(
  estado: EstadoDeBusqueda,
  grupo: Grupo,
): { estado: EstadoDeBusqueda; sello: Sello } | null {
  const salto = estado.resultados.siguiente[grupo];
  if (salto == null) return null;
  if (!esBuscable(estado.termino)) return null;
  const id = estado.secuencia + 1;
  return {
    estado: { ...estado, secuencia: id, ampliando: grupo },
    sello: { id, termino: estado.termino, grupo, salto },
  };
}

/**
 * Si una respuesta que acaba de llegar sigue siendo la que se esperaba.
 *
 * Se comprueban las DOS cosas —el numero de orden y el termino— aunque con el
 * numero bastaria: el dia que alguien lance una peticion sin pasar por
 * `lanzar`, el termino la delata igual.
 */
export function esVigente(estado: EstadoDeBusqueda, sello: Sello): boolean {
  return sello.id === estado.secuencia && sello.termino === estado.termino;
}

function claveDe(grupo: Grupo, fila: { id?: string; tag?: string }): string {
  return grupo === 'hashtags' ? (fila.tag ?? '') : (fila.id ?? '');
}

/**
 * Junta una pagina nueva con la anterior sin repetir filas.
 *
 * Entre dos paginas el orden puede cambiar —alguien publica, sube un contador—
 * y entonces una fila de la primera pagina reaparece en la segunda. Repetida en
 * la lista da dos entradas con la misma clave, que es justo lo que hace que una
 * lista virtualizada pinte filas donde no toca.
 */
function concatenarSinRepetir<T extends { id?: string; tag?: string }>(
  grupo: Grupo,
  previas: readonly T[],
  nuevas: readonly T[],
): T[] {
  const vistas = new Set(previas.map((fila) => claveDe(grupo, fila)));
  return [...previas, ...nuevas.filter((fila) => !vistas.has(claveDe(grupo, fila)))];
}

/**
 * Mete en el estado una respuesta, SI todavia interesa.
 *
 * Devuelve el estado sin tocar cuando el sello ya caduco: quien llama no tiene
 * que acordarse de comprobarlo, y asi una respuesta lenta de una busqueda
 * anterior no puede pisar a la actual pase lo que pase.
 */
export function aplicar(
  estado: EstadoDeBusqueda,
  sello: Sello,
  respuesta: RespuestaDeBusqueda,
): EstadoDeBusqueda {
  if (!esVigente(estado, sello)) return estado;

  const siguiente = respuesta.next_offset ?? {};

  if (sello.grupo === null) {
    // Busqueda nueva: la respuesta sustituye a lo que hubiera.
    return {
      ...estado,
      cargando: false,
      ampliando: null,
      fallo: false,
      resultados: {
        temas: respuesta.topics ?? [],
        people: respuesta.people ?? [],
        posts: respuesta.posts ?? [],
        hashtags: respuesta.hashtags ?? [],
        courses: respuesta.courses ?? [],
        events: respuesta.events ?? [],
        siguiente,
      },
    };
  }

  // «Ver mas» de un grupo: solo crece ese grupo y solo se mueve su `siguiente`.
  const grupo = sello.grupo;
  const previos = estado.resultados;
  const resultados: ResultadosDeBusqueda = {
    ...previos,
    siguiente: { ...previos.siguiente, [grupo]: siguiente[grupo] ?? null },
  };
  if (grupo === 'people') {
    resultados.people = concatenarSinRepetir(grupo, previos.people, respuesta.people ?? []);
  } else if (grupo === 'posts') {
    resultados.posts = concatenarSinRepetir(grupo, previos.posts, respuesta.posts ?? []);
  } else if (grupo === 'hashtags') {
    resultados.hashtags = concatenarSinRepetir(grupo, previos.hashtags, respuesta.hashtags ?? []);
  } else if (grupo === 'courses') {
    resultados.courses = concatenarSinRepetir(grupo, previos.courses, respuesta.courses ?? []);
  } else {
    resultados.events = concatenarSinRepetir(grupo, previos.events, respuesta.events ?? []);
  }

  return { ...estado, cargando: false, ampliando: null, fallo: false, resultados };
}

/**
 * Apunta que la peticion de este sello fallo.
 *
 * Un fallo de una busqueda vieja tampoco pinta nada: si no, cambiar de termino
 * mientras la anterior agoniza deja un error en pantalla sobre unos resultados
 * que estan perfectamente bien.
 *
 * Un «ver mas» que falla NO marca error general: lo que ya se veia sigue siendo
 * valido, solo se ha quedado sin ampliar.
 */
export function marcarFallo(estado: EstadoDeBusqueda, sello: Sello): EstadoDeBusqueda {
  if (!esVigente(estado, sello)) return estado;
  return { ...estado, cargando: false, ampliando: null, fallo: sello.grupo === null };
}

/** Cuantas filas hay pintadas ahora mismo, sumando los cinco grupos. */
export function totalDeResultados(estado: EstadoDeBusqueda): number {
  const r = estado.resultados;
  return r.people.length + r.posts.length + r.hashtags.length + r.courses.length + r.events.length;
}

/**
 * Si toca pintar «sin resultados».
 *
 * Ni mientras se busca ni antes de la primera respuesta: decir «no hay nada»
 * cuando todavia no se ha preguntado es mentira, y es exactamente lo que ve
 * quien teclea rapido si esto se calcula solo con el total.
 */
export function debeDecirSinResultados(estado: EstadoDeBusqueda): boolean {
  return (
    esBuscable(estado.termino) &&
    !estaOcupado(estado) &&
    !estado.fallo &&
    totalDeResultados(estado) === 0
  );
}


/* ========================================================================== *
 * DE UNOS RESULTADOS A LAS FILAS QUE SE PINTAN
 *
 * POR QUE ESTO VIVE AQUI Y NO EN UN COMPONENTE. Por el mismo motivo que el
 * resto del fichero: el runner de Node no resuelve el alias `@/`, asi que todo
 * lo que importe de `@/algo` deja de poder probarse sin montar React ni red.
 * Construir las filas es una decision de producto —que grupos se ven, en que
 * orden, cuando se ofrece «Ver mas»— y esas se prueban una a una. Pintarlas
 * necesita React, y eso vive en `components/resultadosDeBusqueda.tsx`.
 *
 * Y POR QUE ESTAN COMPARTIDAS. Habia DOS buscadores en la aplicacion:
 * `SearchScreen` (`/search`), que preguntaba a `GET /api/v1/search` y encontraba
 * personas, etiquetas, publicaciones, CURSOS y eventos, y era INALCANZABLE —su
 * unico enlace estaba en `app/dev.tsx`, la galeria interna de pantallas—; y el
 * de Explorar, que es el que la gente usa y solo preguntaba por PERSONAS. Por
 * eso alguien que buscaba un curso leia «No encontramos personas con ese
 * nombre». Ahora los dos preguntan lo mismo y pintan con estas filas, para que
 * no vuelvan a separarse.
 * ========================================================================== */

/** Una fila de la lista aplanada: cabeceras y resultados en la misma lista. */
export type FilaDeBusqueda =
  | { kind: 'section'; key: string; title: string; action?: string; onAction?: () => void }
  | { kind: 'temas'; key: string; texto: string }
  | { kind: 'person'; key: string; persona: PersonaDto }
  | { kind: 'hashtag'; key: string; etiqueta: EtiquetaDto }
  | { kind: 'post'; key: string; publicacion: PublicacionDto }
  | { kind: 'course'; key: string; curso: CursoDto }
  | { kind: 'event'; key: string; evento: EventoDto };

/** El titulo de cada grupo, en el mismo sitio que el orden en que se pintan. */
export const TITULOS: Record<Grupo, string> = {
  people: 'Personas',
  hashtags: 'Etiquetas',
  posts: 'Publicaciones',
  courses: 'Cursos',
  events: 'Eventos',
};

/** El tipo de fila que le corresponde a cada grupo, y su prefijo de clave. */
const FILA_DE: Record<Grupo, { kind: FilaDeBusqueda['kind']; prefijo: string }> = {
  people: { kind: 'person', prefijo: 'p' },
  hashtags: { kind: 'hashtag', prefijo: 'h' },
  posts: { kind: 'post', prefijo: 'o' },
  courses: { kind: 'course', prefijo: 'c' },
  events: { kind: 'event', prefijo: 'e' },
};

type OpcionesDeFilas = {
  /** El grupo que esta pidiendo su pagina siguiente, si alguno. */
  ampliando?: Grupo | null;
  /** Que hacer al pulsar «Ver mas». Sin esto no se ofrece. */
  verMas?: (grupo: Grupo) => void;
};

/**
 * Las filas a pintar para unos resultados, en el orden en que se pintan.
 *
 * EL ORDEN LO MANDA `GRUPOS`, que es la misma constante que documenta por que
 * es ese: personas primero porque casi siempre se busca a alguien, y las
 * etiquetas antes que las publicaciones sueltas porque una etiqueta es un atajo
 * a muchas. Recorrerlo en vez de escribir cinco bloques iguales es lo que hace
 * que anadir un grupo sea una linea, y no cinco sitios de los que se olvida uno.
 *
 * UN GRUPO VACIO NO PINTA NI SIQUIERA SU CABECERA. Eso es lo que permite que
 * una busqueda que solo encuentra cursos se lea como «hay cursos» y no como
 * «no hay personas», que es literalmente lo que la pantalla decia antes.
 */
export function filasDeResultados(
  resultados: ResultadosDeBusqueda,
  { ampliando = null, verMas }: OpcionesDeFilas = {},
): FilaDeBusqueda[] {
  const out: FilaDeBusqueda[] = [];

  /*
    Por que se dice en que temas se esta buscando: sin esta linea, encontrar un
    curso de carpinteria escribiendo «muebles» parece un fallo. Un buscador que
    acierta sin explicar por que no se lee como listo, se lee como averiado.
  */
  if (resultados.temas.length > 0) {
    out.push({
      kind: 'temas',
      key: 'temas',
      texto: `También buscamos en ${resultados.temas.map((t) => t.name).join(', ')}`,
    });
  }

  for (const grupo of GRUPOS) {
    const filas: readonly { id?: string; tag?: string }[] = resultados[grupo];
    if (filas.length === 0) continue;

    // «Ver mas» solo si el backend dijo que hay mas: lo calcula pidiendo un
    // resultado de mas y mirando si llego, asi que es un hecho comprobado y no
    // una suposicion del cliente.
    const hayMas = resultados.siguiente[grupo] != null && verMas != null;
    out.push({
      kind: 'section',
      key: `sec-${grupo}`,
      title: TITULOS[grupo],
      action: hayMas ? (ampliando === grupo ? 'Cargando…' : 'Ver más') : undefined,
      // Mientras un grupo se amplia, ninguno acepta pulsaciones: dos paginas en
      // vuelo a la vez se aplicarian en el orden en que vuelvan.
      onAction: hayMas && ampliando === null ? () => verMas?.(grupo) : undefined,
    });

    const { kind, prefijo } = FILA_DE[grupo];
    for (const fila of filas) {
      out.push({ kind, key: `${prefijo}-${claveDe(grupo, fila)}`, ...datos(grupo, fila) } as FilaDeBusqueda);
    }
  }

  return out;
}

/** El resultado bajo el nombre que espera su fila. */
function datos(grupo: Grupo, fila: unknown): Record<string, unknown> {
  switch (grupo) {
    case 'people':
      return { persona: fila };
    case 'hashtags':
      return { etiqueta: fila };
    case 'posts':
      return { publicacion: fila };
    case 'courses':
      return { curso: fila };
    default:
      return { evento: fila };
  }
}
