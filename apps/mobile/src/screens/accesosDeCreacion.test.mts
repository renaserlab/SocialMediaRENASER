/**
 * QUE CREAR Y ADMINISTRAR TENGAN PUERTA.
 *
 * El 23/09/2026 se encontro que «Mis eventos» —y con el el alta de eventos, las
 * entradas y la cola de revision— no tenia ningun enlace: solo se llegaba
 * escribiendo la ruta. Y la revision de cursos no tenia pantalla, asi que
 * ningun curso nuevo podia publicarse desde la app. Este fichero vigila que
 * esas puertas sigan existiendo y que no apunten a rutas que no existen.
 *
 * Se lee el CODIGO FUENTE, como el resto de pruebas de pantalla del proyecto:
 * un componente de React Native no se ejecuta con `node --test`.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SRC = join(import.meta.dirname, '..');
const APP = join(SRC, '..', 'app');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

/** Si una ruta de expo-router tiene fichero: `/a/b` → `app/a/b.tsx` o `app/a/b/index.tsx`. */
function rutaExiste(ruta: string): boolean {
  const base = join(APP, ...ruta.split('/').filter(Boolean));
  return existsSync(`${base}.tsx`) || existsSync(join(base, 'index.tsx'));
}

describe('el panel de administracion', () => {
  const panel = fuente('screens/PanelDeAdministracionScreen.tsx');
  const rutas = [...panel.matchAll(/ruta: '([^']+)'/g)].map((m) => m[1]);

  it('tiene entradas', () => {
    assert.ok(rutas.length >= 10, `solo ${rutas.length} entradas`);
  });

  it('cada entrada lleva a una pantalla que existe', () => {
    const rotas = rutas.filter((ruta) => !rutaExiste(ruta));
    assert.deepEqual(rotas, [], `rutas sin pantalla: ${rotas.join(', ')}`);
  });

  it('incluye la revision de cursos, que antes no existia', () => {
    assert.ok(rutas.includes('/admin/cursos'));
    assert.ok(rutaExiste('/admin'));
  });

  it('se abre desde el perfil, solo para administracion', () => {
    const perfil = fuente('screens/ProfileScreen.tsx');
    assert.match(perfil, /router\.push\('\/admin' as never\)/);
    assert.match(perfil, /esAdministracion \? \(/);
  });
});

describe('Mis eventos vuelve a tener puerta', () => {
  it('desde el menu del perfil y desde Eventos', () => {
    assert.match(fuente('screens/ProfileScreen.tsx'), /router\.push\('\/mis-eventos' as never\)/);
    assert.match(fuente('screens/EventsScreen.tsx'), /router\.push\('\/mis-eventos' as never\)/);
    assert.ok(rutaExiste('/mis-eventos'));
  });
});

describe('crear, donde se busca', () => {
  it('Cursos abre la hoja de alta de curso', () => {
    const cursos = fuente('screens/CursosScreen.tsx');
    assert.match(cursos, /<AccesoDeCreador/);
    assert.match(cursos, /<CreateCatalogSheet kind="curso"/);
  });

  it('Productos lleva a Mis productos, con la frase del blueprint', () => {
    const productos = fuente('screens/ProductosScreen.tsx');
    assert.match(productos, /router\.push\('\/proveedor\/productos' as never\)/);
    assert.match(productos, /t\('proveedorProductos\.marca\.postula'\)/);
    assert.ok(rutaExiste('/proveedor/productos'));
  });
});

describe('la revision de cursos', () => {
  const pantalla = fuente('screens/RevisionDeCursosScreen.tsx');

  it('usa la cola y la decision del servidor', () => {
    assert.match(pantalla, /LearningRepository\.reviewQueue\(\)/);
    assert.match(pantalla, /LearningRepository\.review\(/);
  });

  it('pide motivo con el mismo minimo que el servidor (10)', () => {
    // `review_course` rechaza con 422 un motivo de menos de 10 caracteres: si
    // la pantalla dejara enviar menos, el boton fallaria siempre.
    assert.match(pantalla, /MINIMO_DEL_MOTIVO = 10;/);
    const router = readFileSync(
      join(SRC, '..', '..', 'api', 'app', 'modules', 'catalog', 'router.py'),
      'utf8',
    );
    assert.match(router, /len\(motivo\) < 10/);
  });

  it('distingue el aviso de «es tu propio curso»', () => {
    assert.match(pantalla, /course_self_review_not_allowed/);
  });
});
