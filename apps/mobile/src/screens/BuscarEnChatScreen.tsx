import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Avatar } from '@/components/Avatar';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { useMensajesDeVista } from '@/hooks/useMensajesDeVista';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { pedirSalto } from '@/lib/saltoDeChat';
import { MAX_BUSQUEDA_EN_VISTA, VISTA_TODO } from '@/lib/vistasDeChat';
import type { MensajeDeVista } from '@/repositories/MessageRepository';
import { useAppStore } from '@/store/useAppStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/** Cuánto se espera tras la última tecla antes de preguntar al servidor. */
const ESPERA_AL_BUSCAR_MS = 350;
/** Con menos letras, casi todo coincide: no es una búsqueda. */
const MIN_LETRAS = 2;

const NOMBRE_DE_ADJUNTO: Record<string, TranslationKey> = {
  image: 'chat.replyPhoto',
  video: 'chat.replyVideo',
  audio: 'chat.replyAudio',
  document: 'chat.replyFile',
};

function fechaLegible(iso: string): string {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return '';
  const dia = fecha.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  const hora = fecha.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${dia} · ${hora}`;
}

/**
 * Buscar un mensaje DENTRO de un chat, por su texto o por el nombre de un
 * archivo.
 *
 * BUSCA EL SERVIDOR, en la conversación entera. Filtrar lo ya descargado solo
 * encontraría lo que hubiera tenido la suerte de estar en pantalla, y diría
 * «sin resultados» de un mensaje que está más arriba.
 *
 * TOCAR UN RESULTADO LLEVA AL MENSAJE, en su sitio del chat: se deja el
 * encargo y se vuelve a la conversación, que sube hasta él y lo resalta.
 *
 * Lo que la persona vació de este chat no aparece: tampoco se lo enseña el
 * historial.
 */
export function BuscarEnChatScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; name?: string }>();
  const conversationId = typeof params.id === 'string' ? params.id : '';
  const nombre = typeof params.name === 'string' && params.name ? params.name : undefined;
  const currentUserId = useAppStore((state) => state.user?.id ?? null);

  const [escrito, setEscrito] = useState('');
  const [buscar, setBuscar] = useState('');

  // Se pregunta al servidor cuando se deja de teclear.
  useEffect(() => {
    const espera = setTimeout(() => setBuscar(escrito.trim()), ESPERA_AL_BUSCAR_MS);
    return () => clearTimeout(espera);
  }, [escrito]);

  const hayBusqueda = buscar.length >= MIN_LETRAS;
  // Sin nada que buscar no se pide nada: no se descarga el chat «por si acaso».
  const { mensajes, cargando, cargandoMas, fallo, cargarMas, reintentar } = useMensajesDeVista(
    conversationId,
    hayBusqueda ? VISTA_TODO : null,
    { buscar, currentUserId },
  );

  const irAlMensaje = useCallback(
    (mensaje: MensajeDeVista) => {
      if (!conversationId) return;
      pedirSalto(conversationId, mensaje.id);
      router.dismissTo({
        pathname: '/chat/[id]',
        params: nombre ? { id: conversationId, name: nombre } : { id: conversationId },
      });
    },
    [conversationId, nombre, router],
  );

  const resumen = (mensaje: MensajeDeVista): string => {
    const texto = mensaje.texto.trim();
    if (texto) return texto;
    const adjunto = mensaje.adjuntos[0];
    if (!adjunto) return t('chat.replyMessage');
    return adjunto.kind === 'document' && adjunto.fileName
      ? adjunto.fileName
      : t(NOMBRE_DE_ADJUNTO[adjunto.kind] ?? 'chat.replyMessage');
  };

  const pintar = ({ item }: { item: MensajeDeVista }) => (
    <Pressable
      onPress={() => irAlMensaje(item)}
      accessibilityRole="button"
      accessibilityLabel={`${item.mio ? t('chatViews.you') : item.autor.nombre}. ${resumen(item)}`}
      accessibilityHint={t('chatViews.goToMessage')}
      style={[styles.fila, { borderBottomColor: colors.border }]}
    >
      <Avatar size={40} image={item.autor.avatarUrl ?? null} name={item.autor.nombre} />
      <View style={styles.cuerpo}>
        <View style={styles.titular}>
          <Text weight="700" numberOfLines={1} style={styles.autor}>
            {item.mio ? t('chatViews.you') : item.autor.nombre}
          </Text>
          <Text color={colors.textMuted} numberOfLines={1} style={styles.detalle}>
            {fechaLegible(item.fechaIso)}
          </Text>
        </View>
        <Text numberOfLines={2} style={styles.texto}>
          {resumen(item)}
        </Text>
      </View>
      <Feather name="corner-up-right" size={16} color={colors.textMuted} />
    </Pressable>
  );

  return (
    <AppScreen scroll={false}>
      <AppHeader
        title={nombre ? t('chatSearch.titleOf', { nombre }) : t('chatSearch.title')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
      <View style={styles.buscador}>
        <Input
          value={escrito}
          onChangeText={setEscrito}
          placeholder={t('chatSearch.placeholder')}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          maxLength={MAX_BUSQUEDA_EN_VISTA}
        />
      </View>

      {!hayBusqueda ? (
        <StateView
          state="empty"
          title={t('chatSearch.startTitle')}
          description={t('chatSearch.startBody')}
        />
      ) : cargando && mensajes.length === 0 ? (
        <StateView state="loading" />
      ) : fallo && mensajes.length === 0 ? (
        <StateView state="error" title={fallo} onRetry={reintentar} />
      ) : (
        <FlatList
          data={mensajes}
          keyExtractor={(item) => item.id}
          renderItem={pintar}
          contentContainerStyle={mensajes.length === 0 ? styles.listaVacia : styles.lista}
          keyboardShouldPersistTaps="handled"
          onEndReached={cargarMas}
          onEndReachedThreshold={0.4}
          ListEmptyComponent={
            <StateView
              state="empty"
              title={t('chatViews.emptySearchTitle')}
              description={t('chatSearch.emptyBody', { texto: buscar })}
            />
          }
          ListFooterComponent={
            cargandoMas ? <ActivityIndicator style={styles.pie} color={colors.primary} /> : null
          }
        />
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  buscador: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.sm },
  lista: { paddingBottom: spacing.xl },
  listaVacia: { flexGrow: 1, justifyContent: 'center' },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cuerpo: { flex: 1, minWidth: 0, gap: 2 },
  titular: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  autor: { flexShrink: 1, fontSize: 14 },
  detalle: { fontSize: 12 },
  texto: { fontSize: 14, lineHeight: 19 },
  pie: { paddingVertical: spacing.md },
});
