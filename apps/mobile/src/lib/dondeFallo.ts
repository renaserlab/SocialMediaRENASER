/**
 * DÓNDE falló, en lo que cabe en una captura de pantalla.
 *
 * La pantalla de «Algo no ha salido bien» enseñaba solo el mensaje del error.
 * Con «Maximum update depth exceeded» eso no dice nada: es el mismo texto falle
 * lo que falle, y el 05/10/2026 dejó una cuenta sin poder entrar y a quien
 * tenía que arreglarlo sin saber por dónde empezar.
 *
 * Aquí se resume lo que React y el motor ya saben —en qué componente, por qué
 * llamadas y en qué pantalla— en unas pocas líneas legibles. No se manda a
 * ningún sitio: se pinta, pequeño, para que quien avise lo haga con la
 * información que hace falta.
 */

/** Cuántos componentes se nombran: el que falló y los que lo contienen. */
const COMPONENTES = 8;
/** Cuántas llamadas del motor se nombran. */
const LLAMADAS = 14;
/** Tope del texto: tiene que caber bajo el botón sin tapar la salida. */
export const TOPE_DEL_DETALLE = 1400;

/**
 * Los envoltorios que no dicen nada de dónde está el fallo: los pone la
 * navegación o React Native alrededor de cualquier pantalla.
 */
const SIN_INTERES =
  /^(View|RCTView|Text|RCTText|ScrollView|RCTScrollView|Pressable|Animated\(.*\)|Unknown|anonymous|Fragment|Suspense|Try|Route|RenderErrorBoundary|ThemeProvider|.*Provider|.*Context|.*Navigator.*|Screen.*|SceneView|StaticContainer|EnsureSingleNavigator|PreventRemoveProvider|NavigationContent|NavigationContainer.*|ContextNavigator|ExpoRoot|App|AppContainer|main|withDevTools.*|FrameSizeProvider.*|GestureHandlerRootView|RNGestureHandlerRootView|SafeArea.*|RNC.*|RNS.*|Freeze|DelayedFreeze|MaybeScreen.*|InnerScreen|Group|Background|CardContainer.*|CardSheet|Card|CardStack|StackView|NativeStack.*|DebugContainer|Layout.*|Slot|.*Inner)$/;

/**
 * El recorrido interno de React al repintar: decenas de líneas iguales en
 * cualquier fallo, que no dicen de quién es. Se quitan para que quepa lo que
 * sí: quién pidió el cambio de estado y desde dónde. Se conservan las tres que
 * dicen QUÉ clase de cambio fue (`dispatchSetState`, `dispatchReducerAction`,
 * `forceStoreRerender`).
 */
const RECORRIDO_DE_REACT =
  /^(recursivelyTraverse\w*|commit\w+|flush\w+|perform\w+|workLoop\w*|beginWork\w*|completeWork\w*|completeUnitOfWork|renderRoot\w*|renderWithHooks\w*|update\w+Component|mount\w+|reconcile\w+|processRootSchedule\w*|scheduleUpdateOnFiber|throwIfInfiniteUpdateLoopDetected|ensureRootIsScheduled|scheduleImmediate\w*|runWithFiberInDEV|safelyCall\w*|callCallback\w*|invokeGuardedCallback\w*|batchedUpdates\w*|flushSync\w*|unstable_\w+|react-stack-\w+|apply|call)$/;

/** El nombre de cada línea de una pila de componentes o de llamadas. */
function nombres(pila: string): string[] {
  const salida: string[] = [];
  for (const linea of pila.split('\n')) {
    // «    at Nombre (direccion)» o «    in Nombre (created by Otro)».
    const encontrado = /^\s*(?:at|in)\s+(?:async\s+)?([^\s(]+)/.exec(linea);
    if (!encontrado?.[1]) continue;
    // Una dirección no es un nombre: en web, una función sin nombre sale así.
    if (encontrado[1].includes('://')) continue;
    // «Object.useSyncExternalStore», «_e.ExploreScreen»: vale lo de después.
    const nombre = encontrado[1].slice(encontrado[1].lastIndexOf('.') + 1);
    // Una o dos letras es lo que deja el empaquetado web al recortar nombres.
    if (nombre.length > 2) salida.push(nombre);
  }
  return salida;
}

/** Sin repetidos seguidos: una lista de veinte filas no son veinte nombres. */
function sinSeguidos(lista: string[]): string[] {
  return lista.filter((nombre, i) => nombre !== lista[i - 1]);
}

/**
 * Los componentes propios que rodean al fallo, de dentro afuera.
 *
 * Si al quitar los envoltorios no queda ninguno se devuelven los primeros tal
 * cual: un nombre poco útil sigue siendo mejor que nada.
 */
export function componentesDelFallo(pilaDeComponentes: string | null | undefined): string[] {
  if (!pilaDeComponentes) return [];
  const todos = sinSeguidos(nombres(pilaDeComponentes));
  // Un componente propio empieza por mayúscula; en minúscula van las piezas
  // de la plataforma (`div`, `span`).
  const propios = todos.filter((nombre) => /^[A-Z]/.test(nombre) && !SIN_INTERES.test(nombre));
  return (propios.length > 0 ? propios : todos).slice(0, COMPONENTES);
}

/** Las llamadas más cercanas al fallo, como las da el motor. */
export function llamadasDelFallo(pila: string | null | undefined): string[] {
  if (!pila) return [];
  return sinSeguidos(
    nombres(pila).filter((nombre) => nombre !== 'anonymous' && !nombre.startsWith('?anon') && !RECORRIDO_DE_REACT.test(nombre)),
  ).slice(0, LLAMADAS);
}

/**
 * El detalle que se pinta bajo el mensaje. Cadena vacía si no hay nada que
 * añadir: la pantalla no enseña entonces ningún bloque de más.
 */
export function detalleDelFallo(datos: {
  pilaDeComponentes?: string | null;
  pila?: string | null;
  ruta?: string | null;
}): string {
  const lineas: string[] = [];
  if (datos.ruta) lineas.push(`Pantalla: ${datos.ruta}`);
  const componentes = componentesDelFallo(datos.pilaDeComponentes);
  if (componentes.length > 0) lineas.push(`En: ${componentes.join(' < ')}`);
  const llamadas = llamadasDelFallo(datos.pila);
  if (llamadas.length > 0) lineas.push(`Por: ${llamadas.join(' < ')}`);
  const texto = lineas.join('\n');
  return texto.length > TOPE_DEL_DETALLE ? `${texto.slice(0, TOPE_DEL_DETALLE - 1)}…` : texto;
}
