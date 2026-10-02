/**
 * Z Servicios, Incremento 4: la lógica pura de la agenda, contra el servidor.
 *
 * Lo que aquí no puede desalinearse sin que nadie se entere:
 *  - los VALORES CERRADOS (días, tipos, estados, motivos) y los CÓDIGOS de
 *    error son los del servidor, leídos de su código fuente;
 *  - el repositorio pide EXACTAMENTE las rutas del servidor, ni una más;
 *  - cada CLAVE que arma esta lógica existe en los tres idiomas, con los
 *    mismos huecos, y ningún texto promete una reserva que no existe;
 *  - los formularios rechazan lo que el servidor rechazaría, con los límites
 *    que manda el servidor (no con números propios);
 *  - las fechas se cuentan sin zonas, y el horario elegido es solo un valor
 *    de la ruta.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { es } from '../i18n/es.ts';
import { en } from '../i18n/en.ts';
import { pt } from '../i18n/pt.ts';
import type { Calendario, Horario, LimitesDeLaAgenda } from './serviciosAgenda.ts';

registerHooks({
  resolve(especificador, contexto, siguiente) {
    if (especificador.startsWith('@/')) {
      return { url: new URL(`../${especificador.slice(2)}.ts`, import.meta.url).href, shortCircuit: true };
    }
    return siguiente(especificador, contexto);
  },
});

const A = await import('./serviciosAgenda.ts');

const API = join(import.meta.dirname, '..', '..', '..', 'api', 'app', 'modules', 'services');
const servidor = (fichero: string) => readFileSync(join(API, fichero), 'utf8').replace(/\r\n/g, '\n');
const DOMINIO = servidor('agenda.py');
const MODELOS = servidor('agenda_models.py');
const RUTAS = servidor('agenda_router.py');
const POLITICA = servidor('agenda_politica.py');
const IDIOMAS = { es, en, pt } as Record<string, Record<string, string>>;

const existe = (clave: string) => {
  for (const [idioma, dic] of Object.entries(IDIOMAS)) assert.ok(clave in dic, `falta «${clave}» en ${idioma}`);
};

/** Los límites que manda el servidor (los de fábrica de `agenda_politica.py`). */
const LIMITES: LimitesDeLaAgenda = {
  notice_minutes: 120,
  horizon_days: 60,
  grid_minutes: 5,
  max_buffer_minutes: 240,
  min_interval_minutes: 5,
  max_interval_minutes: 1440,
  max_rules: 50,
  max_exceptions: 200,
  max_blocks: 200,
  max_block_days: 31,
  max_advance_days: 366,
  reason_max_length: 200,
};

// =========================================================================== //
describe('lo mismo que el servidor', () => {
  it('los límites de prueba son los de la política', () => {
    for (const [constante, valor] of [
      ['REJILLA_MINUTOS', 5], ['SEPARACION_MAXIMA', 240], ['INTERVALO_MINIMO', 5], ['INTERVALO_MAXIMO', 1440],
      ['MOTIVO_MAXIMO', 200], ['BLOQUEO_MAXIMO_DIAS', 31], ['ADELANTO_MAXIMO_DIAS', 366],
    ] as const) {
      assert.match(POLITICA, new RegExp(`^${constante} = ${valor}$`, 'm'), constante);
    }
  });

  it('tipos, estados y motivos', () => {
    assert.deepEqual([...A.TIPOS_DE_EXCEPCION].sort(), ['closed', 'extra', 'replace']);
    for (const [constante, valor] of [['CERRADA', 'closed'], ['EXTRA', 'extra'], ['SUSTITUYE', 'replace'],
      ['AGENDA_ACTIVA', 'active'], ['AGENDA_EN_PAUSA', 'paused']] as const) {
      assert.match(MODELOS, new RegExp(`^${constante} = "${valor}"$`, 'm'), constante);
    }
    assert.match(DOMINIO, /^SIN_CONFIGURAR = "not_configured"$/m);
    const motivos = new Set([...DOMINIO.matchAll(/motivos\.append\("([a-z_]+)"\)/g)].map((m) => m[1]));
    assert.ok(motivos.size >= 4);
    assert.deepEqual([...motivos].sort(), [...A.MOTIVOS].sort());
  });

  it('cada código de error del servidor tiene su texto, y ninguno sobra', () => {
    const delServidor = new Set([...DOMINIO.matchAll(/code = "([a-z_]+)"/g)].map((m) => m[1] as string));
    assert.ok(delServidor.size >= 15);
    for (const codigo of delServidor) {
      assert.ok(A.CODIGOS_DE_ERROR_DE_LA_AGENDA.includes(codigo), `${codigo} sin texto en la app`);
    }
    for (const codigo of A.CODIGOS_DE_ERROR_DE_LA_AGENDA) {
      assert.ok(delServidor.has(codigo), `${codigo} no está en el servidor`);
      existe(A.claveDeErrorDeLaAgenda(codigo) as string);
    }
    assert.equal(A.claveDeErrorDeLaAgenda('algo_nuevo'), null);
    assert.equal(A.claveDeErrorDeLaAgenda(null), null);
  });

  it('el repositorio pide exactamente las catorce rutas del servidor', () => {
    const repo = readFileSync(join(import.meta.dirname, '..', 'repositories', 'ServiceScheduleRepository.ts'), 'utf8');
    const base = RUTAS.match(/^AGENDA = "([^"]+)"$/m)?.[1] as string;
    const publica = RUTAS.match(/^DISPONIBILIDAD = "([^"]+)"$/m)?.[1] as string;
    const delServidor = new Set(
      [...RUTAS.matchAll(/@router\.(get|put|post|patch|delete)\((f?)"([^"]+)"/g)].map((m) => {
        const ruta = (m[3] as string).replace('{AGENDA}', base).replace('{DISPONIBILIDAD}', publica).replace(/\{\{/g, '{').replace(/\}\}/g, '}');
        return `${(m[1] as string).toUpperCase()} ${ruta.replace(/\{[a-z_]+\}/g, '{}')}`;
      }),
    );
    // Las de ARRIBA con nombre de constante (sin f-string).
    for (const m of RUTAS.matchAll(/@router\.(get|put)\((AGENDA|DISPONIBILIDAD),/g)) {
      delServidor.add(`${(m[1] as string).toUpperCase()} ${(m[2] === 'AGENDA' ? base : publica).replace(/\{[a-z_]+\}/g, '{}')}`);
    }
    const usadas = new Set<string>();
    for (const m of repo.matchAll(/apiRequest<[^>]+>\(([^;]+?)\);/g)) {
      const llamada = m[1] as string;
      const metodo = /json\([^)]*'(PUT|POST|PATCH)'/.exec(llamada)?.[1] ?? /method: '(DELETE)'/.exec(llamada)?.[1] ?? 'GET';
      const ruta = llamada
        .replace(/agenda\(servicio\)/, '`/provider/services/{}/schedule`')
        .replace(/publica\(servicio\)/, '`/catalog/{}/availability`')
        .replace(/\$\{rango\([^)]*\)\}|\$\{pagina\([^)]*\)\}/g, '')
        .replace(/\$\{encodeURIComponent\([a-z]+\)\}/g, '{}')
        .replace(/\$\{`([^`]*)`\}/g, '$1')
        .replace(/[`$]|\{(?!\})|,.*$/g, (x) => (x === '{' ? '{' : ''));
      usadas.add(`${metodo} ${ruta.replace(/\$?\{(agenda|publica)[^}]*\}/g, '').replace(/[`$]/g, '').trim()}`);
    }
    const normal = (r: string) => r.replace(/\{\}/g, '{}').replace(/\s+/g, ' ');
    assert.equal(delServidor.size, 14, [...delServidor].join('\n'));
    assert.equal(usadas.size, 14, [...usadas].join('\n'));
    assert.deepEqual([...usadas].map(normal).sort(), [...delServidor].map(normal).sort());
  });
});

// =========================================================================== //
describe('textos', () => {
  it('cada clave que arma la lógica existe', () => {
    for (const d of [0, ...A.DIAS]) {
      existe(A.claveDelDia(d));
      existe(`${A.claveDelDia(d)}.corto`);
    }
    for (const tipo of [...A.TIPOS_DE_EXCEPCION, 'otro']) existe(A.claveDelTipo(tipo));
    existe(A.claveDelTipo('closed', true));
    for (const estado of [...A.ESTADOS_DEL_CALENDARIO, null, 'raro']) existe(A.claveDelEstadoDeLaAgenda(estado));
    for (const motivo of A.MOTIVOS) existe(A.claveDelMotivo(motivo) as string);
    assert.equal(A.claveDelMotivo('secreto_interno'), null);
    for (const t of ['closedDay', 'closed', 'extra', 'replace']) existe(`servicios.agenda.tipoAyuda.${t}`);
  });

  it('los tres idiomas tienen las mismas claves de la agenda, con los mismos huecos', () => {
    const claves = (dic: Record<string, string>) => Object.keys(dic).filter((k) => k.startsWith('servicios.agenda.')).sort();
    assert.ok(claves(es).length > 150);
    assert.deepEqual(claves(en), claves(es));
    assert.deepEqual(claves(pt), claves(es));
    const huecos = (t: string) => [...t.matchAll(/\{([a-z]+)\}/g)].map((m) => m[1]).sort();
    for (const clave of claves(es)) {
      assert.deepEqual(huecos(en[clave] as string), huecos(es[clave as keyof typeof es]), `en: ${clave}`);
      assert.deepEqual(huecos(pt[clave] as string), huecos(es[clave as keyof typeof es]), `pt: ${clave}`);
    }
  });

  it('ningún texto promete una reserva, un cupo o una confirmación', () => {
    const prohibido = {
      es: /reserva confirmada|horario reservado|último cupo|últimos cupos|quedan \d|confirmar reserva|pagar/i,
      en: /booking confirmed|booked for you|last spot|spots left|confirm booking|\bpay\b/i,
      pt: /reserva confirmada|horário reservado|última vaga|restam \d|confirmar reserva|pagar/i,
    } as Record<string, RegExp>;
    for (const [idioma, dic] of Object.entries(IDIOMAS)) {
      for (const [clave, texto] of Object.entries(dic)) {
        if (clave.startsWith('servicios.agenda.')) assert.ok(!prohibido[idioma]?.test(texto), `${idioma} ${clave}: «${texto}»`);
      }
    }
  });
});

// =========================================================================== //
describe('formularios, con los límites del servidor', () => {
  it('una franja semanal', () => {
    const buena = { dia: 1, inicio: '09:00', fin: '12:00', modalidad: 'virtual', capacidad: '1' };
    assert.deepEqual(A.peticionDeRegla(buena, LIMITES, ['virtual'], 1), {
      peticion: { weekday: 1, start: '09:00', end: '12:00', modality: 'virtual', capacity: 1 },
      fallo: null,
    });
    assert.equal(A.peticionDeRegla({ ...buena, fin: '24:00' }, LIMITES, ['virtual'], 1).fallo, null);
    for (const [cambio, fallo] of [
      [{ dia: null }, 'servicios.agenda.error.dia'],
      [{ dia: 8 }, 'servicios.agenda.error.dia'],
      [{ inicio: '12:00', fin: '09:00' }, 'servicios.agenda.error.franja'],
      [{ inicio: '09:00', fin: '09:00' }, 'servicios.agenda.error.franja'],
      [{ inicio: '09:07' }, 'servicios.agenda.error.franja'],
      [{ inicio: '24:00', fin: '24:00' }, 'servicios.agenda.error.franja'],
      [{ modalidad: 'in_person' }, 'servicios.agenda.error.modalidad'],
      [{ capacidad: '2' }, 'servicios.agenda.error.capacidad'],
      [{ capacidad: '0' }, 'servicios.agenda.error.capacidad'],
      [{ capacidad: 'x' }, 'servicios.agenda.error.capacidad'],
    ] as const) {
      const r = A.peticionDeRegla({ ...buena, ...cambio } as never, LIMITES, ['virtual'], 1);
      assert.deepEqual(r, { peticion: null, fallo }, JSON.stringify(cambio));
      existe(fallo);
    }
    // Con un servicio grupal, la capacidad sube hasta la suya.
    assert.equal(A.peticionDeRegla({ ...buena, capacidad: '8' }, LIMITES, ['virtual'], 8).fallo, null);
  });

  it('la configuración', () => {
    const f = { zona: 'America/Lima', estado: 'active' as const, preparacion: '', descanso: '15', intervalo: '' };
    assert.deepEqual(A.peticionDeAjustes(f, LIMITES), {
      peticion: {
        timezone: 'America/Lima', status: 'active', buffer_before_minutes: 0, buffer_after_minutes: 15,
        slot_interval_minutes: null,
      },
      fallo: null,
    });
    assert.equal(A.peticionDeAjustes(f, LIMITES, true).peticion?.confirm_timezone_change, true);
    for (const [cambio, fallo] of [
      [{ zona: 'UTC-5' }, 'servicios.agenda.error.zona'],
      [{ zona: 'Etc/GMT+5' }, 'servicios.agenda.error.zona'],
      [{ zona: '' }, 'servicios.agenda.error.zona'],
      [{ descanso: '7' }, 'servicios.agenda.error.ajustes'],
      [{ preparacion: '245' }, 'servicios.agenda.error.ajustes'],
      [{ intervalo: '0' }, 'servicios.agenda.error.ajustes'],
      [{ intervalo: '32' }, 'servicios.agenda.error.ajustes'],
    ] as const) {
      assert.deepEqual(A.peticionDeAjustes({ ...f, ...cambio }, LIMITES), { peticion: null, fallo }, JSON.stringify(cambio));
    }
    // Lo que viene del servidor, tal cual; sin agenda, la zona sugerida (no inventada).
    assert.equal(A.ajustesDesde(null, '').zona, '');
    assert.equal(A.ajustesDesde(null, 'America/Bogota').zona, 'America/Bogota');
  });

  it('una excepción', () => {
    const base = A.excepcionVacia('virtual');
    assert.deepEqual(A.peticionDeExcepcion({ ...base, fecha: '08/10/2026' }, LIMITES, ['virtual'], 1).peticion, {
      date: '2026-10-08', kind: 'closed', start: null, end: null, modality: null, capacity: null,
    });
    assert.deepEqual(
      A.peticionDeExcepcion({ ...base, fecha: '08/10/2026', tipo: 'extra', diaEntero: false, inicio: '15:00', fin: '17:00' },
        LIMITES, ['virtual'], 1).peticion,
      { date: '2026-10-08', kind: 'extra', start: '15:00', end: '17:00', modality: 'virtual', capacity: 1 },
    );
    assert.equal(A.peticionDeExcepcion({ ...base, fecha: '31/02/2026' }, LIMITES, ['virtual'], 1).fallo, 'servicios.agenda.error.fecha');
    assert.equal(
      A.peticionDeExcepcion({ ...base, fecha: '08/10/2026', tipo: 'replace', diaEntero: false, inicio: '17:00', fin: '15:00' },
        LIMITES, ['virtual'], 1).fallo,
      'servicios.agenda.error.franja',
    );
    assert.equal(
      A.peticionDeExcepcion({ ...base, fecha: '08/10/2026', tipo: 'extra', diaEntero: false, inicio: '15:00', fin: '17:00',
        modalidad: 'at_home' }, LIMITES, ['virtual'], 1).fallo,
      'servicios.agenda.error.modalidad',
    );
    // Cerrar una franja no lleva modalidad ni capacidad.
    assert.deepEqual(
      A.peticionDeExcepcion({ ...base, fecha: '08/10/2026', diaEntero: false, inicio: '10:00', fin: '11:00' },
        LIMITES, ['virtual'], 1).peticion,
      { date: '2026-10-08', kind: 'closed', start: '10:00', end: '11:00', modality: null, capacity: null },
    );
  });

  it('un bloqueo', () => {
    const f = { desdeFecha: '08/10/2026', desdeHora: '10:00', hastaFecha: '08/10/2026', hastaHora: '11:00', motivo: '  ' };
    assert.deepEqual(A.peticionDeBloqueo(f, LIMITES).peticion, {
      start_date: '2026-10-08', start_time: '10:00', end_date: '2026-10-08', end_time: '11:00', reason: null,
    });
    assert.equal(A.peticionDeBloqueo({ ...f, hastaHora: '10:00' }, LIMITES).fallo, 'servicios.agenda.error.bloqueo');
    assert.equal(A.peticionDeBloqueo({ ...f, hastaFecha: '07/10/2026' }, LIMITES).fallo, 'servicios.agenda.error.bloqueo');
    assert.equal(A.peticionDeBloqueo({ ...f, motivo: 'x'.repeat(201) }, LIMITES).fallo, 'servicios.agenda.error.motivo');
    assert.equal(A.peticionDeBloqueo({ ...f, desdeHora: '10:03' }, LIMITES).fallo, 'servicios.agenda.error.franja');
    // Hasta el día siguiente a medianoche.
    assert.equal(A.peticionDeBloqueo({ ...f, hastaFecha: '09/10/2026', hastaHora: '00:00' }, LIMITES).fallo, null);
  });
});

// =========================================================================== //
describe('fechas y horarios, sin zonas', () => {
  it('sumar días y el día de la semana cruzan meses y años', () => {
    assert.equal(A.sumarDias('2026-12-31', 1), '2027-01-01');
    assert.equal(A.sumarDias('2026-02-28', 1), '2026-03-01');
    assert.equal(A.sumarDias('2028-02-28', 1), '2028-02-29');
    assert.equal(A.sumarDias('2026-10-01', -1), '2026-09-30');
    assert.equal(A.diaDeLaSemana('2026-10-01'), 4);
    assert.equal(A.diaDeLaSemana('2027-01-03'), 7);
    assert.equal(A.diaDeLaSemana('2026-12-28'), 1);
    assert.equal(A.diaDeLaSemana('mañana'), 0);
    assert.equal(A.fechaVisible('2026-10-08'), '08/10/2026');
  });

  it('las horas van en la rejilla, y solo el fin puede ser las 24:00', () => {
    assert.equal(A.minutos('09:30', 5, false), 570);
    assert.equal(A.minutos('24:00', 5, true), 1440);
    assert.equal(A.minutos('24:00', 5, false), null);
    assert.equal(A.minutos('09:31', 5, false), null);
    assert.equal(A.minutos('9:30', 5, false), null);
  });

  it('el rango del calendario enseña también los días sin horarios, sin inventar ninguno', () => {
    const c = {
      from_date: '2026-12-30', to_date: '2027-01-02', days: [{ date: '2026-12-31', count: 2 }],
    } as Calendario;
    assert.deepEqual(A.diasDelRango(c), [
      { date: '2026-12-30', count: 0 }, { date: '2026-12-31', count: 2 },
      { date: '2027-01-01', count: 0 }, { date: '2027-01-02', count: 0 },
    ]);
    assert.deepEqual(A.diasDelRango({ ...c, from_date: null }), []);
  });

  it('la hora repetida del cambio de hora lleva su desplazamiento; las demás, no', () => {
    const h = (starts_at: string, time: string, utc_offset: string) =>
      ({ starts_at, ends_at: starts_at, date: '2026-11-01', time, end_time: time, utc_offset }) satisfies Horario;
    const dia = [h('2026-11-01T05:00:00Z', '01:00', '-04:00'), h('2026-11-01T06:00:00Z', '01:00', '-05:00'),
      h('2026-11-01T07:00:00Z', '02:00', '-05:00')];
    assert.deepEqual(dia.map((x) => A.etiquetaDelHorario(x, dia)), ['01:00 (UTC-04:00)', '01:00 (UTC-05:00)', '02:00']);
    assert.equal(A.juntarHorarios(dia, [dia[2] as Horario, h('2026-11-01T08:00:00Z', '03:00', '-05:00')]).length, 4);
    assert.equal(A.zonaDistinta('America/Lima', 'America/Lima'), false);
    assert.equal(A.zonaDistinta('America/Lima', 'Europe/Madrid'), true);
    assert.equal(A.zonaDistinta('America/Lima', ''), false);
  });
});

// =========================================================================== //
describe('el horario elegido es solo un valor de la ruta', () => {
  const servicio = '3f9b2c1e-8a4d-4c2b-9e7f-1a2b3c4d5e6f';

  it('se lee lo que tiene forma y se descarta lo demás', () => {
    const params = { serviceId: servicio, fecha: '2026-10-08', inicio: '2026-10-08T14:00:00Z', hora: '09:00', modalidad: 'virtual' };
    assert.deepEqual(A.horarioElegidoDesdeRuta(params), {
      servicio, fecha: '2026-10-08', inicio: '2026-10-08T14:00:00Z', hora: '09:00', modalidad: 'virtual',
    });
    for (const malo of [
      { serviceId: 'x' }, { fecha: '08/10/2026' }, { inicio: '2026-10-08 14:00' }, { hora: '9:00' }, { modalidad: '' },
    ]) {
      assert.equal(A.horarioElegidoDesdeRuta({ ...params, ...malo }), null, JSON.stringify(malo));
    }
  });

  it('la ruta solo guarda fecha, instante, hora y modalidad: nada de precio, reserva ni retención', () => {
    const ruta = A.rutaDelHorarioElegido({ fecha: '2026-10-08', inicio: '2026-10-08T14:00:00Z', hora: '09:00', modalidad: 'virtual' });
    assert.deepEqual(Object.keys(ruta).sort(), ['fecha', 'hora', 'inicio', 'modalidad']);
  });
});
