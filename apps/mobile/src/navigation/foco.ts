import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { useIsFocused } from '@react-navigation/native';

/**
 * ¿Esta pantalla es la que la persona está mirando AHORA MISMO?
 *
 * POR QUE EXISTE. Estar montado no es estar activo. El carrusel de secciones
 * (`SwipeTabs`) deja montadas las vecinas para que aparezcan al instante al
 * arrastrar, y una vez montada una sección ya no se desmonta. Eso es bueno para
 * la fluidez y terrible si además se toma como permiso para reproducir: el
 * vídeo de Inicio seguía sonando desde Explorar o Perfil.
 *
 * Se midió: al entrar en Explorar, el reproductor de Inicio seguía avanzando
 * (`paused=false`, `muted=false`, el tiempo corriendo). No era un fallo del
 * reproductor sino de quién decide: cada pantalla calculaba «activo» mirando
 * solo su estado interno, sin preguntar nunca si alguien la estaba viendo.
 *
 * Aquí vive esa pregunta, una sola vez, para que las tres capas digan lo mismo:
 *
 *     MONTADO      el componente existe en memoria
 *     ACTIVO       además, es lo que se está viendo   ← esto responde el hook
 *     REPRODUCIENDO  además, le toca a ese vídeo concreto
 *
 * `useFocusEffect` dentro del reproductor NO bastaba: solo se dispara al pasar
 * de enfocado a desenfocado, y una sección vecina puede montarse SIN haber
 * estado enfocada nunca. En ese caso no hay transición que escuchar y el vídeo
 * arrancaba solo.
 *
 * Tres condiciones, porque «no se está viendo» tiene tres formas distintas:
 *
 *  1. NAVEGACIÓN — se fue a otra sección o se abrió un detalle encima.
 *  2. APLICACIÓN — se fue al escritorio o atendió una llamada.
 *  3. PESTAÑA (web) — cambió de pestaña del navegador o minimizó.
 *
 * Sin la 2, el audio seguía con el teléfono en el bolsillo. Sin la 3, seguía en
 * una pestaña que ni se ve.
 */
export function useSeccionActiva(): boolean {
  const enfocadaPorNavegacion = useIsFocused();
  const [aplicacionDelante, setAplicacionDelante] = useState(
    () => AppState.currentState === 'active',
  );
  const [pestanaVisible, setPestanaVisible] = useState(
    () =>
      Platform.OS !== 'web' ||
      typeof document === 'undefined' ||
      document.visibilityState === 'visible',
  );

  useEffect(() => {
    const suscripcion = AppState.addEventListener('change', (estado) =>
      setAplicacionDelante(estado === 'active'),
    );
    return () => suscripcion.remove();
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const alCambiar = () => setPestanaVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', alCambiar);
    return () => document.removeEventListener('visibilitychange', alCambiar);
  }, []);

  return enfocadaPorNavegacion && aplicacionDelante && pestanaVisible;
}
