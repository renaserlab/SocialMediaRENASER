import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { debeGuardar } from '@/lib/ritmoDeProgreso';
import { LearningRepository } from '@/repositories/LearningRepository';

/**
 * Guarda por donde va esta persona en una leccion.
 *
 * QUE RESUELVE. `lesson_progress.progress_seconds` existia en la base desde el
 * primer dia y nadie lo escribia nunca: la aplicacion no tenia forma de
 * guardarlo y `LearningRepository.completeLesson()` no se llamaba desde
 * ninguna pantalla. Un curso se podia ver entero y seguir marcando 0 %.
 *
 * COMO. El reproductor avisa de su avance; aqui se decide cada cuanto eso se
 * convierte en una peticion (ver `lib/ritmoDeProgreso.ts`) y se fuerza el
 * guardado en los momentos en los que puede no haber otra oportunidad: al
 * pausar, al terminar, al irse la aplicacion a segundo plano y al salir de la
 * pantalla.
 *
 * LOS FALLOS NO MOLESTAN A NADIE. Si una peticion no sale, se calla y se
 * reintenta en el siguiente tramo. Interrumpir la reproduccion con un aviso de
 * red por no haber podido guardar un segundo seria peor que el problema.
 */
export function useProgresoDeLeccion(
  lessonId: string | undefined,
  opciones: { habilitado?: boolean; alCompletar?: (cursoCompleto: boolean) => void } = {},
) {
  const { habilitado = true, alCompletar } = opciones;

  /** Lo ultimo que confirmo el servidor. */
  const guardado = useRef(0);
  /** Lo ultimo que dijo el reproductor. */
  const actual = useRef(0);
  /** Una peticion en vuelo; no se lanzan dos a la vez. */
  const enVuelo = useRef(false);
  const alCompletarRef = useRef(alCompletar);
  alCompletarRef.current = alCompletar;

  // Cambiar de leccion reinicia el contador: si no, el progreso de la anterior
  // se le atribuiria a la siguiente.
  useEffect(() => {
    guardado.current = 0;
    actual.current = 0;
  }, [lessonId]);

  const enviar = useCallback(
    async (segundos: number, completado: boolean) => {
      if (!lessonId || enVuelo.current) return;
      enVuelo.current = true;
      try {
        const resultado = await LearningRepository.saveProgress(
          lessonId,
          segundos,
          completado,
        );
        guardado.current = resultado.progressSeconds;
        if (resultado.completed) alCompletarRef.current?.(resultado.courseCompleted);
      } catch {
        // Se reintenta en el siguiente tramo. Un aviso aqui interrumpiria el
        // video por algo que la persona no puede resolver.
      } finally {
        enVuelo.current = false;
      }
    },
    [lessonId],
  );

  /** Lo llama el reproductor en cada aviso. Casi siempre no hace nada. */
  const alAvanzar = useCallback(
    (segundos: number) => {
      actual.current = segundos;
      if (!habilitado) return;
      if (!debeGuardar({ guardado: guardado.current }, segundos)) return;
      void enviar(Math.floor(segundos), false);
    },
    [enviar, habilitado],
  );

  /** Momentos en los que puede no haber otra oportunidad de guardar. */
  const guardarAhora = useCallback(
    (completado = false) => {
      if (!habilitado) return;
      const segundos = Math.floor(actual.current);
      if (!completado && !debeGuardar({ guardado: guardado.current }, segundos, true)) {
        return;
      }
      void enviar(segundos, completado);
    },
    [enviar, habilitado],
  );

  /** El video llego al final: eso lo sabe el reproductor y nadie mas. */
  const alTerminar = useCallback(() => {
    guardarAhora(true);
  }, [guardarAhora]);

  // Segundo plano y desmontaje. Sin esto, quien cierra la aplicacion de golpe
  // pierde lo visto desde el ultimo tramo guardado.
  useEffect(() => {
    if (!habilitado) return;
    const suscripcion = AppState.addEventListener('change', (estado) => {
      if (estado !== 'active') guardarAhora();
    });
    return () => {
      suscripcion.remove();
      guardarAhora();
    };
  }, [guardarAhora, habilitado]);

  return { alAvanzar, alTerminar, guardarAhora };
}
