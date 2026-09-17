/**
 * El catálogo de Productos Z: los moldes del contrato, el orden de la ficha y
 * —sobre todo— lo que esta pantalla NO PUEDE DECIR.
 *
 * Es el espejo en el cliente de `products/catalog.py` y `products/schemas.py`.
 * La cabecera de `catalog.py` enumera lo que el servidor deliberadamente no
 * manda, y este módulo existe para que la aplicación no lo rellene por su
 * cuenta. Seis reglas, todas copiadas de allí:
 *
 *   1. NINGUNA VALORACIÓN. No hay reseñas de productos: `rating` viaja `null`.
 *      Ni media, ni histograma, ni «4,8 estrellas». Aquí no hay una sola
 *      función que produzca una media, y el bloque de valoración SE DEJA FUERA
 *      con un estado honesto en vez de pintarse a cero —un cero se lee como
 *      «lo valoraron mal», que es peor que no decir nada—.
 *
 *   2. NINGUNA COMPRA VERIFICADA Y NINGÚN PLAZO. No hay pedidos físicos, ni
 *      transportista, ni condiciones de devolución aprobadas: `delivery` viaja
 *      `null` y el bloque de entrega también se deja fuera. Un «llega en 3-5
 *      días» escrito aquí sería una promesa que nadie puede cumplir.
 *
 *   3. NINGÚN BOTÓN DE COMPRAR. `purchasable` es hoy SIEMPRE `false` y no hay
 *      carrito ni checkout en la API —ni una ruta vacía, dice el router—. Por
 *      eso `accionesDeLaFicha` no puede devolver «comprar» en ningún caso: lo
 *      que se ofrece es guardar, leer el informe y ver quién lo hace.
 *
 *   4. UN PRECIO NULO ES «SIN PRECIO CONFIGURADO». No es gratis y no es cero.
 *      Y sin moneda no hay importe: `precioLegible` exige las dos cosas y
 *      nunca supone una moneda, porque suponerla es escribir un precio que
 *      quien vende no puso.
 *
 *   5. «PARA TI» NO ESTÁ PERSONALIZADO. El contrato manda `personalized:
 *      false` justamente para que el título lo diga: lo que hay es lo más
 *      reciente, y se llama «Nuevos en Z». Llamarlo «Elegidos para ti» sería
 *      mentir con el título, que es la forma más barata de mentir.
 *
 *   6. UN SOLO INDICADOR DE CONFIANZA, y hoy solo puede ser el ORIGEN: es el
 *      único de los cuatro del blueprint §3.1 que se puede demostrar sin
 *      reseñas ni pedidos. Un `trust` que no conozcamos NO se pinta.
 *
 * EL SELLO NO SE ESCRIBE AQUÍ. Lo manda el servidor en `seal`, porque es una
 * promesa de la empresa: si cada pantalla lo escribiera, tres pantallas dirían
 * tres cosas parecidas. Lo mismo con el manifiesto, que viaja en `manifest`.
 *
 * Sin importaciones en tiempo de ejecución: el ejecutor de pruebas de Node no
 * resuelve el alias `@/`.
 */

/** Una clave del diccionario. La pantalla la convierte al traducir. */
export type ClaveDeTraduccion = string;

/* -------------------------------------------------------------------------- */
/* Los moldes, transcritos del contrato                                        */
/* -------------------------------------------------------------------------- */

/** `TarjetaRead`: lo que se enseña de un producto en una lista (§3.1). */
export type TarjetaDeProducto = {
  product_id: string;
  name: string;
  seller_id: string;
  seller_name: string;
  /** `null` es SIN PRECIO CONFIGURADO. Nunca cero. */
  price_minor: number | null;
  currency: string | null;
  /** La RUTA en el almacenamiento, no una URL. */
  image_path: string | null;
  /**
   * La URL FIRMADA, emitida por el servidor al servir esta respuesta y con
   * vencimiento. `null` cuando no hay fotografía aprobada o el almacenamiento
   * no contestó: entonces se enseña `image_alt`, que es la verdad.
   */
  image_url: string | null;
  image_alt: string | null;
  /** UNO SOLO. Hoy solo puede ser `origin`. */
  trust: string | null;
  trust_value: string | null;
  saved: boolean;
};

/** `CreadorRead`: un responsable comercial con algo publicado. */
export type Creador = {
  seller_id: string;
  profile_id: string;
  name: string;
  /** El resumen de su producto más reciente. Puede no haberlo. */
  proposal: string | null;
  product_id: string;
};

/** `PortadaRead`: la portada de Productos Z (§3). */
export type Portada = {
  manifest: string;
  seleccion: TarjetaDeProducto[];
  para_ti: TarjetaDeProducto[];
  /** `false` SIEMPRE hoy: no hay recomendador de productos. */
  personalized: boolean;
  creadores: Creador[];
  /** `false` = las migraciones de Productos no están aplicadas en esta base. */
  disponible: boolean;
};

/** `BusquedaRead`: una página de resultados y el cursor de la siguiente. */
export type Busqueda = {
  items: TarjetaDeProducto[];
  /** El identificador del último producto de esta página. NO es un número. */
  next_cursor: string | null;
};

/** `CategoriaRead`. */
export type Categoria = {
  id: string;
  slug: string;
  name: string;
  position: number;
};

/** `CategoriasRead`. VACÍO = la empresa no las ha definido. */
export type Categorias = {
  items: Categoria[];
};

/** `MediaRead`. `storage_path` es una ruta; firmarla es de la aplicación. */
export type Media = {
  id: string;
  kind: string;
  storage_path: string;
  alt_text: string | null;
  /** Firmada ahora y con vencimiento. `null` si no se pudo firmar. */
  url: string | null;
  width: number | null;
  height: number | null;
};

/** `VarianteRead`. El delta se suma al precio de la versión. */
export type Variante = {
  id: string;
  sku: string;
  name: string;
  options: Record<string, unknown>;
  price_delta_minor: number;
};

/** `RazonRead`: una de las tres razones, CON de qué evidencia sale (§4.1). */
export type Razon = {
  position: number;
  text: string;
  evidence_kind: string;
  evidence_dimension: string;
};

/** `FichaRead`: el detalle, en el orden inalterable del blueprint §4. */
export type Ficha = {
  product_id: string;
  version_id: string;
  version: string;
  name: string;
  summary: string | null;
  description: string | null;
  materials: string | null;
  origin_country: string | null;
  manufacturer: string | null;
  price_minor: number | null;
  currency: string | null;
  /** La huella de lo publicado: es lo que hace demostrable qué se evaluó. */
  content_sha256: string;
  published_at: string | null;
  status: string;

  seller_id: string;
  seller_name: string;
  seller_profile_id: string;

  gallery: Media[];
  variants: Variante[];
  reasons: Razon[];
  /** EL TEXTO DEL SELLO, tal como lo manda el servidor. */
  seal: string;
  /** El informe que abre el sello. `null` si la admisión no está desplegada. */
  evaluation_id: string | null;
  /** `null` PORQUE NO HAY RESEÑAS DE PRODUCTOS. No es cero. */
  rating: Record<string, unknown> | null;
  /** `null` porque no hay condiciones de entrega ni devolución aprobadas. */
  delivery: Record<string, unknown> | null;
  related: TarjetaDeProducto[];
  saved: boolean;
  /** HOY SIEMPRE `false`. No existe la compra física. */
  purchasable: boolean;
};

/** Lo que el informe cuenta de una dimensión. Lo monta el servidor. */
export type DimensionDelInforme = {
  score?: number | null;
  weight?: number | null;
  evidence?: Array<{ kind: string; summary: string }>;
};

/** `InformeRead`: el informe que abre el sello. Sin notas internas. */
export type Informe = {
  evaluation_id: string;
  version_id: string;
  seal: string;
  decision: string;
  /** EN CENTÉSIMAS DE PUNTO: 9 000 son 90,00. */
  score_total: number | null;
  decided_at: string | null;
  dimensions: Record<string, DimensionDelInforme>;
};

/** `GuardadoRead`: si quedó guardado y cuántos hay ahora. */
export type Guardado = {
  saved: boolean;
  count: number;
};

/* -------------------------------------------------------------------------- */
/* Lo que el servidor es, en constantes                                        */
/* -------------------------------------------------------------------------- */

/**
 * `catalog.MANIFIESTO`, letra por letra.
 *
 * Se prefiere SIEMPRE el `manifest` que manda la portada; esto es el respaldo
 * para pintar antes de que llegue, y la prueba de que no se ha reescrito.
 */
export const MANIFIESTO = 'No está todo. Está lo que merece estar.';

/** `catalog.LARGO_MINIMO_DE_LA_BUSQUEDA`: con una letra no se busca. */
export const LARGO_MINIMO_DE_LA_BUSQUEDA = 2;

/** `catalog.POR_PAGINA`: el tope que admite `GET /products/search`. */
export const POR_PAGINA = 20;

/** `catalog.POR_BLOQUE`: cuántas tarjetas trae cada bloque de la portada. */
export const POR_BLOQUE = 8;

/** Dos columnas como máximo (§3). Más tarjetas por fila no se pintan. */
export const COLUMNAS_MAXIMAS = 2;

/** `models.DIMENSIONES`: las seis del blueprint §5.2 con su peso. */
export const DIMENSIONES: Record<string, number> = {
  quality: 25,
  design: 20,
  usefulness: 20,
  durability: 15,
  origin: 10,
  warranty: 10,
};

/** El orden en que se leen las dimensiones del informe. El de la matriz. */
export const ORDEN_DE_DIMENSIONES = [
  'quality',
  'design',
  'usefulness',
  'durability',
  'origin',
  'warranty',
] as const;

/** `models.DECISIONES`. */
export const DECISIONES = ['approved', 'conditionally_approved', 'rejected'] as const;

/** `models.TIPOS_DE_EVIDENCIA`: qué cuenta como evidencia. */
export const TIPOS_DE_EVIDENCIA = [
  'functional_test',
  'inspection',
  'usage_review',
  'problem_and_result',
  'materials',
  'batch',
  'warranty_policy',
  'photo',
  'document',
  'sample',
] as const;

/**
 * Los indicadores de confianza que HOY se pueden demostrar. Uno.
 *
 * `catalog._confianza` solo devuelve `origin`; recomendación y compras
 * verificadas necesitan reseñas y pedidos, y la garantía necesita condiciones
 * aprobadas. Lo que no esté en esta lista no se pinta.
 */
export const CONFIANZAS_CONOCIDAS = ['origin'] as const;

/** `models.RAZONES_EXIGIDAS`: como mucho tres razones (§4.1). */
export const RAZONES_EXIGIDAS = 3;

/**
 * EL ORDEN INALTERABLE de los bloques de la ficha (blueprint §4).
 *
 * Está aquí, y la pantalla los pinta recorriéndolo, para que reordenarlos
 * exija cambiar esta lista —y la prueba que la compara con el código de la
 * pantalla—. Suelto en el JSX, el orden se rompe en el primer arreglo de
 * maquetación y nadie se entera.
 */
export const BLOQUES_DE_LA_FICHA = [
  'galeria',
  'creador',
  'nombre',
  'precio',
  'sello',
  'razones',
  'variantes',
  'descripcion',
  'materialesYOrigen',
  'valoracion',
  'compraProtegida',
  'entregaYDevolucion',
  'perfilDelCreador',
  'relacionados',
  'barraFija',
] as const;
export type BloqueDeLaFicha = (typeof BLOQUES_DE_LA_FICHA)[number];

/**
 * Si hay una fotografía que pintar. LO DECIDE EL SERVIDOR, no una bandera.
 *
 * Antes esto era una constante apagada, porque no existía ningún depósito de
 * productos y firmar la ruta contra otro habría dado una URL rota. Desde la
 * 0073 el depósito existe, es PRIVADO y NO TIENE POLÍTICAS: la aplicación no
 * puede firmar nada por su cuenta, y por eso la URL llega ya firmada en el
 * contrato, emitida al servir la respuesta y con vencimiento.
 *
 * QUE LLEGUE NULA NO ES UN ERROR. Significa que esa versión no tiene ninguna
 * fotografía APROBADA, o que el almacenamiento no contestó. En los dos casos se
 * enseña el texto alternativo, que es lo que hay, y no un hueco.
 */
export function sePuedeMostrarLaImagen(url: string | null | undefined): boolean {
  return typeof url === 'string' && url.trim() !== '';
}

function conocido(valores: readonly string[], valor: string, prefijo: string): string {
  return valores.includes(valor) ? `${prefijo}.${valor}` : `${prefijo}.desconocido`;
}

function texto(valor: string | null | undefined): string | null {
  const limpio = (valor ?? '').trim();
  return limpio === '' ? null : limpio;
}

/* -------------------------------------------------------------------------- */
/* El precio: con su moneda o no existe                                        */
/* -------------------------------------------------------------------------- */

/**
 * Un precio que se puede escribir, o la constancia de que no hay ninguno.
 *
 * `configurado: false` NO es «gratis» y NO es cero: es que quien vende todavía
 * no le ha puesto precio, y la pantalla lo dice con esas palabras.
 */
export type Precio = { configurado: true; texto: string } | { configurado: false };

/** Lo que se enseña cuando no hay precio. Nunca un número. */
export const CLAVE_SIN_PRECIO: ClaveDeTraduccion = 'productos.sinPrecio';

/**
 * El importe en la unidad menor, escrito con su código de moneda.
 *
 * SIN MONEDA NO HAY IMPORTE, y sin importe tampoco: las dos cosas juntas o
 * nada. Y va el CÓDIGO, no un símbolo: `$` valdría para tres monedas
 * distintas, y elegir una por nuestra cuenta es inventarse el precio. La
 * unidad menor se lee con dos decimales, igual que en `dinero.ts`.
 */
export function precioLegible(
  minor: number | null | undefined,
  moneda: string | null | undefined,
): Precio {
  const codigo = (moneda ?? '').trim().toUpperCase();
  if (
    minor === null ||
    minor === undefined ||
    typeof minor !== 'number' ||
    !Number.isFinite(minor) ||
    codigo === ''
  ) {
    return { configurado: false };
  }
  return { configurado: true, texto: `${importe(minor)} ${codigo}` };
}

function importe(minor: number): string {
  const negativo = minor < 0;
  const valor = Math.abs(Math.trunc(minor));
  const enteros = Math.floor(valor / 100);
  const resto = String(valor % 100).padStart(2, '0');
  return `${negativo ? '-' : ''}${enteros}.${resto}`;
}

/** El precio de una tarjeta de lista. Mismo criterio que en la ficha. */
export function precioDeLaTarjeta(tarjeta: TarjetaDeProducto): Precio {
  return precioLegible(tarjeta.price_minor, tarjeta.currency);
}

/**
 * Lo que suma o resta una variante, si se puede decir.
 *
 * Un delta sin moneda no es un importe, y un delta de cero no se enseña: una
 * línea que dice «+0.00» hace pensar que la variante cuesta algo aparte.
 */
export function deltaDeLaVariante(ficha: Ficha, variante: Variante): Precio {
  if (variante.price_delta_minor === 0) return { configurado: false };
  const leido = precioLegible(variante.price_delta_minor, ficha.currency);
  if (!leido.configurado) return leido;
  const signo = variante.price_delta_minor > 0 ? '+' : '';
  return { configurado: true, texto: `${signo}${leido.texto}` };
}

/* -------------------------------------------------------------------------- */
/* El indicador de confianza: uno, y demostrable                               */
/* -------------------------------------------------------------------------- */

/** El indicador de una tarjeta, o `null` si no hay ninguno que enseñar. */
export function indicadorDeConfianza(
  tarjeta: TarjetaDeProducto,
): { clase: string; valor: string } | null {
  const clase = texto(tarjeta.trust);
  const valor = texto(tarjeta.trust_value);
  if (clase === null || valor === null) return null;
  // UN INDICADOR QUE NO CONOCEMOS NO SE PINTA. Si el servidor empieza a mandar
  // «compras verificadas», enseñarlo sin saber qué cuenta sería repetir una
  // promesa sin leerla.
  if (!(CONFIANZAS_CONOCIDAS as readonly string[]).includes(clase)) return null;
  return { clase, valor };
}

/** El texto del indicador. `null` cuando no hay ninguno conocido. */
export function claveDeConfianza(clase: string | null | undefined): ClaveDeTraduccion | null {
  const limpio = texto(clase);
  if (limpio === null) return null;
  if (!(CONFIANZAS_CONOCIDAS as readonly string[]).includes(limpio)) return null;
  return `productos.confianza.${limpio}`;
}

/* -------------------------------------------------------------------------- */
/* La portada                                                                  */
/* -------------------------------------------------------------------------- */

/** El manifiesto que se enseña: el del servidor, y el nuestro de respaldo. */
export function textoDelManifiesto(portada: Portada | null): string {
  return texto(portada?.manifest) ?? MANIFIESTO;
}

/**
 * El título del segundo bloque, y es una decisión, no una etiqueta.
 *
 * `personalized: false` significa que eso es lo MÁS RECIENTE, no una selección
 * hecha para nadie. Mientras el contrato diga `false`, el título es «Nuevos en
 * Z»; el día que exista un recomendador, el servidor dirá `true` y el título
 * cambiará solo.
 */
export function claveDelBloquePersonal(personalized: boolean): ClaveDeTraduccion {
  return personalized ? 'productos.paraTi' : 'productos.nuevosEnZ';
}

/** Qué es ese bloque, con el mismo criterio que el título. */
export function claveDelCuerpoDelBloquePersonal(personalized: boolean): ClaveDeTraduccion {
  return personalized ? 'productos.paraTiCuerpo' : 'productos.nuevosEnZCuerpo';
}

/** Si la portada no trae nada publicado. NO es un error. */
export function portadaVacia(portada: Portada | null): boolean {
  if (portada === null) return true;
  return (
    portada.seleccion.length === 0 &&
    portada.para_ti.length === 0 &&
    portada.creadores.length === 0
  );
}

/** Si Productos está desplegado en esta base. `false` no es «no hay nada». */
export function catalogoDisponible(portada: Portada | null): boolean {
  return portada?.disponible === true;
}

/**
 * Cuántos guardados enseña la bolsa. `null` cuando no hay ninguno.
 *
 * La bolsa se pinta siempre —lleva a los guardados— pero SIN CONTADOR mientras
 * esté vacía: un «0» colgando de un icono es ruido, y encima parece un error.
 */
export function contadorDeLaBolsa(cuantos: number | null | undefined): number | null {
  if (typeof cuantos !== 'number' || !Number.isFinite(cuantos)) return null;
  const entero = Math.trunc(cuantos);
  return entero > 0 ? entero : null;
}

/** Cuántos hay guardados en una lista de tarjetas ya leída. */
export function cuantosGuardados(tarjetas: TarjetaDeProducto[]): number {
  return tarjetas.filter((t) => t.saved).length;
}

/* -------------------------------------------------------------------------- */
/* La búsqueda                                                                 */
/* -------------------------------------------------------------------------- */

/** La consulta lista para viajar, o `null` si con eso no se busca. */
export function consultaUtil(escrito: string | null | undefined): string | null {
  const limpio = (escrito ?? '').trim();
  if (limpio.length < LARGO_MINIMO_DE_LA_BUSQUEDA) return null;
  return limpio;
}

/**
 * Si se puede pedir una búsqueda con lo que hay escrito.
 *
 * Con el campo vacío SÍ: `GET /products/search` sin `q` devuelve lo publicado,
 * que es lo que hace falta para navegar por categorías. Lo que no se manda es
 * una letra sola, que el servidor contesta con una lista vacía.
 */
export function sePuedeBuscar(escrito: string | null | undefined, categoria: string | null): boolean {
  const limpio = (escrito ?? '').trim();
  if (limpio === '') return true;
  if (consultaUtil(limpio) !== null) return true;
  return categoria !== null && categoria !== '';
}

/** Si quedan más páginas por pedir. */
export function hayMasPaginas(busqueda: Busqueda | null): boolean {
  return texto(busqueda?.next_cursor) !== null;
}

/**
 * Pega la página nueva detrás de lo que ya había, SIN REPETIR.
 *
 * El cursor es el identificador del último producto, así que si alguien publica
 * entre dos páginas la siguiente puede traer una fila que ya estaba. Repetida
 * en pantalla parecen dos productos iguales, y en una lista con llaves rompe el
 * render.
 */
export function unirPaginas(
  actuales: TarjetaDeProducto[],
  nuevas: TarjetaDeProducto[],
): TarjetaDeProducto[] {
  const vistos = new Set(actuales.map((t) => t.product_id));
  const salida = [...actuales];
  for (const tarjeta of nuevas) {
    if (vistos.has(tarjeta.product_id)) continue;
    vistos.add(tarjeta.product_id);
    salida.push(tarjeta);
  }
  return salida;
}

/** Las categorías ofrecidas, en el orden del servidor. Vacío es vacío. */
export function categoriasOfrecidas(categorias: Categorias | null): Categoria[] {
  return [...(categorias?.items ?? [])].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    return a.slug.localeCompare(b.slug);
  });
}

/** Marca una tarjeta como guardada, o deja de marcarla, sin tocar el resto. */
export function conGuardado(
  tarjetas: TarjetaDeProducto[],
  productoId: string,
  guardado: boolean,
): TarjetaDeProducto[] {
  return tarjetas.map((t) =>
    t.product_id === productoId ? { ...t, saved: guardado } : t,
  );
}

/* -------------------------------------------------------------------------- */
/* La ficha: qué bloques hay y qué bloques SE DEJAN FUERA                      */
/* -------------------------------------------------------------------------- */

/**
 * Si ese bloque tiene datos que enseñar.
 *
 * Los cuatro que hoy nunca los tienen —valoración, compra protegida, entrega y
 * devolución— no son un descuido: el servidor manda `null` y `purchasable:
 * false` porque esas cosas no existen todavía en Z.
 */
export function bloqueConDatos(ficha: Ficha, bloque: BloqueDeLaFicha): boolean {
  switch (bloque) {
    case 'galeria':
      return ficha.gallery.length > 0;
    case 'razones':
      return ficha.reasons.length > 0;
    case 'variantes':
      return ficha.variants.length > 0;
    case 'descripcion':
      return texto(ficha.description) !== null || texto(ficha.summary) !== null;
    case 'materialesYOrigen':
      return (
        texto(ficha.materials) !== null ||
        texto(ficha.origin_country) !== null ||
        texto(ficha.manufacturer) !== null
      );
    // NO HAY RESEÑAS DE PRODUCTOS. `rating` nulo se deja fuera; a cero sería
    // decir que lo valoraron y salió mal.
    case 'valoracion':
      return ficha.rating !== null;
    // NO HAY COMPRA FÍSICA. Sin compra no hay nada que proteger, y un sello de
    // «compra protegida» sobre algo que no se vende es un adorno.
    case 'compraProtegida':
      return ficha.purchasable;
    // NI TRANSPORTISTA, NI COBERTURA, NI CONDICIONES APROBADAS.
    case 'entregaYDevolucion':
      return ficha.delivery !== null;
    case 'relacionados':
      return ficha.related.length > 0;
    // El sello lo manda el servidor; sin texto no se pinta un sello vacío.
    case 'sello':
      return texto(ficha.seal) !== null;
    case 'creador':
    case 'nombre':
    case 'precio':
    case 'perfilDelCreador':
    case 'barraFija':
      return true;
    default:
      return false;
  }
}

/** Los bloques que se pintan, EN EL ORDEN INALTERABLE del blueprint §4. */
export function bloquesVisibles(ficha: Ficha): BloqueDeLaFicha[] {
  return BLOQUES_DE_LA_FICHA.filter((bloque) => bloqueConDatos(ficha, bloque));
}

/** Los bloques que se dejan fuera por no tener datos, en el mismo orden. */
export function bloquesFuera(ficha: Ficha): BloqueDeLaFicha[] {
  return BLOQUES_DE_LA_FICHA.filter((bloque) => !bloqueConDatos(ficha, bloque));
}

/** Si ese bloque se deja fuera de esta ficha. */
export function seDejaFuera(ficha: Ficha, bloque: BloqueDeLaFicha): boolean {
  return !bloqueConDatos(ficha, bloque);
}

/**
 * Los bloques que llevan un título escrito encima.
 *
 * Los demás no lo llevan porque no lo necesitan: el nombre del producto ES el
 * título, y poner «Barra fija» o «Sello» de encabezado sería nombrar la
 * maquetación en voz alta.
 */
export const BLOQUES_CON_TITULO = [
  'razones',
  'variantes',
  'descripcion',
  'materialesYOrigen',
  'relacionados',
] as const;

/** El título de un bloque, o `null` si ese bloque no lleva ninguno. */
export function claveDelBloque(bloque: string): ClaveDeTraduccion | null {
  return (BLOQUES_CON_TITULO as readonly string[]).includes(bloque)
    ? `productos.bloque.${bloque}`
    : null;
}

/**
 * Qué se dice EN LUGAR de un bloque que no tiene datos.
 *
 * Una frase corta y verdadera, no un hueco ni un valor razonable. Los bloques
 * que nunca se caen —el nombre, el precio, el creador— devuelven `null`: no
 * hay nada que explicar porque no faltan.
 */
export function claveDelBloqueFuera(bloque: string): ClaveDeTraduccion | null {
  const explicables = [
    'galeria',
    'razones',
    'variantes',
    'descripcion',
    'materialesYOrigen',
    'valoracion',
    'compraProtegida',
    'entregaYDevolucion',
    'relacionados',
  ];
  return explicables.includes(bloque) ? `productos.fuera.${bloque}` : null;
}

/**
 * Lo que la ficha OFRECE HACER. Nunca comprar.
 *
 * No hay carrito, ni checkout, ni pedido: el router lo dice y no deja ni una
 * ruta vacía que devolviera 501, porque eso ya sería una promesa. `verInforme`
 * solo cuando hay informe que abrir: un sello que no abre nada es un adorno.
 */
export const ACCIONES_DE_LA_FICHA = ['guardar', 'quitar', 'verInforme', 'verCreador'] as const;
export type AccionDeLaFicha = (typeof ACCIONES_DE_LA_FICHA)[number];

export function accionesDeLaFicha(ficha: Ficha): AccionDeLaFicha[] {
  const acciones: AccionDeLaFicha[] = [ficha.saved ? 'quitar' : 'guardar'];
  if (texto(ficha.evaluation_id) !== null) acciones.push('verInforme');
  if (texto(ficha.seller_profile_id) !== null) acciones.push('verCreador');
  return acciones;
}

/** El texto del botón de cada acción. */
export function claveDeAccion(accion: string): ClaveDeTraduccion {
  return conocido([...ACCIONES_DE_LA_FICHA], accion, 'productos.accion');
}

/**
 * Si el sello abre algo.
 *
 * `evaluation_id` nulo significa que la admisión (0071) no está desplegada, así
 * que el informe no existe: el sello se lee, pero no es un botón.
 */
export function selloAbreInforme(ficha: Ficha): boolean {
  return texto(ficha.evaluation_id) !== null;
}

/**
 * El sello, partido en sus dos mitades por el « · » que trae el servidor.
 *
 * NO SE REESCRIBE NI SE COMPLETA: se parte para poder pintar el nombre en
 * negrita y la explicación debajo, como en la referencia. Si el servidor
 * cambiara el texto o dejara de usar el punto medio, esto devuelve lo que haya
 * en `titulo` y `cuerpo: null`, y la pantalla enseña la frase entera.
 */
export function partesDelSello(seal: string | null | undefined): {
  titulo: string;
  cuerpo: string | null;
} {
  const limpio = texto(seal);
  if (limpio === null) return { titulo: '', cuerpo: null };
  const corte = limpio.indexOf('·');
  if (corte === -1) return { titulo: limpio, cuerpo: null };
  return {
    titulo: limpio.slice(0, corte).trim(),
    cuerpo: texto(limpio.slice(corte + 1)),
  };
}

/**
 * El icono de una razón, SACADO DE SU EVIDENCIA.
 *
 * `evidence_dimension` lo manda el contrato, así que el dibujo que acompaña a
 * cada razón está respaldado por lo que se miró y no elegido a dedo. Una
 * dimensión que no conozcamos devuelve `null` y la razón se enseña sin icono:
 * antes sin dibujo que con uno que insinúe otra cosa.
 */
export function iconoDeLaDimension(dimension: string | null | undefined): string | null {
  const iconos: Record<string, string> = {
    quality: 'layers',
    durability: 'layers',
    origin: 'user',
    warranty: 'shield',
    design: 'feather',
    usefulness: 'target',
  };
  const limpio = texto(dimension);
  if (limpio === null) return null;
  return iconos[limpio] ?? null;
}

/**
 * La posición que se enseña en el contador de la galería, en base 1.
 *
 * `0` cuando no hay nada que contar: un «1/0» es un contador roto. Y nunca
 * pasa del total, porque al final de un desplazamiento el cálculo puede dar un
 * índice de más.
 */
export function posicionEnLaGaleria(indice: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  if (!Number.isFinite(indice) || indice < 0) return 1;
  return Math.min(Math.trunc(indice) + 1, Math.trunc(total));
}

/** Las razones en su orden, y como mucho las tres que el blueprint admite. */
export function razonesOrdenadas(ficha: Ficha): Razon[] {
  return [...ficha.reasons]
    .sort((a, b) => a.position - b.position)
    .slice(0, RAZONES_EXIGIDAS);
}

/** De qué evidencia sale una razón: su tipo y su dimensión. */
export function clavesDeLaEvidenciaDeLaRazon(razon: Razon): {
  tipo: ClaveDeTraduccion;
  dimension: ClaveDeTraduccion;
} {
  return {
    tipo: claveDeTipoDeEvidencia(razon.evidence_kind),
    dimension: claveDeDimension(razon.evidence_dimension),
  };
}

/** Las opciones de una variante, en crudo y ordenadas. Sin interpretarlas. */
export function opcionesDeLaVariante(variante: Variante): Array<[string, string]> {
  return Object.keys(variante.options ?? {})
    .sort()
    .map((clave) => [clave, valorLiteral(variante.options?.[clave])] as [string, string]);
}

/** Un valor tal como es. Sin interpretarlo. */
export function valorLiteral(valor: unknown): string {
  if (valor === null) return '';
  if (valor === undefined) return '';
  if (typeof valor === 'string') return valor;
  if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor);
  try {
    return JSON.stringify(valor);
  } catch {
    return '';
  }
}

/** La huella de lo publicado, recortada para que se pueda leer. */
export function huellaCorta(sha: string | null | undefined): string {
  const limpio = texto(sha);
  if (limpio === null) return '';
  return limpio.slice(0, 12);
}

/* -------------------------------------------------------------------------- */
/* El informe de evaluación                                                    */
/* -------------------------------------------------------------------------- */

/** El titular de la decisión. */
export function claveDeDecision(decision: string | null | undefined): ClaveDeTraduccion {
  return conocido([...DECISIONES], texto(decision) ?? '', 'productos.decision');
}

/** El nombre de una dimensión de la matriz. */
export function claveDeDimension(dimension: string | null | undefined): ClaveDeTraduccion {
  return conocido([...ORDEN_DE_DIMENSIONES], texto(dimension) ?? '', 'productos.dimension');
}

/** Qué se miró: el tipo de evidencia. */
export function claveDeTipoDeEvidencia(tipo: string | null | undefined): ClaveDeTraduccion {
  return conocido([...TIPOS_DE_EVIDENCIA], texto(tipo) ?? '', 'productos.evidencia');
}

/**
 * La puntuación, que viaja EN CENTÉSIMAS DE PUNTO: 9 000 son 90,00.
 *
 * Vacío cuando no hay ninguna registrada; nunca un cero, que se leería como
 * «sacó cero». El separador decimal se pasa desde fuera porque el español y el
 * portugués escriben coma y el inglés escribe punto.
 */
export function puntuacionLegible(
  centesimas: number | null | undefined,
  separador = ',',
): string {
  if (typeof centesimas !== 'number' || !Number.isFinite(centesimas)) return '';
  const valor = Math.max(0, Math.trunc(centesimas));
  const enteros = Math.floor(valor / 100);
  const resto = String(valor % 100).padStart(2, '0');
  return `${enteros}${separador}${resto}`;
}

/** Si el informe trae puntuación total. `null` no es cero. */
export function hayPuntuacion(informe: Informe | null): boolean {
  return typeof informe?.score_total === 'number' && Number.isFinite(informe.score_total);
}

/** Una dimensión del informe, lista para pintar. */
export type FilaDelInforme = {
  dimension: string;
  /** De 0 a 100. `null` = sin puntuar, que no es un cero. */
  score: number | null;
  /** El peso CONGELADO al puntuar; si no vino, el de la matriz de hoy. */
  weight: number | null;
  evidencia: Array<{ kind: string; summary: string }>;
};

/**
 * Las dimensiones del informe, en el orden de la matriz.
 *
 * SOLO LAS QUE EL SERVIDOR MANDÓ. Rellenar las seis con ceros diría que se
 * miraron todas y que en unas se sacó cero, y son dos cosas distintas de la
 * verdad. Lo que llegue y no esté en la matriz se pinta al final, con su
 * nombre: es el aviso de que la matriz cambió.
 */
export function filasDelInforme(informe: Informe | null): FilaDelInforme[] {
  const dimensiones = informe?.dimensions ?? {};
  const conocidas = ORDEN_DE_DIMENSIONES.filter((d) =>
    Object.prototype.hasOwnProperty.call(dimensiones, d),
  );
  const extras = Object.keys(dimensiones)
    .filter((d) => !(ORDEN_DE_DIMENSIONES as readonly string[]).includes(d))
    .sort();
  return [...conocidas, ...extras].map((dimension) => {
    const entrada = dimensiones[dimension] ?? {};
    const score = entrada.score;
    const weight = entrada.weight;
    return {
      dimension,
      score: typeof score === 'number' && Number.isFinite(score) ? score : null,
      weight:
        typeof weight === 'number' && Number.isFinite(weight)
          ? weight
          : (DIMENSIONES[dimension] ?? null),
      evidencia: [...(entrada.evidence ?? [])],
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Formato                                                                     */
/* -------------------------------------------------------------------------- */

/** La fecha, en el idioma del sistema. Vacía si el servidor mandó algo raro. */
export function fechaLegible(iso: string | null | undefined): string {
  if (!iso) return '';
  const momento = new Date(iso);
  if (Number.isNaN(momento.getTime())) return '';
  return momento.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** La fecha con su hora. Vacía si no se puede leer. */
export function momentoLegible(iso: string | null | undefined): string {
  if (!iso) return '';
  const momento = new Date(iso);
  if (Number.isNaN(momento.getTime())) return '';
  return `${momento.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })} · ${momento.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

/** La versión tal como se escribió. Sin ponerle una «v» delante. */
export function etiquetaDeVersion(version: string | null | undefined): string {
  return (version ?? '').trim();
}

/* -------------------------------------------------------------------------- */
/* Cuando algo sale mal                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Los códigos de Productos, traducidos.
 *
 * `null` es «no lo conozco»: entonces habla el servidor, que en español dice
 * algo correcto. Un texto genérico nuestro taparía uno mejor.
 */
export function claveDeErrorDeProductos(
  codigo: string | null | undefined,
): ClaveDeTraduccion | null {
  const conocidos: Record<string, string> = {
    products_not_available: 'productos.error.noDisponible',
    product_admission_not_available: 'productos.error.admisionNoDisponible',
    product_saves_not_available: 'productos.error.guardadosNoDisponibles',
    product_evaluation_not_available: 'productos.error.informeNoDisponible',
    product_not_found: 'productos.error.noEncontrado',
    // Las tres puertas del Incremento 4. Están aquí, y no solo en sus módulos,
    // porque cualquier pantalla del catálogo puede toparse con ellas.
    product_media_not_available: 'productos.error.product_media_not_available',
    product_inventory_not_available:
      'productos.error.product_inventory_not_available',
    product_cart_not_available: 'productos.error.product_cart_not_available',
  };
  if (typeof codigo !== 'string') return null;
  return conocidos[codigo] ?? null;
}

/**
 * Si lo que falta es el despliegue, no el dato.
 *
 * Las migraciones 0070, 0071 y 0072 se entregan sin aplicar y cada puerta
 * contesta su propio 503. Para quien mira la pantalla las tres significan lo
 * mismo: esto todavía no está, y no se ha roto nada.
 */
export function esProductosApagado(codigo: string | null | undefined): boolean {
  return (
    codigo === 'products_not_available' ||
    codigo === 'product_admission_not_available' ||
    codigo === 'product_saves_not_available'
  );
}

/** Si lo apagado es solo guardar. El catálogo se sigue mirando. */
export function esGuardadosApagado(codigo: string | null | undefined): boolean {
  return codigo === 'product_saves_not_available';
}

/** Si lo que no está desplegado es el informe que abre el sello. */
export function esInformeApagado(codigo: string | null | undefined): boolean {
  return (
    codigo === 'product_evaluation_not_available' ||
    codigo === 'product_admission_not_available'
  );
}

/** Lo que hay que enseñar según el estado HTTP, cuando no hay código mejor. */
export function claveDeErrorPorEstado(estado: number | null | undefined): ClaveDeTraduccion | null {
  if (estado === 401) return 'productos.error.sinSesion';
  if (estado === 403) return 'productos.error.sinPermiso';
  if (estado === 404) return 'productos.error.noEncontrado';
  if (estado === 503) return 'productos.error.noDisponible';
  return null;
}

/** Guardar exige sesión: el servidor contesta 401 y se dice con esas palabras. */
export function esFaltaDeSesion(estado: number | null | undefined): boolean {
  return estado === 401;
}
