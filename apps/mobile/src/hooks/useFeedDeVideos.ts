import { useCallback, useEffect, useRef, useState } from 'react';

import {
  guardarInstantaneaDeVideos,
  leerInstantaneaDeVideos,
} from '@/feed/cacheDeVideos';
import { perfMark } from '@/lib/perf';
import {
  VIDEOS_POR_PAGINA,
  type CursorDeVideos,
  type FuenteDeVideos,
} from '@/feed/fuenteDeVideos';
import type { ReelItem } from '@/components/ShortVideoItem';

export type EstadoDelFeed = 'cargando' | 'listo' | 'error';

export type FeedDeVideos = {
  items: ReelItem[];
  estado: EstadoDelFeed;
  /** Motivo del fallo, para poder decirlo en vez de dejar la pantalla negra. */
  error: string | null;
  /** Se esta trayendo la siguiente pagina (no el primer lote). */
  cargandoMas: boolean;
  /**
   * Lo que se ve viene de la instantánea guardada, no de la red.
   *
   * La pantalla lo DICE en vez de disimularlo: los vídeos no se reproducen sin
   * conexión —sus direcciones caducan y los bytes no están descargados— y
   * dejar que alguien toque y no pase nada es peor que avisar.
   */
  desdeCache: boolean;
  hayMas: boolean;
  cargarMas: () => void;
  reintentar: () => void;
  /** Vuelve a pedir la primera pagina conservando lo que ya se ve. */
  refrescar: () => Promise<void>;
};

/**
 * Estado de un feed vertical de videos.
 *
 * Vive aparte de la pantalla porque el Inicio tiene DOS a la vez ("Para ti" y
 * "Siguiendo") y cada uno lleva su propia lista, su propio cursor y su propio
 * fallo. Con el estado dentro de la pantalla, cambiar de pestana perdia lo
 * cargado y volvia a pedirlo todo: el mismo contenido, otra vez, cada vez.
 *
 * Reglas que se respetan aqui y que no son negociables:
 *  - Nunca se pide dos veces a la vez (`enVuelo`): al llegar al final el
 *    disparo se repite varias veces mientras el dedo baja.
 *  - Los ids repetidos se descartan. Un backend sin cursor devolveria la
 *    primera pagina una y otra vez, y la lista crecería con duplicados.
 *  - Una pagina sin novedades apaga `hayMas`, aunque venga llena.
 */
export function useFeedDeVideos(
  fuente: FuenteDeVideos,
  { activo = true }: { activo?: boolean } = {},
): FeedDeVideos {
  /*
    Solo «Para ti» guarda instantánea: es lo que se abre por defecto.
    «Siguiendo» depende de a quién sigue cada quien y guardarlo también
    duplicaría el espacio para algo que se visita mucho menos.
  */
  const conCache = fuente.clave === 'paraTi';
  const [items, setItems] = useState<ReelItem[]>([]);
  const [desdeCache, setDesdeCache] = useState(false);
  const [estado, setEstado] = useState<EstadoDelFeed>('cargando');
  const [error, setError] = useState<string | null>(null);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [hayMas, setHayMas] = useState(true);
  const [intento, setIntento] = useState(0);

  /*
    La peticion en curso. Es una referencia y no estado porque se consulta y se
    escribe dentro del mismo manejador: con estado, dos llamadas seguidas
    leerian el valor viejo y saldrian las dos.
  */
  const enVuelo = useRef(false);
  const clave = fuente.clave;

  /*
    La fuente se recrea en cada render (es un objeto literal), asi que no puede
    entrar como dependencia: dispararia una carga por render. La identidad que
    importa es la CLAVE.
  */
  const fuenteRef = useRef(fuente);
  fuenteRef.current = fuente;

  useEffect(() => {
    if (!activo) return;
    let vigente = true;
    enVuelo.current = true;
    setEstado('cargando');
    setError(null);
    fuenteRef.current
      .cargar(null, VIDEOS_POR_PAGINA)
      .then((lote) => {
        if (!vigente) return;
        // Lo que de verdad se mide del Inicio: cuanto tarda en haber algo que
        // reproducir. Se marca una sola vez por sesion.
        perfMark('INICIO_PRIMERA_PAGINA', { once: true });
        setItems(lote.items);
        setDesdeCache(false);
        setHayMas(lote.hayMas);
        setEstado('listo');
        if (conCache) void guardarInstantaneaDeVideos(lote.items);
      })
      .catch(async (e: unknown) => {
        console.warn('[inicio] no se pudieron cargar los videos', e);
        if (!vigente) return;
        /*
          Sin red, lo guardado es mejor que una pantalla negra con un error.
          Se marca `desdeCache` para poder DECIRLO: los vídeos no se
          reproducirán, y dejar que alguien toque sin que pase nada sería peor
          que avisar. La opción de reintentar sigue estando.
        */
        const guardados = conCache ? await leerInstantaneaDeVideos() : [];
        if (!vigente) return;
        if (guardados.length > 0) {
          setItems(guardados);
          setDesdeCache(true);
          setHayMas(false);
          setEstado('listo');
          return;
        }
        setItems([]);
        setDesdeCache(false);
        setError(e instanceof Error ? e.message : null);
        setEstado('error');
      })
      .finally(() => {
        if (vigente) enVuelo.current = false;
      });
    return () => {
      vigente = false;
      enVuelo.current = false;
    };
    // `clave` identifica la fuente; `intento` es el boton de reintentar.
  }, [clave, intento, activo, conCache]);

  const cursorDelFinal = useCallback((lista: ReelItem[]): CursorDeVideos | null => {
    const ultimo = lista[lista.length - 1];
    if (!ultimo) return null;
    return { creadoEn: ultimo.createdAtIso, id: ultimo.id, desplazamiento: lista.length };
  }, []);

  const cargarMas = useCallback(() => {
    // Con la instantánea no se pagina: lo guardado es lo que hay, y pedir más
    // volvería a fallar por el mismo motivo que fallo la primera carga.
    if (desdeCache) return;
    if (!activo || !hayMas || enVuelo.current || estado !== 'listo') return;
    const cursor = cursorDelFinal(items);
    if (!cursor) return;
    enVuelo.current = true;
    setCargandoMas(true);
    fuenteRef.current
      .cargar(cursor, VIDEOS_POR_PAGINA)
      .then((lote) => {
        const conocidos = new Set(items.map((i) => i.id));
        const nuevos = lote.items.filter((i) => !conocidos.has(i.id));
        if (nuevos.length > 0) setItems((prev) => [...prev, ...nuevos]);
        // Pagina corta o sin novedades: no queda nada por traer.
        setHayMas(lote.hayMas && nuevos.length > 0);
      })
      .catch((e: unknown) => {
        // No se rompe nada: lo que ya se ve sigue ahi y se reintentara la
        // proxima vez que el dedo se acerque al final.
        console.warn('[inicio] no se pudo traer mas contenido', e);
      })
      .finally(() => {
        enVuelo.current = false;
        setCargandoMas(false);
      });
  }, [activo, hayMas, estado, items, cursorDelFinal, desdeCache]);

  const refrescar = useCallback(async () => {
    if (enVuelo.current) return;
    enVuelo.current = true;
    try {
      const lote = await fuenteRef.current.cargar(null, VIDEOS_POR_PAGINA);
      setItems(lote.items);
      setDesdeCache(false);
      setHayMas(lote.hayMas);
      setEstado('listo');
      setError(null);
      if (conCache) void guardarInstantaneaDeVideos(lote.items);
    } catch (e) {
      console.warn('[inicio] no se pudo refrescar', e);
      // Refrescar no vacia la pantalla: si falla, se conserva lo que hubiera.
      if (items.length === 0) {
        setError(e instanceof Error ? e.message : null);
        setEstado('error');
      }
    } finally {
      enVuelo.current = false;
    }
  }, [items.length, conCache]);

  const reintentar = useCallback(() => setIntento((n) => n + 1), []);

  return {
    items,
    estado,
    error,
    cargandoMas,
    hayMas,
    desdeCache,
    cargarMas,
    reintentar,
    refrescar,
  };
}
