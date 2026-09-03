import React, { useMemo } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { enHilos } from '@/lib/comentarios';
import { useHaceFaltaCuenta, useRequireAuth } from '@/hooks/useRequireAuth';
import type { useComentarios } from '@/hooks/useComentarios';
import type { ComentarioConAvatar } from '@/repositories/PostRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

type Comentarios = ReturnType<typeof useComentarios>;

/** El corazón mide 13 px: sin esto no se acierta con el dedo. */
const ZONA_TACTIL = { top: 10, bottom: 10, left: 10, right: 10 };

export function ContenidoDeComentarios({
  comentarios,
  onPersonPress,
  paddingInferior = 0,
}: {
  comentarios: Comentarios;
  /** Quien monta esto cierra su hoja antes de navegar. */
  onPersonPress?: (persona: { id: string }) => void;
  /** Hueco bajo el campo: la barra de gestos en la pantalla, nada en la hoja. */
  paddingInferior?: number;
}) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  /*
    COMENTAR QUEDA ASOCIADO A ALGUIEN, asi que necesita cuenta —igual que
    reaccionar, guardar o repostear, que ya la pedian—. LEER no: el muro entero
    se puede recorrer sin registrarse y esa es una decision del producto, no un
    descuido; lo que estaba mal era dejar ESCRIBIR.

    Sin esto, quien no habia entrado podia redactar el comentario entero y
    recibir al pulsar «Enviar» un 401 crudo del servidor: se perdia lo escrito y
    ademas no se le decia lo unico util, que le hace falta una cuenta.

    Se pide en las TRES escrituras —comentar, responder y reaccionar a un
    comentario—, no solo en el boton de enviar.
  */
  const requireAuth = useRequireAuth();
  const haceFaltaCuenta = useHaceFaltaCuenta();
  const {
    estado,
    uiState,
    cargandoMas,
    inputText,
    setInputText,
    sending,
    load,
    cargarMas,
    enviar,
    respondiendo,
    setRespondiendo,
    reaccionar,
  } = comentarios;

  const hilos = useMemo(() => enHilos(estado.lista), [estado.lista]);

  const pedirCuenta = () => void requireAuth('auth.reasonComment', () => {});

  const fila = (item: ComentarioConAvatar, esRespuesta: boolean) => {
    const puedeAbrirPerfil = Boolean(item.authorId && onPersonPress);
    const abrirPerfil = () => {
      if (item.authorId) onPersonPress?.({ id: item.authorId });
    };
    return (
      <View
        key={item.id}
        style={[
          styles.fila,
          esRespuesta && styles.filaRespuesta,
          { borderBottomColor: colors.border },
        ]}
      >
        <Pressable
          onPress={abrirPerfil}
          disabled={!puedeAbrirPerfil}
          accessibilityRole="button"
          accessibilityLabel={t('post.viewProfileOf', { nombre: item.author })}
        >
          <Avatar
            size={esRespuesta ? 28 : 36}
            image={item.avatarUrl ?? 'avatar'}
            name={item.author}
          />
        </Pressable>
        <View style={styles.texto}>
          <View style={styles.cabecera}>
            <Pressable
              onPress={abrirPerfil}
              disabled={!puedeAbrirPerfil}
              accessibilityRole="button"
              accessibilityLabel={t('post.viewProfileOf', { nombre: item.author })}
            >
              <Text style={[styles.autor, { color: colors.text }]}>{item.author}</Text>
            </Pressable>
            <Text style={[styles.hora, { color: colors.textMuted }]}>{item.createdAt}</Text>
          </View>
          <Text style={[styles.cuerpo, { color: colors.text }]}>{item.text}</Text>
          <View style={styles.acciones}>
            <Pressable
              onPress={() => void requireAuth('auth.reasonReact', () => reaccionar(item.id))}
              hitSlop={ZONA_TACTIL}
              accessibilityRole="switch"
              accessibilityState={{ checked: item.viewerReacted }}
              accessibilityLabel={
                item.viewerReacted ? t('post.unlikeComment') : t('post.likeComment')
              }
              style={styles.reaccion}
            >
              <Feather
                name="heart"
                size={13}
                color={item.viewerReacted ? colors.primary : colors.textMuted}
              />
              {item.likesCount > 0 ? (
                <Text
                  style={[
                    styles.contador,
                    { color: item.viewerReacted ? colors.primary : colors.textMuted },
                  ]}
                >
                  {item.likesCount}
                </Text>
              ) : null}
            </Pressable>
            <Pressable
              onPress={() =>
                void requireAuth('auth.reasonComment', () =>
                  setRespondiendo({ id: item.id, author: item.author }),
                )
              }
              hitSlop={ZONA_TACTIL}
              accessibilityRole="button"
              accessibilityLabel={t('post.reply')}
            >
              <Text style={[styles.responder, { color: colors.textMuted }]}>{t('post.reply')}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.contenedor}>
      <StateView
        state={uiState}
        onRetry={load}
        title={uiState === 'empty' ? t('post.beFirstToComment') : undefined}
        description={uiState === 'empty' ? t('post.noCommentsYet') : undefined}
      >
        <FlatList
          data={hilos}
          keyExtractor={(hilo) => hilo.raiz.id}
          contentContainerStyle={styles.lista}
          onEndReached={() => void cargarMas()}
          onEndReachedThreshold={0.4}
          keyboardShouldPersistTaps="handled"
          ListFooterComponent={
            cargandoMas ? (
              <ActivityIndicator style={styles.masAbajo} color={colors.textMuted} />
            ) : null
          }
          renderItem={({ item }) => (
            <View>
              {fila(item.raiz, false)}
              {item.respuestas.map((respuesta) => fila(respuesta, true))}
            </View>
          )}
        />
      </StateView>

      {respondiendo ? (
        <View style={[styles.respondiendo, { borderTopColor: colors.border }]}>
          <Text style={[styles.respondiendoTexto, { color: colors.textMuted }]} numberOfLines={1}>
            {t('post.replyingTo', { nombre: respondiendo.author })}
          </Text>
          <Pressable
            onPress={() => setRespondiendo(null)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel={t('common.cancel')}
          >
            <Text style={[styles.cancelar, { color: colors.primary }]}>{t('common.cancel')}</Text>
          </Pressable>
        </View>
      ) : null}

      <View
        style={[
          styles.barra,
          {
            borderTopColor: colors.border,
            backgroundColor: colors.background,
            paddingBottom: spacing.md + paddingInferior,
          },
        ]}
      >
        <Input
          placeholder={respondiendo ? t('post.writeReply') : t('post.writeComment')}
          value={inputText}
          onChangeText={setInputText}
          containerStyle={styles.campo}
          // Sin cuenta el teclado no llega a abrirse: el aviso sale al tocar.
          editable={!haceFaltaCuenta}
        />
        <Button
          label={t('common.send')}
          variant="ghost"
          onPress={() => void requireAuth('auth.reasonComment', enviar)}
          loading={sending}
          disabled={!inputText.trim()}
        />
        {/*
          Una capa por encima de la barra entera, y no un campo desactivado a
          secas: desactivado, tocar el campo no haria NADA y pareceria que la
          aplicacion se ha colgado. Asi el primer toque ya explica que hace
          falta una cuenta. Va absoluta, de modo que no altera la fila.
        */}
        {haceFaltaCuenta ? (
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={pedirCuenta}
            accessibilityRole="button"
            accessibilityLabel={t('post.writeComment')}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  contenedor: { flex: 1, justifyContent: 'space-between' },
  lista: { padding: spacing.lg, gap: spacing.md },
  masAbajo: { paddingVertical: spacing.md },
  fila: { flexDirection: 'row', paddingBottom: spacing.md, borderBottomWidth: 1, gap: spacing.md },
  // Un solo nivel de sangrado: el hilo se lee sin encogerse a nada.
  filaRespuesta: { marginLeft: spacing.xl, borderBottomWidth: 0, paddingBottom: spacing.sm },
  texto: { flex: 1 },
  cabecera: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  autor: { fontSize: 13, fontWeight: '700' },
  hora: { fontSize: 10 },
  cuerpo: { fontSize: 13, lineHeight: 18 },
  acciones: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginTop: spacing.xs },
  reaccion: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  contador: { fontSize: 11, fontWeight: '700' },
  responder: { fontSize: 11, fontWeight: '700' },
  respondiendo: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    gap: spacing.sm,
  },
  respondiendoTexto: { flex: 1, fontSize: 12 },
  cancelar: { fontSize: 12, fontWeight: '700' },
  barra: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderTopWidth: 1,
    gap: spacing.sm,
  },
  campo: { flex: 1 },
});
