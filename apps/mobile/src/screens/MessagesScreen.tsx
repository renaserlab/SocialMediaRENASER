import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, RefreshControl, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { BuscadorDeConversaciones } from '@/components/BuscadorDeConversaciones';
import { ChipsDeEtiquetas, ExplicacionDeEtiquetas } from '@/components/ChipsDeEtiquetas';
import { useEspacioInferior } from '@/components/espacioInferior';
import { FilaDeConversacion } from '@/components/FilaDeConversacion';
import { FiltrosDeBandeja } from '@/components/FiltrosDeBandeja';
import { GestorDeEtiquetas } from '@/components/GestorDeEtiquetas';
import { HistoriasDeLaBandeja } from '@/components/HistoriasDeLaBandeja';
import { SignedOutNotice } from '@/components/SignedOutNotice';
import { StateView } from '@/components/StateView';
import { useTranslation } from '@/i18n/useTranslation';
import {
  CONSULTA_VACIA,
  bandejaAlDia,
  esperandoAlServidor,
  esVigente,
  filasVisibles,
  fusionarPaginas,
  hayConsulta,
  hayQueRecargar,
  sinLeerEn,
  type ConsultaDeBandeja,
  type FiltroDeBandeja,
} from '@/lib/bandeja';
import { abreLaLista } from '@/lib/temasDeGrupo';
import {
  CONVERSACIONES_POR_PAGINA,
  MessageRepository,
} from '@/repositories/MessageRepository';
import {
  cargarEtiquetas,
  type EstadoDeEtiquetas,
} from '@/repositories/EtiquetasRepository';
import { useAppStore } from '@/store/useAppStore';
import { useEscribiendoEnBandeja } from '@/hooks/useEscribiendoEnBandeja';
import { useAuthStore } from '@/store/useAuthStore';
import {
  alCambiarLaBandeja,
  alLeerUnaConversacion,
  alLlegarLaBandeja,
  anotarMensajes,
} from '@/services/contadores';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Conversation } from '@/types';

/**
 * La bandeja de mensajes.
 *
 * -----------------------------------------------------------------------------
 * LO QUE SE CONSERVA DE LA VERSIÓN ANTERIOR, Y POR QUÉ SE DICE
 * -----------------------------------------------------------------------------
 * Paginación por desplazamiento con fusión sin repetidos, refresco silencioso al
 * volver al foco, estados de carga/vacío/error, tirar para recargar y lista
 * virtualizada. Todo eso lleva funcionando en producción con gente dentro; el
 * rediseño cambia cómo se ve y añade lo nuevo, no reescribe lo que ya servía.
 *
 * -----------------------------------------------------------------------------
 * LAS CUATRO PETICIONES SALEN A LA VEZ. NINGUNA ESPERA A OTRA
 * -----------------------------------------------------------------------------
 * Conversaciones, historias, etiquetas y qué funciones hay disponibles se piden
 * en el mismo instante, desde efectos que se disparan al montar. Está medido que
 * cada salto de red encadenado cuesta ~0,42 s: cuatro peticiones en paralelo son
 * un salto; encadenadas serían cuatro, o sea 1,7 s en los que no se puede pintar
 * nada. Por eso `HistoriasDeLaBandeja` pide lo suyo por su cuenta en vez de
 * recibirlo de aquí: así no hay forma de que acabe esperando a la bandeja.
 *
 * Y si alguna de las tres secundarias falla, la bandeja se abre igual: unas
 * etiquetas que no cargan no pueden dejar a nadie sin sus mensajes.
 *
 * -----------------------------------------------------------------------------
 * BUSCAR Y FILTRAR LOS RESUELVE EL SERVIDOR
 * -----------------------------------------------------------------------------
 * Antes esta pantalla hacía `conversations.filter(c => c.name.includes(texto))`
 * en el cuerpo del render y además apagaba `onEndReached` mientras hubiera
 * texto. Con doscientas conversaciones eso busca entre las veinte que hay en
 * memoria y calla el resto. Ahora el texto, el filtro y la etiqueta viajan en la
 * petición, y la paginación sigue funcionando sobre el resultado filtrado.
 *
 * -----------------------------------------------------------------------------
 * ...PERO MIENTRAS CONTESTA, LO QUE HAY SE ESTRECHA AL INSTANTE
 * -----------------------------------------------------------------------------
 * Reportado el 04/10/2026: «se demora demasiado en buscar». Buscar esperaba al
 * antirrebote, VACIABA la lista, pintaba un indicador y esperaba a la red: con
 * cuatro conversaciones delante, encontrar una tardaba lo que tardara el viaje.
 * Ahora cada tecla estrecha lo que ya está en pantalla (`filasVisibles`), y la
 * respuesta del servidor —la que manda— lo sustituye al llegar. No es volver a
 * filtrar en el teléfono: en cuanto hay respuesta se pinta la suya, sin tocar.
 *
 * -----------------------------------------------------------------------------
 * FILTROS Y ETIQUETAS SON DOS EJES DISTINTOS
 * -----------------------------------------------------------------------------
 * «No leídos» y «No respondidos» son ESTADOS DERIVADOS: se calculan de los
 * mensajes y cambian solos. Las etiquetas son CATEGORÍAS PERSISTENTES que pone
 * una persona. Se combinan («no respondidos entre los que marqué como Alumnos»)
 * pero no se mezclan: una etiqueta «no leído» que nadie vuelve a quitar miente a
 * los dos días.
 */
export function MessagesScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  /* Lo que ocupa la capsula flotante. Antes eran 120 escritos a mano: con los
     tres botones de Android la capsula ya mide 118 y en otros aparatos mas. */
  const espacioInferior = useEspacioInferior();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const signedIn = useAuthStore((state) => state.status === 'authenticated');
  const demoConversations = useAppStore((state) => state.conversations);

  const [consulta, setConsulta] = useState<ConsultaDeBandeja>(CONSULTA_VACIA);
  const [remote, setRemote] = useState<Conversation[]>([]);
  const [status, setStatus] = useState<'loading' | 'idle' | 'error'>('loading');
  /*
    LO TECLEADO Y LO SERVIDO.

    `tecleado` cambia en cada tecla (lo dice el buscador, ya normalizado);
    `servido` es el texto de la última respuesta del servidor que se pintó.
    Mientras difieren hay una pregunta por salir o en vuelo, y la lista enseña
    lo que tiene, estrechado. Cuando coinciden, lo que se ve es del servidor.

    Las filas llevan `React.memo`: estrechar repinta las que entran o salen, no
    la lista entera, que era lo que costaba tener el texto en esta pantalla.
  */
  const [tecleado, setTecleado] = useState<string>(CONSULTA_VACIA.texto);
  const [servido, setServido] = useState<string>(CONSULTA_VACIA.texto);
  const [refreshing, setRefreshing] = useState(false);
  // Si queda algo por debajo, y si se esta trayendo ahora mismo.
  const [hayMas, setHayMas] = useState(true);
  const [cargandoMas, setCargandoMas] = useState(false);

  const [etiquetas, setEtiquetas] = useState<EstadoDeEtiquetas>({
    disponible: false,
    etiquetas: [],
  });
  /** Si el servidor guarda las respuestas a historias (migración 0044). */
  const [respuestasAHistorias, setRespuestasAHistorias] = useState(false);
  /**
   * Para quién está abierto el gestor de etiquetas.
   *
   * `undefined` = cerrado · `null` = abierto en modo lista (desde los chips) ·
   * un identificador = abierto sobre ESA conversación (pulsación larga).
   */
  const [gestorPara, setGestorPara] = useState<string | null | undefined>(undefined);

  /*
    Lo que hay pintado y lo que se está pidiendo, accesibles desde los callbacks
    sin volver a crearlos.

    `onEndReached` se dispara mientras alguien baja; si dependiera del estado,
    cada carga cambiaria la funcion y la lista la volveria a montar en mitad del
    desplazamiento. Y `load` tiene que poder leer la consulta vigente sin
    depender de ella: si dependiera, cambiar de filtro recrearía el
    `useFocusEffect` y dispararía una petición de más.
  */
  const conversacionesRef = useRef<Conversation[]>([]);
  conversacionesRef.current = remote;
  const consultaRef = useRef<ConsultaDeBandeja>(consulta);
  consultaRef.current = consulta;
  const servidoRef = useRef(servido);
  servidoRef.current = servido;

  /*
    El sello de la última petición pedida, y cuándo se cargó por última vez.

    EL SELLO EVITA QUE UNA RESPUESTA LENTA PISE A UNA MÁS NUEVA. Cambiar de
    «No leídos» a «Todas» lanza dos peticiones y nada garantiza que vuelvan en
    ese orden; si la primera llega la última, la pantalla enseña una lista
    filtrada con el filtro ya quitado. No da error, no sale en los registros y no
    se reproduce en una red buena. Es el mismo criterio que `busquedaProgresiva`
    aplica en la pantalla de buscar.
  */
  const sello = useRef(0);
  const ultimaCarga = useRef<number | null>(null);

  /**
   * Trae la primera pagina de lo que se esté pidiendo ahora.
   *
   * `silencioso` es la diferencia entre volver a esta pantalla y verla parpadear
   * en blanco o no. Antes cada vuelta al foco ponia el estado en «cargando», y
   * eso vacia la lista y pinta el esqueleto AUNQUE ya hubiera datos buenos
   * delante: salir a un chat y volver hacia atras costaba un fogonazo. Lo que
   * cambia entre ida y vuelta suele ser un contador de no leidos, no la lista
   * entera, asi que se refresca por debajo y se sustituye cuando llega.
   */
  const load = useCallback(
    (silencioso = false) => {
      // Sin sesion no se pide nada: las conversaciones son de alguien y el
      // servidor responderia que no esta autorizado.
      if (!supabaseEnabled || !signedIn) {
        setStatus('idle');
        return Promise.resolve();
      }
      const mio = ++sello.current;
      // Lo que se pide AHORA. Se guarda porque al volver la respuesta la
      // consulta vigente puede ser ya otra, y lo servido es esto.
      const pedida = consultaRef.current;
      if (!silencioso || conversacionesRef.current.length === 0) setStatus('loading');
      // Cuándo salió la pregunta: lo que entre en vivo mientras va y viene se
      // vuelve a poner encima de la respuesta (`anotarMensajes`).
      const pedidaEn = Date.now();
      return MessageRepository.listConversations({ consulta: pedida })
        .then((data) => {
          if (!esVigente(mio, sello.current)) return;
          // La bandeja sin filtrar es la fuente del globo de la barra: ya
          // está aquí, no hace falta otra petición para contarla. Con una
          // búsqueda o un filtro puestos NO se anota: sería contar un trozo.
          // Lo que se pinta es lo que devuelve, con lo llegado en vivo encima.
          const portada = hayConsulta(consultaRef.current) ? data : anotarMensajes(data, pedidaEn);
          setRemote(portada);
          setServido(pedida.texto);
          setHayMas(data.length >= CONVERSACIONES_POR_PAGINA);
          setStatus('idle');
          ultimaCarga.current = Date.now();
        })
        .catch(() => {
          if (!esVigente(mio, sello.current)) return;
          // Un refresco silencioso que falla NO borra lo que se esta leyendo:
          // sustituir una lista buena por una pantalla de error porque se cayo
          // la red un segundo es peor que no refrescar.
          //
          // SALVO que lo que falló sea una BÚSQUEDA nueva: ahí lo de delante no
          // es la respuesta sino lo estrechado a la espera, y callar el fallo
          // dejaría la lupa girando para siempre sobre una lista a medias.
          const eraUnRefresco = pedida.texto === servidoRef.current;
          if (silencioso && conversacionesRef.current.length > 0 && eraUnRefresco) return;
          setStatus('error');
        });
    },
    [supabaseEnabled, signedIn],
  );

  /*
    LO QUE PASA FUERA DE ESTA PANTALLA, sin volver a pedir nada.

    Con la validez de treinta segundos, volver de un chat dejaba su fila con el
    globo de «sin leer» aunque se acabara de leer —y entrando desde una
    notificación, siempre—. Dos avisos lo corrigen en el acto: que se ha leído
    una conversación, y la lectura fresca que el contador común hace al salir
    de un chat y al llegar un mensaje. Ver `lib/bandeja.ts`.
  */
  useEffect(() => {
    const dejarLasLeidas = alLeerUnaConversacion((conversacionId) => {
      setRemote((actuales) => sinLeerEn(actuales, conversacionId) as Conversation[]);
    });
    const dejarLaBandeja = alLlegarLaBandeja((frescas) => {
      const portada = !hayConsulta(consultaRef.current);
      setRemote((actuales) => bandejaAlDia(actuales, frescas, portada) as Conversation[]);
      // Lo fresco es la portada entera: cuenta como recién cargada.
      if (portada) ultimaCarga.current = Date.now();
    });
    /*
      UN MENSAJE QUE ACABA DE LLEGAR, ya colocado (28/10/2026): la fila sube,
      cambia su resumen y su globo, sin pedir nada (`lib/bandejaEnVivo.ts`).
      Se fusiona igual que una lectura fresca, pero NO cuenta como recién
      cargada: no lo ha dicho el servidor, y al enfocar la pantalla con datos
      de más de treinta segundos se le sigue preguntando.
    */
    const dejarLosCambios = alCambiarLaBandeja((portadaEnVivo) => {
      const portada = !hayConsulta(consultaRef.current);
      setRemote((actuales) => bandejaAlDia(actuales, portadaEnVivo, portada) as Conversation[]);
    });
    return () => {
      dejarLasLeidas();
      dejarLaBandeja();
      dejarLosCambios();
    };
  }, []);

  /**
   * La pagina siguiente, al llegar al final de la lista.
   *
   * SE PAGINA TAMBIÉN BUSCANDO Y FILTRANDO. Antes `onEndReached` se apagaba
   * mientras hubiera texto, y estaba bien razonado: filtrando en memoria, pedir
   * más páginas daba la sensación de que la lista se completaba sola. Ahora
   * quien recorta es el servidor, así que hay resultados de verdad por debajo y
   * no poder bajar a por ellos sería el nuevo engaño.
   */
  const cargarMas = useCallback(() => {
    if (!supabaseEnabled || !signedIn) return;
    if (cargandoMas || !hayMas || status !== 'idle') return;
    // No se pide la página dos de una lista que todavía no tiene la uno. Con la
    // lista vacía —sin resultados, o con la primera carga fallida— `FlashList`
    // puede considerar que ya se ha llegado al final y disparar esto.
    if (conversacionesRef.current.length === 0) return;

    const mio = ++sello.current;
    setCargandoMas(true);
    MessageRepository.listConversations({
      offset: conversacionesRef.current.length,
      consulta: consultaRef.current,
    })
      .then((mas) => {
        // Si mientras bajaba se cambió el filtro, esta página ya no corresponde
        // a lo que se está mirando: añadirla mezclaría dos listas distintas.
        if (!esVigente(mio, sello.current)) return;
        if (mas.length === 0) {
          // Sin esto, cada rebote al final de la lista lanzaria otra peticion
          // para recibir siempre lo mismo.
          setHayMas(false);
          return;
        }
        // Por identificador y no concatenando a secas: entre una pagina y la
        // siguiente puede entrar un mensaje que reordene la lista, y entonces
        // una conversacion sale en las dos paginas.
        setRemote((previas) => fusionarPaginas(previas, mas));
        setHayMas(mas.length >= CONVERSACIONES_POR_PAGINA);
      })
      .catch(() => {
        // Lo ya cargado se queda; se puede volver a intentar bajando otra vez.
      })
      .finally(() => setCargandoMas(false));
  }, [supabaseEnabled, signedIn, cargandoMas, hayMas, status]);

  /*
    Las etiquetas y qué funciones hay, en paralelo con la bandeja.

    Ninguna de las dos puede tumbar la pantalla: `cargarEtiquetas` no lanza
    nunca —devuelve `disponible: false`— y `funciones()` responde `false` ante
    cualquier fallo. Sin la 0045 no hay chips; sin la 0044 no se ofrece el filtro
    de respuestas a historias. Nunca un botón muerto.
  */
  useEffect(() => {
    if (!supabaseEnabled || !signedIn) return;
    let vivo = true;
    void cargarEtiquetas().then((estado) => {
      if (vivo) setEtiquetas(estado);
    });
    void MessageRepository.funciones().then((funciones) => {
      if (vivo) setRespuestasAHistorias(funciones.respuestasAHistorias);
    });
    return () => {
      vivo = false;
    };
  }, [supabaseEnabled, signedIn]);

  /*
    Cambiar de búsqueda, de filtro o de etiqueta vuelve a pedir la primera
    página.

    UN FILTRO O UNA ETIQUETA NO SON SILENCIOSOS, a propósito: ahí cambia la
    lista entera, y dejar la anterior mientras llega la nueva haría creer que
    el filtro no ha hecho nada.

    EL TEXTO SÍ: lo que hay delante ya se ha estrechado con cada tecla, así que
    la lista ya dice que la búsqueda está en marcha. Vaciarla para pintar un
    indicador era justo lo que hacía que buscar pareciera lento.
  */
  const primerRender = useRef(true);
  const consultaPrevia = useRef(consulta);
  useEffect(() => {
    if (primerRender.current) {
      // Al montar ya carga el `useFocusEffect`; sin esta guarda serían dos
      // peticiones idénticas en el arranque.
      primerRender.current = false;
      return;
    }
    const previa = consultaPrevia.current;
    consultaPrevia.current = consulta;
    const soloCambioElTexto =
      previa.filtro === consulta.filtro && previa.etiqueta === consulta.etiqueta;
    ultimaCarga.current = null;
    setHayMas(true);
    void load(soloCambioElTexto);
  }, [consulta, load]);

  /*
    Al volver a la pantalla, se refresca SOLO SI hace falta.

    Antes se recargaba en cada foco, sin condición: salir a un chat y volver
    costaba otra petición (~0,42 s) para recibir casi siempre lo mismo. Con la
    validez de `lib/bandeja.ts` ese viaje de ida y vuelta ya no se paga, y una
    ausencia larga sí se refresca.
  */
  useFocusEffect(
    useCallback(() => {
      if (!hayQueRecargar(ultimaCarga.current, Date.now())) return;
      void load(true);
    }, [load]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    // Tirar para recargar es una petición explícita: se salta la validez.
    ultimaCarga.current = null;
    // Se espera de verdad: antes se apagaba el indicador en la misma vuelta,
    // asi que el gesto de estirar no llegaba a verse.
    void load(true).finally(() => setRefreshing(false));
  }, [load]);

  const alBuscar = useCallback((texto: string) => {
    // Devolver el MISMO objeto cuando no cambia nada evita una recarga por una
    // identidad nueva: el efecto de arriba compara por referencia.
    setConsulta((previa) => (previa.texto === texto ? previa : { ...previa, texto }));
  }, []);

  /** Cada tecla, ya normalizada. No pide nada: solo estrecha lo que hay. */
  const alTeclear = useCallback((termino: string) => setTecleado(termino), []);

  const alFiltrar = useCallback((filtro: FiltroDeBandeja | null) => {
    setConsulta((previa) => (previa.filtro === filtro ? previa : { ...previa, filtro }));
  }, []);

  const alEtiquetar = useCallback((etiqueta: string | null) => {
    setConsulta((previa) =>
      previa.etiqueta === etiqueta ? previa : { ...previa, etiqueta },
    );
  }, []);

  /**
   * Después de crear, renombrar, borrar o asignar una etiqueta.
   *
   * SI DESAPARECE LA ETIQUETA POR LA QUE SE ESTABA FILTRANDO, se quita el
   * filtro. Sin esto la bandeja se quedaría vacía para siempre, filtrando por
   * algo que ya no existe, y con el chip correspondiente tampoco en la fila: no
   * habría manera de entender qué ha pasado ni de deshacerlo.
   */
  const trasCambiarEtiquetas = useCallback(async () => {
    const nuevo = await cargarEtiquetas();
    setEtiquetas(nuevo);
    const filtrando = consultaRef.current.etiqueta;
    if (filtrando && !nuevo.etiquetas.some((e) => e.id === filtrando)) {
      // Cambiar la consulta ya dispara la recarga; pedirla también aquí serían
      // dos peticiones para la misma lista.
      setConsulta((previa) => ({ ...previa, etiqueta: null }));
      return;
    }
    ultimaCarga.current = null;
    await load(true);
  }, [load]);

  /** El servidor dice que la 0045 no está: se deja de ofrecer la función. */
  const sinEtiquetas = useCallback(() => {
    setEtiquetas({ disponible: false, etiquetas: [] });
    setGestorPara(undefined);
    setConsulta((previa) => (previa.etiqueta ? { ...previa, etiqueta: null } : previa));
  }, []);

  const abrirChat = useCallback(
    (conversacion: Conversation) => {
      /*
        UN GRUPO CON TEMAS O COMUNIDADES SE ABRE POR SU LISTA, como en
        Telegram: General, los temas y las comunidades, cada uno con lo suyo.
        Lo que ya se sabe de General viaja para que la primera fila no salga
        en blanco mientras la lista pregunta lo demás.
      */
      if (abreLaLista(conversacion)) {
        router.push({
          pathname: '/chat/lista/[id]' as never,
          params: {
            id: conversacion.id,
            name: conversacion.name,
            resumen: conversacion.subtitle,
            hora: conversacion.time ?? '',
            sinLeer: String(conversacion.unread || 0),
          },
        });
        return;
      }
      router.push({
        pathname: '/chat/[id]',
        params: { id: conversacion.id, name: conversacion.name },
      });
    },
    [router],
  );

  const abrirGestorDe = useCallback((conversacion: Conversation) => {
    setGestorPara(conversacion.id);
  }, []);

  const abrirGestorDeLaLista = useCallback(() => setGestorPara(null), []);
  const cerrarGestor = useCallback(() => setGestorPara(undefined), []);

  /*
    La bandeja de DEMOSTRACIÓN (sin Supabase) se filtra aquí, y esta vez sí es
    correcto: son unas pocas filas fijas, están todas en memoria y no hay
    servidor al que preguntar ni paginación que romper. Es justo lo contrario del
    caso real, donde filtrar lo ya descargado sólo ve la primera página.
  */
  const pendiente = supabaseEnabled && esperandoAlServidor(tecleado, servido);
  const conversations = useMemo(() => {
    // Del servidor tal cual cuando ya contestó a lo tecleado; si no, lo que
    // hay, estrechado, mientras llega. Ver `filasVisibles`.
    if (supabaseEnabled) return filasVisibles(remote, { tecleado, servido });
    if (!hayConsulta(consulta)) return demoConversations;
    const texto = consulta.texto.toLowerCase();
    return demoConversations.filter((conv) => {
      const coincide =
        !texto ||
        conv.name.toLowerCase().includes(texto) ||
        conv.subtitle.toLowerCase().includes(texto);
      const pasaFiltro = consulta.filtro !== 'unread' || conv.unread > 0;
      return coincide && pasaFiltro;
    });
  }, [supabaseEnabled, remote, demoConversations, consulta, tecleado, servido]);

  /*
    «ESCRIBIENDO…» EN LAS FILAS. Aquí solo se abren los canales de las
    primeras conversaciones; quién escribe lo lee cada fila por su cuenta,
    así que un aviso no repinta esta pantalla. Ver `useEscribiendoEnBandeja`.
  */
  const yo = useAppStore((state) => state.user?.id);
  useEscribiendoEnBandeja(conversations, yo, supabaseEnabled && signedIn);

  const hasMessages = conversations.length > 0;
  const uiState = supabaseEnabled && status === 'loading'
    ? 'loading'
    : supabaseEnabled && status === 'error'
    ? 'error'
    : hasMessages
    ? 'content'
    // Nada de lo cargado casa y el servidor aún no ha contestado: todavía no
    // se sabe. «No hay ninguna así» se dice cuando lo confirma él.
    : pendiente
    ? 'loading'
    : 'empty';

  /*
    `useMemo` para que `data` no cambie de identidad en cada render: sin esto,
    `FlashList` da por hecho que la lista es otra y repinta las celdas visibles.
    Medido: ~8 filas por pulsación en el buscador.
  */
  const datos = useMemo(
    () => (uiState === 'content' ? conversations : []),
    [uiState, conversations],
  );

  const renderItem = useCallback(
    ({ item }: { item: Conversation }) => (
      <FilaDeConversacion
        conversacion={item}
        alAbrir={abrirChat}
        // Sin la 0045 no hay etiquetas que poner: mantener pulsado no abre nada
        // en vez de abrir una hoja que sólo puede decir que no está disponible.
        alEtiquetar={etiquetas.disponible ? abrirGestorDe : undefined}
      />
    ),
    [abrirChat, abrirGestorDe, etiquetas.disponible],
  );

  const keyExtractor = useCallback((item: Conversation) => item.id, []);

  /*
    La cabecera y el control de recarga, memorizados.

    Eran elementos JSX en línea: se reconstruían enteros en cada render, y con
    ellos el buscador. Ahora sólo cambian cuando cambia algo suyo de verdad.
  */
  const cabecera = useMemo(
    () => (
      <View style={styles.cabecera}>
        {/*
          EL BUSCADOR, LO PRIMERO, como en cualquier bandeja: es lo que se
          viene a usar cuando hay muchas conversaciones, y antes quedaba debajo
          de las historias.
        */}
        <View style={styles.buscador}>
          <BuscadorDeConversaciones alBuscar={alBuscar} alTeclear={alTeclear} ocupado={pendiente} />
        </View>

        {/*
          Las historias, por la API (una consulta, un salto), no por el camino
          de Supabase directo (cuatro saltos, ~1,7 s).
        */}
        {supabaseEnabled && signedIn ? <HistoriasDeLaBandeja /> : null}

        <View style={styles.controles}>
          {/*
            PRIMERO LAS ETIQUETAS Y «FILTROS» A LA DERECHA (pedido el 25/09/2026:
            antes iba a la izquierda). Los chips del CRM, en su propia fila
            desplazable, desaparecen enteros sin la 0045; entonces «Filtros»
            queda solo, a la derecha.
          */}
          <View style={styles.filaDeFiltros}>
            <View style={styles.chips}>
              <ChipsDeEtiquetas
                etiquetas={etiquetas.etiquetas}
                seleccionada={consulta.etiqueta}
                alSeleccionar={alEtiquetar}
                disponible={etiquetas.disponible}
                alGestionar={abrirGestorDeLaLista}
              />
            </View>
            <View style={styles.filtros}>
              <FiltrosDeBandeja
                seleccionado={consulta.filtro}
                alSeleccionar={alFiltrar}
                respuestasAHistorias={respuestasAHistorias}
              />
            </View>
          </View>

          {/*
            LA EXPLICACIÓN, DEBAJO DEL RENGLÓN Y A TODO EL ANCHO (12/10/2026).
            Dentro de la columna de las etiquetas se quedaba con el ancho que
            le dejaba «Filtros»: tres líneas estrechas y un hueco a la derecha.
            Aquí llega hasta el mismo margen que el buscador, y no más.
          */}
          <ExplicacionDeEtiquetas
            etiquetas={etiquetas.etiquetas}
            disponible={etiquetas.disponible}
            alGestionar={abrirGestorDeLaLista}
          />
        </View>
      </View>
    ),
    [
      supabaseEnabled,
      signedIn,
      alBuscar,
      alTeclear,
      pendiente,
      consulta.filtro,
      consulta.etiqueta,
      alFiltrar,
      respuestasAHistorias,
      etiquetas.etiquetas,
      etiquetas.disponible,
      alEtiquetar,
      abrirGestorDeLaLista,
    ],
  );

  const controlDeRecarga = useMemo(
    () => (
      <RefreshControl
        refreshing={refreshing}
        onRefresh={onRefresh}
        tintColor={colors.text}
        colors={[colors.text]}
      />
    ),
    [refreshing, onRefresh, colors.text],
  );

  const pie = useMemo(
    () =>
      cargandoMas ? (
        <View style={styles.cargandoMas}>
          <ActivityIndicator size="small" color={colors.textMuted} />
        </View>
      ) : null,
    [cargandoMas, colors.textMuted],
  );

  /*
    Buscando o filtrando, el vacío significa otra cosa: no es «no tienes
    conversaciones» sino «no hay ninguna así». Decir lo primero cuando pasa lo
    segundo hace pensar que se han perdido los mensajes.
  */
  const buscando = hayConsulta(consulta);
  const vacio = useMemo(
    () => (
      <StateView
        state={uiState}
        onRetry={() => void load()}
        title={
          uiState === 'empty'
            ? buscando
              ? t('messages.noResultsTitle')
              : t('messages.emptyTitle')
            : undefined
        }
        description={
          uiState === 'empty'
            ? buscando
              ? t('messages.noResultsBody')
              : t('messages.emptyBody')
            : undefined
        }
        icon={buscando ? 'search' : 'message-square'}
      />
    ),
    [uiState, buscando, t, load],
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/*
        Sin icono a la derecha: el lápiz de antes tenía `onRightPress={() => {}}`
        y no hacía absolutamente nada. Un botón muerto es peor que no tenerlo —
        se pulsa, no pasa nada, y quien lo pulsa cree que la aplicación falla. Un
        chat nuevo se abre desde el perfil de la persona, que es donde está el
        botón que sí funciona.
      */}
      <AppHeader
        title={t('messages.title')}
        grande
        // CREAR UN GRUPO. Solo con sesión y servidor: sin ellos no hay a
        // quién añadir, y el botón no se pinta (nunca uno que no haga nada).
        rightIcon={supabaseEnabled && signedIn ? 'users' : undefined}
        onRightPress={
          supabaseEnabled && signedIn
            ? () => router.push('/chat/nuevo-grupo' as never)
            : undefined
        }
        rightLabel={t('groups.new')}
      />
      {supabaseEnabled && !signedIn ? (
        <SignedOutNotice
          icon="message-square"
          title={t('messages.signedOutTitle')}
          description={t('messages.signedOutBody')}
        />
      ) : (
        <>
          <FlashList
            data={datos}
            keyExtractor={keyExtractor}
            contentContainerStyle={[styles.listContent, { paddingBottom: espacioInferior + spacing.lg }]}
            refreshControl={controlDeRecarga}
            ListHeaderComponent={cabecera}
            onEndReached={cargarMas}
            onEndReachedThreshold={0.6}
            ListFooterComponent={pie}
            ListEmptyComponent={vacio}
            renderItem={renderItem}
            // Al tocar la lista se cierra el teclado, pero sin cancelar la
            // pulsación: sin esto, el primer toque sobre una fila con el teclado
            // abierto sólo lo cerraba y había que volver a tocar.
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          />

          {/*
            El gestor se abre desde los chips (modo lista) o manteniendo pulsada
            una conversación (poner y quitar en ESA). Es la misma hoja porque el
            gesto natural cruza las dos cosas: «esta persona es alumna... espera,
            no tengo esa etiqueta».
          */}
          <GestorDeEtiquetas
            visible={gestorPara !== undefined}
            onClose={cerrarGestor}
            etiquetas={etiquetas.etiquetas}
            conversationId={gestorPara ?? null}
            alCambiar={trasCambiarEtiquetas}
            alDejarDeEstarDisponible={sinEtiquetas}
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  listContent: { paddingHorizontal: spacing.lg },
  cargandoMas: { paddingVertical: spacing.lg, alignItems: 'center' },
  // Las historias se pintan de borde a borde (tienen su propio relleno), así que
  // se compensa el margen de la lista con un margen negativo. Es lo único que
  // sobresale; el resto de la cabecera respeta el mismo margen que las filas.
  cabecera: { marginHorizontal: -spacing.lg },
  buscador: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs, paddingBottom: spacing.sm },
  // Sin `gap`: la explicación va pegada a la fila, como cuando vivía dentro de
  // ella. El aire de arriba y de abajo ya lo ponen la fila y el propio texto.
  controles: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xs },
  // Arriba y no al centro: «Filtros» tiene que quedar a la altura de los
  // chips aunque una de las dos columnas crezca.
  filaDeFiltros: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  // `flex: 1` y `minWidth: 0`: sin esto, una fila de etiquetas larga empuja el
  // botón de filtros fuera de la pantalla en vez de desplazarse por dentro.
  chips: { flex: 1, minWidth: 0 },
  // Las mismas medidas que la fila de chips (`Chip` mide 44 y la fila lleva
  // `spacing.sm` arriba y abajo): así el botón queda centrado con ellos.
  filtros: { minHeight: 44 + spacing.sm * 2, justifyContent: 'center' },
});
