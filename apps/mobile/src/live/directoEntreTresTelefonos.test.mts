import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAXIMO_DE_BURBUJAS,
  TIC_DE_BURBUJAS_MS,
  crearPistaDeBurbujas,
  type Burbuja,
} from './burbujas.ts';
import {
  crearGestorDeCalidad,
  crearVigiaDeConexion,
  type CapaDeVideo,
  type DefinicionDeCapa,
} from './calidadDeVideo.ts';
import {
  asentar,
  crearBaseDeMensajes,
  crearRedDeBroadcast,
  crearReloj,
  type BaseDeMensajes,
  type RedDeBroadcast,
  type Reloj,
  type SuscripcionDeMensajes,
} from './dobles/enMemoria.mts';
import { crearGestorDeEfectos, type ComplementoDeEfectos } from './efectosDeVideo.ts';
import {
  VENTANA_DE_ENVIO_MS,
  conciliarConElServidor,
  crearCanalDeReacciones,
  reaccionesVacias,
  sumarReacciones,
  type ConteoDeReacciones,
  type TipoDeReaccion,
} from './reaccionesEnVivo.ts';
import {
  ESPERA_ENTRE_AVISOS_MS,
  TOPE_DE_MENSAJES,
  crearChatEnVivo,
  mensajesVisibles,
  topicoDeAvisosDelChat,
  type MensajeDeChat,
} from './ventanaDeChat.ts';

/**
 * UNA EMISION ENTERA, CON UN ANFITRION Y DOS ESPECTADORES.
 *
 * Cada «telefono» de aqui monta exactamente las piezas que montan
 * `ReaccionesDeDirecto` y `ChatDeDirecto` —el canal de reacciones, la pista de
 * burbujas, el chat en vivo—, sobre una red de Broadcast y una base de
 * mensajes en memoria que comparten los tres.
 *
 * LO QUE ESTO NO ES. No es una prueba en dispositivos. No hay video, ni
 * Supabase, ni 100ms: hay dobles. Lo que demuestra es que la logica de varios
 * clientes es correcta; que eso mismo ocurra entre tres telefonos de verdad es
 * el QA fisico de `docs/Z_QA_FISICO_PENDIENTE.md`.
 */

const INTERVALO_DE_RESUMEN_MS = 5_000;
const DURACION_DE_BURBUJA_MS = 1_400;
const ESPERA_DE_RECARGA_MS = 250;

type Mundo = { red: RedDeBroadcast; base: BaseDeMensajes; reloj: Reloj };

function mundo(): Mundo {
  const reloj = crearReloj();
  return { red: crearRedDeBroadcast(), base: crearBaseDeMensajes(reloj), reloj };
}

function telefono(m: Mundo, nombre: string, emisionId: string) {
  const usuario = { id: `u-${nombre}`, nombre };
  /** Lo que la politica de lectura y la API miran: quien es, y si modera. */
  const lector = { id: usuario.id, modera: nombre === 'Anfitrion' };

  /* --- Reacciones: lo que monta `ReaccionesDeDirecto`. --- */
  let contador: ConteoDeReacciones = reaccionesVacias();
  let burbujas: readonly Burbuja<TipoDeReaccion>[] = [];
  let pico = 0;
  const vistas = new Set<number>();
  const pista = crearPistaDeBurbujas<TipoDeReaccion>({
    programar: m.reloj.programar,
    alCambiar: (lista) => {
      burbujas = lista;
      pico = Math.max(pico, lista.length);
      for (const burbuja of lista) {
        if (vistas.has(burbuja.clave)) continue;
        vistas.add(burbuja.clave);
        m.reloj.programar(() => pista.quitar(burbuja.clave), DURACION_DE_BURBUJA_MS);
      }
    },
    alSumar: (conteos) => {
      contador = sumarReacciones(contador, conteos);
    },
  });
  const canal = crearCanalDeReacciones({
    emisionId,
    transporte: m.red.telefono(nombre),
    resumir: async () => {},
    esCierreDeReacciones: () => false,
    intervaloDeResumenMs: INTERVALO_DE_RESUMEN_MS,
    programar: m.reloj.programar,
    ahora: m.reloj.ahora,
    alResumir: (totales) => {
      contador = conciliarConElServidor(contador, totales);
    },
  });
  const dejarReacciones = canal.alRecibir((conteos) => pista.recibir(conteos));

  /* --- Chat: lo que monta `ChatDeDirecto`. --- */
  let ventana: readonly MensajeDeChat[] = [];
  let repintados = 0;
  let nuevosAvisados = 0;
  let carga: 'pendiente' | 'lista' | 'fallida' = 'pendiente';
  const chat = crearChatEnVivo({
    leer: () => m.base.ultimos(emisionId, lector),
    esperaMs: ESPERA_DE_RECARGA_MS,
    programar: m.reloj.programar,
    ahora: m.reloj.ahora,
    // Sin dispersion: los tiempos de la prueba son exactos.
    azar: () => 0,
    alCambiar: (siguiente, nuevos) => {
      ventana = siguiente;
      repintados += 1;
      nuevosAvisados += nuevos;
    },
    alLeer: (resultado) => {
      carga = resultado;
    },
  });
  chat.conocerA(usuario.id, usuario.nombre);
  void chat.cargar();
  let suscripcion: SuscripcionDeMensajes | null = m.base.suscribir(
    emisionId,
    lector,
    chat.llegaFila,
  );
  // El aviso de moderacion: un Broadcast sin contenido que manda quien modera.
  const avisos = m.red.telefono(nombre).abrir(topicoDeAvisosDelChat(emisionId), {
    alRecibir: () => chat.seModero(),
    alCambiarEstado: () => {},
  });

  return {
    usuario,
    canal,
    pista,
    chat,
    pulsar(tipo: TipoDeReaccion) {
      pista.soltarPropia(tipo);
      contador = sumarReacciones(contador, { [tipo]: 1 });
      canal.enviar(tipo);
    },
    escribir(cuerpo: string) {
      // El POST solo escribe: el mensaje entra por la suscripcion.
      return m.base.escribir(emisionId, usuario, cuerpo);
    },
    /** Lo que hace `ChatDeDirecto` cuando quien modera esconde un mensaje. */
    moderar(mensajeId: string, opciones: { avisar?: boolean } = {}) {
      m.base.ocultar(mensajeId);
      const mensaje = chat.ventana().find((otro) => otro.id === mensajeId);
      if (mensaje) chat.poner({ ...mensaje, oculto: true });
      if (opciones.avisar !== false) avisos.enviar({ v: 1 });
    },
    /** Se cae la red del telefono: Broadcast y chat a la vez. */
    perderLaRed() {
      m.red.cortar(nombre);
      suscripcion?.cortar();
    },
    recuperarLaRed() {
      m.red.restablecer(nombre);
      suscripcion?.volver();
      chat.volvioElCanal();
    },
    /** Lo que hace la pantalla al desmontarse. */
    salir() {
      dejarReacciones();
      canal.cerrar();
      pista.destruir();
      suscripcion?.dejar();
      suscripcion = null;
      avisos.cerrar();
      chat.destruir();
    },
    contador: () => contador,
    burbujas: () => burbujas.length,
    picoDeBurbujas: () => pico,
    textos: () => mensajesVisibles(ventana).map((mensaje) => `${mensaje.usuarioNombre}: ${mensaje.cuerpo}`),
    ids: () => mensajesVisibles(ventana).map((mensaje) => mensaje.id),
    ventana: () => ventana,
    repintados: () => repintados,
    nuevosAvisados: () => nuevosAvisados,
    carga: () => carga,
  };
}

async function sala(emisionId = 'e1') {
  const m = mundo();
  const anfitrion = telefono(m, 'Anfitrion', emisionId);
  const ana = telefono(m, 'Ana', emisionId);
  const luis = telefono(m, 'Luis', emisionId);
  await asentar();
  return { m, anfitrion, ana, luis, todos: [anfitrion, ana, luis] };
}

/** Deja pasar lo justo para que lo enviado llegue y se pinte. */
async function reposar(m: Mundo, ms = VENTANA_DE_ENVIO_MS + TIC_DE_BURBUJAS_MS): Promise<void> {
  m.reloj.avanzar(ms);
  await asentar();
}

/* ========================================================================= */

describe('1–2. Reacciones entre los tres, y solo entre los tres', () => {
  it('cada uno recibe las de los otros dos, y nadie la suya', async () => {
    const { m, anfitrion, ana, luis, todos } = await sala();
    anfitrion.pulsar('aplauso');
    ana.pulsar('corazon');
    luis.pulsar('fuego');
    await reposar(m);

    for (const uno of todos) {
      assert.deepEqual(
        { aplauso: uno.contador().aplauso, corazon: uno.contador().corazon, fuego: uno.contador().fuego },
        { aplauso: 1, corazon: 1, fuego: 1 },
        `${uno.usuario.nombre} no ve lo mismo que los demas`,
      );
      assert.equal(uno.canal.diagnostico().recibidos, 2, 'dos ajenas, ninguna propia');
      assert.equal(uno.pista.diagnostico().pintadas, 3, 'una propia y dos ajenas, una vez cada una');
    }
    // Tres envios, dos entregas cada uno.
    assert.equal(m.red.cuenta.enviados, 3);
    assert.equal(m.red.cuenta.entregas, 6);
  });

  it('otra emision a la vez no se mezcla en ningun sentido', async () => {
    const m = mundo();
    const aqui = [telefono(m, 'Anfitrion', 'e1'), telefono(m, 'Ana', 'e1')];
    const alli = [telefono(m, 'Otro', 'e2'), telefono(m, 'Marta', 'e2')];
    await asentar();

    aqui[1]?.pulsar('corazon');
    alli[1]?.pulsar('risa');
    await reposar(m);

    assert.equal(aqui[0]?.contador().corazon, 1);
    assert.equal(aqui[0]?.contador().risa, 0, 'llego una reaccion de otra emision');
    assert.equal(alli[0]?.contador().risa, 1);
    assert.equal(alli[0]?.contador().corazon, 0, 'llego una reaccion de otra emision');
  });
});

describe('3–4. Chat en tiempo real y moderacion', () => {
  it('lo que escribe uno lo ven los tres, en el mismo orden y sin duplicados', async () => {
    const { m, anfitrion, ana, luis, todos } = await sala();
    ana.escribir('hola');
    await reposar(m, ESPERA_DE_RECARGA_MS);
    luis.escribir('buenas');
    await reposar(m, ESPERA_DE_RECARGA_MS);
    anfitrion.escribir('bienvenidos');
    ana.escribir('gracias');
    await reposar(m, ESPERA_DE_RECARGA_MS);

    const esperado = ['Ana: hola', 'Luis: buenas', 'Anfitrion: bienvenidos', 'Ana: gracias'];
    for (const uno of todos) {
      assert.deepEqual(uno.textos(), esperado, `el chat de ${uno.usuario.nombre}`);
      assert.equal(new Set(uno.ids()).size, uno.ids().length, 'hay un mensaje repetido');
    }
  });

  it('quien escribe ve su mensaje al momento, sin esperar a ninguna lectura', async () => {
    const { m, ana } = await sala();
    const lecturasAntes = m.base.lecturas();
    ana.escribir('ya esta');
    assert.deepEqual(ana.textos(), ['Ana: ya esta']);
    assert.equal(m.base.lecturas(), lecturasAntes);
  });

  it('un mensaje nunca se pinta sin nombre: el de un desconocido espera a la lectura', async () => {
    const { m, ana, luis } = await sala();
    ana.escribir('soy nueva');
    // Luis aun no sabe como se llama `u-Ana`: no pinta nada todavia.
    assert.deepEqual(luis.textos(), []);
    await reposar(m, ESPERA_DE_RECARGA_MS);
    assert.deepEqual(luis.textos(), ['Ana: soy nueva']);
    // La segunda vez ya la conoce: entra directa.
    const lecturas = m.base.lecturas();
    ana.escribir('otra vez');
    assert.deepEqual(luis.textos(), ['Ana: soy nueva', 'Ana: otra vez']);
    assert.equal(m.base.lecturas(), lecturas);
  });

  it('esconder un mensaje lo quita de las tres pantallas', async () => {
    /*
      La tabla solo entrega el cambio a quien modera y a quien escribio el
      mensaje. A Ana —que solo mira— no le llega nada por la base: se entera
      por el aviso de moderacion, que le hace volver a leer del servidor.
    */
    const { m, anfitrion, ana, luis, todos } = await sala();
    ana.escribir('uno');
    const malo = luis.escribir('esto no');
    ana.escribir('tres');
    await reposar(m, ESPERA_DE_RECARGA_MS * 2);
    for (const uno of todos) assert.equal(uno.textos().length, 3);

    anfitrion.moderar(malo.id);
    // Quien modera lo ve desaparecer en el momento, y no le vuelve cuando
    // llega el cambio de la tabla.
    assert.deepEqual(anfitrion.textos(), ['Ana: uno', 'Ana: tres']);

    await reposar(m, ESPERA_DE_RECARGA_MS * 2);
    for (const uno of todos) {
      assert.deepEqual(uno.textos(), ['Ana: uno', 'Ana: tres'], `sigue visible para ${uno.usuario.nombre}`);
    }
    // Y sigue fuera despues de mas mensajes y mas lecturas.
    ana.escribir('cuatro');
    await reposar(m, ESPERA_ENTRE_AVISOS_MS);
    assert.deepEqual(ana.textos(), ['Ana: uno', 'Ana: tres', 'Ana: cuatro']);
    assert.deepEqual(anfitrion.textos(), ['Ana: uno', 'Ana: tres', 'Ana: cuatro']);
  });

  it('si el aviso de moderacion se pierde, a quien mira se le va en su siguiente lectura', async () => {
    const { m, anfitrion, ana, luis } = await sala();
    ana.escribir('uno');
    const malo = luis.escribir('esto no');
    await reposar(m, ESPERA_DE_RECARGA_MS * 2);

    anfitrion.moderar(malo.id, { avisar: false });
    await reposar(m, ESPERA_DE_RECARGA_MS * 2);
    assert.deepEqual(anfitrion.textos(), ['Ana: uno']);
    // Sin aviso y sin motivo para leer, Ana todavia lo tiene delante. Es el
    // limite conocido: el aviso es lo que lo hace inmediato.
    assert.deepEqual(ana.textos(), ['Ana: uno', 'Luis: esto no']);

    // En cuanto lee por lo que sea —aqui, alguien nuevo escribe—, se le va.
    m.base.escribir('e1', { id: 'u-Marta', nombre: 'Marta' }, 'hola');
    await reposar(m, ESPERA_DE_RECARGA_MS * 2);
    assert.deepEqual(ana.textos(), ['Ana: uno', 'Marta: hola']);
  });

  it('un aviso de moderacion FALSO no esconde nada: el servidor es quien decide', async () => {
    const { m, ana, luis, todos } = await sala();
    ana.escribir('uno');
    luis.escribir('dos');
    await reposar(m, ESPERA_DE_RECARGA_MS * 2);
    const lecturas = m.base.lecturas();
    // Cualquiera con la clave publica puede mandar esto al canal.
    for (let i = 0; i < 200; i += 1) {
      m.red.inyectar(topicoDeAvisosDelChat('e1'), { v: 1, ocultar: 'todo' });
      m.reloj.avanzar(10);
      await asentar(2);
    }
    await reposar(m, ESPERA_ENTRE_AVISOS_MS);
    for (const uno of todos) assert.deepEqual(uno.textos(), ['Ana: uno', 'Luis: dos']);
    // 200 avisos en 2 s: como mucho dos lecturas por telefono, no doscientas.
    assert.ok(m.base.lecturas() - lecturas <= 6, `${m.base.lecturas() - lecturas} lecturas`);
  });

  it('a quien ha bloqueado a alguien no le llegan sus mensajes, ni le cuestan lecturas', async () => {
    const { m, ana, luis } = await sala();
    m.base.bloquear(ana.usuario.id, 'u-Pesado');
    const lecturas = m.base.lecturas();
    for (let i = 0; i < 20; i += 1) {
      m.base.escribir('e1', { id: 'u-Pesado', nombre: 'Pesado' }, `spam ${i}`);
      m.reloj.avanzar(500);
      await asentar(3);
    }
    await reposar(m, ESPERA_DE_RECARGA_MS * 2);
    assert.deepEqual(ana.textos(), [], 've mensajes de alguien a quien ha bloqueado');
    assert.equal(luis.textos().length, 20, 'a quien no lo ha bloqueado si le llegan');
    // Tres telefonos: los dos que no lo bloquean leen una vez para saber quien
    // es; la que lo bloquea lee una y deja de preguntar.
    assert.ok(m.base.lecturas() - lecturas <= 5, `${m.base.lecturas() - lecturas} lecturas`);
  });

  it('quien entra tarde carga los ultimos, sin lo escondido y sin todo el historial', async () => {
    const { m, ana, luis } = await sala();
    for (let i = 0; i < 80; i += 1) ana.escribir(`mensaje ${i}`);
    const escondido = luis.escribir('fuera');
    ana.escribir('el ultimo');
    m.base.ocultar(escondido.id);

    const tarde = telefono(m, 'Marta', 'e1');
    await asentar();
    assert.equal(tarde.carga(), 'lista');
    // El servidor da los ultimos 50 QUE ESTA PERSONA PUEDE VER: lo escondido
    // ni siquiera viaja.
    assert.equal(tarde.ventana().length, 50);
    assert.equal(tarde.textos().length, 50);
    assert.equal(tarde.textos().at(-1), 'Ana: el ultimo');
    assert.equal(tarde.textos().includes('Luis: fuera'), false);
  });

  it('si la primera lectura falla se dice, y reintentar lo arregla', async () => {
    const m = mundo();
    m.base.escribir('e1', { id: 'u-Ana', nombre: 'Ana' }, 'antes');
    m.base.queFalle(true);
    const luis = telefono(m, 'Luis', 'e1');
    await asentar();
    assert.equal(luis.carga(), 'fallida');

    m.base.queFalle(false);
    await luis.chat.cargar();
    assert.equal(luis.carga(), 'lista');
    assert.deepEqual(luis.textos(), ['Ana: antes']);
  });
});

describe('5–6. Rafagas', () => {
  it('los tres pulsando sin parar: nadie pasa del tope de burbujas, y las colas se vacian', async () => {
    const { m, todos } = await sala();
    const tipos: TipoDeReaccion[] = ['corazon', 'fuego', 'aplauso'];
    for (let ronda = 0; ronda < 40; ronda += 1) {
      todos.forEach((uno, i) => {
        for (let toque = 0; toque < 8; toque += 1) uno.pulsar(tipos[i] as TipoDeReaccion);
      });
      m.reloj.avanzar(TIC_DE_BURBUJAS_MS);
      for (const uno of todos) {
        assert.ok(uno.burbujas() <= MAXIMO_DE_BURBUJAS, `${uno.usuario.nombre}: ${uno.burbujas()} burbujas`);
      }
    }
    // 960 toques entre los tres; los mensajes de Broadcast son muchos menos.
    assert.ok(m.red.cuenta.enviados < 120, `${m.red.cuenta.enviados} mensajes para 960 toques`);

    m.reloj.avanzar(DURACION_DE_BURBUJA_MS * 4);
    for (const uno of todos) {
      assert.ok(uno.picoDeBurbujas() <= MAXIMO_DE_BURBUJAS);
      assert.equal(uno.canal.diagnostico().pendientes, 0, 'cola de salida');
      assert.equal(uno.pista.diagnostico().enEspera, 0, 'cola de entrada');
      assert.equal(uno.burbujas(), 0);
    }
  });

  it('una rafaga de mensajes de gente nueva: ventana acotada, lecturas acotadas, mismo orden', async () => {
    const { m, ana, luis } = await sala();
    const lecturasAntes = m.base.lecturas();
    // 300 mensajes de 30 personas que nadie conoce, en tres segundos.
    for (let i = 0; i < 300; i += 1) {
      const quien = i % 30;
      m.base.escribir('e1', { id: `u-nuevo-${quien}`, nombre: `Nuevo ${quien}` }, `m${i}`);
      m.reloj.avanzar(10);
      await asentar(2);
      assert.ok(ana.ventana().length <= TOPE_DE_MENSAJES);
    }
    await reposar(m, ESPERA_DE_RECARGA_MS * 4);

    // Sin agrupar serian 30 lecturas por telefono como poco (una por persona
    // nueva) y hasta 300. Hay tres telefonos en la sala.
    const lecturas = m.base.lecturas() - lecturasAntes;
    assert.ok(lecturas <= 3 * 13, `${lecturas} lecturas para una rafaga de 3 s`);

    assert.ok(ana.ventana().length <= TOPE_DE_MENSAJES);
    assert.equal(ana.textos().at(-1), 'Nuevo 29: m299');
    // Los dos espectadores acaban viendo lo mismo, en el mismo orden.
    assert.deepEqual(ana.ids().slice(-50), luis.ids().slice(-50));
    assert.equal(new Set(ana.ids()).size, ana.ids().length);
    // Un repintado por cambio de ventana, no uno por fila ni por lectura vacia.
    assert.ok(ana.repintados() <= 300 + lecturas);
  });

  it('una rafaga de gente YA conocida no hace ninguna lectura', async () => {
    const { m, ana, luis, anfitrion } = await sala();
    ana.escribir('a');
    luis.escribir('b');
    anfitrion.escribir('c');
    await reposar(m, ESPERA_DE_RECARGA_MS * 3);
    const lecturas = m.base.lecturas();

    for (let i = 0; i < 200; i += 1) (i % 2 === 0 ? ana : luis).escribir(`r${i}`);
    await reposar(m, ESPERA_DE_RECARGA_MS * 3);
    assert.equal(m.base.lecturas(), lecturas);
    assert.equal(anfitrion.ventana().length, TOPE_DE_MENSAJES);
    assert.equal(anfitrion.textos().at(-1), 'Luis: r199');
  });
});

describe('7–8. Reconexion, salida y reentrada', () => {
  it('un espectador pierde la red: al volver recupera el chat con UNA lectura y sin duplicados', async () => {
    const { m, ana, luis, anfitrion } = await sala();
    ana.escribir('antes');
    await reposar(m, ESPERA_DE_RECARGA_MS);

    luis.perderLaRed();
    ana.escribir('durante 1');
    anfitrion.escribir('durante 2');
    ana.pulsar('corazon');
    await reposar(m, ESPERA_DE_RECARGA_MS);
    assert.deepEqual(luis.textos(), ['Ana: antes'], 'sin red no llega nada');
    assert.equal(luis.contador().corazon, 0);

    const lecturas = m.base.lecturas();
    luis.recuperarLaRed();
    await reposar(m, ESPERA_DE_RECARGA_MS);
    assert.equal(m.base.lecturas() - lecturas, 1);
    assert.deepEqual(luis.textos(), ['Ana: antes', 'Ana: durante 1', 'Anfitrion: durante 2']);

    // Y sigue en la sala: recibe lo siguiente por tiempo real, una vez.
    ana.escribir('despues');
    ana.pulsar('fuego');
    await reposar(m);
    assert.equal(luis.textos().at(-1), 'Ana: despues');
    assert.equal(new Set(luis.ids()).size, luis.ids().length);
    assert.equal(luis.contador().fuego, 1);
    // La reaccion de mientras estaba caido NO se reenvia: era de entonces.
    assert.equal(luis.contador().corazon, 0);
  });

  it('salir y volver a entrar: lo de antes se carga, lo nuevo llega, nada doble', async () => {
    const { m, ana, luis } = await sala();
    ana.escribir('uno');
    await reposar(m, ESPERA_DE_RECARGA_MS);

    luis.salir();
    ana.escribir('dos');
    ana.pulsar('corazon');
    await reposar(m);
    assert.deepEqual(luis.textos(), ['Ana: uno'], 'una pantalla cerrada sigue recibiendo');
    assert.equal(luis.contador().corazon, 0);

    const otraVez = telefono(m, 'Luis', 'e1');
    await asentar();
    assert.deepEqual(otraVez.textos(), ['Ana: uno', 'Ana: dos']);
    ana.escribir('tres');
    ana.pulsar('risa');
    await reposar(m);
    assert.deepEqual(otraVez.textos(), ['Ana: uno', 'Ana: dos', 'Ana: tres']);
    assert.equal(otraVez.contador().risa, 1);
    assert.equal(otraVez.pista.diagnostico().pintadas, 1);
  });
});

describe('9–11. Cierre de la emision y desmontaje', () => {
  it('al cerrarse la emision y salir todos no queda ningun canal ni temporizador', async () => {
    const { m, ana, luis, todos } = await sala();
    ana.escribir('adios');
    ana.pulsar('corazon');
    luis.pulsar('aplauso');
    await reposar(m);

    for (const uno of todos) uno.salir();
    m.reloj.avanzar(INTERVALO_DE_RESUMEN_MS + DURACION_DE_BURBUJA_MS);
    await asentar();

    assert.equal(m.red.abiertos(), 0, 'quedan canales de Broadcast');
    assert.equal(m.base.suscriptores(), 0, 'quedan suscripciones al chat');
    assert.equal(m.reloj.vivos(), 0, 'quedan temporizadores');
  });

  it('salir dos veces es seguro', async () => {
    const { ana } = await sala();
    assert.doesNotThrow(() => {
      ana.salir();
      ana.salir();
    });
  });

  it('despues de salir, nada de lo que llegue toca la pantalla', async () => {
    const { m, ana, luis } = await sala();
    luis.salir();
    const repintados = luis.repintados();
    ana.escribir('tarde');
    ana.pulsar('corazon');
    luis.chat.volvioElCanal();
    await reposar(m, ESPERA_DE_RECARGA_MS * 2);
    assert.equal(luis.repintados(), repintados);
    assert.equal(luis.burbujas(), 0);
  });

  it('cien entradas y salidas seguidas no acumulan nada', async () => {
    const m = mundo();
    const fijo = telefono(m, 'Anfitrion', 'e1');
    for (let i = 0; i < 100; i += 1) {
      const uno = telefono(m, 'Ana', 'e1');
      uno.pulsar('corazon');
      uno.escribir(`hola ${i}`);
      uno.salir();
    }
    await reposar(m, INTERVALO_DE_RESUMEN_MS + DURACION_DE_BURBUJA_MS);
    // Los dos canales de Broadcast del anfitrion: reacciones y avisos del chat.
    assert.equal(m.red.abiertos(), 2, 'solo el anfitrion sigue dentro');
    assert.equal(m.base.suscriptores(), 1);
    fijo.salir();
    m.reloj.avanzar(INTERVALO_DE_RESUMEN_MS + DURACION_DE_BURBUJA_MS);
    await asentar();
    assert.equal(m.reloj.vivos(), 0);
  });
});

describe('12. El filtro del anfitrion a lo largo de una emision', () => {
  it('aplicar, cambiar, cambiar de camara, caerse y volver, quitar', async () => {
    const reloj = crearReloj();
    const llamadas: string[] = [];
    const complemento: ComplementoDeEfectos = {
      activar: async () => void llamadas.push('activar'),
      desactivar: async () => void llamadas.push('desactivar'),
      desenfocar: async (radio) => void llamadas.push(`desenfocar(${radio})`),
      ponerFondo: async (id) => void llamadas.push(`fondo(${id})`),
    };
    const estados: string[] = [];
    const efectos = crearGestorDeEfectos({
      complemento,
      fondos: ['estudio-oscuro'],
      programar: reloj.programar,
      alCambiar: (estado) => estados.push(estado.efecto.tipo),
    });

    // APLICAR.
    assert.equal((await efectos.aplicar({ tipo: 'desenfoque' })).efecto.tipo, 'desenfoque');
    // CAMBIAR.
    const conFondo = await efectos.aplicar({ tipo: 'fondo', fondoId: 'estudio-oscuro' });
    assert.deepEqual(conFondo.efecto, { tipo: 'fondo', fondoId: 'estudio-oscuro' });

    // CAMBIAR DE CAMARA: la sala gira la camara sin tocar el efecto. Aqui no
    // hay nada que llamar, y eso es lo que se comprueba: sigue puesto.
    const antes = llamadas.length;
    assert.deepEqual(efectos.estado().efecto, { tipo: 'fondo', fondoId: 'estudio-oscuro' });
    assert.equal(llamadas.length, antes);

    // CAERSE: la sala sale (quita el procesado) y recuerda lo que habia.
    await efectos.apagarParaSalir();
    assert.equal(efectos.estado().efecto.tipo, 'ninguno');
    assert.equal(efectos.hayQueReponer(), true, 'al volver enseñaria el fondo real');

    // VOLVER: pista nueva, se repone.
    const repuesto = await efectos.laPistaEsNueva();
    assert.deepEqual(repuesto.efecto, { tipo: 'fondo', fondoId: 'estudio-oscuro' });
    assert.equal(repuesto.error, null);

    // QUITAR.
    assert.equal((await efectos.aplicar({ tipo: 'ninguno' })).efecto.tipo, 'ninguno');

    assert.deepEqual(llamadas, [
      'activar',
      'desenfocar(75)',
      'fondo(estudio-oscuro)',
      'desactivar',
      'activar',
      'fondo(estudio-oscuro)',
      'desactivar',
    ]);
    assert.equal(reloj.vivos(), 0);
    assert.equal(estados.at(-1), 'ninguno');
  });
});

describe('13. La calidad a lo largo de una emision', () => {
  it('normal, degradada, recuperada, y cambio de capa sin reconectar', async () => {
    const CAPAS: DefinicionDeCapa[] = [
      { capa: 'baja', ancho: 180, alto: 320 },
      { capa: 'alta', ancho: 720, alto: 1280 },
    ];
    const conexion: boolean[] = [];
    const vigia = crearVigiaDeConexion((buena) => conexion.push(buena));
    const fijadas: CapaDeVideo[] = [];
    let entradasEnLaSala = 1;
    const calidad = crearGestorDeCalidad({
      leerCapas: async () => CAPAS,
      fijarCapa: async (_pista, capa) => void fijadas.push(capa),
      alCambiar: () => {},
    });

    // NORMAL: el espectador ve al anfitrion; el proveedor elige.
    await calidad.cambioLaPista('pista-anfitrion');
    for (const nota of [4, 5, 4]) vigia.nota(nota);
    assert.deepEqual(conexion, []);
    assert.equal(calidad.capaAutomatica(), true);

    // DEGRADADA: la red empeora y el proveedor rebaja la imagen.
    vigia.nota(2);
    vigia.nota(1);
    vigia.pistaDegradada(true);
    assert.deepEqual(conexion, [false]);

    // El espectador elige ahorrar datos. No se sale de la sala para eso.
    await calidad.elegir('ahorro');
    assert.deepEqual(fijadas, ['baja']);
    assert.equal(entradasEnLaSala, 1, 'cambiar de calidad no puede reconectar');

    // RECUPERADA.
    vigia.pistaDegradada(false);
    vigia.nota(4);
    vigia.nota(4);
    assert.deepEqual(conexion, [false, true]);

    // El anfitrion apaga y enciende la camara: pista nueva, misma eleccion.
    entradasEnLaSala += 0;
    await calidad.cambioLaPista('pista-anfitrion-2');
    assert.deepEqual(fijadas, ['baja', 'baja']);
    assert.equal(calidad.estado().elegida, 'ahorro');

    // Y vuelve a alta.
    await calidad.elegir('alta');
    assert.deepEqual(fijadas.at(-1), 'alta');
  });

  it('el anfitrion no tiene nada que elegir: ve su camara, que no tiene capas', async () => {
    const calidad = crearGestorDeCalidad({
      leerCapas: async () => {
        throw new Error('no se le piden capas a la pista propia');
      },
      fijarCapa: async () => {
        throw new Error('no se fija capa en la pista propia');
      },
      alCambiar: () => {},
    });
    // La sala no le pasa pista vista a quien publica.
    await calidad.cambioLaPista(null);
    assert.deepEqual(calidad.estado().opciones, []);
    await assert.doesNotReject(calidad.elegir('alta'));
    assert.equal(calidad.estado().elegida, 'automatica');
  });
});
