/**
 * Subir el video de una publicacion a S3 (opcion B): el algoritmo.
 *
 * POR QUE SIN DEPENDENCIAS. Todo lo que toca el mundo —la API, el PUT a S3,
 * la memoria para reanudar, el reloj— entra inyectado. Asi se puede probar en
 * Node lo que de verdad importa (`subidaDeVideoS3.test.mts`): que una parte
 * que falla se reintenta SOLA sin repetir las demas, y que reanudar sigue
 * donde se quedo. El cableado con XHR, `apiRequest` y AsyncStorage esta en
 * `subidaDeVideoS3EnApp.ts`.
 *
 * EL CONTRATO, en dos modos que decide la API (`POST /medios/subidas`):
 *  - `simple` (hasta 50 MB): un PUT prefirmado a `url`, con las `cabeceras`
 *    tal cual. La firma lleva el tamano exacto: S3 rechaza cualquier otro.
 *  - `partes` (por encima): multipart de 10 MiB. Las URLs de cada parte se
 *    piden POR TANDAS y justo antes de usarlas (duran 15 min: pedirlas todas al
 *    principio las dejaria caducar en una subida larga por 4G). Cada PUT
 *    devuelve un `ETag` que hay que guardar para cerrar con `completar`.
 */

/** Respuesta de `POST /medios/subidas`. */
export type SubidaAbierta = {
  id_de_subida: string;
  clave_pendiente?: string;
  modo: 'simple' | 'partes';
  url: string | null;
  cabeceras?: Record<string, string> | null;
  upload_id: string | null;
  partes_totales: number | null;
  tamano_parte: number | null;
  expira: string;
};

/** Una parte ya subida, como la cuenta la API y como se guarda para reanudar. */
export type ParteHecha = { numero: number; etag: string; bytes: number };

/** Respuesta de `GET /medios/subidas/{id}`. */
export type EstadoDeSubida = {
  id_de_subida: string;
  estado: 'abierta' | 'subida' | 'usada' | 'cancelada' | 'vencida';
  modo: 'simple' | 'partes';
  partes_totales: number | null;
  tamano_parte: number | null;
  partes_hechas: ParteHecha[];
  expira: string;
};

export type ApiDeSubidas = {
  abrir(cuerpo: {
    tipo: 'video' | 'poster';
    content_type: string;
    bytes: number;
    grupo: string;
  }): Promise<SubidaAbierta>;
  pedirPartes(
    id: string,
    numeros: number[],
  ): Promise<{ partes: { numero: number; url: string; bytes: number }[]; expira: string }>;
  consultar(id: string): Promise<EstadoDeSubida>;
  completar(id: string, partes: { numero: number; etag: string }[]): Promise<unknown>;
};

/**
 * Un PUT de bytes a una URL prefirmada. Devuelve el `ETag` de la respuesta
 * (null si no vino). `alAvanzar` recibe los bytes enviados de ESTE cuerpo.
 */
export type HacerPut = (
  url: string,
  cuerpo: unknown,
  cabeceras: Record<string, string>,
  alAvanzar: (enviados: number) => void,
) => Promise<{ etag: string | null }>;

/** El archivo, visto como bytes que se pueden cortar (`Blob.slice`). */
export type ArchivoParaSubir = {
  bytes: number;
  trozo(inicio: number, fin: number): unknown;
};

/** Lo que se guarda para poder reanudar una subida por partes. */
export type SubidaGuardada = {
  idDeSubida: string;
  bytes: number;
  contentType: string;
  partesTotales: number;
  tamanoParte: number;
  uploadId: string | null;
  expira: string;
  hechas: ParteHecha[];
};

/** Una ranura de memoria para UNA subida (la de este archivo). */
export type MemoriaDeSubida = {
  leer(): Promise<SubidaGuardada | null>;
  guardar(subida: SubidaGuardada): Promise<void>;
  borrar(): Promise<void>;
};

export type OpcionesDeSubida = {
  api: ApiDeSubidas;
  hacerPut: HacerPut;
  archivo: ArchivoParaSubir;
  tipo: 'video' | 'poster';
  contentType: string;
  grupo: string;
  /** Solo en nativo: en web no se reanuda tras cerrar (no hay archivo al volver). */
  memoria?: MemoriaDeSubida | null;
  /** Avance de 0 a 1, sobre los bytes de ESTE archivo. */
  alAvanzar?: (ratio: number) => void;
  /** Inyectable para las pruebas; por defecto, `setTimeout`. */
  esperar?: (ms: number) => Promise<void>;
  ahora?: () => number;
  /** Partes a la vez. Tres: aprovecha la red sin ahogar un 4G. */
  concurrencia?: number;
  /** Intentos por parte (el primero incluido). */
  intentosPorParte?: number;
};

/** Esperas entre reintentos de UNA parte: de un microcorte a un cambio de red. */
const ESPERAS_MS = [0, 1000, 3000, 8000, 15000];

/** Cuantas URLs de parte se piden de una vez. Pocas: caducan a los 15 min. */
const URLS_POR_TANDA = 6;

/** Una URL a la que le queda menos de esto se pide de nuevo antes de usarla. */
const MARGEN_DE_URL_MS = 60_000;

/** Lo que se supone que vale una URL de parte si `expira` no es creible. */
const VIGENCIA_SUPUESTA_MS = 14 * 60_000;

const esperarDeVerdad = (ms: number) =>
  new Promise<void>((resolver) => setTimeout(resolver, ms));

/**
 * Sube UN archivo (video o poster) y devuelve su `id_de_subida`.
 *
 * Con `memoria`, una subida por partes a medias se reanuda: se pregunta a la
 * API que partes tiene ya (`GET /medios/subidas/{id}`, que es la verdad) y
 * solo se suben las que faltan. Si la API dice que ya no sirve (vencida,
 * cancelada, usada) o no contesta, se empieza de cero.
 */
export async function subirArchivoAS3(op: OpcionesDeSubida): Promise<string> {
  const reanudable = await intentarReanudar(op);
  if (reanudable?.lista) return reanudable.subida.idDeSubida;

  if (reanudable) {
    return subirPorPartes(op, reanudable.subida);
  }

  const abierta = await op.api.abrir({
    tipo: op.tipo,
    content_type: op.contentType,
    bytes: op.archivo.bytes,
    grupo: op.grupo,
  });

  if (abierta.modo === 'simple') {
    await subirSimple(op, abierta);
    return abierta.id_de_subida;
  }

  if (!abierta.partes_totales || !abierta.tamano_parte) {
    throw new Error('La subida por partes llegó sin partes.');
  }
  const subida: SubidaGuardada = {
    idDeSubida: abierta.id_de_subida,
    bytes: op.archivo.bytes,
    contentType: op.contentType,
    partesTotales: abierta.partes_totales,
    tamanoParte: abierta.tamano_parte,
    uploadId: abierta.upload_id,
    expira: abierta.expira,
    hechas: [],
  };
  await op.memoria?.guardar(subida).catch(() => {});
  return subirPorPartes(op, subida);
}

async function intentarReanudar(
  op: OpcionesDeSubida,
): Promise<{ subida: SubidaGuardada; lista: boolean } | null> {
  if (!op.memoria) return null;
  const guardada = await op.memoria.leer().catch(() => null);
  if (!guardada) return null;
  const ahora = (op.ahora ?? Date.now)();
  const vence = Date.parse(guardada.expira);
  const sirve =
    guardada.bytes === op.archivo.bytes &&
    guardada.contentType === op.contentType &&
    (Number.isNaN(vence) || vence > ahora);
  if (!sirve) {
    await op.memoria.borrar().catch(() => {});
    return null;
  }
  try {
    const estado = await op.api.consultar(guardada.idDeSubida);
    if (estado.estado === 'subida') return { subida: guardada, lista: true };
    if (estado.estado !== 'abierta' || estado.modo !== 'partes') {
      await op.memoria.borrar().catch(() => {});
      return null;
    }
    // Las partes que cuenta S3 mandan sobre las apuntadas en el telefono: una
    // parte pudo llegar justo cuando la app se cerraba, sin llegar a guardarse.
    return {
      subida: {
        ...guardada,
        partesTotales: estado.partes_totales ?? guardada.partesTotales,
        tamanoParte: estado.tamano_parte ?? guardada.tamanoParte,
        expira: estado.expira ?? guardada.expira,
        hechas: estado.partes_hechas ?? [],
      },
      lista: false,
    };
  } catch {
    // Sin respuesta no se sabe si sirve: empezar de cero es lo seguro.
    await op.memoria.borrar().catch(() => {});
    return null;
  }
}

async function subirSimple(op: OpcionesDeSubida, abierta: SubidaAbierta): Promise<void> {
  if (!abierta.url) throw new Error('La subida llegó sin dirección.');
  const esperar = op.esperar ?? esperarDeVerdad;
  const intentos = op.intentosPorParte ?? 4;
  const total = op.archivo.bytes;
  for (let intento = 1; ; intento++) {
    try {
      await op.hacerPut(
        abierta.url,
        op.archivo.trozo(0, total),
        abierta.cabeceras ?? {},
        (enviados) => op.alAvanzar?.(total > 0 ? Math.min(1, enviados / total) : 0),
      );
      break;
    } catch (error) {
      if (intento >= intentos) throw error;
      await esperar(ESPERAS_MS[Math.min(intento, ESPERAS_MS.length - 1)] ?? 0);
    }
  }
  op.alAvanzar?.(1);
  /*
    Cerrar tambien el modo simple, sin lista de partes. Si la API no lo
    necesita y contesta 4xx, no pasa nada: lo que cuenta es que el objeto ya
    esta en S3, y al publicar la API lo comprueba con HeadObject. Un fallo de
    red o del servidor si se propaga.
  */
  try {
    await op.api.completar(abierta.id_de_subida, []);
  } catch (error) {
    const estado = (error as { status?: number })?.status ?? 0;
    if (estado < 400 || estado >= 500) throw error;
  }
}

async function subirPorPartes(op: OpcionesDeSubida, subida: SubidaGuardada): Promise<string> {
  const { archivo } = op;
  const esperar = op.esperar ?? esperarDeVerdad;
  const ahora = op.ahora ?? Date.now;
  const intentos = op.intentosPorParte ?? 4;
  const { partesTotales: total, tamanoParte: tamano } = subida;

  const bytesDeParte = (n: number) => Math.max(0, Math.min(tamano, archivo.bytes - (n - 1) * tamano));
  const hechas = new Map<number, ParteHecha>();
  for (const parte of subida.hechas) {
    if (parte.numero >= 1 && parte.numero <= total && parte.etag) hechas.set(parte.numero, parte);
  }

  // Progreso: lo ya hecho mas lo que va en vuelo de cada parte.
  const enVuelo = new Map<number, number>();
  const avisar = () => {
    if (!op.alAvanzar || archivo.bytes <= 0) return;
    let enviados = 0;
    for (const parte of hechas.values()) enviados += parte.bytes;
    for (const bytes of enVuelo.values()) enviados += bytes;
    op.alAvanzar(Math.min(1, enviados / archivo.bytes));
  };
  avisar();

  const cola: number[] = [];
  for (let n = 1; n <= total; n++) if (!hechas.has(n)) cola.push(n);

  /*
    URLs de parte, pedidas por tandas y compartidas entre los tres
    trabajadores. Si uno ya esta pidiendo una tanda, los demas esperan a esa en
    vez de pedir otra que se solaparia.
  */
  const urls = new Map<number, { url: string; vence: number }>();
  let tandaEnCurso: Promise<void> | null = null;
  const pedirTanda = async (desde: number) => {
    const numeros = [desde];
    for (const n of cola) {
      if (numeros.length >= URLS_POR_TANDA) break;
      if (n !== desde && !hechas.has(n) && !urls.has(n)) numeros.push(n);
    }
    const respuesta = await op.api.pedirPartes(subida.idDeSubida, numeros);
    /*
      El vencimiento se cuenta con el reloj del telefono. Si el del servidor y
      el del telefono no coinciden (pasa: hora puesta a mano, zona mal), fiarse
      de `expira` tal cual daria URLs «caducadas» recien recibidas y se
      pedirian otra vez por cada parte. Solo se cree si es razonable; si no, se
      asumen los 15 min del contrato con un minuto de margen.
    */
    const restante = Date.parse(respuesta.expira) - ahora();
    const vigencia =
      Number.isFinite(restante) && restante > 2 * MARGEN_DE_URL_MS && restante <= 60 * 60_000
        ? restante
        : VIGENCIA_SUPUESTA_MS;
    for (const parte of respuesta.partes) {
      urls.set(parte.numero, { url: parte.url, vence: ahora() + vigencia });
    }
  };
  const vigente = (n: number) => {
    const guardada = urls.get(n);
    return guardada && guardada.vence - ahora() > MARGEN_DE_URL_MS ? guardada.url : null;
  };
  const urlDe = async (n: number, renovar: boolean): Promise<string> => {
    if (renovar) urls.delete(n);
    const yaEsta = vigente(n);
    if (yaEsta) return yaEsta;
    if (tandaEnCurso) {
      await tandaEnCurso.catch(() => {});
      const traida = vigente(n);
      if (traida) return traida;
    }
    // La tanda de otro no la traia (o fallo): se pide la propia.
    const tanda = pedirTanda(n);
    tandaEnCurso = tanda;
    try {
      await tanda;
    } finally {
      if (tandaEnCurso === tanda) tandaEnCurso = null;
    }
    const nueva = urls.get(n);
    if (!nueva) throw new Error(`La API no dio la dirección de la parte ${n}.`);
    return nueva.url;
  };

  let fallo: unknown = null;

  const subirParte = async (n: number) => {
    const inicio = (n - 1) * tamano;
    const bytes = bytesDeParte(n);
    for (let intento = 1; ; intento++) {
      try {
        // A partir del segundo intento, URL nueva: la vieja pudo caducar.
        const url = await urlDe(n, intento > 1);
        const { etag } = await op.hacerPut(url, archivo.trozo(inicio, inicio + bytes), {}, (enviados) => {
          enVuelo.set(n, Math.min(enviados, bytes));
          avisar();
        });
        if (!etag) throw new Error(`S3 no devolvió el ETag de la parte ${n}.`);
        enVuelo.delete(n);
        hechas.set(n, { numero: n, etag, bytes });
        avisar();
        await op.memoria
          ?.guardar({ ...subida, hechas: [...hechas.values()] })
          .catch(() => {});
        return;
      } catch (error) {
        enVuelo.delete(n);
        avisar();
        if (intento >= intentos || fallo) throw error;
        await esperar(ESPERAS_MS[Math.min(intento, ESPERAS_MS.length - 1)] ?? 0);
      }
    }
  };

  const trabajador = async () => {
    while (!fallo) {
      const n = cola.shift();
      if (n === undefined) return;
      try {
        await subirParte(n);
      } catch (error) {
        // Una parte agoto sus intentos: nadie coge partes nuevas. Lo hecho
        // queda apuntado para reanudar.
        fallo = fallo ?? error;
        return;
      }
    }
  };

  const cuantos = Math.max(1, Math.min(op.concurrencia ?? 3, cola.length || 1));
  await Promise.all(Array.from({ length: cuantos }, trabajador));
  if (fallo) throw fallo;

  const partes = [...hechas.values()]
    .sort((a, b) => a.numero - b.numero)
    .map(({ numero, etag }) => ({ numero, etag }));
  await op.api.completar(subida.idDeSubida, partes);
  await op.memoria?.borrar().catch(() => {});
  op.alAvanzar?.(1);
  return subida.idDeSubida;
}

/**
 * Sube el video de una publicacion y, si lo hay, su poster local.
 *
 * Video y poster comparten `grupo` (un UUID por publicacion): la API cuenta
 * una sola publicacion con video para el limite por hora. El poster va primero
 * porque pesa poco; si falla, la publicacion sale igual sin el (como hoy con
 * Supabase) y el procesado del servidor puede generarlo despues.
 */
export async function subirVideoDePublicacion(op: {
  api: ApiDeSubidas;
  hacerPut: HacerPut;
  grupo: string;
  video: ArchivoParaSubir & { contentType: string };
  poster?: ArchivoParaSubir | null;
  memoria?: MemoriaDeSubida | null;
  alAvanzar?: (ratio: number) => void;
  esperar?: (ms: number) => Promise<void>;
  ahora?: () => number;
}): Promise<{ idDeSubida: string; idDeSubidaPoster?: string }> {
  let idDeSubidaPoster: string | undefined;
  if (op.poster && op.poster.bytes > 0) {
    try {
      idDeSubidaPoster = await subirArchivoAS3({
        api: op.api,
        hacerPut: op.hacerPut,
        archivo: op.poster,
        tipo: 'poster',
        contentType: 'image/jpeg',
        grupo: op.grupo,
        esperar: op.esperar,
        ahora: op.ahora,
      });
    } catch (error) {
      // Un 403/429 del poster tambien lo dara el video, con su mensaje.
      console.warn('[subida s3] el poster no se pudo subir; sigue sin el', error);
    }
  }
  const idDeSubida = await subirArchivoAS3({
    api: op.api,
    hacerPut: op.hacerPut,
    archivo: op.video,
    tipo: 'video',
    contentType: op.video.contentType,
    grupo: op.grupo,
    memoria: op.memoria,
    alAvanzar: op.alAvanzar,
    esperar: op.esperar,
    ahora: op.ahora,
  });
  return idDeSubidaPoster ? { idDeSubida, idDeSubidaPoster } : { idDeSubida };
}

/**
 * UUID v4 para el `grupo` de una publicacion.
 *
 * No es secreto ni de seguridad: solo agrupa video y poster para el limite por
 * hora. `crypto.randomUUID` no existe en todos los motores de React Native,
 * asi que hay respaldo.
 */
export function nuevoGrupo(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
