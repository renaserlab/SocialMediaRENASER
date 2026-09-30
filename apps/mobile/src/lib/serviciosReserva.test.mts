/**
 * Z Servicios, Incremento 5: la lógica pura de la reserva, contra el servidor.
 *
 * Lo que aquí no puede desalinearse sin que nadie se entere:
 *  - los VALORES CERRADOS (estados, sucesos, bloqueos, aceptaciones) y los
 *    LARGOS son los del servidor, leídos de su código fuente;
 *  - cada CÓDIGO de error de la reserva tiene su texto, y ninguno es inventado;
 *  - cada CLAVE que arma esta lógica existe en los tres idiomas, con los
 *    mismos huecos;
 *  - la CUENTA ATRÁS sale de los segundos del servidor, no del reloj del
 *    teléfono;
 *  - lo que se manda al confirmar es SOLO lo necesario: sin dirección fuera
 *    de «a domicilio», con la versión y la huella de lo aceptado;
 *  - la nota y la dirección NUNCA viajan en la ruta.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { es } from '../i18n/es.ts';
import { en } from '../i18n/en.ts';
import { pt } from '../i18n/pt.ts';
import type { Resumen } from './serviciosReserva.ts';

registerHooks({
  resolve(especificador, contexto, siguiente) {
    if (especificador.startsWith('@/')) {
      return { url: new URL(`../${especificador.slice(2)}.ts`, import.meta.url).href, shortCircuit: true };
    }
    return siguiente(especificador, contexto);
  },
});

const R = await import('./serviciosReserva.ts');

const API = join(import.meta.dirname, '..', '..', '..', 'api', 'app', 'modules', 'services');
const servidor = (fichero: string) => readFileSync(join(API, fichero), 'utf8').replace(/\r\n/g, '\n');
const MODELOS = servidor('reserva_models.py');
const POLITICA = servidor('reserva_politica.py');
const ESQUEMAS = servidor('reserva_schemas.py');
const DICCIONARIOS = { es, en, pt } as Record<string, Record<string, string | undefined>>;

/** Las constantes `NOMBRE = "valor"` de un fichero de Python. */
function constantes(fuente: string): Map<string, string> {
  return new Map([...fuente.matchAll(/^([A-Z_]+) = "([a-z_]+)"$/gm)].map((m) => [m[1] as string, m[2] as string]));
}

/** Una tupla escrita con constantes: `NOMBRE = (A, B, ...)`. */
function tuplaDeConstantes(fuente: string, nombre: string): string[] {
  const valores = constantes(fuente);
  const desde = fuente.indexOf(`${nombre} = (`);
  assert.ok(desde >= 0, `no encontré ${nombre}`);
  const bloque = fuente.slice(desde + nombre.length + 4, fuente.indexOf(')', desde));
  return bloque
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => valores.get(x) ?? x.replace(/"/g, ''));
}

function huecos(texto: string): string[] {
  return [...texto.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string).sort();
}

function existeEnLosTres(clave: string): void {
  const base = es[clave as keyof typeof es] as string | undefined;
  assert.ok(base, `falta «${clave}» en es`);
  for (const [idioma, dic] of Object.entries(DICCIONARIOS)) {
    const texto = dic[clave];
    assert.ok(texto, `falta «${clave}» en ${idioma}`);
    assert.deepEqual(huecos(texto), huecos(base), `${clave}: huecos distintos en ${idioma}`);
  }
}

function resumen(cambios: Partial<Resumen> = {}): Resumen {
  return {
    hold: {
      id: 'h1', service_id: 's1', status: 'active', starts_at: '2026-10-05T15:00:00Z', ends_at: '2026-10-05T16:00:00Z',
      date: '2026-10-05', time: '10:00', end_time: '11:00', utc_offset: '-05:00', timezone: 'America/Lima',
      modality: 'virtual', expires_at: '2026-10-01T10:10:00Z', server_now: '2026-10-01T10:00:00Z', seconds_left: 600,
      booking_id: null,
    },
    service: {
      id: 's1', version_id: 'v1', title: 'Clase', modality: 'virtual', duration_minutes: 60, location_area: null,
      provider_name: 'Ana', price: { model: 'free', amount_minor: null, currency: null },
    },
    contract: {
      kind: 'free', confirmable: true, payments_available: false, provider_confirmation_required: false,
      version_changed: false, terms_available: true, blockers: [],
    },
    terms: { policy_id: 'p1', version: 3, title: 'Condiciones', body: 'Texto', sha256: 'a'.repeat(64) },
    service_conditions: null,
    requires_address: false,
    limits: { note_max_length: 500, district_max_length: 100, address_max_length: 200, reference_max_length: 200 },
    ...cambios,
  };
}

// =========================================================================== //
describe('los valores cerrados son los del servidor', () => {
  it('estados de la retención y sucesos del historial', () => {
    assert.deepEqual([...R.ESTADOS_DE_LA_RETENCION], tuplaDeConstantes(MODELOS, 'ESTADOS_DE_RETENCION'));
    assert.deepEqual([...R.SUCESOS_DE_LA_RESERVA], tuplaDeConstantes(MODELOS, 'ACCIONES'));
    assert.deepEqual(tuplaDeConstantes(MODELOS, 'TIPOS_DE_ACEPTACION'), ['booking_terms', 'service_conditions']);
  });

  it('cada bloqueo que puede mandar el resumen tiene su texto', () => {
    // `hold_{estado}` para cada estado que no es activo, y los demás, literales.
    const esperados = new Set<string>(
      R.ESTADOS_DE_LA_RETENCION.filter((e) => e !== 'active').map((e) => `hold_${e}`),
    );
    for (const m of ESQUEMAS.matchAll(/bloqueos\.append\("([a-z_]+)"\)/g)) esperados.add(m[1] as string);
    // `bloqueos.append(r.forma)` solo con «a consultar» y «desde».
    assert.match(ESQUEMAS, /if r\.forma in \(dominio\.CONTRATA_A_CONSULTAR, dominio\.CONTRATA_PRECIO_ABIERTO\):\s*bloqueos\.append\(r\.forma\)/);
    esperados.add('quote_required');
    esperados.add('price_not_closed');
    assert.deepEqual([...esperados].sort(), [...R.BLOQUEOS].sort());
    for (const b of R.BLOQUEOS) existeEnLosTres(R.claveDelBloqueo(b) as string);
    // Uno nuevo no se imprime crudo: no tiene clave y la vista lo calla.
    assert.equal(R.claveDelBloqueo('algo_nuevo'), null);
  });

  it('los largos del formulario son los de `reserva_politica.py`', () => {
    assert.match(POLITICA, new RegExp(`^NOTA_MAXIMA = ${R.LARGOS_DE_LA_CONTRATACION.nota}$`, 'm'));
    assert.match(POLITICA, new RegExp(`^DISTRITO_MAXIMO = ${R.LARGOS_DE_LA_CONTRATACION.distrito}$`, 'm'));
    assert.match(POLITICA, new RegExp(`^DIRECCION_MAXIMA = ${R.LARGOS_DE_LA_CONTRATACION.direccion}$`, 'm'));
    assert.match(POLITICA, new RegExp(`^REFERENCIA_MAXIMA = ${R.LARGOS_DE_LA_CONTRATACION.referencia}$`, 'm'));
  });

  it('solo se contrata lo gratuito; lo demás lo dice el servidor', () => {
    assert.deepEqual(tuplaDeConstantes(MODELOS, 'CONTRATABLES'), ['free']);
    assert.deepEqual([...R.FORMAS_DE_CONTRATAR].sort(), ['free', 'paid', 'price_not_closed', 'quote_required']);
  });
});

// =========================================================================== //
describe('ningún código de la reserva llega crudo a la pantalla', () => {
  const codigos = new Set<string>();
  for (const fichero of ['reserva.py', 'reserva_router.py']) {
    for (const m of servidor(fichero).matchAll(/\bcode ?= ?"([a-z_]+)"/g)) codigos.add(m[1] as string);
  }
  const esquema = servidor('esquema.py');
  const desdeLaReserva = esquema.slice(esquema.indexOf('class ReservaApagada'));
  for (const m of desdeLaReserva.matchAll(/\bcode ?= ?"([a-z_]+)"/g)) codigos.add(m[1] as string);

  it('cada código del servidor tiene su texto, y ninguno del teléfono es inventado', () => {
    assert.ok(codigos.size >= 22, `solo ${codigos.size} códigos leídos`);
    const sinTexto = [...codigos].filter((c) => R.claveDeErrorDeLaReserva(c) === null);
    assert.deepEqual(sinTexto, [], `sin texto en el teléfono: ${sinTexto.join(', ')}`);
    const inventados = R.CODIGOS_DE_ERROR_DE_LA_RESERVA.filter((c) => !codigos.has(c));
    assert.deepEqual(inventados, []);
  });

  it('cada texto de error existe en los tres idiomas, con los mismos huecos', () => {
    for (const c of R.CODIGOS_DE_ERROR_DE_LA_RESERVA) existeEnLosTres(R.claveDeErrorDeLaReserva(c) as string);
  });

  it('un código desconocido no se traduce a nada (cae en el texto por estado)', () => {
    assert.equal(R.claveDeErrorDeLaReserva('algo_nuevo'), null);
    assert.equal(R.claveDeErrorDeLaReserva(null), null);
  });

  it('tras un 409 que invalida lo apartado, se vuelve a elegir; tras otros, no', () => {
    for (const c of [
      'service_slot_not_available', 'service_hold_expired', 'service_hold_not_active',
      'service_booking_version_changed', 'service_booking_service_unavailable',
    ]) {
      assert.ok(codigos.has(c), c);
      assert.ok(R.hayQueVolverAElegir(c), c);
    }
    for (const c of ['service_booking_terms_changed', 'service_booking_payments_not_configured', 'service_booking_busy', null]) {
      assert.equal(R.hayQueVolverAElegir(c), false, String(c));
    }
  });
});

// =========================================================================== //
describe('cada clave que produce esta lógica existe', () => {
  it('estados, sucesos, aceptaciones y ámbitos', () => {
    for (const e of [...R.ESTADOS_DE_LA_RETENCION, 'raro', null]) existeEnLosTres(R.claveDelEstadoDeLaRetencion(e));
    for (const s of [...R.SUCESOS_DE_LA_RESERVA, 'raro']) existeEnLosTres(R.claveDelSuceso(s));
    for (const a of ['booking_terms', 'service_conditions']) existeEnLosTres(R.claveDeLaAceptacion(a));
    for (const a of R.AMBITOS_DE_RESERVAS) existeEnLosTres(`servicios.reserva.ambito.${a}`);
    for (const v of ['bookings', 'holds']) existeEnLosTres(`servicios.reserva.admin.vista.${v}`);
    assert.equal(R.claveDelSuceso('raro'), 'servicios.reserva.suceso.otro');
    assert.equal(R.claveDelEstadoDeLaRetencion('raro'), 'servicios.reserva.retencion.desconocido');
  });

  it('las claves de la reserva tienen los mismos huecos en los tres idiomas', () => {
    const claves = Object.keys(es).filter((k) => k.startsWith('servicios.reserva.') || k.startsWith('notif.servicioReserva'));
    assert.ok(claves.length >= 120, `solo ${claves.length}`);
    for (const c of claves) existeEnLosTres(c);
  });

  it('«elegido», «apartado» y «reservado» son tres palabras distintas', () => {
    for (const [idioma, dic] of Object.entries(DICCIONARIOS)) {
      const elegido = dic['servicios.reserva.elegidoNoApartado'] as string;
      const apartado = dic['servicios.reserva.apartadoNoReservado'] as string;
      assert.notEqual(elegido, apartado, idioma);
      assert.notEqual(dic['servicios.reserva.retencion.active'], dic['servicios.reserva.retencion.consumed'], idioma);
    }
    // En español, lo apartado NUNCA se llama reserva.
    assert.ok(!/reservad/i.test(es['servicios.reserva.retencion.active']));
    assert.ok(!/reservad/i.test(es['servicios.reserva.continuar']));
    assert.ok(!/reservad/i.test(es['servicios.reserva.elegidoNoApartado']));
  });
});

// =========================================================================== //
describe('la cuenta atrás es la del SERVIDOR', () => {
  const activa = { status: 'active', seconds_left: 600 };

  it('resta solo lo que ha pasado desde que llegó la respuesta', () => {
    assert.equal(R.segundosRestantes(activa, 1_000_000, 1_000_000), 600);
    assert.equal(R.segundosRestantes(activa, 1_000_000, 1_000_000 + 61_500), 539);
    assert.equal(R.segundosRestantes(activa, 1_000_000, 1_000_000 + 600_000), 0);
    assert.equal(R.segundosRestantes(activa, 1_000_000, 1_000_000 + 9_999_999), 0);
  });

  it('un teléfono con la hora mal no cambia nada: solo cuenta lo transcurrido', () => {
    // El mismo transcurso con relojes de años distintos da lo mismo.
    const hoy = Date.UTC(2026, 9, 1);
    const hace10Anos = Date.UTC(2016, 9, 1);
    assert.equal(R.segundosRestantes(activa, hoy, hoy + 30_000), R.segundosRestantes(activa, hace10Anos, hace10Anos + 30_000));
    // Un reloj que va hacia atrás no regala tiempo.
    assert.equal(R.segundosRestantes(activa, 1_000_000, 900_000), 600);
  });

  it('lo que no está activo no tiene tiempo', () => {
    for (const status of ['expired', 'released', 'consumed']) {
      assert.equal(R.segundosRestantes({ status, seconds_left: 600 }, 0, 0), 0, status);
    }
  });

  it('«mm:ss», sin negativos', () => {
    assert.equal(R.cuentaAtras(600), '10:00');
    assert.equal(R.cuentaAtras(61), '01:01');
    assert.equal(R.cuentaAtras(0), '00:00');
    assert.equal(R.cuentaAtras(-5), '00:00');
    assert.equal(R.cuentaAtras(9.9), '00:09');
  });

  it('nada en la lógica mira `expires_at` con el reloj del teléfono', () => {
    const fuente = readFileSync(join(import.meta.dirname, 'serviciosReserva.ts'), 'utf8');
    assert.ok(!/new Date\(/.test(fuente));
    assert.ok(!/expires_at\s*[-<>]/.test(fuente));
  });
});

// =========================================================================== //
describe('la casilla «Acepto» es de UNA versión: la que estaba en pantalla', () => {
  // Hallazgo de la revisión del 30/09: la casilla era un «sí» sin versión. Si
  // la empresa publicaba otra mientras tanto, el borrador seguía marcado y se
  // mandaba como aceptada una versión que nadie había visto.
  const v1 = resumen();
  const v2 = resumen({ terms: { policy_id: 'p2', version: 4, title: 'Condiciones', body: 'Otro', sha256: 'c'.repeat(64) } });

  it('marcar guarda la versión y la huella de lo que se ve; desmarcar, nada', () => {
    const marcado = R.alternarAceptacion(v1, R.formularioVacio(), 'z');
    assert.equal(marcado.acepta, `p1:${'a'.repeat(64)}`);
    assert.equal(R.estaAceptado(v1, marcado, 'z'), true);
    assert.equal(R.alternarAceptacion(v1, marcado, 'z').acepta, null);
  });

  it('lo aceptado con la v1 NO confirma la v2: la casilla sale sin marcar y se dice que algo cambió', () => {
    const conV1 = R.alternarAceptacion(v1, R.formularioVacio(), 'z');
    assert.equal(R.estaAceptado(v2, conV1, 'z'), false);
    assert.deepEqual(R.peticionDeConfirmacion(v2, conV1), { peticion: null, fallo: 'servicios.reserva.algoCambio' });
  });

  it('tampoco el borrador que sobrevive a salir y volver (el resumen recargado ya es la v2)', () => {
    R.guardarBorrador('h-v1', R.alternarAceptacion(v1, R.formularioVacio(), 'z'));
    const recuperado = R.borradorDe('h-v1');
    R.olvidarBorrador('h-v1');
    assert.equal(R.peticionDeConfirmacion(v2, recuperado).peticion, null);
  });

  it('ni la misma huella bajo otra versión, ni otra huella bajo la misma versión', () => {
    const conV1 = R.alternarAceptacion(v1, R.formularioVacio(), 'z');
    const mismaHuellaOtraVersion = resumen({ terms: { ...v1.terms!, policy_id: 'p9' } });
    const otraHuellaMismaVersion = resumen({ terms: { ...v1.terms!, sha256: 'd'.repeat(64) } });
    assert.equal(R.peticionDeConfirmacion(mismaHuellaOtraVersion, conV1).peticion, null);
    assert.equal(R.peticionDeConfirmacion(otraHuellaMismaVersion, conV1).peticion, null);
  });

  it('volver a marcar ya viendo la v2 sí confirma, con SU versión y SU huella', () => {
    const conV1 = R.alternarAceptacion(v1, R.formularioVacio(), 'z');
    const conV2 = R.alternarAceptacion(v2, conV1, 'z');
    assert.equal(R.estaAceptado(v2, conV2, 'z'), true);
    assert.deepEqual(R.peticionDeConfirmacion(v2, conV2).peticion, {
      terms_policy_id: 'p2', terms_sha256: 'c'.repeat(64), note: null,
    });
  });

  it('las condiciones del servicio, igual: lo aceptado es su huella', () => {
    const conDelServicio = (sha: string) => resumen({ service_conditions: { text: 'x', sha256: sha } });
    const antes = conDelServicio('e'.repeat(64));
    const despues = conDelServicio('f'.repeat(64));
    let f = R.alternarAceptacion(antes, R.formularioVacio(), 'z');
    f = R.alternarAceptacion(antes, f, 'servicio');
    assert.equal(R.peticionDeConfirmacion(antes, f).peticion?.service_conditions_sha256, 'e'.repeat(64));
    assert.deepEqual(R.peticionDeConfirmacion(despues, f), { peticion: null, fallo: 'servicios.reserva.algoCambio' });
    assert.equal(R.estaAceptado(despues, f, 'servicio'), false);
  });

  it('sin condiciones no hay nada que marcar', () => {
    const sin = resumen({ terms: null });
    assert.equal(R.huellaDeLoAceptable(sin, 'z'), null);
    assert.equal(R.alternarAceptacion(sin, R.formularioVacio(), 'z').acepta, null);
    assert.equal(R.estaAceptado(sin, { ...R.formularioVacio(), acepta: 'null' }, 'z'), false);
  });
});

// =========================================================================== //
describe('lo que se manda al confirmar: solo lo necesario', () => {
  const lleno = { ...R.formularioVacio(), acepta: `p1:${'a'.repeat(64)}` };

  it('sin condiciones publicadas no se confirma', () => {
    assert.deepEqual(R.peticionDeConfirmacion(resumen({ terms: null }), lleno), {
      peticion: null,
      fallo: 'servicios.reserva.error.sinCondiciones',
    });
  });

  it('sin aceptar, no; y las del servicio también, si las tiene', () => {
    assert.equal(R.peticionDeConfirmacion(resumen(), R.formularioVacio()).fallo, 'servicios.reserva.error.aceptar');
    const conDelServicio = resumen({ service_conditions: { text: 'x', sha256: 'b'.repeat(64) } });
    assert.equal(R.peticionDeConfirmacion(conDelServicio, lleno).fallo, 'servicios.reserva.error.aceptarServicio');
    const ok = R.peticionDeConfirmacion(conDelServicio, { ...lleno, aceptaServicio: 'b'.repeat(64) });
    assert.equal(ok.fallo, null);
    assert.equal(ok.peticion?.service_conditions_sha256, 'b'.repeat(64));
  });

  it('manda la versión CONCRETA que se leyó: su id y su huella', () => {
    const { peticion } = R.peticionDeConfirmacion(resumen(), lleno);
    assert.deepEqual(peticion, { terms_policy_id: 'p1', terms_sha256: 'a'.repeat(64), note: null });
  });

  it('en línea o presencial NO viaja ninguna dirección, aunque se haya escrito', () => {
    const escrito = { ...lleno, distrito: 'Miraflores', direccion: 'Av. 1', referencia: 'Piso 2', nota: ' hola ' };
    const { peticion } = R.peticionDeConfirmacion(resumen(), escrito);
    assert.deepEqual(Object.keys(peticion ?? {}).sort(), ['note', 'terms_policy_id', 'terms_sha256']);
    assert.equal(peticion?.note, 'hola');
  });

  it('a domicilio exige distrito y dirección, y la referencia es opcional', () => {
    const domicilio = resumen({ requires_address: true });
    assert.equal(R.peticionDeConfirmacion(domicilio, lleno).fallo, 'servicios.reserva.error.direccion');
    assert.equal(R.peticionDeConfirmacion(domicilio, { ...lleno, distrito: 'X' }).fallo, 'servicios.reserva.error.direccion');
    const { peticion } = R.peticionDeConfirmacion(domicilio, { ...lleno, distrito: ' X ', direccion: ' Calle 1 ' });
    assert.deepEqual(peticion, {
      terms_policy_id: 'p1', terms_sha256: 'a'.repeat(64), note: null,
      district: 'X', address_line: 'Calle 1', address_reference: null,
    });
  });

  it('los largos son los del servidor (los manda en `limits`)', () => {
    const corto = resumen({ limits: { note_max_length: 5, district_max_length: 3, address_max_length: 4, reference_max_length: 2 } });
    assert.equal(R.peticionDeConfirmacion(corto, { ...lleno, nota: '123456' }).fallo, 'servicios.reserva.error.largo');
    assert.equal(R.peticionDeConfirmacion(corto, { ...lleno, nota: '12345' }).fallo, null);
    const casa = { ...corto, requires_address: true };
    assert.equal(R.peticionDeConfirmacion(casa, { ...lleno, distrito: '1234', direccion: 'a' }).fallo, 'servicios.reserva.error.largo');
    assert.equal(R.peticionDeConfirmacion(casa, { ...lleno, distrito: '1', direccion: 'a', referencia: '123' }).fallo, 'servicios.reserva.error.largo');
  });

  it('nunca manda un estado, un precio ni un importe', () => {
    const { peticion } = R.peticionDeConfirmacion(resumen({ requires_address: true }), { ...lleno, distrito: 'X', direccion: 'Y' });
    for (const prohibido of ['status', 'price', 'amount_minor', 'total_minor', 'currency', 'payment_status']) {
      assert.ok(!(prohibido in (peticion ?? {})), prohibido);
    }
  });
});

// =========================================================================== //
describe('el borrador vive en memoria, y la ruta solo lleva identificadores', () => {
  it('se guarda, se lee como copia y se olvida', () => {
    assert.deepEqual(R.borradorDe('h-x'), R.formularioVacio());
    const f = { ...R.formularioVacio(), nota: 'hola', direccion: 'Calle 1' };
    R.guardarBorrador('h-x', f);
    f.nota = 'cambiado fuera';
    const leido = R.borradorDe('h-x');
    assert.equal(leido.nota, 'hola');
    leido.direccion = 'otra';
    assert.equal(R.borradorDe('h-x').direccion, 'Calle 1');
    R.olvidarBorrador('h-x');
    assert.deepEqual(R.borradorDe('h-x'), R.formularioVacio());
  });

  it('las rutas son identificadores codificados, nada más', () => {
    assert.equal(R.rutaDeLaContratacion('h1'), '/servicios/contratar/h1');
    assert.equal(R.rutaDeLaContratacion('h1', 'resumen'), '/servicios/contratar/h1/resumen');
    assert.equal(R.rutaDeLaContratacion('h1', 'condiciones'), '/servicios/contratar/h1/condiciones');
    assert.equal(R.rutaDeLaReserva('a/b?c'), '/servicios/reservas/a%2Fb%3Fc');
    assert.equal(R.rutaDeLaReservaDelPrestador('b1'), '/servicios/prestador/reservas/b1');
    const fuente = readFileSync(join(import.meta.dirname, 'serviciosReserva.ts'), 'utf8');
    const rutas = fuente.slice(fuente.indexOf('export function rutaDeLaContratacion'), fuente.indexOf('// Los errores del servidor'));
    assert.ok(!/nota|direccion|distrito|referencia|note|address/.test(rutas));
  });
});
