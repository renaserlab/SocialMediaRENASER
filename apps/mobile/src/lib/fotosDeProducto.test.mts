/**
 * Las fotografías de un producto, ejecutadas.
 *
 * SUBIR NO ES PUBLICAR, y casi todo lo que se prueba aquí sale de esa frase. Una
 * fotografía nace PENDIENTE; quien evalúa la aprueba o la rechaza con motivo, y
 * el catálogo solo enseña las aprobadas. Sin ese estado, aprobar un producto
 * aprobaría también cualquier imagen que le colgaran después, y el sello de Z
 * acabaría encima de una foto que nadie miró.
 *
 * Lo demás son las tres formas de romperlo que no fallan solas:
 *
 *  1. UN SVG NO ES UNA FOTOGRAFÍA. Es un documento con scripts. La lista de
 *     tipos es cerrada y no se amplía «porque el navegador lo pinta igual».
 *  2. UN TEXTO ALTERNATIVO VACÍO NO ES UN ADORNO DE ACCESIBILIDAD. Es lo único
 *     que queda cuando la URL firmada no se pudo firmar, y es lo que lee quien
 *     no ve. Por eso es obligatorio ANTES de elegir el archivo.
 *  3. UN ORDEN PARCIAL NO ES UN ORDEN. `ordenar` exige la lista COMPLETA de
 *     identificadores: mandar media lista deja a las que faltan en una posición
 *     que nadie eligió, y el resultado no es ni el orden viejo ni el nuevo.
 *
 * NO SE COMPRUEBAN LOS DICCIONARIOS. Las claves `fotos.*` todavía no están en
 * `es.ts`: viajan aparte, en el fichero de traducciones del incremento. Lo que
 * sí se comprueba es la FORMA de cada clave, porque un prefijo mal escrito no
 * falla: enseña la clave en crudo en mitad de la pantalla.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LARGO_MAXIMO_DEL_ALTERNATIVO,
  LARGO_MINIMO_DEL_ALTERNATIVO,
  MAXIMO_BYTES,
  MAXIMO_DE_FOTOS,
  TIPOS_ADMITIDOS,
  aprobadas,
  avisoDeLaGaleria,
  cabeOtraFoto,
  claveDeErrorDeFotos,
  claveDeLaSubida,
  claveDelEstadoDeLaFoto,
  claveDelMotivo,
  enOrden,
  esFotosApagado,
  hayAlgunaAprobada,
  iconoDelEstadoDeLaFoto,
  moverFoto,
  porQueNoSePuedeSubir,
  type FotoDelProveedor,
} from './fotosDeProducto.ts';

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

function foto(campos: Partial<FotoDelProveedor> = {}): FotoDelProveedor {
  return {
    id: 'foto-1',
    kind: 'image',
    storage_path: 'producto-1/foto-1.jpg',
    alt_text: 'Silla de nogal vista de frente',
    position: 1,
    status: 'pending',
    content_type: 'image/jpeg',
    byte_size: 120_000,
    width: 1200,
    height: 900,
    url: 'https://ejemplo/firmada',
    reviewed_at: null,
    rejection_reason: null,
    created_at: '2026-03-01T10:00:00Z',
    ...campos,
  };
}

/** Lo que se le pasa al comprobador antes de subir, con todo en regla. */
function subida(campos: Partial<Parameters<typeof porQueNoSePuedeSubir>[0]> = {}) {
  return {
    tipo: 'image/jpeg',
    bytes: 120_000,
    altText: 'Silla de nogal vista de frente',
    yaHay: 0,
    ...campos,
  };
}

/* ========================================================================== */
describe('lo que NO se puede subir, y por qué', () => {
  it('un SVG NO es una fotografía: es un documento con scripts', () => {
    assert.equal(porQueNoSePuedeSubir(subida({ tipo: 'image/svg+xml' })), 'tipo');
    assert.ok(!(TIPOS_ADMITIDOS as readonly string[]).includes('image/svg+xml'));
    // Y la lista es cerrada: tres tipos, ni uno más.
    assert.deepEqual([...TIPOS_ADMITIDOS], ['image/jpeg', 'image/png', 'image/webp']);
  });

  it('tampoco un GIF, un HEIC ni un ejecutable con nombre de foto', () => {
    for (const tipo of ['image/gif', 'image/heic', 'application/pdf', 'application/x-msdownload']) {
      assert.equal(porQueNoSePuedeSubir(subida({ tipo })), 'tipo', tipo);
    }
    // Sin tipo tampoco se supone ninguno.
    assert.equal(porQueNoSePuedeSubir(subida({ tipo: null })), 'tipo');
    assert.equal(porQueNoSePuedeSubir(subida({ tipo: '  ' })), 'tipo');
  });

  it('el `charset` que añaden algunos navegadores no convierte un JPEG en otra cosa', () => {
    assert.equal(porQueNoSePuedeSubir(subida({ tipo: 'image/jpeg; charset=binary' })), null);
    assert.equal(porQueNoSePuedeSubir(subida({ tipo: 'IMAGE/PNG' })), null);
  });

  it('un archivo de más de diez megas se para aquí, no tras subirlo', () => {
    assert.equal(MAXIMO_BYTES, 10 * 1024 * 1024);
    assert.equal(porQueNoSePuedeSubir(subida({ bytes: MAXIMO_BYTES + 1 })), 'peso');
    assert.equal(porQueNoSePuedeSubir(subida({ bytes: MAXIMO_BYTES })), null);
  });

  it('un archivo vacío no es una fotografía', () => {
    assert.equal(porQueNoSePuedeSubir(subida({ bytes: 0 })), 'vacio');
    assert.equal(porQueNoSePuedeSubir(subida({ bytes: -1 })), 'vacio');
  });

  it('un tamaño que no se sabe NO se trata como cero', () => {
    // En el teléfono el selector no siempre informa del tamaño. Suponer cero
    // rechazaría una foto perfectamente válida sin que saliera del aparato.
    assert.equal(porQueNoSePuedeSubir(subida({ bytes: null })), null);
    assert.equal(porQueNoSePuedeSubir(subida({ bytes: undefined })), null);
    assert.equal(porQueNoSePuedeSubir(subida({ bytes: Number.NaN })), null);
  });

  it('un texto alternativo de menos de tres caracteres no describe nada', () => {
    assert.equal(LARGO_MINIMO_DEL_ALTERNATIVO, 3);
    assert.equal(porQueNoSePuedeSubir(subida({ altText: '' })), 'alternativo');
    assert.equal(porQueNoSePuedeSubir(subida({ altText: 'ab' })), 'alternativo');
    assert.equal(porQueNoSePuedeSubir(subida({ altText: '   x   ' })), 'alternativo');
    assert.equal(porQueNoSePuedeSubir(subida({ altText: 'abc' })), null);
  });

  it('y uno larguísimo tampoco: el servidor lo corta igual', () => {
    const larguisimo = 'a'.repeat(LARGO_MAXIMO_DEL_ALTERNATIVO + 1);
    assert.equal(porQueNoSePuedeSubir(subida({ altText: larguisimo })), 'alternativo');
  });

  it('LA SEXTA FOTOGRAFÍA NO CABE, y se dice antes de elegir el archivo', () => {
    assert.equal(MAXIMO_DE_FOTOS, 5);
    assert.equal(porQueNoSePuedeSubir(subida({ yaHay: MAXIMO_DE_FOTOS })), 'demasiadas');
    assert.equal(porQueNoSePuedeSubir(subida({ yaHay: MAXIMO_DE_FOTOS + 1 })), 'demasiadas');
    assert.equal(porQueNoSePuedeSubir(subida({ yaHay: MAXIMO_DE_FOTOS - 1 })), null);
  });

  it('el tope manda sobre todo lo demás: primero se dice que no cabe', () => {
    // Pedir el texto alternativo de una foto que no va a caber es hacer
    // escribir para nada.
    assert.equal(
      porQueNoSePuedeSubir({ tipo: 'image/svg+xml', bytes: 0, altText: '', yaHay: 5 }),
      'demasiadas',
    );
  });

  it('cada motivo tiene su texto propio, y ninguno se repite', () => {
    const motivos = ['tipo', 'peso', 'vacio', 'alternativo', 'demasiadas'] as const;
    const claves = motivos.map(claveDelMotivo);
    assert.equal(new Set(claves).size, motivos.length);
    for (const clave of claves) assert.ok(clave.startsWith('fotos.noSePuede.'), clave);
  });

  it('`cabeOtraFoto` dice lo mismo que el comprobador', () => {
    assert.equal(cabeOtraFoto([]), true);
    assert.equal(cabeOtraFoto(Array.from({ length: 4 }, () => foto())), true);
    assert.equal(cabeOtraFoto(Array.from({ length: 5 }, () => foto())), false);
  });
});

/* ========================================================================== */
describe('solo las aprobadas se ven, y solo ellas cuentan', () => {
  const pendiente = foto({ id: 'a', position: 1, status: 'pending' });
  const aprobada = foto({ id: 'b', position: 2, status: 'approved' });
  const rechazada = foto({ id: 'c', position: 3, status: 'rejected' });

  it('las pendientes y las rechazadas SE QUEDAN FUERA', () => {
    assert.deepEqual(
      aprobadas([pendiente, aprobada, rechazada]).map((x) => x.id),
      ['b'],
    );
  });

  it('un estado que no conocemos tampoco se cuela como aprobado', () => {
    assert.deepEqual(aprobadas([foto({ id: 'd', status: 'inventado' })]), []);
  });

  it('con todas pendientes NO hay ninguna aprobada', () => {
    const todasPendientes = [
      foto({ id: 'a', status: 'pending' }),
      foto({ id: 'b', status: 'pending' }),
    ];
    assert.equal(hayAlgunaAprobada(todasPendientes), false);
    assert.deepEqual(aprobadas(todasPendientes), []);
  });

  it('con una sola aprobada, sí', () => {
    assert.equal(hayAlgunaAprobada([pendiente, aprobada]), true);
    assert.equal(hayAlgunaAprobada([]), false);
  });

  it('las aprobadas salen EN SU ORDEN, no en el que llegaron', () => {
    const desordenadas = [
      foto({ id: 'b', position: 3, status: 'approved' }),
      foto({ id: 'a', position: 1, status: 'approved' }),
    ];
    assert.deepEqual(
      aprobadas(desordenadas).map((x) => x.id),
      ['a', 'b'],
    );
  });
});

/* ========================================================================== */
describe('el aviso: UNO SOLO, y el más accionable primero', () => {
  it('EL RECHAZO MANDA: es lo único que quien vende puede corregir hoy', () => {
    const conRechazo = [
      foto({ id: 'a', status: 'approved' }),
      foto({ id: 'b', status: 'pending' }),
      foto({ id: 'c', status: 'rejected' }),
    ];
    assert.equal(avisoDeLaGaleria(conRechazo), 'fotos.aviso.rechazada');
  });

  it('el rechazo gana incluso cuando ninguna está aprobada', () => {
    const todoMal = [
      foto({ id: 'a', status: 'pending' }),
      foto({ id: 'b', status: 'rejected' }),
    ];
    assert.equal(avisoDeLaGaleria(todoMal), 'fotos.aviso.rechazada');
    assert.notEqual(avisoDeLaGaleria(todoMal), 'fotos.aviso.pendientes');
  });

  it('sin ninguna fotografía, que suba una', () => {
    assert.equal(avisoDeLaGaleria([]), 'fotos.aviso.ninguna');
  });

  it('con todas pendientes, que espere: no hay nada que hacer', () => {
    assert.equal(
      avisoDeLaGaleria([foto({ status: 'pending' })]),
      'fotos.aviso.pendientes',
    );
  });

  it('con alguna aprobada y nada rechazado NO se avisa de nada', () => {
    // Tres avisos a la vez es una pantalla que nadie lee.
    assert.equal(
      avisoDeLaGaleria([
        foto({ id: 'a', status: 'approved' }),
        foto({ id: 'b', status: 'pending' }),
      ]),
      null,
    );
  });
});

/* ========================================================================== */
describe('el orden viaja ENTERO', () => {
  const galeria = [
    foto({ id: 'a', position: 1 }),
    foto({ id: 'b', position: 2 }),
    foto({ id: 'c', position: 3 }),
  ];

  it('`enOrden` respeta `position`, que es lo que manda el servidor', () => {
    const desordenada = [
      foto({ id: 'c', position: 3 }),
      foto({ id: 'a', position: 1 }),
      foto({ id: 'b', position: 2 }),
    ];
    assert.deepEqual(
      enOrden(desordenada).map((x) => x.id),
      ['a', 'b', 'c'],
    );
  });

  it('con `position` repetida el desempate es estable, no aleatorio', () => {
    const empatadas = [foto({ id: 'b', position: 1 }), foto({ id: 'a', position: 1 })];
    assert.deepEqual(
      enOrden(empatadas).map((x) => x.id),
      ['a', 'b'],
    );
  });

  it('`enOrden` NO muta la lista que recibe', () => {
    const original = [foto({ id: 'c', position: 3 }), foto({ id: 'a', position: 1 })];
    enOrden(original);
    assert.deepEqual(
      original.map((x) => x.id),
      ['c', 'a'],
    );
  });

  it('mover DEVUELVE SIEMPRE LA LISTA COMPLETA', () => {
    // Una lista parcial dejaría a las que faltan en una posición que nadie
    // eligió, y el orden final no sería ni el viejo ni el nuevo.
    assert.deepEqual(moverFoto(galeria, 'b', -1), ['b', 'a', 'c']);
    assert.deepEqual(moverFoto(galeria, 'b', 1), ['a', 'c', 'b']);
    for (const paso of [1, -1] as const) {
      for (const id of ['a', 'b', 'c']) {
        assert.equal(moverFoto(galeria, id, paso).length, galeria.length, `${id} ${paso}`);
      }
    }
  });

  it('EN LOS EXTREMOS NO MUEVE NADA, y aun así devuelve la lista entera', () => {
    assert.deepEqual(moverFoto(galeria, 'a', -1), ['a', 'b', 'c']);
    assert.deepEqual(moverFoto(galeria, 'c', 1), ['a', 'b', 'c']);
  });

  it('una fotografía que no está deja el orden como estaba', () => {
    assert.deepEqual(moverFoto(galeria, 'no-existe', 1), ['a', 'b', 'c']);
    assert.deepEqual(moverFoto([], 'a', 1), []);
  });

  it('mover parte del orden del servidor, no del orden en que llegaron', () => {
    const desordenada = [
      foto({ id: 'c', position: 3 }),
      foto({ id: 'a', position: 1 }),
      foto({ id: 'b', position: 2 }),
    ];
    assert.deepEqual(moverFoto(desordenada, 'c', -1), ['a', 'c', 'b']);
  });

  it('mover y devolver deja la lista como estaba', () => {
    const ids = moverFoto(galeria, 'a', 1);
    const vueltos = moverFoto(
      ids.map((id, indice) => foto({ id, position: indice + 1 })),
      'a',
      -1,
    );
    assert.deepEqual(vueltos, ['a', 'b', 'c']);
  });
});

/* ========================================================================== */
describe('los estados, las claves y los errores', () => {
  it('los tres estados tienen texto e icono propios', () => {
    const estados = ['pending', 'approved', 'rejected'];
    const claves = estados.map(claveDelEstadoDeLaFoto);
    assert.equal(new Set(claves).size, 3);
    for (const clave of claves) assert.ok(clave.startsWith('fotos.estado.'), clave);
    const iconos = estados.map(iconoDelEstadoDeLaFoto);
    assert.equal(new Set(iconos).size, 3);
    assert.ok(iconos.every((x) => x !== null));
  });

  it('un estado desconocido no se pinta como aprobado ni lleva icono prestado', () => {
    assert.equal(claveDelEstadoDeLaFoto('inventado'), 'fotos.estado.desconocido');
    assert.equal(iconoDelEstadoDeLaFoto('inventado'), null);
  });

  it('cada código del servidor tiene su mensaje, y ninguno se repite', () => {
    const codigos = [
      'product_media_not_available',
      'product_media_not_found',
      'product_media_invalid',
      'product_media_limit_reached',
      'product_media_without_file',
      'product_media_not_approved',
      'product_media_required',
      'product_not_editable',
      'product_version_missing',
    ];
    const claves = codigos.map(claveDeErrorDeFotos);
    assert.ok(claves.every((x) => x !== null));
    assert.equal(new Set(claves).size, claves.length);
  });

  it('un código que no conocemos deja hablar al servidor', () => {
    assert.equal(claveDeErrorDeFotos('lo_que_sea'), null);
    assert.equal(claveDeErrorDeFotos(''), null);
    assert.equal(claveDeErrorDeFotos(null), null);
  });

  it('el 503 de la migración no es una avería, y se distingue', () => {
    assert.equal(esFotosApagado('product_media_not_available'), true);
    assert.equal(esFotosApagado('product_media_invalid'), false);
    assert.equal(esFotosApagado(null), false);
  });

  it('la clave de la subida es una por pulsación', () => {
    assert.equal(claveDeLaSubida('producto-1', 1_700_000_000_000), 'producto-1:1700000000000');
    assert.notEqual(claveDeLaSubida('producto-1', 1), claveDeLaSubida('producto-2', 1));
    assert.notEqual(claveDeLaSubida('producto-1', 1), claveDeLaSubida('producto-1', 2));
  });
});

/* ========================================================================== */
describe('lo que las pantallas tienen escrito', () => {
  const mias = sinComentarios(fuente('screens', 'FotosDeProductoScreen.tsx'));
  const bandeja = sinComentarios(fuente('screens', 'RevisarFotosScreen.tsx'));

  it('SUBIR NO ES PUBLICAR, dicho en la pantalla y no solo en un comentario', () => {
    assert.ok(mias.includes("f('fotos.subirNoEsPublicar')"));
  });

  it('el orden se manda ENTERO, pasando por `moverFoto`', () => {
    assert.ok(mias.includes('moverFoto(fotos, foto.id, paso)'));
    assert.ok(mias.includes('ProductMediaRepository.ordenar(productoId, orden)'));
    // Y no se manda una lista de un solo identificador.
    assert.ok(!mias.includes('ordenar(productoId, [foto.id])'));
  });

  it('sin URL se enseña el texto alternativo, no un hueco', () => {
    assert.ok(mias.includes('foto.url !== null'));
    assert.ok(mias.includes('cacheKey: foto.storage_path'));
    assert.ok(mias.includes('name="image"'));
    assert.ok(bandeja.includes('foto.url !== null'));
    assert.ok(bandeja.includes('cacheKey: foto.storage_path'));
  });

  it('se comprueba con el módulo antes de subir, no con condiciones a mano', () => {
    assert.ok(mias.includes('porQueNoSePuedeSubir('));
    assert.ok(mias.includes('claveDelMotivo('));
    assert.ok(mias.includes('cabeOtraFoto(fotos)'));
    // Ni un tope escrito a mano en la pantalla.
    assert.ok(!mias.includes('fotos.length >= 5'));
    assert.ok(!mias.includes('byte_size > 10'));
  });

  it('quitar pregunta antes, y el cerrojo se cierra antes del await', () => {
    const quitar = mias.slice(mias.indexOf('const quitar'));
    assert.ok(quitar.includes('confirm('));
    assert.ok(quitar.indexOf('confirm(') < quitar.indexOf('.quitar(productoId'));
    assert.ok(quitar.includes('destructive: true'));
    for (const [nombre, pantalla] of [
      ['FotosDeProductoScreen', mias],
      ['RevisarFotosScreen', bandeja],
    ] as Array<[string, string]>) {
      const cerrojo = pantalla.slice(pantalla.indexOf('const conCerrojo'));
      const hasta = cerrojo.slice(0, cerrojo.indexOf('await trabajo()'));
      assert.ok(hasta.includes('if (ocupadoRef.current) return;'), nombre);
      assert.ok(!hasta.includes('await '), `${nombre} tiene un await antes del cerrojo`);
    }
  });

  it('RECHAZAR NO SE PUEDE SIN MOTIVO: el botón está apagado hasta que lo hay', () => {
    assert.ok(bandeja.includes('motivo.trim().length >= LARGO_MINIMO_DEL_MOTIVO'));
    assert.ok(bandeja.includes('disabled={ocupado || !motivoSirve}'));
    assert.ok(bandeja.includes("f('fotos.bandeja.porQueMotivo')"));
    assert.ok(bandeja.includes('reason: limpio'));
  });

  it('«es tu propio producto» NO se enseña como un fallo de permisos genérico', () => {
    // El servidor manda dos 403 distintos y significan cosas distintas.
    assert.ok(bandeja.includes('falloDeCarga(error.status, error.code)'));
    assert.ok(bandeja.includes("'esTuProducto'"));
    assert.ok(bandeja.includes('claveDelFallo(fallo)'));
    assert.ok(bandeja.includes('claveDelCuerpoDelFallo(fallo)'));
  });

  it('las dos tienen sus estados, incluido el 503 de la migración', () => {
    for (const [nombre, pantalla] of [
      ['FotosDeProductoScreen', mias],
      ['RevisarFotosScreen', bandeja],
    ] as Array<[string, string]>) {
      assert.ok(pantalla.includes('state="loading"'), nombre);
      assert.ok(pantalla.includes('state="empty"'), nombre);
      assert.ok(pantalla.includes("'offline' : 'error'"), nombre);
      assert.ok(pantalla.includes('onRetry={() => void cargar()}'), nombre);
      assert.ok(pantalla.includes('esFotosApagado('), nombre);
    }
    assert.ok(bandeja.includes("icon=\"check-circle\""));
  });

  it('ningún texto en duro: todo pasa por el traductor', () => {
    for (const [nombre, pantalla] of [
      ['FotosDeProductoScreen', mias],
      ['RevisarFotosScreen', bandeja],
    ] as Array<[string, string]>) {
      for (const atributo of ['label="', 'title="', 'description="', 'placeholder="']) {
        assert.ok(!pantalla.includes(atributo), `${nombre} lleva ${atributo}`);
      }
      for (const atributo of ["title: '", "message: '", "confirmLabel: '"]) {
        assert.ok(!pantalla.includes(atributo), `${nombre} lleva ${atributo}`);
      }
    }
  });

  it('la pantalla de quien vende NO llama a rutas de administración', () => {
    assert.ok(!mias.includes('/admin/'));
    assert.ok(!mias.includes('.decidir('));
    assert.ok(!mias.includes('.pendientes('));
  });

  it('las rutas de expo-router existen y montan su pantalla', () => {
    const suya = readFileSync(
      join(AQUI, '..', '..', 'app', 'proveedor', 'productos', '[productId]', 'fotos.tsx'),
      'utf8',
    );
    assert.ok(suya.includes('FotosDeProductoScreen'));
    const admin = readFileSync(
      join(AQUI, '..', '..', 'app', 'admin', 'productos', 'fotos.tsx'),
      'utf8',
    );
    assert.ok(admin.includes('RevisarFotosScreen'));
  });

  it('se llega a las dos desde donde se tiene que llegar', () => {
    const editar = sinComentarios(fuente('screens', 'EditarProductoScreen.tsx'));
    assert.ok(editar.includes('/fotos'));
    assert.ok(editar.includes("f('fotos.acceso')"));
    const panel = sinComentarios(fuente('screens', 'AdminProductosScreen.tsx'));
    assert.ok(panel.includes("'/admin/productos/fotos'"));
    assert.ok(panel.includes("f('fotos.bandeja.acceso')"));
  });
});
