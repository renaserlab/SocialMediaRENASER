import { Redirect } from 'expo-router';

/**
 * Compatibilidad: `/stories/nueva` ya no es una pantalla.
 *
 * Crear una historia se hace ahora desde la PESTAÑA Crear, en modo Historia,
 * que es la unica puerta a crear contenido. Antes esta ruta vivia fuera del
 * grupo de pestañas y por eso al entrar desaparecia la barra de secciones,
 * ademas de que el `+` de la fila de historias y el del muro acababan en
 * pantallas distintas aunque significan lo mismo.
 *
 * El archivo se queda solo para redirigir. Borrarlo del todo seria peor: la
 * ruta `/stories/[id]` capturaria la palabra «nueva» y quien llegara desde un
 * enlace viejo o desde el historial del navegador acabaria en un «historia no
 * encontrada». Aqui no queda ninguna vista antigua, solo el desvio.
 */
export default function NuevaHistoriaRedirige() {
  return <Redirect href="/(tabs)/create?modo=historia" />;
}
