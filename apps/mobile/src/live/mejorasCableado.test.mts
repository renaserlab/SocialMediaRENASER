import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * QUE «MEJORAR» USE LO QUE ESTÁ PROBADO, Y QUE NO ROMPA NADA DONDE NO EXISTE.
 *
 * Las reglas se EJECUTAN en `mejorasDeVideo.test.mts`. Lo que no corre con
 * `node --test` es la hoja (React Native), el adaptador de 100ms y el módulo
 * nativo (Kotlin): esto mira su CÓDIGO FUENTE. Cada comprobación nombra el
 * defecto que dejaría pasar si desapareciera.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');
const MOVIL = join(SRC, '..');
const MODULO = join(MOVIL, 'modules', 'mejoras-de-video');

function leer(ruta: string): string {
  return readFileSync(ruta, 'utf8').replace(/\r\n/g, '\n');
}

/** Sin comentarios: lo que se comprueba es lo que se EJECUTA. */
function sinComentarios(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const HOJA = sinComentarios(leer(join(SRC, 'components/live/HojaDeEfectos.tsx')));
const PANTALLA = sinComentarios(leer(join(SRC, 'screens/LiveScreen.tsx')));
const HOOK = sinComentarios(leer(join(SRC, 'hooks/useSesionDeDirecto.ts')));
const ADAPTADOR = sinComentarios(leer(join(SRC, 'live/salaDeVideo100ms.ts')));
const FALSA = sinComentarios(leer(join(SRC, 'live/salaDeVideo.ts')));
const TOKENS = leer(join(SRC, 'theme/tokens.ts'));
const KOTLIN = sinComentarios(
  leer(join(MODULO, 'android/src/main/java/expo/modules/mejorasdevideo/MejorasDeVideoModule.kt')),
);
const COMPLEMENTO = sinComentarios(
  leer(join(MODULO, 'android/src/main/java/expo/modules/mejorasdevideo/FiltroDeMejoras.kt')),
);
const RETOCADOR = sinComentarios(
  leer(join(MODULO, 'android/src/main/java/expo/modules/mejorasdevideo/RetocadorGpu.kt')),
);
const GRADLE = sinComentarios(leer(join(MODULO, 'android/build.gradle')));
const CONFIG = JSON.parse(leer(join(MODULO, 'expo-module.config.json'))) as {
  platforms: string[];
  android: { modules: string[] };
};

describe('la hoja de efectos', () => {
  it('«Mejorar» solo aparece donde la sala dice que lo hay', () => {
    // Sin esto saldrían las barras en iOS, en web o en un binario viejo, y
    // moverlas no haría nada.
    assert.match(HOJA, /const conMejorar = mejoras\.capacidad\.admitida;/);
    assert.match(HOJA, /\{conMejorar \? \(\s*<SeccionMejorar/);
    assert.match(HOJA, /\{conMejorar \? \(\s*<Pressable/, 'el ojo, solo con «Mejorar»');
  });

  it('sin fondos ni «Mejorar» (web, Expo Go) explica por qué, como antes', () => {
    assert.match(HOJA, /\{!conMejorar && !conFondo \? \(/);
    assert.match(HOJA, /t\(EXPLICACION\[capacidad\.motivo \?\? 'sin_proveedor'\]\)/);
  });

  it('la barra manda como mucho un valor cada 100 ms, y el último al soltar (lo probado)', () => {
    assert.match(HOJA, /crearLimitador<ValoresDeMejora>\(\{\s*intervaloMs: INTERVALO_DE_ENVIO_MS,/);
    assert.match(HOJA, /limitador\.current\?\.empujar\(/);
    const soltar = HOJA.slice(HOJA.indexOf('const soltar = () =>'), HOJA.indexOf('const ponerEnCero'));
    assert.match(soltar, /limitador\.current\?\.soltar\(\)/);
    // Cerrar la hoja a mitad de un arrastre no pierde lo último.
    assert.match(HOJA, /if \(!visible\) limitador\.current\?\.soltar\(\);/);
    // Y nadie llama a la sala directamente desde el arrastre.
    const mover = HOJA.slice(HOJA.indexOf('const mover = (valor: number) =>'), HOJA.indexOf('const soltar = () =>'));
    assert.doesNotMatch(mover, /cambiar\(/);
  });

  it('imán en 0 y 50 (lo probado), doble toque a 0 y Restablecer a todo 0', () => {
    assert.match(HOJA, /conIman\(/);
    assert.match(HOJA, /avisos\.current\.alDobleToque\(\)/);
    assert.match(HOJA, /cambiar\(\{ \.\.\.valores, \[elegida\]: 0 \}\)/);
    assert.match(HOJA, /cambiar\(valoresEnCero\(\)\)/);
  });

  it('el ojo compara MIENTRAS se mantiene, y se suelta también al cerrar', () => {
    assert.match(HOJA, /onPressIn=\{\(\) => \{[\s\S]*?comparar\.current\(true\);/);
    assert.match(HOJA, /onPressOut=\{soltarOjo\}/);
    const alCerrar = HOJA.slice(HOJA.indexOf('if ((visible && puedeComparar) || !apretado) return;'));
    assert.ok(alCerrar.length > 0);
    assert.match(alCerrar.slice(0, 200), /comparar\.current\(false\);/);
  });

  it('con un fondo puesto, «Mejorar» dice que está apagado y esconde las barras', () => {
    assert.match(HOJA, /\{estado\.bloqueada \? \([\s\S]*?live\.enhanceBlocked/);
    assert.match(HOJA, /const apagada = estado\.bloqueada \|\| estado\.averiada;/);
  });

  it('dos desenfoques solo donde la sala los ofrece (Android); uno en iOS', () => {
    assert.match(HOJA, /capacidad\.dosDesenfoques \? \(/);
    assert.match(HOJA, /\{ tipo: 'desenfoque', fuerza: 'suave' \}/);
    assert.match(HOJA, /\{ tipo: 'desenfoque', fuerza: 'fuerte' \}/);
  });

  it('no importa el SDK ni el módulo nativo: pinta y avisa', () => {
    assert.doesNotMatch(HOJA, /@100mslive|requireOptionalNativeModule|MejorasDeVideo|NativeModules/);
  });

  it('velo transparente y todos los colores de los tokens', () => {
    assert.match(HOJA, /backgroundColor: tinta\.velo/);
    assert.match(TOKENS, /export const efectosDeCamara = \{\s*velo: 'transparent',/);
    const literales = [...leer(join(SRC, 'components/live/HojaDeEfectos.tsx')).matchAll(/#[0-9A-Fa-f]{3,8}\b|rgba?\(/g)];
    assert.deepEqual(literales.map((m) => m[0]), []);
  });
});

describe('la pantalla de la transmisión', () => {
  it('le pasa «Mejorar» a la hoja y aparta el chat y los botones con ella abierta', () => {
    assert.match(PANTALLA, /mejoras=\{mejoras\}/);
    assert.match(PANTALLA, /toValue: hojaDeEfectos \? 0 : 1,/);
    assert.match(PANTALLA, /style=\{\[estilos\.filaInferior, conLaHoja\]\}/);
    assert.match(PANTALLA, /<Animated\.View style=\{conLaHoja\}[^>]*>\s*<TemaDeDirecto/);
  });

  it('avisa una vez si al empezar hay «Mejorar» recordado', () => {
    assert.match(PANTALLA, /if \(avisoDeMejorasDado\.current\) return;/);
    assert.match(PANTALLA, /!mejoras\.recordadas \|\| !mejoras\.capacidad\.admitida/);
    assert.match(PANTALLA, /live\.enhanceRemembered/);
  });

  it('el punto del botón de efectos cuenta «Mejorar» solo si se está aplicando, y solo donde existe', () => {
    // Un binario viejo recuerda los valores pero no tiene el filtro: sin la
    // capacidad, el punto diría «hay efectos» sobre una cámara sin ninguno.
    assert.match(
      PANTALLA,
      /efectoPuesto=\{\s*efectos\.estado\.efecto\.tipo !== 'ninguno' \|\|\s*\(mejoras\.capacidad\.admitida && mejoraPuesta\(mejoras\.estado\)\)\s*\}/,
    );
  });
});

describe('lo que se recuerda y lo que se dice', () => {
  it('se escribe SOLO después de haber leído: los ceros de la sala no pisan lo guardado', () => {
    const escribir = HOOK.slice(HOOK.indexOf('const leido = leidas.current;'));
    assert.match(escribir.slice(0, 120), /if \(!leido \|\| mismosValores\(leido\.valores, mejoras\.valores\)\) return;/);
    assert.match(HOOK, /guardarMejoras\(crudo, leido\.cuenta, valores\)/);
    assert.match(HOOK, /mejorasGuardadas\(crudo, cuenta\)/);
    assert.match(HOOK, /CLAVE_DE_MEJORAS/);
  });

  it('si «Mejorar» se apaga solo, se avisa aunque la hoja esté cerrada', () => {
    assert.match(HOOK, /if \(evento\.estado\.averiada && !mejoraAveriada\.current\) \{/);
    assert.match(HOOK, /live\.enhanceTurnedOff/);
  });

  it('la sala falsa (web, pruebas) no ofrece «Mejorar» y no hace nada', () => {
    const mejoras = FALSA.slice(FALSA.indexOf('mejoras() {'), FALSA.indexOf('calidad() {'));
    assert.match(mejoras, /return \{ admitida: false \};/);
  });
});

describe('el adaptador de 100ms', () => {
  it('busca el módulo propio de forma opcional y solo en Android', () => {
    const buscar = ADAPTADOR.slice(ADAPTADOR.indexOf('function moduloDeMejoras()'));
    assert.match(buscar.slice(0, 400), /if \(Platform\.OS !== 'android'\) return null;/);
    assert.match(buscar.slice(0, 400), /requireOptionalNativeModule<ModuloNativoDeMejoras>\('MejorasDeVideo'\)/);
    assert.match(buscar.slice(0, 600), /catch \{\s*return null;/);
  });

  it('el fondo se pone con «Mejorar» quitado (nunca los dos complementos a la vez)', () => {
    assert.match(ADAPTADOR, /const verbos = protegerFondoConMejoras\(delSdk, this\.mejorasDeLaSala\);/);
    assert.match(ADAPTADOR, /dosDesenfoques: Platform\.OS === 'android',/);
  });

  it('al salir: cámara apagada, después «Mejorar», después el fondo', () => {
    const soltar = ADAPTADOR.slice(ADAPTADOR.indexOf('private async soltar('));
    const camara = soltar.indexOf('this.silenciarEn(sdk)');
    const mejora = soltar.indexOf('this.mejorasDeLaSala.apagarParaSalir()');
    const fondo = soltar.indexOf('this.efectosDeLaSala?.apagarParaSalir()');
    assert.ok(camara >= 0 && camara < mejora && mejora < fondo);
  });

  it('«Mejorar» se repone después del fondo al volver a entrar, y solo publicando', () => {
    assert.match(ADAPTADOR, /void this\.reponerEfecto\(this\.efectosDeLaSala\)\.finally\(\(\) => this\.estrenarMejoras\(\)\);/);
    assert.match(ADAPTADOR, /if \(this\.destruida \|\| !this\.sdk \|\| !this\.estado\.publicando\) return;/);
  });

  it('el filtro va a la instancia de AHORA: el id se lee en cada llamada', () => {
    assert.match(ADAPTADOR, /const id = this\.sdk\?\.id;/);
    assert.match(ADAPTADOR, /ajusteDeAndroid\(valores, tocados\)/);
  });
});

describe('el módulo nativo', () => {
  it('solo existe en Android: iOS no lo compila ni lo enlaza', () => {
    assert.deepEqual(CONFIG.platforms, ['android']);
    assert.deepEqual(CONFIG.android.modules, ['expo.modules.mejorasdevideo.MejorasDeVideoModule']);
  });

  it('se llama como lo busca JavaScript', () => {
    assert.match(KOTLIN, /Name\("MejorasDeVideo"\)/);
    for (const verbo of ['encender', 'ajustar', 'apagar']) {
      assert.match(KOTLIN, new RegExp(`AsyncFunction\\("${verbo}"\\)`));
    }
  });

  it('comprueba la pista ANTES de addPlugin (sin ella el SDK lo dejaría pendiente)', () => {
    const encender = KOTLIN.slice(KOTLIN.indexOf('private fun encender('));
    const pista = encender.indexOf('videoTrack == null');
    const otro = encender.indexOf('"otro_complemento"');
    const anadir = encender.indexOf('sdk.addPlugin(');
    assert.ok(pista >= 0 && pista < otro && otro < anadir, 'orden: pista, otro complemento, addPlugin');
  });

  it('la lista de complementos del SDK puede ser null: siempre con `.orEmpty()`', () => {
    // Así falló la primera compilación en EAS (02/11/2026): `getPlugins()` es
    // `List<HMSVideoPlugin>?` y llamarla sin más no compila.
    assert.doesNotMatch(KOTLIN, /getPlugins\(\)\.(?!orEmpty\(\))/);
  });

  it('no llama a init() a mano: addPlugin ya lo hace, y otra vez crearía otro hilo', () => {
    assert.doesNotMatch(KOTLIN, /\.init\(/);
    // El SDK solo los anota: el complemento retoca todos los de la cámara.
    assert.match(KOTLIN, /FOTOGRAMAS_POR_SEGUNDO = 30/);
  });

  it('«Mejorar» es un complemento propio: el filtro de 100ms no se usa', () => {
    // HMSVideoFilter se quedaba segundos atrás y devolvía la imagen en espejo
    // (03/11/2026): se sustituyó por uno que retoca en la GPU.
    assert.match(KOTLIN, /\?: FiltroDeMejoras\(\)/);
    assert.match(KOTLIN, /private var filtro: FiltroDeMejoras\? = null/);
    assert.match(KOTLIN, /sdk\.addPlugin\(actual, /);
    for (const fuente of [KOTLIN, COMPLEMENTO, RETOCADOR, GRADLE]) {
      assert.doesNotMatch(fuente, /HMSVideoFilter|videofilters|video-filters|gpuimage/i);
    }
    assert.match(COMPLEMENTO, /override fun getPluginType\(\): HMSVideoPluginType = HMSVideoPluginType\.TRANSFORM/);
    assert.match(COMPLEMENTO, /const val NOMBRE = "zeta-mejorar"/);
  });

  it('nunca deja la cámara sin imagen: si no se puede retocar, pasa tal cual', () => {
    // Solo en el hilo de la textura y con un contexto de GPU puesto.
    assert.match(COMPLEMENTO, /if \(hilo\.looper != Looper\.myLooper\(\)\) return null/);
    assert.match(COMPLEMENTO, /contexto == EGL14\.EGL_NO_CONTEXT\) return null/);
    assert.match(COMPLEMENTO, /entrada\.buffer as\? TextureBufferImpl \?: return null/);
    // Tal cual = retenido antes, porque el SDK suelta lo que recibe.
    assert.match(COMPLEMENTO, /entrada\.retain\(\)\s*destino\.onOutputResult\(entrada\)/);
    // Si la GPU falla: se avisa, queda sin efecto y la imagen sigue.
    assert.match(
      COMPLEMENTO,
      /catch \(fallo: Throwable\) \{[\s\S]*?averiado = true[\s\S]*?return pasarTalCual\(input, destino\)/,
    );
    // En neutro, ni se toca la GPU.
    assert.match(COMPLEMENTO, /if \(averiado \|\| ajustes\.neutros\) return null/);
  });

  it('la salida es la cámara retocada, sin espejo ni vuelta: la matriz de la cámara una vez', () => {
    // El mismo vértice que WebRTC: la matriz de la textura sobre el rectángulo entero.
    assert.match(RETOCADOR, /tc = \(tex_matrix \* in_tc\)\.xy;/);
    assert.match(RETOCADOR, /floatArrayOf\(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f\)/);
    assert.match(RETOCADOR, /floatArrayOf\(0f, 0f, 1f, 0f, 0f, 1f, 1f, 1f\)/);
    assert.match(RETOCADOR, /convertMatrixFromAndroidGraphicsMatrix\(entrada\.transformMatrix\)/);
    // La segunda pasada y la salida, sin matriz: identidad.
    assert.match(RETOCADOR, /retoque\.pintar\(GLES20\.GL_TEXTURE_2D, base\.textureId, IDENTIDAD, salida\)/);
    assert.match(RETOCADOR, /VideoFrame\.TextureBuffer\.Type\.RGB,\s*salida\.textureId,\s*Matrix\(\),/);
    assert.match(RETOCADOR, /return VideoFrame\(buffer, giro, marcaDeTiempoNs\)/);
    assert.doesNotMatch(RETOCADOR, /1\.0 - tc|postScale|preScale|setRotate/);
  });

  it('cada salida vuelve a su hilo al soltarse; terminada antes de entregarla', () => {
    assert.match(RETOCADOR, /GLES20\.glFinish\(\)[\s\S]*?TextureBufferImpl\(/);
    assert.match(RETOCADOR, /Runnable \{ hilo\.post \{ devolver\(salida, generacionDeLaTextura\) \} \}/);
    assert.match(RETOCADOR, /const val MAXIMO_EN_USO = 8/);
    // stop() suelta la GPU en el hilo de la cámara, y solo en su contexto.
    assert.match(COMPLEMENTO, /override fun stop\(\) \{\s*hiloDeLaGpu\?\.post \{/);
    assert.match(COMPLEMENTO, /EGL14\.eglGetCurrentContext\(\) == contextoDeLaGpu/);
  });

  it('el SDK y react-native-hms van en la MISMA versión de 100ms', () => {
    const versiones = [...GRADLE.matchAll(/'live\.100ms:([a-z-]+):([0-9.]+)'/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(versiones.map((v) => v[0]), ['android-sdk']);
    const requerir = createRequire(import.meta.url);
    const hms = dirname(requerir.resolve('@100mslive/react-native-hms/package.json'));
    const delPuente = (JSON.parse(leer(join(hms, 'sdk-versions.json'))) as { android: string }).android;
    for (const [, version] of versiones) assert.equal(version, delPuente);
    assert.match(GRADLE, /implementation project\(':100mslive_react-native-hms'\)/);
  });
});
