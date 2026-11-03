package expo.modules.mejorasdevideo

import android.opengl.EGL14
import android.opengl.EGLContext
import android.os.Handler
import android.os.Looper
import android.util.Log
import hms.webrtc.TextureBufferImpl
import hms.webrtc.VideoFrame
import live.hms.video.plugin.video.HMSVideoPlugin
import live.hms.video.plugin.video.HMSVideoPluginType
import live.hms.video.sdk.HMSPluginResultListener

/**
 * «Mejorar» en Android: un complemento de video propio, que retoca la cámara
 * en la GPU ([RetocadorGpu]) en el mismo hilo en que llega cada fotograma.
 *
 * POR QUÉ NO EL FILTRO DE 100ms (`HMSVideoFilter`, 2.9.84). Pasaba cada
 * fotograma a mapa de bits, lo retocaba con GPUImage montando un contexto de
 * GPU nuevo por fotograma y lo volvía a subir. No daba abasto, encolaba sin
 * límite (segundos de retraso) y devolvía la imagen en espejo. Esto no saca el
 * fotograma de la GPU: misma frecuencia que la cámara y sin cola.
 *
 * CÓMO LLEGAN LOS FOTOGRAMAS (leído en las clases del SDK). La cámara de 100ms
 * (`HMSCameraCapturer`) entrega cada fotograma en el hilo de su
 * `SurfaceTextureHelper`, con su contexto de GPU puesto, y de ahí pasa sin
 * cambiar de hilo por `VideoSource` hasta `processVideoFrame`. Lo que se
 * devuelve por `onOutputResult` lo envía el SDK a la sala y a la vista, y
 * después lo suelta (`release`).
 *
 * NUNCA DEJA LA CÁMARA SIN IMAGEN. Si algo no es como se espera (no es una
 * textura, no estamos en su hilo, no hay contexto) o la GPU falla una vez, el
 * fotograma pasa tal cual, sin retocar. Si falla, no se vuelve a intentar
 * hasta que se apague y se encienda.
 */
internal class FiltroDeMejoras : HMSVideoPlugin {
  /** Lo que piden las barras. Se cambia desde el hilo del módulo. */
  @Volatile var ajustes = Ajustes()

  private val retocador = RetocadorGpu()

  /** El hilo de la cámara y su contexto de GPU, donde vive todo lo del [retocador]. */
  @Volatile private var hiloDeLaGpu: Handler? = null
  private var contextoDeLaGpu: EGLContext? = null

  /** La GPU falló: todo pasa sin retocar hasta el próximo encendido. */
  @Volatile private var averiado = false

  override fun getName(): String = NOMBRE

  override fun getPluginType(): HMSVideoPluginType = HMSVideoPluginType.TRANSFORM

  override fun isSupported(): Boolean = true

  override suspend fun init() {
    averiado = false
  }

  override fun processVideoFrame(
    input: VideoFrame,
    outputListener: HMSPluginResultListener?,
    skipProcessing: Boolean?,
  ) {
    val destino = outputListener ?: return
    val ajustes = ajustes
    val textura = if (skipProcessing == true) null else retocable(input, ajustes)
    if (textura == null) return pasarTalCual(input, destino)
    val salida = try {
      retocador.retocar(textura, input.rotation, input.timestampNs, ajustes, textura.toI420Handler, textura.yuvConverter)
    } catch (fallo: Throwable) {
      Log.e(ETIQUETA, "La GPU falló retocando; «Mejorar» queda sin efecto hasta reencenderlo.", fallo)
      averiado = true
      runCatching { retocador.liberar() }
      return pasarTalCual(input, destino)
    }
    // `null`: todas las salidas siguen en uso. Este fotograma se pierde: uno
    // sin retocar en medio se vería como un parpadeo.
    if (salida != null) destino.onOutputResult(salida)
  }

  /**
   * La textura de la cámara si se puede retocar AQUÍ: hay algo que hacer, es
   * una textura, estamos en su hilo y con su contexto de GPU puesto. Si no,
   * `null`, y el fotograma pasa tal cual.
   */
  private fun retocable(entrada: VideoFrame, ajustes: Ajustes): TextureBufferImpl? {
    if (averiado || ajustes.neutros) return null
    val textura = entrada.buffer as? TextureBufferImpl ?: return null
    val hilo = textura.toI420Handler ?: return null
    if (hilo.looper != Looper.myLooper()) return null
    val contexto = EGL14.eglGetCurrentContext()
    if (contexto == null || contexto == EGL14.EGL_NO_CONTEXT) return null
    if (contexto != contextoDeLaGpu) {
      // Otra cámara, otro contexto: lo creado en el de antes no sirve aquí.
      retocador.abandonar()
      contextoDeLaGpu = contexto
    }
    hiloDeLaGpu = hilo
    return textura
  }

  /** El SDK suelta lo que recibe después de enviarlo: se retiene antes. */
  private fun pasarTalCual(entrada: VideoFrame, destino: HMSPluginResultListener) {
    entrada.retain()
    destino.onOutputResult(entrada)
  }

  /**
   * El SDK lo llama al quitar el complemento, desde su hilo. Lo de la GPU se
   * suelta en el hilo de la cámara, que es donde vive.
   */
  override fun stop() {
    hiloDeLaGpu?.post {
      if (EGL14.eglGetCurrentContext() == contextoDeLaGpu) {
        runCatching { retocador.liberar() }
      } else {
        retocador.abandonar()
      }
    }
  }

  internal companion object {
    /** Único entre los complementos de la sala: el SDK los guarda por nombre. */
    const val NOMBRE = "zeta-mejorar"
    private const val ETIQUETA = "MejorasDeVideo"
  }
}
