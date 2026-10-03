/**
 * Z Servicios, Incremento 2: la lógica pura del catálogo en el teléfono,
 * contra el servidor.
 *
 * Lo que aquí no puede desalinearse sin que nadie se entere:
 *  - los VALORES CERRADOS (estados, modalidades, modelos de precio, requisitos,
 *    campos, acciones, colas, límites) son los del servidor, leídos de su
 *    código fuente;
 *  - CADA CÓDIGO de error que el catálogo puede devolver tiene su texto, y
 *    ninguno se enseña crudo;
 *  - cada CLAVE que esta lógica arma existe en los tres idiomas;
 *  - el FORMULARIO manda solo lo que cambió, nunca un estado, y nunca un
 *    importe con un modelo que no lo admite.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { es } from '../i18n/es.ts';
import { en } from '../i18n/en.ts';
import { pt } from '../i18n/pt.ts';
import type { Categoria, ServicioPrivado, Version } from './serviciosCatalogo.ts';

/*
  EL ALIAS `@/` NO LO RESUELVE NODE. `serviciosCatalogo.ts` importa VALORES de
  `@/lib/proveedorDeProductos` (el dinero, que no se duplica) y de
  `@/lib/serviciosAdmision`; se traduce el alias a la ruta relativa, igual que
  en `carrito.test.mts`. Es maquinaria de la prueba, no del producto.
*/
registerHooks({
  resolve(especificador, contexto, siguiente) {
    if (especificador.startsWith('@/')) {
      return { url: new URL(`../${especificador.slice(2)}.ts`, import.meta.url).href, shortCircuit: true };
    }
    return siguiente(especificador, contexto);
  },
});

const C = await import('./serviciosCatalogo.ts');
const { claveDeErrorDeServicios } = await import('./serviciosAdmision.ts');
const { claveDeErrorDeLaReserva } = await import('./serviciosReserva.ts');

const API = join(import.meta.dirname, '..', '..', '..', 'api', 'app', 'modules', 'services');
const servidor = (fichero: string) => readFileSync(join(API, fichero), 'utf8');
const DICCIONARIOS = { es, en, pt } as Record<string, Record<string, string | undefined>>;
const enLosTres = (clave: string) =>
  Object.entries(DICCIONARIOS).filter(([, d]) => !(clave in d)).map(([idioma]) => idioma);

/** Los valores entre comillas de una tupla de Python: `NOMBRE = ( "a", "b", )`. */
function tupla(fuente: string, nombre: string): string[] {
  const desde = fuente.indexOf(`${nombre} = (`);
  assert.ok(desde >= 0, `no encontré ${nombre}`);
  const bloque = fuente.slice(desde, fuente.indexOf(')', desde));
  return [...bloque.matchAll(/"([a-z_/]+)"/g)].map((m) => m[1] as string);
}

/** Una tupla escrita con CONSTANTES (`ESTADOS: tuple[...] = (BORRADOR, ...)`). */
function tuplaDeConstantes(fuente: string, nombre: string): string[] {
  const valores = new Map([...fuente.matchAll(/^([A-Z_]+) = "([a-z_]+)"$/gm)].map((m) => [m[1], m[2]]));
  const desde = fuente.indexOf(`${nombre}: tuple`);
  assert.ok(desde >= 0, `no encontré ${nombre}`);
  const bloque = fuente.slice(fuente.indexOf('(', fuente.indexOf('=', desde)), fuente.indexOf(')', fuente.indexOf('=', desde)));
  return [...bloque.matchAll(/([A-Z_]{4,}),/g)].map((m) => valores.get(m[1] as string) as string);
}

function version(parcial: Partial<Version> = {}): Version {
  return {
    id: 'v1',
    version: 1,
    status: 'draft',
    based_on_version: null,
    images: [],
    created_at: '2026-09-29T10:00:00Z',
    updated_at: '2026-09-29T10:00:00Z',
    submitted_at: null,
    decided_at: null,
    published_at: null,
    title: 'Asesoría contable',
    summary: 'Revisamos tus cuentas del mes.',
    description: 'Una sesión para ordenar ingresos, gastos e impuestos del mes.',
    modality: 'virtual',
    duration_minutes: 60,
    capacity: null,
    price: { model: 'fixed', amount_minor: 12000, currency: 'PEN' },
    scope: 'Personas naturales con negocio.',
    includes: ['Revisión de facturas'],
    excludes: ['Declaraciones anuales'],
    requirements: 'Traer tus facturas del mes.',
    conditions: null,
    location_area: null,
    ...parcial,
  };
}

function categoria(parcial: Partial<Categoria> = {}): Categoria {
  return {
    id: 'c1', slug: 'finanzas', name: 'Finanzas', name_en: 'Finance', name_pt: null, description: null,
    icon: null, parent_id: null, country_code: null, sort_order: 0, status: 'active', ...parcial,
  };
}

// =========================================================================== //
describe('los valores cerrados son los del servidor', () => {
  it('los estados del servicio y de la versión, en su orden', () => {
    const estados = servidor('catalogo_estados.py');
    assert.deepEqual(tuplaDeConstantes(estados, 'ESTADOS_DEL_SERVICIO'), [...C.ESTADOS_DEL_SERVICIO]);
    assert.deepEqual(tuplaDeConstantes(estados, 'ESTADOS_DE_LA_VERSION'), [...C.ESTADOS_DE_LA_VERSION]);
  });

  it('modalidades, modelos de precio, los que llevan importe, imágenes y el historial', () => {
    const modelos = servidor('catalogo_models.py');
    const valores = new Map([...modelos.matchAll(/^([A-Z_]+) = "([a-z_]+)"$/gm)].map((m) => [m[1], m[2]]));
    const deConstantes = (nombre: string) => {
      const linea = modelos.match(new RegExp(`^${nombre} = \\(([^)]*)\\)`, 'm'));
      assert.ok(linea, nombre);
      return [...(linea[1] as string).matchAll(/([A-Z_]+)/g)].map((m) => valores.get(m[1] as string));
    };
    assert.deepEqual(deConstantes('MODALIDADES'), [...C.MODALIDADES]);
    assert.deepEqual(deConstantes('MODELOS_DE_PRECIO'), [...C.MODELOS_DE_PRECIO]);
    assert.deepEqual(deConstantes('CON_IMPORTE'), [...C.CON_IMPORTE]);
    assert.deepEqual(tupla(modelos, 'TIPOS_DE_IMAGEN'), [...C.TIPOS_DE_IMAGEN]);
    assert.match(modelos, /PESO_MAXIMO_DE_LA_IMAGEN = 5 \* 1024 \* 1024/);
    assert.equal(C.PESO_MAXIMO_DE_IMAGEN, 5 * 1024 * 1024);
    assert.deepEqual(tupla(modelos, 'ACCIONES'), [...C.SUCESOS]);
  });

  it('lo que se OFRECE en la primera versión es lo que el servidor trae de fábrica (P5 y P2)', () => {
    const ajustes = readFileSync(join(API, '..', '..', 'core', 'config.py'), 'utf8');
    const deFabrica = (nombre: string) => {
      const linea = ajustes.match(new RegExp(`^    ${nombre}: str = "([^"]*)"$`, 'm'));
      assert.ok(linea, nombre);
      return (linea[1] as string).split(',');
    };
    assert.deepEqual(deFabrica('services_catalog_modalities'), [...C.MODALIDADES_OFRECIDAS]);
    assert.deepEqual(deFabrica('services_catalog_currencies'), [...C.MONEDAS]);
    // «A domicilio» sigue en el modelo —lo que ya la tuviera se sigue
    // nombrando—, pero ningún formulario ni filtro la ofrece. Y solo soles.
    assert.ok((C.MODALIDADES as readonly string[]).includes('at_home'));
    assert.ok(!(C.MODALIDADES_OFRECIDAS as readonly string[]).includes('at_home'));
    assert.deepEqual([...C.MONEDAS], ['PEN']);
    assert.deepEqual(C.FILTROS_DE_MODALIDAD, [null, 'virtual', 'in_person']);
    for (const m of C.MODALIDADES) assert.deepEqual(enLosTres(C.claveDeLaModalidad(m)), [], m);
  });

  it('EL PILOTO ES GRATUITO: solo se ofrecen «gratis» y «a consultar», lo que el servidor admite de fábrica', () => {
    const ajustes = readFileSync(join(API, '..', '..', 'core', 'config.py'), 'utf8');
    const linea = ajustes.match(/^    services_catalog_price_models: str = "([^"]*)"$/m);
    assert.ok(linea, 'services_catalog_price_models');
    // La app y el servidor, la misma lista: si uno cambia y el otro no, rojo.
    assert.deepEqual((linea[1] as string).split(','), [...C.MODELOS_DE_PRECIO_OFRECIDOS]);
    assert.deepEqual([...C.MODELOS_DE_PRECIO_OFRECIDOS], ['free', 'on_request']);
    // Lo PROHIBIDO no se ofrece: ni «precio fijo» ni «desde» (`from`, que el
    // blueprint llama `starting_at`), ni nada que lleve importe.
    for (const prohibido of ['fixed', 'from', 'starting_at']) {
      assert.ok(!(C.MODELOS_DE_PRECIO_OFRECIDOS as readonly string[]).includes(prohibido), prohibido);
      assert.equal(C.seOfrece(prohibido), false, prohibido);
    }
    assert.deepEqual(C.MODELOS_DE_PRECIO_OFRECIDOS.filter((m) => C.llevaImporte(m)), []);
    assert.ok(C.seOfrece('free') && C.seOfrece('on_request') && !C.seOfrece(null) && !C.seOfrece(''));
    // Pero SIGUEN EN EL MODELO: una ficha antigua con importe se lee, se
    // nombra y se pinta (compatibilidad al visualizar).
    for (const antiguo of ['fixed', 'from'] as const) {
      assert.ok((C.MODELOS_DE_PRECIO as readonly string[]).includes(antiguo));
      assert.deepEqual(enLosTres(C.claveDelModeloDePrecio(antiguo)), [], antiguo);
      assert.ok(C.llevaImporte(antiguo));
    }
    assert.equal(
      C.precioLegible({ model: 'fixed', amount_minor: 12000, currency: 'PEN' } as never).clave,
      'servicios.catalogo.precio.fixed',
    );
    assert.equal(
      C.precioLegible({ model: 'from', amount_minor: 8000, currency: 'PEN' } as never).clave,
      'servicios.catalogo.precio.from',
    );
    // El error del servidor, si alguien lo provoca a mano, tiene su texto.
    assert.equal(
      C.claveDeErrorDelCatalogo('service_price_model_not_allowed'),
      'servicios.catalogo.falta.price_model_not_allowed',
    );
  });

  it('los requisitos y los campos que Z puede señalar', () => {
    const requisitos = servidor('catalogo_requisitos.py');
    assert.deepEqual(tupla(requisitos, 'CODIGOS'), [...C.REQUISITOS]);
    assert.deepEqual(tupla(requisitos, 'CAMPOS'), [...C.CAMPOS_SENALABLES]);
  });

  it('las decisiones del equipo y las colas de la bandeja', () => {
    const esquemas = servidor('catalogo_schemas.py');
    const literal = esquemas.slice(esquemas.indexOf('AccionDeAdministracion = Literal['));
    const acciones = [...literal.slice(0, literal.indexOf(']')).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    assert.deepEqual(acciones, [...C.ACCIONES_DEL_CATALOGO]);
    const colas = servidor('catalogo_router.py').match(/queue: str = Query\(default="pending", pattern="\^\(([^)]*)\)\$"\)/);
    assert.ok(colas);
    assert.deepEqual((colas[1] as string).split('|'), [...C.COLAS]);
  });

  it('los largos del formulario son los del contrato', () => {
    const esquemas = servidor('catalogo_schemas.py');
    const bloque = esquemas.slice(esquemas.indexOf('class BorradorEditar'), esquemas.indexOf('class ImagenesOrdenar'));
    const largo = (campo: string) => {
      const m = bloque.match(new RegExp(`${campo}: str \\| None = Field\\(default=None, (?:min_length=(\\d+), )?max_length=(\\d+)\\)`));
      assert.ok(m, campo);
      return [Number(m[1] ?? 0), Number(m[2])];
    };
    assert.deepEqual(largo('title'), [...C.LARGOS.titulo]);
    assert.deepEqual(largo('summary'), [...C.LARGOS.resumen]);
    assert.deepEqual(largo('description'), [...C.LARGOS.descripcion]);
    assert.deepEqual(largo('scope'), [...C.LARGOS.alcance]);
    assert.deepEqual(largo('requirements'), [...C.LARGOS.requisitos]);
    assert.deepEqual(largo('conditions'), [...C.LARGOS.condiciones]);
    assert.deepEqual(largo('location_area'), [...C.LARGOS.zona]);
    assert.match(bloque, /duration_minutes: int \| None = Field\(default=None, ge=5, le=1440\)/);
    assert.match(bloque, /capacity: int \| None = Field\(default=None, ge=1, le=1000\)/);
    assert.deepEqual([...C.DURACION], [5, 1440]);
    assert.deepEqual([...C.CAPACIDAD], [1, 1000]);
    assert.match(esquemas, /if not 2 <= len\(frase\) <= 200:/);
    assert.match(esquemas, /if len\(limpias\) > 20:/);
    assert.deepEqual([...C.LARGOS.frase], [2, 200]);
    assert.equal(C.MAXIMO_DE_FRASES, 20);
  });
});

// =========================================================================== //
describe('ningún código del catálogo llega crudo a la pantalla', () => {
  it('cada código de error del catálogo tiene su texto', () => {
    const codigos = new Set<string>();
    for (const fichero of [
      'catalogo.py', 'catalogo_estados.py', 'catalogo_imagenes.py', 'catalogo_requisitos.py',
      'catalogo_router.py', 'catalogo_vistas.py', 'categorias.py', 'esquema.py',
    ]) {
      for (const m of servidor(fichero).matchAll(/\bcode ?= ?"([a-z_]+)"/g)) codigos.add(m[1] as string);
    }
    assert.ok(codigos.size >= 24, `solo ${codigos.size} códigos leídos`);
    // `esquema.py` guarda también la puerta de la reserva (Incremento 5).
    const sinTexto = [...codigos].filter(
      (c) =>
        C.claveDeErrorDelCatalogo(c) === null &&
        claveDeErrorDeServicios(c) === null &&
        claveDeErrorDeLaReserva(c) === null,
    );
    assert.deepEqual(sinTexto, [], `sin texto en el teléfono: ${sinTexto.join(', ')}`);
    // Y ninguno del mapa del teléfono es inventado.
    const inventados = C.CODIGOS_DE_ERROR_DEL_CATALOGO.filter((c) => !codigos.has(c));
    assert.deepEqual(inventados, []);
  });

  it('cada texto de error existe en los tres idiomas', () => {
    for (const codigo of C.CODIGOS_DE_ERROR_DEL_CATALOGO) {
      const clave = C.claveDeErrorDelCatalogo(codigo) as string;
      assert.deepEqual(enLosTres(clave), [], `${codigo} → ${clave}`);
    }
    assert.equal(C.claveDeErrorDelCatalogo('algo_que_no_existe'), null);
    assert.equal(C.claveDeErrorDelCatalogo(null), null);
  });

  it('cada clave que se arma existe en los tres idiomas, y lo desconocido tiene la suya', () => {
    const claves = [
      ...C.ESTADOS_DEL_SERVICIO.flatMap((e) => [C.claveDelEstadoDelServicio(e), C.claveDelCuerpoDelEstado(e)]),
      ...C.ESTADOS_DE_LA_VERSION.map((e) => C.claveDelEstadoDeLaVersion(e)),
      ...C.MODALIDADES.map((m) => C.claveDeLaModalidad(m)),
      ...C.MODELOS_DE_PRECIO.map((m) => C.claveDelModeloDePrecio(m)),
      ...C.REQUISITOS.map((r) => C.claveDelRequisito(r)),
      ...C.CAMPOS_SENALABLES.map((c) => C.claveDelCampo(c)),
      ...C.ACCIONES_DEL_CATALOGO.flatMap((a) => [
        C.claveDeLaAccion(a),
        `servicios.catalogo.admin.confirmar.${a}`,
        `servicios.catalogo.admin.explica.${a}`,
      ]),
      ...C.SUCESOS.map((s) => C.claveDelSuceso(s)),
      ...C.COLAS.map((c) => C.claveDeLaCola(c)),
      ...['provider', 'reviewer', 'admin', 'system', 'otra'].map((f) => C.claveDeLaFuncion(f)),
      ...['submitted', 'under_review', 'approved', 'draft'].map((e) => `servicios.catalogo.versionCuerpo.${e}`),
      'servicios.catalogo.admin.confirmar.publishSuspendido',
      'servicios.catalogo.admin.explica.publishSuspendido',
      C.claveDelEstadoDelServicio('nuevo'), C.claveDelCuerpoDelEstado('nuevo'), C.claveDelEstadoDeLaVersion('nuevo'),
      C.claveDeLaModalidad('nuevo'), C.claveDeLaModalidad(null), C.claveDelModeloDePrecio('nuevo'),
      C.claveDelModeloDePrecio(null), C.claveDelRequisito('nuevo'), C.claveDelCampo('nuevo'),
      C.claveDeLaAccion('nuevo'), C.claveDelSuceso('nuevo'),
    ];
    for (const m of ['free', 'fixed', 'from', 'on_request', null]) {
      claves.push(C.precioLegible({ model: m, amount_minor: 100, currency: 'PEN' }).clave);
    }
    claves.push(C.precioLegible({ model: 'fixed', amount_minor: null, currency: null }).clave);
    for (const n of [null, 30, 60, 90]) claves.push(C.duracionLegible(n).clave);
    const faltan = claves.filter((c) => enLosTres(c).length > 0);
    assert.deepEqual(faltan, []);
    assert.equal(C.claveDelEstadoDelServicio('nuevo'), 'servicios.catalogo.estado.desconocido');
    assert.equal(C.claveDelRequisito('algo_nuevo'), 'servicios.catalogo.falta.otro');
  });

  it('las claves del catálogo tienen los mismos huecos en los tres idiomas', () => {
    const huecos = (t: string) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    const claves = Object.keys(es).filter((c) => c.startsWith('servicios.catalogo.') || c.startsWith('notif.servicioCatalogo'));
    assert.ok(claves.length >= 300, `solo ${claves.length}`);
    for (const clave of claves) {
      const base = (es as Record<string, string>)[clave] as string;
      for (const idioma of ['en', 'pt']) {
        const texto = DICCIONARIOS[idioma]?.[clave];
        assert.ok(texto, `${idioma}: falta ${clave}`);
        assert.equal(huecos(texto), huecos(base), `${idioma}: huecos distintos en ${clave}`);
      }
    }
  });
});

// =========================================================================== //
describe('el precio y la duración, en palabras', () => {
  it('sin configurar NO es gratis', () => {
    assert.equal(C.precioLegible({ model: null, amount_minor: null, currency: null }).clave, 'servicios.catalogo.precio.sinDefinir');
    assert.equal(C.precioLegible({ model: 'free', amount_minor: null, currency: null }).clave, 'servicios.catalogo.precio.free');
    assert.equal(C.precioLegible(null).clave, 'servicios.catalogo.precio.sinDefinir');
  });

  it('el importe va con el código de su moneda y los decimales de la moneda', () => {
    assert.deepEqual(C.precioLegible({ model: 'fixed', amount_minor: 12000, currency: 'PEN' }), {
      clave: 'servicios.catalogo.precio.fixed',
      params: { importe: '120.00 PEN' },
    });
    assert.deepEqual(C.precioLegible({ model: 'from', amount_minor: 4990, currency: 'usd' }).params, { importe: '49.90 USD' });
    assert.deepEqual(C.precioLegible({ model: 'fixed', amount_minor: 1500, currency: 'JPY' }).params, { importe: '1500 JPY' });
  });

  it('un importe sin moneda (o una moneda sin importe) no se inventa', () => {
    assert.equal(C.precioLegible({ model: 'fixed', amount_minor: 100, currency: null }).clave, 'servicios.catalogo.precio.sinImporte');
    assert.equal(C.precioLegible({ model: 'from', amount_minor: null, currency: 'PEN' }).clave, 'servicios.catalogo.precio.sinImporte');
  });

  it('la duración', () => {
    assert.deepEqual(C.duracionLegible(45), { clave: 'servicios.catalogo.duracion.minutos', params: { n: 45 } });
    assert.deepEqual(C.duracionLegible(120), { clave: 'servicios.catalogo.duracion.horas', params: { h: 2 } });
    assert.deepEqual(C.duracionLegible(90), { clave: 'servicios.catalogo.duracion.horasYMinutos', params: { h: 1, m: 30 } });
    assert.equal(C.duracionLegible(null).clave, 'servicios.catalogo.duracion.sinDefinir');
    assert.equal(C.duracionLegible(0).clave, 'servicios.catalogo.duracion.sinDefinir');
  });
});

// =========================================================================== //
describe('el formulario del borrador', () => {
  const v = version();
  const cambios = (f: ReturnType<typeof C.formularioDesde>, cambiable = true, base = v) =>
    C.cambiosDelBorrador(f, base, 'c1', { categoriaCambiable: cambiable });

  it('recién cargado no cambia nada', () => {
    assert.deepEqual(cambios(C.formularioDesde(v, 'c1')), { cambios: {}, fallos: [] });
    const vacia = version({
      title: null, summary: null, description: null, modality: null, duration_minutes: null, scope: null,
      includes: [], excludes: [], requirements: null, price: { model: null, amount_minor: null, currency: null },
    });
    assert.deepEqual(cambios(C.formularioDesde(vacia, 'c1'), true, vacia), { cambios: {}, fallos: [] });
  });

  it('solo viaja lo que cambió, y NUNCA un estado', () => {
    const f = { ...C.formularioDesde(v, 'c1'), titulo: '  Asesoría contable mensual  ' };
    const { cambios: c } = cambios(f);
    assert.deepEqual(c, { title: 'Asesoría contable mensual' });
    assert.ok(!('status' in c));
  });

  it('vaciar un campo manda null (guardar a medias no exige nada)', () => {
    const f = { ...C.formularioDesde(v, 'c1'), requisitos: '   ', duracion: '' };
    assert.deepEqual(cambios(f).cambios, { requirements: null, duration_minutes: null });
  });

  it('un modelo sin importe no manda importe ni moneda', () => {
    const f = { ...C.formularioDesde(v, 'c1'), modeloDePrecio: 'free' as const };
    assert.deepEqual(cambios(f).cambios, { price_model: 'free' });
    const g = { ...C.formularioDesde(v, 'c1'), modeloDePrecio: 'on_request' as const, importe: '99' };
    assert.deepEqual(cambios(g).cambios, { price_model: 'on_request' });
  });

  it('el importe se escribe como lo escribe una persona y viaja en unidades menores', () => {
    const f = { ...C.formularioDesde(v, 'c1'), importe: '149,90' };
    assert.deepEqual(cambios(f).cambios, { price_minor: 14990 });
    const g = { ...C.formularioDesde(v, 'c1'), moneda: 'USD' };
    assert.deepEqual(cambios(g).cambios, { currency: 'USD' });
    const gratis = version({ price: { model: 'free', amount_minor: null, currency: null } });
    const h = { ...C.formularioDesde(gratis, 'c1'), modeloDePrecio: 'from' as const, importe: '80' };
    assert.deepEqual(cambios(h, true, gratis).cambios, { price_model: 'from', price_minor: 8000, currency: 'PEN' });
  });

  it('un importe raro, cero o sin moneda se dice antes de mandarlo', () => {
    for (const importe of ['12.345', 'abc', '0', '-5']) {
      const f = { ...C.formularioDesde(v, 'c1'), importe };
      assert.ok(cambios(f).fallos.some((x) => x.campo === 'importe'), importe);
    }
    const f = { ...C.formularioDesde(v, 'c1'), moneda: 'soles' };
    assert.ok(cambios(f).fallos.some((x) => x.campo === 'moneda'));
  });

  it('los largos, la duración y la capacidad se revisan con las reglas del servidor', () => {
    const f = {
      ...C.formularioDesde(v, 'c1'),
      titulo: 'AB', resumen: 'corto', duracion: '4', capacidad: '1001', zona: 'x'.repeat(121),
    };
    const campos = cambios(f).fallos.map((x) => x.campo).sort();
    assert.deepEqual(campos, ['capacidad', 'duracion', 'resumen', 'titulo', 'zona']);
  });

  it('incluye y no incluye: una frase por línea, sin vacías, con su largo y su tope', () => {
    const f = { ...C.formularioDesde(v, 'c1'), incluye: 'Revisión de facturas\n\n  Llamada de seguimiento  \n' };
    assert.deepEqual(cambios(f).cambios, { includes: ['Revisión de facturas', 'Llamada de seguimiento'] });
    const g = { ...C.formularioDesde(v, 'c1'), excluye: 'x' };
    assert.ok(cambios(g).fallos.some((x) => x.campo === 'excluye'));
    const h = { ...C.formularioDesde(v, 'c1'), incluye: Array.from({ length: 21 }, (_, i) => `Frase ${i}`).join('\n') };
    assert.ok(cambios(h).fallos.some((x) => x.clave === 'servicios.catalogo.validacion.demasiadasFrases'));
  });

  it('la categoría solo viaja si todavía se puede cambiar', () => {
    const f = { ...C.formularioDesde(v, 'c1'), categoria: 'c2' };
    assert.deepEqual(cambios(f, true).cambios, { category_id: 'c2' });
    assert.deepEqual(cambios(f, false).cambios, {});
  });

  it('hay cambios sin guardar solo si de verdad los hay', () => {
    const f = C.formularioDesde(v, 'c1');
    assert.equal(C.hayCambiosSinGuardar(f, v, 'c1', true), false);
    assert.equal(C.hayCambiosSinGuardar({ ...f, alcance: 'Otro alcance distinto.' }, v, 'c1', true), true);
    assert.equal(C.hayCambiosSinGuardar(null, v, 'c1', true), false);
  });

  it('el importe se enseña con los decimales de su moneda', () => {
    assert.equal(C.formularioDesde(v, 'c1').importe, '120.00');
    assert.equal(C.formularioDesde(version({ price: { model: null, amount_minor: null, currency: null } }), 'c1').moneda, 'PEN');
    assert.equal(C.llevaImporte('fixed'), true);
    assert.equal(C.llevaImporte('free'), false);
    assert.equal(C.llevaImporte(null), false);
  });
});

// =========================================================================== //
describe('las imágenes', () => {
  const imagenes = [
    { id: 'b', url: null, alt_text: 'B', position: 1, is_cover: false, width: 1, height: 1 },
    { id: 'a', url: null, alt_text: 'A', position: 0, is_cover: true, width: 1, height: 1 },
    { id: 'c', url: null, alt_text: 'C', position: 2, is_cover: false, width: 1, height: 1 },
  ];

  it('se mueven dentro de la lista COMPLETA, y fuera de rango no cambian', () => {
    assert.deepEqual(C.moverImagen(imagenes, 'b', -1), ['b', 'a', 'c']);
    assert.deepEqual(C.moverImagen(imagenes, 'b', 1), ['a', 'c', 'b']);
    assert.deepEqual(C.moverImagen(imagenes, 'a', -1), ['a', 'b', 'c']);
    assert.deepEqual(C.moverImagen(imagenes, 'c', 1), ['a', 'b', 'c']);
    assert.deepEqual(C.moverImagen(imagenes, 'zz', 1), ['a', 'b', 'c']);
  });

  it('la portada es la marcada; si ninguna, la primera', () => {
    assert.equal(C.portada(imagenes)?.id, 'a');
    assert.equal(C.portada(imagenes.map((i) => ({ ...i, is_cover: false })))?.id, 'b');
    assert.equal(C.portada([]), null);
  });

  it('el texto alternativo es obligatorio antes de elegir, con su largo', () => {
    assert.equal(C.revisarAlternativo('  '), 'servicios.catalogo.imagenes.alternativoObligatorio');
    assert.equal(C.revisarAlternativo('ab'), 'servicios.validacion.corto');
    assert.equal(C.revisarAlternativo('x'.repeat(301)), 'servicios.validacion.largo');
    assert.equal(C.revisarAlternativo('Sesión en consultorio'), null);
  });

  it('lo barato se mira antes de subir: tipo, peso y vacío; lo demás, el servidor', () => {
    assert.equal(C.porQueNoSeSube({ tipo: 'image/gif', bytes: 10 }), 'servicios.catalogo.imagenes.formato');
    assert.equal(C.porQueNoSeSube({ tipo: 'image/png', bytes: 5 * 1024 * 1024 + 1 }), 'servicios.catalogo.imagenes.pesada');
    assert.equal(C.porQueNoSeSube({ tipo: 'image/png', bytes: 0 }), 'servicios.catalogo.imagenes.vacia');
    assert.equal(C.porQueNoSeSube({ tipo: null, bytes: null }), null);
    assert.equal(C.porQueNoSeSube({ tipo: 'image/webp', bytes: 1000 }), null);
  });
});

// =========================================================================== //
describe('el servicio propio', () => {
  const servicio = (parcial: Partial<ServicioPrivado> = {}): ServicioPrivado => ({
    id: 's1', status: 'published', title: 'Asesoría contable', last_version_status: 'published',
    category: categoria(), created_at: '', updated_at: '',
    first_published_at: '2026-09-01T00:00:00Z', published_at: null, suspended_at: null, retired_at: null,
    published_version: version({ id: 'v1', status: 'published' }), open_version: null, last_observation: null,
    missing: [], can_edit: false, can_submit: false, can_withdraw: false, can_open_draft: true,
    publicly_visible: true, ...parcial,
  });

  it('se enseña la versión abierta y, sin ella, la publicada', () => {
    assert.equal(C.versionQueSeEnsena(servicio())?.id, 'v1');
    assert.equal(C.versionQueSeEnsena(servicio({ open_version: version({ id: 'v2' }) }))?.id, 'v2');
  });

  it('la lista enseña la versión abierta y, sin ella, los cambios pedidos', () => {
    assert.equal(C.estadoDeVersionQueSeEnsena({ open_version_status: 'submitted', last_version_status: 'submitted' }), 'submitted');
    assert.equal(C.estadoDeVersionQueSeEnsena({ open_version_status: null, last_version_status: 'changes_requested' }), 'changes_requested');
    assert.equal(C.estadoDeVersionQueSeEnsena({ open_version_status: null, last_version_status: 'published' }), null);
    assert.equal(C.estadoDeVersionQueSeEnsena({ open_version_status: null, last_version_status: null }), null);
  });

  it('está en manos de Z mientras la versión abierta espera', () => {
    for (const estado of ['submitted', 'under_review', 'approved']) {
      assert.equal(C.estaEnManosDeZ(servicio({ open_version: version({ status: estado }) })), true, estado);
    }
    assert.equal(C.estaEnManosDeZ(servicio({ open_version: version({ status: 'draft' }) })), false);
    assert.equal(C.estaEnManosDeZ(servicio()), false);
  });

  it('es un reenvío si el borrador sale de la versión a la que Z pidió cambios', () => {
    const pedido = { action: 'changes_requested', note: 'Falta el alcance.', fields: ['scope'], version: 2, created_at: '' };
    const borrador = version({ id: 'v3', version: 3, based_on_version: 2 });
    assert.equal(C.esReenvio(servicio({ open_version: borrador, last_observation: pedido })), true);
    assert.equal(C.esReenvio(servicio({ open_version: { ...borrador, based_on_version: 1 }, last_observation: pedido })), false);
    assert.equal(C.esReenvio(servicio({ open_version: borrador, last_observation: { ...pedido, action: 'suspended' } })), false);
    assert.equal(C.esReenvio(servicio({ open_version: { ...borrador, status: 'submitted' }, last_observation: pedido })), false);
  });

  it('«aún no eres prestador activo» no es «sin permiso»', () => {
    assert.equal(C.falloDelCatalogo(403, 'service_provider_not_active'), 'prestadorInactivo');
    assert.equal(C.falloDelCatalogo(403, 'service_review_forbidden'), 'sinPermiso');
    assert.equal(C.falloDelCatalogo(503, 'services_not_ready'), 'apagado');
    assert.equal(C.falloDelCatalogo(404, 'service_not_found'), 'noEncontrada');
    assert.equal(C.falloDelCatalogo(0, 'network_error'), 'sinConexion');
  });

  it('tras un envío incompleto, o un cambio ajeno, se vuelve a leer', () => {
    assert.equal(C.hayQueRecargarElCatalogo(422, 'service_catalog_incomplete'), true);
    assert.equal(C.hayQueRecargarElCatalogo(409, 'service_catalog_transition_invalid'), true);
    assert.equal(C.hayQueRecargarElCatalogo(404, 'service_not_found'), true);
    assert.equal(C.hayQueRecargarElCatalogo(422, 'validation_error'), false);
  });
});

// =========================================================================== //
describe('la bandeja y las decisiones', () => {
  it('la consulta de la bandeja', () => {
    assert.equal(C.consultaDelCatalogo({ cola: 'pending' }), 'queue=pending&limit=20');
    assert.equal(
      C.consultaDelCatalogo({ cola: 'pending', estadoDeVersion: 'approved', modalidad: 'at_home', categoria: 'c 1', cursor: 'x|y' }),
      'queue=pending&limit=20&version_status=approved&modality=at_home&category_id=c%201&cursor=x%7Cy',
    );
  });

  it('juntar páginas no repite filas', () => {
    assert.deepEqual(C.juntar([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }]).map((x) => x.id), ['a', 'b', 'c']);
  });

  it('el motivo es obligatorio donde el prestador lo lee', () => {
    for (const a of ['request_changes', 'suspend', 'reinstate', 'retire']) {
      assert.equal(C.revisarMotivo(a, ' '), 'servicios.catalogo.validacion.motivoObligatorio', a);
    }
    for (const a of ['start_review', 'approve', 'publish']) assert.equal(C.revisarMotivo(a, ''), null, a);
    assert.equal(C.revisarMotivo('suspend', 'ab'), 'servicios.validacion.corto');
    assert.equal(C.revisarMotivo('suspend', 'x'.repeat(2001)), 'servicios.validacion.largo');
  });

  it('el cuerpo de cada decisión lleva solo lo que esa decisión admite', () => {
    const datos = { motivo: '  Falta el alcance.  ', notaInterna: '  ', campos: ['scope', 'scope', 'inventado'] };
    assert.deepEqual(C.cuerpoDeLaDecision('start_review', datos), {});
    assert.deepEqual(C.cuerpoDeLaDecision('approve', { ...datos, notaInterna: ' Todo bien ' }), { internal_note: 'Todo bien' });
    assert.deepEqual(C.cuerpoDeLaDecision('request_changes', datos), { note: 'Falta el alcance.', fields: ['scope'] });
    assert.deepEqual(C.cuerpoDeLaDecision('retire', datos), { note: 'Falta el alcance.' });
    for (const a of C.ACCIONES_DEL_CATALOGO) assert.ok(!('status' in C.cuerpoDeLaDecision(a, datos)), a);
  });

  it('qué va sobre la versión y qué es destructivo', () => {
    assert.deepEqual(C.ACCIONES_DEL_CATALOGO.filter((a) => C.esDeLaVersion(a)), ['start_review', 'request_changes', 'approve', 'publish']);
    assert.deepEqual(C.ACCIONES_DEL_CATALOGO.filter((a) => C.esDestructiva(a)), ['suspend', 'retire']);
  });
});

// =========================================================================== //
describe('las categorías', () => {
  const madre = categoria({ id: 'm', name: 'Salud', name_en: null, name_pt: 'Saúde' });
  const hija = categoria({ id: 'h', name: 'Fisioterapia', parent_id: 'm', name_en: 'Physiotherapy' });
  const suelta = categoria({ id: 's', name: 'Suelta', parent_id: 'no-esta' });
  const otra = categoria({ id: 'o', name: 'Hogar' });

  it('el nombre en el idioma de quien mira, y si no lo hay, el base', () => {
    assert.equal(C.nombreDeLaCategoria(hija, 'en'), 'Physiotherapy');
    assert.equal(C.nombreDeLaCategoria(madre, 'en'), 'Salud');
    assert.equal(C.nombreDeLaCategoria(madre, 'pt'), 'Saúde');
    assert.equal(C.nombreDeLaCategoria(null, 'es'), '');
    assert.equal(C.etiquetaDeCategoria(hija, [madre, hija], 'es'), 'Salud › Fisioterapia');
  });

  it('en árbol: cada madre con sus hijas; una hija huérfana al final', () => {
    assert.deepEqual(C.categoriasEnArbol([hija, suelta, madre, otra]).map((c) => c.id), ['m', 'h', 'o', 's']);
  });

  it('solo una de primer nivel, y nunca ella misma, puede ser madre', () => {
    assert.deepEqual(C.madresPosibles([madre, hija, otra], 'o').map((c) => c.id), ['m']);
  });

  it('el alta lleva el slug y solo lo escrito; el slug se revisa', () => {
    const f = { ...C.categoriaVacia(), slug: 'fisioterapia', nombre: ' Fisioterapia ', pais: 'pe', madre: 'm' };
    assert.deepEqual(C.peticionDeCategoria(f, null), {
      peticion: { slug: 'fisioterapia', name: 'Fisioterapia', country_code: 'PE', sort_order: 0, parent_id: 'm' },
      fallos: [],
    });
    const malo = C.peticionDeCategoria({ ...f, slug: 'Con Espacios' }, null);
    assert.equal(malo.peticion, null);
    assert.ok(malo.fallos.some((x) => x.campo === 'slug'));
  });

  it('la edición manda solo lo que cambió, nunca el slug ni el estado; vaciar manda null', () => {
    const f = { ...C.categoriaDesde(hija), nombreEn: '', orden: '5' };
    const { peticion } = C.peticionDeCategoria(f, hija);
    assert.deepEqual(peticion, { name_en: null, sort_order: 5 });
    assert.ok(peticion && !('slug' in peticion) && !('status' in peticion));
    const igual = C.peticionDeCategoria(C.categoriaDesde(hija), hija);
    assert.equal(igual.peticion, null);
    assert.equal(igual.fallos[0]?.clave, 'servicios.validacion.sinCambios');
  });

  it('icono, país y orden se revisan antes de mandar', () => {
    const f = { ...C.categoriaVacia(), slug: 'ok-slug', nombre: 'Nombre', icono: 'Con Mayúsculas', pais: 'PER', orden: '100001' };
    const campos = C.peticionDeCategoria(f, null).fallos.map((x) => x.campo).sort();
    assert.deepEqual(campos, ['icono', 'orden', 'pais']);
  });
});
