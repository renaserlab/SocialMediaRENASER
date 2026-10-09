import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  FRANJAS_POR_DIA,
  MINUTOS_DE_SESION,
  aFechaYHora,
  aMinutos,
  agruparPorDia,
  juzgarFranja,
  leerDisponibilidad,
  leerHuecos,
  ordenarFranjas,
} from './disponibilidad.ts';

/*
  Disponibilidad para las sesiones 1:1 (prototipo, 09/10/2026). Lo esencial:
  una franja sin sentido se dice antes de guardar, lo que manda el servidor se
  lee sin romperse, y la aplicación y el servidor usan los mismos números.
*/

const leer = (ruta: string) =>
  readFileSync(new URL(ruta, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('las horas se leen en minutos, y lo que no es una hora no', () => {
  assert.equal(aMinutos('09:30'), 570);
  assert.equal(aMinutos('00:00'), 0);
  assert.equal(aMinutos('24:00'), 1440);
  for (const mala of ['', '9am', '25:00', '12:60', '24:01', '1200']) {
    assert.equal(aMinutos(mala), null, mala);
  }
});

test('una franja vale si dura una sesión y no se pisa con otra del día', () => {
  const lunes = { dia: 0, desde: '09:00', hasta: '12:00' };
  assert.equal(juzgarFranja({ dia: 0, desde: '15:00', hasta: '16:00' }, [lunes]), 'vale');
  // Pegada a otra, sin pisarla.
  assert.equal(juzgarFranja({ dia: 0, desde: '12:00', hasta: '13:00' }, [lunes]), 'vale');
  // El mismo horario otro día.
  assert.equal(juzgarFranja({ dia: 1, desde: '09:00', hasta: '12:00' }, [lunes]), 'vale');
});

test('se dice qué le pasa a una franja que no vale', () => {
  const lunes = { dia: 0, desde: '09:00', hasta: '12:00' };
  assert.equal(juzgarFranja({ dia: 0, desde: '', hasta: '10:00' }, []), 'hora');
  assert.equal(juzgarFranja({ dia: 0, desde: '10:00', hasta: '10:30' }, []), 'corta');
  assert.equal(juzgarFranja({ dia: 0, desde: '11:00', hasta: '10:00' }, []), 'corta');
  assert.equal(juzgarFranja({ dia: 0, desde: '11:00', hasta: '13:00' }, [lunes]), 'se_pisa');
  assert.equal(juzgarFranja({ dia: 0, desde: '08:00', hasta: '13:00' }, [lunes]), 'se_pisa');

  const lleno = Array.from({ length: FRANJAS_POR_DIA }, (_, i) => ({
    dia: 2,
    desde: `${String(8 + i * 2).padStart(2, '0')}:00`,
    hasta: `${String(9 + i * 2).padStart(2, '0')}:00`,
  }));
  assert.equal(juzgarFranja({ dia: 2, desde: '20:00', hasta: '21:00' }, lleno), 'llena');
});

test('las franjas se ordenan por día y por hora, sin tocar la lista original', () => {
  const desordenadas = [
    { dia: 3, desde: '15:00', hasta: '16:00' },
    { dia: 1, desde: '14:00', hasta: '15:00' },
    { dia: 1, desde: '09:00', hasta: '10:00' },
  ];
  assert.deepEqual(
    ordenarFranjas(desordenadas).map((f) => `${f.dia} ${f.desde}`),
    ['1 09:00', '1 14:00', '3 15:00'],
  );
  assert.equal(desordenadas[0]?.dia, 3);
});

test('se lee la disponibilidad del servidor y se descarta la fila que no se entiende', () => {
  const leida = leerDisponibilidad({
    available: true,
    timezone: 'America/Lima',
    slots: [
      { weekday: 3, start: '15:00', end: '17:00' },
      { weekday: 1, start: '09:00', end: '12:00' },
      { weekday: 9, start: '09:00', end: '12:00' },
      { weekday: 2, start: 'mañana', end: '12:00' },
      null,
    ],
  });
  assert.deepEqual(leida, {
    disponible: true,
    zona: 'America/Lima',
    franjas: [
      { dia: 1, desde: '09:00', hasta: '12:00' },
      { dia: 3, desde: '15:00', hasta: '17:00' },
    ],
  });
});

test('un servidor sin la función dice que no está, y otra cosa no es disponibilidad', () => {
  assert.deepEqual(leerDisponibilidad({ available: false }), {
    disponible: false,
    zona: 'America/Lima',
    franjas: [],
  });
  for (const bruto of [null, [], 'x', {}, { slots: [] }]) {
    assert.equal(leerDisponibilidad(bruto), null);
  }
});

test('los huecos se leen; sin función o sin lista, no hay ninguno', () => {
  const dos = leerHuecos({
    available: true,
    openings: [
      { starts_at: '2026-10-13T14:00:00Z', ends_at: '2026-10-13T15:00:00Z' },
      { starts_at: 'no es una fecha', ends_at: 'x' },
      { starts_at: '2026-10-13T15:00:00Z', ends_at: '2026-10-13T16:00:00Z' },
    ],
  });
  assert.deepEqual(
    dos.map((h) => h.empiezaIso),
    ['2026-10-13T14:00:00Z', '2026-10-13T15:00:00Z'],
  );
  assert.deepEqual(leerHuecos({ available: false, openings: [{}] }), []);
  assert.deepEqual(leerHuecos(null), []);
  assert.deepEqual(leerHuecos({ available: true }), []);
});

test('un hueco se dice en la hora del teléfono, con el formato de los campos', () => {
  const iso = '2026-10-13T14:00:00Z';
  const local = new Date(iso);
  const dos = (n: number) => String(n).padStart(2, '0');
  assert.deepEqual(aFechaYHora(iso), {
    fecha: `${dos(local.getDate())}/${dos(local.getMonth() + 1)}/${local.getFullYear()}`,
    hora: `${dos(local.getHours())}:${dos(local.getMinutes())}`,
  });
  assert.match(aFechaYHora(iso).fecha, /^\d{2}\/\d{2}\/\d{4}$/);
  assert.match(aFechaYHora(iso).hora, /^\d{2}:\d{2}$/);
});

test('los huecos se agrupan por día, en el orden en que llegan', () => {
  // A mediodía UTC: el mismo día en cualquier zona horaria razonable.
  const dias = agruparPorDia([
    { empiezaIso: '2026-10-13T12:00:00Z', terminaIso: '2026-10-13T13:00:00Z' },
    { empiezaIso: '2026-10-13T13:00:00Z', terminaIso: '2026-10-13T14:00:00Z' },
    { empiezaIso: '2026-10-15T12:00:00Z', terminaIso: '2026-10-15T13:00:00Z' },
  ]);
  assert.deepEqual(
    dias.map((d) => d.huecos.length),
    [2, 1],
  );
  assert.deepEqual(agruparPorDia([]), []);
});

test('la aplicación y el servidor usan los mismos números y las mismas rutas', () => {
  const servidor = leer('../../../api/app/modules/bookings/disponibilidad.py');
  assert.match(servidor, new RegExp(`MINUTOS_DE_SESION = ${MINUTOS_DE_SESION}\\b`));
  assert.match(servidor, new RegExp(`FRANJAS_POR_DIA = ${FRANJAS_POR_DIA}\\b`));

  const repositorio = leer('../repositories/AvailabilityRepository.ts');
  assert.ok(repositorio.includes('/availability/me`'));
  assert.ok(repositorio.includes('/openings`'));
  assert.ok(servidor.includes('prefix="/availability"'));
  assert.ok(servidor.includes('"/{user_id}/openings"'));
});

test('pedir una sesión sigue funcionando si no hay huecos que ofrecer', () => {
  const repositorio = leer('../repositories/AvailabilityRepository.ts');
  const funcion = repositorio.slice(repositorio.indexOf('async huecosDe'));
  // Cualquier fallo es «no hay huecos»: la hoja queda como era.
  assert.match(funcion, /catch \{\s*return \[\];\s*\}/);

  const hoja = leer('../components/BookSessionSheet.tsx');
  assert.match(hoja, /\{dias\.length > 0 \? \(/);
  // Los campos de día y hora siguen estando: elegir un hueco solo los rellena.
  assert.match(hoja, /<DateField label=\{t\('booking\.date'\)\}/);
  assert.match(hoja, /setDate\(fecha\);\s*setTime\(hora\);/);
});
