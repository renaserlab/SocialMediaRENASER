import { apiRequest, API_V1 } from '@/services/api';

/**
 * Las reglas del servidor que cambian lo que se pinta (`GET /platform/config`).
 *
 * Hoy una: el MODO FLEXIBLE (`PUBLICACION_FLEXIBLE`). Encendido, enviar un
 * evento, un curso o un producto lo PUBLICA al momento, así que los botones
 * dicen «Publicar» y no «Enviar a revisión», y los mínimos de texto se
 * relajan. Lo decide el servidor: la app solo adapta las palabras, y el
 * servidor vuelve a comprobarlo todo.
 *
 * SE PREGUNTA UNA VEZ POR SESIÓN de la app y se comparte: todas las pantallas
 * que lo necesitan leen la misma promesa. Un fallo NO se guarda —la siguiente
 * pantalla vuelve a preguntar— y mientras tanto vale `false`, que es el modo
 * estricto: decir «Enviar a revisión» de más no promete nada falso.
 */
let enCurso: Promise<boolean> | null = null;

export function publicacionFlexible(): Promise<boolean> {
  if (enCurso === null) {
    enCurso = apiRequest<{ publicacion_flexible?: unknown }>(`${API_V1}/platform/config`, {
      auth: false,
    })
      .then((dto) => dto?.publicacion_flexible === true)
      .catch(() => {
        enCurso = null;
        return false;
      });
  }
  return enCurso;
}
