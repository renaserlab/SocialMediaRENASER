import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { navegadorDeLaAppMontado } from './navegadorMontado.ts';

/*
  EL FALLO (05/10/2026). Después de tocar una notificación, la aplicación dejaba
  de abrirse: «Maximum update depth exceeded» en cada arranque. La compilación
  de diagnóstico lo situó en el layout raíz, fuera de cualquier pantalla.

  Tres cosas a la vez, y las tres se comprueban aquí:
    1. se navegaba con el layout raíz todavía devolviendo `null`;
    2. lo atendido se recordaba en una referencia del propio layout, que al
       volver a montarse lo olvidaba;
    3. el sistema sigue entregando el mismo toque en cada arranque.

  LA PRUEBA QUE HABÍA decía «con la navegación ya montada» y lo que comprobaba
  era que el código contuviera `if (!lista || !respuesta) return;`. Custodiaba
  el texto de la guarda, no que la guarda guardara: `lista` era siempre cierta.
*/

/** El almacenamiento del teléfono, de mentira y en memoria. */
const DISCO = new Map<string, string>();
const fallos = { leer: false, escribir: false };
(globalThis as Record<string, unknown>).__discoDePrueba = { DISCO, fallos };

registerHooks({
  resolve(especificador, contexto, siguiente) {
    if (especificador === '@react-native-async-storage/async-storage') {
      return {
        url:
          'data:text/javascript,' +
          encodeURIComponent(`
            const { DISCO, fallos } = globalThis.__discoDePrueba;
            export default {
              async getItem(k) { if (fallos.leer) throw new Error('sin disco'); return DISCO.has(k) ? DISCO.get(k) : null; },
              async setItem(k, v) { if (fallos.escribir) throw new Error('sin disco'); DISCO.set(k, v); },
            };
          `),
        shortCircuit: true,
      };
    }
    return siguiente(especificador, contexto);
  },
});

const { anotarToqueAtendido, olvidarToques, reservarToque, soltarToque } = await import(
  '../services/pushAtendido.ts'
);

/** Como cerrar la aplicación del todo: la memoria se va, el disco se queda. */
const cerrarLaAplicacion = () => olvidarToques();

describe('cuándo está montado el navegador de la aplicación', () => {
  it('con el layout raíz devolviendo null NO lo está, aunque el enrutador ya tenga estado', () => {
    // Esto es lo que había al arrancar: la raíz interna con su clave, y nada debajo.
    assert.equal(navegadorDeLaAppMontado({ index: 0, routes: [{}] }), false);
    assert.equal(navegadorDeLaAppMontado({ index: 0, routes: [{ state: null }] }), false);
    assert.equal(navegadorDeLaAppMontado({ index: 0, routes: [{ state: { routes: [] } }] }), false);
  });

  it('lo está cuando el <Stack> del layout ha registrado sus rutas', () => {
    assert.equal(
      navegadorDeLaAppMontado({ index: 0, routes: [{ state: { index: 0, routes: [{}] } }] }),
      true,
    );
  });

  it('se mira la raíz ENFOCADA, no la primera', () => {
    assert.equal(
      navegadorDeLaAppMontado({ index: 1, routes: [{ state: { routes: [{}] } }, {}] }),
      false,
    );
    assert.equal(
      navegadorDeLaAppMontado({ index: 1, routes: [{}, { state: { routes: [{}] } }] }),
      true,
    );
  });

  it('sin estado, o con uno que no es lo esperado, no', () => {
    assert.equal(navegadorDeLaAppMontado(null), false);
    assert.equal(navegadorDeLaAppMontado(undefined), false);
    assert.equal(navegadorDeLaAppMontado({}), false);
    assert.equal(navegadorDeLaAppMontado({ routes: [] }), false);
  });
});

describe('cada toque de notificación se atiende una vez', () => {
  it('en la misma apertura: el segundo intento no pasa', async () => {
    DISCO.clear();
    cerrarLaAplicacion();
    assert.equal(await reservarToque('aviso-1'), true);
    // El layout se vuelve a montar y lee el mismo toque.
    assert.equal(await reservarToque('aviso-1'), false);
    assert.equal(await reservarToque('aviso-1'), false);
  });

  it('dos lecturas casi a la vez: solo pasa una', async () => {
    DISCO.clear();
    cerrarLaAplicacion();
    const [una, otra] = await Promise.all([reservarToque('aviso-2'), reservarToque('aviso-2')]);
    assert.deepEqual([una, otra].sort(), [false, true]);
  });

  it('ENTRE APERTURAS: el sistema vuelve a entregarlo y no se repite', async () => {
    DISCO.clear();
    cerrarLaAplicacion();
    assert.equal(await reservarToque('aviso-3'), true);
    await anotarToqueAtendido('aviso-3');
    cerrarLaAplicacion();
    assert.equal(await reservarToque('aviso-3'), false, 'cada arranque volvería a abrir aquel chat');
    // Y otro aviso distinto sí se atiende.
    assert.equal(await reservarToque('aviso-4'), true);
  });

  it('si no llegó a atenderse, se suelta y otro intento puede', async () => {
    DISCO.clear();
    cerrarLaAplicacion();
    assert.equal(await reservarToque('aviso-5'), true);
    soltarToque('aviso-5');
    assert.equal(await reservarToque('aviso-5'), true);
  });

  it('sin disco no lanza: se atiende, y queda la memoria de esta apertura', async () => {
    DISCO.clear();
    cerrarLaAplicacion();
    fallos.leer = true;
    fallos.escribir = true;
    try {
      assert.equal(await reservarToque('aviso-6'), true);
      await anotarToqueAtendido('aviso-6');
      assert.equal(await reservarToque('aviso-6'), false);
    } finally {
      fallos.leer = false;
      fallos.escribir = false;
    }
  });

  it('se recuerdan unos pocos: el disco no crece sin fin', async () => {
    DISCO.clear();
    cerrarLaAplicacion();
    for (let i = 0; i < 60; i += 1) await anotarToqueAtendido(`serie-${i}`);
    const guardados = JSON.parse(DISCO.get('z.push.atendidos.v1') ?? '[]') as string[];
    assert.equal(guardados.length, 20);
    assert.equal(guardados.at(-1), 'serie-59');
  });
});

describe('los ganchos de la raíz que navegan, enchufados', () => {
  const MOVIL = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  const fuente = (rel: string) => readFileSync(join(MOVIL, rel), 'utf8').replace(/\r\n/g, '\n');
  const sinComentarios = (codigo: string) =>
    codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const LAYOUT = sinComentarios(fuente('app/_layout.tsx'));
  const PUSH = sinComentarios(fuente('src/hooks/useAbrirDesdeElPush.native.ts'));
  const ENLACE = sinComentarios(fuente('src/hooks/useAuthDeepLink.ts'));
  const MONTADO = sinComentarios(fuente('src/hooks/useNavegadorMontado.ts'));

  it('ninguno vuelve a fiarse de la clave del navegador interno', () => {
    for (const [nombre, codigo] of [['push', PUSH], ['enlace', ENLACE], ['layout', LAYOUT]] as const) {
      assert.ok(!/useRootNavigationState/.test(codigo), `${nombre} vuelve a usar useRootNavigationState`);
    }
  });

  it('la señal sale del estado REAL del contenedor, y del layout ya pintado', () => {
    assert.match(MONTADO, /contenedor\.isReady\(\) \? \(contenedor\.getRootState\(\)/);
    assert.match(MONTADO, /if \(navegadorDeLaAppMontado\(raiz\)\) \{\s*setMontado\(true\);/);
    assert.match(MONTADO, /if \(!pintado \|\| montado\) return undefined;/);
    // Con tope: si no llega, no se navega; no se queda mirando para siempre.
    assert.match(MONTADO, /if \(miradas < MIRADAS_MAXIMAS\)/);
  });

  it('el layout calcula la señal con `ready` y se la da a los dos', () => {
    const listo = LAYOUT.indexOf('const ready = ');
    const senal = LAYOUT.indexOf('const navegadorMontado = useNavegadorMontado(ready);');
    assert.ok(listo !== -1 && senal > listo, 'la señal se calcula antes de saber si el layout pinta');
    assert.match(LAYOUT, /useAuthDeepLink\(navegadorMontado\);/);
    assert.match(LAYOUT, /useAbrirDesdeElPush\(navegadorMontado\);/);
  });

  it('abrir desde el push: espera al navegador y no guarda lo atendido en el componente', () => {
    assert.match(PUSH, /if \(!navegadorMontado \|\| !respuesta\) return undefined;/);
    assert.ok(!/atendidas/.test(PUSH), 'vuelve la memoria dentro del componente');
    assert.match(PUSH, /void reservarToque\(identificador\)\.then\(\(libre\) => \{/);
    // Lo ya atendido en otra apertura se olvida también en la biblioteca.
    assert.match(PUSH, /if \(!libre\) \{\s*olvidarEnLaBiblioteca\(\);\s*return;\s*\}/);
    // Navega, lo anota para siempre y lo olvida en la biblioteca, en ese orden.
    const navega = PUSH.indexOf('navegar.current.push(ruta as never);');
    const anota = PUSH.indexOf('void anotarToqueAtendido(identificador);');
    assert.ok(navega !== -1 && anota > navega);
    assert.match(PUSH, /Notifications\.clearLastNotificationResponse\(\);/);
  });

  it('el enlace de la contraseña: misma señal, sin releer el enlace al montarse', () => {
    assert.match(ENLACE, /export function useAuthDeepLink\(navegadorMontado: boolean\): void/);
    assert.match(ENLACE, /if \(montado\.current\) router\.replace\('\/reset-password'\);/);
    // El efecto que lee el enlace de entrada NO depende de la señal: repetirlo
    // abriría dos veces la misma sesión de recuperación.
    assert.match(ENLACE, /suscripcion\.remove\(\);\s*\};\s*\}, \[router\]\);/);
    assert.match(ENLACE, /if \(!navegadorMontado \|\| !destinoPendiente\.current\) return;/);
  });
});
