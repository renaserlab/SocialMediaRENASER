import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import {
  claveDeErrorDeIncidencias,
  claveDelEstadoDeIncidencia,
  claveDelMotivo,
  esIncidenciaApagada,
  iconoDelEstadoDeIncidencia,
  type ResumenDeIncidencia,
} from '@/lib/incidencias';
import {
  claveDeErrorDeProductos,
  claveDeErrorPorEstado,
  esFaltaDeSesion,
} from '@/lib/productos';
import { ProductIncidentAdminRepository } from '@/repositories/ProductIncidentRepository';
import { useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * La cola de Z: los casos que esperan una decisión.
 *
 * SOLO `admin`, NO `is_admin`. Moderación cura contenido; decidir sobre dinero
 * y sobre mercancía es el mismo conjunto estrecho que ya decide quién publica y
 * quién ajusta existencias. El servidor contesta 403 a moderación y esta
 * pantalla lo dice con palabras en vez de enseñar una lista vacía.
 *
 * NINGÚN DATO PERSONAL EN LA COLA. La lista no lleva la descripción —texto
 * libre de quien reclama— ni el nombre de nadie: para saber qué caso atender
 * basta con por qué se abrió, en qué está y cuánto lleva.
 *
 * EL BARRIDO DE VENCIDOS SE LANZA A MANO, y no es provisionalidad disimulada:
 * un temporizador dentro de FastAPI se ejecutaría una vez por réplica. La ruta
 * es idempotente —llamarla dos veces seguidas devuelve cero la segunda— y está
 * preparada para un planificador externo el día que exista.
 */
export function AdminReclamacionesScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();

  const [casos, setCasos] = useState<ResumenDeIncidencia[]>([]);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'sinSesion' | 'noDisponible' | 'sinPermiso' | null
  >(null);

  const [aviso, setAviso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      setCasos(await ProductIncidentAdminRepository.cola());
    } catch (e) {
      if (e instanceof ApiError && esFaltaDeSesion(e.status)) setFallo('sinSesion');
      else if (e instanceof ApiError && e.status === 403) setFallo('sinPermiso');
      else if (e instanceof ApiError && esIncidenciaApagada(e.code))
        setFallo('noDisponible');
      else if (e instanceof ApiError && esFalloDeRed(e.code)) setFallo('sinConexion');
      else setFallo('red');
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const textoDelError = (e: unknown) => {
    if (e instanceof ApiError) {
      const deCasos = claveDeErrorDeIncidencias(e.code);
      if (deCasos !== null) return f(deCasos);
      const deProductos = claveDeErrorDeProductos(e.code);
      if (deProductos !== null) return f(deProductos);
      const porEstado = claveDeErrorPorEstado(e.status);
      if (porEstado !== null) return f(porEstado);
    }
    return e instanceof Error && e.message.trim() !== '' ? e.message : t('common.tryAgain');
  };

  const escalarVencidas = async () => {
    if (ocupadoRef.current) return;
    ocupadoRef.current = true;
    setOcupado(true);
    setError(null);
    setAviso(null);
    try {
      const resultado = await ProductIncidentAdminRepository.escalarVencidas();
      /* SE DICE CUÁNTOS, INCLUIDO CERO. Un cero aquí no es un fallo: significa
         que no quedaba ninguno vencido, que es exactamente lo que se quería
         saber. Callarlo haría dudar de si el botón hizo algo. */
      setAviso(f('incidencia.admin.escaladas', { n: resultado.escalated }));
      await cargar();
    } catch (e) {
      setError(textoDelError(e));
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/admin/productos' as never);

  const encabezado = (
    <AppHeader title={f('incidencia.admin.titulo')} onBack={volver} />
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
            title={f('sesion.entraParaVerlo')}
            description={f('sesion.entraParaVerloCuerpo')}
          />
        ) : fallo === 'sinPermiso' ? (
          <StateView
            state="empty"
            icon="shield"
            title={f('incidencia.admin.sinPermiso')}
            description={f('incidencia.admin.sinPermisoCuerpo')}
          />
        ) : fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            icon="clock"
            title={f('incidencia.error.noDisponible')}
            description={f('incidencia.falta.migration_0080')}
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

  return (
    <AppScreen contentStyle={styles.contenido}>
      {encabezado}
      <ScrollView contentContainerStyle={styles.cuerpo}>
        <Text variant="caption" color="muted">
          {f('incidencia.admin.cuerpo')}
        </Text>

        <View style={[styles.tarjeta, { borderColor: colors.border }]}>
          <Text variant="caption" color="muted">
            {f('incidencia.admin.escalarVencidasCuerpo')}
          </Text>
          <Button
            label={f('incidencia.admin.escalarVencidas')}
            variant="secondary"
            onPress={() => void escalarVencidas()}
            disabled={ocupado}
            loading={ocupado}
          />
          {aviso !== null ? (
            <Text variant="caption" color="muted">
              {aviso}
            </Text>
          ) : null}
        </View>

        {error !== null ? <InlineError message={error} /> : null}

        {casos.length === 0 ? (
          <StateView
            state="empty"
            icon="check-circle"
            title={f('incidencia.admin.vacio')}
            description={f('incidencia.admin.vacioCuerpo')}
          />
        ) : (
          casos.map((caso) => {
            const icono = iconoDelEstadoDeIncidencia(caso.status);
            return (
              <Pressable
                key={caso.id}
                onPress={() =>
                  router.push(`/admin/productos/reclamaciones/${caso.id}` as never)
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
                </View>
                <Feather name="chevron-right" size={18} color={colors.textMuted} />
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { paddingHorizontal: 0 },
  cuerpo: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xl },
  tarjeta: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
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
