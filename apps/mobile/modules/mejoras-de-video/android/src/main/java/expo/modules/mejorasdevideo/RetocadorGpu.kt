package expo.modules.mejorasdevideo

import android.graphics.Matrix
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.os.Handler
import hms.webrtc.GlShader
import hms.webrtc.GlTextureFrameBuffer
import hms.webrtc.GlUtil
import hms.webrtc.RendererCommon
import hms.webrtc.TextureBufferImpl
import hms.webrtc.VideoFrame
import hms.webrtc.YuvConverter
import java.nio.FloatBuffer

/**
 * Los cinco ajustes de «Mejorar», de 0 (sin efecto) a 1. Qué es cada uno lo
 * dice [RetocadorGpu]; cuánto llega a valer cada barra al 100, `ESCALA_ANDROID`
 * en `src/live/mejorasDeVideo.ts`.
 */
internal data class Ajustes(
  val suavidad: Float = 0f,
  val luz: Float = 0f,
  val contraste: Float = 0f,
  val nitidez: Float = 0f,
  val rubor: Float = 0f,
) {
  val neutros: Boolean
    get() = suavidad <= 0f && luz <= 0f && contraste <= 0f && nitidez <= 0f && rubor <= 0f
}

/**
 * Retoca un fotograma de la cámara en la GPU, sin sacarlo de ella.
 *
 * DOS PASADAS, TEXTURA A TEXTURA. La cámara entrega una textura (OES) con su
 * matriz. La primera pasada la copia a una textura normal ([base]) aplicando
 * la matriz, como haría cualquier pantalla al pintarla. La segunda lee esa
 * copia y escribe el retoque en una textura de salida, que se entrega tal cual
 * (matriz identidad, mismo giro que la cámara). No hay mapas de bits ni viajes
 * a la memoria del teléfono: ~2 pasadas a 720p, unos milisegundos.
 *
 * EL RETOQUE (en [RETOQUE]):
 * - **Suavidad**: un desenfoque que respeta los bordes (cada vecino pesa menos
 *   cuanto más distinto es su color) y SOLO sobre lo que parece piel, por su
 *   color en YCbCr. El fondo, los ojos y el pelo quedan como estaban.
 * - **Luz**: una curva (gamma) que aclara las sombras y los medios sin quemar
 *   los blancos: el negro y el blanco no se mueven.
 * - **Contraste**: ×(1 + contraste) alrededor del gris medio.
 * - **Nitidez**: máscara de enfoque con los 4 vecinos (la de GPUImage: con
 *   nitidez 1, el píxel + 4 × su diferencia con ellos). Menos sobre la piel
 *   que se está suavizando, para no deshacerlo.
 * - **Rubor**: el rojo ×(1 + rubor), solo sobre la piel.
 *
 * TODO EN EL HILO DE LA CÁMARA. Cada método se llama en el hilo del
 * `SurfaceTextureHelper` que entrega los fotogramas, con su contexto de GPU
 * puesto. Ahí viven las texturas, y desde ahí las leen el codificador y la
 * vista (comparten contexto). Fuera de ese hilo no se toca nada.
 */
internal class RetocadorGpu {
  private var copiaOes: Programa? = null
  private var copiaRgb: Programa? = null
  private var retoque: Programa? = null
  private var base: GlTextureFrameBuffer? = null

  /** Texturas de salida libres para reutilizar. Solo se tocan en este hilo. */
  private val libres = ArrayDeque<GlTextureFrameBuffer>()
  private var creadas = 0

  /**
   * Sube cada vez que se sueltan los recursos: una textura de salida que
   * vuelve de una generación anterior se borra en vez de reutilizarse.
   * Volátil: si la cámara se volvió a crear, las de antes vuelven por el hilo
   * de antes.
   */
  @Volatile private var generacion = 0

  /**
   * Retoca [entrada] y devuelve el fotograma de salida, o `null` si todas las
   * texturas de salida siguen en uso (ese fotograma se pierde: mejor uno menos
   * que uno sin retocar).
   *
   * La salida es de quien la recibe: se suelta con `release()` como cualquier
   * fotograma, y entonces su textura vuelve aquí por [hilo].
   */
  fun retocar(
    entrada: TextureBufferImpl,
    giro: Int,
    marcaDeTiempoNs: Long,
    ajustes: Ajustes,
    hilo: Handler,
    convertidor: YuvConverter,
  ): VideoFrame? {
    val ancho = entrada.width
    val alto = entrada.height
    val salida = sacarTextura(ancho, alto) ?: return null
    val base = base ?: GlTextureFrameBuffer(GLES20.GL_RGBA).also { base = it }
    base.setSize(ancho, alto)

    // 1. La cámara, con su matriz, a una textura normal.
    val matriz = RendererCommon.convertMatrixFromAndroidGraphicsMatrix(entrada.transformMatrix)
    if (entrada.type == VideoFrame.TextureBuffer.Type.OES) {
      val copia = copiaOes ?: Programa(VERTICES, COPIA_OES).also { copiaOes = it }
      copia.pintar(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, entrada.textureId, matriz, base)
    } else {
      val copia = copiaRgb ?: Programa(VERTICES, COPIA_RGB).also { copiaRgb = it }
      copia.pintar(GLES20.GL_TEXTURE_2D, entrada.textureId, matriz, base)
    }

    // 2. El retoque, de la copia a la salida.
    val retoque = retoque ?: Programa(VERTICES, RETOQUE).also { retoque = it }
    retoque.pintar(GLES20.GL_TEXTURE_2D, base.textureId, IDENTIDAD, salida) { programa ->
      GLES20.glUniform2f(programa.uniforme("paso"), 1f / ancho, 1f / alto)
      GLES20.glUniform1f(programa.uniforme("radio"), radioDePiel(ancho, alto))
      GLES20.glUniform1f(programa.uniforme("suavidad"), ajustes.suavidad)
      GLES20.glUniform1f(programa.uniforme("luz"), ajustes.luz)
      GLES20.glUniform1f(programa.uniforme("contraste"), ajustes.contraste)
      GLES20.glUniform1f(programa.uniforme("nitidez"), ajustes.nitidez)
      GLES20.glUniform1f(programa.uniforme("rubor"), ajustes.rubor)
    }
    GlUtil.checkNoGLES2Error("RetocadorGpu.retocar")
    // El codificador y la vista la leen desde OTROS contextos: tiene que estar
    // terminada antes de soltarla.
    GLES20.glFinish()

    val generacionDeLaTextura = generacion
    val buffer = TextureBufferImpl(
      ancho,
      alto,
      VideoFrame.TextureBuffer.Type.RGB,
      salida.textureId,
      Matrix(),
      hilo,
      convertidor,
      Runnable { hilo.post { devolver(salida, generacionDeLaTextura) } },
    )
    return VideoFrame(buffer, giro, marcaDeTiempoNs)
  }

  /**
   * Suelta todo lo que es de la GPU. Lo que esté todavía en uso (salidas que
   * el codificador no ha soltado) se borra cuando vuelva. Después se puede
   * seguir usando: vuelve a crear lo que necesite.
   */
  fun liberar() {
    generacion++
    copiaOes?.liberar()
    copiaRgb?.liberar()
    retoque?.liberar()
    base?.release()
    copiaOes = null
    copiaRgb = null
    retoque = null
    base = null
    while (libres.isNotEmpty()) libres.removeFirst().release()
    creadas = 0
  }

  /**
   * Olvida los recursos SIN borrarlos: son de otro contexto de GPU (la cámara
   * se volvió a crear) y borrarlos desde este borraría lo que no es. Mueren
   * con su contexto.
   */
  fun abandonar() {
    generacion++
    copiaOes = null
    copiaRgb = null
    retoque = null
    base = null
    libres.clear()
    creadas = 0
  }

  private fun sacarTextura(ancho: Int, alto: Int): GlTextureFrameBuffer? {
    val textura = libres.removeFirstOrNull()
      ?: if (creadas < MAXIMO_EN_USO) GlTextureFrameBuffer(GLES20.GL_RGBA).also { creadas++ } else return null
    textura.setSize(ancho, alto)
    return textura
  }

  private fun devolver(textura: GlTextureFrameBuffer, deLaGeneracion: Int) {
    if (deLaGeneracion == generacion) libres.addLast(textura) else textura.release()
  }

  /** Un programa de GPU con su forma de pintar un rectángulo entero. */
  private class Programa(vertices: String, fragmentos: String) {
    private val shader = GlShader(vertices, fragmentos)
    private val uniformes = HashMap<String, Int>()

    /** -1 si el compilador la quitó por no usarse: entonces `glUniform` no hace nada. */
    fun uniforme(nombre: String): Int =
      uniformes.getOrPut(nombre) { runCatching { shader.getUniformLocation(nombre) }.getOrDefault(-1) }

    fun pintar(
      tipoDeTextura: Int,
      textura: Int,
      matriz: FloatArray,
      destino: GlTextureFrameBuffer,
      extra: (Programa) -> Unit = {},
    ) {
      GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, destino.frameBufferId)
      GLES20.glViewport(0, 0, destino.width, destino.height)
      shader.useProgram()
      GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
      GLES20.glBindTexture(tipoDeTextura, textura)
      GLES20.glUniform1i(uniforme("tex"), 0)
      GLES20.glUniformMatrix4fv(uniforme("tex_matrix"), 1, false, matriz, 0)
      extra(this)
      shader.setVertexAttribArray("in_pos", 2, RECTANGULO)
      shader.setVertexAttribArray("in_tc", 2, COORDENADAS)
      GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
      GLES20.glDisableVertexAttribArray(shader.getAttribLocation("in_pos"))
      GLES20.glDisableVertexAttribArray(shader.getAttribLocation("in_tc"))
      GLES20.glBindTexture(tipoDeTextura, 0)
      GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
    }

    fun liberar() = shader.release()
  }

  internal companion object {
    /**
     * Cuántas salidas puede haber a la vez en manos del codificador y de la
     * vista. Si se agotan, se pierde un fotograma: no se crean sin fin.
     */
    const val MAXIMO_EN_USO = 8

    /**
     * El radio de la piel suave, en píxeles: 2 a 720p (anillos a 2, 4 y 6
     * píxeles), proporcional a la resolución y nunca menos de 1.
     */
    fun radioDePiel(ancho: Int, alto: Int): Float = maxOf(1f, minOf(ancho, alto) / 360f)

    private val IDENTIDAD = FloatArray(16).also { android.opengl.Matrix.setIdentityM(it, 0) }

    /** El rectángulo entero, y sus coordenadas de textura: las de WebRTC. */
    private val RECTANGULO: FloatBuffer =
      GlUtil.createFloatBuffer(floatArrayOf(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f))
    private val COORDENADAS: FloatBuffer =
      GlUtil.createFloatBuffer(floatArrayOf(0f, 0f, 1f, 0f, 0f, 1f, 1f, 1f))

    /** Igual que el de WebRTC: la matriz de la textura, aplicada a cada esquina. */
    const val VERTICES = """
attribute vec4 in_pos;
attribute vec4 in_tc;
uniform mat4 tex_matrix;
varying vec2 tc;
void main() {
  gl_Position = in_pos;
  tc = (tex_matrix * in_tc).xy;
}
"""

    private const val PRECISION = """
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
"""

    const val COPIA_OES = """#extension GL_OES_EGL_image_external : require
$PRECISION
varying vec2 tc;
uniform samplerExternalOES tex;
void main() {
  gl_FragColor = vec4(texture2D(tex, tc).rgb, 1.0);
}
"""

    const val COPIA_RGB = """$PRECISION
varying vec2 tc;
uniform sampler2D tex;
void main() {
  gl_FragColor = vec4(texture2D(tex, tc).rgb, 1.0);
}
"""

    /**
     * Los 18 vecinos de la piel suave: tres anillos de 6 (a 1, 2 y 3 veces el
     * radio), girados entre sí para cubrir el círculo. Desenrollados: algunos
     * teléfonos no aceptan bucles con índices en los programas de GPU.
     */
    private val VECINOS_DE_PIEL: String = buildString {
      for (anillo in 1..3) {
        for (i in 0 until 6) {
          val giro = when (anillo) {
            1 -> 0.0
            2 -> 30.0
            else -> 15.0
          }
          val angulo = Math.toRadians(60.0 * i + giro)
          val x = "%.4f".format(java.util.Locale.ROOT, anillo * Math.cos(angulo))
          val y = "%.4f".format(java.util.Locale.ROOT, anillo * Math.sin(angulo))
          append("    vecino(vec2($x, $y));\n")
        }
      }
    }

    val RETOQUE = """$PRECISION
varying vec2 tc;
uniform sampler2D tex;
uniform vec2 paso;
uniform float radio;
uniform float suavidad;
uniform float luz;
uniform float contraste;
uniform float nitidez;
uniform float rubor;

const vec3 LUMA = vec3(0.299, 0.587, 0.114);

vec3 original;
vec3 suma;
float pesos;

// Cuánto parece piel (0 a 1): su color en YCbCr cerca del de la piel, y no
// demasiado oscuro.
float piel(vec3 c) {
  float cb = dot(c, vec3(-0.168736, -0.331264, 0.5)) + 0.5;
  float cr = dot(c, vec3(0.5, -0.418688, -0.081312)) + 0.5;
  float d = length(vec2((cb - 0.41) / 0.09, (cr - 0.59) / 0.07));
  return (1.0 - smoothstep(0.7, 1.3, d)) * smoothstep(0.08, 0.2, dot(c, LUMA));
}

// Un vecino de la piel suave: pesa menos cuanto más distinto es su color, así
// los bordes (ojos, labios, pelo) no se emborronan.
void vecino(vec2 donde) {
  vec3 m = texture2D(tex, tc + donde * radio * paso).rgb;
  vec3 d = m - original;
  float w = exp(-50.0 * dot(d, d));
  suma += m * w;
  pesos += w;
}

void main() {
  original = texture2D(tex, tc).rgb;
  vec3 c = original;
  float esPiel = (suavidad > 0.0 || rubor > 0.0) ? piel(original) : 0.0;
  float suavizado = suavidad * esPiel;

  if (suavizado > 0.0) {
    suma = original;
    pesos = 1.0;
$VECINOS_DE_PIEL    c = mix(original, suma / pesos, suavizado);
  }

  if (nitidez > 0.0) {
    vec3 vecinos = (texture2D(tex, tc + vec2(paso.x, 0.0)).rgb
      + texture2D(tex, tc - vec2(paso.x, 0.0)).rgb
      + texture2D(tex, tc + vec2(0.0, paso.y)).rgb
      + texture2D(tex, tc - vec2(0.0, paso.y)).rgb) * 0.25;
    c += 4.0 * nitidez * (1.0 - suavizado) * (original - vecinos);
  }

  c.r *= 1.0 + rubor * esPiel;
  c = pow(clamp(c, 0.0, 1.0), vec3(1.0 / (1.0 + luz)));
  c = (c - 0.5) * (1.0 + contraste) + 0.5;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
"""
  }
}
