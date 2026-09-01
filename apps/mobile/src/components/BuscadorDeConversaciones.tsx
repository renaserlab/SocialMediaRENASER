import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { useTranslation } from '@/i18n/useTranslation';
import {
  ESPERA_DE_TECLEO_MS,
  esBuscable,
  normalizarTermino,
} from '@/lib/busquedaProgresiva';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  /**
   * Se llama con el término YA LISTO para viajar, después del antirrebote.
   *
   * Cadena vacía significa «deja de buscar»: la pantalla vuelve a pedir la lista
   * entera. Nunca se llama con lo que se está tecleando a medias.
   */
  alBuscar: (termino: string) => void;
};

/**
 * La barra de búsqueda de la bandeja. Su estado NO repinta la lista.
 *
 * -----------------------------------------------------------------------------
 * POR QUÉ ES UN COMPONENTE APARTE Y NO UN `TextInput` DENTRO DE LA PANTALLA
 * -----------------------------------------------------------------------------
 * Porque el texto tecleado vivía en el estado de `MessagesScreen`, y ahí cada
 * pulsación volvía a pintar la lista entera: `data` cambiaba de identidad, el
 * `renderItem` era una flecha en línea y la cabecera se reconstruía. Medido en
 * `docs/Z_MEDICION_MENSAJES_EXPLORE.md` §2.4: en una pantalla de 812 px caben
 * 7-8 filas, así que escribir un nombre de ocho letras eran unos **64 renders de
 * fila**, sin `React.memo` en ninguna.
 *
 * Aquí el texto es estado LOCAL. Teclear repinta este componente y nada más; la
 * pantalla solo se entera cuando el término se asienta.
 *
 * -----------------------------------------------------------------------------
 * EL ANTIRREBOTE NO SE INVENTA: SE REUTILIZA
 * -----------------------------------------------------------------------------
 * `ESPERA_DE_TECLEO_MS`, `esBuscable` y `normalizarTermino` salen de
 * `lib/busquedaProgresiva.ts`, que ya usan Explorar y Buscar y que está probado.
 * Sin antirrebote, escribir «martinez» son **ocho peticiones**; con él, una o
 * dos. Y el mínimo de dos caracteres evita pedir la bandeja entera —filtrada por
 * «a»— en cuanto alguien toca el campo.
 *
 * Que una respuesta lenta no pise a una más nueva se decide en la pantalla, con
 * el sello de `lib/bandeja.ts`: aquí no se sabe cuándo vuelve nada.
 */
export const BuscadorDeConversaciones = React.memo(function BuscadorDeConversaciones({
  alBuscar,
}: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const [texto, setTexto] = useState('');
  const [enfocado, setEnfocado] = useState(false);

  /*
    El último término que se le ha comunicado a la pantalla.

    Sin esto, pasar de «ana » a «ana» —un espacio de sobra que la normalización
    quita— relanzaría la misma búsqueda. Y al montar volvería a pedirse la lista
    sin filtro, que la pantalla ya está pidiendo por su cuenta.
  */
  const ultimoEnviado = useRef('');

  useEffect(() => {
    const termino = esBuscable(texto) ? normalizarTermino(texto) : '';
    if (termino === ultimoEnviado.current) return;
    const temporizador = setTimeout(() => {
      ultimoEnviado.current = termino;
      alBuscar(termino);
    }, ESPERA_DE_TECLEO_MS);
    // Cada tecla cancela el disparo anterior: es lo que convierte ocho
    // peticiones en una.
    return () => clearTimeout(temporizador);
  }, [texto, alBuscar]);

  const limpiar = useCallback(() => setTexto(''), []);

  return (
    <View
      style={[
        styles.campo,
        {
          backgroundColor: colors.surfaceAlt,
          // Un borde de un pixel que solo se marca al enfocar. La captura del
          // documento describía el campo anterior como «muy mal aspecto»: era un
          // recuadro con el mismo grosor que un botón, siempre encendido.
          borderColor: enfocado ? colors.text : colors.border,
        },
      ]}
    >
      {/*
        La lupa va DENTRO de la caja, como un hermano del campo, y no colocada
        encima con posición absoluta. Antes se superponía con `left`, `top: 0` y
        `bottom: 0`, y el texto tenía que esquivarla con un relleno calculado a
        mano: cualquier cambio de fuente o de tamaño lo descuadraba, y en web se
        descuadraba solo.
      */}
      <Feather name="search" size={17} color={colors.textMuted} />
      <TextInput
        value={texto}
        onChangeText={setTexto}
        onFocus={() => setEnfocado(true)}
        onBlur={() => setEnfocado(false)}
        placeholder={t('messages.searchPlaceholder')}
        placeholderTextColor={colors.textMuted}
        style={[styles.entrada, { color: colors.text }]}
        accessibilityLabel={t('messages.searchPlaceholder')}
        // Un nombre no se escribe en mayúscula automática ni se autocorrige: el
        // corrector convertía apellidos poco comunes en otra palabra y la
        // búsqueda no encontraba a nadie.
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        // En iOS pinta la X y el aspecto de campo de búsqueda del sistema; en
        // Android y web no hace nada, y por eso el botón de borrar es propio.
        clearButtonMode="never"
      />
      {texto.length > 0 ? (
        <Pressable
          onPress={limpiar}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={t('messages.searchClear')}
        >
          <Feather name="x" size={16} color={colors.textMuted} />
        </Pressable>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  campo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    // Alto fijo y no relleno vertical: así el campo mide lo mismo en Android,
    // iOS y web, donde `TextInput` calcula su alto de tres formas distintas.
    height: 40,
  },
  // `flex: 1` para que el texto ocupe lo que sobra entre la lupa y la X, sin
  // rellenos calculados a mano.
  entrada: { flex: 1, fontSize: 14, padding: 0 },
});
