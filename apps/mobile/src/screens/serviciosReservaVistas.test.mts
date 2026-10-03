/**
 * Z Servicios, Incremento 5: las vistas de la reserva, leídas en su código
 * (aquí no hay renderizador).
 *
 * Que cada vista tiene ruta y se alcanza desde otra (horarios → tus datos →
 * resumen ⇄ condiciones → reserva; Servicios → mis reservas → detalle;
 * prestador → reservas de mis servicios → detalle; administración →
 * supervisión y condiciones de contratación; avisos → su reserva), que cada
 * una tiene carga, error con reintento y bloqueo del doble toque, que la
 * cuenta atrás es la del servidor, que antes de confirmar se vuelve a
 * preguntar al servidor, que un 409 devuelve a elegir, que nada se cobra,
 * que la dirección y la nota no viajan en la ruta, que el prestador no ve
 * ni correo ni teléfono, que administración no ve nada privado y que ningún
 * texto está en duro.
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
const API = join(SRC, '..', '..', 'api', 'app', 'modules');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
const pantalla = (nombre: string) => sinComentarios(fuente(`screens/${nombre}.tsx`));
const componente = (nombre: string) => sinComentarios(fuente(`components/${nombre}.tsx`));

/** Ruta de expo-router → pantalla que monta. */
const VISTAS: Record<string, string> = {
  '/servicios/contratar/[holdId]': 'DatosDeLaContratacionScreen',
  '/servicios/contratar/[holdId]/resumen': 'ResumenDeLaContratacionScreen',
  '/servicios/contratar/[holdId]/condiciones': 'CondicionesDeLaContratacionScreen',
  '/servicios/reservas': 'MisReservasScreen',
  '/servicios/reservas/[bookingId]': 'ReservaScreen',
  '/servicios/prestador/reservas': 'ReservasDelPrestadorScreen',
  '/servicios/prestador/reservas/[bookingId]': 'ReservaDelPrestadorScreen',
  '/admin/servicios/reservas': 'AdminReservasDeServiciosScreen',
};
const PANTALLAS = [...new Set(Object.values(VISTAS))];
const DE_LA_CONTRATACION = ['DatosDeLaContratacionScreen', 'ResumenDeLaContratacionScreen', 'CondicionesDeLaContratacionScreen'];
const COMPONENTES = ['CuentaAtrasDeRetencion', 'ListaDeReservas', 'DetalleDeReserva'];
const TODO = [
  ...PANTALLAS.map(pantalla),
  pantalla('HorariosDelServicioScreen'),
  ...COMPONENTES.map(componente),
].join('\n');
const REPO = sinComentarios(fuente('repositories/ServiceBookingRepository.ts'));

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

  it('las condiciones de contratación usan la pantalla de condiciones, con su tipo', () => {
    const fichero = ficheroDeLaRuta('/admin/servicios/condiciones-de-contratacion') as string;
    assert.ok(fichero);
    const codigo = readFileSync(fichero, 'utf8');
    assert.match(codigo, /from '@\/screens\/AdminServiciosCondicionesScreen'/);
    assert.match(codigo, /<AdminServiciosCondicionesScreen tipo="booking_terms" \/>/);
    const admin = pantalla('AdminServiciosCondicionesScreen');
    assert.match(admin, /ServiceAdmissionRepository\.condiciones\(null, tipo\)/);
    assert.match(admin, /ServiceAdmissionRepository\.crearBorrador\(peticion, tipo\)/);
    // Sin parámetros: el servidor rechaza cualquiera en las de contratación.
    assert.match(admin, /deContratacion \? \{ \.\.\.leida, parameters: \{\} \} : leida/);
    // Ni repostulación, ni documentos, ni credenciales.
    assert.match(admin, /\{deContratacion \? null : \(/);
    const repo = sinComentarios(fuente('repositories/ServiceAdmissionRepository.ts'));
    assert.match(repo, /tipo === 'booking_terms' \? 'booking-terms' : 'provider-terms'/);
    assert.match(repo, /new URLSearchParams\(\{ kind: tipo \}\)/);
  });

  it('el flujo: horarios → tus datos → resumen ⇄ condiciones → reserva confirmada', () => {
    const horarios = pantalla('HorariosDelServicioScreen');
    assert.match(horarios, /router\.push\(rutaDeLaContratacion\(retencion\.id\) as never\)/);
    assert.match(pantalla('DatosDeLaContratacionScreen'), /router\.push\(rutaDeLaContratacion\(retencion, 'resumen'\) as never\)/);
    const resumen = pantalla('ResumenDeLaContratacionScreen');
    assert.match(resumen, /router\.push\(rutaDeLaContratacion\(retencion, 'condiciones'\) as never\)/);
    assert.match(resumen, /router\.replace\(`\$\{rutaDeLaReserva\(reserva\.id\)\}\?confirmada=1` as never\)/);
    assert.match(pantalla('ReservaScreen'), /confirmada === '1'/);
  });

  it('«Mis reservas», «Reservas de mis servicios» y la supervisión tienen su entrada', () => {
    assert.match(pantalla('ServiciosScreen'), /router\.push\('\/servicios\/reservas' as never\)/);
    assert.match(pantalla('MisReservasScreen'), /router\.push\(rutaDeLaReserva\(b\.id\) as never\)/);
    const prestador = pantalla('ServiciosPrestadorScreen');
    // Para un prestador ADMITIDO, activo o SUSPENDIDO: nada cancela sus
    // reservas por venir al suspenderlo y el servidor se las sigue sirviendo
    // (hallazgo de la revisión del 30/09: suspendido, solo llegaba por un aviso).
    assert.match(
      prestador,
      /solicitud\.provider\.status !== 'pending' \? \(\s*<ListRow\s*title=\{f\('servicios\.reserva\.delPrestador'\)\}[\s\S]*?router\.push\('\/servicios\/prestador\/reservas' as never\)/,
    );
    // Y el estado del prestador es uno de estos tres: si apareciera otro, esa
    // condición hay que volver a pensarla.
    assert.match(
      fuente('lib/serviciosAdmision.ts'),
      /status: 'pending' \| 'active' \| 'suspended';/,
    );
    assert.match(pantalla('ReservasDelPrestadorScreen'), /router\.push\(rutaDeLaReservaDelPrestador\(b\.id\) as never\)/);
    const admin = pantalla('AdminServiciosScreen');
    assert.match(admin, /router\.push\('\/admin\/servicios\/reservas' as never\)/);
    assert.match(admin, /router\.push\('\/admin\/servicios\/condiciones-de-contratacion' as never\)/);
  });

  it('«Atrás» respeta la pila y cae en la pantalla de la que se vino', () => {
    const esperadas: Record<string, RegExp> = {
      DatosDeLaContratacionScreen: /router\.canGoBack\(\) \? router\.back\(\) : router\.replace\('\/servicios' as never\)/,
      ResumenDeLaContratacionScreen: /router\.canGoBack\(\) \? router\.back\(\) : router\.replace\(rutaDeLaContratacion\(retencion\) as never\)/,
      CondicionesDeLaContratacionScreen: /router\.canGoBack\(\) \? router\.back\(\) : router\.replace\(rutaDeLaContratacion\(retencion, 'resumen'\) as never\)/,
      MisReservasScreen: /router\.canGoBack\(\) \? router\.back\(\) : router\.replace\('\/servicios' as never\)/,
      ReservaScreen: /router\.canGoBack\(\) \? router\.back\(\) : router\.replace\('\/servicios\/reservas' as never\)/,
      ReservasDelPrestadorScreen: /router\.canGoBack\(\) \? router\.back\(\) : router\.replace\('\/servicios\/prestador' as never\)/,
      ReservaDelPrestadorScreen: /router\.canGoBack\(\) \? router\.back\(\) : router\.replace\('\/servicios\/prestador\/reservas' as never\)/,
      AdminReservasDeServiciosScreen: /router\.canGoBack\(\) \? router\.back\(\) : router\.replace\('\/admin\/servicios' as never\)/,
    };
    for (const [nombre, patron] of Object.entries(esperadas)) assert.match(pantalla(nombre), patron, nombre);
  });

  it('los avisos llevan a la reserva: quien contrata a la suya; el prestador, a su bandeja', async () => {
    const avisos = sinComentarios(fuente('lib/avisosAlCreador.ts'));
    assert.match(avisos, /case 'service_booking_confirmed':\s*return id \? `\/servicios\/reservas\/\$\{id\}` : '\/servicios\/reservas';/);
    assert.match(avisos, /case 'service_booking_received':\s*return id \? `\/servicios\/prestador\/reservas\/\$\{id\}` : '\/servicios\/prestador\/reservas';/);
    for (const clave of [
      'notif.servicioReservaConfirmadaTitle', 'notif.servicioReservaConfirmadaBody',
      'notif.servicioReservaRecibidaTitle', 'notif.servicioReservaRecibidaBody',
    ]) {
      for (const dic of [es, en, pt]) assert.ok(clave in dic, clave);
    }
    // Y el servidor manda esos dos tipos, con el id de la RESERVA y su texto en los tres idiomas.
    const servidor = readFileSync(join(API, 'services', 'avisos.py'), 'utf8');
    assert.match(servidor, /RESERVA_CONFIRMADA = "service_booking_confirmed"/);
    assert.match(servidor, /RESERVA_RECIBIDA = "service_booking_received"/);
    const textos = readFileSync(join(API, 'notifications', 'textos.py'), 'utf8');
    assert.ok(textos.includes('"service_booking_confirmed"') && textos.includes('"service_booking_received"'));
    const dominio = readFileSync(join(API, 'services', 'reserva.py'), 'utf8');
    assert.equal((dominio.match(/solicitud_id=reserva\.id,/g) ?? []).length, 2);
  });
});

// =========================================================================== //
describe('cada vista se comporta', () => {
  for (const nombre of PANTALLAS) {
    it(`${nombre}: carga, error con reintento y sus textos`, () => {
      const codigo = pantalla(nombre);
      const lista = /<ListaDeReservas/.test(codigo);
      if (lista) {
        // La carga y el error los pinta la lista.
        assert.match(codigo, /alReintentar=\{\(\) => void lista\.cargar\(\)\}/);
      } else {
        assert.match(codigo, /<StateView state="loading" \/>/);
        assert.match(codigo, /<EstadoDeServicios fallo=\{fallo\} onRetry=\{\(\) => void cargar\(\)\} \/>/);
      }
      assert.match(codigo, /useTextosDeServicios\('reserva'\)/);
    });
  }

  it('la lista: carga, vacío con su texto, error con reintento y «ver más» sin repetir', () => {
    const lista = componente('ListaDeReservas');
    assert.match(lista, /<StateView state="loading" \/>/);
    assert.match(lista, /<EstadoDeServicios fallo=\{fallo\} onRetry=\{alReintentar\} \/>/);
    assert.match(lista, /<StateView state="empty" icon="calendar" title=\{vacia\.titulo\} description=\{vacia\.cuerpo\} \/>/);
    const hook = sinComentarios(fuente('hooks/useReservaDeServicios.ts'));
    assert.match(hook, /\.filter\(\(b\) => !\(ya \?\? \[\]\)\.some\(\(x\) => x\.id === b\.id\)\)/);
    // Solo vale la última respuesta (cambiar de pestaña no mezcla páginas).
    assert.match(hook, /const esta = \+\+vigente\.current;/);
    assert.equal((hook.match(/if \(esta !== vigente\.current\) return;/g) ?? []).length, 2);
  });

  it('sin sesión, sin permiso o con la reserva apagada se dice, no se inventa', () => {
    // `EstadoDeServicios` traduce el 401/403/503 de cada fallo; la vista no los decide.
    for (const nombre of PANTALLAS) {
      assert.ok(!/status === 40[13]|status === 503/.test(pantalla(nombre)), nombre);
    }
    assert.match(sinComentarios(fuente('hooks/useServicios.ts')), /ambito === 'reserva' \? claveDeErrorDeLaReserva\(error\.code\)/);
  });

  it('el doble toque no manda dos veces: cerrojo y botón apagado', () => {
    for (const nombre of ['DatosDeLaContratacionScreen', 'ResumenDeLaContratacionScreen', 'AdminReservasDeServiciosScreen']) {
      const codigo = pantalla(nombre);
      assert.match(codigo, /useCerrojo\([a-z]+, 'reserva'\)/, nombre);
      assert.match(codigo, /disabled=\{ocupado/, nombre);
    }
    const horarios = pantalla('HorariosDelServicioScreen');
    assert.match(horarios, /useCerrojo\(undefined, 'reserva'\)/);
    assert.match(horarios, /loading=\{ocupado\}\s*disabled=\{ocupado\}\s*onPress=\{continuar\}/);
  });

  it('cada alta y cada salto lleva su Idempotency-Key; ninguno manda un estado', () => {
    assert.match(REPO, /headers: \{ 'Idempotency-Key': clave \}/);
    for (const metodo of ['retener', 'soltar', 'confirmar']) {
      const cuerpo = REPO.slice(REPO.indexOf(`async ${metodo}(`));
      assert.match(cuerpo.slice(0, cuerpo.indexOf('\n  },')), /post\([\s\S]*?, clave\)/, metodo);
    }
    // (`status` solo aparece como FILTRO de la lista de administración, en la consulta.)
    assert.deepEqual([...REPO.matchAll(/['"]?status['"]?\s*:/g)].length, 1);
    assert.match(REPO, /consulta\(\{ status: estado, cursor \}\)/);
    for (const m of REPO.matchAll(/post\(([\s\S]*?), clave\)/g)) {
      assert.ok(!/status|price|amount|total|payment/.test(m[1] as string), `el teléfono nunca manda un estado: ${m[1]}`);
    }
    // APARTAR: una clave por horario elegido, y otra tras el éxito.
    const horarios = pantalla('HorariosDelServicioScreen');
    assert.match(horarios, /ServiceBookingRepository\.retener\(id, elegido\.inicio, elegido\.modalidad, clave\.current\);\s*clave\.current = nuevaClave\(\);/);
    assert.match(horarios, /useEffect\(\(\) => \{\s*clave\.current = nuevaClave\(\);\s*\}, \[elegido\?\.inicio\]\);/);
    // CONFIRMAR: una clave por PETICIÓN (repetir lo mismo usa la misma).
    const resumen = pantalla('ResumenDeLaContratacionScreen');
    assert.match(resumen, /if \(clave\.current === null \|\| clave\.current\.firma !== firma\) clave\.current = \{ firma, valor: nuevaClave\(\) \};/);
    assert.match(resumen, /ServiceBookingRepository\.confirmar\(retencion, peticion, claveDe\(peticion\)\)/);
  });

  it('el repositorio habla con las 12 rutas de la reserva, ni una más', () => {
    const router = readFileSync(join(API, 'services', 'reserva_router.py'), 'utf8');
    const delServidor = new Set<string>();
    for (const m of router.matchAll(/@(router|admin_router)\.(get|post)\(\s*"([^"]+)"/g)) {
      delServidor.add(`${(m[2] as string).toUpperCase()} ${m[1] === 'router' ? '/services' : '/admin/services'}${m[3]}`);
    }
    const usadas = new Set([
      'POST /services/catalog/{service_id}/holds',
      'GET /services/holds/{hold_id}',
      'POST /services/holds/{hold_id}/release',
      'GET /services/holds/{hold_id}/checkout',
      'POST /services/holds/{hold_id}/confirm',
      'GET /services/me/bookings',
      'GET /services/me/bookings/{booking_id}',
      'GET /services/provider/bookings',
      'GET /services/provider/bookings/{booking_id}',
      'GET /admin/services/holds',
      'GET /admin/services/bookings',
      'POST /admin/services/holds/expire',
    ]);
    assert.deepEqual([...delServidor].sort(), [...usadas].sort());
    for (const tramo of ['/catalog/', '/holds', '/release', '/checkout', '/confirm', '/me/bookings', '/provider/bookings', '/holds/expire', '/bookings']) {
      assert.ok(REPO.includes(tramo), tramo);
    }
  });

  it('nadie escribe en la base ni en el almacenamiento desde el teléfono', () => {
    for (const codigo of [TODO, REPO, sinComentarios(fuente('lib/serviciosReserva.ts'))]) {
      assert.ok(!/supabase|\.from\(|\.rpc\(|storage_path|fetch\(|AsyncStorage|SecureStore|localStorage/.test(codigo));
    }
    assert.match(REPO, /apiRequest</);
  });
});

// =========================================================================== //
describe('lo apartado vence, y lo decide el servidor', () => {
  it('la cuenta atrás parte de los segundos del servidor, no de `expires_at`', () => {
    for (const nombre of ['DatosDeLaContratacionScreen', 'ResumenDeLaContratacionScreen']) {
      const codigo = pantalla(nombre);
      assert.match(codigo, /const segundos = useCuentaAtras\(resumen, recibidaEn\);/, nombre);
      assert.match(codigo, /<CuentaAtrasDeRetencion\s*segundos=\{segundos\}/, nombre);
      assert.ok(!/expires_at|new Date\(|Date\.now\(\)/.test(codigo), nombre);
    }
    const hook = sinComentarios(fuente('hooks/useReservaDeServicios.ts'));
    assert.match(hook, /segundosRestantes\(resumen\.hold, recibidaEn, Date\.now\(\)\)/);
    assert.match(hook, /setRecibidaEn\(Date\.now\(\)\);/);
    assert.ok(!/expires_at/.test(hook));
  });

  it('vencida o soltada: se dice y se vuelve a elegir; ya reservada: a la reserva', () => {
    for (const nombre of ['DatosDeLaContratacionScreen', 'ResumenDeLaContratacionScreen']) {
      const codigo = pantalla(nombre);
      assert.match(codigo, /if \(h\.status === 'consumed' && h\.booking_id\) \{/, nombre);
      assert.match(codigo, /if \(h\.status !== 'active' \|\| segundos <= 0\) \{/, nombre);
      assert.match(codigo, /h\.status === 'released' \? 'servicios\.reserva\.bloqueo\.hold_released' : 'servicios\.reserva\.vencio'/, nombre);
    }
  });

  it('la cuenta atrás se anuncia al vencer, no cada segundo', () => {
    const cuenta = componente('CuentaAtrasDeRetencion');
    assert.match(cuenta, /accessibilityLiveRegion=\{vencida \? 'assertive' : 'none'\}/);
    assert.match(cuenta, /accessibilityRole="timer"/);
    // Lo que se lee es «apartado», nunca «reservado».
    assert.match(cuenta, /servicios\.reserva\.apartadoDurante/);
    assert.match(cuenta, /servicios\.reserva\.apartadoNoReservado/);
  });

  it('ANTES DE CONFIRMAR se vuelve a preguntar al servidor', () => {
    const resumen = pantalla('ResumenDeLaContratacionScreen');
    const confirmar = resumen.slice(resumen.indexOf('const confirmar = () =>'), resumen.indexOf('const soltar = () =>'));
    const fresco = confirmar.indexOf('const fresco = await cargar();');
    const llamada = confirmar.indexOf('ServiceBookingRepository.confirmar(');
    assert.ok(fresco > 0 && llamada > fresco, 'se lee el resumen antes de mandar');
    // Si cambiaron las condiciones (las de Z o las del servicio: versión o
    // huella) o ya no se puede, no se manda nada.
    assert.match(confirmar, /\(\['z', 'servicio'\] as const\)\.some\(\s*\(que\) => huellaDeLoAceptable\(fresco, que\) !== huellaDeLoAceptable\(r, que\),?\s*\)/);
    assert.match(confirmar, /if \(cambiaron \|\| !fresco\.contract\.confirmable\) \{[\s\S]*?return;/);
    // Y lo que se manda se arma con lo NUEVO.
    assert.match(confirmar, /peticionDeConfirmacion\(fresco, formulario\)/);
  });

  it('la casilla «Acepto» es de la versión QUE SE VE, no un «sí» que sobrevive a otra', () => {
    // Hallazgo de la revisión del 30/09: marcada con la v1, confirmaba la v2.
    const resumen = pantalla('ResumenDeLaContratacionScreen');
    assert.match(resumen, /const aceptaZ = estaAceptado\(r, formulario, 'z'\);/);
    assert.match(resumen, /const aceptaServicio = r\.service_conditions === null \|\| estaAceptado\(r, formulario, 'servicio'\);/);
    assert.match(resumen, /selected=\{aceptaZ\}/);
    assert.match(resumen, /selected=\{aceptaServicio\}/);
    assert.match(resumen, /disabled=\{ocupado \|\| !aceptaZ \|\| !aceptaServicio\}/);
    assert.match(resumen, /alternarAceptacion\(r, formulario, que\)/);
    // Nadie lee la casilla como booleano suelto.
    assert.ok(!/formulario\.acepta\b|formulario\.aceptaServicio\b/.test(resumen));
    assert.ok(!/acepta: (true|false)/.test(resumen));
  });

  it('tras un 409 que invalida el horario se vuelve a elegir, sin reintentar a ciegas', () => {
    const horarios = pantalla('HorariosDelServicioScreen');
    assert.match(horarios, /if \(error instanceof ApiError && hayQueVolverAElegir\(error\.code\)\) \{\s*router\.setParams\(\{ fecha: undefined, inicio: undefined, hora: undefined, modalidad: undefined \} as never\);\s*setVuelta\(\(v\) => v \+ 1\);/);
    // Ya apartado por la misma persona: se sigue con ESE (el servidor dice cuál).
    assert.match(horarios, /error\.code === 'service_hold_already_active' && detalles\?\.hold_id/);
    const resumen = pantalla('ResumenDeLaContratacionScreen');
    assert.match(resumen, /if \(error instanceof ApiError && hayQueVolverAElegir\(error\.code\)\) \{\s*await cargar\(\);\s*\}\s*throw error;/);
  });

  it('soltar libera en el servidor y olvida lo escrito', () => {
    assert.match(pantalla('DatosDeLaContratacionScreen'), /await ServiceBookingRepository\.soltar\(retencion, nuevaClave\(\)\);\s*olvidarBorrador\(retencion\);/);
    assert.match(pantalla('ResumenDeLaContratacionScreen'), /await ServiceBookingRepository\.soltar\(retencion, nuevaClave\(\)\);\s*elegirOtro\(\);/);
    assert.match(pantalla('ResumenDeLaContratacionScreen'), /const elegirOtro = \(\) => \{\s*olvidarBorrador\(retencion\);/);
    // Confirmar también lo olvida.
    assert.match(pantalla('ResumenDeLaContratacionScreen'), /olvidarBorrador\(retencion\);\s*router\.replace\(`\$\{rutaDeLaReserva/);
  });
});

// =========================================================================== //
describe('el dinero: nada se cobra, y nada se finge', () => {
  it('ninguna vista paga, ni habla con una pasarela', () => {
    assert.ok(!/stripe|paypal|mercadopago|culqi|niubiz|izipay|payment_intent|client_secret|pagar\(/i.test(TODO + REPO));
  });

  it('con precio, la contratación se detiene y lo dice; confirmar solo si el servidor deja', () => {
    const resumen = pantalla('ResumenDeLaContratacionScreen');
    assert.match(resumen, /const esDePago = r\.contract\.kind === 'paid';/);
    assert.match(resumen, /\{esDePago \? \(\s*<StateView[\s\S]*?title=\{f\('servicios\.reserva\.sinPagos'\)\}/);
    assert.match(resumen, /\{r\.contract\.confirmable \? \(\s*<Button\s*label=\{f\('servicios\.reserva\.confirmar'\)\}/);
    // Lo que impide confirmar se enseña en palabras (nunca el código).
    assert.match(resumen, /r\.contract\.blockers\.map\(claveDelBloqueo\)\.filter\(\(c\): c is string => c !== null\)/);
  });

  it('«a consultar» y «desde» no se apartan: el botón solo existe con `booking_available`', () => {
    const horarios = pantalla('HorariosDelServicioScreen');
    assert.match(horarios, /setSePuedeContinuar\(calendario\.booking_available === true\)/);
    assert.match(horarios, /\{sePuedeContinuar \? \(\s*<Button/);
    const catalogo = sinComentarios(fuente('lib/serviciosCatalogo.ts'));
    // Sin precio no es gratis (lo prueba el catálogo); aquí se usa esa misma frase.
    assert.match(catalogo, /if \(modelo === null\) return \{ clave: 'servicios\.catalogo\.precio\.sinDefinir' \};/);
    for (const nombre of ['ResumenDeLaContratacionScreen']) assert.match(pantalla(nombre), /precioLegible\(r\.service\.price\)/);
    assert.match(componente('DetalleDeReserva'), /precioLegible\(\{ model: r\.price\.model, amount_minor: r\.price\.amount_minor, currency: r\.price\.currency \}\)/);
  });

  it('«no se cobró nada» solo si el servidor dice que no hacía falta', () => {
    assert.match(componente('DetalleDeReserva'), /r\.price\.payment_status === 'not_required' \? \(/);
  });
});

// =========================================================================== //
describe('privacidad: solo lo necesario, y nunca en la ruta', () => {
  it('la dirección solo se pide a domicilio, y se dice que no es pública', () => {
    const datos = pantalla('DatosDeLaContratacionScreen');
    assert.match(datos, /\{resumen\.requires_address \? \(\s*<>\s*<Text weight="700">\{f\('servicios\.reserva\.direccionTitulo'\)\}/);
    assert.match(datos, /servicios\.reserva\.direccionPrivada/);
    // Los límites los manda el servidor.
    for (const campo of ['note', 'district', 'address', 'reference']) {
      assert.match(datos, new RegExp(`maxLength=\\{l\\.${campo}_max_length\\}`), campo);
    }
  });

  it('ni la nota ni la dirección viajan en la ruta', () => {
    for (const codigo of [...DE_LA_CONTRATACION.map(pantalla), pantalla('HorariosDelServicioScreen')]) {
      for (const m of codigo.matchAll(/router\.(push|replace|setParams)\(([^;]*?)\)( as never)?\)?;?\n/g)) {
        assert.ok(!/nota|direccion|distrito|referencia|note|address|district/.test(m[2] as string), m[0]);
      }
      assert.ok(!/useLocalSearchParams<\{[^}]*(nota|direccion|note|address)/.test(codigo));
    }
    // Pasan de un paso a otro en MEMORIA.
    assert.match(pantalla('DatosDeLaContratacionScreen'), /guardarBorrador\(retencion, \{ \.\.\.borradorDe\(retencion\), nota, distrito, direccion, referencia \}\)/);
    assert.match(pantalla('ResumenDeLaContratacionScreen'), /setFormulario\(borradorDe\(retencion\)\);/);
  });

  it('el prestador ve la identidad PÚBLICA de quien contrata: ni correo ni teléfono', () => {
    const detalle = pantalla('ReservaDelPrestadorScreen');
    assert.match(detalle, /reserva\.client\.name, reserva\.client\.username \? `@\$\{reserva\.client\.username\}` : null/);
    assert.ok(!/email|phone|telefono|correo/i.test(detalle + componente('DetalleDeReserva')));
    const tipos = sinComentarios(fuente('lib/serviciosReserva.ts'));
    assert.match(tipos, /client: \{ username: string \| null; name: string \| null \} \| null;/);
    // Y el servidor no manda más que eso.
    const esquemas = readFileSync(join(API, 'services', 'reserva_schemas.py'), 'utf8');
    const cliente = esquemas.slice(esquemas.indexOf('class ClienteRead'), esquemas.indexOf('class ReservaDelPrestadorRead'));
    assert.deepEqual([...cliente.matchAll(/^    ([a-z_]+): /gm)].map((m) => m[1]), ['username', 'name']);
  });

  it('administración ve lo OPERATIVO: ni personas, ni notas, ni direcciones', () => {
    const admin = pantalla('AdminReservasDeServiciosScreen');
    assert.ok(!/client_id|provider_id|intake|note|address|district|username|\.name\b/.test(admin));
    // El barrido pide confirmación.
    assert.match(admin, /const si = await confirm\(\{[\s\S]*?servicios\.reserva\.admin\.barrerTitulo/);
  });
});

// =========================================================================== //
describe('accesibilidad y textos', () => {
  it('lo que se acepta son casillas; las pestañas, opciones', () => {
    const resumen = pantalla('ResumenDeLaContratacionScreen');
    assert.equal((resumen.match(/rol="checkbox"/g) ?? []).length, 2);
    assert.match(componente('ListaDeReservas'), /accessibilityRole="tablist"/);
    assert.ok((pantalla('AdminReservasDeServiciosScreen').match(/rol="radio"/g) ?? []).length >= 3);
  });

  it('ningún texto en duro', () => {
    const todas = [...PANTALLAS, 'HorariosDelServicioScreen'].map((p) => [p, pantalla(p)] as const);
    for (const [nombre, codigo] of [...todas, ...COMPONENTES.map((c) => [c, componente(c)] as const)]) {
      for (const atributo of ['label="', 'title="', 'description="', 'placeholder="', 'actionLabel="', 'accessibilityLabel="']) {
        assert.ok(!codigo.includes(atributo), `${nombre} escribe ${atributo}…" en duro`);
      }
      for (const m of codigo.matchAll(/<Text[^>]*>([^<{]+)<\/Text>/g)) {
        assert.equal((m[1] as string).trim(), '', `${nombre}: texto en duro «${m[1]}»`);
      }
    }
  });

  it('cada clave escrita en las vistas existe en es, en y pt', () => {
    const claves = new Set([...TODO.matchAll(/'((?:servicios|notif)\.[A-Za-z0-9_.]+)'/g)].map((m) => m[1] as string));
    assert.ok(claves.size > 70, `solo ${claves.size} claves`);
    for (const clave of claves) {
      for (const [idioma, dic] of Object.entries({ es, en, pt })) {
        assert.ok(clave in dic, `falta «${clave}» en ${idioma}`);
      }
    }
  });

  it('ningún código interno llega a la pantalla', () => {
    for (const bruto of [...PANTALLAS.map(pantalla), ...COMPONENTES.map(componente)]) {
      // Las `key` de React no se ven.
      const codigo = bruto.replace(/key=\{`[^`]*`\}/g, '').replace(/key=\{[^}]*\}/g, '');
      // Ni `error.code`, ni un estado, tipo o suceso impreso tal cual. (`b.code`
      // es el CÓDIGO DE LA RESERVA, el que se da a la persona: ese sí se enseña.)
      assert.ok(!/error\.code\}|\{[a-z]+\.status\}|\{[a-z]+\.kind\}|\{[a-z]+\.action\}/.test(codigo));
    }
  });
});
