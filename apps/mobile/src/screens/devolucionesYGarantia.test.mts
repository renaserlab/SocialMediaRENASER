/**
 * La garantía de devolución de 7 días: las decisiones que, si alguien las
 * deshace, dejan todo compilando y todo con el mismo aspecto.
 *
 * ESTO NO SE PUEDE PROBAR EJECUTÁNDOLO, igual que `etiquetasPrivadas.test.mts`:
 * los módulos importan React Native y las pruebas de este proyecto corren con
 * el runner de Node, sin renderizador. Así que se comprueba sobre el TEXTO de
 * los ficheros. No es una prueba de comportamiento: es un cerrojo.
 *
 * Y son cinco cerrojos que merecen estar puestos porque los cinco fallos son
 * INVISIBLES mientras todo va bien:
 *
 *  1. Una cuenta atrás nacida de `Date.now()` funciona perfectamente en un
 *     teléfono con la hora correcta. Solo falla en el que la tiene movida, que
 *     es exactamente el caso que importa.
 *  2. Un doble envío necesita dos toques rápidos: en desarrollo no pasa nunca,
 *     y en producción son dos expedientes sobre la misma compra.
 *  3. Un motivo opcional no rompe nada: simplemente llegan solicitudes que
 *     nadie sabe revisar.
 *  4. Filtrar el historial por «tiene acceso» deja una pantalla más limpia y
 *     borra de la vista justo las operaciones sobre las que se pregunta.
 *  5. Una casilla que no bloquea el botón sigue apareciendo en la pantalla, y
 *     el cobro ocurre igual sin que nadie haya aceptado nada.
 *
 * Lo que de verdad protege el dinero está en el servidor —revalida el plazo,
 * el índice parcial de la 0049 rechaza la segunda solicitud viva sobre la misma
 * orden, y el endpoint exige la aceptación—. Esto cubre la mitad del teléfono.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

const HOOK = fuente('hooks/useGarantia.ts');
const TARJETA = fuente('components/TarjetaDeGarantia.tsx');
const FORMULARIO = fuente('screens/SolicitarDevolucionScreen.tsx');
const HISTORIAL = fuente('screens/ComprasYDevolucionesScreen.tsx');
const CURSO = fuente('screens/CourseScreen.tsx');
const ADMIN = fuente('screens/AdminDevolucionesScreen.tsx');
const AJUSTES = fuente('screens/SettingsScreen.tsx');
const REPOSITORIO = fuente('repositories/PaymentRepository.ts');

/** El trozo de texto entre dos marcas, para no mirar el fichero entero. */
function entre(texto: string, desde: string, hasta: string): string {
  const inicio = texto.indexOf(desde);
  assert.notEqual(inicio, -1, `No se encontró «${desde}».`);
  const fin = texto.indexOf(hasta, inicio + desde.length);
  assert.notEqual(fin, -1, `No se encontró «${hasta}» después de «${desde}».`);
  return texto.slice(inicio, fin);
}

// ---------------------------------------------------------------------------
// 1. La cuenta atrás la manda el reloj del SERVIDOR
// ---------------------------------------------------------------------------
describe('la cuenta atrás de la garantía', () => {
  it('mide el desfase entre el reloj del servidor y el del teléfono', () => {
    /*
      Es la pieza entera. Sin ella, «te quedan 6 días» se calcularía con la hora
      que diga el aparato, y atrasar el reloj —dos toques en ajustes— estiraría
      un plazo que el servidor ya dio por vencido.
    */
    assert.ok(
      /export function desfaseConElServidor\(\s*serverTime: string,\s*ahoraLocal: number,?\s*\): number/.test(
        HOOK,
      ),
      'Tiene que existir `desfaseConElServidor(serverTime, ahoraLocal)`.',
    );
    assert.ok(
      HOOK.includes('return servidor - ahoraLocal;'),
      'El desfase es la hora del servidor MENOS la local, en ese orden.',
    );
  });

  it('cuenta contra la hora local YA CORREGIDA, no contra la local a secas', () => {
    assert.ok(
      HOOK.includes('const ahoraSegunElServidor = ahoraLocal + desfaseMs;'),
      'Lo que se compara con `expires_at` es la hora local más el desfase.',
    );
    assert.ok(
      /Math\.max\(0, Math\.floor\(\(vence - ahoraSegunElServidor\) \/ 1000\)\)/.test(HOOK),
      'Los segundos restantes salen de `expires_at` menos la hora corregida.',
    );
  });

  it('guarda el desfase en el mismo instante en que llega la respuesta', () => {
    // Calcularlo más tarde metería en el desfase lo que tardó el render.
    assert.ok(
      HOOK.includes(
        'desfaseRef.current = desfaseConElServidor(respuesta.serverTime, Date.now());',
      ),
      'El desfase se calcula con `server_time` junto a la respuesta.',
    );
  });

  it('refresca con un intervalo local y NO volviendo a preguntar', () => {
    /*
      Un segundo por persona mirando una ficha de curso sería una petición por
      segundo y por persona, para pintar un número que ya se puede calcular.
    */
    const intervalo = entre(HOOK, 'const tic = setInterval(', '}, 1000);');
    assert.equal(
      /DevolucionesRepository|apiRequest|fetch\(/.test(intervalo),
      false,
      'El intervalo solo repinta: no puede pedirle la hora al servidor.',
    );
    assert.ok(
      HOOK.includes('return () => clearInterval(tic);'),
      'El intervalo tiene que limpiarse al desmontar: sin esto queda uno vivo ' +
        'por cada visita a la ficha, llamando a `setRestantes` sobre un ' +
        'componente que ya no existe.',
    );
  });

  it('la tarjeta no vuelve a mirar el reloj del teléfono por su cuenta', () => {
    // Toda la aritmética del plazo vive en el hook, con el desfase aplicado. Un
    // `Date.now()` suelto en la vista sería la puerta trasera al reloj local.
    assert.equal(
      /Date\.now\(/.test(TARJETA),
      false,
      'La tarjeta pinta `restantes`, que ya viene corregido; no calcula plazos.',
    );
    assert.ok(
      /const \{ estado, cargando, error, restantes, recargar \} = useGarantia\(/.test(
        TARJETA,
      ),
      'La tarjeta consume la cuenta atrás del hook.',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Lo que la tarjeta tiene que decir en cada situación
// ---------------------------------------------------------------------------
describe('la tarjeta de garantía', () => {
  it('explica la regla de los 7 días en TODOS los estados', () => {
    // La frase va fuera del bloque que cambia: es la que responde «¿y esto
    // desde cuándo cuenta?», y se pregunta igual con el plazo vencido.
    assert.ok(
      TARJETA.includes("t('garantia.explicacion')"),
      'Hace falta la línea de «7 días desde el primer acceso».',
    );
  });

  it('cubre los cinco estados y no solo el que deja pedir', () => {
    for (const marca of [
      'estado.solicitudActivaId',
      'estado.garantiaUsada',
      "'not_started'",
      "'expired'",
      'estado.elegible',
    ]) {
      assert.ok(
        TARJETA.includes(marca),
        `Falta el estado «${marca}»: una tarjeta que solo aparece mientras ` +
          'queda plazo deja sin explicación los casos en los que se busca.',
      );
    }
  });

  it('ofrece el botón SOLO cuando el servidor dice que sí', () => {
    assert.ok(
      /\{estado\.elegible \? \(\s*<Button\s+label=\{t\('garantia\.solicitar'\)\}/.test(
        TARJETA,
      ),
      '«Solicitar devolución» va dentro de `estado.elegible`, y de nada más.',
    );
  });

  it('no se pinta cuando no hay nada que contar', () => {
    // Con la función apagada, sin la 0049 o sin compra detrás no hay error que
    // enseñar: la ficha del curso se pinta igual y la tarjeta no existe.
    assert.ok(
      /if \(estado\.motivo === 'disabled' \|\| estado\.motivo === 'no_purchase'\) return null;/.test(
        TARJETA,
      ),
      'Sin garantía que anunciar, la tarjeta devuelve null.',
    );
  });

  it('no enseña identificadores ni datos de la pasarela', () => {
    for (const tecnico of ['orderId', 'checkoutUrl', 'stripe', 'provider']) {
      assert.equal(
        TARJETA.includes(tecnico),
        false,
        `«${tecnico}» no puede aparecer en la tarjeta: es dato interno.`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 3. El formulario: motivo obligatorio y un solo envío
// ---------------------------------------------------------------------------
describe('la solicitud de devolución', () => {
  it('no envía nada sin motivo, y dice por qué', () => {
    /*
      El motivo es lo único que hace revisable una solicitud. Dejarlo opcional
      no rompe ninguna pantalla: simplemente llegan expedientes que nadie sabe
      por dónde coger. Y se avisa en vez de dejar el botón apagado sin más:
      un botón que no responde y no explica es un botón muerto.
    */
    assert.ok(
      /if \(!motivo\) \{\s*setFaltaMotivo\(true\);\s*return;\s*\}/.test(FORMULARIO),
      'Sin motivo se corta el envío y se enciende el aviso.',
    );
    assert.ok(
      FORMULARIO.includes("t('devolucion.motivoObligatorio')"),
      'Y se dice que el motivo hace falta.',
    );
  });

  it('ofrece exactamente los cuatro motivos del enum del backend', () => {
    const lista = entre(FORMULARIO, 'const MOTIVOS', '];');
    for (const motivo of [
      'not_as_expected',
      'content_quality',
      'technical_problem',
      'other',
    ]) {
      assert.ok(lista.includes(`'${motivo}'`), `Falta el motivo «${motivo}».`);
    }
    // Uno de más sería un 422 del servidor con un formulario aparentemente
    // válido: el enum de Pydantic no lo acepta.
    assert.equal(
      (lista.match(/'/g) ?? []).length / 2,
      4,
      'Los motivos son cuatro: los que acepta el enum del backend.',
    );
  });

  it('impide el doble envío antes del siguiente render', () => {
    /*
      `enviando` es estado de React: se aplica en el render SIGUIENTE, y entre
      el primer toque y ese render caben más toques. Cada uno abriría su propio
      expediente sobre la misma compra.
    */
    assert.ok(
      FORMULARIO.includes('if (enviandoRef.current) return;'),
      'Hace falta un cerrojo síncrono al entrar en el envío.',
    );
    const cerrojo = FORMULARIO.indexOf('enviandoRef.current = true;');
    const peticion = FORMULARIO.indexOf('DevolucionesRepository.crearSolicitud');
    assert.ok(cerrojo !== -1 && peticion !== -1, 'Faltan el cerrojo o la petición.');
    assert.ok(
      cerrojo < peticion,
      'El cerrojo se echa ANTES de la petición, no después de que vuelva.',
    );
    assert.ok(
      /label=\{enviando \? t\('devolucion\.enviando'\) : t\('devolucion\.enviar'\)\}[\s\S]{0,240}disabled=\{enviando\}/.test(
        FORMULARIO,
      ),
      'Y el botón se apaga mientras se envía: es la mitad visible.',
    );
  });

  it('echa el cerrojo ANTES de abrir el diálogo de confirmación', () => {
    /*
      EL CERROJO DETRÁS DEL DIÁLOGO NO PROTEGE NADA. La comprobación estaba al
      entrar, pero la referencia no se ponía a `true` hasta DESPUÉS del
      `await confirm(...)`: dos toques rápidos la encuentran los dos en
      `false`, los dos abren su diálogo, y aceptar los dos abre dos
      expedientes sobre la misma compra. Justo lo que el cerrojo existe para
      impedir.

      Y si la persona cancela hay que soltarlo, o el botón se queda muerto
      hasta salir de la pantalla.
    */
    for (const [fichero, nombre, ref] of [
      [FORMULARIO, 'la solicitud', 'enviandoRef'],
      [HISTORIAL, 'la retirada', 'retirandoRef'],
      [ADMIN, 'las acciones de administración', 'enviandoRef'],
    ] as const) {
      const cerrojo = fichero.indexOf(`${ref}.current = true;`);
      const dialogo = fichero.indexOf('await confirm({');
      assert.ok(cerrojo !== -1 && dialogo !== -1, `Faltan cerrojo o diálogo en ${nombre}.`);
      assert.ok(
        cerrojo < dialogo,
        `En ${nombre} el cerrojo se echa antes de abrir el diálogo.`,
      );
      assert.ok(
        fichero.includes(`${ref}.current = false;`),
        `En ${nombre} hay que soltar el cerrojo si se cancela.`,
      );
    }
  });

  it('cobrar y restaurar tienen cerrojo síncrono, no solo estado', () => {
    /*
      `comprando` ES ESTADO, y el estado no está puesto hasta el siguiente
      render. Entre el primer toque y ese render caben más toques: con dos se
      abren dos checkouts de Stripe, o se lanzan dos compras a la tienda sobre
      el mismo curso. Una referencia se actualiza en el acto.

      Se comprueba tambien que se suelta en el `finally`, o el botón se queda
      muerto en cuanto una compra falle.
    */
    assert.ok(
      CURSO.includes('const comprandoRef = useRef(false);'),
      'Falta el cerrojo síncrono de compra.',
    );
    assert.ok(
      CURSO.includes('|| comprandoRef.current) return;'),
      'Comprar tiene que salir si ya hay una compra en marcha.',
    );
    assert.ok(
      CURSO.includes('if (comprandoRef.current) return;'),
      'Restaurar tiene que salir si ya hay una operación en marcha.',
    );
    assert.strictEqual(
      CURSO.split('comprandoRef.current = false;').length - 1,
      2,
      'Los dos caminos sueltan el cerrojo en su `finally`.',
    );

    /*
      Y AQUÍ ESTÁ LO QUE FALTABA, que es lo único que de verdad cierra la
      puerta: que el cerrojo SE ECHE, y antes de llamar a la pasarela.

      Todo lo de arriba comprobaba que la referencia se declara, se lee y se
      suelta. Borrando las tres asignaciones a `true` el cerrojo no se cerraba
      nunca, dos toques rápidos abrían dos checkouts sobre el mismo curso, y las
      cinco aserciones seguían en verde. Comprobado quitándolas: la suite entera
      —1134 pruebas— pasaba igual.
    */
    // `await …` Y NO EL NOMBRE SUELTO: `comprarEnTienda` aparece antes que nada
    // en la línea del `import`, así que buscarlo a secas encontraba la
    // importación y la aserción fallaba con el código correcto.
    for (const [ref, llamada, nombre] of [
      ['comprandoRef', 'await CommerceRepository.stripeCheckout', 'la compra web'],
      ['comprandoRef', 'await comprarEnTienda', 'la compra en la tienda'],
      ['aceptandoRef', 'await DevolucionesRepository.aceptarRecompra', 'la recompra'],
    ] as const) {
      const echado = CURSO.indexOf(ref + '.current = true;');
      const cobra = CURSO.indexOf(llamada);
      assert.ok(echado !== -1, `En ${nombre} el cerrojo nunca se echa.`);
      assert.ok(cobra !== -1, `No se encuentra la llamada de ${nombre}.`);
      assert.ok(
        echado < cobra,
        `En ${nombre} el cerrojo se echa ANTES de llamar a la pasarela.`,
      );
    }
  });

  // La prueba de «restaurar compras» vivia aqui y miraba subcadenas del
  // codigo fuente: cambiando `granted.length` por `granted.length + 1` seguia
  // verde y el mensaje falso volvia. Se sustituyo por una que EJECUTA el
  // codigo, en `lib/restauracion.test.mts`.

  it('resume las consecuencias y confirma antes de enviar', () => {
    assert.ok(
      FORMULARIO.includes("t('devolucion.consecuenciasTitulo')"),
      'Hay que decir qué pasa si se continúa, antes de continuar.',
    );
    const confirmacion = FORMULARIO.indexOf('await confirm({');
    const peticion = FORMULARIO.indexOf('DevolucionesRepository.crearSolicitud');
    assert.ok(
      confirmacion !== -1 && confirmacion < peticion,
      'La confirmación final va antes de crear la solicitud.',
    );
  });

  it('el pedido lo elige el SERVIDOR, no la pantalla', () => {
    /*
      Si el `order_id` saliera de la URL o de un campo, cualquiera podría pedir
      la devolución del pedido de otro. Sale de `refund-eligibility`, que ya
      filtró por quien pregunta.
    */
    assert.ok(
      FORMULARIO.includes('const orderId = estado?.orderId;'),
      'El pedido viene del estado de garantía que devolvió el servidor.',
    );
    assert.equal(
      /useLocalSearchParams<\{[^}]*order/i.test(FORMULARIO),
      false,
      'El pedido no puede llegar por la URL.',
    );
  });

  it('no manda importe ni elegibilidad', () => {
    // Un formulario que envía cuánto devolver es un formulario que deja
    // elegirlo, por mucho que después haya un `if` que lo compruebe.
    const cuerpo = entre(FORMULARIO, 'crearSolicitud({', '});');
    for (const prohibido of ['amount', 'currency', 'eligib', 'elegible']) {
      assert.equal(
        cuerpo.toLowerCase().includes(prohibido),
        false,
        `El cuerpo de la solicitud no puede llevar «${prohibido}».`,
      );
    }
  });

  it('tiene los estados de carga, error y éxito con salida', () => {
    for (const estado of ['state="loading"', 'state="error"', 'setEnviado(true)']) {
      assert.ok(FORMULARIO.includes(estado), `Falta el estado «${estado}».`);
    }
    assert.ok(
      /onRetry=\{recargar\}/.test(FORMULARIO),
      'El error de carga tiene que poder reintentarse.',
    );
  });

  it('es navegable con lector de pantalla y con teclado', () => {
    for (const marca of [
      'accessibilityRole="radiogroup"',
      'accessibilityRole="radio"',
      'accessibilityState={{ checked: elegida',
      'focusable',
      'accessibilityLabel={t(\'devolucion.explicacionEtiqueta\')}',
    ]) {
      assert.ok(
        FORMULARIO.includes(marca),
        `Falta «${marca}»: sin roles ni etiquetas el formulario no se puede ` +
          'recorrer sin ver la pantalla.',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 4. El historial sobrevive a perder el acceso
// ---------------------------------------------------------------------------
describe('compras y devoluciones', () => {
  it('no esconde las compras cuyo acceso se retiró', () => {
    /*
      Una compra devuelta sigue siendo una compra: tiene fecha, importe y un
      pedido detrás. Filtrar por «tiene acceso» dejaría la lista más limpia y
      borraría justo las operaciones sobre las que alguien va a preguntar.
    */
    assert.equal(
      /\.filter\(\s*\(?[^)]*\)?\s*=>\s*[^)]*hasAccess/.test(HISTORIAL),
      false,
      'El historial no se puede filtrar por `hasAccess`.',
    );
    assert.ok(
      HISTORIAL.includes('{!compra.hasAccess ? ('),
      'Lo que cambia sin acceso es que se DICE, no que desaparezca la fila.',
    );
    assert.ok(
      HISTORIAL.includes("t('compras.sinAcceso')"),
      'Y se explica que el registro de la compra se conserva.',
    );
  });

  it('lo reconstruye desde el servidor, nunca desde el teléfono', () => {
    // En el disco del aparato no hay forma de saber si algo se devolvió, y
    // quien reinstale se quedaría sin historial.
    assert.equal(
      /async-storage|AsyncStorage\s*\./.test(HISTORIAL),
      false,
      'El historial no se guarda en el dispositivo.',
    );
    assert.ok(
      HISTORIAL.includes('CommerceRepository.history()'),
      'Las compras salen de `/payments/history`.',
    );
    assert.ok(
      HISTORIAL.includes('DevolucionesRepository.misSolicitudes()'),
      'Y las solicitudes de `/payments/refund-requests/mine`.',
    );
  });

  it('un fallo de las devoluciones no se lleva el historial de compras', () => {
    // Es lo que exigen las tiendas: poder ver lo comprado. Que el módulo de
    // devoluciones no esté no puede dejar a nadie sin eso.
    assert.ok(
      /misSolicitudes\(\)\.catch\(/.test(HISTORIAL),
      'Las solicitudes van con su propio `catch`.',
    );
  });

  it('tiene carga, vacío, error con reintento y acción cuando procede', () => {
    for (const marca of [
      'state="loading"',
      'state="empty"',
      'state="error"',
      'onRetry={() => void cargar()}',
      "t('compras.retirar')",
    ]) {
      assert.ok(HISTORIAL.includes(marca), `Falta «${marca}».`);
    }
  });

  it('retirar una solicitud tampoco se puede pulsar dos veces', () => {
    assert.ok(
      HISTORIAL.includes('if (retirandoRef.current) return;'),
      'Mismo cerrojo síncrono que en el formulario.',
    );
  });

  it('no enseña datos técnicos de la compra', () => {
    for (const tecnico of ['provider', 'channel', 'stripe', 'checkoutUrl']) {
      assert.equal(
        HISTORIAL.includes(tecnico),
        false,
        `«${tecnico}» es dato interno: no se pinta.`,
      );
    }
  });

  it('se llega desde Ajustes', () => {
    assert.ok(
      AJUSTES.includes("router.push('/compras' as never)"),
      'La pantalla tiene que ser alcanzable desde Ajustes.',
    );
    // `t(...)` y no `tx(...)`: el puente temporal de traducciones desaparecio
    // al entrar las claves en el diccionario. Lo que importa es que el texto
    // salga del diccionario, no como se llame la funcion.
    assert.ok(
      AJUSTES.includes("t('settings.purchases')"),
      'Con su propia fila, y con texto traducible.',
    );
  });
});

// ---------------------------------------------------------------------------
// 5. La recompra sin garantía: la casilla manda
// ---------------------------------------------------------------------------
describe('volver a comprar un curso ya devuelto', () => {
  it('no continúa sin marcar la casilla', () => {
    assert.ok(
      CURSO.includes('if (!aceptaLaRecompra) return;'),
      'Sin aceptar no se guarda la aceptación ni se cobra nada.',
    );
    assert.ok(
      CURSO.includes('disabled={!aceptaLaRecompra || aceptando || comprando}'),
      'Y el botón está apagado hasta que se marca: el estado del botón no es ' +
        'la garantía, pero sin él la casilla es decorativa.',
    );
  });

  it('el aviso y la etiqueta vienen del SERVIDOR, no escritos aquí', () => {
    /*
      Lo que hay que poder demostrar después es qué texto EXACTO se enseñó. Si
      vive en la aplicación cambia con cada despliegue y las aceptaciones
      antiguas apuntan a una redacción que ya no existe: entonces «lo aceptó»
      no significa nada, porque no se sabe el qué.
    */
    assert.ok(
      CURSO.includes('{avisoDeRecompra.aviso}'),
      'El texto del aviso se pinta tal y como llega.',
    );
    assert.ok(
      CURSO.includes('{avisoDeRecompra.etiquetaDeCasilla}'),
      'La etiqueta de la casilla, también.',
    );
    assert.equal(
      /garantía de devolución de este curso el/i.test(CURSO),
      false,
      'La redacción de la política no se copia en la aplicación.',
    );
  });

  it('acepta primero y cobra después, una sola vez', () => {
    const aceptacion = CURSO.indexOf('DevolucionesRepository.aceptarRecompra');
    const compra = CURSO.indexOf('await comprar();');
    assert.ok(aceptacion !== -1 && compra !== -1, 'Faltan la aceptación o la compra.');
    assert.ok(
      aceptacion < compra,
      'La aceptación se guarda ANTES de abrir el pago.',
    );
    assert.ok(
      CURSO.includes('if (!course || aceptandoRef.current) return;'),
      'Y un cerrojo síncrono impide que dos toques abran dos órdenes.',
    );
  });

  it('la puerta sustituye al botón de comprar, no lo acompaña', () => {
    // Con los dos a la vez se podría pagar sin pasar por el aviso.
    assert.ok(
      /avisoDeRecompra\?\.requiereAceptacion \? \(/.test(CURSO),
      'El bloque de recompra y el botón normal son ramas del mismo ternario.',
    );
  });

  it('la casilla se anuncia como casilla', () => {
    assert.ok(
      /accessibilityRole="checkbox"[\s\S]{0,200}accessibilityState=\{\{ checked: aceptaLaRecompra \}\}/.test(
        CURSO,
      ),
      'Sin rol ni estado, un lector de pantalla no sabe que hay algo que marcar.',
    );
  });

  it('la ficha del curso enseña la garantía a quien compró', () => {
    assert.ok(
      CURSO.includes('<TarjetaDeGarantia courseId={course.id} hayCompraPagada />'),
      'La tarjeta va en la ficha del curso.',
    );
    assert.ok(
      /\{esDePago && hasAccess && !canManage \? \(/.test(CURSO),
      'Y solo cuando hay compra de pago: quien gestiona el curso no compró nada.',
    );
  });
});

// ---------------------------------------------------------------------------
// 6. El repositorio no deja mandar lo que no le toca
// ---------------------------------------------------------------------------
describe('el repositorio de devoluciones', () => {
  it('envía solo el pedido, el motivo y la explicación', () => {
    const cuerpo = entre(REPOSITORIO, 'async crearSolicitud(', 'return aSolicitud(dto);');
    const enviado = entre(cuerpo, 'JSON.stringify({', '}),');
    for (const prohibido of ['amount', 'currency', 'course_id', 'status']) {
      assert.equal(
        enviado.includes(prohibido),
        false,
        `El cuerpo no puede llevar «${prohibido}»: lo resuelve el servidor ` +
          'desde la orden.',
      );
    }
    for (const necesario of ['order_id', 'reason', 'explanation']) {
      assert.ok(enviado.includes(necesario), `Falta «${necesario}».`);
    }
  });

  it('habla con los endpoints reales del backend', () => {
    for (const ruta of [
      '/refund-eligibility',
      '/payments/refund-requests',
      '/payments/refund-requests/mine',
      '/cancel',
      '/repurchase-notice',
      '/payments/repurchase-acceptance',
    ]) {
      assert.ok(REPOSITORIO.includes(ruta), `Falta la ruta «${ruta}».`);
    }
  });

  it('la aceptación se manda como aceptada de verdad', () => {
    assert.ok(
      REPOSITORIO.includes('{ course_id: courseId, accepted: true }'),
      'El endpoint rechaza `accepted: false`, y hace bien.',
    );
  });

  it('conoce los ocho estados del expediente', () => {
    const tipo = entre(REPOSITORIO, 'export type EstadoDeSolicitud', ';');
    for (const estado of [
      'requested',
      'under_review',
      'approved',
      'refund_processing',
      'refunded',
      'rejected',
      'failed',
      'cancelled',
    ]) {
      assert.ok(tipo.includes(`'${estado}'`), `Falta el estado «${estado}».`);
    }
  });
});

describe('la versión adquirida', () => {
  it('solo se enseña cuando consta, y nunca se inventa', () => {
    /*
      EL RIESGO REAL. Las compras anteriores al versionado no tienen versión, y
      no la tienen por un motivo: el temario nunca guardó una marca temporal, así
      que no hay forma de saber qué contenido se vendió. Escribir «versión 1»
      para que la fila no quede coja sería inventar una prueba.

      Por eso la condición es `!== null` y NO hay rama `else`: callarse es la
      respuesta honesta.
    */
    const inicio = HISTORIAL.indexOf('compra.courseVersion !== null ? (');
    assert.ok(inicio !== -1, 'La versión se pinta solo cuando el servidor la manda.');

    // SE COMPRUEBA LA RAMA `else`, NO SOLO LA CONDICIÓN. Mirando únicamente que
    // exista el `!== null`, esta prueba seguía pasando con un
    // `) : <Text>versión 1</Text>}` detrás, que es exactamente el fallo que
    // pretende impedir. Lo que hay que afirmar es que cuando no consta no se
    // pinta NADA.
    const cierre = HISTORIAL.indexOf(') : ', inicio);
    assert.ok(cierre !== -1, 'Falta el cierre del ternario de la versión.');
    assert.strictEqual(
      HISTORIAL.slice(cierre, cierre + 9),
      ') : null}',
      'Si no consta la versión no se pinta nada: callarse es la respuesta honesta.',
    );
    assert.ok(
      !/courseVersion\s*\?\?\s*\d/.test(HISTORIAL),
      'No se puede rellenar una versión ausente con un número.',
    );
    assert.ok(
      !/courseVersion\s*\|\|\s*\d/.test(HISTORIAL),
      'Tampoco con un `||`, que además trataría la versión 0 como ausente.',
    );
  });
});
