import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { sobreMedio } from '@/components/CapaDeContraste';
import { Input } from '@/components/Input';
import { RotuloDeDirecto } from '@/components/live/RotuloDeDirecto';
import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import type { DestacadoEnPantalla } from '@/hooks/useDestacadoDeDirecto';
import { useReduceMotion } from '@/hooks/useReduceMotion';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import {
  ESTILOS_DE_ROTULO,
  ESTILO_POR_OMISION,
  MAXIMO_DE_ROTULO,
  juzgarRotulo,
  largoDelRotulo,
  limpiarRotulo,
  type EstiloDeRotulo,
} from '@/live/destacado';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const NOMBRE_DEL_ESTILO: Record<EstiloDeRotulo, TranslationKey> = {
  slide: 'live.bannerStyleSlide',
  pulse: 'live.bannerStylePulse',
  ticker: 'live.bannerStyleTicker',
};

/**
 * Lo que admite el campo, en unidades de teclado. Bastante más que el tope: el
 * tope de verdad se mide por caracteres y después de limpiar, y un emoji ocupa
 * dos de estas. Cortar aquí en 80 impediría escribir ochenta emojis que caben.
 */
const TOPE_DEL_CAMPO = MAXIMO_DE_ROTULO * 4;

type Props = {
  visible: boolean;
  alCerrar: () => void;
  destacar: DestacadoEnPantalla;
};

/**
 * Poner, cambiar o quitar el texto que quien emite enseña sobre la imagen.
 *
 * QUIÉN LA VE. Solo quien gestiona la emisión, y solo si el servidor admite
 * destacar.
 *
 * SE VE ANTES DE MANDARLO. La muestra de abajo es el MISMO componente que verá
 * la sala, con el texto ya limpio —una línea, sin espacios de más— y con el
 * movimiento elegido: lo que se aprueba aquí es lo que sale.
 *
 * EL CONTADOR CUENTA LO QUE CUENTA EL SERVIDOR (`live/destacado.ts`): por
 * caracteres y después de limpiar. Si contara otra cosa, diría «cabe» de un
 * texto que el servidor va a rechazar.
 */
export function HojaDeRotulo({ visible, alCerrar, destacar }: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const reduceMotion = useReduceMotion();
  const puesto = destacar.destacado.rotulo;

  const [texto, setTexto] = useState('');
  const [estilo, setEstilo] = useState<EstiloDeRotulo>(ESTILO_POR_OMISION);

  // Al abrir se parte de lo que hay puesto: lo normal es corregirlo, no
  // escribirlo otra vez desde cero.
  useEffect(() => {
    if (!visible) return;
    setTexto(puesto?.texto ?? '');
    setEstilo(puesto?.estilo ?? ESTILO_POR_OMISION);
    // Solo al abrir: si el rótulo cambia con la hoja abierta no se le pisa a
    // la persona lo que está escribiendo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const limpio = limpiarRotulo(texto);
  const largo = largoDelRotulo(limpiarRotulo(texto));
  const juicio = juzgarRotulo(texto);
  const sobran = largo - MAXIMO_DE_ROTULO;
  const sinCambios = Boolean(puesto) && puesto?.texto === limpio && puesto?.estilo === estilo;

  const mostrar = async () => {
    if (juicio !== 'vale') return;
    if (await destacar.ponerRotulo(limpio, estilo)) alCerrar();
  };

  const quitar = async () => {
    if (await destacar.quitarRotulo()) alCerrar();
  };

  return (
    <BottomSheet visible={visible} onClose={alCerrar}>
      <View style={estilos.columna}>
      <Text variant="titleMedium" weight="800">
        {t('live.bannerTitle')}
      </Text>
      <Text variant="secondary" color={colors.textMuted}>
        {t('live.bannerBody', { n: MAXIMO_DE_ROTULO })}
      </Text>

      <Input
        value={texto}
        onChangeText={setTexto}
        placeholder={t('live.bannerPlaceholder')}
        accessibilityLabel={t('live.bannerTitle')}
        icono="type"
        maxLength={TOPE_DEL_CAMPO}
        returnKeyType="done"
        autoFocus={!puesto}
        error={juicio === 'largo' ? t('live.bannerTooLong', { n: sobran }) : undefined}
      />
      <Text
        variant="caption"
        weight="700"
        color={juicio === 'largo' ? colors.danger : colors.textMuted}
        style={estilos.contador}
        accessibilityLiveRegion="polite"
      >
        {largo}/{MAXIMO_DE_ROTULO}
      </Text>

      <Text variant="caption" weight="800" color={colors.textMuted}>
        {t('live.bannerStyle')}
      </Text>
      <View style={estilos.estilos} accessibilityRole="radiogroup">
        {ESTILOS_DE_ROTULO.map((opcion) => {
          const elegido = opcion === estilo;
          return (
            <Pulsable
              key={opcion}
              onPress={() => setEstilo(opcion)}
              accessibilityRole="radio"
              accessibilityState={{ selected: elegido }}
              style={[
                estilos.opcion,
                {
                  borderColor: elegido ? colors.text : colors.border,
                  backgroundColor: elegido ? colors.text : 'transparent',
                },
              ]}
            >
              <Text variant="secondary" weight="800" color={elegido ? colors.background : colors.text}>
                {t(NOMBRE_DEL_ESTILO[opcion])}
              </Text>
            </Pulsable>
          );
        })}
      </View>

      {juicio === 'vale' ? (
        <View style={estilos.muestra}>
          <Text variant="caption" weight="800" color={sobreMedio.textMuted}>
            {t('live.bannerPreview')}
          </Text>
          <RotuloDeDirecto
            // Una muestra nueva por texto y por estilo: así se ve entrar.
            key={`${estilo}|${limpio}`}
            rotulo={{ texto: limpio, estilo, puestoEnIso: null }}
            reduceMotion={reduceMotion}
            etiqueta={limpio}
          />
        </View>
      ) : null}

      <Button
        label={puesto ? t('live.bannerUpdate') : t('live.bannerShow')}
        icon="volume-2"
        onPress={mostrar}
        disabled={juicio !== 'vale' || sinCambios || destacar.ocupado}
      />
      {puesto ? (
        <Button
          label={t('live.bannerRemove')}
          variant="secondary"
          icon="x"
          onPress={quitar}
          disabled={destacar.ocupado}
        />
      ) : null}
      </View>
    </BottomSheet>
  );
}

const estilos = StyleSheet.create({
  columna: { gap: spacing.md },
  contador: { textAlign: 'right', marginTop: -spacing.sm },
  estilos: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  opcion: {
    minHeight: 40,
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
  },
  // La muestra va sobre oscuro en los dos temas: así es como se verá, encima
  // del vídeo, tenga la persona la aplicación en claro o en oscuro.
  muestra: {
    gap: spacing.xs,
    backgroundColor: sobreMedio.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    overflow: 'hidden',
  },
});
