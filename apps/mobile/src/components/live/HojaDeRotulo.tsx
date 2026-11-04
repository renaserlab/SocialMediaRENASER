import React, { useEffect, useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type LayoutChangeEvent,
  type TextStyle,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Aparecer } from '@/components/Aparecer';
import { Pulsable } from '@/components/Pulsable';
import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { Text } from '@/components/Text';
import { ReglaFina } from '@/components/live/ReglaFina';
import { tintasDelRotulo } from '@/components/live/RotuloDeDirecto';
import type { DestacadoEnPantalla } from '@/hooks/useDestacadoDeDirecto';
import { estiloDeLaLetra, useLetrasDelRotulo } from '@/hooks/useLetrasDelRotulo';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import {
  COLORES_DE_ROTULO,
  ESTILOS_DE_ROTULO,
  FONDOS_DE_ROTULO,
  LETRAS_DE_ROTULO,
  MAXIMO_DE_ROTULO,
  juzgarRotulo,
  largoDelRotulo,
  limpiarRotulo,
  type ColorDeRotulo,
  type EstiloDeRotulo,
  type FondoDeRotulo,
  type LetraDeRotulo,
  type Presentacion,
} from '@/live/destacado';
import { REGLA_DE_GIRO, REGLA_DE_TAMANO } from '@/live/reglaFina';
import { getTextStyle, hojaDelRotulo as tinta, rotuloDeDirecto, spacing } from '@/theme/tokens';

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

/** Lo que se cambia, un círculo cada uno, y debajo solo el ajuste del elegido. */
type Herramienta = 'color' | 'fondo' | 'letra' | 'tamano' | 'giro' | 'estilo';

const HERRAMIENTAS: readonly {
  id: Herramienta;
  nombre: TranslationKey;
  /** Sin icono, el círculo enseña lo que está puesto (el color, el fondo, la letra). */
  icono?: keyof typeof Feather.glyphMap;
}[] = [
  { id: 'color', nombre: 'live.bannerColor' },
  { id: 'fondo', nombre: 'live.bannerBackground' },
  { id: 'letra', nombre: 'live.bannerFont' },
  { id: 'tamano', nombre: 'live.bannerSize', icono: 'maximize-2' },
  { id: 'giro', nombre: 'live.bannerRotation', icono: 'rotate-cw' },
  { id: 'estilo', nombre: 'live.bannerMotion', icono: 'wind' },
];

/**
 * Lo que admite el campo, en unidades de teclado. Bastante más que el tope: el
 * tope de verdad se mide por caracteres y después de limpiar, y un emoji ocupa
 * dos de estas. Cortar aquí en 80 impediría escribir ochenta emojis que caben.
 */
const TOPE_DEL_CAMPO = MAXIMO_DE_ROTULO * 4;

/**
 * En web el navegador pinta su propio anillo de foco DENTRO del campo, que ya
 * dice que está enfocado con el suyo (lo mismo que `Input`).
 */
const SIN_ANILLO_DEL_NAVEGADOR =
  Platform.OS === 'web' ? ({ outlineStyle: 'none' } as unknown as TextStyle) : null;

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
  /** La papelera: la pantalla cierra la hoja, lo quita y ofrece deshacer. */
  alQuitar: () => void;
  /** Cuánto ocupa la hoja desde abajo, para que el texto suba si queda debajo. */
  alMedirAlto?: (alto: number) => void;
};

/**
 * Poner, cambiar o quitar el texto que quien emite enseña sobre la imagen.
 *
 * LA MISMA HOJA QUE LA DE LOS EFECTOS (maqueta v2, aprobada el 04/11/2026):
 * translúcida, baja y sin velo. Arriba el campo; debajo, seis círculos —color,
 * fondo, letra, tamaño, giro y animación— que enseñan lo que está puesto, y
 * solo el ajuste del elegido. Tamaño y giro con la barra fina de «Mejorar».
 *
 * QUIÉN LA VE. Solo quien gestiona la emisión, y solo si el servidor admite
 * destacar.
 *
 * LO QUE SE CAMBIA SE VE AL MOMENTO, DETRÁS, y si la hoja lo tapa, sube. La
 * SALA no ve nada hasta pulsar «Actualizar el texto». Cerrar sin pulsarlo lo
 * descarta, como siempre.
 *
 * SIN LA 0114 (`rotuloEditable`) no hay círculos: el texto y su movimiento,
 * como antes.
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
  const insets = useSafeAreaInsets();
  const puesto = destacar.destacado.rotulo;
  const editable = destacar.destacado.rotuloEditable;
  // Las letras propias se cargan al abrir la hoja: las opciones van escritas
  // cada una con la suya.
  const cargadas = useLetrasDelRotulo(visible && editable ? LETRAS_DE_ROTULO : []);
  const [herramienta, setHerramienta] = useState<Herramienta>('color');
  const [enfocado, setEnfocado] = useState(false);

  // Cada vez que se abre, empieza por el color.
  useEffect(() => {
    if (visible) setHerramienta('color');
  }, [visible]);

  /*
    En web el Modal marca el resto de la página como `aria-hidden`: el botón
    que abrió la hoja no puede conservar el foco (lo mismo que `BottomSheet`).
  */
  useEffect(() => {
    if (!visible || Platform.OS !== 'web') return;
    const activo = typeof document !== 'undefined' ? document.activeElement : null;
    if (activo instanceof HTMLElement) activo.blur();
  }, [visible]);

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
  const noSePuedeMandar = juicio !== 'vale' || sinCambios || destacar.ocupado;
  const etiquetaDelBoton = puesto ? t('live.bannerUpdate') : t('live.bannerShow');

  const cambiar = (parte: Partial<Presentacion>) =>
    alCambiar({ texto, estilo, presentacion: { ...presentacion, ...parte } });
  // Cambiar el movimiento se ve: el texto vuelve a entrar.
  const cambiarEstilo = (opcion: EstiloDeRotulo) => alCambiar({ texto, estilo: opcion, presentacion }, { entra: true });

  const mostrar = async () => {
    if (juicio !== 'vale') return;
    // Sin la posición: la hoja no lo mueve, y el sitio lo sabe el servidor.
    if (await destacar.ponerRotulo(limpio, estilo, editable ? presentacion : null, false)) alCerrar();
  };

  const medir = (evento: LayoutChangeEvent) => alMedirAlto?.(evento.nativeEvent.layout.height);

  const letraDe = (letra: LetraDeRotulo) => estiloDeLaLetra(letra, cargadas[letra]);

  /** Lo que enseña cada círculo: lo puesto, o su icono. */
  const enElCirculo = (id: Herramienta, icono?: keyof typeof Feather.glyphMap) => {
    if (id === 'color') {
      return (
        <View
          style={[
            estilos.gota,
            { backgroundColor: rotuloDeDirecto.colores[presentacion.color].relleno, borderColor: tinta.bordeDeLaMuestra },
          ]}
        />
      );
    }
    if (id === 'fondo') return <Chapa presentacion={presentacion} texto="A" />;
    if (id === 'letra') {
      return (
        <Text variant="secondary" weight="800" color={tinta.texto} style={[estilos.aa, letraDe(presentacion.letra)]}>
          Aa
        </Text>
      );
    }
    return icono ? <Feather name={icono} size={19} color={tinta.texto} /> : null;
  };

  const ajuste = () => {
    switch (herramienta) {
      case 'color':
        return (
          <View style={estilos.muestras} accessibilityRole="radiogroup" accessibilityLabel={t('live.bannerColor')}>
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
                  style={[estilos.anilloDeMuestra, { borderColor: elegido ? tinta.anillo : 'transparent' }]}
                >
                  <View
                    style={[
                      estilos.muestra,
                      { backgroundColor: rotuloDeDirecto.colores[color].relleno, borderColor: tinta.bordeDeLaMuestra },
                    ]}
                  />
                </Pulsable>
              );
            })}
          </View>
        );
      case 'fondo':
        return (
          <Fichas
            opciones={FONDOS_DE_ROTULO}
            elegida={presentacion.fondo}
            grupo={t('live.bannerBackground')}
            nombre={(fondo) => t(NOMBRE_DEL_FONDO[fondo])}
            contenido={(fondo) => <Chapa presentacion={{ color: presentacion.color, fondo }} texto="Aa" />}
            alElegir={(fondo) => cambiar({ fondo })}
          />
        );
      case 'letra':
        return (
          <Fichas
            opciones={LETRAS_DE_ROTULO}
            elegida={presentacion.letra}
            grupo={t('live.bannerFont')}
            nombre={(letra) => t(NOMBRE_DE_LA_LETRA[letra])}
            contenido={(letra) => (
              <Text variant="secondary" weight="700" numberOfLines={1} color={tinta.texto} style={letraDe(letra)}>
                {t(NOMBRE_DE_LA_LETRA[letra])}
              </Text>
            )}
            alElegir={(letra) => cambiar({ letra })}
          />
        );
      case 'tamano':
        return (
          <ReglaFina
            regla={REGLA_DE_TAMANO}
            valor={presentacion.tamano}
            etiqueta={t('live.bannerSize')}
            texto={(v) => `${v} %`}
            alCambiar={(tamano) => cambiar({ tamano })}
          />
        );
      case 'giro':
        return (
          <ReglaFina
            regla={REGLA_DE_GIRO}
            valor={presentacion.giro}
            etiqueta={t('live.bannerRotation')}
            texto={(v) => `${v}°`}
            alCambiar={(giro) => cambiar({ giro })}
          />
        );
      case 'estilo':
        return movimiento;
    }
  };

  const movimiento = (
    <Fichas
      opciones={ESTILOS_DE_ROTULO}
      elegida={estilo}
      grupo={t('live.bannerStyle')}
      nombre={(opcion) => t(NOMBRE_DEL_ESTILO[opcion])}
      alElegir={cambiarEstilo}
    />
  );

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={alCerrar}>
      {/* `ventanaPropia`: la hoja es un Modal, otra ventana encima de la pantalla. */}
      <SinTecladoDelante style={estilos.pantalla} ventanaPropia>
        {/* Sin velo: el texto se ve tal cual detrás. Tocar fuera cierra sin mandar. */}
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: tinta.velo }]}
          onPress={alCerrar}
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
        />

        <Aparecer desde={40} style={estilos.caja}>
          <View
            style={[
              estilos.hoja,
              {
                backgroundColor: Platform.OS === 'android' ? tinta.hojaSinDesenfoque : tinta.hoja,
                paddingBottom: Math.max(insets.bottom, spacing.md) + spacing.sm,
              },
            ]}
            onLayout={medir}
            accessibilityViewIsModal
          >
            {Platform.OS !== 'android' ? (
              <BlurView intensity={30} tint="dark" style={StyleSheet.absoluteFill} />
            ) : null}
            <View style={estilos.asa} />

            <ScrollView
              style={estilos.desplazable}
              contentContainerStyle={estilos.contenido}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              bounces={false}
            >
              <View style={estilos.fila}>
                <Text
                  variant="caption"
                  weight="700"
                  color={tinta.texto}
                  style={estilos.titulo}
                  accessibilityRole="header"
                >
                  {t('live.bannerSheetTitle')}
                </Text>
                <View style={estilos.acciones}>
                  {puesto ? (
                    <Pulsable
                      onPress={alQuitar}
                      disabled={destacar.ocupado}
                      opacidad={destacar.ocupado ? 0.4 : 1}
                      accessibilityRole="button"
                      accessibilityLabel={t('live.bannerRemoveA11y')}
                      accessibilityState={{ disabled: destacar.ocupado }}
                      style={estilos.iconoMinimo}
                    >
                      <Feather name="trash-2" size={17} color={tinta.texto} />
                    </Pulsable>
                  ) : null}
                  <Pulsable
                    onPress={alCerrar}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.close')}
                    style={estilos.iconoMinimo}
                  >
                    <Feather name="x" size={19} color={tinta.texto} />
                  </Pulsable>
                </View>
              </View>

              <View
                style={[
                  estilos.campo,
                  { backgroundColor: tinta.campo, borderColor: enfocado ? tinta.campoEnfocado : 'transparent' },
                ]}
              >
                <TextInput
                  value={texto}
                  onChangeText={(nuevo) => alCambiar({ texto: nuevo, estilo, presentacion })}
                  placeholder={t('live.bannerPlaceholder')}
                  placeholderTextColor={tinta.textoSuave}
                  accessibilityLabel={t('live.bannerTitle')}
                  maxLength={TOPE_DEL_CAMPO}
                  returnKeyType="done"
                  onSubmitEditing={() => void mostrar()}
                  autoFocus={!puesto}
                  onFocus={() => setEnfocado(true)}
                  onBlur={() => setEnfocado(false)}
                  selectionColor={tinta.texto}
                  style={[estilos.entrada, getTextStyle('500'), SIN_ANILLO_DEL_NAVEGADOR, { color: tinta.texto }]}
                />
                <Text
                  variant="caption"
                  weight="600"
                  color={juicio === 'largo' ? tinta.peligro : tinta.textoSuave}
                  style={estilos.contador}
                  accessibilityLiveRegion="polite"
                >
                  {largo}/{MAXIMO_DE_ROTULO}
                </Text>
              </View>
              {juicio === 'largo' ? (
                <Text
                  variant="caption"
                  weight="600"
                  color={tinta.peligro}
                  style={estilos.error}
                  accessibilityRole="alert"
                  accessibilityLiveRegion="polite"
                >
                  {t('live.bannerTooLong', { n: sobran })}
                </Text>
              ) : null}

              {editable ? (
                <>
                  <View
                    style={estilos.herramientas}
                    accessibilityRole="tablist"
                    accessibilityLabel={t('live.bannerToolsA11y')}
                  >
                    {HERRAMIENTAS.map(({ id, nombre, icono }) => {
                      const elegida = id === herramienta;
                      return (
                        <Pulsable
                          key={id}
                          onPress={() => setHerramienta(id)}
                          accessibilityRole="tab"
                          accessibilityLabel={t(nombre)}
                          accessibilityState={{ selected: elegida }}
                          style={estilos.herramienta}
                        >
                          <View
                            style={[
                              estilos.circulo,
                              {
                                backgroundColor: elegida ? tinta.circuloElegido : tinta.circulo,
                                borderColor: elegida ? tinta.anillo : 'transparent',
                              },
                            ]}
                          >
                            {enElCirculo(id, icono)}
                          </View>
                          <Text variant="caption" weight="500" color={tinta.texto} numberOfLines={1}>
                            {t(nombre)}
                          </Text>
                        </Pulsable>
                      );
                    })}
                  </View>
                  <View style={estilos.ajuste}>{ajuste()}</View>
                </>
              ) : (
                <View style={estilos.ajuste}>{movimiento}</View>
              )}

              {/* La etiqueta, a mano: sin ella el icono se colaría en el nombre del botón. */}
              <Pulsable
                onPress={() => void mostrar()}
                disabled={noSePuedeMandar}
                opacidad={noSePuedeMandar ? 0.4 : 1}
                accessibilityRole="button"
                accessibilityLabel={etiquetaDelBoton}
                accessibilityState={{ disabled: noSePuedeMandar }}
                style={[estilos.boton, { backgroundColor: tinta.boton }]}
              >
                <Feather name="volume-2" size={17} color={tinta.textoDelBoton} />
                <Text variant="secondary" weight="700" color={tinta.textoDelBoton}>
                  {etiquetaDelBoton}
                </Text>
              </Pulsable>
            </ScrollView>
          </View>
        </Aparecer>
      </SinTecladoDelante>
    </Modal>
  );
}

/** Una muestra del fondo con el color elegido: «A» en su círculo, «Aa» en su ficha. */
function Chapa({ presentacion, texto }: { presentacion: Pick<Presentacion, 'color' | 'fondo'>; texto: string }) {
  const tintas = tintasDelRotulo(presentacion);
  return (
    <View style={[estilos.chapa, { backgroundColor: tintas.fondo, borderColor: tintas.borde }]}>
      <Text
        variant="caption"
        weight="800"
        color={tintas.letra}
        style={
          tintas.sombra
            ? { textShadowColor: tintas.sombra, textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 }
            : null
        }
      >
        {texto}
      </Text>
    </View>
  );
}

/** Tres opciones en fichas translúcidas; la elegida, con anillo. */
function Fichas<T extends string>({
  opciones,
  elegida,
  grupo,
  nombre,
  contenido,
  alElegir,
}: {
  opciones: readonly T[];
  elegida: T;
  grupo: string;
  nombre: (opcion: T) => string;
  /** Sin esto, la ficha lleva su nombre. */
  contenido?: (opcion: T) => React.ReactNode;
  alElegir: (opcion: T) => void;
}) {
  return (
    <View style={estilos.fichas} accessibilityRole="radiogroup" accessibilityLabel={grupo}>
      {opciones.map((opcion) => {
        const marcada = opcion === elegida;
        return (
          <Pulsable
            key={opcion}
            onPress={() => alElegir(opcion)}
            accessibilityRole="radio"
            accessibilityLabel={nombre(opcion)}
            accessibilityState={{ selected: marcada, checked: marcada }}
            style={[
              estilos.ficha,
              {
                backgroundColor: marcada ? tinta.circuloElegido : tinta.circulo,
                borderColor: marcada ? tinta.anillo : 'transparent',
              },
            ]}
          >
            {contenido ? (
              contenido(opcion)
            ) : (
              <Text variant="secondary" weight="600" numberOfLines={1} color={tinta.texto}>
                {nombre(opcion)}
              </Text>
            )}
          </Pulsable>
        );
      })}
    </View>
  );
}

const estilos = StyleSheet.create({
  pantalla: { flex: 1, justifyContent: 'flex-end' },
  /*
    El tope va en la caja, que mide contra la pantalla. Puesto en la hoja se
    medía contra la propia caja —que mide lo que la hoja— y la recortaba al
    80 % de sí misma: el botón de mandar quedaba fuera de la vista.
  */
  caja: { alignItems: 'stretch', maxHeight: '80%' },
  hoja: {
    flexShrink: 1,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    overflow: 'hidden',
    paddingTop: spacing.sm,
  },
  asa: {
    alignSelf: 'center',
    width: 32,
    height: 4,
    borderRadius: 2,
    marginBottom: spacing.xs,
    backgroundColor: tinta.asa,
  },
  desplazable: { flexShrink: 1 },
  contenido: { paddingHorizontal: spacing.lg, gap: 10 },
  fila: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 30 },
  titulo: { textTransform: 'uppercase', letterSpacing: 0.9, fontSize: 11 },
  acciones: { marginLeft: 'auto', flexDirection: 'row', gap: 2 },
  iconoMinimo: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  campo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    borderRadius: 22,
    borderWidth: 1.5,
    paddingLeft: spacing.lg,
    paddingRight: 14,
  },
  entrada: { flex: 1, minWidth: 0, fontSize: 16, paddingVertical: 10 },
  contador: { fontVariant: ['tabular-nums'] },
  error: { marginTop: -4, marginLeft: spacing.lg },
  // Los seis círculos se reparten la fila; llegan casi hasta el borde.
  herramientas: { flexDirection: 'row', marginHorizontal: -spacing.sm },
  herramienta: { flex: 1, minWidth: 0, alignItems: 'center', gap: 6, paddingTop: 2 },
  circulo: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gota: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5 },
  aa: { fontSize: 15, lineHeight: 18 },
  chapa: {
    minWidth: 22,
    height: 20,
    paddingHorizontal: 4,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ajuste: { minHeight: 46, flexDirection: 'row', alignItems: 'center' },
  muestras: { flex: 1, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  // El aro de la muestra elegida: no depende solo del color (la elegida lleva
  // aro, y el lector de pantalla dice su nombre y que está marcada).
  anilloDeMuestra: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  muestra: { width: 26, height: 26, borderRadius: 13, borderWidth: 1 },
  fichas: { flex: 1, flexDirection: 'row', gap: spacing.sm },
  ficha: {
    flex: 1,
    minHeight: 38,
    borderRadius: 19,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
  },
  boton: {
    minHeight: 44,
    borderRadius: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: 2,
  },
});
