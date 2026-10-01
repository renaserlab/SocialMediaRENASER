/**
 * Z Servicios, Incremento 6: las vistas de la atención y la posventa, leídas
 * en su código (aquí no hay renderizador).
 *
 * Que cada vista tiene ruta y se alcanza desde otra (la reserva → cancelar,
 * cambiar de horario, el caso, la reseña; el prestador → lo suyo;
 * administración → casos y reseñas; la ficha → sus reseñas; los avisos → su
 * destino), que cada una tiene carga, error con reintento y bloqueo del doble
 * toque, que LO QUE SE OFRECE ES LO QUE DICE EL SERVIDOR, que cada escritura
 * lleva su clave, que nada mueve ni finge dinero, que las evidencias son
 * privadas, que una reseña no se marca «verificada» a mano y que ningún texto
 * está en duro.
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
const API = join(SRC, '..', '..', 'api', 'app', 'modules', 'services');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
const pantalla = (nombre: string) => sinComentarios(fuente(`screens/${nombre}.tsx`));
const componente = (nombre: string) => sinComentarios(fuente(`components/${nombre}.tsx`));

/** Ruta de expo-router → [pantalla que monta, su papel si lo lleva]. */
const VISTAS: Record<string, [string, string?]> = {
  '/servicios/reservas/[bookingId]': ['ReservaScreen'],
  '/servicios/reservas/[bookingId]/cancelar': ['CancelarReservaScreen', 'client'],
  '/servicios/reservas/[bookingId]/reprogramar': ['ReprogramarReservaScreen'],
  '/servicios/reservas/[bookingId]/caso': ['CasoDeLaReservaScreen', 'client'],
  '/servicios/reservas/[bookingId]/resena': ['ResenaDeLaReservaScreen'],
  '/servicios/prestador/reservas/[bookingId]': ['ReservaDelPrestadorScreen'],
  '/servicios/prestador/reservas/[bookingId]/cancelar': ['CancelarReservaScreen', 'provider'],
  '/servicios/prestador/reservas/[bookingId]/caso': ['CasoDeLaReservaScreen', 'provider'],
  '/admin/servicios/casos': ['AdminCasosDeServiciosScreen'],
  '/admin/servicios/casos/[incidentId]': ['AdminCasoDeServiciosScreen'],
  '/admin/servicios/resenas': ['AdminResenasDeServiciosScreen'],
};
/** Las pantallas NUEVAS de este incremento. */
const NUEVAS = [
  'CancelarReservaScreen', 'ReprogramarReservaScreen', 'CasoDeLaReservaScreen', 'ResenaDeLaReservaScreen',
  'AdminCasosDeServiciosScreen', 'AdminCasoDeServiciosScreen', 'AdminResenasDeServiciosScreen',
];
const COMPONENTES = ['AtencionDeLaReserva', 'ExpedienteDelCaso', 'ListaDeResenasDelServicio'];
const TODO = [...NUEVAS.map(pantalla), ...COMPONENTES.map(componente)].join('\n');
const REPO = sinComentarios(fuente('repositories/ServiceCareRepository.ts'));
const ATENCION = componente('AtencionDeLaReserva');
const ACCIONES = [
  'cancel', 'reschedule', 'issue_code', 'start', 'complete', 'confirm', 'report_absence', 'open_incident',
  'add_incident_entry', 'withdraw_incident', 'appeal_incident', 'review', 'reply_review',
];

function ficheroDeLaRuta(ruta: string): string | null {
  const base = join(APP, ...ruta.split('/').filter(Boolean));
  if (existsSync(`${base}.tsx`)) return `${base}.tsx`;
  if (existsSync(join(base, 'index.tsx'))) return join(base, 'index.tsx');
  return null;
}

// =========================================================================== //
describe('cada vista tiene ruta y se alcanza desde otra', () => {
  for (const [ruta, [nombre, rol]] of Object.entries(VISTAS)) {
    it(`${ruta} monta ${nombre}${rol ? ` como ${rol}` : ''}`, () => {
      const fichero = ficheroDeLaRuta(ruta);
      assert.ok(fichero, `no hay fichero para ${ruta}`);
      const codigo = readFileSync(fichero, 'utf8');
      assert.match(codigo, new RegExp(`from '@/screens/${nombre}'`));
      if (rol) assert.match(codigo, new RegExp(`<${nombre} rol="${rol}" />`));
    });
  }

  it('ninguna ruta está dos veces (un fichero Y una carpeta con el mismo nombre)', () => {
    for (const carpeta of ['servicios/reservas', 'servicios/prestador/reservas']) {
      assert.ok(!existsSync(join(APP, carpeta, '[bookingId].tsx')), `${carpeta}/[bookingId].tsx sobra`);
      assert.ok(existsSync(join(APP, carpeta, '[bookingId]', 'index.tsx')));
    }
    assert.ok(!existsSync(join(APP, 'admin', 'servicios', 'casos.tsx')));
    assert.ok(!existsSync(join(APP, 'admin', 'servicios', 'resenas', 'index.tsx')));
  });

  it('desde la reserva se llega a cancelar, a cambiar el horario, al caso y a la reseña', () => {
    for (const nombre of ['ReservaScreen', 'ReservaDelPrestadorScreen']) {
      assert.match(pantalla(nombre), /<AtencionDeLaReserva\s+rol="(client|provider)"/, nombre);
    }
    assert.match(pantalla('ReservaScreen'), /<AtencionDeLaReserva rol="client" reserva=\{reserva\} alCambiar=\{setReserva\} recargar=\{cargar\} \/>/);
    assert.match(ATENCION, /router\.push\(rutaDeCancelar\(rol, id\) as never\)/);
    assert.match(ATENCION, /router\.push\(rutaDeHorariosParaReprogramar\(reserva\.service_id, id\) as never\)/);
    assert.match(ATENCION, /router\.push\(rutaDelCaso\(rol, id\) as never\)/);
    assert.match(ATENCION, /router\.push\(rutaDeLaResena\(id\) as never\)/);
  });

  it('cambiar el horario: horarios → apartar → confirmar el cambio → la reserva', () => {
    const horarios = pantalla('HorariosDelServicioScreen');
    assert.match(horarios, /const reprogramar = typeof parametros\.reprogramar === 'string' \? parametros\.reprogramar : '';/);
    assert.match(horarios, /if \(reprogramar\) router\.push\(rutaDeReprogramar\(reprogramar, retencion\.id\) as never\);\s*else router\.push\(rutaDeLaContratacion\(retencion\.id\) as never\);/);
    // Ya apartado por la misma persona: se sigue con ESE, también al reprogramar.
    assert.match(horarios, /if \(reprogramar\) router\.push\(rutaDeReprogramar\(reprogramar, detalles\.hold_id\) as never\);/);
    const confirmar = pantalla('ReprogramarReservaScreen');
    assert.match(confirmar, /ServiceCareRepository\.reprogramar\(id, retencion, llaves\.de\('reprogramar', retencion\)\)/);
    assert.match(confirmar, /router\.replace\(rutaDeLaReserva\(id\) as never\);/);
    // La retención viaja como identificador; la cuenta atrás es la del servidor.
    assert.match(confirmar, /const segundos = useCuentaAtras\(resumen, recibidaEn\);/);
    assert.ok(!/expires_at|Date\.now\(\)|new Date\(/.test(confirmar));
  });

  it('administración llega a los casos y a las reseñas; un caso, a su expediente', () => {
    const admin = pantalla('AdminServiciosScreen');
    assert.match(admin, /router\.push\('\/admin\/servicios\/casos' as never\)/);
    assert.match(admin, /router\.push\('\/admin\/servicios\/resenas' as never\)/);
    assert.match(pantalla('AdminCasosDeServiciosScreen'), /router\.push\(rutaDelCasoParaAdministrar\(c\.id\) as never\)/);
  });

  it('la ficha enseña las reseñas publicadas bajo su resumen', () => {
    const ficha = pantalla('FichaDeServicioScreen');
    assert.match(ficha, /<ResenasDelServicio resenas=\{ficha\.reviews\} \/>\s*<ListaDeResenasDelServicio servicio=\{ficha\.id\} \/>/);
  });

  it('«Atrás» respeta la pila y cae en la pantalla de la que se vino', () => {
    const esperadas: Record<string, RegExp> = {
      CancelarReservaScreen: /router\.canGoBack\(\) \? router\.back\(\) : router\.replace\(laReserva as never\)/,
      CasoDeLaReservaScreen: /router\.canGoBack\(\) \? router\.back\(\) : router\.replace\(laReserva as never\)/,
      ReprogramarReservaScreen: /router\.canGoBack\(\) \? router\.back\(\) : router\.replace\(rutaDeLaReserva\(id\) as never\)/,
      ResenaDeLaReservaScreen: /router\.canGoBack\(\) \? router\.back\(\) : router\.replace\(rutaDeLaReserva\(id\) as never\)/,
      AdminCasosDeServiciosScreen: /router\.canGoBack\(\) \? router\.back\(\) : router\.replace\('\/admin\/servicios' as never\)/,
      AdminCasoDeServiciosScreen: /router\.canGoBack\(\) \? router\.back\(\) : router\.replace\('\/admin\/servicios\/casos' as never\)/,
      AdminResenasDeServiciosScreen: /router\.canGoBack\(\) \? router\.back\(\) : router\.replace\('\/admin\/servicios' as never\)/,
    };
    for (const [nombre, patron] of Object.entries(esperadas)) assert.match(pantalla(nombre), patron, nombre);
    for (const nombre of ['CancelarReservaScreen', 'CasoDeLaReservaScreen']) {
      assert.match(pantalla(nombre), /const laReserva = rol === 'client' \? rutaDeLaReserva\(id\) : rutaDeLaReservaDelPrestador\(id\);/);
    }
  });
});

// =========================================================================== //
describe('lo que se ofrece es lo que dice el servidor', () => {
  it('cada acción de la reserva sale solo con `puede(cuidado, …)`', () => {
    for (const accion of ['cancel', 'reschedule', 'issue_code', 'start', 'complete', 'confirm', 'report_absence',
      'open_incident', 'review', 'reply_review']) {
      assert.match(ATENCION, new RegExp(`puede\\(cuidado, '${accion}'\\)`), accion);
    }
    const caso = pantalla('CasoDeLaReservaScreen');
    for (const accion of ['add_incident_entry', 'appeal_incident', 'withdraw_incident']) {
      assert.match(caso, new RegExp(`puedeEnElCaso\\(caso, '${accion}'\\)`), accion);
    }
    assert.match(caso, /puede\(reserva\.care, 'open_incident'\)/);
    // Y son las trece del servidor: ninguna vista inventa otra.
    for (const m of (TODO + pantalla('ReservaScreen')).matchAll(/puede(?:EnElCaso)?\([a-zA-Z.?]+, '([a-z_]+)'\)/g)) {
      assert.ok(ACCIONES.includes(m[1] as string), m[1]);
    }
  });

  it('sin `care` (sin la 0094) la reserva se ve y no se ofrece nada', () => {
    assert.match(ATENCION, /const cuidado = reserva\.care;\s*if \(!cuidado\) return null;/);
  });

  it('ninguna vista decide por la hora del teléfono ni por el estado de la reserva', () => {
    for (const codigo of [ATENCION, ...NUEVAS.map(pantalla)]) {
      assert.ok(!/Date\.now\(\)|new Date\(/.test(codigo));
      // Ni «si empieza en menos de…»: los plazos se ENSEÑAN, no se comparan.
      assert.ok(!/_until\s*[<>]|starts_at\s*[<>]|_at\s*[<>]/.test(codigo));
    }
    // Las pantallas de un solo paso lo vuelven a comprobar al entrar: si ya no se puede, lo dicen.
    assert.match(pantalla('CancelarReservaScreen'), /!puede\(reserva\.care, 'cancel'\) \? \(\s*<StateView/);
    assert.match(pantalla('ReprogramarReservaScreen'), /if \(!puede\(reserva\.care, 'reschedule'\)\) \{/);
    assert.match(pantalla('ResenaDeLaReservaScreen'), /!puede\(reserva\.care, 'review'\) \? \(\s*<StateView/);
  });

  it('administración resuelve solo un caso vivo, y dice que la apelación es de otra persona', () => {
    const caso = pantalla('AdminCasoDeServiciosScreen');
    assert.match(caso, /const vivo = caso !== null && \(caso\.status === 'open' \|\| caso\.status === 'appealed'\);/);
    assert.match(caso, /\{vivo \? \(\s*<View style=\{\[styles\.tarjeta, \{ borderColor: colors\.primary \}\]\}>/);
    assert.match(caso, /servicios\.atencion\.admin\.otraPersona/);
  });
});

// =========================================================================== //
describe('cada vista se comporta', () => {
  for (const nombre of NUEVAS) {
    it(`${nombre}: carga, error con reintento, cerrojo y sus textos`, () => {
      const codigo = pantalla(nombre);
      assert.match(codigo, /<StateView state="loading" \/>/);
      assert.match(codigo, /<EstadoDeServicios fallo=\{fallo\} onRetry=\{\(\) => void cargar\(\)\} \/>/);
      assert.match(codigo, /useTextosDeServicios\('reserva'\)/);
      assert.match(codigo, /const \{ ocupado, correr \} = useCerrojo\(cargar, 'reserva'\);/);
      assert.match(codigo, /disabled=\{ocupado/);
      assert.ok(!/status === 40[13]|status === 503/.test(codigo));
    });
  }

  it('la atención de la reserva: cerrojo, y tras un 409 se vuelve a leer', () => {
    assert.match(ATENCION, /const \{ ocupado, correr \} = useCerrojo\(recargar, 'reserva'\);/);
    assert.ok((ATENCION.match(/disabled=\{ocupado/g) ?? []).length >= 10);
    // El resultado es el que devuelve el servidor, no uno supuesto.
    assert.ok((ATENCION.match(/alCambiar\(await ServiceCareRepository\./g) ?? []).length >= 5);
  });

  it('las listas de administración: vacío con su texto, «ver más» sin repetir y solo la última respuesta', () => {
    for (const nombre of ['AdminCasosDeServiciosScreen', 'AdminResenasDeServiciosScreen']) {
      const codigo = pantalla(nombre);
      assert.match(codigo, /<StateView state="empty" icon="[a-z-]+" title=\{f\('servicios\.atencion\.admin\.sin(Casos|Resenas)'\)\} \/>/);
      assert.match(codigo, /\.filter\(\(x\) => !\(ya \?\? \[\]\)\.some\(\(y\) => y\.id === x\.id\)\)/);
      assert.match(codigo, /const esta = \+\+vigente\.current;/);
      assert.ok((codigo.match(/rol="radio"/g) ?? []).length >= 1);
    }
  });

  it('lo que no se deshace se pregunta antes', () => {
    assert.match(pantalla('CancelarReservaScreen'), /const si = await confirm\(\{[\s\S]*?servicios\.atencion\.cancelar\.preguntaTitulo[\s\S]*?destructive: true/);
    assert.match(pantalla('CasoDeLaReservaScreen'), /servicios\.atencion\.caso\.retirarTitulo[\s\S]*?destructive: true/);
    assert.match(pantalla('CasoDeLaReservaScreen'), /servicios\.atencion\.caso\.apelarTitulo/);
    assert.match(pantalla('AdminCasoDeServiciosScreen'), /const si = await confirm\(\{[\s\S]*?servicios\.atencion\.admin\.resolverTitulo/);
    assert.match(pantalla('AdminCasosDeServiciosScreen'), /const si = await confirm\(\{[\s\S]*?servicios\.atencion\.admin\.tareasTitulo/);
    assert.match(pantalla('AdminResenasDeServiciosScreen'), /const si = await confirm\(\{/);
    for (const cual of ['sinCodigo', 'terminar', 'confirmar', 'responder']) {
      assert.match(ATENCION, new RegExp(`await preguntar\\('${cual}'\\)`), cual);
    }
    assert.match(ATENCION, /await preguntar\(esCliente \? 'ausenciaDelPrestador' : 'ausenciaDelCliente'\)/);
  });
});

// =========================================================================== //
describe('el repositorio', () => {
  it('habla con las rutas de la atención del servidor, ni una más ni una menos', () => {
    const router = readFileSync(join(API, 'atencion_router.py'), 'utf8').replace(/\r\n/g, '\n');
    const delServidor = new Set<string>();
    for (const m of router.matchAll(/@(router|admin_router)\.(get|post)\(\s*"([^"]+)"/g)) {
      delServidor.add(`${(m[2] as string).toUpperCase()} ${m[1] === 'router' ? '/services' : '/admin/services'}${m[3]}`);
    }
    // Las que comparten las dos partes se montan en un bucle, con su prefijo.
    assert.match(router, /PARTES = \(\(CLIENTE, "\/me\/bookings"\), \(PRESTADOR, "\/provider\/bookings"\)\)/);
    for (const m of router.matchAll(/^        \("(\/[^"]+)", [a-z_]+, "(GET|POST)", /gm)) {
      for (const prefijo of ['/me/bookings', '/provider/bookings']) {
        delServidor.add(`${m[2]} /services${prefijo}/{booking_id}${m[1]}`);
      }
    }
    assert.equal(delServidor.size, 34, [...delServidor].sort().join('\n'));
    const usadas = [
      ...['me', 'provider'].flatMap((quien) => [
        `POST /services/${quien}/bookings/{booking_id}/cancel`,
        `POST /services/${quien}/bookings/{booking_id}/no-show`,
        `POST /services/${quien}/bookings/{booking_id}/incident`,
        `GET /services/${quien}/bookings/{booking_id}/incident`,
        `POST /services/${quien}/bookings/{booking_id}/incident/entries`,
        `POST /services/${quien}/bookings/{booking_id}/incident/evidence`,
        `GET /services/${quien}/bookings/{booking_id}/incident/entries/{entry_id}/file`,
        `POST /services/${quien}/bookings/{booking_id}/incident/withdraw`,
        `POST /services/${quien}/bookings/{booking_id}/incident/appeal`,
      ]),
      'POST /services/me/bookings/{booking_id}/reschedule',
      'POST /services/me/bookings/{booking_id}/check-in-code',
      'POST /services/me/bookings/{booking_id}/confirm',
      'POST /services/me/bookings/{booking_id}/review',
      'POST /services/provider/bookings/{booking_id}/start',
      'POST /services/provider/bookings/{booking_id}/complete',
      'POST /services/provider/bookings/{booking_id}/review/reply',
      'GET /services/catalog/{service_id}/reviews',
      'GET /admin/services/incidents',
      'GET /admin/services/incidents/{incident_id}',
      'POST /admin/services/incidents/{incident_id}/entries',
      'GET /admin/services/incidents/{incident_id}/entries/{entry_id}/file',
      'POST /admin/services/incidents/{incident_id}/resolve',
      'GET /admin/services/reviews',
      'POST /admin/services/reviews/{review_id}/moderate',
      'POST /admin/services/tasks/run',
    ];
    assert.deepEqual([...delServidor].sort(), [...usadas].sort());
    for (const tramo of [
      '/cancel', '/no-show', '/incident`', '/incident/entries', '/incident/evidence', '/file', '/incident/withdraw',
      '/incident/appeal', '/reschedule', '/check-in-code', '/confirm', '/review`', '/start', '/complete', '/review/reply',
      '/reviews', '/incidents', '/resolve', '/moderate', '/tasks/run',
    ]) {
      assert.ok(REPO.includes(tramo), tramo);
    }
  });

  it('cada escritura lleva su Idempotency-Key, y ninguna manda un estado ni un importe', () => {
    assert.match(REPO, /headers: \{ 'Idempotency-Key': clave \}/);
    const escrituras = [
      'cancelar', 'reportarAusencia', 'abrirCaso', 'escribirEnElCaso', 'subirEvidencia', 'retirarCaso', 'apelar',
      'reprogramar', 'pedirCodigo', 'confirmar', 'resenar', 'iniciar', 'terminar', 'responderResena', 'anotarEnElCaso',
      'resolver', 'moderarResena',
    ];
    for (const metodo of escrituras) {
      const desde = REPO.indexOf(`async ${metodo}`);
      assert.ok(desde >= 0, metodo);
      const cuerpo = REPO.slice(desde, REPO.indexOf('\n  },', desde));
      assert.match(cuerpo, /clave: string/, metodo);
      assert.match(cuerpo, /post\([\s\S]*?, clave\)|'Idempotency-Key': clave/, metodo);
    }
    // (`status` solo aparece como FILTRO de las bandejas de administración.)
    assert.equal([...REPO.matchAll(/['"]?status['"]?\s*:/g)].length, 2);
    for (const m of REPO.matchAll(/post\((\{[\s\S]*?\}), clave\)/g)) {
      assert.ok(!/status|price|amount|total|payment|refund|verified/.test(m[1] as string), m[1]);
    }
    // Los barridos no llevan cuerpo: no deciden nada.
    assert.match(REPO, /apiRequest<Tareas>\(`\$\{ADMIN\}\/tasks\/run`, \{ method: 'POST' \}\)/);
  });

  it('nadie escribe en la base ni en el almacenamiento desde el teléfono', () => {
    for (const codigo of [TODO, REPO, sinComentarios(fuente('lib/serviciosAtencion.ts'))]) {
      assert.ok(!/supabase|\.from\(|\.rpc\(|storage_path|fetch\(|AsyncStorage|SecureStore|localStorage/.test(codigo));
    }
    assert.match(REPO, /apiRequest</);
  });

  it('las claves: una por petición, y otra tras terminar', () => {
    for (const codigo of [ATENCION, ...NUEVAS.filter((n) => n !== 'AdminCasosDeServiciosScreen').map(pantalla)]) {
      assert.match(codigo, /const llaves = useRef\(llavero\(nuevaClave\)\)\.current;/);
      assert.ok((codigo.match(/llaves\.de\(/g) ?? []).length >= 1);
      assert.equal((codigo.match(/llaves\.de\(/g) ?? []).length, (codigo.match(/llaves\.hecho\(/g) ?? []).length);
    }
  });
});

// =========================================================================== //
describe('el dinero: nada se mueve, y nada se finge', () => {
  it('ninguna vista paga, devuelve ni habla con una pasarela', () => {
    assert.ok(!/stripe|paypal|mercadopago|culqi|niubiz|izipay|payment_intent|client_secret|pagar\(|devolver\(|refund\(/i.test(TODO + REPO));
  });

  it('lo resuelto se dice en líneas separadas: la decisión, la atención y LO ECONÓMICO', () => {
    const expediente = componente('ExpedienteDelCaso');
    assert.match(expediente, /f\(claveDelResultado\(caso\.outcome\)\)/);
    assert.match(expediente, /servicios\.atencion\.caso\.efectoEnLaAtencion/);
    assert.match(expediente, /f\('servicios\.atencion\.dinero\.solicitado', \{\s*efecto: f\(claveDelEfectoEconomico\(caso\.financial_effect\)\),\s*estado: f\(claveDelEstadoDelEfecto\(caso\.financial_effect_status\)\),/);
    assert.match(expediente, /servicios\.atencion\.dinero\.noSeMovio/);
    // Y la bandeja de «efectos solicitados» dice que es de lectura.
    assert.match(pantalla('AdminCasosDeServiciosScreen'), /servicios\.atencion\.admin\.conEfectoIntro/);
    assert.ok(!/ejecutar|reintentar|pagar|transferir/i.test(pantalla('AdminCasosDeServiciosScreen')));
  });

  it('quien resuelve elige lo que se SOLICITA; el estado del efecto no se puede elegir', () => {
    const caso = pantalla('AdminCasoDeServiciosScreen');
    assert.match(caso, /EFECTOS_ECONOMICOS\.map\(/);
    assert.ok(!/ESTADOS_DEL_EFECTO|financial_effect_status|not_applicable|'pending'|'blocked'/.test(caso));
    assert.match(caso, /servicios\.atencion\.admin\.efectoEconomicoAyuda/);
  });

  it('antes de cancelar se enseña la consecuencia, con lo económico que dice el servidor', () => {
    const cancelar = pantalla('CancelarReservaScreen');
    assert.match(cancelar, /servicios\.atencion\.cancelar\.consecuencias/);
    assert.match(cancelar, /claveDelEstadoDelEfecto\(reserva\.care\?\.deadlines\.cancellation_financial_effect\)/);
    assert.match(cancelar, /servicios\.atencion\.cancelar\.seLibera/);
    // El prestador explica por qué: sin motivo, el botón no manda.
    assert.match(cancelar, /disabled=\{ocupado \|\| \(rol === 'provider' && !nota\.trim\(\)\)\}/);
  });
});

// =========================================================================== //
describe('privacidad: evidencias, notas internas y el código de asistencia', () => {
  it('una evidencia se elige, se comprueba y se sube al servidor; se mira con un enlace que caduca', () => {
    const caso = pantalla('CasoDeLaReservaScreen');
    assert.match(caso, /DocumentPicker\.getDocumentAsync\(\{\s*type: \[\.\.\.FORMATOS_DE_EVIDENCIA\],/);
    assert.match(caso, /elegido\.size > PESO_MAXIMO_DE_EVIDENCIA/);
    assert.match(caso, /ServiceCareRepository\.subirEvidencia\(rol, id, \{ archivo, nombre: elegido\.name \}, nuevaClave\(\)\)/);
    for (const codigo of [caso, pantalla('AdminCasoDeServiciosScreen')]) {
      assert.match(codigo, /const enlace = await ServiceCareRepository\.verEvidencia(ParaAdministrar)?\([a-z, .]+\);\s*await Linking\.openURL\(enlace\.url\);/);
      assert.ok(!/setEnlace|useState<EnlaceTemporal|\.url\}/.test(codigo), 'el enlace no se guarda ni se pinta');
    }
    // El expediente no trae rutas de archivo: solo el tipo y el peso.
    const tipos = sinComentarios(fuente('lib/serviciosAtencion.ts'));
    const entrada = tipos.slice(tipos.indexOf('export type Entrada = {'), tipos.indexOf('export type Expediente'));
    assert.deepEqual([...entrada.matchAll(/^  ([a-z_]+): /gm)].map((m) => m[1]), [
      'id', 'kind', 'author_role', 'mine', 'body', 'content_type', 'byte_size', 'created_at',
    ]);
    // Y el servidor tampoco la manda.
    const esquemas = readFileSync(join(API, 'atencion_schemas.py'), 'utf8');
    const delServidor = esquemas.slice(esquemas.indexOf('class EntradaRead'), esquemas.indexOf('class ExpedienteRead'));
    assert.ok(!/storage_path|sha256|author_id: /.test(delServidor.replace(/#.*$/gm, '').replace(/e\.author_id/g, '')));
  });

  it('una nota interna solo se escribe (y se marca) en administración', () => {
    const admin = pantalla('AdminCasoDeServiciosScreen');
    assert.match(admin, /ServiceCareRepository\.anotarEnElCaso\(id, texto, interna, /);
    assert.match(admin, /servicios\.atencion\.admin\.notaInternaAyuda/);
    assert.ok(!/interna|internal/.test(pantalla('CasoDeLaReservaScreen')));
    for (const dic of [es, en, pt]) assert.ok('servicios.atencion.caso.entrada.internal_note' in dic);
  });

  it('la bandeja de casos no enseña lo que escribieron las partes', () => {
    const bandeja = pantalla('AdminCasosDeServiciosScreen');
    assert.ok(!/description|\.body|client_id|username|email/.test(bandeja));
  });

  it('el código de asistencia lo ve quien contrata; el prestador lo escribe, con sus intentos', () => {
    assert.match(ATENCION, /\{esCliente && a\?\.checkin_code \? \(/);
    assert.match(ATENCION, /onChangeText=\{\(texto\) => setCodigo\(codigoLimpio\(texto\)\)\}/);
    assert.match(ATENCION, /disabled=\{ocupado \|\| codigo\.length !== LARGOS_DE_LA_ATENCION\.codigo\}/);
    assert.match(ATENCION, /servicios\.atencion\.iniciar\.intentos/);
    // El código nunca viaja en una ruta.
    for (const m of (ATENCION + NUEVAS.map(pantalla).join('\n')).matchAll(/router\.(push|replace|setParams)\(([^;\n]*)\)/g)) {
      assert.ok(!/codigo|checkin|nota|descripcion|comentario|mensaje/.test(m[2] as string), m[0]);
    }
  });
});

// =========================================================================== //
describe('la reseña es verificada porque lo dice el servidor', () => {
  it('el formulario no tiene ningún «verificada» ni estado que marcar', () => {
    const resena = pantalla('ResenaDeLaReservaScreen');
    assert.ok(!/verified|verificad/i.test(resena.replace(/servicios\.atencion\.resena\.aviso/g, '')));
    assert.match(resena, /ServiceCareRepository\.resenar\(id, peticion, llaves\.de\('resenar', peticion\)\)/);
    assert.match(resena, /disabled=\{ocupado \|\| formulario\.nota === 0 \|\| formulario\.recomienda === null\}/);
    // Tras enviarla dice si quedó pública o a la espera, según lo que contestó el servidor.
    assert.match(resena, /fresca\.care\?\.review\?\.status === 'pending' \? 'servicios\.atencion\.resena\.enRevision' : 'servicios\.atencion\.resena\.publicada'/);
  });

  it('sin reseñas la ficha no inventa nada: ni la lista ni una nota', () => {
    const lista = componente('ListaDeResenasDelServicio');
    assert.match(lista, /if \(pagina === null \|\| !pagina\.available \|\| resenas\.length === 0\) return null;/);
    assert.ok(!/0\.0|toFixed\(1\)\}? ?\|\| ?0/.test(lista));
    // El resumen de la ficha ya decía «todavía no hay reseñas» sin nota (Incremento 3).
    assert.match(sinComentarios(fuente('lib/serviciosDescubrimiento.ts')), /if \(cuantas <= 0 \|\| media === null \|\| !Number\.isFinite\(media\)\) \{\s*return \{ clave: 'servicios\.descubrir\.resenas\.ninguna' \};/);
  });

  it('moderar: publicar o esconder con motivo; nunca borrar ni reescribir', () => {
    const moderar = pantalla('AdminResenasDeServiciosScreen');
    assert.match(moderar, /MOTIVOS_DE_MODERACION\.map\(/);
    assert.match(moderar, /disabled=\{ocupado \|\| motivo === null\}/);
    assert.ok(!/borrar|eliminar|delete|editar|comment:|setComentario/i.test(moderar));
    assert.match(moderar, /servicios\.atencion\.moderar\.porQue/);
  });

  it('el prestador responde una vez, y se le avisa de que no se edita', () => {
    assert.match(ATENCION, /\{puede\(cuidado, 'reply_review'\) \? \(/);
    assert.match(ATENCION, /maxLength=\{LARGOS_DE_LA_ATENCION\.respuesta\}/);
    assert.match(es['servicios.atencion.pregunta.responder.aviso'], /no se puede editar/);
  });
});

// =========================================================================== //
describe('accesibilidad y textos', () => {
  it('lo que se elige entre varias opciones son botones de opción', () => {
    for (const nombre of ['CancelarReservaScreen', 'CasoDeLaReservaScreen', 'ResenaDeLaReservaScreen',
      'AdminCasoDeServiciosScreen', 'AdminCasosDeServiciosScreen', 'AdminResenasDeServiciosScreen']) {
      const codigo = pantalla(nombre);
      assert.ok((codigo.match(/rol="radio"/g) ?? []).length >= 1, nombre);
      assert.match(codigo, /accessibilityRole="radiogroup"/, nombre);
    }
    // El código de asistencia y las estrellas se leen como lo que son.
    assert.match(ATENCION, /accessibilityLabel=\{f\('servicios\.atencion\.codigo\.leido'/);
    assert.match(ATENCION, /accessibilityLabel=\{f\('servicios\.atencion\.resena\.notaLeida'/);
  });

  it('ningún texto en duro', () => {
    const todas = [...NUEVAS.map((p) => [p, pantalla(p)] as const), ...COMPONENTES.map((c) => [c, componente(c)] as const)];
    for (const [nombre, codigo] of todas) {
      for (const atributo of ['label="', 'title="', 'description="', 'placeholder="', 'actionLabel="', 'accessibilityLabel="']) {
        assert.ok(!codigo.includes(atributo), `${nombre} escribe ${atributo}…" en duro`);
      }
      for (const m of codigo.matchAll(/<Text[^>]*>([^<{]+)<\/Text>/g)) {
        assert.equal((m[1] as string).trim(), '', `${nombre}: texto en duro «${m[1]}»`);
      }
    }
  });

  it('cada clave escrita en las vistas existe en es, en y pt', () => {
    const codigo = TODO + pantalla('HorariosDelServicioScreen') + pantalla('AdminServiciosScreen') + componente('ListaDeReservas');
    const claves = new Set([...codigo.matchAll(/'((?:servicios|notif)\.[A-Za-z0-9_.]+)'/g)].map((m) => m[1] as string));
    assert.ok(claves.size > 150, `solo ${claves.size} claves`);
    for (const clave of claves) {
      for (const [idioma, dic] of Object.entries({ es, en, pt })) {
        assert.ok(clave in dic, `falta «${clave}» en ${idioma}`);
      }
    }
  });

  it('ningún código interno llega a la pantalla', () => {
    for (const bruto of [...NUEVAS.map(pantalla), ...COMPONENTES.map(componente)]) {
      const codigo = bruto.replace(/key=\{`[^`]*`\}/g, '').replace(/key=\{[^}]*\}/g, '');
      assert.ok(!/error\.code\}|\{[a-z]+\.status\}|\{[a-z]+\.kind\}|\{[a-z]+\.reason\}|\{[a-z]+\.outcome\}|\{[a-z]+\.action\}/.test(codigo));
    }
  });
});
