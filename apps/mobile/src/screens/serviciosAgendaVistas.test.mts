/**
 * Z Servicios, Incremento 4: las vistas de la agenda, leídas en su código
 * (aquí no hay renderizador).
 *
 * Que cada vista tiene ruta y se alcanza desde otra (servicio propio →
 * agenda → ajustes, semana, excepciones, bloqueos y vista previa; ficha →
 * horarios), que el acceso a la agenda solo sale si el servidor lo permite,
 * que «Atrás» respeta la pila, que ninguna vista reserva, retiene ni cobra,
 * que no se inventa ningún horario ni se convierte ninguna zona, que el
 * motivo de un bloqueo no sale de la agenda del prestador, que ningún texto
 * está en duro y que los controles se anuncian bien.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { es } from '../i18n/es.ts';
import { en } from '../i18n/en.ts';
import { pt } from '../i18n/pt.ts';

const SRC = join(import.meta.dirname, '..');
const APP = join(SRC, '..', 'app');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
const pantalla = (nombre: string) => sinComentarios(fuente(`screens/${nombre}.tsx`));
const componente = (nombre: string) => sinComentarios(fuente(`components/${nombre}.tsx`));

const AGENDA = '/servicios/prestador/catalogo/[serviceId]/agenda';
/** Ruta de expo-router → pantalla que monta. */
const VISTAS: Record<string, string> = {
  [AGENDA]: 'AgendaDelServicioScreen',
  [`${AGENDA}/ajustes`]: 'AjustesDeAgendaScreen',
  [`${AGENDA}/semanal`]: 'HorarioSemanalScreen',
  [`${AGENDA}/excepciones`]: 'ExcepcionesDeAgendaScreen',
  [`${AGENDA}/bloqueos`]: 'BloqueosDeAgendaScreen',
  [`${AGENDA}/vista-previa`]: 'VistaPreviaDeAgendaScreen',
  '/servicios/horarios/[serviceId]': 'HorariosDelServicioScreen',
};
const PANTALLAS = Object.values(VISTAS);
const DEL_PRESTADOR = PANTALLAS.filter((p) => p !== 'HorariosDelServicioScreen' && p !== 'VistaPreviaDeAgendaScreen');
const COMPONENTES = ['SelectorDeHorarios', 'DisponibilidadEnLaFicha'];
const TODO = [...PANTALLAS.map(pantalla), ...COMPONENTES.map(componente)].join('\n');

function ficheroDeLaRuta(ruta: string): string | null {
  const base = join(APP, ...ruta.split('/').filter(Boolean));
  if (existsSync(`${base}.tsx`)) return `${base}.tsx`;
  if (existsSync(join(base, 'index.tsx'))) return join(base, 'index.tsx');
  return null;
}

// =========================================================================== //
describe('cada vista tiene ruta y se alcanza desde otra', () => {
  for (const [ruta, nombre] of Object.entries(VISTAS)) {
    it(`${ruta} monta ${nombre}`, () => {
      const fichero = ficheroDeLaRuta(ruta);
      assert.ok(fichero, `no hay fichero para ${ruta}`);
      assert.match(readFileSync(fichero, 'utf8'), new RegExp(`from '@/screens/${nombre}'`));
    });
  }

  it('servicio propio → agenda, SOLO si el servidor dice que se puede', () => {
    const codigo = pantalla('ServicioDelPrestadorScreen');
    assert.match(codigo, /\{s\.can_manage_schedule \? \(\s*<ListRow[\s\S]*?router\.push\(`\$\{ruta\}\/agenda` as never\)/);
  });

  it('agenda → ajustes, semana, excepciones, bloqueos y vista previa', () => {
    const codigo = pantalla('AgendaDelServicioScreen');
    for (const destino of ['ajustes', 'semanal', 'excepciones', 'bloqueos', 'vista-previa']) {
      assert.match(codigo, new RegExp(`router\\.push\\(\`\\$\\{ruta\\}/${destino}\` as never\\)`), destino);
    }
    // Sin agenda, configurarla solo lo ofrece quien puede.
    assert.match(codigo, /actionLabel=\{a\.can_edit \? f\('servicios\.agenda\.configurar'\) : undefined\}/);
  });

  it('ficha → horarios, desde la sección de disponibilidad', () => {
    assert.match(pantalla('FichaDeServicioScreen'), /<DisponibilidadEnLaFicha servicio=\{ficha\.id\} \/>/);
    assert.match(componente('DisponibilidadEnLaFicha'), /router\.push\(`\/servicios\/horarios\/\$\{servicio\}` as never\)/);
  });

  it('«Atrás» respeta la pila y cae en la pantalla de la que se vino', () => {
    for (const nombre of PANTALLAS) {
      const codigo = pantalla(nombre);
      const cabeceras = [...codigo.matchAll(/<AppHeader[\s\S]*?\/>/g)].map((m) => m[0]);
      assert.ok(cabeceras.length > 0 && cabeceras.every((c) => /onBack=\{volver\}/.test(c)), nombre);
      assert.match(codigo, /router\.canGoBack\(\) \? router\.back\(\) : router\.replace\(/, nombre);
    }
    assert.match(pantalla('AgendaDelServicioScreen'), /router\.replace\(`\/servicios\/prestador\/catalogo\/\$\{id\}` as never\)/);
    for (const nombre of [...DEL_PRESTADOR.slice(1), 'VistaPreviaDeAgendaScreen']) {
      assert.match(pantalla(nombre), /router\.replace\(`\/servicios\/prestador\/catalogo\/\$\{id\}\/agenda` as never\)/, nombre);
    }
    assert.match(pantalla('HorariosDelServicioScreen'), /router\.replace\(`\/servicios\/ficha\/\$\{id\}` as never\)/);
  });

  it('con Servicios apagado o sin la 0092, la ficha no enseña la sección', () => {
    const seccion = componente('DisponibilidadEnLaFicha');
    assert.match(seccion, /\.catch\(\(\) => \{\s*if \(vigente\) setOculta\(true\);\s*\}\)/);
    assert.match(seccion, /if \(oculta \|\| calendario === null\) return null;/);
  });
});

// =========================================================================== //
describe('cada vista se comporta', () => {
  for (const nombre of DEL_PRESTADOR) {
    it(`${nombre}: carga, error con reintento, bloqueo del doble toque`, () => {
      const codigo = pantalla(nombre);
      assert.match(codigo, /<StateView state="loading" \/>/);
      assert.match(codigo, /<EstadoDelCatalogo fallo=\{fallo\} onRetry=\{\(\) => void cargar\(\)\} \/>/);
      assert.match(codigo, /useAgendaPropia\(id\)/);
      assert.match(codigo, /useTextosDeServicios\('agenda'\)/);
      if (nombre !== 'AgendaDelServicioScreen') {
        assert.match(codigo, /useCerrojo\(cargar, 'agenda'\)/);
        assert.match(codigo, /disabled=\{ocupado\}/);
      }
    });
  }

  it('cada escritura con alta lleva su Idempotency-Key, renovada tras el éxito', () => {
    for (const [nombre, metodo] of [
      ['HorarioSemanalScreen', 'crearRegla'], ['ExcepcionesDeAgendaScreen', 'crearExcepcion'], ['BloqueosDeAgendaScreen', 'crearBloqueo'],
    ] as const) {
      const codigo = pantalla(nombre);
      assert.match(codigo, new RegExp(`ServiceScheduleRepository\\.${metodo}\\(id, peticion, clave\\.current\\)\\);\\s*clave\\.current = nuevaClave\\(\\);`), nombre);
    }
  });

  it('quitar pide confirmación, y cambiar la zona también', () => {
    for (const nombre of ['HorarioSemanalScreen', 'ExcepcionesDeAgendaScreen', 'BloqueosDeAgendaScreen']) {
      assert.match(pantalla(nombre), /await confirm\(\{[\s\S]*?destructive: true,/, nombre);
    }
    assert.match(pantalla('AjustesDeAgendaScreen'), /servicios\.agenda\.cambiarZona\.aviso/);
    assert.match(pantalla('AjustesDeAgendaScreen'), /peticionDeAjustes\(campos, agenda\.limits, cambiaZona\)/);
  });

  it('los límites de los formularios los manda el servidor', () => {
    for (const nombre of ['AjustesDeAgendaScreen', 'HorarioSemanalScreen', 'ExcepcionesDeAgendaScreen', 'BloqueosDeAgendaScreen']) {
      assert.match(pantalla(nombre), /a(genda)?\.limits/, nombre);
    }
    assert.match(pantalla('BloqueosDeAgendaScreen'), /maxLength=\{a\.limits\.reason_max_length\}/);
  });

  it('estados vacíos que dicen qué pasa', () => {
    const selector = componente('SelectorDeHorarios');
    for (const clave of ['sinAgenda', 'enPausa', 'sinHorariosEnRango', 'sinHorarios', 'sinHorariosEseDia', 'horizonte', 'noDisponible']) {
      assert.match(selector, new RegExp(`servicios\\.agenda\\.vacio\\.${clave}`), clave);
    }
    assert.match(selector, /calendario\.status === 'not_configured'/);
    assert.match(selector, /calendario\.status === 'paused'/);
    assert.match(selector, /error\.code === 'service_availability_out_of_horizon'/);
    assert.match(pantalla('AgendaDelServicioScreen'), /servicios\.agenda\.sinConfigurar/);
  });
});

// =========================================================================== //
describe('lo decide el servidor, y nada se reserva', () => {
  it('ninguna vista reserva, retiene, contrata ni cobra', () => {
    // En cualquier parte (también dentro de un nombre: `crearReserva`)…
    const dinero = /reserv|booking|checkout|payment|pagar|contratar|stripe/i;
    // …y como palabra entera lo que se esconde en otras («borderColor», «placeholder»).
    const palabras = /\b(holds?|orders?)\b/i;
    const limpio = TODO.replace(/servicios\.agenda\.(sinReservas|sinReservasPublico)/g, '');
    assert.ok(!dinero.test(limpio), limpio.match(dinero)?.[0]);
    assert.ok(!palabras.test(limpio), limpio.match(palabras)?.[0]);
    assert.ok(dinero.test('crearReserva(') && palabras.test('slot hold') && !palabras.test('borderColor placeholder'));
    const publica = pantalla('HorariosDelServicioScreen');
    // Lo público solo LEE: ni una escritura del repositorio.
    assert.ok(!/ServiceScheduleRepository\.(configurar|crear|editar|borrar)/.test(publica));
    assert.ok(!/<Button/.test(publica), 'no hay botón final: elegir solo guarda en la ruta');
    assert.match(publica, /router\.setParams\(rutaDelHorarioElegido\(/);
    assert.match(publica, /servicios\.agenda\.noApartado/);
  });

  it('ningún horario ni zona se calcula en el teléfono', () => {
    assert.ok(!/toLocaleTimeString|toLocaleDateString|getTimezoneOffset|Intl\.DateTimeFormat\(|new Date\(/.test(TODO));
    const selector = componente('SelectorDeHorarios');
    // Se pinta lo que llega: la hora local, su desplazamiento y cuántos hay.
    assert.match(selector, /etiquetaDelHorario\(h, horarios\)/);
    assert.match(selector, /f\('servicios\.agenda\.horasEn', \{ zona: calendario\.timezone \?\? '' \}\)/);
    assert.match(selector, /zonaDistinta\(calendario\.timezone, dispositivo\)/);
    assert.ok(!/\.sort\(/.test(selector), 'no se reordena lo que manda el servidor');
  });

  it('el motivo de un bloqueo solo sale en la pantalla de bloqueos', () => {
    for (const nombre of PANTALLAS.filter((p) => p !== 'BloqueosDeAgendaScreen')) {
      assert.ok(!/\.reason\b/.test(pantalla(nombre)), nombre);
    }
    for (const nombre of COMPONENTES) assert.ok(!/\.reason\b/.test(componente(nombre)), nombre);
    assert.match(pantalla('BloqueosDeAgendaScreen'), /servicios\.agenda\.motivoSoloTu/);
  });

  it('nadie escribe en la base desde el teléfono', () => {
    const repo = fuente('repositories/ServiceScheduleRepository.ts');
    for (const codigo of [TODO, repo]) {
      assert.ok(!/supabase|\.from\(|\.rpc\(|storage_path|fetch\(/.test(codigo));
    }
    assert.match(repo, /apiRequest</);
  });
});

// =========================================================================== //
describe('accesibilidad y textos', () => {
  it('las fechas y los horarios se anuncian como botones, con estado y nombre', () => {
    const selector = componente('SelectorDeHorarios');
    assert.match(selector, /accessibilityState=\{\{ selected: actual, disabled: !con \}\}/);
    assert.match(selector, /accessibilityLabel=\{f\(con \? 'servicios\.agenda\.fechaConHorarios'/);
    assert.match(selector, /accessibilityLabel=\{f\('servicios\.agenda\.horarioAccesible'/);
    assert.match(selector, /accessibilityRole=\{alElegir \? 'button' : 'text'\}/);
    assert.match(selector, /minWidth: 48,\s*minHeight: 56/);
    assert.match(selector, /minWidth: 72,\s*minHeight: 44/);
  });

  it('las elecciones únicas son botones de opción', () => {
    for (const nombre of ['AjustesDeAgendaScreen', 'HorarioSemanalScreen', 'ExcepcionesDeAgendaScreen']) {
      assert.ok((pantalla(nombre).match(/rol="radio"/g) ?? []).length >= 2, nombre);
    }
  });

  it('ningún texto en duro', () => {
    for (const [nombre, codigo] of [...PANTALLAS.map((p) => [p, pantalla(p)]), ...COMPONENTES.map((c) => [c, componente(c)])]) {
      for (const atributo of ['label="', 'title="', 'description="', 'placeholder="', 'actionLabel="', 'accessibilityLabel="']) {
        assert.ok(!(codigo as string).includes(atributo), `${nombre} escribe ${atributo}…" en duro`);
      }
      for (const m of (codigo as string).matchAll(/<Text[^>]*>([^<{]+)<\/Text>/g)) {
        assert.equal((m[1] as string).trim(), '', `${nombre}: texto en duro «${m[1]}»`);
      }
    }
  });

  it('cada clave escrita en las vistas existe en es, en y pt', () => {
    const claves = new Set([...TODO.matchAll(/'(servicios\.[A-Za-z0-9_.]+)'/g)].map((m) => m[1] as string));
    assert.ok(claves.size > 60, `solo ${claves.size} claves`);
    for (const clave of claves) {
      for (const [idioma, dic] of Object.entries({ es, en, pt })) {
        assert.ok(clave in dic, `falta «${clave}» en ${idioma}`);
      }
    }
  });
});
