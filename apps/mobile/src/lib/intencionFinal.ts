/**
 * Varias pulsaciones rápidas sobre un interruptor, convertidas en UNA intención.
 *
 * LO QUE SE REPORTÓ. Al guardar una publicación «se demora un poco en procesar
 * y luego recién puedo volver a desmarcar… no funciona si se presiona el botón
 * constantemente». Guardar, reaccionar y republicar son interruptores contra
 * un servidor, y había dos formas malas de hacerlos:
 *
 *   - CONGELAR el botón hasta que conteste (republicar): el segundo toque se
 *     pierde y la aplicación parece que no escucha.
 *   - MANDAR UNA PETICIÓN POR TOQUE (guardar, reaccionar): cuatro toques son
 *     cuatro peticiones volando a la vez, que pueden llegar en otro orden.
 *     La pantalla dice «guardada», el servidor se quedó en «no guardada», y
 *     al recargar el icono cambia solo.
 *
 * LO QUE HACE ESTO. El icono cambia en cada toque, al instante. Al servidor
 * solo viaja una petición a la vez por elemento, y cuando vuelve se mira qué
 * quiere la persona AHORA: si coincide con lo que el servidor ya tiene, no se
 * manda nada más; si no, se manda eso. Diez toques son como mucho dos
 * peticiones, y nunca hay dos en vuelo: las respuestas no pueden cruzarse.
 *
 * SIN REACT Y SIN STORE: es la regla, y se prueba ejecutándola.
 */

export type ResultadoDeIntencion<R, C> = {
  /** Lo que el servidor tiene al terminar. */
  valor: boolean;
  /**
   * Si lo que la persona quería es lo que quedó. `false` solo cuando una
   * petición falló Y lo que quería no es lo que hay: entonces la pantalla
   * tiene que volver a `valor` y decirlo.
   */
  ok: boolean;
  /** La respuesta de la última petición que salió bien, si hubo alguna. */
  respuesta: R | undefined;
  /** Lo que se guardó al empezar la ráfaga (p. ej. el contador de partida). */
  contexto: C;
};

export type PeticionDeIntencion<R, C> = {
  /** Se resuelve cuando la ráfaga se asienta. Nunca falla. */
  asentada: Promise<ResultadoDeIntencion<R, C>>;
  /**
   * `true` si este toque se sumó a una ráfaga que ya estaba en marcha. Quien
   * la empezó es quien cuenta cómo acabó: así diez toques dan un aviso y no
   * diez.
   */
  absorbida: boolean;
  /** El contexto de la ráfaga: el mismo para todos sus toques. */
  contexto: C;
};

type Rafaga<R, C> = {
  confirmado: boolean;
  deseado: boolean;
  contexto: C;
  asentada: Promise<ResultadoDeIntencion<R, C>>;
};

export type Consolidador<R, C> = {
  /**
   * La persona quiere que `clave` quede en `deseado`.
   *
   * `alEmpezar` solo se llama si no había ráfaga: devuelve lo que el servidor
   * tiene ahora (`confirmado`) y lo que haya que recordar para deshacer
   * (`contexto`).
   */
  pedir(
    clave: string,
    deseado: boolean,
    alEmpezar: () => { confirmado: boolean; contexto: C },
  ): PeticionDeIntencion<R, C>;
  /** Si hay una petición en vuelo para esa clave. Para pintar «pendiente». */
  pendiente(clave: string): boolean;
};

/**
 * @param enviar manda UN estado al servidor. Tiene que ser idempotente:
 *   guardar lo ya guardado no es un error.
 */
export function crearConsolidador<R = void, C = undefined>(
  enviar: (clave: string, valor: boolean) => Promise<R>,
): Consolidador<R, C> {
  const rafagas = new Map<string, Rafaga<R, C>>();

  async function vaciar(clave: string, rafaga: Rafaga<R, C>): Promise<ResultadoDeIntencion<R, C>> {
    let respuesta: R | undefined;
    try {
      // Mientras lo que quiere no sea lo que hay, se manda lo que quiere
      // AHORA —no lo que quería cuando salió la petición anterior—.
      while (rafaga.deseado !== rafaga.confirmado) {
        const objetivo = rafaga.deseado;
        respuesta = await enviar(clave, objetivo);
        rafaga.confirmado = objetivo;
      }
      return { valor: rafaga.confirmado, ok: true, respuesta, contexto: rafaga.contexto };
    } catch {
      // Se abandona. Lo que hay es lo último que el servidor confirmó; si eso
      // es justo lo que la persona acabó queriendo, no hay nada que lamentar.
      return {
        valor: rafaga.confirmado,
        ok: rafaga.deseado === rafaga.confirmado,
        respuesta,
        contexto: rafaga.contexto,
      };
    } finally {
      // Se borra ANTES de que nadie reciba el resultado: el siguiente toque
      // empieza una ráfaga nueva, con lo confirmado al día.
      rafagas.delete(clave);
    }
  }

  return {
    pedir(clave, deseado, alEmpezar) {
      const enMarcha = rafagas.get(clave);
      if (enMarcha) {
        enMarcha.deseado = deseado;
        return { asentada: enMarcha.asentada, absorbida: true, contexto: enMarcha.contexto };
      }
      const { confirmado, contexto } = alEmpezar();
      const rafaga = { confirmado, deseado, contexto } as Rafaga<R, C>;
      rafagas.set(clave, rafaga);
      rafaga.asentada = vaciar(clave, rafaga);
      return { asentada: rafaga.asentada, absorbida: false, contexto };
    },
    pendiente(clave) {
      return rafagas.has(clave);
    },
  };
}

/**
 * El contador que se enseña mientras la ráfaga está en marcha.
 *
 * Sale SIEMPRE del contador de partida y de la diferencia entre lo que hay y
 * lo que se quiere, nunca de sumar o restar sobre lo que ya se pintó: diez
 * toques no pueden dejar un «+10».
 */
export function contadorOptimista(deBase: number, confirmado: boolean, deseado: boolean): number {
  if (confirmado === deseado) return Math.max(0, deBase);
  return Math.max(0, deBase + (deseado ? 1 : -1));
}
