import { apiRequest, API_V1 } from '@/services/api';
import type {
  EstadoDelProveedor,
  PeticionDePostulacion,
  PeticionDeVersion,
  Postulacion,
  ProductoDelProveedor,
} from '@/lib/proveedorDeProductos';

/**
 * Las diez rutas del PROVEEDOR de productos. Ni una más.
 *
 * SEPARADO DE LO DE ADMINISTRACIÓN A PROPÓSITO, igual que
 * `EventPolicyRepository` se separó del panel de la empresa. Aquí no hay ni un
 * método bajo `/admin/`: quien produce escribe SU postulación y SUS productos, y
 * la admisión —`/admin/products/applications`, `.../evaluations`,
 * `.../publish`— es otra pantalla y otro rol. Que no quepa por descuido es la
 * mitad del trabajo de este fichero.
 *
 * NO EXISTE «PUBLICAR» NI «APROBAR». Y no puede existir: publicar exige una
 * evaluación aprobada de esa versión, sus tres razones respaldadas por
 * evidencia y al menos una fotografía, y lo hace `POST /admin/products/{id}/
 * publish` con rol de administración. Un método aquí acabaría en 403 y, peor,
 * haría creer que el sello de Z se lo pone uno mismo.
 *
 * Y NINGUNA RUTA DE EXISTENCIAS, ENVÍOS, PEDIDOS, INCIDENCIAS NI SALDOS. No
 * están en la API porque no existen todavía.
 *
 * `retirarProducto` devuelve el producto a BORRADOR —es el `withdraw` del
 * contrato— y no lo retira del catálogo: eso es `removed`, y es una decisión de
 * administración.
 */
export const ProductSellerRepository = {
  /** Dónde estoy: sin postular, en revisión, aceptado o rechazado con motivo. */
  async estado(): Promise<EstadoDelProveedor> {
    return apiRequest<EstadoDelProveedor>(`${API_V1}/products/seller/application`);
  },

  /** Escribe o reescribe el borrador de la postulación. UNA VIVA por perfil. */
  async guardarPostulacion(peticion: PeticionDePostulacion): Promise<Postulacion> {
    return apiRequest<Postulacion>(`${API_V1}/products/seller/application`, {
      method: 'PUT',
      body: JSON.stringify(peticion),
    });
  },

  /** La manda a revisión. Después deja de poder cambiarse. */
  async enviarPostulacion(): Promise<Postulacion> {
    return apiRequest<Postulacion>(`${API_V1}/products/seller/application/submit`, {
      method: 'POST',
    });
  },

  /** La retira quien la escribió. Solo antes de que se decida. */
  async retirarPostulacion(): Promise<Postulacion> {
    return apiRequest<Postulacion>(`${API_V1}/products/seller/application/withdraw`, {
      method: 'POST',
    });
  },

  /** Los míos. Lista vacía si todavía no soy responsable comercial. */
  async misProductos(): Promise<ProductoDelProveedor[]> {
    return apiRequest<ProductoDelProveedor[]>(`${API_V1}/products/seller/products`);
  },

  /** Un producto nuevo nace BORRADOR. Crear no es publicar. */
  async crearProducto(peticion: PeticionDeVersion): Promise<ProductoDelProveedor> {
    return apiRequest<ProductoDelProveedor>(`${API_V1}/products/seller/products`, {
      method: 'POST',
      body: JSON.stringify(peticion),
    });
  },

  /** Uno mío, con su borrador, lo publicado, sus acciones y su bloqueo. */
  async producto(productoId: string): Promise<ProductoDelProveedor> {
    return apiRequest<ProductoDelProveedor>(
      `${API_V1}/products/seller/products/${productoId}`,
    );
  },

  /** Reescribe el borrador. SOLO mientras el producto sea editable. */
  async guardarBorrador(
    productoId: string,
    peticion: PeticionDeVersion,
  ): Promise<ProductoDelProveedor> {
    return apiRequest<ProductoDelProveedor>(
      `${API_V1}/products/seller/products/${productoId}/draft`,
      { method: 'PUT', body: JSON.stringify(peticion) },
    );
  },

  /** «Postula tu producto»: lo manda a admisión y deja de ser editable. */
  async postularProducto(productoId: string): Promise<ProductoDelProveedor> {
    return apiRequest<ProductoDelProveedor>(
      `${API_V1}/products/seller/products/${productoId}/submit`,
      { method: 'POST' },
    );
  },

  /** Lo devuelve a borrador. Solo mientras nadie lo haya mirado. */
  async retirarProducto(productoId: string): Promise<ProductoDelProveedor> {
    return apiRequest<ProductoDelProveedor>(
      `${API_V1}/products/seller/products/${productoId}/withdraw`,
      { method: 'POST' },
    );
  },
};
