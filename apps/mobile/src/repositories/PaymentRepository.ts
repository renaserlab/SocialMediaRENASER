import { apiRequest, API_V1 } from '@/services/api';

/**
 * Portal de pagos de los cursos.
 *
 * **Listo para conectar, sin usar todavia.** Ninguna pantalla llama a esto:
 * `FEATURE_PURCHASES` sigue en `false` y la interfaz no muestra precios ni
 * botones de compra.
 *
 * ## Por que la compra NO ocurre dentro de la app
 *
 * Vender contenido digital dentro de una aplicacion obliga a usar las compras
 * integradas de Apple y la facturacion de Google Play, con su comision. El
 * cobro se hace en la WEB para evitarla, que es el modelo de Netflix.
 *
 * A cambio, la app movil no puede mostrar precios, botones de compra ni
 * enlaces al checkout (directriz 3.1.1 de Apple). Por eso `startCheckout` esta
 * pensado para la version WEB de la aplicacion, no para el movil.
 *
 * En el movil solo tiene sentido `hasAccess()`: mirar si se puede ver el
 * contenido, sin explicar como se compra.
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
