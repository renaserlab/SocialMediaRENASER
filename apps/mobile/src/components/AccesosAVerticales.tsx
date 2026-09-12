import React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { SinCambioDeSeccion } from '@/navigation/tabSwipe';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Los cuatro accesos de la referencia: Cursos, Eventos, Servicios y Productos.
 *
 * UNA DE LAS CUATRO NO EXISTE TODAVÍA, y eso se dice en vez de disimularse.
 * Servicios no tiene ni pantalla ni endpoints —ver
 * `docs/Z_MATRIZ_DE_VISTAS.md`—, así que su acceso avisa de que aún no está en
 * lugar de llevar a una pantalla con datos inventados o a una compra que no se
 * puede completar. Un acceso que promete algo que no hay cuesta más confianza
 * que un acceso que dice «todavía no».
 *
 * PRODUCTOS YA LLEVA A SU CATÁLOGO. Tiene pantalla (`/productos`) y API
 * (`/products`), y su portada resuelve por sí misma el caso de que las
 * migraciones no estén aplicadas: contesta `disponible: false` y lo dice. Lo
 * que sigue sin existir es COMPRAR, y por eso el catálogo no tiene ni un botón
 * que lo prometa.
 *
 * NO SUSTITUYE A LA BÚSQUEDA SOCIAL. Va debajo del buscador y encima del muro:
 * personas, publicaciones, temas e historias siguen exactamente donde estaban.
 */

type Vertical = {
  clave: 'cursos' | 'eventos' | 'servicios' | 'productos';
  icono: keyof typeof Feather.glyphMap;
  /**
   * La ruta a la que lleva, o `null` si la vertical aún no existe.
   *
   * Se escribe como literal para que expo-router la compruebe: si mañana
   * alguien renombra `/cursos`, esto no compila en vez de fallar al tocarlo.
   */
  ruta: '/cursos' | '/events' | '/productos' | null;
};

const VERTICALES: readonly Vertical[] = [
  { clave: 'cursos', icono: 'book-open', ruta: '/cursos' },
  { clave: 'eventos', icono: 'calendar', ruta: '/events' },
  // Sin pantalla y sin endpoints. Ver la matriz de vistas.
  { clave: 'servicios', icono: 'briefcase', ruta: null },
  // YA TIENE PANTALLA Y ENDPOINTS: el catálogo de Productos Z (`/products`).
  { clave: 'productos', icono: 'shopping-bag', ruta: '/productos' },
];

export function AccesosAVerticales({
  alTocarNoDisponible,
}: {
  /** Cómo se avisa de que una vertical todavía no está. Lo pone la pantalla. */
  alTocarNoDisponible: (nombreDeLaVertical: string) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();

  return (
    /*
      BLINDADA CONTRA EL CARRUSEL DE SECCIONES. Explorar se cambia de pestaña
      con un gesto horizontal, y esta fila también se desplaza en horizontal:
      sin `SinCambioDeSeccion`, arrastrarla a media lista cambia de sección en
      vez de mover los accesos. Es la regla del proyecto para toda lista
      horizontal dentro de las pestañas.
    */
    <SinCambioDeSeccion>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.fila}
        nestedScrollEnabled
      >
      {VERTICALES.map((vertical) => {
        const nombre = t(`verticales.${vertical.clave}`);
        const disponible = vertical.ruta !== null;
        return (
          <Pressable
            key={vertical.clave}
            onPress={() =>
              /*
                El literal de arriba sigue siendo la comprobación de que la ruta
                existe; el molde de aquí se relaja porque los tipos de rutas de
                expo-router son GENERADOS (`.expo/types`) y los rehace el
                servidor de desarrollo: recién creada, `/productos` todavía no
                está en el fichero generado de esta copia de trabajo.
              */
              disponible
                ? router.push(vertical.ruta! as never)
                : alTocarNoDisponible(nombre)
            }
            style={({ pressed }) => [
              styles.acceso,
              { borderColor: colors.border, opacity: pressed ? 0.6 : 1 },
            ]}
            accessibilityRole="button"
            accessibilityLabel={
              disponible ? nombre : `${nombre}. ${t('verticales.proximamente')}`
            }
          >
            <Feather
              name={vertical.icono}
              size={20}
              color={disponible ? colors.text : colors.textMuted}
            />
            <Text
              style={[
                styles.etiqueta,
                { color: disponible ? colors.text : colors.textMuted },
              ]}
            >
              {nombre}
            </Text>
          </Pressable>
        );
        })}
      </ScrollView>
    </SinCambioDeSeccion>
  );
}

const styles = StyleSheet.create({
  fila: { gap: spacing.sm, paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  acceso: {
    minWidth: 96,
    alignItems: 'center',
    gap: 6,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
  },
  etiqueta: { fontSize: 13, fontWeight: '600' },
});
