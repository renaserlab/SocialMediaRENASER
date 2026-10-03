/**
 * Z Servicios, Incremento 2: las vistas del catálogo, sus puertas y sus
 * contratos.
 *
 * Se lee el CÓDIGO FUENTE, como en `serviciosVistas.test.mts`: un componente
 * de React Native no se ejecuta con `node --test`. Lo que se vigila:
 *
 *  1. LAS 13 VISTAS TIENEN RUTA y cada una se alcanza desde otra vista de la
 *     app —ninguna solo escribiendo la URL—, detrás de la bandera.
 *  2. CADA VISTA tiene carga, error con reintento, ningún texto en duro, y las
 *     que escriben, cerrojo contra el doble toque y confirmación en lo que no
 *     tiene vuelta atrás.
 *  3. LOS REPOSITORIOS llaman a las 30 rutas del catálogo que existen en el
 *     servidor —ni una más, ni una menos—, con `Idempotency-Key` en cada alta y
 *     cada salto, y ninguno manda un estado.
 *  4. NINGUNA ESCRITURA DIRECTA a la base ni al almacenamiento.
 *  5. LOS 11 AVISOS del catálogo tienen título, texto y destino.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { es } from '../i18n/es.ts';
import { en } from '../i18n/en.ts';
import { pt } from '../i18n/pt.ts';
import { avisoAlCreador, rutaDelAviso } from '../lib/avisosAlCreador.ts';
import { rutaDelPush } from '../lib/rutaDelPush.ts';

const SRC = join(import.meta.dirname, '..');
const APP = join(SRC, '..', 'app');
const API = join(SRC, '..', '..', 'api', 'app', 'modules');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const sinComentarios = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');

/** Ruta de expo-router → pantalla que monta. */
const VISTAS: Record<string, string> = {
  '/servicios/prestador/catalogo': 'MisServiciosScreen',
  '/servicios/prestador/catalogo/nuevo': 'NuevoServicioScreen',
  '/servicios/prestador/catalogo/[serviceId]': 'ServicioDelPrestadorScreen',
  '/servicios/prestador/catalogo/[serviceId]/editar': 'EditarServicioScreen',
  '/servicios/prestador/catalogo/[serviceId]/imagenes': 'ImagenesDelServicioScreen',
  '/servicios/prestador/catalogo/[serviceId]/enviar': 'EnviarServicioScreen',
  '/servicios/prestador/catalogo/[serviceId]/historial': 'HistorialDelServicioScreen',
  '/servicios/ficha/[serviceId]': 'FichaDeServicioScreen',
  '/admin/servicios/catalogo': 'AdminCatalogoScreen',
  '/admin/servicios/catalogo/[serviceId]': 'AdminServicioDelCatalogoScreen',
  '/admin/servicios/catalogo/[serviceId]/historial': 'AdminHistorialDelCatalogoScreen',
  '/admin/servicios/catalogo/[serviceId]/version/[versionId]': 'AdminVersionDelServicioScreen',
  '/admin/servicios/categorias': 'AdminCategoriasDeServiciosScreen',
};
const PANTALLAS = Object.values(VISTAS);
const pantalla = (nombre: string) => sinComentarios(fuente(`screens/${nombre}.tsx`));

function ficheroDeLaRuta(ruta: string): string | null {
  const base = join(APP, ...ruta.split('/').filter(Boolean));
  if (existsSync(`${base}.tsx`)) return `${base}.tsx`;
  if (existsSync(join(base, 'index.tsx'))) return join(base, 'index.tsx');
  return null;
}

/** Un enlace escrito en el código (`/a/${x}/b`) → el patrón de ruta (`/a/[p]/b`). */
function patron(enlace: string): string {
  return enlace.replace(/\$\{[^}]+\}/g, '[]');
}
const PATRONES = new Map(Object.keys(VISTAS).map((r) => [r.replace(/\[[a-zA-Z]+\]/g, '[]'), r]));

// =========================================================================== //
describe('las vistas existen y se llega a ellas desde la app', () => {
  it('cada ruta tiene su fichero y monta su pantalla', () => {
    for (const [ruta, nombre] of Object.entries(VISTAS)) {
      const fichero = ficheroDeLaRuta(ruta);
      assert.ok(fichero, `falta la ruta ${ruta}`);
      assert.match(readFileSync(fichero, 'utf8'), new RegExp(`export default ${nombre};`), ruta);
    }
  });

  it('«Mis servicios» sale de la postulación, SOLO para un prestador activo', () => {
    const hub = pantalla('ServiciosPrestadorScreen');
    const desde = hub.indexOf("{solicitud.provider.status === 'active' ? (");
    assert.ok(desde > 0, 'la entrada no depende de que el prestador esté activo');
    const bloque = hub.slice(desde, hub.indexOf(') : null}', desde));
    assert.match(bloque, /router\.push\('\/servicios\/prestador\/catalogo' as never\)/);
    // Y a la postulación solo se llega desde el perfil con la bandera encendida.
    const perfil = fuente('screens/ProfileScreen.tsx');
    const entrada = perfil.slice(perfil.indexOf('{serviciosEncendido ? ('));
    assert.match(entrada.slice(0, entrada.indexOf(') : null}')), /router\.push\('\/servicios\/prestador' as never\)/);
  });

  it('el catálogo y las categorías, en el panel de administración, SOLO con la bandera', () => {
    const panel = fuente('screens/PanelDeAdministracionScreen.tsx');
    assert.match(panel, /serviciosEncendido\s*\?\s*\[\.\.\.SECCIONES_DE_ADMINISTRACION, SECCION_DE_SERVICIOS\]/);
    const seccion = panel.slice(panel.indexOf('export const SECCION_DE_SERVICIOS'));
    for (const ruta of ['/admin/servicios/catalogo', '/admin/servicios/categorias']) {
      assert.ok(seccion.includes(`ruta: '${ruta}'`), ruta);
    }
    const siempre = panel.slice(
      panel.indexOf('export const SECCIONES_DE_ADMINISTRACION'),
      panel.indexOf('export const SECCION_DE_SERVICIOS'),
    );
    assert.ok(!siempre.includes('/admin/servicios'));
  });

  it('ninguna vista se alcanza solo escribiendo la URL', () => {
    const enlazadas = new Set<string>();
    const origenes = [...PANTALLAS, 'ServiciosPrestadorScreen', 'PanelDeAdministracionScreen'];
    for (const nombre of origenes) {
      const codigo = fuente(`screens/${nombre}.tsx`);
      for (const m of codigo.matchAll(/['`](\/(?:servicios|admin\/servicios)\/[^'`]*)['`]/g)) {
        const enlace = (m[1] as string).replace(/\$\{ruta\}/g, '/servicios/prestador/catalogo/${id}');
        const ruta = PATRONES.get(patron(enlace));
        if (ruta) enlazadas.add(ruta);
      }
      // `${ruta}/editar` etc.: `ruta` es el servicio propio.
      for (const m of codigo.matchAll(/`\$\{ruta\}\/([a-z]+)`/g)) {
        const r = PATRONES.get(`/servicios/prestador/catalogo/[]/${m[1]}`);
        if (r) enlazadas.add(r);
      }
      for (const m of codigo.matchAll(/`\$\{ruta\}\/\$\{donde\}`/g)) {
        void m;
        enlazadas.add('/servicios/prestador/catalogo/[serviceId]/editar');
        enlazadas.add('/servicios/prestador/catalogo/[serviceId]/imagenes');
      }
    }
    const sueltas = Object.keys(VISTAS).filter((r) => !enlazadas.has(r));
    assert.deepEqual(sueltas, [], `sin enlace desde la app: ${sueltas.join(', ')}`);
  });

  it('con la bandera apagada no cambia nada más: ninguna otra pantalla importa el catálogo', () => {
    const sucias: string[] = [];
    for (const nombre of ['HomeScreen', 'ExploreScreen', 'EventsScreen', 'SettingsScreen', 'NotificationsScreen', 'ProfileScreen']) {
      const ruta = join(SRC, 'screens', `${nombre}.tsx`);
      if (!existsSync(ruta)) continue;
      if (/serviciosCatalogo|ServiceCatalog|EstadoDelCatalogo/.test(readFileSync(ruta, 'utf8'))) sucias.push(nombre);
    }
    assert.deepEqual(sucias, []);
  });
});

// =========================================================================== //
describe('el formulario del servicio solo ofrece lo que el servidor admite', () => {
  const EDITAR = fuente('screens/EditarServicioScreen.tsx').replace(/\r\n/g, '\n');
  const limpio = sinComentarios(EDITAR);

  it('los modelos de precio y las modalidades salen de las listas OFRECIDAS', () => {
    assert.ok(limpio.includes('MODELOS_DE_PRECIO_OFRECIDOS.map('));
    assert.ok(limpio.includes('MODALIDADES_OFRECIDAS.map('));
    // Si alguien vuelve a iterar la lista completa, «precio fijo» y «desde»
    // (o «a domicilio») vuelven a la pantalla: rojo.
    assert.ok(!/\bMODELOS_DE_PRECIO\.map\(/.test(limpio), 'vuelve a ofrecer los cuatro modelos');
    assert.ok(!/\bMODALIDADES\.map\(/.test(limpio), 'vuelve a ofrecer «a domicilio»');
    assert.ok(!/^\s*MODELOS_DE_PRECIO,$/m.test(EDITAR), 'la pantalla no necesita la lista completa');
  });

  it('el importe y la moneda no se piden con un modelo que no se ofrece', () => {
    assert.ok(limpio.includes('seOfrece(formulario.modeloDePrecio) && llevaImporte(formulario.modeloDePrecio)'));
    assert.ok(!/\{llevaImporte\(formulario\.modeloDePrecio\) \?/.test(limpio));
  });

  it('un borrador antiguo con importe dice por qué no hay ninguna opción marcada', () => {
    assert.ok(limpio.includes("f('servicios.catalogo.editar.precioNoAdmitido')"));
    for (const diccionario of [es, en, pt]) {
      assert.ok('servicios.catalogo.editar.precioNoAdmitido' in diccionario);
    }
    // Y lo que pide elegir ya no nombra lo prohibido.
    const pide = (es as Record<string, string>)['servicios.catalogo.falta.price_model'] ?? '';
    assert.ok(pide.length > 0 && !/fijo|desde/i.test(pide), pide);
  });
});

// =========================================================================== //
describe('cada vista se comporta', () => {
  for (const nombre of PANTALLAS) {
    const codigo = pantalla(nombre);

    it(`${nombre}: cabecera, carga, error con reintento y ningún texto en duro`, () => {
      assert.match(codigo, /<AppHeader\s+title=\{/);
      assert.match(codigo, /<StateView state="loading" \/>/);
      assert.match(codigo, /<EstadoDelCatalogo fallo=\{fallo\} onRetry=\{\(\) => void cargar\(\)\} \/>/);
      // 'descubrimiento' (Incremento 3) traduce los del catálogo y, antes, los suyos.
      assert.match(codigo, /useTextosDeServicios\('(?:catalogo|descubrimiento)'\)/, 'los errores del catálogo se traducen como del catálogo');
      for (const atributo of ['label="', 'title="', 'description="', 'placeholder="', 'actionLabel="']) {
        assert.ok(!codigo.includes(atributo), `${nombre} escribe ${atributo}…" en duro`);
      }
      for (const m of codigo.matchAll(/<Text[^>]*>([^<{]+)<\/Text>/g)) {
        assert.equal((m[1] as string).trim(), '', `${nombre}: texto en duro «${m[1]}»`);
      }
    });

    it(`${nombre}: nunca ve rutas de archivo ni toca la base ni el almacenamiento`, () => {
      assert.ok(!codigo.includes('storage_path'));
      assert.ok(!/supabase/.test(codigo));
      assert.ok(!/fetch\(/.test(codigo), 'todo pasa por los repositorios');
      assert.ok(!/ApiError/.test(codigo), 'los fallos se leen con leerFalloDelCatalogo');
    });
  }

  const CON_ESCRITURA = [
    'NuevoServicioScreen',
    'ServicioDelPrestadorScreen',
    'EditarServicioScreen',
    'ImagenesDelServicioScreen',
    'EnviarServicioScreen',
    'AdminServicioDelCatalogoScreen',
    'AdminCategoriasDeServiciosScreen',
  ];
  const LECTURAS = new Set(['categorias', 'mios', 'servicio', 'requisitos', 'historial', 'ficha', 'bandeja', 'version']);
  for (const nombre of CON_ESCRITURA) {
    it(`${nombre}: cada escritura pasa por el cerrojo y los botones se bloquean mientras tanto`, () => {
      const codigo = pantalla(nombre);
      assert.match(codigo, /useCerrojo\(cargar, 'catalogo'\)/);
      assert.match(codigo, /disabled=\{[^}]*ocupado/);
      const llamadas = [...codigo.matchAll(/await ServiceCatalog(?:Admin)?Repository\.(\w+)\(/g)];
      const escrituras = llamadas.filter((m) => !LECTURAS.has(m[1] as string));
      assert.ok(escrituras.length > 0, `${nombre} no escribe nada`);
      for (const m of escrituras) {
        const antes = codigo.slice(0, m.index);
        assert.ok(antes.lastIndexOf('correr(async') >= 0, `${nombre}: ${m[1]} fuera del cerrojo`);
      }
    });
  }

  it('las vistas que solo leen no escriben', () => {
    for (const nombre of PANTALLAS.filter((n) => !CON_ESCRITURA.includes(n))) {
      const llamadas = [...pantalla(nombre).matchAll(/ServiceCatalog(?:Admin)?Repository\.(\w+)\(/g)];
      for (const m of llamadas) assert.ok(LECTURAS.has(m[1] as string), `${nombre} llama a ${m[1]}`);
    }
  });

  it('lo que no tiene vuelta atrás pide confirmación (y lo destructivo se marca)', () => {
    const confirmaciones: [string, RegExp][] = [
      ['ServicioDelPrestadorScreen', /retirarVersion\.titulo[\s\S]*destructive: true/],
      ['EnviarServicioScreen', /enviar\.(re)?enviarTitulo/],
      ['ImagenesDelServicioScreen', /quitarTitulo[\s\S]*destructive: true/],
      ['EditarServicioScreen', /salirTitulo[\s\S]*destructive: true/],
      ['AdminServicioDelCatalogoScreen', /destructive: esDestructiva\(esta\)/],
      ['AdminCategoriasDeServiciosScreen', /desactivarTitulo[\s\S]*destructive: true/],
    ];
    for (const [nombre, patronDeConfirmacion] of confirmaciones) {
      const codigo = pantalla(nombre);
      assert.match(codigo, /await confirm\(\{/, nombre);
      assert.match(codigo, patronDeConfirmacion, nombre);
    }
  });

  it('lo que se ofrece al prestador lo dice el servidor', () => {
    const detalle = pantalla('ServicioDelPrestadorScreen');
    for (const bandera of ['s.can_edit ?', 's.can_open_draft ?', 's.can_withdraw ?', 's.publicly_visible ?']) {
      assert.ok(detalle.includes(bandera), bandera);
    }
    const enviar = pantalla('EnviarServicioScreen');
    assert.match(enviar, /const puede = servicio\.can_submit && faltan\.length === 0;/);
    assert.match(enviar, /disabled=\{!puede \|\| ocupado\}/);
    assert.match(enviar, /ServiceCatalogRepository\.requisitos\(id\)/, 'lo que falta se pide al servidor');
    for (const nombre of ['EditarServicioScreen', 'ImagenesDelServicioScreen', 'EnviarServicioScreen']) {
      assert.match(pantalla(nombre), /!servicio\.can_edit \|\| !servicio\.open_version/, nombre);
    }
  });

  it('las decisiones son las que ofrece el servidor, con motivo donde toca, y nadie decide lo propio', () => {
    const detalle = pantalla('AdminServicioDelCatalogoScreen');
    assert.match(detalle, /s\.actions\.map\(/);
    assert.match(detalle, /revisarMotivo\(accion, motivo\)/);
    assert.match(detalle, /s\.own \?/);
    assert.match(detalle, /cuerpoDeLaDecision\(esta, \{ motivo, notaInterna, campos \}\)/);
    assert.match(detalle, /resaltar=\{vista === propuesta \? s\.changed_fields : \[\]\}/, 'se marca lo que cambia');
    // Publicar la versión de un suspendido no promete que lo verán todos.
    assert.match(detalle, /a === 'publish' && s\.status === 'suspended' \? 'publishSuspendido' : a/);
  });

  it('cada salto lleva una clave por intento, que se renueva tras el éxito', () => {
    for (const [nombre, llamada] of [
      ['NuevoServicioScreen', 'crear(categoria, clave.current)'],
      ['EnviarServicioScreen', 'enviar(servicio.id, clave.current)'],
      ['ServicioDelPrestadorScreen', 'retirarVersion(s.id, clave.current)'],
    ] as const) {
      const codigo = pantalla(nombre);
      assert.ok(codigo.includes(llamada), `${nombre}: ${llamada}`);
      assert.match(codigo, /clave\.current = nuevaClave\(\);/, nombre);
    }
    const imagenes = pantalla('ImagenesDelServicioScreen');
    assert.match(imagenes, /if \(clave\.current === null\) clave\.current = nuevaClave\(\);/);
    assert.match(imagenes, /clave\.current = null;/);
    assert.match(pantalla('AdminServicioDelCatalogoScreen'), /clave\.current = nuevaClave\(\);[\s\S]*clave\.current,\n/);
  });

  it('la bandeja pagina por cursor y una respuesta vieja no pisa un filtro nuevo', () => {
    for (const nombre of ['AdminCatalogoScreen', 'MisServiciosScreen']) {
      const codigo = pantalla(nombre);
      assert.match(codigo, /juntar\(/, nombre);
      assert.match(codigo, /este !== pedido\.current/, nombre);
    }
    // «Ver más» tampoco mezcla una página del filtro anterior.
    const verMas = pantalla('AdminCatalogoScreen').split('const verMas = async')[1]?.split('\n  };')[0] ?? '';
    assert.match(verMas, /const este = pedido\.current;[\s\S]*if \(este !== pedido\.current\) return;/);
    const bandeja = pantalla('AdminCatalogoScreen');
    for (const filtro of ['COLAS.map', 'FILTROS_DE_VERSION.map', 'FILTROS_DE_MODALIDAD.map', 'categoriasEnArbol(categorias).map']) {
      assert.ok(bandeja.includes(filtro), filtro);
    }
  });

  it('la ficha pública no promete reservar ni pagar', () => {
    const ficha = pantalla('FichaDeServicioScreen');
    // «bookmark» es el icono de guardar, no una reserva.
    assert.ok(!/reserv|pag(ar|o)|compr|checkout|book(?!mark)/i.test(ficha));
    // UN solo botón desde el Incremento 3: guardar, que no reserva nada.
    const botones = ficha.match(/<Button\b[\s\S]*?\/>/g) ?? [];
    assert.equal(botones.length, 1, 'un solo botón: guardar');
    assert.match(botones[0] as string, /icon="bookmark"/);
    assert.match(botones[0] as string, /alternarGuardado/);
  });

  it('accesibilidad: las opciones excluyentes son radios, y cada imagen se describe', () => {
    for (const nombre of ['NuevoServicioScreen', 'EditarServicioScreen', 'AdminCatalogoScreen', 'AdminCategoriasDeServiciosScreen']) {
      const codigo = pantalla(nombre);
      assert.match(codigo, /accessibilityRole="radiogroup"/, nombre);
      assert.match(codigo, /rol="radio"/, nombre);
    }
    assert.match(pantalla('ImagenesDelServicioScreen'), /accessibilityLabel=\{imagen\.alt_text\}/);
    assert.match(sinComentarios(fuente('components/ContenidoDelServicio.tsx')), /accessibilityLabel=\{imagen\.alt_text\}/);
  });
});

// =========================================================================== //
describe('los repositorios hablan con rutas que existen', () => {
  const router = readFileSync(join(API, 'services', 'catalogo_router.py'), 'utf8');
  const rutasDelServidor = new Set<string>();
  for (const m of router.matchAll(/@(router|admin_router)\.(get|post|patch|delete|put)\(\s*"([^"]+)"/g)) {
    const prefijo = m[1] === 'router' ? '/services' : '/admin/services';
    rutasDelServidor.add(`${(m[2] as string).toUpperCase()} ${prefijo}${m[3]}`);
  }
  const prestador = sinComentarios(fuente('repositories/ServiceCatalogRepository.ts'));
  const admin = sinComentarios(fuente('repositories/ServiceCatalogAdminRepository.ts'));

  const USADAS = [
    'GET /services/categories',
    'GET /services/provider/services',
    'POST /services/provider/services',
    'GET /services/provider/services/{service_id}',
    'POST /services/provider/services/{service_id}/draft',
    'PATCH /services/provider/services/{service_id}/draft',
    'GET /services/provider/services/{service_id}/draft/requirements',
    'POST /services/provider/services/{service_id}/draft/images',
    'PUT /services/provider/services/{service_id}/draft/images/order',
    'DELETE /services/provider/services/{service_id}/draft/images/{image_id}',
    'POST /services/provider/services/{service_id}/draft/submit',
    'POST /services/provider/services/{service_id}/draft/withdraw',
    'GET /services/provider/services/{service_id}/history',
    'GET /services/catalog/{service_id}',
    'GET /admin/services/catalog',
    'GET /admin/services/catalog/{service_id}',
    'GET /admin/services/catalog/{service_id}/versions/{version_id}',
    'GET /admin/services/catalog/{service_id}/history',
    'POST /admin/services/catalog/{service_id}/versions/{version_id}/start-review',
    'POST /admin/services/catalog/{service_id}/versions/{version_id}/request-changes',
    'POST /admin/services/catalog/{service_id}/versions/{version_id}/approve',
    'POST /admin/services/catalog/{service_id}/versions/{version_id}/publish',
    'POST /admin/services/catalog/{service_id}/suspend',
    'POST /admin/services/catalog/{service_id}/reinstate',
    'POST /admin/services/catalog/{service_id}/retire',
    'GET /admin/services/categories',
    'POST /admin/services/categories',
    'PATCH /admin/services/categories/{category_id}',
    'POST /admin/services/categories/{category_id}/activate',
    'POST /admin/services/categories/{category_id}/deactivate',
  ];

  it('el servidor tiene las 30 rutas del catálogo que usa el teléfono, y ninguna más', () => {
    assert.equal(USADAS.length, 30);
    const usadas = new Set(USADAS);
    const faltan = [...usadas].filter((r) => !rutasDelServidor.has(r));
    assert.deepEqual(faltan, [], `el teléfono llama a rutas que no existen: ${faltan.join(', ')}`);
    const sinUsar = [...rutasDelServidor].filter((r) => !usadas.has(r));
    assert.deepEqual(sinUsar, [], `rutas del servidor sin vista: ${sinUsar.join(', ')}`);
  });

  it('cada tramo de ruta aparece en su repositorio', () => {
    for (const tramo of ['/categories', '/provider/services', '/draft', '/draft/requirements', '/draft/images', '/images/order', '/draft/submit', '/draft/withdraw', '/history', '/catalog/']) {
      assert.ok(prestador.includes(tramo), `prestador: ${tramo}`);
    }
    for (const tramo of ['/admin/services', '/catalog', '/versions/', "'start-review'", "'request-changes'", "'approve'", "'publish'", "'suspend'", "'reinstate'", "'retire'", '/history', '/categories', '/activate', '/deactivate']) {
      assert.ok(admin.includes(tramo), `administración: ${tramo}`);
    }
  });

  it('las altas y los saltos llevan Idempotency-Key; ninguna petición manda `status`', () => {
    for (const metodo of ['crear', 'subirImagen', 'enviar', 'retirarVersion']) {
      const cuerpo = prestador.slice(prestador.indexOf(`async ${metodo}(`));
      assert.match(cuerpo.slice(0, cuerpo.indexOf('\n  },')), /clave/, metodo);
    }
    assert.match(prestador, /headers: \{ 'Idempotency-Key': clave \}/);
    assert.match(prestador, /headers: \{ 'Idempotency-Key': opciones\.clave \}/);
    assert.match(admin, /headers: \{ 'Idempotency-Key': clave \}/);
    assert.ok(!/status['"]?\s*:/.test(prestador), 'el prestador nunca manda un estado');
    assert.ok(!/['"]status['"]/.test(admin), 'administración decide por rutas, no con un campo `status`');
  });

  it('la subida es multipart a la API, con espera larga y sin cabecera de tipo a mano', () => {
    assert.match(prestador, /new FormData\(\)/);
    assert.match(prestador, /formulario\.append\('file', opciones\.archivo, opciones\.nombre\)/);
    assert.match(prestador, /formulario\.append\('alt_text', opciones\.alternativo\)/);
    assert.match(prestador, /timeoutMs: ESPERA_DE_SUBIDA_MS/);
    assert.ok(!/Content-Type/.test(prestador));
  });

  it('nada del catálogo escribe directo en la base o en el almacenamiento', () => {
    const ficheros = [
      'repositories/ServiceCatalogRepository.ts', 'repositories/ServiceCatalogAdminRepository.ts',
      'lib/serviciosCatalogo.ts', 'hooks/useCatalogoDeServicios.ts', 'components/ContenidoDelServicio.tsx',
      'components/EstadoDelCatalogo.tsx',
    ];
    for (const f of ficheros) {
      const codigo = sinComentarios(fuente(f));
      assert.ok(!/supabase|storage\.from|service-media/.test(codigo), f);
    }
  });
});

// =========================================================================== //
describe('los avisos del catálogo', () => {
  const avisos = readFileSync(join(API, 'services', 'avisos.py'), 'utf8');
  const constantes = new Map(
    [...avisos.matchAll(/^([A-Z_]+) = "(service_[a-z_]+)"$/gm)].map((m) => [m[1] as string, m[2] as string]),
  );
  const bloque = avisos.slice(avisos.indexOf('TIPOS_DEL_CATALOGO = frozenset'), avisos.indexOf('TIPOS = frozenset'));
  const tipos = [...bloque.matchAll(/([A-Z_]{4,}),/g)].map((m) => constantes.get(m[1] as string) as string);

  it('los 11 tipos del servidor tienen título, texto y destino en los tres idiomas', () => {
    assert.equal(tipos.length, 11);
    for (const tipo of tipos) {
      const aviso = avisoAlCreador(tipo);
      assert.ok(aviso, `sin aviso: ${tipo}`);
      for (const clave of [aviso.titulo, aviso.cuerpo ?? '']) {
        assert.ok(clave in es && clave in en && clave in pt, `${tipo}: falta ${clave}`);
      }
      assert.ok(rutaDelAviso(tipo, 's1'), `${tipo} sin destino`);
      assert.ok(rutaDelAviso(tipo, null), `${tipo} sin destino cuando no hay servicio`);
    }
  });

  it('lo publicado, a su ficha; lo demás, al servicio propio; el equipo, a la revisión', () => {
    assert.equal(rutaDelAviso('service_catalog_published', 's1'), '/servicios/ficha/s1');
    assert.equal(rutaDelAviso('service_catalog_changes_requested', 's1'), '/servicios/prestador/catalogo/s1');
    assert.equal(rutaDelAviso('service_catalog_suspended', null), '/servicios/prestador/catalogo');
    // Publicada en un servicio suspendido: al servicio propio, no a una ficha que da 404.
    assert.equal(rutaDelAviso('service_catalog_published_suspended', 's1'), '/servicios/prestador/catalogo/s1');
    assert.equal(rutaDelAviso('service_catalog_submitted', 's1'), '/admin/servicios/catalogo/s1');
    assert.equal(rutaDelAviso('service_catalog_withdrawn_review', null), '/admin/servicios/catalogo');
  });

  it('cada destino es una vista que existe', () => {
    for (const tipo of tipos) {
      for (const id of ['s1', null]) {
        const destino = rutaDelAviso(tipo, id) as string;
        assert.ok(PATRONES.has(destino.replace('s1', '[]')), `${tipo} → ${destino}`);
      }
    }
  });

  it('tocar el PUSH abre la aplicación sin inventar una ruta (la cola no manda destino)', () => {
    // Limitación documentada (Z_SERVICIOS_ARQUITECTURA.md §32): el push de la
    // cola de entregas sale sin `data` y `rutaDelPush` solo conoce los
    // directos; el destino lo da la bandeja. Si un día el push lleva el
    // servicio, esta prueba tiene que cambiar A LA VEZ que `rutaDelPush`.
    const cola = readFileSync(join(API, 'notifications', 'push.py'), 'utf8')
      .replace(/\r\n/g, '\n')
      .split('async def enviar_de_la_cola(')[1]
      ?.split('\ndef ')[0] ?? '';
    assert.ok(cola.includes('"channelId"'), 'no se encontró el envío de la cola');
    assert.ok(!cola.includes('"data"'), 'la cola ya manda datos: enseñar a rutaDelPush los avisos del catálogo');
    for (const tipo of tipos) {
      assert.equal(rutaDelPush({ type: tipo, serviceId: '5b7e2f7a-8d1c-4a55-9d61-0c3f1e2a4b6c' }), null, tipo);
    }
  });

  it('los textos del push existen en los tres idiomas en el servidor', () => {
    const textos = readFileSync(join(API, 'notifications', 'textos.py'), 'utf8');
    for (const tipo of tipos) assert.ok(textos.includes(`"${tipo}"`), tipo);
  });
});
