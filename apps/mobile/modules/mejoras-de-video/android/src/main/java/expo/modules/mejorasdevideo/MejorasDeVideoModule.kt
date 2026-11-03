package expo.modules.mejorasdevideo

import com.reactnativehmssdk.HMSManager
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.atomic.AtomicBoolean
import live.hms.video.error.HMSException
import live.hms.video.sdk.HMSActionResultListener
import live.hms.video.sdk.HMSSDK

/**
 * «Mejorar» del directo en Android: un complemento de video propio
 * ([FiltroDeMejoras]) sobre la cámara de quien emite, que retoca en la GPU.
 *
 * POR QUÉ HACE FALTA ESTE MÓDULO. El paquete de React Native de 100ms no deja
 * poner complementos de video desde JavaScript, salvo el fondo virtual. Esto
 * es el puente, y nada más.
 *
 * LA MISMA SALA. El complemento se engancha a la instancia de `HMSSDK` que ya
 * está emitiendo, la que el puente de 100ms guarda en `HMSManager.hmsCollection`
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
 *   aparezca un efecto que nadie pidió.
 * - **`addPlugin` ya llama a `init()`** del complemento: no se llama a mano.
 * - **Los fps de `addPlugin` no frenan nada**: el SDK los anota pero no los usa.
 *   Al complemento le llega cada fotograma de la cámara.
 * - **El filtro de 100ms (`HMSVideoFilter`) no sirve en directo**: se quedaba
 *   segundos atrás y devolvía la imagen en espejo. Ver [FiltroDeMejoras].
 */
class MejorasDeVideoModule : Module() {
  /** El filtro de ahora y la instancia del SDK a la que está enganchado. */
  @Volatile private var filtro: FiltroDeMejoras? = null
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
    val actual = filtro.takeIf { sdkDelFiltro === sdk } ?: FiltroDeMejoras()
    filtro = actual
    sdkDelFiltro = sdk
    // Al encender nace todo en 0, también si se reutiliza: JavaScript solo
    // manda después lo que no está en 0 (`ajusteDeAndroid`).
    actual.ajustes = Ajustes()

    // `getPlugins()` puede devolver `null` (sin pista todavía): sin lista, ninguno.
    val puestos = sdk.getPlugins().orEmpty()
    if (puestos.any { it === actual }) {
      // Puesto, pero si la GPU falló sigue sin efecto: que JavaScript lo sepa.
      if (actual.averiado) {
        promise.reject("averiado", "El retoque de la cámara falló en este teléfono.", null)
      } else {
        promise.resolve(true)
      }
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
    // `false`: no hay filtro, o la GPU falló y no hace nada. JavaScript lo
    // apaga y lo dice; no se finge que se está aplicando.
    val actual = filtro ?: return false
    if (actual.averiado) return false
    // `null` = ese ajuste se queda como está.
    val antes = actual.ajustes
    actual.ajustes = Ajustes(
      suavidad = suavidad?.let(::deCeroAUno) ?: antes.suavidad,
      luz = brillo?.let(::deCeroAUno) ?: antes.luz,
      contraste = contraste?.let(::deCeroAUno) ?: antes.contraste,
      nitidez = nitidez?.let(::deCeroAUno) ?: antes.nitidez,
      rubor = rubor?.let(::deCeroAUno) ?: antes.rubor,
    )
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

  private fun olvidar(quitado: FiltroDeMejoras) {
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

  /** De 0 (sin efecto) a 1; lo que no es un número, sin efecto. */
  private fun deCeroAUno(valor: Double): Float =
    if (valor.isNaN()) 0f else valor.coerceIn(0.0, 1.0).toFloat()

  private companion object {
    /**
     * Lo que se le declara al SDK. Solo lo anota (2.9.84 no frena nada con
     * él): el complemento retoca todos los fotogramas de la cámara.
     */
    const val FOTOGRAMAS_POR_SEGUNDO = 30
  }
}
