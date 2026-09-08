import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { deCentavos } from '@/lib/dinero';
import { ordenDeLaUrl } from '@/lib/vueltaDelPago';
import { CommerceRepository, type EstadoDeOrden } from '@/repositories/PaymentRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * La constancia de una compra.
 *
 * NO es una factura ni una boleta, y por eso no se llama así: no hay integración
 * tributaria, así que no hay número fiscal, ni razón social, ni impuestos. Todo
 * lo que sale aquí está en la orden.
 */

function fecha(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

export function ConstanciaDeCompraScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const orderId = ordenDeLaUrl(id);

  const [orden, setOrden] = useState<EstadoDeOrden | null>(null);
  const [estado, setEstado] = useState<'cargando' | 'lista' | 'no_encontrada' | 'error'>(
    orderId === null ? 'no_encontrada' : 'cargando',
  );

  const cargar = useCallback(async () => {
    if (orderId === null) return;
    setEstado('cargando');
    try {
      setOrden(await CommerceRepository.estadoDeOrden(orderId));
      setEstado('lista');
    } catch (e) {
      const noEsta =
        typeof e === 'object' && e !== null && 'status' in e &&
        (e as { status: number }).status === 404;
      setEstado(noEsta ? 'no_encontrada' : 'error');
    }
  }, [orderId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (estado === 'cargando') {
    return (
      <AppScreen>
        <AppHeader title={t('constancia.titulo')} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (estado === 'no_encontrada' || orden === null) {
    return (
      <AppScreen>
        <AppHeader title={t('constancia.titulo')} />
        <StateView state="empty" description={t('constancia.noEncontrada')} />
        <Button label={t('constancia.misCompras')} onPress={() => router.replace('/compras')} />
      </AppScreen>
    );
  }

  if (estado === 'error') {
    return (
      <AppScreen>
        <AppHeader title={t('constancia.titulo')} />
        <StateView state="error" onRetry={() => void cargar()} />
      </AppScreen>
    );
  }

  const dias = orden.horasDeGarantia ? Math.round(orden.horasDeGarantia / 24) : null;
  const filas: { etiqueta: string; valor: string }[] = [
    { etiqueta: t('constancia.curso'), valor: orden.cursoTitulo },
    { etiqueta: t('constancia.estado'), valor: t(`constancia.estados.${orden.status}` as 'constancia.estados.paid') },
    { etiqueta: t('constancia.fecha'), valor: fecha(orden.pagadaEn ?? orden.creadaEn) },
    { etiqueta: t('constancia.total'), valor: deCentavos(orden.amountMinor, orden.currency) },
    { etiqueta: t('constancia.proveedor'), valor: orden.proveedor },
    { etiqueta: t('constancia.operacion'), valor: orden.id },
  ];
  if (orden.version !== null) {
    filas.splice(1, 0, {
      etiqueta: t('constancia.version'),
      valor: String(orden.version),
    });
  }

  return (
    <AppScreen>
      <AppHeader title={t('constancia.titulo')} />
      <View style={[styles.tarjeta, { borderColor: colors.border }]}>
        {filas.map((fila) => (
          <View key={fila.etiqueta} style={styles.fila}>
            <Text style={[styles.etiqueta, { color: colors.textMuted }]}>
              {fila.etiqueta}
            </Text>
            <Text
              style={[styles.valor, { color: colors.text }]}
              selectable
              numberOfLines={2}
            >
              {fila.valor}
            </Text>
          </View>
        ))}
      </View>

      {dias !== null ? (
        <Text style={[styles.nota, { color: colors.textMuted }]}>
          {orden.recompraSinGarantia
            ? t('constancia.sinSegundaGarantia')
            : t('constancia.garantia').replace('{dias}', String(dias))}
        </Text>
      ) : null}

      {/* No se llama factura: no hay integración tributaria. */}
      <Text style={[styles.aviso, { color: colors.textMuted }]}>
        {t('constancia.noEsFactura')}
      </Text>

      <View style={styles.acciones}>
        {orden.tieneAcceso ? (
          <Button
            label={t('constancia.irAlCurso')}
            onPress={() => router.push(`/course/${orden.courseId}`)}
          />
        ) : null}
        <Button
          label={t('constancia.misCompras')}
          variant="ghost"
          onPress={() => router.replace('/compras')}
        />
        <Button
          label={t('constancia.ayuda')}
          variant="ghost"
          onPress={() => router.push('/support')}
        />
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  tarjeta: {
    margin: spacing.md,
    padding: spacing.md,
    gap: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
  },
  fila: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  etiqueta: { width: 110, fontSize: 13 },
  valor: { flex: 1, fontSize: 14, fontWeight: '600' },
  nota: { paddingHorizontal: spacing.md, fontSize: 13, lineHeight: 19 },
  aviso: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, fontSize: 12 },
  acciones: { padding: spacing.md, gap: spacing.sm },
});
