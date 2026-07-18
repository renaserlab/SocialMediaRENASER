import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { ImageBackground, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '@/components/PrimaryButton';
import { assets } from '@/data/assets';
import { spacing } from '@/theme/tokens';

export function LandingScreen() {
  return (
    <ImageBackground source={assets.hero} resizeMode="cover" style={styles.background}>
      <LinearGradient colors={['rgba(0,0,0,0.10)', 'rgba(0,0,0,0.55)', '#000000']} style={StyleSheet.absoluteFill} />
      <SafeAreaView style={styles.safe}>
        <Text style={styles.brand}>RENASER</Text>
        <View style={styles.content}>
          <Text style={styles.title}>¿Qué está bloqueando realmente tu crecimiento?</Text>
          <Text style={styles.subtitle}>Responde 7 preguntas y descubre tu verdadero límite.</Text>
          <PrimaryButton
            label="Descubrir ahora"
            onPress={() => router.push('/quiz')}
            style={styles.button}
          />
          <Text style={styles.hint}>Desliza tu vida hacia el siguiente nivel</Text>
        </View>
      </SafeAreaView>
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  background: { flex: 1, backgroundColor: '#000' },
  safe: { flex: 1, paddingHorizontal: spacing.xl },
  brand: { color: '#FFFFFF', textAlign: 'center', fontWeight: '800', letterSpacing: 1.8, marginTop: spacing.sm },
  content: { flex: 1, justifyContent: 'flex-end', paddingBottom: spacing.xxl },
  title: { color: '#FFFFFF', fontSize: 34, lineHeight: 40, fontWeight: '800', textAlign: 'center' },
  subtitle: { color: '#DADADA', fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: spacing.lg, marginBottom: spacing.xl },
  button: { backgroundColor: '#FFFFFF', borderColor: '#FFFFFF' },
  hint: { color: '#888888', fontSize: 11, textAlign: 'center', marginTop: spacing.lg },
});
