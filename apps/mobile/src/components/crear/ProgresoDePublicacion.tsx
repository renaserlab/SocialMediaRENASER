import React, { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { sobreMedio } from '@/components/CapaDeContraste';
import { Text } from '@/components/Text';
import type { FaseDePublicacion } from '@/hooks/usePublicacion';
import type { TranslationKey } from '@/i18n';
import { DURACION } from '@/lib/movimiento';
import { radius, spacing } from '@/theme/tokens';
import { useTranslation } from '@/i18n/useTranslation';

const media = sobreMedio;

// Estaba escrito en español dentro del componente: quien tuviera la aplicación
// en inglés o portugués leía «Subiendo…» igual.
const CLAVE: Partial<Record<FaseDePublicacion, TranslationKey>> = {
  comprimiendo: 'editPost.optimizing',
  subiendo: 'editPost.uploading',
  publicando: 'common.loading',
};

// El estado no se cuenta SOLO con color: icono + texto + porcentaje + barra.
const ICONO: Partial<Record<FaseDePublicacion, keyof typeof Feather.glyphMap>> = {
  comprimiendo: 'minimize-2',
  subiendo: 'upload-cloud',
  publicando: 'send',
};

type Props = {
  fase: FaseDePublicacion;
  progreso: number;
  error: string | null;
  puedeReintentar: boolean;
  alReintentar: () => void;
  alCancelar: () => void;
  /** Paleta clara para el editor de texto; oscura sobre la camara. */
  sobreOscuro?: boolean;
  colores?: { texto: string; suave: string; borde: string; peligro: string; fondo?: string };
};

/**
 * Lo que pasa mientras algo se publica, y que hacer si sale mal.
 *
 * Sin esto, subir un video de dos minutos era un boton girando: nadie sabia si
 * quedaba mucho, si se habia colgado, ni que hacer cuando fallaba salvo
 * empezar de cero —y volver a empezar es justo lo que produce publicaciones
 * duplicadas—. Aqui siempre hay tres cosas: en que va, cuanto lleva y una
 * salida (cancelar mientras sube, reintentar si fallo).
 */
/**
 * El relleno de la barra, que AVANZA en vez de saltar.
 *
 * El progreso de una subida llega a golpes —un 12 %, luego un 31 %— y pintado
 * tal cual la barra daba tirones que parecian cuelgues. Aqui cada valor nuevo
 * se alcanza deslizando; con «reducir movimiento» se pone en su sitio sin mas.
 */
function RellenoAnimado({ progreso, color }: { progreso: number; color: string }) {
  const reducir = useReducedMotion();
  const avance = useSharedValue(progreso);
  useEffect(() => {
    avance.value = reducir ? progreso : withTiming(progreso, { duration: DURACION.normal });
  }, [progreso, avance, reducir]);
  const animado = useAnimatedStyle(() => ({ width: `${Math.max(2, avance.value * 100)}%` }));
  return <Animated.View style={[styles.relleno, { backgroundColor: color }, animado]} />;
}

export function ProgresoDePublicacion({
  fase,
  progreso,
  error,
  puedeReintentar,
  alReintentar,
  alCancelar,
  sobreOscuro = true,
  colores,
}: Props) {
  const { t } = useTranslation();
  const c = colores ?? {
    texto: media.text,
    suave: media.textMuted,
    // `border` del tema oscuro es casi negro y sobre una foto no se ve: el
    // borde de esta caja tiene que separarla del MEDIO, no de un fondo.
    borde: media.glassBorder,
    peligro: media.danger,
  };

  /*
    EL FONDO ES EL ARREGLO. La caja no tenia ninguno: era un borde de 1 px y
    letras sueltas encima del video, y por eso «Subiendo… / Cancelar» resultaba
    ilegible sobre cualquier imagen clara. Ahora se apoya en una superficie.
  */
  const fondo = c.fondo ?? (sobreOscuro ? media.overlay : 'transparent');

  if (fase === 'error') {
    return (
      <View style={[styles.caja, { borderColor: c.peligro, backgroundColor: fondo }]}>
        <Feather name="alert-triangle" size={18} color={c.peligro} />
        <View style={styles.contenido}>
          <Text variant="secondary" weight="700" color={c.peligro}>
            {error ?? t('create.publishFailed')}
          </Text>
          {puedeReintentar ? (
            <Pressable
              onPress={alReintentar}
              style={[styles.boton, { borderColor: c.suave }]}
              accessibilityRole="button"
              accessibilityLabel={t('common.retry')}
            >
              <Text variant="secondary" weight="700" color={c.texto}>
                {t('common.retry')}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }

  const enMarcha = fase === 'comprimiendo' || fase === 'subiendo' || fase === 'publicando';
  if (!enMarcha) return null;

  const clave = CLAVE[fase];
  const icono = ICONO[fase];
  const porcentaje = Math.round(progreso * 100);

  return (
    <View style={[styles.caja, { borderColor: c.borde, backgroundColor: fondo }]}>
      {icono ? <Feather name={icono} size={18} color={c.texto} /> : null}
      <View style={styles.contenido}>
        <View style={styles.fila}>
          {/*
            El estado va en el color de texto PRINCIPAL, no en el apagado: sobre
            un medio, un gris medio es lo primero que se pierde.
          */}
          <Text variant="secondary" weight="700" color={c.texto}>
            {clave ? t(clave) : ''}
          </Text>
          {fase !== 'publicando' ? (
            <Text variant="secondary" weight="700" color={c.texto}>
              {porcentaje}%
            </Text>
          ) : null}
        </View>
        <View style={[styles.pista, { backgroundColor: sobreOscuro ? media.glassBorder : c.borde }]}>
          <RellenoAnimado progreso={progreso} color={c.texto} />
        </View>
        {/*
          Cancelar solo mientras hay algo que cancelar. Durante «Publicando» ya
          se ha soltado la peticion al servidor y ofrecer una salida que no
          existe seria peor que no ofrecerla.

          Con borde y 44 px de alto: era una palabra suelta de 11 px sobre el
          video, imposible de ver y de acertar.
        */}
        {fase !== 'publicando' ? (
          <Pressable
            onPress={alCancelar}
            hitSlop={8}
            style={[styles.boton, styles.cancelar, { borderColor: c.suave }]}
            accessibilityRole="button"
            accessibilityLabel={t('common.cancel')}
          >
            <Feather name="x" size={14} color={c.texto} />
            <Text variant="secondary" weight="700" color={c.texto}>
              {t('common.cancel')}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  caja: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  contenido: { flex: 1, gap: spacing.sm },
  fila: { flexDirection: 'row', justifyContent: 'space-between' },
  pista: { height: 6, borderRadius: radius.pill, overflow: 'hidden' },
  relleno: { height: '100%', borderRadius: radius.pill },
  boton: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    // 44 px es el minimo tactil. Cancelar tenia 32 y ninguna forma visible.
    minHeight: 44,
    justifyContent: 'center',
  },
  cancelar: { marginTop: spacing.xs },
});
