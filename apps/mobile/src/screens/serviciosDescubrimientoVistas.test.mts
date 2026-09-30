/**
 * Z Servicios, Incremento 3: las vistas del descubrimiento, leídas en su
 * código (aquí no hay renderizador).
 *
 * Que cada vista tiene ruta y se alcanza desde otra (Explorar → Servicios →
 * ficha → prestador; Servicios → guardados), que con la bandera apagada
 * Explorar no cambia, que ninguna vista filtra ni ordena lo que manda el
 * servidor, que no se pinta ninguna nota inventada, que guardar se bloquea
 * mientras tanto, y que ningún texto está en duro.
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

/** Ruta de expo-router → pantalla que monta. */
const VISTAS: Record<string, string> = {
  '/servicios': 'ServiciosScreen',
  '/servicios/guardados': 'ServiciosGuardadosScreen',
  '/servicios/prestadores/[providerId]': 'PrestadorPublicoScreen',
  '/servicios/ficha/[serviceId]': 'FichaDeServicioScreen',
};
const PANTALLAS = Object.values(VISTAS);

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

  it('Explorar → Servicios, SOLO con la bandera encendida', () => {
    const accesos = componente('AccesosAVerticales');
    assert.match(accesos, /\{ clave: 'servicios', icono: 'briefcase', ruta: '\/servicios', conBandera: true \}/);
    assert.match(accesos, /const serviciosEncendido = useServiciosEncendido\(\);/);
    assert.match(accesos, /const disponible = vertical\.ruta !== null && \(!vertical\.conBandera \|\| serviciosEncendido\);/);
    // Apagada: el aviso de siempre, sin navegar.
    assert.match(accesos, /: alTocarNoDisponible\(nombre\)/);
  });

  it('con la bandera apagada Explorar no pide nada de Servicios', () => {
    const explorar = fuente('screens/ExploreScreen.tsx');
    // `@/services/…` es la carpeta de la app, no Z Servicios: se buscan sus rutas.
    assert.ok(
      !/ServiceDiscovery|serviciosDescubrimiento|ServiceCatalog|\/services\/(catalog|providers|saved|suggestions|public-categories)/.test(
        explorar,
      ),
    );
    const accesos = componente('AccesosAVerticales');
    assert.ok(!/Repository|apiRequest/.test(accesos), 'el acceso solo lee la bandera de /platform/config');
  });

  it('Servicios → ficha y guardados; ficha → prestador; prestador y guardados → ficha', () => {
    assert.match(pantalla('ServiciosScreen'), /router\.push\('\/servicios\/guardados'/);
    assert.match(pantalla('ServiciosScreen'), /router\.push\(`\/servicios\/ficha\/\$\{t\.id\}`/);
    assert.match(pantalla('FichaDeServicioScreen'), /router\.push\(`\/servicios\/prestadores\/\$\{ficha\.provider\.id\}`/);
    assert.match(pantalla('FichaDeServicioScreen'), /router\.push\(`\/servicios\/ficha\/\$\{servicio\}`/);
    assert.match(pantalla('PrestadorPublicoScreen'), /router\.push\(`\/servicios\/ficha\/\$\{t\.id\}`/);
    assert.match(pantalla('ServiciosGuardadosScreen'), /router\.push\(`\/servicios\/ficha\/\$\{g\.service_id\}`/);
  });
});

// =========================================================================== //
describe('cada vista se comporta', () => {
  for (const nombre of PANTALLAS) {
    it(`${nombre}: atrás, carga, error con reintento, textos traducidos`, () => {
      const codigo = pantalla(nombre);
      const cabeceras = [...codigo.matchAll(/<AppHeader[\s\S]*?\/>/g)].map((m) => m[0]);
      assert.ok(cabeceras.length > 0 && cabeceras.every((c) => /onBack=\{volver\}/.test(c)));
      assert.match(codigo, /router\.replace\('\/(servicios|explore)' as never\)/, 'respaldo del atrás');
      assert.match(codigo, /<StateView state="loading" \/>/);
      assert.match(codigo, /<EstadoDelCatalogo fallo=\{fallo\} onRetry=\{\(\) => void cargar\(\)\} \/>/);
      assert.match(codigo, /useTextosDeServicios\('descubrimiento'\)/);
      assert.match(codigo, /leerFalloDelCatalogo\(error\)/);
      for (const atributo of ['label="', 'title="', 'description="', 'placeholder="', 'actionLabel="', 'accessibilityLabel="']) {
        assert.ok(!codigo.includes(atributo), `${nombre} escribe ${atributo}…" en duro`);
      }
      for (const m of codigo.matchAll(/<Text[^>]*>([^<{]+)<\/Text>/g)) {
        assert.equal((m[1] as string).trim(), '', `${nombre}: texto en duro «${m[1]}»`);
      }
      assert.ok(!/supabase|storage_path|fetch\(|ApiError/.test(codigo));
    });
  }

  for (const nombre of ['ServiciosScreen', 'ServiciosGuardadosScreen']) {
    it(`${nombre}: tiene un estado vacío que dice qué pasa`, () => {
      assert.match(pantalla(nombre), /<StateView\s+state="empty"/);
    });
  }

  it('el perfil dice «no lo encontramos» con palabras propias', () => {
    const codigo = pantalla('PrestadorPublicoScreen');
    assert.match(codigo, /fallo === 'noEncontrada'/);
    assert.match(codigo, /servicios\.descubrir\.error\.prestadorNoEncontrado/);
  });
});

// =========================================================================== //
describe('lo decide el servidor, no el teléfono', () => {
  it('el catálogo pide con los filtros y pagina con el cursor, sin recortar ni reordenar', () => {
    const codigo = pantalla('ServiciosScreen');
    assert.match(codigo, /ServiceDiscoveryRepository\.catalogo\(filtros, null\)/);
    assert.match(codigo, /ServiceDiscoveryRepository\.catalogo\(filtros, cursor\)/);
    assert.match(codigo, /juntarSinRepetir\(actuales \?\? \[\], pagina\.items\)/);
    assert.ok(!/\.sort\(/.test(codigo), 'no se reordena nada');
    assert.ok(!/(items|pagina\.items|secciones)\s*\.filter\(/.test(codigo), 'no se filtra lo que manda el servidor');
    // Los filtros viven en la ruta.
    assert.match(codigo, /filtrosDesdeRuta\(params\)/);
    assert.match(codigo, /router\.replace\(\{ pathname: '\/servicios', params: rutaDesdeFiltros\(nuevos\) \}/);
  });

  it('el repositorio manda los filtros al servidor', () => {
    const repo = fuente('repositories/ServiceDiscoveryRepository.ts');
    assert.match(repo, /`\$\{BASE\}\/catalog\?\$\{consultaDelCatalogo\(filtros, cursor\)\}`/);
    assert.ok(!/\.filter\(|\.sort\(/.test(repo));
  });

  it('sin búsqueda ni filtros, las sugerencias; con ellos, ni se piden', () => {
    const codigo = pantalla('ServiciosScreen');
    assert.match(codigo, /estaBuscando\(filtros\) \? Promise\.resolve\(\{ sections: \[\] \}\) : ServiceDiscoveryRepository\.sugerencias\(\)/);
    assert.match(codigo, /claveDeLaSeccion\(s\.reason\)/);
    assert.match(codigo, /titulo && s\.items\.length > 0/);
  });
});

// =========================================================================== //
describe('nada inventado', () => {
  const todo = [...PANTALLAS.map(pantalla), componente('TarjetaDeServicio'), componente('ConfianzaEnServicios')].join('\n');

  it('ninguna estrella, ninguna nota, ningún contador de popularidad', () => {
    assert.ok(!/name="star"|toFixed|rating|popular|saves_count|guardadoPor/.test(todo));
  });

  it('las reseñas y la confianza pasan por su lógica', () => {
    const confianza = componente('ConfianzaEnServicios');
    assert.match(confianza, /resenasLegibles\(resenas\)/);
    assert.match(confianza, /senalesDeConfianza\(confianza\)/);
    assert.match(confianza, /servicios\.descubrir\.confianza\.alcance/);
    assert.match(pantalla('FichaDeServicioScreen'), /<ResenasDelServicio resenas=\{ficha\.reviews\} \/>/);
    assert.match(pantalla('PrestadorPublicoScreen'), /<ResenasDelServicio resenas=\{perfil\.reviews\} delPrestador \/>/);
  });

  it('el motivo de una tarjeta pasa por motivoLegible y la credencial solo si es verdad', () => {
    const tarjeta = componente('TarjetaDeServicio');
    assert.match(tarjeta, /const motivo = motivoLegible\(tarjeta\);/);
    assert.match(tarjeta, /\{tarjeta\.credential_verified \? \(/);
    assert.ok(!/location_area &&(?![^\n]*modality !== 'virtual')/.test(tarjeta), 'la zona solo fuera de lo virtual');
  });
});

// =========================================================================== //
describe('guardar', () => {
  it('no se puede tocar dos veces mientras se guarda', () => {
    for (const nombre of ['ServiciosScreen', 'FichaDeServicioScreen', 'ServiciosGuardadosScreen']) {
      const codigo = pantalla(nombre);
      assert.match(codigo, /ServiceDiscoveryRepository\.(guardar|quitar)\(/, nombre);
      assert.match(codigo, /if \((guardando|quitando|!ficha \|\| guardando)\) return;/, nombre);
    }
    const tarjeta = componente('TarjetaDeServicio');
    assert.match(tarjeta, /disabled=\{guardando\}/);
    assert.match(tarjeta, /accessibilityState=\{\{ selected: tarjeta\.saved, disabled: guardando \}\}/);
  });

  it('lo que ya no está disponible sale sin contenido ni enlace, y se puede quitar', () => {
    const codigo = pantalla('ServiciosGuardadosScreen');
    assert.match(codigo, /g\.available && g\.service \?/);
    assert.match(codigo, /servicios\.descubrir\.guardados\.noDisponible/);
    assert.match(codigo, /onPress=\{\(\) => void quitar\(g\.service_id\)\}/);
  });
});

// =========================================================================== //
describe('accesibilidad', () => {
  it('la tarjeta se anuncia como botón, con nombre, y el marcador tiene área táctil', () => {
    const tarjeta = componente('TarjetaDeServicio');
    assert.equal((tarjeta.match(/accessibilityRole="button"/g) ?? []).length, 2);
    assert.match(tarjeta, /minWidth: 44, minHeight: 44/);
    assert.match(tarjeta, /accessibilityLabel=\{tarjeta\.cover\.alt_text\}/);
  });

  it('las opciones de los filtros se anuncian como botones de opción', () => {
    const codigo = pantalla('ServiciosScreen');
    assert.ok((codigo.match(/rol="radio"/g) ?? []).length >= 4);
    assert.match(codigo, /rol="checkbox"/);
    assert.match(codigo, /accessibilityRole="radiogroup"/);
  });
});

// =========================================================================== //
describe('traducciones', () => {
  it('cada clave escrita en las vistas existe en es, en y pt', () => {
    const codigo = [...PANTALLAS.map(pantalla), componente('TarjetaDeServicio'), componente('ConfianzaEnServicios')].join('\n');
    const claves = new Set([...codigo.matchAll(/'(servicios\.[A-Za-z0-9_.]+)'/g)].map((m) => m[1] as string));
    assert.ok(claves.size > 40, `solo ${claves.size} claves: ¿cambió la forma de escribirlas?`);
    for (const clave of claves) {
      for (const [idioma, dic] of Object.entries({ es, en, pt })) {
        assert.ok(clave in dic, `falta «${clave}» en ${idioma}`);
      }
    }
  });
});
