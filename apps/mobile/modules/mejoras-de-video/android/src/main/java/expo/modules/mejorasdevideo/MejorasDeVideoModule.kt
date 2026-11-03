package expo.modules.mejorasdevideo

import com.reactnativehmssdk.HMSManager
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.atomic.AtomicBoolean
import live.hms.video.error.HMSException
import live.hms.video.sdk.HMSActionResultListener
import live.hms.video.sdk.HMSSDK
import live.hms.videofilters.HMSVideoFilter

/**
 * «Mejorar» del directo en Android: el filtro de video de 100ms
 * (`HMSVideoFilter`) sobre la cámara de quien emite.
 *
 * POR QUÉ HACE FALTA ESTE MÓDULO. El paquete de React Native de 100ms trae el
 * filtro escrito en JavaScript (`HMSVideoFilterPlugin.ts`), pero no lo exporta
 * y su parte nativa no lo implementa: no hay forma de encenderlo desde la
 * aplicación. Esto es el puente, y nada más.
 *
 * LA MISMA SALA. El filtro se engancha a la instancia de `HMSSDK` que ya está
 * emitiendo, la que el puente de 100ms guarda en `HMSManager.hmsCollection`
 * con el identificador que conoce JavaScript (`HMSSDK.id`). No se construye
 * ningún SDK aquí.
 *
 * TRES VERBOS, Y LAS REGLAS EN JAVASCRIPT. Encender, ajustar y apagar. Cuándo
 * se llama a cada uno —una operación a la vez, límite de tiempo, apagarlo con
 * un fondo puesto— lo decide `src/live/mejorasDeVideo.ts`, que se prueba con
 * `node --test`.
 *
 * LO QUE AVERIGUAMOS DEL SDK 2.9.84 (leyendo sus clases):
 *
 * - **No se combina con el fondo virtual.** El SDK pasa EL MISMO fotograma de
 *   la cámara a cada complemento y manda la salida de todos al mismo sitio: no
 *   se encadenan. Con los dos puestos saldría un fotograma con el fondo y otro
 *   con la casa real. Por eso `encender` se niega si hay otro complemento.
 * - **Sin pista de video, `addPlugin` lo deja pendiente** para cuando la haya,
 *   además de contestar con un error. Se comprueba la pista ANTES, para que no
 *   aparezca un filtro que nadie pidió.
 * - **`addPlugin` ya llama a `init()`** del filtro (la guía de 100ms lo llama
 *   también a mano; eso crearía dos hilos). Y los valores que llegan antes de
 *   `init()` se pierden en silencio: JavaScript ajusta DESPUÉS de encender.
 * - **Los ajustes son de 0 a 1** (decimales; la guía dice enteros). El filtro
 *   los guarda como porcentaje entero truncando: por eso `aDecimal` suma una
 *   milésima, para que 0,29 no se quede en 28.
 * - **Devuelve la imagen en espejo.** Por eso nunca se engancha solo: va
 *   dentro de `FiltroAlDerecho`, que la endereza (ver allí el porqué).
 */
class MejorasDeVideoModule : Module() {
  /** El filtro de ahora y la instancia del SDK a la que está enganchado. */
  @Volatile private var filtro: FiltroAlDerecho? = null
  @Volatile private var sdkDelFiltro: HMSSDK? = null

  override fun definition() = ModuleDefinition {
    Name("MejorasDeVideo")

    AsyncFunction("encender") { sdkId: String, promise: Promise ->
      try {
        encender(sdkId, promise)
      } catch (fallo: Throwable) {
        promise.reject("no_se_pudo", fallo.message ?: "No se pudo encender el filtro.", fallo)
      }
    }

    AsyncFunction("ajustar") { brillo: Double?, contraste: Double?, nitidez: Double?, rubor: Double?, suavidad: Double? ->
      ajustar(brillo, contraste, nitidez, rubor, suavidad)
    }

    AsyncFunction("apagar") { promise: Promise ->
      try {
        apagar(promise)
      } catch (fallo: Throwable) {
        promise.reject("no_se_pudo", fallo.message ?: "No se pudo apagar el filtro.", fallo)
      }
    }
  }

  private fun encender(sdkId: String, promise: Promise) {
    val sdk = HMSManager.hmsCollection[sdkId]?.hmsSDK
    if (sdk == null) {
      promise.reject("sin_sala", "No hay una sala con ese identificador.", null)
      return
    }
    if (sdk.getLocalPeer()?.videoTrack == null) {
      promise.reject("sin_pista", "Todavía no hay cámara que filtrar.", null)
      return
    }
    // Una instancia nueva del SDK (se volvió a entrar) pide un filtro nuevo: el
    // de antes lee la cámara de una sala que ya no existe.
    val actual = filtro.takeIf { sdkDelFiltro === sdk } ?: FiltroAlDerecho(HMSVideoFilter(sdk))
    filtro = actual
    sdkDelFiltro = sdk

    // `getPlugins()` puede devolver `null` (sin pista todavía): sin lista, ninguno.
    val puestos = sdk.getPlugins().orEmpty()
    if (puestos.any { it === actual }) {
      promise.resolve(true)
      return
    }
    if (puestos.isNotEmpty()) {
      promise.reject("otro_complemento", "Hay otro efecto de cámara puesto.", null)
      return
    }
    sdk.addPlugin(actual, alTerminar(promise), FOTOGRAMAS_POR_SEGUNDO)
  }

  private fun ajustar(
    brillo: Double?,
    contraste: Double?,
    nitidez: Double?,
    rubor: Double?,
    suavidad: Double?,
  ): Boolean {
    val actual = filtro?.filtro ?: return false
    // `null` = ese filtro no se toca. Llamar a un ajuste mete su filtro en la
    // cadena aunque sea con el valor neutro, y cada uno cuesta una pasada más.
    if (brillo != null) actual.setBrightness(aDecimal(brillo))
    if (contraste != null) actual.setContrast(aDecimal(contraste))
    if (nitidez != null) actual.setSharpness(aDecimal(nitidez))
    if (rubor != null) actual.setRedness(aDecimal(rubor))
    if (suavidad != null) actual.setSmoothness(aDecimal(suavidad))
    return true
  }

  private fun apagar(promise: Promise) {
    val actual = filtro
    val sdk = sdkDelFiltro
    if (actual == null || sdk == null) {
      promise.resolve(true)
      return
    }
    val puesto = sdk.getPlugins().orEmpty().any { it === actual }
    if (!puesto) {
      // No está puesto AHORA. No se olvida: si un `encender` lento lo pone
      // después, el siguiente `apagar` tiene que poder encontrarlo.
      promise.resolve(true)
      return
    }
    val respuesta = AtomicBoolean(false)
    sdk.removePlugin(
      actual,
      object : HMSActionResultListener {
        override fun onSuccess() {
          if (!respuesta.compareAndSet(false, true)) return
          // Quitado: el próximo `encender` estrena filtro.
          olvidar(actual)
          promise.resolve(true)
        }

        override fun onError(error: HMSException) {
          if (!respuesta.compareAndSet(false, true)) return
          // Se conserva para poder volver a intentarlo.
          promise.reject("no_se_pudo", error.message ?: "No se pudo apagar el filtro.", error)
        }
      },
    )
  }

  private fun olvidar(quitado: FiltroAlDerecho) {
    if (filtro === quitado) {
      filtro = null
      sdkDelFiltro = null
    }
  }

  private fun alTerminar(promise: Promise): HMSActionResultListener {
    val respuesta = AtomicBoolean(false)
    return object : HMSActionResultListener {
      override fun onSuccess() {
        if (respuesta.compareAndSet(false, true)) promise.resolve(true)
      }

      override fun onError(error: HMSException) {
        if (respuesta.compareAndSet(false, true)) {
          promise.reject("no_se_pudo", error.message ?: "No se pudo encender el filtro.", error)
        }
      }
    }
  }

  /** De 0 a 1, con una milésima de más: el filtro trunca a porcentaje entero. */
  private fun aDecimal(valor: Double): Float =
    (valor.coerceIn(0.0, 1.0) + 0.001).toFloat().coerceAtMost(1f)

  private companion object {
    /** Lo que recomienda 100ms para este filtro, y lo que usa ya el fondo virtual. */
    const val FOTOGRAMAS_POR_SEGUNDO = 15
  }
}
