import React, { useEffect, useState } from 'react';
import { BackHandler, Platform, Pressable, StyleSheet, View } from 'react-native';
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
 * La pantalla de recorte que sale al elegir la foto NO ES NUESTRA: es el editor
 * del SISTEMA OPERATIVO (`expo-image-picker` con `allowsEditing`). Sus iconos y
 * su tijera los dibuja iOS o Android, no se pueden tematizar desde aqui y NO se
 * han tocado. Esto es el paso siguiente: ver el resultado en el marco real
 * —1:1 el avatar, 16:9 la portada— y poder volver atras en un toque.
 *
 * AQUI NO SE RECORTAN PIXELES: se sube el archivo tal cual y se encuadra con
 * `contentFit="cover"`, igual que despues lo pintan el avatar y la portada.
 */

/**
 * Lo que se supone que ocupan cabecera y pie MIENTRAS no se han medido, o sea
 * durante el primer fotograma. Despues manda la medida real.
 *
 * Eran las alturas definitivas, y eso era el fallo: cabecera y pie flotan sobre
 * la foto y CRECEN con el tamano de letra del sistema. Con la letra grande de
 * accesibilidad el boton de guardar se subia por encima del marco y tapaba
 * justo lo que hay que mirar antes de decidir.
 */
const ALTO_CABECERA_MINIMO = 60;
const ALTO_PIE_MINIMO = 132;

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
 * ES LA PANTALLA ENTERA, no una capa encima. Quien la usa la devuelve en lugar
 * de su contenido (`ProfileScreen`), asi que no hay hermanos que puedan pintarse
 * despues y quedarse los toques. Sin `Modal` propio: apilar uno sobre la hoja
 * que se acaba de cerrar es lo que rompio el selector una vez (ver `applyPhoto`).
 */
export function ConfirmarRecorte({ uri, forma, alConfirmar, alCancelar, ocupado = false }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const titulo = forma === 'avatar' ? t('profile.avatarPhoto') : t('profile.coverPhoto');

  // MEDIDOS, no supuestos. Incluyen ya sus propios rellenos de zona segura, asi
  // que el hueco del marco es la altura tal cual, sin volver a sumar `insets`.
  const [altoCabecera, setAltoCabecera] = useState<number | null>(null);
  const [altoPie, setAltoPie] = useState<number | null>(null);
  const huecoArriba = altoCabecera ?? insets.top + ALTO_CABECERA_MINIMO;
  const huecoAbajo = altoPie ?? insets.bottom + ALTO_PIE_MINIMO;

  // Atras fisico = cancelar, no salir del perfil. Mientras sube se traga el
  // evento: irse a medias dejaria la subida sin pantalla a la que volver.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const suscripcion = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!ocupado) alCancelar();
      return true;
    });
    return () => suscripcion.remove();
  }, [alCancelar, ocupado]);

  return (
    <View style={styles.raiz}>
      {/*
        LA CABECERA TAMBIEN SE APAGA. Es el fallo que se esta corrigiendo: unos
        controles arriba, sin fondo, encima de una imagen que puede ser blanca.
      */}
      {/* El degradado cubre lo que ocupen los controles, no una altura fija. */}
      <ScrimDeMedio borde="arriba" alto={Math.max(160, huecoArriba + 40)} />

      <View
        style={[styles.cabecera, { paddingTop: insets.top + spacing.sm }]}
        onLayout={(evento) => {
          const alto = Math.ceil(evento.nativeEvent.layout.height);
          setAltoCabecera((previo) => (previo === alto ? previo : alto));
        }}
      >
        <Pressable
          onPress={alCancelar}
          disabled={ocupado}
          hitSlop={12}
          style={[styles.redondo, ocupado ? styles.apagado : null]}
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
          accessibilityState={{ disabled: ocupado }}
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
      <View
        style={[
          styles.centro,
          // Hueco para la cabecera y el pie, que van flotando sobre la foto.
          { paddingTop: huecoArriba, paddingBottom: huecoAbajo },
        ]}
      >
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

      <ScrimDeMedio alto={Math.max(240, huecoAbajo + 40)} />

      <View
        style={[styles.pie, { paddingBottom: Math.max(insets.bottom, spacing.md) + spacing.md }]}
        onLayout={(evento) => {
          const alto = Math.ceil(evento.nativeEvent.layout.height);
          setAltoPie((previo) => (previo === alto ? previo : alto));
        }}
      >
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
          style={[styles.otra, ocupado ? styles.apagado : null]}
          accessibilityRole="button"
          accessibilityLabel={t('create.chooseSomethingElse')}
          accessibilityState={{ disabled: ocupado }}
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
  // `flex: 1`, no `absoluteFill`: es la raiz de la pantalla, no una capa que
  // depende de que nadie se pinte despues.
  raiz: { flex: 1, backgroundColor: media.background },
  apagado: { opacity: 0.5 },
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
