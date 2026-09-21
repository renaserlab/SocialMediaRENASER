/**
 * El proveedor de Productos Z, ejecutado.
 *
 * Lo que se prueba aquí es lo que se rompe sin que se note mirando la
 * aplicación, y lo que le cuesta dinero o reputación a otra persona cuando se
 * rompe:
 *
 *  1. UN CAMPO CON VALOR DE PARTIDA. `price_minor: 0` precargado es «este
 *     producto es gratis», decidido por la aplicación y firmado por quien
 *     produce sin enterarse. Se comprueba que los dos formularios nacen vacíos,
 *     que lo que nadie escribió NO VIAJA en la petición, y que un precio nulo no
 *     se cuenta nunca como cero.
 *  2. UN PRECIO SIN MONEDA. Lo rechaza un CHECK de la 0070 y lo rechaza
 *     `_exigir_textos`; si aquí pasara, la persona rellena la ficha entera para
 *     que se la tiren. Se comprueba en las dos direcciones.
 *  3. UN BOTÓN DE EDITAR SOBRE ALGO QUE YA SE ESTÁ EVALUANDO. `states.EDITABLES`
 *     es `{draft}`: editar después cambia el objeto de la evaluación a mitad de
 *     camino y el sello acabaría puesto sobre un texto que el evaluador no vio.
 *     Se comprueba estado por estado, los once.
 *  4. UN VALIDADOR QUE NO COINCIDE CON EL SERVIDOR. Si aquí se acepta lo que
 *     allí se rechaza, el formulario vuelve rechazado; si aquí se rechaza lo que
 *     allí se acepta, nos hemos inventado una regla de negocio. La tabla está
 *     transcrita de `_exigir_textos`, `_exigir_variantes` y
 *     `_exigir_documentos`. `_exigir_galeria` YA NO ESTÁ en ninguno de los dos
 *     lados: ver el punto 5.
 *  5. UNA FOTOGRAFÍA QUE SE TECLEA. La pantalla tuvo un editor donde se
 *     escribía A MANO la ruta del almacenamiento de cada foto, y se mandaba en
 *     `gallery`. `VersionRequest` ya no tiene ese campo: Pydantic descartaba la
 *     clave SIN ERROR, así que quien vendía recibía un 200 y no se guardaba
 *     nada; y una ruta escrita a mano podía apuntar a un archivo ajeno o a
 *     ninguno, que es justo lo que vino a cerrar la 0073. Aquí se comprueba, YA
 *     EJECUTANDO Y SOBRE EL CÓDIGO DE LA PANTALLA, que ni el campo ni `gallery`
 *     vuelven.
 *  6. UN BOTÓN SIN RUTA. La máquina permite `(draft, removed)` al proveedor,
 *     pero no hay ninguna ruta suya que lo haga: pintarlo sería una promesa.
 *  7. EL LENGUAJE DEL BLUEPRINT. Las cinco frases obligatorias tienen que estar
 *     escritas, y las cinco prohibidas no pueden aparecer en ningún diccionario.
 *     Es lo que separa «Postula tu producto» de «Hazte vendedor».
 *
 * Las últimas se comprueban además sobre el CÓDIGO de las pantallas y sobre los
 * DICCIONARIOS, porque no son funciones: son lo que está escrito.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { es } from '../i18n/es.ts';
import { en } from '../i18n/en.ts';
import { pt } from '../i18n/pt.ts';
import {
  ACCIONES_CON_RUTA,
  BLOQUEOS,
  CODIGOS_LOCALES,
  DOCUMENTOS,
  ESTADOS_DE_POSTULACION,
  ESTADOS_DE_PRODUCTO,
  ESTADOS_DE_VENDEDOR,
  FORMATO_DEL_SKU,
  LARGO_DEL_FABRICANTE,
  LARGO_DEL_NOMBRE,
  LARGO_DEL_NOMBRE_DEL_PRODUCTO,
  LARGO_DEL_RESUMEN,
  LARGO_DE_LA_DESCRIPCION,
  LARGO_DE_LA_NOTA,
  LARGO_DE_LA_PROPUESTA,
  LARGO_DE_LA_RUTA,
  LARGO_DE_LA_VERSION,
  LARGO_DE_LOS_MATERIALES,
  MAXIMO_DE_DOCUMENTOS,
  MAXIMO_DE_VARIANTES,
  POSTULACIONES_VIVAS,
  PRODUCTOS_EDITABLES,
  accionesOfrecidas,
  claveDeAccionDeProducto,
  claveDeErrorDeProveedor,
  claveDeErrorPorEstado,
  claveDeFallo,
  claveDeLaSituacion,
  claveDelBloqueo,
  claveDelCuerpoDeLaSituacion,
  claveDelCuerpoDelEstadoDePostulacion,
  claveDelCuerpoDelEstadoDeProducto,
  claveDelEstadoDePostulacion,
  claveDelEstadoDeProducto,
  claveDelEstadoDelVendedor,
  claveDelTipoDeDocumento,
  documentoVacio,
  esProductosApagado,
  esProveedorActivo,
  esRutaDeAlmacenamiento,
  etiquetaDeVersion,
  fechaLegible,
  formularioDePostulacionDesde,
  formularioDePostulacionVacio,
  formularioDeProductoDesde,
  formularioDeProductoVacio,
  hayAlgoEscrito,
  hayQueRecargar,
  motivoDeLaDecision,
  opcionVacia,
  opcionesUtiles,
  peticionDePostulacion,
  peticionDeVersion,
  precioLegible,
  rutaDelProveedor,
  sePuedeEditarProducto,
  sePuedeEnviarPostulacion,
  sePuedeEscribirPostulacion,
  sePuedeGuardarPostulacion,
  sePuedeGuardarProducto,
  sePuedePostularProducto,
  sePuedeRetirarPostulacion,
  sePuedeRetirarProducto,
  situacionDelProveedor,
  validarPostulacion,
  validarProducto,
  varianteVacia,
  versionEnBorrador,
  versionQueSeEnsena,
  type EstadoDelProveedor,
  type Fallo,
  type FormularioDeProducto,
  type Postulacion,
  type ProductoDelProveedor,
  type Version,
} from './proveedorDeProductos.ts';

const AQUI = fileURLToPath(new URL('.', import.meta.url));

function fuente(carpeta: string, nombre: string): string {
  return readFileSync(join(AQUI, '..', carpeta, nombre), 'utf8');
}

/** El código sin comentarios: lo que la pantalla HACE, no lo que explica. */
function sinComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((linea) => !linea.trim().startsWith('//'))
    .join('\n');
}

const codigosDe = (fallos: Fallo[]) => fallos.map((x) => x.codigo).sort();

/** Una propuesta que cumple el mínimo del servidor (20 caracteres). */
const PROPUESTA = 'Hago cerámica a mano en Ayacucho, pieza por pieza.';

function postulacion(campos: Partial<Postulacion> = {}): Postulacion {
  return {
    id: 'postulacion-1',
    status: 'draft',
    display_name: 'Taller Ayacucho',
    proposal: PROPUESTA,
    submitted_at: null,
    decided_at: null,
    decision_reason: null,
    documents: [],
    ...campos,
  };
}

function estadoCon(campos: Partial<EstadoDelProveedor> = {}): EstadoDelProveedor {
  return {
    seller_status: null,
    seller_id: null,
    application: null,
    puede_postular: true,
    disponible: true,
    ...campos,
  };
}

function version(campos: Partial<Version> = {}): Version {
  return {
    id: 'version-1',
    version: '1',
    status: 'draft',
    name: 'Tinaja de barro',
    summary: null,
    description: null,
    materials: null,
    origin_country: null,
    manufacturer: null,
    price_minor: null,
    currency: null,
    content_sha256: 'a'.repeat(64),
    published_at: null,
    effective_to: null,
    variants: [],
    gallery: [],
    ...campos,
  };
}

function producto(campos: Partial<ProductoDelProveedor> = {}): ProductoDelProveedor {
  return {
    id: 'producto-1',
    status: 'draft',
    category_id: null,
    published_at: null,
    suspension_reason: null,
    created_at: '2026-01-01T00:00:00Z',
    draft: version(),
    published: null,
    acciones: [],
    bloqueo: null,
    ...campos,
  };
}

/** Un formulario de producto con lo mínimo para poder guardarlo. */
function conNombre(nombre = 'Tinaja de barro'): FormularioDeProducto {
  return { ...formularioDeProductoVacio(), nombre };
}

/* ========================================================================== */
describe('los formularios nacen vacíos', () => {
  it('la postulación no trae nombre, ni propuesta, ni un solo documento', () => {
    const vacio = formularioDePostulacionVacio();
    assert.equal(vacio.nombre, '');
    assert.equal(vacio.propuesta, '');
    // NI UN DOCUMENTO SUGERIDO: qué papeles exige la empresa depende del país y
    // de la entidad legal, y eso no está decidido.
    assert.deepEqual(vacio.documentos, []);
  });

  it('el producto no trae ni precio, ni moneda, ni versión, ni variantes', () => {
    const vacio = formularioDeProductoVacio();
    assert.equal(vacio.precio, '');
    assert.equal(vacio.moneda, '');
    assert.equal(vacio.version, '');
    assert.equal(vacio.nombre, '');
    assert.equal(vacio.resumen, '');
    assert.equal(vacio.descripcion, '');
    assert.equal(vacio.materiales, '');
    assert.equal(vacio.pais, '');
    assert.equal(vacio.fabricante, '');
    assert.deepEqual(vacio.variantes, []);
    // SIN `galeria`: ya no es un campo del formulario. Que la clave no exista
    // es lo que impide que alguien vuelva a rellenarla sin darse cuenta.
    assert.ok(!('galeria' in vacio));
  });

  it('NINGÚN campo del producto nace con un cero escrito', () => {
    // Un `0` en `precio` es «gratis» y un `0` en `diferencia` es un precio
    // decidido. Los dos serían decisiones de la aplicación.
    const vacio = formularioDeProductoVacio();
    for (const [campo, valor] of Object.entries(vacio)) {
      if (Array.isArray(valor)) continue;
      assert.notEqual(valor, '0', campo);
      assert.equal(valor, '', campo);
    }
  });

  it('una variante nueva y un documento nuevo también nacen vacíos', () => {
    // `fotoVacia()` SALIÓ DE AQUÍ con el editor de galería: una fotografía ya
    // no se escribe en este formulario, se sube en su propia pantalla.
    assert.deepEqual(varianteVacia(), { sku: '', nombre: '', opciones: [], diferencia: '' });
    assert.deepEqual(opcionVacia(), { clave: '', valor: '' });
    assert.deepEqual(documentoVacio(), { kind: '', ruta: '', nota: '' });
  });

  it('un documento nuevo no trae ningún tipo elegido', () => {
    assert.equal(documentoVacio().kind, '');
    assert.ok(!(DOCUMENTOS as readonly string[]).includes(documentoVacio().kind));
  });

  it('cargar un borrador no rellena lo que ese borrador no trae', () => {
    const formulario = formularioDeProductoDesde(version({ summary: 'Una tinaja.' }));
    assert.equal(formulario.resumen, 'Una tinaja.');
    assert.equal(formulario.descripcion, '');
    assert.equal(formulario.materiales, '');
    assert.equal(formulario.pais, '');
    assert.equal(formulario.fabricante, '');
  });

  it('un precio nulo en el servidor deja el campo en blanco, NO en cero', () => {
    // Escribir «0» aquí convertiría «sin precio configurado» en «gratis» en
    // cuanto alguien pulsara guardar sin tocar nada.
    const formulario = formularioDeProductoDesde(version({ price_minor: null }));
    assert.equal(formulario.precio, '');
    assert.equal(formulario.moneda, '');
  });

  it('un precio de cero SÍ se carga como cero: alguien lo escribió', () => {
    const formulario = formularioDeProductoDesde(
      version({ price_minor: 0, currency: 'PEN' }),
    );
    assert.equal(formulario.precio, '0');
    assert.equal(formulario.moneda, 'PEN');
  });

  it('la postulación se carga tal cual, documentos incluidos', () => {
    const formulario = formularioDePostulacionDesde(
      postulacion({
        documents: [
          { id: 'd1', kind: 'identity', storage_path: 'carpeta/dni.pdf', note: null },
          { id: 'd2', kind: 'permits', storage_path: null, note: 'Lo pedí en marzo.' },
        ],
      }),
    );
    assert.equal(formulario.nombre, 'Taller Ayacucho');
    assert.deepEqual(formulario.documentos[0], {
      kind: 'identity',
      ruta: 'carpeta/dni.pdf',
      nota: '',
    });
    assert.deepEqual(formulario.documentos[1], {
      kind: 'permits',
      ruta: '',
      nota: 'Lo pedí en marzo.',
    });
  });
});

/* ========================================================================== */
describe('lo que no se escribió no viaja', () => {
  it('un producto con solo el nombre manda SOLO el nombre', () => {
    const { peticion, fallos } = peticionDeVersion(conNombre());
    assert.deepEqual(fallos, []);
    assert.deepEqual(peticion, { name: 'Tinaja de barro' });
  });

  it('ni `price_minor`, ni `currency`, ni `summary` aparecen como nulos', () => {
    const { peticion } = peticionDeVersion(conNombre());
    for (const clave of [
      'price_minor',
      'currency',
      'summary',
      'description',
      'materials',
      'origin_country',
      'manufacturer',
      'version',
    ]) {
      assert.ok(!(clave in (peticion ?? {})), `${clave} viaja sin haberse escrito`);
    }
  });

  it('las listas vacías tampoco viajan, y `gallery` no viaja nunca', () => {
    const { peticion } = peticionDeVersion(conNombre());
    assert.ok(!('variants' in (peticion ?? {})));
    // `gallery` NO ES UNA LISTA VACÍA: es una clave que el servidor ya no lee.
    assert.ok(!('gallery' in (peticion ?? {})));
  });

  it('un campo con solo espacios se cuenta como no escrito', () => {
    const { peticion } = peticionDeVersion({ ...conNombre(), resumen: '   ', pais: '  ' });
    assert.deepEqual(peticion, { name: 'Tinaja de barro' });
  });

  it('lo que sí se escribe viaja recortado, y el país y la moneda en mayúsculas', () => {
    const { peticion } = peticionDeVersion({
      ...conNombre(),
      resumen: '  Una tinaja hecha a mano.  ',
      pais: 'pe',
      precio: '4990',
      moneda: 'pen',
      version: ' 2 ',
    });
    assert.equal(peticion?.summary, 'Una tinaja hecha a mano.');
    assert.equal(peticion?.origin_country, 'PE');
    assert.equal(peticion?.currency, 'PEN');
    assert.equal(peticion?.price_minor, 4990);
    assert.equal(peticion?.version, '2');
  });

  it('un documento con nota y sin archivo manda `note` y nada más', () => {
    const { peticion } = peticionDePostulacion({
      nombre: 'Taller Ayacucho',
      propuesta: PROPUESTA,
      documentos: [{ kind: 'permits', ruta: '', nota: 'Lo pedí en marzo.' }],
    });
    assert.deepEqual(peticion?.documents, [
      { kind: 'permits', note: 'Lo pedí en marzo.' },
    ]);
  });

  it('un documento con archivo y sin nota manda `storage_path` y nada más', () => {
    const { peticion } = peticionDePostulacion({
      nombre: 'Taller Ayacucho',
      propuesta: PROPUESTA,
      documentos: [{ kind: 'identity', ruta: 'carpeta/dni.pdf', nota: '  ' }],
    });
    assert.deepEqual(peticion?.documents, [
      { kind: 'identity', storage_path: 'carpeta/dni.pdf' },
    ]);
  });

  it('una postulación sin documentos manda la lista vacía, no claves sueltas', () => {
    const { peticion } = peticionDePostulacion({
      nombre: 'Taller Ayacucho',
      propuesta: `  ${PROPUESTA}  `,
      documentos: [],
    });
    assert.deepEqual(peticion, {
      display_name: 'Taller Ayacucho',
      proposal: PROPUESTA,
      documents: [],
    });
  });

  it('una petición con fallos no se construye: devuelve `null`', () => {
    assert.equal(peticionDeVersion(formularioDeProductoVacio()).peticion, null);
    assert.equal(peticionDePostulacion(formularioDePostulacionVacio()).peticion, null);
  });

  it('las opciones sin clave se caen, y las escritas viajan como texto', () => {
    assert.deepEqual(
      opcionesUtiles([
        { clave: 'talla', valor: '38' },
        { clave: '  ', valor: 'huérfano' },
        { clave: ' color ', valor: ' rojo ' },
      ]),
      { talla: '38', color: 'rojo' },
    );
  });

  it('una diferencia de precio en blanco viaja como cero, como en el servidor', () => {
    // `v.get("price_delta_minor") or 0`. No es un precio: es una diferencia, y
    // «sin diferencia» y «cero de diferencia» son lo mismo.
    const { peticion } = peticionDeVersion({
      ...conNombre(),
      variantes: [{ sku: 'TIN-38', nombre: 'Mediana', opciones: [], diferencia: '' }],
    });
    assert.equal(peticion?.variants?.[0]?.price_delta_minor, 0);
  });

  /*
    ESTA PRUEBA DECÍA LO CONTRARIO. Comprobaba que una foto tecleada viajaba
    como `{ storage_path, kind: 'image' }`. Se ha dado la vuelta en vez de
    borrarla: lo que antes era el comportamiento correcto es hoy el defecto, y
    una prueba que solo desaparece no impide que el defecto vuelva.

    Se fuerza a propósito un formulario con `galeria` —el tipo ya no la tiene,
    de ahí el molde— porque lo que hay que asegurar es que NI SIQUIERA ASÍ se
    construye `gallery`: el servidor no lee ese campo y mandarlo devolvía un 200
    sobre unas rutas que se perdían por el camino.
  */
  it('una foto NO viaja: `gallery` no se construye nunca', () => {
    const conGaleria = {
      ...conNombre(),
      galeria: [{ ruta: 'productos/tinaja.jpg', alternativo: 'Una tinaja.' }],
    } as unknown as FormularioDeProducto;
    const { peticion, fallos } = peticionDeVersion(conGaleria);
    assert.deepEqual(fallos, []);
    assert.ok(!('gallery' in (peticion ?? {})));
    assert.deepEqual(peticion, { name: 'Tinaja de barro' });
  });
});

/* ========================================================================== */
describe('el precio va con su moneda o no va', () => {
  it('los dos en blanco es válido: el producto queda sin precio', () => {
    assert.deepEqual(validarProducto(conNombre()), []);
  });

  it('un precio sin moneda se rechaza, igual que en el servidor', () => {
    const fallos = validarProducto({ ...conNombre(), precio: '4990' });
    assert.ok(fallos.some((x) => x.codigo === 'product_price_without_currency'));
    assert.equal(peticionDeVersion({ ...conNombre(), precio: '4990' }).peticion, null);
  });

  it('una moneda sin precio se rechaza igual', () => {
    const fallos = validarProducto({ ...conNombre(), moneda: 'PEN' });
    assert.ok(fallos.some((x) => x.codigo === 'product_price_without_currency'));
  });

  it('un precio de CERO con su moneda es válido: es una decisión escrita', () => {
    const formulario = { ...conNombre(), precio: '0', moneda: 'PEN' };
    assert.deepEqual(validarProducto(formulario), []);
    assert.equal(peticionDeVersion(formulario).peticion?.price_minor, 0);
  });

  it('un precio negativo se rechaza', () => {
    assert.ok(
      codigosDe(validarProducto({ ...conNombre(), precio: '-1', moneda: 'PEN' })).includes(
        'product_price_invalid',
      ),
    );
  });

  it('un precio con decimales se rechaza: el contrato pide un entero', () => {
    for (const escrito of ['49.90', '49,90', '4e3', 'mucho']) {
      assert.ok(
        codigosDe(
          validarProducto({ ...conNombre(), precio: escrito, moneda: 'PEN' }),
        ).includes('product_price_invalid'),
        escrito,
      );
    }
  });

  it('una moneda que no son tres letras se rechaza', () => {
    for (const escrito of ['PE', 'PENN', 'PE1', '###']) {
      assert.ok(
        codigosDe(
          validarProducto({ ...conNombre(), precio: '100', moneda: escrito }),
        ).includes('product_currency_invalid'),
        escrito,
      );
    }
  });

  it('el precio nunca se convierte a la unidad mayor al enseñarlo', () => {
    // Cuántos decimales tiene una moneda depende de la moneda —el yen no tiene
    // ninguno— y el servidor no manda ese dato. Se enseña como se escribió.
    assert.equal(precioLegible(version({ price_minor: 4990, currency: 'pen' })), '4990 PEN');
    assert.equal(precioLegible(version({ price_minor: 0, currency: 'PEN' })), '0 PEN');
  });

  it('sin precio configurado NO se enseña «gratis» ni un cero', () => {
    assert.equal(precioLegible(version({ price_minor: null, currency: null })), null);
    assert.equal(precioLegible(null), null);
    // Un servidor que mandara medio precio tampoco puede producir un importe.
    assert.equal(precioLegible(version({ price_minor: 4990, currency: null })), null);
    assert.equal(precioLegible(version({ price_minor: null, currency: 'PEN' })), null);
  });
});

/* ========================================================================== */
describe('el validador del producto dice lo mismo que el servidor', () => {
  it('sin nombre no se guarda, y el código es el del servidor', () => {
    const fallo = validarProducto(formularioDeProductoVacio())[0];
    assert.equal(fallo?.codigo, 'product_name_required');
    assert.equal(fallo?.campo, 'nombre');
  });

  it('un nombre de dos letras está fuera de rango, no «falta»', () => {
    const fallo = validarProducto(conNombre('ab'))[0];
    assert.equal(fallo?.codigo, 'product_field_out_of_range');
    assert.equal(fallo?.min, LARGO_DEL_NOMBRE_DEL_PRODUCTO[0]);
    assert.equal(fallo?.max, LARGO_DEL_NOMBRE_DEL_PRODUCTO[1]);
  });

  it('el nombre al límite se acepta, y uno más se rechaza', () => {
    assert.deepEqual(validarProducto(conNombre('x'.repeat(140))), []);
    assert.ok(
      codigosDe(validarProducto(conNombre('x'.repeat(141)))).includes(
        'product_field_out_of_range',
      ),
    );
  });

  it('los topes de los textos son los de `service.LARGOS`', () => {
    const TABLA: Array<[keyof FormularioDeProducto, number]> = [
      ['resumen', LARGO_DEL_RESUMEN],
      ['descripcion', LARGO_DE_LA_DESCRIPCION],
      ['materiales', LARGO_DE_LOS_MATERIALES],
    ];
    for (const [campo, tope] of TABLA) {
      assert.deepEqual(validarProducto({ ...conNombre(), [campo]: 'x'.repeat(tope) }), [], campo);
      assert.ok(
        codigosDe(validarProducto({ ...conNombre(), [campo]: 'x'.repeat(tope + 1) })).includes(
          'product_field_out_of_range',
        ),
        campo,
      );
    }
    assert.equal(LARGO_DEL_RESUMEN, 300);
    assert.equal(LARGO_DE_LA_DESCRIPCION, 8_000);
    assert.equal(LARGO_DE_LOS_MATERIALES, 2_000);
  });

  it('el fabricante vacío NO es un fallo, pero uno de una letra sí', () => {
    // `service.LARGOS['manufacturer']` es `(2, 160)`, y vacío se guarda nulo.
    assert.deepEqual(validarProducto({ ...conNombre(), fabricante: '' }), []);
    assert.ok(
      codigosDe(validarProducto({ ...conNombre(), fabricante: 'x' })).includes(
        'product_field_out_of_range',
      ),
    );
    assert.deepEqual(validarProducto({ ...conNombre(), fabricante: 'xx' }), []);
    assert.equal(LARGO_DEL_FABRICANTE[0], 2);
    assert.equal(LARGO_DEL_FABRICANTE[1], 160);
  });

  it('el país de origen son dos letras y nada más', () => {
    assert.deepEqual(validarProducto({ ...conNombre(), pais: 'pe' }), []);
    for (const escrito of ['p', 'per', 'p1', '12']) {
      assert.ok(
        codigosDe(validarProducto({ ...conNombre(), pais: escrito })).includes(
          'product_country_invalid',
        ),
        escrito,
      );
    }
  });

  it('el nombre de la versión no pasa de lo que cabe en la columna', () => {
    assert.deepEqual(validarProducto({ ...conNombre(), version: 'x'.repeat(32) }), []);
    const fallo = validarProducto({ ...conNombre(), version: 'x'.repeat(33) })[0];
    assert.equal(fallo?.codigo, 'product_version_label_too_long');
    assert.equal(fallo?.max, LARGO_DE_LA_VERSION);
  });

  it('una variante necesita SKU y nombre', () => {
    for (const variante of [
      { sku: '', nombre: 'Mediana', opciones: [], diferencia: '' },
      { sku: 'TIN-38', nombre: '', opciones: [], diferencia: '' },
      { sku: '', nombre: '', opciones: [], diferencia: '' },
    ]) {
      assert.ok(
        codigosDe(validarProducto({ ...conNombre(), variantes: [variante] })).includes(
          'product_variant_incomplete',
        ),
      );
    }
  });

  it('el SKU es el del CHECK de la 0070, letra por letra', () => {
    for (const bueno of ['ab', 'TIN-38', 'tin_38.a', 'A'.repeat(48)]) {
      assert.ok(FORMATO_DEL_SKU.test(bueno), bueno);
      assert.deepEqual(
        validarProducto({
          ...conNombre(),
          variantes: [{ sku: bueno, nombre: 'Mediana', opciones: [], diferencia: '' }],
        }),
        [],
        bueno,
      );
    }
    for (const malo of ['a', 'con espacio', 'ñandú', 'A'.repeat(49), 'tin/38', 'tin+38']) {
      assert.ok(!FORMATO_DEL_SKU.test(malo), malo);
      assert.ok(
        codigosDe(
          validarProducto({
            ...conNombre(),
            variantes: [{ sku: malo, nombre: 'Mediana', opciones: [], diferencia: '' }],
          }),
        ).includes('product_variant_sku_invalid'),
        malo,
      );
    }
  });

  it('dos variantes con el mismo SKU se rechazan, y se dice cuál', () => {
    const fallos = validarProducto({
      ...conNombre(),
      variantes: [
        { sku: 'TIN-38', nombre: 'Mediana', opciones: [], diferencia: '' },
        { sku: 'TIN-38', nombre: 'Grande', opciones: [], diferencia: '' },
      ],
    });
    const repetido = fallos.find((x) => x.codigo === 'product_variant_sku_repeated');
    assert.equal(repetido?.indice, 1);
  });

  it('una diferencia de precio que no es entera se rechaza', () => {
    for (const escrito of ['1.5', 'mucho', '1,5']) {
      assert.ok(
        codigosDe(
          validarProducto({
            ...conNombre(),
            variantes: [
              { sku: 'TIN-38', nombre: 'Mediana', opciones: [], diferencia: escrito },
            ],
          }),
        ).includes('product_variant_delta_invalid'),
        escrito,
      );
    }
    // Una diferencia NEGATIVA sí vale: una variante puede costar menos.
    assert.deepEqual(
      validarProducto({
        ...conNombre(),
        variantes: [{ sku: 'TIN-38', nombre: 'Mediana', opciones: [], diferencia: '-500' }],
      }),
      [],
    );
  });

  it('el nombre de una variante no pasa de ochenta caracteres', () => {
    assert.ok(
      codigosDe(
        validarProducto({
          ...conNombre(),
          variantes: [
            { sku: 'TIN-38', nombre: 'x'.repeat(81), opciones: [], diferencia: '' },
          ],
        }),
      ).includes('product_variant_name_out_of_range'),
    );
  });

  it('más variantes de las que caben se rechaza con su propio código', () => {
    const muchas = Array.from({ length: MAXIMO_DE_VARIANTES + 1 }, (_, i) => ({
      sku: `TIN-${i}`,
      nombre: 'Mediana',
      opciones: [],
      diferencia: '',
    }));
    const fallo = validarProducto({ ...conNombre(), variantes: muchas }).find(
      (x) => x.codigo === 'product_variants_too_many',
    );
    assert.equal(fallo?.max, MAXIMO_DE_VARIANTES);
    assert.equal(MAXIMO_DE_VARIANTES, 50);
  });

  /*
    AQUÍ HABÍA TRES PRUEBAS DE LA GALERÍA: el tope de fotos, la repetida y el
    texto alternativo largo. No se borran, se dan la vuelta: el validador ya no
    mira la galería porque el formulario ya no la tiene, y lo que hay que dejar
    clavado es que NO SE INVENTA UN FALLO sobre un campo que no existe. Si
    alguien devolviera la validación sin devolver la pantalla, quien vende vería
    un error sobre algo que no puede tocar.

    Los topes de verdad de las fotografías viven en `fotosDeProducto.ts` —cinco
    por versión, tipo y peso— y se prueban allí, junto a la ruta que las sube.
  */
  it('el validador YA NO opina de la galería: no es un campo suyo', () => {
    const conGaleria = {
      ...conNombre(),
      galeria: [
        { ruta: 'https://cdn.z/foto.jpg', alternativo: 'x'.repeat(301) },
        { ruta: 'https://cdn.z/foto.jpg', alternativo: '' },
      ],
    } as unknown as FormularioDeProducto;
    assert.deepEqual(validarProducto(conGaleria), []);
    assert.equal(sePuedeGuardarProducto(conGaleria), true);
  });

  it('con todo escrito, se puede guardar', () => {
    const formulario: FormularioDeProducto = {
      version: '2',
      nombre: 'Tinaja de barro',
      resumen: 'Hecha a mano en Ayacucho.',
      descripcion: 'Barro cocido en horno de leña, sin esmaltes industriales.',
      materiales: 'Barro y agua.',
      pais: 'PE',
      fabricante: 'Taller Ayacucho',
      precio: '12900',
      moneda: 'PEN',
      variantes: [
        {
          sku: 'TIN-M',
          nombre: 'Mediana',
          opciones: [{ clave: 'capacidad', valor: '5 litros' }],
          diferencia: '0',
        },
      ],
    };
    assert.equal(sePuedeGuardarProducto(formulario), true);
    const { peticion } = peticionDeVersion(formulario);
    assert.equal(peticion?.variants?.[0]?.options.capacidad, '5 litros');
    // Con TODO escrito sigue sin haber `gallery`: las fotografías no son parte
    // de este formulario ni de esta petición.
    assert.ok(!('gallery' in (peticion ?? {})));
  });
});

/* ========================================================================== */
/*
  ESTE BLOQUE ERA «la galería guarda rutas, nunca URLs». La galería ya no guarda
  nada desde aquí, pero LOS DOCUMENTOS DE LA POSTULACIÓN SÍ: esa otra ruta del
  servidor sigue pidiendo `storage_path` escrito. Las pruebas se quedan, con su
  dueño corregido, porque la regla que protegen —una URL firmada caduca y lo
  guardado deja de cargar sin que nadie toque nada— sigue viva ahí.
*/
describe('un documento guarda su ruta, nunca una URL', () => {
  it('cualquier cosa con `://` se rechaza', () => {
    for (const url of [
      'https://cdn.z/foto.jpg',
      'http://x/y.png',
      's3://bucket/foto.jpg',
      'file:///tmp/foto.jpg',
    ]) {
      assert.equal(esRutaDeAlmacenamiento(url), false, url);
      assert.ok(
        codigosDe(
          validarPostulacion({
            nombre: 'Taller Ayacucho',
            propuesta: PROPUESTA,
            documentos: [{ kind: 'identity', ruta: url, nota: '' }],
          }),
        ).includes('seller_application_document_path_invalid'),
        url,
      );
    }
  });

  it('una ruta normal se acepta', () => {
    assert.equal(esRutaDeAlmacenamiento('productos/tinaja.jpg'), true);
    assert.equal(esRutaDeAlmacenamiento('a'.repeat(512)), true);
  });

  it('una ruta demasiado corta o demasiado larga se rechaza', () => {
    assert.equal(esRutaDeAlmacenamiento('ab'), false);
    assert.equal(esRutaDeAlmacenamiento('a'.repeat(513)), false);
    assert.equal(esRutaDeAlmacenamiento(''), false);
    assert.equal(esRutaDeAlmacenamiento(null), false);
    assert.deepEqual([...LARGO_DE_LA_RUTA], [3, 512]);
  });

  it('un documento de la postulación con una URL se rechaza igual', () => {
    const fallos = validarPostulacion({
      nombre: 'Taller Ayacucho',
      propuesta: PROPUESTA,
      documentos: [{ kind: 'identity', ruta: 'https://cdn.z/dni.pdf', nota: '' }],
    });
    assert.ok(fallos.some((x) => x.codigo === 'seller_application_document_path_invalid'));
  });
});

/* ========================================================================== */
describe('el validador de la postulación dice lo mismo que el servidor', () => {
  const base = { nombre: 'Taller Ayacucho', propuesta: PROPUESTA, documentos: [] };

  it('un nombre fuera de las cotas se rechaza, con su rango', () => {
    for (const escrito of ['', 'x', 'x'.repeat(121)]) {
      const fallo = validarPostulacion({ ...base, nombre: escrito }).find(
        (x) => x.campo === 'nombre',
      );
      assert.equal(fallo?.codigo, 'seller_application_name_invalid', escrito);
      assert.equal(fallo?.min, LARGO_DEL_NOMBRE[0]);
      assert.equal(fallo?.max, LARGO_DEL_NOMBRE[1]);
    }
    assert.deepEqual(validarPostulacion({ ...base, nombre: 'xx' }), []);
    assert.deepEqual(validarPostulacion({ ...base, nombre: 'x'.repeat(120) }), []);
  });

  it('una propuesta más corta que el mínimo del servidor se rechaza', () => {
    const fallo = validarPostulacion({ ...base, propuesta: 'Hago cosas' }).find(
      (x) => x.campo === 'propuesta',
    );
    assert.equal(fallo?.codigo, 'seller_application_proposal_invalid');
    assert.equal(fallo?.min, 20);
    assert.equal(fallo?.max, 4_000);
    assert.deepEqual([...LARGO_DE_LA_PROPUESTA], [20, 4_000]);
  });

  it('la propuesta al límite se acepta, y una más se rechaza', () => {
    assert.deepEqual(validarPostulacion({ ...base, propuesta: 'x'.repeat(4_000) }), []);
    assert.ok(
      codigosDe(validarPostulacion({ ...base, propuesta: 'x'.repeat(4_001) })).includes(
        'seller_application_proposal_invalid',
      ),
    );
  });

  it('los espacios no cuentan como propuesta', () => {
    assert.ok(
      codigosDe(validarPostulacion({ ...base, propuesta: ' '.repeat(30) })).includes(
        'seller_application_proposal_invalid',
      ),
    );
  });

  it('un tipo de documento que no existe se rechaza', () => {
    for (const tipo of ['', 'dni', 'IDENTITY', 'factura']) {
      const fallos = validarPostulacion({
        ...base,
        documentos: [{ kind: tipo, ruta: 'carpeta/x.pdf', nota: '' }],
      });
      assert.ok(
        fallos.some((x) => x.codigo === 'seller_application_document_kind_invalid'),
        tipo,
      );
    }
  });

  it('los nueve tipos del blueprint se aceptan', () => {
    for (const tipo of DOCUMENTOS) {
      assert.deepEqual(
        validarPostulacion({
          ...base,
          documentos: [{ kind: tipo, ruta: '', nota: 'Una nota.' }],
        }),
        [],
        tipo,
      );
    }
    assert.equal(DOCUMENTOS.length, 9);
  });

  it('un documento sin ruta y sin nota se rechaza', () => {
    const fallos = validarPostulacion({
      ...base,
      documentos: [{ kind: 'identity', ruta: '  ', nota: '  ' }],
    });
    const fallo = fallos.find((x) => x.codigo === 'seller_application_document_empty');
    assert.equal(fallo?.indice, 0);
  });

  it('una nota demasiado larga se avisa aquí', () => {
    assert.ok(
      codigosDe(
        validarPostulacion({
          ...base,
          documentos: [{ kind: 'other', ruta: '', nota: 'x'.repeat(LARGO_DE_LA_NOTA + 1) }],
        }),
      ).includes('seller_application_document_note_too_long'),
    );
  });

  it('más documentos de los que caben se rechaza', () => {
    const muchos = Array.from({ length: MAXIMO_DE_DOCUMENTOS + 1 }, () => ({
      kind: 'other',
      ruta: '',
      nota: 'Una nota.',
    }));
    const fallo = validarPostulacion({ ...base, documentos: muchos }).find(
      (x) => x.codigo === 'seller_application_documents_too_many',
    );
    assert.equal(fallo?.max, MAXIMO_DE_DOCUMENTOS);
    assert.equal(MAXIMO_DE_DOCUMENTOS, 30);
  });

  it('con lo mínimo escrito, se puede guardar', () => {
    assert.equal(sePuedeGuardarPostulacion(base), true);
  });
});

/* ========================================================================== */
describe('no hay editar sobre lo que ya se está evaluando', () => {
  it('un producto en borrador SÍ se edita', () => {
    assert.equal(sePuedeEditarProducto(producto({ status: 'draft' })), true);
  });

  it('NINGÚN otro estado se edita, ni uno de los once', () => {
    // Si esto cae, hay un botón que acaba en 409 `product_not_editable` y que
    // antes ya ha prometido cambiar lo que alguien está evaluando.
    for (const estado of ESTADOS_DE_PRODUCTO) {
      if (estado === 'draft') continue;
      assert.equal(
        sePuedeEditarProducto(producto({ status: estado })),
        false,
        `${estado} deja editar`,
      );
    }
  });

  it('un estado que no conocemos tampoco se edita', () => {
    for (const raro of ['', 'DRAFT', 'borrador', 'pending']) {
      assert.equal(sePuedeEditarProducto(producto({ status: raro })), false, raro);
    }
  });

  it('tener la acción `draft` no convierte un producto en editable', () => {
    // Un `submitted` puede volver a borrador, y eso NO es poder editarlo: son
    // dos preguntas distintas y confundirlas abre el editor a media evaluación.
    const enviado = producto({ status: 'submitted', acciones: ['draft'] });
    assert.equal(sePuedeRetirarProducto(enviado), true);
    assert.equal(sePuedeEditarProducto(enviado), false);
  });

  it('`PRODUCTOS_EDITABLES` es exactamente `states.EDITABLES`', () => {
    assert.deepEqual([...PRODUCTOS_EDITABLES], ['draft']);
  });
});

/* ========================================================================== */
describe('los botones los dicta el servidor, y solo si tienen ruta', () => {
  it('un borrador recién creado ofrece postular', () => {
    const nuevo = producto({ status: 'draft', acciones: ['removed', 'submitted'] });
    assert.deepEqual(accionesOfrecidas(nuevo), ['submitted']);
    assert.equal(sePuedePostularProducto(nuevo), true);
  });

  it('`removed` NUNCA se pinta: no hay ruta de proveedor que lo haga', () => {
    const nuevo = producto({ status: 'draft', acciones: ['removed'] });
    assert.deepEqual(accionesOfrecidas(nuevo), []);
    assert.ok(!(ACCIONES_CON_RUTA as readonly string[]).includes('removed'));
  });

  it('un enviado ofrece volver a borrador y nada más', () => {
    const enviado = producto({ status: 'submitted', acciones: ['draft'] });
    assert.deepEqual(accionesOfrecidas(enviado), ['draft']);
    assert.equal(sePuedePostularProducto(enviado), false);
  });

  it('sin acciones no se pinta ningún botón', () => {
    const publicado = producto({ status: 'published', acciones: [] });
    assert.deepEqual(accionesOfrecidas(publicado), []);
    assert.equal(sePuedePostularProducto(publicado), false);
    assert.equal(sePuedeRetirarProducto(publicado), false);
  });

  it('una acción que esta versión no conoce se ignora', () => {
    const raro = producto({ acciones: ['teletransportar', 'submitted'] });
    assert.deepEqual(accionesOfrecidas(raro), ['submitted']);
  });

  it('el orden de los botones no depende de cómo llegue la lista', () => {
    const uno = producto({ acciones: ['draft', 'submitted'] });
    const otro = producto({ acciones: ['submitted', 'draft'] });
    assert.deepEqual(accionesOfrecidas(uno), accionesOfrecidas(otro));
  });

  it('cada acción con ruta tiene su propio texto', () => {
    const claves = ACCIONES_CON_RUTA.map(claveDeAccionDeProducto);
    assert.equal(new Set(claves).size, claves.length);
    assert.equal(claveDeAccionDeProducto('removed'), 'proveedorProductos.accion.desconocido');
  });
});

/* ========================================================================== */
describe('qué versión se enseña', () => {
  it('se enseña el borrador cuando lo hay', () => {
    const borrador = version({ id: 'borrador' });
    const publicada = version({ id: 'publicada', status: 'published' });
    const p = producto({ draft: borrador, published: publicada });
    assert.equal(versionQueSeEnsena(p)?.id, 'borrador');
    assert.equal(versionEnBorrador(p)?.id, 'borrador');
  });

  it('sin borrador se enseña lo publicado, pero no se ofrece como borrador', () => {
    const p = producto({ draft: null, published: version({ id: 'publicada' }) });
    assert.equal(versionQueSeEnsena(p)?.id, 'publicada');
    assert.equal(versionEnBorrador(p), null);
  });

  it('sin nada escrito no se inventa una versión', () => {
    const p = producto({ draft: null, published: null });
    assert.equal(versionQueSeEnsena(p), null);
    assert.equal(versionEnBorrador(p), null);
  });
});

/* ========================================================================== */
describe('dónde está quien postula', () => {
  it('sin esquema no se dice nada más', () => {
    assert.equal(situacionDelProveedor(estadoCon({ disponible: false })), 'noDisponible');
    assert.equal(situacionDelProveedor(null), 'noDisponible');
  });

  it('sin postulación es «sin postular», no «rechazada»', () => {
    assert.equal(situacionDelProveedor(estadoCon()), 'sinPostular');
  });

  it('cada estado de la postulación tiene su situación', () => {
    const ESPERADO: Record<string, string> = {
      draft: 'borrador',
      submitted: 'enviada',
      under_review: 'enRevision',
      accepted: 'aceptada',
      rejected: 'rechazada',
      withdrawn: 'retirada',
    };
    for (const estado of ESTADOS_DE_POSTULACION) {
      assert.equal(
        situacionDelProveedor(estadoCon({ application: postulacion({ status: estado }) })),
        ESPERADO[estado],
        estado,
      );
    }
  });

  it('ser responsable comercial activo manda sobre la postulación', () => {
    assert.equal(
      situacionDelProveedor(
        estadoCon({
          seller_status: 'active',
          application: postulacion({ status: 'accepted' }),
        }),
      ),
      'proveedorActivo',
    );
  });

  it('la SUSPENSIÓN se dice antes que nada: explica por qué no se puede', () => {
    assert.equal(
      situacionDelProveedor(
        estadoCon({
          seller_status: 'suspended',
          application: postulacion({ status: 'accepted' }),
        }),
      ),
      'proveedorSuspendido',
    );
  });

  it('`pending` no es «casi activo»: se sigue contando la postulación', () => {
    assert.equal(
      situacionDelProveedor(
        estadoCon({
          seller_status: 'pending',
          application: postulacion({ status: 'submitted' }),
        }),
      ),
      'enviada',
    );
    assert.equal(esProveedorActivo(estadoCon({ seller_status: 'pending' })), false);
    assert.equal(esProveedorActivo(estadoCon({ seller_status: 'suspended' })), false);
    assert.equal(esProveedorActivo(estadoCon({ seller_status: 'active' })), true);
    assert.equal(esProveedorActivo(null), false);
  });

  it('un estado de postulación que no conocemos no se cuenta como nada', () => {
    assert.equal(
      situacionDelProveedor(estadoCon({ application: postulacion({ status: 'raro' }) })),
      'desconocida',
    );
  });

  it('el acceso del perfil lleva a productos solo si ya es proveedor', () => {
    assert.equal(rutaDelProveedor(estadoCon({ seller_status: 'active' })), '/proveedor/productos');
    for (const estado of [null, 'pending', 'suspended']) {
      assert.equal(
        rutaDelProveedor(estadoCon({ seller_status: estado })),
        '/proveedor/postular',
        String(estado),
      );
    }
  });

  it('cada situación tiene titular y cuerpo propios', () => {
    const situaciones = [
      'noDisponible',
      'proveedorActivo',
      'proveedorSuspendido',
      'sinPostular',
      'borrador',
      'enviada',
      'enRevision',
      'aceptada',
      'rechazada',
      'retirada',
      'desconocida',
    ] as const;
    const titulares = situaciones.map(claveDeLaSituacion);
    const cuerpos = situaciones.map(claveDelCuerpoDeLaSituacion);
    assert.equal(new Set(titulares).size, situaciones.length);
    assert.equal(new Set(cuerpos).size, situaciones.length);
  });

  it('el motivo de la decisión se enseña tal cual, y vacío es `null`', () => {
    assert.equal(
      motivoDeLaDecision(
        estadoCon({
          application: postulacion({ status: 'rejected', decision_reason: '  No cuadra.  ' }),
        }),
      ),
      'No cuadra.',
    );
    assert.equal(
      motivoDeLaDecision(
        estadoCon({ application: postulacion({ decision_reason: '   ' }) }),
      ),
      null,
    );
    assert.equal(motivoDeLaDecision(estadoCon()), null);
    assert.equal(motivoDeLaDecision(null), null);
  });
});

/* ========================================================================== */
describe('los botones de la postulación, cuando el contrato dice que se puede', () => {
  it('se envía un borrador, y solo un borrador', () => {
    for (const estado of ESTADOS_DE_POSTULACION) {
      assert.equal(
        sePuedeEnviarPostulacion(estadoCon({ application: postulacion({ status: estado }) })),
        estado === 'draft',
        estado,
      );
    }
  });

  it('sin postulación no hay nada que enviar ni que retirar', () => {
    assert.equal(sePuedeEnviarPostulacion(estadoCon()), false);
    assert.equal(sePuedeRetirarPostulacion(estadoCon()), false);
    assert.equal(sePuedeEnviarPostulacion(null), false);
    assert.equal(sePuedeRetirarPostulacion(null), false);
  });

  it('se retira mientras esté viva, y no después', () => {
    for (const estado of ESTADOS_DE_POSTULACION) {
      assert.equal(
        sePuedeRetirarPostulacion(estadoCon({ application: postulacion({ status: estado }) })),
        (POSTULACIONES_VIVAS as readonly string[]).includes(estado),
        estado,
      );
    }
  });

  it('un borrador SE SIGUE ESCRIBIENDO aunque `puede_postular` sea `false`', () => {
    // `puede_postular` es «puedo abrir una nueva», y vale `false` justo cuando
    // hay un borrador. Usarlo para el botón de editar esconde el propio
    // borrador de quien lo escribió.
    const conBorrador = estadoCon({
      application: postulacion({ status: 'draft' }),
      puede_postular: false,
    });
    assert.equal(sePuedeEscribirPostulacion(conBorrador), true);
  });

  it('una enviada o en revisión NO se puede reescribir', () => {
    for (const estado of ['submitted', 'under_review']) {
      assert.equal(
        sePuedeEscribirPostulacion(
          estadoCon({ application: postulacion({ status: estado }) }),
        ),
        false,
        estado,
      );
    }
  });

  it('una rechazada o retirada deja escribir otra', () => {
    for (const estado of ['rejected', 'withdrawn']) {
      assert.equal(
        sePuedeEscribirPostulacion(
          estadoCon({ application: postulacion({ status: estado }) }),
        ),
        true,
        estado,
      );
    }
  });

  it('quien ya es responsable comercial activo no postula otra vez', () => {
    assert.equal(
      sePuedeEscribirPostulacion(estadoCon({ seller_status: 'active' })),
      false,
    );
  });

  it('sin esquema no se ofrece escribir, enviar ni retirar', () => {
    const apagado = estadoCon({
      disponible: false,
      application: postulacion({ status: 'draft' }),
    });
    assert.equal(sePuedeEscribirPostulacion(apagado), false);
    assert.equal(sePuedeEnviarPostulacion(apagado), false);
    assert.equal(sePuedeRetirarPostulacion(apagado), false);
  });
});

/* ========================================================================== */
describe('cada cosa se llama por su nombre', () => {
  it('los once estados del producto tienen titular y cuerpo propios', () => {
    const titulares = ESTADOS_DE_PRODUCTO.map(claveDelEstadoDeProducto);
    const cuerpos = ESTADOS_DE_PRODUCTO.map(claveDelCuerpoDelEstadoDeProducto);
    assert.equal(new Set(titulares).size, 11);
    assert.equal(new Set(cuerpos).size, 11);
    assert.equal(claveDelEstadoDeProducto('lo-que-sea'), 'proveedorProductos.estado.desconocido');
    assert.equal(
      claveDelCuerpoDelEstadoDeProducto('lo-que-sea'),
      'proveedorProductos.estadoCuerpo.desconocido',
    );
  });

  it('los seis estados de la postulación también', () => {
    const titulares = ESTADOS_DE_POSTULACION.map(claveDelEstadoDePostulacion);
    assert.equal(new Set(titulares).size, 6);
    assert.equal(
      claveDelEstadoDePostulacion('raro'),
      'proveedorProductos.postular.estado.desconocido',
    );
    assert.equal(
      claveDelCuerpoDelEstadoDePostulacion('raro'),
      'proveedorProductos.postular.estadoCuerpo.desconocido',
    );
  });

  it('los nueve tipos de documento tienen nombre, y no se repiten', () => {
    const claves = DOCUMENTOS.map(claveDelTipoDeDocumento);
    assert.equal(new Set(claves).size, 9);
    assert.equal(claveDelTipoDeDocumento('dni'), 'proveedorProductos.documento.desconocido');
  });

  it('los tres estados de la capacidad comercial tienen nombre', () => {
    const claves = ESTADOS_DE_VENDEDOR.map(claveDelEstadoDelVendedor);
    assert.equal(new Set(claves).size, 3);
    assert.equal(claveDelEstadoDelVendedor('raro'), 'proveedorProductos.vendedor.desconocido');
  });

  it('cada bloqueo se cuenta con su propio mensaje', () => {
    const claves = BLOQUEOS.map((codigo) => claveDelBloqueo(codigo));
    assert.equal(new Set(claves).size, BLOQUEOS.length);
    assert.equal(claveDelBloqueo('lo_que_sea'), 'proveedorProductos.bloqueo.desconocido');
  });

  it('sin bloqueo NO se enseña ningún aviso: `null` es que se puede', () => {
    assert.equal(claveDelBloqueo(null), null);
    assert.equal(claveDelBloqueo(undefined), null);
    assert.equal(claveDelBloqueo(''), null);
  });
});

/* ========================================================================== */
describe('cuando algo sale mal', () => {
  /** Todos los códigos que devuelven `applications.py` y `service.py`. */
  const CODIGOS_DEL_SERVIDOR = [
    'seller_application_not_found',
    'seller_application_not_editable',
    'seller_application_changed',
    'seller_application_name_invalid',
    'seller_application_proposal_invalid',
    'seller_application_documents_too_many',
    'seller_application_document_kind_invalid',
    'seller_application_document_empty',
    'seller_application_document_path_invalid',
    'seller_application_document_note_too_long',
    'seller_application_reject_needs_reason',
    'seller_application_reason_too_long',
    'seller_application_self_review_forbidden',
    'seller_already_active',
    'product_name_required',
    'product_field_out_of_range',
    'product_country_invalid',
    'product_price_invalid',
    'product_currency_invalid',
    'product_price_without_currency',
    'product_variants_too_many',
    'product_variant_incomplete',
    'product_variant_sku_repeated',
    'product_variant_options_invalid',
    'product_variant_delta_invalid',
    // LOS CINCO DE LA GALERIA PEGADA A MANO SE FUERON CON ELLA. El servidor
    // ya no los produce —se marcharon con `_exigir_galeria` en la 0073— y
    // seguir exigiendoles texto obligaba a mantener cinco frases que nadie
    // puede ver. Lo que puede fallar al SUBIR una fotografia lo cubre
    // `fotosDeProducto.test.mts`, que es donde vive ese camino.
    'product_category_invalid',
    'product_not_editable',
    'product_version_taken',
    'product_version_not_editable',
    'product_changed',
    'product_suspension_needs_reason',
    'product_not_approved',
    'product_version_missing',
    'product_media_required',
    'product_evaluation_required',
    'product_reasons_required',
    'product_evaluation_not_available',
    'product_not_found',
    'product_seller_not_active',
    'product_self_review_forbidden',
    'product_review_forbidden',
    'product_publish_forbidden',
    'product_transition_invalid',
    'product_transition_forbidden',
    'products_not_available',
    'product_admission_not_available',
    'product_saves_not_available',
  ];

  it('TODOS los códigos de la API tienen su propio mensaje', () => {
    const sinMensaje = CODIGOS_DEL_SERVIDOR.filter(
      (codigo) => claveDeErrorDeProveedor(codigo) === null,
    );
    assert.deepEqual(sinMensaje, [], `sin traducir: ${sinMensaje.join(', ')}`);
  });

  it('los tres códigos locales también', () => {
    for (const codigo of CODIGOS_LOCALES) {
      assert.ok(claveDeErrorDeProveedor(codigo) !== null, codigo);
    }
  });

  it('cada código dice algo distinto, salvo los que son el mismo aviso', () => {
    // `product_admission_not_available` es a la vez un 503 y un bloqueo, y se
    // cuenta con dos textos distintos según dónde aparezca; el resto es único.
    const claves = CODIGOS_DEL_SERVIDOR.map((codigo) => claveDeErrorDeProveedor(codigo));
    assert.equal(new Set(claves).size, claves.length);
  });

  it('un código que no conocemos deja hablar al servidor', () => {
    assert.equal(claveDeErrorDeProveedor('lo_que_sea'), null);
    assert.equal(claveDeErrorDeProveedor(null), null);
    assert.equal(claveDeErrorDeProveedor(undefined), null);
  });

  it('401, 403, 404 y 409 se cuentan distinto entre sí', () => {
    const claves = [401, 403, 404, 409].map(claveDeErrorPorEstado);
    assert.ok(claves.every((x) => x !== null));
    assert.equal(new Set(claves).size, 4);
    assert.equal(claveDeErrorPorEstado(500), null);
  });

  it('los dos códigos de «todavía no está desplegado» se tratan igual', () => {
    assert.equal(esProductosApagado('products_not_available'), true);
    assert.equal(esProductosApagado('product_admission_not_available'), true);
    assert.equal(esProductosApagado('network_error'), false);
    assert.equal(esProductosApagado(null), false);
  });

  it('un 409 se recupera recargando, no se muestra y se olvida', () => {
    assert.equal(hayQueRecargar(409, null), true);
    assert.equal(hayQueRecargar(null, 'product_changed'), true);
    assert.equal(hayQueRecargar(null, 'product_not_editable'), true);
    assert.equal(hayQueRecargar(null, 'seller_application_changed'), true);
    assert.equal(hayQueRecargar(null, 'seller_application_not_editable'), true);
    assert.equal(hayQueRecargar(500, 'otro'), false);
  });

  it('un fallo local se cuenta con el mismo mensaje que el del servidor', () => {
    assert.equal(
      claveDeFallo({ campo: 'precio', codigo: 'product_price_without_currency' }),
      claveDeErrorDeProveedor('product_price_without_currency'),
    );
    assert.equal(
      claveDeFallo({ campo: 'producto', codigo: 'inventado' }),
      'proveedorProductos.error.desconocido',
    );
  });

  it('cada fallo que producen los validadores tiene mensaje', () => {
    const rotos = [
      formularioDeProductoVacio(),
      { ...conNombre(), precio: '4990' },
      { ...conNombre(), pais: 'peru' },
      { ...conNombre(), fabricante: 'x' },
      { ...conNombre(), version: 'x'.repeat(40) },
      {
        ...conNombre(),
        variantes: [{ sku: 'a', nombre: '', opciones: [], diferencia: 'x' }],
      },
    ];
    for (const formulario of rotos) {
      for (const fallo of validarProducto(formulario)) {
        assert.ok(
          claveDeErrorDeProveedor(fallo.codigo) !== null,
          `${fallo.codigo} no tiene mensaje`,
        );
      }
    }
    for (const fallo of validarPostulacion(formularioDePostulacionVacio())) {
      assert.ok(claveDeErrorDeProveedor(fallo.codigo) !== null, fallo.codigo);
    }
  });
});

/* ========================================================================== */
describe('el formato no añade nada que no se escribiera', () => {
  it('la versión se enseña como se escribió: sin «v» y sin «1.0»', () => {
    assert.equal(etiquetaDeVersion('  condiciones-2026 '), 'condiciones-2026');
    assert.equal(etiquetaDeVersion('1'), '1');
    assert.equal(etiquetaDeVersion(''), '');
    assert.equal(etiquetaDeVersion(null), '');
    assert.equal(etiquetaDeVersion(undefined), '');
  });

  it('una fecha que no se puede leer se queda vacía, no pone «hoy»', () => {
    assert.equal(fechaLegible(null), '');
    assert.equal(fechaLegible(''), '');
    assert.equal(fechaLegible('mañana'), '');
    assert.notEqual(fechaLegible('2026-03-01T10:00:00Z'), '');
  });

  it('un formulario en blanco se reconoce como vacío', () => {
    assert.equal(hayAlgoEscrito(formularioDeProductoVacio()), false);
    assert.equal(hayAlgoEscrito(conNombre()), true);
    assert.equal(
      hayAlgoEscrito({
        ...formularioDeProductoVacio(),
        variantes: [varianteVacia()],
      }),
      true,
    );
    // UNA GALERÍA NO CUENTA COMO «ALGO ESCRITO». Las fotografías viven en su
    // propia pantalla: si aquí solo hubiera fotos, no habría nada que perder al
    // salir, y avisar de lo contrario sería un aviso falso.
    assert.equal(
      hayAlgoEscrito({
        ...formularioDeProductoVacio(),
        galeria: [{ ruta: 'productos/tinaja.jpg', alternativo: '' }],
      } as unknown as FormularioDeProducto),
      false,
    );
  });
});

/* ========================================================================== */
describe('el lenguaje del blueprint', () => {
  const DICCIONARIOS: Array<[string, Record<string, string>]> = [
    ['es', es as unknown as Record<string, string>],
    ['en', en as Record<string, string>],
    ['pt', pt as Record<string, string>],
  ];

  /** Las cinco frases que el blueprint exige, palabra por palabra. */
  const OBLIGATORIAS = [
    'Postula tu producto',
    'Selección Z',
    'Producto de Excelencia Z',
    'Creadores de excelencia',
    'Evaluado y aprobado por nuestro estándar',
  ];

  /** Las cinco prohibidas, tal como están escritas en el blueprint. */
  const PROHIBIDAS = [
    'Vende en Z',
    'Hazte vendedor',
    'Millones de productos',
    'Los precios más bajos',
    'Ofertas imperdibles',
  ];

  /**
   * Los equivalentes en los otros dos idiomas, que se comprueban SOLO sobre las
   * claves de este módulo.
   *
   * Y no sobre el diccionario entero a propósito: una frase como «when somebody
   * applies to become a seller it will show up here» es prosa descriptiva de una
   * bandeja de administración, no la llamada comercial que el blueprint
   * prohíbe. Prohibir la secuencia de letras en todo el diccionario haría fallar
   * textos correctos de otras pantallas, y lo que se está defendiendo aquí es
   * cómo se le habla a quien produce.
   */
  const PROHIBIDAS_TRADUCIDAS: Record<string, string[]> = {
    en: [
      'Sell on Z',
      'Become a seller',
      'Millions of products',
      'Lowest prices',
      'Unmissable deals',
    ],
    pt: [
      'Venda na Z',
      'Torne-se vendedor',
      'Milhões de produtos',
      'Os preços mais baixos',
      'Ofertas imperdíveis',
    ],
  };

  it('el español dice las cinco frases obligatorias, tal cual', () => {
    const textos = Object.values(es as unknown as Record<string, string>);
    for (const frase of OBLIGATORIAS) {
      assert.ok(
        textos.some((texto) => texto.includes(frase)),
        `falta la frase del blueprint: ${frase}`,
      );
    }
  });

  it('NINGÚN diccionario usa el lenguaje prohibido del blueprint', () => {
    for (const [idioma, diccionario] of DICCIONARIOS) {
      for (const frase of PROHIBIDAS) {
        const sucias = Object.entries(diccionario)
          .filter(([, texto]) => texto.toLowerCase().includes(frase.toLowerCase()))
          .map(([clave]) => clave);
        assert.deepEqual(sucias, [], `${idioma} dice «${frase}» en: ${sucias.join(', ')}`);
      }
    }
  });

  it('tampoco lo usan sus equivalentes en inglés ni en portugués', () => {
    for (const [idioma, diccionario] of DICCIONARIOS) {
      const prohibidas = PROHIBIDAS_TRADUCIDAS[idioma] ?? [];
      const mias = Object.entries(diccionario).filter(([clave]) =>
        clave.startsWith('proveedorProductos.'),
      );
      for (const frase of prohibidas) {
        const sucias = mias
          .filter(([, texto]) => texto.toLowerCase().includes(frase.toLowerCase()))
          .map(([clave]) => clave);
        assert.deepEqual(sucias, [], `${idioma} dice «${frase}» en: ${sucias.join(', ')}`);
      }
    }
  });

  it('el botón de postular un producto es el del blueprint', () => {
    const diccionario = es as unknown as Record<string, string>;
    assert.equal(diccionario['proveedorProductos.marca.postula'], 'Postula tu producto');
    assert.equal(diccionario['proveedorProductos.accion.submitted'], 'Postula tu producto');
  });

  it('todas las claves de este módulo existen en los TRES idiomas', () => {
    const claves = [
      ...ESTADOS_DE_PRODUCTO.map(claveDelEstadoDeProducto),
      ...ESTADOS_DE_PRODUCTO.map(claveDelCuerpoDelEstadoDeProducto),
      ...ESTADOS_DE_POSTULACION.map(claveDelEstadoDePostulacion),
      ...ESTADOS_DE_POSTULACION.map(claveDelCuerpoDelEstadoDePostulacion),
      ...ESTADOS_DE_VENDEDOR.map(claveDelEstadoDelVendedor),
      ...DOCUMENTOS.map(claveDelTipoDeDocumento),
      ...ACCIONES_CON_RUTA.map(claveDeAccionDeProducto),
      ...BLOQUEOS.map((codigo) => claveDelBloqueo(codigo) ?? ''),
      'proveedorProductos.estado.desconocido',
      'proveedorProductos.estadoCuerpo.desconocido',
      'proveedorProductos.postular.estado.desconocido',
      'proveedorProductos.postular.estadoCuerpo.desconocido',
      'proveedorProductos.vendedor.desconocido',
      'proveedorProductos.documento.desconocido',
      'proveedorProductos.accion.desconocido',
      'proveedorProductos.bloqueo.desconocido',
      'proveedorProductos.error.desconocido',
    ];
    for (const [idioma, diccionario] of DICCIONARIOS) {
      const faltan = claves.filter((clave) => !(clave in diccionario));
      assert.deepEqual(faltan, [], `faltan en ${idioma}: ${faltan.join(', ')}`);
    }
  });

  it('cada mensaje de error apunta a una clave que existe', () => {
    const diccionario = es as unknown as Record<string, string>;
    const situaciones = [
      'noDisponible',
      'proveedorActivo',
      'proveedorSuspendido',
      'sinPostular',
      'borrador',
      'enviada',
      'enRevision',
      'aceptada',
      'rechazada',
      'retirada',
      'desconocida',
    ] as const;
    for (const situacion of situaciones) {
      assert.ok(claveDeLaSituacion(situacion) in diccionario, situacion);
      assert.ok(claveDelCuerpoDeLaSituacion(situacion) in diccionario, situacion);
    }
    for (const estado of [401, 403, 404, 409]) {
      const clave = claveDeErrorPorEstado(estado);
      assert.ok(clave !== null && clave in diccionario, String(estado));
    }
  });
});

/* ========================================================================== */
describe('lo que las pantallas y el repositorio tienen escrito', () => {
  const postular = sinComentarios(fuente('screens', 'PostularProveedorScreen.tsx'));
  const productos = sinComentarios(fuente('screens', 'MisProductosScreen.tsx'));
  const editar = sinComentarios(fuente('screens', 'EditarProductoScreen.tsx'));
  const repositorio = sinComentarios(
    fuente('repositories', 'ProductSellerRepository.ts'),
  );
  const pantallas: Array<[string, string]> = [
    ['PostularProveedorScreen', postular],
    ['MisProductosScreen', productos],
    ['EditarProductoScreen', editar],
  ];

  it('NINGÚN texto en duro: todo pasa por el traductor', () => {
    for (const [nombre, pantalla] of pantallas) {
      for (const atributo of ['label="', 'title="', 'description="', 'placeholder="']) {
        assert.ok(!pantalla.includes(atributo), `${nombre} lleva ${atributo}`);
      }
      // Ni un `confirm`/`notify` con el texto escrito a mano.
      for (const atributo of ["title: '", "message: '", "confirmLabel: '"]) {
        assert.ok(!pantalla.includes(atributo), `${nombre} lleva ${atributo}`);
      }
    }
  });

  it('ninguna pantalla precarga un precio, una moneda ni una versión', () => {
    // Un `price_minor: 0` escrito aquí sería «gratis» decidido por nosotros.
    for (const [nombre, pantalla] of pantallas) {
      for (const prohibido of ["precio: '0'", "moneda: 'PEN'", "version: '1'", 'price_minor:']) {
        assert.ok(!pantalla.includes(prohibido), `${nombre} precarga ${prohibido}`);
      }
    }
    assert.ok(editar.includes('formularioDeProductoVacio('));
    assert.ok(postular.includes('formularioDePostulacionVacio('));
  });

  it('el editor solo se abre preguntando por el estado, no por un `status`', () => {
    assert.ok(editar.includes('sePuedeEditarProducto('));
    assert.ok(productos.includes('sePuedeEditarProducto('));
    for (const pantalla of [productos, editar]) {
      assert.ok(!pantalla.includes("status === 'draft'"));
      assert.ok(!pantalla.includes("status !== 'draft'"));
    }
  });

  it('los botones del producto salen de `accionesOfrecidas`', () => {
    assert.ok(productos.includes('accionesOfrecidas('));
    assert.ok(!productos.includes("acciones.includes('removed')"));
  });

  it('postular y retirar piden confirmación ANTES de llamar al servidor', () => {
    const postularProducto = productos.slice(productos.indexOf('const postular'));
    const hasta = postularProducto.slice(0, postularProducto.indexOf('const retirar'));
    assert.ok(hasta.includes('confirm('), 'un toque no postula');
    assert.ok(hasta.indexOf('confirm(') < hasta.indexOf('.postularProducto('));
    const retirar = productos.slice(productos.indexOf('const retirar'));
    assert.ok(retirar.includes('destructive: true'));
    assert.ok(retirar.indexOf('confirm(') < retirar.indexOf('.retirarProducto('));
  });

  it('enviar la postulación también, y avisa de que deja de poder cambiarse', () => {
    const enviar = postular.slice(postular.indexOf('const enviar'));
    const hasta = enviar.slice(0, enviar.indexOf('const retirar'));
    assert.ok(hasta.includes('confirm('));
    assert.ok(hasta.includes('proveedorProductos.postular.enviarAviso'));
    assert.ok(hasta.indexOf('confirm(') < hasta.indexOf('.enviarPostulacion('));
  });

  it('el cerrojo se cierra ANTES del primer await, en las tres pantallas', () => {
    for (const [nombre, pantalla] of pantallas) {
      const cerrojo = pantalla.slice(pantalla.indexOf('const conCerrojo'));
      const hasta = cerrojo.slice(0, cerrojo.indexOf('await trabajo()'));
      assert.ok(hasta.includes('if (ocupadoRef.current) return;'), nombre);
      assert.ok(!hasta.includes('await '), `${nombre} tiene un await antes del cerrojo`);
    }
  });

  it('ninguna pantalla llama a una ruta de administración', () => {
    for (const [nombre, pantalla] of pantallas) {
      assert.ok(!pantalla.includes('/admin/'), nombre);
    }
    assert.ok(!repositorio.includes('/admin/'));
  });

  it('el repositorio tiene EXACTAMENTE las diez rutas del proveedor', () => {
    const metodos = [
      'async estado(',
      'async guardarPostulacion(',
      'async enviarPostulacion(',
      'async retirarPostulacion(',
      'async misProductos(',
      'async crearProducto(',
      'async producto(',
      'async guardarBorrador(',
      'async postularProducto(',
      'async retirarProducto(',
    ];
    for (const metodo of metodos) {
      assert.ok(repositorio.includes(metodo), `falta ${metodo}`);
    }
    assert.equal((repositorio.match(/async /g) ?? []).length, metodos.length);
  });

  it('el repositorio no sabe publicar, aprobar, evaluar ni suspender', () => {
    for (const prohibido of [
      'publicar(',
      'aprobar(',
      'evaluar(',
      'suspender(',
      'decidir(',
      '/publish',
      '/suspend',
      '/transition',
    ]) {
      assert.ok(!repositorio.includes(prohibido), prohibido);
    }
  });

  it('NINGUNA pantalla de existencias, incidencias ni saldos', () => {
    // No existen en la API. Una pantalla vacía que los simulara prometería una
    // operación que no hay.
    //
    // «inventario» SALIÓ DE ESTA LISTA con el incremento 4: el inventario por
    // SKU existe de verdad en el servidor —`/products/seller/products/{id}/
    // inventory`, la 0074— y tiene su propia pantalla. Lo que sigue prohibido
    // aquí es lo que sigue sin existir, y también que ESTAS tres pantallas
    // escriban un número de existencias: los números viven en
    // `InventarioDeProductoScreen`, que es la única que los lee del contrato,
    // y por eso «stock» y «existencias» se quedan.
    //
    // «envio» y «pedido» SALEN AHORA, con el Incremento 6, y SOLO de esta
    // comprobación conjunta: los pedidos de la tienda existen de verdad —la
    // 0079— y tienen su pantalla. Lo único que «Mis productos» puede hacer con
    // ellos es LLEVAR allí, y eso se comprueba aparte, igual que se comprueba
    // aparte que ni el repositorio ni las otras dos pantallas los mencionen.
    const todo = [postular, productos, editar, repositorio].join('\n');
    // Con límites de palabra: `borderColor` contiene «order» y no es un pedido.
    for (const prohibido of [
      'stock',
      'existencias',
      'shipping',
      'orders?',
      'incidencia',
      'saldo',
      'payout',
      'checkout',
      'carrito',
      'cart',
    ]) {
      const patron = new RegExp(`\\b${prohibido}\\b`, 'i');
      assert.ok(!patron.test(todo), `aparece «${prohibido}»`);
    }
  });

  it('el repositorio del proveedor no aprende a enviar', () => {
    // QUIEN ENVÍA ES `ProductShipmentRepository`, y tiene que seguir siéndolo.
    // Si este repositorio creciera un método de despacho habría dos sitios
    // desde donde sacar unidades del almacén, y uno de los dos acabaría sin su
    // clave de idempotencia.
    for (const prohibido of ['envio', 'envío', 'shipment', 'pedido', 'despach', 'dispatch']) {
      const patron = new RegExp(prohibido, 'i');
      assert.ok(!patron.test(repositorio), `aparece «${prohibido}»`);
    }
  });

  it('postular y editar siguen sin hablar de envíos ni de pedidos', () => {
    // Un producto no es un pedido. Que estas dos pantallas escribieran un
    // estado de envío significaría que lo están deduciendo de algo que no es
    // el contrato del envío.
    for (const pantalla of [postular, editar]) {
      for (const prohibido of ['envio', 'envío', 'pedido', 'shipment']) {
        const patron = new RegExp(`\\b${prohibido}\\b`, 'i');
        assert.ok(!patron.test(pantalla), `aparece «${prohibido}»`);
      }
    }
  });

  it('«Mis productos» LLEVA a los pedidos de la tienda, y solo eso', () => {
    // UNA RUTA QUE SOLO FUNCIONA ESCRIBIENDO LA URL NO ESTÁ TERMINADA. Esta es
    // la comprobación de que se puede llegar.
    assert.ok(
      productos.includes("'/proveedor/pedidos'"),
      'falta el acceso a los pedidos de la tienda',
    );
    // Y NADA MÁS QUE LLEVAR: ni estados de envío, ni cantidades preparadas, ni
    // transportistas. Todo eso se lee del contrato en la pantalla que lo pide.
    for (const prohibido of [
      'DISPATCHED',
      'DELIVERED',
      'PREPARING',
      'prepared_quantity',
      'carrier',
      'tracking',
      'shipment',
    ]) {
      assert.ok(!productos.includes(prohibido), `aparece «${prohibido}»`);
    }
  });

  /*
    ESTA PRUEBA EXIGÍA EL EDITOR DE GALERÍA: comprobaba que la pantalla pintara
    `rutaEtiqueta` y `galeriaCuerpo`. Exigía, por tanto, el defecto. Se da la
    vuelta en vez de borrarla, porque lo que hace falta es justo lo contrario:
    que NADIE pueda volver a poner un campo donde se teclee una ruta del
    almacenamiento. Se mira el código SIN COMENTARIOS, así que la explicación
    que hay en la pantalla no la satisface ni la rompe.
  */
  it('NINGÚN campo donde se teclee una ruta del almacenamiento', () => {
    for (const prohibido of [
      // Las claves del editor viejo. Ya no están en ningún diccionario.
      'rutaEtiqueta',
      'rutaAyuda',
      'anadirFoto',
      'quitarFoto',
      'galeriaCuerpo',
      // El nombre del campo del contrato, en cualquiera de sus dos formas.
      'storage_path',
      'LARGO_DE_LA_RUTA',
      // Y el campo del formulario que lo alimentaba.
      'galeria',
      'fotoVacia',
    ]) {
      assert.ok(
        !editar.includes(prohibido),
        `EditarProductoScreen vuelve a escribir rutas: «${prohibido}»`,
      );
    }
    // Ni enlaces, que era la otra mitad de la regla vieja.
    for (const prohibido of ['https://', 'http://']) {
      assert.ok(!editar.includes(prohibido), prohibido);
    }
  });

  it('el único camino a las fotografías es la pantalla que SUBE el archivo', () => {
    // Quitar el editor sin dejar el camino bueno sería quitar la función
    // entera: esto comprueba que el botón sigue ahí y a dónde lleva.
    assert.ok(editar.includes('/fotos'));
    assert.ok(editar.includes("f('fotos.acceso')"));
  });

  it('las tres pantallas tienen los estados completos, incluido el 503', () => {
    for (const [nombre, pantalla] of pantallas) {
      for (const trozo of [
        'state="loading"',
        'state="empty"',
        'onRetry',
        'esProductosApagado(',
        'esFalloDeRed(',
        'error.status === 403',
        'error.status === 401',
      ]) {
        assert.ok(pantalla.includes(trozo), `${nombre} no tiene ${trozo}`);
      }
    }
  });

  it('el bloqueo se enseña traducido y no se esconde', () => {
    assert.ok(productos.includes('claveDelBloqueo('));
    assert.ok(productos.includes('proveedorProductos.productos.bloqueoTitulo'));
  });

  it('el acceso del perfil usa el contrato para decidir a dónde lleva', () => {
    const perfil = sinComentarios(fuente('screens', 'ProfileScreen.tsx'));
    assert.ok(perfil.includes('rutaDelProveedor('));
    assert.ok(perfil.includes('esProveedorActivo('));
    assert.ok(perfil.includes('ProductSellerRepository.estado('));
    // Y no se inventa la ruta a mano.
    assert.ok(!perfil.includes("'/proveedor/postular'"));
  });

  it('las cuatro rutas de expo-router existen y apuntan a su pantalla', () => {
    const RUTAS: Array<[string, string]> = [
      ['postular.tsx', 'PostularProveedorScreen'],
      ['productos/index.tsx', 'MisProductosScreen'],
      ['productos/nuevo.tsx', 'EditarProductoScreen'],
      ['productos/[productId].tsx', 'EditarProductoScreen'],
    ];
    for (const [fichero, pantalla] of RUTAS) {
      const texto = readFileSync(join(AQUI, '..', '..', 'app', 'proveedor', fichero), 'utf8');
      assert.ok(texto.includes(pantalla), `${fichero} no monta ${pantalla}`);
    }
  });
});
