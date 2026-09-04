/**
 * LA SALA DE VIDEO: el unico sitio por donde entrara el SDK nativo.
 *
 * POR QUE ESTE FICHERO EXISTE. Hoy no hay proveedor de directo instalado en la
 * aplicacion. El backend ya sabe repartir credenciales
 * (`POST /live/sessions/{id}/credential`), pero el paquete que de verdad
 * publica y reproduce video —100ms, LiveKit o el que se apruebe— todavia no
 * esta en `package.json`, y esa decision es del cliente, no del codigo.
 *
 * La forma barata de esperar seria dejar la pantalla sin nada y escribirlo todo
 * el dia que llegue el SDK. La forma que no obliga a rehacer nada es esta: se
 * fija AHORA el contrato que la pantalla va a consumir, se implementa una sala
 * FALSA que cumple ese contrato sin hacer nada, y el dia que entre el paquete
 * se escribe una segunda implementacion y se registra. Ni la pantalla ni la
 * maquina de estados se tocan.
 *
 * ASI SE ENCHUFA EL SDK, y no hay mas pasos:
 *
 *   // src/live/salaDeVideo100ms.ts  (fichero NUEVO, no existe todavia)
 *   import { HMSSDK } from '@100mslive/react-native-hms';
 *   export function crearSala100ms(): SalaDeVideo { ... }
 *
 *   // en el arranque de la aplicacion, UNA linea:
 *   registrarFabricaDeSala(crearSala100ms);
 *
 * NO IMPORTA NADA, a proposito. Ni React, ni React Native, ni el repositorio.
 * Es lo que permite ejecutarlo tal cual con `node --test` (ver
 * `salaDeVideo.test.mts`) y lo que garantiza que la implementacion falsa se
 * comprueba de verdad en vez de darse por buena.
 */

/* ------------------------------------------------------------------------- *
 * LA CREDENCIAL. Lo que responde el backend, ya leido y comprobado.
 * ------------------------------------------------------------------------- */

/** Los papeles que reparte el servidor. Lista cerrada. */
export const PAPELES_EN_SALA = ['host', 'moderator', 'guest', 'viewer'] as const;

export type PapelEnSala = (typeof PAPELES_EN_SALA)[number];

/**
 * La credencial de video, en el idioma de la aplicacion.
 *
 * `url` viaja aunque con 100ms llegue SIEMPRE vacia: la sala va dentro del
 * token. Se conserva porque otros proveedores (LiveKit, por ejemplo) si mandan
 * un servidor al que conectarse, y quitarla obligaria a cambiar el tipo —y con
 * el, la maquina y la pantalla— el dia que se cambie de proveedor.
 */
export type CredencialDeVideo = {
  /** `'100ms'`, `'none'`, o lo que diga el servidor. Nunca vacio. */
  proveedor: string;
  /** JWT corto. Vacio cuando el proveedor es `none`. */
  token: string;
  /** Servidor al que conectarse. Vacio en 100ms. */
  url: string;
  /** Segundos que dura el token. Sirve para saber cuando hay que renovarlo. */
  expiraEnSegundos: number;
  /** Si esta persona puede EMITIR. Lo decide el servidor, nunca la pantalla. */
  puedePublicar: boolean;
  papel: PapelEnSala;
  salaId: string;
};

/** Si un texto cualquiera es uno de los papeles que reparte el servidor. */
export function esPapelEnSala(valor: unknown): valor is PapelEnSala {
  return typeof valor === 'string' && (PAPELES_EN_SALA as readonly string[]).includes(valor);
}

function texto(valor: unknown, respaldo: string): string {
  return typeof valor === 'string' ? valor : respaldo;
}

/**
 * Lee la respuesta del servidor y devuelve `null` si no es una credencial.
 *
 * Devuelve `null` en vez de lanzar porque quien llama ya esta dentro de un
 * `try`/`catch` que clasifica errores HTTP, y un cuerpo malformado NO es un
 * error HTTP: es un 200 que no sirve. Distinguirlos importa, porque un 200 raro
 * se reintenta y un 503 de proveedor no.
 *
 * Lo unico OBLIGATORIO es `provider`: sin el no se sabe ni si hay video. El
 * resto tiene respaldo, y los respaldos son siempre los conservadores —sin
 * token, sin permiso de publicar, papel de espectador— para que un campo que
 * falte nunca conceda mas de lo que el servidor concedio.
 */
export function leerCredencial(bruto: unknown): CredencialDeVideo | null {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return null;
  const dto = bruto as Record<string, unknown>;

  const proveedor = typeof dto.provider === 'string' ? dto.provider.trim() : '';
  if (proveedor === '') return null;

  const expira = dto.expires_in;

  return {
    proveedor,
    token: texto(dto.token, ''),
    url: texto(dto.url, ''),
    expiraEnSegundos:
      typeof expira === 'number' && Number.isFinite(expira) && expira > 0 ? Math.floor(expira) : 0,
    // `=== true` y no `Boolean(...)`: un `can_publish` que llegue como la cadena
    // `"false"` es verdadero para `Boolean`, y eso pondria a emitir a alguien
    // que el servidor no ha autorizado.
    puedePublicar: dto.can_publish === true,
    papel: esPapelEnSala(dto.role) ? dto.role : 'viewer',
    salaId: texto(dto.room_id, ''),
  };
}

/**
 * Si esta credencial sirve para ver u oir algo.
 *
 * `provider: "none"` es la respuesta normal del backend con la bandera de
 * directo apagada: es un 200, no un error, y significa exactamente «no hay
 * video». Un token vacio dice lo mismo por otro camino.
 */
export function hayVideoEnLaCredencial(credencial: CredencialDeVideo): boolean {
  return credencial.proveedor !== 'none' && credencial.token !== '';
}

/* ------------------------------------------------------------------------- *
 * EL CONTRATO DE LA SALA.
 * ------------------------------------------------------------------------- */

/** Que esta encendido ahora mismo. */
export type EstadoDeMedios = {
  camara: boolean;
  microfono: boolean;
  /** Camara de delante (selfie) o de detras. */
  camaraFrontal: boolean;
  /** Si esta persona esta emitiendo su pista en este momento. */
  publicando: boolean;
};

/** Nada encendido. Es el estado de quien solo mira. */
export function mediosApagados(): EstadoDeMedios {
  return { camara: false, microfono: false, camaraFrontal: true, publicando: false };
}

/**
 * Lo que la sala cuenta hacia fuera.
 *
 * Es deliberadamente corto. Cada proveedor tiene decenas de eventos propios
 * (calidad por pista, cambios de rol, mensajes de la sala); traducirlos todos
 * aqui ataria la maquina de estados al SDK que se elija, que es justo lo que
 * este fichero evita. Solo cruzan los seis que cambian lo que se ve.
 */
export type EventoDeSala =
  | { tipo: 'conectado' }
  | { tipo: 'reconectando' }
  | { tipo: 'reconectado' }
  /** La conexion aguanta pero va mal. `buena: false` = imagen a trompicones. */
  | { tipo: 'calidad'; buena: boolean }
  | { tipo: 'medios'; medios: EstadoDeMedios }
  /**
   * Se acabo la conexion. `recuperable` decide si se vuelve a intentar: una
   * caida de red lo es; un token caducado o una expulsion, no.
   */
  | { tipo: 'desconectado'; recuperable: boolean; motivo?: string };

/**
 * La sala de video.
 *
 * TODOS los metodos son seguros de llamar sobre una sala ya destruida: la
 * pantalla se desmonta en cualquier momento —el telefono suena, alguien pulsa
 * Atras a mitad de la conexion— y una promesa que se resuelve despues no puede
 * acabar en una excepcion sin capturar.
 */
export interface SalaDeVideo {
  /** Quien la implementa. `'ninguno'` en la falsa. Solo para diagnostico. */
  readonly proveedor: string;
  /**
   * Entra en la sala. `publicar` decide si ademas se emite.
   *
   * Rechaza con `SalaNoDisponible` cuando no hay proveedor instalado.
   */
  unirse(credencial: CredencialDeVideo, opciones: { publicar: boolean }): Promise<void>;
  /** Sale de la sala. Nunca lanza: salir siempre tiene que poder ocurrir. */
  salir(): Promise<void>;
  /** Enciende o apaga la camara. Devuelve como quedaron los medios. */
  alternarCamara(encendida: boolean): Promise<EstadoDeMedios>;
  alternarMicrofono(encendido: boolean): Promise<EstadoDeMedios>;
  /** Delante <-> detras. */
  cambiarCamara(): Promise<EstadoDeMedios>;
  /** Lo que hay encendido ahora, sin preguntar al SDK. */
  medios(): EstadoDeMedios;
  /** Suscribe un oyente. Devuelve como quitarlo. */
  alOcurrir(oyente: (evento: EventoDeSala) => void): () => void;
  /**
   * Libera camara, microfono, oyentes y conexion. Idempotente.
   *
   * Es lo que impide que la camara se quede viva en segundo plano cuando la
   * pantalla se va: un `salir()` sin `destruir()` deja el motor del SDK cargado
   * y, en algunos telefonos, el piloto de la camara encendido.
   */
  destruir(): void;
}

/** Como se fabrica una sala. Es lo que se registra cuando llega el SDK. */
export type FabricaDeSala = () => SalaDeVideo;

/**
 * No hay proveedor de video instalado.
 *
 * Lleva `clase` para que quien la reciba pueda clasificarla igual que un fallo
 * HTTP, sin comparar el mensaje —que es texto y cambia— ni el nombre de la
 * clase, que el minificador puede reescribir.
 */
export class SalaNoDisponible extends Error {
  readonly clase = 'sin_proveedor' as const;

  constructor(mensaje = 'No hay proveedor de video instalado en esta version.') {
    super(mensaje);
    this.name = 'SalaNoDisponible';
  }
}

/** Si un error cualquiera es «no hay proveedor». */
export function esSalaNoDisponible(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { clase?: unknown }).clase === 'sin_proveedor'
  );
}

/* ------------------------------------------------------------------------- *
 * LA IMPLEMENTACION FALSA. La unica que existe hoy.
 * ------------------------------------------------------------------------- */

/**
 * Una sala que no hace nada y lo dice.
 *
 * NO ES UNA MAQUETA. La diferencia importa: una maqueta finge que funciona
 * —pinta un video de ejemplo, inventa espectadores— y esto hace lo contrario,
 * rechaza `unirse` con un error clasificado para que la pantalla acabe
 * diciendo «todavia no hay video». Es la misma regla que ya sigue el resto del
 * modulo de directos.
 *
 * Lo que si hace de verdad es la contabilidad: los oyentes se registran y se
 * quitan, `destruir` los borra todos, y despues de destruir nada vuelve a
 * emitir. Eso es lo que permite probar la limpieza al desmontar sin un SDK.
 */
export function crearSalaFalsa(): SalaDeVideo {
  let destruida = false;
  const oyentes = new Set<(evento: EventoDeSala) => void>();
  const estado = mediosApagados();

  const avisar = (evento: EventoDeSala): void => {
    if (destruida) return;
    // Copia: un oyente puede desuscribirse desde dentro del propio aviso.
    for (const oyente of [...oyentes]) oyente(evento);
  };

  return {
    proveedor: 'ninguno',

    unirse() {
      return Promise.reject(new SalaNoDisponible());
    },

    salir() {
      // Resuelve siempre: no haber entrado nunca no es un fallo al salir.
      return Promise.resolve();
    },

    alternarCamara() {
      // Sin proveedor no hay pista que encender. Se devuelve el estado real
      // —apagado— en vez de fingir que se encendio: un boton que se pinta
      // encendido sobre una camara muerta es peor que uno que no reacciona.
      return Promise.resolve({ ...estado });
    },

    alternarMicrofono() {
      return Promise.resolve({ ...estado });
    },

    cambiarCamara() {
      return Promise.resolve({ ...estado });
    },

    medios() {
      return { ...estado };
    },

    alOcurrir(oyente) {
      if (destruida) return () => {};
      oyentes.add(oyente);
      return () => {
        oyentes.delete(oyente);
      };
    },

    destruir() {
      destruida = true;
      oyentes.clear();
      // `avisar` queda mudo por `destruida`; se referencia aqui para que el
      // dia que la falsa emita algo no se olvide este corte.
      void avisar;
    },
  };
}

/* ------------------------------------------------------------------------- *
 * EL REGISTRO. Un solo punto de entrada para el SDK que venga.
 * ------------------------------------------------------------------------- */

let fabrica: FabricaDeSala | null = null;

/**
 * Registra la implementacion de verdad. Se llama UNA vez, en el arranque.
 *
 * Pasar `null` la retira y vuelve a la falsa; lo usan las pruebas y sirve
 * ademas para apagar el video sin desinstalar nada.
 */
export function registrarFabricaDeSala(nueva: FabricaDeSala | null): void {
  fabrica = nueva;
}

/** Si hay una implementacion de verdad registrada. */
export function hayProveedorDeVideo(): boolean {
  return fabrica !== null;
}

/** Fabrica una sala: la de verdad si la hay, la falsa si no. */
export function crearSalaDeVideo(): SalaDeVideo {
  return fabrica ? fabrica() : crearSalaFalsa();
}
