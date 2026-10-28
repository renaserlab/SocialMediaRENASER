/**
 * Convierte una pregunta en una que se COMPARTE y se recuerda un rato.
 *
 * PARA QUÉ. Hay respuestas que describen la instalación y no a quien mira
 * —qué funciones tiene el servidor— y que varias pantallas piden al montarse,
 * a veces dos a la vez para la misma pantalla. Sin esto cada una es una
 * petición igual a la anterior.
 *
 * LA REGLA
 *
 *   - Si alguien ya está preguntando, se espera a esa misma respuesta.
 *   - Una respuesta buena vale `duraMs`; pasado ese rato se vuelve a preguntar,
 *     para enterarse de que el servidor cambió sin reiniciar la aplicación.
 *   - UN FALLO NO SE RECUERDA: la próxima llamada vuelve a preguntar. Quien
 *     llama decide qué hacer con él, como si no hubiera nada en medio.
 *
 * SIN REACT: se prueba con el runner de Node.
 */
export function respuestaCompartida<T>(
  pedir: () => Promise<T>,
  duraMs: number,
  ahora: () => number = Date.now,
): () => Promise<T> {
  let vigente: { respuesta: Promise<T>; hasta: number } | null = null;

  return () => {
    if (vigente && ahora() < vigente.hasta) return vigente.respuesta;
    // Mientras va y viene, vale para todos: el plazo empieza al contestar.
    const esta = { respuesta: pedir(), hasta: Number.POSITIVE_INFINITY };
    vigente = esta;
    esta.respuesta.then(
      () => {
        if (vigente === esta) esta.hasta = ahora() + duraMs;
      },
      () => {
        if (vigente === esta) vigente = null;
      },
    );
    return esta.respuesta;
  };
}
