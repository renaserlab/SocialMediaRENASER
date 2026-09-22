import { apiRequest, API_V1 } from '@/services/api';
import type {
  LineaValorable,
  ResenaMinima,
  ResumenDeResenas,
} from '@/lib/resenasDeProductos';

/**
 * Lo que opina quien compró, y lo que se puede hacer con ello.
 *
 * NO MANDA EL SELLO. En el cuerpo de una reseña viajan cinco puntuaciones, un
 * sí/no y un texto. El producto, el pedido, la línea y las dos fechas que
 * verifican la compra las pone el servidor leyendo las filas de verdad, y la
 * base las vuelve a comprobar con tres claves ajenas. Si este fichero las
 * enviara, «compra verificada» sería un campo de formulario.
 *
 * NO HAY NINGÚN MÉTODO QUE MUEVA DINERO, y no es un olvido: una reseña no
 * devuelve nada, no libera nada y no descuenta nada.
 *
 * NO HAY `borrar()`. Moderar es esconder: la fila se queda entera —puntuación,
 * texto y autor— y quien la escribió puede seguir viéndola. Borrarla dejaría a
 * esa persona sin saber qué pasó con lo que escribió.
 *
 * NO HAY NINGÚN MÉTODO DE PROVEEDOR QUE TOQUE LA RESEÑA. Puede responder, y
 * nada más; tampoco existen esas rutas en el servidor.
 */
export type ResenaDeProducto = ResenaMinima & {
  product_id: string;
  author_id: string;
  overall: number;
  quality: number;
  fidelity: number;
  functioning: number;
  value_for_money: number;
  recommends: boolean;
  comment?: string | null;
  updated_at: string;
};

export type MovimientoDeModeracion = {
  id: string;
  review_id?: string | null;
  reply_id?: string | null;
  actor_id?: string | null;
  from_status?: string | null;
  to_status: string;
  reason?: string | null;
  created_at: string;
};

export type CuerpoDeResena = {
  overall: number;
  quality: number;
  fidelity: number;
  functioning: number;
  value_for_money: number;
  recommends: boolean;
  comment: string | null;
};

export const ProductReviewRepository = {
  /** La puntuación de un producto. SIN RESEÑAS VIAJA NULA, no en cero. */
  async resumen(productId: string): Promise<ResumenDeResenas> {
    return apiRequest<ResumenDeResenas>(
      `${API_V1}/products/${productId}/reviews/summary`,
    );
  },

  /**
   * Las reseñas visibles de un producto, de la más nueva a la más vieja.
   *
   * EL CURSOR VA ENTERO O NO VA. Las dos partes —`before` y `before_id`—
   * describen la misma fila; mandar solo una haría que el servidor ignorara el
   * cursor y devolviera otra vez la primera página.
   */
  async listar(
    productId: string,
    opciones?: { before?: string; beforeId?: string; limit?: number },
  ): Promise<ResenaDeProducto[]> {
    const parametros = new URLSearchParams();
    if (opciones?.before && opciones?.beforeId) {
      parametros.set('before', opciones.before);
      parametros.set('before_id', opciones.beforeId);
    }
    if (opciones?.limit) parametros.set('limit', String(opciones.limit));
    const cola = parametros.toString();
    return apiRequest<ResenaDeProducto[]>(
      `${API_V1}/products/${productId}/reviews${cola ? `?${cola}` : ''}`,
    );
  },

  /** Qué puedo valorar de este pedido, y qué ya valoré. */
  async valorables(orderId: string): Promise<LineaValorable[]> {
    return apiRequest<LineaValorable[]>(
      `${API_V1}/products/orders/${orderId}/reviewable`,
    );
  },

  /** Valora una línea que llegó. UNA POR LÍNEA. */
  async valorar(orderItemId: string, cuerpo: CuerpoDeResena): Promise<ResenaDeProducto> {
    return apiRequest<ResenaDeProducto>(
      `${API_V1}/products/order-items/${orderItemId}/review`,
      { method: 'POST', body: JSON.stringify(cuerpo) },
    );
  },

  /** La mía, escondida incluida: tengo derecho a saber qué pasó con ella. */
  async leer(reviewId: string): Promise<ResenaDeProducto> {
    return apiRequest<ResenaDeProducto>(`${API_V1}/products/reviews/${reviewId}`);
  },

  /** Las que escribí. */
  async mias(): Promise<ResenaDeProducto[]> {
    return apiRequest<ResenaDeProducto[]>(`${API_V1}/products/reviews/mine`);
  },

  /** Cambia lo que escribí. NO de qué compra habla. */
  async editar(
    reviewId: string,
    cambios: Partial<CuerpoDeResena>,
  ): Promise<ResenaDeProducto> {
    return apiRequest<ResenaDeProducto>(`${API_V1}/products/reviews/${reviewId}`, {
      method: 'PATCH',
      body: JSON.stringify(cambios),
    });
  },

  /** Lo que opinan de mis productos. */
  async deMiTienda(): Promise<ResenaDeProducto[]> {
    return apiRequest<ResenaDeProducto[]>(`${API_V1}/products/seller/reviews`);
  },

  /** Responde en público. UNA VISIBLE POR RESEÑA. */
  async responder(reviewId: string, body: string): Promise<ResenaDeProducto> {
    return apiRequest<ResenaDeProducto>(
      `${API_V1}/products/seller/reviews/${reviewId}/reply`,
      { method: 'POST', body: JSON.stringify({ body }) },
    );
  },
};

/** Lo que solo puede hacer quien modera. */
export const ProductReviewModerationRepository = {
  /** La cola: las visibles, de la más nueva a la más vieja. */
  async cola(): Promise<ResenaDeProducto[]> {
    return apiRequest<ResenaDeProducto[]>(`${API_V1}/admin/products/reviews`);
  },

  /** Esconde o restaura. NUNCA reescribe. */
  async moderar(
    reviewId: string,
    datos: { hidden: boolean; reason?: string | null },
  ): Promise<ResenaDeProducto> {
    return apiRequest<ResenaDeProducto>(
      `${API_V1}/admin/products/reviews/${reviewId}/moderate`,
      {
        method: 'POST',
        body: JSON.stringify({ hidden: datos.hidden, reason: datos.reason ?? null }),
      },
    );
  },

  /** Lo mismo, para la respuesta del proveedor. */
  async moderarRespuesta(
    replyId: string,
    datos: { hidden: boolean; reason?: string | null },
  ): Promise<ResenaDeProducto> {
    return apiRequest<ResenaDeProducto>(
      `${API_V1}/admin/products/review-replies/${replyId}/moderate`,
      {
        method: 'POST',
        body: JSON.stringify({ hidden: datos.hidden, reason: datos.reason ?? null }),
      },
    );
  },

  /** Qué se hizo con esta reseña y con su respuesta, en orden. */
  async historial(reviewId: string): Promise<MovimientoDeModeracion[]> {
    return apiRequest<MovimientoDeModeracion[]>(
      `${API_V1}/admin/products/reviews/${reviewId}/moderation`,
    );
  },
};
