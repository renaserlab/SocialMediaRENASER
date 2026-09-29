import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { ListRow } from '@/components/ListRow';
import { SectionTitle } from '@/components/SectionTitle';
import { Text } from '@/components/Text';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { useServiciosEncendido } from '@/hooks/useServiciosEncendido';

type Entrada = { titulo: TranslationKey; icono: keyof typeof Feather.glyphMap; ruta: string };

/**
 * Todas las colas y paneles de administración, en una lista.
 *
 * POR QUÉ EXISTE. Las bandejas estaban encadenadas unas a otras: para revisar
 * una postulación de proveedor había que ir a Perfil › Mis eventos › Eventos
 * por revisar › Postulaciones, y «Mis eventos» se había quedado sin enlace, así
 * que en la práctica no se llegaba a ninguna. La de cursos ni siquiera existía.
 *
 * NO DECIDE PERMISOS. Cada pantalla de destino pregunta al servidor y, si quien
 * entra no puede, lo dice. El perfil solo enseña la entrada a quien tiene
 * `isAdmin`, para no poner una puerta inútil a todo el mundo.
 */
export const SECCIONES_DE_ADMINISTRACION: { titulo: TranslationKey; entradas: Entrada[] }[] = [
  {
    titulo: 'panelAdmin.seccionRevision',
    entradas: [
      { titulo: 'panelAdmin.eventos', icono: 'calendar', ruta: '/admin/eventos' },
      { titulo: 'panelAdmin.cursos', icono: 'book', ruta: '/admin/cursos' },
      { titulo: 'panelAdmin.resenas', icono: 'message-square', ruta: '/admin/resenas' },
      { titulo: 'panelAdmin.politicas', icono: 'file-text', ruta: '/admin/politicas' },
    ],
  },
  {
    titulo: 'panelAdmin.seccionProductos',
    entradas: [
      { titulo: 'panelAdmin.productosAdmision', icono: 'user-plus', ruta: '/admin/productos/admision' },
      { titulo: 'panelAdmin.productosPanel', icono: 'package', ruta: '/admin/productos' },
      { titulo: 'panelAdmin.productosFotos', icono: 'image', ruta: '/admin/productos/fotos' },
      { titulo: 'panelAdmin.productosResenas', icono: 'star', ruta: '/admin/productos/resenas' },
      { titulo: 'panelAdmin.productosReclamaciones', icono: 'alert-circle', ruta: '/admin/productos/reclamaciones' },
      { titulo: 'panelAdmin.productosEnvios', icono: 'truck', ruta: '/admin/productos/envios' },
    ],
  },
  {
    titulo: 'panelAdmin.seccionPosventa',
    entradas: [
      { titulo: 'panelAdmin.posventa', icono: 'inbox', ruta: '/admin/posventa' },
      { titulo: 'panelAdmin.devoluciones', icono: 'rotate-ccw', ruta: '/admin/devoluciones' },
      { titulo: 'panelAdmin.finanzas', icono: 'bar-chart-2', ruta: '/admin/finanzas' },
      { titulo: 'panelAdmin.productosFinanzas', icono: 'dollar-sign', ruta: '/admin/productos/finanzas' },
    ],
  },
];

/**
 * Z SERVICIOS, aparte: solo se enseña con `FEATURE_SERVICES` encendida en el
 * servidor. Apagada, el panel queda exactamente como estaba.
 */
export const SECCION_DE_SERVICIOS: { titulo: TranslationKey; entradas: Entrada[] } = {
  titulo: 'panelAdmin.seccionServicios',
  entradas: [
    { titulo: 'panelAdmin.serviciosAdmision', icono: 'briefcase', ruta: '/admin/servicios' },
    { titulo: 'panelAdmin.serviciosCondiciones', icono: 'file-text', ruta: '/admin/servicios/condiciones' },
    { titulo: 'panelAdmin.serviciosCatalogo', icono: 'layers', ruta: '/admin/servicios/catalogo' },
    { titulo: 'panelAdmin.serviciosCategorias', icono: 'grid', ruta: '/admin/servicios/categorias' },
  ],
};

export function PanelDeAdministracionScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const serviciosEncendido = useServiciosEncendido();
  const secciones = serviciosEncendido
    ? [...SECCIONES_DE_ADMINISTRACION, SECCION_DE_SERVICIOS]
    : SECCIONES_DE_ADMINISTRACION;

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={t('panelAdmin.titulo')} onBack={volver} />
      <Text variant="caption" color={colors.textMuted}>
        {t('panelAdmin.intro')}
      </Text>
      {secciones.map((seccion) => (
        <View key={seccion.titulo} style={styles.seccion}>
          <SectionTitle title={t(seccion.titulo)} />
          {seccion.entradas.map((entrada) => (
            <ListRow
              key={entrada.ruta}
              title={t(entrada.titulo)}
              leftIcon={entrada.icono}
              onPress={() => router.push(entrada.ruta as never)}
            />
          ))}
        </View>
      ))}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  seccion: { gap: spacing.xs },
});
