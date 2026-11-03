import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Aparecer } from '@/components/Aparecer';
import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { haptics } from '@/lib/haptics';
import {
  mismoEfecto,
  type CapacidadDeEfectos,
  type EfectoDeVideo,
  type EstadoDeEfectos,
  type MotivoSinEfectos,
} from '@/live/efectosDeVideo';
import { FONDOS_VIRTUALES, fondoPorId } from '@/live/fondosVirtuales';
import {
  IMANES,
  INTERVALO_DE_ENVIO_MS,
  MEJORAS,
  PASO_DE_ACCESIBILIDAD,
  conIman,
  crearLimitador,
  hayMejora,
  mejoraPuesta,
  normalizarValor,
  valoresEnCero,
  type CapacidadDeMejoras,
  type EstadoDeMejoras,
  type IdDeMejora,
  type Limitador,
  type ValoresDeMejora,
} from '@/live/mejorasDeVideo';
import { efectosDeCamara as tinta, radius, spacing } from '@/theme/tokens';

/**
 * La hoja de efectos de quien emite (aprobada el 02/11/2026, maqueta v4):
 * «Mejorar» arriba —piel suave, luz, contraste, nitidez y rubor— y el fondo
 * debajo.
 *
 * TRANSLÚCIDA, BAJA Y SIN VELO. Lo que se ve detrás ES la pista que sale, con
 * el efecto ya aplicado por el SDK: quien ajusta la luz tiene que verla tal
 * cual. Por eso no hay vista previa aparte ni velo que oscurezca la cámara, y
 * la pantalla aparta el chat y los botones mientras la hoja está abierta.
 *
 * LA HOJA NO DECIDE NADA. Pinta lo que le dan y llama a `alElegir` (fondos) o
 * a `mejoras.cambiar` (barras). Las reglas —una operación a la vez, límite de
 * tiempo, apagar «Mejorar» con un fondo, qué se recuerda— están en
 * `live/efectosDeVideo.ts` y `live/mejorasDeVideo.ts`. Lo único suyo es la
 * barra: el imán, el doble toque y no mandar más de un valor cada 100 ms.
 *
 * «MEJORAR» SOLO APARECE DONDE FUNCIONA: Android con el módulo propio y quien
 * publica. En iOS, web, Expo Go o un binario anterior la hoja es la de los
 * fondos, como antes.
 *
 * «Ninguno» SE PUEDE TOCAR SIEMPRE, también mientras se está aplicando otra
 * cosa: es la salida si el teléfono no puede con el efecto.
 */

/** Por qué no hay efectos, dicho a la persona. */
const EXPLICACION: Record<MotivoSinEfectos, TranslationKey> = {
  sin_proveedor: 'live.effectsUnavailableProvider',
  no_publica: 'live.effectsUnavailableViewer',
  sin_modulo: 'live.effectsUnavailableUpdate',
  sistema_antiguo: 'live.effectsUnavailableSystem',
};

/** Cada efecto de «Mejorar»: su nombre y su icono fino. */
const OPCION: Record<IdDeMejora, { nombre: TranslationKey; icono: keyof typeof Feather.glyphMap }> = {
  piel: { nombre: 'live.enhanceSkin', icono: 'feather' },
  luz: { nombre: 'live.enhanceLight', icono: 'sun' },
  contraste: { nombre: 'live.enhanceContrast', icono: 'pie-chart' },
  nitidez: { nombre: 'live.enhanceSharpness', icono: 'crosshair' },
  rubor: { nombre: 'live.enhanceBlush', icono: 'smile' },
};

/** La miniatura de los desenfoques: una sala desenfocada con la silueta nítida. */
const SALA_DESENFOCADA = fondoPorId('sala-gris')?.imagen;

/** Dos toques en menos de esto, y cerca, vuelven la barra a 0. */
const DOBLE_TOQUE_MS = 320;
const DOBLE_TOQUE_PX = 32;

type Props = {
  visible: boolean;
  alCerrar: () => void;
  capacidad: CapacidadDeEfectos;
  estado: EstadoDeEfectos;
  alElegir: (efecto: EfectoDeVideo) => void;
  mejoras: {
    capacidad: CapacidadDeMejoras;
    estado: EstadoDeMejoras;
    cambiar: (valores: ValoresDeMejora) => void;
    comparar: (si: boolean) => void;
  };
};

export function HojaDeEfectos({ visible, alCerrar, capacidad, estado, alElegir, mejoras }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const conMejorar = mejoras.capacidad.admitida;
  const conFondo = capacidad.admitidos;
  const [apretado, setApretado] = useState(false);
  const comparar = useRef(mejoras.comparar);
  comparar.current = mejoras.comparar;

  /*
    En web el Modal marca el resto de la página como `aria-hidden`: el botón
    que abrió la hoja no puede conservar el foco (lo mismo que `BottomSheet`).
  */
  useEffect(() => {
    if (!visible || Platform.OS !== 'web') return;
    const activo = typeof document !== 'undefined' ? document.activeElement : null;
    if (activo instanceof HTMLElement) activo.blur();
  }, [visible]);

  const puedeComparar = mejoraPuesta(mejoras.estado);

  // Cerrar la hoja con el ojo apretado (Atrás, o se fue la sala) lo suelta:
  // nadie puede quedarse emitiendo «sin efecto» sin saberlo. Igual si a mitad
  // entra un fondo o «Mejorar» se apaga: ya no hay nada que comparar.
  useEffect(() => {
    if ((visible && puedeComparar) || !apretado) return;
    setApretado(false);
    comparar.current(false);
  }, [visible, puedeComparar, apretado]);

  const soltarOjo = () => {
    if (!apretado) return;
    setApretado(false);
    comparar.current(false);
  };

  const opcion = (
    efecto: EfectoDeVideo,
    etiqueta: string,
    contenido: React.ReactNode,
    siempre = false,
  ) => {
    const puesto = mismoEfecto(estado.efecto, efecto);
    const apagada = estado.aplicando && !siempre;
    return (
      <Pulsable
        key={claveDeEfecto(efecto)}
        onPress={() => alElegir(efecto)}
        disabled={apagada}
        opacidad={apagada ? 0.45 : 1}
        accessibilityRole="radio"
        accessibilityLabel={etiqueta}
        accessibilityState={{ checked: puesto, disabled: apagada }}
        style={[estilos.anilloDeMosaico, { borderColor: puesto ? tinta.anillo : 'transparent' }]}
      >
        <View style={estilos.mosaico}>{contenido}</View>
      </Pulsable>
    );
  };

  const desenfoque = (blur: number) => (
    <>
      {SALA_DESENFOCADA ? (
        <Image source={SALA_DESENFOCADA} blurRadius={blur} style={estilos.miniatura} resizeMode="cover" />
      ) : null}
      <Feather name="user" size={22} color={tinta.texto} />
    </>
  );

  const nombreDelFondo = (efecto: EfectoDeVideo): string => {
    if (efecto.tipo === 'ninguno') return t('live.effectNone');
    if (efecto.tipo === 'desenfoque') {
      if (!capacidad.dosDesenfoques) return t('live.effectBlur');
      return efecto.fuerza === 'suave' ? t('live.effectBlurSoft') : t('live.effectBlurStrong');
    }
    const fondo = fondoPorId(efecto.fondoId);
    return fondo ? t(fondo.nombre) : '';
  };

  const cerrar = (
    <Pulsable
      onPress={alCerrar}
      accessibilityRole="button"
      accessibilityLabel={t('common.close')}
      style={estilos.iconoMinimo}
    >
      <Feather name="x" size={19} color={tinta.texto} />
    </Pulsable>
  );

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={alCerrar}>
      <View style={estilos.pantalla}>
        {/* El velo es transparente: tocar la cámara cierra la hoja. */}
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: tinta.velo }]}
          onPress={alCerrar}
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
        />

        {apretado ? (
          <View
            style={[estilos.insignia, { top: insets.top + 72 }]}
            pointerEvents="none"
            accessibilityLiveRegion="polite"
          >
            <Feather name="eye-off" size={13} color={tinta.texto} />
            <Text variant="caption" weight="800" color={tinta.texto}>
              {t('live.enhanceComparing')}
            </Text>
          </View>
        ) : null}

        <Aparecer desde={40} style={estilos.caja}>
          {conMejorar ? (
            <Pressable
              onPressIn={() => {
                if (!puedeComparar) return;
                setApretado(true);
                comparar.current(true);
              }}
              onPressOut={soltarOjo}
              disabled={!puedeComparar}
              accessibilityRole="button"
              accessibilityLabel={puedeComparar ? t('live.enhanceCompare') : t('live.enhanceCompareNothing')}
              accessibilityState={{ disabled: !puedeComparar, selected: apretado }}
              style={[
                estilos.ojo,
                { backgroundColor: apretado ? tinta.ojoApretado : tinta.ojo },
                !puedeComparar ? estilos.apagado : null,
              ]}
            >
              <Feather
                name={apretado ? 'eye-off' : 'eye'}
                size={18}
                color={apretado ? tinta.iconoDelOjoApretado : tinta.texto}
              />
            </Pressable>
          ) : null}

          <View
            style={[
              estilos.hoja,
              {
                backgroundColor: Platform.OS === 'android' ? tinta.hojaSinDesenfoque : tinta.hoja,
                paddingBottom: Math.max(insets.bottom, spacing.md) + spacing.sm,
              },
            ]}
            accessibilityViewIsModal
          >
            {Platform.OS !== 'android' ? (
              <BlurView intensity={30} tint="dark" style={StyleSheet.absoluteFill} />
            ) : null}
            <View style={estilos.asa} />

            {!conMejorar && !conFondo ? (
              <View style={estilos.seccion}>
                <View style={estilos.fila}>
                  <Text variant="caption" weight="700" color={tinta.texto} style={estilos.titulo} accessibilityRole="header">
                    {t('live.effectsTitle')}
                  </Text>
                  <View style={estilos.acciones}>{cerrar}</View>
                </View>
                <Text variant="secondary" color={tinta.texto}>
                  {t(EXPLICACION[capacidad.motivo ?? 'sin_proveedor'])}
                </Text>
              </View>
            ) : null}

            {conMejorar ? (
              <SeccionMejorar estado={mejoras.estado} cambiar={mejoras.cambiar} visible={visible} cerrar={cerrar} />
            ) : null}

            {conFondo ? (
              <View style={estilos.seccion}>
                <View style={estilos.fila}>
                  <Text variant="caption" weight="700" color={tinta.texto} style={estilos.titulo} accessibilityRole="header">
                    {t('live.effectsBackgroundTitle')}
                  </Text>
                  {estado.aplicando ? (
                    <View style={estilos.aplicando} accessibilityLiveRegion="polite">
                      <ActivityIndicator size="small" color={tinta.texto} />
                      <Text variant="caption" color={tinta.texto}>
                        {t('live.effectApplying')}
                      </Text>
                    </View>
                  ) : (
                    <Text variant="caption" color={tinta.texto} numberOfLines={1} style={estilos.crece}>
                      {nombreDelFondo(estado.efecto)}
                    </Text>
                  )}
                  {/* Sin «Mejorar», cerrar va aquí. */}
                  {!conMejorar ? <View style={estilos.acciones}>{cerrar}</View> : null}
                </View>

                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={estilos.sangrado}
                  contentContainerStyle={estilos.tira}
                  accessibilityRole="radiogroup"
                >
                  {opcion(
                    { tipo: 'ninguno' },
                    t('live.effectNone'),
                    <Feather name="slash" size={20} color={tinta.texto} />,
                    true,
                  )}
                  {capacidad.dosDesenfoques ? (
                    <>
                      {opcion({ tipo: 'desenfoque', fuerza: 'suave' }, t('live.effectBlurSoft'), desenfoque(2))}
                      {opcion({ tipo: 'desenfoque', fuerza: 'fuerte' }, t('live.effectBlurStrong'), desenfoque(6))}
                    </>
                  ) : (
                    opcion({ tipo: 'desenfoque' }, t('live.effectBlur'), desenfoque(5))
                  )}
                  {FONDOS_VIRTUALES.filter((fondo) => capacidad.fondos.includes(fondo.id)).map((fondo) =>
                    opcion(
                      { tipo: 'fondo', fondoId: fondo.id },
                      t(fondo.nombre),
                      <Image source={fondo.imagen} style={estilos.miniatura} resizeMode="cover" />,
                    ),
                  )}
                </ScrollView>

                {!estado.aplicando && estado.error ? (
                  <View style={estilos.aviso} accessibilityLiveRegion="polite">
                    <Feather name="alert-triangle" size={15} color={tinta.texto} />
                    <Text variant="caption" color={tinta.texto} style={estilos.crece}>
                      {estado.error === 'se_apago' ? t('live.effectTurnedOff') : t('live.effectFailed')}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        </Aparecer>
      </View>
    </Modal>
  );
}

/**
 * «Mejorar»: los cinco efectos en fila y UNA barra para el elegido.
 *
 * El valor de la barra mientras se arrastra es de aquí (se pinta en el acto);
 * a la sala le llega como mucho uno cada 100 ms y el último al soltar
 * (`crearLimitador`). Al soltar, lo que se pinta vuelve a ser lo de la sala.
 */
function SeccionMejorar({
  estado,
  cambiar,
  visible,
  cerrar,
}: {
  estado: EstadoDeMejoras;
  cambiar: (valores: ValoresDeMejora) => void;
  visible: boolean;
  cerrar: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [elegida, setElegida] = useState<IdDeMejora>('piel');
  const [arrastrando, setArrastrando] = useState<number | null>(null);

  const enviar = useRef(cambiar);
  enviar.current = cambiar;
  const limitador = useRef<Limitador<ValoresDeMejora> | null>(null);
  if (!limitador.current) {
    limitador.current = crearLimitador<ValoresDeMejora>({
      intervaloMs: INTERVALO_DE_ENVIO_MS,
      ahora: () => Date.now(),
      programar: (fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
      enviar: (valores) => enviar.current(valores),
    });
  }

  // Cerrar la hoja o desmontarla a mitad de un arrastre manda lo último: lo
  // que la persona dejó es lo que tiene que salir.
  useEffect(() => {
    if (!visible) limitador.current?.soltar();
  }, [visible]);
  useEffect(() => () => limitador.current?.soltar(), []);

  const valores = estado.valores;
  const valorDe = (id: IdDeMejora) => (id === elegida && arrastrando !== null ? arrastrando : valores[id]);
  const actual = valorDe(elegida);

  const mover = (valor: number) => {
    setArrastrando(valor);
    limitador.current?.empujar({ ...valores, [elegida]: valor });
  };
  const soltar = () => {
    limitador.current?.soltar();
    setArrastrando(null);
  };
  const ponerEnCero = () => {
    limitador.current?.cancelar();
    setArrastrando(null);
    cambiar({ ...valores, [elegida]: 0 });
  };
  const restablecer = () => {
    limitador.current?.cancelar();
    setArrastrando(null);
    cambiar(valoresEnCero());
  };

  const apagada = estado.bloqueada || estado.averiada;

  return (
    <View style={estilos.seccion}>
      <View style={estilos.fila}>
        <Text variant="caption" weight="700" color={tinta.texto} style={estilos.titulo} accessibilityRole="header">
          {t('live.effectsEnhanceTitle')}
        </Text>
        <View style={estilos.acciones}>
          {!apagada ? (
            <Pulsable
              onPress={restablecer}
              disabled={!hayMejora(valores)}
              opacidad={hayMejora(valores) ? 1 : 0.35}
              accessibilityRole="button"
              accessibilityLabel={t('live.enhanceReset')}
              accessibilityState={{ disabled: !hayMejora(valores) }}
              style={estilos.iconoMinimo}
            >
              <Feather name="rotate-ccw" size={17} color={tinta.texto} />
            </Pulsable>
          ) : null}
          {cerrar}
        </View>
      </View>

      {estado.bloqueada ? (
        <View style={estilos.aviso} accessibilityLiveRegion="polite">
          <Feather name="layers" size={15} color={tinta.texto} />
          <Text variant="caption" color={tinta.texto} style={estilos.crece}>
            {t('live.enhanceBlocked')}
          </Text>
        </View>
      ) : estado.averiada ? (
        <View style={estilos.aviso} accessibilityLiveRegion="polite">
          <Feather name="alert-triangle" size={15} color={tinta.texto} />
          <Text variant="caption" color={tinta.texto} style={estilos.crece}>
            {t('live.enhanceFailed')}
          </Text>
        </View>
      ) : (
        <View style={estilos.controles}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={estilos.sangrado}
            contentContainerStyle={estilos.opciones}
            accessibilityRole="radiogroup"
            accessibilityLabel={t('live.enhanceChooseA11y')}
          >
            {MEJORAS.map((id) => {
              const elegido = id === elegida;
              const valor = valorDe(id);
              const nombre = t(OPCION[id].nombre);
              return (
                <Pulsable
                  key={id}
                  onPress={() => setElegida(id)}
                  accessibilityRole="radio"
                  accessibilityLabel={
                    valor === 0
                      ? `${nombre}, ${t('live.enhanceOffA11y')}`
                      : t('live.enhanceOnA11y', { nombre, valor })
                  }
                  accessibilityState={{ checked: elegido }}
                  style={estilos.opcion}
                >
                  <View
                    style={[
                      estilos.circulo,
                      {
                        backgroundColor: elegido ? tinta.circuloElegido : tinta.circulo,
                        borderColor: elegido ? tinta.anillo : 'transparent',
                      },
                    ]}
                  >
                    <Feather
                      name={OPCION[id].icono}
                      size={20}
                      color={tinta.texto}
                      style={valor === 0 ? estilos.iconoEnCero : null}
                    />
                    {valor > 0 && !elegido ? <View style={estilos.punto} /> : null}
                  </View>
                  <Text variant="caption" weight="500" color={tinta.texto} numberOfLines={1}>
                    {nombre}
                  </Text>
                </Pulsable>
              );
            })}
          </ScrollView>

          <View style={estilos.filaDeLaBarra}>
            <BarraDeMejora
              valor={actual}
              nombre={t(OPCION[elegida].nombre)}
              textoEnCero={t('live.enhanceOffA11y')}
              alMover={mover}
              alSoltar={soltar}
              alDobleToque={ponerEnCero}
            />
            <Text
              variant="caption"
              weight="600"
              color={tinta.texto}
              style={[estilos.cifra, actual === 0 ? estilos.cifraEnCero : null]}
              accessibilityElementsHidden
              importantForAccessibility="no"
            >
              {actual}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

/** Lo que queda libre a cada lado del carril, para que el pulgar no se corte. */
const MARGEN_DEL_CARRIL = 8;

/**
 * La barra 0–100: arrastrar, tocar para saltar, doble toque a 0, imán en 0 y
 * en 50. Con lector de pantalla, sube y baja de cinco en cinco.
 *
 * `PanResponder` y no el gestor de gestos: va dentro de un `Modal`, que en
 * Android es otra ventana y pediría su propia raíz de gestos.
 */
function BarraDeMejora({
  valor,
  nombre,
  textoEnCero,
  alMover,
  alSoltar,
  alDobleToque,
}: {
  valor: number;
  nombre: string;
  textoEnCero: string;
  alMover: (valor: number) => void;
  alSoltar: () => void;
  alDobleToque: () => void;
}) {
  const { t } = useTranslation();
  const [activa, setActiva] = useState(false);
  const ancho = useRef(0);
  /** Dónde empezó el dedo, en puntos de la barra. `null` = no hay arrastre. */
  const inicio = useRef<number | null>(null);
  const ultimoToque = useRef({ t: 0, x: 0 });
  const ultimo = useRef(valor);
  ultimo.current = arrastreOValor(inicio.current, ultimo.current, valor);

  const avisos = useRef({ alMover, alSoltar, alDobleToque });
  avisos.current = { alMover, alSoltar, alDobleToque };

  const responder = useMemo(() => {
    const desdeX = (x: number) =>
      conIman(((x - MARGEN_DEL_CARRIL) / Math.max(1, ancho.current - 2 * MARGEN_DEL_CARRIL)) * 100);
    const mover = (x: number) => {
      const v = desdeX(x);
      if (v === ultimo.current) return;
      if (IMANES.includes(v)) haptics.seleccion();
      ultimo.current = v;
      avisos.current.alMover(v);
    };
    const terminar = () => {
      if (inicio.current === null) return;
      inicio.current = null;
      setActiva(false);
      avisos.current.alSoltar();
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // La fila de abajo se desliza de lado: la barra no suelta el dedo.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (evento) => {
        const x = evento.nativeEvent.locationX;
        const ahora = Date.now();
        const anterior = ultimoToque.current;
        if (ahora - anterior.t < DOBLE_TOQUE_MS && Math.abs(x - anterior.x) < DOBLE_TOQUE_PX) {
          ultimoToque.current = { t: 0, x: 0 };
          inicio.current = null;
          ultimo.current = 0;
          avisos.current.alDobleToque();
          return;
        }
        ultimoToque.current = { t: ahora, x };
        inicio.current = x;
        setActiva(true);
        mover(x);
      },
      onPanResponderMove: (_evento, gesto) => {
        if (inicio.current !== null) mover(inicio.current + gesto.dx);
      },
      onPanResponderRelease: terminar,
      onPanResponderTerminate: terminar,
    });
  }, []);

  const alAccion = (evento: AccessibilityActionEvent) => {
    const paso = evento.nativeEvent.actionName === 'increment' ? PASO_DE_ACCESIBILIDAD : -PASO_DE_ACCESIBILIDAD;
    const v = normalizarValor(valor + paso);
    if (v === valor) return;
    ultimo.current = v;
    alMover(v);
    alSoltar();
  };

  return (
    <View
      style={estilos.barra}
      onLayout={(evento: LayoutChangeEvent) => {
        ancho.current = evento.nativeEvent.layout.width;
      }}
      {...responder.panHandlers}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={t('live.enhanceIntensityA11y', { nombre })}
      accessibilityValue={{ min: 0, max: 100, now: valor, text: valor === 0 ? textoEnCero : String(valor) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={alAccion}
    >
      {/* Nada de dentro recibe el dedo: las coordenadas son siempre de la barra. */}
      <View style={estilos.carril} pointerEvents="none">
        <View style={[estilos.relleno, { width: `${valor}%` }]} />
        <View
          style={[
            estilos.muesca,
            { backgroundColor: valor === 50 ? tinta.muescaEnganchada : tinta.muesca },
          ]}
        />
        <View style={[estilos.pulgar, { left: `${valor}%` }]}>
          {activa ? (
            <View style={estilos.burbuja}>
              <Text variant="caption" weight="700" color={tinta.textoDeLaBurbuja} style={estilos.centrado}>
                {valor}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/** Una clave estable por opción: el fondo, o el tipo con su fuerza. */
function claveDeEfecto(efecto: EfectoDeVideo): string {
  if (efecto.tipo === 'fondo') return efecto.fondoId;
  if (efecto.tipo === 'desenfoque') return `desenfoque-${efecto.fuerza ?? 'unico'}`;
  return efecto.tipo;
}

/** Sin arrastre en curso, lo último conocido es el valor que llega. */
function arrastreOValor(inicio: number | null, ultimo: number, valor: number): number {
  return inicio === null ? valor : ultimo;
}

const estilos = StyleSheet.create({
  pantalla: { flex: 1, justifyContent: 'flex-end' },
  caja: { alignItems: 'stretch' },
  hoja: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    overflow: 'hidden',
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    gap: 10,
  },
  asa: {
    alignSelf: 'center',
    width: 32,
    height: 4,
    borderRadius: 2,
    backgroundColor: tinta.asa,
  },
  seccion: { gap: spacing.sm },
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
  aplicando: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  crece: { flex: 1 },
  aviso: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 30 },
  controles: { gap: spacing.xs },
  // Las filas que se deslizan llegan hasta el borde de la hoja.
  sangrado: { marginHorizontal: -spacing.lg },
  opciones: { gap: 6, paddingHorizontal: spacing.lg, paddingTop: 3, paddingBottom: 2 },
  opcion: { width: 60, alignItems: 'center', gap: 6 },
  circulo: {
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconoEnCero: { opacity: 0.6 },
  punto: {
    position: 'absolute',
    right: 1,
    bottom: 1,
    width: 9,
    height: 9,
    borderRadius: 4.5,
    borderWidth: 2,
    borderColor: tinta.bordeDelPunto,
    backgroundColor: tinta.punto,
  },
  filaDeLaBarra: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  barra: { flex: 1, height: 36, justifyContent: 'center' },
  carril: {
    marginHorizontal: MARGEN_DEL_CARRIL,
    height: 2,
    borderRadius: 1,
    backgroundColor: tinta.carril,
  },
  relleno: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 1, backgroundColor: tinta.relleno },
  muesca: { position: 'absolute', left: '50%', top: -3, width: 2, height: 8, marginLeft: -1, borderRadius: 1 },
  pulgar: {
    position: 'absolute',
    top: -7,
    width: 16,
    height: 16,
    marginLeft: -8,
    borderRadius: 8,
    backgroundColor: tinta.pulgar,
    shadowColor: tinta.sombra,
    shadowOpacity: 0.6,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
    alignItems: 'center',
  },
  burbuja: {
    position: 'absolute',
    bottom: 22,
    minWidth: 30,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 7,
    backgroundColor: tinta.burbuja,
  },
  centrado: { textAlign: 'center' },
  cifra: { width: 28, textAlign: 'right', fontVariant: ['tabular-nums'] },
  cifraEnCero: { opacity: 0.8 },
  tira: { gap: 10, paddingHorizontal: spacing.lg, paddingVertical: 3 },
  anilloDeMosaico: { borderRadius: 18, borderWidth: 2, padding: 2 },
  mosaico: {
    width: 50,
    height: 50,
    borderRadius: 14,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tinta.circulo,
  },
  miniatura: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  ojo: {
    alignSelf: 'flex-start',
    marginLeft: 14,
    marginBottom: 10,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  apagado: { opacity: 0.4 },
  insignia: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: tinta.bordeDeLaInsignia,
    backgroundColor: tinta.insignia,
  },
});
