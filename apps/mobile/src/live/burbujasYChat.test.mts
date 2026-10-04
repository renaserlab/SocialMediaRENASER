import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BURBUJAS_POR_TIC,
  CARRILES,
  MAXIMO_DE_BURBUJAS,
  MUESTRA_POR_MENSAJE,
  TIC_DE_BURBUJAS_MS,
  TOPE_DE_ESPERA,
  crearPistaDeBurbujas,
  type Burbuja,
} from './burbujas.ts';
import { asentar, crearReloj } from './dobles/enMemoria.mts';
import {
  TOPE_DE_MENSAJES,
  UMBRAL_DEL_FINAL,
  alDesplazar,
  alLlegarMensajes,
  aplicarMensaje,
  crearChatEnVivo,
  crearRecargaAgrupada,
  cuantosNuevos,
  estadoDelChat,
  fundirConLaLista,
  mensajesVisibles,
  seguimientoInicial,
  type MensajeDeChat,
  type MensajeDeVentana,
} from './ventanaDeChat.ts';

/**
 * LO QUE SE PINTA EN UN DIRECTO: las burbujas y la ventana del chat.
 *
 * Las dos cosas tienen el mismo problema —en una sala con gente llega mas de
 * lo que una pantalla puede pintar— y la misma respuesta: un tope, una cola
 * corta y un repintado por tanda. Aqui se comprueba que los topes SE CUMPLEN
 * bajo rafaga, no que estan escritos.
 */

/* ------------------------------------------------------------- Burbujas --- */

function pista() {
  const reloj = crearReloj();
  let visibles: readonly Burbuja[] = [];
  let repintados = 0;
  const sumas: Record<string, number>[] = [];
  const p = crearPistaDeBurbujas<string>({
    programar: reloj.programar,
    alCambiar: (lista) => {
      visibles = lista;
      repintados += 1;
    },
    alSumar: (conteos) => sumas.push(conteos as Record<string, number>),
  });
  return { p, reloj, visibles: () => visibles, repintados: () => repintados, sumas };
}

describe('burbujas: la propia se ve ya', () => {
  it('un toque pinta una burbuja en el mismo gesto, sin esperar a ningun tic', () => {
    const { p, visibles } = pista();
    p.soltarPropia('corazon');
    assert.equal(visibles().length, 1);
    assert.equal(visibles()[0]?.tipo, 'corazon');
  });

  it('500 toques seguidos nunca pasan del tope, y la ultima siempre esta', () => {
    const { p, visibles } = pista();
    for (let i = 0; i < 500; i += 1) {
      p.soltarPropia('corazon');
      assert.ok(visibles().length <= MAXIMO_DE_BURBUJAS);
    }
    assert.equal(visibles().length, MAXIMO_DE_BURBUJAS);
    assert.equal(p.diagnostico().picoEnPantalla, MAXIMO_DE_BURBUJAS);
    // Se quita la mas vieja, no se ignora la nueva.
    assert.equal(visibles().at(-1)?.clave, 500);
  });

  it('las claves no se repiten y los carriles se reparten', () => {
    const { p, visibles } = pista();
    for (let i = 0; i < CARRILES; i += 1) p.soltarPropia('corazon');
    const claves = visibles().map((burbuja) => burbuja.clave);
    assert.equal(new Set(claves).size, claves.length);
    const carriles = visibles().map((burbuja) => burbuja.carril);
    assert.equal(new Set(carriles).size, CARRILES, 'dos seguidas salen por el mismo carril');
    for (const carril of carriles) assert.ok(carril >= 0 && carril < CARRILES);
  });
});

describe('burbujas: las ajenas entran por turnos', () => {
  it('lo ajeno no pinta nada hasta el tic, y entonces suma UNA vez', () => {
    const { p, reloj, visibles, sumas } = pista();
    p.recibir({ corazon: 2 });
    p.recibir({ corazon: 1, fuego: 4 });
    assert.equal(visibles().length, 0);
    assert.deepEqual(sumas, []);

    reloj.avanzar(TIC_DE_BURBUJAS_MS);
    // Dos mensajes, una sola entrega al contador, con la cuenta ENTERA.
    assert.deepEqual(sumas, [{ corazon: 3, fuego: 4 }]);
    assert.equal(visibles().length, BURBUJAS_POR_TIC);
  });

  it('de un mensaje se pinta una muestra, pero se cuenta todo', () => {
    const { p, reloj, sumas } = pista();
    p.recibir({ corazon: 12 });
    reloj.avanzar(TIC_DE_BURBUJAS_MS * 10);
    assert.deepEqual(sumas, [{ corazon: 12 }]);
    assert.equal(p.diagnostico().pintadas, MUESTRA_POR_MENSAJE);
  });

  it('una avalancha no pasa del tope en pantalla ni deja crecer la cola', () => {
    const { p, reloj, visibles } = pista();
    let pico = 0;
    // Mil mensajes de golpe, y otros cien cada tic durante un rato.
    for (let i = 0; i < 1_000; i += 1) p.recibir({ corazon: 3, fuego: 3 });
    for (let t = 0; t < 60; t += 1) {
      for (let i = 0; i < 100; i += 1) p.recibir({ risa: 2 });
      reloj.avanzar(TIC_DE_BURBUJAS_MS);
      pico = Math.max(pico, visibles().length);
      assert.ok(p.diagnostico().enEspera <= TOPE_DE_ESPERA, 'la cola de espera crece sin tope');
    }
    assert.ok(pico <= MAXIMO_DE_BURBUJAS, `llego a haber ${pico} burbujas`);
    assert.equal(p.diagnostico().picoDeEspera, TOPE_DE_ESPERA);
    assert.ok(p.diagnostico().descartadas > 0, 'bajo avalancha tiene que descartar');
  });

  it('con la pista llena las ajenas esperan; al hacerse sitio, entran', () => {
    const { p, reloj, visibles } = pista();
    for (let i = 0; i < MAXIMO_DE_BURBUJAS; i += 1) p.soltarPropia('corazon');
    p.recibir({ fuego: 1 });
    reloj.avanzar(TIC_DE_BURBUJAS_MS * 3);
    assert.equal(visibles().some((burbuja) => burbuja.tipo === 'fuego'), false);
    assert.equal(p.diagnostico().enEspera, 1);

    p.quitar(visibles()[0]?.clave ?? -1);
    reloj.avanzar(TIC_DE_BURBUJAS_MS);
    assert.equal(visibles().some((burbuja) => burbuja.tipo === 'fuego'), true);
    assert.equal(p.diagnostico().enEspera, 0);
  });

  it('un repintado por tic, no uno por reaccion', () => {
    const { p, reloj, repintados } = pista();
    for (let i = 0; i < 300; i += 1) p.recibir({ corazon: 1 });
    assert.equal(repintados(), 0);
    reloj.avanzar(TIC_DE_BURBUJAS_MS);
    assert.equal(repintados(), 1);
  });

  it('sin nada que hacer no queda ningun reloj corriendo', () => {
    const { p, reloj, visibles } = pista();
    p.recibir({ corazon: 2 });
    reloj.avanzar(TIC_DE_BURBUJAS_MS * 4);
    for (const burbuja of [...visibles()]) p.quitar(burbuja.clave);
    reloj.avanzar(TIC_DE_BURBUJAS_MS * 4);
    assert.equal(reloj.vivos(), 0);
    assert.equal(p.diagnostico().enEspera, 0);
    assert.equal(p.diagnostico().enPantalla, 0);
  });

  it('destruir corta el tic y deja de avisar', () => {
    const { p, reloj, repintados, sumas } = pista();
    p.recibir({ corazon: 5 });
    p.destruir();
    p.destruir();
    reloj.avanzar(TIC_DE_BURBUJAS_MS * 5);
    assert.equal(reloj.vivos(), 0);
    assert.equal(repintados(), 0);
    assert.deepEqual(sumas, []);
    // Y ya no acepta nada.
    p.soltarPropia('corazon');
    p.recibir({ corazon: 1 });
    assert.equal(repintados(), 0);
    assert.equal(reloj.vivos(), 0);
  });

  it('una cantidad que no es un numero positivo se ignora', () => {
    const { p, reloj, sumas, visibles } = pista();
    p.recibir({ corazon: 0, fuego: -4, risa: Number.NaN });
    reloj.avanzar(TIC_DE_BURBUJAS_MS * 2);
    assert.deepEqual(sumas, []);
    assert.equal(visibles().length, 0);
    assert.equal(reloj.vivos(), 0);
  });
});

/* ------------------------------------------------------------- El chat ---- */

let serie = 0;
function mensaje(extra: Partial<MensajeDeVentana> & { minuto?: number } = {}): MensajeDeVentana {
  serie += 1;
  const minuto = extra.minuto ?? serie;
  return {
    id: extra.id ?? `m${String(serie).padStart(6, '0')}`,
    creadoEnIso:
      extra.creadoEnIso ?? new Date(Date.UTC(2026, 9, 4, 12, 0, 0) + minuto * 1_000).toISOString(),
    oculto: extra.oculto ?? false,
    cuerpo: extra.cuerpo ?? `mensaje ${serie}`,
    usuarioNombre: extra.usuarioNombre ?? 'Ana',
    usuarioAvatarUrl: extra.usuarioAvatarUrl,
  };
}

describe('la ventana del chat: acotada y en orden', () => {
  it('un mensaje nuevo entra al final y los demas conservan su objeto', () => {
    const a = mensaje();
    const b = mensaje();
    const antes = [a, b];
    const c = mensaje();
    const despues = aplicarMensaje(antes, c);
    assert.deepEqual(despues.map((m) => m.id), [a.id, b.id, c.id]);
    // Identidad, no igualdad: es lo que evita repintar las filas memorizadas.
    assert.equal(despues[0], a);
    assert.equal(despues[1], b);
    assert.notEqual(despues, antes, 'ha mutado la lista que es estado de React');
    assert.equal(antes.length, 2);
  });

  it('el mismo mensaje dos veces no se duplica ni repinta', () => {
    const a = mensaje();
    const ventana = [a];
    assert.equal(aplicarMensaje(ventana, { ...a }), ventana, 'tiene que devolver LA MISMA ventana');
  });

  it('esconder un mensaje lo sustituye en su sitio, y deja de pintarse', () => {
    const a = mensaje();
    const b = mensaje();
    const c = mensaje();
    const despues = aplicarMensaje([a, b, c], { ...b, oculto: true });
    assert.deepEqual(despues.map((m) => m.id), [a.id, b.id, c.id]);
    assert.equal(despues[0], a);
    assert.equal(despues[2], c);
    assert.deepEqual(mensajesVisibles(despues).map((m) => m.id), [a.id, c.id]);
  });

  it('sin ningun escondido, los visibles son la misma lista', () => {
    const ventana = [mensaje(), mensaje()];
    assert.equal(mensajesVisibles(ventana), ventana);
  });

  it('un mensaje que llega tarde entra por su hora, no al final', () => {
    const a = mensaje({ minuto: 10 });
    const c = mensaje({ minuto: 30 });
    const b = mensaje({ minuto: 20 });
    const despues = aplicarMensaje([a, c], b);
    assert.deepEqual(despues.map((m) => m.id), [a.id, b.id, c.id]);
  });

  it('a la misma hora, el orden es estable (por id)', () => {
    const iso = '2026-10-04T12:00:00.000Z';
    const b = mensaje({ id: 'b', creadoEnIso: iso });
    const a = mensaje({ id: 'a', creadoEnIso: iso });
    assert.deepEqual(aplicarMensaje([b], a).map((m) => m.id), ['a', 'b']);
    assert.deepEqual(aplicarMensaje([a], b).map((m) => m.id), ['a', 'b']);
  });

  it('formatos de fecha distintos (`Z` y `+00:00`) se ordenan por instante', () => {
    const antes = mensaje({ id: 'x', creadoEnIso: '2026-10-04T12:00:01+00:00' });
    const despues = mensaje({ id: 'y', creadoEnIso: '2026-10-04T12:00:02.000Z' });
    assert.deepEqual(aplicarMensaje([despues], antes).map((m) => m.id), ['x', 'y']);
  });

  it('una rafaga de 5000 mensajes deja en memoria solo los ultimos', () => {
    let ventana: readonly MensajeDeVentana[] = [];
    let ultimo = mensaje();
    for (let i = 0; i < 5_000; i += 1) {
      ultimo = mensaje();
      ventana = aplicarMensaje(ventana, ultimo);
      assert.ok(ventana.length <= TOPE_DE_MENSAJES);
    }
    assert.equal(ventana.length, TOPE_DE_MENSAJES);
    assert.equal(ventana.at(-1), ultimo);
  });

  it('con la ventana llena, un mensaje anterior a toda ella no entra', () => {
    let ventana: readonly MensajeDeVentana[] = [];
    for (let i = 0; i < TOPE_DE_MENSAJES; i += 1) ventana = aplicarMensaje(ventana, mensaje({ minuto: 1_000 + i }));
    const viejo = mensaje({ minuto: 1 });
    assert.equal(aplicarMensaje(ventana, viejo), ventana);
  });

  it('la lista del servidor se FUNDE: no borra lo anterior ni cambia lo que no ha cambiado', () => {
    const viejos = [mensaje(), mensaje(), mensaje()];
    const ultimos = [viejos[2] as MensajeDeVentana, mensaje(), mensaje()];
    // El servidor devuelve objetos nuevos con los mismos datos.
    const delServidor = ultimos.map((m) => ({ ...m }));
    const fundida = fundirConLaLista(viejos, delServidor);
    assert.equal(fundida.length, 5);
    assert.equal(fundida[0], viejos[0], 'recargar se ha llevado lo que alguien estaba leyendo');
    assert.equal(fundida[2], viejos[2], 'un mensaje sin cambios ha cambiado de objeto');
    // Y si la lista no trae nada nuevo, la ventana es la misma.
    assert.equal(fundirConLaLista(fundida, delServidor), fundida);
  });

  it('cuantos nuevos: solo los visibles que no estaban', () => {
    const a = mensaje();
    const b = mensaje();
    const antes = [a];
    assert.equal(cuantosNuevos(antes, antes), 0);
    assert.equal(cuantosNuevos(antes, [a, b]), 1);
    assert.equal(cuantosNuevos(antes, [a, { ...b, oculto: true }]), 0);
    // Esconder uno que ya estaba no es un mensaje nuevo.
    assert.equal(cuantosNuevos([a, b], [a, { ...b, oculto: true }]), 0);
  });
});

describe('seguir el final, o no', () => {
  it('quien esta al final no acumula «nuevos»', () => {
    const inicial = seguimientoInicial();
    assert.equal(alLlegarMensajes(inicial, 3), inicial);
  });

  it('quien subio a leer no se mueve, y se le cuentan', () => {
    const leyendo = alDesplazar(seguimientoInicial(), UMBRAL_DEL_FINAL + 200);
    assert.deepEqual(leyendo, { alFinal: false, nuevos: 0 });
    const tras = alLlegarMensajes(alLlegarMensajes(leyendo, 2), 5);
    assert.deepEqual(tras, { alFinal: false, nuevos: 7 });
  });

  it('volver al final pone la cuenta a cero', () => {
    const leyendo = alLlegarMensajes(alDesplazar(seguimientoInicial(), 900), 4);
    assert.deepEqual(alDesplazar(leyendo, 0), { alFinal: true, nuevos: 0 });
  });

  it('un empujon pequeño (llega un mensaje) no saca a nadie del final', () => {
    const inicial = seguimientoInicial();
    assert.equal(alDesplazar(inicial, UMBRAL_DEL_FINAL), inicial);
    assert.equal(alDesplazar(inicial, 10), inicial);
  });

  it('desplazarse sin cambiar de zona devuelve el mismo objeto: no repinta', () => {
    const leyendo = alDesplazar(seguimientoInicial(), 500);
    assert.equal(alDesplazar(leyendo, 700), leyendo);
  });
});

describe('el estado del chat', () => {
  const base = { abierto: true, carga: 'lista', canal: 'suscrito', seConectoAntes: true } as const;

  it('los cinco estados', () => {
    assert.equal(estadoDelChat(base), 'conectado');
    assert.equal(estadoDelChat({ ...base, canal: 'conectando', seConectoAntes: false }), 'conectando');
    assert.equal(estadoDelChat({ ...base, carga: 'pendiente' }), 'conectando');
    assert.equal(estadoDelChat({ ...base, canal: 'caido' }), 'reconectando');
    assert.equal(estadoDelChat({ ...base, carga: 'fallida' }), 'error');
    assert.equal(estadoDelChat({ ...base, abierto: false }), 'cerrado');
  });

  it('cerrado manda sobre todo lo demas', () => {
    assert.equal(estadoDelChat({ abierto: false, carga: 'fallida', canal: 'caido', seConectoAntes: true }), 'cerrado');
  });

  it('un canal que nunca llego a estar no «reconecta»: conecta', () => {
    assert.equal(estadoDelChat({ ...base, canal: 'caido', seConectoAntes: false }), 'conectando');
  });
});

describe('la recarga agrupada: una rafaga no es una lectura por mensaje', () => {
  function recarga(duracionMs = 0) {
    const reloj = crearReloj();
    let enVuelo = 0;
    let simultaneas = 0;
    const pendientes: (() => void)[] = [];
    const r = crearRecargaAgrupada({
      esperaMs: 250,
      programar: reloj.programar,
      leer: () =>
        new Promise<void>((resolver) => {
          enVuelo += 1;
          simultaneas = Math.max(simultaneas, enVuelo);
          const terminar = () => {
            enVuelo -= 1;
            resolver();
          };
          if (duracionMs === 0) pendientes.push(terminar);
          else reloj.programar(terminar, duracionMs);
        }),
    });
    return { r, reloj, simultaneas: () => simultaneas, pendientes };
  }

  it('doscientos mensajes de gente nueva en un instante: UNA lectura', async () => {
    const { r, reloj } = recarga(100);
    for (let i = 0; i < 200; i += 1) r.pedir();
    assert.equal(r.lecturas(), 0, 'no espera a agrupar');
    reloj.avanzar(250);
    assert.equal(r.lecturas(), 1);
    reloj.avanzar(100);
    await asentar();
    reloj.avanzar(2_000);
    await asentar();
    assert.equal(r.lecturas(), 1);
  });

  it('si llegan mas durante la lectura, hace UNA mas al terminar, no una por mensaje', async () => {
    const { r, reloj, pendientes } = recarga();
    r.pedir();
    reloj.avanzar(250);
    assert.equal(r.lecturas(), 1);
    for (let i = 0; i < 500; i += 1) r.pedir();
    assert.equal(r.lecturas(), 1, 'ha lanzado otra con una en vuelo');

    pendientes.shift()?.();
    await asentar();
    reloj.avanzar(250);
    assert.equal(r.lecturas(), 2);
    pendientes.shift()?.();
    await asentar();
    reloj.avanzar(5_000);
    assert.equal(r.lecturas(), 2);
  });

  it('diez segundos de rafaga continua: lecturas acotadas y nunca dos a la vez', async () => {
    const { r, reloj, simultaneas } = recarga(400);
    // Un mensaje de alguien nuevo cada 10 ms durante 10 s: mil peticiones.
    for (let t = 0; t < 10_000; t += 10) {
      r.pedir();
      reloj.avanzar(10);
      await asentar(3);
    }
    reloj.avanzar(2_000);
    await asentar();
    assert.equal(simultaneas(), 1);
    // Cada ciclo dura espera + lectura = 650 ms: 10 s dan para dieciseis.
    assert.ok(r.lecturas() <= 17, `hizo ${r.lecturas()} lecturas para 1000 mensajes`);
    assert.ok(r.lecturas() >= 2);
  });

  it('una lectura que falla no rompe nada ni deja de agrupar', async () => {
    const reloj = crearReloj();
    let intentos = 0;
    const r = crearRecargaAgrupada({
      esperaMs: 250,
      programar: reloj.programar,
      leer: async () => {
        intentos += 1;
        throw new Error('sin red');
      },
    });
    r.pedir();
    reloj.avanzar(250);
    await asentar();
    r.pedir();
    reloj.avanzar(250);
    await asentar();
    assert.equal(intentos, 2);
  });

  it('cancelar suelta el temporizador y ya no lee', async () => {
    const { r, reloj } = recarga(100);
    r.pedir();
    r.cancelar();
    reloj.avanzar(5_000);
    await asentar();
    assert.equal(r.lecturas(), 0);
    assert.equal(reloj.vivos(), 0);
    r.pedir();
    reloj.avanzar(5_000);
    assert.equal(r.lecturas(), 0);
  });
});

describe('REVISION 04/10: la moderacion, con la fila que de verdad manda la tabla', () => {
  /*
    La tabla `live_messages` NO tiene columna `hidden`: tiene `hidden_at`
    (migracion 0029). Y Realtime solo entrega el UPDATE a quien todavia puede
    leer la fila: quien modera y quien la escribio. La prueba anterior usaba un
    doble que repartia a todos una fila con `hidden: true`, que el servidor de
    verdad no manda nunca, y por eso pasaba con el codigo roto.
  */
  type Fila = Parameters<ReturnType<typeof crearChatEnVivo>['llegaFila']>[0];

  function fila(id: string, segundo: number, escondida = false): Fila {
    return {
      id,
      session_id: 'e1',
      user_id: 'u-ana',
      body: `texto ${id}`,
      created_at: new Date(Date.UTC(2026, 9, 4, 12, 0, segundo)).toISOString(),
      hidden_at: escondida ? '2026-10-04T12:30:00+00:00' : null,
    } as Fila;
  }

  function deLista(f: Fila, oculto = false): MensajeDeChat {
    return {
      id: f.id,
      emisionId: f.session_id,
      usuarioId: f.user_id,
      usuarioNombre: 'Ana',
      cuerpo: f.body,
      creadoEnIso: f.created_at,
      oculto,
    };
  }

  function chat(servidor: () => MensajeDeChat[] | Promise<MensajeDeChat[]>) {
    const reloj = crearReloj();
    let ventana: readonly MensajeDeChat[] = [];
    const c = crearChatEnVivo({
      leer: async () => servidor(),
      esperaMs: 250,
      programar: reloj.programar,
      ahora: reloj.ahora,
      azar: () => 0,
      alCambiar: (siguiente) => {
        ventana = siguiente;
      },
      alLeer: () => {},
    });
    c.conocerA('u-ana', 'Ana');
    const visibles = () => mensajesVisibles(ventana).map((m) => m.id);
    return { c, reloj, visibles };
  }

  it('a QUIEN MODERA no le reaparece el mensaje cuando llega el cambio por tiempo real', () => {
    const { c, visibles } = chat(() => []);
    c.llegaFila(fila('a', 1));
    c.llegaFila(fila('malo', 2));
    assert.deepEqual(visibles(), ['a', 'malo']);

    // Quien modera lo esconde: la pantalla lo quita en el momento...
    c.poner({ ...deLista(fila('malo', 2)), oculto: true });
    assert.deepEqual(visibles(), ['a']);
    // ...y despues llega el UPDATE de la tabla, con `hidden_at` y sin `hidden`.
    c.llegaFila(fila('malo', 2, true));
    assert.deepEqual(visibles(), ['a'], 'el mensaje escondido ha vuelto a pintarse');
  });

  it('a QUIEN MIRA se le va en cuanto el servidor deja de devolverlo', async () => {
    // Al publico no le llega el UPDATE. Solo lo sabe al volver a leer: la
    // lista del servidor ya no trae el mensaje.
    let escondido = false;
    const filas = [fila('a', 1), fila('malo', 2), fila('c', 3)];
    const { c, reloj, visibles } = chat(() =>
      filas.filter((f) => !(escondido && f.id === 'malo')).map((f) => deLista(f)),
    );
    await c.cargar();
    assert.deepEqual(visibles(), ['a', 'malo', 'c']);

    escondido = true;
    c.seModero();
    reloj.avanzar(10_000);
    await asentar();
    assert.deepEqual(visibles(), ['a', 'c'], 'el mensaje moderado sigue en la pantalla de quien mira');
  });

  it('lo que el servidor no devuelve por ser MAS ANTIGUO que su lista se queda', async () => {
    // La lista trae los ultimos 50. Lo anterior no es que este escondido: es
    // que no cabe. No se puede retirar por no venir.
    const viejas = [fila('v1', 1), fila('v2', 2)];
    const recientes = [fila('r1', 30), fila('r2', 31)];
    let lista = [...viejas, ...recientes].map((f) => deLista(f));
    const { c, reloj, visibles } = chat(() => lista);
    await c.cargar();
    lista = recientes.map((f) => deLista(f));
    c.seModero();
    reloj.avanzar(10_000);
    await asentar();
    assert.deepEqual(visibles(), ['v1', 'v2', 'r1', 'r2']);
  });

  it('lo que llega MIENTRAS se lee no se retira; lo que ya estaba y no viene, si', async () => {
    /*
      La lista del servidor es una foto del momento en que se pidio. Un mensaje
      que entra por tiempo real con la lectura en vuelo no puede venir en ella,
      y no traerlo no significa que este escondido.
    */
    let entregar: ((lista: MensajeDeChat[]) => void) | null = null;
    let primera = true;
    const { c, reloj, visibles } = chat(() => {
      if (primera) {
        primera = false;
        return [deLista(fila('a', 1)), deLista(fila('viejo', 2))];
      }
      return new Promise<MensajeDeChat[]>((resolver) => {
        entregar = resolver;
      });
    });
    await c.cargar();
    assert.deepEqual(visibles(), ['a', 'viejo']);

    c.seModero();
    reloj.avanzar(10_000);
    await asentar();
    assert.ok(entregar, 'la lectura no ha empezado');
    // Con la lectura en vuelo llega uno nuevo...
    c.llegaFila(fila('nuevo', 3));
    assert.deepEqual(visibles(), ['a', 'viejo', 'nuevo']);
    // ...y la respuesta ya no trae `viejo` (lo han escondido) ni `nuevo`.
    (entregar as unknown as (lista: MensajeDeChat[]) => void)([deLista(fila('a', 1))]);
    await asentar();
    assert.deepEqual(visibles(), ['a', 'nuevo']);
  });

  it('una lista vacia es una respuesta completa: se va todo lo que ya estaba', async () => {
    let escondidos = false;
    const { c, reloj, visibles } = chat(() =>
      escondidos ? [] : [deLista(fila('a', 1)), deLista(fila('b', 2))],
    );
    await c.cargar();
    escondidos = true;
    c.seModero();
    reloj.avanzar(10_000);
    await asentar();
    assert.deepEqual(visibles(), []);
  });

  it('alguien a quien el servidor no devuelve no cuesta una lectura por cada mensaje suyo', async () => {
    // El servidor no entrega los mensajes de quien uno ha bloqueado, pero la
    // fila de tiempo real si llega.
    let lecturas = 0;
    const { c, reloj, visibles } = chat(() => {
      lecturas += 1;
      return [];
    });
    await c.cargar();
    const antes = lecturas;
    for (let i = 0; i < 12; i += 1) {
      c.llegaFila({ ...fila(`b${i}`, 10 + i), user_id: 'u-bloqueado' });
      reloj.avanzar(1_000);
      await asentar();
    }
    assert.ok(lecturas - antes <= 2, `${lecturas - antes} lecturas para 12 mensajes que nunca se pintan`);
    assert.deepEqual(visibles(), []);
  });

  it('la carga inicial y una lectura por autor nuevo no van a la vez', async () => {
    let enVuelo = 0;
    let simultaneas = 0;
    const pendientes: (() => void)[] = [];
    const reloj = crearReloj();
    const c = crearChatEnVivo({
      leer: () =>
        new Promise<MensajeDeChat[]>((resolver) => {
          enVuelo += 1;
          simultaneas = Math.max(simultaneas, enVuelo);
          pendientes.push(() => {
            enVuelo -= 1;
            resolver([]);
          });
        }),
      esperaMs: 250,
      programar: reloj.programar,
      ahora: reloj.ahora,
      azar: () => 0,
      alCambiar: () => {},
      alLeer: () => {},
    });
    // Entra en un chat activo con la red lenta: la carga inicial tarda...
    const carga = c.cargar();
    // ...y mientras tanto escribe gente que no conoce.
    for (let i = 0; i < 5; i += 1) c.llegaFila({ ...fila(`n${i}`, i), user_id: `u-nuevo-${i}` });
    reloj.avanzar(2_000);
    await asentar();
    assert.equal(simultaneas, 1, 'dos lecturas a la vez');
    pendientes.shift()?.();
    await carga;
    reloj.avanzar(2_000);
    await asentar();
    assert.equal(simultaneas, 1);
    while (pendientes.length > 0) pendientes.shift()?.();
    await asentar();
    c.destruir();
    assert.equal(reloj.vivos(), 0);
  });

  it('fechas con microsegundos, como las da PostgreSQL, se ordenan por instante', () => {
    const tarde = { ...deLista(fila('z', 1)), id: 'a-id', creadoEnIso: '2026-10-04T12:00:00.900001+00:00' };
    const pronto = { ...deLista(fila('y', 1)), id: 'z-id', creadoEnIso: '2026-10-04T12:00:00.100009+00:00' };
    assert.deepEqual(aplicarMensaje([tarde], pronto).map((m) => m.id), ['z-id', 'a-id']);
  });

  it('con una fecha ilegible no se baraja el chat: manda el orden de llegada', () => {
    const uno = { ...deLista(fila('zzz', 1)), creadoEnIso: 'no es una fecha' };
    const dos = { ...deLista(fila('aaa', 1)), creadoEnIso: 'tampoco' };
    assert.deepEqual(aplicarMensaje([uno], dos).map((m) => m.id), ['zzz', 'aaa']);
  });

  it('un aviso de moderacion falso no provoca mas de una lectura cada pocos segundos', async () => {
    // El aviso viaja por un canal publico: lo puede mandar cualquiera.
    let lecturas = 0;
    const { c, reloj } = chat(() => {
      lecturas += 1;
      return [];
    });
    await c.cargar();
    const antes = lecturas;
    for (let i = 0; i < 500; i += 1) {
      c.seModero();
      reloj.avanzar(20);
      await asentar(2);
    }
    // 500 avisos en 10 segundos.
    assert.ok(lecturas - antes <= 3, `${lecturas - antes} lecturas por 500 avisos`);
    assert.ok(lecturas - antes >= 1);
  });
});
