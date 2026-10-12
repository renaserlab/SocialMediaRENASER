import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { BottomSheet } from '@/components/BottomSheet';
import { InlineError } from '@/components/InlineError';
import { ListRow } from '@/components/ListRow';
import { Text } from '@/components/Text';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { COLORES_DE_FONDO, mismoFondo, type FondoDeChat } from '@/lib/fondoDeChat';
import { PermisoDenegadoError, pickImage } from '@/services/storage';
import { FONDO_CON_FOTO, useFondoDeChatStore } from '@/store/useFondoDeChatStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const MUESTRA = 56;

type Props = {
  visible: boolean;
  onClose: () => void;
};

/**
 * Elegir el fondo del chat: el de siempre, uno de los colores o una foto.
 *
 * VALE PARA TODOS LOS CHATS Y SOLO EN ESTE TELÉFONO. No se guarda en el
 * servidor ni lo ve nadie más.
 *
 * LOS COLORES SE ENSEÑAN COMO SE VAN A VER: cada muestra pinta el tono del
 * tema que está puesto, que es el que acabará detrás de los mensajes.
 */
export function HojaDeFondoDeChat({ visible, onClose }: Props) {
  const { colors, mode } = useAppTheme();
  const { t } = useTranslation();
  const fondo = useFondoDeChatStore((estado) => estado.fondo);
  const elegir = useFondoDeChatStore((estado) => estado.elegir);
  const elegirFoto = useFondoDeChatStore((estado) => estado.elegirFoto);
  const [fallo, setFallo] = useState<string | null>(null);
  const oscuro = mode === 'dark';

  const poner = useCallback(
    (nuevo: FondoDeChat) => {
      setFallo(null);
      void elegir(nuevo);
    },
    [elegir],
  );

  const ponerFoto = useCallback(async () => {
    setFallo(null);
    try {
      // La hoja se queda abierta mientras se elige: en iOS el selector no se
      // abre mientras un Modal se está cerrando (ver `FotoDelGrupo`).
      const elegida = await pickImage({ allowsEditing: false });
      if (!elegida) return;
      if (!(await elegirFoto(elegida.uri))) setFallo(t('chatBackground.photoFailed'));
    } catch (error) {
      setFallo(
        error instanceof PermisoDenegadoError ? error.message : t('chatBackground.photoFailed'),
      );
    }
  }, [elegirFoto, t]);

  const muestra = (
    clave: string,
    valor: FondoDeChat,
    color: string,
    etiqueta: string,
    contenido?: React.ReactNode,
  ) => {
    const elegido = mismoFondo(fondo, valor);
    return (
      <Pressable
        key={clave}
        onPress={() => poner(valor)}
        accessibilityRole="radio"
        // Las dos: un lector de pantalla anuncia la elegida por `checked`.
        accessibilityState={{ checked: elegido, selected: elegido }}
        accessibilityLabel={etiqueta}
        style={styles.opcion}
      >
        <View
          style={[
            styles.muestra,
            {
              backgroundColor: color,
              borderColor: elegido ? colors.primary : colors.border,
              borderWidth: elegido ? 2 : StyleSheet.hairlineWidth,
            },
          ]}
        >
          {elegido ? <Feather name="check" size={20} color={colors.text} /> : contenido ?? null}
        </View>
        <Text numberOfLines={1} color={colors.textMuted} style={styles.nombre}>
          {etiqueta}
        </Text>
      </Pressable>
    );
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text weight="800" style={styles.titulo}>
        {t('chatBackground.title')}
      </Text>
      <Text color={colors.textMuted} style={styles.ayuda}>
        {t('chatBackground.hint')}
      </Text>

      {fallo ? <InlineError message={fallo} /> : null}

      <View accessibilityRole="radiogroup" style={styles.rejilla}>
        {muestra(
          'defecto',
          { tipo: 'defecto' },
          colors.background,
          t('chatBackground.default'),
        )}
        {COLORES_DE_FONDO.map((color) =>
          muestra(
            color.id,
            { tipo: 'color', id: color.id },
            oscuro ? color.oscuro : color.claro,
            t(`chatBackground.color.${color.id}` as TranslationKey),
          ),
        )}
      </View>

      {FONDO_CON_FOTO ? (
        <ListRow
          title={t(fondo.tipo === 'foto' ? 'chatBackground.changePhoto' : 'chatBackground.photo')}
          subtitle={fondo.tipo === 'foto' ? t('chatBackground.photoInUse') : undefined}
          leftIcon="image"
          onPress={() => void ponerFoto()}
        />
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  titulo: { fontSize: 17 },
  ayuda: { fontSize: 13, lineHeight: 18, marginBottom: spacing.md },
  rejilla: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginBottom: spacing.md },
  opcion: { width: MUESTRA + 8, alignItems: 'center', gap: 4 },
  muestra: {
    width: MUESTRA,
    height: MUESTRA,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nombre: { fontSize: 11 },
});
