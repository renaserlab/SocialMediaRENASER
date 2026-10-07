import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { PildoraActiva } from '@/components/PildoraActiva';
import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ALTO_SELECTOR } from '@/lib/controlesDeCamara';
import { ESCALA_AL_PULSAR } from '@/lib/movimiento';
import { getFontFamily, radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export type ModoDeCreacion = 'publicacion' | 'historia' | 'reel' | 'vivo';

// La etiqueta se guarda como CLAVE, no como texto: el rotulo se resuelve al
// pintar, que es cuando se sabe en que idioma esta la aplicacion.
export const MODOS: Array<{ id: ModoDeCreacion; clave: TranslationKey }> = [
  { id: 'publicacion', clave: 'create.modePost' },
  { id: 'historia', clave: 'create.modeStory' },
  { id: 'reel', clave: 'create.modeReel' },
  { id: 'vivo', clave: 'create.modeLive' },
];

export function posicionDeModo(modo: ModoDeCreacion): number {
  return MODOS.findIndex((m) => m.id === modo);
}

/**
 * Lee el modo que llega por la URL (`/(tabs)/create?modo=historia`).
 *
 * Existe para que TODOS los accesos a crear contenido —el `+` de la cabecera de
 * Inicio, el de la fila de historias, el del muro y la propia pestaña— entren
 * por la misma puerta y solo se diferencien en con que modo abren. Cualquier
 * valor que no reconozcamos cae en Publicacion, que es el modo por defecto.
 */
export function modoDesdeParametro(valor: unknown): ModoDeCreacion {
  return MODOS.some((m) => m.id === valor) ? (valor as ModoDeCreacion) : 'publicacion';
}

/** Aire entre el borde de la barra y sus opciones. */
const RELLENO = 6;

type Props = {
  activo: ModoDeCreacion;
  alCambiar: (modo: ModoDeCreacion) => void;
  /**
   * `false` mientras Crear no es la seccion que se esta viendo.
   *
   * Al llegar a Crear arrastrando desde la seccion de al lado, la barra de
   * secciones sigue puesta hasta que se suelta el dedo. Sin esto se verian las
   * dos a la vez, una asomando por detras de la otra. Se oculta en vez de
   * desmontarse para que lo de encima no de un salto al aparecer.
   */
  visible?: boolean;
};

/**
 * La barra de tipos de publicacion: Publicacion · Historia · Reel · Vivo.
 *
 * QUE ERA Y POR QUE CAMBIA. Era una fila de palabras blancas escritas sobre la
 * imagen de la camara, con un velo detras. Sobre una imagen que cambia en cada
 * fotograma ningun color de letra se lee siempre, y ademas solo cabian dos o
 * tres de las cuatro: las otras quedaban cortadas por los lados.
 *
 * Ahora es una barra con FONDO PROPIO, en el sitio de la barra de secciones,
 * que en Crear se retira (ver `traeSuPropiaBarra`). Las cuatro opciones se ven
 * a la vez y el contraste ya no depende de lo que haya detras: fondo claro y
 * letra oscura con el tema claro, y al reves con el oscuro.
 *
 * DE LA MISMA FAMILIA QUE LA DE SECCIONES, PERO NO IGUAL. Misma capsula
 * flotante, mismo borde, misma sombra y misma forma de marcar la opcion activa.
 * Lo que la distingue, para que nadie crea que sigue en la barra de secciones:
 * llega casi a los bordes (8 px de margen, la otra 16), es mas alta
 * (`ALTO_SELECTOR`), no lleva iconos y la opcion activa va en negativo.
 *
 * Se cambia tocando una opcion o arrastrando de lado sobre la pantalla, como
 * antes: el gesto lo declara `CrearScreen`.
 */
export function SelectorDeModo({ activo, alCambiar, visible = true }: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();

  return (
    <View
      style={[styles.host, visible ? null : styles.oculta]}
      pointerEvents={visible ? 'box-none' : 'none'}
    >
      {/* La sombra vive en el envoltorio: iOS la ignora cuando el mismo nodo
          recorta su contenido. */}
      <View
        style={[
          styles.sombra,
          {
            shadowColor: colors.glassShadow,
            ...(Platform.OS === 'android' ? { elevation: 10 } : null),
          },
        ]}
      >
        <View
          accessibilityRole="tablist"
          style={[
            styles.barra,
            {
              /*
                Superficie OPACA, no el vidrio translucido de la de secciones.
                Detras hay una camara en vivo: con un 6 % de transparencia el
                blanco se volvia gris sobre un fondo oscuro, y lo que se pidio
                es que el contraste no dependa de lo que haya detras. Y sin
                desenfoque, que obligaria a redibujar la barra en cada
                fotograma.
              */
              backgroundColor: colors.surface,
              borderColor: colors.glassBorder,
            },
          ]}
        >
          {MODOS.map(({ id, clave }) => {
            const etiqueta = t(clave);
            const seleccionado = id === activo;
            return (
              <Pulsable
                key={id}
                onPress={() => alCambiar(id)}
                escala={ESCALA_AL_PULSAR.chip}
                atenuar={0.8}
                haptica="ligera"
                style={styles.opcion}
                accessibilityRole="tab"
                accessibilityState={{ selected: seleccionado }}
                accessibilityLabel={etiqueta}
              >
                <Rotulo texto={etiqueta} color={colors.text} />
                <PildoraActiva activa={seleccionado} color={colors.primary} style={styles.pildora}>
                  <Rotulo texto={etiqueta} color={colors.onPrimary} />
                </PildoraActiva>
              </Pulsable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

/**
 * El nombre de una opcion.
 *
 * Se pinta DOS veces por opcion —debajo, en el color del texto; dentro de la
 * capsula, en el inverso— y por eso es un componente: las dos tienen que medir
 * exactamente lo mismo o al elegir una opcion la letra daria un saltito.
 */
function Rotulo({ texto, color }: { texto: string; color: string }) {
  return (
    <Text
      numberOfLines={1}
      // Red de seguridad para un telefono estrecho o un idioma con nombres mas
      // largos: antes que cortar una palabra, se encoge un poco.
      adjustsFontSizeToFit
      minimumFontScale={0.8}
      style={[styles.rotulo, { color }]}
    >
      {texto}
    </Text>
  );
}

const styles = StyleSheet.create({
  host: {
    alignItems: 'center',
    // La de secciones deja `spacing.lg` a cada lado: esta se acerca mas al borde.
    paddingHorizontal: spacing.sm,
  },
  oculta: { opacity: 0 },
  sombra: {
    width: '100%',
    // Mismo criterio que la de secciones: en tablet o en el navegador deja de
    // crecer y se queda centrada en vez de volverse una regla de lado a lado.
    maxWidth: 520,
    borderRadius: radius.pill,
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
  barra: {
    flexDirection: 'row',
    alignItems: 'center',
    height: ALTO_SELECTOR,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    padding: RELLENO,
    overflow: 'hidden',
  },
  opcion: {
    /*
      Cada opcion ocupa lo que pide su nombre y el sobrante se reparte a partes
      iguales. Con cuatro huecos iguales, «Publicación» no cabia en el suyo
      mientras a «Reel» le sobraba la mitad.
    */
    flexGrow: 1,
    flexShrink: 1,
    height: ALTO_SELECTOR - RELLENO * 2,
    paddingHorizontal: spacing.sm + 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  // Ocupa la opcion entera y repite su margen, para que el nombre de dentro
  // caiga justo encima del de debajo.
  pildora: { paddingHorizontal: spacing.sm + 2 },
  rotulo: {
    fontSize: 14,
    // El mismo grosor elegida o no: si cambiara, cambiaria el ancho de la
    // palabra y con el el de todas las opciones.
    fontFamily: getFontFamily('700'),
    fontWeight: Platform.OS === 'ios' ? '700' : undefined,
  },
});
