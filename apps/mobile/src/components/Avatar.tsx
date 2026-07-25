import React from 'react';
import { Image, ImageSourcePropType, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { assets } from '@/data/assets';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  size?: number;
  label?: string;
  image?: keyof typeof assets | ImageSourcePropType | null;
  name?: string;
};

export function Avatar({ size = 44, label, image, name }: Props) {
  const { colors } = useAppTheme();

  // Fuente de la imagen. Se aceptan tres formas y conviene distinguirlas:
  //
  //   - una clave del catalogo local ('avatar', 'circle'...),
  //   - una URL, que es lo que devuelve `profileImageUrl` para las fotos
  //     subidas por cada persona,
  //   - o una fuente ya construida.
  //
  // La URL hay que envolverla en `{ uri }`. Sin este caso, un enlace perfecto
  // no coincidia con ninguna clave del catalogo, se descartaba en silencio y
  // salia la silueta por defecto: quien tenia foto se veia como quien no.
  let source: ImageSourcePropType | null = null;
  if (image) {
    if (typeof image === 'string') {
      if (assets[image]) source = assets[image]!;
      else if (/^(https?:|file:|data:|blob:)/.test(image)) source = { uri: image };
    } else if (typeof image === 'object') {
      source = image as ImageSourcePropType;
    }
  }

  // Generar iniciales para el fallback
  const getInitials = () => {
    if (!name) return '';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0]?.slice(0, 2).toUpperCase() || '';
    return `${parts[0]?.charAt(0)}${parts[1]?.charAt(0)}`.toUpperCase();
  };

  const initials = getInitials();

  return (
    <View style={{ alignItems: 'center', gap: 6 }}>
      {source ? (
        <Image
          source={source}
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: colors.surfaceAlt,
            borderWidth: 1,
            borderColor: colors.border,
          }}
        />
      ) : (
        <View
          style={[
            styles.placeholder,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: colors.surfaceAlt,
              borderColor: colors.border,
            },
          ]}
        >
          {initials ? (
            <Text style={[styles.initials, { fontSize: size * 0.38, color: colors.text }]}>
              {initials}
            </Text>
          ) : (
            <Feather name="user" size={size * 0.48} color={colors.textMuted} />
          )}
        </View>
      )}
      {label ? (
        <Text numberOfLines={1} style={[styles.label, { color: colors.text }]}>
          {label}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initials: {
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  label: {
    fontSize: 10,
    maxWidth: 70,
    textAlign: 'center',
    fontWeight: '600',
  },
});
