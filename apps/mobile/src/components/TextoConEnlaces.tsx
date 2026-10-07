import React, { useCallback, useMemo } from 'react';
import { Linking, Platform, type StyleProp, type TextStyle } from 'react-native';
import { useRouter } from 'expo-router';

import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { rutaInternaDe } from '@/lib/enlaces';
import { colorDelEnlace, partirEnEnlaces } from '@/lib/enlacesEnTexto';
import { toast } from '@/lib/toast';

/**
 * Un texto en el que los enlaces se ven como enlaces y se abren con un toque.
 *
 * Pedido el 07/10/2026 para los mensajes: el enlace de una reunión pegado en un
 * chat tiene que poder tocarse, «tal cual pasa en WhatsApp».
 *
 * QUÉ ES UN ENLACE lo decide `lib/enlacesEnTexto`, que está probado. Aquí solo
 * se pinta cada trozo y se abre el que se toca:
 *
 *   · un enlace de la propia web de Z a algo que la aplicación sabe abrir —un
 *     directo, una publicación— se abre DENTRO, sin sacar a nadie al navegador;
 *   · cualquier otro, con lo que el teléfono tenga para abrirlo.
 *
 * SIN ENLACES NO CAMBIA NADA: se pinta el texto en un solo `Text`, como antes.
 */
type Props = {
  texto: string;
  /** El estilo del texto. Su `color` decide el del enlace: claro sobre oscuro y al revés. */
  style?: StyleProp<TextStyle>;
  /** El color de la letra, para elegir el del enlace sin tener que leer el estilo. */
  colorDelTexto: string;
};

export function TextoConEnlaces({ texto, style, colorDelTexto }: Props) {
  const { t } = useTranslation();
  const router = useRouter();
  const trozos = useMemo(() => partirEnEnlaces(texto), [texto]);
  const hayEnlaces = trozos.some((trozo) => trozo.tipo === 'enlace');

  const abrir = useCallback(
    (direccion: string) => {
      const ruta = rutaInternaDe(direccion);
      if (ruta) {
        router.push(ruta as never);
        return;
      }
      Linking.openURL(direccion).catch(() => {
        toast(t('chat.linkFailed'), 'alert-circle');
      });
    },
    [router, t],
  );

  if (!hayEnlaces) return <Text style={style}>{texto}</Text>;

  const colorDeEnlace = colorDelEnlace(colorDelTexto);

  return (
    <Text style={style}>
      {trozos.map((trozo, indice) =>
        trozo.tipo === 'texto' ? (
          trozo.texto
        ) : (
          <Text
            // El índice basta: la lista sale entera del mismo texto, en orden.
            key={indice}
            onPress={() => abrir(trozo.direccion)}
            // En web un `link` es un <a>, y este texto va dentro de la zona
            // pulsable de la burbuja: un <a> dentro de un <button> no es HTML
            // válido. En el teléfono sí se anuncia como enlace.
            accessibilityRole={Platform.OS === 'web' ? undefined : 'link'}
            accessibilityHint={t('chat.openLink')}
            style={[style, { color: colorDeEnlace, textDecorationLine: 'underline' }]}
          >
            {trozo.texto}
          </Text>
        ),
      )}
    </Text>
  );
}
