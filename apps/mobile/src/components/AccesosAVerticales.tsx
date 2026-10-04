import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { useServiciosEncendido } from '@/hooks/useServiciosEncendido';
import { useTranslation } from '@/i18n/useTranslation';
import { SinCambioDeSeccion } from '@/navigation/tabSwipe';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Los cuatro accesos de la referencia: Cursos, Eventos, Servicios y Productos.
 *
 * SERVICIOS DEPENDE DE `FEATURE_SERVICES` (Incremento 3). Encendida en el
 * servidor, lleva a su catálogo (`/servicios`). Apagada —lo de fábrica— el
 * acceso sigue exactamente como antes: avisa de que aún no está, sin llevar a
 * ninguna pantalla y sin preguntar nada a la API de Servicios (la bandera se
 * lee de `/platform/config`, que ya se pedía). Un acceso que promete algo que
 * no hay cuesta más confianza que uno que dice «todavía no».
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
  ruta: '/cursos' | '/events' | '/servicios' | '/productos' | null;
  /** Solo lleva a su ruta con `FEATURE_SERVICES` encendida en el servidor. */
  conBandera?: true;
};

const VERTICALES: readonly Vertical[] = [
  { clave: 'cursos', icono: 'book-open', ruta: '/cursos' },
  { clave: 'eventos', icono: 'calendar', ruta: '/events' },
  // El catálogo de Z Servicios (Incremento 3), solo con la bandera encendida.
  { clave: 'servicios', icono: 'briefcase', ruta: '/servicios', conBandera: true },
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
  const serviciosEncendido = useServiciosEncendido();

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
        /*
          QUE NO CREZCA. Un `ScrollView` horizontal ocupa todo el alto que le
          den, y sus hijos se estiran con él: en web, dentro de una columna
          alta, cada acceso salía como una columna de medio metro. Con
          `flexGrow: 0` la fila mide lo que miden los accesos.
        */
        style={styles.carril}
        nestedScrollEnabled
      >
      {VERTICALES.map((vertical) => {
        const nombre = t(`verticales.${vertical.clave}`);
        const disponible = vertical.ruta !== null && (!vertical.conBandera || serviciosEncendido);
        return (
          <Pulsable
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
            // Se hunde bajo el dedo, como el resto de lo que se pulsa.
            style={[
              styles.acceso,
              { borderColor: colors.border, backgroundColor: colors.surface },
            ]}
            accessibilityRole="button"
            accessibilityLabel={
              disponible ? nombre : `${nombre}. ${t('verticales.proximamente')}`
            }
          >
            {/*
              El icono va en un circulo suave: suelto sobre blanco parecia una
              casilla vacia; con su fondo es una entrada a una seccion.
            */}
            <View style={[styles.circulo, { backgroundColor: colors.backgroundAlt }]}>
              <Feather
                name={vertical.icono}
                size={20}
                color={disponible ? colors.text : colors.textMuted}
              />
            </View>
            <Text
              style={[
                styles.etiqueta,
                { color: disponible ? colors.text : colors.textMuted },
              ]}
            >
              {nombre}
            </Text>
          </Pulsable>
        );
        })}
      </ScrollView>
    </SinCambioDeSeccion>
  );
}

const styles = StyleSheet.create({
  carril: { flexGrow: 0 },
  fila: {
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    /*
      Y QUE NO SE ESTIREN. En una fila horizontal el eje cruzado es el vertical:
      sin esto, cada acceso se estira hasta el alto del carril. Es lo que hacía
      que las cuatro casillas salieran alargadas y feas.
    */
    alignItems: 'flex-start',
  },
  acceso: {
    minWidth: 96,
    // El área táctil mínima, que antes dependía de cuánto se estirara la caja.
    minHeight: 72,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
  },
  circulo: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  etiqueta: { fontSize: 13, fontWeight: '600' },
});
