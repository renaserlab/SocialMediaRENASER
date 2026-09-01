import { useCallback, useEffect, useRef, useState } from 'react';

import {
  guardarInstantaneaDeVideos,
  leerInstantaneaDeVideos,
} from '@/feed/cacheDeVideos';
import { perfMark } from '@/lib/perf';
import { useRefrescoAlEnfocar } from '@/hooks/useRefrescoAlEnfocar';
import { VIDEOS_POR_PAGINA, type CursorDeVideos, type FuenteDeVideos } from '@/feed/fuenteDeVideos';
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
  /**
   * Con qué versión del algoritmo se ordenó lo que se está viendo, si es que lo
   * ordenó alguna. La pantalla la manda en cada impresión para poder saber
   * después si aquella ordenación producía algo.
   *
   * Vacía cuando el lote no viene de ningún algoritmo: orden cronológico,
   * respaldo o instantánea guardada. No se hereda la versión del lote anterior
   * —le apuntaría al recomendador un orden que ya no es suyo—; ante la duda se
   * mide de menos, nunca de más.
   */
  versionDelAlgoritmo?: string;
  cargarMas: () => void;
  reintentar: () => void;
  /** Vuelve a pedir la primera pagina conservando lo que ya se ve. */
  refrescar: () => Promise<void>;
  /**
   * Quita un vídeo de la lista que se está viendo, sin recargar nada.
   *
   * Lo usa «No me interesa»: la promesa que se le hace a quien pulsa es que ESE
   * vídeo desaparece, y desaparecer dentro de tres segundos no es desaparecer.
   * Quitarlo aquí, en el estado, es lo único que lo hace inmediato.
   *
   * Es sobre el VÍDEO, nunca sobre quien lo publicó: el resto de su contenido
   * sigue en la lista y en el feed.
   */
  descartar: (postId: string) => void;
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
  const [versionDelAlgoritmo, setVersionDelAlgoritmo] = useState<string | undefined>(undefined);

  /*
    La peticion en curso. Es una referencia y no estado porque se consulta y se
    escribe dentro del mismo manejador: con estado, dos llamadas seguidas
    leerian el valor viejo y saldrian las dos.
  */
  const enVuelo = useRef(false);
  /*
    Por donde seguir pidiendo. Lo dice la fuente, no la lista que se ve: una
    publicacion con video puede no ser reproducible y quedarse fuera, y
    entonces la lista no sabe por donde iba el servidor (ver `siguienteCursor`
    en `fuenteDeVideos.ts`).
  */
  const cursor = useRef<CursorDeVideos | null>(null);
  /*
    Vídeos que esta persona ha rechazado en esta sesión.

    Va en una referencia porque no se pinta: solo sirve para filtrar. Y hace
    falta además de quitarlos de la lista porque la paginación sigue en marcha:
    la página siguiente se pidió con un desplazamiento calculado ANTES del
    rechazo, así que puede traer de vuelta el vídeo que se acaba de quitar. Sin
    esto, «no volveremos a mostrártelo» duraría hasta el siguiente deslizamiento.
  */
  const descartados = useRef(new Set<string>());
  /*
    Espejo de la lista, para poder quitar un vídeo sin que `descartar` dependa
    del estado (ver más abajo por qué su identidad no puede cambiar). Mismo
    patrón que `fuenteRef`.
  */
  const itemsRef = useRef(items);
  itemsRef.current = items;
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
        const visibles = sinDescartados(lote.items, descartados.current);
        setItems(visibles);
        setDesdeCache(false);
        cursor.current = lote.siguienteCursor;
        setHayMas(lote.hayMas);
        setVersionDelAlgoritmo(lote.versionDelAlgoritmo);
        setEstado('listo');
        if (conCache) void guardarInstantaneaDeVideos(visibles);
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
          setItems(sinDescartados(guardados, descartados.current));
          setDesdeCache(true);
          cursor.current = null;
          setHayMas(false);
          // Lo guardado se ordeno en otra sesion y quiza con otra version: no
          // se le atribuye ninguna.
          setVersionDelAlgoritmo(undefined);
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

  const cargarMas = useCallback(() => {
    // Con la instantánea no se pagina: lo guardado es lo que hay, y pedir más
    // volvería a fallar por el mismo motivo que fallo la primera carga.
    if (desdeCache) return;
    if (!activo || !hayMas || enVuelo.current || estado !== 'listo') return;
    const desde = cursor.current;
    if (!desde) return;
    enVuelo.current = true;
    setCargandoMas(true);
    fuenteRef.current
      .cargar(desde, VIDEOS_POR_PAGINA)
      .then((lote) => {
        const conocidos = new Set(items.map((i) => i.id));
        const nuevos = sinDescartados(lote.items, descartados.current).filter(
          (i) => !conocidos.has(i.id),
        );
        if (nuevos.length > 0) setItems((prev) => [...prev, ...nuevos]);
        cursor.current = lote.siguienteCursor;
        setVersionDelAlgoritmo(lote.versionDelAlgoritmo);
        /*
          Se sigue mientras el servidor tenga mas. Antes se exigia ademas que
          la pagina trajera novedades, y eso apagaba la paginacion para siempre
          en cuanto una pagina entera fuera de videos no reproducibles.
        */
        setHayMas(lote.hayMas && lote.siguienteCursor !== null);
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
  }, [activo, hayMas, estado, items, desdeCache]);

  const refrescar = useCallback(async () => {
    if (enVuelo.current) return;
    enVuelo.current = true;
    try {
      const lote = await fuenteRef.current.cargar(null, VIDEOS_POR_PAGINA);
      const visibles = sinDescartados(lote.items, descartados.current);
      setItems(visibles);
      setDesdeCache(false);
      cursor.current = lote.siguienteCursor;
      setHayMas(lote.hayMas);
      setVersionDelAlgoritmo(lote.versionDelAlgoritmo);
      setEstado('listo');
      setError(null);
      if (conCache) void guardarInstantaneaDeVideos(visibles);
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

  /*
    SI SE PUBLICA ALGO, ESTA LISTA DEJA DE ESTAR AL DIA.

    Inicio tiene su propia lista de videos: `createPost` insertaba en
    `useAppStore.posts` —lo que pinta Explorar— y aqui no llegaba nada. Como la
    seccion no se desmonta al cambiar de pestaña, el video recien publicado no
    aparecia hasta cerrar y abrir la aplicacion.

    No se refresca en el acto: se refresca cuando Inicio se esta viendo. Pedir
    esta lista mientras la persona esta en Mensajes gasta datos para pintar algo
    que nadie mira. Y si no ha cambiado nada, no pide NADA: cambiar de pestaña
    veinte veces son cero peticiones.
  */
  useRefrescoAlEnfocar('publicaciones', refrescar);

  const reintentar = useCallback(() => setIntento((n) => n + 1), []);

  /*
    Sin dependencias A PROPOSITO: esta función viaja como prop hasta cada vídeo
    de la lista, que está memoizado. Si su identidad cambiara con el estado,
    cambiaría en cada deslizamiento y volvería a dibujar todos los vídeos
    montados —con sus reproductores— justo mientras el dedo arrastra.
  */
  const descartar = useCallback(
    (postId: string) => {
      descartados.current.add(postId);
      const quedan = itemsRef.current.filter((item) => item.id !== postId);
      if (quedan.length === itemsRef.current.length) return;
      setItems(quedan);
      /*
        La instantánea se reescribe sin él. Si no, abrir la aplicación sin
        cobertura devolvería el vídeo rechazado, que es justo lo que se acaba de
        prometer que no pasaría.
      */
      if (conCache) void guardarInstantaneaDeVideos(quedan);
    },
    [conCache],
  );

  return {
    items,
    estado,
    error,
    cargandoMas,
    hayMas,
    desdeCache,
    versionDelAlgoritmo,
    cargarMas,
    reintentar,
    refrescar,
    descartar,
  };
}

/**
 * Quita de un lote lo que esta persona ya rechazó.
 *
 * Vive fuera del hook para no tener identidad: se llama desde dentro de las
 * cargas, nunca se pasa como prop.
 */
function sinDescartados(items: ReelItem[], descartados: Set<string>): ReelItem[] {
  if (descartados.size === 0) return items;
  return items.filter((item) => !descartados.has(item.id));
}
