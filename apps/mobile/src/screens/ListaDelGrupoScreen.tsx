import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';

import { AppHeader } from '@/components/AppHeader';
import { Avatar } from '@/components/Avatar';
import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { useEspacioInferior } from '@/components/espacioInferior';
import { GloboDeNoLeidos } from '@/components/GloboDeNoLeidos';
import { InlineError } from '@/components/InlineError';
import { Input } from '@/components/Input';
import { ListRow } from '@/components/ListRow';
import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { useInfoDeConversacion } from '@/hooks/useInfoDeConversacion';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { afterSheetClose } from '@/lib/afterSheetClose';
import { confirm, notify } from '@/lib/confirm';
import { claveDelFalloDeGrupo } from '@/lib/gruposDeChat';
import {
  MAX_NOMBRE_DE_TEMA,
  MAX_TEMAS_POR_GRUPO,
  MAX_TITULO_DE_COMUNIDAD,
  accionDeComunidad,
  claveDelFalloDeTemas,
  juzgarNombreDeTema,
  juzgarTituloDeComunidad,
  limpiarNombre,
  resumenDeUltimo,
  type ComunidadDeGrupo,
  type ComunidadesDeGrupo,
  type EntradaDeComunidad,
  type TemaDeGrupo,
  type TemasDeGrupo,
  type UltimoMensaje,
} from '@/lib/temasDeGrupo';
import { toast } from '@/lib/toast';
import { formatTime } from '@/mappers/messageMapper';
import { ComunidadesRepository } from '@/repositories/ComunidadesRepository';
import { GroupRepository } from '@/repositories/GroupRepository';
import { TemasRepository } from '@/repositories/TemasRepository';
import { ApiError } from '@/services/api';
import {
  alCambiarLaBandeja,
  alLeerUnaConversacion,
  alLlegarLaBandeja,
  refrescarMensajes,
} from '@/services/contadores';
import { avisosDeTemas } from '@/services/realtime';
import { profileImageUrl } from '@/services/storage';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Conversation } from '@/types';

/** Lo que se sabe de General: lo mismo que su fila de la bandeja. */
type ResumenDeGeneral = { resumen: string; hora: string; sinLeer: number };

/** Cuánto se espera a que pare una ráfaga de avisos antes de volver a preguntar. */
const RESPIRO_DE_AVISOS_MS = 800;

/**
 * La LISTA de un grupo, como los temas de Telegram.
 *
 * Arriba «General», que es el chat de siempre. Debajo los TEMAS, que todos los
 * miembros leen sin unirse y que solo llena la administración, y las
 * COMUNIDADES, grupos hijos en los que cada persona entra si quiere. Cada fila
 * se abre como un chat y lleva su numerito de no leídos.
 *
 * SE LLEGA AQUÍ DESDE LA BANDEJA, y solo cuando el grupo tiene algún tema o
 * comunidad (`abreLaLista`): un grupo que no los usa se abre como siempre.
 *
 * GENERAL NO SE PREGUNTA APARTE. Lo que dice su fila es lo mismo que la fila de
 * la bandeja —su último mensaje, su hora y lo no leído—, así que viaja en la
 * navegación y se pone al día con la lectura de la bandeja que ya hace el
 * contador común al salir de un chat. Una petición más por abrir la lista
 * sería pagar dos veces por lo mismo.
 *
 * NUNCA UN BOTÓN MUERTO. Sin la 0108 no se pinta la sección de temas; sin la
 * 0109, la de comunidades. Y lo que solo hace quien administra —crear temas y
 * comunidades, ver las solicitudes— solo se le ofrece a quien administra. El
 * permiso, como siempre, lo decide el servidor.
 */
export function ListaDelGrupoScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const espacioInferior = useEspacioInferior();
  const params = useLocalSearchParams<{
    id: string;
    name?: string;
    resumen?: string;
    hora?: string;
    sinLeer?: string;
  }>();
  const grupoId = typeof params.id === 'string' ? params.id : '';
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const currentUserId = useAppStore((state) => state.user?.id ?? null);
  const activo = supabaseEnabled && !!grupoId;

  const { info, refrescar: refrescarInfo } = useInfoDeConversacion(grupoId, currentUserId, activo);

  const [temas, setTemas] = useState<TemasDeGrupo | null>(null);
  const [comunidades, setComunidades] = useState<ComunidadesDeGrupo | null>(null);
  const [fallo, setFallo] = useState(false);
  const [refrescando, setRefrescando] = useState(false);
  const [general, setGeneral] = useState<ResumenDeGeneral | null>(() =>
    typeof params.resumen === 'string' && params.resumen
      ? {
          resumen: params.resumen,
          hora: typeof params.hora === 'string' ? params.hora : '',
          sinLeer: Number(params.sinLeer) > 0 ? Math.floor(Number(params.sinLeer)) : 0,
        }
      : null,
  );
  const [menuAbierto, setMenuAbierto] = useState(false);
  const [hoja, setHoja] = useState<'tema' | 'comunidad' | null>(null);
  /** La comunidad en la que se está entrando, pidiendo o retirando. */
  const [ocupada, setOcupada] = useState<string | null>(null);

  const titulo = info?.titulo || (typeof params.name === 'string' ? params.name : '') || t('groups.infoTitle');

  /*
    LO QUE HAY PINTADO, accesible desde los avisos sin volver a crearlos. Un
    refresco que falla no borra lo que ya se lee; solo la primera carga puede
    acabar en «no se pudo».
  */
  const temasRef = useRef(temas);
  temasRef.current = temas;
  const comunidadesRef = useRef(comunidades);
  comunidadesRef.current = comunidades;
  const montada = useRef(true);
  useEffect(
    () => () => {
      montada.current = false;
    },
    [],
  );

  /**
   * Temas y comunidades, A LA VEZ y cada uno por su lado.
   *
   * Que falle uno no tumba al otro, y ninguno tumba General: es la fila que
   * más se usa y no depende de estas dos preguntas.
   */
  const cargar = useCallback(async () => {
    if (!activo) return;
    const [deTemas, deComunidades] = await Promise.allSettled([
      TemasRepository.listar(grupoId),
      ComunidadesRepository.listar(grupoId),
    ]);
    if (!montada.current) return;
    if (deTemas.status === 'fulfilled') setTemas(deTemas.value);
    if (deComunidades.status === 'fulfilled') setComunidades(deComunidades.value);
    const sinTemas = deTemas.status === 'rejected' && !temasRef.current;
    const sinComunidades = deComunidades.status === 'rejected' && !comunidadesRef.current;
    setFallo(sinTemas || sinComunidades);
  }, [activo, grupoId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  /*
    GENERAL, AL DÍA SIN PREGUNTAR. El contador común lee la bandeja al salir
    de cada chat; de ahí sale la fila de este grupo. Y leer General desde aquí
    deja su globo a cero en el acto.
  */
  useEffect(() => {
    const ponerGeneral = (frescas: readonly Conversation[]) => {
      const fila = frescas.find((c) => c.id === grupoId);
      if (fila) setGeneral({ resumen: fila.subtitle, hora: fila.time ?? '', sinLeer: fila.unread || 0 });
    };
    const dejarLaBandeja = alLlegarLaBandeja(ponerGeneral);
    // Un mensaje en General ya no hace releer la bandeja entera (28/10/2026):
    // llega colocado por aquí, sin preguntar.
    const dejarLosCambios = alCambiarLaBandeja(ponerGeneral);
    const dejarLasLeidas = alLeerUnaConversacion((conversacionId) => {
      if (conversacionId === grupoId) setGeneral((g) => (g ? { ...g, sinLeer: 0 } : g));
    });
    return () => {
      dejarLaBandeja();
      dejarLosCambios();
      dejarLasLeidas();
    };
  }, [grupoId]);

  // Sin lo de la bandeja —se llegó por un aviso o desde el chat—, se pide.
  const sinGeneralAlAbrir = useRef(!general);
  useEffect(() => {
    if (activo && sinGeneralAlAbrir.current) void refrescarMensajes();
  }, [activo]);

  /*
    AL VOLVER de un tema o de una comunidad, lo suyo cambió: su numerito, su
    último mensaje, quizá ya se es miembro. La primera vez ya cargó el montaje.
  */
  const yaTuvoElFoco = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (yaTuvoElFoco.current) {
        void cargar();
        refrescarInfo();
      }
      yaTuvoElFoco.current = true;
    }, [cargar, refrescarInfo]),
  );

  /*
    «ALGO CAMBIÓ EN LOS TEMAS»: otra persona agregó o quitó una referencia, o
    creó un tema. Se vuelve a preguntar, una sola vez por ráfaga.
  */
  const canal = useRef<{ avisar: () => void; cerrar: () => void } | null>(null);
  useEffect(() => {
    if (!activo) return;
    let pendiente: ReturnType<typeof setTimeout> | null = null;
    const abierto = avisosDeTemas(grupoId, () => {
      if (pendiente) return;
      pendiente = setTimeout(() => {
        pendiente = null;
        void cargar();
      }, RESPIRO_DE_AVISOS_MS);
    });
    canal.current = abierto;
    return () => {
      if (pendiente) clearTimeout(pendiente);
      canal.current = null;
      abierto.cerrar();
    };
  }, [activo, grupoId, cargar]);

  const alRefrescar = useCallback(async () => {
    setRefrescando(true);
    refrescarInfo();
    // Tirar para recargar es una petición explícita: también la fila de General.
    await Promise.all([cargar(), refrescarMensajes()]);
    if (montada.current) setRefrescando(false);
  }, [cargar, refrescarInfo]);

  /*
    SI ESTO NO ES UN GRUPO CON LISTA, al chat. Pasa con una fila vieja de la
    bandeja o un enlace guardado: una comunidad o el chat de un tema no tienen
    lista propia (un solo nivel).
  */
  useEffect(() => {
    if (!info) return;
    if (info.tema) {
      router.replace({
        pathname: '/chat/tema/[id]' as never,
        params: { id: info.tema.grupoId, tema: info.tema.temaId, name: info.tema.nombre },
      });
    } else if (!info.esGrupo || info.padre) {
      router.replace({ pathname: '/chat/[id]', params: { id: grupoId, name: info.titulo } });
    }
  }, [info, grupoId, router]);

  // -------------------------------------------------------------------------
  // Ir a los sitios
  // -------------------------------------------------------------------------

  const irAGeneral = () =>
    router.push({ pathname: '/chat/[id]', params: { id: grupoId, name: titulo } });

  const irAlTema = (tema: TemaDeGrupo) =>
    router.push({
      pathname: '/chat/tema/[id]' as never,
      params: { id: grupoId, tema: tema.id, name: tema.nombre },
    });

  const irALaComunidad = (comunidad: ComunidadDeGrupo) =>
    router.push({ pathname: '/chat/[id]', params: { id: comunidad.id, name: comunidad.titulo } });

  const verElGrupo = () =>
    router.push({ pathname: '/chat/grupo/[id]' as never, params: { id: grupoId } });

  /** Las solicitudes de una comunidad se responden donde ya se responden las de un grupo. */
  const verSolicitudes = (comunidad: ComunidadDeGrupo) =>
    router.push({ pathname: '/chat/ajustes-de-grupo/[id]' as never, params: { id: comunidad.id } });

  /** Cierra el menú y espera: nada se abre encima de una hoja que se va (iOS). */
  const trasElMenu = async () => {
    setMenuAbierto(false);
    await afterSheetClose();
  };

  /**
   * El texto que explica un rechazo del servidor, de temas o de grupos.
   * `deDentro`: el rechazo es de una de sus comunidades (en pantalla, un
   * «grupo»), no de este (en pantalla, la «comunidad»).
   */
  const textoDelFallo = useCallback(
    (error: unknown, deDentro = false): string => {
      const codigo = error instanceof ApiError ? error.code : null;
      return t(
        (claveDelFalloDeTemas(codigo) ?? claveDelFalloDeGrupo(codigo, deDentro)) as TranslationKey,
      );
    },
    [t],
  );

  // -------------------------------------------------------------------------
  // Comunidades: entrar, pedir, retirar
  // -------------------------------------------------------------------------

  const hacerConComunidad = async (
    comunidad: ComunidadDeGrupo,
    tarea: () => Promise<void>,
    hecho: string,
  ) => {
    if (ocupada) return;
    setOcupada(comunidad.id);
    try {
      await tarea();
      toast(hecho, 'check');
    } catch (error) {
      // Es en una de sus comunidades, que en pantalla es un «grupo»: «El grupo
      // está completo», no «La comunidad está completa».
      notify(t('chatMenu.failedTitle'), textoDelFallo(error, true));
    } finally {
      if (montada.current) setOcupada(null);
      // Pase lo que pase, lo que se pinta es lo que dice el servidor: si la
      // comunidad cambió de abierta a con solicitud, el botón cambia solo.
      void cargar();
    }
  };

  const unirme = (comunidad: ComunidadDeGrupo) =>
    hacerConComunidad(
      comunidad,
      () => ComunidadesRepository.unirme(grupoId, comunidad.id),
      t('groupCommunities.joined', { nombre: comunidad.titulo }),
    );

  const pedir = (comunidad: ComunidadDeGrupo) =>
    hacerConComunidad(comunidad, () => ComunidadesRepository.pedir(comunidad.id), t('groupJoin.pending'));

  const retirar = (comunidad: ComunidadDeGrupo) =>
    hacerConComunidad(
      comunidad,
      () => ComunidadesRepository.retirar(comunidad.id),
      t('groupCommunities.withdrawn'),
    );

  // -------------------------------------------------------------------------
  // Menú: ver el grupo, crear, salir
  // -------------------------------------------------------------------------

  const abrirHoja = async (cual: 'tema' | 'comunidad') => {
    await trasElMenu();
    setHoja(cual);
  };

  const salirDelGrupo = async () => {
    if (!currentUserId) return;
    await trasElMenu();
    const seguro = await confirm({
      title: t('groups.leaveTitle'),
      message: t('groupTopics.leaveBody'),
      confirmLabel: t('groups.leave'),
      destructive: true,
    });
    if (!seguro) return;
    try {
      // Sale también de sus comunidades y de los chats de sus temas (D10): lo
      // hace el servidor en la misma transacción.
      await GroupRepository.quitar(grupoId, currentUserId);
      router.replace('/messages' as never);
    } catch (error) {
      notify(t('chatMenu.failedTitle'), textoDelFallo(error));
    }
  };

  /** Tras crear algo: los demás que tengan la lista abierta, que pregunten. */
  const trasCrear = (mensaje: string) => {
    toast(mensaje, 'check');
    canal.current?.avisar();
    void cargar();
  };

  // -------------------------------------------------------------------------
  // Pintar
  // -------------------------------------------------------------------------

  const puedoAdministrar = info?.puedoAdministrar === true;
  const conTemas = temas?.disponible === true;
  const conComunidades = comunidades?.disponible === true;
  const listaDeTemas = temas?.temas ?? [];
  const listaDeComunidades = comunidades?.comunidades ?? [];
  // Crear se ofrece a quien administra y solo si el servidor sabe hacerlo.
  const puedeCrearTemas = conTemas && (temas?.puedoAdministrar || puedoAdministrar);
  const puedeCrearComunidades =
    conComunidades && (comunidades?.puedoAdministrar || puedoAdministrar);

  const subtitulo = [
    info ? t('groups.membersCount', { n: info.miembros.length }) : null,
    conTemas
      ? listaDeTemas.length === 1
        ? t('groupTopics.countOne')
        : t('groupTopics.countMany', { n: listaDeTemas.length })
      : null,
    conComunidades
      ? listaDeComunidades.length === 1
        ? t('groupCommunities.countOne')
        : t('groupCommunities.countMany', { n: listaDeComunidades.length })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  /** «Nombre: lo último» o qué era, si no tenía texto. */
  const vistaPrevia = (ultimo: UltimoMensaje): string => {
    const lo = resumenDeUltimo(ultimo);
    const texto = 'texto' in lo ? lo.texto : t(lo.clave as TranslationKey);
    return ultimo.autor ? `${ultimo.autor}: ${texto}` : texto;
  };
  const horaDe = (ultimo: UltimoMensaje | null) => (ultimo?.fechaIso ? formatTime(ultimo.fechaIso) : '');

  const cabecera = (
    <AppHeader
      onBack={() => (router.canGoBack() ? router.back() : router.replace('/messages' as never))}
      rightIcon={activo ? 'more-vertical' : undefined}
      onRightPress={activo ? () => setMenuAbierto(true) : undefined}
      rightLabel={t('groupTopics.menuOpen')}
      center={
        <Pressable
          onPress={verElGrupo}
          accessibilityRole="button"
          accessibilityLabel={t('groups.openGroup', { nombre: titulo })}
          hitSlop={8}
          style={styles.cabecera}
        >
          <Avatar size={30} image={profileImageUrl(info?.avatarPath) ?? null} name={titulo} />
          <View style={styles.cabeceraTextos}>
            <Text numberOfLines={1} weight="700" color={colors.text} style={styles.cabeceraTitulo}>
              {titulo}
            </Text>
            {subtitulo ? (
              <Text numberOfLines={1} color={colors.textMuted} style={styles.cabeceraSubtitulo}>
                {subtitulo}
              </Text>
            ) : null}
          </View>
        </Pressable>
      }
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {cabecera}
      <ScrollView
        contentContainerStyle={[styles.contenido, { paddingBottom: espacioInferior + spacing.xl }]}
        refreshControl={
          <RefreshControl
            refreshing={refrescando}
            onRefresh={() => void alRefrescar()}
            tintColor={colors.text}
            colors={[colors.text]}
          />
        }
      >
        {/* GENERAL: el chat de siempre. */}
        <FilaDeLaLista
          icono="message-circle"
          titulo={t('groupTopics.general')}
          resumen={general?.resumen || t('groupTopics.generalHint')}
          hora={general?.hora ?? ''}
          cuenta={general?.sinLeer ?? 0}
          etiqueta={t('groupTopics.generalLabel', {
            detalle: general?.resumen || t('groupTopics.generalHint'),
          })}
          alPulsar={irAGeneral}
        />

        {fallo ? (
          <View style={styles.fallo}>
            <InlineError message={t('groupTopics.loadError')} />
            <Button label={t('common.retry')} variant="secondary" icon="refresh-cw" onPress={() => void cargar()} />
          </View>
        ) : null}

        {/* TEMAS: los ven todos, los llena la administración. */}
        {conTemas && (listaDeTemas.length > 0 || puedeCrearTemas) ? (
          <View>
            <Text weight="800" accessibilityRole="header" style={styles.bloque}>
              {t('groupTopics.topics')}
            </Text>
            {listaDeTemas.map((tema) => {
              const detalle = tema.ultimo ? vistaPrevia(tema.ultimo) : t('groupTopics.emptyPreview');
              return (
                <FilaDeLaLista
                  key={tema.id}
                  icono={tema.icono}
                  titulo={tema.nombre}
                  soloLectura
                  resumen={detalle}
                  hora={horaDe(tema.ultimo)}
                  cuenta={tema.sinVer}
                  etiqueta={`${t('groupTopics.topicLabel', { nombre: tema.nombre, detalle })}${
                    tema.sinVer > 0 ? ` ${t('groupTopics.unseenCount', { n: tema.sinVer })}` : ''
                  }`}
                  alPulsar={() => irAlTema(tema)}
                />
              );
            })}
            {puedeCrearTemas && listaDeTemas.length < MAX_TEMAS_POR_GRUPO ? (
              <FilaParaCrear titulo={t('groupTopics.newTopic')} alPulsar={() => setHoja('tema')} />
            ) : null}
          </View>
        ) : null}

        {/* COMUNIDADES: cada una con su chat; se entra si se quiere. */}
        {conComunidades && (listaDeComunidades.length > 0 || puedeCrearComunidades) ? (
          <View>
            <Text weight="800" accessibilityRole="header" style={styles.bloque}>
              {t('groupCommunities.title')}
            </Text>
            {listaDeComunidades.map((comunidad) => (
              <FilaDeComunidad
                key={comunidad.id}
                comunidad={comunidad}
                ocupada={ocupada === comunidad.id}
                vistaPrevia={vistaPrevia}
                hora={horaDe(comunidad.ultimo)}
                alAbrir={() => irALaComunidad(comunidad)}
                alUnirme={() => void unirme(comunidad)}
                alPedir={() => void pedir(comunidad)}
                alRetirar={() => void retirar(comunidad)}
                alVerSolicitudes={() => verSolicitudes(comunidad)}
              />
            ))}
            {puedeCrearComunidades ? (
              <FilaParaCrear titulo={t('groupCommunities.new')} alPulsar={() => setHoja('comunidad')} />
            ) : null}
          </View>
        ) : null}
      </ScrollView>

      {/*
        EL MENÚ DE LA LISTA. «Ver el grupo» para todos; crear, para quien
        administra; salir, para quien no (quien administra no puede dejar el
        grupo sin nadie que lo lleve).
      */}
      <BottomSheet visible={menuAbierto} onClose={() => setMenuAbierto(false)}>
        <ListRow
          title={t('chatMenu.groupInfo')}
          leftIcon="users"
          onPress={() => {
            void trasElMenu().then(verElGrupo);
          }}
        />
        {puedeCrearTemas && listaDeTemas.length < MAX_TEMAS_POR_GRUPO ? (
          <ListRow title={t('groupTopics.newTopic')} leftIcon="folder-plus" onPress={() => void abrirHoja('tema')} />
        ) : null}
        {puedeCrearComunidades ? (
          <ListRow title={t('groupCommunities.new')} leftIcon="layers" onPress={() => void abrirHoja('comunidad')} />
        ) : null}
        {info && !puedoAdministrar ? (
          <ListRow
            title={t('groups.leave')}
            leftIcon="log-out"
            destructive
            onPress={() => void salirDelGrupo()}
          />
        ) : null}
      </BottomSheet>

      <HojaNuevoTema
        visible={hoja === 'tema'}
        grupoId={grupoId}
        existentes={listaDeTemas.map((tema) => tema.nombre)}
        textoDelFallo={textoDelFallo}
        onClose={() => setHoja(null)}
        alCrear={(nombre) => {
          setHoja(null);
          // El aviso de éxito va DESPUÉS de cerrar la hoja.
          void afterSheetClose().then(() => trasCrear(t('groupTopics.created', { nombre })));
        }}
      />

      <HojaNuevaComunidad
        visible={hoja === 'comunidad'}
        grupoId={grupoId}
        existentes={listaDeComunidades.map((comunidad) => comunidad.titulo)}
        textoDelFallo={textoDelFallo}
        onClose={() => setHoja(null)}
        alCrear={(nombre) => {
          setHoja(null);
          void afterSheetClose().then(() => trasCrear(t('groupCommunities.created', { nombre })));
        }}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Las filas
// ---------------------------------------------------------------------------

/** El círculo de la izquierda de una fila: el icono de lo que es. */
function Circulo({
  icono,
  discontinuo = false,
}: {
  icono: keyof typeof Feather.glyphMap;
  discontinuo?: boolean;
}) {
  const { colors } = useAppTheme();
  return (
    <View
      style={[
        styles.circulo,
        discontinuo
          ? { borderStyle: 'dashed', borderColor: colors.textMuted, backgroundColor: 'transparent' }
          : { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
      ]}
    >
      <Feather name={icono} size={20} color={colors.text} />
    </View>
  );
}

/**
 * Una fila de la lista: General, un tema o una comunidad de la que se es
 * miembro. Se lee como la de la bandeja: lo no leído en negrita y con su
 * globo, nunca solo con color.
 */
function FilaDeLaLista({
  icono,
  titulo,
  resumen,
  hora,
  cuenta,
  etiqueta,
  alPulsar,
  soloLectura = false,
  avatar,
}: {
  icono?: keyof typeof Feather.glyphMap;
  titulo: string;
  resumen: string;
  hora: string;
  cuenta: number;
  etiqueta: string;
  alPulsar: () => void;
  /** Un tema: lleva el candado, porque ahí no se escribe. */
  soloLectura?: boolean;
  /** Una comunidad: su foto o sus iniciales en vez de un icono. */
  avatar?: React.ReactNode;
}) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const sinLeer = cuenta > 0;
  return (
    <Pulsable
      onPress={alPulsar}
      escala={0.985}
      atenuar={0.72}
      accessibilityRole="button"
      accessibilityLabel={etiqueta}
      style={styles.fila}
    >
      {avatar ?? <Circulo icono={icono ?? 'folder'} />}
      <View style={styles.centro}>
        <View style={styles.lineaDeNombre}>
          <Text
            numberOfLines={1}
            weight={sinLeer ? '800' : '600'}
            color={colors.text}
            style={styles.nombre}
          >
            {titulo}
          </Text>
          {soloLectura ? (
            <Feather
              name="lock"
              size={12}
              color={colors.textMuted}
              accessibilityLabel={t('groupTopics.readOnly')}
            />
          ) : null}
        </View>
        <View style={styles.lineaDeResumen}>
          <Text
            numberOfLines={1}
            weight={sinLeer ? '700' : '400'}
            color={sinLeer ? colors.text : colors.textMuted}
            style={styles.resumen}
          >
            {resumen}
          </Text>
          {hora ? (
            <Text numberOfLines={1} color={colors.textMuted} style={styles.hora}>
              {` · ${hora}`}
            </Text>
          ) : null}
        </View>
      </View>
      <GloboDeNoLeidos cuenta={cuenta} />
    </Pulsable>
  );
}

/** «+ Nuevo tema», «+ Crear comunidad»: solo para quien administra. */
function FilaParaCrear({ titulo, alPulsar }: { titulo: string; alPulsar: () => void }) {
  return (
    <Pulsable
      onPress={alPulsar}
      escala={0.985}
      atenuar={0.72}
      accessibilityRole="button"
      accessibilityLabel={titulo}
      style={styles.fila}
    >
      <Circulo icono="plus" discontinuo />
      <Text weight="600" style={styles.nombre}>
        {titulo}
      </Text>
    </Pulsable>
  );
}

/**
 * Una comunidad. Si se es miembro, la fila abre su chat; si no, dice cómo se
 * entra y lleva SU botón —uno solo, el que toca (`accionDeComunidad`)—.
 *
 * LOS BOTONES VAN AL LADO DE LA FILA, NUNCA DENTRO: en la web cada pulsable es
 * un `<button>` y uno dentro de otro rompe la página.
 */
function FilaDeComunidad({
  comunidad,
  ocupada,
  vistaPrevia,
  hora,
  alAbrir,
  alUnirme,
  alPedir,
  alRetirar,
  alVerSolicitudes,
}: {
  comunidad: ComunidadDeGrupo;
  ocupada: boolean;
  vistaPrevia: (ultimo: UltimoMensaje) => string;
  hora: string;
  alAbrir: () => void;
  alUnirme: () => void;
  alPedir: () => void;
  alRetirar: () => void;
  alVerSolicitudes: () => void;
}) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const accion = accionDeComunidad(comunidad);
  const foto = (
    <Avatar size={46} image={profileImageUrl(comunidad.avatarPath) ?? null} name={comunidad.titulo} />
  );
  const solicitudes =
    comunidad.solicitudes > 0 ? (
      <Chip
        rol="button"
        label={
          comunidad.solicitudes === 1
            ? t('groupCommunities.requestsOne')
            : t('groupCommunities.requestsMany', { n: comunidad.solicitudes })
        }
        icon="user-plus"
        onPress={alVerSolicitudes}
      />
    ) : null;

  if (accion === 'abrir') {
    const detalle = comunidad.ultimo
      ? vistaPrevia(comunidad.ultimo)
      : t('groupCommunities.noMessages');
    return (
      <View style={styles.filaConBoton}>
        <View style={styles.flexible}>
          <FilaDeLaLista
            avatar={foto}
            titulo={comunidad.titulo}
            resumen={detalle}
            hora={hora}
            cuenta={comunidad.sinLeer}
            etiqueta={t('groupCommunities.rowLabel', { nombre: comunidad.titulo, detalle })}
            alPulsar={alAbrir}
          />
        </View>
        {solicitudes}
      </View>
    );
  }

  const entrada: EntradaDeComunidad = comunidad.entrada;
  const meta = [
    comunidad.solicitudPendiente ? t('groupCommunities.requestSent') : null,
    t('groups.membersCount', { n: comunidad.miembros }),
    entrada === 'open' ? t('groupCommunities.open') : t('groupCommunities.byRequest'),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <View style={[styles.fila, styles.filaConBoton]}>
      {foto}
      <View style={styles.centro}>
        <View style={styles.lineaDeNombre}>
          <Text numberOfLines={1} weight="600" style={styles.nombre}>
            {comunidad.titulo}
          </Text>
          {entrada === 'request' ? (
            // El candado dice «con solicitud»; también lo dice el texto de abajo.
            <Feather
              name="lock"
              size={12}
              color={colors.textMuted}
              accessibilityLabel={t('groupCommunities.byRequest')}
            />
          ) : null}
        </View>
        <Text numberOfLines={2} color={colors.textMuted} style={styles.meta}>
          {meta}
        </Text>
      </View>
      {accion === 'unirme' ? (
        <Chip rol="button" selected label={t('groupCommunities.join')} onPress={alUnirme} disabled={ocupada} />
      ) : accion === 'pedir' ? (
        <Chip rol="button" selected label={t('groupJoin.ask')} onPress={alPedir} disabled={ocupada} />
      ) : (
        <Chip rol="button" label={t('groupCommunities.withdraw')} onPress={alRetirar} disabled={ocupada} />
      )}
      {solicitudes}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Las hojas de crear
// ---------------------------------------------------------------------------

/**
 * «Nuevo tema». Solo el nombre, como en el diseño aprobado: el icono queda en
 * la carpeta de siempre y el tema se llena desde General o escribiendo en él.
 *
 * LOS ERRORES VAN DENTRO DE LA HOJA (`InlineError`): un diálogo encima de un
 * `Modal` no se ve en iOS.
 */
function HojaNuevoTema({
  visible,
  grupoId,
  existentes,
  textoDelFallo,
  onClose,
  alCrear,
}: {
  visible: boolean;
  grupoId: string;
  existentes: string[];
  textoDelFallo: (error: unknown) => string;
  onClose: () => void;
  alCrear: (nombre: string) => void;
}) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [nombre, setNombre] = useState('');
  const [fallo, setFallo] = useState<string | null>(null);
  const [creando, setCreando] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setNombre('');
    setFallo(null);
  }, [visible]);

  const crear = async () => {
    if (creando) return;
    const juicio = juzgarNombreDeTema(nombre, existentes);
    if (juicio !== 'vale') {
      setFallo(
        t(
          juicio === 'vacio'
            ? 'groupTopics.errorNameEmpty'
            : juicio === 'largo'
              ? 'groupTopics.errorNameLong'
              : 'groupTopics.errorNameTaken',
        ),
      );
      return;
    }
    setCreando(true);
    setFallo(null);
    try {
      const limpio = limpiarNombre(nombre);
      const creado = await TemasRepository.crear(grupoId, limpio);
      alCrear(creado?.nombre ?? limpio);
    } catch (error) {
      setFallo(textoDelFallo(error));
    } finally {
      setCreando(false);
    }
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View style={styles.hoja}>
        <Text weight="800" style={styles.hojaTitulo}>
          {t('groupTopics.newTopic')}
        </Text>
        <Text color={colors.textMuted} style={styles.hojaAyuda}>
          {t('groupTopics.newTopicHelp')}
        </Text>
        <Input
          label={t('groupTopics.nameLabel')}
          value={nombre}
          onChangeText={(texto) => {
            setNombre(texto);
            setFallo(null);
          }}
          placeholder={t('groupTopics.namePlaceholder')}
          maxLength={MAX_NOMBRE_DE_TEMA}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={() => void crear()}
        />
        <InlineError message={fallo} />
        <Button label={t('groupTopics.create')} onPress={() => void crear()} loading={creando} disabled={creando} />
      </View>
    </BottomSheet>
  );
}

/** «Crear comunidad»: el nombre y cómo se entra (D2). */
function HojaNuevaComunidad({
  visible,
  grupoId,
  existentes,
  textoDelFallo,
  onClose,
  alCrear,
}: {
  visible: boolean;
  grupoId: string;
  existentes: string[];
  textoDelFallo: (error: unknown) => string;
  onClose: () => void;
  alCrear: (nombre: string) => void;
}) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [nombre, setNombre] = useState('');
  const [entrada, setEntrada] = useState<EntradaDeComunidad>('open');
  const [fallo, setFallo] = useState<string | null>(null);
  const [creando, setCreando] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setNombre('');
    setEntrada('open');
    setFallo(null);
  }, [visible]);

  const crear = async () => {
    if (creando) return;
    const juicio = juzgarTituloDeComunidad(nombre, existentes);
    if (juicio !== 'vale') {
      setFallo(
        t(
          juicio === 'vacio'
            ? 'groupCommunities.errorNameEmpty'
            : juicio === 'largo'
              ? 'groupCommunities.errorNameLong'
              : 'groupCommunities.errorNameTaken',
        ),
      );
      return;
    }
    setCreando(true);
    setFallo(null);
    try {
      const limpio = limpiarNombre(nombre);
      const creada = await ComunidadesRepository.crear(grupoId, { titulo: limpio, entrada });
      alCrear(creada?.titulo ?? limpio);
    } catch (error) {
      setFallo(textoDelFallo(error));
    } finally {
      setCreando(false);
    }
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View style={styles.hoja}>
        <Text weight="800" style={styles.hojaTitulo}>
          {t('groupCommunities.new')}
        </Text>
        <Input
          label={t('groupTopics.nameLabel')}
          value={nombre}
          onChangeText={(texto) => {
            setNombre(texto);
            setFallo(null);
          }}
          placeholder={t('groupCommunities.namePlaceholder')}
          maxLength={MAX_TITULO_DE_COMUNIDAD}
          autoFocus
          returnKeyType="done"
        />
        <Text weight="700" style={styles.etiquetaDeCampo}>
          {t('groupCommunities.entryLabel')}
        </Text>
        <View style={styles.opciones} accessibilityRole="radiogroup">
          <Chip
            rol="radio"
            label={t('groupCommunities.open')}
            selected={entrada === 'open'}
            onPress={() => setEntrada('open')}
          />
          <Chip
            rol="radio"
            label={t('groupCommunities.byRequest')}
            icon="lock"
            selected={entrada === 'request'}
            onPress={() => setEntrada('request')}
          />
        </View>
        <Text color={colors.textMuted} style={styles.hojaAyuda}>
          {t(entrada === 'open' ? 'groupCommunities.entryOpenHelp' : 'groupCommunities.entryRequestHelp')}
        </Text>
        <InlineError message={fallo} />
        <Button label={t('groupCommunities.new')} onPress={() => void crear()} loading={creando} disabled={creando} />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  cabecera: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minWidth: 0,
    flexShrink: 1,
  },
  cabeceraTextos: { minWidth: 0, flexShrink: 1 },
  cabeceraTitulo: { fontSize: 15 },
  cabeceraSubtitulo: { fontSize: 11 },
  contenido: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 10,
  },
  // La fila de una comunidad con botones al lado: la zona que abre el chat
  // ocupa lo que sobra y los botones no encogen.
  filaConBoton: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  flexible: { flex: 1, minWidth: 0 },
  circulo: {
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // `minWidth: 0` para que un nombre largo se recorte en vez de empujar el globo.
  centro: { flex: 1, minWidth: 0, gap: 2 },
  lineaDeNombre: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  nombre: { fontSize: 15, lineHeight: 20, flexShrink: 1 },
  lineaDeResumen: { flexDirection: 'row', alignItems: 'center' },
  resumen: { fontSize: 14, lineHeight: 19, flexShrink: 1 },
  hora: { fontSize: 14, lineHeight: 19 },
  meta: { fontSize: 13, lineHeight: 18 },
  bloque: { fontSize: 13, marginTop: 18, marginBottom: 2 },
  fallo: { gap: spacing.sm, marginVertical: spacing.sm },
  hoja: { gap: spacing.md, paddingBottom: spacing.sm },
  hojaTitulo: { fontSize: 20, lineHeight: 24 },
  hojaAyuda: { fontSize: 13, lineHeight: 18 },
  etiquetaDeCampo: { fontSize: 13 },
  opciones: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
});
