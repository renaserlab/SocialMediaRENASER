import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';
import { Feather } from '@expo/vector-icons';

import { Button } from '@/components/Button';
import { ScrimDeMedio, SuperficieSobreMedio, sobreMedio } from '@/components/CapaDeContraste';
import { Text } from '@/components/Text';
import { radius, spacing } from '@/theme/tokens';
import { useTranslation } from '@/i18n/useTranslation';

const media = sobreMedio;

/**
 * CONFIRMAR EL ENCUADRE de la foto de perfil o de la portada.
 *
 * ===========================================================================
 * QUE ARREGLA Y QUE NO.
 *
 * La pantalla de la que habla el informe —«los botones superiores para
 * personalización no son fácilmente visibles… tampoco se puede observar bien el
 * símbolo de cortar»— NO ES NUESTRA. Es el editor del SISTEMA OPERATIVO, el que
 * abre `expo-image-picker` con `allowsEditing: true` (ver `services/storage.ts`
 * y la llamada de `ProfileScreen.applyPhoto`). Sus iconos, su tijera y su barra
 * superior los dibuja iOS o Android con su propio tema: desde la aplicacion no
 * se pueden recolorear, mover ni etiquetar. Cualquier promesa de haberlos
 * arreglado seria falsa.
 *
 * Lo que si esta en nuestra mano es el paso SIGUIENTE: enseñar el resultado
 * dentro del marco real —cuadrado para el avatar, 16:9 para la portada— con
 * acciones que se lean sobre CUALQUIER foto, y dejar volver atras sin salir del
 * flujo. Asi, cuando el editor nativo se entienda mal (o cuando iOS imponga su
 * recorte cuadrado a una portada apaisada, que es un caso real documentado en
 * `PickImageOptions`), el error se ve AQUI y se corrige en un toque.
 *
 * AQUI NO SE RECORTAN PIXELES. No hay `expo-image-manipulator` ni ninguna otra
 * libreria de imagen en el proyecto, y no se añade: seria una dependencia
 * nativa nueva y una compilacion nueva por un recuadro. Se sube el archivo tal
 * cual y se encuadra con `contentFit="cover"`, que es EXACTAMENTE como se
 * pintan despues el avatar y la portada. Lo que se ve aqui es lo que se vera.
 * ===========================================================================
 */

type Forma = 'avatar' | 'portada';

/** El marco de cada sitio, igual que en el perfil. */
const PROPORCION: Record<Forma, number> = {
  avatar: 1,
  portada: 16 / 9,
};

type Props = {
  /** Fichero local ya elegido (y ya pasado por el editor del sistema). */
  uri: string;
  forma: Forma;
  /** Aceptar el encuadre. */
  alConfirmar: () => void;
  /** Volver a elegir otra foto. */
  alCancelar: () => void;
  /** Mientras se sube. */
  ocupado?: boolean;
};

/**
 * Se pinta A PANTALLA COMPLETA sobre lo que haya: quien la usa la monta cuando
 * hay foto que confirmar y la desmonta al terminar. No trae `Modal` propio a
 * proposito —en iOS presentar una pantalla nativa encima de otra que se esta
 * cerrando es justo lo que rompio el selector una vez (ver `applyPhoto`)—.
 */
export function ConfirmarRecorte({ uri, forma, alConfirmar, alCancelar, ocupado = false }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const titulo = forma === 'avatar' ? t('profile.avatarPhoto') : t('profile.coverPhoto');

  return (
    <View style={styles.raiz}>
      {/*
        LA CABECERA TAMBIEN SE APAGA. Es el fallo que se esta corrigiendo: unos
        controles arriba, sin fondo, encima de una imagen que puede ser blanca.
      */}
      <ScrimDeMedio borde="arriba" alto={160} />

      <View style={[styles.cabecera, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable
          onPress={alCancelar}
          hitSlop={12}
          style={styles.redondo}
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
        >
          <Feather name="arrow-left" size={22} color={media.text} />
        </Pressable>
        <SuperficieSobreMedio forma="pildora">
          <Feather name={forma === 'avatar' ? 'user' : 'image'} size={13} color={media.text} />
          <Text variant="secondary" weight="700" color={media.text}>
            {titulo}
          </Text>
        </SuperficieSobreMedio>
        {/* Hueco simetrico al boton de volver, para que el titulo quede centrado. */}
        <View style={styles.redondo} />
      </View>

      {/*
        EL MARCO ES LA EXPLICACION. No hace falta una frase que diga «se
        recortara»: se ve el recorte. `cover` es el mismo ajuste con el que se
        pintan el avatar y la portada en el perfil.
      */}
      <View style={styles.centro}>
        <View
          style={[
            styles.marco,
            { aspectRatio: PROPORCION[forma] },
            forma === 'avatar' ? styles.marcoAvatar : styles.marcoPortada,
          ]}
        >
          <ExpoImage
            source={{ uri }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            accessibilityLabel={titulo}
          />
        </View>
      </View>

      <ScrimDeMedio alto={240} />

      <View style={[styles.pie, { paddingBottom: Math.max(insets.bottom, spacing.md) + spacing.md }]}>
        <Button
          label={t('common.save')}
          variant="secondary"
          icon="check"
          onPress={alConfirmar}
          loading={ocupado}
          disabled={ocupado}
        />
        <Pressable
          onPress={alCancelar}
          disabled={ocupado}
          style={styles.otra}
          accessibilityRole="button"
          accessibilityLabel={t('create.chooseSomethingElse')}
        >
          <Feather name="image" size={14} color={media.text} />
          <Text variant="secondary" weight="700" color={media.text}>
            {t('create.chooseSomethingElse')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  raiz: { ...StyleSheet.absoluteFillObject, backgroundColor: media.background },
  cabecera: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  redondo: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: media.overlay,
    borderWidth: 1,
    borderColor: media.glassBorder,
  },
  centro: { flex: 1, justifyContent: 'center', paddingHorizontal: spacing.lg },
  marco: {
    width: '100%',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: media.glassBorder,
    backgroundColor: media.surface,
  },
  // El avatar se pinta redondo en el perfil, pero el recorte que se guarda es
  // cuadrado: el marco lo enseña cuadrado para no prometer de menos.
  marcoAvatar: { alignSelf: 'center', maxWidth: 320, borderRadius: radius.lg },
  marcoPortada: { borderRadius: radius.md },
  pie: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: 0,
    gap: spacing.sm,
  },
  otra: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    // 44 px de alto: es un boton, no una nota al pie.
    minHeight: 44,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
  },
});
