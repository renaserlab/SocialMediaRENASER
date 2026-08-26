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
