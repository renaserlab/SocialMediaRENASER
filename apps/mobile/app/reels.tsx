import { Redirect } from 'expo-router';

/*
  Los shorts ya no viven en una ruta aparte: SON la pantalla de Inicio (ver
  `src/screens/InicioScreen.tsx`). Esta ruta se conserva porque hay enlaces
  antiguos —avisos, enlaces compartidos, la pantalla de desarrollo— que siguen
  apuntando aqui; en vez de dar un 404 llevan a donde esta ahora el contenido.

  Ir a la PESTAÑA y no a una pantalla suelta es lo que mantiene visible la barra
  de secciones, que era justo el problema que tenia `/reels`.
*/
export default function ReelsRedirect() {
  return <Redirect href="/(tabs)/home" />;
}
