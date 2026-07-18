import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { PrimaryButton } from '@/components/PrimaryButton';
import { course } from '@/data/mockData';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function CheckoutScreen() {
  const { colors } = useAppTheme();
  const purchase = useAppStore((state) => state.purchaseCourse);
  const [coupon, setCoupon] = useState('');
  const [method, setMethod] = useState<'card' | 'store'>('card');

  const pay = () => {
    purchase(course.id);
    router.replace('/confirmation');
  };

  return (
    <AppScreen contentStyle={{ paddingBottom: spacing.xl }}>
      <AppHeader back title="Resumen de compra" />
      <View style={styles.container}>
        <View style={[styles.summary, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={[styles.thumbnail, { backgroundColor: colors.primary }]}>
            <Text style={{ color: colors.onPrimary, fontWeight: '900', textAlign: 'center' }}>LÍDER{`\n`}DE TU VIDA</Text>
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
        <Pressable onPress={() => setMethod('card')} style={[styles.method, { borderColor: method === 'card' ? colors.text : colors.border, backgroundColor: colors.surface }]}>
          <Ionicons name="card-outline" size={22} color={colors.text} />
          <View style={{ flex: 1 }}><Text style={[styles.methodTitle, { color: colors.text }]}>Tarjeta terminada en 4242</Text><Text style={[styles.methodMeta, { color: colors.textMuted }]}>Pago de demostración local</Text></View>
          <Ionicons name={method === 'card' ? 'radio-button-on' : 'radio-button-off'} size={22} color={colors.text} />
        </Pressable>
        <Pressable onPress={() => setMethod('store')} style={[styles.method, { borderColor: method === 'store' ? colors.text : colors.border, backgroundColor: colors.surface }]}>
          <Ionicons name="logo-google-playstore" size={22} color={colors.text} />
          <View style={{ flex: 1 }}><Text style={[styles.methodTitle, { color: colors.text }]}>Compra de App Store / Google Play</Text><Text style={[styles.methodMeta, { color: colors.textMuted }]}>Requerido para contenido digital real</Text></View>
          <Ionicons name={method === 'store' ? 'radio-button-on' : 'radio-button-off'} size={22} color={colors.text} />
        </Pressable>

        <View style={[styles.coupon, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Ionicons name="pricetag-outline" size={20} color={colors.textMuted} />
          <TextInput value={coupon} onChangeText={setCoupon} placeholder="Agregar cupón" placeholderTextColor={colors.textMuted} style={{ flex: 1, color: colors.text }} />
          <Pressable onPress={() => Alert.alert('Cupón', coupon ? 'Cupón validado en modo demostración.' : 'Ingresa un cupón.')}><Text style={{ color: colors.text, fontWeight: '800' }}>Aplicar</Text></Pressable>
        </View>

        <PrimaryButton label={`Pagar $${course.price.toLocaleString()} ${course.currency}`} onPress={pay} style={{ marginTop: spacing.xl }} />
        <View style={styles.secure}><Ionicons name="lock-closed" size={14} color={colors.success} /><Text style={{ color: colors.textMuted, fontSize: 11 }}>Pago de demostración. No se procesa dinero real.</Text></View>
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing.lg },
  summary: { flexDirection: 'row', gap: spacing.md, borderWidth: 1, borderRadius: radius.lg, padding: spacing.md },
  thumbnail: { width: 82, height: 100, borderRadius: radius.md, justifyContent: 'center', padding: spacing.sm },
  product: { fontSize: 15, fontWeight: '800', lineHeight: 20 },
  price: { fontSize: 17, fontWeight: '900', marginTop: spacing.md },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing.xl, borderBottomWidth: 1 },
  totalLabel: { fontSize: 17, fontWeight: '800' },
  totalValue: { fontSize: 17, fontWeight: '900' },
  section: { fontSize: 16, fontWeight: '900', marginVertical: spacing.lg },
  method: { minHeight: 70, flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderWidth: 1, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  methodTitle: { fontSize: 13, fontWeight: '800' },
  methodMeta: { fontSize: 10, marginTop: 4 },
  coupon: { height: 54, flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing.md, marginTop: spacing.md },
  secure: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'center', marginTop: spacing.lg },
});
