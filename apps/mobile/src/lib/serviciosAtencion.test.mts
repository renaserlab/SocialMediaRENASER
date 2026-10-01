/**
 * Z Servicios, Incremento 6: la lógica pura de la atención y la posventa,
 * contra el servidor.
 *
 * Lo que aquí no puede desalinearse sin que nadie se entere:
 *  - los VALORES CERRADOS (acciones, estados, motivos, efectos) y los LARGOS
 *    son los del servidor, leídos de su código fuente;
 *  - cada CÓDIGO de error tiene su texto, y ninguno es inventado;
 *  - cada CLAVE que arma esta lógica existe en los tres idiomas, con los
 *    mismos huecos;
 *  - LO QUE SE PUEDE HACER lo dice el servidor: sin `care`, nada;
 *  - EL DINERO nunca se da por movido: ningún estado ni texto dice «devuelto»;
 *  - SIN RESEÑAS NO HAY NOTA;
 *  - lo que se manda nunca lleva un estado, un importe ni un «verificada».
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { es } from '../i18n/es.ts';
import { en } from '../i18n/en.ts';
import { pt } from '../i18n/pt.ts';

registerHooks({
  resolve(especificador, contexto, siguiente) {
    if (especificador.startsWith('@/')) {
      return { url: new URL(`../${especificador.slice(2)}.ts`, import.meta.url).href, shortCircuit: true };
    }
    return siguiente(especificador, contexto);
  },
});

const A = await import('./serviciosAtencion.ts');
const { rutaDelAviso, avisoAlCreador } = await import('./avisosAlCreador.ts');

const API = join(import.meta.dirname, '..', '..', '..', 'api', 'app', 'modules');
const servidor = (fichero: string) => readFileSync(join(API, 'services', fichero), 'utf8').replace(/\r\n/g, '\n');
const MODELOS = servidor('atencion_models.py');
const RESERVA = servidor('reserva_models.py');
const POLITICA = servidor('reserva_politica.py');
const DOMINIO = servidor('atencion.py');
const POSVENTA = servidor('posventa.py');
const DICCIONARIOS = { es, en, pt } as Record<string, Record<string, string | undefined>>;

function constantes(fuente: string): Map<string, string> {
  return new Map([...fuente.matchAll(/^([A-Z_]+) = "([a-z_]+)"$/gm)].map((m) => [m[1] as string, m[2] as string]));
}

/** Una tupla escrita con constantes o literales: `NOMBRE = (A, "b", ...)`. */
function tupla(fuente: string, nombre: string, valores = constantes(fuente)): string[] {
  const desde = fuente.search(new RegExp(`^${nombre} = \\(`, 'm'));
  assert.ok(desde >= 0, `no encontré ${nombre}`);
  const bloque = fuente.slice(fuente.indexOf('(', desde) + 1, fuente.indexOf(')', desde));
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

const cuidado = (acciones: string[]) => ({
  available_actions: acciones,
  attendance: null,
  cancellation: null,
  reschedules: [],
  deadlines: {
    cancel_until: '2026-10-05T15:00:00Z', reschedule_until: '2026-10-04T15:00:00Z', reschedules_left: 1,
    checkin_opens_at: '2026-10-05T14:45:00Z', absence_from: '2026-10-05T15:15:00Z',
    incident_until: '2026-10-07T16:00:00Z', review_until: null, appeal_until: null,
    cancellation_financial_effect: 'not_applicable',
  },
  incident: null,
  review: null,
});

// =========================================================================== //
describe('los valores cerrados son los del servidor', () => {
  it('las acciones que puede ofrecer `care.available_actions`', () => {
    const delServidor = [
      'CANCELAR', 'REPROGRAMAR', 'PEDIR_CODIGO', 'INICIAR', 'TERMINAR', 'CONFIRMAR', 'REPORTAR_AUSENCIA',
      'ABRIR_CASO', 'ESCRIBIR_EN_EL_CASO', 'RETIRAR_EL_CASO', 'APELAR', 'RESENAR', 'RESPONDER_RESENA',
    ].map((n) => constantes(DOMINIO).get(n));
    assert.deepEqual([...A.ACCIONES_DE_LA_ATENCION], delServidor);
    // Y `acciones_disponibles` no añade ninguna que no sea una de esas.
    const funcion = DOMINIO.slice(DOMINIO.indexOf('def acciones_disponibles('), DOMINIO.indexOf('class Cuidado'));
    const anadidas = new Set([...funcion.matchAll(/acciones\.append\(([A-Z_]+)\)/g)].map((m) => constantes(DOMINIO).get(m[1] as string)));
    assert.deepEqual([...anadidas].sort(), [...A.ACCIONES_DE_LA_ATENCION].sort());
  });

  it('estados, motivos, efectos, entradas y ejes', () => {
    assert.deepEqual([...A.ESTADOS_DE_LA_RESERVA], tupla(RESERVA, 'ESTADOS_DE_RESERVA'));
    assert.deepEqual([...A.ESTADOS_DE_LA_ATENCION], tupla(MODELOS, 'ESTADOS_DE_ATENCION'));
    assert.deepEqual([...A.ESTADOS_DEL_CASO], tupla(MODELOS, 'ESTADOS_DE_CASO'));
    assert.deepEqual([...A.MOTIVOS_DEL_CASO], tupla(MODELOS, 'MOTIVOS'));
    assert.deepEqual([...A.RESULTADOS_DEL_CASO], tupla(MODELOS, 'RESULTADOS'));
    assert.deepEqual([...A.EFECTOS_EN_LA_ATENCION], tupla(MODELOS, 'EFECTOS_EN_LA_ATENCION'));
    assert.deepEqual([...A.EFECTOS_ECONOMICOS], tupla(MODELOS, 'EFECTOS_ECONOMICOS'));
    assert.deepEqual([...A.ESTADOS_DEL_EFECTO], tupla(MODELOS, 'ESTADOS_DEL_EFECTO'));
    assert.deepEqual([...A.TIPOS_DE_ENTRADA], tupla(MODELOS, 'TIPOS_DE_ENTRADA'));
    assert.deepEqual([...A.ESTADOS_DE_LA_RESENA], tupla(MODELOS, 'ESTADOS_DE_RESENA'));
    assert.deepEqual([...A.EJES_DE_LA_RESENA], tupla(MODELOS, 'EJES_DE_RESENA'));
    assert.deepEqual([...A.CIERRES_DE_LA_ATENCION], tupla(MODELOS, 'CIERRES', constantes(RESERVA)));
    assert.deepEqual([...A.MOTIVOS_DE_CANCELACION], tupla(DOMINIO, 'MOTIVOS_DE_CANCELACION'));
    assert.deepEqual([...A.MOTIVOS_DE_MODERACION], tupla(POSVENTA, 'MOTIVOS_DE_MODERACION'));
  });

  it('cada parte alega solo sus motivos: nadie se reporta ausente a sí mismo', () => {
    // Quien contrata: todos menos «quien contrató no asistió».
    assert.match(POSVENTA, /CLIENTE: tuple\(m for m in MOTIVOS if m != "client_absent"\),/);
    assert.deepEqual([...A.MOTIVOS_DE_CADA_PARTE.client], A.MOTIVOS_DEL_CASO.filter((m) => m !== 'client_absent'));
    const prestador = POSVENTA.match(/PRESTADOR: \(([^)]*)\),/);
    assert.ok(prestador);
    const valores = constantes(MODELOS);
    assert.deepEqual(
      [...A.MOTIVOS_DE_CADA_PARTE.provider],
      (prestador[1] as string).split(',').map((x) => x.trim()).filter(Boolean).map((x) => valores.get(x) ?? x.replace(/"/g, '')),
    );
    assert.ok(!(A.MOTIVOS_DE_CADA_PARTE.provider as readonly string[]).includes('provider_absent'));
  });

  it('los largos son los de `reserva_politica.py`', () => {
    const L = A.LARGOS_DE_LA_ATENCION;
    assert.match(POLITICA, new RegExp(`^CODIGO_DE_ASISTENCIA_CIFRAS = ${L.codigo}$`, 'm'));
    assert.match(POLITICA, new RegExp(`^DESCRIPCION_DEL_CASO = \\(${L.descripcionMinima}, ${L.descripcion}\\)$`, 'm'));
    assert.match(POLITICA, new RegExp(`^ENTRADA_MAXIMA = ${L.entrada}$`, 'm'));
    assert.match(POLITICA, new RegExp(`^MOTIVO_MAXIMO = ${L.nota}$`, 'm'));
    assert.match(POLITICA, new RegExp(`^COMENTARIO_DE_RESENA = \\(${L.comentarioMinimo}, ${L.comentario}\\)$`, 'm'));
    assert.match(POLITICA, new RegExp(`^RESPUESTA_MAXIMA = ${L.respuesta}$`, 'm'));
    assert.match(POLITICA, new RegExp(`^EVIDENCIAS_POR_CASO = ${L.evidencias}$`, 'm'));
    // Las evidencias: los formatos y el peso del depósito privado (0094).
    const migracion = readFileSync(
      join(API, '..', '..', '..', '..', 'supabase', 'migrations', '0094_servicios_atencion_y_cierre.sql'), 'utf8',
    );
    assert.match(migracion, /allowed_mime_types = array\['application\/pdf', 'image\/jpeg', 'image\/png', 'image\/webp'\]/);
    assert.deepEqual([...A.FORMATOS_DE_EVIDENCIA], ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
    assert.equal(A.PESO_MAXIMO_DE_EVIDENCIA, 10 * 1024 * 1024);
  });
});

// =========================================================================== //
describe('ningún código de la atención llega crudo a la pantalla', () => {
  const codigos = new Set<string>();
  for (const fuente of [DOMINIO, POSVENTA, servidor('atencion_router.py')]) {
    for (const m of fuente.matchAll(/\bcode ?= ?"([a-z_]+)"/g)) codigos.add(m[1] as string);
  }

  it('cada código del servidor tiene su texto, y ninguno del teléfono es inventado', () => {
    assert.ok(codigos.size >= 27, `solo ${codigos.size} códigos leídos`);
    const sinTexto = [...codigos].filter((c) => A.claveDeErrorDeLaAtencion(c) === null);
    assert.deepEqual(sinTexto, [], `sin texto en el teléfono: ${sinTexto.join(', ')}`);
    assert.deepEqual(A.CODIGOS_DE_ERROR_DE_LA_ATENCION.filter((c) => !codigos.has(c)), []);
  });

  it('cada texto de error existe en los tres idiomas', () => {
    for (const c of A.CODIGOS_DE_ERROR_DE_LA_ATENCION) existeEnLosTres(A.claveDeErrorDeLaAtencion(c) as string);
    assert.equal(A.claveDeErrorDeLaAtencion('algo_nuevo'), null);
    assert.equal(A.claveDeErrorDeLaAtencion(null), null);
  });

  it('la pantalla de la reserva los traduce (y sigue traduciendo los del Incremento 5)', () => {
    const hook = readFileSync(join(import.meta.dirname, '..', 'hooks', 'useServicios.ts'), 'utf8');
    assert.match(hook, /ambito === 'reserva' \? claveDeErrorDeLaReserva\(error\.code\) \?\? claveDeErrorDeLaAtencion\(error\.code\) : null/);
  });
});

// =========================================================================== //
describe('cada clave que produce esta lógica existe', () => {
  it('estados, motivos, efectos, autores y ejes: cada valor del servidor y su «desconocido»', () => {
    const familias: Array<[(v: string | null) => string, readonly string[]]> = [
      [A.claveDelEstadoDeLaReserva, A.ESTADOS_DE_LA_RESERVA],
      [A.claveDelEstadoDeLaAtencion, A.ESTADOS_DE_LA_ATENCION],
      [A.claveDelCierre, A.CIERRES_DE_LA_ATENCION],
      [A.claveDelEstadoDelCaso, A.ESTADOS_DEL_CASO],
      [A.claveDelMotivoDelCaso, A.MOTIVOS_DEL_CASO],
      [A.claveDelMotivoDeCancelacion, A.MOTIVOS_DE_CANCELACION],
      [A.claveDelResultado, A.RESULTADOS_DEL_CASO],
      [A.claveDelEfectoEnLaAtencion, A.EFECTOS_EN_LA_ATENCION],
      [A.claveDelEfectoEconomico, A.EFECTOS_ECONOMICOS],
      [A.claveDelEstadoDelEfecto, A.ESTADOS_DEL_EFECTO],
      [A.claveDelTipoDeEntrada, A.TIPOS_DE_ENTRADA],
      [A.claveDelEstadoDeLaResena, A.ESTADOS_DE_LA_RESENA],
      [A.claveDelEje, A.EJES_DE_LA_RESENA],
      [A.claveDelMotivoDeModeracion, A.MOTIVOS_DE_MODERACION],
    ];
    for (const [clave, valores] of familias) {
      for (const v of [...valores, 'algo_raro']) existeEnLosTres(clave(v));
      assert.ok(clave('algo_raro').endsWith('.otro'));
    }
    // Sin atención todavía no es «desconocido»: es «todavía no empezó».
    assert.equal(A.claveDelEstadoDeLaAtencion(null), 'servicios.atencion.estado.ninguno');
    existeEnLosTres('servicios.atencion.estado.ninguno');
    for (const rol of ['client', 'provider', 'admin', 'raro']) existeEnLosTres(A.claveDeQuienEscribe(rol, false));
    assert.equal(A.claveDeQuienEscribe('provider', true), 'servicios.atencion.caso.autor.yo');
    existeEnLosTres('servicios.atencion.caso.autor.yo');
  });

  it('lo que se pregunta antes de lo que no se deshace', () => {
    assert.deepEqual(Object.keys(A.PREGUNTAS_DE_LA_ATENCION).sort(), [
      'ausenciaDelCliente', 'ausenciaDelPrestador', 'confirmar', 'responder', 'sinCodigo', 'terminar',
    ]);
    for (const p of Object.values(A.PREGUNTAS_DE_LA_ATENCION)) {
      for (const clave of [p.titulo, p.aviso, p.si]) existeEnLosTres(clave);
    }
  });

  it('las claves de la atención tienen los mismos huecos en los tres idiomas', () => {
    const claves = Object.keys(es).filter((k) => k.startsWith('servicios.atencion.') || k.startsWith('notif.servicioAtencion'));
    assert.ok(claves.length >= 300, `solo ${claves.length}`);
    for (const c of claves) existeEnLosTres(c);
    // Y los fallos que devuelven las peticiones de abajo.
    const fuente = readFileSync(join(import.meta.dirname, 'serviciosAtencion.ts'), 'utf8');
    for (const m of fuente.matchAll(/'(servicios\.atencion\.[A-Za-z0-9_.]+)'/g)) {
      const clave = m[1] as string;
      // Los prefijos de una familia (`…caso.estado`) no son claves.
      if (Object.keys(es).some((k) => k.startsWith(`${clave}.`)) && !(clave in es)) continue;
      existeEnLosTres(clave);
    }
  });
});

// =========================================================================== //
describe('lo que se puede hacer lo dice el SERVIDOR', () => {
  it('solo lo que viene en `available_actions`', () => {
    const c = cuidado(['cancel', 'reschedule']);
    assert.equal(A.puede(c, 'cancel'), true);
    assert.equal(A.puede(c, 'reschedule'), true);
    for (const a of A.ACCIONES_DE_LA_ATENCION.filter((x) => x !== 'cancel' && x !== 'reschedule')) {
      assert.equal(A.puede(c, a), false, a);
    }
  });

  it('sin `care` (la base todavía sin la 0094) no se ofrece NADA', () => {
    for (const a of A.ACCIONES_DE_LA_ATENCION) {
      assert.equal(A.puede(null, a), false, a);
      assert.equal(A.puede(undefined, a), false, a);
      assert.equal(A.puedeEnElCaso(null, a), false, a);
    }
  });

  it('nada en la lógica decide por la hora del teléfono ni por el estado', () => {
    const fuente = readFileSync(join(import.meta.dirname, 'serviciosAtencion.ts'), 'utf8');
    const logica = fuente.slice(0, fuente.indexOf('export function momentoLegible')) + fuente.slice(fuente.indexOf('// Las reseñas, en palabras'));
    assert.ok(!/Date\.now\(|new Date\(/.test(logica), 'solo `momentoLegible` formatea un instante');
    const puede = fuente.slice(fuente.indexOf('export function puede('), fuente.indexOf('// Palabras'));
    assert.ok(!/status|starts_at|_until|_at\b/.test(puede));
  });
});

// =========================================================================== //
describe('el dinero nunca se da por movido', () => {
  const DINERO = Object.keys(es).filter((k) => k.startsWith('servicios.atencion.dinero.'));

  it('no existe un estado «ejecutado», ni aquí ni en el servidor', () => {
    assert.deepEqual([...A.ESTADOS_DEL_EFECTO], ['not_applicable', 'pending', 'blocked']);
    for (const palabra of ['executed', 'refunded', 'paid', 'done', 'completed', 'succeeded']) {
      assert.ok(!(A.ESTADOS_DEL_EFECTO as readonly string[]).includes(palabra), palabra);
    }
  });

  it('un estado desconocido NO se lee como hecho', () => {
    for (const raro of ['executed', 'refunded', 'paid', '', null, undefined]) {
      assert.equal(A.claveDelEstadoDelEfecto(raro), 'servicios.atencion.dinero.estado.otro');
    }
    assert.match(es['servicios.atencion.dinero.estado.otro'], /sin confirmar/);
  });

  it('ningún texto del dinero dice «devuelto», «reembolsado», «pagado» o «ejecutado»', () => {
    assert.ok(DINERO.length >= 11);
    for (const clave of DINERO) {
      for (const [idioma, dic] of Object.entries(DICCIONARIOS)) {
        const texto = dic[clave] as string;
        assert.ok(
          !/devuelt[oa]s?\b|reembolsad|ejecutad|\bpagad[oa]\b|\brefunded\b|\bexecuted\b|\bpaid\b|devolvid|reembolsad|executad/i.test(texto),
          `${idioma} ${clave}: «${texto}»`,
        );
      }
    }
    // Y se dice expresamente que solicitar no es devolver.
    assert.match(es['servicios.atencion.dinero.noSeMovio'], /no movió dinero/);
    assert.match(es['servicios.atencion.dinero.estado.not_applicable'], /no se cobró nada/);
  });

  it('la resolución manda lo que se SOLICITA; el estado del efecto lo pone el servidor', () => {
    const { peticion } = A.peticionDeResolucion({
      resultado: 'upheld', texto: ' Revisado. ', efectoEnLaAtencion: 'none', efectoEconomico: 'full_refund', notaInterna: '',
    });
    assert.deepEqual(peticion, {
      outcome: 'upheld', resolution: 'Revisado.', attention_effect: 'none', financial_effect: 'full_refund',
      internal_note: null,
    });
    for (const prohibido of ['financial_effect_status', 'status', 'amount_minor', 'refund_minor', 'currency']) {
      assert.ok(!(prohibido in (peticion ?? {})), prohibido);
    }
    assert.equal(A.peticionDeResolucion(A.resolucionVacia()).fallo, 'servicios.atencion.error.resultado');
    assert.equal(
      A.peticionDeResolucion({ ...A.resolucionVacia(), resultado: 'upheld', efectoEconomico: 'transfer' }).peticion, null);
    assert.equal(
      A.peticionDeResolucion({ ...A.resolucionVacia(), resultado: 'upheld' }).fallo, 'servicios.atencion.error.explica');
  });
});

// =========================================================================== //
describe('sin reseñas no hay nota', () => {
  it('promedio nulo o cero reseñas: «todavía no hay reseñas», nunca «0,0»', () => {
    const ninguna = { clave: 'servicios.atencion.resenas.ninguna' };
    assert.deepEqual(A.promedioLegible(null), ninguna);
    assert.deepEqual(A.promedioLegible({ total: 0, average: null, recommend_bps: null, by_axis: {} }), ninguna);
    assert.deepEqual(A.promedioLegible({ total: 0, average: 0, recommend_bps: 0, by_axis: {} }), ninguna);
    assert.deepEqual(A.promedioLegible({ total: 3, average: null, recommend_bps: null, by_axis: {} }), ninguna);
    assert.equal(A.recomendacionLegible({ total: 0, average: null, recommend_bps: null, by_axis: {} }), null);
    for (const dic of Object.values(DICCIONARIOS)) assert.ok(!/\b0[.,]0\b/.test(dic['servicios.atencion.resenas.ninguna'] as string));
  });

  it('con reseñas, la media con un decimal y cuántas', () => {
    assert.deepEqual(A.promedioLegible({ total: 2, average: 4.5, recommend_bps: 5000, by_axis: {} }), {
      clave: 'servicios.atencion.resenas.media', params: { media: '4.5', n: 2 },
    });
    assert.deepEqual(A.recomendacionLegible({ total: 2, average: 4.5, recommend_bps: 5000, by_axis: {} }), {
      clave: 'servicios.atencion.resenas.recomiendan', params: { porcentaje: 50 },
    });
    assert.equal(A.estrellas(4), '★★★★☆');
    assert.equal(A.estrellas(0), '☆☆☆☆☆');
    assert.equal(A.estrellas(9), '★★★★★');
  });
});

// =========================================================================== //
describe('lo que se manda: solo lo necesario', () => {
  it('cancelar: un motivo de la lista; el prestador explica por qué', () => {
    assert.deepEqual(A.peticionDeCancelacion('client', 'change_of_plans', '  '), {
      peticion: { reason: 'change_of_plans', note: null }, fallo: null,
    });
    assert.equal(A.peticionDeCancelacion('client', 'porque_si', '').fallo, 'servicios.atencion.error.motivo');
    assert.equal(A.peticionDeCancelacion('provider', 'unavailable', ' ').fallo, 'servicios.atencion.error.explica');
    assert.deepEqual(A.peticionDeCancelacion('provider', 'unavailable', ' Me operan. ').peticion, {
      reason: 'unavailable', note: 'Me operan.',
    });
    assert.equal(A.peticionDeCancelacion('client', 'other', 'x'.repeat(501)).fallo, 'servicios.atencion.error.largo');
  });

  it('el caso: un motivo de ESA parte y qué pasó', () => {
    const texto = 'Llegué a la hora y no había nadie.';
    assert.deepEqual(A.peticionDelCaso('client', 'provider_absent', ` ${texto} `).peticion, {
      reason: 'provider_absent', description: texto,
    });
    assert.equal(A.peticionDelCaso('client', 'client_absent', texto).fallo, 'servicios.atencion.error.motivo');
    assert.equal(A.peticionDelCaso('provider', 'quality', texto).fallo, 'servicios.atencion.error.motivo');
    assert.equal(A.peticionDelCaso('provider', null, texto).fallo, 'servicios.atencion.error.motivo');
    assert.equal(A.peticionDelCaso('client', 'quality', 'Mal.').fallo, 'servicios.atencion.error.descripcionCorta');
    assert.equal(A.peticionDelCaso('client', 'quality', 'x'.repeat(2001)).fallo, 'servicios.atencion.error.largo');
    assert.equal(A.peticionDeMensaje('  ').fallo, 'servicios.atencion.error.vacio');
    assert.equal(A.peticionDeMensaje('No.', 20).fallo, 'servicios.atencion.error.descripcionCorta');
    assert.deepEqual(A.peticionDeMensaje(' Hola. ').peticion, { body: 'Hola.' });
  });

  it('la reseña: nota de 1 a 5, si la recomienda y un comentario; nunca un «verificada» ni un estado', () => {
    const comentario = 'Muy clara y puntual, resolvió mis dudas.';
    const base = { ...A.resenaVacia(), nota: 5, recomienda: true, comentario };
    assert.deepEqual(A.peticionDeResena(base).peticion, { rating: 5, recommends: true, comment: comentario });
    assert.deepEqual(A.peticionDeResena({ ...base, ejes: { punctuality: 4, quality: 0 } }).peticion, {
      rating: 5, recommends: true, comment: comentario, punctuality: 4,
    });
    assert.equal(A.peticionDeResena(A.resenaVacia()).fallo, 'servicios.atencion.error.nota');
    for (const nota of [0, 6, 2.5, -1]) assert.equal(A.peticionDeResena({ ...base, nota }).peticion, null, String(nota));
    assert.equal(A.peticionDeResena({ ...base, recomienda: null }).fallo, 'servicios.atencion.error.recomienda');
    assert.equal(A.peticionDeResena({ ...base, comentario: 'Bien.' }).fallo, 'servicios.atencion.error.comentarioCorto');
    assert.equal(A.peticionDeResena({ ...base, ejes: { clarity: 7 } }).peticion, null);
    for (const prohibido of ['verified', 'status', 'author_id', 'booking_id']) {
      assert.ok(!(prohibido in (A.peticionDeResena(base).peticion ?? {})), prohibido);
    }
    assert.deepEqual(A.peticionDeRespuesta(' Gracias. ').peticion, { reply: 'Gracias.' });
    assert.equal(A.peticionDeRespuesta(' ').fallo, 'servicios.atencion.error.vacio');
    assert.equal(A.peticionDeRespuesta('x'.repeat(1001)).fallo, 'servicios.atencion.error.largo');
  });

  it('moderar: publicar, o esconder con un motivo de la lista («es negativa» no existe)', () => {
    assert.deepEqual(A.peticionDeModeracion('publish', null).peticion, { action: 'publish' });
    assert.equal(A.peticionDeModeracion('hide', null).fallo, 'servicios.atencion.error.motivo');
    assert.equal(A.peticionDeModeracion('hide', 'es_negativa').peticion, null);
    assert.deepEqual(A.peticionDeModeracion('hide', 'personal_data').peticion, { action: 'hide', reason: 'personal_data' });
    assert.ok(!A.MOTIVOS_DE_MODERACION.some((m) => /negativ|rating|low/.test(m)));
  });

  it('el código de asistencia: solo cifras, y seis', () => {
    assert.equal(A.codigoLimpio('12 34-56'), '123456');
    assert.equal(A.codigoLimpio('1234567890'), '123456');
    assert.equal(A.codigoLimpio('abc'), '');
  });
});

// =========================================================================== //
describe('una clave de idempotencia por petición', () => {
  it('lo mismo, la misma; otra cosa, otra; y tras terminar, una nueva', () => {
    let n = 0;
    const llaves = A.llavero(() => `k${++n}`);
    const primera = llaves.de('cancelar', { reason: 'other' });
    assert.equal(llaves.de('cancelar', { reason: 'other' }), primera);
    const segunda = llaves.de('cancelar', { reason: 'unavailable' });
    assert.notEqual(segunda, primera);
    assert.notEqual(llaves.de('confirmar'), segunda);
    assert.equal(llaves.de('confirmar'), llaves.de('confirmar'));
    llaves.hecho('confirmar');
    assert.equal(llaves.de('confirmar'), `k${n}`);
    assert.equal(n, 4);
  });
});

// =========================================================================== //
describe('las rutas son identificadores, y los avisos llevan a donde toca', () => {
  it('cada ruta, con su identificador codificado y nada más', () => {
    assert.equal(A.rutaDeCancelar('client', 'b1'), '/servicios/reservas/b1/cancelar');
    assert.equal(A.rutaDeCancelar('provider', 'b1'), '/servicios/prestador/reservas/b1/cancelar');
    assert.equal(A.rutaDelCaso('client', 'a/b'), '/servicios/reservas/a%2Fb/caso');
    assert.equal(A.rutaDelCaso('provider', 'b1'), '/servicios/prestador/reservas/b1/caso');
    assert.equal(A.rutaDeLaResena('b1'), '/servicios/reservas/b1/resena');
    assert.equal(A.rutaDeHorariosParaReprogramar('s1', 'b1'), '/servicios/horarios/s1?reprogramar=b1');
    assert.equal(A.rutaDeReprogramar('b1', 'h1'), '/servicios/reservas/b1/reprogramar?retencion=h1');
    assert.equal(A.rutaDelCasoParaAdministrar('c1'), '/admin/servicios/casos/c1');
    const fuente = readFileSync(join(import.meta.dirname, 'serviciosAtencion.ts'), 'utf8');
    const rutas = fuente.slice(fuente.indexOf('// Rutas: identificadores'), fuente.indexOf('// Los errores del servidor'));
    assert.ok(!/\b(motivo|nota|descripcion|comentario|codigo|reason|note|comment|code)\b/.test(rutas));
  });

  it('los 19 avisos del servidor tienen título, texto en los tres idiomas y destino', () => {
    const avisos = servidor('avisos.py');
    const bloque = avisos.slice(avisos.indexOf('TIPOS_DE_LA_ATENCION'));
    const valores = constantes(avisos);
    const tipos = [...new Set([...bloque.matchAll(/\b([A-Z_]{6,})\b/g)].map((m) => valores.get(m[1] as string)).filter(Boolean))] as string[];
    const deLaAtencion = [...valores.values()].filter((v) => /^service_(booking_(cancelled|rescheduled|reminder)|attention|incident|review)_/.test(v));
    assert.equal(deLaAtencion.length, 19, deLaAtencion.join(', '));
    assert.ok(tipos.length >= 19);
    const textos = readFileSync(join(API, 'notifications', 'textos.py'), 'utf8');
    for (const tipo of deLaAtencion) {
      const aviso = avisoAlCreador(tipo);
      assert.ok(aviso, `sin título: ${tipo}`);
      existeEnLosTres(aviso.titulo);
      existeEnLosTres(aviso.cuerpo as string);
      // EL MISMO TEXTO que manda el servidor en la notificación.
      assert.ok(textos.includes(`"${es[aviso.titulo as keyof typeof es]}"`), `${tipo}: el título no es el del servidor`);
      assert.ok(textos.includes(`"${tipo}"`), tipo);
      const destino = rutaDelAviso(tipo, 'x1');
      if (tipo.endsWith('_team')) assert.equal(destino, '/admin/servicios/casos/x1', tipo);
      else if (tipo.endsWith('_provider')) assert.ok(destino?.startsWith('/servicios/prestador/reservas/x1'), tipo);
      else assert.ok(destino?.startsWith('/servicios/reservas/x1'), tipo);
      // Lo del caso, a su expediente.
      if (tipo.includes('_incident_') && !tipo.endsWith('_team')) assert.ok(destino?.endsWith('/caso'), tipo);
      assert.ok(rutaDelAviso(tipo, null), `${tipo} sin destino cuando falta el identificador`);
    }
  });
});
