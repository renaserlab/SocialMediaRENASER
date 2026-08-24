/**
 * Cada cuanto se guarda por donde va alguien en una leccion.
 *
 * EL PROBLEMA. El reproductor avisa cuatro veces por segundo. Mandar una
 * peticion por aviso serian catorce mil peticiones en una leccion de una hora,
 * por persona: la red del telefono compitiendo con la descarga del propio
 * video que se esta viendo.
 *
 * EL OTRO PROBLEMA, el contrario. Guardar solo al salir pierde el progreso de
 * quien cierra la aplicacion de golpe, se queda sin bateria o pierde
 * cobertura. Y perder el progreso es peor que no tenerlo: quien vuelve y se
 * encuentra el video al principio deja de fiarse de que se guarde nada.
 *
 * EL EQUILIBRIO. Se guarda cada 15 segundos DE REPRODUCCION, no de reloj: un
 * video pausado no genera peticiones porque no ha avanzado nada. Y ademas en
 * los momentos en que se sabe que puede no haber otra oportunidad —pausa,
 * cambio de leccion, salida, segundo plano, final—, que los decide quien
 * llama.
 *
 * Esta aqui y no dentro del hook para poder probarlo sin montar un reproductor
 * ni un temporizador.
 */

/** Cada cuantos segundos de avance real se guarda. */
export const CADA_SEGUNDOS = 15;

/** Por debajo de esto no se guarda nada: es un toque, no haber visto algo. */
export const MINIMO_PARA_GUARDAR = 3;

export type EstadoDeGuardado = {
  /** Segundos que ya estan guardados en el servidor. */
  guardado: number;
};

/**
 * Si toca mandar el progreso al servidor.
 *
 * `forzado` son los momentos en que puede no haber otra oportunidad: pausa,
 * cambio de leccion, salir, pasar a segundo plano, terminar.
 */
export function debeGuardar(
  estado: EstadoDeGuardado,
  segundosActuales: number,
  forzado = false,
): boolean {
  const actuales = Math.floor(segundosActuales);
  if (actuales < MINIMO_PARA_GUARDAR) return false;
  // Retroceder no se guarda: rebobinar para repasar no es perder lo avanzado,
  // y ademas el servidor se queda con el maximo de todas formas.
  if (actuales <= estado.guardado) return false;
  if (forzado) return true;
  return actuales - estado.guardado >= CADA_SEGUNDOS;
}
