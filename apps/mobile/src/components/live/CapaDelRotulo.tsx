import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Platform, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import { rellenoDePeligro, sobreMedio } from '@/components/CapaDeContraste';
import { RotuloDeDirecto } from '@/components/live/RotuloDeDirecto';
import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { haptics } from '@/lib/haptics';
import { claveDelRotulo, type Rotulo } from '@/live/destacado';
import {
  DURACION_DEL_DESLIZ_MS,
  UMBRAL_DE_ARRASTRE,
  aFracciones,
  ajustarGiro,
  ajustarTamano,
  centroDeLaZona,
  colocar,
  comoCambia,
  cuantoSube,
  dedoAlEmpezar,
  enLaPapelera,
  iman,
  limitar,
  mitadesGiradas,
  type Caja,
  type Disposicion,
  type Medida,
  type Punto,
  type Zona,
} from '@/live/rotuloEnPantalla';
import { radius, rotuloDeDirecto, spacing } from '@/theme/tokens';

/** En la web `Animated` no tiene hilo nativo y avisa por consola si se le pide. */
const HILO_NATIVO = Platform.OS !== 'web';

/**
 * Aire tocable alrededor de la píldora. Un rótulo al 70 % mide 24 puntos de
 * alto: agarrarlo —y poner dos dedos para pellizcarlo— necesita algo más.
 */
const MARGEN_TACTIL = 12;
/** Lo que se encoge el texto al pasar por encima de la papelera. */
const ESCALA_EN_LA_PAPELERA = 0.32;
/** Lo que mide la papelera. */
const PAPELERA = 52;

/** Lo que mide la pantalla útil, la zona libre y dónde está la papelera. */
export type GeometriaDelRotulo = { lienzo: Medida; zona: Zona; papelera: Punto };

/** Lo que se manda al soltar: siempre con un sitio concreto. */
export type Soltado = { x: number; y: number; tamano: number; giro: number };

type Props = {
  /** Lo que se enseña: lo publicado, o el borrador mientras el host edita. */
  rotulo: Rotulo | null;
  /**
   * Cuándo es OTRO rótulo y se anima su entrada. Fuera de la hoja es
   * `claveDelRotulo`; con la hoja abierta la mantiene la pantalla, para que
   * escribir no lo haga entrar en cada letra.
   */
  clave?: string;
  /** `null` mientras la pantalla no se ha medido: no se pinta nada. */
  geometria: GeometriaDelRotulo | null;
  /** Arrastrar, pellizcar y girar: host o administración, con la 0114. */
  puedeMover: boolean;
  /** Tocarlo abre la hoja: host o administración. */
  puedeEditar: boolean;
  /** La hoja está abierta: no hay gestos y, si hace falta, sube. */
  editando: boolean;
  /** Dónde empieza la hoja, en puntos del lienzo, mientras está abierta. */
  techoDeLaHoja: number | null;
  reduceMotion: boolean;
  /** Lo que se le dice a un lector de pantalla. */
  etiqueta: string;
  /** Qué hace tocarlo, para un lector de pantalla. */
  pista?: string;
  alTocar: () => void;
  /** Soltado en la zona. `false` si el servidor no lo guardó: vuelve a su sitio. */
  alSoltar: (sitio: Soltado) => Promise<boolean>;
  /** Soltado en la papelera. `false` si no se pudo quitar: reaparece. */
  alTirar: () => Promise<boolean>;
  /** Empieza o termina un gesto: la pantalla apaga la cabecera mientras dura. */
  alCambiarGesto: (activo: boolean) => void;
  /**
   * Lo que mide la capa —la pantalla útil, sobre la que van las fracciones— y
   * dónde está dentro de la columna, para llevar a sus puntos lo que la
   * pantalla mide fuera de ella (la cabecera, el chat).
   */
  alMedirLienzo: (lienzo: Caja) => void;
};

type Sesion = {
  /** Dónde estaba el centro al empezar, y la traslación del dedo en ese momento. */
  centroInicial: Punto;
  origen: Punto;
  /** El dedo al empezar, en puntos del lienzo. Para la papelera. */
  dedoInicial: Punto | null;
  traslacion: Punto;
  /** Tamaño y giro sobre los que se pellizca (cambian si se vuelve a pellizcar). */
  tamanoBase: number;
  giroBase: number;
  escala: number;
  rotacion: number;
  /** Hubo pellizco o giro: ya no hay papelera ni imán al centro. */
  pellizco: boolean;
  activos: Set<string>;
  centro: Punto;
  tamano: number;
  giro: number;
  caliente: boolean;
  guiaV: boolean;
  guiaH: boolean;
  recto: boolean;
};

function mismaDisposicion(a: Disposicion | null, b: Disposicion | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.tamano === b.tamano && a.giro === b.giro;
}

/** El giro equivalente a `objetivo` más cercano a `actual`: no da la vuelta larga. */
function giroCercano(actual: number, objetivo: number): number {
  return objetivo + 360 * Math.round((actual - objetivo) / 360);
}

/**
 * El texto de quien emite, suelto encima de la imagen, y lo que hace el dedo.
 *
 * QUÉ VE CADA UNO.
 *   · Quien MIRA: el texto en su sitio. Cuando el host lo suelta en otro, se
 *     desliza hasta allí en `DURACION_DEL_DESLIZ_MS` (con «reducir
 *     movimiento», salta). Nunca mientras el host arrastra: hasta que suelta
 *     no se manda nada.
 *   · El HOST (o la administración): lo arrastra; con dos dedos lo pellizca y
 *     lo gira. Mientras arrastra ve la zona por la que puede ir, las guías del
 *     imán al centro y la papelera arriba. Tocarlo abre la hoja.
 *
 * LO QUE PINTA ES LO QUE DICE EL SERVIDOR, salvo mientras dura un gesto y
 * hasta que el servidor contesta al soltar: ahí manda lo del dedo, para que
 * el texto no salte atrás mientras llega la respuesta. Si el servidor no lo
 * guarda, vuelve deslizándose a donde estaba.
 *
 * VA DEBAJO DE LOS BOTONES. Está detrás del chat y de la columna de
 * controles: si el host lo lleva muy a la derecha, sus botones se lo tapan a
 * él (la sala no tiene esa columna). Por encima, eso sí, de lo que ocupa el
 * sitio de la imagen cuando no la hay (el cartel de «el video no está
 * disponible»): si no, el cartel lo tapaba y se quedaba con el toque.
 * Mientras dura el gesto sube por encima de todo, con la papelera.
 *
 * El movimiento va con el motor de React Native y el hilo nativo, sobre UNA
 * vista: no repinta la pantalla. Los gestos corren en el hilo de JavaScript
 * —es un gesto corto sobre una sola vista, como deslizar para responder—.
 */
export function CapaDelRotulo({
  rotulo,
  clave: claveDada,
  geometria,
  puedeMover,
  puedeEditar,
  editando,
  techoDeLaHoja,
  reduceMotion,
  etiqueta,
  pista,
  alTocar,
  alSoltar,
  alTirar,
  alCambiarGesto,
  alMedirLienzo,
}: Props) {
  const { t } = useTranslation();

  /** Lo que mide la píldora sin girar, y con qué tamaño se midió. */
  const [medida, setMedida] = useState<{ medida: Medida; tamano: number } | null>(null);
  /** Lo del dedo, mientras dura el gesto y hasta que el servidor contesta. */
  const [local, setLocal] = useState<Disposicion | null>(null);
  const [tamanoVivo, setTamanoVivo] = useState<number | null>(null);
  const [giroVivo, setGiroVivo] = useState<number | null>(null);
  const [modo, setModo] = useState<'quieto' | 'arrastre' | 'pellizco'>('quieto');
  const [guias, setGuias] = useState({ v: false, h: false });
  const [caliente, setCaliente] = useState(false);
  /** Lo acaba de tirar a la papelera: no se pinta mientras se quita. */
  const [tirado, setTirado] = useState<string | null>(null);

  const esquinaX = useRef(new Animated.Value(0)).current;
  const esquinaY = useRef(new Animated.Value(0)).current;
  const giro = useRef(new Animated.Value(0)).current;
  const escala = useRef(new Animated.Value(1)).current;
  const subida = useRef(new Animated.Value(0)).current;

  const clave = claveDada ?? claveDelRotulo(rotulo);
  const publicada: Disposicion | null = rotulo
    ? {
        x: rotulo.presentacion.x,
        y: rotulo.presentacion.y,
        tamano: rotulo.presentacion.tamano,
        giro: rotulo.presentacion.giro,
      }
    : null;
  const mostrada = local ?? publicada;
  const tamanoPintado = tamanoVivo ?? mostrada?.tamano ?? 100;

  /** Lo último que se colocó: desde aquí arranca el siguiente gesto. */
  const colocado = useRef<{ centro: Punto; giro: number } | null>(null);
  /** Lo que se enseñaba en la vuelta anterior, para saber qué ha cambiado. */
  const anterior = useRef<{ clave: string; disposicion: Disposicion } | null>(null);
  /** Hasta cuándo dura el deslizamiento en curso. */
  const finDelDesliz = useRef(0);
  const sesion = useRef<Sesion | null>(null);
  /** La capa; en la web, para saber dónde empieza en la ventana. */
  const capaRef = useRef<View>(null);

  /** Solo en la web: la esquina de la capa en la ventana (`dedoAlEmpezar`). */
  function origenEnLaVentana(): Punto | null {
    if (Platform.OS !== 'web') return null;
    const nodo = capaRef.current as unknown as { getBoundingClientRect?: () => { left: number; top: number } };
    const caja = nodo?.getBoundingClientRect?.();
    return caja ? { x: caja.left, y: caja.top } : null;
  }

  // Todo lo que leen los gestos, siempre al día: los gestos no se rehacen en
  // cada pintada.
  const ultimo = useRef({ clave, geometria, medida, mostrada, alSoltar, alTirar, alTocar, alCambiarGesto });
  ultimo.current = { clave, geometria, medida, mostrada, alSoltar, alTirar, alTocar, alCambiarGesto };

  /** La píldora medida, llevada al tamaño que se pinta ahora. */
  function medidaA(tamano: number, base = medida): Medida | null {
    if (!base) return null;
    const f = tamano / base.tamano;
    return { ancho: base.medida.ancho * f, alto: base.medida.alto * f };
  }

  /** Lleva la píldora a `centro` con `grados`, ya o deslizándose `duracion` ms. */
  function ponerEn(centro: Punto, med: Medida, grados: number, duracion = 0) {
    const x = centro.x - med.ancho / 2 - MARGEN_TACTIL;
    const y = centro.y - med.alto / 2 - MARGEN_TACTIL;
    const actual = colocado.current?.giro ?? grados;
    const g = giroCercano(actual, grados);
    colocado.current = { centro, giro: g };
    if (duracion <= 0) {
      esquinaX.setValue(x);
      esquinaY.setValue(y);
      giro.setValue(g);
      return;
    }
    const curva = Easing.bezier(0.2, 0.8, 0.2, 1);
    Animated.parallel([
      Animated.timing(esquinaX, { toValue: x, duration: duracion, easing: curva, useNativeDriver: HILO_NATIVO }),
      Animated.timing(esquinaY, { toValue: y, duration: duracion, easing: curva, useNativeDriver: HILO_NATIVO }),
      Animated.timing(giro, { toValue: g, duration: duracion, easing: curva, useNativeDriver: HILO_NATIVO }),
    ]).start();
  }

  // Colocar lo que toca enseñar. Mientras dura un gesto, manda el dedo.
  const objetivo =
    geometria && mostrada && medida
      ? colocar(mostrada, geometria.lienzo, geometria.zona, medidaA(mostrada.tamano) as Medida, mostrada.giro)
      : null;
  useEffect(() => {
    if (!objetivo || !mostrada || !medida || sesion.current) return;
    const med = medidaA(mostrada.tamano) as Medida;
    const cambio = comoCambia(anterior.current, { clave, disposicion: mostrada });
    const tamanoAntes = anterior.current?.disposicion.tamano;
    anterior.current = { clave, disposicion: mostrada };
    const ahora = Date.now();
    if (cambio === 'desliza' && !reduceMotion && colocado.current) {
      finDelDesliz.current = ahora + DURACION_DEL_DESLIZ_MS;
      // El tamaño nuevo ya está en la letra: se arranca con la escala del
      // anterior y se llega a 1 a la vez que al sitio nuevo.
      if (tamanoAntes && tamanoAntes !== mostrada.tamano) {
        escala.setValue(tamanoAntes / mostrada.tamano);
        Animated.timing(escala, {
          toValue: 1,
          duration: DURACION_DEL_DESLIZ_MS,
          easing: Easing.bezier(0.2, 0.8, 0.2, 1),
          useNativeDriver: HILO_NATIVO,
        }).start();
      }
      ponerEn(objetivo, med, mostrada.giro, DURACION_DEL_DESLIZ_MS);
      return;
    }
    // Lo demás —entrar, medirse de nuevo, cambiar la zona— va a su sitio sin
    // deslizarse. Si había un deslizamiento a medias, lo termina hacia el
    // sitio corregido en el tiempo que le quedaba.
    const queda = finDelDesliz.current - ahora;
    ponerEn(objetivo, med, mostrada.giro, !reduceMotion && queda > 0 ? queda : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave, objetivo?.x, objetivo?.y, mostrada?.giro, mostrada?.tamano, reduceMotion]);

  // Mientras se edita, si la hoja lo tapa, sube; al cerrarla, baja.
  const sube =
    editando && techoDeLaHoja !== null && objetivo && mostrada && medida
      ? cuantoSube({
          centroY: objetivo.y,
          medida: medidaA(tamanoPintado) as Medida,
          giro: mostrada.giro,
          techoDeLaHoja,
        })
      : 0;
  useEffect(() => {
    if (reduceMotion) {
      subida.setValue(-sube);
      return;
    }
    const animacion = Animated.timing(subida, {
      toValue: -sube,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: HILO_NATIVO,
    });
    animacion.start();
    return () => animacion.stop();
  }, [sube, reduceMotion, subida]);

  // Otro rótulo (o ninguno): lo tirado ya no hace falta esconderlo, y el
  // siguiente no hereda lo encogido de la papelera.
  useEffect(() => {
    if (tirado !== null && tirado !== clave) {
      setTirado(null);
      escala.setValue(1);
    }
  }, [clave, tirado, escala]);

  // El texto desaparece a mitad de un gesto (otra persona lo quitó, terminó
  // la emisión): el gesto ya no va a terminar solo, se cierra aquí. Sin esto
  // la cabecera se quedaría apagada.
  useEffect(() => {
    if (rotulo || !sesion.current) return;
    sesion.current = null;
    setModo('quieto');
    setGuias({ v: false, h: false });
    setCaliente(false);
    setTamanoVivo(null);
    setGiroVivo(null);
    ultimo.current.alCambiarGesto(false);
  }, [rotulo]);
  useEffect(
    () => () => {
      if (sesion.current) ultimo.current.alCambiarGesto(false);
    },
    [],
  );

  /* ------------------------------------------------------------ gestos -- */

  function recalcular() {
    const s = sesion.current;
    const { geometria: geo, medida: base } = ultimo.current;
    if (!s || !geo || !base) return;

    const tamano = ajustarTamano(s.tamanoBase * s.escala);
    const enderezado = ajustarGiro(s.giroBase + s.rotacion);
    if (tamano !== s.tamano) {
      s.tamano = tamano;
      setTamanoVivo(tamano);
    }
    if (s.pellizco) {
      if (enderezado.iman && !s.recto) haptics.light();
      s.recto = enderezado.iman;
      if (enderezado.giro !== s.giro) setGiroVivo(enderezado.giro);
    }
    s.giro = enderezado.giro;
    const med = medidaA(tamano, base) as Medida;

    // La papelera la mira el DEDO, y solo arrastrando con uno.
    if (!s.pellizco && s.dedoInicial) {
      const dedo = { x: s.dedoInicial.x + s.traslacion.x, y: s.dedoInicial.y + s.traslacion.y };
      const encima = enLaPapelera(dedo, geo.papelera);
      if (encima !== s.caliente) {
        s.caliente = encima;
        setCaliente(encima);
        if (encima) haptics.medium();
      }
      if (encima) {
        if (s.guiaV || s.guiaH) {
          s.guiaV = s.guiaH = false;
          setGuias({ v: false, h: false });
        }
        ponerEn(geo.papelera, med, 0);
        escala.setValue(ESCALA_EN_LA_PAPELERA);
        return;
      }
    }

    const deseado = {
      x: s.centroInicial.x + s.traslacion.x,
      y: s.centroInicial.y + s.traslacion.y,
    };
    let centro = limitar(deseado, med, s.giro, geo.zona);
    let v = false;
    let h = false;
    if (!s.pellizco) {
      const conIman = iman(centro, med, s.giro, geo.zona, geo.lienzo);
      centro = conIman.centro;
      v = conIman.vertical;
      h = conIman.horizontal;
    }
    if (v !== s.guiaV || h !== s.guiaH) {
      // Un toque suave al ENGANCHARSE, no al soltarse.
      if ((v && !s.guiaV) || (h && !s.guiaH)) haptics.light();
      s.guiaV = v;
      s.guiaH = h;
      setGuias({ v, h });
    }
    s.centro = centro;
    escala.setValue(1);
    ponerEn(centro, med, s.giro);
  }

  function empezar(cual: 'pan' | 'pinza' | 'giro') {
    const { mostrada: vista, alCambiarGesto: avisar } = ultimo.current;
    if (!sesion.current) {
      const desde = colocado.current;
      if (!desde || !vista) return false;
      sesion.current = {
        centroInicial: desde.centro,
        origen: { x: 0, y: 0 },
        dedoInicial: null,
        traslacion: { x: 0, y: 0 },
        tamanoBase: vista.tamano,
        giroBase: vista.giro,
        escala: 1,
        rotacion: 0,
        pellizco: false,
        activos: new Set(),
        centro: desde.centro,
        tamano: vista.tamano,
        giro: vista.giro,
        caliente: false,
        guiaV: false,
        guiaH: false,
        recto: vista.giro === 0,
      };
      finDelDesliz.current = 0;
      avisar(true);
    }
    const s = sesion.current;
    s.activos.add(cual);
    if (cual !== 'pan') {
      // Otra pinza dentro del mismo gesto parte de lo que ya hay.
      s.pellizco = true;
      if (cual === 'pinza') {
        s.tamanoBase = s.tamano;
        s.escala = 1;
      } else {
        s.giroBase = s.giro;
        s.rotacion = 0;
      }
      if (s.caliente) {
        s.caliente = false;
        setCaliente(false);
      }
      setModo('pellizco');
      setGiroVivo(s.giro);
    } else if (!s.pellizco) {
      setModo('arrastre');
    }
    return true;
  }

  function terminar(cual: 'pan' | 'pinza' | 'giro') {
    const s = sesion.current;
    if (!s || !s.activos.has(cual)) return;
    s.activos.delete(cual);
    if (s.activos.size > 0) return;

    sesion.current = null;
    // De `ultimo`, no del cierre: los gestos se crearon en otra pintada.
    const {
      clave: deAhora,
      geometria: geo,
      mostrada: vista,
      alSoltar: soltar,
      alTirar: tirar,
      alCambiarGesto: avisar,
    } = ultimo.current;
    setModo('quieto');
    setGuias({ v: false, h: false });
    setCaliente(false);
    setTamanoVivo(null);
    setGiroVivo(null);
    avisar(false);

    if (s.caliente && !s.pellizco) {
      setTirado(deAhora);
      void tirar().then((hecho) => {
        if (hecho) return;
        // No se pudo quitar: vuelve a su sitio, que es el de antes de arrastrar.
        setTirado(null);
        escala.setValue(1);
        const { geometria: g, medida: m, mostrada: d } = ultimo.current;
        const med = d ? medidaA(d.tamano, m) : null;
        if (g && d && med) ponerEn(colocar(d, g.lienzo, g.zona, med, d.giro), med, d.giro);
      });
      return;
    }
    escala.setValue(1);
    if (!geo) return;
    const f = aFracciones(s.centro, geo.lienzo);
    const sitio: Soltado = { x: f.x, y: f.y, tamano: s.tamano, giro: s.giro };
    if (vista && mismaDisposicion(vista, sitio)) return;
    setLocal(sitio);
    anterior.current = { clave: deAhora, disposicion: sitio };
    void soltar(sitio).finally(() => {
      setLocal((actual) => (actual === sitio ? null : actual));
    });
  }

  const gestos = useMemo(() => {
    const tocar = Gesture.Tap()
      .runOnJS(true)
      .enabled(puedeEditar && !editando)
      .maxDistance(UMBRAL_DE_ARRASTRE)
      .onEnd((_evento, hecho) => {
        if (hecho) ultimo.current.alTocar();
      });
    if (!puedeMover || editando) return tocar;

    const arrastre = Gesture.Pan()
      .runOnJS(true)
      .minDistance(UMBRAL_DE_ARRASTRE)
      // Con dos dedos, la traslación es la de su punto medio.
      .averageTouches(true)
      .onStart((evento) => {
        if (!empezar('pan')) return;
        const s = sesion.current as Sesion;
        const { medida: base } = ultimo.current;
        const yaMovido = { x: evento.translationX, y: evento.translationY };
        const primero = s.activos.size === 1;
        // Si el arrastre abre el gesto, el texto sigue al dedo desde donde se
        // tocó (alcanza los pocos puntos que el dedo ya se movió para
        // arrancar). Si llega a mitad de una pinza, parte de donde está: así
        // no salta.
        s.origen = primero ? { x: 0, y: 0 } : yaMovido;
        // El dedo, en el lienzo, cuando se tocó: donde está ahora menos lo
        // que ya se ha movido. En el teléfono sale del toque dentro del texto;
        // en la web, del toque en la ventana (`dedoAlEmpezar` explica por qué).
        if (base && primero) {
          const pildora = medidaA(s.tamano, base) as Medida;
          const dedo = dedoAlEmpezar({
            web: Platform.OS === 'web',
            centro: s.centro,
            caja: { ancho: pildora.ancho + 2 * MARGEN_TACTIL, alto: pildora.alto + 2 * MARGEN_TACTIL },
            giro: s.giro,
            toqueLocal: { x: evento.x, y: evento.y },
            toqueAbsoluto: { x: evento.absoluteX, y: evento.absoluteY },
            origenDeLaCapa: origenEnLaVentana(),
          });
          s.dedoInicial = { x: dedo.x - yaMovido.x, y: dedo.y - yaMovido.y };
        }
        s.centroInicial = s.centro;
        s.traslacion = { x: yaMovido.x - s.origen.x, y: yaMovido.y - s.origen.y };
        recalcular();
      })
      .onUpdate((evento) => {
        const s = sesion.current;
        if (!s || !s.activos.has('pan')) return;
        s.traslacion = { x: evento.translationX - s.origen.x, y: evento.translationY - s.origen.y };
        recalcular();
      })
      .onFinalize(() => terminar('pan'));

    const pinza = Gesture.Pinch()
      .runOnJS(true)
      .onStart(() => {
        empezar('pinza');
      })
      .onUpdate((evento) => {
        const s = sesion.current;
        if (!s || !s.activos.has('pinza')) return;
        s.escala = evento.scale;
        recalcular();
      })
      .onFinalize(() => terminar('pinza'));

    const vuelta = Gesture.Rotation()
      .runOnJS(true)
      .onStart(() => {
        empezar('giro');
      })
      .onUpdate((evento) => {
        const s = sesion.current;
        if (!s || !s.activos.has('giro')) return;
        s.rotacion = (evento.rotation * 180) / Math.PI;
        recalcular();
      })
      .onFinalize(() => terminar('giro'));

    return Gesture.Race(Gesture.Simultaneous(arrastre, pinza, vuelta), tocar);
    // Los gestos leen lo demás de `ultimo`: solo se rehacen si cambia quién puede qué.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [puedeMover, puedeEditar, editando]);

  /* ------------------------------------------------------------ pintar -- */

  // La capa se pinta SIEMPRE, aunque no haya texto: es la que mide la
  // pantalla útil. Mientras dura un gesto sube por encima de todo lo demás.
  const medirLienzo = (evento: LayoutChangeEvent) => {
    const { x, y, width, height } = evento.nativeEvent.layout;
    alMedirLienzo({ x, y, ancho: width, alto: height });
  };
  const capa = [StyleSheet.absoluteFill, modo !== 'quieto' ? estilos.porEncima : null];
  if (!rotulo || !geometria) {
    return <View ref={capaRef} style={capa} pointerEvents="box-none" onLayout={medirLienzo} />;
  }
  const { zona, lienzo, papelera } = geometria;
  const escondido = tirado !== null && tirado === clave;
  const listo = Boolean(medida) && !escondido;
  const arrastrando = modo === 'arrastre';
  const conGesto = modo !== 'quieto';
  const anchoMaximo = Math.max(0, zona.derecha - zona.izquierda);
  const centroZona = centroDeLaZona(zona);
  const medidaActual = medidaA(tamanoPintado);
  const lectura =
    modo === 'pellizco' && medidaActual && sesion.current
      ? {
          x: sesion.current.centro.x,
          y: Math.max(
            spacing.lg,
            sesion.current.centro.y -
              mitadesGiradas(medidaActual, giroVivo ?? 0).my -
              spacing.md,
          ),
        }
      : null;

  return (
    <View ref={capaRef} style={capa} pointerEvents="box-none" onLayout={medirLienzo}>
      {arrastrando ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <View
            style={[
              estilos.zona,
              {
                left: zona.izquierda,
                top: zona.arriba,
                width: anchoMaximo,
                height: Math.max(0, zona.abajo - zona.arriba),
              },
            ]}
          >
            <Text variant="caption" weight="800" color={rotuloDeDirecto.zonaTexto} style={estilos.rotuloDeZona}>
              {t('live.bannerZone')}
            </Text>
          </View>
          <View
            style={[
              estilos.guia,
              guias.v ? estilos.guiaFija : null,
              { left: lienzo.ancho / 2 - 0.5, top: zona.arriba, width: 1, height: Math.max(0, zona.abajo - zona.arriba) },
            ]}
          />
          <View
            style={[
              estilos.guia,
              guias.h ? estilos.guiaFija : null,
              { left: zona.izquierda, top: centroZona.y - 0.5, width: anchoMaximo, height: 1 },
            ]}
          />
          <View
            style={[estilos.papelera, { left: papelera.x - PAPELERA / 2, top: papelera.y - PAPELERA / 2 }]}
          >
            <View style={[estilos.circulo, caliente ? estilos.circuloCaliente : null]}>
              <Feather name="trash-2" size={22} color={sobreMedio.text} />
            </View>
            {caliente ? (
              <Text variant="caption" weight="800" color={sobreMedio.text} style={estilos.letrero}>
                {t('live.bannerDropToRemove')}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}

      <Animated.View
        style={[StyleSheet.absoluteFill, { transform: [{ translateY: subida }] }]}
        pointerEvents="box-none"
      >
        <GestureDetector gesture={gestos}>
          <Animated.View
            collapsable={false}
            style={[
              estilos.colocado,
              { opacity: listo ? 1 : 0 },
              {
                transform: [
                  { translateX: esquinaX },
                  { translateY: esquinaY },
                  { rotate: giro.interpolate({ inputRange: [-360, 360], outputRange: ['-360deg', '360deg'] }) },
                  { scale: escala },
                ],
              },
            ]}
            pointerEvents={listo && (puedeMover || puedeEditar) ? 'auto' : 'none'}
            accessible
            accessibilityRole={puedeEditar ? 'button' : 'text'}
            accessibilityLabel={etiqueta}
            accessibilityHint={pista}
            // Quien entra a media emisión lo oye; no se vuelve a anunciar al releer.
            accessibilityLiveRegion="polite"
            onAccessibilityTap={puedeEditar ? alTocar : undefined}
            accessibilityActions={puedeEditar ? [{ name: 'activate' }] : undefined}
            onAccessibilityAction={(evento) => {
              if (puedeEditar && evento.nativeEvent.actionName === 'activate') alTocar();
            }}
          >
            {/* El marco que le dice al host que el texto se puede tocar y mover. */}
            {puedeMover && !conGesto && !editando ? (
              <View style={estilos.marco} pointerEvents="none" />
            ) : null}
            <RotuloDeDirecto
              rotulo={rotulo}
              claveDeEntrada={clave}
              reduceMotion={reduceMotion}
              anchoMaximo={anchoMaximo}
              tamano={tamanoPintado}
              alMedir={(nueva) => {
                setMedida((antes) =>
                  antes &&
                  antes.tamano === tamanoPintado &&
                  antes.medida.ancho === nueva.ancho &&
                  antes.medida.alto === nueva.alto
                    ? antes
                    : { medida: nueva, tamano: tamanoPintado },
                );
              }}
            />
          </Animated.View>
        </GestureDetector>
      </Animated.View>

      {lectura ? (
        <View
          style={[estilos.lectura, { left: lectura.x, top: lectura.y }]}
          pointerEvents="none"
        >
          <Text variant="caption" weight="800" color={sobreMedio.text}>
            {`${tamanoVivo ?? tamanoPintado} % · ${giroVivo ?? 0}°`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const estilos = StyleSheet.create({
  porEncima: { zIndex: 2 },
  colocado: {
    position: 'absolute',
    left: 0,
    top: 0,
    padding: MARGEN_TACTIL,
  },
  marco: {
    position: 'absolute',
    left: MARGEN_TACTIL - 6,
    top: MARGEN_TACTIL - 6,
    right: MARGEN_TACTIL - 6,
    bottom: MARGEN_TACTIL - 6,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: rotuloDeDirecto.marcoDelHost,
    borderRadius: radius.pill,
  },
  zona: {
    position: 'absolute',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: rotuloDeDirecto.zonaBorde,
    backgroundColor: rotuloDeDirecto.zonaRelleno,
    borderRadius: radius.sm,
    justifyContent: 'flex-end',
  },
  rotuloDeZona: {
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginLeft: spacing.sm,
    marginBottom: 6,
  },
  guia: { position: 'absolute', backgroundColor: rotuloDeDirecto.guia, opacity: 0.3 },
  guiaFija: { opacity: 1 },
  papelera: {
    position: 'absolute',
    width: PAPELERA,
    alignItems: 'center',
    gap: 6,
  },
  circulo: {
    width: PAPELERA,
    height: PAPELERA,
    borderRadius: PAPELERA / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    backgroundColor: rotuloDeDirecto.papelera,
    borderColor: rotuloDeDirecto.bordeDeLaPapelera,
  },
  circuloCaliente: {
    backgroundColor: rellenoDePeligro.fondo,
    borderColor: rellenoDePeligro.fondo,
    transform: [{ scale: 1.18 }],
  },
  letrero: {
    alignSelf: 'center',
    minWidth: 140,
    textAlign: 'center',
    borderRadius: radius.pill,
    overflow: 'hidden',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    backgroundColor: rotuloDeDirecto.letreroDeLaPapelera,
  },
  aviso: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  avisoPildora: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.md,
    paddingRight: 5,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: sobreMedio.border,
    backgroundColor: rotuloDeDirecto.avisoQuitado,
  },
  deshacer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minHeight: 32,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: sobreMedio.text,
  },
  apagado: { opacity: 0.5 },
  lectura: {
    position: 'absolute',
    transform: [{ translateX: -50 }, { translateY: -24 }],
    width: 100,
    alignItems: 'center',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    backgroundColor: rotuloDeDirecto.velo,
    borderWidth: 1,
    borderColor: rotuloDeDirecto.bordeDelVelo,
  },
});

/**
 * «Texto quitado · Deshacer», seis segundos, para quien lo quitó.
 *
 * Tirarlo a la papelera es un gesto rápido y se puede hacer sin querer: el
 * texto se va de la pantalla de toda la sala en el acto, pero se puede
 * devolver tal cual estaba —con su sitio, su tamaño y su color—.
 */
export function AvisoDeRotuloQuitado({
  arriba,
  ocupado,
  alDeshacer,
}: {
  /** A qué altura va, en puntos de la pantalla útil. */
  arriba: number;
  ocupado: boolean;
  alDeshacer: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={[estilos.aviso, { top: arriba }]} pointerEvents="box-none">
      <View style={estilos.avisoPildora} accessibilityLiveRegion="polite">
        <Text variant="secondary" weight="700" color={sobreMedio.text}>
          {t('live.bannerRemoved')}
        </Text>
        <Pulsable
          onPress={alDeshacer}
          disabled={ocupado}
          accessibilityRole="button"
          accessibilityLabel={t('live.bannerUndo')}
          style={[estilos.deshacer, ocupado ? estilos.apagado : null]}
        >
          <Feather name="rotate-ccw" size={13} color={sobreMedio.background} />
          <Text variant="caption" weight="800" color={sobreMedio.background}>
            {t('live.bannerUndo')}
          </Text>
        </Pulsable>
      </View>
    </View>
  );
}

/** Cuánto dura el aviso de «Texto quitado». */
export const DURACION_DEL_AVISO_DE_QUITADO_MS = 6_000;
