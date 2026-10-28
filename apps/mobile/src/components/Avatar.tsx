import React from 'react';
import { ImageSourcePropType, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import Feather from '@expo/vector-icons/Feather';

import { Text } from '@/components/Text';
import { assets } from '@/data/assets';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  size?: number;
  label?: string;
  image?: keyof typeof assets | ImageSourcePropType | null;
  name?: string;
  /**
   * De QUIEN es la foto (su id), solo en filas que una lista RECICLA
   * (FlashList). Ver el comentario donde se usa.
   */
  recyclingKey?: string;
};

export function Avatar({ size = 44, label, image, name, recyclingKey }: Props) {
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
        /*
          `expo-image` y no el `Image` de React Native: este componente es el
          mas repetido de la app —sale en cada publicacion, cada comentario,
          cada conversacion y cada lista de miembros—, y el de React Native no
          guarda las imagenes en cache. Cada vez que una fila volvia a
          renderizarse, la foto se descargaba otra vez.
        */
        <ExpoImage
          source={source}
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: colors.surfaceAlt,
            borderWidth: 1,
            borderColor: colors.border,
          }}
          contentFit="cover"
          cachePolicy="memory-disk"
          // Sin transicion el cambio es brusco; con una larga se nota lento.
          transition={120}
          /*
            EN UNA FILA RECICLADA, LA CARA DE LA FILA DE ANTES. FlashList no
            crea una fila nueva al desplazarse: reutiliza la que salio por
            arriba con los datos de la que entra. Sin `recyclingKey`, la foto
            anterior se quedaba puesta hasta que llegaba la nueva, y durante ese
            instante un mensaje salia con la cara de otra persona. Con la clave,
            al cambiar de persona se vacia primero.

            Solo si quien llama la pasa, y no por defecto con la URL: fuera de
            las listas, cambiar de foto —la vista previa recien elegida que pasa
            a ser la subida, en Editar perfil— vaciaria el circulo un instante
            en vez de fundir una foto con la otra, como hace ahora.
          */
          recyclingKey={recyclingKey}
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
