import React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { ListaDeReacciones } from '@/components/ListaDeReacciones';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * Quién reaccionó a una publicación, como PANTALLA.
 *
 * SIGUE EXISTIENDO AUNQUE EL FEED YA NO LA USE. Desde una publicación se abre
 * ahora una hoja (`ReaccionesSheet`), que no pierde el contexto. Pero esta
 * pantalla es la ENTRADA DIRECTA: un aviso agrupado —«Edson y 99 personas
 * más»— o un enlace no tienen ninguna publicación abierta detrás sobre la que
 * levantar una hoja, y necesitan un sitio propio al que llegar.
 *
 * El contenido es el mismo objeto en los dos casos (`ListaDeReacciones`): la
 * misma consulta y el mismo estado. Aquí solo se añade el marco de pantalla
 * —cabecera y forma de volver— que la hoja no necesita.
 */
export function ReaccionesScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title={t('post.reactions')}
        // Si se llega desde un aviso puede no haber a donde volver: en ese caso
        // se cae a la publicacion, que es el contexto de lo que se esta viendo.
        onBack={() =>
          router.canGoBack()
            ? router.back()
            : router.replace((id ? `/post/${id}` : '/(tabs)/home') as never)
        }
      />
      <ListaDeReacciones postId={id} />
    </View>
  );
}
