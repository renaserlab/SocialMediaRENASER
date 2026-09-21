import { apiRequest, API_V1 } from '@/services/api';
import type { Incidencia, ResumenDeIncidencia } from '@/lib/incidencias';

/**
 * El expediente de algo que llegó mal: abrirlo, probarlo y seguirlo.
 *
 * NO HAY NINGÚN MÉTODO QUE MUEVA DINERO, y no es un olvido: en esta versión no
 * se ejecuta ningún reembolso, ninguna reposición y ninguna transferencia. Una
 * resolución dice QUÉ se decidió; ejecutarla es del Incremento 9. Un método
 * aquí llamado `reembolsar()` sería ofrecer algo que no ocurre.
 *
 * NO HAY `borrarPrueba()`. Retirar una fotografía después de que la otra parte
 * la haya visto es reescribir lo que se discutió; lo impide además un
 * disparador de la base.
 *
 * EL ARCHIVO VIAJA A LA API, no al almacenamiento: el depósito
 * `product-incidents` es privado y no tiene ninguna política. El servidor
 * decide el nombre —el que trae quien sube puede llevar `../`—, mira los bytes
 * de verdad y guarda.
 */
export const ProductIncidentRepository = {
  /** Mis casos, los más nuevos primero. SIN LA DESCRIPCIÓN. */
  async mios(): Promise<ResumenDeIncidencia[]> {
    return apiRequest<ResumenDeIncidencia[]>(`${API_V1}/products/incidents`);
  },

  /** Uno de mis casos, entero. */
  async leer(incidentId: string): Promise<Incidencia> {
    return apiRequest<Incidencia>(`${API_V1}/products/incidents/${incidentId}`);
  },

  /**
   * Abre un caso sobre un pedido entregado. ABRIR NO ES APROBAR NADA.
   *
   * EL CASO NACE SIN PRUEBAS Y SIN PLAZO CORRIENDO: se abre, se le cuelgan las
   * fotografías y se **envía**, que es cuando el proveedor recibe el aviso y
   * cuando empiezan a correr sus 48 horas.
   *
   * `orderItemId` va nulo SOLO para la entrega negada: no hay una línea
   * concreta de la que quejarse porque no llegó nada.
   */
  async abrir(
    orderId: string,
    datos: { reason: string; description: string; orderItemId?: string | null },
  ): Promise<Incidencia> {
    return apiRequest<Incidencia>(`${API_V1}/products/orders/${orderId}/incidents`, {
      method: 'POST',
      body: JSON.stringify({
        reason: datos.reason,
        description: datos.description,
        order_item_id: datos.orderItemId ?? null,
      }),
    });
  },

  /** Cuelga una fotografía del expediente. SOLO SE AÑADE, Y NO SE QUITA. */
  async anadirPrueba(
    incidentId: string,
    opciones: { archivo: Blob | File; nombre: string; caption?: string | null },
  ): Promise<Incidencia> {
    const formulario = new FormData();
    formulario.append('archivo', opciones.archivo as Blob, opciones.nombre);
    if ((opciones.caption ?? '').trim() !== '') {
      formulario.append('caption', (opciones.caption as string).trim());
    }
    return apiRequest<Incidencia>(
      `${API_V1}/products/incidents/${incidentId}/evidence`,
      {
        method: 'POST',
        body: formulario,
        // Igual que en el catálogo: un archivo tarda más que una respuesta
        // normal, y cortarlo a los veinte segundos dejaría a medias una
        // subida que iba bien.
        timeoutMs: 120_000,
      },
    );
  },

  /** Manda el caso al proveedor. AQUÍ ARRANCA SU PLAZO DE 48 HORAS. */
  async enviar(incidentId: string): Promise<Incidencia> {
    return apiRequest<Incidencia>(
      `${API_V1}/products/incidents/${incidentId}/submit`,
      { method: 'POST' },
    );
  },

  /** Aporto la evidencia que me pidieron. El reloj del proveedor vuelve a correr. */
  async responder(incidentId: string, note: string): Promise<Incidencia> {
    return apiRequest<Incidencia>(
      `${API_V1}/products/incidents/${incidentId}/reply`,
      { method: 'POST', body: JSON.stringify({ note }) },
    );
  },

  /** Pido que lo mire Z. NO PROMETE UNA FECHA: no hay plazo calculable. */
  async escalar(incidentId: string, note: string): Promise<Incidencia> {
    return apiRequest<Incidencia>(
      `${API_V1}/products/incidents/${incidentId}/escalate`,
      { method: 'POST', body: JSON.stringify({ note }) },
    );
  },

  /** Apelo la decisión. UNA SOLA VEZ, en plazo y con evidencia NUEVA. */
  async apelar(incidentId: string, note: string): Promise<Incidencia> {
    return apiRequest<Incidencia>(
      `${API_V1}/products/incidents/${incidentId}/appeal`,
      { method: 'POST', body: JSON.stringify({ note }) },
    );
  },

  /** Retiro mi reclamación. Solo antes de que se resuelva, y con motivo. */
  async retirar(incidentId: string, note: string): Promise<Incidencia> {
    return apiRequest<Incidencia>(
      `${API_V1}/products/incidents/${incidentId}/withdraw`,
      { method: 'POST', body: JSON.stringify({ note }) },
    );
  },
};

/**
 * Lo que quien vende puede hacer con un caso de su tienda.
 *
 * NO HAY `resolver()`, Y ES LA REGLA CENTRAL DEL INCREMENTO. Las cinco salidas
 * mueven dinero, mueven mercancía o niegan la reclamación, y ninguna de las
 * tres la decide en solitario quien tiene el conflicto. El proveedor PROPONE;
 * resolver es de Z. En el servidor tampoco existe esa ruta: hay una prueba que
 * comprueba que ninguna ruta de proveedor termina en `/resolve`.
 */
export const ProductIncidentSellerRepository = {
  /** Los casos de mi tienda, los más nuevos primero. SIN LA DESCRIPCIÓN. */
  async mios(): Promise<ResumenDeIncidencia[]> {
    return apiRequest<ResumenDeIncidencia[]>(
      `${API_V1}/products/seller/incidents`,
    );
  },

  /** Uno de los casos de mi tienda, entero. */
  async leer(incidentId: string): Promise<Incidencia> {
    return apiRequest<Incidencia>(
      `${API_V1}/products/seller/incidents/${incidentId}`,
    );
  },

  /**
   * Lo que PROPONGO. Proponer no es resolver: lo registra Z después.
   *
   * `proposal` es una de las cinco salidas del blueprint. Pedir más evidencia
   * NO va por aquí: es otro paso, y para el reloj.
   */
  async proponer(
    incidentId: string,
    datos: { proposal: string; note?: string | null },
  ): Promise<Incidencia> {
    return apiRequest<Incidencia>(
      `${API_V1}/products/seller/incidents/${incidentId}/respond`,
      {
        method: 'POST',
        body: JSON.stringify({
          proposal: datos.proposal,
          note: (datos.note ?? '').trim() || null,
        }),
      },
    );
  },

  /** Pido más evidencia. CON MOTIVO, y MI PLAZO SE PARA mientras llega. */
  async pedirMasEvidencia(incidentId: string, note: string): Promise<Incidencia> {
    return apiRequest<Incidencia>(
      `${API_V1}/products/seller/incidents/${incidentId}/request-evidence`,
      { method: 'POST', body: JSON.stringify({ note }) },
    );
  },
};

/**
 * Lo que administración puede hacer con los casos.
 *
 * RESOLVER ES SOLO DE `admin`, NO DE `is_admin`: moderación cura contenido, y
 * decidir sobre dinero y sobre mercancía es el mismo conjunto estrecho que ya
 * decide quién publica y quién ajusta existencias. El servidor contesta 403 a
 * moderación y hay una prueba que lo ejecuta por HTTP.
 *
 * Y RESOLVER NO ES PAGAR. `resolver()` registra qué se decidió y deja el efecto
 * financiero PENDIENTE. Nadie lo ejecuta en esta versión.
 */
export const ProductIncidentAdminRepository = {
  /** La cola: los casos que esperan a Z. */
  async cola(): Promise<ResumenDeIncidencia[]> {
    return apiRequest<ResumenDeIncidencia[]>(`${API_V1}/admin/products/incidents`);
  },

  /** Un caso entero, para decidirlo. */
  async leer(incidentId: string): Promise<Incidencia> {
    return apiRequest<Incidencia>(
      `${API_V1}/admin/products/incidents/${incidentId}`,
    );
  },

  /**
   * Registra la decisión. CON MOTIVO, siempre.
   *
   * `resolution` NUNCA es `REQUEST_MORE_EVIDENCE`: pedir más evidencia es un
   * paso y no un desenlace, y contarlo como resuelto daría un número falso.
   */
  async resolver(
    incidentId: string,
    datos: { resolution: string; note: string },
  ): Promise<Incidencia> {
    return apiRequest<Incidencia>(
      `${API_V1}/admin/products/incidents/${incidentId}/resolve`,
      {
        method: 'POST',
        body: JSON.stringify({ resolution: datos.resolution, note: datos.note }),
      },
    );
  },

  /**
   * Manda a mediación los casos cuyo plazo venció. IDEMPOTENTE.
   *
   * NO ES UN TEMPORIZADOR DENTRO DE LA API: la API puede correr con varias
   * réplicas. Esta ruta está preparada para un planificador externo, y hasta
   * que exista se lanza a mano desde esta pantalla.
   */
  async escalarVencidas(): Promise<{ escalated: number }> {
    return apiRequest<{ escalated: number }>(
      `${API_V1}/admin/products/incidents/escalate-overdue`,
      { method: 'POST' },
    );
  },
};
