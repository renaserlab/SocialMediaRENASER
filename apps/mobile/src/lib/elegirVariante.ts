/**
 * Qué calidad de un video se reproduce, elegida UNA vez por video.
 *
 * DE DÓNDE SALE. Medido en TikTok (Dashlet, NSDI 2023, §2.2): cada video
 * existe en unas pocas calidades de MP4 progresivo (480p, 560p, 720p) y el
 * reproductor escoge UNA al empezar según la red; nunca cambia a mitad del
 * video. Con MP4 progresivo, además, la caché de disco de expo-video
 * (`useCaching`) funciona en Android y en iOS, cosa que con HLS en iOS no.
 *
 * SIN REACT NATIVE a propósito: se prueba en Node (`elegirVariante.test.mts`).
 *
 * REGLA DE ORO: sin variantes —servidor viejo, bandera apagada, video de
 * Supabase— nada de esto interviene y se reproduce lo de siempre. Y con
 * variantes pero SIN medición de red, se elige la de arriba, que es
 * exactamente el `media_url` de hoy: solo se baja de calidad cuando hay
 * evidencia de que la red no da para más.
 */

/** Una calidad tal como llega de la API (`media[].variantes[]`). */
export type VarianteDeVideo = {
  /** Lado menor en píxeles, como en «480p». */
  alto: number;
  /** URL ya firmada por la API. */
  url: string;
  /** Bits por segundo (video + audio). Puede faltar. */
  bitrate?: number | null;
};

/**
 * Lo que se sabe de la red en el momento de elegir. Todo opcional: lo que no
 * se sabe no se inventa.
 */
export type MedicionDeRed = {
  /** Throughput medido en kilobits por segundo. */
  kbps?: number | null;
  /**
   * Tipo de red, si se conoce: `slow-2g`, `2g`, `3g`, `4g` (los de
   * `navigator.connection.effectiveType`), `wifi`, `celular`.
   */
  tipo?: string | null;
  /** La persona pidió ahorrar datos (`navigator.connection.saveData`). */
  ahorroDeDatos?: boolean | null;
};

/**
 * Qué fracción del throughput medido se le permite a un video.
 *
 * 0.7 y no 1: el throughput medido es una media y la red oscila; además, el
 * feed precarga el siguiente video mientras suena este. Elegir justo al
 * límite es elegir un video que se va a quedar cargando.
 */
export const MARGEN_DEL_THROUGHPUT = 0.7;

/**
 * Throughput supuesto por tipo de red cuando no hay medición en kbps
 * (aproximado a la baja). `null` = no limita: se queda la de arriba.
 */
const KBPS_POR_TIPO: Record<string, number | null> = {
  'slow-2g': 50,
  '2g': 150,
  '3g': 700,
  '4g': null,
  wifi: null,
  celular: null,
};

/** Bitrate supuesto de una variante que no lo trae (kbps por lado menor). */
function bitrateSupuesto(alto: number): number {
  if (alto <= 480) return 1_000_000;
  if (alto <= 560) return 1_400_000;
  if (alto <= 720) return 2_500_000;
  return 4_000_000;
}

function numeroPositivo(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isFinite(valor) && valor > 0 ? valor : null;
}

/**
 * Normaliza lo que llega del servidor: descarta lo inválido, quita alturas
 * repetidas y ordena de menor a mayor. Devuelve `undefined` si no quedan al
 * menos DOS (con una sola no hay nada que elegir).
 */
export function normalizarVariantes(crudas: unknown): VarianteDeVideo[] | undefined {
  if (!Array.isArray(crudas)) return undefined;
  const porAlto = new Map<number, VarianteDeVideo>();
  for (const item of crudas) {
    if (!item || typeof item !== 'object') continue;
    const { alto, url, bitrate } = item as Record<string, unknown>;
    const lado = numeroPositivo(alto);
    if (lado === null || typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
    if (porAlto.has(lado)) continue;
    porAlto.set(lado, { alto: lado, url, bitrate: numeroPositivo(bitrate) });
  }
  const lista = [...porAlto.values()].sort((a, b) => a.alto - b.alto);
  return lista.length >= 2 ? lista : undefined;
}

/** El throughput utilizable en bps, o `null` si no hay con qué limitar. */
function presupuestoEnBps(medicion: MedicionDeRed | null | undefined): number | null {
  if (!medicion) return null;
  const kbps = numeroPositivo(medicion.kbps);
  if (kbps !== null) return kbps * 1000 * MARGEN_DEL_THROUGHPUT;
  const tipo = typeof medicion.tipo === 'string' ? medicion.tipo.toLowerCase() : '';
  const supuesto = KBPS_POR_TIPO[tipo];
  return typeof supuesto === 'number' ? supuesto * 1000 * MARGEN_DEL_THROUGHPUT : null;
}

/**
 * La calidad a reproducir, o `null` si no hay variantes usables (y entonces
 * se hace exactamente lo de hoy).
 *
 *  - Ahorro de datos → la más baja.
 *  - Sin medición → la más alta (el `media_url` de siempre).
 *  - Con medición → la más alta cuyo bitrate entra en el presupuesto; si
 *    ninguna entra, la más baja.
 */
export function elegirVariante(
  variantes: readonly VarianteDeVideo[] | null | undefined,
  medicion?: MedicionDeRed | null,
): VarianteDeVideo | null {
  const lista = normalizarVariantes(variantes);
  if (!lista) return null;
  // `normalizarVariantes` garantiza al menos dos: las dos existen.
  const masBaja = lista[0]!;
  const masAlta = lista[lista.length - 1]!;
  if (medicion?.ahorroDeDatos) return masBaja;
  const presupuesto = presupuestoEnBps(medicion);
  if (presupuesto === null) return masAlta;
  let elegida = masBaja;
  for (const variante of lista) {
    if ((variante.bitrate ?? bitrateSupuesto(variante.alto)) <= presupuesto) elegida = variante;
  }
  return elegida;
}

/**
 * Recuerda la calidad elegida para cada video durante la sesión.
 *
 * POR QUÉ. «Una vez por video» tiene que sobrevivir a que la lista se vuelva
 * a armar: cuando las URLs firmadas se renuevan, el elemento del feed se
 * recalcula, y sin memoria podría saltar a otra calidad (otra URL, otra
 * entrada en la caché de disco, otra descarga). Con memoria, la renovación
 * trae la MISMA calidad con firma nueva.
 */
export function crearMemoriaDeCalidad(maximo = 500) {
  const elegidas = new Map<string, number>();
  return {
    elegir(
      id: string | null | undefined,
      variantes: readonly VarianteDeVideo[] | null | undefined,
      medicion?: MedicionDeRed | null,
    ): VarianteDeVideo | null {
      const lista = normalizarVariantes(variantes);
      if (!lista) return null;
      if (id) {
        const recordada = elegidas.get(id);
        const misma = lista.find((v) => v.alto === recordada);
        if (misma) return misma;
      }
      const elegida = elegirVariante(lista, medicion);
      if (id && elegida) {
        if (elegidas.size >= maximo) {
          // La más antigua fuera: un Map conserva el orden de inserción.
          const primera = elegidas.keys().next().value;
          if (primera !== undefined) elegidas.delete(primera);
        }
        elegidas.set(id, elegida.alto);
      }
      return elegida;
    },
    olvidar(): void {
      elegidas.clear();
    },
  };
}
