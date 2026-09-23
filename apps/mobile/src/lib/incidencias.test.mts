/**
 * El expediente de algo que llegó mal, ejecutado. Incremento 7.
 *
 * Lo que se prueba aquí es, sobre todo, LO QUE NO SE PUEDE DECIR. Esta es la
 * pantalla donde alguien está esperando su dinero de vuelta: basta con un
 * importe pintado, con un «resuelto» que suene a «pagado» o con una fecha de
 * decisión inventada para prometer algo que Z no puede cumplir todavía.
 *
 *  1. NI UN SOLO IMPORTE, en ningún sitio: cuánto se devuelve no lo ha decidido
 *     nadie y el contrato del servidor tampoco lo trae.
 *  2. RESOLVER NO ES PAGAR, Y ABRIR NO ES APROBAR: las dos frases viven en las
 *     pantallas, y ninguna dice lo contrario.
 *  3. NINGUNA FECHA DE LA DECISIÓN DE Z: «tres días hábiles» no se calcula.
 *  4. NADA VUELVE AL ALMACÉN: ni el módulo ni las pantallas saben de inventario.
 *  5. EL PROVEEDOR NO RESUELVE SU PROPIO CASO: no hay ruta ni botón.
 *  6. LAS PANTALLAS NO DECIDEN NINGÚN SALTO: solo ofrecen lo que el servidor ya
 *     ofreció en `available_transitions`.
 *  7. PEDIR MÁS PRUEBAS NO ES UNA SALIDA: es un paso.
 *  8. EL PLAZO SE DICE COMO UN HECHO, nunca como un incumplimiento, y NULO NO
 *     ES VENCIDO: es «ahora no le toca a él».
 *  9. LA ENTREGA NEGADA NO PUEDE PEDIR FOTOGRAFÍAS.
 * 10. LOS MOTIVOS, ESTADOS Y SALIDAS DEL MÓVIL SON LOS DEL SERVIDOR, leídos de
 *     su fichero: el contrato no se copia de memoria.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Incidencia, PasoDelCaso, PruebaDelCaso } from './incidencias.ts';

/** El mismo resolutor que `envios.test.mts`, y por lo mismo: `@/` no es Node. */
registerHooks({
  resolve(especificador, contexto, siguiente) {
    if (especificador.startsWith('@/')) {
      return {
        url: new URL(`../${especificador.slice(2)}.ts`, import.meta.url).href,
        shortCircuit: true,
      };
    }
    return siguiente(especificador, contexto);
  },
});

const {
  DESCRIPCION_MAXIMA,
  DESCRIPCION_MINIMA,
  ENTREGA_NEGADA,
  ESTADOS_DE_INCIDENCIA,
  FOTOS_MAXIMAS,
  FOTOS_MINIMAS,
  HAY_IMPORTE_DE_REEMBOLSO,
  HAY_PLAZO_DE_DECISION,
  HORAS_PARA_APELAR,
  HORAS_PARA_RESPONDER,
  MOTIVOS,
  MOTIVOS_DEL_PRODUCTO,
  PEDIR_MAS_EVIDENCIA,
  PROPUESTAS,
  RESOLUCIONES,
  VIVAS,
  cabenMasFotos,
  casoVivo,
  claveDeErrorDeIncidencias,
  claveDeLaResolucion,
  claveDelEstadoDeIncidencia,
  claveDelMotivo,
  claveDelPlazo,
  claveDelRechazo,
  descripcionValida,
  esEstadoConocido,
  esIncidenciaApagada,
  esMotivoConocido,
  fotosExigidas,
  fotosQueFaltan,
  historialPintable,
  horasQueLeQuedan,
  iconoDelEstadoDeIncidencia,
  ofrece,
  pideLinea,
  porQueNoSePuedeAdjuntar,
  esperaRegistrarLaReposicion,
  quedaAlgoPendiente,
  sePasoDelPlazo,
  sePuedeApelar,
  sePuedeAportarEvidencia,
  sePuedeEnviar,
  sePuedeEscalar,
  sePuedeRetirar,
  sigueVivo,
} = await import('./incidencias.ts');

const AQUI = fileURLToPath(new URL('.', import.meta.url));

function fuente(carpeta: string, nombre: string): string {
  return readFileSync(join(AQUI, '..', carpeta, nombre), 'utf8');
}

/** El servidor, leído de verdad: el contrato no se copia de memoria. */
function delServidor(ruta: string): string {
  return readFileSync(
    join(AQUI, '..', '..', '..', 'api', 'app', 'modules', 'products', ruta),
    'utf8',
  );
}

/** El código sin comentarios: lo que la pantalla HACE, no lo que explica. */
function sinComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((linea) => !linea.trim().startsWith('//') && !linea.trim().startsWith('*'))
    .join('\n');
}

/** Las seis pantallas del incremento, juntas. */
const PANTALLAS = [
  'ReportarProblemaScreen.tsx',
  'ReclamacionScreen.tsx',
  'ReclamacionesDeMiTiendaScreen.tsx',
  'ResponderReclamacionScreen.tsx',
  'AdminReclamacionesScreen.tsx',
  'DecidirReclamacionScreen.tsx',
];

function prueba(campos: Partial<PruebaDelCaso> = {}): PruebaDelCaso {
  return {
    id: 'ev-1',
    uploaded_role: 'buyer',
    content_type: 'image/png',
    byte_size: 1024,
    width: 8,
    height: 8,
    caption: null,
    url: null,
    created_at: '2026-09-20T10:00:00Z',
    ...campos,
  };
}

function caso(campos: Partial<Incidencia> = {}): Incidencia {
  return {
    id: 'pi-1',
    order_id: 'po-1',
    order_item_id: 'it-1',
    reason: 'DAMAGED',
    description: 'Llego con el cristal roto y la caja aplastada por un lado.',
    status: 'OPEN',
    seller_response_due_at: null,
    seller_responded_at: null,
    seller_proposal: null,
    resolution: null,
    resolved_at: null,
    financial_effect: null,
    appeal_due_at: null,
    appealed_at: null,
    appeals_used: 0,
    withdrawn_at: null,
    evidence: [],
    history: [],
    available_transitions: [],
    created_at: '2026-09-20T09:00:00Z',
    ...campos,
  };
}

function paso(campos: Partial<PasoDelCaso> = {}): PasoDelCaso {
  return {
    from_status: null,
    to_status: 'OPEN',
    actor_role: 'buyer',
    note: null,
    created_at: '2026-09-20T09:00:00Z',
    ...campos,
  };
}

/* ========================================================================== */
/* 1. Ni un importe, y ninguna promesa de dinero                              */
/* ========================================================================== */
describe('el expediente no habla de dinero', () => {
  it('NO HAY IMPORTE DE REEMBOLSO, y está escrito una vez', () => {
    // Cuánto se devuelve —total, parcial, con o sin el porte de vuelta— no lo
    // ha decidido nadie, y quién ejecuta el pago es del Incremento 9.
    assert.equal(HAY_IMPORTE_DE_REEMBOLSO, false);
  });

  it('ni el módulo ni las seis pantallas escriben un importe', () => {
    const textos = [
      sinComentarios(fuente('lib', 'incidencias.ts')),
      ...PANTALLAS.map((p) => sinComentarios(fuente('screens', p))),
    ].join('\n');
    for (const prohibido of [
      'refund_amount',
      'refundAmount',
      'amount_minor',
      'importeDevuelto',
      'total_minor',
      'precioLegible',
      'refund_reference',
      'refunded_at',
    ]) {
      assert.ok(!textos.includes(prohibido), `aparece «${prohibido}»`);
    }
  });

  it('el contrato del servidor tampoco trae ningún importe', () => {
    // SI EL SERVIDOR EMPIEZA A MANDARLO, esta prueba se pone roja y alguien
    // tiene que decidir qué se pinta, en vez de que aparezca solo.
    const molde = delServidor('schemas.py');
    const bloque = molde.slice(
      molde.indexOf('class IncidenciaRead'),
      molde.indexOf('class AbrirIncidencia'),
    );
    assert.ok(bloque.length > 100, 'no encontré el molde de la incidencia');
    for (const prohibido of [
      'refund_amount_minor',
      'refund_reference',
      'refunded_at',
      'amount_minor',
      'currency',
    ]) {
      assert.ok(!bloque.includes(prohibido), `el molde trae «${prohibido}»`);
    }
  });

  it('el efecto financiero nace pendiente y NUNCA dice «hecho»', () => {
    assert.equal(quedaAlgoPendiente(caso({ financial_effect: 'PENDING' })), true);
    assert.equal(quedaAlgoPendiente(caso({ financial_effect: 'NOT_APPLICABLE' })), false);
    assert.equal(quedaAlgoPendiente(caso()), false);
    assert.equal(quedaAlgoPendiente(null), false);
    // No existe ningún valor que signifique «ya se pagó»: si apareciera, esta
    // capa lo trataría como «no pendiente» y eso sería mentir por omisión.
    const texto = sinComentarios(fuente('lib', 'incidencias.ts'));
    for (const prohibido of ['EXECUTED', 'PAID', 'SETTLED', 'DONE']) {
      assert.ok(!texto.includes(prohibido), `aparece «${prohibido}»`);
    }
  });
});

/* ========================================================================== */
/* 2. Resolver no es pagar, y abrir no es aprobar                             */
/* ========================================================================== */
describe('las dos frases están en las pantallas', () => {
  it('quien reporta lee que abrir no es que le den la razón', () => {
    const pantalla = fuente('screens', 'ReportarProblemaScreen.tsx');
    assert.ok(pantalla.includes("incidencia.abrirNoEsAprobar"));
  });

  it('quien decide lee, ANTES de pulsar, que no mueve dinero ni almacén', () => {
    const pantalla = fuente('screens', 'DecidirReclamacionScreen.tsx');
    assert.ok(pantalla.includes("incidencia.resolverNoEsPagar"));
    assert.ok(pantalla.includes("incidencia.nadaVuelveAlAlmacen"));
  });

  it('quien reclama lee lo mismo junto a la decisión', () => {
    const pantalla = fuente('screens', 'ReclamacionScreen.tsx');
    assert.ok(pantalla.includes("incidencia.resolverNoEsPagar"));
  });
});

/* ========================================================================== */
/* 3. Ninguna fecha de la decisión de Z                                       */
/* ========================================================================== */
describe('la decisión de Z no tiene fecha, y se dice por qué', () => {
  it('NO HAY PLAZO DE DECISIÓN, y está escrito una vez', () => {
    // «Hábil» depende de un calendario de festivos que nadie ha definido.
    assert.equal(HAY_PLAZO_DE_DECISION, false);
  });

  it('el módulo no sabe calcular ningún día hábil', () => {
    const texto = sinComentarios(fuente('lib', 'incidencias.ts'));
    for (const prohibido of [
      'diasHabiles',
      'businessDays',
      'decision_due',
      'decisionDue',
      'festivo',
      'holiday',
    ]) {
      assert.ok(!texto.includes(prohibido), `aparece «${prohibido}»`);
    }
  });

  it('el servidor tampoco guarda una fecha límite de la decisión', () => {
    const molde = delServidor('schemas.py');
    assert.ok(!molde.includes('decision_due_at'), 'el molde trae decision_due_at');
  });
});

/* ========================================================================== */
/* 4. Nada vuelve al almacén                                                  */
/* ========================================================================== */
describe('el expediente no toca el inventario', () => {
  it('ni el módulo ni las seis pantallas saben de existencias', () => {
    // DÓNDE ESTÁ UNA UNIDAD DAÑADA LO DECIDE UNA PERSONA. Reponerla desde aquí
    // la pondría a la venta estando en casa de alguien.
    const textos = [
      sinComentarios(fuente('lib', 'incidencias.ts')),
      ...PANTALLAS.map((p) => sinComentarios(fuente('screens', p))),
    ].join('\n');
    for (const prohibido of [
      'inventario',
      'inventory',
      'on_hand',
      'reserved',
      'stock',
      'restock',
      'reponerUnidades',
    ]) {
      const patron = new RegExp(`\\b${prohibido}\\b`, 'i');
      assert.ok(!patron.test(textos), `aparece «${prohibido}»`);
    }
  });

  it('el servicio del servidor tampoco importa el inventario', () => {
    // Lo mismo que comprueba la prueba de Python recorriendo el árbol de
    // sintaxis; aquí se comprueba desde el otro lado del contrato.
    const servicio = delServidor('incidencias.py');
    assert.ok(
      !/^from app\.modules\.products import.*\binventory\b/m.test(servicio),
      'el servicio importa inventory',
    );
  });
});

/* ========================================================================== */
/* 5. El proveedor no resuelve su propio caso                                 */
/* ========================================================================== */
describe('proponer no es resolver', () => {
  it('el repositorio del proveedor no tiene método de resolver', () => {
    // SE MIRA EL CÓDIGO SIN COMENTARIOS. La explicación de por qué NO existe
    // `resolver()` contiene la palabra, y prohibir la palabra prohibiría la
    // explicación, que es justo lo que hay que conservar.
    const repositorio = fuente('repositories', 'ProductIncidentRepository.ts');
    const entero = sinComentarios(repositorio);
    const bloque = entero.slice(
      entero.indexOf('ProductIncidentSellerRepository'),
      entero.indexOf('ProductIncidentAdminRepository'),
    );
    assert.ok(bloque.length > 100, 'no encontré el repositorio del proveedor');
    for (const prohibido of ['resolver(', '/resolve', 'resolution:']) {
      assert.ok(!bloque.includes(prohibido), `aparece «${prohibido}»`);
    }
  });

  it('la pantalla del proveedor no pinta ningún botón de resolver', () => {
    // Lo que no puede hacer es LLAMAR. `incidencia.resolverNoEsPagar` es una
    // clave de texto y dice exactamente lo contrario de resolver.
    const pantalla = sinComentarios(
      fuente('screens', 'ResponderReclamacionScreen.tsx'),
    );
    assert.ok(!pantalla.includes('AdminRepository'), 'llama al repositorio de Z');
    assert.ok(!pantalla.includes('.resolver('), 'llama a resolver()');
    assert.ok(!pantalla.includes('/resolve'), 'llama a /resolve');
    assert.ok(!pantalla.includes('resolution:'), 'manda una resolución');
  });

  it('el servidor no tiene ninguna ruta de proveedor que resuelva', () => {
    const rutas = delServidor('router.py');
    for (const m of rutas.matchAll(/"(\/seller\/incidents[^"]*)"/g)) {
      assert.ok(!(m[1] as string).endsWith('/resolve'), `existe ${m[1]}`);
    }
  });

  it('lo que el proveedor propone son las cinco salidas, más pedir pruebas', () => {
    assert.deepEqual([...PROPUESTAS], [...RESOLUCIONES, PEDIR_MAS_EVIDENCIA]);
  });
});

/* ========================================================================== */
/* 6. Las pantallas no deciden ningún salto                                   */
/* ========================================================================== */
describe('quien decide qué se puede hacer es el servidor', () => {
  it('sin transiciones ofrecidas no se ofrece nada', () => {
    const sinNada = caso({ status: 'RESOLVED' });
    assert.equal(sePuedeApelar(sinNada), false);
    assert.equal(sePuedeRetirar(sinNada), false);
    assert.equal(sePuedeEscalar(sinNada), false);
    assert.equal(ofrece(sinNada, 'APPEALED'), false);
    assert.equal(ofrece(null, 'APPEALED'), false);
  });

  it('con la transición ofrecida, sí', () => {
    const ofrecido = caso({
      status: 'RESOLVED',
      available_transitions: ['APPEALED'],
    });
    assert.equal(sePuedeApelar(ofrecido), true);
    assert.equal(ofrece(ofrecido, 'APPEALED'), true);
  });

  it('UNA SOLA APELACIÓN: haberla gastado cierra la puerta aunque el servidor la ofrezca', () => {
    // Defensa en profundidad: el servidor lo vuelve a comprobar con la fila
    // bloqueada delante, pero ofrecer un botón que va a fallar seguro es
    // prometer algo que ya no se puede.
    const gastada = caso({
      status: 'RESOLVED',
      appeals_used: 1,
      available_transitions: ['APPEALED'],
    });
    assert.equal(sePuedeApelar(gastada), false);
  });

  it('aportar pruebas solo cuando se las pidieron', () => {
    assert.equal(sePuedeAportarEvidencia(caso()), false);
    assert.equal(
      sePuedeAportarEvidencia(caso({ status: 'MORE_EVIDENCE_REQUESTED' })),
      true,
    );
    assert.equal(sePuedeAportarEvidencia(null), false);
  });

  it('las seis pantallas leen `available_transitions` y no una lista propia', () => {
    // Si una pantalla decidiera por su cuenta, bastaría una versión vieja
    // instalada en un teléfono para intentar un salto que el servidor cerró.
    for (const nombre of [
      'ReclamacionScreen.tsx',
      'ResponderReclamacionScreen.tsx',
      'DecidirReclamacionScreen.tsx',
    ]) {
      const pantalla = sinComentarios(fuente('screens', nombre));
      assert.ok(
        pantalla.includes('available_transitions') || pantalla.includes('sePuede'),
        `${nombre} no consulta lo que el servidor ofrece`,
      );
    }
  });
});

/* ========================================================================== */
/* 7. Pedir más pruebas no es una salida                                      */
/* ========================================================================== */
describe('pedir más pruebas es un paso, no un desenlace', () => {
  it('no está entre las cinco salidas', () => {
    assert.ok(!(RESOLUCIONES as readonly string[]).includes(PEDIR_MAS_EVIDENCIA));
    assert.equal(RESOLUCIONES.length, 5);
  });

  it('la pantalla de decidir NO lo ofrece como decisión', () => {
    // Contarlo como resuelto daría un número falso de casos cerrados, y el
    // servidor lo rechaza con su propio código.
    const pantalla = sinComentarios(fuente('screens', 'DecidirReclamacionScreen.tsx'));
    assert.ok(!pantalla.includes('REQUEST_MORE_EVIDENCE'));
    assert.ok(!pantalla.includes('PROPUESTAS'), 'usa la lista del proveedor');
  });

  it('las cinco salidas y los siete estados son los del servidor', () => {
    const maquina = delServidor('estados_de_incidencia.py');
    for (const salida of RESOLUCIONES) {
      assert.ok(maquina.includes(`"${salida}"`), `el servidor no tiene ${salida}`);
    }
    for (const estado of ESTADOS_DE_INCIDENCIA) {
      assert.ok(maquina.includes(`"${estado}"`), `el servidor no tiene ${estado}`);
    }
    for (const motivo of MOTIVOS) {
      assert.ok(maquina.includes(`"${motivo}"`), `el servidor no tiene ${motivo}`);
    }
  });
});

/* ========================================================================== */
/* 8. El plazo, dicho como un hecho                                           */
/* ========================================================================== */
describe('el plazo del proveedor es un hecho, no una acusación', () => {
  const AHORA = Date.parse('2026-09-21T12:00:00Z');

  it('se dice cuánto le queda', () => {
    assert.equal(horasQueLeQuedan('2026-09-22T12:00:00Z', AHORA), 24);
    assert.equal(claveDelPlazo('2026-09-22T12:00:00Z', AHORA), 'incidencia.plazo.quedan');
  });

  it('NULO NO ES VENCIDO: es que ahora no le toca a él', () => {
    // Si pidió más pruebas, el servidor manda el plazo nulo. Devolver cero
    // aquí lo pintaría como si hubiera dejado pasar el tiempo.
    assert.equal(horasQueLeQuedan(null, AHORA), null);
    assert.equal(sePasoDelPlazo(null, AHORA), false);
    assert.equal(claveDelPlazo(null, AHORA), 'incidencia.plazo.noCorre');
  });

  it('pasado el plazo se dice que pasó, y nada más', () => {
    assert.equal(sePasoDelPlazo('2026-09-21T10:00:00Z', AHORA), true);
    assert.equal(claveDelPlazo('2026-09-21T10:00:00Z', AHORA), 'incidencia.plazo.cumplido');
  });

  it('una fecha ilegible no se convierte en vencida', () => {
    assert.equal(horasQueLeQuedan('no es una fecha', AHORA), null);
    assert.equal(sePasoDelPlazo('no es una fecha', AHORA), false);
  });

  it('ni el módulo ni las pantallas conocen la palabra «incumplió»', () => {
    // Lo que ocurre pasadas las 48 horas es que el caso pasa a revisión, no
    // que alguien haya incumplido nada.
    const textos = [
      sinComentarios(fuente('lib', 'incidencias.ts')),
      ...PANTALLAS.map((p) => sinComentarios(fuente('screens', p))),
    ].join('\n');
    for (const prohibido of [
      'incumpl',
      'breach',
      'sla',
      'penaliz',
      'sancion',
      'atrasado',
      'overdue',
    ]) {
      // CON LÍMITE DE PALABRA: «useTranslation» contiene «sla» y no es un SLA.
      //
      // Y CON LA BARRA DOBLADA. Dentro de una plantilla, `\b` NO es el límite
      // de palabra: es el carácter de retroceso, U+0008. Un patrón así no
      // coincide con nada y la comprobación es cierta siempre. Lo encontró la
      // revisión independiente, y es el mismo defecto que ya costó una vez.
      const patron = new RegExp(`\\b${prohibido}`, 'i');
      assert.ok(!patron.test(textos), `aparece «${prohibido}»`);
    }
  });

  it('las 48 horas son exactamente las del servidor', () => {
    const modelos = delServidor('models.py');
    assert.ok(modelos.includes(`HORAS_PARA_RESPONDER = ${HORAS_PARA_RESPONDER}`));
    assert.ok(modelos.includes(`HORAS_PARA_APELAR = ${HORAS_PARA_APELAR}`));
  });
});

/* ========================================================================== */
/* 9. La entrega negada, y las fotografías                                    */
/* ========================================================================== */
describe('las fotografías se exigen donde se pueden tener', () => {
  it('LA ENTREGA NEGADA NO PIDE NINGUNA', () => {
    // A quien dice que no le llegó nada no se le puede pedir la foto de lo que
    // no tiene: exigírselas cerraría el único caso que solo él puede abrir.
    assert.equal(fotosExigidas(ENTREGA_NEGADA), 0);
    assert.equal(fotosExigidas('DAMAGED'), FOTOS_MINIMAS);
    assert.equal(FOTOS_MINIMAS, 2);
    assert.equal(FOTOS_MAXIMAS, 6);
  });

  it('y tampoco pide elegir un artículo: habla del pedido entero', () => {
    assert.equal(pideLinea(ENTREGA_NEGADA), false);
    assert.equal(pideLinea('DAMAGED'), true);
    assert.ok(!MOTIVOS_DEL_PRODUCTO.includes(ENTREGA_NEGADA));
    assert.equal(MOTIVOS_DEL_PRODUCTO.length, MOTIVOS.length - 1);
  });

  it('sin el mínimo no se puede enviar, y se dice cuántas faltan', () => {
    const vacio = caso();
    assert.equal(sePuedeEnviar(vacio), false);
    assert.equal(fotosQueFaltan(vacio), 2);
    const una = caso({ evidence: [prueba()] });
    assert.equal(sePuedeEnviar(una), false);
    assert.equal(fotosQueFaltan(una), 1);
    const dos = caso({ evidence: [prueba(), prueba({ id: 'ev-2' })] });
    assert.equal(sePuedeEnviar(dos), true);
    assert.equal(fotosQueFaltan(dos), 0);
  });

  it('la entrega negada se envía sin ninguna', () => {
    assert.equal(sePuedeEnviar(caso({ reason: ENTREGA_NEGADA })), true);
  });

  it('un caso ya enviado no se vuelve a enviar', () => {
    const enviado = caso({
      status: 'SELLER_RESPONDED',
      evidence: [prueba(), prueba({ id: 'ev-2' })],
    });
    assert.equal(sePuedeEnviar(enviado), false);
  });

  it('caben seis y ni una más', () => {
    const seis = caso({
      evidence: Array.from({ length: 6 }, (_, i) => prueba({ id: `ev-${i}` })),
    });
    assert.equal(cabenMasFotos(seis), false);
    assert.equal(
      porQueNoSePuedeAdjuntar({
        tipo: 'image/png',
        bytes: 100,
        yaHay: 6,
        maximoBytes: 1000,
        tiposAdmitidos: ['image/png'],
      }),
      'demasiadas',
    );
  });

  it('la comprobación de cortesía rechaza lo barato y deja decidir al servidor', () => {
    const base = {
      yaHay: 0,
      maximoBytes: 1000,
      tiposAdmitidos: ['image/jpeg', 'image/png', 'image/webp'],
    };
    assert.equal(
      porQueNoSePuedeAdjuntar({ ...base, tipo: 'image/svg+xml', bytes: 10 }),
      'tipo',
    );
    assert.equal(porQueNoSePuedeAdjuntar({ ...base, tipo: 'image/png', bytes: 0 }), 'vacio');
    assert.equal(
      porQueNoSePuedeAdjuntar({ ...base, tipo: 'image/png', bytes: 1001 }),
      'peso',
    );
    // SIN TAMAÑO NO SE RECHAZA: el selector no siempre lo sabe, y negarse aquí
    // impediría subir una foto perfectamente válida sin salir del teléfono.
    assert.equal(porQueNoSePuedeAdjuntar({ ...base, tipo: 'image/png', bytes: null }), null);
    // Y EL PARÁMETRO DEL TIPO SE LIMPIA: `image/png; charset=binary` es un PNG.
    assert.equal(
      porQueNoSePuedeAdjuntar({ ...base, tipo: 'image/PNG; x=1', bytes: 10 }),
      null,
    );
  });

  it('cada rechazo tiene texto, y el de «no caben más» es el del expediente', () => {
    assert.equal(claveDelRechazo('tipo'), 'fotos.noSePuede.tipo');
    assert.equal(claveDelRechazo('peso'), 'fotos.noSePuede.peso');
    assert.equal(claveDelRechazo('vacio'), 'fotos.noSePuede.vacio');
    // La del catálogo dice «no cabe otra en esta versión» y hablaría de otra
    // cosa: aquí lo que no cabe es otra prueba en el expediente.
    assert.equal(claveDelRechazo('demasiadas'), 'incidencia.error.demasiadasFotos');
  });

  it('la descripción tiene el largo que el servidor va a exigir', () => {
    assert.equal(DESCRIPCION_MINIMA, 20);
    assert.equal(descripcionValida('no funciona'), false);
    assert.equal(descripcionValida('   '.repeat(30)), false, 'espacios no cuentan');
    assert.equal(descripcionValida('a'.repeat(DESCRIPCION_MINIMA)), true);
    assert.equal(descripcionValida('a'.repeat(DESCRIPCION_MAXIMA + 1)), false);
  });
});

/* ========================================================================== */
/* 10. Los estados, los textos y los errores                                  */
/* ========================================================================== */
describe('nada se queda sin nombre', () => {
  it('un estado desconocido tiene texto propio, no ninguno', () => {
    assert.equal(esEstadoConocido('OPEN'), true);
    assert.equal(esEstadoConocido('LO_QUE_SEA'), false);
    assert.equal(claveDelEstadoDeIncidencia('OPEN'), 'incidencia.estado.OPEN');
    assert.equal(
      claveDelEstadoDeIncidencia('LO_QUE_SEA'),
      'incidencia.estado.desconocido',
    );
  });

  it('un motivo y una salida desconocidos, igual', () => {
    assert.equal(esMotivoConocido('DAMAGED'), true);
    assert.equal(claveDelMotivo('LO_QUE_SEA'), 'incidencia.motivo.desconocido');
    assert.equal(
      claveDeLaResolucion('LO_QUE_SEA'),
      'incidencia.resolucion.desconocida',
    );
    // Pedir más pruebas SÍ tiene texto aunque no sea una salida: el proveedor
    // la propone y aparece en el historial.
    assert.equal(
      claveDeLaResolucion(PEDIR_MAS_EVIDENCIA),
      `incidencia.resolucion.${PEDIR_MAS_EVIDENCIA}`,
    );
  });

  it('cada estado conocido tiene icono, y el desconocido no lo finge', () => {
    for (const estado of ESTADOS_DE_INCIDENCIA) {
      assert.ok(iconoDelEstadoDeIncidencia(estado) !== null, `${estado} sin icono`);
    }
    assert.equal(iconoDelEstadoDeIncidencia('LO_QUE_SEA'), null);
  });

  it('un código que no es de aquí devuelve nulo, no un texto cualquiera', () => {
    assert.equal(claveDeErrorDeIncidencias('product_incident_not_found'), 'incidencia.error.noEncontrado');
    assert.equal(claveDeErrorDeIncidencias('lo_que_sea'), null);
    assert.equal(claveDeErrorDeIncidencias(''), null);
    assert.equal(claveDeErrorDeIncidencias(null), null);
    assert.equal(claveDeErrorDeIncidencias(undefined), null);
  });

  it('la 0080 sin aplicar se reconoce, y nada más se confunde con ella', () => {
    assert.equal(esIncidenciaApagada('product_incidents_not_available'), true);
    assert.equal(esIncidenciaApagada('product_incident_not_found'), false);
    assert.equal(esIncidenciaApagada(null), false);
  });
});

/* ========================================================================== */
/* 11. El caso vivo, y el historial                                           */
/* ========================================================================== */
describe('un caso vivo bloquea lo incompatible', () => {
  it('los cinco estados vivos son los del servidor', () => {
    // EL FROZENSET DEL SERVIDOR LISTA NOMBRES DE CONSTANTES, no valores, así
    // que primero se resuelven contra sus definiciones. Comparar contra los
    // nombres sin resolver daría verde siempre.
    const maquina = delServidor('estados_de_incidencia.py');
    const valorDe = new Map<string, string>();
    for (const m of maquina.matchAll(/^([A-Z_]+) = "([A-Z_]+)"$/gm)) {
      valorDe.set(m[1] as string, m[2] as string);
    }
    const linea = maquina.slice(maquina.indexOf('VIVAS = frozenset'));
    const cierre = linea.indexOf('})');
    assert.ok(cierre > 0, 'no encontré el frozenset de las vivas');
    const delServidorVivas = (linea.slice(0, cierre).match(/[A-Z_]{2,}/g) ?? [])
      .map((n) => valorDe.get(n))
      .filter((v): v is string => v !== undefined);
    assert.deepEqual([...VIVAS].sort(), delServidorVivas.sort());
    assert.equal(VIVAS.length, 5);
    // RESUELTA Y RETIRADA NO SON VIVAS: un caso cerrado no bloquea nada.
    assert.ok(!VIVAS.includes('RESOLVED'));
    assert.ok(!VIVAS.includes('WITHDRAWN'));
  });

  it('se encuentra el caso vivo de un pedido, y no uno cerrado', () => {
    const cerrado = { id: 'a', status: 'RESOLVED' };
    const vivo = { id: 'b', status: 'MEDIATION' };
    const lista = [cerrado, vivo].map((c) => ({
      ...c,
      order_id: 'po-1',
      order_item_id: null,
      reason: 'DAMAGED',
      seller_response_due_at: null,
      resolution: null,
      created_at: '2026-09-20T09:00:00Z',
    }));
    assert.equal(casoVivo(lista)?.id, 'b');
    assert.equal(casoVivo([lista[0] as never]), null);
    assert.equal(casoVivo([]), null);
    assert.equal(sigueVivo({ status: 'OPEN' }), true);
    assert.equal(sigueVivo({ status: 'WITHDRAWN' }), false);
    assert.equal(sigueVivo(null), false);
  });

  it('el pedido lleva sus casos, para que se vean donde está el pedido', () => {
    // UNA RUTA QUE SOLO FUNCIONA ESCRIBIENDO LA URL NO ESTÁ TERMINADA: quien
    // reclamó tiene que encontrar su caso en el pedido del que habla.
    const contrato = fuente('lib', 'pedidos.ts');
    assert.ok(contrato.includes('incidents: ResumenDeIncidencia[]'));
    const pantalla = fuente('screens', 'PedidoDeProductoScreen.tsx');
    assert.ok(pantalla.includes('/productos/reclamaciones/'), 'no lleva al caso');
    assert.ok(pantalla.includes('/reportar'), 'no lleva a reportar');
  });
});

describe('el historial se pinta entero y en orden', () => {
  it('EL ORDEN ES ESTABLE: dos pasos del mismo instante no bailan', () => {
    const pasos = historialPintable([
      paso({ to_status: 'OPEN', created_at: '2026-09-20T09:00:00Z' }),
      paso({ to_status: 'MEDIATION', created_at: '2026-09-20T09:00:00Z' }),
      paso({ to_status: 'SELLER_RESPONDED', created_at: '2026-09-20T08:00:00Z' }),
    ]);
    assert.deepEqual(
      pasos.map((p) => p.clave),
      [
        'incidencia.estado.SELLER_RESPONDED',
        'incidencia.estado.OPEN',
        'incidencia.estado.MEDIATION',
      ],
    );
  });

  it('una fecha ilegible no reordena nada ni rompe el pintado', () => {
    const pasos = historialPintable([
      paso({ to_status: 'OPEN', created_at: 'rota' }),
      paso({ to_status: 'MEDIATION', created_at: '2026-09-20T09:00:00Z' }),
    ]);
    assert.equal(pasos.length, 2);
    assert.equal(pasos[0]?.clave, 'incidencia.estado.OPEN');
  });

  it('la nota viaja con el paso: es el expediente, no una lista general', () => {
    const pasos = historialPintable([paso({ note: 'faltan dos piezas' })]);
    assert.equal(pasos[0]?.nota, 'faltan dos piezas');
    assert.equal(pasos[0]?.actor, 'buyer');
  });

  it('las listas NO llevan la descripción, y el molde del servidor tampoco', () => {
    // Ese texto lo escribió quien reclama y suele llevar dentro dónde vive.
    const molde = delServidor('schemas.py');
    const bloque = molde.slice(
      molde.indexOf('class IncidenciaResumen'),
      molde.indexOf('class AbrirIncidencia'),
    );
    assert.ok(bloque.length > 100, 'no encontré el resumen');
    for (const prohibido of ['description', 'evidence', 'history']) {
      assert.ok(!bloque.includes(prohibido), `el resumen trae «${prohibido}»`);
    }
    // Y la pantalla de la lista tampoco lo pinta.
    for (const nombre of [
      'ReclamacionesDeMiTiendaScreen.tsx',
      'AdminReclamacionesScreen.tsx',
    ]) {
      const pantalla = sinComentarios(fuente('screens', nombre));
      assert.ok(!pantalla.includes('.description'), `${nombre} pinta la descripción`);
    }
  });
});

/* ========================================================================== */
/* 12. Las rutas existen y llevan a su pantalla                               */
/* ========================================================================== */
describe('las seis rutas existen y apuntan a su pantalla', () => {
  const RUTAS: Array<[string, string]> = [
    ['productos/pedidos/[orderId]/reportar.tsx', 'ReportarProblemaScreen'],
    ['productos/reclamaciones/[incidentId].tsx', 'ReclamacionScreen'],
    ['proveedor/reclamaciones/index.tsx', 'ReclamacionesDeMiTiendaScreen'],
    ['proveedor/reclamaciones/[incidentId].tsx', 'ResponderReclamacionScreen'],
    ['admin/productos/reclamaciones/index.tsx', 'AdminReclamacionesScreen'],
    ['admin/productos/reclamaciones/[incidentId].tsx', 'DecidirReclamacionScreen'],
  ];

  for (const [ruta, pantalla] of RUTAS) {
    it(`${ruta} existe y exporta ${pantalla}`, () => {
      const fichero = readFileSync(join(AQUI, '..', '..', 'app', ruta), 'utf8');
      assert.ok(fichero.includes(pantalla), `${ruta} no apunta a ${pantalla}`);
      assert.ok(fichero.includes('export default'), `${ruta} no exporta nada`);
    });
  }

  it('se llega a las dos bandejas desde una pantalla, no escribiendo la URL', () => {
    assert.ok(
      fuente('screens', 'MisProductosScreen.tsx').includes("'/proveedor/reclamaciones'"),
    );
    assert.ok(
      fuente('screens', 'AdminProductosScreen.tsx').includes(
        "'/admin/productos/reclamaciones'",
      ),
    );
  });
});

/* ========================================================================== */
/* 13. Lo que encontró la revisión independiente                              */
/* ========================================================================== */
describe('el contrato con el servidor, donde la revisión lo encontró roto', () => {
  const repositorio = fuente('repositories', 'ProductIncidentRepository.ts');

  it('escalar y aportar MANDAN su explicación, que el servidor ahora exige', () => {
    // LA PANTALLA LA EXIGE —bloquea el botón por debajo de tres caracteres— y
    // durante un tiempo el servidor la descartaba porque la ruta no declaraba
    // cuerpo. Quien la escribía creía que la había mandado. Ahora la ruta la
    // pide, así que un repositorio que no la mande recibiría un 422.
    const sinComentar = sinComentarios(repositorio);
    for (const metodo of ['responder', 'escalar', 'apelar', 'retirar']) {
      const desde = sinComentar.indexOf(`async ${metodo}(`);
      assert.ok(desde > 0, `no encontré ${metodo}`);
      const bloque = sinComentar.slice(desde, desde + 400);
      assert.ok(
        bloque.includes("JSON.stringify({ note })"),
        `${metodo} no manda la explicación`,
      );
    }
  });

  it('NO HAY `mios()`: una ruta sin pantalla detrás no se ofrece', () => {
    // `GET /products/incidents` existe y está probada, pero a un caso se llega
    // desde el pedido del que habla. Un método de cliente sin pantalla es
    // código muerto que parece una función; misma regla que el Incremento 6.
    const bloque = repositorio.slice(
      repositorio.indexOf('export const ProductIncidentRepository'),
      repositorio.indexOf('ProductIncidentSellerRepository'),
    );
    assert.ok(bloque.length > 100, 'no encontré el repositorio de quien compra');
    assert.ok(!sinComentarios(bloque).includes('async mios('));
  });
});

describe('la reposicion entregada, que era el unico efecto sin salida', () => {
    it('una reposicion resuelta y sin entregar espera que alguien la registre', () => {
    // Es el unico caso que lo pide: las tres resoluciones de dinero se saldan
    // devolviendo de verdad, y aceptar aqui una de ellas dejaria desbloquear el
    // cobro de un reembolso que nadie hizo.
    assert.equal(
      esperaRegistrarLaReposicion(
        caso({
          status: 'RESOLVED',
          resolution: 'REPLACEMENT',
          financial_effect: 'PENDING',
        }),
      ),
      true,
    );
    assert.equal(
      esperaRegistrarLaReposicion(
        caso({
          status: 'RESOLVED',
          resolution: 'REPLACEMENT',
          financial_effect: 'EXECUTED',
        }),
      ),
      false,
      'ya registrada: el boton no vuelve a salir',
    );
    for (const dinero of [
      'RETURN_AND_FULL_REFUND',
      'FULL_REFUND_WITHOUT_RETURN',
      'PARTIAL_REFUND',
    ]) {
      assert.equal(
        esperaRegistrarLaReposicion(
          caso({
            status: 'RESOLVED',
            resolution: dinero,
            financial_effect: 'PENDING',
          }),
        ),
        false,
        `${dinero} se salda devolviendo, no diciendo que se repuso`,
      );
    }
    assert.equal(
      esperaRegistrarLaReposicion(
        caso({
          status: 'MEDIATION',
          resolution: 'REPLACEMENT',
          financial_effect: 'PENDING',
        }),
      ),
      false,
      'sin resolver no hay nada que registrar',
    );
    assert.equal(esperaRegistrarLaReposicion(null), false);
  });
});

describe('cada formulario de una reclamación escribe en su propia caja', () => {
  /** Los `value={...}` de los `<Input>` de una pantalla, en orden. */
  const cajas = (texto: string): string[] =>
    [...sinComentarios(texto).matchAll(/<Input\b[\s\S]*?\bvalue=\{([^}]+)\}/g)].map(
      (m) => m[1].trim(),
    );

  it('quien compra: aportar, escalar, apelar y retirar no comparten texto', () => {
    // LO ENCONTRÓ LA REVISIÓN INDEPENDIENTE. Con el caso a la espera de pruebas
    // se pintan tres formularios a la vez y los cuatro escribían en la misma
    // `nota`: lo escrito para uno viajaba como motivo del otro, a un expediente
    // que no se reescribe. Lo peor, apelar —una vez en la vida del caso— con el
    // texto que se había escrito para retirar.
    const valores = cajas(fuente('screens', 'ReclamacionScreen.tsx'));
    assert.ok(valores.length >= 4, `solo encontré ${valores.length} cajas`);
    assert.equal(new Set(valores).size, valores.length, `cajas compartidas: ${valores.join(', ')}`);
  });

  it('quien vende: la propuesta y la petición de pruebas no comparten texto', () => {
    const valores = cajas(fuente('screens', 'ResponderReclamacionScreen.tsx'));
    assert.ok(valores.length >= 2, `solo encontré ${valores.length} cajas`);
    assert.equal(new Set(valores).size, valores.length, `cajas compartidas: ${valores.join(', ')}`);
  });

  it('apelar pregunta antes, porque es una sola vez y no se deshace', () => {
    const pantalla = sinComentarios(fuente('screens', 'ReclamacionScreen.tsx'));
    const desde = pantalla.indexOf('const apelar = async');
    assert.ok(desde > 0, 'no encontré el manejador de apelar');
    const cuerpo = pantalla.slice(desde, pantalla.indexOf('};', desde));
    assert.ok(cuerpo.includes('await confirm('), 'apelar dispara sin preguntar');
    assert.ok(pantalla.includes('onPress={() => void apelar()}'));
  });
});
