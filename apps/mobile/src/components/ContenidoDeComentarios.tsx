import React, { useMemo, useRef } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

import { Aparecer } from '@/components/Aparecer';
import { Avatar } from '@/components/Avatar';
import { BotonDeEnviar } from '@/components/BotonDeEnviar';
import { ContadorAnimado } from '@/components/ContadorAnimado';
import { IconoQueSeEnciende } from '@/components/IconoQueSeEnciende';
import { Input } from '@/components/Input';
import { Pulsable } from '@/components/Pulsable';
import { StateView } from '@/components/StateView';
import { enHilos } from '@/lib/comentarios';
import { ESCALA_AL_PULSAR, retrasoEnCascada } from '@/lib/movimiento';
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
  /** Los hilos que ya hicieron su entrada. */
  const yaEntraron = useRef(new Set<string>());

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
          // Una respuesta cuelga de su comentario: sangrada y con una raya a
          // la izquierda que la ata a el. Sin separadores entre filas: la
          // jerarquia la dan el sangrado y el aire, no una rejilla de lineas.
          esRespuesta && [styles.filaRespuesta, { borderLeftColor: colors.border }],
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
            <Text style={[styles.hora, { color: colors.textMuted }]}>· {item.createdAt}</Text>
          </View>
          <Text style={[styles.cuerpo, { color: colors.text }]}>{item.text}</Text>
          <View style={styles.acciones}>
            <Pulsable
              onPress={() => void requireAuth('auth.reasonReact', () => reaccionar(item.id))}
              hitSlop={ZONA_TACTIL}
              escala={ESCALA_AL_PULSAR.icono}
              haptica="ligera"
              accessibilityRole="switch"
              accessibilityState={{ checked: item.viewerReacted }}
              accessibilityLabel={
                item.viewerReacted ? t('post.unlikeComment') : t('post.likeComment')
              }
              style={styles.reaccion}
            >
              {/*
                Relleno al reaccionar y de contorno al quitar: cambia la forma,
                no solo el tono, y salta al encenderse.
              */}
              <IconoQueSeEnciende activo={item.viewerReacted}>
                {item.viewerReacted ? (
                  <MaterialCommunityIcons name="heart" size={16} color={colors.meGusta} />
                ) : (
                  <Feather name="heart" size={15} color={colors.textMuted} />
                )}
              </IconoQueSeEnciende>
              {item.likesCount > 0 ? (
                <ContadorAnimado
                  valor={item.likesCount}
                  color={item.viewerReacted ? colors.text : colors.textMuted}
                  style={styles.contador}
                />
              ) : null}
            </Pulsable>
            <Pulsable
              onPress={() =>
                void requireAuth('auth.reasonComment', () =>
                  setRespondiendo({ id: item.id, author: item.author }),
                )
              }
              hitSlop={ZONA_TACTIL}
              atenuar={0.6}
              accessibilityRole="button"
              accessibilityLabel={t('post.reply')}
              style={styles.reaccion}
            >
              <Feather name="corner-down-right" size={13} color={colors.textMuted} />
              <Text style={[styles.responder, { color: colors.textMuted }]}>{t('post.reply')}</Text>
            </Pulsable>
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
        // Un globo de conversacion, no la bandeja generica: dice de que va.
        icon={uiState === 'empty' ? 'message-circle' : undefined}
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
          renderItem={({ item, index }) => {
            /*
              Cada hilo entra subiendo unos puntos, en cascada los primeros.
              Un comentario recien enviado entra igual: se ve llegar.

              UNA VEZ. La lista desmonta las filas que quedan lejos y las
              vuelve a montar al regresar: sin apuntar las que ya entraron,
              volver arriba las animaba otra vez.
            */
            const yaEntro = yaEntraron.current.has(item.raiz.id);
            yaEntraron.current.add(item.raiz.id);
            return (
              <Aparecer inmediato={yaEntro} retraso={index < 6 ? retrasoEnCascada(index) : 0}>
                {fila(item.raiz, false)}
                {item.respuestas.map((respuesta) => fila(respuesta, true))}
              </Aparecer>
            );
          }}
        />
      </StateView>

      {respondiendo ? (
        <Aparecer
          desde={6}
          style={[
            styles.respondiendo,
            { borderTopColor: colors.border, backgroundColor: colors.backgroundAlt },
          ]}
        >
          <Feather name="corner-down-right" size={14} color={colors.textMuted} />
          <Text style={[styles.respondiendoTexto, { color: colors.textMuted }]} numberOfLines={1}>
            {t('post.replyingTo', { nombre: respondiendo.author })}
          </Text>
          <Pulsable
            onPress={() => setRespondiendo(null)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            escala={ESCALA_AL_PULSAR.icono}
            accessibilityRole="button"
            accessibilityLabel={t('common.cancel')}
          >
            <Feather name="x" size={16} color={colors.text} />
          </Pulsable>
        </Aparecer>
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
          // Si el envio falla el texto se queda aqui: lo conserva el hook.
          multiline
        />
        {/*
          Un boton redondo y siempre en su sitio, en vez de la palabra «Enviar»
          en gris: crece cuando hay algo que mandar y enseña la espera dentro.
        */}
        <BotonDeEnviar
          onPress={() => void requireAuth('auth.reasonComment', enviar)}
          listo={Boolean(inputText.trim())}
          enviando={sending}
          accessibilityLabel={t('common.send')}
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
  lista: { padding: spacing.lg, gap: spacing.lg },
  masAbajo: { paddingVertical: spacing.md },
  fila: { flexDirection: 'row', gap: spacing.md },
  // Un solo nivel de sangrado: el hilo se lee sin encogerse a nada. La raya
  // de la izquierda es el hilo.
  filaRespuesta: {
    marginLeft: spacing.lg + 2,
    marginTop: spacing.md,
    paddingLeft: spacing.md,
    borderLeftWidth: 2,
  },
  texto: { flex: 1 },
  // Nombre y hora juntos, a la izquierda: se leen de un golpe de vista.
  cabecera: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: 2,
  },
  autor: { fontSize: 14, fontWeight: '700' },
  hora: { fontSize: 12 },
  cuerpo: { fontSize: 14, lineHeight: 20 },
  acciones: { flexDirection: 'row', alignItems: 'center', gap: spacing.xl, marginTop: spacing.sm },
  reaccion: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 24 },
  contador: { fontSize: 12, fontWeight: '700' },
  responder: { fontSize: 12, fontWeight: '700' },
  respondiendo: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    borderTopWidth: 1,
    gap: spacing.sm,
  },
  respondiendoTexto: { flex: 1, fontSize: 13 },
  barra: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: spacing.md,
    borderTopWidth: 1,
    gap: spacing.sm,
  },
  campo: { flex: 1, maxHeight: 120 },
});
