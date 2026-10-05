import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  TOPE_DEL_DETALLE,
  componentesDelFallo,
  detalleDelFallo,
  llamadasDelFallo,
} from './dondeFallo.ts';

/*
  El 05/10/2026 una cuenta no pudo entrar: «Maximum update depth exceeded» al
  abrir la aplicación, y en pantalla solo ese mensaje, que es el mismo falle lo
  que falle. Aquí se comprueba que la pantalla del fallo dice DÓNDE.
*/

const PILA_DE_COMPONENTES = `
    at GloboDeNoLeidos (address at index.android.bundle:1:2345)
    at View
    at RCTView
    at Pulsable (address at index.android.bundle:1:999)
    at BarraInferior (address at index.android.bundle:1:1200)
    at SwipeTabs (address at index.android.bundle:1:1500)
    at TabsLayout
    at Route
    at StaticContainer
    at EnsureSingleNavigator
    at SceneView
    at RNSScreen
    at SafeAreaProvider
    at LimiteDeErrores
    at RootLayout
    at ExpoRoot
    at App`;

const PILA = `Error: Maximum update depth exceeded.
    at throwIfInfiniteUpdateLoopDetected (address at index.android.bundle:1:10)
    at scheduleUpdateOnFiber (address at index.android.bundle:1:11)
    at dispatchSetState (address at index.android.bundle:1:12)
    at anonymous (address at index.android.bundle:1:13)
    at commitHookEffectListMount (address at index.android.bundle:1:14)
    at commitHookEffectListMount (address at index.android.bundle:1:14)
    at commitLayoutEffects (address at index.android.bundle:1:15)`;

describe('dónde falló', () => {
  it('nombra los componentes propios, de dentro afuera, sin los envoltorios', () => {
    assert.deepEqual(componentesDelFallo(PILA_DE_COMPONENTES), [
      'GloboDeNoLeidos',
      'Pulsable',
      'BarraInferior',
      'SwipeTabs',
      'TabsLayout',
      'LimiteDeErrores',
      'RootLayout',
    ]);
  });

  it('la forma «in Nombre (created by …)» también se lee', () => {
    assert.deepEqual(componentesDelFallo('\n    in ChatScreen (created by Route)\n    in View'), [
      'ChatScreen',
    ]);
  });

  it('en web: sin direcciones, sin nombres recortados y sin el prefijo del módulo', () => {
    // Así salió al provocar un fallo en la copia web del 05/10/2026.
    const web = `
    at _e.ExploreScreen (http://127.0.0.1:8799/_expo/static/js/web/entry-0b2d.js:900:12)
    at e.Route (http://127.0.0.1:8799/_expo/static/js/web/entry-0b2d.js:233:100)
    at s (http://127.0.0.1:8799/_expo/static/js/web/entry-0b2d.js:233:300)
    at http://127.0.0.1:8799/_expo/static/js/web/entry-0b2d.js:233:458
    at _e.SceneView (http://127.0.0.1:8799/_expo/static/js/web/entry-0b2d.js:240:1)
    at div`;
    assert.deepEqual(componentesDelFallo(web), ['ExploreScreen']);
    assert.deepEqual(
      llamadasDelFallo(`TypeError: x
    at http://127.0.0.1:8799/_expo/static/js/web/entry-0b2d.js:1922:1367
    at Object.useSyncExternalStore (http://127.0.0.1:8799/x.js:1:1)
    at n (http://127.0.0.1:8799/x.js:1:2)
    at _e.ExploreScreen (http://127.0.0.1:8799/x.js:1:3)`),
      ['useSyncExternalStore', 'ExploreScreen'],
    );
  });

  it('si todo son envoltorios, se dan igualmente: algo es mejor que nada', () => {
    assert.deepEqual(componentesDelFallo('\n    at View\n    at RCTView'), ['View', 'RCTView']);
  });

  it('las llamadas, sin anónimas ni repetidas seguidas', () => {
    // Del recorrido de React solo queda qué clase de cambio fue.
    assert.deepEqual(llamadasDelFallo(PILA), ['dispatchSetState']);
  });

  it('sin el recorrido interno de React cabe quién lo pidió y desde dónde', () => {
    // Un aviso de «animación terminada» que llega en mitad de un repintado.
    const pila = `Error: Maximum update depth exceeded.
    at throwIfInfiniteUpdateLoopDetected (address at index.android.bundle:1:10)
    at scheduleUpdateOnFiber (address at index.android.bundle:1:11)
    at dispatchSetState (address at index.android.bundle:1:12)
    at alTerminar (address at index.android.bundle:1:13)
    at anonymous (address at index.android.bundle:1:14)
    at __notifyAnimationEnd (address at index.android.bundle:1:15)
    at stop (address at index.android.bundle:1:16)
    at stopAnimation (address at index.android.bundle:1:17)
    at __detach (address at index.android.bundle:1:18)
    at __removeChild (address at index.android.bundle:1:19)
    at __detach (address at index.android.bundle:1:20)
    at commitHookEffectListUnmount (address at index.android.bundle:1:21)
    at recursivelyTraverseDeletionEffects (address at index.android.bundle:1:22)
    at commitDeletionEffectsOnFiber (address at index.android.bundle:1:23)
    at recursivelyTraverseDeletionEffects (address at index.android.bundle:1:22)
    at commitMutationEffectsOnFiber (address at index.android.bundle:1:24)
    at flushMutationEffects (address at index.android.bundle:1:25)
    at performSyncWorkOnRoot (address at index.android.bundle:1:26)`;
    assert.deepEqual(llamadasDelFallo(pila), [
      'dispatchSetState',
      'alTerminar',
      '__notifyAnimationEnd',
      'stop',
      'stopAnimation',
      '__detach',
      '__removeChild',
      '__detach',
    ]);
  });

  it('sin nada que decir no inventa nada', () => {
    assert.deepEqual(componentesDelFallo(null), []);
    assert.deepEqual(llamadasDelFallo(undefined), []);
    assert.equal(detalleDelFallo({}), '');
  });

  it('el detalle junta pantalla, componentes y llamadas, y cabe en la pantalla', () => {
    const detalle = detalleDelFallo({
      ruta: '/home',
      pilaDeComponentes: PILA_DE_COMPONENTES,
      pila: PILA,
    });
    const [pantalla, en, por] = detalle.split('\n');
    assert.equal(pantalla, 'Pantalla: /home');
    assert.match(en ?? '', /^En: GloboDeNoLeidos < Pulsable < BarraInferior/);
    assert.equal(por, 'Por: dispatchSetState');

    const largo = detalleDelFallo({ pila: Array.from({ length: 400 }, (_, i) => `    at funcionLarguisima${i} (x)`).join('\n') });
    assert.ok(largo.length <= TOPE_DEL_DETALLE);
  });
});

describe('la pantalla del fallo dice dónde, enchufado', () => {
  const RAIZ = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  const fuente = (rel: string) => readFileSync(join(RAIZ, rel), 'utf8').replace(/\r\n/g, '\n');

  it('el layout raíz envuelve la navegación Y los avisos siempre montados', () => {
    const layout = fuente('app/_layout.tsx');
    const dentro = layout.slice(layout.indexOf('<LimiteDeErrores ruta={ruta}>'), layout.indexOf('</LimiteDeErrores>'));
    for (const pieza of ['<Stack', '<AvisoDeDirectoSeguido />', '<DialogHost />', '<ToastHost />']) {
      assert.ok(dentro.includes(pieza), `${pieza} queda fuera del límite`);
    }
    // La red de expo-router sigue detrás, para lo que falle en el propio layout.
    assert.match(layout, /export function ErrorBoundary\(/);
  });

  it('el límite pasa a la pantalla lo que React le dice del componente', () => {
    const limite = fuente('src/components/LimiteDeErrores.tsx');
    assert.match(limite, /componentDidCatch\(error: Error, info: React\.ErrorInfo\)/);
    assert.match(limite, /pilaDeComponentes: info\.componentStack/);
    assert.match(limite, /<AppErrorFallback error=\{error\} retry=\{this\.reintentar\} detalle=\{detalle\} \/>/);
  });

  it('y sin límite propio, la pantalla saca lo que pueda del error', () => {
    const pantalla = fuente('src/components/AppErrorFallback.tsx');
    assert.match(pantalla, /const donde = detalle \|\| detalleDelFallo\(\{ pila: error\?\.stack \}\);/);
    assert.match(pantalla, /\{donde \? \(/);
  });
});
