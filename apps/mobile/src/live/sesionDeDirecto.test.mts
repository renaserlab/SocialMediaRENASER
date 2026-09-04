import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  crearSesionDeDirecto,
  type CredencialLeida,
  type EntornoDeDirecto,
  type EstadoDeSesion,
  type VistaDeDirecto,
} from './maquinaDeDirecto.ts';
import { MAXIMO_DE_REINTENTOS, esperaAntesDeReintentar } from './reintentos.ts';
import { crearSalaFalsa, leerCredencial } from './salaDeVideo.ts';

/**
 * LA MAQUINA QUE LLEVA UNA PANTALLA DE DIRECTO, con el entorno inyectado.
 *
 * `decidirEstadoDeDirecto` ya dice QUE se pinta. Lo que se comprueba aqui es lo
 * otro, que es donde estan los fallos que se pagan caros:
 *
 *  - Que a quien SOLO MIRA no se le pida ni la camara ni el microfono. Es
 *    requisito explicito del cliente, y comprobarlo consiste en afirmar que una
 *    funcion NO se llamo: no hay forma de ver eso leyendo el codigo.
 *  - Que dos toques rapidos en «terminar» no abran dos dialogos ni manden dos
 *    `POST /end`, cosa que el segundo devuelve como 409 y se pinta como si algo
 *    hubiera fallado.
 *  - Que salir siendo anfitrion pregunte, y que quien mira se vaya sin dialogos.
 *  - Que al desmontar no quede un temporizador vivo, ni la sala, ni la camara.
 *  - Que un fallo definitivo no programe ni un solo reintento.
 *
 * El entorno entero es de mentira y lleva contadores, asi que se puede afirmar
 * «esto no ocurrio». El reloj tambien: las esperas se disparan a mano en vez de
 * esperarlas, y una prueba de un reintento a los cinco segundos tarda un
 * milisegundo.
 */

/** Deja correr las promesas pendientes de la maquina. */
function respirar(): Promise<void> {
  return new Promise((listo) => setImmediate(listo));
}

const CREDENCIAL_CON_VIDEO = leerCredencial({
  provider: '100ms',
  token: 'jwt',
  url: '',
  expires_in: 3600,
  can_publish: false,
  role: 'viewer',
  room_id: 'sala',
})!;

type Opciones = {
  esAnfitrion?: boolean;
  banderaEncendida?: boolean;
  sesion?: EstadoDeSesion | null;
  /** Lo que contesta el servidor a la credencial. Una funcion por si cambia. */
  credencial?: () => Promise<CredencialLeida>;
  confirmarFinal?: boolean;
  confirmarSalida?: boolean;
  /** Por defecto se usa la politica DE VERDAD. */
  esperaAntesDeReintentar?: (intentos: number, clase: string) => number | null;
  unirse?: () => Promise<void>;
  /** Se ejecuta al pedir cada permiso: sirve para cambiar la sesion a mitad. */
  alPedirPermiso?: (tipo: string) => void;
};

function crearBanco(opciones: Opciones = {}) {
  const registro = {
    credenciales: 0,
    permisos: [] as string[],
    uniones: [] as Array<{ credencial: unknown; publicar: boolean }>,
    salidas: 0,
    destruccionesDeSala: 0,
    empezadas: 0,
    terminadas: 0,
    confirmacionesDeFinal: 0,
    confirmacionesDeSalida: 0,
    avisos: [] as string[],
    vistas: [] as VistaDeDirecto[],
    temporizadoresProgramados: 0,
    temporizadoresCancelados: 0,
    camara: false,
    microfono: false,
  };

  /** Permisos que se conceden. Se cambia desde la prueba antes de arrancar. */
  const concede: Record<string, boolean> = { camara: true, microfono: true };
  let disparar: (() => void) | null = null;
  let esperaPedida: number | null = null;

  const entorno: EntornoDeDirecto = {
    esAnfitrion: () => opciones.esAnfitrion ?? false,
    banderaEncendida: opciones.banderaEncendida ?? true,
    estadoInicialDeSesion: opciones.sesion === undefined ? 'live' : opciones.sesion,

    pedirCredencial: async () => {
      registro.credenciales += 1;
      if (opciones.credencial) return opciones.credencial();
      return { puedePublicar: false, hayVideo: true, opaca: CREDENCIAL_CON_VIDEO };
    },
    clasificarFallo: (error) =>
      typeof error === 'object' && error !== null && 'clase' in error
        ? (error as { clase: never })
        : { clase: 'desconocido' },
    pedirPermiso: async (tipo) => {
      registro.permisos.push(tipo);
      opciones.alPedirPermiso?.(tipo);
      return concede[tipo] ?? true;
    },

    unirseALaSala: async (credencial, publicar) => {
      if (opciones.unirse) await opciones.unirse();
      registro.uniones.push({ credencial, publicar });
    },
    salirDeLaSala: async () => {
      registro.salidas += 1;
    },
    alternarCamaraEnLaSala: async (encendida) => {
      registro.camara = encendida;
    },
    alternarMicrofonoEnLaSala: async (encendido) => {
      registro.microfono = encendido;
    },
    cambiarCamaraEnLaSala: async () => {},
    destruirLaSala: () => {
      registro.destruccionesDeSala += 1;
    },

    empezarEnElServidor: async () => {
      registro.empezadas += 1;
    },
    terminarEnElServidor: async () => {
      registro.terminadas += 1;
    },
    confirmarFinal: async () => {
      registro.confirmacionesDeFinal += 1;
      return opciones.confirmarFinal ?? true;
    },
    confirmarSalida: async () => {
      registro.confirmacionesDeSalida += 1;
      return opciones.confirmarSalida ?? true;
    },

    esperaAntesDeReintentar:
      opciones.esperaAntesDeReintentar ??
      ((intentos, clase) => esperaAntesDeReintentar(intentos, clase)),
    programar: (fn, ms) => {
      registro.temporizadoresProgramados += 1;
      esperaPedida = ms;
      disparar = fn;
      return () => {
        registro.temporizadoresCancelados += 1;
        disparar = null;
      };
    },

    alCambiar: (vista) => registro.vistas.push(vista),
    avisar: (clave) => registro.avisos.push(clave),
  };

  const sesion = crearSesionDeDirecto(entorno);

  return {
    registro,
    sesion,
    concede,
    /** El ultimo estado publicado. Es lo que estaria en pantalla. */
    estado: () => registro.vistas[registro.vistas.length - 1]?.estado ?? sesion.vista().estado,
    ultimaVista: () => registro.vistas[registro.vistas.length - 1] ?? sesion.vista(),
    esperaPedida: () => esperaPedida,
    /** Dispara el reintento programado, si lo hay. */
    correrElReloj: () => {
      const fn = disparar;
      disparar = null;
      fn?.();
    },
    hayTemporizadorVivo: () => disparar !== null,
  };
}

/* ================================================================ Permisos */

describe('A QUIEN SOLO MIRA NO SE LE PIDE NADA', () => {
  it('un espectador llega a la sala sin un solo dialogo de permisos', async () => {
    const banco = crearBanco();
    banco.sesion.arrancar();
    await respirar();

    assert.deepEqual(banco.registro.permisos, [], 'no se le puede pedir la camara a quien mira');
    assert.equal(banco.registro.uniones.length, 1);
    assert.equal(banco.registro.uniones[0]?.publicar, false);
  });

  it('tampoco si la credencial falla, ni si no hay video', async () => {
    const sinVideo = crearBanco({
      credencial: async () => ({ puedePublicar: false, hayVideo: false, opaca: null }),
    });
    sinVideo.sesion.arrancar();
    await respirar();
    assert.deepEqual(sinVideo.registro.permisos, []);
    assert.equal(sinVideo.estado(), 'proveedor_no_configurado');
    assert.equal(sinVideo.registro.uniones.length, 0, 'sin video no se entra en ninguna sala');

    const roto = crearBanco({
      credencial: async () => {
        throw { clase: 'sin_proveedor' };
      },
    });
    roto.sesion.arrancar();
    await respirar();
    assert.deepEqual(roto.registro.permisos, []);
  });

  it('a quien SI publica se le piden los dos, y en ese orden', async () => {
    const banco = crearBanco({
      esAnfitrion: true,
      credencial: async () => ({ puedePublicar: true, hayVideo: true, opaca: CREDENCIAL_CON_VIDEO }),
    });
    banco.sesion.arrancar();
    await respirar();

    assert.deepEqual(banco.registro.permisos, ['camara', 'microfono']);
    assert.equal(banco.registro.uniones[0]?.publicar, true);
  });

  it('camara denegada: se para ahi y NO se pide el microfono', async () => {
    // Encadenar un segundo dialogo para acabar en el mismo sitio es maltratar a
    // quien ya ha dicho que no.
    const banco = crearBanco({
      esAnfitrion: true,
      credencial: async () => ({ puedePublicar: true, hayVideo: true, opaca: CREDENCIAL_CON_VIDEO }),
    });
    banco.concede.camara = false;
    banco.sesion.arrancar();
    await respirar();

    assert.deepEqual(banco.registro.permisos, ['camara']);
    assert.equal(banco.estado(), 'permiso_camara_denegado');
    assert.equal(banco.registro.uniones.length, 0, 'no se entra en la sala sin camara');
  });

  it('microfono denegado: tampoco se entra', async () => {
    const banco = crearBanco({
      esAnfitrion: true,
      credencial: async () => ({ puedePublicar: true, hayVideo: true, opaca: CREDENCIAL_CON_VIDEO }),
    });
    banco.concede.microfono = false;
    banco.sesion.arrancar();
    await respirar();

    assert.deepEqual(banco.registro.permisos, ['camara', 'microfono']);
    assert.equal(banco.estado(), 'permiso_microfono_denegado');
    assert.equal(banco.registro.uniones.length, 0);
  });
});

/* ================================================================= Bandera */

describe('con la bandera de directo apagada', () => {
  it('no se llama al servidor ni una vez', async () => {
    /*
      La respuesta ya se sabe. Una peticion que solo sirve para confirmar lo que
      ya sabemos cuenta ademas para el limite de ritmo del endpoint de
      credencial, que es compartido con los intentos que si sirven para algo.
    */
    const banco = crearBanco({ banderaEncendida: false });
    banco.sesion.arrancar();
    await respirar();

    assert.equal(banco.registro.credenciales, 0);
    assert.deepEqual(banco.registro.permisos, []);
    assert.equal(banco.registro.uniones.length, 0);
    assert.equal(banco.estado(), 'proveedor_no_configurado');
  });

  it('y tampoco se programa ningun reintento', async () => {
    const banco = crearBanco({ banderaEncendida: false });
    banco.sesion.arrancar();
    await respirar();
    assert.equal(banco.registro.temporizadoresProgramados, 0);
  });
});

describe('una emision que todavia no ha empezado', () => {
  it('no pide credencial: solo se ganaria un 409 y un intento gastado', async () => {
    const banco = crearBanco({ sesion: 'scheduled' });
    banco.sesion.arrancar();
    await respirar();

    assert.equal(banco.registro.credenciales, 0);
    assert.equal(banco.estado(), 'programado');
  });

  it('pero en cuanto empieza, se conecta sola', async () => {
    const banco = crearBanco({ sesion: 'scheduled' });
    banco.sesion.arrancar();
    await respirar();

    banco.sesion.cambiaLaSesion('live');
    await respirar();

    assert.equal(banco.registro.credenciales, 1);
    assert.equal(banco.registro.uniones.length, 1);
  });
});

/* ============================================================== Reintentos */

describe('el 429 de credencial', () => {
  it('se reintenta, con la espera que dice la politica de verdad', async () => {
    const banco = crearBanco({
      credencial: async () => {
        throw { clase: 'limitado' };
      },
    });
    banco.sesion.arrancar();
    await respirar();

    assert.equal(banco.estado(), 'error_recuperable');
    assert.equal(banco.registro.temporizadoresProgramados, 1);
    assert.equal(banco.esperaPedida(), esperaAntesDeReintentar(0, 'limitado'));
  });

  it('al disparar la espera vuelve a pedir credencial', async () => {
    const banco = crearBanco({
      credencial: async () => {
        throw { clase: 'limitado' };
      },
    });
    banco.sesion.arrancar();
    await respirar();
    assert.equal(banco.registro.credenciales, 1);

    banco.correrElReloj();
    await respirar();
    assert.equal(banco.registro.credenciales, 2);
  });

  it('y acaba PARANDO: no se reintenta para siempre', async () => {
    /*
      Se recorre el ciclo entero con la politica real hasta que deja de
      programar. Si alguien rompiera el corte, esta prueba no terminaria —el
      tope de vueltas lo delata— en vez de pasar en silencio.
    */
    const banco = crearBanco({
      credencial: async () => {
        throw { clase: 'limitado' };
      },
    });
    banco.sesion.arrancar();
    await respirar();

    let vueltas = 0;
    while (banco.hayTemporizadorVivo() && vueltas < 50) {
      vueltas += 1;
      banco.correrElReloj();
      await respirar();
    }

    assert.ok(vueltas < 50, 'los reintentos no paran');
    assert.equal(banco.registro.credenciales, MAXIMO_DE_REINTENTOS + 1);
    assert.equal(banco.estado(), 'error_definitivo');
  });
});

describe('UN FALLO DEFINITIVO NO SE REINTENTA', () => {
  const definitivos = [
    ['sin_proveedor', 'proveedor_no_configurado'],
    ['sin_permiso', 'acceso_denegado'],
    ['no_unible', 'terminado'],
  ] as const;

  for (const [clase, esperado] of definitivos) {
    it(`\`${clase}\`: cero temporizadores, cero peticiones de mas`, async () => {
      const banco = crearBanco({
        credencial: async () => {
          throw { clase };
        },
      });
      banco.sesion.arrancar();
      await respirar();

      assert.equal(banco.estado(), esperado);
      assert.equal(banco.registro.temporizadoresProgramados, 0, 'no puede programar reintento');
      assert.equal(banco.registro.credenciales, 1, 'una peticion y ni una mas');
    });
  }

  it('un fallo al ENTRAR en la sala se clasifica igual', async () => {
    // Es el caso de hoy: la sala falsa rechaza `unirse` con `sin_proveedor`.
    const sala = crearSalaFalsa();
    const banco = crearBanco({
      unirse: () => sala.unirse(CREDENCIAL_CON_VIDEO, { publicar: false }),
    });
    banco.sesion.arrancar();
    await respirar();

    assert.equal(banco.estado(), 'proveedor_no_configurado');
    assert.equal(banco.registro.temporizadoresProgramados, 0);
  });
});

describe('el reintento a mano', () => {
  it('vuelve a poner el contador a cero', async () => {
    const banco = crearBanco({
      credencial: async () => {
        throw { clase: 'red' };
      },
    });
    banco.sesion.arrancar();
    await respirar();
    while (banco.hayTemporizadorVivo()) {
      banco.correrElReloj();
      await respirar();
    }
    assert.equal(banco.estado(), 'error_definitivo');

    banco.sesion.reintentar();
    await respirar();

    // Lo que no puede ser infinito es lo que ocurre SOLO. Aqui hay una persona
    // pulsando, y quien decide cuando parar es ella.
    assert.equal(banco.ultimaVista().intentos, 1);
    assert.equal(banco.estado(), 'error_recuperable');
  });
});

/* ================================================ Lo que cuenta la sala */

describe('los eventos de la sala', () => {
  async function bancoConectado() {
    const banco = crearBanco();
    banco.sesion.arrancar();
    await respirar();
    banco.sesion.laSalaConecto();
    return banco;
  }

  it('conectar sin medios es «conectado», con medios es «en directo»', async () => {
    const banco = await bancoConectado();
    assert.equal(banco.estado(), 'conectado');

    banco.sesion.laSalaCambioDeMedios({
      camara: true,
      microfono: true,
      camaraFrontal: true,
      publicando: true,
    });
    assert.equal(banco.estado(), 'en_directo');
    assert.equal(banco.ultimaVista().camara, true);
  });

  it('la mala calidad se dice, no se disimula', async () => {
    const banco = await bancoConectado();
    banco.sesion.laSalaCambioDeCalidad(false);
    assert.equal(banco.estado(), 'conexion_lenta');
    banco.sesion.laSalaCambioDeCalidad(true);
    assert.equal(banco.estado(), 'conectado');
  });

  it('una mala medida durante la reconexion no pinta «lenta»', async () => {
    // Sin este corte, un aviso de calidad que llegara tarde tapaba el estado de
    // reconexion con uno que dice que se esta viendo algo.
    const banco = await bancoConectado();
    banco.sesion.laSalaReconecta();
    banco.sesion.laSalaCambioDeCalidad(false);
    assert.equal(banco.estado(), 'reconectando');
  });

  it('una caida recuperable reintenta; una definitiva, no', async () => {
    const recuperable = await bancoConectado();
    recuperable.sesion.laSalaSeCayo(true);
    await respirar();
    assert.equal(recuperable.estado(), 'error_recuperable');
    assert.equal(recuperable.registro.temporizadoresProgramados, 1);

    const definitiva = await bancoConectado();
    definitiva.sesion.laSalaSeCayo(false);
    await respirar();
    assert.equal(definitiva.estado(), 'error_definitivo');
    assert.equal(definitiva.registro.temporizadoresProgramados, 0);
  });

  it('reconectar con exito borra los intentos gastados', async () => {
    const banco = await bancoConectado();
    banco.sesion.laSalaSeCayo(true);
    await respirar();
    assert.equal(banco.ultimaVista().intentos, 1);

    banco.sesion.laSalaConecto();
    assert.equal(banco.ultimaVista().intentos, 0);
    assert.equal(banco.hayTemporizadorVivo(), false, 'el reintento pendiente se cancela');
  });
});

/* =========================================== La emision termina mientras miras */

describe('LA EMISION TERMINA MIENTRAS SE ESTA MIRANDO', () => {
  it('suelta la sala en el acto', async () => {
    /*
      Sin esto, el SDK sigue conectado contra una sala que el servidor ya cerro,
      empieza a reintentar por su cuenta y deja la camara de quien emitia
      encendida despues de haber terminado.
    */
    const banco = crearBanco({ esAnfitrion: true });
    banco.sesion.arrancar();
    await respirar();
    banco.sesion.laSalaConecto();
    assert.equal(banco.registro.salidas, 0);

    banco.sesion.cambiaLaSesion('ended');
    await respirar();

    assert.equal(banco.estado(), 'terminado');
    assert.equal(banco.registro.salidas, 1);
    assert.equal(banco.ultimaVista().camara, false);
    assert.equal(banco.ultimaVista().microfono, false);
  });

  it('cancelar una emision programada tambien se ve', async () => {
    const banco = crearBanco({ sesion: 'scheduled' });
    banco.sesion.arrancar();
    await respirar();
    banco.sesion.cambiaLaSesion('cancelled');
    assert.equal(banco.estado(), 'cancelado');
  });

  it('un reintento pendiente se cancela al terminar la emision', async () => {
    const banco = crearBanco({
      credencial: async () => {
        throw { clase: 'red' };
      },
    });
    banco.sesion.arrancar();
    await respirar();
    assert.equal(banco.hayTemporizadorVivo(), true);

    banco.sesion.cambiaLaSesion('ended');
    assert.equal(banco.hayTemporizadorVivo(), false);
    assert.equal(banco.registro.temporizadoresCancelados, 1);
  });
});

/* ============================================================ Doble pulsacion */

describe('DOBLE PULSACION', () => {
  it('dos toques en «terminar» abren UN dialogo y mandan UN `POST`', async () => {
    /*
      EL FRENO TIENE QUE ESTAR ANTES DEL DIALOGO, no despues. La ventana real en
      la que cabe el segundo toque es justo mientras el primero espera la
      confirmacion: el dialogo tarda en aparecer y el dedo ya va por el segundo
      toque. Por eso aqui la confirmacion se queda ABIERTA a proposito.
    */
    const lento = crearBancoConDialogoLento();

    void lento.sesion.terminar();
    void lento.sesion.terminar();
    await respirar();

    assert.equal(lento.registro.confirmacionesDeFinal, 1, 'se abrieron dos dialogos');

    lento.resolver(true);
    await respirar();
    assert.equal(lento.registro.terminadas, 1, 'se mando dos veces `POST /end`');
  });

  it('dos toques en «empezar» mandan UNA sola peticion', async () => {
    const banco = crearBanco({ esAnfitrion: true, sesion: 'scheduled' });
    banco.sesion.arrancar();
    await respirar();

    void banco.sesion.empezar();
    void banco.sesion.empezar();
    await respirar();

    assert.equal(banco.registro.empezadas, 1);
  });

  it('mientras hay una accion en vuelo, la vista lo dice', async () => {
    const lento = crearBancoConDialogoLento();
    void lento.sesion.terminar();
    await respirar();
    assert.equal(lento.ultimaVista().ocupado, true, 'los botones tienen que ir deshabilitados');

    lento.resolver(false);
    await respirar();
    assert.equal(lento.ultimaVista().ocupado, false);
  });

  it('cuando la accion termina, se vuelve a poder pulsar', async () => {
    const banco = crearBanco({ esAnfitrion: true });
    await banco.sesion.terminar();
    await banco.sesion.terminar();
    assert.equal(banco.registro.terminadas, 2, 'el freno es por accion, no para siempre');
  });
});

describe('LA CONFIRMACION ANTES DE TERMINAR', () => {
  it('decir que no NO termina la emision', async () => {
    const banco = crearBanco({ esAnfitrion: true, confirmarFinal: false });
    await banco.sesion.terminar();

    assert.equal(banco.registro.confirmacionesDeFinal, 1);
    assert.equal(banco.registro.terminadas, 0, 'se cancelo y aun asi se termino');
  });

  it('la peticion NO sale hasta que el dialogo se ha contestado', async () => {
    // Con el freno mal puesto —despues del `await`— la peticion salia mientras
    // el dialogo seguia en pantalla, y decir «no» ya no servia de nada.
    const lento = crearBancoConDialogoLento();
    void lento.sesion.terminar();
    await respirar();
    assert.equal(lento.registro.terminadas, 0, 'se termino sin esperar la respuesta');

    lento.resolver(true);
    await respirar();
    assert.equal(lento.registro.terminadas, 1);
  });

  it('si el servidor falla, se avisa en vez de tragarselo', async () => {
    const avisos: string[] = [];
    const roto = crearSesionDeDirecto({
      ...bancoBase(),
      terminarEnElServidor: async () => {
        throw new Error('502');
      },
      avisar: (clave) => avisos.push(clave),
    });
    await roto.terminar();
    assert.deepEqual(avisos, ['live.endFailed']);
  });

  it('lo mismo al empezar', async () => {
    const avisos: string[] = [];
    const roto = crearSesionDeDirecto({
      ...bancoBase(),
      empezarEnElServidor: async () => {
        throw new Error('502');
      },
      avisar: (clave) => avisos.push(clave),
    });
    await roto.empezar();
    assert.deepEqual(avisos, ['live.startFailed']);
  });
});

describe('CONFIRMAR ANTES DE ABANDONAR SIENDO ANFITRION', () => {
  it('quien emite en directo tiene que confirmar', async () => {
    const banco = crearBanco({ esAnfitrion: true, confirmarSalida: true });
    const puede = await banco.sesion.intentarSalir();

    assert.equal(banco.registro.confirmacionesDeSalida, 1);
    assert.equal(puede, true);
  });

  it('y si dice que no, no se sale', async () => {
    const banco = crearBanco({ esAnfitrion: true, confirmarSalida: false });
    assert.equal(await banco.sesion.intentarSalir(), false);
  });

  it('QUIEN SOLO MIRA SE VA SIN DIALOGOS', async () => {
    // Un dialogo por cerrar un video es ruido: no hay nada que interrumpir.
    const banco = crearBanco({ esAnfitrion: false });
    assert.equal(await banco.sesion.intentarSalir(), true);
    assert.equal(banco.registro.confirmacionesDeSalida, 0);
  });

  it('tampoco se pregunta por una emision que ya termino', async () => {
    const banco = crearBanco({ esAnfitrion: true, sesion: 'ended' });
    assert.equal(await banco.sesion.intentarSalir(), true);
    assert.equal(banco.registro.confirmacionesDeSalida, 0);
  });

  it('ni por una que aun no ha empezado', async () => {
    const banco = crearBanco({ esAnfitrion: true, sesion: 'scheduled' });
    assert.equal(await banco.sesion.intentarSalir(), true);
    assert.equal(banco.registro.confirmacionesDeSalida, 0);
  });
});

/* ================================================================= Limpieza */

describe('LIMPIEZA AL DESMONTAR', () => {
  it('destruir corta el reintento pendiente, sale y libera el SDK', async () => {
    const banco = crearBanco({
      credencial: async () => {
        throw { clase: 'red' };
      },
    });
    banco.sesion.arrancar();
    await respirar();
    assert.equal(banco.hayTemporizadorVivo(), true);

    banco.sesion.destruir();

    assert.equal(banco.registro.temporizadoresCancelados, 1, 'quedaria un setTimeout vivo');
    assert.equal(banco.registro.destruccionesDeSala, 1, 'la camara se queda encendida sin esto');
  });

  it('estando dentro de la sala, tambien se sale', async () => {
    const banco = crearBanco();
    banco.sesion.arrancar();
    await respirar();
    banco.sesion.laSalaConecto();

    banco.sesion.destruir();
    assert.equal(banco.registro.salidas, 1);
    assert.equal(banco.registro.destruccionesDeSala, 1);
  });

  it('despues de destruir NO se vuelve a pintar nada', async () => {
    const banco = crearBanco();
    banco.sesion.arrancar();
    await respirar();
    banco.sesion.destruir();

    const antes = banco.registro.vistas.length;
    banco.sesion.laSalaConecto();
    banco.sesion.cambiaLaSesion('ended');
    banco.sesion.laSalaSeCayo(true);
    await banco.sesion.terminar();
    await respirar();

    // Publicar sobre una pantalla desmontada es la advertencia de React de
    // «actualizar el estado de un componente que ya no esta montado».
    assert.equal(banco.registro.vistas.length, antes);
    assert.equal(banco.registro.terminadas, 0);
  });

  it('destruir es idempotente: el desmontaje puede correr dos veces', async () => {
    const banco = crearBanco();
    banco.sesion.arrancar();
    await respirar();
    banco.sesion.laSalaConecto();

    banco.sesion.destruir();
    banco.sesion.destruir();
    assert.equal(banco.registro.destruccionesDeSala, 1);
    assert.equal(banco.registro.salidas, 1);
  });

  it('si la pantalla se va MIENTRAS se entra en la sala, se sale igual', async () => {
    /*
      Ventana real: alguien pulsa Atras mientras la union esta en vuelo. Sin
      esto, la promesa se resolvia despues del desmontaje y dejaba una sala
      conectada —con camara— detras de una pantalla que ya no existe.
    */
    let dejarEntrar: (() => void) | null = null;
    const banco = crearBanco({
      unirse: () => new Promise<void>((listo) => { dejarEntrar = listo; }),
    });
    banco.sesion.arrancar();
    await respirar();

    banco.sesion.destruir();
    dejarEntrar?.();
    await respirar();

    assert.equal(banco.registro.salidas, 1, 'la sala quedo conectada tras el desmontaje');
  });

  it('arrancar dos veces no conecta dos veces', async () => {
    // Un efecto que corre dos veces (recarga en caliente, arbol en modo
    // estricto) no puede pedir dos credenciales ni abrir dos salas.
    const banco = crearBanco();
    banco.sesion.arrancar();
    banco.sesion.arrancar();
    await respirar();
    assert.equal(banco.registro.credenciales, 1);
    assert.equal(banco.registro.uniones.length, 1);
  });
});

/* -------------------------------------------------------------- Auxiliares */

/** Un entorno base minimo, para las pruebas que sustituyen una sola pieza. */
function bancoBase(): EntornoDeDirecto {
  return {
    esAnfitrion: true,
    banderaEncendida: true,
    estadoInicialDeSesion: 'live',
    pedirCredencial: async () => ({ puedePublicar: false, hayVideo: true, opaca: null }),
    clasificarFallo: () => ({ clase: 'desconocido' }),
    pedirPermiso: async () => true,
    unirseALaSala: async () => {},
    salirDeLaSala: async () => {},
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
    alCambiar: () => {},
    avisar: () => {},
  };
}

/**
 * Una sesion cuyo dialogo de confirmacion se queda ABIERTO hasta que la prueba
 * lo cierra. Es la unica forma de meter el segundo toque en la ventana en la
 * que de verdad cabia.
 */
function crearBancoConDialogoLento() {
  const registro = {
    confirmacionesDeFinal: 0,
    terminadas: 0,
    vistas: [] as VistaDeDirecto[],
  };
  let resolver: (si: boolean) => void = () => {};

  const sesion = crearSesionDeDirecto({
    ...bancoBase(),
    confirmarFinal: () => {
      registro.confirmacionesDeFinal += 1;
      return new Promise<boolean>((listo) => {
        resolver = listo;
      });
    },
    terminarEnElServidor: async () => {
      registro.terminadas += 1;
    },
    alCambiar: (vista) => registro.vistas.push(vista),
  });

  return {
    sesion,
    registro,
    resolver: (si: boolean) => resolver(si),
    ultimaVista: () => registro.vistas[registro.vistas.length - 1]!,
  };
}

// ---------------------------------------------------------------------------
// LO QUE ENCONTRO LA REVISION INDEPENDIENTE
// ---------------------------------------------------------------------------

describe('LA EMISION PUEDE TERMINAR MIENTRAS SE CONECTA', () => {
  /*
    EL FALLO. Tras cada espera se comprobaba `destruida`, pero nunca si la
    emision seguia viva. Entre pedir la credencial y entrar en la sala pasan
    segundos, y en ese hueco el anfitrion puede cerrarla —o llegar el aviso por
    Realtime—. La maquina seguia adelante: pedia los permisos y entraba en la
    sala de una emision TERMINADA, y la camara se quedaba encendida detras de
    una pantalla que decia «terminado».
  */

  it('si termina mientras la credencial esta en vuelo, no se pide un permiso', async () => {
    let contestar: (() => void) | null = null;
    const banco = crearBanco({
      esAnfitrion: true,
      credencial: () =>
        new Promise((resolver) => {
          contestar = () =>
            resolver({ puedePublicar: true, hayVideo: true, opaca: CREDENCIAL_CON_VIDEO });
        }),
    });

    banco.sesion.arrancar();
    await respirar();
    // La emision termina ANTES de que conteste el servidor.
    banco.sesion.cambiaLaSesion('ended');
    contestar!();
    await respirar();

    assert.deepEqual(banco.registro.permisos, [], 'pidio permisos para una emision terminada');
    assert.equal(banco.registro.uniones.length, 0, 'entro en la sala de una emision terminada');
    assert.equal(banco.ultimaVista().estado, 'terminado');
  });

  it('si termina entre los dos permisos, no se entra en la sala', async () => {
    let banco: ReturnType<typeof crearBanco>;
    banco = crearBanco({
      esAnfitrion: true,
      credencial: async () => ({
        puedePublicar: true,
        hayVideo: true,
        opaca: CREDENCIAL_CON_VIDEO,
      }),
      // Se cierra justo despues de conceder la camara.
      alPedirPermiso: (tipo) => {
        if (tipo === 'camara') banco.sesion.cambiaLaSesion('ended');
      },
    });

    banco.sesion.arrancar();
    await respirar();

    assert.deepEqual(banco.registro.permisos, ['camara'], 'siguio pidiendo el microfono');
    assert.equal(banco.registro.uniones.length, 0);
  });

  it('si termina mientras se entra en la sala, se sale de ella', async () => {
    let entrar: (() => void) | null = null;
    const banco = crearBanco({
      esAnfitrion: true,
      credencial: async () => ({
        puedePublicar: true,
        hayVideo: true,
        opaca: CREDENCIAL_CON_VIDEO,
      }),
      unirse: () =>
        new Promise((resolver) => {
          entrar = () => resolver();
        }),
    });

    banco.sesion.arrancar();
    await respirar();
    banco.sesion.cambiaLaSesion('ended');
    entrar!();
    await respirar();

    // Se entro —la peticion ya habia salido— pero se sale inmediatamente: la
    // camara no puede quedarse encendida detras de una pantalla «terminado».
    assert.ok(banco.registro.salidas >= 1, 'se quedo dentro de la sala');
  });
});

describe('DOS TOQUES EN REINTENTAR NO ENTRAN DOS VECES', () => {
  it('el segundo se descarta mientras el primero esta en vuelo', async () => {
    /*
      `reintentar` era el UNICO gesto publico sin freno. Dos toques dentro del
      mismo fotograma —antes de que React repinte y esconda el boton— pedian dos
      credenciales, encadenaban cuatro dialogos de permiso y llamaban dos veces
      a `unirse`. Al desmontar solo se salia una vez: la segunda conexion
      quedaba huerfana con la camara encendida.
    */
    let contestar: Array<() => void> = [];
    const banco = crearBanco({
      esAnfitrion: true,
      credencial: () =>
        new Promise((resolver) => {
          contestar.push(() =>
            resolver({ puedePublicar: true, hayVideo: true, opaca: CREDENCIAL_CON_VIDEO }),
          );
        }),
    });

    banco.sesion.reintentar();
    banco.sesion.reintentar();
    await respirar();

    assert.equal(banco.registro.credenciales, 1, 'pidio dos credenciales');
    for (const soltar of contestar) soltar();
    await respirar();
    assert.equal(banco.registro.uniones.length, 1, 'entro dos veces en la sala');
  });
});
