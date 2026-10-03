/**
 * Z Servicios, Incremento 3: la lógica pura del descubrimiento, contra el
 * servidor.
 *
 * Lo que aquí no puede desalinearse sin que nadie se entere:
 *  - los VALORES CERRADOS (órdenes, precios, motivos, campos) y los CÓDIGOS
 *    de error son los del servidor, leídos de su código fuente;
 *  - cada CLAVE que esta lógica arma existe en los tres idiomas;
 *  - los filtros viven en la ruta sin perder nada y sin aceptar basura;
 *  - la consulta nunca manda un importe sin moneda ni mezcla monedas;
 *  - nada se inventa: sin reseñas no hay nota, una señal falsa no se pinta,
 *    un motivo desconocido no se enseña.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { es } from '../i18n/es.ts';
import { en } from '../i18n/en.ts';
import { pt } from '../i18n/pt.ts';
import type { TarjetaDeServicio } from './serviciosDescubrimiento.ts';

registerHooks({
  resolve(especificador, contexto, siguiente) {
    if (especificador.startsWith('@/')) {
      return { url: new URL(`../${especificador.slice(2)}.ts`, import.meta.url).href, shortCircuit: true };
    }
    return siguiente(especificador, contexto);
  },
});

const D = await import('./serviciosDescubrimiento.ts');

const API = join(import.meta.dirname, '..', '..', '..', 'api', 'app', 'modules', 'services');
const servidor = (fichero: string) => readFileSync(join(API, fichero), 'utf8').replace(/\r\n/g, '\n');
const DOMINIO = servidor('descubrimiento.py');
const RUTAS = servidor('descubrimiento_router.py');
const IDIOMAS = { es, en, pt } as Record<string, Record<string, string>>;

function tupla(nombre: string): string[] {
  const m = DOMINIO.match(new RegExp(`^${nombre} = \\(([^)]*)\\)`, 'm'));
  assert.ok(m, `no se encontró ${nombre} en descubrimiento.py`);
  const nombres = [...(m[1] as string).matchAll(/([A-Z_]+)/g)].map((x) => x[1] as string);
  return nombres.map((n) => {
    const v = DOMINIO.match(new RegExp(`^${n} = "([a-z_]+)"`, 'm'));
    assert.ok(v, `sin valor para ${n}`);
    return v[1] as string;
  });
}

function existe(clave: string): void {
  for (const [idioma, dic] of Object.entries(IDIOMAS)) {
    assert.ok(clave in dic, `falta «${clave}» en ${idioma}`);
  }
}

const tarjeta = (extra: Partial<TarjetaDeServicio> = {}): TarjetaDeServicio => ({
  id: 's1',
  title: 'Asesoría',
  summary: null,
  category: { id: 'c1', slug: 'c', name: 'Legal', name_en: null, name_pt: null, icon: null, parent_id: null },
  modality: 'virtual',
  location_area: null,
  duration_minutes: 60,
  price: { model: 'fixed', amount_minor: 12000, currency: 'PEN' },
  cover: null,
  provider: { id: 'p1', display_name: 'Ana' },
  credential_verified: false,
  saved: false,
  reason: null,
  reason_fields: [],
  ...extra,
});

// =========================================================================== //
describe('los valores son los del servidor', () => {
  it('órdenes, precios y motivos', () => {
    assert.deepEqual([...D.ORDENES], tupla('ORDENES'));
    assert.deepEqual([...D.TIPOS_DE_PRECIO], tupla('TIPOS_DE_PRECIO'));
    assert.deepEqual([...D.MOTIVOS], tupla('MOTIVOS'));
  });

  it('los campos donde puede coincidir una búsqueda', () => {
    const m = DOMINIO.match(/^_CAMPOS_BUSCADOS = \(([^)]*)\)/m);
    assert.ok(m);
    assert.deepEqual([...D.CAMPOS_DE_COINCIDENCIA], [...(m[1] as string).matchAll(/"([a-z]+)"/g)].map((x) => x[1]));
  });

  it('cada código de error del descubrimiento tiene texto, y todos existen en el servidor', () => {
    const delServidor = new Set(
      [...(DOMINIO + RUTAS).matchAll(/code = "([a-z_]+)"/g)].map((x) => x[1] as string),
    );
    for (const codigo of D.CODIGOS_DE_ERROR_DEL_DESCUBRIMIENTO) {
      if (codigo !== 'invalid_cursor') assert.ok(delServidor.has(codigo), `${codigo} no está en el servidor`);
      existe(D.claveDeErrorDelDescubrimiento(codigo) as string);
    }
    for (const codigo of delServidor) {
      assert.ok(D.CODIGOS_DE_ERROR_DEL_DESCUBRIMIENTO.includes(codigo), `${codigo} sin texto en la app`);
    }
    assert.equal(D.claveDeErrorDelDescubrimiento('algo_nuevo'), null);
  });

  it('el repositorio pide exactamente las rutas del servidor, ni una más', () => {
    const repo = readFileSync(join(import.meta.dirname, '..', 'repositories', 'ServiceDiscoveryRepository.ts'), 'utf8');
    const delServidor = new Set(
      [...RUTAS.matchAll(/@router\.(get|post|delete)\("([^"]+)"/g)].map((x) => `${(x[1] as string).toUpperCase()} ${x[2]}`),
    );
    const usadas = new Set<string>();
    for (const m of repo.matchAll(/`\$\{BASE\}(\/[^`?]*)(?:\?[^`]*)?`(?:, \{ method: '(POST|DELETE)' \})?/g)) {
      const ruta = (m[1] as string).replace(/\$\{encodeURIComponent\(id\)\}/g, '{id}').replace(/\$\{consultaDelCatalogo[^}]*\}/, '');
      usadas.add(`${m[2] ?? 'GET'} /services${ruta}`);
    }
    const normalizar = (r: string) => r.replace(/\{[a-z_]+\}/g, '{id}');
    // Sin esto, dos conjuntos vacíos también serían «iguales».
    assert.equal(delServidor.size, 8, [...delServidor].join(', '));
    assert.equal(usadas.size, 8, [...usadas].join(', '));
    assert.deepEqual(
      [...usadas].map(normalizar).sort(),
      [...delServidor].map((r) => normalizar(r.replace(' /', ' /services/'))).map((r) => r.replace('/services/services', '/services')).sort(),
    );
  });
});

// =========================================================================== //
describe('los filtros en la ruta', () => {
  it('van y vuelven sin perder nada', () => {
    const f = {
      ...D.SIN_FILTROS,
      q: 'contabilidad pymes',
      categoria: '5b7e2f7a-8d1c-4a55-9d61-0c3f1e2a4b6c',
      modalidad: 'in_person' as const,
      precio: 'on_request' as const,
      zona: 'Miraflores',
      conCredencial: true,
      orden: 'relevance' as const,
    };
    assert.deepEqual(D.filtrosDesdeRuta(D.rutaDesdeFiltros(f)), f);
  });

  it('EL PILOTO ES GRATUITO: «con precio», la moneda, el rango y el orden por precio no se ofrecen', () => {
    assert.deepEqual([...D.TIPOS_DE_PRECIO_OFRECIDOS], ['free', 'on_request']);
    // El servidor sigue entendiendo `priced`; aquí no se ofrece.
    assert.ok((D.TIPOS_DE_PRECIO as readonly string[]).includes('priced'));
    assert.ok(!(D.TIPOS_DE_PRECIO_OFRECIDOS as readonly string[]).includes('priced'));
    // Un enlace viejo con esos filtros se abre SIN ellos, y no ordena por precio.
    const f = D.filtrosDesdeRuta({ precio: 'priced', moneda: 'PEN', minimo: '100', maximo: '250', orden: 'price_asc' });
    assert.deepEqual([f.precio, f.moneda, f.minimo, f.maximo], [null, null, '', '']);
    assert.deepEqual(D.ordenesPosibles(f), ['recent']);
    assert.ok(!/price|currency/.test(D.consultaDelCatalogo(f, null)), D.consultaDelCatalogo(f, null));
    // La pantalla itera la lista ofrecida y ya no pinta ni la moneda ni el rango.
    const pantalla = readFileSync(join(import.meta.dirname, '..', 'screens', 'ServiciosScreen.tsx'), 'utf8');
    assert.ok(pantalla.includes('[null, ...TIPOS_DE_PRECIO_OFRECIDOS].map('));
    assert.ok(!/\.\.\.TIPOS_DE_PRECIO\]/.test(pantalla), 'vuelve a ofrecer «con precio»');
    for (const resto of ["hoja.precio === 'priced'", 'filtros.monedaAviso', 'filtros.desde', 'filtros.hasta']) {
      assert.ok(!pantalla.includes(resto), resto);
    }
  });

  it('lo que no se entiende se descarta', () => {
    const f = D.filtrosDesdeRuta({
      categoria: 'no-es-un-id', modalidad: 'hybrid', precio: 'cheap', moneda: 'XXX', orden: 'popular',
      credencial: 'si',
    });
    assert.deepEqual(f, D.SIN_FILTROS);
  });

  it('limpiar deja la búsqueda y quita lo demás', () => {
    const f = { ...D.SIN_FILTROS, q: 'sunat', modalidad: 'virtual' as const, moneda: 'PEN' };
    assert.deepEqual(D.limpiarFiltros(f), { ...D.SIN_FILTROS, q: 'sunat' });
    assert.equal(D.cuantosFiltros(f), 2);
    assert.equal(D.estaBuscando(D.SIN_FILTROS), false);
    assert.equal(D.estaBuscando({ ...D.SIN_FILTROS, q: 'x' }), true);
  });
});

describe('la consulta', () => {
  it('sin nada: lo más reciente', () => {
    assert.equal(D.consultaDelCatalogo(D.SIN_FILTROS, null), 'sort=recent&limit=20');
  });

  it('cada filtro viaja al servidor (el teléfono no filtra)', () => {
    const q = D.consultaDelCatalogo(
      {
        ...D.SIN_FILTROS, categoria: '5b7e2f7a-8d1c-4a55-9d61-0c3f1e2a4b6c', modalidad: 'at_home',
        zona: 'Surco', conCredencial: true,
      },
      null,
    );
    assert.equal(
      q,
      'category_id=5b7e2f7a-8d1c-4a55-9d61-0c3f1e2a4b6c&modality=at_home&area=Surco&credential_verified=true&sort=recent&limit=20',
    );
  });

  it('con búsqueda: relevancia; el cursor va al final y escapado', () => {
    const q = D.consultaDelCatalogo({ ...D.SIN_FILTROS, q: '  contabilidad  ' }, 'a+b/c=');
    assert.equal(q, 'q=contabilidad&sort=relevance&limit=20&cursor=a%2Bb%2Fc%3D');
  });

  it('el importe va en unidades menores de SU moneda, y nunca sin moneda', () => {
    const conMoneda = D.consultaDelCatalogo({ ...D.SIN_FILTROS, precio: 'priced', moneda: 'PEN', minimo: '100', maximo: '250,50' }, null);
    assert.ok(conMoneda.includes('currency=PEN') && conMoneda.includes('min_price=10000') && conMoneda.includes('max_price=25050'));
    assert.ok(!conMoneda.includes('price=priced'), 'con moneda, el servidor ya sabe que es con importe');
    const sinMoneda = D.consultaDelCatalogo({ ...D.SIN_FILTROS, minimo: '100' }, null);
    assert.ok(!/min_price|currency/.test(sinMoneda));
    assert.deepEqual(D.revisarFiltros({ ...D.SIN_FILTROS, minimo: '100' }), { campo: 'moneda', clave: 'servicios.descubrir.error.moneda' });
  });

  it('gratis y a consultar no llevan ni moneda ni rango', () => {
    for (const precio of ['free', 'on_request'] as const) {
      const q = D.consultaDelCatalogo({ ...D.SIN_FILTROS, precio, moneda: 'PEN', minimo: '1' }, null);
      assert.ok(q.includes(`price=${precio}`) && !/currency|min_price/.test(q), q);
    }
  });

  it('ordenar por precio solo con moneda; relevancia solo con búsqueda', () => {
    assert.deepEqual(D.ordenesPosibles(D.SIN_FILTROS), ['recent']);
    assert.deepEqual(D.ordenesPosibles({ ...D.SIN_FILTROS, q: 'x', moneda: 'USD' }), ['relevance', 'recent', 'price_asc', 'price_desc']);
    assert.equal(D.ordenElegido({ ...D.SIN_FILTROS, orden: 'price_asc' }), 'recent');
    assert.equal(D.ordenElegido({ ...D.SIN_FILTROS, moneda: 'USD', orden: 'price_desc' }), 'price_desc');
  });

  it('lo que el servidor rechazaría, dicho antes', () => {
    assert.equal(D.revisarFiltros({ ...D.SIN_FILTROS, q: 'a' })?.clave, 'servicios.descubrir.error.consultaCorta');
    assert.equal(D.revisarFiltros({ ...D.SIN_FILTROS, q: '!!' })?.campo, 'q');
    assert.equal(D.revisarFiltros({ ...D.SIN_FILTROS, moneda: 'PEN', minimo: 'diez' })?.clave, 'servicios.descubrir.error.importe');
    assert.equal(D.revisarFiltros({ ...D.SIN_FILTROS, moneda: 'PEN', minimo: '300', maximo: '100' })?.clave, 'servicios.descubrir.error.rango');
    assert.equal(D.revisarFiltros({ ...D.SIN_FILTROS, q: 'ok' }), null);
    // Las mismas reglas que el servidor: alguna PALABRA de dos letras, y el
    // guion bajo separa (no es un comodín).
    for (const q of ['a b', 'y o', '____', 'a_b']) {
      assert.equal(D.revisarFiltros({ ...D.SIN_FILTROS, q })?.clave, 'servicios.descubrir.error.consultaCorta', q);
    }
    assert.equal(D.revisarFiltros({ ...D.SIN_FILTROS, zona: '__' })?.campo, 'zona');
  });

  it('un enlace contradictorio no deja un orden por precio sin moneda', () => {
    const f = D.filtrosDesdeRuta({ precio: 'free', moneda: 'PEN', minimo: '10', orden: 'price_asc' });
    assert.deepEqual([f.precio, f.moneda, f.minimo], ['free', null, '']);
    assert.ok(!D.ordenesPosibles({ ...D.SIN_FILTROS, precio: 'free', moneda: 'PEN' }).includes('price_asc'));
    assert.ok(D.consultaDelCatalogo(f, null).includes('sort=recent'));
  });
});

// =========================================================================== //
describe('las listas no se recortan ni se reordenan aquí', () => {
  it('juntar no repite', () => {
    const a = [tarjeta({ id: '1' }), tarjeta({ id: '2' })];
    assert.deepEqual(D.juntarSinRepetir(a, [tarjeta({ id: '2' }), tarjeta({ id: '3' })]).map((t) => t.id), ['1', '2', '3']);
  });

  it('marcar guardado cambia solo esa tarjeta', () => {
    const lista = D.conGuardado([tarjeta({ id: '1' }), tarjeta({ id: '2' })], '2', true);
    assert.deepEqual(lista.map((t) => t.saved), [false, true]);
  });

  it('las frecuentes son las de primer nivel, cuatro como mucho, en su orden', () => {
    const cats = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ ...tarjeta().category, id }));
    const hija = { ...tarjeta().category, id: 'h', parent_id: 'a' };
    assert.deepEqual(D.categoriasFrecuentes([hija, ...cats]).map((c) => c.id), ['a', 'b', 'c', 'd']);
  });
});

// =========================================================================== //
describe('nada inventado', () => {
  it('sin reseñas verificadas no hay nota ni «0.0»', () => {
    for (const resenas of [{ count: 0, average: null }, { count: 0, average: 0 }, { count: 3, average: null }, null]) {
      assert.deepEqual(D.resenasLegibles(resenas), { clave: 'servicios.descubrir.resenas.ninguna' });
    }
    assert.deepEqual(D.resenasLegibles({ count: 12, average: 4.25 }), {
      clave: 'servicios.descubrir.resenas.media', params: { media: '4.3', n: 12 },
    });
  });

  it('una señal de confianza solo se pinta si es verdad', () => {
    assert.deepEqual(D.senalesDeConfianza({ admitted_since: null, identity_verified: false, credential_verified: false }), []);
    assert.deepEqual(
      D.senalesDeConfianza({ admitted_since: '2026-09-29', identity_verified: true, credential_verified: true }).map((s) => s.clave),
      ['servicios.descubrir.confianza.admitido', 'servicios.descubrir.confianza.identidad', 'servicios.descubrir.confianza.credencial'],
    );
    assert.equal(D.senalesDeConfianza({ admitted_since: '2026-09-29', identity_verified: false, credential_verified: false })[0]?.params?.fecha, '09/2026');
  });

  it('un motivo desconocido no se enseña; uno conocido se explica', () => {
    assert.equal(D.motivoLegible(tarjeta({ reason: 'popular' })), null);
    assert.equal(D.motivoLegible(tarjeta({ reason: null })), null);
    assert.deepEqual(D.motivoLegible(tarjeta({ reason: 'matches_search', reason_fields: ['title', 'hack'] })), {
      clave: 'servicios.descubrir.motivo.matches_search', campos: ['servicios.descubrir.campo.title'],
    });
    assert.equal(D.claveDeLaSeccion('para_ti'), null);
  });
});

// =========================================================================== //
describe('cada clave existe en los tres idiomas', () => {
  it('las que arma la lógica', () => {
    for (const o of D.ORDENES) existe(D.claveDelOrden(o));
    for (const p of [null, ...D.TIPOS_DE_PRECIO]) existe(D.claveDelTipoDePrecio(p));
    for (const m of D.MOTIVOS) {
      existe(`servicios.descubrir.motivo.${m}`);
      existe(D.claveDeLaSeccion(m) as string);
    }
    for (const c of D.CAMPOS_DE_COINCIDENCIA) existe(`servicios.descubrir.campo.${c}`);
    for (const t of ['individual', 'company', 'otra']) existe(D.claveDelTipoDePrestador(t));
    for (const s of ['admitido', 'identidad', 'credencial', 'credencialCorta', 'alcance', 'titulo']) existe(`servicios.descubrir.confianza.${s}`);
    existe('servicios.descubrir.resenas.ninguna');
    existe('servicios.descubrir.resenas.media');
  });

  it('los huecos son los mismos en los tres', () => {
    for (const clave of Object.keys(es).filter((k) => k.startsWith('servicios.descubrir.'))) {
      const huecos = (t: string) => [...t.matchAll(/\{([a-z]+)\}/g)].map((x) => x[1]).sort();
      assert.deepEqual(huecos(en[clave as keyof typeof en] as string), huecos(es[clave as keyof typeof es] as string), clave);
      assert.deepEqual(huecos(pt[clave as keyof typeof pt] as string), huecos(es[clave as keyof typeof es] as string), clave);
    }
  });

  it('ningún texto promete lo prohibido por el blueprint', () => {
    const prohibido = /\b(el mejor|100 ?%|garantiz(?!an el resultado)|m[aá]s contratad|m[aá]s popular|seguro al 100)/i;
    for (const [clave, texto] of Object.entries(es).filter(([k]) => k.startsWith('servicios.descubrir.'))) {
      assert.ok(!prohibido.test(texto as string), `${clave}: «${texto}»`);
    }
  });
});
