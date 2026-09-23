/**
 * Las reglas de la admisión de eventos, del lado de la interfaz.
 *
 * NO SUSTITUYEN AL SERVIDOR. Cada una de estas comprobaciones vuelve a hacerse
 * en `events/admission.py` y, las que se pueden, en un CHECK de la 0060. Aquí
 * existen para otra cosa: para no ofrecer un botón que va a responder 409 y
 * para explicar por qué antes de que alguien lo pulse.
 *
 * SIN IMPORTACIONES ENTRE FICHEROS EN TIEMPO DE EJECUCIÓN. El ejecutor de
 * pruebas de Node no resuelve el alias `@/` y este tsconfig rechaza las
 * extensiones `.ts` en los imports, así que lo que corre en las pruebas no
 * puede importar de un módulo vecino. Los tipos sí: se borran al compilar.
 */

/** Criterio -> tope, tal cual el blueprint §4.2. Suman 100. */
export const CRITERIOS = {
  propuesta: 20,
  trayectoria: 15,
  programa: 15,
  recinto: 15,
  seguridad: 15,
  precio: 10,
  accesibilidad: 5,
  afinidad: 5,
} as const;

export type Criterio = keyof typeof CRITERIOS;

export const ORDEN_DE_CRITERIOS = Object.keys(CRITERIOS) as Criterio[];

export const TOTAL_POSIBLE = 100;
export const UMBRAL_APROBACION = 85;
export const UMBRAL_CONDICIONAL = 80;

export type Puntajes = Record<Criterio, number>;

export function puntajesVacios(): Puntajes {
  return ORDEN_DE_CRITERIOS.reduce((acc, c) => {
    acc[c] = 0;
    return acc;
  }, {} as Puntajes);
}

export function total(puntajes: Puntajes): number {
  return ORDEN_DE_CRITERIOS.reduce((suma, c) => suma + (puntajes[c] ?? 0), 0);
}

/**
 * El valor recortado a su tope, para el control deslizante y los botones.
 *
 * Recorta en vez de rechazar porque quien pulsa «+» en un 20 sobre 20 no está
 * cometiendo un error: no hay nada que avisar, simplemente no sube.
 */
export function dentroDelTope(criterio: Criterio, valor: number): number {
  const tope = CRITERIOS[criterio];
  if (!Number.isFinite(valor)) return 0;
  return Math.max(0, Math.min(tope, Math.round(valor)));
}

/**
 * Hasta dónde permite llegar este puntaje.
 *
 * NO ES LA DECISIÓN: quien administra puede rechazar un evento de 92. Lo que
 * esto dice es el techo, y por debajo de él no se aprueba.
 *
 * UNA FALLA CRÍTICA MANDA SOBRE EL PUNTAJE. Es la regla que más fácil se pierde
 * al programarla: con un `if total >= 85` delante, un evento sin plan de
 * emergencias y con 98 puntos entra igual.
 */
export function decisionPosible(
  puntajes: Puntajes,
  fallaCritica: boolean,
): 'approved' | 'conditional' | 'rejected' {
  if (fallaCritica) return 'rejected';
  const suma = total(puntajes);
  if (suma >= UMBRAL_APROBACION) return 'approved';
  if (suma >= UMBRAL_CONDICIONAL) return 'conditional';
  return 'rejected';
}

/** Si esta decisión concede «Seleccionado por Z». Solo `approved`. */
export function daSelloZ(decision: string): boolean {
  return decision === 'approved';
}

/**
 * Por qué esta evaluación no se puede guardar, o `null`.
 *
 * Devuelve una CLAVE de traducción, no una frase: la pantalla la traduce en el
 * idioma que esté puesto.
 */
export function motivoParaNoEvaluar(
  evidencia: string,
  fallaCritica: boolean,
  motivoDeLaFalla: string,
): string | null {
  if (evidencia.trim() === '') return 'admisionEvento.faltaEvidencia';
  if (fallaCritica && motivoDeLaFalla.trim() === '') {
    return 'admisionEvento.faltaMotivoDeLaFalla';
  }
  return null;
}

/**
 * Por qué esta decisión no se puede tomar, o `null`.
 *
 * `hayEvaluacion` es lo primero: aprobar sin haber puntuado es lo que el
 * blueprint prohíbe cuando dice que nadie altera un puntaje sin motivo,
 * evidencia y registro.
 */
export function motivoParaNoDecidir(
  decision: 'approved' | 'conditional' | 'rejected',
  hayEvaluacion: boolean,
  puntajes: Puntajes | null,
  fallaCritica: boolean,
  motivo: string,
): string | null {
  if (motivo.trim() === '') return 'admisionEvento.faltaMotivo';
  if (decision === 'rejected') return null;
  if (!hayEvaluacion || puntajes === null) return 'admisionEvento.sinEvaluar';
  if (fallaCritica) return 'admisionEvento.hayFallaCritica';
  const suma = total(puntajes);
  if (decision === 'approved' && suma < UMBRAL_APROBACION) {
    return 'admisionEvento.noLlegaAAprobado';
  }
  if (
    decision === 'conditional' &&
    (suma < UMBRAL_CONDICIONAL || suma >= UMBRAL_APROBACION)
  ) {
    return 'admisionEvento.fueraDeCondicional';
  }
  return null;
}

/** La clave de traducción del estado. Los doce del contrato, y nada más. */
export function claveDelEstado(estado: string): string {
  const conocidos = [
    'DRAFT',
    'SUBMITTED',
    'CONDITIONAL',
    'APPROVED',
    'PUBLISHED',
    'SOLD_OUT',
    'SUSPENDED',
    'CANCELLED',
    'IN_PROGRESS',
    'COMPLETED_PENDING',
    'MODIFIED',
    'SETTLED',
  ];
  return conocidos.includes(estado)
    ? `estadoDeEvento.${estado}`
    : 'estadoDeEvento.desconocido';
}
