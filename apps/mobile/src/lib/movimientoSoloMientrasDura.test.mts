import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ESCALA_AL_PULSAR,
  daElSalto,
  estiloPulsado,
  modoDeEntrada,
  saltoDelGlobo,
  sentidoDelCambio,
} from './movimiento.ts';

/*
  LO REPORTADO (04/10/2026). «La velocidad de la navegación ha empeorado
  considerablemente… está demasiado lenta, con movimientos acartonados, está
  demasiado lag. Esto se nota especialmente en las vistas de Inicio y
  Explorar, pero generalmente toda la aplicación está así».

  LA CAUSA. El sistema de movimiento convirtió cada cosa pulsable, cada icono y
  cada contador en un componente animado SIEMPRE MONTADO: más de cien en
  Inicio, donde antes había uno. La biblioteca de animación reaplica todas sus
  entradas en cada cambio de la pantalla —en Android, cada fotograma de un
  desplazamiento—, y montar cada una para el hilo de JavaScript.

  LO QUE SE FIJA AQUÍ:
    1. Las reglas de CUÁNDO hay algo que animar (lo demás del tiempo, nada).
    2. Que nada de lo que se repite por fila vuelva a montar una vista animada
       permanente, y que quien quiera añadir una lo haga a sabiendas.
*/

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

const NORMAL = { escala: ESCALA_AL_PULSAR.superficie, atenuar: 0.85, opacidad: 1, reducir: false };

describe('algo pulsable no pinta nada especial mientras nadie lo toca', () => {
  it('en reposo no hay ni objeto de estilo: es el caso de casi todos casi siempre', () => {
    assert.equal(estiloPulsado(false, NORMAL), null);
  });

  it('bajo el dedo encoge y se atenúa, en el acto', () => {
    assert.deepEqual(estiloPulsado(true, NORMAL), {
      opacity: 0.85,
      transform: [{ scale: ESCALA_AL_PULSAR.superficie }],
    });
  });

  it('un botón apagado se sigue viendo apagado en reposo', () => {
    assert.deepEqual(estiloPulsado(false, { ...NORMAL, opacidad: 0.4 }), { opacity: 0.4 });
    // Y pulsado se atenúa SOBRE su opacidad, no la recupera.
    const pulsado = estiloPulsado(true, { ...NORMAL, opacidad: 0.4 });
    assert.ok(pulsado && Math.abs(pulsado.opacity - 0.34) < 1e-9);
  });

  it('con «reducir movimiento» no encoge, pero el toque se sigue viendo', () => {
    assert.deepEqual(estiloPulsado(true, { ...NORMAL, reducir: true }), { opacity: 0.85 });
  });

  it('quien pide no encoger ni atenuar no recibe nada, ni pulsado', () => {
    assert.equal(estiloPulsado(true, { escala: 1, atenuar: 1, opacidad: 1, reducir: false }), null);
  });
});

describe('un icono salta solo cuando cambia él', () => {
  it('guardar o quitar el guardado, salta', () => {
    assert.equal(daElSalto({ activo: false, clave: 'p1' }, { activo: true, clave: 'p1' }), true);
    assert.equal(daElSalto({ activo: true, clave: 'p1' }, { activo: false, clave: 'p1' }), true);
  });

  it('sin cambio no hay salto: es lo que pasa en cada repintado', () => {
    assert.equal(daElSalto({ activo: true, clave: 'p1' }, { activo: true, clave: 'p1' }), false);
  });

  it('la fila que pasa a pintar OTRA publicación ya guardada no acaba de guardarse', () => {
    assert.equal(daElSalto({ activo: false, clave: 'p1' }, { activo: true, clave: 'p2' }), false);
  });
});

describe('una cifra entra solo cuando cambia', () => {
  it('sube desde abajo y baja desde arriba', () => {
    assert.equal(sentidoDelCambio({ valor: 3, clave: 'p1' }, { valor: 4, clave: 'p1' }), 1);
    assert.equal(sentidoDelCambio({ valor: 4, clave: 'p1' }, { valor: 3, clave: 'p1' }), -1);
  });

  it('la misma cifra, o la cifra de otro elemento, no se mueve', () => {
    assert.equal(sentidoDelCambio({ valor: 3, clave: 'p1' }, { valor: 3, clave: 'p1' }), 0);
    assert.equal(sentidoDelCambio({ valor: 3, clave: 'p1' }, { valor: 90, clave: 'p2' }), 0);
  });
});

describe('el globo de no leídos', () => {
  it('aparece cuando llega lo primero y crece cuando llega más', () => {
    assert.equal(saltoDelGlobo(0, 1), 'aparece');
    assert.equal(saltoDelGlobo(2, 3), 'crece');
  });

  it('no se mueve al montarse con su cuenta, ni cuando baja, ni cuando se vacía', () => {
    assert.equal(saltoDelGlobo(3, 3), null);
    assert.equal(saltoDelGlobo(3, 1), null);
    assert.equal(saltoDelGlobo(3, 0), null);
    assert.equal(saltoDelGlobo(0, 0), null);
  });
});

describe('lo que «entra» en una lista', () => {
  it('el historial no monta nada animado: son casi todas las filas', () => {
    const modo = modoDeEntrada(null, 'm1', true);
    assert.equal(modo.animada, false);
    // Y sigue igual al repintar: es el MISMO objeto, no uno nuevo cada vez.
    assert.equal(modoDeEntrada(modo, 'm1', true), modo);
  });

  it('el mensaje que se acaba de enviar entra animado', () => {
    assert.equal(modoDeEntrada(null, 'temp-1', false).animada, true);
  });

  it('y cuando el servidor lo confirma NO cambia de componente: no parpadea', () => {
    // Al confirmarse deja de ser «nuevo» (quieta) y cambia de identificador.
    const enviando = modoDeEntrada(null, 'temp-1', false);
    const confirmado = modoDeEntrada(enviando, 'srv-9', true);
    assert.equal(confirmado.animada, true, 'la burbuja se remontaría al confirmarse');
    assert.equal(modoDeEntrada(confirmado, 'srv-9', true), confirmado);
  });

  it('una fila normal que recibe un elemento que sí entra, pasa a animada', () => {
    const historial = modoDeEntrada(null, 'm1', true);
    assert.equal(modoDeEntrada(historial, 'temp-2', false).animada, true);
  });

  it('una fila del historial que pasa a otro elemento del historial sigue normal', () => {
    const una = modoDeEntrada(null, 'm1', true);
    assert.equal(modoDeEntrada(una, 'm2', true).animada, false);
  });
});

describe('nada que se repita por fila deja una vista animada montada', () => {
  /** Lo que crea un nodo animado que vive mientras el componente esté montado. */
  const NODO_PERMANENTE =
    /\buseSharedValue\b|\buseAnimatedStyle\b|\bcreateAnimatedComponent\b|\bAnimated\.(View|Text|ScrollView|Image)\b/;

  const usaReanimated = (codigo: string) => /from 'react-native-reanimated'/.test(codigo);

  it('lo pulsable, el icono, el contador, el globo y la entrada ya no lo hacen', () => {
    for (const componente of [
      'Pulsable',
      'IconoQueSeEnciende',
      'ContadorAnimado',
      'GloboDeNoLeidos',
      'Aparecer',
    ]) {
      const codigo = fuente(`components/${componente}.tsx`);
      assert.ok(
        !NODO_PERMANENTE.test(codigo),
        `${componente} vuelve a montar una vista animada permanente`,
      );
    }
  });

  it('`Pulsable` pinta su estado con la función pura, sin animación', () => {
    const pulsable = fuente('components/Pulsable.tsx');
    assert.match(pulsable, /estiloPulsado\(pressed, \{ escala, atenuar, opacidad, reducir \}\)/);
    assert.match(pulsable, /<Pressable\b/);
  });

  it('lo que se mueve usa el motor de React Native y avisa al terminar', () => {
    const breve = fuente('components/movimientoBreve.tsx');
    assert.ok(!usaReanimated(breve), 'lo breve no puede dejar entradas en Reanimated');
    assert.match(breve, /from 'react-native'/);
    assert.match(breve, /useNativeDriver: NATIVO/);
    // Si se corta también avisa: quien lo montó no puede quedarse esperando.
    assert.match(breve, /animacion\.start\(\(\) => fin\.current\(\)\)/);
    assert.match(breve, /return \(\) => animacion\.stop\(\)/);
  });

  it('el icono, el contador y el globo montan lo animado solo si hay salto', () => {
    assert.match(fuente('components/IconoQueSeEnciende.tsx'), /if \(!salto\) return <View style=\{estilo\}>/);
    assert.match(fuente('components/ContadorAnimado.tsx'), /if \(!entrada\) return <View>\{cifra\}<\/View>;/);
    const globo = fuente('components/GloboDeNoLeidos.tsx');
    assert.match(globo, /if \(cuenta <= 0\) return null;/);
    assert.match(globo, /if \(!salto\) \{\s*return \(\s*<View/);
  });

  /*
    QUIÉN PUEDE TENER UNA VISTA ANIMADA SIEMPRE MONTADA. Cada una se reaplica
    en cada cambio de la pantalla mientras viva, así que la lista es cerrada y
    cada entrada dice por qué no multiplica: hay UNA por pantalla, o solo
    existe mientras dura algo. Un fichero nuevo que monte una hace fallar esta
    prueba: quien la añada tiene que venir aquí y justificarla.

    Nada de esta lista se pinta por fila de una lista.
  */
  const CON_PERMISO: Record<string, string> = {
    'components/BotonDeEnviar.tsx': 'uno, en la barra de escribir',
    'components/CabeceraDeAcceso.tsx': 'una, en las pantallas de entrar y registrarse',
    'components/CampoDeBusqueda.tsx': 'uno por pantalla con buscador',
    'components/Desplegable.tsx': 'acordeones: unos pocos por pantalla',
    'components/DoubleTapLike.tsx': 'el corazón del doble toque; ya existía',
    'components/ImageViewer.tsx': 'el visor a pantalla completa; solo mientras está abierto',
    'components/Input.tsx': 'los campos de un formulario',
    'components/OndaDeVoz.tsx': 'solo mientras se graba',
    'components/SegmentedControl.tsx': 'uno por pantalla',
    'components/Tabs.tsx': 'una fila de pestañas por pantalla',
    'components/Toast.tsx': 'el aviso flotante; solo mientras hay alguno',
    'components/crear/ProgresoDePublicacion.tsx': 'solo mientras se publica',
    'components/crear/SelectorDeModo.tsx': 'uno, en Crear',
    'components/live/ReaccionesDeDirecto.tsx': 'las burbujas de un directo, con tope',
    'navigation/SwipeTabs.tsx': 'el carrusel de pestañas: uno en toda la aplicación',
    'screens/CrearScreen.tsx': 'una pantalla',
    'screens/StoriesScreen.tsx': 'una pantalla',
  };

  it('fuera de la lista cerrada, ningún fichero monta una vista animada permanente', () => {
    const ficheros = globSync('**/*.{ts,tsx}', { cwd: SRC })
      .map((f) => f.replace(/\\/g, '/'))
      .filter((f) => !f.endsWith('.test.mts') && !f.endsWith('.d.ts'));
    assert.ok(ficheros.length > 400, `se han leído solo ${ficheros.length} ficheros`);

    const conNodos = ficheros.filter((f) => {
      const codigo = fuente(f);
      return usaReanimated(codigo) && NODO_PERMANENTE.test(codigo);
    });
    const sinPermiso = conNodos.filter((f) => !(f in CON_PERMISO));
    assert.deepEqual(
      sinPermiso,
      [],
      'montan una vista animada permanente sin estar en la lista: ' + sinPermiso.join(', '),
    );
    // Y la lista no guarda permisos de ficheros que ya no los usan.
    const deMas = Object.keys(CON_PERMISO).filter((f) => !conNodos.includes(f));
    assert.deepEqual(deMas, [], 'tienen permiso y ya no lo usan: ' + deMas.join(', '));
  });

  it('las filas de las listas grandes no usan nada de la lista con permiso', () => {
    const FILAS = [
      'components/PostCard.tsx',
      'components/AccionDePublicacion.tsx',
      'components/ShortVideoItem.tsx',
      'components/FilaDeConversacion.tsx',
      'components/Button.tsx',
      'components/Chip.tsx',
      'components/ListRow.tsx',
    ];
    const prohibidos = Object.keys(CON_PERMISO)
      .map((f) => relative('components', f).replace(/\\/g, '/'))
      .filter((f) => !f.startsWith('..'))
      .map((f) => f.replace(/\.tsx$/, ''))
      // Un campo de texto o un botón de enviar no son una fila de una lista.
      .filter((nombre) => !['Input', 'BotonDeEnviar', 'DoubleTapLike'].includes(nombre));
    for (const fila of FILAS) {
      const codigo = fuente(fila);
      assert.ok(!NODO_PERMANENTE.test(codigo) || !usaReanimated(codigo), `${fila} monta nodos animados`);
      for (const nombre of prohibidos) {
        assert.ok(
          !new RegExp(`from '@/components/${nombre}'`).test(codigo),
          `${fila} pinta ${nombre} en cada fila`,
        );
      }
    }
  });
});
