import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';

import { ContadorAnimado } from '@/components/ContadorAnimado';
import { IconoQueSeEnciende } from '@/components/IconoQueSeEnciende';
import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { ESCALA_AL_PULSAR } from '@/lib/movimiento';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Un botón de la fila de acciones de una publicación: icono, contador y NOMBRE.
 *
 * POR QUE LLEVA NOMBRE. El icono de republicar —dos flechas en ciclo— no dice
 * nada a quien no lo ha visto antes en otra aplicación. Se reportó tal cual:
 * «los usuarios no van a saber para qué sirve exactamente ese botón». Un icono
 * solo funciona cuando ya se conoce; el corazón y el globo de comentario sí,
 * las flechas no.
 *
 * POR QUE UN COMPONENTE Y NO CINCO BLOQUES. Eran cinco pulsables con el mismo
 * `hitSlop`, el mismo tamaño de icono y el mismo estilo de contador, escritos
 * cinco veces. Añadir el nombre debajo a mano habría sido escribir cinco veces
 * también el tamaño del texto, el recorte a una línea y la altura mínima — y
 * cada uno se habría desviado con el tiempo.
 *
 * RESPONSIVE. Cada acción ocupa la misma fracción de la fila (`flex: 1`) y su
 * nombre se recorta a UNA línea. En un teléfono estrecho eso encoge las
 * columnas, no monta unas sobre otras ni estira la tarjeta a lo alto. El área
 * pulsable se mantiene con `minHeight` más el `hitSlop`, que es lo que sostiene
 * los 44 puntos aunque el icono mida 19.
 */

/** Lo que se puede pulsar cómodamente sin agrandar el icono. */
const AREA_PULSABLE = { top: 10, bottom: 10, left: 6, right: 6 };

type Props = {
  icono: keyof typeof Feather.glyphMap;
  /**
   * La variante RELLENA del icono, para el estado encendido.
   *
   * POR QUE OTRA FAMILIA. El estado no puede vivir solo en el color: se
   * reportó que «aparece la notificación de que se guardó pero el icono no se
   * pinta», y dos tonos del mismo dibujo no se distinguen en un móvil al sol
   * —ni los distingue quien no separa bien los colores—. Feather solo dibuja
   * contornos: su `bookmark` no tiene versión rellena. `MaterialCommunityIcons`
   * sí, y viene en el MISMO paquete (`@expo/vector-icons`) que ya se usa, así
   * que no añade ninguna dependencia.
   *
   * Sin esta propiedad el botón se comporta como siempre: mismo dibujo,
   * distinto color.
   */
  iconoRelleno?: keyof typeof MaterialCommunityIcons.glyphMap;
  /** El nombre que se lee debajo. Traducido por quien llama. */
  etiqueta: string;
  /** Se omite cuando no hay nada que contar (compartir, guardar). */
  contador?: number;
  /** Estado encendido: pinta el icono con `colorActivo`. */
  activo?: boolean;
  /**
   * El servidor aún no ha confirmado el último toque. El icono ya enseña lo
   * pedido, algo atenuado, y recupera su tinta al confirmarse. El botón NO se
   * apaga: se puede seguir pulsando y la última intención es la que vale.
   */
  pendiente?: boolean;
  /**
   * El color del estado encendido. Se pide explícito porque no es el mismo en
   * todas: «me gusta» es el color de peligro y guardar el primario.
   */
  colorActivo?: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel: string;
  accessibilityRole?: 'button' | 'switch';
  accessibilityState?: { checked?: boolean };
  /**
   * Un SEGUNDO destino, sobre el número.
   *
   * Es el caso de «me gusta»: el corazón reacciona y el número abre la lista de
   * quién reaccionó. Son dos cosas distintas y por eso son dos pulsables, no
   * uno con dos significados.
   */
  alPulsarContador?: () => void;
  /** Lo que se anuncia del segundo destino. */
  etiquetaDelContador?: string;
};

export function AccionDePublicacion({
  icono,
  iconoRelleno,
  etiqueta,
  contador,
  activo = false,
  pendiente = false,
  colorActivo,
  onPress,
  disabled,
  accessibilityLabel,
  accessibilityRole = 'button',
  accessibilityState,
  alPulsarContador,
  etiquetaDelContador,
}: Props) {
  const { colors } = useAppTheme();
  const colorDelIcono = activo ? (colorActivo ?? colors.text) : colors.text;

  return (
    <View style={styles.accion}>
      <View style={styles.fila}>
        {/*
          Se hunde bajo el dedo (`Pulsable`) y, al cambiar de estado, el icono
          salta (`IconoQueSeEnciende`). Son dos respuestas distintas: la
          primera dice «te he oído» y la segunda «ha cambiado».
        */}
        <Pulsable
          hitSlop={AREA_PULSABLE}
          onPress={onPress}
          disabled={disabled}
          escala={ESCALA_AL_PULSAR.icono}
          atenuar={0.7}
          opacidad={disabled ? 0.4 : 1}
          accessibilityLabel={accessibilityLabel}
          accessibilityRole={accessibilityRole}
          accessibilityState={{ ...accessibilityState, disabled, busy: pendiente }}
        >
          <IconoQueSeEnciende activo={activo} pendiente={pendiente}>
            {/*
              Encendido y con variante rellena: cambia la FORMA, no solo el
              tono. Es lo que hace que se vea que quedo guardada.
            */}
            {activo && iconoRelleno ? (
              <MaterialCommunityIcons name={iconoRelleno} size={21} color={colorDelIcono} />
            ) : (
              <Feather name={icono} size={20} color={colorDelIcono} />
            )}
          </IconoQueSeEnciende>
        </Pulsable>

        {/*
          Se pinta tambien el cero: «0 comentarios» es informacion, y que el
          numero aparezca y desaparezca movia los iconos de sitio. Quien no
          tenga nada que contar —compartir, guardar— no manda `contador`.
        */}
        {contador !== undefined ? (
          alPulsarContador && contador > 0 ? (
            <Pressable
              hitSlop={AREA_PULSABLE}
              onPress={alPulsarContador}
              accessibilityLabel={etiquetaDelContador ?? accessibilityLabel}
              accessibilityRole="button"
              style={styles.contadorPulsable}
            >
              <ContadorAnimado valor={contador} variant="secondary" weight="600" style={styles.contador} />
            </Pressable>
          ) : (
            <ContadorAnimado
              valor={contador}
              variant="secondary"
              weight="600"
              style={styles.contador}
            />
          )
        ) : null}
      </View>

      {/*
        El nombre NO es pulsable a proposito. En «me gusta» hay dos destinos
        —el corazon y el numero— y un tercer area que abarcara los dos no
        podria decidir cual de las dos cosas hacer.
      */}
      <Text
        variant="secondary"
        color={colors.textMuted}
        numberOfLines={1}
        style={styles.etiqueta}
      >
        {etiqueta}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  accion: {
    // Todas ocupan lo mismo: en un telefono estrecho encogen a la vez en vez de
    // empujarse unas a otras.
    flex: 1,
    alignItems: 'center',
    // Con el hitSlop, lo que sostiene los ~44 puntos de area pulsable.
    minHeight: 44,
    justifyContent: 'center',
  },
  fila: { flexDirection: 'row', alignItems: 'center' },
  contadorPulsable: { marginLeft: spacing.xs },
  contador: { marginLeft: spacing.xs },
  etiqueta: {
    // Deliberadamente pequeño: informa sin competir con el contenido de la
    // publicacion ni estirar la tarjeta.
    fontSize: 10,
    marginTop: 2,
  },
});
