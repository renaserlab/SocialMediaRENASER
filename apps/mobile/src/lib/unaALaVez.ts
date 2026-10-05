/**
 * Convierte una tarea en una que nunca corre dos veces a la vez.
 *
 * PARA QUÉ. «Ponerse al día» —pedir al servidor lo que haya entrado desde lo
 * último que se tiene— lo piden varias señales que no saben unas de otras: el
 * canal de tiempo real que se reengancha, un push que llega, la pantalla que
 * recupera el foco, la aplicación que vuelve del segundo plano. A menudo dos o
 * tres a la vez. Sin esto serían dos o tres peticiones iguales, y la segunda
 * podría responder antes que la primera y pintar una lista más vieja encima de
 * una más nueva.
 *
 * LA REGLA
 *
 *   - Si no está corriendo, corre.
 *   - Si la piden mientras corre, corre UNA vez más al terminar, por muchas
 *     veces que se haya pedido en medio. Esa vuelta de más no es un adorno: lo
 *     que motivó la petición pudo ocurrir después de que la tarea en curso
 *     mirase, y sin ella se quedaría sin ver.
 *   - NUNCA LANZA. Una vuelta que falla no rompe a quien la pidió: la siguiente
 *     señal lo vuelve a intentar.
 *
 * SIN REACT: se prueba con el runner de Node.
 */
export function unaALaVez(tarea: () => Promise<void>): () => Promise<void> {
  let enCurso: Promise<void> | null = null;
  let otraVez = false;

  const correr = async (): Promise<void> => {
    do {
      otraVez = false;
      try {
        await tarea();
      } catch {
        // La siguiente señal lo reintenta.
      }
    } while (otraVez);
  };

  return () => {
    if (enCurso) {
      otraVez = true;
      return enCurso;
    }
    enCurso = correr().finally(() => {
      enCurso = null;
    });
    return enCurso;
  };
}
