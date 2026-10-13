import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { MarcaDeEntrega } from '@/components/chat/MarcaDeEntrega';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import {
  COLOR_DE_LEIDO,
  type DetallesDeMensaje as Detalles,
  type PersonaDeLectura,
} from '@/lib/lecturaDeMensajes';
import { MessageRepository } from '@/repositories/MessageRepository';
import { profileImageUrl } from '@/services/storage';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  conversacionId: string;
  /** El mensaje del que se piden los detalles. `null`: la hoja está cerrada. */
  mensaje: { id: string; text?: string; createdAt: string } | null;
  esGrupo: boolean;
  onClose: () => void;
};

type Carga =
  | { estado: 'cargando' }
  | { estado: 'error' }
  | { estado: 'listo'; detalles: Detalles };

/**
 * Los detalles de un mensaje propio: quién lo leyó y quién todavía no.
 *
 * SE PREGUNTA AL ABRIR, CADA VEZ. La lista cambia mientras la gente va
 * abriendo el chat, y una guardada de hace un minuto diría que falta quien ya
 * lo leyó.
 *
 * NO HAY HORA DE LECTURA. El servidor sabe hasta dónde leyó cada persona, no
 * cuándo vio cada mensaje; se dice quién sí y quién no, que es lo cierto.
 */
export function DetallesDeMensaje({ conversacionId, mensaje, esGrupo, onClose }: Props) {
  const { colors, mode } = useAppTheme();
  const { t } = useTranslation();
  const [carga, setCarga] = useState<Carga>({ estado: 'cargando' });
  const mensajeId = mensaje?.id ?? null;

  const preguntar = useCallback(() => {
    if (!mensajeId) return () => {};
    let vigente = true;
    setCarga({ estado: 'cargando' });
    MessageRepository.detallesDeMensaje(conversacionId, mensajeId).then(
      (detalles) => {
        if (!vigente) return;
        setCarga(detalles ? { estado: 'listo', detalles } : { estado: 'error' });
      },
      () => {
        if (vigente) setCarga({ estado: 'error' });
      },
    );
    return () => {
      vigente = false;
    };
  }, [conversacionId, mensajeId]);

  useEffect(() => preguntar(), [preguntar]);

  const fila = (persona: PersonaDeLectura) => (
    <View key={persona.id} style={styles.persona}>
      <Avatar size={36} image={profileImageUrl(persona.avatarPath) ?? null} name={persona.nombre} />
      <View style={styles.textos}>
        <Text numberOfLines={1} weight="600">
          {persona.nombre || t('chat.someone')}
        </Text>
        {persona.usuario ? (
          <Text numberOfLines={1} color={colors.textMuted} style={styles.usuario}>
            @{persona.usuario}
          </Text>
        ) : null}
      </View>
    </View>
  );

  const seccion = (
    titulo: string,
    personas: PersonaDeLectura[],
    vacio: string,
    leido: boolean,
  ) => (
    <View style={styles.seccion}>
      <View style={styles.cabecera}>
        <MarcaDeEntrega
          estado={leido ? 'leido' : 'enviado'}
          size={14}
          color={colors.textMuted}
          // La hoja tiene el fondo del tema, al revés que la burbuja propia.
          colorDeLeido={mode === 'dark' ? COLOR_DE_LEIDO.sobreOscuro : COLOR_DE_LEIDO.sobreClaro}
        />
        <Text weight="700" style={styles.titulo}>
          {titulo}
        </Text>
      </View>
      {personas.length > 0 ? (
        personas.map(fila)
      ) : (
        <Text color={colors.textMuted} style={styles.vacio}>
          {vacio}
        </Text>
      )}
    </View>
  );

  return (
    <BottomSheet visible={!!mensaje} onClose={onClose}>
      <Text weight="800" style={styles.nombre}>
        {t('chat.messageDetails')}
      </Text>
      {mensaje ? (
        <Text numberOfLines={2} color={colors.textMuted} style={styles.resumen}>
          {mensaje.text?.trim()
            ? t('chat.detailsOf', { texto: mensaje.text.trim(), hora: mensaje.createdAt })
            : t('chat.detailsSentAt', { hora: mensaje.createdAt })}
        </Text>
      ) : null}

      {carga.estado === 'cargando' ? (
        <View style={styles.centro}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      ) : null}

      {carga.estado === 'error' ? (
        <View style={styles.centro}>
          <Text color={colors.textMuted} style={styles.vacio}>
            {t('chat.detailsFailed')}
          </Text>
          <Button label={t('common.retry')} variant="secondary" onPress={() => void preguntar()} />
        </View>
      ) : null}

      {carga.estado === 'listo' ? (
        <>
          {seccion(
            t('chat.readBy', { n: carga.detalles.leyeron.length }),
            carga.detalles.leyeron,
            t(esGrupo ? 'chat.readByNobody' : 'chat.readByNobodyDirect'),
            true,
          )}
          {/* En un chat de dos, cuando ya lo leyó no hay segunda lista que enseñar. */}
          {carga.detalles.faltan.length > 0 || esGrupo
            ? seccion(
                t('chat.notReadYet', { n: carga.detalles.faltan.length }),
                carga.detalles.faltan,
                t('chat.everyoneRead'),
                false,
              )
            : null}
          <Text color={colors.textMuted} style={styles.nota}>
            {t('chat.detailsNote')}
          </Text>
        </>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  nombre: { fontSize: 17 },
  resumen: { fontSize: 13, lineHeight: 18, marginTop: 2, marginBottom: spacing.md },
  centro: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.lg },
  seccion: { marginBottom: spacing.md },
  cabecera: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  titulo: { fontSize: 14 },
  persona: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 6 },
  textos: { flex: 1, minWidth: 0 },
  usuario: { fontSize: 12 },
  vacio: { fontSize: 13, lineHeight: 18, textAlign: 'left' },
  nota: { fontSize: 11, lineHeight: 16, marginTop: spacing.xs },
});
