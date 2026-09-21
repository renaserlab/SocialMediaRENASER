import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import {
  claveDelEstadoDeIncidencia,
  claveDelMotivo,
  claveDelPlazo,
  esIncidenciaApagada,
  horasQueLeQuedan,
  iconoDelEstadoDeIncidencia,
  type ResumenDeIncidencia,
} from '@/lib/incidencias';
import { esFaltaDeSesion } from '@/lib/productos';
import { ProductIncidentSellerRepository } from '@/repositories/ProductIncidentRepository';
import { useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Las reclamaciones de mi tienda.
 *
 * LA LISTA NO LLEVA LA DESCRIPCIÓN, y lo decide el servidor: ese texto lo
 * escribió quien reclama y suele llevar dentro dónde vive y qué le pasó. Para
 * elegir cuál abrir basta con de qué pedido es, por qué se abrió y en qué está.
 *
 * EL PLAZO SE DICE COMO UN HECHO, nunca como una acusación: lo que ocurre
 * pasadas las 48 horas es que el caso se manda a revisión de Z, no que alguien
 * haya incumplido nada.
 *
 * Y NO HAY NINGÚN BOTÓN DE RESOLVER, aquí ni en la pantalla del caso. Las cinco
 * salidas mueven dinero, mueven mercancía o niegan la reclamación, y ninguna la
 * decide en solitario quien tiene el conflicto.
 */
export function ReclamacionesDeMiTiendaScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();

  const [casos, setCasos] = useState<ResumenDeIncidencia[]>([]);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'sinSesion' | 'noDisponible' | 'sinTienda' | null
  >(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      setCasos(await ProductIncidentSellerRepository.mios());
    } catch (e) {
      if (e instanceof ApiError && esFaltaDeSesion(e.status)) setFallo('sinSesion');
      else if (e instanceof ApiError && esIncidenciaApagada(e.code))
        setFallo('noDisponible');
      /* 404 AQUÍ ES «NO ERES RESPONSABLE COMERCIAL», no «no hay casos»: el
         servidor contesta lo mismo a quien no tiene tienda que a quien pide la
         de otro. Una lista vacía es otra cosa y se pinta distinto. */
      else if (e instanceof ApiError && e.status === 404) setFallo('sinTienda');
      else if (e instanceof ApiError && esFalloDeRed(e.code)) setFallo('sinConexion');
      else setFallo('red');
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/proveedor/productos' as never);

  const encabezado = (
    <AppHeader title={f('incidencia.proveedor.titulo')} onBack={volver} />
  );

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        {fallo === 'sinSesion' ? (
          <StateView
            state="empty"
            icon="lock"
            title={f('carrito.error.sinSesion')}
            description={f('carrito.error.sinSesionCuerpo')}
          />
        ) : fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            icon="clock"
            title={f('incidencia.error.noDisponible')}
            description={f('incidencia.falta.migration_0080')}
          />
        ) : fallo === 'sinTienda' ? (
          <StateView
            state="empty"
            icon="shopping-bag"
            title={f('envio.proveedor.sinTienda')}
            description={f('envio.proveedor.sinTiendaCuerpo')}
          />
        ) : (
          <StateView
            state={fallo === 'sinConexion' ? 'offline' : 'error'}
            description={fallo === 'sinConexion' ? undefined : t('common.loadFailed')}
            onRetry={() => void cargar()}
          />
        )}
      </AppScreen>
    );
  }

  if (casos.length === 0) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        <StateView
          state="empty"
          icon="check-circle"
          title={f('incidencia.proveedor.vacio')}
          description={f('incidencia.proveedor.vacioCuerpo')}
        />
      </AppScreen>
    );
  }

  return (
    <AppScreen contentStyle={styles.contenido}>
      {encabezado}
      <ScrollView contentContainerStyle={styles.cuerpo}>
        <Text variant="caption" color="muted">
          {f('incidencia.proveedor.cuerpo')}
        </Text>
        {casos.map((caso) => {
          const icono = iconoDelEstadoDeIncidencia(caso.status);
          const horas = horasQueLeQuedan(caso.seller_response_due_at);
          return (
            <Pressable
              key={caso.id}
              onPress={() =>
                router.push(`/proveedor/reclamaciones/${caso.id}` as never)
              }
              accessibilityRole="button"
              accessibilityLabel={f(claveDelMotivo(caso.reason))}
              style={[styles.fila, { borderColor: colors.border }]}
            >
              {icono !== null ? (
                <Feather name={icono as never} size={20} color={colors.text} />
              ) : null}
              <View style={styles.filaTexto}>
                <Text>{f(claveDelMotivo(caso.reason))}</Text>
                <Text variant="caption" color="muted">
                  {f(claveDelEstadoDeIncidencia(caso.status))}
                </Text>
                {/* EL PLAZO, COMO UN HECHO. Y solo cuando el reloj corre: si
                    pidió más pruebas, no se le cuenta el tiempo ajeno. */}
                {caso.seller_response_due_at !== null ? (
                  <Text variant="caption" color="muted">
                    {f(claveDelPlazo(caso.seller_response_due_at), {
                      n: Math.max(0, horas ?? 0),
                    })}
                  </Text>
                ) : null}
              </View>
              <Feather name="chevron-right" size={18} color={colors.textMuted} />
            </Pressable>
          );
        })}
      </ScrollView>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { paddingHorizontal: 0 },
  cuerpo: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xl },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    // 44 de alto: el área táctil mínima.
    minHeight: 44,
  },
  filaTexto: { flex: 1 },
});
