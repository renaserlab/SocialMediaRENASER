package expo.modules.mejorasdevideo

import android.opengl.EGL14
import android.opengl.EGLContext
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

  /**
   * La GPU falló: todo pasa sin retocar hasta que se quite y se vuelva a poner.
   * El módulo lo mira para decírselo a JavaScript (que entonces lo apaga).
   */
  @Volatile var averiado = false
    private set

  /** Quitado del SDK: lo que aún llegue pasa tal cual, sin crear nada en la GPU. */
  @Volatile private var detenido = false

  /**
   * El retocador de la cámara de ahora, con su hilo y su contexto. Si la cámara
   * se vuelve a crear (otro hilo, otro contexto), se estrena otro: nada de la
   * GPU se usa fuera del hilo donde se creó.
   */
  @Volatile private var retocador: RetocadorGpu? = null
  @Volatile private var contextoDeLaGpu: EGLContext? = null

  override fun getName(): String = NOMBRE

  override fun getPluginType(): HMSVideoPluginType = HMSVideoPluginType.TRANSFORM

  override fun isSupported(): Boolean = true

  /** El SDK lo llama en cada `addPlugin`, antes de mandar fotogramas. */
  override suspend fun init() {
    averiado = false
    detenido = false
  }

  override fun processVideoFrame(
    input: VideoFrame,
    outputListener: HMSPluginResultListener?,
    skipProcessing: Boolean?,
  ) {
    val destino = outputListener ?: return
    val ajustes = ajustes
    val textura = if (skipProcessing == true) null else retocable(input, ajustes)
    val retocador = retocador
    if (textura == null || retocador == null) return pasarTalCual(input, destino)
    val salida = try {
      retocador.retocar(textura, input.rotation, input.timestampNs, ajustes, textura.yuvConverter)
    } catch (fallo: Throwable) {
      Log.e(ETIQUETA, "La GPU falló retocando; «Mejorar» queda sin efecto.", fallo)
      averiado = true
      this.retocador = null
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
   * `null`, y el fotograma pasa tal cual. Deja listo el [retocador] de esta
   * cámara.
   */
  private fun retocable(entrada: VideoFrame, ajustes: Ajustes): TextureBufferImpl? {
    if (detenido || averiado || ajustes.neutros) return null
    val textura = entrada.buffer as? TextureBufferImpl ?: return null
    val hilo = textura.toI420Handler ?: return null
    if (hilo.looper != Looper.myLooper()) return null
    val contexto = EGL14.eglGetCurrentContext()
    if (contexto == null || contexto == EGL14.EGL_NO_CONTEXT) return null
    val actual = retocador
    // Se compara también el hilo: el número de un contexto nuevo puede repetir
    // el de uno destruido, el hilo de cada cámara no.
    if (actual == null || actual.hilo !== hilo || contexto != contextoDeLaGpu) {
      actual?.soltar()
      val nuevo = RetocadorGpu(hilo)
      retocador = nuevo
      contextoDeLaGpu = contexto
      // Si `stop()` llegó mientras tanto, este no lo vería: se suelta aquí.
      if (detenido) {
        retocador = null
        nuevo.soltar()
        return null
      }
    }
    return textura
  }

  /** El SDK suelta lo que recibe después de enviarlo: se retiene antes. */
  private fun pasarTalCual(entrada: VideoFrame, destino: HMSPluginResultListener) {
    entrada.retain()
    destino.onOutputResult(entrada)
  }

  /**
   * El SDK lo llama al quitar el complemento, desde su hilo. Lo de la GPU se
   * suelta en el hilo de la cámara, que es donde vive (o, si esa cámara ya no
   * existe, desde la próxima: ver `RetocadorGpu.soltar`).
   */
  override fun stop() {
    detenido = true
    val actual = retocador
    retocador = null
    contextoDeLaGpu = null
    actual?.soltar()
  }

  internal companion object {
    /** Único entre los complementos de la sala: el SDK los guarda por nombre. */
    const val NOMBRE = "zeta-mejorar"
    private const val ETIQUETA = "MejorasDeVideo"
  }
}
