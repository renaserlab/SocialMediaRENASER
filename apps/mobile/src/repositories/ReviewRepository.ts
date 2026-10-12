import { ApiError, apiRequest, API_V1 } from '@/services/api';
import { profileImageUrl, signMediaUrls } from '@/services/storage';

/**
 * Resenas entre personas, contra el backend FastAPI (`/api/v1/reviews`).
 *
 * POR QUE NO VA CONTRA POSTGREST, como si hace `TestimonialRepository`. Las
 * reglas de una resena no son «quien escribio esta fila»: son «A opina de B»,
 * «nadie se opina a si mismo», «el opinado NO puede borrar lo que se dice de
 * el» y, sobre todo, el sello de interaccion verificada, que sale de mirar las
 * reservas y las compras de las dos personas. Nada de eso lo puede calcular el
 * telefono: no ve las reservas de nadie mas. La RLS de la 0030 impone las
 * mismas reglas por debajo, asi que saltarse esta capa no da mas permisos.
 *
 * QUE NO ES ESTO. NO sustituye a `TestimonialRepository`. Aquella es la galeria
 * de fotos y videos de un perfil —contenido real, publicado por gente real— y
 * sigue siendo eso. Lo que faltaba, y es lo que hay aqui, es poder opinar SOBRE
 * otra persona.
 *
 * SIN LA MIGRACION 0030 APLICADA esto no falla: los listados vienen vacios y
 * `disponibles()` responde false, que es lo que permite no ensenar el boton de
 * escribir en vez de ofrecerlo y dejar la pantalla cargando.
 */

/** Un archivo que acompana a una resena. Siempre opcional. */
export type MedioDeResena = {
  id: string;
  /** Ruta en el bucket privado; hay que firmarla para poder pintarla. */
  storagePath: string;
  tipo: 'image' | 'video';
  /** URL firmada, ya resuelta por `listarRecibidas`. Caduca. */
  url?: string;
};

/** Una resena, ya en el idioma de la aplicacion. */
export type Resena = {
  id: string;
  /** Quien opina. */
  autorId: string;
  /** Sobre quien. En cuyo perfil sale. */
  sobreId: string;
  autorNombre: string;
  autorUsuario: string | null;
  autorAvatarUrl?: string;
  texto: string;
  medios: MedioDeResena[];
  /**
   * De donde sale el sello de interaccion verificada, o null si no hay
   * constancia. Lo decide el SERVIDOR mirando reservas y compras: el telefono
   * no puede saberlo y no debe intentar deducirlo.
   */
  verificadaPor: 'booking' | 'course' | null;
  /**
   * De qué curso habla, si habla de alguno (migración 0041). `null` es lo
   * normal: la mayoría de las reseñas no van de un curso concreto.
   */
  cursoId: string | null;
  /**
   * Su título, ya resuelto por el servidor. Sin esto, pintar el rótulo de cada
   * tarjeta costaría una petición por reseña.
   */
  cursoTitulo: string | null;
  creadaEnIso: string;
  /**
   * Si quien mira puede editarla o borrarla. Lo dice el servidor y lo vuelve a
   * comprobar en cada escritura; aqui solo sirve para no ensenar botones que
   * van a dar 403.
   *
   * OJO: es `true` para quien la ESCRIBIO, nunca para la persona resenada.
   */
  puedeGestionar: boolean;
};

type MedioDto = {
  id: string;
  storage_path: string;
  media_type: 'image' | 'video';
  sort_order: number;
};

type ResenaDto = {
  id: string;
  reviewer_id: string;
  reviewed_user_id: string;
  reviewer_name: string;
  reviewer_username: string | null;
  reviewer_avatar_path: string | null;
  body: string;
  status: string;
  media: MedioDto[] | null;
  verified_source: 'booking' | 'course' | null;
  /**
   * Opcionales a proposito: mientras la migracion 0041 espere aprobacion el
   * backend responde `null` en los dos, y una version anterior de la API ni
   * siquiera manda los campos. Un mapeador que los diera por seguros dejaria
   * la seccion entera en blanco por una funcion que todavia no esta.
   */
  course_id?: string | null;
  course_title?: string | null;
  created_at: string;
  updated_at: string;
  can_manage: boolean;
};

/** Lo que se manda al publicar o editar. La foto y el video son opcionales. */
export type DatosDeResena = {
  texto: string;
  medios?: { storagePath: string; tipo: 'image' | 'video' }[];
  /**
   * De QUE CURSO habla, si habla de alguno (migración 0041).
   *
   * Tres valores con tres significados distintos, y la diferencia importa:
   *   - un id  -> se enlaza a ese curso,
   *   - `null` -> se QUITA el enlace que hubiera,
   *   - ausente (`undefined`) -> no se toca lo que ya había.
   *
   * Sin distinguir los dos últimos no habría forma de deshacer un curso
   * elegido por error: «no lo toques» y «quítalo» llegarían igual al servidor.
   */
  cursoId?: string | null;
};

/** Que partes del dominio de resenas estan montadas en ESTA instalacion. */
export type DisponibilidadDeResenas = {
  /** Si se puede escribir una resena (migracion 0030). */
  hay: boolean;
  /** Si ademas se puede decir de que curso habla (migracion 0041). */
  conCurso: boolean;
};

function aResena(dto: ResenaDto): Resena {
  return {
    id: dto.id,
    autorId: dto.reviewer_id,
    sobreId: dto.reviewed_user_id,
    autorNombre: dto.reviewer_name,
    autorUsuario: dto.reviewer_username,
    autorAvatarUrl: profileImageUrl(dto.reviewer_avatar_path),
    texto: dto.body,
    medios: (dto.media ?? []).map((m) => ({
      id: m.id,
      storagePath: m.storage_path,
      tipo: m.media_type,
    })),
    verificadaPor: dto.verified_source,
    cursoId: dto.course_id ?? null,
    cursoTitulo: dto.course_title ?? null,
    creadaEnIso: dto.created_at,
    puedeGestionar: dto.can_manage,
  };
}

/**
 * Firma en LOTE los archivos de una tanda de resenas.
 *
 * El bucket es privado, asi que sin firma no se pinta nada. Se hace de una vez
 * para toda la lista y no una por archivo: veinte resenas con foto serian
 * veinte peticiones de firma solo para dibujar una pantalla.
 */
async function firmarMedios(resenas: Resena[]): Promise<Resena[]> {
  const rutas = resenas.flatMap((r) => r.medios.map((m) => m.storagePath));
  if (rutas.length === 0) return resenas;
  try {
    const urls = await signMediaUrls(rutas);
    resenas.forEach((r) =>
      r.medios.forEach((m) => {
        m.url = urls[m.storagePath];
      }),
    );
  } catch {
    // Sin firma la resena se lee IGUAL: lo que aporta es el texto. Dejar caer
    // la lista entera por una imagen que no se pudo firmar seria cambiar un
    // hueco vacio por una pantalla vacia.
  }
  return resenas;
}

function cuerpo(datos: DatosDeResena): Record<string, unknown> {
  return {
    body: datos.texto,
    ...(datos.medios
      ? {
          media: datos.medios.map((m) => ({
            storage_path: m.storagePath,
            media_type: m.tipo,
          })),
        }
      : {}),
    // `'cursoId' in datos` y NO `datos.cursoId !== undefined`: mandar `null`
    // explicito es como se QUITA el curso, y con la segunda forma ese `null`
    // no llegaria nunca a viajar. El servidor mira lo mismo del otro lado
    // (`model_fields_set`).
    ...('cursoId' in datos ? { course_id: datos.cursoId ?? null } : {}),
  };
}

export const ReviewRepository = {
  /**
   * Si en esta instalacion se pueden escribir resenas.
   *
   * Responde false mientras la migracion 0030 espere aprobacion. Con eso la
   * pantalla puede no ensenar el boton, en vez de ensenarlo y fallar al
   * pulsarlo, que es exactamente el problema que tenia la version anterior.
   *
   * Un fallo de red tambien responde false: es preferible no ofrecer algo que
   * quiza no funcione a ofrecerlo y dejar a alguien escribiendo un texto que se
   * va a perder.
   */
  async disponibles(): Promise<DisponibilidadDeResenas> {
    try {
      const dto = await apiRequest<{
        available: boolean;
        courses_available?: boolean;
      }>(`${API_V1}/reviews/availability`);
      return {
        hay: dto.available === true,
        // `?? false` y no `=== true` a secas por la misma razon por la que el
        // campo es opcional arriba: una API anterior a la 0041 no manda este
        // campo, y darlo por hecho ensenaria un selector que no existe.
        conCurso: dto.courses_available ?? false,
      };
    } catch {
      return { hay: false, conCurso: false };
    }
  },

  /** Lo que han escrito SOBRE esta persona. Es la seccion de su perfil. */
  async listarRecibidas(perfilId: string, limite = 20): Promise<Resena[]> {
    const dtos = await apiRequest<ResenaDto[]>(
      `${API_V1}/reviews/received/${perfilId}?limit=${limite}`,
    );
    return firmarMedios((dtos ?? []).map(aResena));
  },

  /**
   * Las que YO he escrito.
   *
   * Hace falta para poder editarlas o borrarlas sin recordar en que perfil
   * quedaron.
   */
  async listarMias(limite = 20): Promise<Resena[]> {
    const dtos = await apiRequest<ResenaDto[]>(`${API_V1}/reviews/mine?limit=${limite}`);
    return firmarMedios((dtos ?? []).map(aResena));
  },

  /**
   * Publica una resena sobre otra persona.
   *
   * Quien firma NO viaja en el cuerpo: sale del token que pone `apiRequest`. Si
   * lo mandara el cliente, cualquiera podria opinar con el nombre de otro.
   */
  async publicar(sobreId: string, datos: DatosDeResena): Promise<Resena> {
    const dto = await apiRequest<ResenaDto>(`${API_V1}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ reviewed_user_id: sobreId, ...cuerpo(datos) }),
    });
    return aResena(dto);
  },

  /** Cambia el texto o los archivos de una resena PROPIA. */
  async editar(resenaId: string, datos: DatosDeResena): Promise<Resena> {
    const dto = await apiRequest<ResenaDto>(`${API_V1}/reviews/${resenaId}`, {
      method: 'PATCH',
      body: JSON.stringify(cuerpo(datos)),
    });
    return aResena(dto);
  },

  /**
   * Borra una resena PROPIA.
   *
   * La persona resenada NO puede: el servidor responde 403 con
   * `review_not_yours_to_delete`. Su via es reportarla. Si el opinado pudiera
   * quitar lo que no le gusta, en cada perfil quedaria solo lo favorable.
   */
  async borrar(resenaId: string): Promise<void> {
    await apiRequest<void>(`${API_V1}/reviews/${resenaId}`, { method: 'DELETE' });
  },
};

/**
 * Traduce el fallo del servidor a algo que se pueda leer en pantalla.
 *
 * Los codigos vienen del backend (`app/modules/reviews/router.py`). Sin esta
 * traduccion, publicar una segunda resena sobre la misma persona mostraba «No
 * pudimos completar la operacion», que no dice ni que ya hay una ni que se
 * puede editar.
 */
export function mensajeDeErrorDeResena(fallo: unknown): string {
  if (fallo instanceof ApiError) {
    switch (fallo.code) {
      case 'reviews_not_available':
        return 'Las reseñas todavía no están disponibles.';
      case 'review_self_not_allowed':
        return 'No puedes escribir una reseña sobre ti mismo.';
      case 'review_already_exists':
        return 'Ya escribiste una reseña sobre esta persona. Puedes editarla.';
      case 'review_blocked':
        return 'No puedes escribir una reseña sobre esta persona.';
      case 'review_not_yours_to_delete':
        return 'No puedes modificar ni borrar una reseña que escribieron sobre ti. Si incumple las normas, repórtala.';
      case 'review_media_path_invalid':
        return 'No se pudo adjuntar el archivo. Inténtalo de nuevo.';
      default:
        return fallo.message;
    }
  }
  return fallo instanceof Error ? fallo.message : 'No se pudo completar. Inténtalo de nuevo.';
}
