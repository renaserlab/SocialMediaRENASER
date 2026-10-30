import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { FotoDelGrupo } from '@/components/chat/FotoDelGrupo';
import { PestanasDeContenido } from '@/components/chat/PestanasDeContenido';
import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
import { ListRow } from '@/components/ListRow';
import { SelectorDePersonas } from '@/components/SelectorDePersonas';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { alCambiarElSilencioDeUnChat } from '@/hooks/useAvisosEnVivo';
import { useDisponibilidadDeTemas } from '@/hooks/useDisponibilidadDeTemas';
import { useFuncionesDelChat } from '@/hooks/useFuncionesDelChat';
import { useInfoDeConversacion } from '@/hooks/useInfoDeConversacion';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { confirm } from '@/lib/confirm';
import {
  MAX_PERSONAS_POR_TANDA,
  claveDelFalloDeGrupo,
  type MiembroDeGrupo,
} from '@/lib/gruposDeChat';
import { irAlPerfil } from '@/lib/irAlPerfil';
import { toast } from '@/lib/toast';
import { ComunidadesRepository } from '@/repositories/ComunidadesRepository';
import { GroupRepository } from '@/repositories/GroupRepository';
import { MessageRepository } from '@/repositories/MessageRepository';
import { ApiError } from '@/services/api';
import { profileImageUrl } from '@/services/storage';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { PersonaEtiquetada } from '@/types';

/**
 * Un grupo por dentro, como la ficha de cualquier mensajería: su foto y su
 * nombre, tres acciones a mano —escribir, silenciar, salir— y, debajo, sus
 * pestañas: «Miembros» y lo que se ha compartido («Media», «Enlaces»,
 * «Archivos», «Audios» y los filtros del grupo).
 *
 * LO QUE SE ENSEÑA DEPENDE DE QUIÉN MIRA, PERO EL PERMISO ES DEL SERVIDOR.
 * Quien administra ve además el lápiz —nombre, enlace, filtros—, añadir y
 * sacar gente; los demás, «Salir». Esconder un botón es comodidad: cada
 * cambio se vuelve a comprobar al llegar a la API.
 *
 * NUNCA UN BOTÓN MUERTO. «Silenciar» solo se ofrece si el servidor sabe
 * silenciar, y cada pestaña de contenido, solo si tiene algo dentro.
 */
export function GrupoScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const conversationId = typeof params.id === 'string' ? params.id : '';
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const currentUserId = useAppStore((state) => state.user?.id ?? null);

  const activo = supabaseEnabled && !!conversationId;
  const { info, refrescar } = useInfoDeConversacion(conversationId, currentUserId, activo);
  const funciones = useFuncionesDelChat(activo);
  const disponibilidadDeTemas = useDisponibilidadDeTemas(activo);

  const [nuevas, setNuevas] = useState<PersonaEtiquetada[]>([]);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);
  // Lo que se acaba de pulsar manda sobre lo último leído hasta que el
  // servidor lo confirme: el botón no puede tardar una vuelta de red en cambiar.
  const [silenciada, setSilenciada] = useState<boolean | null>(null);
  const estaSilenciada = silenciada ?? info?.silenciada ?? false;
  useEffect(() => {
    setSilenciada(null);
  }, [info?.silenciada]);

  // Al volver de editar el grupo o de sus filtros, la ficha está al día.
  const yaTuvoElFoco = React.useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (yaTuvoElFoco.current) refrescar();
      yaTuvoElFoco.current = true;
    }, [refrescar]),
  );

  /*
    EN PANTALLA, EL DE PRIMER NIVEL ES UNA «COMUNIDAD» Y EL DE DENTRO UN
    «GRUPO» (30/10/2026). Los textos que lo nombran se eligen con `padre`,
    como ya hacían salir y eliminar. Mientras no se sabe —cargando, o si no
    se pudo leer— se dice «comunidad», que es lo que son casi todos.
  */
  const deDentro = !!info?.padre;

  /** Hace una cosa a la vez, y cuenta el rechazo con el texto que le toca. */
  const hacer = useCallback(
    async (clave: string, tarea: () => Promise<unknown>): Promise<boolean> => {
      if (ocupado) return false;
      setOcupado(clave);
      setFallo(null);
      try {
        await tarea();
        return true;
      } catch (error) {
        const codigo = error instanceof ApiError ? error.code : null;
        setFallo(t(claveDelFalloDeGrupo(codigo, deDentro) as TranslationKey));
        return false;
      } finally {
        setOcupado(null);
      }
    },
    [ocupado, t, deDentro],
  );

  const anadir = useCallback(async () => {
    if (nuevas.length === 0) return;
    const ids = nuevas.map((persona) => persona.id);
    if (await hacer('anadir', () => GroupRepository.anadir(conversationId, ids))) {
      setNuevas([]);
      toast(t('groups.added'));
      refrescar();
    }
  }, [nuevas, hacer, conversationId, t, refrescar]);

  const sacar = useCallback(
    async (miembro: MiembroDeGrupo) => {
      const seguro = await confirm({
        title: t(deDentro ? 'groupCommunities.removeTitle' : 'groups.removeTitle', {
          nombre: miembro.nombre,
        }),
        message: t(deDentro ? 'groupCommunities.removeBody' : 'groups.removeBody'),
        confirmLabel: t('groups.remove'),
        destructive: true,
      });
      if (!seguro) return;
      if (await hacer(`sacar:${miembro.id}`, () => GroupRepository.quitar(conversationId, miembro.id))) {
        refrescar();
      }
    },
    [hacer, conversationId, t, refrescar, deDentro],
  );

  const salir = useCallback(async () => {
    if (!currentUserId) return;
    // De una comunidad se sale sin salir de su grupo, y se dice así.
    const delPadre = info?.padre ?? null;
    const seguro = await confirm({
      title: t(delPadre ? 'groupCommunities.leaveTitle' : 'groups.leaveTitle'),
      message: t(delPadre ? 'groupCommunities.leaveBody' : 'groups.leaveBody'),
      confirmLabel: t(delPadre ? 'groupCommunities.leave' : 'groups.leave'),
      destructive: true,
    });
    if (!seguro) return;
    if (await hacer('salir', () => GroupRepository.quitar(conversationId, currentUserId))) {
      // Ya no se pertenece: ni al chat ni a esta pantalla se puede volver. De
      // una comunidad se vuelve a la lista de su grupo, donde se sigue.
      if (delPadre) {
        router.dismissTo({ pathname: '/chat/lista/[id]' as never, params: { id: delPadre.id } });
        return;
      }
      router.replace('/messages' as never);
    }
  }, [currentUserId, hacer, conversationId, router, t, info?.padre]);

  const alternarSilencio = useCallback(async () => {
    const quiere = !estaSilenciada;
    setSilenciada(quiere);
    if (await hacer('silencio', () => MessageRepository.silenciar(conversationId, quiere))) {
      toast(t(quiere ? 'chatMenu.muted' : 'chatMenu.unmuted'));
      refrescar();
      alCambiarElSilencioDeUnChat();
    } else {
      setSilenciada(null);
    }
  }, [estaSilenciada, hacer, conversationId, t, refrescar]);

  /*
    UNA COMUNIDAD (D5): quien administra puede eliminarla, por si se creó por
    error. Se pregunta antes y se dice qué pasa: sale para todos y se quitan
    sus miembros. Después se vuelve a la lista del grupo, que sigue ahí.
  */
  const padre = info?.padre ?? null;
  const irALaListaDelPadre = useCallback(() => {
    if (!padre) return;
    router.dismissTo({ pathname: '/chat/lista/[id]' as never, params: { id: padre.id } });
  }, [padre, router]);

  const eliminarComunidad = useCallback(async () => {
    if (!padre) return;
    const seguro = await confirm({
      title: t('groupCommunities.deleteTitle'),
      message: t('groupCommunities.deleteBody'),
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!seguro) return;
    if (await hacer('eliminar', () => ComunidadesRepository.eliminar(padre.id, conversationId))) {
      toast(t('groupCommunities.deleted'));
      irALaListaDelPadre();
    }
  }, [padre, t, hacer, conversationId, irALaListaDelPadre]);

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const tituloDeLaFicha = t(deDentro ? 'groupCommunities.infoTitle' : 'groups.infoTitle');

  if (info === undefined) {
    return (
      <AppScreen scroll={false}>
        <AppHeader title={tituloDeLaFicha} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }
  if (info === null || !info.esGrupo) {
    return (
      <AppScreen scroll={false}>
        <AppHeader title={tituloDeLaFicha} onBack={volver} />
        <StateView
          state="error"
          title={t('groups.loadError')}
          onRetry={refrescar}
        />
      </AppScreen>
    );
  }

  const cabenMas = info.miembros.length < info.maximoDeMiembros;
  const abrirAjustes = () =>
    router.push({ pathname: '/chat/ajustes-de-grupo/[id]' as never, params: { id: conversationId } });
  // Al chat que está debajo; si se llegó aquí sin él (por un aviso), se abre.
  const irAlChat = () =>
    router.dismissTo({ pathname: '/chat/[id]', params: { id: conversationId, name: info.titulo } });

  const acciones: {
    clave: string;
    icono: keyof typeof Feather.glyphMap;
    etiqueta: string;
    alPulsar: () => void;
    peligro?: boolean;
  }[] = [
    { clave: 'mensaje', icono: 'message-circle', etiqueta: t('groups.actionMessage'), alPulsar: irAlChat },
    ...(funciones.preferencias
      ? [
          {
            clave: 'silencio',
            icono: (estaSilenciada ? 'bell' : 'bell-off') as keyof typeof Feather.glyphMap,
            etiqueta: t(estaSilenciada ? 'chatMenu.unmute' : 'chatMenu.mute'),
            alPulsar: () => void alternarSilencio(),
          },
        ]
      : []),
    // Quien administra no puede salir —el grupo quedaría sin nadie que lo
    // lleve—: en su sitio tiene «Editar».
    info.puedoAdministrar
      ? { clave: 'editar', icono: 'edit-2', etiqueta: t('groups.actionEdit'), alPulsar: abrirAjustes }
      : {
          clave: 'salir',
          icono: 'log-out',
          etiqueta: t('groups.actionLeave'),
          alPulsar: () => void salir(),
          peligro: true,
        },
  ];

  const cabecera = (
    <View style={styles.cabecera}>
      {/* Para quien administra, la foto es también el botón de cambiarla. */}
      <FotoDelGrupo info={info} alCambiar={refrescar} alFallar={setFallo} />
      <Text weight="800" style={styles.titulo} numberOfLines={2}>
        {info.titulo}
      </Text>
      <Text color={colors.textMuted}>{t('groups.membersCount', { n: info.miembros.length })}</Text>

      <View style={styles.acciones}>
        {acciones.map((accion) => (
          <Pressable
            key={accion.clave}
            onPress={accion.alPulsar}
            disabled={!!ocupado}
            accessibilityRole="button"
            accessibilityLabel={accion.etiqueta}
            style={[styles.accion, { backgroundColor: colors.surfaceAlt }]}
          >
            <Feather
              name={accion.icono}
              size={20}
              color={accion.peligro ? colors.danger : colors.text}
            />
            <Text
              weight="600"
              numberOfLines={1}
              color={accion.peligro ? colors.danger : colors.text}
              style={styles.accionTexto}
            >
              {accion.etiqueta}
            </Text>
          </Pressable>
        ))}
      </View>

      {fallo ? <InlineError message={fallo} /> : null}

      {/* Una comunidad dice de qué grupo es, y lleva a su lista. */}
      {padre ? (
        <View style={[styles.tarjeta, { borderColor: colors.border }]}>
          <ListRow
            // El padre siempre es de primer nivel: sin nombre, «Comunidad».
            title={t('groupCommunities.ofGroup', { nombre: padre.titulo || t('groups.infoTitle') })}
            subtitle={t('groupCommunities.ofGroupHint')}
            leftIcon="layers"
            rightIcon="chevron-right"
            onPress={irALaListaDelPadre}
          />
        </View>
      ) : null}

      {/* A quien administra se le dice que hay alguien esperando: se responde
          en «Editar», donde están el enlace y las solicitudes. */}
      {info.puedoAdministrar && info.pendientes > 0 ? (
        <View style={[styles.tarjeta, { borderColor: colors.border }]}>
          <ListRow
            title={t('groupJoin.requestsTitle', { n: info.pendientes })}
            subtitle={t('groupJoin.requestsHint')}
            leftIcon="user-plus"
            rightIcon="chevron-right"
            onPress={abrirAjustes}
          />
        </View>
      ) : null}

      {padre && info.puedoAdministrar ? (
        <View style={[styles.tarjeta, { borderColor: colors.border }]}>
          <ListRow
            title={t('groupCommunities.delete')}
            leftIcon="trash-2"
            destructive
            onPress={() => void eliminarComunidad()}
          />
        </View>
      ) : null}
    </View>
  );

  const miembros = (
    <View style={styles.miembros}>
      {info.puedoAdministrar ? (
        <View style={styles.seccion}>
          {cabenMas ? (
            <>
              <SelectorDePersonas
                seleccionadas={nuevas}
                alCambiar={setNuevas}
                maximo={Math.min(
                  MAX_PERSONAS_POR_TANDA,
                  info.maximoDeMiembros - info.miembros.length,
                )}
                titulo={t('groups.addPeople')}
                ayuda={t('groups.peopleHint')}
              />
              {nuevas.length > 0 ? (
                <Button
                  label={t('groups.addSelected', { n: nuevas.length })}
                  icon="user-plus"
                  onPress={() => void anadir()}
                  loading={ocupado === 'anadir'}
                  disabled={!!ocupado}
                />
              ) : null}
            </>
          ) : (
            <>
              <Text weight="700">{t('groups.addPeople')}</Text>
              <Text color={colors.textMuted} style={styles.detalle}>
                {t(deDentro ? 'groupCommunities.errorFull' : 'groups.errorFull')}
              </Text>
            </>
          )}
        </View>
      ) : null}

      <View style={styles.seccion}>
        {info.miembros.map((miembro) => {
          const soyYo = miembro.id === currentUserId;
          return (
            <View key={miembro.id} style={styles.miembro}>
              <Pressable
                onPress={() => irAlPerfil(router, miembro.id)}
                accessibilityRole="button"
                accessibilityLabel={t('chat.openProfile', { nombre: miembro.nombre })}
                style={styles.persona}
              >
                <Avatar
                  size={44}
                  image={profileImageUrl(miembro.avatarPath) ?? null}
                  name={miembro.nombre}
                />
                <View style={styles.textos}>
                  <Text numberOfLines={1} weight="600">
                    {soyYo ? t('groups.youNamed', { nombre: miembro.nombre }) : miembro.nombre}
                  </Text>
                  {miembro.usuario ? (
                    <Text color={colors.textMuted} style={styles.detalle} numberOfLines={1}>
                      @{miembro.usuario}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
              {miembro.administra ? (
                <View style={[styles.insignia, { backgroundColor: colors.surfaceAlt }]}>
                  <Text weight="600" color={colors.textMuted} style={styles.insigniaTexto}>
                    {t('groups.adminBadge')}
                  </Text>
                </View>
              ) : info.puedoAdministrar ? (
                <Pressable
                  onPress={() => void sacar(miembro)}
                  disabled={!!ocupado}
                  accessibilityRole="button"
                  accessibilityLabel={t(
                    deDentro ? 'groupCommunities.removeTitle' : 'groups.removeTitle',
                    { nombre: miembro.nombre },
                  )}
                  hitSlop={8}
                  style={styles.sacar}
                >
                  <Feather name="user-minus" size={18} color={colors.danger} />
                </Pressable>
              ) : null}
            </View>
          );
        })}
      </View>
    </View>
  );

  return (
    <AppScreen scroll={false}>
      <AppHeader
        title={tituloDeLaFicha}
        onBack={volver}
        // Solo para quien administra. El permiso es del servidor; esto evita
        // pintar un botón que respondería 403.
        rightIcon={info.puedoAdministrar ? 'edit-2' : undefined}
        onRightPress={info.puedoAdministrar ? abrirAjustes : undefined}
        rightLabel={t('groups.actionEdit')}
      />
      <PestanasDeContenido
        conversationId={conversationId}
        nombreDelChat={info.titulo}
        cabecera={cabecera}
        primera={{ clave: 'miembros', etiqueta: t('groups.members'), contenido: miembros }}
        alRefrescar={refrescar}
        /*
          AUDIOS Y TEMAS (30/10/2026): en una comunidad de primer nivel con
          temas, su Contenido es el de General y se filtra por tema; quien
          administra elige varios y los agrega a un tema de una vez.
        */
        temasDelGrupo={
          disponibilidadDeTemas.temas && !info.padre && !info.tema
            ? { grupoId: conversationId, puedoAdministrar: info.puedoAdministrar }
            : null
        }
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  cabecera: {
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },
  titulo: { fontSize: 22, textAlign: 'center', marginTop: spacing.xs },
  acciones: {
    flexDirection: 'row',
    alignSelf: 'stretch',
    gap: spacing.sm,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  accion: {
    flex: 1,
    minHeight: 64,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: spacing.xs,
  },
  accionTexto: { fontSize: 13 },
  tarjeta: {
    alignSelf: 'stretch',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    overflow: 'hidden',
    marginTop: spacing.xs,
  },
  miembros: { paddingHorizontal: spacing.md, paddingTop: spacing.xs, gap: spacing.lg },
  seccion: { gap: spacing.md },
  miembro: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  persona: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: 0 },
  textos: { flex: 1, minWidth: 0 },
  detalle: { fontSize: 13 },
  insignia: { paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.pill },
  insigniaTexto: { fontSize: 12 },
  sacar: { padding: spacing.xs },
});
