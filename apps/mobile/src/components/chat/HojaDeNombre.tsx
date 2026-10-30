import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { formatearDuracion } from '@/lib/notaDeVoz';
import {
  MAX_TITULO_DE_ADJUNTO,
  claveDelFalloDeNombre,
  iconoDeTarjeta,
  limpiarTitulo,
} from '@/lib/nombresDeAdjuntos';
import { MessageRepository } from '@/repositories/MessageRepository';
import { ApiError } from '@/services/api';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { MessageAttachment } from '@/types';

/** A qué adjunto se le pone nombre, y lo que hace falta para decir de quién es. */
export type ObjetivoDeNombre = {
  conversacionId: string;
  mensajeId: string;
  adjunto: MessageAttachment;
  /** Quién lo mandó, para «Nota de voz de Mariana Torres». */
  autor: string;
  /** En un grupo el nombre lo ve toda la comunidad, y lo dice la ayuda. */
  esGrupo: boolean;
};

type Props = {
  /** `null`: cerrada. */
  objetivo: ObjetivoDeNombre | null;
  onClose: () => void;
  /** Lo que quedó guardado en el servidor, para pintarlo ya en el chat. */
  alGuardar: (adjuntoId: string, titulo: string | null) => void;
};

/**
 * «Ponerle nombre» / «Cambiar el nombre», desde el menú del mensaje (lienzo,
 * «3 · Después, desde el menú del mensaje»).
 *
 * Solo se ofrece a quien envió el mensaje y a quien administra; quien decide
 * es el servidor (`PATCH …/attachments/{id}`), y su «no» se cuenta DENTRO de
 * la hoja (`InlineError`): un diálogo encima de un `Modal` no se ve en iOS.
 * Dejar el campo vacío y guardar le quita el nombre.
 */
export function HojaDeNombre({ objetivo, onClose, alGuardar }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [texto, setTexto] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [fallo, setFallo] = useState<string | null>(null);

  const adjunto = objetivo?.adjunto ?? null;
  const tenia = adjunto?.title?.trim() || null;

  // Cada vez que se abre, empieza con el nombre que ya tiene (o vacío).
  useEffect(() => {
    if (!objetivo) return;
    setTexto(objetivo.adjunto.title?.trim() ?? '');
    setFallo(null);
    setGuardando(false);
  }, [objetivo]);

  const titulo = limpiarTitulo(texto);
  // Sin nombre antes y sin nombre ahora no hay nada que guardar.
  const sePuedeGuardar = !!objetivo && !guardando && (titulo !== null || tenia !== null);

  const guardar = async () => {
    if (!objetivo || !sePuedeGuardar) return;
    if (titulo === tenia) {
      onClose();
      return;
    }
    setGuardando(true);
    setFallo(null);
    try {
      const guardado = await MessageRepository.nombrarAdjunto(
        objetivo.conversacionId,
        objetivo.mensajeId,
        objetivo.adjunto.id,
        titulo,
      );
      // Lo que dice el servidor manda; si no contestó el adjunto, lo pedido.
      alGuardar(objetivo.adjunto.id, guardado ? guardado.title ?? null : titulo);
      onClose();
    } catch (error) {
      setFallo(
        t(claveDelFalloDeNombre(error instanceof ApiError ? error.code : null) as TranslationKey),
      );
    } finally {
      setGuardando(false);
    }
  };

  const icono = adjunto ? iconoDeTarjeta(adjunto) ?? 'file-text' : 'file-text';
  const queEs = !adjunto || !objetivo
    ? ''
    : adjunto.kind === 'document'
      ? adjunto.fileName || t('chat.file')
      : t(
          adjunto.kind === 'video'
            ? 'attachmentName.previewVideo'
            : adjunto.voiceNote === false
              ? 'attachmentName.previewAudio'
              : 'attachmentName.previewVoice',
          { nombre: objetivo.autor || t('groups.someone') },
        );
  const duracion =
    adjunto && adjunto.kind !== 'document' && adjunto.durationS
      ? formatearDuracion(adjunto.durationS)
      : '';

  return (
    <BottomSheet visible={!!objetivo} onClose={onClose}>
      <View style={styles.cuerpo}>
        <Text weight="800" style={styles.titulo}>
          {t(tenia ? 'attachmentName.rename' : 'attachmentName.name')}
        </Text>

        <View style={[styles.resumen, { backgroundColor: colors.tarjetaRelleno }]}>
          <View style={[styles.punto, { backgroundColor: colors.text }]}>
            <Feather name={icono} size={13} color={colors.background} />
          </View>
          <Text numberOfLines={1} color={colors.textMuted} style={styles.resumenTexto}>
            {queEs}
          </Text>
          {duracion ? (
            <Text color={colors.textMuted} style={styles.resumenDuracion}>
              {duracion}
            </Text>
          ) : null}
        </View>

        <Input
          label={t('attachmentName.label')}
          value={texto}
          onChangeText={(nuevo) => {
            setTexto(nuevo);
            setFallo(null);
          }}
          maxLength={MAX_TITULO_DE_ADJUNTO}
          returnKeyType="done"
          onSubmitEditing={() => void guardar()}
        />
        <View style={styles.pie}>
          <Text color={colors.textMuted} style={styles.ayuda}>
            {t(objetivo?.esGrupo ? 'attachmentName.help' : 'attachmentName.helpDirect')}
          </Text>
          <Text color={colors.textMuted} style={styles.cuenta}>
            {`${texto.length}/${MAX_TITULO_DE_ADJUNTO}`}
          </Text>
        </View>

        <InlineError message={fallo} />

        <Button
          label={t('attachmentName.save')}
          onPress={() => void guardar()}
          loading={guardando}
          disabled={!sePuedeGuardar}
        />
        <Button label={t('common.cancel')} variant="secondary" onPress={onClose} disabled={guardando} />
        {objetivo?.esGrupo ? (
          <Text color={colors.textMuted} style={[styles.ayuda, styles.quien]}>
            {t('attachmentName.whoCan')}
          </Text>
        ) : null}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  cuerpo: { gap: spacing.sm + 4, paddingBottom: spacing.sm },
  titulo: { fontSize: 20, lineHeight: 24 },
  resumen: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm + 2,
    borderRadius: radius.md,
  },
  punto: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  resumenTexto: { flex: 1, minWidth: 0, fontSize: 14 },
  resumenDuracion: { fontSize: 12 },
  pie: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm, marginTop: -spacing.xs },
  ayuda: { flex: 1, fontSize: 12, lineHeight: 16 },
  cuenta: { fontSize: 12, lineHeight: 16 },
  quien: { textAlign: 'center' },
});
