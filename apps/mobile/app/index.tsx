import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';

import { hayQueElegirIdioma } from '@/lib/idioma';
import { rutaDeArranque } from '@/lib/rutaDeArranque';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { usePreferenciasStore } from '@/store/usePreferenciasStore';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * La puerta de entrada. Lee el estado y obedece a `rutaDeArranque`.
 *
 * La DECISION —y sobre todo el orden en que se comprueban las cosas— vive en
 * `@/lib/rutaDeArranque`, aparte y probada. Aqui no hay ninguna regla: solo
 * estado, indicador de carga y redireccion. Es lo que impide que alguien
 * cuele mañana una condicion por delante de la recuperación de contraseña sin
 * enterarse de lo que rompe.
 */
export default function IndexRoute() {
  const hydrated = useAppStore((state) => state.hydrated);
  const idiomaElegido = useAppStore((state) => state.idiomaElegido);
  const authStatus = useAuthStore((state) => state.status);
  const passwordRecovery = useAuthStore((state) => state.passwordRecovery);
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const cuestionario = usePreferenciasStore((state) => state.estado);
  const { colors } = useAppTheme();

  const destino = rutaDeArranque({
    hidratado: hydrated,
    conBackend: supabaseEnabled,
    sesion:
      authStatus === 'loading'
        ? 'resolviendo'
        : authStatus === 'authenticated'
        ? 'conCuenta'
        : 'sinCuenta',
    recuperandoContrasena: passwordRecovery,
    cuestionario,
    // «Ya eligio» NO es «tiene un idioma»: mientras nadie ha contestado, la
    // aplicacion se pinta en el idioma por defecto y aun asi hay que preguntar.
    idiomaElegido: !hayQueElegirIdioma(idiomaElegido),
  });

  // `null` = todavia no se puede decidir. Ninguna de las esperas es indefinida:
  // la sesion resuelve o degrada a anonima, y el cuestionario tiene su propio
  // reloj (ver `usePreferenciasStore`).
  if (destino === null) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.background,
        }}
      >
        <ActivityIndicator color={colors.text} />
      </View>
    );
  }

  return <Redirect href={destino as never} />;
}
