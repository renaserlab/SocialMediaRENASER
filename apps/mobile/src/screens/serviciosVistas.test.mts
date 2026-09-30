/**
 * Z Servicios, Incremento 1: las vistas, sus puertas y sus contratos.
 *
 * Se lee el CÓDIGO FUENTE, como el resto de pruebas de pantalla del proyecto:
 * un componente de React Native no se ejecuta con `node --test`. Lo que se
 * vigila:
 *
 *  1. LAS 14 VISTAS TIENEN RUTA y se llega a ellas desde la app (perfil y
 *     panel de administración), SOLO con la bandera encendida.
 *  2. CADA VISTA tiene carga, vacío, error con reintento, cerrojo contra el
 *     doble toque, confirmación en lo que no tiene vuelta atrás, y ningún
 *     texto escrito en duro.
 *  3. LOS REPOSITORIOS llaman a rutas que EXISTEN en el servidor, con
 *     `Idempotency-Key` en cada salto, y ninguno cambia el estado con PATCH.
 *  4. NINGUNA ESCRITURA DIRECTA a la base ni al almacenamiento, y ninguna ruta
 *     de archivo en el teléfono.
 *  5. LOS 12 AVISOS de Servicios tienen título, texto y destino.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { es } from '../i18n/es.ts';
import { en } from '../i18n/en.ts';
import { pt } from '../i18n/pt.ts';
import { avisoAlCreador, rutaDelAviso } from '../lib/avisosAlCreador.ts';

const SRC = join(import.meta.dirname, '..');
const APP = join(SRC, '..', 'app');
const API = join(SRC, '..', '..', 'api', 'app', 'modules');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function rutaExiste(ruta: string): boolean {
  const base = join(APP, ...ruta.split('/').filter(Boolean));
  return existsSync(`${base}.tsx`) || existsSync(join(base, 'index.tsx'));
}

/** Ruta de expo-router → pantalla que monta. */
const VISTAS: Record<string, string> = {
  '/servicios/prestador': 'ServiciosPrestadorScreen',
  '/servicios/prestador/inicio': 'ServiciosInicioScreen',
  '/servicios/prestador/datos': 'ServiciosDatosScreen',
  '/servicios/prestador/condiciones': 'ServiciosCondicionesScreen',
  '/servicios/prestador/documentos': 'ServiciosDocumentosScreen',
  '/servicios/prestador/credenciales': 'ServiciosCredencialesScreen',
  '/servicios/prestador/credencial': 'ServiciosCredencialScreen',
  '/servicios/prestador/resumen': 'ServiciosResumenScreen',
  '/servicios/prestador/historial': 'ServiciosHistorialScreen',
  '/servicios/prestador/retirar': 'ServiciosRetirarScreen',
  '/admin/servicios': 'AdminServiciosScreen',
  '/admin/servicios/[applicationId]': 'AdminServicioScreen',
  '/admin/servicios/historial/[applicationId]': 'AdminServicioHistorialScreen',
  '/admin/servicios/condiciones': 'AdminServiciosCondicionesScreen',
};
const PANTALLAS = Object.values(VISTAS);
const pantalla = (nombre: string) => sinComentarios(fuente(`screens/${nombre}.tsx`));

// =========================================================================== //
describe('las vistas existen y se llega a ellas', () => {
  it('cada ruta tiene su fichero y monta su pantalla', () => {
    for (const [ruta, nombre] of Object.entries(VISTAS)) {
      assert.ok(rutaExiste(ruta), `falta la ruta ${ruta}`);
      const base = join(APP, ...ruta.split('/').filter(Boolean));
      const fichero = existsSync(`${base}.tsx`) ? `${base}.tsx` : join(base, 'index.tsx');
      assert.match(readFileSync(fichero, 'utf8'), new RegExp(`export default ${nombre};`), ruta);
    }
  });

  it('desde el perfil, «Ofrecer un servicio», SOLO con la bandera encendida', () => {
    const perfil = fuente('screens/ProfileScreen.tsx');
    assert.match(perfil, /const serviciosEncendido = useServiciosEncendido\(\);/);
    const desde = perfil.indexOf('{serviciosEncendido ? (');
    assert.ok(desde > 0, 'la entrada no depende de la bandera');
    const bloque = perfil.slice(desde, perfil.indexOf(') : null}', desde));
    assert.match(bloque, /router\.push\('\/servicios\/prestador' as never\)/);
    assert.match(bloque, /t\('servicios\.entrada'\)/);
  });

  it('desde el panel de administración, SOLO con la bandera encendida', () => {
    const panel = fuente('screens/PanelDeAdministracionScreen.tsx');
    assert.match(panel, /serviciosEncendido\s*\?\s*\[\.\.\.SECCIONES_DE_ADMINISTRACION, SECCION_DE_SERVICIOS\]\s*:\s*SECCIONES_DE_ADMINISTRACION/);
    const seccion = panel.slice(panel.indexOf('export const SECCION_DE_SERVICIOS'));
    for (const ruta of ['/admin/servicios', '/admin/servicios/condiciones']) {
      assert.ok(seccion.includes(`ruta: '${ruta}'`), ruta);
      assert.ok(rutaExiste(ruta), ruta);
    }
    // Y la lista de siempre no cambió: Servicios va aparte.
    const siempre = panel.slice(
      panel.indexOf('export const SECCIONES_DE_ADMINISTRACION'),
      panel.indexOf('export const SECCION_DE_SERVICIOS'),
    );
    assert.ok(!siempre.includes('/admin/servicios'));
  });

  it('las pantallas del prestador se enlazan entre sí (ninguna solo por URL escrita)', () => {
    const enlazadas = new Set<string>();
    for (const nombre of [...PANTALLAS, 'ProfileScreen', 'PanelDeAdministracionScreen']) {
      const codigo = fuente(`screens/${nombre}.tsx`);
      for (const m of codigo.matchAll(/'(\/(?:servicios|admin\/servicios)[a-z/]*)'/g)) enlazadas.add(m[1] as string);
      if (codigo.includes('/admin/servicios/${')) enlazadas.add('/admin/servicios/[applicationId]');
      if (codigo.includes('/admin/servicios/historial/${')) enlazadas.add('/admin/servicios/historial/[applicationId]');
    }
    const sueltas = Object.keys(VISTAS).filter((r) => !enlazadas.has(r));
    assert.deepEqual(sueltas, [], `sin enlace desde la app: ${sueltas.join(', ')}`);
  });

  it('con la bandera apagada no cambia nada más: ninguna otra pantalla importa Servicios', () => {
    const permitidas = new Set([...PANTALLAS, 'ProfileScreen', 'PanelDeAdministracionScreen']);
    const sucias: string[] = [];
    for (const nombre of ['HomeScreen', 'ExploreScreen', 'EventsScreen', 'SettingsScreen', 'NotificationsScreen']) {
      const ruta = join(SRC, 'screens', `${nombre}.tsx`);
      if (!existsSync(ruta) || permitidas.has(nombre)) continue;
      if (/Servicios|ServiceProvider|ServiceAdmission/.test(readFileSync(ruta, 'utf8'))) sucias.push(nombre);
    }
    assert.deepEqual(sucias, []);
  });
});

describe('la bandera funcional', () => {
  const plataforma = sinComentarios(fuente('services/plataforma.ts'));

  it('Servicios solo está encendido si el servidor dice exactamente `true`', () => {
    assert.match(plataforma, /serviciosEncendido: dto\?\.feature_services === true/);
    assert.match(plataforma, /const APAGADA: Configuracion = \{ publicacionFlexible: false, serviciosEncendido: false \}/);
  });

  it('el modo flexible sigue igual: una sola lectura compartida, que se olvida si falla', () => {
    assert.match(plataforma, /publicacionFlexible: dto\?\.publicacion_flexible === true/);
    assert.match(plataforma, /enCurso = null;\s*return APAGADA;/);
    assert.equal((plataforma.match(/platform\/config/g) ?? []).length, 1);
  });

  it('el gancho vale `false` mientras pregunta', () => {
    assert.match(fuente('hooks/useServiciosEncendido.ts'), /useState\(false\)/);
  });
});

describe('cada vista se comporta', () => {
  for (const nombre of PANTALLAS) {
    const codigo = pantalla(nombre);

    it(`${nombre}: cabecera, carga, error con reintento y ningún texto en duro`, () => {
      assert.match(codigo, /<AppHeader\s+title=\{/);
      assert.match(codigo, /<StateView state="loading" \/>/);
      assert.match(codigo, /<EstadoDeServicios fallo=\{[^}]+\} onRetry=\{\(\) => void cargar\(\)\} \/>/);
      for (const atributo of ['label="', 'title="', 'description="', 'placeholder="', 'actionLabel="']) {
        assert.ok(!codigo.includes(atributo), `${nombre} escribe ${atributo}…" en duro`);
      }
      for (const m of codigo.matchAll(/<Text[^>]*>([^<{]+)<\/Text>/g)) {
        assert.equal((m[1] as string).trim(), '', `${nombre}: texto en duro «${m[1]}»`);
      }
    });

    it(`${nombre}: nunca ve ni escribe rutas de archivo ni toca la base`, () => {
      assert.ok(!codigo.includes('storage_path'));
      assert.ok(!/supabase\.(from|storage)/.test(codigo));
      assert.ok(!/fetch\(/.test(codigo), 'todo pasa por los repositorios');
    });
  }

  // La bandeja y los historiales solo leen.
  const CON_ESCRITURA = PANTALLAS.filter((n) => !/Historial/.test(n) && n !== 'AdminServiciosScreen');
  for (const nombre of CON_ESCRITURA) {
    it(`${nombre}: cada escritura pasa por el cerrojo y los botones se bloquean mientras tanto`, () => {
      const codigo = pantalla(nombre);
      assert.match(codigo, /useCerrojo\(/);
      assert.match(codigo, /disabled=\{[^}]*ocupado/);
      const llamadas = [...codigo.matchAll(/await Service(Provider|Admission)Repository\.(\w+)\(/g)];
      assert.ok(llamadas.length > 0, `${nombre} no escribe nada`);
      const lecturas = new Set(['postulacion', 'condiciones', 'bandeja', 'expediente', 'historial', 'verDocumento', 'vistaPrevia']);
      for (const m of llamadas) {
        const metodo = m[2] as string;
        if (lecturas.has(metodo)) continue;
        const antes = codigo.slice(0, m.index);
        const correr = antes.lastIndexOf('correr(async');
        assert.ok(correr >= 0, `${nombre}: ${metodo} fuera del cerrojo`);
      }
    });
  }

  it('lo que no tiene vuelta atrás pide confirmación (y lo destructivo se marca)', () => {
    const confirmaciones: [string, RegExp][] = [
      ['ServiciosRetirarScreen', /confirmarTitulo[\s\S]*destructive: true/],
      ['ServiciosResumenScreen', /enviarTitulo/],
      ['ServiciosDocumentosScreen', /retirarTitulo[\s\S]*destructive: true/],
      ['ServiciosCredencialesScreen', /retirarTitulo[\s\S]*destructive: true/],
      ['AdminServicioScreen', /destructive: esDestructiva\(esta\)/],
      ['AdminServicioScreen', /rechazarCredencialTitulo[\s\S]*destructive: true/],
      ['AdminServiciosCondicionesScreen', /publicarTitulo/],
    ];
    for (const [nombre, patron] of confirmaciones) {
      const codigo = pantalla(nombre);
      assert.match(codigo, /await confirm\(\{/, nombre);
      assert.match(codigo, patron, nombre);
    }
  });

  it('el envío y la retirada llevan una clave por intento y solo se ofrecen si el servidor dice que se puede', () => {
    const resumen = pantalla('ServiciosResumenScreen');
    assert.match(resumen, /const clave = useRef\(nuevaClave\(\)\)/);
    assert.match(resumen, /disabled=\{!puede \|\| !declaro \|\| ocupado\}/);
    assert.match(resumen, /solicitud\.can_resubmit : solicitud\.can_submit/);
    const retirar = pantalla('ServiciosRetirarScreen');
    assert.match(retirar, /!solicitud\.can_withdraw/);
    assert.match(retirar, /ServiceProviderRepository\.retirar\(motivo\.trim\(\) \|\| null, clave\.current\)/);
    assert.match(pantalla('ServiciosPrestadorScreen'), /solicitud\.can_withdraw \?/);
  });

  it('las decisiones son las que ofrece el servidor, con motivo donde toca, y nadie decide lo propio', () => {
    const detalle = pantalla('AdminServicioScreen');
    assert.match(detalle, /e\.available_actions\.map\(/);
    assert.match(detalle, /revisarMotivo\(accion, mensaje\)/);
    assert.match(detalle, /const enRevision = e\.status === 'under_review' && !e\.is_own;/);
    assert.match(detalle, /e\.is_own \?/);
    assert.match(detalle, /ServiceAdmissionRepository\.verDocumento\(e\.id, documentoId\)/);
    assert.match(detalle, /Linking\.openURL\(enlace\.url\)/);
  });

  it('la bandeja pagina por cursor y filtra por estado y tipo', () => {
    const bandeja = pantalla('AdminServiciosScreen');
    assert.match(bandeja, /cursor: null/);
    assert.match(bandeja, /juntarPaginas\(/);
    assert.match(bandeja, /FILTROS_DE_ESTADO\.map/);
    assert.match(bandeja, /FILTROS_DE_TIPO\.map/);
    assert.match(bandeja, /este !== pedido\.current/, 'una respuesta vieja no pisa un filtro nuevo');
  });

  it('accesibilidad básica: las opciones excluyentes son un grupo de radios', () => {
    for (const nombre of ['ServiciosInicioScreen', 'ServiciosDatosScreen', 'ServiciosCredencialScreen']) {
      const codigo = pantalla(nombre);
      assert.match(codigo, /accessibilityRole="radiogroup"/, nombre);
      assert.match(codigo, /rol="radio"/, nombre);
    }
  });
});

// =========================================================================== //
describe('los repositorios hablan con rutas que existen', () => {
  const router = readFileSync(join(API, 'services', 'router.py'), 'utf8');
  const rutasDelServidor = new Set<string>();
  for (const m of router.matchAll(/@(router|admin_router)\.(get|post|patch|delete|put)\(\s*"([^"]+)"/g)) {
    const prefijo = m[1] === 'router' ? '/services' : '/admin/services';
    rutasDelServidor.add(`${(m[2] as string).toUpperCase()} ${prefijo}${m[3]}`);
  }
  const prestador = sinComentarios(fuente('repositories/ServiceProviderRepository.ts'));
  const admin = sinComentarios(fuente('repositories/ServiceAdmissionRepository.ts'));

  const USADAS: [string, string][] = [
    ['GET', '/services/provider/application'],
    ['POST', '/services/provider/application'],
    ['PATCH', '/services/provider/application'],
    ['GET', '/services/provider/application/history'],
    ['GET', '/services/provider/terms'],
    ['POST', '/services/provider/application/terms'],
    ['POST', '/services/provider/application/documents'],
    ['POST', '/services/provider/application/documents/{document_id}/replace'],
    ['DELETE', '/services/provider/application/documents/{document_id}'],
    ['POST', '/services/provider/application/documents/{document_id}/view'],
    ['POST', '/services/provider/application/credentials'],
    ['PATCH', '/services/provider/application/credentials/{credential_id}'],
    ['DELETE', '/services/provider/application/credentials/{credential_id}'],
    ['POST', '/services/provider/application/submit'],
    ['POST', '/services/provider/application/resubmit'],
    ['POST', '/services/provider/application/withdraw'],
    ['GET', '/admin/services/applications'],
    ['GET', '/admin/services/applications/{application_id}'],
    ['GET', '/admin/services/applications/{application_id}/history'],
    ['POST', '/admin/services/applications/{application_id}/documents/{document_id}/view'],
    ['POST', '/admin/services/applications/{application_id}/documents/{document_id}/accept'],
    ['POST', '/admin/services/applications/{application_id}/documents/{document_id}/observe'],
    ['POST', '/admin/services/applications/{application_id}/credentials/{credential_id}/verify'],
    ['POST', '/admin/services/applications/{application_id}/credentials/{credential_id}/observe'],
    ['POST', '/admin/services/applications/{application_id}/credentials/{credential_id}/reject'],
    ['POST', '/admin/services/applications/{application_id}/start-review'],
    ['POST', '/admin/services/applications/{application_id}/request-changes'],
    ['POST', '/admin/services/applications/{application_id}/approve'],
    ['POST', '/admin/services/applications/{application_id}/reject'],
    ['POST', '/admin/services/applications/{application_id}/suspend'],
    ['GET', '/admin/services/policies'],
    ['POST', '/admin/services/policies/provider-terms/draft'],
    // Incremento 5: las condiciones de CONTRATACIÓN, con la misma pantalla.
    ['POST', '/admin/services/policies/booking-terms/draft'],
    ['PATCH', '/admin/services/policies/{policy_id}'],
    ['GET', '/admin/services/policies/{policy_id}/preview'],
    ['POST', '/admin/services/policies/{policy_id}/publish'],
  ];

  it('el servidor tiene las 36 rutas que usa el teléfono, y ninguna más', () => {
    const usadas = new Set(USADAS.map(([m, r]) => `${m} ${r}`));
    const faltan = [...usadas].filter((r) => !rutasDelServidor.has(r));
    assert.deepEqual(faltan, [], `el teléfono llama a rutas que no existen: ${faltan.join(', ')}`);
    const sinUsar = [...rutasDelServidor].filter((r) => !usadas.has(r));
    assert.deepEqual(sinUsar, [], `rutas del servidor sin vista: ${sinUsar.join(', ')}`);
  });

  it('cada tramo de ruta aparece en su repositorio', () => {
    for (const tramo of ['/terms', '/documents', '/replace', '/view', '/credentials', '/submit', '/resubmit', '/withdraw', '/history']) {
      assert.ok(prestador.includes(tramo), `prestador: ${tramo}`);
    }
    for (const tramo of ['/accept', '/observe', '/verify', '/reject', 'start-review', 'request-changes', 'approve', 'suspend', '/policies', '/preview', '/publish', "'provider-terms'", "'booking-terms'", '/draft']) {
      assert.ok(admin.includes(tramo), `administración: ${tramo}`);
    }
  });

  it('los saltos y las altas llevan Idempotency-Key; ninguno manda `status`', () => {
    for (const metodo of ['registrarCredencial', 'enviar', 'reenviar', 'retirar']) {
      const cuerpo = prestador.slice(prestador.indexOf(`async ${metodo}(`));
      assert.match(cuerpo.slice(0, cuerpo.indexOf('\n  },')), /clave/, metodo);
    }
    assert.match(prestador, /headers: \{ 'Idempotency-Key': clave \}/);
    assert.match(admin, /headers: \{ 'Idempotency-Key': clave \}/);
    assert.ok(!/status['"]?\s*:/.test(prestador), 'el prestador nunca manda un estado');
    assert.ok(!/['"]status['"]/.test(admin), 'administración decide por rutas, no con un campo `status`');
  });

  it('la subida es multipart al servidor, con espera larga, y sin cabecera de tipo a mano', () => {
    assert.match(prestador, /new FormData\(\)/);
    assert.match(prestador, /formulario\.append\('file', opciones\.archivo, opciones\.nombre\)/);
    assert.match(prestador, /timeoutMs: ESPERA_DE_SUBIDA_MS/);
    assert.ok(!/Content-Type/.test(prestador));
  });
});

// =========================================================================== //
describe('los avisos de Servicios', () => {
  const avisos = readFileSync(join(API, 'services', 'avisos.py'), 'utf8');
  const bloque = avisos.slice(avisos.indexOf('TIPOS = frozenset'), avisos.indexOf('MAXIMO_DEL_EQUIPO'));
  const constantes = new Map(
    [...avisos.matchAll(/^([A-Z_]+) = "(service_[a-z_]+)"$/gm)].map((m) => [m[1] as string, m[2] as string]),
  );
  const tipos = [...bloque.matchAll(/([A-Z_]{4,}),/g)].map((m) => constantes.get(m[1] as string) as string);

  it('los 12 tipos del servidor tienen título, texto y destino', () => {
    assert.equal(tipos.length, 12);
    for (const tipo of tipos) {
      const aviso = avisoAlCreador(tipo);
      assert.ok(aviso, `sin aviso: ${tipo}`);
      for (const clave of [aviso.titulo, aviso.cuerpo ?? '']) {
        assert.ok(clave in es && clave in en && clave in pt, `${tipo}: falta ${clave}`);
      }
      assert.ok(rutaDelAviso(tipo, 'a1'), `${tipo} sin destino`);
    }
  });

  it('quien postula va a su postulación; el equipo, al expediente', () => {
    assert.equal(rutaDelAviso('service_application_changes_requested', 'a1'), '/servicios/prestador');
    assert.equal(rutaDelAviso('service_application_submitted', 'a1'), '/admin/servicios/a1');
    assert.equal(rutaDelAviso('service_application_withdrawn_review', null), '/admin/servicios');
  });

  it('los textos del push existen en los tres idiomas en el servidor', () => {
    const textos = readFileSync(join(API, 'notifications', 'textos.py'), 'utf8');
    for (const tipo of tipos) assert.ok(textos.includes(`"${tipo}"`), tipo);
  });
});

describe('las traducciones de Servicios', () => {
  it('cada clave `servicios.*` está en los tres idiomas y con los mismos huecos', () => {
    const claves = Object.keys(es).filter((c) => c.startsWith('servicios.') || c.startsWith('notif.servicio'));
    assert.ok(claves.length >= 300, `solo ${claves.length}`);
    const huecos = (t: string) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    for (const clave of claves) {
      const base = (es as Record<string, string>)[clave] as string;
      for (const [idioma, dic] of [['en', en], ['pt', pt]] as const) {
        const texto = (dic as Record<string, string | undefined>)[clave];
        assert.ok(texto, `${idioma}: falta ${clave}`);
        assert.equal(huecos(texto), huecos(base), `${idioma}: huecos distintos en ${clave}`);
      }
    }
  });
});
