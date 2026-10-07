import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MAXIMO_EN_PANTALLA,
  avisoDeEscenario,
  claveDelFalloDeEscenario,
  elegirPistasDeEscenario,
  escenarioVacio,
  leerEscenario,
  meTocaElAviso,
  pasoTrasLeer,
  plazasLibres,
  repartirEnColumnas,
  repartoDeEscenario,
  topicoDeEscenario,
  type PistaDeEscenario,
} from './escenario.ts';
import {
  crearSesionDeDirecto,
  type EntornoDeDirecto,
  type VistaDeDirecto,
} from './maquinaDeDirecto.ts';

/**
 * INVITADOS EN EL DIRECTO, como se pidió el 07/10/2026.
 *
 * Con sus palabras: «que haya un botón de invitar a personas al live, por lo
 * tanto el anfitrión puede invitar a más personas y estas personas estar con su
 * cámara y poder dividir en pantallas tal cual tiktok», y «sin romper lógicas
 * internas».
 *
 * Lo que tiene reglas se EJECUTA: qué se pinta, cómo se reparte, cuándo se
 * vuelve a preguntar al servidor y —lo que más importa— cuándo esta persona
 * pide permiso para publicar. Lo que es de pantalla se comprueba sobre el
 * código. Cómo se ve y cómo suena con dos teléfonos solo se sabe con dos
 * teléfonos.
 */

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (codigo: string) =>
  codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const pista = (id: string, papel: string, extra: Partial<PistaDeEscenario> = {}): PistaDeEscenario => ({
  id,
  papel,
  local: false,
  silenciada: false,
  ...extra,
});
const ids = (pistas: readonly PistaDeEscenario[]) => pistas.map((p) => p.id);

describe('con una sola persona se pinta exactamente lo de antes', () => {
  it('quien mira ve a quien emite', () => {
    assert.deepEqual(ids(elegirPistasDeEscenario([pista('h', 'host')], { emito: false })), ['h']);
  });

  it('quien emite se ve a sí mismo', () => {
    const propia = pista('yo', 'host', { local: true });
    assert.deepEqual(ids(elegirPistasDeEscenario([propia], { emito: true })), ['yo']);
  });

  it('con la única cámara apagada no se pinta nada: la pantalla pone su cartel', () => {
    const apagada = pista('h', 'host', { silenciada: true });
    assert.deepEqual(elegirPistasDeEscenario([apagada], { emito: false }), []);
    assert.deepEqual(
      elegirPistasDeEscenario([{ ...apagada, local: true }], { emito: true }),
      [],
    );
  });

  it('sin nadie, nada', () => {
    assert.deepEqual(elegirPistasDeEscenario([], { emito: false }), []);
  });

  it('una plantilla con otros nombres de rol no deja la pantalla en negro', () => {
    const rara = pista('x', 'presentador');
    assert.deepEqual(ids(elegirPistasDeEscenario([rara], { emito: false })), ['x']);
  });

  it('una pista sin identificador no se pinta', () => {
    assert.deepEqual(elegirPistasDeEscenario([pista('', 'host')], { emito: false }), []);
  });
});

describe('con invitados la pantalla se reparte', () => {
  const sala = [pista('g2', 'guest'), pista('h', 'host'), pista('g1', 'guest')];

  it('quien emite va primero, llegue en el orden que llegue', () => {
    assert.equal(elegirPistasDeEscenario(sala, { emito: false })[0]?.id, 'h');
  });

  it('todos los teléfonos colocan a los invitados en el mismo orden', () => {
    const otroOrden = [sala[2]!, sala[0]!, sala[1]!];
    assert.deepEqual(
      ids(elegirPistasDeEscenario(sala, { emito: false })),
      ids(elegirPistasDeEscenario(otroOrden, { emito: false })),
    );
    assert.deepEqual(ids(elegirPistasDeEscenario(sala, { emito: false })), ['h', 'g1', 'g2']);
  });

  it('quien apaga la cámara conserva su recuadro: los demás no saltan de sitio', () => {
    const conUnaApagada = [pista('h', 'host'), pista('g1', 'guest', { silenciada: true })];
    const pintadas = elegirPistasDeEscenario(conUnaApagada, { emito: false });
    assert.deepEqual(ids(pintadas), ['h', 'g1']);
    assert.equal(pintadas[1]?.silenciada, true);
  });

  it('el invitado se ve a sí mismo junto a quien emite', () => {
    const desdeElInvitado = [pista('yo', 'guest', { local: true }), pista('h', 'host')];
    assert.deepEqual(ids(elegirPistasDeEscenario(desdeElInvitado, { emito: true })), ['h', 'yo']);
  });

  it('administración modera, pero no es parte de la emisión: no tiene recuadro', () => {
    const conModeracion = [pista('h', 'host'), pista('m', 'moderator')];
    assert.deepEqual(ids(elegirPistasDeEscenario(conModeracion, { emito: false })), ['h']);
  });

  it('nunca más de cuatro imágenes', () => {
    const muchas = [
      pista('h', 'host'),
      ...['a', 'b', 'c', 'd', 'e'].map((id) => pista(id, 'guest')),
    ];
    assert.equal(MAXIMO_EN_PANTALLA, 4);
    assert.deepEqual(ids(elegirPistasDeEscenario(muchas, { emito: false })), ['h', 'a', 'b', 'c']);
  });

  it('el reparto: una entera, dos lado a lado, tres con quien emite a lo alto, cuatro en cuadrícula', () => {
    assert.deepEqual(repartoDeEscenario(0), []);
    assert.deepEqual(repartoDeEscenario(1), [1]);
    assert.deepEqual(repartoDeEscenario(2), [1, 1]);
    assert.deepEqual(repartoDeEscenario(3), [1, 2]);
    assert.deepEqual(repartoDeEscenario(4), [2, 2]);
    // Una medida absurda no inventa recuadros.
    assert.deepEqual(repartoDeEscenario(9), [2, 2]);
    assert.deepEqual(repartoDeEscenario(-3), []);
  });

  it('quien emite ocupa siempre la primera columna', () => {
    for (const cuantas of [1, 2, 3, 4]) {
      const columnas = repartirEnColumnas(['h', 'a', 'b', 'c'].slice(0, cuantas));
      assert.equal(columnas[0]?.[0], 'h', `con ${cuantas}`);
      assert.equal(columnas.flat().length, cuantas);
    }
    assert.deepEqual(repartirEnColumnas(['h', 'a', 'b']), [['h'], ['a', 'b']]);
  });
});

describe('lo que contesta el servidor', () => {
  const bruto = {
    max_guests: 3,
    can_invite: true,
    me: null,
    guests: [
      { user_id: 'u1', name: 'Bruno', username: 'bruno', avatar_path: null, status: 'invited' },
      { user_id: 'u2', name: 'Carla', username: null, avatar_path: 'a/b.jpg', status: 'accepted' },
      { user_id: 'u3', name: 'Dario', status: 'declined' },
    ],
  };

  it('se lee entero', () => {
    const escenario = leerEscenario(bruto);
    assert.ok(escenario);
    assert.equal(escenario.maximo, 3);
    assert.equal(escenario.puedeInvitar, true);
    assert.equal(escenario.mio, null);
    assert.deepEqual(
      escenario.invitados.map((i) => [i.usuarioId, i.estado, i.usuario, i.avatarPath]),
      [
        ['u1', 'invited', 'bruno', null],
        ['u2', 'accepted', null, 'a/b.jpg'],
        ['u3', 'declined', null, null],
      ],
    );
  });

  it('quien dijo que no deja libre su sitio', () => {
    assert.equal(plazasLibres(leerEscenario(bruto)!), 1);
    assert.equal(plazasLibres(escenarioVacio()), 0);
  });

  it('una fila que no se entiende se descarta, no tumba la lista', () => {
    const conRuido = leerEscenario({
      ...bruto,
      guests: [...bruto.guests, { user_id: 'u9', status: 'en_la_luna' }, null, 'x', { status: 'invited' }],
    });
    assert.equal(conRuido?.invitados.length, 3);
  });

  it('lo que no es un escenario no se toma por uno', () => {
    for (const cosa of [null, 'x', 7, [], {}, { guests: 'no' }]) {
      assert.equal(leerEscenario(cosa), null);
    }
  });

  it('un estado mío desconocido es «nada», no un permiso', () => {
    assert.equal(leerEscenario({ ...bruto, me: 'superanfitrion' })?.mio, null);
    assert.equal(leerEscenario({ ...bruto, me: 'accepted' })?.mio, 'accepted');
  });

  it('cada fallo del servidor tiene su texto, en los tres idiomas', () => {
    const codigos = [
      'live_guests_full',
      'live_guest_not_invited',
      'live_guests_rate_limited',
      'live_guests_not_live',
      'live_guest_is_host',
      'live_guests_not_available',
    ];
    const router = readFileSync(
      join(SRC, '..', '..', 'api', 'app', 'modules', 'live', 'router.py'),
      'utf8',
    );
    const reglas = readFileSync(
      join(SRC, '..', '..', 'api', 'app', 'modules', 'live', 'escenario.py'),
      'utf8',
    );
    for (const codigo of codigos) {
      // El código existe de verdad en el servidor: no se traduce un fantasma.
      assert.ok((router + reglas).includes(`"${codigo}"`), `${codigo} no sale del servidor`);
      const clave = claveDelFalloDeEscenario(codigo);
      assert.ok(clave, codigo);
      for (const idioma of ['es', 'en', 'pt']) {
        assert.ok(fuente(`i18n/${idioma}.ts`).includes(`'${clave}': `), `${clave} falta en ${idioma}`);
      }
    }
    assert.equal(claveDelFalloDeEscenario('otra_cosa'), null);
    assert.equal(claveDelFalloDeEscenario(null), null);
    // Ni las propiedades heredadas de un objeto cuelan como código.
    assert.equal(claveDelFalloDeEscenario('toString'), null);
  });
});

describe('el aviso de «el escenario cambió» solo sirve para volver a preguntar', () => {
  it('el tópico es el mismo en todos los teléfonos de la sala', () => {
    assert.equal(topicoDeEscenario('abc'), 'live-escenario:abc');
  });

  it('quien gestiona pregunta siempre: es su lista', () => {
    assert.equal(meTocaElAviso(avisoDeEscenario('otra'), 'yo', true), true);
  });

  it('quien mira solo pregunta si el aviso va a su nombre', () => {
    assert.equal(meTocaElAviso(avisoDeEscenario('yo'), 'yo', false), true);
    assert.equal(meTocaElAviso(avisoDeEscenario('otra'), 'yo', false), false);
  });

  it('un aviso sin destinatario, o ilegible, hace preguntar: nunca se pierde por raro', () => {
    assert.equal(meTocaElAviso(avisoDeEscenario(null), 'yo', false), true);
    assert.equal(meTocaElAviso(undefined, 'yo', false), true);
    assert.equal(meTocaElAviso('basura', 'yo', false), true);
  });

  it('sin cuenta no hay nada que preguntar', () => {
    assert.equal(meTocaElAviso(avisoDeEscenario(null), null, false), false);
    assert.equal(meTocaElAviso(avisoDeEscenario(null), null, true), false);
  });

  it('el aviso no dice qué ha pasado: no lleva ningún permiso', () => {
    assert.deepEqual(Object.keys(avisoDeEscenario('yo')).sort(), ['para', 'v']);
  });
});

describe('nadie sale al aire sin haberlo decidido en esta visita', () => {
  it('el servidor me recuerda como aceptado de antes: se suelta esa plaza', () => {
    assert.equal(pasoTrasLeer('accepted', { subidoAqui: false }), 'soltar_lo_viejo');
  });

  it('acepté aquí y sigo arriba: nada que hacer', () => {
    assert.equal(pasoTrasLeer('accepted', { subidoAqui: true }), 'nada');
  });

  it('estaba arriba y ya no consto: me han quitado, o la invitación ya no vale', () => {
    for (const mio of ['removed', 'left', 'declined', 'invited', null] as const) {
      assert.equal(pasoTrasLeer(mio, { subidoAqui: true }), 'bajar', String(mio));
    }
  });

  it('quien solo mira no tiene nada que hacer con ninguna respuesta', () => {
    for (const mio of ['removed', 'left', 'declined', 'invited', null] as const) {
      assert.equal(pasoTrasLeer(mio, { subidoAqui: false }), 'nada', String(mio));
    }
  });
});

/* ------------------------------------------------------------------------- *
 * LA MÁQUINA DEL DIRECTO
 * ------------------------------------------------------------------------- */

function respirar(): Promise<void> {
  return new Promise((resolver) => setTimeout(resolver, 0));
}

function banco(opciones: { gestiona?: boolean; servidorConcede?: boolean; unirse?: () => Promise<void> } = {}) {
  const registro = {
    pedidos: [] as boolean[],
    permisos: [] as string[],
    uniones: [] as boolean[],
    salidas: 0,
    vistas: [] as VistaDeDirecto[],
    /** Lo que pasó, en orden: para comprobar que se sale ANTES de pedir. */
    orden: [] as string[],
  };
  const entorno: EntornoDeDirecto = {
    esAnfitrion: () => opciones.gestiona ?? false,
    banderaEncendida: true,
    estadoInicialDeSesion: 'live',
    pedirCredencial: async ({ publicar }) => {
      registro.pedidos.push(publicar);
      registro.orden.push(`credencial:${publicar}`);
      // El servidor solo concede publicar a quien lo pide Y tiene derecho.
      const concede = publicar && (opciones.servidorConcede ?? true);
      return { puedePublicar: concede, hayVideo: true, opaca: { publicar: concede } };
    },
    clasificarFallo: () => ({ clase: 'desconocido' }),
    pedirPermiso: async (tipo) => {
      registro.permisos.push(tipo);
      return true;
    },
    unirseALaSala: async (_credencial, publicar) => {
      if (opciones.unirse) await opciones.unirse();
      registro.uniones.push(publicar);
      registro.orden.push(`unirse:${publicar}`);
    },
    salirDeLaSala: async () => {
      registro.salidas += 1;
      registro.orden.push('salir');
    },
    alternarCamaraEnLaSala: async () => {},
    alternarMicrofonoEnLaSala: async () => {},
    cambiarCamaraEnLaSala: async () => {},
    destruirLaSala: () => {},
    empezarEnElServidor: async () => {},
    terminarEnElServidor: async () => {},
    confirmarFinal: async () => true,
    confirmarSalida: async () => true,
    esperaAntesDeReintentar: () => null,
    programar: () => () => {},
    alCambiar: (vista) => registro.vistas.push(vista),
    avisar: () => {},
  };
  return { sesion: crearSesionDeDirecto(entorno), registro };
}

describe('la sesión pide publicar solo cuando la persona lo ha decidido', () => {
  it('quien mira entra pidiendo NO publicar, y no se le pide ningún permiso', async () => {
    const { sesion, registro } = banco();
    sesion.arrancar();
    await respirar();
    assert.deepEqual(registro.pedidos, [false]);
    assert.deepEqual(registro.uniones, [false]);
    assert.deepEqual(registro.permisos, []);
  });

  it('quien gestiona entra pidiendo publicar, como siempre', async () => {
    const { sesion, registro } = banco({ gestiona: true });
    sesion.arrancar();
    await respirar();
    assert.deepEqual(registro.pedidos, [true]);
    assert.deepEqual(registro.uniones, [true]);
    assert.deepEqual(registro.permisos, ['camara', 'microfono']);
  });

  it('al subir: sale, pide publicar, pide los permisos y entra emitiendo', async () => {
    const { sesion, registro } = banco();
    sesion.arrancar();
    await respirar();
    sesion.subirAlEscenario();
    await respirar();
    assert.deepEqual(registro.orden, [
      'credencial:false',
      'unirse:false',
      'salir',
      'credencial:true',
      'unirse:true',
    ]);
    assert.deepEqual(registro.permisos, ['camara', 'microfono']);
    assert.equal(sesion.vista().puedePublicar, true);
  });

  it('al bajar: sale ANTES de pedir nada, y vuelve a entrar como público', async () => {
    const { sesion, registro } = banco();
    sesion.arrancar();
    await respirar();
    sesion.subirAlEscenario();
    await respirar();
    registro.orden.length = 0;

    sesion.bajarDelEscenario();
    // En el mismo instante ya no consta como emisor: los controles se quitan
    // sin esperar a la red.
    assert.equal(sesion.vista().puedePublicar, false);
    assert.equal(sesion.vista().camara, false);
    await respirar();
    assert.deepEqual(registro.orden, ['salir', 'credencial:false', 'unirse:false']);
  });

  it('si el servidor no concede, subir no enciende nada', async () => {
    // Pulsar «Aceptar» en una aplicación trucada sin estar invitado.
    const { sesion, registro } = banco({ servidorConcede: false });
    sesion.arrancar();
    await respirar();
    sesion.subirAlEscenario();
    await respirar();
    assert.deepEqual(registro.uniones, [false, false]);
    assert.deepEqual(registro.permisos, []);
    assert.equal(sesion.vista().puedePublicar, false);
  });

  it('subir dos veces no vuelve a entrar; bajar sin estar arriba no hace nada', async () => {
    const { sesion, registro } = banco();
    sesion.arrancar();
    await respirar();
    sesion.bajarDelEscenario();
    await respirar();
    assert.equal(registro.pedidos.length, 1);

    sesion.subirAlEscenario();
    await respirar();
    sesion.subirAlEscenario();
    await respirar();
    assert.deepEqual(registro.pedidos, [false, true]);
  });

  it('subir mientras todavía se está entrando no se pierde ni entra dos veces a la vez', async () => {
    let soltar: () => void = () => {};
    const puerta = new Promise<void>((resolver) => {
      soltar = resolver;
    });
    let primera = true;
    const { sesion, registro } = banco({
      unirse: async () => {
        if (!primera) return;
        primera = false;
        await puerta;
      },
    });
    sesion.arrancar();
    await respirar();
    // La primera entrada sigue en vuelo.
    assert.deepEqual(registro.uniones, []);

    sesion.subirAlEscenario();
    await respirar();
    // No se ha pedido nada más: se espera a que termine la que hay.
    assert.deepEqual(registro.pedidos, [false]);

    soltar();
    await respirar();
    await respirar();
    assert.deepEqual(registro.pedidos, [false, true]);
    assert.deepEqual(registro.uniones, [false, true]);
  });

  it('un reintento tras una caída conserva el papel: quien estaba arriba vuelve arriba', async () => {
    const { sesion, registro } = banco();
    sesion.arrancar();
    await respirar();
    sesion.subirAlEscenario();
    await respirar();

    sesion.laSalaSeCayo(false);
    sesion.reintentar();
    await respirar();
    assert.equal(registro.pedidos.at(-1), true);
  });

  it('al terminar la emisión ya nadie está arriba', async () => {
    const { sesion, registro } = banco();
    sesion.arrancar();
    await respirar();
    sesion.subirAlEscenario();
    await respirar();

    sesion.cambiaLaSesion('ended');
    const antes = registro.pedidos.length;
    sesion.bajarDelEscenario();
    await respirar();
    assert.equal(registro.pedidos.length, antes);
  });
});

describe('la pantalla enseña lo que el servidor decide, y nada más', () => {
  const PANTALLA = sinComentarios(fuente('screens/LiveScreen.tsx'));
  const HOOK = sinComentarios(fuente('hooks/useEscenarioDeDirecto.ts'));
  const REPO = sinComentarios(fuente('repositories/LiveRepository.ts'));
  const REJILLA = sinComentarios(fuente('components/live/EscenarioDeVideo.tsx'));

  it('las imágenes las elige la regla, no la pantalla', () => {
    assert.match(PANTALLA, /elegirPistasDeEscenario\(pistas\.video, \{ emito: vista\.puedePublicar \}\)/);
    assert.match(PANTALLA, /<EscenarioDeVideo\s+pistas=\{enEscena\}/);
    assert.match(REJILLA, /repartirEnColumnas\(pistas\)/);
  });

  it('el botón de invitar solo existe si el servidor dice que se puede', () => {
    assert.match(
      PANTALLA,
      /enDirecto && escena\.disponible && escena\.escenario\.puedeInvitar \? \(\s*<BotonDeControl\s+icono="user-plus"/,
    );
    assert.match(PANTALLA, /visible=\{hojaDeInvitados && escena\.disponible && escena\.escenario\.puedeInvitar\}/);
  });

  it('la invitación solo se pinta mientras el servidor la mantenga', () => {
    assert.match(PANTALLA, /\{escena\.meInvitan \? \(\s*<InvitacionAlEscenario/);
    assert.match(HOOK, /meInvitan: disponible && enDirecto && escenario\.mio === 'invited'/);
  });

  it('quien está arriba tiene a la vista cómo bajarse', () => {
    assert.match(PANTALLA, /escena\.enPantalla && emision\.estado === 'live' \? \(/);
    assert.match(PANTALLA, /texto=\{t\('live\.stageLeave'\)\}\s+alPulsar=\{\(\) => void escena\.bajarme\(\)\}/);
  });

  it('bajarse apaga la cámara antes de preguntarle nada a la red', () => {
    const bajarme = /const bajarme = useCallback\(([\s\S]*?)\n  \);/.exec(HOOK)?.[1] ?? '';
    const apaga = bajarme.indexOf('sesion.bajarDelEscenario()');
    const pregunta = bajarme.indexOf('LiveRepository.dejarEscenario');
    assert.ok(apaga !== -1 && pregunta !== -1);
    assert.ok(apaga < pregunta, 'primero deja de salir y luego avisa al servidor');
  });

  it('salir de la sala estando arriba deja libre la plaza', () => {
    assert.match(HOOK, /if \(!subidoAqui\.current\) return;\s+subidoAqui\.current = false;\s+LiveRepository\.dejarEscenario\(emisionId\)/);
  });

  it('al servidor solo se le dice si se quiere publicar; el rol no se pide', () => {
    assert.match(REPO, /body: JSON\.stringify\(\{ publish: publicar \}\)/);
    assert.doesNotMatch(REPO, /role:/);
  });

  it('un servidor sin invitados no enseña nada de esto, y un fallo de red no lo esconde', () => {
    assert.match(REPO, /error\.code === 'live_guests_not_available' \|\| error\.status === 404/);
    assert.match(HOOK, /if \(vigente\.current && sinInvitados\(error\)\) setDisponible\(false\);/);
  });

  it('el aviso «te invitan a un directo» abre la sala desde el teléfono y desde la bandeja', () => {
    assert.match(sinComentarios(fuente('lib/rutaDelPush.ts')), /tipo === 'live_started' \|\| tipo === 'live_invited'/);
    assert.match(sinComentarios(fuente('lib/avisosAlCreador.ts')), /case 'live_started':\s+case 'live_invited':/);
    assert.match(sinComentarios(fuente('mappers/notificationMapper.ts')), /case 'live_invited':/);
  });
});
