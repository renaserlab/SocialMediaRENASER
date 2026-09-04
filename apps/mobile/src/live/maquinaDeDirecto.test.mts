import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CLASES_DE_FALLO,
  ESTADOS_DE_DIRECTO,
  NATURALEZA_DEL_ESTADO,
  admiteReintentoAutomatico,
  cartelDelEstado,
  clasificarFalloDeCredencial,
  decidirEstadoDeDirecto,
  esDefinitivo,
  hayEmisionEnMarcha,
  pideAccionDeLaPersona,
  vistaInicialDeDirecto,
  type ClaseDeFallo,
  type EntradaDeDirecto,
  type EstadoDeDirecto,
} from './maquinaDeDirecto.ts';
import { es } from '../i18n/es.ts';

/**
 * LOS CATORCE ESTADOS DE UN DIRECTO, uno a uno.
 *
 * POR QUE HACIA FALTA ESTO. Casi todos son estados de EXCEPCION: permiso
 * denegado, proveedor caido, red que se va, emision que termina mientras la
 * miras, credencial limitada por ritmo. Ninguno se puede provocar a mano en un
 * telefono, asi que escritos dentro de un componente no se comprueban nunca.
 * Se veria «funciona» y se entregaria una pantalla que se rompe en el unico
 * momento en que importa.
 *
 * Lo que se prueba, en orden de gravedad:
 *
 *  1. Que la traduccion de codigos HTTP a clases del dominio distinga lo que
 *     tiene arreglo de lo que no.
 *  2. Que CADA uno de los catorce estados se alcance de verdad.
 *  3. Que el ORDEN de las preguntas sea el que es: una emision terminada gana a
 *     una red caida, y el servidor se pregunta ANTES que los permisos.
 *  4. Que recuperable y definitivo no se mezclen.
 */

/** Una entrada valida por defecto: emision en directo, todo bien. */
function entrada(cambios: Partial<EntradaDeDirecto> = {}): EntradaDeDirecto {
  return {
    sesion: 'live',
    credencial: { estado: 'lista', puedePublicar: false, hayVideo: true },
    permisoCamara: 'noHaceFalta',
    permisoMicrofono: 'noHaceFalta',
    conexion: 'conectado',
    hayMedios: true,
    quedanReintentos: false,
    ...cambios,
  };
}

const conFallo = (clase: ClaseDeFallo): Partial<EntradaDeDirecto> => ({
  credencial: { estado: 'fallo', fallo: { clase } },
});

/* ---------------------------------------------------------- Clasificacion -- */

describe('traducir el fallo del servidor a una clase del dominio', () => {
  it('el codigo del backend manda sobre el estado HTTP', () => {
    /*
      Los dos motivos de «no hay proveedor» llegan como 503, igual que llegaria
      una caida del propio servidor. Sin mirar el codigo primero, un despliegue
      en curso se anunciaria como «no hay proveedor de video» —que suena
      definitivo y corta los reintentos— en vez de recuperarse solo.
    */
    assert.equal(
      clasificarFalloDeCredencial({ status: 503, code: 'live_provider_not_configured' }).clase,
      'sin_proveedor',
    );
    assert.equal(
      clasificarFalloDeCredencial({ status: 503, code: 'live_provider_missing' }).clase,
      'sin_proveedor',
    );
    assert.equal(
      clasificarFalloDeCredencial({ status: 409, code: 'live_not_joinable' }).clase,
      'no_unible',
    );
    assert.equal(
      clasificarFalloDeCredencial({ status: 429, code: 'live_credential_rate_limited' }).clase,
      'limitado',
    );
  });

  it('los estados que el backend documenta caen donde tienen que caer', () => {
    const esperado: Array<[number, ClaseDeFallo]> = [
      [401, 'sin_permiso'],
      [403, 'sin_permiso'],
      [404, 'no_unible'],
      [409, 'no_unible'],
      [429, 'limitado'],
      [503, 'sin_proveedor'],
    ];
    for (const [status, clase] of esperado) {
      assert.equal(clasificarFalloDeCredencial({ status }).clase, clase, `HTTP ${status}`);
    }
  });

  it('sin respuesta del servidor es RED, y la red se reintenta', () => {
    // Un `status` que no existe no se puede comparar con ningun rango: si esto
    // no fuera lo primero que se mira, un corte de red caeria en `desconocido`.
    for (const nada of [0, undefined, null, Number.NaN]) {
      assert.equal(
        clasificarFalloDeCredencial({ status: nada as number | null | undefined }).clase,
        'red',
      );
    }
  });

  it('un 500 es red y no «desconocido»', () => {
    // Es un fallo del servidor, no del contrato, y esos se pasan solos.
    assert.equal(clasificarFalloDeCredencial({ status: 500 }).clase, 'red');
    assert.equal(clasificarFalloDeCredencial({ status: 502 }).clase, 'red');
  });

  it('lo que no encaja en nada es «desconocido»', () => {
    assert.equal(clasificarFalloDeCredencial({ status: 400 }).clase, 'desconocido');
    assert.equal(clasificarFalloDeCredencial({ status: 422 }).clase, 'desconocido');
    assert.equal(clasificarFalloDeCredencial({ status: 418, code: 'te' }).clase, 'desconocido');
  });

  it('la espera sugerida viaja con el fallo, y solo si es un numero', () => {
    assert.equal(
      clasificarFalloDeCredencial({ status: 429, esperaSugeridaMs: 9000 }).esperaSugeridaMs,
      9000,
    );
    assert.equal(
      'esperaSugeridaMs' in clasificarFalloDeCredencial({ status: 429, esperaSugeridaMs: null }),
      false,
    );
  });
});

/* --------------------------------------------------------------- Estados --- */

describe('cada uno de los catorce estados se alcanza', () => {
  /** El camino minimo hasta cada estado. Es la tabla que documenta la maquina. */
  const CAMINOS: Array<[EstadoDeDirecto, Partial<EntradaDeDirecto>]> = [
    ['conectando', { credencial: { estado: 'pendiente' } }],
    ['conectado', { hayMedios: false }],
    ['reconectando', { conexion: 'reconectando' }],
    ['programado', { sesion: 'scheduled' }],
    ['en_directo', {}],
    ['terminado', { sesion: 'ended' }],
    ['cancelado', { sesion: 'cancelled' }],
    ['acceso_denegado', conFallo('sin_permiso')],
    ['proveedor_no_configurado', conFallo('sin_proveedor')],
    [
      'permiso_camara_denegado',
      {
        credencial: { estado: 'lista', puedePublicar: true, hayVideo: true },
        permisoCamara: 'denegado',
      },
    ],
    [
      'permiso_microfono_denegado',
      {
        credencial: { estado: 'lista', puedePublicar: true, hayVideo: true },
        permisoCamara: 'concedido',
        permisoMicrofono: 'denegado',
      },
    ],
    ['conexion_lenta', { conexion: 'lenta' }],
    ['error_recuperable', { ...conFallo('red'), quedanReintentos: true }],
    ['error_definitivo', { ...conFallo('red'), quedanReintentos: false }],
  ];

  for (const [esperado, cambios] of CAMINOS) {
    it(`\`${esperado}\``, () => {
      assert.equal(decidirEstadoDeDirecto(entrada(cambios)), esperado);
    });
  }

  it('la tabla de arriba cubre los catorce, sin repetir ni olvidar ninguno', () => {
    // Si mañana se añade un estado y nadie escribe su camino, esto falla. Sin
    // esta comprobacion, un estado nuevo podria no ser alcanzable jamas.
    const cubiertos = CAMINOS.map(([estado]) => estado);
    assert.equal(new Set(cubiertos).size, cubiertos.length, 'hay caminos repetidos');
    assert.deepEqual([...cubiertos].sort(), [...ESTADOS_DE_DIRECTO].sort());
  });
});

describe('el orden de las preguntas, que ES la regla', () => {
  it('una emision CANCELADA gana a cualquier otra cosa', () => {
    const todoMal = entrada({
      sesion: 'cancelled',
      ...conFallo('red'),
      permisoCamara: 'denegado',
      conexion: 'perdida',
      quedanReintentos: true,
    });
    assert.equal(decidirEstadoDeDirecto(todoMal), 'cancelado');
  });

  it('una emision TERMINADA gana a un error de red reintentable', () => {
    /*
      El fallo que esto impide: con la red caida y la emision ya cerrada, la
      pantalla decia «reintentando» y se pasaba medio minuto llamando a una
      sala que el servidor habia cerrado.
    */
    const entrada1 = entrada({ sesion: 'ended', ...conFallo('red'), quedanReintentos: true });
    assert.equal(decidirEstadoDeDirecto(entrada1), 'terminado');
  });

  it('sin ficha todavia se esta conectando, no hay error', () => {
    assert.equal(decidirEstadoDeDirecto(entrada({ sesion: null })), 'conectando');
  });

  it('PROGRAMADA gana a los permisos: no se pide la camara por algo que no ha empezado', () => {
    const luego = entrada({
      sesion: 'scheduled',
      credencial: { estado: 'lista', puedePublicar: true, hayVideo: true },
      permisoCamara: 'denegado',
    });
    assert.equal(decidirEstadoDeDirecto(luego), 'programado');
  });

  it('EL FALLO DE CREDENCIAL se mira ANTES que los permisos', () => {
    /*
      Es la regla que garantiza el requisito del cliente por construccion:
      preguntar primero al servidor y solo despues por la camara. Al reves, se
      le gastaria a alguien un permiso —que en iOS se concede una sola vez—
      para acabar diciendole que no hay proveedor de video.
    */
    const sinProveedorYSinPermiso = entrada({
      ...conFallo('sin_proveedor'),
      permisoCamara: 'denegado',
      permisoMicrofono: 'denegado',
    });
    assert.equal(decidirEstadoDeDirecto(sinProveedorYSinPermiso), 'proveedor_no_configurado');
  });

  it('un 409 sobre una ficha que aun decia «live»: manda el servidor', () => {
    // La ficha es una foto de hace unos segundos; el 409 es de ahora.
    assert.equal(decidirEstadoDeDirecto(entrada(conFallo('no_unible'))), 'terminado');
  });

  it('la camara se pregunta antes que el microfono', () => {
    const losDos = entrada({
      credencial: { estado: 'lista', puedePublicar: true, hayVideo: true },
      permisoCamara: 'denegado',
      permisoMicrofono: 'denegado',
    });
    assert.equal(decidirEstadoDeDirecto(losDos), 'permiso_camara_denegado');
  });

  it('«conexion lenta» gana a «en directo»: se ve, pero hay que decirlo', () => {
    assert.equal(decidirEstadoDeDirecto(entrada({ conexion: 'lenta', hayMedios: true })), 'conexion_lenta');
  });
});

describe('QUIEN SOLO MIRA NO ACABA NUNCA EN UN ESTADO DE PERMISOS', () => {
  it('con `puedePublicar` en false, un permiso denegado se ignora por completo', () => {
    /*
      Requisito explicito del cliente. Aqui esta cumplido por CONSTRUCCION y no
      por un `if` en la pantalla: aunque alguien llegara a marcar los permisos
      como denegados para un espectador —por un estado mal reseteado, por
      ejemplo—, la maquina no puede pintarselos.
    */
    const espectador = entrada({
      credencial: { estado: 'lista', puedePublicar: false, hayVideo: true },
      permisoCamara: 'denegado',
      permisoMicrofono: 'denegado',
    });
    assert.equal(decidirEstadoDeDirecto(espectador), 'en_directo');
  });

  it('ni tampoco en «conectando» por un permiso pendiente ajeno', () => {
    const espectador = entrada({
      credencial: { estado: 'lista', puedePublicar: false, hayVideo: true },
      permisoCamara: 'pendiente',
      permisoMicrofono: 'pendiente',
      hayMedios: false,
    });
    assert.equal(decidirEstadoDeDirecto(espectador), 'conectado');
  });
});

describe('un 200 sin video es lo mismo que un 503', () => {
  it('`hayVideo: false` es «proveedor no configurado»', () => {
    // Es la respuesta normal del backend con la bandera apagada: 200 con
    // `provider: "none"`. Para quien mira significa exactamente lo mismo.
    const sinVideo = entrada({ credencial: { estado: 'lista', puedePublicar: false, hayVideo: false } });
    assert.equal(decidirEstadoDeDirecto(sinVideo), 'proveedor_no_configurado');
    assert.equal(decidirEstadoDeDirecto(entrada(conFallo('sin_proveedor'))), 'proveedor_no_configurado');
  });
});

describe('recuperable contra definitivo', () => {
  it('los mismos datos dan un estado u otro segun queden reintentos', () => {
    for (const clase of ['limitado', 'red', 'desconocido'] as const) {
      assert.equal(
        decidirEstadoDeDirecto(entrada({ ...conFallo(clase), quedanReintentos: true })),
        'error_recuperable',
        clase,
      );
      assert.equal(
        decidirEstadoDeDirecto(entrada({ ...conFallo(clase), quedanReintentos: false })),
        'error_definitivo',
        clase,
      );
    }
  });

  it('las tres clases definitivas NO cambian aunque queden reintentos', () => {
    // Es la mitad del contrato «un error definitivo no se reintenta»: ni
    // siquiera se pinta como reintentable.
    const definitivas: Array<[ClaseDeFallo, EstadoDeDirecto]> = [
      ['sin_proveedor', 'proveedor_no_configurado'],
      ['sin_permiso', 'acceso_denegado'],
      ['no_unible', 'terminado'],
    ];
    for (const [clase, esperado] of definitivas) {
      assert.equal(
        decidirEstadoDeDirecto(entrada({ ...conFallo(clase), quedanReintentos: true })),
        esperado,
        clase,
      );
      assert.equal(esDefinitivo(esperado), true, `${esperado} deberia ser definitivo`);
    }
  });

  it('una conexion perdida sigue la misma regla', () => {
    assert.equal(
      decidirEstadoDeDirecto(entrada({ conexion: 'perdida', quedanReintentos: true })),
      'error_recuperable',
    );
    assert.equal(
      decidirEstadoDeDirecto(entrada({ conexion: 'perdida', quedanReintentos: false })),
      'error_definitivo',
    );
  });

  it('DE UN ESTADO DEFINITIVO NO SE SALE REINTENTANDO SOLO', () => {
    for (const estado of ESTADOS_DE_DIRECTO) {
      if (!esDefinitivo(estado)) continue;
      assert.equal(admiteReintentoAutomatico(estado), false, estado);
      assert.equal(pideAccionDeLaPersona(estado), false, estado);
    }
  });

  it('los permisos denegados NO son definitivos, pero tampoco se reintentan', () => {
    // Cambiarlos en los ajustes arregla la pantalla sin salir de ella; volver a
    // pedirlos por codigo no hace absolutamente nada (ver `estadoDePermiso.ts`).
    for (const estado of ['permiso_camara_denegado', 'permiso_microfono_denegado'] as const) {
      assert.equal(esDefinitivo(estado), false);
      assert.equal(admiteReintentoAutomatico(estado), false);
      assert.equal(pideAccionDeLaPersona(estado), true);
    }
  });

  it('solo `error_recuperable` se reintenta solo', () => {
    const reintentables = ESTADOS_DE_DIRECTO.filter(admiteReintentoAutomatico);
    assert.deepEqual([...reintentables], ['error_recuperable']);
  });

  it('hay emision en marcha exactamente cuando se esta viendo algo', () => {
    const enMarcha = ESTADOS_DE_DIRECTO.filter(hayEmisionEnMarcha);
    assert.deepEqual([...enMarcha].sort(), ['conexion_lenta', 'en_directo']);
  });
});

/* -------------------------------------------------------- Naturaleza y i18n */

describe('la tabla de naturalezas y los textos', () => {
  it('los catorce estados tienen naturaleza declarada, y ninguna sobra', () => {
    assert.deepEqual(Object.keys(NATURALEZA_DEL_ESTADO).sort(), [...ESTADOS_DE_DIRECTO].sort());
  });

  it('cada estado tiene cartel, y sus claves EXISTEN en `i18n/es.ts`', () => {
    /*
      Cruce de verdad entre dos ficheros que no se pueden importar entre si: la
      maquina devuelve claves como texto plano —no puede importar el
      diccionario sin dejar de ejecutarse con `node --test`— y aqui se
      comprueba que esas claves existen. Sin esto, una clave mal escrita se
      pintaria tal cual en pantalla: «live.slowTitle» encima de un directo.
    */
    const diccionario = es as unknown as Record<string, string>;
    const faltan: string[] = [];
    for (const estado of ESTADOS_DE_DIRECTO) {
      for (const esAnfitrion of [false, true]) {
        const cartel = cartelDelEstado(estado, esAnfitrion);
        for (const clave of [cartel.titulo, cartel.cuerpo]) {
          if (!(clave in diccionario)) faltan.push(`${estado}/${clave}`);
        }
        assert.ok(cartel.icono.length > 0, `${estado} sin icono`);
      }
    }
    assert.deepEqual(faltan, [], `claves que no existen: ${faltan.join(', ')}`);
  });

  it('quien emite y quien mira leen cosas distintas cuando lo son', () => {
    // Misma situacion tecnica, dos personas que la viven de forma opuesta.
    // Darle a quien emite el texto del espectador lo deja esperandose a si mismo.
    const anfitrion = cartelDelEstado('conectado', true);
    const espectador = cartelDelEstado('conectado', false);
    assert.notEqual(anfitrion.titulo, espectador.titulo);
    assert.notEqual(anfitrion.cuerpo, espectador.cuerpo);
  });

  it('las clases de fallo son seis y no se repiten', () => {
    assert.equal(new Set(CLASES_DE_FALLO).size, CLASES_DE_FALLO.length);
    assert.equal(CLASES_DE_FALLO.length, 6);
  });
});

describe('la vista de antes de arrancar', () => {
  it('no promete nada: ni camara, ni microfono, ni permiso de publicar', () => {
    const vista = vistaInicialDeDirecto('live');
    assert.deepEqual(vista, {
      estado: 'conectando',
      camara: false,
      microfono: false,
      camaraFrontal: true,
      puedePublicar: false,
      ocupado: false,
      intentos: 0,
    });
  });

  it('respeta el estado que ya se conozca de la sesion', () => {
    assert.equal(vistaInicialDeDirecto(null).estado, 'conectando');
    assert.equal(vistaInicialDeDirecto('scheduled').estado, 'programado');
    assert.equal(vistaInicialDeDirecto('ended').estado, 'terminado');
    assert.equal(vistaInicialDeDirecto('cancelled').estado, 'cancelado');
  });
});
