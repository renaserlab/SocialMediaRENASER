/**
 * QUE HACE EL BOTON ATRAS DE ANDROID: la decision y la maquina que la aplica.
 *
 * POR QUE ESTE FICHERO EXISTE Y NO IMPORTA NADA. Hasta ahora todo esto vivia
 * dentro de un `useEffect` del layout raiz, asi que para comprobar que «la
 * primera pulsacion en la raiz avisa y la segunda sale» habia que montar la
 * aplicacion entera en un telefono. Es decir: no se comprobaba nunca, y por eso
 * el fallo que reporto el cliente —Atras cerraba la aplicacion en vez de
 * deshacer la navegacion— pudo vivir tanto tiempo.
 *
 * Aqui no hay React, ni React Native, ni un solo import: el fichero se ejecuta
 * tal cual con `node --test`, que es lo que permite probarlo de verdad
 * (`atras.test.mts` y `recorridoDeAtras.test.mts`). Quien lo enchufa al
 * `BackHandler` y a la navegacion real es
 * `src/hooks/useSalidaConDoblePulsacion.ts`, que ya no decide nada.
 *
 * Van juntos —decision y maquina— porque el proyecto no permite importar entre
 * ficheros `.ts` con extension y sin ella Node no resolveria la ruta; partirlo
 * obligaria a tocar la configuracion de TypeScript para no ganar nada.
 */


/* ------------------------------------------------------------------------- *
 * LA DECISION. Tres datos entran, un veredicto sale. Nada mas.
 * ------------------------------------------------------------------------- */

export const MARGEN_DE_SALIDA_MS = 2000;

export type EntradaDeAtras = {
  /**
   * Hay algo montado ENCIMA de la pantalla: un dialogo, una hoja inferior, un
   * recorte de foto, un visor. Cerrarlo es siempre lo primero: retroceder de
   * pantalla con una capa delante deja al usuario mirando una capa huerfana
   * sobre una pantalla que ya no es la suya.
   */
  hayCapaAbierta: boolean;
  /**
   * Queda una ruta anterior a la que volver. Lo responde `canGoBack()` del
   * contenedor de navegacion, que pregunta a la pantalla enfocada y sube por
   * sus padres: cubre tanto el historial ENTRE PESTANAS (`backBehavior="history"`
   * del `TabRouter`) como la pila de DETALLES de encima.
   */
  puedeVolver: boolean;
  /**
   * Milisegundos desde la pulsacion que mostro el aviso, o `null` si no hay
   * ninguna pendiente. `null` —y no cero— porque «nunca» y «ahora mismo» son
   * respuestas opuestas y confundirlas cerraria la aplicacion a la primera.
   */
  msDesdeLaUltimaPulsacion: number | null;
};

export type DecisionDeAtras =
  /** Cerrar la capa de encima y no tocar la navegacion. */
  | 'cerrarCapa'
  /** Deshacer la ultima navegacion: es lo normal y lo que mas ocurre. */
  | 'volver'
  /** No queda a donde volver: avisar de que otra pulsacion cierra. */
  | 'avisar'
  /** Confirmado dentro del margen: que se cierre la aplicacion. */
  | 'salir';

/**
 * El orden de las tres preguntas ES la regla, y no es intercambiable.
 *
 * 1. CAPA. Una hoja abierta se come el Atras entera. Si esto fuera despues de
 *    `puedeVolver`, abrir los comentarios de una publicacion y pulsar Atras
 *    saldria de la publicacion con los comentarios todavia montados.
 *
 * 2. VOLVER. Mientras quede ruta anterior no se pregunta nada mas: el aviso de
 *    salida NO aparece a mitad del historial. Es literalmente el fallo que se
 *    corrige —el usuario no tiene que pulsar rapido durante todo el recorrido—
 *    y por eso `puedeVolver` manda sobre el temporizador.
 *
 * 3. SALIR / AVISAR. Solo en la raiz, y solo con una confirmacion reciente.
 *
 * Casos raros tratados como «avisar» a proposito, porque equivocarse hacia el
 * otro lado cierra la aplicacion de alguien:
 *
 *  - `msDesdeLaUltimaPulsacion` negativo: el reloj del telefono salto hacia
 *    atras (cambio de hora, sincronizacion NTP). No es una confirmacion.
 *  - `Infinity` o `NaN`: no es una medida de nada.
 *  - Exactamente `MARGEN_DE_SALIDA_MS`: el margen ya se agoto. La comparacion
 *    es estricta para que el limite tenga un solo lado.
 */
export function decidirAtras({
  hayCapaAbierta,
  puedeVolver,
  msDesdeLaUltimaPulsacion,
}: EntradaDeAtras): DecisionDeAtras {
  if (hayCapaAbierta) return 'cerrarCapa';
  if (puedeVolver) return 'volver';

  const ms = msDesdeLaUltimaPulsacion;
  const confirmacionReciente =
    ms !== null && Number.isFinite(ms) && ms >= 0 && ms < MARGEN_DE_SALIDA_MS;

  return confirmacionReciente ? 'salir' : 'avisar';
}


/* ------------------------------------------------------------------------- *
 * LA MAQUINA. Lleva la cuenta de la doble pulsacion y ejecuta el veredicto.
 *
 * Lo que hay que poder comprobar aqui no es la decision suelta sino lo que la
 * rodea: que el temporizador se arma y se olvida, que retroceder cancela una
 * confirmacion a medias, que al desmontar no queda ni un `setTimeout` ni un
 * oyente vivo, y que dos montajes no dejan dos oyentes sobre la misma tecla.
 * Por eso el entorno se INYECTA: reloj, temporizador y suscripcion son
 * parametros, y las pruebas mandan sobre los dos segundos en vez de esperarlos.
 * ------------------------------------------------------------------------- */

export type EntornoDeAtras = {
  /**
   * Suscribe el manejador a la tecla Atras. Devuelve como quitarlo.
   *
   * El manejador devuelve `true` cuando se ha quedado el evento y `false`
   * cuando quiere que siga su camino (que en Android acaba cerrando la
   * aplicacion).
   */
  suscribir: (manejador: () => boolean) => () => void;
  /** Reloj. Inyectado para que las pruebas manden sobre los 2 segundos. */
  ahora: () => number;
  /** Programa el olvido de la confirmacion. Devuelve como cancelarlo. */
  programar: (fn: () => void, ms: number) => () => void;
  /** ¿Hay un dialogo, hoja o visor delante? */
  hayCapaAbierta: () => boolean;
  /** Cerrar esa capa. */
  cerrarCapa: () => void;
  /** ¿Queda ruta anterior? Lo contesta la navegacion, nadie mas. */
  puedeVolver: () => boolean;
  /** Deshacer la ultima navegacion. */
  volver: () => void;
  /** Mostrar «Presiona otra vez para salir». */
  avisar: () => void;
};

/**
 * Ya hay una instalacion viva.
 *
 * Es de modulo y no de componente a proposito: el layout raiz puede montarse
 * dos veces (recarga en caliente, un arbol en modo estricto) y dos oyentes
 * sobre la misma tecla se pisan —el aviso saldria dos veces y harian falta dos
 * pulsaciones para cada paso—. La limpieza lo devuelve a `false`, asi que un
 * ciclo montar/desmontar/montar vuelve a instalar con normalidad.
 */
let instalado = false;

/** Solo para las pruebas: ¿queda algo instalado? */
export function hayAtrasInstalado(): boolean {
  return instalado;
}

/**
 * Instala el comportamiento y devuelve como retirarlo.
 *
 * Si ya habia una instalacion viva NO se instala nada y se devuelve una
 * limpieza vacia: la primera sigue mandando. Retirar la vacia no puede
 * desmontar por accidente a la que si esta funcionando.
 */
export function instalarAtras(entorno: EntornoDeAtras): () => void {
  if (instalado) return () => {};
  instalado = true;

  /** Cuando se mostro el aviso, o `null` si no hay confirmacion pendiente. */
  let avisadoEn: number | null = null;
  /** Como cancelar el olvido programado, o `null` si no hay ninguno. */
  let cancelarOlvido: (() => void) | null = null;

  const olvidarLaConfirmacion = () => {
    avisadoEn = null;
    if (cancelarOlvido) {
      cancelarOlvido();
      cancelarOlvido = null;
    }
  };

  const quitarSuscripcion = entorno.suscribir(() => {
    const decision = decidirAtras({
      hayCapaAbierta: entorno.hayCapaAbierta(),
      puedeVolver: entorno.puedeVolver(),
      msDesdeLaUltimaPulsacion: avisadoEn === null ? null : entorno.ahora() - avisadoEn,
    });

    switch (decision) {
      case 'cerrarCapa':
        entorno.cerrarCapa();
        return true;

      case 'volver':
        /*
          Se retrocede AQUI y se devuelve `true`, en vez de devolver `false`
          para que lo haga el manejador de expo-router.

          El codigo anterior hacia lo segundo y lo justificaba diciendo que
          este oyente se registra DESPUES que el de la navegacion. Es al reves:
          `useBackButton` vive en el `NavigationContainer` de expo-router, que
          es ANCESTRO del layout raiz, y React ejecuta los efectos de los hijos
          antes que los de los padres; como Android consulta los oyentes del
          ultimo al primero, el de expo-router va delante. Que el resultado
          fuera correcto de todas formas era suerte, no diseño.

          Encargarse aqui quita esa dependencia del orden de montaje. No hay
          riesgo de retroceder dos veces: Android para en el primer oyente que
          devuelve `true`, asi que solo uno de los dos llega a actuar.
        */
        olvidarLaConfirmacion();
        entorno.volver();
        return true;

      case 'avisar':
        /*
          Se rearma el reloj en cada aviso. Sin cancelar el anterior, dos
          pulsaciones separadas por mas del margen dejarian dos olvidos en
          vuelo y el segundo borraria una confirmacion recien puesta.
        */
        if (cancelarOlvido) cancelarOlvido();
        avisadoEn = entorno.ahora();
        cancelarOlvido = entorno.programar(() => {
          avisadoEn = null;
          cancelarOlvido = null;
        }, MARGEN_DE_SALIDA_MS);
        entorno.avisar();
        return true;

      case 'salir':
        /*
          Unico camino que devuelve `false`. Android entiende que nadie se ha
          quedado el evento y cierra la aplicacion, que es exactamente lo que
          la segunda pulsacion pedia.
        */
        return false;
    }
  });

  let retirado = false;
  return () => {
    if (retirado) return;
    retirado = true;
    instalado = false;
    quitarSuscripcion();
    // El temporizador tambien: un olvido pendiente sobre un cierre ya
    // desmontado es una fuga, y en una recarga en caliente escribiria sobre el
    // estado de la instalacion siguiente.
    olvidarLaConfirmacion();
  };
}
