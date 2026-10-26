import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Avatar } from '@/components/Avatar';
import { BurbujaDeNotaDeVoz } from '@/components/BurbujaDeNotaDeVoz';
import { ArchivoDeChat } from '@/components/chat/ArchivoDeChat';
import { MedioDeChat } from '@/components/chat/MedioDeChat';
import { RespuestaAHistoria } from '@/components/RespuestaAHistoria';
import { Text } from '@/components/Text';
import { TextoConEnlaces } from '@/components/TextoConEnlaces';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { colorDeAutor, miembroDe, nombreDelAutor, type InfoDeConversacion } from '@/lib/gruposDeChat';
import { medioQueEs } from '@/lib/mediosDeChat';
import { textoDeCita } from '@/lib/reaccionesDeChat';
import type { MensajeDeTema } from '@/repositories/TemasRepository';
import { profileImageUrl } from '@/services/storage';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { MessageAttachment } from '@/types';

/** Las mismas medidas que la burbuja de `ChatScreen`. */
const RELLENO_V = spacing.sm + 2;
const RELLENO_H = spacing.md + 2;
const AVATAR = 28;

type Props = {
  mensaje: MensajeDeTema;
  /** El de antes en el tema: con el mismo autor, no se repiten ni foto ni nombre. */
  anterior?: MensajeDeTema;
  /** El grupo, para el nombre y la foto de quien escribió. */
  info: InfoDeConversacion | null | undefined;
  currentUserId: string | null;
  /** Lo que mide una foto o un archivo: el chat lo recorta a la pantalla. */
  anchoDeMedio: number;
  /** La nota de voz que está sonando: solo una tiene reproductor (ver `ChatScreen`). */
  audioSonando: string | null;
  alSonar: (adjuntoId: string) => void;
  alParar: () => void;
  alVerAdjunto: (adjunto: MessageAttachment) => void;
  /** Mantener presionado: la hoja de acciones del mensaje. Sin ella, no hay nada que hacer. */
  alMantener?: (mensaje: MensajeDeTema) => void;
  alReaccionar?: (mensaje: MensajeDeTema, emoji: string | null) => void;
  alVerEnGeneral: (mensaje: MensajeDeTema) => void;
  /** Se acaba de llegar a él: se marca un momento. */
  resaltado?: boolean;
};

/** El día de un mensaje en el tema: cuándo llegó AL TEMA. */
function diaDe(mensaje?: MensajeDeTema): string | null {
  if (!mensaje?.ordenIso) return null;
  const fecha = new Date(mensaje.ordenIso);
  return Number.isNaN(fecha.getTime()) ? null : fecha.toDateString();
}

/**
 * Un mensaje de un tema, con el MISMO aspecto que en el chat.
 *
 * POR QUÉ NO ES LA BURBUJA DE `ChatScreen`. Aquella vive dentro de la pantalla
 * del chat, atada a su estado (enviar, reintentar, deslizar para responder,
 * marcas de lectura). Un tema no tiene nada de eso: se lee. Así que esta es
 * una pieza pequeña con los mismos tokens y las mismas medidas —relleno,
 * radios, 80 % de ancho, el nombre en el color de cada persona— y las mismas
 * piezas para lo de dentro: `MedioDeChat`, `ArchivoDeChat`,
 * `BurbujaDeNotaDeVoz`, `TextoConEnlaces`.
 *
 * DEBAJO DE CADA MENSAJE, DE DÓNDE VIENE. Una referencia lleva «Ver en General
 * · agregado por X», que lleva al mensaje en su sitio. Lo escrito solo aquí
 * lleva «Escrito solo en este tema»: es lo que no está en General, y se dice
 * con texto e icono, no con un color.
 *
 * NINGÚN PULSABLE DENTRO DE OTRO. En la web cada uno es un `<button>`: los
 * adjuntos, el texto, las reacciones y el enlace de abajo son HERMANOS.
 */
export function BurbujaDeTema({
  mensaje,
  anterior,
  info,
  currentUserId,
  anchoDeMedio,
  audioSonando,
  alSonar,
  alParar,
  alVerAdjunto,
  alMantener,
  alReaccionar,
  alVerEnGeneral,
  resaltado = false,
}: Props) {
  const { colors, mode } = useAppTheme();
  const { t } = useTranslation();
  const mio = mensaje.sender === 'me';
  const dia = diaDe(mensaje);
  const cambioDeDia = !!dia && dia !== diaDe(anterior);
  const agrupado =
    !cambioDeDia &&
    !!anterior &&
    anterior.sender === mensaje.sender &&
    !!anterior.autorId &&
    anterior.autorId === mensaje.autorId;
  const nombre =
    nombreDelAutor(info, mensaje.autorId, mensaje.autorNombre) || t('groups.someone');
  const conAutor = !mio && !agrupado;
  const colorDelTexto = mio ? colors.onPrimary : colors.text;
  const mantener = alMantener ? () => alMantener(mensaje) : undefined;

  const quienLoAgrego = !mensaje.anadidoPor
    ? null
    : mensaje.anadidoPor.id === currentUserId
      ? t('chatViews.you')
      : mensaje.anadidoPor.nombre || null;

  const pintarAdjunto = (adjunto: MessageAttachment) => {
    if (adjunto.kind === 'audio') {
      return (
        <BurbujaDeNotaDeVoz
          key={adjunto.id}
          adjunto={adjunto}
          mio={mio}
          activo={audioSonando === adjunto.id}
          alPulsar={() => alSonar(adjunto.id)}
          alTerminar={alParar}
        />
      );
    }
    if (adjunto.kind === 'document') {
      // Una foto o un video mandado como archivo se abre en el visor, como en el chat.
      const medio = adjunto.url?.startsWith('http') ? medioQueEs(adjunto.mimeType, adjunto.fileName) : null;
      return (
        <ArchivoDeChat
          key={adjunto.id}
          adjunto={adjunto}
          mio={mio}
          alVer={medio ? () => alVerAdjunto({ ...adjunto, kind: medio }) : undefined}
          alMantener={mantener}
          style={{ width: anchoDeMedio }}
        />
      );
    }
    const proporcion = adjunto.width && adjunto.height ? adjunto.width / adjunto.height : 1;
    return (
      <Pressable
        key={adjunto.id}
        onPress={() => {
          if (adjunto.url) alVerAdjunto(adjunto);
        }}
        onLongPress={mantener}
        delayLongPress={400}
        accessibilityRole="button"
        accessibilityLabel={adjunto.kind === 'video' ? t('chat.viewVideo') : t('chat.viewPhoto')}
        accessibilityHint={mantener ? t('chat.holdForActions') : undefined}
        style={[
          styles.medio,
          { width: anchoDeMedio, aspectRatio: Math.min(Math.max(proporcion, 0.6), 1.9) },
        ]}
      >
        <MedioDeChat adjunto={adjunto} style={StyleSheet.absoluteFill} />
      </Pressable>
    );
  };

  return (
    <View>
      {cambioDeDia ? (
        <View style={styles.dia}>
          <Text style={[styles.diaTexto, { color: colors.textMuted, backgroundColor: colors.surfaceAlt }]}>
            {new Date(mensaje.ordenIso).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}
          </Text>
        </View>
      ) : null}

      <View
        style={[
          styles.bloque,
          mio ? styles.bloqueMio : styles.bloqueSuyo,
          resaltado && { backgroundColor: colors.border },
        ]}
      >
        <View style={[styles.fila, mio ? styles.filaMia : styles.filaSuya]}>
          {!mio ? (
            agrupado ? (
              <View style={styles.huecoDeAvatar} />
            ) : (
              <Avatar
                size={AVATAR}
                image={profileImageUrl(miembroDe(info, mensaje.autorId)?.avatarPath) ?? null}
                name={nombre}
              />
            )
          ) : null}

          <View
            style={[
              styles.burbuja,
              mio ? styles.mia : styles.suya,
              agrupado && (mio ? styles.miaSeguida : styles.suyaSeguida),
              {
                backgroundColor: mensaje.eliminado ? 'transparent' : mio ? colors.primary : colors.surfaceAlt,
                borderColor: mio && !mensaje.eliminado ? colors.primary : colors.border,
              },
            ]}
          >
            {conAutor ? (
              <Text
                numberOfLines={1}
                style={[styles.autor, { color: colorDeAutor(mensaje.autorId, mode === 'dark') }]}
              >
                {nombre}
              </Text>
            ) : null}

            {mensaje.eliminado ? (
              <View style={styles.eliminado}>
                <Feather name="slash" size={12} color={colors.textMuted} />
                <Text style={[styles.eliminadoTexto, { color: colors.textMuted }]}>
                  {t('chat.deletedMessage')}
                </Text>
              </View>
            ) : (
              <>
                {/* A qué responde, como cita. Aquí no lleva a ningún sitio: se lee. */}
                {mensaje.respuestaA ? (
                  <View
                    style={[
                      styles.cita,
                      { borderLeftColor: colorDeAutor(mensaje.respuestaA.autorId, mode === 'dark') },
                    ]}
                  >
                    <Text numberOfLines={1} style={[styles.citaAutor, { color: colorDelTexto }]}>
                      {mensaje.respuestaA.autorId === currentUserId
                        ? t('chatViews.you')
                        : mensaje.respuestaA.autor || t('groups.someone')}
                    </Text>
                    <Text
                      numberOfLines={2}
                      style={[styles.citaTexto, { color: mio ? colors.onPrimary : colors.textMuted }]}
                    >
                      {(() => {
                        const lo = textoDeCita(mensaje.respuestaA);
                        return 'texto' in lo ? lo.texto : t(lo.clave as TranslationKey);
                      })()}
                    </Text>
                  </View>
                ) : null}

                {mensaje.storyContext ? (
                  <RespuestaAHistoria contexto={mensaje.storyContext} mio={mio} />
                ) : null}

                {mensaje.attachments?.length ? (
                  <View style={styles.adjuntos}>{mensaje.attachments.map(pintarAdjunto)}</View>
                ) : null}

                {/* El texto y la hora: mantener presionado abre las acciones. */}
                <Pressable
                  onLongPress={mantener}
                  delayLongPress={400}
                  accessibilityRole={mantener ? 'button' : undefined}
                  accessibilityLabel={mantener ? t('chat.holdForActions') : undefined}
                >
                  {mensaje.text ? (
                    <TextoConEnlaces
                      texto={mensaje.text}
                      colorDelTexto={colorDelTexto}
                      style={{ color: colorDelTexto, fontSize: 15, lineHeight: 22 }}
                    />
                  ) : null}
                  <View style={[styles.pie, mio && styles.pieMio]}>
                    <Text style={[styles.hora, { color: mio ? colors.onPrimary : colors.textMuted }]}>
                      {mensaje.createdAt}
                    </Text>
                  </View>
                </Pressable>

                {mensaje.reacciones?.length ? (
                  <View style={styles.reacciones}>
                    {mensaje.reacciones.map((reaccion) => (
                      <Pressable
                        key={reaccion.emoji}
                        onPress={
                          alReaccionar
                            ? () => alReaccionar(mensaje, reaccion.mia ? null : reaccion.emoji)
                            : undefined
                        }
                        disabled={!alReaccionar}
                        accessibilityRole={alReaccionar ? 'button' : undefined}
                        accessibilityLabel={t('chat.reactionOf', {
                          emoji: reaccion.emoji,
                          n: reaccion.cuantos,
                        })}
                        style={[
                          styles.reaccion,
                          {
                            backgroundColor: colors.background,
                            borderColor: reaccion.mia ? colors.text : colors.border,
                          },
                        ]}
                      >
                        <Text style={[styles.reaccionTexto, { color: colors.text }]}>
                          {reaccion.cuantos > 1 ? `${reaccion.emoji} ${reaccion.cuantos}` : reaccion.emoji}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
              </>
            )}
          </View>
        </View>

        {/* De dónde viene: hermano de la burbuja, nunca dentro de ella. */}
        {mensaje.propio ? (
          <View style={[styles.origen, !mio && styles.origenSuyo]}>
            <Feather name="edit-3" size={13} color={colors.textMuted} />
            <Text weight="600" color={colors.textMuted} style={styles.origenTexto}>
              {t('groupTopics.writtenHere')}
            </Text>
          </View>
        ) : (
          <Pressable
            onPress={() => alVerEnGeneral(mensaje)}
            accessibilityRole="button"
            hitSlop={6}
            style={[styles.origen, !mio && styles.origenSuyo]}
          >
            <Feather name="corner-up-right" size={13} color={colors.textMuted} />
            <Text weight="700" color={colors.textMuted} style={styles.origenTexto}>
              {quienLoAgrego
                ? t('groupTopics.seeInGeneralBy', { nombre: quienLoAgrego })
                : t('groupTopics.seeInGeneral')}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dia: { alignItems: 'center', marginVertical: spacing.md },
  diaTexto: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    overflow: 'hidden',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  // Cada mensaje con lo suyo debajo: el bloque entero se resalta al llegar a él.
  bloque: { marginBottom: 14, marginHorizontal: -spacing.sm, paddingHorizontal: spacing.sm, borderRadius: radius.md },
  bloqueMio: { alignItems: 'flex-end' },
  bloqueSuyo: { alignItems: 'flex-start' },
  fila: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, width: '100%' },
  filaMia: { justifyContent: 'flex-end' },
  filaSuya: { justifyContent: 'flex-start' },
  huecoDeAvatar: { width: AVATAR },
  // 80 % y no más, como en el chat: una burbuja que toca el borde contrario
  // deja de decir de quién es.
  burbuja: {
    maxWidth: '80%',
    borderRadius: 20,
    paddingVertical: RELLENO_V,
    paddingHorizontal: RELLENO_H,
    borderWidth: 1,
  },
  mia: { borderBottomRightRadius: 4 },
  suya: { borderBottomLeftRadius: 4 },
  miaSeguida: { borderTopRightRadius: 6 },
  suyaSeguida: { borderTopLeftRadius: 6 },
  autor: { fontSize: 13, fontWeight: '700', marginBottom: 2 },
  eliminado: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  eliminadoTexto: { fontSize: 13, fontStyle: 'italic' },
  // Sin fondo propio: la raya del color de su autor ya la separa del texto, y
  // así no hace falta ningún color fuera de los tokens.
  cita: {
    borderLeftWidth: 3,
    borderRadius: 2,
    paddingVertical: 2,
    paddingHorizontal: 8,
    marginBottom: 6,
  },
  citaAutor: { fontSize: 12, fontWeight: '700' },
  citaTexto: { fontSize: 13, lineHeight: 18 },
  adjuntos: { gap: spacing.sm, marginBottom: spacing.sm },
  medio: { borderRadius: radius.md, overflow: 'hidden' },
  pie: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  pieMio: { justifyContent: 'flex-end' },
  hora: { fontSize: 11, opacity: 0.8 },
  reacciones: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 6 },
  reaccion: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 2 },
  reaccionTexto: { fontSize: 13 },
  origen: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 28,
    marginTop: 4,
  },
  // Bajo una burbuja ajena, alineado con ella y no con la foto.
  origenSuyo: { marginLeft: AVATAR + 6 },
  origenTexto: { fontSize: 12 },
});
