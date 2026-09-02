import { apiRequest, API_V1 } from '@/services/api';

/**
 * Portal de pagos de los cursos.
 *
 * ## Donde se cobra cada cosa
 *
 * - **Movil (Android/iOS)** -> compras integradas de Google Play y la App
 *   Store, a traves de RevenueCat. Es lo que EXIGEN las dos tiendas para
 *   contenido digital que se consume dentro de la app; vender por fuera es el
 *   motivo de rechazo de la directriz 3.1.1, no una optimizacion de comision.
 * - **Web** -> Stripe Checkout alojado.
 *
 * Stripe no aparece nunca en el flujo nativo, y RevenueCat no se exige nunca
 * en la web.
 *
 * ## Lo que este fichero NO puede hacer
 *
 * Conceder acceso. `nativeSync` NO envia precio, ni estado, ni transaccion, ni
 * entitlement: es un DISPARADOR. El servidor consulta RevenueCat servidor a
 * servidor con su clave secreta y decide el. Da igual lo que mande el telefono.
 *
 * La compra es UNICA y permanente: no hay suscripcion ni plan mensual.
 */

export type CoursePurchase = {
  id: string;
  courseId: string;
  /** 'pending' | 'paid' | 'refunded' | 'cancelled'. */
  status: string;
  /** Importe en la unidad MENOR de la moneda (centimos). */
  amountMinor: number;
  currency: string;
  purchasedAt: string;
};

export type CourseAccess = {
  courseId: string;
  hasAccess: boolean;
  /** 'gratuito' | 'comprado' | 'autor' | 'administracion' | 'sin_acceso'. */
  reason: string;
};

type PurchaseDto = {
  id: string;
  course_id: string;
  status: string;
  amount_minor: number;
  currency: string;
  purchased_at: string;
};

type AccessDto = {
  course_id: string;
  has_access: boolean;
  reason: string;
};

type CheckoutDto = {
  purchase_id: string;
  checkout_url: string;
  amount_minor: number;
  currency: string;
};

export const PaymentRepository = {
  /**
   * Comprueba si se puede ver el contenido de un curso.
   *
   * OJO: esto es para decidir QUE MOSTRAR, no es la seguridad. Quien de verdad
   * protege los videos y los documentos es la RLS (`has_course_access`,
   * migracion 0016), que actua aunque alguien llame al almacenamiento por su
   * cuenta saltandose la app.
   */
  async hasAccess(courseId: string): Promise<CourseAccess> {
    const dto = await apiRequest<AccessDto>(
      `${API_V1}/payments/courses/${courseId}/access`,
    );
    return {
      courseId: dto.course_id,
      hasAccess: dto.has_access,
      reason: dto.reason,
    };
  },

  /** Compras de la cuenta actual, de la mas reciente a la mas antigua. */
  async listMine(): Promise<CoursePurchase[]> {
    const dtos = await apiRequest<PurchaseDto[]>(`${API_V1}/payments/me`);
    return dtos.map((dto) => ({
      id: dto.id,
      courseId: dto.course_id,
      status: dto.status,
      amountMinor: dto.amount_minor,
      currency: dto.currency,
      purchasedAt: dto.purchased_at,
    }));
  },

  /**
   * Inicia la compra y devuelve a donde hay que ir a pagar.
   *
   * **Pensado para la version web.** Llamarlo desde el movil y abrir la URL
   * seria exactamente lo que prohibe la directriz 3.1.1: dirigir a un metodo
   * de pago externo desde la aplicacion.
   *
   * El importe NO se envia: lo fija el servidor leyendolo del curso. Si
   * viniera de aqui, cualquiera compraria un curso de 300 por 1.
   */
  async startCheckout(courseId: string): Promise<{
    purchaseId: string;
    checkoutUrl: string;
    amountMinor: number;
    currency: string;
  }> {
    const dto = await apiRequest<CheckoutDto>(`${API_V1}/payments/checkout`, {
      method: 'POST',
      body: JSON.stringify({ course_id: courseId }),
    });
    return {
      purchaseId: dto.purchase_id,
      checkoutUrl: dto.checkout_url,
      amountMinor: dto.amount_minor,
      currency: dto.currency,
    };
  },
};

/** Formatea un importe en unidad menor para mostrarlo. */
export function formatAmount(amountMinor: number, currency: string): string {
  // Se divide al final y solo para pintar: los calculos de dinero se hacen
  // siempre en enteros, porque los decimales en coma flotante acaban en
  // descuadres de un centimo.
  return `${(amountMinor / 100).toFixed(2)} ${currency}`;
}


// ---------------------------------------------------------------------------
// Dominio comercial (migracion 0035)
// ---------------------------------------------------------------------------

export type ProductoDisponible = {
  courseId: string;
  /** 'ios' | 'android' | 'web'. */
  platform: string;
  available: boolean;
  /** 'revenuecat_test' | 'google' | 'apple' | 'stripe', o null. */
  provider: string | null;
  /** Identificador EN LA TIENDA, para pedirselo al SDK. Null en web. */
  productId: string | null;
  /** Precio de catalogo, en unidad menor. Es el precio WEB y la referencia. */
  priceMinor: number;
  currency: string;
  /**
   * Por que no se puede comprar: 'gratuito', 'ya_comprado', 'sin_producto',
   * 'pagos_apagados', 'no_publicado', 'no_aprobado'. Vacio si si se puede.
   */
  reason: string;
};

export type ResultadoDeSincronizacion = {
  granted: string[];
  revoked: string[];
  unchanged: string[];
  unknownProducts: string[];
};

export type CompraDelHistorial = {
  id: string;
  courseId: string;
  status: string;
  amountMinor: number;
  currency: string;
  provider: string;
  channel: string;
  purchasedAt: string | null;
  /** Si HOY se puede ver el curso. Va aparte del estado del pedido. */
  hasAccess: boolean;
};

type ProductoDto = {
  course_id: string;
  platform: string;
  available: boolean;
  provider: string | null;
  product_id: string | null;
  price_minor: number;
  currency: string;
  reason: string;
};

type SyncDto = {
  granted: string[];
  revoked: string[];
  unchanged: string[];
  unknown_products: string[];
};

type HistorialDto = {
  id: string;
  course_id: string;
  status: string;
  amount_minor: number;
  currency: string;
  provider: string;
  channel: string;
  purchased_at: string | null;
  has_access: boolean;
};

export const CommerceRepository = {
  /**
   * Que se puede comprar para un curso desde ESTA plataforma.
   *
   * Es lo que evita el boton muerto: si un curso no tiene producto dado de
   * alta para esta tienda, `available` es false y `reason` dice por que, para
   * poder explicarlo con palabras en vez de ofrecer una compra imposible.
   */
  async product(courseId: string, platform: string): Promise<ProductoDisponible> {
    const dto = await apiRequest<ProductoDto>(
      `${API_V1}/payments/courses/${courseId}/product?platform=${platform}`,
    );
    return {
      courseId: dto.course_id,
      platform: dto.platform,
      available: dto.available,
      provider: dto.provider,
      productId: dto.product_id,
      priceMinor: dto.price_minor,
      currency: dto.currency,
      reason: dto.reason,
    };
  },

  /**
   * Pide al servidor que reconcilie las compras de tienda de esta cuenta.
   *
   * El cuerpo solo lleva la plataforma, y es una ETIQUETA para apuntar el
   * canal del pedido: no decide nada sobre el acceso. Todo lo demas lo saca el
   * servidor de RevenueCat.
   */
  async nativeSync(platform: 'ios' | 'android'): Promise<ResultadoDeSincronizacion> {
    const dto = await apiRequest<SyncDto>(`${API_V1}/payments/native/sync`, {
      method: 'POST',
      body: JSON.stringify({ platform }),
    });
    return {
      granted: dto.granted,
      revoked: dto.revoked,
      unchanged: dto.unchanged,
      unknownProducts: dto.unknown_products,
    };
  },

  /**
   * Abre el Checkout alojado de Stripe. **Solo web.**
   *
   * El importe NO se envia: lo lee el servidor del curso. Llamarlo desde el
   * movil seria dirigir a un metodo de pago externo, que es justo lo que
   * prohibe la directriz 3.1.1.
   */
  async stripeCheckout(courseId: string): Promise<{ orderId: string; checkoutUrl: string }> {
    const dto = await apiRequest<CheckoutDto>(`${API_V1}/payments/stripe/checkout`, {
      method: 'POST',
      body: JSON.stringify({ course_id: courseId }),
    });
    return { orderId: dto.purchase_id, checkoutUrl: dto.checkout_url };
  },

  /**
   * Historial real, reconstruido desde el servidor.
   *
   * Nunca desde AsyncStorage: alli no hay forma de saber si algo se devolvio,
   * y quien reinstale se quedaria sin historial.
   */
  async history(): Promise<CompraDelHistorial[]> {
    const dtos = await apiRequest<HistorialDto[]>(`${API_V1}/payments/history`);
    return dtos.map((dto) => ({
      id: dto.id,
      courseId: dto.course_id,
      status: dto.status,
      amountMinor: dto.amount_minor,
      currency: dto.currency,
      provider: dto.provider,
      channel: dto.channel,
      purchasedAt: dto.purchased_at,
      hasAccess: dto.has_access,
    }));
  },
};


// ---------------------------------------------------------------------------
// Devoluciones: la garantia de 7 dias (migracion 0049)
// ---------------------------------------------------------------------------

/**
 * Devoluciones de curso.
 *
 * REGLA DE ESTE FICHERO: el cliente NO manda importe, ni moneda, ni curso, ni
 * elegibilidad, ni fechas. Solo QUE ORDEN y POR QUE. Todo lo demas lo resuelve
 * el servidor desde la orden, y lo revalida aunque la pantalla ya haya pintado
 * el boton.
 *
 * Y NO SE CALCULA NINGUN PLAZO AQUI. El reloj del telefono lo elige quien lo
 * lleva: atrasarlo una semana bastaria para «seguir en plazo» si la cuenta
 * atras naciera de `Date.now()`. Por eso la respuesta trae `server_time`, y de
 * ahi sale el desfase con el que se corrige la hora local (ver
 * `hooks/useGarantia.ts`).
 */

/** Los cuatro motivos del enum del backend. No hay texto libre como motivo. */
export type MotivoDeDevolucion =
  | 'not_as_expected'
  | 'content_quality'
  | 'technical_problem'
  | 'other';

/** Estados del expediente. Los define `refunds/estados.py`. */
export type EstadoDeSolicitud =
  | 'requested'
  | 'under_review'
  | 'approved'
  | 'refund_processing'
  | 'refunded'
  | 'rejected'
  | 'failed'
  | 'cancelled';

/** Por que NO se puede pedir. `null` cuando si se puede. */
export type MotivoSinGarantia =
  | 'no_purchase'
  | 'not_started'
  | 'expired'
  | 'already_refunded'
  | 'request_active'
  | 'disabled';

/** El estado de la garantia de un curso, resuelto en el servidor. */
export type EstadoDeGarantia = {
  /** Hora del SERVIDOR al responder. Es la autoridad de la cuenta atras. */
  serverTime: string;
  elegible: boolean;
  motivo: MotivoSinGarantia | null;
  primerAccesoEn: string | null;
  venceEn: string | null;
  segundosRestantes: number;
  garantiaUsada: boolean;
  garantiaUsadaEn: string | null;
  solicitudActivaId: string | null;
  solicitudActivaEstado: EstadoDeSolicitud | null;
  /** La orden sobre la que se pide. La elige el SERVIDOR, nunca la pantalla. */
  orderId: string | null;
  amountMinor: number;
  currency: string;
};

/** Una solicitud, como la ve quien la pidio. */
export type SolicitudDeDevolucion = {
  id: string;
  orderId: string;
  courseId: string;
  courseTitle: string;
  status: EstadoDeSolicitud;
  reason: string;
  explanation: string | null;
  amountMinor: number;
  currency: string;
  requestedAt: string;
  resolvedAt: string | null;
  /** El motivo del rechazo. Las notas internas no salen nunca por aqui. */
  reviewNotes: string | null;
};

/** Lo que hay que ensenar antes de dejar recomprar un curso ya devuelto. */
export type AvisoDeRecompra = {
  requiereAceptacion: boolean;
  versionDePolitica: string;
  /** El texto viene del SERVIDOR: es lo que hay que poder demostrar despues. */
  aviso: string;
  etiquetaDeCasilla: string;
  garantiaUsadaEn: string | null;
};

type ElegibilidadDto = {
  server_time: string;
  eligible: boolean;
  reason_code: string | null;
  first_accessed_at: string | null;
  expires_at: string | null;
  seconds_remaining: number;
  refund_used: boolean;
  refund_used_at: string | null;
  active_request_id: string | null;
  active_request_status: string | null;
  order_id: string | null;
  amount_minor: number;
  currency: string;
};

type SolicitudDto = {
  id: string;
  order_id: string;
  course_id: string;
  course_title: string;
  status: string;
  reason: string;
  explanation: string | null;
  amount_minor: number;
  currency: string;
  requested_at: string;
  resolved_at: string | null;
  review_notes: string | null;
};

type AvisoDto = {
  requires_acceptance: boolean;
  policy_version: string;
  notice: string;
  checkbox_label: string;
  refund_used_at: string | null;
};

function aSolicitud(dto: SolicitudDto): SolicitudDeDevolucion {
  return {
    id: dto.id,
    orderId: dto.order_id,
    courseId: dto.course_id,
    courseTitle: dto.course_title ?? '',
    status: dto.status as EstadoDeSolicitud,
    reason: dto.reason,
    explanation: dto.explanation,
    amountMinor: dto.amount_minor,
    currency: dto.currency,
    requestedAt: dto.requested_at,
    resolvedAt: dto.resolved_at,
    reviewNotes: dto.review_notes,
  };
}

export const DevolucionesRepository = {
  /**
   * El estado de la garantia de un curso.
   *
   * Responde SIEMPRE, tambien con la funcion apagada o sin la 0049: en ese caso
   * `elegible` es false con motivo `disabled`, y no un error. La ficha del
   * curso tiene que poder pintarse igual.
   */
  async garantia(courseId: string): Promise<EstadoDeGarantia> {
    const dto = await apiRequest<ElegibilidadDto>(
      `${API_V1}/payments/courses/${courseId}/refund-eligibility`,
    );
    return {
      serverTime: dto.server_time,
      elegible: dto.eligible,
      motivo: (dto.reason_code as MotivoSinGarantia | null) ?? null,
      primerAccesoEn: dto.first_accessed_at,
      venceEn: dto.expires_at,
      segundosRestantes: dto.seconds_remaining ?? 0,
      garantiaUsada: dto.refund_used ?? false,
      garantiaUsadaEn: dto.refund_used_at,
      solicitudActivaId: dto.active_request_id,
      solicitudActivaEstado: (dto.active_request_status as EstadoDeSolicitud | null) ?? null,
      orderId: dto.order_id,
      amountMinor: dto.amount_minor ?? 0,
      currency: dto.currency ?? '',
    };
  },

  /**
   * Pedir la devolucion de una orden.
   *
   * `orderId` sale de `garantia()`, o sea del SERVIDOR. No hay ningun camino
   * por el que la pantalla lo elija: dejar escribir el pedido seria dejar
   * pedir la devolucion del pedido de otro.
   */
  async crearSolicitud(datos: {
    orderId: string;
    reason: MotivoDeDevolucion;
    explanation?: string;
  }): Promise<SolicitudDeDevolucion> {
    const dto = await apiRequest<SolicitudDto>(`${API_V1}/payments/refund-requests`, {
      method: 'POST',
      body: JSON.stringify({
        order_id: datos.orderId,
        reason: datos.reason,
        // Cadena vacia y «sin explicacion» son la misma cosa: no se manda.
        explanation: datos.explanation?.trim() ? datos.explanation.trim() : null,
      }),
    });
    return aSolicitud(dto);
  },

  /** Las mias, de la mas reciente a la mas antigua. Vacia si no hay 0049. */
  async misSolicitudes(): Promise<SolicitudDeDevolucion[]> {
    const dtos = await apiRequest<SolicitudDto[]>(
      `${API_V1}/payments/refund-requests/mine`,
    );
    return dtos.map(aSolicitud);
  },

  /** Una solicitud concreta, si es mia. */
  async solicitud(requestId: string): Promise<SolicitudDeDevolucion> {
    const dto = await apiRequest<SolicitudDto>(
      `${API_V1}/payments/refund-requests/${requestId}`,
    );
    return aSolicitud(dto);
  },

  /** Retirarla. NO consume la garantia: quien se arrepiente conserva su plazo. */
  async cancelarSolicitud(requestId: string): Promise<SolicitudDeDevolucion> {
    const dto = await apiRequest<SolicitudDto>(
      `${API_V1}/payments/refund-requests/${requestId}/cancel`,
      { method: 'POST' },
    );
    return aSolicitud(dto);
  },

  /**
   * Que hay que ensenar antes de dejar comprar otra vez un curso ya devuelto.
   *
   * El TEXTO viaja desde el servidor a proposito. Escrito en la aplicacion
   * cambiaria con cada despliegue, y entonces «lo acepto» no significaria nada
   * porque no se sabria el que.
   */
  async avisoDeRecompra(courseId: string): Promise<AvisoDeRecompra> {
    const dto = await apiRequest<AvisoDto>(
      `${API_V1}/payments/courses/${courseId}/repurchase-notice`,
    );
    return {
      requiereAceptacion: dto.requires_acceptance,
      versionDePolitica: dto.policy_version ?? '',
      aviso: dto.notice ?? '',
      etiquetaDeCasilla: dto.checkbox_label ?? '',
      garantiaUsadaEn: dto.refund_used_at,
    };
  },

  /** Guarda la aceptacion. Sin ella el servidor no deja seguir al pago. */
  async aceptarRecompra(courseId: string): Promise<void> {
    await apiRequest<void>(`${API_V1}/payments/repurchase-acceptance`, {
      method: 'POST',
      body: JSON.stringify({ course_id: courseId, accepted: true }),
    });
  },
};
