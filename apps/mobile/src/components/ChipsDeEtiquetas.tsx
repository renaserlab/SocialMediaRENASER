import React from 'react';
import { Pressable, ScrollView, StyleSheet, View, ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Chip } from '@/components/Chip';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { SinCambioDeSeccion } from '@/navigation/tabSwipe';
import type { Etiqueta } from '@/repositories/EtiquetasRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  /** Las etiquetas de quien mira. Vienen de `cargarEtiquetas()`. */
  etiquetas: Etiqueta[];
  /** La etiqueta por la que se está filtrando. `null` = «Todos», sin filtro. */
  seleccionada: string | null;
  /**
   * Cambia el filtro. Quien reciba esto tiene que volver a pedir la lista al
   * SERVIDOR con `label_id`, no quedarse filtrando lo que ya tiene cargado: con
   * doscientas conversaciones, filtrar las veinte que hay en memoria es
   * mentirle a quien busca.
   */
  alSeleccionar: (id: string | null) => void;
  /**
   * `false` mientras la migración 0045 no esté aplicada. La fila entera
   * desaparece: nunca un botón muerto.
   */
  disponible?: boolean;
  /**
   * Abre el gestor de etiquetas. Si no se pasa, no sale el botón: este
   * componente no decide dónde se gestionan, sólo ofrece la puerta si la hay.
   */
  alGestionar?: () => void;
  style?: ViewStyle;
};

/**
 * La fila de filtros de la bandeja: «Todos · Seguimiento · Interesados · Alumnos».
 *
 * Es la parte visible del CRM, y va arriba del todo porque su trabajo es decir
 * de un vistazo qué hay y permitir cambiar de vista sin abrir nada. Al estilo de
 * la bandeja de Instagram.
 *
 * NO GUARDA ESTADO NI PIDE DATOS. Recibe las etiquetas y cuál está elegida, y
 * avisa cuando se toca otra. Es a propósito: quien filtra es la consulta del
 * servidor —con su paginación—, así que el estado tiene que vivir donde se
 * lanza esa consulta. Un componente que se guardara aquí «la elegida» acabaría
 * discrepando de lo que se está mostrando en cuanto la pantalla recargara.
 *
 * LO QUE NO ESTÁ AQUÍ, y no es un olvido: «No leídos» y «No respondidos». Ésos
 * son estados DERIVADOS —se calculan de los mensajes y cambian solos— y van en
 * otro eje de filtros. Mezclar un estado derivado con una categoría persistente
 * es lo que convierte un CRM en un cajón de sastre: nadie vuelve a marcar
 * «leído» a mano, así que la etiqueta mentiría a los dos días.
 *
 * LAS CUENTAS NO SE PINTAN EN LOS CHIPS. Se saben (`etiqueta.conversaciones`) y
 * se enseñan en el gestor, que es donde sirven para decidir. Aquí sólo
 * engordarían la fila y harían que cupieran tres etiquetas en vez de cinco: una
 * barra de filtros que hay que recorrer entera deja de ser un índice.
 *
 * -----------------------------------------------------------------------------
 * LA PRIMERA VEZ SE EXPLICA; DESPUÉS NO
 * -----------------------------------------------------------------------------
 * Sin ninguna etiqueta creada, esta fila es un botón «Crear etiqueta» suelto y
 * nada dice qué es eso, a qué se le pone ni quién lo ve. Eran las tres
 * preguntas que frenaban la función: quien no sabe que son privadas o no la usa
 * —por no etiquetar a una persona delante de ella— o la usa creyendo que es
 * compartido. Por eso `label.explain` sale AQUÍ, a la vista, y no sólo dentro
 * del gestor que hay que abrir para leerlo.
 *
 * Y DESAPARECE EN CUANTO HAY UNA. Un cartel permanente encima de la bandeja
 * roba la altura de la primera conversación todos los días para explicar algo
 * que ya se entendió el primero.
 */
export function ChipsDeEtiquetas({
  etiquetas,
  seleccionada,
  alSeleccionar,
  disponible = true,
  alGestionar,
  style,
}: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();

  // Sin la migración no hay nada que ofrecer, y sin etiquetas ni forma de
  // crearlas tampoco: una fila con un solo chip que dice «Todos» no ordena nada
  // y roba la altura que necesita la primera conversación.
  if (!disponible) return null;
  if (etiquetas.length === 0 && !alGestionar) return null;

  return (
    <View style={style}>
      {/*
        Blindado frente al gesto de cambiar de sección: sin esto, arrastrar la
        fila de etiquetas se llevaría la pantalla entera a la pestaña de al
        lado (ver `navigation/tabSwipe.tsx`).
      */}
      <SinCambioDeSeccion>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.fila}
          // En web la rueda del ratón desplaza en vertical: sin esto, la fila
          // no se puede recorrer con un ratón normal.
          keyboardShouldPersistTaps="handled"
        >
          <Chip
            label={t('gallery.all')}
            selected={seleccionada === null}
            onPress={() => alSeleccionar(null)}
          />
          {etiquetas.map((etiqueta) => (
            <Chip
              key={etiqueta.id}
              label={etiqueta.nombre}
              selected={seleccionada === etiqueta.id}
              // Volver a tocar la que ya está elegida quita el filtro. Es el
              // camino corto de vuelta a «Todos» sin tener que buscar el
              // principio de una fila que puede estar desplazada.
              onPress={() =>
                alSeleccionar(seleccionada === etiqueta.id ? null : etiqueta.id)
              }
            />
          ))}

          {alGestionar ? (
            <Pressable
              onPress={alGestionar}
              style={[styles.gestionar, { borderColor: colors.border }]}
              accessibilityRole="button"
              accessibilityLabel={
                etiquetas.length === 0 ? t('label.createShort') : t('label.manageShort')
              }
              // Lo que un icono no puede decir: qué son y quién las ve. Con
              // lector de pantalla el botón era sólo «Etiquetas».
              accessibilityHint={t('label.explain')}
            >
              <Feather name="plus" size={14} color={colors.text} />
              <Text variant="caption" weight="700" color={colors.text}>
                {etiquetas.length === 0
                  ? t('label.createShort')
                  : t('label.manageShort')}
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </SinCambioDeSeccion>

      {/*
        Sólo mientras no hay ninguna: ver la cabecera. Va FUERA del ScrollView
        horizontal para que se lea entera sin arrastrar nada.
      */}
      {etiquetas.length === 0 && alGestionar ? (
        <Text variant="caption" color={colors.textMuted} style={styles.explicacion}>
          {t('label.explain')}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fila: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  explicacion: { paddingBottom: spacing.sm, lineHeight: 15 },
  gestionar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    // Discontinuo para que se lea como «añadir» y no como una etiqueta más:
    // sin eso, «Etiquetas» parecía una categoría llamada «Etiquetas».
    borderStyle: 'dashed',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    minHeight: 34,
  },
});
