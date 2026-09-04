import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
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

describe('EL SDK NATIVO SIGUE SIN INSTALARSE', () => {
  /** Los paquetes que no pueden entrar sin que el cliente lo apruebe. */
  const PROHIBIDOS = [
    '@100mslive/react-native-hms',
    'livekit-client',
    '@livekit/react-native',
    'react-native-webrtc',
    'agora-react-native-rtc',
    'react-native-agora',
  ];

  it('no aparece en `package.json`', () => {
    /*
      Instalar el paquete obliga a una compilacion nativa nueva y tiene coste
      recurrente. Que aparezca sin aprobacion no es un detalle: rompe la build
      de EAS de todo el equipo.
    */
    const paquete = JSON.parse(readFileSync(join(MOVIL, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const instalados = new Set([
      ...Object.keys(paquete.dependencies ?? {}),
      ...Object.keys(paquete.devDependencies ?? {}),
    ]);
    const colados = PROHIBIDOS.filter((nombre) => instalados.has(nombre));
    assert.deepEqual(colados, [], `dependencias sin aprobar: ${colados.join(', ')}`);
  });

  it('y la sala que se sirve hoy es la falsa', () => {
    // El registro esta vacio: `crearSalaDeVideo()` devuelve la implementacion
    // que rechaza `unirse` con «no hay proveedor». Cuando el SDK entre, esta
    // prueba tendra que cambiar a proposito, que es justo la señal que se busca.
    const SALA = sinComentarios(fuente('live/salaDeVideo.ts'));
    assert.match(SALA, /let fabrica: FabricaDeSala \| null = null;/);
    assert.match(SALA, /return fabrica \? fabrica\(\) : crearSalaFalsa\(\);/);
  });

  it('ningun fichero de `src` importa uno de esos paquetes', () => {
    for (const rel of [
      'live/salaDeVideo.ts',
      'live/maquinaDeDirecto.ts',
      'live/reintentos.ts',
      'hooks/useSesionDeDirecto.ts',
      'screens/LiveScreen.tsx',
      'components/crear/ModoVivo.tsx',
    ]) {
      // Sin comentarios: `salaDeVideo.ts` NOMBRA el paquete en su cabecera para
      // explicar como se enchufara el dia que se apruebe. Documentarlo no es
      // importarlo, y confundir las dos cosas haria imposible dejar escrito el
      // camino.
      const texto = sinComentarios(fuente(rel));
      for (const nombre of PROHIBIDOS) {
        const importa = new RegExp(`from\\s*['"]${nombre.replace(/[/@]/g, '\\$&')}`).test(texto);
        assert.equal(importa, false, `${rel} importa ${nombre}`);
      }
    }
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
    for (const rel of ['live/salaDeVideo.ts', 'live/maquinaDeDirecto.ts', 'live/reintentos.ts']) {
      const importaciones = [...fuente(rel).matchAll(/^\s*import\s.+$/gm)].map((m) => m[0]);
      assert.deepEqual(importaciones, [], `${rel} ha dejado de ser autonomo`);
    }
  });
});
