/**
 * Los tres diccionarios dicen lo MISMO, y lo dicen en su idioma.
 *
 * Esta es la prueba que impide que la traduccion se vuelva a desincronizar.
 * Cubre los dos fallos que se han visto de verdad:
 *
 *  1. Una clave se añade al español y se olvida en `en`/`pt`. Como `translate`
 *     cae al español cuando falta la traduccion, el olvido NO se nota mirando
 *     la aplicacion: simplemente aparece una frase en español en medio del
 *     ingles. Aqui si se nota.
 *
 *  2. La clave existe en los tres, pero el texto de `en`/`pt` es el español
 *     copiado. Es el mismo agujero, disfrazado de trabajo hecho.
 *
 * El segundo caso tiene excepciones legitimas: «Podcast», «Live», «Z», o
 * palabras que el portugues escribe igual que el español («Perfil»,
 * «Cancelar»). Se admiten, pero solo si estan escritas AQUI: una coincidencia
 * nueva que nadie ha declarado falla, y quien la añada tiene que decir por que.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { es } from './es.ts';
import { en } from './en.ts';
import { pt } from './pt.ts';
import { RESPALDOS_ES as RESPALDOS_DE_AUTH } from '../lib/authErrors.ts';
import { RESPALDOS_ES as RESPALDOS_DE_MOTIVOS } from '../lib/motivoDeRecomendacion.ts';
import { RESPALDOS_ES as RESPALDOS_DE_CURSOS } from '../lib/motivoDeCurso.ts';
import { RESPALDOS_ES as RESPALDOS_DE_ENLACES } from '../lib/enlaces.ts';
import { RESPALDOS_ES as RESPALDOS_DEL_ASISTENTE } from '../lib/asistenteDeCurso.ts';
import { RESPALDOS_ES as RESPALDOS_DE_ENLACE } from '../lib/authLink.ts';
import { RESPALDOS_ES as RESPALDOS_DE_DINERO } from '../lib/dinero.ts';
import { RESPALDOS_ES as RESPALDOS_DE_HISTORIAS } from '../lib/historias.ts';
import { RESPALDOS_ES as RESPALDOS_DE_GUARDADOS } from '../lib/guardados.ts';
import { RESPALDOS_ES as RESPALDOS_DE_VALORACIONES } from '../lib/valoracionesDeCurso.ts';

/**
 * Los módulos que guardan su propia copia del español.
 *
 * Son los que se prueban con el runner de Node —que no resuelve el alias
 * `@/`— y por eso no pueden importar el diccionario: reciben el idioma por
 * parámetro y llevan dentro el español de repuesto. Aquí se comprueba que esa
 * copia y el diccionario dicen exactamente lo mismo.
 */
const RESPALDOS: Array<[string, Record<string, string>]> = [
  ['lib/authErrors.ts', RESPALDOS_DE_AUTH],
  ['lib/motivoDeRecomendacion.ts', RESPALDOS_DE_MOTIVOS],
  ['lib/motivoDeCurso.ts', RESPALDOS_DE_CURSOS],
  ['lib/enlaces.ts', RESPALDOS_DE_ENLACES],
  ['lib/asistenteDeCurso.ts', RESPALDOS_DEL_ASISTENTE],
  ['lib/authLink.ts', RESPALDOS_DE_ENLACE],
  ['lib/dinero.ts', RESPALDOS_DE_DINERO],
  ['lib/historias.ts', RESPALDOS_DE_HISTORIAS],
  ['lib/guardados.ts', RESPALDOS_DE_GUARDADOS],
  ['lib/valoracionesDeCurso.ts', RESPALDOS_DE_VALORACIONES],
];

type Diccionario = Record<string, string>;

const REFERENCIA = es as unknown as Diccionario;
const TRADUCCIONES: Array<[string, Diccionario]> = [
  ['en', en as Diccionario],
  ['pt', pt as Diccionario],
];

/**
 * Entradas que coinciden con el español a proposito.
 *
 * Motivos validos: nombres propios y marcas (Z, Google, Podcast, Live),
 * abreviaturas internacionales (OK), y palabras que el portugues escribe
 * exactamente igual que el español. NO es valido apuntar aqui una frase
 * porque «ya se entiende»: eso es dejarla sin traducir.
 */
const IGUALES_A_PROPOSITO: Record<string, ReadonlySet<string>> = {
  en: new Set<string>([
    // Incremento 5 de Productos: se escriben igual en espanol y en ingles.
    'pedidoDeProducto.checkout.subtotal', // «Subtotal» es la misma palabra.
    'pedidoDeProducto.checkout.total',    // «Total», tambien.
    // Incremento 4: se escriben igual en español y en inglés.
    'carrito.subtotal',     // «Subtotal» es la misma palabra.
    'inventario.sku',       // «SKU» es una sigla inglesa.
    'fotos.bandeja.peso',   // Un número y «KB».
    // Formato puro: un numero, un separador y un importe ya formateado.
    'entradas.subtotalDeTipo',
    'reserva.porUnidad',
    // «Total» se escribe igual en los dos idiomas.
    'constancia.total',
    'home.live', // «Live» ya es la palabra inglesa.
    'home.podcast',
    'profile.podcast',
    'settings.legal',
    'create.modeReel', // «Reel» ya es la palabra inglesa.
    'audio.audio',
    // Formato puro: solo dos puntos y los huecos.
    'field.dateWithLabel',
    'field.timeWithLabel',
    // Un numero y el simbolo del segundo, que se escribe igual en los tres.
    'story.trimSeconds',
    'video.video',
    'gallery.videos',
    // «Mentor» y el separador se escriben igual en los tres idiomas.
    'lesson.mentorSuffix',
    // «Feed» y «Chat» ya son las palabras inglesas.
    'circle.tabFeed',
    'circle.tabChat',
    'category.audiosOne',
    // Formato puro: un numero, un punto medio y un texto ya traducido.
    'finanzasEvento.hallazgoContado',
    // «No» y «Visible» se escriben igual en los dos idiomas.
    'politicasEvento.ternario.no',
    'politicasAdmin.valor.no',
    'moderacionResenas.estado.visible',
    // Formato puro: una flecha entre dos huecos, y un número con su unidad.
    'politicasAdmin.antesAhora',
    'politicasAdmin.valor.horas',
    // Formato puro: el tipo de evidencia y su dimensión, ya traducidos, con un
    // punto medio en medio.
    'productosAdmin.evidenciaEtiqueta',
    // Formato puro: el contador de la galeria, «{i}/{n}».
    'productos.ficha.galeriaContador',
    // Proveedor de productos. Dos de formato puro —«{tipo} · {detalle}» y
    // «{nombre}, {estado}», donde lo de dentro ya viene traducido—, «SKU», que
    // es la misma sigla en los tres idiomas, y un numero de ejemplo.
    'proveedorProductos.postular.documentoContado',
    'proveedorProductos.productos.tarjeta',
    'proveedorProductos.editar.skuEtiqueta',
    'proveedorProductos.editar.opcionValorAyuda',
  ]),
  pt: new Set<string>([
    // Incremento 6 de Productos: el portugues escribe estas EXACTAMENTE igual
    // que el espanol. No son traducciones olvidadas; escribirlas distintas
    // seria escribirlas mal.
    'envio.estado.DISPATCHED',        // «Despachado».
    'envio.motivo.etiqueta',          // «Motivo».
    'envio.proveedor.pedido',         // «Pedido».
    'envio.proveedor.unidades',       // «{n} unidades».
    'envio.preparar.contadas',        // «{hechas} de {total}»: formato puro.
    'envio.preparar.reabrir',         // «Reabrir».
    'envio.preparar.despachoTitulo',  // «Despachar».
    'envio.preparar.despachar',       // «Despachar».
    'envio.detalle.transporte',       // «Transporte».
    'envio.detalle.motivoDelFallo',   // «Motivo: {motivo}».
    // Incremento 5 de Productos: el portugues las escribe igual.
    'pedidoDeProducto.estado.CANCELLED',      // «Cancelado».
    'pedidoDeProducto.falta.desconocido',     // «Falta algo por configurar.»
    'pedidoDeProducto.direccion.postal_code', // «Codigo postal (opcional)».
    'pedidoDeProducto.condiciones.horas',     // «{n} horas».
    'pedidoDeProducto.checkout.titulo',       // «Comprar».
    'pedidoDeProducto.checkout.subtotal',     // «Subtotal».
    'pedidoDeProducto.checkout.total',        // «Total».
    'pedidoDeProducto.checkout.unidades',     // «{n} unidades».
    'pedidoDeProducto.pagar.titulo',          // «Pagar».
    'pedidoDeProducto.detalle.entrega',       // «Entrega».
    // Incremento 4: español y portugués comparten estas palabras enteras. No
    // son traducciones olvidadas; escribirlas distintas sería escribirlas mal.
    'carrito.subtotal',
    'carrito.proveedor',            // «De {nombre}».
    'carrito.precioAnterior',       // «Antes: …».
    'carrito.guardadosContador',    // «{n} guardados».
    'inventario.sku',
    'inventario.comprometidas',
    'inventario.ajustar',
    'inventario.ajusteHecho',       // «Ajuste registrado».
    'inventario.motivoDelMovimiento',
    'inventario.movimiento.intake',       // «Entrada».
    'inventario.movimiento.adjustment',   // «Ajuste».
    'inventario.movimiento.reservation',  // «Reserva».
    'fotos.bandeja.alternativo',    // «Texto alternativo: …».
    'fotos.bandeja.peso',
    // Políticas y moderación: palabras que se escriben exactamente igual en
    // portugués —«Publicar», «Descartar», «Igual», «Publicada», «Evento»,
    // «Aplicar», «Estado», «Organizador», «Publicadas», «Saldo negativo»,
    // «Ocultar», «Oculta», «Todas», «Confirmar», «Motivo», «Ocultada»,
    // «Avisos enviados», «caracteres», «Políticas de eventos», «Tipo»— y tres
    // de formato puro.
    'politicasEvento.accion.publicar',
    'politicasEvento.cancelar.avisos',
    'politicasEvento.descartarBoton',
    'politicasEvento.publicarBoton',
    'politicasAdmin.antesAhora',
    'politicasAdmin.cambio.igual',
    'politicasAdmin.estado.published',
    'politicasAdmin.eventoRef',
    'politicasAdmin.filtroAplicar',
    'politicasAdmin.filtroEstado',
    'politicasAdmin.filtroEvento',
    'politicasAdmin.filtroOrganizador',
    'politicasAdmin.filtroTipo',
    'politicasAdmin.organizador',
    'politicasAdmin.pestana.publicadas',
    'politicasAdmin.sinPoliticaResumen',
    'politicasAdmin.tipo.negative_balance',
    'politicasAdmin.tituloPanel',
    'politicasAdmin.valor.horas',
    'moderacionResenas.accion.ocultar',
    'moderacionResenas.estado.hidden',
    'moderacionResenas.eventoRef',
    'moderacionResenas.filtroAplicar',
    'moderacionResenas.filtroEstado',
    'moderacionResenas.filtroEvento',
    'moderacionResenas.filtroTodas',
    'moderacionResenas.mandar',
    'moderacionResenas.motivoContador',
    'moderacionResenas.motivoOpcional',
    'moderacionResenas.ocultadaPor',
    'moderacionResenas.pasoMotivo',
    // Finanzas: once palabras que se escriben exactamente igual en portugues
    // —«Vendido», «Transferido», «Cancelado», «Perdida», «Disputas», «Todas»,
    // «Motivo», «Contadores», «Saldos transferidos»— y una de formato puro.
    'finanzasEvento.bruto',
    'finanzasEvento.contador.saldos_transferred',
    'finanzasEvento.disputa.lost',
    'finanzasEvento.disputasTitulo',
    'finanzasEvento.estadoSaldo.cancelled',
    'finanzasEvento.estadoSaldo.transferred',
    'finanzasEvento.filtroTodas',
    'finanzasEvento.hallazgoContado',
    'finanzasEvento.motivoEtiqueta',
    'finanzasEvento.saludTitulo',
    'finanzasEvento.transferido',
    // Entradas: «Desde», «Reserva gratuita», «Retirar» y «Retirado» se
    // escriben exactamente igual en los dos idiomas; las dos ultimas son
    // formato puro.
    'evento.desde',
    'modoDeAcceso.FREE_RSVP',
    'entradas.retirar',
    // «Retirar {tipo}» y «{n} de {tipo}»: el verbo y la preposicion se escriben
    // igual en los dos idiomas, y lo demas es el nombre que puso el organizador.
    'entradas.retirarTipo',
    'entradas.elegidasDe',
    // «Codigo: …», «Buscar por codigo» y «Todos» se escriben exactamente igual
    // en los dos idiomas.
    'miEntrada.codigoAccesible',
    'asistentes.buscar',
    'asistentes.todos',
    'entradas.estado.retired',
    'entradas.subtotalDeTipo',
    'reserva.porUnidad',
    // Admision de eventos. «Publicado», «Cancelado», «Editar evento»,
    // «Titulo», «Publicar» y «Total: … de …» se escriben exactamente igual en
    // los dos idiomas; `admisionEvento.deTope` es formato puro.
    'estadoDeEvento.PUBLISHED',
    'estadoDeEvento.CANCELLED',
    'miEvento.titulo',
    'miEvento.campoTitulo',
    'admisionEvento.deTope',
    'admisionEvento.total',
    'admisionEvento.publicar',
    'admisionEvento.publicado',
    // «Evento», «Organizador», «inscritos», «Cancelar reserva», «Reserva
    // cancelada», «Presencial» y «Todas» se escriben igual en los dos idiomas.
    'evento.titulo',
    'evento.organizadorSinNombre',
    'evento.inscritos',
    'evento.cancelarConfirmar',
    'evento.reservaCancelada',
    'evento.modalidad.presencial',
    'eventos.todasLasModalidades',
    // «Motivo» se escribe exactamente igual en los dos idiomas.
    'solicitud.motivo',
    // «Anterior», «Ver certificado», «Certificado», «Este documento certifica
    // que», «Verificar certificado» y «Continuar» se escriben exactamente
    // igual en los dos idiomas.
    'evaluacion.anterior',
    'completado.verCertificado',
    'certificado.titulo',
    'certificado.certificaQue',
    'certificado.verificar',
    'biblioteca.continuar',
    // «Recursos», «Notas», «Guardar nota», «Nota guardada», «Editar nota» y
    // «Notas guardadas» se escriben exactamente igual en los dos idiomas.
    'lesson.tabResources',
    'lesson.tabNotes',
    'nota.guardar',
    'nota.guardada',
    'nota.editar',
    'nota.guardadas',
    // «Cursos» y «Eventos» se escriben exactamente igual en los dos idiomas.
    'verticales.cursos',
    // «Todos» y «Principiante» se escriben igual en los dos idiomas.
    'cursos.nivel.todos',
    // «Guardados», «Guardar curso» y «Requisitos» se escriben igual.
    'cursos.guardados',
    // «Por {nombre}» se escribe igual en los dos idiomas.
    'curso.por',
    // «Antes de continuar» se escribe igual en los dos idiomas.
    'condiciones.titulo',
    // «Curso», «Estado», «Total», «Confirmada», «Cancelada» y «Reembolsada»
    // se escriben igual en los dos idiomas.
    'constancia.curso',
    // «Anterior» se escribe igual en los dos idiomas.
    'lesson.previous',
    'constancia.estado',
    'constancia.total',
    'constancia.estados.paid',
    'constancia.estados.cancelled',
    'constancia.estados.refunded',
    'cursos.guardar',
    'ficha.requisitos',
    'cursos.nivel.beginner',
    'verticales.eventos',
    // «Programa» y «Restaurar compras» se escriben igual en los dos idiomas.
    'course.headerTitle',
    'course.restorePurchases',
    // Portugues y español escriben estas igual. Se comprueban una a una.
    // Los nombres bajo los botones de una publicacion: «Comentar» es la misma
    // palabra en los dos idiomas —«Curtir» y «Compartilhar», que si cambian, no
    // estan aqui— y «Ver lista» tambien.
    //
    // `post.actionRepost` YA NO ESTA: el español paso a «Repostear» y el
    // portugues conserva «Republicar», que es su forma correcta. Al dejar de
    // coincidir, la excepcion sobraba.
    // Devoluciones: «Cancelada» y «Retirada» se escriben igual en los dos
    // idiomas, igual que ya pasaba con `agenda.stateCancelled`.
    'compras.estado.cancelled',
    'devolucion.estado.cancelled',
    // «Publicado», «Reel publicado» y «Usar esta foto» tambien coinciden.
    'create.postPublished',
    'create.reelPublished',
    'profile.usePhoto',
    'post.actionComment',
    'post.viewSavedList',
    // «Responder» es la misma palabra en los dos idiomas; «Respondendo a» y
    // «Escreva uma resposta», que si cambian, no estan aqui.
    'post.reply',
    // «Filtros» y «Todas» se escriben igual en los dos idiomas; el resto de los
    // filtros de la bandeja sí cambian («Não lidas», «Sem resposta»).
    'messages.filters',
    'messages.filterAll',
    'tabs.explore',
    'tabs.profile',
    'home.live',
    'home.events',
    'home.courses',
    'home.podcast',
    'profile.titlePublic',
    'profile.followers',
    'profile.follow',
    'profile.podcast',
    'profile.events',
    'profile.courses',
    'profile.circles',
    'profile.bookSession',
    'profile.editProfile',
    'settings.legal',
    'settings.light',
    'settings.system',
    'language.title',
    'language.continue',
    'common.cancel',
    'common.edit',
    'common.publish',
    'live.badgeCancelled',
    'explore.headerTitle',
    'explore.recommendedProgram',
    'explore.recommendedProgramA11y',
    'explore.communities',
    'explore.privateCircle',
    'explore.circleA11y',
    'search.title',
    'search.searching',
    'search.groupCourses',
    'search.groupEvents',
    'search.program',
    'events.upcoming',
    'event.reserved',
    'event.reserve',
    'event.editNamed',
    'chat.sending',
    'chat.viewPhoto',
    'chat.viewVideo',
    'create.modeReel',
    'create.publishReel',
    'video.mute',
    'field.dateWithLabel',
    'field.timeWithLabel',
    'story.trimSeconds',
    'course.viewProgram',
    'auth.reasonComment',
    'common.discard',
    'post.block',
    'blocked.unblock',
    'members.viewProfile',
    'common.send',
    'profile.avatarPhoto',
    'gallery.all',
    'gallery.photos',
    'gallery.photo',
    'lesson.mentorSuffix',
    'course.purchased',
    'course.purchasesRestored',
    'course.published',
    'course.unpublishConfirm',
    'course.unpublished',
    'course.modules',
    'course.buy',
    'course.continue',
    'course.publish',
    'circle.headerTitle',
    'circle.tabFeed',
    'circle.tabChat',
    'circle.tabResources',
    'course.moduleOne',
    'common.showLess',
    'intro.recordingTime',
    'booking.time',
    'booking.confirm',
    'agenda.headerTitle',
    'agenda.stateAccepted',
    'agenda.stateCancelled',
    'agenda.stateCompleted',
    'agenda.markedDone',
    'agenda.upcoming',
    'support.documents',
    'live.reactionClap',
    'live.end',
    'live.hide',
    'catalog.eventPublished',
    'catalog.editEvent',
    'catalog.editCourse',
    'catalog.time',
    'catalog.place',
    'catalog.free',
    'catalog.publishEvent',
    'catalog.publishCourse',
    'syllabus.optional',
    'syllabus.text',
    'syllabus.video',
    'syllabus.editModuleTitle',
    'syllabus.moduleTitleExample',
    'syllabus.titleField',
    'wizard.levelBeginner',
    'wizard.language',
    // Valoraciones de un curso: «{n} de 5» y «Retirar» se escriben exactamente
    // igual en los dos idiomas, y «Compra verificada» tambien (el portugues
    // dice «compra» y «verificada» con la misma grafia). El resto de la
    // seccion SI cambia: «Avaliações», «Sem avaliações», «1 avaliação».
    'valoracion.deCinco',
    'valoracion.distribucionA11y',
    'valoracion.compraVerificada',
    'valoracion.retirarConfirmar',
    // Productos Z: palabras y frases que el portugues escribe exactamente
    // igual que el español —«Guardado», «Guardar», «Variantes», «De {nombre}»,
    // «Fabricante: …», «Lote», «Documento», «Entra para guardar»— mas dos de
    // formato puro: «{n} guardados» y el SEPARADOR DECIMAL, que en los dos
    // idiomas es la coma (el ingles si cambia: usa el punto).
    'productos.bolsaContador',
    'productos.guardado',
    'productos.separadorDecimal',
    'productos.accion.guardar',
    'productos.bloque.variantes',
    'productos.ficha.creadorEs',
    'productos.ficha.fabricante',
    'productos.evidencia.batch',
    'productos.evidencia.document',
    'productos.error.sinSesion',
    // Formato puro: el contador de la galeria, «{i}/{n}».
    'productos.ficha.galeriaContador',
    // Administración de productos: palabras que el portugues escribe
    // exactamente igual que el español —«Filtrar por estado», «Todos»,
    // «Publicar», «Suspender», «Motivo (opcional)», «Notas internas
    // (opcional)», «Decidir», «Publicado», «Retirado», «Retirada», «Lote»,
    // «Documento» y «Fabricante»— y tres de formato puro: «Nota: …»,
    // «{n} de {max} caracteres» y el tipo de evidencia con su dimension.
    'productosAdmin.filtroEstado',
    'productosAdmin.filtroTodos',
    'productosAdmin.publicar',
    'productosAdmin.suspender',
    'productosAdmin.documentoNota',
    'productosAdmin.motivoOpcional',
    'productosAdmin.motivoContador',
    'productosAdmin.notasEtiqueta',
    'productosAdmin.evidenciaEtiqueta',
    'productosAdmin.decidir',
    'productosAdmin.estado.published',
    'productosAdmin.estado.removed',
    'productosAdmin.postulacion.withdrawn',
    'productosAdmin.evidencia.batch',
    'productosAdmin.evidencia.document',
    'productosAdmin.documento.manufacturer',
    // Proveedor de productos: «Tipo de documento», «Nota», «Fabricante» y
    // «Variantes» se escriben exactamente igual en portugues, y
    // `opcionValorAyuda` es un numero de ejemplo.
    //
    // «Texto alternativo» SALIO DE ESTA LISTA con el editor de galeria de
    // `EditarProductoScreen`: la clave ya no existe en ningun diccionario,
    // porque las fotografias ya no se escriben a mano.
    'proveedorProductos.postular.tipoDeDocumento',
    'proveedorProductos.postular.notaEtiqueta',
    'proveedorProductos.documento.manufacturer',
    'proveedorProductos.editar.fabricanteEtiqueta',
    'proveedorProductos.editar.variantes',
    'proveedorProductos.editar.opcionValorAyuda',
  ]),
};

/** Los huecos `{nombre}` de un texto, en orden alfabetico y sin repetidos. */
function huecos(texto: string): string[] {
  return [...new Set([...texto.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

describe('los tres idiomas tienen exactamente las mismas claves', () => {
  const claves = Object.keys(REFERENCIA);

  it('el español no tiene claves repetidas ni vacias', () => {
    assert.equal(new Set(claves).size, claves.length);
    const vacias = claves.filter((k) => REFERENCIA[k].trim() === '');
    assert.deepEqual(vacias, []);
  });

  for (const [idioma, diccionario] of TRADUCCIONES) {
    it(`a ${idioma} no le falta ninguna clave`, () => {
      const faltan = claves.filter((k) => !(k in diccionario));
      assert.deepEqual(
        faltan,
        [],
        `sin traducir en ${idioma}: ${faltan.join(', ')}`,
      );
    });

    it(`${idioma} no tiene claves que ya no existen en español`, () => {
      const sobran = Object.keys(diccionario).filter((k) => !(k in REFERENCIA));
      assert.deepEqual(
        sobran,
        [],
        `sobran en ${idioma}: ${sobran.join(', ')}`,
      );
    });

    it(`ninguna entrada de ${idioma} esta vacia`, () => {
      const vacias = Object.keys(diccionario).filter((k) => diccionario[k].trim() === '');
      assert.deepEqual(vacias, []);
    });
  }
});

describe('las traducciones estan traducidas de verdad', () => {
  for (const [idioma, diccionario] of TRADUCCIONES) {
    const permitidas = IGUALES_A_PROPOSITO[idioma];

    it(`ninguna entrada de ${idioma} es el español copiado`, () => {
      const copiadas = Object.keys(diccionario).filter(
        (k) => k in REFERENCIA && diccionario[k] === REFERENCIA[k] && !permitidas.has(k),
      );
      assert.deepEqual(
        copiadas,
        [],
        `sin traducir (identicas al español) en ${idioma}: ${copiadas.join(', ')}`,
      );
    });

    it(`la lista de excepciones de ${idioma} no tiene entradas obsoletas`, () => {
      // Una excepcion que ya no coincide es una excepcion que sobra: mantenerla
      // taparia el dia que alguien vuelva a copiar el español en esa clave.
      const obsoletas = [...permitidas].filter(
        (k) => !(k in diccionario) || diccionario[k] !== REFERENCIA[k],
      );
      assert.deepEqual(
        obsoletas,
        [],
        `excepciones que ya no hacen falta en ${idioma}: ${obsoletas.join(', ')}`,
      );
    });
  }
});

describe('el español de repuesto que llevan dentro algunos módulos', () => {
  for (const [modulo, respaldos] of RESPALDOS) {
    it(`${modulo} dice lo mismo que \`es.ts\`, palabra por palabra`, () => {
      const distintos = Object.entries(respaldos)
        .filter(([clave, texto]) => REFERENCIA[clave] !== texto)
        .map(([clave]) => clave);
      assert.deepEqual(
        distintos,
        [],
        `el respaldo de ${modulo} se ha desviado de i18n/es.ts: ${distintos.join(', ')}`,
      );
    });

    it(`${modulo} no apunta a claves que ya no existen`, () => {
      const huerfanas = Object.keys(respaldos).filter((k) => !(k in REFERENCIA));
      assert.deepEqual(huerfanas, []);
    });
  }
});

describe('los huecos de las frases con datos dentro', () => {
  for (const [idioma, diccionario] of TRADUCCIONES) {
    it(`${idioma} conserva los mismos {huecos} que el español`, () => {
      const rotas: string[] = [];
      for (const [clave, texto] of Object.entries(diccionario)) {
        if (!(clave in REFERENCIA)) continue;
        const esperados = huecos(REFERENCIA[clave]);
        const puestos = huecos(texto);
        if (esperados.join('|') !== puestos.join('|')) {
          rotas.push(`${clave} (español: ${esperados.join(',') || '—'}; ${idioma}: ${puestos.join(',') || '—'})`);
        }
      }
      assert.deepEqual(rotas, [], `huecos que no cuadran en ${idioma}: ${rotas.join(' · ')}`);
    });
  }
});
