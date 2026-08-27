import { Redirect } from 'expo-router';

/*
  Los shorts ya no viven en una ruta aparte: SON la pantalla de Inicio (ver
  `src/screens/InicioScreen.tsx`). Esta ruta se conserva porque hay enlaces
  antiguos —avisos, enlaces compartidos, la pantalla de desarrollo— que siguen
  apuntando aqui; en vez de dar un 404 llevan a donde esta ahora el contenido.

  Ir a la PESTAÑA y no a una pantalla suelta es lo que mantiene visible la barra
  de secciones, que era justo el problema que tenia `/reels`.

  Y QUE PASO CON `/short/[id]`, que era la otra ruta suelta de la misma idea:
  se BORRO, y no se rehace. Era una maqueta —reproducia siempre el mismo clip
  de demostracion alojado fuera, con 142 me gusta y un autor escritos a mano—,
  y su fichero de ruta no comprobaba `__DEV__` como si hace `/dev`, el unico
  sitio que la enlazaba: viajaba en las builds y en la web bastaba con escribir
  la URL para llegar. Es el mismo motivo por el que se borro la sala de directo
  de maqueta (ver `FEATURE_LIVE` en `src/config/features.ts`). Aqui no hace
  falta redirigir nada porque nunca hubo enlaces publicos a esa ruta. El feed
  de shorts de verdad es `components/ShortVideoItem`, dentro de Inicio.
*/
export default function ReelsRedirect() {
  return <Redirect href="/(tabs)/home" />;
}
