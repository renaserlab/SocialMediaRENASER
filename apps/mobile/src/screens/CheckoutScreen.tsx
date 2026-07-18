import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { course } from '@/data/mockData';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function CheckoutScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const purchase = useAppStore((state) => state.purchaseCourse);

  const [coupon, setCoupon] = useState('');
  const [method, setMethod] = useState<'card' | 'store'>('card');

  // Estado del proceso de pago: 'checkout' (formulario), 'processing', 'error'
  const [paymentState, setPaymentState] = useState<'checkout' | 'processing' | 'error'>('checkout');

  const startPayment = () => {
    setPaymentState('processing');

    // Simulamos un retraso de 1s y luego forzamos un error de pago (para cumplir con el requisito de StateView real)
    setTimeout(() => {
      setPaymentState('error');
    }, 1000);
  };

  const forceSuccess = () => {
    // Simulamos reintento exitoso
    purchase(course.id);
    router.replace('/confirmation');
  };

  if (paymentState === 'processing') {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, justifyContent: 'center' }}>
        <StateView state="loading" title="Procesando pago..." description="Por favor no cierres la aplicación." />
      </View>
    );
  }

  if (paymentState === 'error') {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="Error de Pago" onBack={() => setPaymentState('checkout')} />
        <StateView
          state="error"
          title="Tu transacción ha sido rechazada"
          description="Hubo un error al procesar tu tarjeta bancaria. Verifica tus fondos o utiliza otro método."
          onRetry={forceSuccess}
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="Resumen de compra" onBack={() => router.back()} />
      <AppScreen contentStyle={{ paddingBottom: spacing.xl }}>
        <View style={styles.container}>
          <View style={[styles.summary, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={[styles.thumbnail, { backgroundColor: colors.primary }]}>
              <Text style={{ color: colors.onPrimary, fontWeight: '900', textAlign: 'center', fontSize: 12 }}>
                LÍDER{`\n`}DE TU VIDA
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.product, { color: colors.text }]}>{course.title}</Text>
              <Text style={[styles.price, { color: colors.text }]}>${course.price.toLocaleString()} {course.currency}</Text>
            </View>
          </View>

          <View style={[styles.totalRow, { borderColor: colors.border }]}>
            <Text style={[styles.totalLabel, { color: colors.text }]}>Total</Text>
            <Text style={[styles.totalValue, { color: colors.text }]}>${course.price.toLocaleString()} {course.currency}</Text>
          </View>

          <Text style={[styles.section, { color: colors.text }]}>Método de pago</Text>
          <Pressable
            onPress={() => setMethod('card')}
            accessibilityRole="radio"
            accessibilityState={{ checked: method === 'card' }}
            style={[styles.method, { borderColor: method === 'card' ? colors.text : colors.border, backgroundColor: colors.surface }]}
          >
            <Feather name="credit-card" size={22} color={colors.text} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.methodTitle, { color: colors.text }]}>Tarjeta terminada en 4242</Text>
              <Text style={[styles.methodMeta, { color: colors.textMuted }]}>Pago de demostración local</Text>
            </View>
            <Feather name={method === 'card' ? 'check-circle' : 'circle'} size={20} color={colors.text} />
          </Pressable>

          <Pressable
            onPress={() => setMethod('store')}
            accessibilityRole="radio"
            accessibilityState={{ checked: method === 'store' }}
            style={[styles.method, { borderColor: method === 'store' ? colors.text : colors.border, backgroundColor: colors.surface }]}
          >
            <Feather name="shopping-bag" size={22} color={colors.text} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.methodTitle, { color: colors.text }]}>Compra In-App</Text>
              <Text style={[styles.methodMeta, { color: colors.textMuted }]}>Requerido para contenido digital real</Text>
            </View>
            <Feather name={method === 'store' ? 'check-circle' : 'circle'} size={20} color={colors.text} />
          </Pressable>

          <View style={styles.couponWrapper}>
            <Input
              placeholder="Agregar cupón"
              value={coupon}
              onChangeText={setCoupon}
              containerStyle={{ flex: 1 }}
            />
            <Button
              label="Aplicar"
              variant="secondary"
              onPress={() => Alert.alert('Cupón', coupon ? 'Cupón validado en modo demostración.' : 'Ingresa un cupón.')}
              style={styles.couponButton}
            />
          </View>

          <Button
            label={`Pagar $${course.price.toLocaleString()} ${course.currency}`}
            onPress={startPayment}
            style={{ marginTop: spacing.xl }}
          />

          <View style={styles.secure}>
            <Feather name="lock" size={14} color={colors.success} />
            <Text style={{ color: colors.textMuted, fontSize: 11, textAlign: 'center' }}>
              Pago de demostración. No se procesa dinero real.
            </Text>
          </View>
        </View>
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing.lg },
  summary: { flexDirection: 'row', gap: spacing.md, borderWidth: 1, borderRadius: radius.lg, padding: spacing.md, alignItems: 'center' },
  thumbnail: { width: 82, height: 100, borderRadius: radius.md, justifyContent: 'center', padding: spacing.sm },
  product: { fontSize: 14, fontWeight: '800', lineHeight: 18 },
  price: { fontSize: 16, fontWeight: '900', marginTop: spacing.sm },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing.xl, borderBottomWidth: 1 },
  totalLabel: { fontSize: 16, fontWeight: '800' },
  totalValue: { fontSize: 16, fontWeight: '900' },
  section: { fontSize: 15, fontWeight: '900', marginVertical: spacing.lg },
  method: { minHeight: 70, flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderWidth: 1, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  methodTitle: { fontSize: 13, fontWeight: '800' },
  methodMeta: { fontSize: 10, marginTop: 4 },
  couponWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  couponButton: {
    minHeight: 48,
    justifyContent: 'center',
  },
  secure: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'center', alignItems: 'center', marginTop: spacing.lg, paddingHorizontal: spacing.xl },
});
