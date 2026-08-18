import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';

import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useAppTheme } from '@/theme/useAppTheme';

export default function IndexRoute() {
  const hydrated = useAppStore((state) => state.hydrated);
  const onboardingComplete = useAppStore((state) => state.onboardingComplete);
  const languageSelected = useAppStore((state) => state.languageSelected);
  const authStatus = useAuthStore((state) => state.status);
  const passwordRecovery = useAuthStore((state) => state.passwordRecovery);
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const { colors } = useAppTheme();

  // Espera a la hidratación del store y (si hay Supabase) a resolver la sesión,
  // para no mostrar el flujo de onboarding un instante antes de redirigir al home.
  const authResolving = supabaseEnabled && authStatus === 'loading';

  if (!hydrated || authResolving) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background }}>
        <ActivityIndicator color={colors.text} />
      </View>
    );
  }

  /*
    La recuperacion de contrasena va PRIMERO, antes que la sesion.

    Al pulsar el enlace del correo Supabase abre sesion, asi que sin esta
    comprobacion el usuario aterrizaba en el feed con la contrasena vieja
    intacta y sin llegar a cambiarla: pedia recuperarla y la aplicacion se
    comportaba como si no hubiera pasado nada. `passwordRecovery` ya se leia
    aqui, pero no se usaba para nada.
  */
  if (passwordRecovery) return <Redirect href="/reset-password" />;

  // Con sesión activa se va directo al home.
  if (authStatus === 'authenticated') return <Redirect href="/(tabs)/home" />;

  // Sin sesión TAMBIEN se entra al muro. Antes habia por delante una portada y
  // un cuestionario de siete preguntas, de modo que no se veia ni una sola
  // publicacion sin registrarse primero: quien llegaba por un enlace tenia que
  // rellenar un formulario para descubrir de que iba la aplicacion.
  //
  // Ahora se navega libremente, como en TikTok, y la cuenta se pide en el
  // momento en que hace falta de verdad —publicar, comentar, reaccionar o
  // guardar—, que es cuando ya se entiende para que sirve (ver `useRequireAuth`).
  //
  // El idioma se sigue preguntando primero: condiciona todo lo que se lee
  // despues y no cuesta nada responderlo.
  if (!languageSelected) return <Redirect href="/language" />;
  return <Redirect href="/(tabs)/home" />;
}
