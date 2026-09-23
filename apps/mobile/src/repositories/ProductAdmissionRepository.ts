import {
  cadenaDeFiltros,
  type DecisionDeEvaluacion,
  type DecisionDePostulacion,
  type EvaluacionRead,
  type EvidenciaRequest,
  type PostulacionRead,
  type ProductoDeAdministracion,
  type ProductoDelProveedor,
  type PuntuacionRequest,
  type RazonRequest,
} from '@/lib/evaluacionDeProductos';
import { apiRequest, API_V1 } from '@/services/api';

/**
 * La admisión y la evaluación de productos, por HTTP y solo por HTTP.
 *
 * CATORCE MÉTODOS, NI UNO MÁS: exactamente las catorce rutas que el servidor publica
 * bajo `/admin/products`. No hay ninguno que borre, ni que edite una evidencia ya
 * registrada, ni que escriba una razón sin evidencia, porque esas rutas no existen.
 *
 * **NINGÚN MÉTODO FINANCIERO.** Aquí no se consulta un saldo, no se transfiere nada y no
 * se toca ningún precio: evaluar un producto no mueve dinero. Si algún día lo mueve, será
 * otro repositorio y otro permiso.
 *
 * LA PUNTUACIÓN VIAJA ENTERA, DE 0 A 100. La ponderación y las centésimas las hace el
 * servidor con el peso de la matriz; este fichero no manda ningún número con coma.
 *
 * QUIÉN PUEDE QUÉ LO DECIDE EL SERVIDOR. Ninguna de estas funciones comprueba un rol:
 * quien no evalúa recibe un 403 con su código, y quien intenta evaluar lo suyo recibe
 * `product_self_review_forbidden`. Adivinarlo aquí sería comodidad, no protección.
 *
 * SIN MOCKS Y SIN SUPABASE. Todo pasa por `apiRequest`, que pone la sesión y traduce los
 * errores a `ApiError` con su `status` y su `code`.
 */

export const ProductAdmissionRepository = {
  /* ----------------------------- Postulaciones ----------------------------- */

  /**
   * La bandeja de postulaciones. Sin `estado`, el servidor devuelve las que esperan.
   *
   * El servidor NO manda cursor: lo que vuelve es «las más recientes hasta este tope».
   */
  async postulaciones(opciones?: {
    estado?: string | null;
    limite?: number;
  }): Promise<PostulacionRead[]> {
    return apiRequest<PostulacionRead[]>(
      `${API_V1}/admin/products/applications?${cadenaDeFiltros(opciones)}`,
    );
  },

  /** «La estoy mirando yo». Se dice para que no la miren dos a la vez. */
  async tomarPostulacion(applicationId: string): Promise<PostulacionRead> {
    return apiRequest<PostulacionRead>(
      `${API_V1}/admin/products/applications/${applicationId}/take`,
      { method: 'POST' },
    );
  },

  /**
   * Acepta o rechaza. Aceptar CREA la capacidad comercial, en la misma transacción.
   *
   * El cuerpo se construye fuera (`revisarDecisionDePostulacion`) para que el motivo de
   * un rechazo esté comprobado antes de salir de la pantalla: el servidor también lo
   * exige, y descubrirlo después de pulsar es trabajo tirado.
   */
  async decidirPostulacion(
    applicationId: string,
    cuerpo: DecisionDePostulacion,
  ): Promise<PostulacionRead> {
    return apiRequest<PostulacionRead>(
      `${API_V1}/admin/products/applications/${applicationId}/decide`,
      { method: 'POST', body: JSON.stringify(cuerpo) },
    );
  },

  /* -------------------------------- Productos ------------------------------- */

  /** El listado administrativo, con quién vende cada producto y qué se puede hacer. */
  async productos(opciones?: {
    estado?: string | null;
    limite?: number;
  }): Promise<ProductoDeAdministracion[]> {
    return apiRequest<ProductoDeAdministracion[]>(
      `${API_V1}/admin/products?${cadenaDeFiltros(opciones)}`,
    );
  },

  /* ------------------------------ Evaluaciones ------------------------------ */

  /** La bandeja de evaluaciones, con su bloqueo y lo que les falta. */
  async evaluaciones(opciones?: {
    estado?: string | null;
    limite?: number;
  }): Promise<EvaluacionRead[]> {
    return apiRequest<EvaluacionRead[]>(
      `${API_V1}/admin/products/evaluations?${cadenaDeFiltros(opciones)}`,
    );
  },

  /** Una evaluación entera: sus puntuaciones, su evidencia y sus razones. */
  async evaluacion(evaluationId: string): Promise<EvaluacionRead> {
    return apiRequest<EvaluacionRead>(
      `${API_V1}/admin/products/evaluations/${evaluationId}`,
    );
  },

  /** Abre la evaluación de esa versión. IDEMPOTENTE: abrir dos veces da la misma. */
  async abrirEvaluacion(versionId: string): Promise<EvaluacionRead> {
    return apiRequest<EvaluacionRead>(
      `${API_V1}/admin/products/versions/${versionId}/evaluation`,
      { method: 'POST' },
    );
  },

  /**
   * Puntúa UNA dimensión, de 0 a 100.
   *
   * El peso lo pone la matriz del servidor y se congela en la fila; aquí solo viaja la
   * nota entera y, si se escribió, el apunte de quien evalúa.
   */
  async puntuar(
    evaluationId: string,
    dimension: string,
    cuerpo: PuntuacionRequest,
  ): Promise<EvaluacionRead> {
    return apiRequest<EvaluacionRead>(
      `${API_V1}/admin/products/evaluations/${evaluationId}/scores/${dimension}`,
      { method: 'PUT', body: JSON.stringify(cuerpo) },
    );
  },

  /** Registra qué se miró. SOLO AÑADIR: una evidencia no se reescribe ni se quita. */
  async registrarEvidencia(
    evaluationId: string,
    cuerpo: EvidenciaRequest,
  ): Promise<EvaluacionRead> {
    return apiRequest<EvaluacionRead>(
      `${API_V1}/admin/products/evaluations/${evaluationId}/evidence`,
      { method: 'POST', body: JSON.stringify(cuerpo) },
    );
  },

  /**
   * Las razones que leerá quien compra. CADA UNA CON SU `evidence_id`.
   *
   * La firma no admite otra forma: no hay parámetro para un texto suelto, así que no se
   * puede mandar una razón que nadie respaldó. Se reemplazan enteras, así que mandar la
   * misma lista dos veces deja lo mismo.
   */
  async elegirRazones(
    evaluationId: string,
    razones: RazonRequest[],
  ): Promise<EvaluacionRead> {
    return apiRequest<EvaluacionRead>(
      `${API_V1}/admin/products/evaluations/${evaluationId}/reasons`,
      { method: 'PUT', body: JSON.stringify({ razones }) },
    );
  },

  /**
   * Cierra la evaluación. LA DECISIÓN LA DA LA MATRIZ, no quien pulsa.
   *
   * Lo único que viaja es si hay una falla crítica —que solo puede acabar en rechazo— y
   * la nota interna. No hay ningún campo `decision` ni `score_total`: eso lo escribe el
   * servidor a partir de lo puntuado.
   */
  async decidirEvaluacion(
    evaluationId: string,
    cuerpo: DecisionDeEvaluacion,
  ): Promise<EvaluacionRead> {
    return apiRequest<EvaluacionRead>(
      `${API_V1}/admin/products/evaluations/${evaluationId}/decide`,
      { method: 'POST', body: JSON.stringify(cuerpo) },
    );
  },

  /* -------------------------- El ciclo del producto ------------------------- */

  /** Mueve el producto por su ciclo. Qué salto existe lo dice la máquina del servidor. */
  async transicionar(
    productId: string,
    hasta: string,
    motivo: string | null = null,
  ): Promise<ProductoDelProveedor> {
    return apiRequest<ProductoDelProveedor>(
      `${API_V1}/admin/products/${productId}/transition`,
      { method: 'POST', body: JSON.stringify({ hasta, motivo }) },
    );
  },

  /**
   * Publica la versión aprobada.
   *
   * SIN CUERPO a propósito: el servidor exige una evaluación aprobada de esa versión,
   * sus tres razones respaldadas y al menos una foto, y nada de eso se puede mandar
   * desde aquí. Si falta algo contesta el código del bloqueo.
   */
  async publicar(productId: string): Promise<ProductoDelProveedor> {
    return apiRequest<ProductoDelProveedor>(
      `${API_V1}/admin/products/${productId}/publish`,
      { method: 'POST' },
    );
  },

  /**
   * Lo saca del catálogo, CON MOTIVO. Suspender no es retirar.
   *
   * El motivo es obligatorio en la firma porque lo es en la práctica: el servidor lo
   * exige (`product_suspension_needs_reason`) y quien vende tiene que poder leerlo.
   */
  async suspender(productId: string, motivo: string): Promise<ProductoDelProveedor> {
    return apiRequest<ProductoDelProveedor>(
      `${API_V1}/admin/products/${productId}/suspend`,
      { method: 'POST', body: JSON.stringify({ motivo }) },
    );
  },
};
