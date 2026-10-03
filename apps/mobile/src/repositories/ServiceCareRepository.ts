import { apiRequest, API_V1 } from '@/services/api';
import { ESPERA_DE_SUBIDA_MS, type EnlaceTemporal } from '@/lib/serviciosAdmision';
import type {
  CasoAdmin,
  ConCuidado,
  Expediente,
  ExpedienteAdmin,
  PaginaDeResenas,
  Parte,
  ResenaAdmin,
  Tareas,
} from '@/lib/serviciosAtencion';
import type { ReservaDelPrestador, ReservaDetalle } from '@/lib/serviciosReserva';

/**
 * Z Servicios, Incremento 6: la atención de una reserva y su posventa.
 *
 * EL SERVIDOR DECIDE qué se puede hacer (`care.available_actions`), cuándo y
 * quién. Aquí se pide y se pinta; ninguna llamada manda un estado.
 *
 * TODA ESCRITURA LLEVA `Idempotency-Key`: un doble toque o un reintento
 * devuelven lo mismo, nunca dos cancelaciones, dos casos ni dos reseñas.
 * NINGUNA LLAMADA MUEVE DINERO: resolver un caso deja un efecto económico
 * SOLICITADO y su estado, que nunca es «ejecutado».
 */
const BASE = `${API_V1}/services`;
const ADMIN = `${API_V1}/admin/services`;

type Detalle<R extends Parte> = ConCuidado<R extends 'client' ? ReservaDetalle : ReservaDelPrestador>;

function de(rol: Parte, reserva: string): string {
  return `${BASE}/${rol === 'client' ? 'me' : 'provider'}/bookings/${encodeURIComponent(reserva)}`;
}

function consulta(partes: Record<string, string | number | boolean | null | undefined>): string {
  const lista = Object.entries(partes)
    .filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== false)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return lista.length ? `?${lista.join('&')}` : '';
}

function post(cuerpo: unknown, clave: string): RequestInit {
  return {
    method: 'POST',
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    headers: { 'Idempotency-Key': clave },
  };
}

export const ServiceCareRepository = {
  // ------------------------------------------------------------------ //
  // El detalle de una reserva, con su atención (`care`)
  // ------------------------------------------------------------------ //
  async reserva<R extends Parte>(rol: R, id: string): Promise<Detalle<R>> {
    return apiRequest<Detalle<R>>(de(rol, id));
  },

  // ------------------------------------------------------------------ //
  // Lo que hacen las dos partes
  // ------------------------------------------------------------------ //
  async cancelar<R extends Parte>(rol: R, id: string, cuerpo: Record<string, unknown>, clave: string): Promise<Detalle<R>> {
    return apiRequest<Detalle<R>>(`${de(rol, id)}/cancel`, post(cuerpo, clave));
  },

  /** Decir que LA OTRA parte no vino. No decide nada económico. */
  async reportarAusencia<R extends Parte>(rol: R, id: string, clave: string): Promise<Detalle<R>> {
    return apiRequest<Detalle<R>>(`${de(rol, id)}/no-show`, post(undefined, clave));
  },

  async caso(rol: Parte, id: string): Promise<Expediente> {
    return apiRequest<Expediente>(`${de(rol, id)}/incident`);
  },

  async abrirCaso(rol: Parte, id: string, cuerpo: Record<string, unknown>, clave: string): Promise<Expediente> {
    return apiRequest<Expediente>(`${de(rol, id)}/incident`, post(cuerpo, clave));
  },

  async escribirEnElCaso(rol: Parte, id: string, cuerpo: Record<string, unknown>, clave: string): Promise<Expediente> {
    return apiRequest<Expediente>(`${de(rol, id)}/incident/entries`, post(cuerpo, clave));
  },

  /** Una evidencia al depósito privado. La ruta la pone el servidor. */
  async subirEvidencia(
    rol: Parte,
    id: string,
    opciones: { archivo: Blob; nombre: string },
    clave: string,
  ): Promise<Expediente> {
    const formulario = new FormData();
    formulario.append('file', opciones.archivo, opciones.nombre);
    return apiRequest<Expediente>(`${de(rol, id)}/incident/evidence`, {
      method: 'POST',
      body: formulario,
      headers: { 'Idempotency-Key': clave },
      timeoutMs: ESPERA_DE_SUBIDA_MS,
    });
  },

  /** Un enlace de dos minutos para mirar una evidencia. No se guarda. */
  async verEvidencia(rol: Parte, id: string, entrada: string): Promise<EnlaceTemporal> {
    return apiRequest<EnlaceTemporal>(`${de(rol, id)}/incident/entries/${encodeURIComponent(entrada)}/file`);
  },

  async retirarCaso(rol: Parte, id: string, clave: string): Promise<Expediente> {
    return apiRequest<Expediente>(`${de(rol, id)}/incident/withdraw`, post(undefined, clave));
  },

  async apelar(rol: Parte, id: string, cuerpo: Record<string, unknown>, clave: string): Promise<Expediente> {
    return apiRequest<Expediente>(`${de(rol, id)}/incident/appeal`, post(cuerpo, clave));
  },

  // ------------------------------------------------------------------ //
  // Solo quien contrata
  // ------------------------------------------------------------------ //
  /** Mover la reserva al horario que YA SE APARTÓ. El contrato no cambia. */
  async reprogramar(id: string, retencion: string, clave: string): Promise<ConCuidado<ReservaDetalle>> {
    return apiRequest(`${de('client', id)}/reschedule`, post({ hold_id: retencion }, clave));
  },

  /** El código de asistencia: se le enseña al prestador al empezar. */
  async pedirCodigo(id: string, clave: string): Promise<{ checkin_code: string }> {
    return apiRequest(`${de('client', id)}/check-in-code`, post(undefined, clave));
  },

  async confirmar(id: string, clave: string): Promise<ConCuidado<ReservaDetalle>> {
    return apiRequest(`${de('client', id)}/confirm`, post(undefined, clave));
  },

  async resenar(id: string, cuerpo: Record<string, unknown>, clave: string): Promise<ConCuidado<ReservaDetalle>> {
    return apiRequest(`${de('client', id)}/review`, post(cuerpo, clave));
  },

  // ------------------------------------------------------------------ //
  // Solo el prestador
  // ------------------------------------------------------------------ //
  /** Empezar. Con el código de quien contrata, la señal fuerte; sin él, una declaración. */
  async iniciar(id: string, codigo: string | null, clave: string): Promise<ConCuidado<ReservaDelPrestador>> {
    return apiRequest(`${de('provider', id)}/start`, post(codigo ? { code: codigo } : {}, clave));
  },

  async terminar(id: string, clave: string): Promise<ConCuidado<ReservaDelPrestador>> {
    return apiRequest(`${de('provider', id)}/complete`, post(undefined, clave));
  },

  async responderResena(id: string, cuerpo: Record<string, unknown>, clave: string): Promise<ConCuidado<ReservaDelPrestador>> {
    return apiRequest(`${de('provider', id)}/review/reply`, post(cuerpo, clave));
  },

  // ------------------------------------------------------------------ //
  // Lo público: las reseñas publicadas de un servicio
  // ------------------------------------------------------------------ //
  async resenasDelServicio(servicio: string, cursor: string | null): Promise<PaginaDeResenas> {
    return apiRequest<PaginaDeResenas>(`${BASE}/catalog/${encodeURIComponent(servicio)}/reviews${consulta({ cursor })}`);
  },

  // ------------------------------------------------------------------ //
  // Administración
  // ------------------------------------------------------------------ //
  async casos(
    filtro: string | null,
    conEfecto: boolean,
    cursor: string | null,
  ): Promise<{ items: CasoAdmin[]; next_cursor: string | null }> {
    return apiRequest(`${ADMIN}/incidents${consulta({ status: filtro, with_financial_effect: conEfecto, cursor })}`);
  },

  async casoParaAdministrar(caso: string): Promise<ExpedienteAdmin> {
    return apiRequest<ExpedienteAdmin>(`${ADMIN}/incidents/${encodeURIComponent(caso)}`);
  },

  /** Un mensaje a las partes, o una NOTA INTERNA que no sale de administración. */
  async anotarEnElCaso(caso: string, texto: string, interna: boolean, clave: string): Promise<ExpedienteAdmin> {
    return apiRequest<ExpedienteAdmin>(
      `${ADMIN}/incidents/${encodeURIComponent(caso)}/entries`,
      post({ body: texto, internal: interna }, clave),
    );
  },

  async verEvidenciaParaAdministrar(caso: string, entrada: string): Promise<EnlaceTemporal> {
    return apiRequest<EnlaceTemporal>(
      `${ADMIN}/incidents/${encodeURIComponent(caso)}/entries/${encodeURIComponent(entrada)}/file`,
    );
  },

  /** La resolución. NO MUEVE DINERO: deja el efecto solicitado y su estado. */
  async resolver(caso: string, cuerpo: Record<string, unknown>, clave: string): Promise<ExpedienteAdmin> {
    return apiRequest<ExpedienteAdmin>(`${ADMIN}/incidents/${encodeURIComponent(caso)}/resolve`, post(cuerpo, clave));
  },

  async resenasParaModerar(
    filtro: string | null,
    cursor: string | null,
  ): Promise<{ items: ResenaAdmin[]; next_cursor: string | null }> {
    return apiRequest(`${ADMIN}/reviews${consulta({ status: filtro, cursor })}`);
  },

  async moderarResena(resena: string, cuerpo: Record<string, unknown>, clave: string): Promise<ResenaAdmin> {
    return apiRequest<ResenaAdmin>(`${ADMIN}/reviews/${encodeURIComponent(resena)}/moderate`, post(cuerpo, clave));
  },

  /** Los barridos: recordar y cerrar lo que ya se puede cerrar. Idempotentes. */
  async correrTareas(): Promise<Tareas> {
    return apiRequest<Tareas>(`${ADMIN}/tasks/run`, { method: 'POST' });
  },
};
