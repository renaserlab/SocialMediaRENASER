import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * QUE LA PANTALLA USE LA MAQUINA, Y QUE EL SDK SIGA SIN ENTRAR.
 *
 * Las reglas del directo estan probadas de verdad en `maquinaDeDirecto` y
 * `reintentos`, ejecutandolas. Lo que NO se puede ejecutar con `node --test` es
 * un componente de React Native, y ahi queda una pregunta que si importa: ¿la
 * pantalla llama a la maquina, o se ha vuelto a escribir la logica dentro del
 * componente? Si eso pasara, las pruebas seguirian en verde comprobando codigo
 * que ya no manda nada.
 *
 * Se mira el CODIGO FUENTE, como hacen el resto de pruebas de pantalla de este
 * proyecto (`screens/accionesPorEstado.test.mts`). No sustituye a las pruebas
 * de comportamiento: las custodia.
 *
 * Y hay una segunda cosa que vigilar y que no es de estilo: que NO se haya
 * colado el paquete nativo de video. Instalarlo es una decision del cliente
 * —tiene coste y obliga a una compilacion nativa nueva— y una dependencia que
 * aparece sin que nadie la haya aprobado rompe la build de EAS del resto del
 * equipo.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');
const MOVIL = join(SRC, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

/** Sin comentarios: lo que se comprueba es lo que se EJECUTA. */
function sinComentarios(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const PANTALLA = sinComentarios(fuente('screens/LiveScreen.tsx'));
const HOOK = sinComentarios(fuente('hooks/useSesionDeDirecto.ts'));
const REPOSITORIO = sinComentarios(fuente('repositories/LiveRepository.ts'));

describe('la pantalla se apoya en la maquina y no rehace su trabajo', () => {
  it('monta la sesion de directo', () => {
    assert.match(HOOK, /crearSesionDeDirecto\(/, 'el hook no crea la maquina');
    assert.match(PANTALLA, /useSesionDeDirecto\(/, 'la pantalla no usa el hook');
  });

  it('el estado del video sale de la maquina, no de un `if` de la pantalla', () => {
    /*
      El fallo que esto impide es una regresion concreta: la pantalla tenia su
      propia escalera sobre `reproduccionDisponible` y sobre el estado de la
      emision. Volver a escribirla dejaria dos verdades distintas sobre lo mismo,
      y la probada seria la que no se pinta.
    */
    assert.match(PANTALLA, /cartelDelEstado\(/);
    assert.doesNotMatch(
      PANTALLA,
      /emision\.reproduccionDisponible/,
      'la pantalla vuelve a decidir el video por su cuenta',
    );
  });

  it('terminar y empezar pasan por la maquina, que es la que frena el doble toque', () => {
    assert.match(PANTALLA, /sesion\.terminar\(\)/);
    assert.match(PANTALLA, /sesion\.empezar\(\)/);
  });

  it('la confirmacion de terminar ya NO vive en la pantalla', () => {
    // Si volviera aqui, dejaria de estar bajo el freno de la doble pulsacion:
    // dos toques abrian dos dialogos y el segundo `POST /end` volvia como 409.
    assert.doesNotMatch(
      PANTALLA,
      /live\.endConfirmTitle/,
      'la confirmacion de terminar se ha vuelto a escribir en la pantalla',
    );
    assert.match(HOOK, /live\.endConfirmTitle/);
  });

  it('salir pregunta a la maquina si se puede salir', () => {
    assert.match(PANTALLA, /sesion\.intentarSalir\(\)/);
  });

  it('la pantalla NO pide permisos por su cuenta', () => {
    /*
      Requisito del cliente: al espectador no se le piden camara ni microfono.
      Quien decide a quien se le piden es la maquina, que solo lo hace tras un
      `can_publish` del servidor. Un `pedirPermiso` suelto en la pantalla
      esquivaria esa decision entera.
    */
    assert.doesNotMatch(PANTALLA, /\bpedirPermiso\b/);
    assert.match(HOOK, /pedirPermiso:/, 'el permiso tiene que entrar por el entorno');
  });
});

describe('el desmontaje suelta lo que abrio', () => {
  it('el efecto del hook destruye la maquina al limpiar', () => {
    // `destruir` es lo que corta el reintento programado, sale de la sala y
    // libera el SDK. Sin la llamada en la limpieza, la camara sobrevive a la
    // pantalla.
    const limpieza = HOOK.slice(HOOK.indexOf('return () => {'));
    assert.match(limpieza, /maquina\.destruir\(\)/);
    assert.match(limpieza, /dejarDeEscuchar\(\)/);
  });

  it('el temporizador de reintento se crea con su cancelacion', () => {
    // `programar` tiene que devolver como cancelar: un `setTimeout` sin su
    // `clearTimeout` es exactamente la fuga que se esta evitando.
    assert.match(HOOK, /clearTimeout\(id\)/);
  });
});

describe('el repositorio no devuelve codigos HTTP a la interfaz', () => {
  it('la credencial vuelve tipada y el fallo, clasificado', () => {
    assert.match(REPOSITORIO, /Promise<CredencialDeVideo>/);
    assert.match(REPOSITORIO, /clasificarFalloDeCredencial\(/);
  });

  it('la pantalla no compara codigos del proveedor de video', () => {
    // Los codigos del backend se traducen UNA vez, en el repositorio. Leerlos
    // tambien aqui haria que renombrar uno en el servidor rompiera en silencio
    // un `if` de la interfaz.
    assert.doesNotMatch(PANTALLA, /live_provider_not_configured'\s*\)/);
  });
});

describe('EL SDK NATIVO ESTA AISLADO EN UN SOLO FICHERO', () => {
  /*
    ESTA PRUEBA CAMBIO DE SIGNO, y era su trabajo.

    Mientras el SDK estaba pendiente de aprobacion, custodiaba que NO apareciera:
    instalarlo obliga a una compilacion nativa nueva, deja de funcionar Expo Go y
    cambia lo que produce una build de EAS, asi que colarlo sin permiso rompia el
    trabajo de todo el equipo. Salto en cuanto se instalo, que es justo la señal
    que se buscaba.

    Ya autorizado, lo que hay que custodiar es lo contrario y es mas valioso: que
    el SDK viva en UN solo fichero. Ese es el invariante que permite cambiar de
    proveedor sin reescribir la logica de negocio, y el que se pierde en silencio
    el dia que alguien importe `HMSView` directamente en una pantalla.
  */

  const PAQUETE = '@100mslive/react-native-hms';
  /** El complemento de video de 100ms (desenfoque y fondo virtual). */
  const COMPLEMENTO = '@100mslive/react-native-video-plugin';

  /** Otros proveedores. Estos siguen prohibidos: no se ha aprobado ninguno. */
  const PROHIBIDOS = [
    'livekit-client',
    '@livekit/react-native',
    'react-native-webrtc',
    'agora-react-native-rtc',
    'react-native-agora',
  ];

  const paquete = () =>
    JSON.parse(readFileSync(join(MOVIL, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

  it('esta instalado y con version fija', () => {
    // Fija y no con rango: una actualizacion menor de un modulo nativo puede
    // exigir otra compilacion, y eso no puede pasar sin que nadie lo decida.
    const version = paquete().dependencies?.[PAQUETE];
    assert.equal(typeof version, 'string');
    assert.match(String(version), /^\d+\.\d+\.\d+$/);
  });

  it('el complemento de video tambien, con version fija y compatible', () => {
    const version = paquete().dependencies?.[COMPLEMENTO];
    assert.equal(typeof version, 'string', 'falta el complemento de efectos');
    assert.match(String(version), /^\d+\.\d+\.\d+$/, 'el complemento lleva un rango');
    // El complemento declara con que SDK funciona (`>=1.12.0 <2.0.0`). Si
    // alguien sube el SDK a la 2 sin mirar el complemento, esto salta.
    const instalado = JSON.parse(
      readFileSync(
        join(MOVIL, '..', '..', 'node_modules', COMPLEMENTO, 'package.json'),
        'utf8',
      ),
    ) as { version: string; peerDependencies?: Record<string, string>; scripts?: Record<string, string> };
    assert.equal(instalado.version, version);
    assert.equal(instalado.peerDependencies?.[PAQUETE], '>=1.12.0 <2.0.0');
    const [mayor, menor] = String(paquete().dependencies?.[PAQUETE]).split('.').map(Number);
    assert.ok(mayor === 1 && (menor ?? 0) >= 12, 'el SDK instalado no es el que pide el complemento');
    // Un paquete que ejecuta codigo al instalarse no entra sin que alguien lo lea.
    for (const gancho of ['preinstall', 'install', 'postinstall']) {
      assert.equal(instalado.scripts?.[gancho], undefined, `el complemento trae un script «${gancho}»`);
    }
  });

  it('ningun otro proveedor se ha colado', () => {
    const instalados = new Set([
      ...Object.keys(paquete().dependencies ?? {}),
      ...Object.keys(paquete().devDependencies ?? {}),
    ]);
    const colados = PROHIBIDOS.filter((nombre) => instalados.has(nombre));
    assert.deepEqual(colados, [], `dependencias sin aprobar: ${colados.join(', ')}`);
  });

  it('SOLO `salaDeVideo100ms.ts` lo importa', () => {
    /*
      Es el invariante entero de esta integracion. Si una pantalla importara el
      SDK, cambiar de proveedor dejaria de ser escribir un fichero y pasaria a
      ser buscar por todo `src`.
    */
    for (const rel of [
      'live/salaDeVideo.ts',
      'live/maquinaDeDirecto.ts',
      'live/reintentos.ts',
      'live/registro100ms.ts',
      'live/registro100ms.native.ts',
      'live/efectosDeVideo.ts',
      'live/calidadDeVideo.ts',
      'live/fondosVirtuales.ts',
      'live/reaccionesEnVivo.ts',
      'live/burbujas.ts',
      'live/ventanaDeChat.ts',
      'live/suscripcionViva.ts',
      'hooks/useSesionDeDirecto.ts',
      'screens/LiveScreen.tsx',
      'components/crear/ModoVivo.tsx',
      'components/live/ChatDeDirecto.tsx',
      'components/live/ReaccionesDeDirecto.tsx',
      'components/live/HojaDeEfectos.tsx',
      'components/live/HojaDeCalidad.tsx',
      'services/directoEnVivo.ts',
    ]) {
      // Sin comentarios: varios ficheros NOMBRAN el paquete en su cabecera para
      // explicar donde vive. Documentarlo no es importarlo.
      const texto = sinComentarios(fuente(rel));
      for (const nombre of [PAQUETE, COMPLEMENTO, ...PROHIBIDOS]) {
        // Barra DOBLE en `\\s`: dentro de una plantilla, una sola se queda en
        // una `s` suelta, el patron buscaba «froms» y esta comprobacion no
        // podia fallar nunca (corregido el 23/09/2026, comprobado importando
        // el SDK en `ModoVivo`).
        const importa = new RegExp(`from\\s*['"]${nombre.replace(/[/@]/g, '\\$&')}`).test(texto);
        assert.equal(importa, false, `${rel} importa ${nombre}`);
      }
    }
    // Y el que si lo importa, lo importa.
    assert.match(
      sinComentarios(fuente('live/salaDeVideo100ms.ts')),
      new RegExp(`from '${PAQUETE.replace(/[/@]/g, '\$&')}'`),
    );
    assert.match(
      sinComentarios(fuente('live/salaDeVideo100ms.ts')),
      new RegExp(`from '${COMPLEMENTO.replace(/[/@]/g, '\$&')}'`),
      'el complemento de efectos tiene que entrar por el adaptador',
    );
  });

  it('NINGUN otro fichero de `src` importa nada de 100ms', () => {
    /*
      La lista de arriba nombra los ficheros que mas tentacion tienen. Esta
      recorre todos: un componente nuevo que importe `HmsView` o el complemento
      no esta en ninguna lista, y es justo el que hay que cazar.
    */
    const culpables: string[] = [];
    const recorrer = (carpeta: string) => {
      for (const entrada of readdirSync(carpeta, { withFileTypes: true })) {
        const ruta = join(carpeta, entrada.name);
        if (entrada.isDirectory()) {
          recorrer(ruta);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entrada.name) || /\.test\./.test(entrada.name)) continue;
        if (ruta.endsWith(join('live', 'salaDeVideo100ms.ts'))) continue;
        const texto = sinComentarios(readFileSync(ruta, 'utf8'));
        if (/(from|require\()\s*['"]@100mslive\//.test(texto)) culpables.push(ruta);
      }
    };
    recorrer(SRC);
    assert.deepEqual(culpables, [], `importan 100ms fuera del adaptador: ${culpables.join(', ')}`);
  });

  it('se carga TARDE y SOLO en un aparato', () => {
    /*
      LA SEPARACION ES POR EXTENSION, y no por un `if`. Se intento con
      `Platform.OS === 'web'` alrededor de un `require`, y no basta: Metro
      resuelve las rutas de forma ESTATICA y no elimina codigo por una condicion
      que solo se conoce al ejecutar, asi que el modulo nativo entraba igual en
      el paquete de web y `expo export --platform web` fallaba entero.

      El fichero sin sufijo es el del navegador —y el que resuelve TypeScript—;
      el `.native.ts` es el unico que toca el SDK.
    */
    const web = sinComentarios(fuente('live/registro100ms.ts'));
    assert.ok(
      !/salaDeVideo100ms/.test(web),
      'el registro de web nombra el adaptador nativo: eso lo mete en el paquete',
    );
    assert.match(web, /export function asegurarProveedorDeVideo\(\): void/);

    const nativo = sinComentarios(fuente('live/registro100ms.native.ts'));
    assert.match(nativo, /require\('@\/live\/salaDeVideo100ms'\)/);
    assert.ok(
      !/^import .*salaDeVideo100ms/m.test(nativo),
      'el adaptador se importa desde arriba en vez de cargarse tarde',
    );
    // Idempotente, y si no se puede cargar no se levanta: se sirve la falsa.
    assert.match(nativo, /if \(hayProveedorDeVideo\(\)\) return;/);
    assert.match(nativo, /\} catch \{/);
  });

  it('el registro sigue siendo el unico camino', () => {
    // `crearSalaDeVideo()` no conoce a nadie: sirve lo que le hayan registrado
    // y, si no hay nada, la falsa. Eso es lo que hace que las pruebas y el
    // navegador se comporten como si el SDK no existiera.
    const SALA = sinComentarios(fuente('live/salaDeVideo.ts'));
    assert.match(SALA, /let fabrica: FabricaDeSala \| null = null;/);
    assert.match(SALA, /return fabrica \? fabrica\(\) : crearSalaFalsa\(\);/);
  });
});

describe('los modulos probados con Node siguen sin importar nada', () => {
  it('ni React, ni React Native, ni el resto del proyecto', () => {
    /*
      Es la condicion que los mantiene ejecutables con `node --test`. Un solo
      `import { View } from 'react-native'` los saca del runner, y la maquina
      de estados de un directo volveria a ser codigo que nadie comprueba.
      Ademas, el proyecto no permite importar entre modulos `.ts` con extension
      (`allowImportingTsExtensions` esta apagado) y sin ella Node no resuelve la
      ruta: por eso van sin imports y con el entorno inyectado.
    */
    /*
      `import type` SI se permite, y solo eso: desaparece al ejecutar (Node lo
      borra al quitar los tipos), asi que no saca a nadie del runner. Hace falta
      desde que la sala expone el componente que dibuja una pista
      (`ComponentType` de React), el 23/09/2026. Cualquier otro `import`, aunque
      sea de un solo valor, sigue fallando aqui.
    */
    for (const rel of [
      'live/salaDeVideo.ts',
      'live/maquinaDeDirecto.ts',
      'live/reintentos.ts',
      // Los de este bloque (04/10/2026). Si alguno importara un valor, las
      // baterias que los EJECUTAN con varios clientes dejarian de arrancar.
      'live/reaccionesEnVivo.ts',
      'live/burbujas.ts',
      'live/ventanaDeChat.ts',
      'live/suscripcionViva.ts',
      'live/efectosDeVideo.ts',
      'live/calidadDeVideo.ts',
    ]) {
      const importaciones = [...fuente(rel).matchAll(/^\s*import\s.+$/gm)]
        .map((m) => m[0])
        .filter((linea) => !/^\s*import\s+type\s/.test(linea));
      assert.deepEqual(importaciones, [], `${rel} ha dejado de ser autonomo`);
    }
  });
});
