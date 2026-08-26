import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { Input } from '@/components/Input';
import { SignedOutNotice } from '@/components/SignedOutNotice';
import { StateView } from '@/components/StateView';
import { assets } from '@/data/assets';
import {
  CONVERSACIONES_POR_PAGINA,
  MessageRepository,
} from '@/repositories/MessageRepository';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Conversation } from '@/types';

export function MessagesScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const signedIn = useAuthStore((state) => state.status === 'authenticated');
  const demoConversations = useAppStore((state) => state.conversations);

  const [searchText, setSearchText] = useState('');
  const [remote, setRemote] = useState<Conversation[]>([]);
  const [status, setStatus] = useState<'loading' | 'idle' | 'error'>('loading');
  const [refreshing, setRefreshing] = useState(false);
  // Si queda algo por debajo, y si se esta trayendo ahora mismo.
  const [hayMas, setHayMas] = useState(true);
  const [cargandoMas, setCargandoMas] = useState(false);

  /*
    Lo que hay pintado, accesible desde los callbacks sin volver a crearlos.

    `onEndReached` se dispara mientras alguien baja; si dependiera del estado,
    cada carga cambiaria la funcion y la lista la volveria a montar en mitad del
    desplazamiento.
  */
  const conversacionesRef = useRef<Conversation[]>([]);
  conversacionesRef.current = remote;

  /**
   * Trae la primera pagina.
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
      if (!silencioso || conversacionesRef.current.length === 0) setStatus('loading');
      return MessageRepository.listConversations()
        .then((data) => {
          setRemote(data);
          setHayMas(data.length >= CONVERSACIONES_POR_PAGINA);
          setStatus('idle');
        })
        .catch(() => {
          // Un refresco silencioso que falla NO borra lo que se esta leyendo:
          // sustituir una lista buena por una pantalla de error porque se cayo
          // la red un segundo es peor que no refrescar.
          if (silencioso && conversacionesRef.current.length > 0) return;
          setStatus('error');
        });
    },
    [supabaseEnabled, signedIn],
  );

  /** La pagina siguiente, al llegar al final de la lista. */
  const cargarMas = useCallback(() => {
    if (!supabaseEnabled || !signedIn) return;
    if (cargandoMas || !hayMas || status === 'loading') return;

    setCargandoMas(true);
    MessageRepository.listConversations({ offset: conversacionesRef.current.length })
      .then((mas) => {
        if (mas.length === 0) {
          // Sin esto, cada rebote al final de la lista lanzaria otra peticion
          // para recibir siempre lo mismo.
          setHayMas(false);
          return;
        }
        setRemote((previas) => {
          // Por identificador y no concatenando a secas: entre una pagina y la
          // siguiente puede entrar un mensaje que reordene la lista, y entonces
          // una conversacion sale en las dos paginas.
          const vistas = new Set(previas.map((c) => c.id));
          return [...previas, ...mas.filter((c) => !vistas.has(c.id))];
        });
        setHayMas(mas.length >= CONVERSACIONES_POR_PAGINA);
      })
      .catch(() => {
        // Lo ya cargado se queda; se puede volver a intentar bajando otra vez.
      })
      .finally(() => setCargandoMas(false));
  }, [supabaseEnabled, signedIn, cargandoMas, hayMas, status]);

  useFocusEffect(
    useCallback(() => {
      void load(true);
    }, [load]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    // Se espera de verdad: antes se apagaba el indicador en la misma vuelta,
    // asi que el gesto de estirar no llegaba a verse.
    void load(true).finally(() => setRefreshing(false));
  }, [load]);

  const conversations = supabaseEnabled ? remote : demoConversations;

  const filteredConversations = conversations.filter((conv) =>
    conv.name.toLowerCase().includes(searchText.toLowerCase()) ||
    conv.subtitle.toLowerCase().includes(searchText.toLowerCase())
  );

  const hasMessages = filteredConversations.length > 0;
  const uiState = supabaseEnabled && status === 'loading'
    ? 'loading'
    : supabaseEnabled && status === 'error'
    ? 'error'
    : hasMessages
    ? 'content'
    : 'empty';

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title="MENSAJES"
        rightIcon={signedIn ? 'edit' : undefined}
        onRightPress={() => {}}
      />
      {supabaseEnabled && !signedIn ? (
        <SignedOutNotice
          icon="message-square"
          title="Tus mensajes te esperan"
          description="Crea tu cuenta para escribir a otras personas y recibir sus respuestas."
        />
      ) : (
      <FlashList
        data={uiState === 'content' ? filteredConversations : []}
        keyExtractor={(item: Conversation) => item.id}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text} colors={[colors.text]} />
        }
        ListHeaderComponent={
          <View style={styles.searchWrapper}>
            <Input
              placeholder="Buscar mensajes..."
              value={searchText}
              onChangeText={setSearchText}
              placeholderTextColor={colors.textMuted}
              // Deja hueco para la lupa: sin esto el texto arranca debajo de ella.
              style={styles.searchInput}
            />
            <View style={styles.searchIcon} pointerEvents="none">
              <Feather name="search" size={18} color={colors.textMuted} />
            </View>
          </View>
        }
        // La busqueda filtra lo que YA se ha traido, asi que paginar mientras
        // se busca daria la sensacion de que la lista se completa sola. Solo se
        // pide mas cuando se esta viendo la lista entera.
        onEndReached={searchText ? undefined : cargarMas}
        onEndReachedThreshold={0.6}
        ListFooterComponent={
          cargandoMas ? (
            <View style={styles.cargandoMas}>
              <ActivityIndicator size="small" color={colors.textMuted} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          <StateView
            state={uiState}
            onRetry={() => void load()}
            title={uiState === 'empty' ? 'No hay conversaciones' : undefined}
            description={
              uiState === 'empty'
                ? 'Inicia un chat desde el perfil de alguien.'
                : undefined
            }
            icon="message-square"
          />
        }
        renderItem={({ item: conversation }: { item: Conversation }) => (
              <Pressable
                onPress={() =>
                  router.push({
                    pathname: '/chat/[id]',
                    params: { id: conversation.id, name: conversation.name },
                  })
                }
                accessibilityRole="button"
                accessibilityLabel={`Chat con ${conversation.name}. ${conversation.subtitle}`}
                style={({ pressed }) => [
                  styles.row,
                  { borderBottomColor: colors.border, opacity: pressed ? 0.78 : 1 },
                ]}
              >
                {/*
                  La foto real de la otra persona. Antes se elegia una imagen
                  de muestra segun la POSICION de la fila (la primera una, la
                  segunda otra...), asi que no correspondia con nadie: quien
                  tenia foto salia con la de otro.
                */}
                <Image
                  source={conversation.avatarUrl ? { uri: conversation.avatarUrl } : assets.avatar}
                  style={styles.avatar}
                />
                <View style={{ flex: 1 }}>
                  <View style={styles.nameRow}>
                    <Text style={[styles.name, { color: colors.text }]}>{conversation.name}</Text>
                    <Text style={[styles.time, { color: colors.textMuted }]}>
                      {conversation.time ?? conversation.messages.at(-1)?.createdAt}
                    </Text>
                  </View>
                  <Text numberOfLines={1} style={[styles.subtitle, { color: colors.textMuted }]}>
                    {conversation.subtitle}
                  </Text>
                </View>
                {conversation.unread > 0 ? (
                  <View style={[styles.badge, { backgroundColor: colors.primary }]}>
                    <Text style={{ color: colors.onPrimary, fontSize: 10, fontWeight: '700' }}>
                      {conversation.unread}
                    </Text>
                  </View>
                ) : null}
              </Pressable>
        )}
      />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  listContent: { paddingHorizontal: spacing.lg, paddingBottom: 120 },
  cargandoMas: { paddingVertical: spacing.lg, alignItems: 'center' },
  searchWrapper: {
    position: 'relative',
    marginBottom: spacing.md,
  },
  // El texto ya empieza en el margen del campo, donde tambien esta la lupa; se
  // desplaza el ancho del icono (18) mas un respiro (8) para que no se pisen.
  searchInput: {
    paddingLeft: 18 + spacing.sm,
  },
  // top/bottom a 0 centra la lupa verticalmente sea cual sea el alto del campo,
  // sin depender de un desplazamiento fijo que se descuadra si cambia la fuente.
  searchIcon: {
    position: 'absolute',
    left: spacing.md,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.lg, borderBottomWidth: 1 },
  avatar: { width: 48, height: 48, borderRadius: 24, borderWidth: 1, borderColor: '#DDD' },
  nameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  name: { fontSize: 14, fontWeight: '800' },
  time: { fontSize: 10 },
  subtitle: { fontSize: 12, marginTop: 4 },
  badge: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
