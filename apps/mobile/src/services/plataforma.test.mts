/**
 * `GET /platform/config`, visto desde el teléfono: si ESTA persona puede usar
 * Z Servicios (el piloto, política P101).
 *
 * Lo que aquí no puede romperse sin que nadie se entere:
 *  - la pregunta va CON la sesión (el servidor contesta para esa persona), y
 *    la respuesta es un sí o un no: nunca una lista;
 *  - se pregunta una vez por persona, y OTRA persona vuelve a preguntar: lo
 *    que valía para la cuenta anterior no se hereda;
 *  - ante la duda, `false`: un fallo no enseña Servicios, y no se guarda;
 *  - una respuesta que llega tarde, de la cuenta anterior, no pisa la actual;
 *  - administración es OTRA respuesta, por el rol: no depende del piloto;
 *  - con sesión y sin perfil cargado no se pregunta como «nadie».
 */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { describe, it } from 'node:test';

type Peticion = { ruta: string; opciones: { auth?: boolean } | undefined };
type Respuesta = { publicacion_flexible?: unknown; feature_services?: unknown; feature_services_admin?: unknown };

const peticiones: Peticion[] = [];
let responder: (peticion: Peticion) => Promise<Respuesta> = async () => ({});

(globalThis as Record<string, unknown>).__apiDePrueba = (ruta: string, opciones?: { auth?: boolean }) => {
  const peticion = { ruta, opciones };
  peticiones.push(peticion);
  return responder(peticion);
};

/*
  `plataforma.ts` importa `apiRequest` de `@/services/api`, que arrastra el
  cliente HTTP entero. Aquí se sustituye por uno de prueba que apunta lo que
  se pide: es maquinaria de la prueba, no del producto.
*/
const API_DE_PRUEBA =
  'data:text/javascript,' +
  encodeURIComponent(
    "export const API_V1 = '/api/v1';" +
      'export function apiRequest(ruta, opciones) { return globalThis.__apiDePrueba(ruta, opciones); }',
  );

registerHooks({
  resolve(especificador, contexto, siguiente) {
    if (especificador === '@/services/api') return { url: API_DE_PRUEBA, shortCircuit: true };
    return siguiente(especificador, contexto);
  },
});

const P = await import('./plataforma.ts');

const si = async (): Promise<Respuesta> => ({ publicacion_flexible: true, feature_services: true });
const no = async (): Promise<Respuesta> => ({ publicacion_flexible: true, feature_services: false });

describe('si esta persona puede usar Z Servicios', () => {
  it('pregunta con la sesión, una vez por persona, y solo recibe un sí o un no', async () => {
    peticiones.length = 0;
    responder = si;
    assert.equal(await P.serviciosEncendido('ana'), true);
    assert.equal(await P.serviciosEncendido('ana'), true);
    assert.equal(peticiones.length, 1);
    assert.equal(peticiones[0]?.ruta, '/api/v1/platform/config');
    // SIN `auth: false`: el token viaja, y el servidor contesta para ella.
    assert.notEqual(peticiones[0]?.opciones?.auth, false);
  });

  it('otra persona vuelve a preguntar: lo de la cuenta anterior no se hereda', async () => {
    peticiones.length = 0;
    responder = no;
    assert.equal(await P.serviciosEncendido('beto'), false);
    assert.equal(peticiones.length, 1);
    // Sin sesión es otra «persona» más: se pregunta, y vale lo que diga el servidor.
    assert.equal(await P.serviciosEncendido(null), false);
    assert.equal(peticiones.length, 2);
    // Y al volver la primera, se pregunta otra vez.
    responder = si;
    assert.equal(await P.serviciosEncendido('ana'), true);
    assert.equal(peticiones.length, 3);
  });

  it('solo `true` literal enciende: un servidor viejo, o una respuesta rara, es que no', async () => {
    for (const [quien, dto] of [
      ['c1', {}],
      ['c2', { feature_services: 'true' }],
      ['c3', { feature_services: 1 }],
      ['c4', { feature_services: null }],
      ['c5', { feature_services: ['ana', 'beto'] }],
    ] as [string, Respuesta][]) {
      responder = async () => dto;
      assert.equal(await P.serviciosEncendido(quien), false, quien);
    }
  });

  it('un fallo es que no, y no se guarda: la siguiente pantalla vuelve a preguntar', async () => {
    peticiones.length = 0;
    responder = async () => {
      throw new Error('sin cobertura');
    };
    assert.equal(await P.serviciosEncendido('dora'), false);
    responder = si;
    assert.equal(await P.serviciosEncendido('dora'), true);
    assert.equal(peticiones.length, 2);
  });

  it('una respuesta tardía de la cuenta anterior no pisa la de la actual', async () => {
    peticiones.length = 0;
    let fallarLaVieja: (motivo: Error) => void = () => undefined;
    responder = () =>
      new Promise<Respuesta>((_, rechazar) => {
        fallarLaVieja = rechazar;
      });
    const vieja = P.serviciosEncendido('eva');
    responder = si;
    assert.equal(await P.serviciosEncendido('fran'), true);
    // La de Eva falla DESPUÉS de que Fran ya tenga la suya.
    fallarLaVieja(new Error('tarde'));
    assert.equal(await vieja, false);
    assert.equal(await P.serviciosEncendido('fran'), true);
    assert.equal(peticiones.length, 2);
  });

  it('el modo flexible es del servidor: usa lo último preguntado, sin otra petición', async () => {
    peticiones.length = 0;
    responder = si;
    assert.equal(await P.serviciosEncendido('gema'), true);
    assert.equal(await P.publicacionFlexible(), true);
    assert.equal(peticiones.length, 1);
  });
});

describe('si a esta persona le toca administrar Z Servicios', () => {
  it('es otra respuesta: una administradora de fuera del piloto ve su sección', async () => {
    peticiones.length = 0;
    responder = async () => ({ feature_services: false, feature_services_admin: true });
    assert.equal(await P.serviciosDeAdministracion('jefa'), true);
    assert.equal(await P.serviciosEncendido('jefa'), false);
    // Y una participante sin rol, al revés. Las dos salen de UNA petición por persona.
    responder = async () => ({ feature_services: true, feature_services_admin: false });
    assert.equal(await P.serviciosEncendido('pili'), true);
    assert.equal(await P.serviciosDeAdministracion('pili'), false);
    assert.equal(peticiones.length, 2);
  });

  it('solo `true` literal, y un fallo es que no', async () => {
    for (const [quien, dto] of [
      ['a1', {}],
      ['a2', { feature_services: true }],
      ['a3', { feature_services_admin: 'admin' }],
      ['a4', { feature_services_admin: 1 }],
    ] as [string, Respuesta][]) {
      responder = async () => dto;
      assert.equal(await P.serviciosDeAdministracion(quien), false, quien);
    }
    responder = async () => {
      throw new Error('sin cobertura');
    };
    assert.equal(await P.serviciosDeAdministracion('a5'), false);
  });
});

describe('para quién se pregunta', () => {
  it('el perfil; sin él, si hay sesión; y si no, nadie', () => {
    assert.equal(P.quienPregunta('ana', true), 'ana');
    assert.equal(P.quienPregunta('ana', false), 'ana');
    assert.equal(P.quienPregunta(null, false), null);
    assert.notEqual(P.quienPregunta(null, true), null);
  });

  it('una sesión sin perfil cargado no deja su respuesta a quien no tiene sesión', async () => {
    peticiones.length = 0;
    // El perfil no cargó, pero el token es de una participante: el servidor dice que sí.
    responder = si;
    assert.equal(await P.serviciosEncendido(P.quienPregunta(null, true)), true);
    // Sale. Sigue sin perfil, pero ya sin sesión: se pregunta otra vez.
    responder = no;
    assert.equal(await P.serviciosEncendido(P.quienPregunta(null, false)), false);
    assert.equal(peticiones.length, 2);
  });
});

describe('videos de publicaciones en S3 (opción B)', () => {
  it('por persona, y solo `true` literal enciende: un servidor viejo es que no', async () => {
    for (const [quien, dto, subida, lectura] of [
      ['m1', {}, false, false],
      ['m2', { medios_s3_subida: true, medios_s3_lectura: true }, true, true],
      ['m3', { medios_s3_subida: 'true', medios_s3_lectura: 1 }, false, false],
      ['m4', { medios_s3_lectura: true }, false, true],
    ] as [string, Record<string, unknown>, boolean, boolean][]) {
      responder = async () => dto as Respuesta;
      assert.equal(await P.mediosS3Subida(quien), subida, quien);
      assert.equal(await P.mediosS3Lectura(quien), lectura, quien);
    }
  });

  it('un fallo es que no: se sube a Supabase como siempre', async () => {
    responder = async () => {
      throw new Error('sin cobertura');
    };
    assert.equal(await P.mediosS3Subida('m5'), false);
  });

  it('sale de la misma pregunta que Servicios: ni una petición más', async () => {
    peticiones.length = 0;
    responder = async () => ({ feature_services: true, medios_s3_subida: true }) as Respuesta;
    assert.equal(await P.serviciosEncendido('m6'), true);
    assert.equal(await P.mediosS3Subida('m6'), true);
    assert.equal(peticiones.length, 1);
  });
});
