package expo.modules.mejorasdevideo

import android.os.Handler
import android.os.SystemClock
import hms.webrtc.VideoFrame
import java.lang.reflect.Field
import java.nio.ByteBuffer
import live.hms.video.plugin.video.HMSVideoPlugin
import live.hms.video.sdk.HMSPluginResultListener
import live.hms.video.sdk.ProcessTimeVariables
import live.hms.videofilters.HMSVideoFilter

/**
 * El filtro de 100ms (`HMSVideoFilter`) con sus defectos corregidos.
 *
 * 1. **Devuelve la imagen en espejo.** Se endereza cada fotograma que sale
 *    ([enderezar], el porqué está allí).
 * 2. **Se va quedando atrás, segundos.** Encola todos los fotogramas aunque no
 *    dé abasto. Se le pasan de uno en uno ([UnFotogramaALaVez]).
 * 3. **No cierra nunca su hilo.** Cada vez que se enciende abre uno más. Se
 *    cierra al quitarlo ([stop]).
 *
 * Todo lo demás (nombre, tipo, `init`) es el filtro de 100ms tal cual.
 */
internal class FiltroArreglado(val filtro: HMSVideoFilter) : HMSVideoPlugin by filtro {
  private val compuerta = UnFotogramaALaVez(reloj = SystemClock::elapsedRealtime)

  override fun processVideoFrame(
    input: VideoFrame,
    outputListener: HMSPluginResultListener?,
    skipProcessing: Boolean?,
  ) {
    compuerta.pasar(hiloDe(filtro)?.let { hilo -> hilo::post }) {
      filtro.processVideoFrame(input, outputListener?.let(::alDerecho), skipProcessing)
    }
  }

  /**
   * El SDK solo lo llama al quitar el complemento, ya fuera de su lista. Lo que
   * quede en la cola del hilo se termina antes de cerrarlo. Si se vuelve a
   * poner, `init()` abre otro hilo.
   */
  override fun stop() {
    val hilo = hiloDe(filtro)
    filtro.stop()
    compuerta.soltar()
    hilo?.looper?.quitSafely()
  }
}

/**
 * El hilo donde el filtro hace los retoques: su campo privado `processHandler`.
 * Es `null` hasta su `init()`, o si otra versión del SDK lo cambiara. Sin él,
 * todo funciona como lo dejó 100ms.
 *
 * El SDK manda conservar sus clases tal cual (`-keep class live.hms.** { *; }`
 * en sus reglas de ProGuard), así que el nombre no cambia al compilar.
 */
private fun hiloDe(filtro: HMSVideoFilter): Handler? =
  runCatching { CAMPO_DEL_HILO?.get(filtro) as? Handler }.getOrNull()

private val CAMPO_DEL_HILO: Field? = runCatching {
  HMSVideoFilter::class.java.getDeclaredField("processHandler").apply { isAccessible = true }
}.getOrNull()

/** El destino del SDK, recibiendo cada fotograma ya enderezado. */
private fun alDerecho(destino: HMSPluginResultListener): HMSPluginResultListener =
  object : HMSPluginResultListener {
    override fun onOutputResult(output: VideoFrame?) {
      destino.onOutputResult(output?.let(::enderezar))
    }

    override fun onTimeTaken(timeObject: ProcessTimeVariables) {
      destino.onTimeTaken(timeObject)
    }
  }

/** El giro con el que `HMSVideoFilter` 2.9.84 marca todo lo que devuelve. */
internal const val GIRO_DEL_FILTRO = 180

/**
 * Deshace el espejo de un fotograma del filtro.
 *
 * EL DEFECTO (video-filters 2.9.84, leído en sus clases). Para devolver el
 * fotograma filtrado, `HMSVideoFilter` sube su mapa de bits a una textura, la
 * pasa a I420 con `YuvConverter` y lo marca girado 180°. En WebRTC la fila 0
 * de una textura es la de ABAJO, así que el I420 sale volteado de arriba
 * abajo. El giro de 180° lo pone de pie, pero cambiando la izquierda por la
 * derecha: un espejo. El fondo virtual de 100ms hace el mismo camino y sale
 * bien porque le añade a la textura un `postScale(-1, 1)`. El filtro no.
 *
 * LO QUE SE VEÍA. Con «Mejorar» puesto, el público veía en espejo a quien
 * emite (un letrero, al revés). Quien emite se ve en espejo a propósito, como
 * en cualquier cámara frontal (`EscenarioDeVideo`), así que se veía al
 * derecho: si se movía a la derecha, su imagen iba a la izquierda. Con todo en
 * 0 tres segundos el filtro se quita y volvía a estar bien. Por eso pasaba
 * «a veces».
 *
 * EL ARREGLO. Se vuelven a poner las filas en su orden (en el mismo búfer) y se
 * quita el giro. Voltear de arriba abajo y girar 180° es exactamente voltear de
 * izquierda a derecha, que es lo que sobraba. Son tres planos copiados fila a
 * fila: nada al lado de lo que ya cuesta el filtro.
 *
 * Solo toca lo que sale como sale hoy (I420 girado 180°). Con otro giro no se
 * sabe qué habría que corregir, y voltear algo que ya está bien sería el mismo
 * defecto al revés: se deja pasar tal cual.
 *
 * El búfer es el mismo, recién hecho por el filtro para este fotograma y de
 * nadie más. No se retiene ni se suelta: el SDK lo suelta una vez después de
 * pintarlo y enviarlo, como habría soltado el original.
 */
internal fun enderezar(fotograma: VideoFrame): VideoFrame {
  if (fotograma.rotation != GIRO_DEL_FILTRO) return fotograma
  val i420 = fotograma.buffer as? VideoFrame.I420Buffer ?: return fotograma
  val ancho = i420.width
  val alto = i420.height
  val anchoDeColor = (ancho + 1) / 2
  val altoDeColor = (alto + 1) / 2
  voltearFilas(i420.dataY, i420.strideY, ancho, alto)
  voltearFilas(i420.dataU, i420.strideU, anchoDeColor, altoDeColor)
  voltearFilas(i420.dataV, i420.strideV, anchoDeColor, altoDeColor)
  return VideoFrame(i420, 0, fotograma.timestampNs)
}

/**
 * Pone las filas de un plano en orden inverso, en el sitio.
 *
 * Copia `ancho` bytes de cada fila y no el paso entero: la última fila de un
 * plano puede no llegar a ocupar su paso completo.
 */
internal fun voltearFilas(plano: ByteBuffer, paso: Int, ancho: Int, filas: Int) {
  val arriba = ByteArray(ancho)
  val abajo = ByteArray(ancho)
  var i = 0
  var j = filas - 1
  while (i < j) {
    plano.position(i * paso)
    plano.get(arriba)
    plano.position(j * paso)
    plano.get(abajo)
    plano.position(i * paso)
    plano.put(abajo)
    plano.position(j * paso)
    plano.put(arriba)
    i++
    j--
  }
}
