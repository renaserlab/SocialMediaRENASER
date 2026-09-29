/**
 * Z Servicios, Incremento 1: la lógica pura del teléfono, contra el servidor.
 *
 * Tres cosas que aquí no pueden desalinearse sin que nadie se entere:
 *  - los VALORES CERRADOS (estados, tipos, campos, formatos) son los del
 *    servidor, leídos de su código fuente;
 *  - CADA CÓDIGO que el servidor puede devolver tiene su texto, y ninguno se
 *    enseña crudo;
 *  - cada CLAVE que esta lógica produce existe en el diccionario.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { es } from '../i18n/es.ts';
import {
  ACCIONES,
  CAMPOS_OBSERVABLES,
  CODIGOS_DE_ERROR,
  ESTADOS,
  FORMATOS_DE_DOCUMENTO,
  PASOS,
  PESO_MAXIMO_DE_DOCUMENTO,
  REPOSTULACIONES,
  TIPOS_DE_CREDENCIAL,
  TIPOS_DE_DOCUMENTO,
  TIPOS_DE_PRESTADOR,
  alternar,
  bloqueo,
  cambiosDelBorrador,
  claveDeErrorDeServicios,
  claveDeErrorPorEstado,
  claveDeLaAccion,
  claveDelCampo,
  claveDelCuerpoDelEstado,
  claveDelEstado,
  claveDelEstadoDeCredencial,
  claveDelEstadoDeDocumento,
  claveDelEstadoDePolitica,
  claveDelTipoDeCredencial,
  claveDelTipoDeDocumento,
  claveDelTipoDePrestador,
  condicionesDesde,
  condicionesVacias,
  consultaDeLaBandeja,
  credencialDesde,
  credencialVacia,
  documentosQueFaltan,
  esDestructiva,
  esFinal,
  exigeMotivo,
  falloDeCarga,
  fechaCorta,
  fechaDeCampo,
  fechaIso,
  formularioDesde,
  hayQueRecargar,
  huellaCorta,
  juntarPaginas,
  nuevaClave,
  parametrosDeCondiciones,
  pasoDelRequisito,
  pasosPendientes,
  peticionDeAlta,
  peticionDeCondiciones,
  peticionDeCredencial,
  pesoLegible,
  requisito,
  revisarMotivo,
  revisarMotivoDeRetirada,
  revisarNota,
  seReintenta,
  type CredencialPrivada,
  type Politica,
  type SolicitudPrivada,
  type SolicitudResumen,
} from './serviciosAdmision.ts';

const API = join(import.meta.dirname, '..', '..', '..', 'api', 'app', 'modules', 'services');
const servidor = (fichero: string) => readFileSync(join(API, fichero), 'utf8');
const DICCIONARIO = es as Record<string, string>;
const existe = (clave: string) => clave in DICCIONARIO;

/** Los valores entre comillas de una tupla de Python: `NOMBRE = ( "a", "b", )`. */
function tupla(fuente: string, nombre: string): string[] {
  const desde = fuente.indexOf(`${nombre} = (`);
  assert.ok(desde >= 0, `no encontré ${nombre}`);
  const bloque = fuente.slice(desde, fuente.indexOf(')', desde));
  return [...bloque.matchAll(/"([a-z_/]+)"/g)].map((m) => m[1] as string);
}

function solicitud(parcial: Partial<SolicitudPrivada> = {}): SolicitudPrivada {
  return {
    id: 's1',
    status: 'draft',
    provider: {
      id: 'p1',
      provider_type: 'individual',
      display_name: 'Ana Guitarra',
      legal_name: null,
      country_code: null,
      tax_id: null,
      representative_name: null,
      status: 'pending',
    },
    summary: null,
    requested_category: null,
    submitted_at: null,
    last_submitted_at: null,
    decided_at: null,
    suspended_at: null,
    applicant_message: null,
    observed_fields: [],
    terms: null,
    documents: [],
    credentials: [],
    editable: true,
    missing: [],
    can_submit: false,
    can_resubmit: false,
    can_withdraw: true,
    submissions_count: 0,
    created_at: null,
    updated_at: null,
    ...parcial,
  };
}

// =========================================================================== //
describe('los valores cerrados son los del servidor', () => {
  it('los nueve estados, en el mismo orden', () => {
    const estados = servidor('states.py');
    // `states.ESTADOS` usa constantes: se leen sus valores y su orden.
    const valores = [...estados.matchAll(/^([A-Z_]+) = "([a-z_]+)"$/gm)];
    const porNombre = new Map(valores.map((m) => [m[1] as string, m[2] as string]));
    const bloque = estados.slice(estados.indexOf('ESTADOS: tuple'), estados.indexOf(')', estados.indexOf('ESTADOS: tuple')));
    const orden = [...bloque.matchAll(/([A-Z_]{4,}),/g)].map((m) => porNombre.get(m[1] as string));
    assert.deepEqual(orden, [...ESTADOS]);
  });

  it('tipos de documento, formatos y peso', () => {
    const modelos = servidor('models.py');
    assert.deepEqual(tupla(modelos, 'TIPOS_DE_DOCUMENTO'), [...TIPOS_DE_DOCUMENTO]);
    assert.deepEqual(tupla(modelos, 'FORMATOS_DE_DOCUMENTO'), [...FORMATOS_DE_DOCUMENTO]);
    assert.match(modelos, /PESO_MAXIMO_DE_DOCUMENTO = 10 \* 1024 \* 1024/);
    assert.equal(PESO_MAXIMO_DE_DOCUMENTO, 10 * 1024 * 1024);
  });

  it('tipos de credencial', () => {
    assert.deepEqual(tupla(servidor('models.py'), 'TIPOS_DE_CREDENCIAL'), [...TIPOS_DE_CREDENCIAL]);
  });

  it('los campos que Z puede pedir corregir', () => {
    assert.deepEqual(tupla(servidor('requisitos.py'), 'CAMPOS_OBSERVABLES'), [...CAMPOS_OBSERVABLES]);
  });

  it('las acciones de administración son las del router', () => {
    const router = servidor('router.py');
    for (const accion of ACCIONES) assert.ok(router.includes(`"${accion}"`), accion);
  });
});

describe('ningún código del servidor llega crudo a la pantalla', () => {
  it('cada código de error de Servicios tiene su texto', () => {
    const codigos = new Set<string>();
    for (const fichero of [
      'admision.py', 'credenciales.py', 'documentos.py', 'esquema.py', 'permissions.py',
      'politicas.py', 'router.py', 'service.py', 'states.py',
    ]) {
      for (const m of servidor(fichero).matchAll(/code ?= ?"([a-z_]+)"/g)) codigos.add(m[1] as string);
    }
    assert.ok(codigos.size >= 40, `solo ${codigos.size} códigos leídos`);
    const sinTexto = [...codigos].filter((c) => claveDeErrorDeServicios(c) === null);
    assert.deepEqual(sinTexto, [], `sin texto en el teléfono: ${sinTexto.join(', ')}`);
  });

  it('cada texto de error existe en el diccionario', () => {
    for (const codigo of CODIGOS_DE_ERROR) {
      const clave = claveDeErrorDeServicios(codigo) as string;
      assert.ok(existe(clave), `${codigo} → ${clave}`);
    }
    for (const estado of [401, 403, 404, 409, 422, 503]) {
      assert.ok(existe(claveDeErrorPorEstado(estado) as string), String(estado));
    }
    assert.equal(claveDeErrorPorEstado(500), null);
    assert.equal(claveDeErrorDeServicios('algo_que_no_existe'), null);
    assert.equal(claveDeErrorDeServicios(null), null);
  });

  it('cada requisito y cada bloqueo del servidor se traduce, y uno nuevo no se imprime', () => {
    const requisitos = servidor('requisitos.py');
    const codigos = [
      'legal_name', 'country_code', 'summary', 'tax_id', 'representative_name',
      'document:identity', 'document:legal_representation', 'credential:certification',
      'credential_evidence', 'provider_terms_not_published', 'provider_terms_not_accepted',
      'provider_terms_changed', 'document_observed:identity', 'credential_observed',
      'field_not_corrected:legal_name',
    ];
    for (const codigo of codigos) {
      const base = codigo.split(':')[0] as string;
      assert.ok(requisitos.includes(`"${base}`), `el servidor no emite ${base}`);
      const r = requisito(codigo);
      assert.notEqual(r.clave, 'servicios.falta.otro', codigo);
      assert.ok(existe(r.clave), r.clave);
      if (r.nombre) assert.ok(existe(r.nombre), r.nombre);
    }
    assert.equal(requisito('requisito_nuevo').clave, 'servicios.falta.otro');
    for (const codigo of [
      'document_pending_review:identity', 'document_observed:identity',
      'document_not_accepted:identity', 'credential_pending_review', 'credential_not_verified:certification',
    ]) {
      const b = bloqueo(codigo);
      assert.notEqual(b.clave, 'servicios.bloqueo.otro', codigo);
      assert.ok(existe(b.clave), b.clave);
      assert.ok(requisitos.includes(`"${codigo.split(':')[0]}`), `el servidor no emite ${codigo}`);
    }
    assert.equal(bloqueo('otro_bloqueo').clave, 'servicios.bloqueo.otro');
  });
});

describe('cada clave que produce esta lógica existe', () => {
  it('estados, tipos, campos, acciones y pasos', () => {
    const claves = [
      ...ESTADOS.flatMap((e) => [claveDelEstado(e), claveDelCuerpoDelEstado(e)]),
      claveDelEstado('inventado'), claveDelCuerpoDelEstado('inventado'),
      ...TIPOS_DE_PRESTADOR.map(claveDelTipoDePrestador), claveDelTipoDePrestador('x'),
      ...TIPOS_DE_DOCUMENTO.map(claveDelTipoDeDocumento),
      ...TIPOS_DE_CREDENCIAL.map(claveDelTipoDeCredencial),
      ...['pending', 'accepted', 'rejected', 'x'].map(claveDelEstadoDeDocumento),
      ...['pending', 'observed', 'verified', 'rejected', 'expired', 'x'].map(claveDelEstadoDeCredencial),
      ...CAMPOS_OBSERVABLES.map(claveDelCampo), claveDelCampo('x'), 'servicios.campo.legal_name_company',
      ...ACCIONES.map((a) => claveDeLaAccion(a, 'under_review')), claveDeLaAccion('start_review', 'suspended'),
      ...ACCIONES.map((a) => `servicios.admin.confirmar.${a}`),
      ...PASOS.map((p) => `servicios.paso.${p}`), 'servicios.paso.inicio',
      ...TIPOS_DE_PRESTADOR.map((t) => `servicios.inicio.ayuda.${t}`),
      ...['pending', 'active', 'suspended'].map((s) => `servicios.prestadorEstado.${s}`),
      ...['provider', 'reviewer', 'admin', 'system'].map((s) => `servicios.funcion.${s}`),
      ...['draft', 'published', 'superseded', 'withdrawn'].map(claveDelEstadoDePolitica),
      ...REPOSTULACIONES.map((r) => `servicios.politica.repostular.${r}`),
    ];
    const faltan = claves.filter((c) => !existe(c));
    assert.deepEqual(faltan, []);
  });

  it('un tipo desconocido cae en «otro», nunca en su código', () => {
    assert.equal(claveDelTipoDeDocumento('pasaporte_de_marte'), 'servicios.documento.other');
    assert.equal(claveDelTipoDeCredencial('x'), 'servicios.tipoCredencial.other');
    assert.equal(claveDelEstado('approved_maybe'), 'servicios.estado.desconocido');
  });

  it('volver a revisión una suspendida no se llama «tomar»', () => {
    assert.equal(claveDeLaAccion('start_review', 'suspended'), 'servicios.admin.accion.volverARevision');
    assert.equal(claveDeLaAccion('start_review', 'submitted'), 'servicios.admin.accion.start_review');
  });
});

// =========================================================================== //
describe('fallos de carga', () => {
  it('cada fallo dice lo suyo y solo se reintenta lo que se arregla reintentando', () => {
    assert.equal(falloDeCarga(503, 'services_disabled'), 'apagado');
    assert.equal(falloDeCarga(503, 'services_not_ready'), 'apagado');
    assert.equal(falloDeCarga(0, 'network_error'), 'sinConexion');
    assert.equal(falloDeCarga(0, 'timeout'), 'sinConexion');
    assert.equal(falloDeCarga(401, 'x'), 'sinSesion');
    assert.equal(falloDeCarga(403, 'service_review_forbidden'), 'sinPermiso');
    assert.equal(falloDeCarga(404, 'service_application_not_found'), 'noEncontrada');
    assert.equal(falloDeCarga(500, 'internal_error'), 'error');
    assert.equal(seReintenta('sinConexion'), true);
    assert.equal(seReintenta('error'), true);
    for (const f of ['apagado', 'sinSesion', 'sinPermiso', 'noEncontrada'] as const) {
      assert.equal(seReintenta(f), false, f);
    }
  });

  it('un 409 o un 404 vuelven a leer del servidor; un 422, no', () => {
    assert.equal(hayQueRecargar(409, 'service_application_transition_invalid'), true);
    assert.equal(hayQueRecargar(404, 'service_document_not_found'), true);
    assert.equal(hayQueRecargar(409, 'provider_terms_changed'), true);
    assert.equal(hayQueRecargar(422, 'service_application_incomplete'), false);
  });
});

describe('el borrador', () => {
  it('solo viaja lo que cambió; vaciar es null; el país va en mayúsculas', () => {
    const base = solicitud({
      summary: 'Clases de guitarra clásica desde hace diez años.',
      provider: { ...solicitud().provider, legal_name: 'Ana María' },
    });
    const formulario = { ...formularioDesde(base), pais: 'pe', nombreLegal: '' };
    const { cambios, fallos } = cambiosDelBorrador(formulario, base);
    assert.deepEqual(fallos, []);
    assert.deepEqual(cambios, { country_code: 'PE', legal_name: null });
    assert.equal('status' in cambios, false);
  });

  it('valida los mínimos y máximos del servidor', () => {
    const base = solicitud();
    const f = { ...formularioDesde(base), nombre: 'A', resumen: 'corto', pais: 'PER', ruc: '1'.repeat(21) };
    const campos = cambiosDelBorrador(f, base).fallos.map((x) => x.campo).sort();
    assert.deepEqual(campos, ['nombre', 'pais', 'resumen', 'ruc']);
  });

  it('el alta exige tipo y nombre', () => {
    assert.equal(peticionDeAlta(null, 'Ana').peticion, null);
    assert.equal(peticionDeAlta('individual', 'A').peticion, null);
    assert.deepEqual(peticionDeAlta('company', '  Taller Andino  ').peticion, {
      provider_type: 'company',
      display_name: 'Taller Andino',
    });
  });
});

describe('credenciales', () => {
  const guardada: CredencialPrivada = {
    id: 'c1', kind: 'professional_license', title: 'Colegiatura', issuer: 'Colegio',
    jurisdiction: null, number_masked: '••••4587', specialty: null, issued_on: '2020-01-15',
    expires_on: null, display_status: 'pending', review_note: null, evidence_document_id: 'd1',
    can_edit: true, can_remove: true,
  };

  it('las fechas: dd/mm/aaaa ↔ aaaa-mm-dd, y un 31/02 no es una fecha', () => {
    assert.equal(fechaIso('15/01/2020'), '2020-01-15');
    assert.equal(fechaIso('31/02/2024'), null);
    assert.equal(fechaIso('2020-01-15'), null);
    assert.equal(fechaDeCampo('2020-01-15'), '15/01/2020');
    assert.equal(fechaDeCampo(null), '');
  });

  it('crear lleva todo lo escrito; sin tipo, no', () => {
    assert.equal(peticionDeCredencial({ ...credencialVacia(), titulo: 'Curso', emisor: 'Instituto' }, null).peticion, null);
    const { peticion } = peticionDeCredencial(
      { ...credencialVacia(), tipo: 'certification', titulo: 'Curso', emisor: 'Instituto', vence: '01/01/2030', evidencia: 'd1' },
      null,
    );
    assert.deepEqual(peticion, {
      kind: 'certification', title: 'Curso', issuer: 'Instituto', expires_on: '2030-01-01', evidence_document_id: 'd1',
    });
  });

  it('editar: el número solo si se escribe uno nuevo; sin cambios, nada', () => {
    const formulario = credencialDesde(guardada);
    assert.equal(formulario.numero, '', 'el número enmascarado no se rellena');
    assert.equal(peticionDeCredencial(formulario, guardada).peticion, null);
    assert.deepEqual(peticionDeCredencial({ ...formulario, titulo: 'Colegiatura CPsP' }, guardada).peticion, {
      title: 'Colegiatura CPsP',
    });
    assert.deepEqual(peticionDeCredencial({ ...formulario, numero: 'PSI-1' }, guardada).peticion, { number: 'PSI-1' });
  });

  it('no vence antes de emitirse', () => {
    const { fallos } = peticionDeCredencial(
      { ...credencialVacia(), tipo: 'certification', titulo: 'Curso', emisor: 'Instituto', emitida: '01/01/2024', vence: '01/01/2023' },
      null,
    );
    assert.deepEqual(fallos.map((f) => f.clave), ['servicios.validacion.venceAntes']);
  });
});

describe('motivos', () => {
  it('pedir correcciones, rechazar y suspender exigen motivo; aprobar y tomar, no', () => {
    for (const accion of ['request_changes', 'reject', 'suspend']) {
      assert.equal(exigeMotivo(accion), true, accion);
      assert.equal(revisarMotivo(accion, '  '), 'servicios.validacion.motivoObligatorio');
    }
    assert.equal(revisarMotivo('approve', ''), null);
    assert.equal(revisarMotivo('approve', 'ok'), 'servicios.validacion.corto');
    assert.equal(revisarMotivo('reject', 'x'.repeat(2001)), 'servicios.validacion.largo');
    assert.equal(esDestructiva('reject') && esDestructiva('suspend') && !esDestructiva('approve'), true);
  });

  it('una observación exige motivo; la retirada lo deja opcional', () => {
    assert.equal(revisarNota(''), 'servicios.validacion.motivoObligatorio');
    assert.equal(revisarNota('Borrosa'), null);
    assert.equal(revisarMotivoDeRetirada(''), null);
    assert.equal(revisarMotivoDeRetirada('no'), 'servicios.validacion.corto');
    assert.equal(revisarMotivoDeRetirada('x'.repeat(501)), 'servicios.validacion.largo');
  });
});

describe('pasos del asistente', () => {
  it('cada requisito cae en su paso, y un paso está listo cuando el servidor ya no pide nada', () => {
    assert.equal(pasoDelRequisito('legal_name'), 'datos');
    assert.equal(pasoDelRequisito('field_not_corrected:summary'), 'datos');
    assert.equal(pasoDelRequisito('provider_terms_changed'), 'condiciones');
    assert.equal(pasoDelRequisito('document:identity'), 'documentos');
    assert.equal(pasoDelRequisito('document_observed:identity'), 'documentos');
    assert.equal(pasoDelRequisito('credential_evidence'), 'credenciales');
    const pendientes = pasosPendientes(solicitud({ missing: ['summary', 'document:identity'] }));
    assert.deepEqual([...pendientes].sort(), ['datos', 'documentos']);
    assert.deepEqual(documentosQueFaltan(solicitud({ missing: ['document:identity', 'summary'] })), ['identity']);
  });

  it('rechazada y retirada son finales', () => {
    assert.equal(esFinal('rejected') && esFinal('withdrawn'), true);
    assert.equal(esFinal('suspended'), false);
  });
});

describe('bandeja', () => {
  it('la consulta lleva solo los filtros elegidos', () => {
    assert.equal(consultaDeLaBandeja({ estado: null, tipo: null, cursor: null }), 'limit=20');
    assert.equal(
      consultaDeLaBandeja({ estado: 'approved', tipo: 'company', cursor: 'a b' }),
      'limit=20&status=approved&provider_type=company&cursor=a%20b',
    );
  });

  it('juntar páginas no repite filas', () => {
    const fila = (id: string) => ({ id } as SolicitudResumen);
    assert.deepEqual(
      juntarPaginas([fila('1'), fila('2')], [fila('2'), fila('3')]).map((s) => s.id),
      ['1', '2', '3'],
    );
  });

  it('cada intento lleva una clave distinta y válida para el servidor (8–100)', () => {
    const claves = new Set(Array.from({ length: 50 }, () => nuevaClave()));
    assert.equal(claves.size, 50);
    for (const c of claves) assert.ok(c.length >= 8 && c.length <= 100, c);
  });
});

describe('condiciones del prestador (administración)', () => {
  it('«sin decidir» no manda nada: el servidor contestará «no configurado»', () => {
    assert.deepEqual(parametrosDeCondiciones(condicionesVacias()), {});
  });

  it('solo viajan valores que existen, sin repetir', () => {
    const p = parametrosDeCondiciones({
      ...condicionesVacias(),
      repostulacion: 'allowed',
      documentosPersona: ['proof_of_address', 'proof_of_address', 'inventado'],
      credenciales: ['certification'],
    });
    assert.deepEqual(p, {
      required_documents: { individual: ['proof_of_address'] },
      required_credentials: ['certification'],
      reapplication_after_rejection: 'allowed',
    });
  });

  it('leer una política y volver a escribirla da lo mismo', () => {
    const politica = {
      id: 'p', kind: 'provider_terms', country_code: 'PE', category: null, version: 2, status: 'draft',
      title: 'Condiciones', body: 'x'.repeat(60), body_sha256: 'a'.repeat(64), effective_at: null, published_at: null,
      parameters: { reapplication_after_rejection: 'not_allowed', required_documents: { company: ['tax_registration'] } },
    } as Politica;
    const f = condicionesDesde(politica);
    assert.equal(f.repostulacion, 'not_allowed');
    assert.deepEqual(peticionDeCondiciones(f).peticion?.parameters, politica.parameters);
  });

  it('valida país, título y un texto de al menos 50 caracteres', () => {
    const campos = peticionDeCondiciones({ ...condicionesVacias(), pais: 'P', titulo: 'x', texto: 'corto' })
      .fallos.map((f) => f.campo);
    assert.deepEqual(campos, ['pais', 'titulo', 'texto']);
    assert.deepEqual(alternar(['a'], 'a'), []);
    assert.deepEqual(alternar(['a'], 'b'), ['a', 'b']);
  });
});

describe('formatos', () => {
  it('fecha, peso y huella legibles; lo inválido, vacío', () => {
    assert.equal(fechaCorta(null), '');
    assert.equal(fechaCorta('no es una fecha'), '');
    assert.match(fechaCorta('2026-09-28T12:00:00Z'), /^\d{2}\/\d{2}\/2026$/);
    assert.equal(pesoLegible(512), '512 B');
    assert.equal(pesoLegible(2048), '2 KB');
    assert.equal(pesoLegible(3 * 1024 * 1024), '3.0 MB');
    assert.equal(huellaCorta('0123456789abcdef'), '01234567…cdef');
    assert.equal(huellaCorta(null), '');
  });
});
