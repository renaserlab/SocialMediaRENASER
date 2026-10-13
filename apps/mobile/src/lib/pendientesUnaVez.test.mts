import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CLAVE_DE_PENDIENTES_DICHOS,
  claveDePendientesDichos,
  hayPendientesSinDecir,
  leerPendientesDichos,
  ultimoSinLeer,
} from './avisosNuevos.ts';

/**
 * LA VENTANA FLOTANTE QUE VOLVÍA A SALIR (teléfono, 13/10/2026).
 *
 * A una persona le aparecía, cada vez que abría la aplicación, la misma
 * ventana —«Sesión confirmada · … aceptó tu solicitud»— de un aviso de hacía
 * días. Lo pendiente se anunciaba «al entrar», y lo ya dicho se recordaba solo
 * mientras la aplicación seguía abierta.
 *
 * Y EL ICONO DE LAS NOTIFICACIONES, que enseñaba una «R» donde va la Z.
 */

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const RAIZ = join(SRC, '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (codigo: string) =>
  codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const aviso = (createdAtIso: string | undefined, read = false) => ({ createdAtIso, read });
const LUNES = '2026-10-05T15:00:00.000Z';
const MARTES = '2026-10-06T15:00:00.000Z';
const MIERCOLES = '2026-10-07T15:00:00.000Z';

describe('lo pendiente se dice una vez por teléfono', () => {
  it('EL FALLO: el mismo aviso sin leer, al volver a abrir la aplicación, ya no se repite', () => {
    const bandeja = [aviso(LUNES)];
    // Primer arranque: nada guardado todavía, se dice.
    assert.equal(hayPendientesSinDecir(bandeja, 0), true);
    const dichoHasta = ultimoSinLeer(bandeja);
    // Segundo arranque, tercero, décimo: el aviso sigue sin leer y no vuelve a saltar.
    assert.equal(hayPendientesSinDecir(bandeja, dichoHasta), false);
  });

  it('si llega otro aviso con la aplicación cerrada, ese sí se dice', () => {
    const dichoHasta = ultimoSinLeer([aviso(LUNES)]);
    assert.equal(hayPendientesSinDecir([aviso(MARTES), aviso(LUNES)], dichoHasta), true);
  });

  it('lo leído no cuenta, por reciente que sea', () => {
    const dichoHasta = ultimoSinLeer([aviso(LUNES)]);
    assert.equal(hayPendientesSinDecir([aviso(MIERCOLES, true), aviso(LUNES)], dichoHasta), false);
    assert.equal(ultimoSinLeer([aviso(MIERCOLES, true)]), 0);
  });

  it('sin nada pendiente no hay nada que decir', () => {
    assert.equal(hayPendientesSinDecir([], 0), false);
    assert.equal(hayPendientesSinDecir([aviso(LUNES, true)], 0), false);
  });

  it('si el servidor no dice de cuándo es un aviso, se dice una vez y solo una', () => {
    const bandeja = [aviso(undefined)];
    assert.equal(hayPendientesSinDecir(bandeja, 0), true);
    assert.equal(hayPendientesSinDecir(bandeja, ultimoSinLeer(bandeja)), false);
  });

  it('lo guardado se lee sin fiarse', () => {
    assert.equal(leerPendientesDichos(null), 0);
    assert.equal(leerPendientesDichos(''), 0);
    assert.equal(leerPendientesDichos('basura'), 0);
    assert.equal(leerPendientesDichos('-5'), 0);
    assert.equal(leerPendientesDichos(String(Date.parse(LUNES))), Date.parse(LUNES));
  });

  it('se guarda por cuenta: lo dicho a una persona no calla lo de otra', () => {
    assert.notEqual(claveDePendientesDichos('ana'), claveDePendientesDichos('luis'));
    assert.ok(claveDePendientesDichos('ana').startsWith(CLAVE_DE_PENDIENTES_DICHOS));
    assert.equal(claveDePendientesDichos(null), CLAVE_DE_PENDIENTES_DICHOS);
  });

  it('el anfitrión de los avisos lo consulta y lo guarda antes de anunciar', () => {
    const gancho = sinComentarios(fuente('hooks/useAvisosEnVivo.ts'));
    const decir = gancho.slice(
      gancho.indexOf('const decirAvisosPendientes = async'),
      gancho.indexOf('const leerAvisos = async'),
    );
    assert.match(decir, /const clave = claveDePendientesDichos\(yo\);/);
    assert.match(decir, /await AsyncStorage\.getItem\(clave\)\.catch\(\(\) => null\)/);
    assert.match(decir, /if \(!vivo \|\| !hayPendientesSinDecir\(avisos, leerPendientesDichos\(guardado\)\)\) return;/);
    assert.match(decir, /AsyncStorage\.setItem\(clave, String\(ultimoSinLeer\(avisos\)\)\)/);
    // Primero se decide y se apunta; después se anuncia.
    assert.ok(decir.indexOf('AsyncStorage.setItem') < decir.indexOf('avisar('));
    // La regla de «no repetir mientras sigue abierta» no se ha tocado.
    assert.match(gancho, /const decirPendientes = entrando && hayPendientesQueDecir\(lectura\.cuenta, avisosDichos\);/);
  });
});

describe('el icono de las notificaciones es la Z', () => {
  const png = readFileSync(join(RAIZ, 'assets', 'notification-icon.png'));

  it('es un PNG de 96 × 96 con transparencia, que es lo que Android pide para ese icono', () => {
    assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
    assert.equal(png.readUInt32BE(16), 96, 'ancho');
    assert.equal(png.readUInt32BE(20), 96, 'alto');
    // Tipo de color 6: rojo, verde, azul y ALFA. Android solo mira el alfa.
    assert.equal(png.readUInt8(25), 6);
  });

  it('la configuración apunta a él', () => {
    const app = JSON.parse(readFileSync(join(RAIZ, 'app.json'), 'utf8'));
    const avisos = app.expo.plugins.find(
      (plugin: unknown) => Array.isArray(plugin) && plugin[0] === 'expo-notifications',
    );
    assert.equal(avisos[1].icon, './assets/notification-icon.png');
  });
});
