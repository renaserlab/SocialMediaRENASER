/**
 * La primera pagina de Inicio, pedida ANTES de que Inicio exista.
 *
 * POR QUE. La telemetria de los telefonos (`metricas_de_video`, iPhone, del 20
 * y 21/11/2026) separa bien los dos tramos que suman los 4,4 s de
 * `feed_respuesta`:
 *
 *   - de que arranca el JS a que Inicio pide el feed (`feed_pedido`): 60 ms en
 *     unos arranques y 3,7–4,4 s en otros;
 *   - de que lo pide a que responde: 0,44–0,86 s, mediana ~0,6 s (en la web,
 *     ~0,45 s). La API en si contesta en ~0,15 s; el resto es abrir la
 *     conexion desde el telefono (DNS, TCP, TLS) y el viaje.
 *
 * Es decir: la peticion no es lenta, es que sale TARDE y en fila. Hasta ahora
 * nadie la pedia hasta que Inicio se montaba, y antes de eso el arranque ya
 * habia esperado a todo lo demas. Aqui se pide en cuanto se sabe si hay sesion
 * (lectura local, milisegundos), en paralelo con el resto del arranque, y
 * Inicio se queda con la respuesta —o con la peticion a medio camino— al
 * montarse. El viaje de red deja de sumarse al arranque y pasa a solaparse con
 * el.
 *
 * Esta pieza no sabe de React Native ni de la red: guarda una promesa con una
 * firma y una fecha, y la entrega una sola vez. Asi se prueba sola.
 */
import type { LoteDeVideos } from './fuenteDeVideos';

/**
 * Cuanto vale una precarga sin recoger. Pasado esto se descarta y se pide de
 * nuevo: si el arranque se fue a otra pantalla (elegir idioma, el
 * cuestionario) y se vuelve a Inicio mucho despues, los videos recientes y las
 * firmas frescas valen mas que lo que ya estaba pedido.
 */
export const VIGENCIA_DE_LA_PRECARGA_MS = 60_000;

type Precarga = {
  /** Que feed se pidio: con o sin recomendador. Debe coincidir con el de Inicio. */
  firma: string;
  /** Para quien se pidio. Si cambia la cuenta, lo pedido ya no vale. */
  usuarioId: string | null;
  promesa: Promise<LoteDeVideos>;
  creadaEn: number;
};

export type PrecargaDeInicio = {
  /** Lanza la carga, si no hay ya una en marcha. Devuelve si la lanzo. */
  lanzar: (
    firma: string,
    usuarioId: string | null,
    cargar: () => Promise<LoteDeVideos>,
  ) => boolean;
  /**
   * La precarga, si existe, coincide con la firma y no ha caducado. Se entrega
   * UNA sola vez: un reintento o una segunda pantalla piden de verdad.
   */
  tomar: (firma: string) => Promise<LoteDeVideos> | null;
  /** Se descarta si se pidio para otra cuenta (cerrar sesion, cambiar de cuenta). */
  descartarSiNoEsDe: (usuarioId: string | null) => void;
  /** Se descarta sin mas: lo pedido ya no refleja lo que la persona eligio. */
  descartar: () => void;
};

export function crearPrecargaDeInicio({
  ahora = () => Date.now(),
  vigenciaMs = VIGENCIA_DE_LA_PRECARGA_MS,
}: { ahora?: () => number; vigenciaMs?: number } = {}): PrecargaDeInicio {
  let actual: Precarga | null = null;

  return {
    lanzar(firma, usuarioId, cargar) {
      if (actual && ahora() - actual.creadaEn <= vigenciaMs) return false;
      let promesa: Promise<LoteDeVideos>;
      try {
        promesa = cargar();
      } catch (error) {
        promesa = Promise.reject(error);
      }
      // Que nadie la recoja no puede acabar en un rechazo sin atender: quien la
      // tome despues recibe la misma promesa y decide que hacer con el fallo.
      promesa.catch(() => {});
      actual = { firma, usuarioId, promesa, creadaEn: ahora() };
      return true;
    },

    tomar(firma) {
      const precarga = actual;
      if (!precarga) return null;
      // Se entrega una vez, y si no sirve tampoco se guarda: una firma distinta
      // quiere decir que el arranque ya decidio otro feed.
      actual = null;
      if (precarga.firma !== firma) return null;
      if (ahora() - precarga.creadaEn > vigenciaMs) return null;
      return precarga.promesa;
    },

    descartarSiNoEsDe(usuarioId) {
      if (actual && actual.usuarioId !== usuarioId) actual = null;
    },

    descartar() {
      actual = null;
    },
  };
}
