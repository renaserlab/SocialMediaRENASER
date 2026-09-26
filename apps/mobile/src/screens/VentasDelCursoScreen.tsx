import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppScreen } from '@/components/AppScreen';
import { AppHeader } from '@/components/AppHeader';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { deCentavos } from '@/lib/dinero';
import {
  ESTADOS_DE_SALDO,
  OwnerRepository,
  type ResumenDeVentas,
  type VentaDelCurso,
} from '@/repositories/OwnerRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

import { esProhibido, useTextosDeGestion } from '@/screens/GestionDeCursoScreen';

/**
 * Lo cobrado y lo devuelto de un curso, PARA QUIEN LO CREÓ.
 *
 * ESTA PANTALLA SOLO CONSULTA, y esa es la decisión importante. Aquí NO hay:
 *
 *   - el motivo privado de una devolución, ni las notas internas de quien la
 *     revisa: son del expediente de administración, no del balance;
 *   - identificadores de la pasarela ni del pedido: no significan nada para
 *     quien vende y son exactamente lo que no debe circular;
 *   - dato financiero alguno del comprador —ni su nombre junto a un importe—:
 *     esto es el balance de un curso, no la ficha de una persona;
 *   - ningún botón de aprobar o rechazar. Resolver una devolución es mover
 *     dinero de un tercero, y quien cobra por el curso no puede ser quien
 *     decide si se devuelve.
 *
 * Quien resuelve es la administración, en su propia bandeja.
 */

const POR_PAGINA = 20;

function fechaLegible(iso: string | null): string {
  if (!iso) return '';
  const momento = new Date(iso);
  if (Number.isNaN(momento.getTime())) return '';
  return momento.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function VentasDelCursoScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const t = useTextosDeGestion();
  const { id } = useLocalSearchParams<{ id: string }>();
  const courseId = typeof id === 'string' ? id : '';

  const [resumen, setResumen] = useState<ResumenDeVentas | null>(null);
  const [ventas, setVentas] = useState<VentaDelCurso[]>([]);
  const [cargando, setCargando] = useState(true);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [hayMas, setHayMas] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prohibido, setProhibido] = useState(false);
  const masRef = useRef(false);
  /**
   * La ULTIMA pagina pedida no llego.
   *
   * Antes esto apagaba `hayMas` y no se decia nada: la lista quedaba truncada
   * con el mismo aspecto que una lista completa, asi que se leia como «ya no
   * hay mas» cuando lo que habia era un fallo de red. En una bandeja de
   * expedientes o en un listado de ventas eso es dar por vistas cosas que no se
   * han visto. Ahora se avisa en el pie y se puede reintentar la misma pagina.
   */
  const [falloAlPaginar, setFalloAlPaginar] = useState(false);


  const cargar = useCallback(async () => {
    if (!courseId) return;
    setCargando(true);
    // Recargar de cero borra el fallo de la pagina anterior: se vuelve a
    // empezar y ese error ya no describe nada.
    setFalloAlPaginar(false);
    setError(null);
    setProhibido(false);
    try {
      const [cabecera, pagina] = await Promise.all([
        OwnerRepository.resumenDeVentas(courseId),
        OwnerRepository.ventas(courseId, POR_PAGINA, 0),
      ]);
      setResumen(cabecera);
      setVentas(pagina);
      setHayMas(pagina.length === POR_PAGINA);
    } catch (e) {
      if (esProhibido(e)) setProhibido(true);
      else setError(e instanceof Error ? e.message : t('common.loadFailed'));
      setResumen(null);
      setVentas([]);
      setHayMas(false);
    } finally {
      setCargando(false);
    }
  }, [courseId, t]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const cargarMas = useCallback(async (reintentoManual = false) => {
    // `falloAlPaginar` corta el reintento AUTOMATICO. Al no apagar ya `hayMas`,
    // repintar el pie cambia el alto del contenido y `onEndReached` vuelve a
    // dispararse: con el servidor caido eso es un bucle de peticiones sin
    // freno. Se reintenta solo cuando la persona toca el aviso.
    if (masRef.current || !hayMas || cargando || !courseId) return;
    if (falloAlPaginar && !reintentoManual) return;
    masRef.current = true;
    setCargandoMas(true);
    try {
      const pagina = await OwnerRepository.ventas(courseId, POR_PAGINA, ventas.length);
      setVentas((previas) => {
        const vistas = new Set(previas.map((v) => v.id));
        return [...previas, ...pagina.filter((v) => !vistas.has(v.id))];
      });
      setHayMas(pagina.length === POR_PAGINA);
      setFalloAlPaginar(false);
    } catch {
      // La lista no se cierra: `hayMas` se queda como estaba para que el
      // reintento vuelva a pedir la misma pagina.
      setFalloAlPaginar(true);
    } finally {
      masRef.current = false;
      setCargandoMas(false);
    }
  }, [cargando, courseId, falloAlPaginar, hayMas, ventas.length]);

  const cabecera = (
    <AppHeader
      title={t('ventas.titulo')}
      onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
    />
  );

  if (prohibido) {
    return (
      <AppScreen scroll={false}>
        {cabecera}
        <StateView state="empty" icon="lock" description={t('gestion.sinPermiso')} />
      </AppScreen>
    );
  }

  if (cargando) {
    return (
      <AppScreen scroll={false}>
        {cabecera}
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (error) {
    return (
      <AppScreen scroll={false}>
        {cabecera}
        <StateView state="error" description={error} onRetry={() => void cargar()} />
      </AppScreen>
    );
  }

  const moneda = resumen?.currency ?? 'PEN';

  const encabezado = (
    <View style={styles.encabezado}>
      <Text style={[styles.aviso, { color: colors.textMuted }]}>{t('ventas.soloConsulta')}</Text>

      {resumen ? (
        <React.Fragment>
          <View
            style={[
              styles.tarjeta,
              { borderColor: colors.border, backgroundColor: colors.surface },
            ]}
          >
            <Dato etiqueta={t('ventas.pagados')} valor={String(resumen.studentsPaid)} />
            <Dato etiqueta={t('ventas.devoluciones')} valor={String(resumen.refunds)} />
            <Dato etiqueta={t('ventas.bruto')} valor={deCentavos(resumen.grossMinor, moneda)} />
            <Dato etiqueta={t('ventas.comision')} valor={deCentavos(resumen.feeMinor, moneda)} />
            <Dato etiqueta={t('ventas.neto')} valor={deCentavos(resumen.netMinor, moneda)} />
          </View>

          <Text style={[styles.seccion, { color: colors.textMuted }]}>{t('ventas.saldos')}</Text>
          <View
            style={[
              styles.tarjeta,
              { borderColor: colors.border, backgroundColor: colors.surface },
            ]}
          >
            {ESTADOS_DE_SALDO.map((estado) => (
              <Dato
                key={estado}
                etiqueta={t(`ventas.saldo.${estado}`)}
                valor={deCentavos(resumen.balances[estado], moneda)}
              />
            ))}
          </View>
        </React.Fragment>
      ) : null}

      <Text style={[styles.seccion, { color: colors.textMuted }]}>{t('ventas.listaTitulo')}</Text>
    </View>
  );

  return (
    <AppScreen scroll={false}>
      {cabecera}
      <FlatList
        data={ventas}
        keyExtractor={(venta) => venta.id}
        ListHeaderComponent={encabezado}
        contentContainerStyle={styles.lista}
        onEndReachedThreshold={0.4}
        onEndReached={() => void cargarMas()}
        renderItem={({ item }) => (
          <View
            style={[styles.fila, { borderColor: colors.border, backgroundColor: colors.surface }]}
          >
            <Text style={[styles.importe, { color: colors.text }]}>
              {deCentavos(item.amountMinor, item.currency)}
            </Text>
            <Text style={[styles.dato, { color: colors.textMuted }]}>
              {fechaLegible(item.soldAt)}
            </Text>
            <View style={[styles.etiqueta, { borderColor: colors.border }]}>
              <Text style={[styles.etiquetaTexto, { color: colors.text }]}>
                {t(`ventas.saldo.${item.balanceState}`)}
              </Text>
            </View>
          </View>
        )}
        ListEmptyComponent={
          <StateView
            state="empty"
            icon="bar-chart-2"
            title={t('ventas.vacioTitulo')}
            description={t('ventas.vacioCuerpo')}
          />
        }
        ListFooterComponent={
          cargandoMas ? (
            <ActivityIndicator style={styles.pie} color={colors.textMuted} />
          ) : falloAlPaginar ? (
            <Pressable
              onPress={() => void cargarMas(true)}
              accessibilityRole="button"
              accessibilityLabel={t('common.retry')}
              style={styles.pie}
            >
              <Text style={[styles.cargarMas, { color: colors.danger }]}>
                {t('common.loadMoreFailed')}
              </Text>
            </Pressable>
          ) : hayMas ? (
            <Pressable
              onPress={() => void cargarMas()}
              accessibilityRole="button"
              accessibilityLabel={t('ventas.cargarMas')}
              style={styles.pie}
            >
              <Text style={[styles.cargarMas, { color: colors.text }]}>
                {t('ventas.cargarMas')}
              </Text>
            </Pressable>
          ) : null
        }
      />
    </AppScreen>
  );
}

function Dato({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  const { colors } = useAppTheme();
  return (
    <View style={styles.datoFila}>
      <Text style={[styles.dato, { color: colors.textMuted }]}>{etiqueta}</Text>
      <Text style={[styles.datoValor, { color: colors.text }]}>{valor}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  lista: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm },
  encabezado: { gap: spacing.sm },
  aviso: { fontSize: 12, lineHeight: 17 },
  seccion: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.lg,
  },
  tarjeta: { borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm },
  datoFila: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  dato: { fontSize: 12 },
  datoValor: { fontSize: 13, fontWeight: '800' },
  fila: { borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.xs },
  importe: { fontSize: 15, fontWeight: '800' },
  etiqueta: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 3,
    marginTop: spacing.xs,
  },
  etiquetaTexto: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  pie: { paddingVertical: spacing.lg, alignItems: 'center' },
  cargarMas: { fontSize: 13, fontWeight: '700' },
});
