import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { BottomSheet } from '@/components/BottomSheet';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { filtrosOfrecidos, type FiltroDeBandeja } from '@/lib/bandeja';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  seleccionado: FiltroDeBandeja | null;
  /** `null` quita el filtro. Quien reciba esto vuelve a pedir la lista. */
  alSeleccionar: (filtro: FiltroDeBandeja | null) => void;
  /**
   * `false` mientras la migración 0044 no esté aplicada: entonces «Respuestas a
   * historias» NO SE OFRECE. Sin la tabla `message_story_context` el servidor
   * devuelve siempre una lista vacía, así que el botón existiría para no
   * encontrar nunca nada. Nunca un botón muerto.
   */
  respuestasAHistorias: boolean;
};

/** Cómo se llama cada filtro, en el idioma de quien mira. */
const TEXTOS: Record<FiltroDeBandeja, 'messages.filterUnread' | 'messages.filterUnanswered' | 'messages.filterStoryReplies'> = {
  unread: 'messages.filterUnread',
  unanswered: 'messages.filterUnanswered',
  story_replies: 'messages.filterStoryReplies',
};

const ICONOS: Record<FiltroDeBandeja, keyof typeof Feather.glyphMap> = {
  unread: 'mail',
  unanswered: 'corner-up-left',
  story_replies: 'circle',
};

/**
 * El botón de Filtros y su hoja.
 *
 * -----------------------------------------------------------------------------
 * SON EXACTAMENTE TRES, Y NO SE PARECEN A LOS DE INSTAGRAM POR CASUALIDAD
 * -----------------------------------------------------------------------------
 * «No leídos», «No respondidos» y «Respuestas a historias». La bandeja de
 * Instagram ofrece además «perfiles verificados» y «más de 10 000 seguidores»;
 * no se copian. Aquí se atiende a alumnos y a interesados, no a una lista de
 * famosos, y un filtro que nadie usa ocupa el sitio de los que sí.
 *
 * -----------------------------------------------------------------------------
 * SON ESTADOS DERIVADOS, NO ETIQUETAS
 * -----------------------------------------------------------------------------
 * Se calculan de los mensajes y cambian solos: nadie los pone ni los quita. Por
 * eso van en un botón aparte de la fila de chips del CRM, que son categorías
 * PERSISTENTES que escribe una persona. Se pueden combinar —«no respondidos
 * entre los que marqué como Alumnos»— pero no se mezclan: guardar «no leído»
 * como una etiqueta manual sería un cajón de sastre, porque nadie vuelve a
 * desmarcarla y a los dos días la etiqueta miente.
 *
 * -----------------------------------------------------------------------------
 * FILTRAN EN EL SERVIDOR
 * -----------------------------------------------------------------------------
 * Este componente no toca ninguna lista: avisa de lo elegido y quien lo recibe
 * vuelve a pedir la página con `filtro=…`. Filtrar aquí lo ya descargado costaría
 * cero peticiones pero solo vería las veinte filas de la primera página, que es
 * el mismo engaño que tenía la búsqueda.
 */
export function FiltrosDeBandeja({
  seleccionado,
  alSeleccionar,
  respuestasAHistorias,
}: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const [abierto, setAbierto] = useState(false);

  const disponibles = filtrosOfrecidos(respuestasAHistorias);

  const elegir = (filtro: FiltroDeBandeja | null) => {
    setAbierto(false);
    alSeleccionar(filtro);
  };

  return (
    <>
      <Pressable
        onPress={() => setAbierto(true)}
        accessibilityRole="button"
        accessibilityLabel={t('messages.filtersTitle')}
        // `checked` y no solo la etiqueta: quien navega con lector de pantalla
        // no ve que el botón esté relleno, y tiene que poder saber si hay un
        // filtro puesto sin abrir la hoja.
        accessibilityState={{ checked: seleccionado !== null }}
        style={({ pressed }) => [
          styles.boton,
          {
            backgroundColor: seleccionado ? colors.primary : colors.surfaceAlt,
            borderColor: seleccionado ? colors.primary : colors.border,
            opacity: pressed ? 0.8 : 1,
          },
        ]}
      >
        <Feather
          name="sliders"
          size={15}
          color={seleccionado ? colors.onPrimary : colors.text}
        />
        <Text
          variant="caption"
          weight="700"
          color={seleccionado ? colors.onPrimary : colors.text}
          numberOfLines={1}
        >
          {/*
            Con filtro puesto se lee CUÁL, no la palabra «Filtros». Una lista
            recortada sin decir por qué es lo que hace pensar que faltan
            conversaciones.
          */}
          {seleccionado ? t(TEXTOS[seleccionado]) : t('messages.filters')}
        </Text>
      </Pressable>

      <BottomSheet visible={abierto} onClose={() => setAbierto(false)}>
        <Text variant="titleMedium" weight="800" color={colors.text}>
          {t('messages.filtersTitle')}
        </Text>

        <View style={styles.lista}>
          <Opcion
            icono="inbox"
            texto={t('messages.filterAll')}
            elegida={seleccionado === null}
            alPulsar={() => elegir(null)}
          />
          {disponibles.map((filtro) => (
            <Opcion
              key={filtro}
              icono={ICONOS[filtro]}
              texto={t(TEXTOS[filtro])}
              elegida={seleccionado === filtro}
              // Volver a tocar el que ya está puesto lo quita: es el camino
              // corto de vuelta a la bandeja entera.
              alPulsar={() => elegir(seleccionado === filtro ? null : filtro)}
            />
          ))}
        </View>
      </BottomSheet>
    </>
  );
}

function Opcion({
  icono,
  texto,
  elegida,
  alPulsar,
}: {
  icono: keyof typeof Feather.glyphMap;
  texto: string;
  elegida: boolean;
  alPulsar: () => void;
}) {
  const { colors } = useAppTheme();
  return (
    <Pressable
      onPress={alPulsar}
      accessibilityRole="radio"
      accessibilityState={{ selected: elegida }}
      accessibilityLabel={texto}
      style={({ pressed }) => [
        styles.opcion,
        { borderColor: colors.border, opacity: pressed ? 0.8 : 1 },
      ]}
    >
      <Feather name={icono} size={18} color={colors.text} />
      <Text style={styles.opcionTexto} color={colors.text} weight={elegida ? '700' : '400'}>
        {texto}
      </Text>
      {/* La marca y la negrita a la vez: el estado no puede depender solo de un
          icono pequeño ni solo del grosor de la letra. */}
      {elegida ? <Feather name="check" size={18} color={colors.text} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  boton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    height: 34,
    // Un filtro con nombre largo no puede empujar a la fila de chips fuera de
    // la pantalla.
    maxWidth: 200,
  },
  lista: { marginTop: spacing.md, gap: 2 },
  opcion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
  },
  opcionTexto: { flex: 1, fontSize: 15 },
});
