package expo.modules.mejorasdevideo

import java.util.concurrent.atomic.AtomicLong

/**
 * Le pasa al filtro un fotograma solo cuando ha terminado con el anterior.
 *
 * EL DEFECTO (video-filters 2.9.84 y GPUImage 2.1.0, leídos en sus clases).
 * `HMSVideoFilter` convierte cada fotograma de la cámara en un mapa de bits y
 * encarga el retoque a su propio hilo, en una cola SIN LÍMITE. Lo que devuelve
 * es siempre el último retoque terminado. Cada retoque es lento: GPUImage monta
 * un contexto de GPU nuevo y vuelve a compilar los sombreadores en cada uno.
 * Tarda más de lo que tarda en llegar el siguiente fotograma, así que la cola
 * crece sin parar y la imagen se va quedando atrás: segundos. Además, cada
 * fotograma en espera guarda su mapa de bits (unos 3,7 MB a 720p). El SDK
 * tampoco frena nada: los 15 fps de `addPlugin` los calcula, pero no los usa.
 *
 * EL ARREGLO. Un fotograma a la vez. Detrás de cada retoque se deja un aviso en
 * la cola del filtro; hasta que ese aviso llega, los fotogramas que entran se
 * descartan sin convertirlos ni encolarlos. Con «Mejorar» salen menos
 * fotogramas por segundo, pero ninguno con retraso.
 *
 * Por si un aviso no llegara nunca, pasado [paciencia] se deja pasar otro: la
 * cámara no se queda congelada ni en el peor caso.
 *
 * No sabe nada de Android, para poder probarlo fuera del teléfono: el reloj y
 * la cola los pone quien lo usa ([FiltroArreglado]).
 */
internal class UnFotogramaALaVez(
  private val reloj: () -> Long,
  private val paciencia: Long = PACIENCIA_MS,
) {
  /** Cuándo empezó el retoque en marcha, según [reloj], o [LIBRE] si no hay ninguno. */
  private val enMarchaDesde = AtomicLong(LIBRE)

  /**
   * Le da el fotograma al filtro ([procesar]) si está libre. Si no, no hace nada.
   *
   * [encolar] deja un aviso en la cola del filtro y dice si pudo. Si es `null`
   * (no se encontró la cola), pasan todos, como los dejaba 100ms.
   */
  fun pasar(encolar: ((Runnable) -> Boolean)?, procesar: () -> Unit) {
    if (encolar == null) {
      procesar()
      return
    }
    val ahora = reloj()
    val anterior = enMarchaDesde.get()
    if (anterior != LIBRE && ahora - anterior < paciencia) return
    if (!enMarchaDesde.compareAndSet(anterior, ahora)) return
    var avisoEnCola = false
    try {
      procesar()
      // Solo libera SU retoque: si la paciencia ya dejó pasar otro, el aviso
      // de este no abre la puerta al de después.
      avisoEnCola = encolar(Runnable { enMarchaDesde.compareAndSet(ahora, LIBRE) })
    } finally {
      if (!avisoEnCola) enMarchaDesde.compareAndSet(ahora, LIBRE)
    }
  }

  /** Olvida lo que hubiera en marcha: el filtro se quitó y su cola ya no cuenta. */
  fun soltar() {
    enMarchaDesde.set(LIBRE)
  }

  internal companion object {
    const val LIBRE = Long.MIN_VALUE

    /** Lo más que se espera a un retoque antes de dejar pasar otro fotograma. */
    const val PACIENCIA_MS = 2_000L
  }
}
