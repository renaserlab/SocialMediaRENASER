import React from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import type { DestacadoEnPantalla } from '@/hooks/useDestacadoDeDirecto';
import { estiloDeLaLetra, useLetrasDelRotulo } from '@/hooks/useLetrasDelRotulo';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import {
  COLORES_DE_ROTULO,
  ESTILOS_DE_ROTULO,
  FONDOS_DE_ROTULO,
  GIRO_MAXIMO,
  LETRAS_DE_ROTULO,
  MAXIMO_DE_ROTULO,
  PASO_DE_TAMANO,
  TAMANO_MAXIMO,
  TAMANO_MINIMO,
  juzgarRotulo,
  largoDelRotulo,
  limpiarRotulo,
  type ColorDeRotulo,
  type EstiloDeRotulo,
  type FondoDeRotulo,
  type LetraDeRotulo,
  type Presentacion,
} from '@/live/destacado';
import { ajustarTamano, pasoDeGiro } from '@/live/rotuloEnPantalla';
import { radius, rotuloDeDirecto, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const NOMBRE_DEL_ESTILO: Record<EstiloDeRotulo, TranslationKey> = {
  slide: 'live.bannerStyleSlide',
  pulse: 'live.bannerStylePulse',
  ticker: 'live.bannerStyleTicker',
};

const NOMBRE_DEL_COLOR: Record<ColorDeRotulo, TranslationKey> = {
  blanco: 'live.bannerColorWhite',
  negro: 'live.bannerColorBlack',
  esmeralda: 'live.bannerColorEmerald',
  oro: 'live.bannerColorGold',
  rojo: 'live.bannerColorRed',
  azul: 'live.bannerColorBlue',
  amarillo: 'live.bannerColorYellow',
  rosa: 'live.bannerColorPink',
};

const NOMBRE_DEL_FONDO: Record<FondoDeRotulo, TranslationKey> = {
  ninguno: 'live.bannerBackgroundNone',
  velo: 'live.bannerBackgroundVeil',
  solido: 'live.bannerBackgroundSolid',
};

const NOMBRE_DE_LA_LETRA: Record<LetraDeRotulo, TranslationKey> = {
  clasica: 'live.bannerFontClassic',
  fuerte: 'live.bannerFontBold',
  maquina: 'live.bannerFontTypewriter',
};

/** Lo que gira cada toque de −/+ en la hoja. */
const PASO_DE_GIRO = 5;

/**
 * Lo que admite el campo, en unidades de teclado. Bastante más que el tope: el
 * tope de verdad se mide por caracteres y después de limpiar, y un emoji ocupa
 * dos de estas. Cortar aquí en 80 impediría escribir ochenta emojis que caben.
 */
const TOPE_DEL_CAMPO = MAXIMO_DE_ROTULO * 4;

/** Lo que se está editando: el texto, su movimiento y su presentación. */
export type BorradorDeRotulo = {
  texto: string;
  estilo: EstiloDeRotulo;
  presentacion: Presentacion;
};

type Props = {
  visible: boolean;
  /** Cerrar SIN mandar: lo cambiado se descarta, como siempre. */
  alCerrar: () => void;
  destacar: DestacadoEnPantalla;
  borrador: BorradorDeRotulo;
  /** Cada cambio, al momento: la pantalla lo pinta detrás de la hoja. */
  alCambiar: (borrador: BorradorDeRotulo, opciones?: { entra?: boolean }) => void;
  /** «Quitar»: la pantalla cierra la hoja, lo quita y ofrece deshacer. */
  alQuitar: () => void;
  /** Cuánto ocupa la hoja desde abajo, para que el texto suba si queda debajo. */
  alMedirAlto?: (alto: number) => void;
};

/**
 * Poner, cambiar o quitar el texto que quien emite enseña sobre la imagen.
 *
 * QUIÉN LA VE. Solo quien gestiona la emisión, y solo si el servidor admite
 * destacar.
 *
 * LO QUE SE CAMBIA SE VE AL MOMENTO, DETRÁS. El host no necesita una muestra:
 * el texto de la pantalla —detrás de un velo suave— cambia con cada letra y
 * cada opción, y si la hoja lo tapa, sube. La SALA no ve nada hasta pulsar
 * «Actualizar el texto». Cerrar sin pulsarlo lo descarta, como siempre.
 *
 * CON LA 0114 (`rotuloEditable`) se elige además color, fondo, letra, tamaño y
 * giro. Tamaño y giro con −/+: es lo que hace falta en la web y con un lector
 * de pantalla, donde no se puede pellizcar. Sin ella, la hoja de siempre:
 * texto y movimiento.
 *
 * EL CONTADOR CUENTA LO QUE CUENTA EL SERVIDOR (`live/destacado.ts`): por
 * caracteres y después de limpiar. Si contara otra cosa, diría «cabe» de un
 * texto que el servidor va a rechazar.
 */
export function HojaDeRotulo({
  visible,
  alCerrar,
  destacar,
  borrador,
  alCambiar,
  alQuitar,
  alMedirAlto,
}: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const puesto = destacar.destacado.rotulo;
  const editable = destacar.destacado.rotuloEditable;
  // Las letras propias se cargan al abrir la hoja: las opciones van escritas
  // cada una con la suya.
  const cargadas = useLetrasDelRotulo(visible && editable ? LETRAS_DE_ROTULO : []);

  const { texto, estilo, presentacion } = borrador;
  const limpio = limpiarRotulo(texto);
  const largo = largoDelRotulo(limpiarRotulo(texto));
  const juicio = juzgarRotulo(texto);
  const sobran = largo - MAXIMO_DE_ROTULO;
  const mismaPresentacion =
    !editable ||
    (puesto !== null &&
      puesto.presentacion.color === presentacion.color &&
      puesto.presentacion.fondo === presentacion.fondo &&
      puesto.presentacion.letra === presentacion.letra &&
      puesto.presentacion.tamano === presentacion.tamano &&
      puesto.presentacion.giro === presentacion.giro);
  const sinCambios =
    Boolean(puesto) && puesto?.texto === limpio && puesto?.estilo === estilo && mismaPresentacion;

  const cambiar = (parte: Partial<Presentacion>) =>
    alCambiar({ texto, estilo, presentacion: { ...presentacion, ...parte } });

  const mostrar = async () => {
    if (juicio !== 'vale') return;
    // Sin la posición: la hoja no lo mueve, y el sitio lo sabe el servidor.
    if (await destacar.ponerRotulo(limpio, estilo, editable ? presentacion : null, false)) alCerrar();
  };

  const medir = (evento: LayoutChangeEvent) => {
    if (!alMedirAlto) return;
    // Lo que añade la hoja compartida alrededor del contenido: el asa, sus
    // márgenes y el relleno de abajo, que sale de la zona segura
    // (`components/BottomSheet.tsx`).
    const alrededor = spacing.sm + 4 + spacing.md + 1 + Math.max(insets.bottom, spacing.md) + spacing.md;
    alMedirAlto(evento.nativeEvent.layout.height + alrededor);
  };

  return (
    <BottomSheet visible={visible} onClose={alCerrar} colorDelVelo={rotuloDeDirecto.veloDeLaHoja}>
      <View style={estilos.columna} onLayout={medir}>
        <View style={estilos.cabeza}>
          <Text variant="titleMedium" weight="800">
            {t('live.bannerTitle')}
          </Text>
          <Text variant="secondary" color={colors.textMuted}>
            {editable ? t('live.bannerLiveHint') : t('live.bannerBody', { n: MAXIMO_DE_ROTULO })}
          </Text>
        </View>

        <Input
          value={texto}
          onChangeText={(nuevo) => alCambiar({ texto: nuevo, estilo, presentacion })}
          placeholder={t('live.bannerPlaceholder')}
          accessibilityLabel={t('live.bannerTitle')}
          icono="type"
          maxLength={TOPE_DEL_CAMPO}
          returnKeyType="done"
          onSubmitEditing={() => void mostrar()}
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

        {editable ? (
          <>
            <Fila etiqueta={t('live.bannerColor')}>
              <View style={estilos.muestras} accessibilityRole="radiogroup">
                {COLORES_DE_ROTULO.map((color) => {
                  const elegido = color === presentacion.color;
                  return (
                    <Pulsable
                      key={color}
                      onPress={() => cambiar({ color })}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: elegido, checked: elegido }}
                      accessibilityLabel={t(NOMBRE_DEL_COLOR[color])}
                      escala={1}
                      style={[estilos.anillo, { borderColor: elegido ? colors.text : 'transparent' }]}
                    >
                      <View
                        style={[
                          estilos.muestra,
                          {
                            backgroundColor: rotuloDeDirecto.colores[color].relleno,
                            borderColor: colors.border,
                          },
                        ]}
                      />
                    </Pulsable>
                  );
                })}
              </View>
            </Fila>

            <Fila etiqueta={t('live.bannerBackground')}>
              <Opciones
                opciones={FONDOS_DE_ROTULO}
                elegida={presentacion.fondo}
                nombre={(fondo) => t(NOMBRE_DEL_FONDO[fondo])}
                alElegir={(fondo) => cambiar({ fondo })}
              />
            </Fila>

            <Fila etiqueta={t('live.bannerFont')}>
              <Opciones
                opciones={LETRAS_DE_ROTULO}
                elegida={presentacion.letra}
                nombre={(letra) => t(NOMBRE_DE_LA_LETRA[letra])}
                letra={(letra) => estiloDeLaLetra(letra, cargadas[letra])}
                alElegir={(letra) => cambiar({ letra })}
              />
            </Fila>

            <Fila etiqueta={t('live.bannerSize')}>
              <Regulador
                valor={presentacion.tamano}
                texto={`${presentacion.tamano} %`}
                minimo={TAMANO_MINIMO}
                maximo={TAMANO_MAXIMO}
                etiqueta={t('live.bannerSize')}
                menos={t('live.bannerSmaller')}
                mas={t('live.bannerBigger')}
                alCambiar={(paso) =>
                  cambiar({ tamano: ajustarTamano(presentacion.tamano + paso * PASO_DE_TAMANO) })
                }
              />
            </Fila>

            <Fila etiqueta={t('live.bannerRotation')}>
              <Regulador
                valor={presentacion.giro}
                texto={`${presentacion.giro}°`}
                minimo={-GIRO_MAXIMO}
                maximo={GIRO_MAXIMO}
                etiqueta={t('live.bannerRotation')}
                menos={t('live.bannerRotateLeft')}
                mas={t('live.bannerRotateRight')}
                alCambiar={(paso) => cambiar({ giro: pasoDeGiro(presentacion.giro, paso * PASO_DE_GIRO) })}
                alPulsarValor={presentacion.giro !== 0 ? () => cambiar({ giro: 0 }) : undefined}
                pistaDelValor={t('live.bannerStraighten')}
              />
            </Fila>
          </>
        ) : null}

        <Fila etiqueta={t('live.bannerStyle')}>
          <Opciones
            opciones={ESTILOS_DE_ROTULO}
            elegida={estilo}
            nombre={(opcion) => t(NOMBRE_DEL_ESTILO[opcion])}
            // Cambiar el movimiento se ve: el texto vuelve a entrar.
            alElegir={(opcion) => alCambiar({ texto, estilo: opcion, presentacion }, { entra: true })}
          />
        </Fila>

        <View style={estilos.botones}>
          {puesto ? (
            <Button
              label={t('live.bannerRemoveShort')}
              variant="secondary"
              icon="x"
              onPress={alQuitar}
              disabled={destacar.ocupado}
            />
          ) : null}
          <Button
            label={puesto ? t('live.bannerUpdate') : t('live.bannerShow')}
            icon="volume-2"
            onPress={mostrar}
            disabled={juicio !== 'vale' || sinCambios || destacar.ocupado}
            style={estilos.principal}
          />
        </View>
      </View>
    </BottomSheet>
  );
}

/** Una fila de la hoja: la etiqueta a la izquierda y el control a la derecha. */
function Fila({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }) {
  const { colors } = useAppTheme();
  return (
    <View style={estilos.fila}>
      <Text variant="caption" weight="800" color={colors.textMuted} style={estilos.etiqueta}>
        {etiqueta}
      </Text>
      <View style={estilos.control}>{children}</View>
    </View>
  );
}

/** Tres opciones, una elegida. */
function Opciones<T extends string>({
  opciones,
  elegida,
  nombre,
  letra,
  alElegir,
}: {
  opciones: readonly T[];
  elegida: T;
  nombre: (opcion: T) => string;
  letra?: (opcion: T) => object;
  alElegir: (opcion: T) => void;
}) {
  const { colors } = useAppTheme();
  return (
    <View style={estilos.opciones} accessibilityRole="radiogroup">
      {opciones.map((opcion) => {
        const marcada = opcion === elegida;
        return (
          <Pulsable
            key={opcion}
            onPress={() => alElegir(opcion)}
            accessibilityRole="radio"
            accessibilityState={{ selected: marcada, checked: marcada }}
            style={[
              estilos.opcion,
              {
                borderColor: marcada ? colors.text : colors.border,
                backgroundColor: marcada ? colors.text : 'transparent',
              },
            ]}
          >
            <Text
              variant="secondary"
              weight="700"
              numberOfLines={1}
              color={marcada ? colors.background : colors.text}
              style={letra ? letra(opcion) : null}
            >
              {nombre(opcion)}
            </Text>
          </Pulsable>
        );
      })}
    </View>
  );
}

/**
 * Un valor con −/+. Para un lector de pantalla es un control ajustable: se
 * sube y se baja deslizando arriba y abajo, como cualquier regulador.
 */
function Regulador({
  valor,
  texto,
  minimo,
  maximo,
  etiqueta,
  menos,
  mas,
  alCambiar,
  alPulsarValor,
  pistaDelValor,
}: {
  valor: number;
  texto: string;
  minimo: number;
  maximo: number;
  etiqueta: string;
  menos: string;
  mas: string;
  alCambiar: (paso: -1 | 1) => void;
  alPulsarValor?: () => void;
  pistaDelValor?: string;
}) {
  const { colors } = useAppTheme();
  const boton = (paso: -1 | 1, nombre: string, desactivado: boolean) => (
    <Pulsable
      onPress={() => alCambiar(paso)}
      accessibilityRole="button"
      accessibilityLabel={nombre}
      accessibilityState={{ disabled: desactivado }}
      disabled={desactivado}
      style={[estilos.paso, { borderColor: colors.border, opacity: desactivado ? 0.4 : 1 }]}
    >
      <Feather name={paso < 0 ? 'minus' : 'plus'} size={16} color={colors.text} />
    </Pulsable>
  );
  return (
    <View style={estilos.regulador}>
      {boton(-1, menos, valor <= minimo)}
      {/* Sin `disabled`: un regulador apagado no se deja ajustar con VoiceOver. */}
      <Pulsable
        onPress={alPulsarValor}
        escala={1}
        accessibilityRole="adjustable"
        accessibilityLabel={etiqueta}
        accessibilityHint={alPulsarValor ? pistaDelValor : undefined}
        accessibilityValue={{ min: minimo, max: maximo, now: valor, text: texto }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(evento) => {
          if (evento.nativeEvent.actionName === 'increment' && valor < maximo) alCambiar(1);
          if (evento.nativeEvent.actionName === 'decrement' && valor > minimo) alCambiar(-1);
        }}
        style={estilos.valor}
      >
        <Text variant="secondary" weight="800" style={estilos.cifra}>
          {texto}
        </Text>
      </Pulsable>
      {boton(1, mas, valor >= maximo)}
    </View>
  );
}

const estilos = StyleSheet.create({
  columna: { gap: spacing.md },
  cabeza: { gap: 2 },
  contador: { textAlign: 'right', marginTop: -spacing.sm },
  fila: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  etiqueta: { width: 72 },
  control: { flex: 1, minWidth: 0 },
  muestras: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  // El anillo de la muestra elegida: no depende solo del color (la elegida
  // lleva aro, y el lector de pantalla dice su nombre y que está marcada).
  anillo: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  muestra: { width: 24, height: 24, borderRadius: 12, borderWidth: 1 },
  opciones: { flexDirection: 'row', gap: spacing.xs + 2 },
  opcion: {
    flex: 1,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.xs,
  },
  regulador: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  paso: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  valor: { flex: 1, minHeight: 36, alignItems: 'center', justifyContent: 'center' },
  cifra: { fontVariant: ['tabular-nums'] },
  botones: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  principal: { flex: 1 },
});
