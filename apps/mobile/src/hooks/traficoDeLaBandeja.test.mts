/**
 * Cuánto tráfico genera un mensaje en el teléfono de los DEMÁS, medido sobre
 * el código de verdad (auditoría del 28/10, §10).
 *
 * QUÉ SE EJECUTA. El hook real (`useAvisosEnVivo`), el servicio real de
 * contadores (`services/contadores`), el oyente real del push en primer plano
 * (`useAvisosDelPush.native`) y el hook real de «escribiendo» en la bandeja.
 * Lo único simulado es lo que está fuera del teléfono o no corre en Node:
 * React (los efectos se ejecutan al montar), el canal de Supabase, el push,
 * el reloj y la API, que aquí es un servidor de mentira con la MISMA regla de
 * no leídos que `lectura.py` y que apunta cada petición que recibe.
 *
 * QUÉ SE FIJA, además de contar:
 *
 *   - los globos: después de CADA mensaje, el de la pestaña es exactamente lo
 *     que diría el servidor, sin esperar a ninguna lectura;
 *   - la recarga de seguridad: como mucho una cada veinte segundos aunque
 *     sigan llegando mensajes;
 *   - lo que sí pregunta: una conversación desconocida, un reenganche del
 *     canal, un push que el tiempo real no trajo;
 *   - lo que se cruza con una pregunta en vuelo: ni se pierde ni se cuenta dos
 *     veces, y leer no resucita el globo;
 *   - cuántos canales de «escribiendo» abre la bandeja.
 *
 * CÓMO SE MIDE «ANTES». Este mismo fichero se puede lanzar contra otro árbol
 * de fuentes, por ejemplo el de `origin/main` sacado con `git archive`:
 *
 *     TRAFICO_SRC=/ruta/a/apps/mobile/src \
 *       node --experimental-strip-types --test src/hooks/traficoDeLaBandeja.test.mts
 *
 * Con otro árbol solo MIDE (lo cuenta con `t.diagnostic`): las exigencias son
 * las del código nuevo y no se le piden a uno que no las conoce.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { after, afterEach, describe, it, mock } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROPIO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.env.TRAFICO_SRC ? resolve(process.env.TRAFICO_SRC) : PROPIO;
/** Midiendo otro árbol (el de antes): solo se cuenta, no se exige. */
const SOLO_MEDIR = SRC !== PROPIO;

/* ------------------------------------------------------------------------- */
/* LO SIMULADO                                                               */
/* ------------------------------------------------------------------------- */

/*
  Cada módulo simulado lee y escribe en `globalThis.__T`, que se rehace en
  cada escenario. Son JavaScript plano: no pasan por el quitatipos.
*/
const FALSOS: Record<string, string> = {
  react: `
    const T = () => globalThis.__T;
    export function useEffect(fn) { const l = fn(); if (typeof l === 'function') T().limpiezas.push(l); }
    export function useRef(v) { return { current: v }; }
    export function useMemo(fn) { return fn(); }
    export function useCallback(fn) { return fn; }
    export function useState(v) { return [typeof v === 'function' ? v() : v, () => {}]; }
    export default { useEffect, useRef, useMemo, useCallback, useState };
  `,
  'react-native': `
    export const AppState = {
      get currentState() { return globalThis.__T.appState; },
      addEventListener(_tipo, fn) { globalThis.__T.alCambiarAppState = fn; return { remove() {} }; },
    };
    export const Platform = { OS: 'android' };
  `,
  'expo-router': `export function useRouter() { return { push() {} }; }`,
  'expo-notifications': `
    export function addNotificationReceivedListener(fn) {
      globalThis.__T.oyenteDelPush = fn;
      return { remove() { globalThis.__T.oyenteDelPush = undefined; } };
    }
  `,
  '@/i18n': `export function traduceEnElIdiomaActual(clave) { return clave; }`,
  '@/lib/toast': `
    export function avisar(aviso) { globalThis.__T.avisos.push(aviso); }
  `,
  '@/repositories/NotificationRepository': `
    export const NotificationRepository = {
      async novedades() {
        const T = globalThis.__T;
        T.peticiones.push({ que: 'GET /notifications/unread-count', en: Date.now() });
        await T.servidor.viaje();
        return { cuenta: 0, nuevos: 0 };
      },
      async list() {
        const T = globalThis.__T;
        T.peticiones.push({ que: 'GET /notifications', en: Date.now() });
        await T.servidor.viaje();
        return [];
      },
    };
  `,
  '@/repositories/MessageRepository': `
    export const CONVERSACIONES_POR_PAGINA = 20;
    export const MessageRepository = {
      async listConversations() {
        const T = globalThis.__T;
        T.peticiones.push({ que: 'GET /conversations', en: Date.now() });
        // Ida, consulta, vuelta: lo que entre mientras va y viene no sale.
        await T.servidor.mitadDelViaje();
        const portada = T.servidor.portada();
        await T.servidor.mitadDelViaje();
        return portada;
      },
      async markRead(id) {
        const T = globalThis.__T;
        T.peticiones.push({ que: 'POST /conversations/:id/read', en: Date.now() });
        await T.servidor.mitadDelViaje();
        T.servidor.leer(id);
      },
    };
  `,
  '@/services/notifications': `
    export async function asegurarRegistroDePush() {}
    export async function setBadgeCount() {}
  `,
  '@/services/supabase': `
    export const supabase = {
      channel() {
        const T = globalThis.__T;
        const canal = {
          on(_tipo, _filtro, cb) { T.canal.alInsertar = cb; return canal; },
          subscribe(cb) { T.canal.alEstado = cb; queueMicrotask(() => cb('SUBSCRIBED')); return canal; },
        };
        return canal;
      },
      async removeChannel() {},
      auth: { async getSession() { return { data: { session: { user: { id: globalThis.__T.yo } } } }; } },
    };
  `,
  '@/store/useAuthStore': `
    export function useAuthStore(sel) { return sel({ supabaseEnabled: true, status: 'authenticated' }); }
  `,
  '@/store/useContadoresStore': `
    export const useContadoresStore = {
      getState() {
        const c = globalThis.__T.contadores;
        return {
          ...c,
          ponerNotificaciones(n) { c.notificaciones = n; },
          ponerMensajes(n) { c.mensajes = n; },
          vaciar() { c.notificaciones = 0; c.mensajes = 0; },
        };
      },
    };
  `,
  '@/mappers/messageMapper': `
    export function formatTime(iso) { return iso ? String(iso).slice(11, 16) : ''; }
  `,
  '@/services/realtime': `
    export function canalDeEscritura(id) {
      const T = globalThis.__T;
      T.canalesDeEscritura.add(id);
      return { avisar() {}, cerrar() { T.canalesDeEscritura.delete(id); } };
    }
  `,
  '@/repositories/GroupRepository': `
    export const GroupRepository = {
      async info() { globalThis.__T.peticiones.push({ que: 'GET /conversations/:id/info', en: Date.now() }); return null; },
    };
  `,
  '@/store/useEscribiendoEnBandejaStore': `
    const estado = { porConversacion: {}, miembros: {}, anotar() {}, quitar() {}, guardarMiembros() {}, quedarseCon() {} };
    export const useEscribiendoEnBandejaStore = Object.assign((sel) => sel(estado), { getState: () => estado });
  `,
};

/** `@/x` → el fichero de `SRC`, como lo resuelve Metro. */
function buscar(base: string): string {
  for (const candidato of [`${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidato)) return candidato;
  }
  throw new Error(`no se encuentra ${base} (.ts)`);
}

/**
 * CADA ESCENARIO CARGA SU PROPIA COPIA de los módulos: el número de escenario
 * viaja en la URL (`?e=`) y se hereda de padre a hijo. Así el estado de un
 * módulo (la portada de `contadores`, los oyentes) no pasa de uno a otro.
 */
function escenarioDe(url: string | undefined): string {
  if (!url) return '0';
  try {
    return new URL(url).searchParams.get('e') ?? '0';
  } catch {
    return '0';
  }
}

registerHooks({
  resolve(especificador, contexto, siguiente) {
    const e = escenarioDe(contexto.parentURL);
    if (Object.hasOwn(FALSOS, especificador)) {
      return { url: `falso:${encodeURIComponent(especificador)}?e=${e}`, shortCircuit: true };
    }
    if (especificador.startsWith('@/')) {
      const ruta = buscar(join(SRC, especificador.slice(2)));
      return { url: `${pathToFileURL(ruta).href}?e=${e}`, shortCircuit: true };
    }
    return siguiente(especificador, contexto);
  },
  load(url, contexto, siguiente) {
    if (url.startsWith('falso:')) {
      const nombre = decodeURIComponent(url.slice('falso:'.length).split('?')[0] ?? '');
      return { format: 'module', source: FALSOS[nombre], shortCircuit: true };
    }
    // Con la `?e=` detrás, Node no reconoce la extensión: se le dice.
    if (url.startsWith('file:') && new URL(url).pathname.endsWith('.ts')) {
      return siguiente(url, { ...contexto, format: 'module-typescript' });
    }
    return siguiente(url, contexto);
  },
});

function moduloDe(rel: string, e: number): string {
  return `${pathToFileURL(buscar(join(SRC, rel))).href}?e=${e}`;
}

/* ------------------------------------------------------------------------- */
/* EL SERVIDOR DE MENTIRA                                                    */
/* ------------------------------------------------------------------------- */

const YO = '00000000-0000-4000-8000-0000000000aa';
const ANA = '00000000-0000-4000-8000-0000000000bb';
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const GRUPO = id(1);
const DIRECTO = id(2);
const OTRO_DIRECTO = id(3);
const NUEVA = id(4);
const TEMA = id(5);

type MensajeDelServidor = { id: string; remitente: string; texto: string; en: number };
type ConversacionDelServidor = {
  id: string;
  nombre: string;
  esGrupo: boolean;
  miembros: number;
  /** El chat de un tema: existe, llegan sus mensajes, y no sale en la bandeja. */
  enLaBandeja: boolean;
  /** Si existe ya; una conversación que todavía no existe no se lista. */
  existe: boolean;
  mensajes: MensajeDelServidor[];
  leidoHasta: number;
  actividad: number;
};

/** Microsegundos → ISO con microsegundos, como los manda Postgres. */
function iso(micro: number): string {
  return `${new Date(Math.floor(micro / 1000)).toISOString().slice(0, 23)}${String(micro % 1000).padStart(3, '0')}+00:00`;
}

class Servidor {
  latenciaMs = 200;
  private conversaciones = new Map<string, ConversacionDelServidor>();
  private ultimo = 0;
  private siguienteMensaje = 1000;

  /** Un instante estrictamente creciente, en microsegundos. */
  private ahora(): number {
    this.ultimo = Math.max(this.ultimo + 1, Date.now() * 1000);
    return this.ultimo;
  }

  crear(c: Partial<ConversacionDelServidor> & { id: string }): void {
    this.conversaciones.set(c.id, {
      nombre: c.id,
      esGrupo: false,
      miembros: 2,
      enLaBandeja: true,
      existe: true,
      mensajes: [],
      leidoHasta: 0,
      actividad: this.ahora(),
      ...c,
    });
  }

  /** Guarda un mensaje y devuelve la fila que manda el tiempo real. */
  escribir(conversacionId: string, remitente: string, texto = 'hola') {
    const c = this.conversaciones.get(conversacionId);
    if (!c) throw new Error(`no existe ${conversacionId}`);
    c.existe = true;
    const en = this.ahora();
    const mensaje = { id: id((this.siguienteMensaje += 1)), remitente, texto, en };
    c.mensajes.push(mensaje);
    c.actividad = en;
    return {
      id: mensaje.id,
      conversation_id: conversacionId,
      sender_id: remitente,
      body: texto,
      created_at: iso(en),
    };
  }

  leer(conversacionId: string): void {
    const c = this.conversaciones.get(conversacionId);
    if (c) c.leidoHasta = this.ahora();
  }

  /** La regla de `lectura.py`: de otra persona y posterior a la última lectura. */
  private sinLeer(c: ConversacionDelServidor): number {
    return c.mensajes.filter((m) => m.remitente !== YO && m.en > c.leidoHasta).length;
  }

  private primeraPagina(): ConversacionDelServidor[] {
    return [...this.conversaciones.values()]
      .filter((c) => c.enLaBandeja && c.existe)
      .sort((a, b) => b.actividad - a.actividad)
      .slice(0, 20);
  }

  /** `GET /conversations?grouped=true`, ya pasado por `toConversation`. */
  portada() {
    return this.primeraPagina().map((c) => {
      const ultimo = c.mensajes.at(-1);
      const sinLeer = this.sinLeer(c);
      return {
        id: c.id,
        name: c.nombre,
        esGrupo: c.esGrupo,
        subtitle: ultimo ? ultimo.texto : 'Sin mensajes aún',
        unread: sinLeer,
        silenciada: false,
        messages: [],
        time: ultimo ? iso(ultimo.en).slice(11, 16) : '',
        otherId: c.esGrupo ? undefined : ANA,
        labels: [],
        temas: 0,
        comunidades: 0,
        totalSinLeer: sinLeer,
        ultimoMensajeEn: ultimo ? iso(ultimo.en) : null,
        miembros: c.esGrupo ? c.miembros : undefined,
      };
    });
  }

  /** Lo que tiene que decir el globo de la pestaña. */
  globoDeMensajes(): number {
    return this.primeraPagina().reduce((suma, c) => suma + this.sinLeer(c), 0);
  }

  mitadDelViaje(): Promise<void> {
    return new Promise((listo) => setTimeout(listo, this.latenciaMs / 2));
  }

  viaje(): Promise<void> {
    return new Promise((listo) => setTimeout(listo, this.latenciaMs));
  }
}

/* ------------------------------------------------------------------------- */
/* EL TELÉFONO                                                               */
/* ------------------------------------------------------------------------- */

type Peticion = { que: string; en: number };
type Trafico = {
  yo: string;
  appState: string;
  peticiones: Peticion[];
  avisos: unknown[];
  limpiezas: (() => void)[];
  canal: { alInsertar?: (payload: { new: unknown }) => void; alEstado?: (estado: string) => void };
  contadores: { notificaciones: number; mensajes: number };
  canalesDeEscritura: Set<string>;
  servidor: Servidor;
  alCambiarAppState?: (estado: string) => void;
  oyenteDelPush?: (notificacion: unknown) => void;
};

declare global {
  // eslint-disable-next-line no-var
  var __T: Trafico;
}

const INICIO = Date.parse('2026-10-28T10:00:00.000Z');
let escenarios = 0;
const azarDeVerdad = Math.random;

/** Deja correr las promesas pendientes (el reloj está quieto). */
async function vaciar(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise((listo) => setImmediate(listo));
}

/** Adelanta el reloj de 50 en 50 ms, dejando correr lo que se despierte. */
async function avanzar(ms: number): Promise<void> {
  let falta = ms;
  while (falta > 0) {
    const paso = Math.min(50, falta);
    mock.timers.tick(paso);
    falta -= paso;
    await vaciar();
  }
}

type Telefono = {
  T: Trafico;
  servidor: Servidor;
  contadores: { marcarConversacionLeida: (id: string) => Promise<boolean> };
  loQueSeVe: { marcarConversacionALaVista: (id: string | null) => void };
  /** Llega un mensaje por tiempo real (ya guardado en el servidor). */
  llega: (fila: ReturnType<Servidor['escribir']>) => void;
  /** Llega el push de ese mensaje, con la aplicación abierta. */
  pushDe: (fila: ReturnType<Servidor['escribir']>) => void;
  /** Peticiones a la API desde un instante, sin contar las del propio chat. */
  desde: (instante: number) => Peticion[];
  desmontar: () => void;
};

async function encender(preparar: (servidor: Servidor) => void): Promise<Telefono> {
  escenarios += 1;
  const e = escenarios;
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: INICIO });
  // La dispersión de la recarga de seguridad, en su punto medio: las cuentas
  // tienen que salir iguales en cada pasada.
  Math.random = () => 0.5;
  const servidor = new Servidor();
  preparar(servidor);
  const T: Trafico = {
    yo: YO,
    appState: 'active',
    peticiones: [],
    avisos: [],
    limpiezas: [],
    canal: {},
    contadores: { notificaciones: 0, mensajes: 0 },
    canalesDeEscritura: new Set(),
    servidor,
  };
  globalThis.__T = T;

  const vivo = await import(moduloDe('hooks/useAvisosEnVivo', e));
  const push = await import(moduloDe('hooks/useAvisosDelPush.native', e));
  const contadores = await import(moduloDe('services/contadores', e));
  const loQueSeVe = await import(moduloDe('lib/loQueSeVe', e));
  vivo.useAvisosEnVivo();
  push.useAvisosDelPush();
  // El arranque: quién soy, la primera lectura de todo y el canal dentro.
  await avanzar(3_000);

  let apagado = false;
  const telefono: Telefono = {
    T,
    servidor,
    contadores,
    loQueSeVe,
    llega: (fila) => T.canal.alInsertar?.({ new: fila }),
    pushDe: (fila) =>
      T.oyenteDelPush?.({
        request: {
          content: {
            title: 'Ana',
            body: 'Ana envió un mensaje',
            data: { type: 'message', conversationId: fila.conversation_id, messageId: fila.id },
          },
        },
      }),
    desde: (instante) =>
      T.peticiones.filter((p) => p.en >= instante && p.que !== 'POST /conversations/:id/read'),
    desmontar: () => {
      if (apagado) return;
      apagado = true;
      encendido = null;
      for (const limpiar of T.limpiezas.splice(0)) limpiar();
      mock.timers.reset();
      Math.random = azarDeVerdad;
    },
  };
  encendido = telefono;
  return telefono;
}

/** El que está encendido: si una prueba falla a medias, se apaga igual. */
let encendido: Telefono | null = null;

afterEach(() => {
  encendido?.desmontar();
});

after(() => {
  Math.random = azarDeVerdad;
});

/** La bandeja típica: el grupo grande arriba y unos cuantos chats de dos. */
function bandejaTipica(servidor: Servidor): void {
  servidor.crear({ id: DIRECTO, nombre: 'Beto' });
  servidor.escribir(DIRECTO, ANA, 'hola');
  servidor.crear({ id: OTRO_DIRECTO, nombre: 'Carla' });
  servidor.escribir(OTRO_DIRECTO, YO, 'ok');
  servidor.crear({ id: GRUPO, nombre: 'Aula', esGrupo: true, miembros: 200 });
  servidor.escribir(GRUPO, YO, 'buenas');
}

const contar = (peticiones: Peticion[]) => ({
  bandeja: peticiones.filter((p) => p.que === 'GET /conversations').length,
  avisos: peticiones.filter((p) => p.que.startsWith('GET /notifications')).length,
});

/* ------------------------------------------------------------------------- */
/* LA MEDIDA                                                                 */
/* ------------------------------------------------------------------------- */

type Medida = {
  bandeja: number;
  avisos: number;
  total: number;
  /** El globo de la pestaña decía lo mismo que el servidor justo al llegar cada mensaje. */
  globoAlInstante: boolean;
  /** Y al final, con todo asentado. */
  globoAlFinal: boolean;
};

/**
 * Un teléfono con la aplicación abierta recibe `cuantos` mensajes de un grupo,
 * uno cada `cada` ms, con su push un segundo después. Se cuenta lo que pide a
 * la API desde el primer mensaje hasta 40 s después del último (lo que tarda
 * como mucho la recarga de seguridad), MENOS lo que habría pedido igual sin
 * ningún mensaje en ese tiempo (la vuelta de los avisos cada 30 s).
 */
async function medir(
  cuantos: number,
  cada: number,
  { dentroDelChat = false }: { dentroDelChat?: boolean } = {},
): Promise<Medida> {
  const duracion = cuantos * cada + 40_000;

  const sinMensajes = await encender(bandejaTipica);
  const base = Date.now();
  await avanzar(duracion);
  const linea = contar(sinMensajes.desde(base));
  sinMensajes.desmontar();

  const telefono = await encender(bandejaTipica);
  if (dentroDelChat) telefono.loQueSeVe.marcarConversacionALaVista(GRUPO);
  const inicio = Date.now();
  let globoAlInstante = true;
  for (let i = 0; i < cuantos; i += 1) {
    const fila = telefono.servidor.escribir(GRUPO, ANA, `mensaje ${i}`);
    telefono.llega(fila);
    // Con el chat delante, el chat lo marca leído al llegar (ChatScreen).
    if (dentroDelChat) void telefono.contadores.marcarConversacionLeida(GRUPO);
    await vaciar();
    if (!dentroDelChat && telefono.T.contadores.mensajes !== telefono.servidor.globoDeMensajes()) {
      globoAlInstante = false;
    }
    await avanzar(Math.min(1_000, cada));
    telefono.pushDe(fila);
    await avanzar(Math.max(0, cada - 1_000));
  }
  await avanzar(duracion - cuantos * cada);
  const conMensajes = contar(telefono.desde(inicio));
  const globoAlFinal = telefono.T.contadores.mensajes === telefono.servidor.globoDeMensajes();
  telefono.desmontar();

  const bandeja = conMensajes.bandeja - linea.bandeja;
  const avisos = conMensajes.avisos - linea.avisos;
  return { bandeja, avisos, total: bandeja + avisos, globoAlInstante, globoAlFinal };
}

describe('peticiones a la API por mensajes de un grupo, con la aplicación abierta', () => {
  const casos = [
    { cuantos: 1, cada: 3_000 },
    { cuantos: 10, cada: 200 },
    { cuantos: 10, cada: 3_000 },
    { cuantos: 50, cada: 200 },
    { cuantos: 50, cada: 3_000 },
  ];

  for (const { cuantos, cada } of casos) {
    it(`fuera del chat: ${cuantos} mensaje(s), uno cada ${cada} ms`, async (t) => {
      const medida = await medir(cuantos, cada);
      t.diagnostic(
        `${SOLO_MEDIR ? 'ANTES' : 'AHORA'} · fuera del chat · ${cuantos} × cada ${cada} ms → ` +
          `${medida.total} peticiones (${medida.bandeja} GET /conversations + ${medida.avisos} de avisos), ` +
          `${(medida.total / cuantos).toFixed(2)} por mensaje · globo al día al llegar cada mensaje: ` +
          `${medida.globoAlInstante ? 'sí' : 'no'} · al final: ${medida.globoAlFinal ? 'sí' : 'no'}`,
      );
      // Antes y ahora: al final, el globo dice lo que dice el servidor.
      assert.ok(medida.globoAlFinal);
      if (SOLO_MEDIR) return;
      // Ningún aviso de la campana por un mensaje de grupo: la API no escribe
      // avisos por mensajes, y las sesiones son de dos.
      assert.equal(medida.avisos, 0);
      // La bandeja: una recarga de seguridad cada 20–30 s como mucho.
      const ventanas = Math.ceil((cuantos * cada) / 20_000) + 1;
      assert.ok(medida.bandeja >= 1 && medida.bandeja <= ventanas, `${medida.bandeja} lecturas`);
      // Y el globo, exacto al instante: sin esperar a ninguna lectura.
      assert.ok(medida.globoAlInstante);
    });
  }

  it('dentro del chat del grupo (con su push en primer plano): 10 mensajes, uno cada 3 s', async (t) => {
    const medida = await medir(10, 3_000, { dentroDelChat: true });
    t.diagnostic(
      `${SOLO_MEDIR ? 'ANTES' : 'AHORA'} · dentro del chat · 10 × cada 3000 ms → ` +
        `${medida.total} peticiones (${medida.bandeja} GET /conversations + ${medida.avisos} de avisos), ` +
        'sin contar las del propio chat (marcar leído, que no cambia) · ' +
        `globo al final: ${medida.globoAlFinal ? 'sí' : 'no'}`,
    );
    assert.ok(medida.globoAlFinal);
    if (SOLO_MEDIR) return;
    assert.equal(medida.avisos, 0);
    assert.ok(medida.bandeja <= 3, `${medida.bandeja} lecturas`);
  });
});

/* ------------------------------------------------------------------------- */
/* LO QUE SÍ PREGUNTA, Y LO QUE SE CRUZA CON UNA PREGUNTA EN VUELO           */
/* ------------------------------------------------------------------------- */

describe('la bandeja pregunta solo cuando hace falta', { skip: SOLO_MEDIR }, () => {
  it('una conversación nueva: UNA lectura enseguida, y se anuncia con su nombre', async () => {
    const telefono = await encender((servidor) => {
      bandejaTipica(servidor);
      servidor.crear({ id: NUEVA, nombre: 'Dani', existe: false });
    });
    const inicio = Date.now();
    telefono.llega(telefono.servidor.escribir(NUEVA, ANA, '¿hablamos?'));
    await avanzar(1_500);
    assert.equal(contar(telefono.desde(inicio)).bandeja, 1);
    assert.ok(
      telefono.T.avisos.some((aviso) => (aviso as { titulo?: string }).titulo === 'Dani'),
      'no se anunció con su nombre',
    );
    assert.equal(telefono.T.contadores.mensajes, telefono.servidor.globoDeMensajes());
    telefono.desmontar();
  });

  it('el chat de un tema (no sale en la bandeja): se busca UNA vez; luego, solo la red de seguridad', async () => {
    const telefono = await encender((servidor) => {
      bandejaTipica(servidor);
      servidor.crear({ id: TEMA, nombre: 'Avisos', esGrupo: true, miembros: 200, enLaBandeja: false });
    });
    const inicio = Date.now();
    telefono.llega(telefono.servidor.escribir(TEMA, ANA, 'aviso 1'));
    await avanzar(1_500);
    assert.equal(contar(telefono.desde(inicio)).bandeja, 1, 'la primera vez se busca');
    const despues = Date.now();
    for (let i = 2; i <= 6; i += 1) {
      telefono.llega(telefono.servidor.escribir(TEMA, ANA, `aviso ${i}`));
      await avanzar(1_000);
    }
    // Ni una lectura por mensaje, ni preguntas a la campana: no es un chat de dos.
    assert.deepEqual(contar(telefono.desde(despues)), { bandeja: 0, avisos: 0 });
    await avanzar(30_000);
    assert.ok(contar(telefono.desde(despues)).bandeja <= 1);
    telefono.desmontar();
  });

  it('al reengancharse el canal se relee todo: lo que entró con él caído no llegó', async () => {
    const telefono = await encender(bandejaTipica);
    const inicio = Date.now();
    // Con el canal caído entra un mensaje que no llega por él.
    telefono.servidor.escribir(DIRECTO, ANA, 'mientras no estabas');
    telefono.T.canal.alEstado?.('SUBSCRIBED');
    await avanzar(1_000);
    assert.equal(contar(telefono.desde(inicio)).bandeja, 1);
    assert.equal(telefono.T.contadores.mensajes, telefono.servidor.globoDeMensajes());
    telefono.desmontar();
  });

  it('un push que el tiempo real no trajo hace preguntar, y el globo queda bien', async () => {
    const telefono = await encender(bandejaTipica);
    const inicio = Date.now();
    const fila = telefono.servidor.escribir(DIRECTO, ANA, 'solo por push');
    telefono.pushDe(fila);
    await avanzar(1_000);
    assert.equal(contar(telefono.desde(inicio)).bandeja, 1);
    assert.equal(telefono.T.contadores.mensajes, telefono.servidor.globoDeMensajes());
    // Y si después llega también por tiempo real, no se cuenta dos veces.
    telefono.llega(fila);
    await vaciar();
    assert.equal(telefono.T.contadores.mensajes, telefono.servidor.globoDeMensajes());
    telefono.desmontar();
  });

  it('la recarga de seguridad sale como mucho una vez cada 20 s, aunque no paren de llegar', async () => {
    const telefono = await encender(bandejaTipica);
    const inicio = Date.now();
    for (let i = 0; i < 90; i += 1) {
      telefono.llega(telefono.servidor.escribir(GRUPO, ANA, `m${i}`));
      await avanzar(1_000);
    }
    await avanzar(40_000);
    const lecturas = telefono.desde(inicio).filter((p) => p.que === 'GET /conversations');
    assert.ok(lecturas.length >= 3 && lecturas.length <= 5, `${lecturas.length} lecturas en 130 s`);
    for (let i = 1; i < lecturas.length; i += 1) {
      const hueco = (lecturas[i]?.en ?? 0) - (lecturas[i - 1]?.en ?? 0);
      assert.ok(hueco >= 20_000, `dos lecturas a ${hueco} ms`);
    }
    assert.equal(telefono.T.contadores.mensajes, telefono.servidor.globoDeMensajes());
    telefono.desmontar();
  });

  it('si mientras tanto ya se leyó la bandeja por otro motivo, la de seguridad no sale', async () => {
    const telefono = await encender(bandejaTipica);
    telefono.llega(telefono.servidor.escribir(GRUPO, ANA, 'hola'));
    await avanzar(2_000);
    // Se reengancha el canal: eso ya lee la bandeja, después del mensaje.
    telefono.T.canal.alEstado?.('SUBSCRIBED');
    const inicio = Date.now();
    await avanzar(40_000);
    assert.equal(contar(telefono.desde(inicio)).bandeja, 1);
    telefono.desmontar();
  });

  it('un mensaje propio sube la fila sin sumar; con el chat abierto tampoco suma', async () => {
    const telefono = await encender(bandejaTipica);
    const antes = telefono.T.contadores.mensajes;
    telefono.llega(telefono.servidor.escribir(GRUPO, YO, 'lo escribí yo, desde otro aparato'));
    await vaciar();
    assert.equal(telefono.T.contadores.mensajes, antes);
    telefono.loQueSeVe.marcarConversacionALaVista(OTRO_DIRECTO);
    telefono.llega(telefono.servidor.escribir(OTRO_DIRECTO, ANA, 'te veo'));
    await vaciar();
    assert.equal(telefono.T.contadores.mensajes, antes);
    telefono.desmontar();
  });
});

describe('lo que se cruza con una pregunta en vuelo', { skip: SOLO_MEDIR }, () => {
  it('un mensaje que entra mientras va y viene no se pierde ni se cuenta dos veces', async () => {
    const telefono = await encender(bandejaTipica);
    telefono.servidor.latenciaMs = 2_000;
    // Sale una lectura (la consulta se hace a mitad de viaje, a 1 s).
    telefono.T.canal.alEstado?.('SUBSCRIBED');
    await avanzar(200);
    // A: antes de la consulta, así que la respuesta ya lo trae.
    telefono.llega(telefono.servidor.escribir(DIRECTO, ANA, 'A'));
    await avanzar(1_300);
    // B: después de la consulta; la respuesta no lo trae.
    telefono.llega(telefono.servidor.escribir(DIRECTO, ANA, 'B'));
    await avanzar(700);
    // La respuesta ya llegó (a los 2 s): ni falta B ni A cuenta dos veces.
    assert.equal(telefono.T.contadores.mensajes, telefono.servidor.globoDeMensajes());
    telefono.desmontar();
  });

  it('leer mientras una pregunta va y viene no resucita el globo', async () => {
    const telefono = await encender(bandejaTipica);
    telefono.llega(telefono.servidor.escribir(DIRECTO, ANA, 'otro'));
    await vaciar();
    assert.ok(telefono.T.contadores.mensajes > 0);
    telefono.servidor.latenciaMs = 2_000;
    telefono.T.canal.alEstado?.('SUBSCRIBED');
    await avanzar(300);
    // Se abre el chat y se lee; el servidor lo anota DESPUÉS de la consulta.
    void telefono.contadores.marcarConversacionLeida(DIRECTO);
    await vaciar();
    assert.equal(telefono.T.contadores.mensajes, 0, 'leer no baja el globo al momento');
    await avanzar(2_500);
    // La respuesta traía la cuenta de antes de leer: no vuelve a salir.
    assert.equal(telefono.T.contadores.mensajes, 0);
    assert.equal(telefono.servidor.globoDeMensajes(), 0);
    telefono.desmontar();
  });

  it('dos mensajes que la base confirma al revés de su hora: lo arregla la red de seguridad', async () => {
    const telefono = await encender(bandejaTipica);
    const primero = telefono.servidor.escribir(GRUPO, ANA, 'primero');
    const segundo = telefono.servidor.escribir(GRUPO, ANA, 'segundo');
    // El segundo llega antes: el primero parece «ya contado».
    telefono.llega(segundo);
    telefono.llega(primero);
    await vaciar();
    assert.equal(telefono.T.contadores.mensajes, telefono.servidor.globoDeMensajes() - 1);
    // Es para esto la recarga de seguridad: como mucho en 30 s, bien.
    await avanzar(31_000);
    assert.equal(telefono.T.contadores.mensajes, telefono.servidor.globoDeMensajes());
    telefono.desmontar();
  });
});

/* ------------------------------------------------------------------------- */
/* «ESCRIBIENDO» EN LA BANDEJA                                               */
/* ------------------------------------------------------------------------- */

describe('canales de «escribiendo» que abre la bandeja', () => {
  it('con 5 grupos grandes y 5 chats de dos entre sus primeras conversaciones', async (t) => {
    escenarios += 1;
    const e = escenarios;
    const T = {
      peticiones: [],
      limpiezas: [],
      canalesDeEscritura: new Set<string>(),
    } as unknown as Trafico;
    globalThis.__T = T;
    const { useEscribiendoEnBandeja } = await import(moduloDe('hooks/useEscribiendoEnBandeja', e));
    const conversaciones = Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0
        ? { id: id(100 + i), name: `Grupo ${i}`, esGrupo: true, miembros: 300, subtitle: '', unread: 0, messages: [] }
        : { id: id(100 + i), name: `Chat ${i}`, esGrupo: false, otherId: ANA, subtitle: '', unread: 0, messages: [] },
    );
    useEscribiendoEnBandeja(conversaciones, YO, true);
    const abiertos = T.canalesDeEscritura.size;
    // Cada aviso de escritura cuesta en Supabase 1 + cada teléfono suscrito.
    // En un grupo de 300 que todos tienen arriba, el canal lo atienden las 300
    // bandejas (quien escribe no se recibe a sí mismo).
    const grande = conversaciones[0]?.id ?? '';
    const atiendeElGrande = T.canalesDeEscritura.has(grande);
    t.diagnostic(
      `${SOLO_MEDIR ? 'ANTES' : 'AHORA'} · canales de «escribiendo» abiertos por la bandeja: ${abiertos} ` +
        `· atiende el grupo de 300: ${atiendeElGrande ? 'sí' : 'no'} → cada aviso en ese grupo cuesta ` +
        (atiendeElGrande
          ? '1 + 299 entregas (los 299 demás lo tienen en su bandeja)'
          : '1 + quienes tengan ese chat ABIERTO'),
    );
    for (const limpiar of T.limpiezas.splice(0)) limpiar();
    assert.equal(T.canalesDeEscritura.size, 0, 'queda algún canal abierto al desmontar');
    if (SOLO_MEDIR) return;
    assert.equal(abiertos, 5);
    assert.ok(!atiendeElGrande);
  });
});
