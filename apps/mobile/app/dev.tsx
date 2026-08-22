import { StyleSheet, View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';

import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { spacing } from '@/theme/tokens';

type Item = { label: string; href: string };
type Group = { title: string; items: Item[] };

// Galería de pantallas para revisar todas las vistas sin recorrer el flujo.
// Las rutas dinámicas usan un id mock ("1") solo para navegar; los datos
// siguen siendo mock (no se conecta ninguna API).
const GROUPS: Group[] = [
  {
    title: 'Onboarding / Auth',
    items: [
      { label: 'Landing (index)', href: '/' },
      { label: 'Idioma', href: '/language' },
      { label: 'Onboarding', href: '/onboarding' },
      { label: 'Registro', href: '/register' },
      { label: 'Verificación', href: '/verification' },
      { label: 'Quiz', href: '/quiz' },
      { label: 'Resultado', href: '/result' },
      { label: 'Confirmación', href: '/confirmation' },
    ],
  },
  {
    title: 'Tabs principales',
    items: [
      { label: 'Inicio', href: '/(tabs)/home' },
      { label: 'Explorar', href: '/(tabs)/explore' },
      { label: 'Crear', href: '/(tabs)/create' },
      { label: 'Mensajes', href: '/(tabs)/messages' },
      { label: 'Perfil (tab)', href: '/(tabs)/profile' },
    ],
  },
  {
    title: 'Detalle (id mock)',
    items: [
      { label: 'Perfil de usuario', href: '/profile/1' },
      { label: 'Curso', href: '/course/1' },
      { label: 'Lección', href: '/lesson/1' },
      { label: 'Chat', href: '/chat/1' },
      { label: 'Comentarios', href: '/comments/1' },
      { label: 'Círculo', href: '/circle/1' },
      { label: 'En vivo', href: '/live/1' },
      { label: 'Short', href: '/short/1' },
      { label: 'Audio', href: '/audio/1' },
    ],
  },
  {
    title: 'Social (nuevas)',
    items: [
      { label: 'Historias (visor)', href: '/stories/0' },
      { label: 'Inicio (feed vertical)', href: '/(tabs)/home' },
      { label: 'Detalle de publicación', href: '/post/post-1' },
      { label: 'Seguidores', href: '/followers/me' },
      { label: 'Siguiendo', href: '/following/me' },
      { label: 'Búsqueda', href: '/search' },
      { label: 'Guardados', href: '/saved' },
    ],
  },
  {
    title: 'Otras',
    items: [
      { label: 'Eventos', href: '/events' },
      { label: 'Biblioteca', href: '/library' },
      { label: 'Notificaciones', href: '/notifications' },
      { label: 'Ajustes', href: '/settings' },
      { label: 'Editar perfil', href: '/edit-profile' },
      { label: 'Login', href: '/login' },
    ],
  },
];

export default function DevGalleryScreen() {
  const router = useRouter();

  // Esta galeria es una herramienta de desarrollo: no esta enlazada en ningun
  // sitio, pero la ruta /dev respondia igual en una build de produccion y
  // dejaba entrar a pantallas internas con un enlace profundo.
  if (!__DEV__) return <Redirect href="/" />;

  return (
    <AppScreen contentStyle={styles.content}>
      <Text variant="display" style={styles.heading}>
        Galería de pantallas
      </Text>
      <Text variant="secondary" style={styles.subheading}>
        Acceso directo a cada vista para revisión. Solo desarrollo.
      </Text>

      {GROUPS.map((group) => (
        <View key={group.title} style={styles.group}>
          <Text variant="titleMedium" style={styles.groupTitle}>
            {group.title}
          </Text>
          {group.items.map((item) => (
            <Button
              key={item.href + item.label}
              label={item.label}
              variant="secondary"
              style={styles.button}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onPress={() => router.push(item.href as any)}
            />
          ))}
        </View>
      ))}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  heading: {
    marginBottom: spacing.xs,
  },
  subheading: {
    marginBottom: spacing.md,
  },
  group: {
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  groupTitle: {
    marginBottom: spacing.xs,
  },
  button: {
    justifyContent: 'flex-start',
  },
});
