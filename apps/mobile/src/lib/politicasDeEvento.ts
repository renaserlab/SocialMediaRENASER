/**
 * Las condiciones de cambios y devoluciones que escribe QUIEN ORGANIZA.
 *
 * Es el espejo en el cliente de `politicas_del_organizador.py`, y lo es a
 * propósito: cada regla de aquí está copiada de una del servidor, con el mismo
 * código de error, para que la pantalla pueda decir lo que pasa ANTES de mandar
 * un formulario que va a volver rechazado. No es una validación distinta ni más
 * blanda: donde el servidor acepta, aquí se acepta.
 *
 * CINCO COSAS QUE NO SE PUEDEN CONFUNDIR, y que este módulo separa:
 *
 *   1. LO PUBLICADO NO SE EDITA. Lo impone un disparador de la 0069, no una
 *      convención. Para cambiar una regla se publica una VERSIÓN NUEVA, y por
 *      eso `accionesDePolitica` no ofrece «editar» sobre nada publicado ni
 *      superado. Un botón que acabaría en 409 `event_policy_not_editable` es
 *      una promesa rota, no un atajo.
 *
 *   2. SIN CONFIGURAR NO ES «NO SE DEVUELVE». `configurada: false` significa
 *      que quien organiza todavía no ha escrito sus condiciones. Decirlo como
 *      «no hay devolución» es inventarse una decisión que nadie ha tomado, y en
 *      la dirección que más perjudica a quien compró.
 *
 *   3. NINGÚN CAMPO NACE CON VALOR. `formularioVacio` devuelve cadenas vacías y
 *      `sinDecidir`, nunca un `0`, un `false` ni un plazo. Un formulario que
 *      precarga `refund_bps: 0` ha decidido que no se devuelve nada, y lo ha
 *      hecho por su cuenta. Por eso los booleanos son TERNARIOS: «sí», «no» y
 *      «todavía no lo he decidido» son tres respuestas, y la tercera no viaja.
 *
 *   4. PUBLICAR NO ES RETROACTIVO. Las compras anteriores guardan en
 *      `event_order_policy_acceptances` la versión y la huella que aceptaron.
 *      Publicar otra no las toca. La pantalla tiene que decirlo antes, no
 *      después.
 *
 *   5. CANCELAR EL EVENTO NO DEVUELVE DINERO. `cancelacion.py` deja
 *      `DEVOLUCION_TOTAL_OBLIGATORIA` en `None` —sin decidir— y hasta que la
 *      empresa conteste no se devuelve, no se rechaza y no se libera nada: se
 *      RETIENE y se abre un expediente por compra. `claveDeRegla` y
 *      `filasDelResultado` cuentan lo que el servidor hizo, y ni una palabra
 *      más: aquí no hay ningún plazo ni ninguna promesa de abono.
 *
 * Sin importaciones en tiempo de ejecución: el ejecutor de pruebas de Node no
 * resuelve el alias `@/`.
 */

/** Una clave del diccionario. La pantalla la convierte al traducir. */
export type ClaveDeTraduccion = string;

/* -------------------------------------------------------------------------- */
/* Lo que el servidor es                                                       */
/* -------------------------------------------------------------------------- */

/** Una política, tal como la manda `PoliticaRead`. */
export type Politica = {
  id: string;
  event_id: string | null;
  policy_type: string;
  version: string;
  /** `draft`, `published` o `superseded`. */
  status: string;
  params: Record<string, unknown>;
  /** El texto que lee quien compra. `null` = no se escribió ninguno. */
  body: string | null;
  /** La huella. Es lo que hace demostrable qué se publicó. */
  params_sha256: string;
  published_at: string | null;
  published_by: string | null;
  created_by: string | null;
  effective_from: string | null;
  effective_to: string | null;
  created_at: string;
};

/** `GET /events/{id}/policies`: todo lo del evento en una lectura. */
export type EstadoDeLasPoliticas = {
  event_id: string;
  /** Los tipos que puede decidir quien organiza. LOS MANDA EL SERVIDOR. */
  tipos: string[];
  /** `false` es SIN CONFIGURAR. No es «no hay devolución». */
  configurada: boolean;
  vigentes: Politica[];
  borradores: Politica[];
  historial: Politica[];
};

/** Una condición tal como la lee quien compra, sin huellas ni identificadores. */
export type Condicion = {
  policy_type: string;
  version: string;
  body: string | null;
  params: Record<string, unknown>;
};

/** `GET /events/{id}/policies/terms`: EXACTAMENTE lo que verá quien compra. */
export type Condiciones = {
  configurada: boolean;
  condiciones: Condicion[];
};

/**
 * Lo que contesta `POST /events/{id}/cancel`. NINGÚN IMPORTE SE MOVIÓ.
 *
 * El servidor manda además el `evento` actualizado; esta pantalla no lo usa
 * —vuelve a leerlo entero— y por eso no se escribe aquí un segundo molde del
 * evento que habría que mantener al día.
 */
export type ResultadoDeCancelacion = {
  /** `pending_business_decision`, `full_refund_required` o `policy_applies`. */
  regla: string;
  expedientes: number;
  saldos_bloqueados: number;
  sin_saldo: number;
  avisos: number;
};

/**
 * Los tipos que decide quien organiza. Los vuelve a mandar el servidor en
 * `tipos`, y se prefiere ESE: esto es el respaldo para pintar antes de leer.
 */
export const TIPOS_DEL_ORGANIZADOR = ['aftersale_eligibility', 'ticket_effect'] as const;
export type TipoDePolitica = (typeof TIPOS_DEL_ORGANIZADOR)[number];

/**
 * Las claves que deciden algo en cada tipo. Copiadas de `CLAVES_CON_SENTIDO`.
 *
 * No están todas las que la tabla admite: `reserve_bps`, `hold_days` y
 * `reserve_days` son CÓMO SE MUEVE EL DINERO DE LA PLATAFORMA, y quien organiza
 * no los decide sobre su propio cobro. El servidor contesta
 * `event_policy_type_not_allowed` a lo que no le corresponde, y esta lista es
 * la misma puerta un paso antes.
 */
export const CLAVES_CON_SENTIDO: Record<string, readonly string[]> = {
  aftersale_eligibility: [
    'window_hours_before_event',
    'days_after_event',
    'refund_bps',
    'cancelled_event_bps',
    'allow_buyer_cancellation',
    'allow_exchange',
  ],
  ticket_effect: [
    'revoke_on_refund',
    'revoke_on_partial_refund',
    'hold_on_dispute',
    'restore_on_rejected_refund',
  ],
};

/** Las cotas de `politicas.COTAS`, tal cual. Fuera de aquí no es «alto»: no existe. */
export const COTAS: Record<string, readonly [number, number]> = {
  refund_bps: [0, 10_000],
  cancelled_event_bps: [0, 10_000],
  reserve_bps: [0, 10_000],
  window_hours_before_event: [0, 24 * 365],
  hold_days: [0, 365],
  reserve_days: [0, 365],
  days_after_event: [0, 365],
};

/** `politicas.CLAVES_MAXIMAS`: una política es una decisión, no un almacén. */
export const CLAVES_MAXIMAS = 50;
/** `propias.LARGO_DEL_TEXTO`: ni un tuit ni un contrato entero. */
export const LARGO_DEL_TEXTO = 5_000;
/** `BorradorRequest.version`: `min_length=1, max_length=32`. */
export const LARGO_MAXIMO_DE_LA_VERSION = 32;
/** `MotivoObligatorio.motivo`: `min_length=1, max_length=1000`. */
export const LARGO_MAXIMO_DEL_MOTIVO = 1_000;

/** Los tres estados de la tabla. `superseded` SE LEE y no se toca. */
export const ESTADOS_DE_POLITICA = ['draft', 'published', 'superseded'] as const;

function conocido(valores: readonly string[], valor: string, prefijo: string): string {
  return valores.includes(valor) ? `${prefijo}.${valor}` : `${prefijo}.desconocido`;
}

/* -------------------------------------------------------------------------- */
/* Nombrar las cosas                                                           */
/* -------------------------------------------------------------------------- */

/** Todas las claves que quien organiza puede llegar a escribir. */
export const CLAVES_DEL_ORGANIZADOR: readonly string[] = TIPOS_DEL_ORGANIZADOR.flatMap(
  (tipo) => [...(CLAVES_CON_SENTIDO[tipo] ?? [])],
);

/** Si ese tipo lo decide quien organiza. */
export function esTipoDelOrganizador(tipo: string): boolean {
  return (TIPOS_DEL_ORGANIZADOR as readonly string[]).includes(tipo);
}

/** Las claves de ese tipo, en el orden en que se preguntan. Vacío si no es suyo. */
export function clavesDelTipo(tipo: string): readonly string[] {
  return CLAVES_CON_SENTIDO[tipo] ?? [];
}

/** Si esa clave lleva un número con cotas. */
export function esClaveNumerica(clave: string): boolean {
  return Object.prototype.hasOwnProperty.call(COTAS, clave);
}

/** Si esa clave del tipo es un sí/no. Lo que no es número, lo es. */
export function esClaveBooleana(tipo: string, clave: string): boolean {
  return clavesDelTipo(tipo).includes(clave) && !esClaveNumerica(clave);
}

/** La cota de esa clave, o `null` si no tiene ninguna. */
export function cotaDe(clave: string): readonly [number, number] | null {
  return COTAS[clave] ?? null;
}

export function claveDelTipo(tipo: string): ClaveDeTraduccion {
  return conocido([...TIPOS_DEL_ORGANIZADOR], tipo, 'politicasEvento.tipo');
}

export function claveDelCuerpoDelTipo(tipo: string): ClaveDeTraduccion {
  return conocido([...TIPOS_DEL_ORGANIZADOR], tipo, 'politicasEvento.tipoCuerpo');
}

export function claveDelEstado(estado: string): ClaveDeTraduccion {
  return conocido([...ESTADOS_DE_POLITICA], estado, 'politicasEvento.estado');
}

/** El nombre del parámetro. `days_after_event` no se le enseña a nadie. */
export function claveDelParametro(clave: string): ClaveDeTraduccion {
  return conocido(CLAVES_DEL_ORGANIZADOR, clave, 'politicasEvento.param');
}

/** Qué significa ese parámetro. Explica la unidad, no propone ningún valor. */
export function claveDeAyudaDelParametro(clave: string): ClaveDeTraduccion {
  return conocido(CLAVES_DEL_ORGANIZADOR, clave, 'politicasEvento.paramAyuda');
}

/* -------------------------------------------------------------------------- */
/* El formulario, que nace vacío                                               */
/* -------------------------------------------------------------------------- */

/**
 * Un sí/no que todavía puede no estar contestado.
 *
 * TRES RESPUESTAS, NO DOS. Una casilla sin marcar dice `false`, y `false` es
 * una decisión: «no se revoca la entrada». Quien no ha llegado a esa pregunta
 * no ha dicho eso. `sinDecidir` no viaja al servidor, y así la clave no aparece
 * en `params` —que es justo lo que significa no haberlo decidido—.
 */
export type Ternario = 'sinDecidir' | 'si' | 'no';

/** Lo que hay escrito en la pantalla. Todo texto: el usuario escribe texto. */
export type Formulario = {
  version: string;
  texto: string;
  numeros: Record<string, string>;
  booleanos: Record<string, Ternario>;
};

/**
 * El formulario en blanco de ese tipo. SIN UN SOLO VALOR.
 *
 * Ni un cero, ni un `false`, ni una versión sugerida. Cada hueco que se
 * rellenara aquí sería una condición de venta decidida por la aplicación.
 */
export function formularioVacio(tipo: string): Formulario {
  const numeros: Record<string, string> = {};
  const booleanos: Record<string, Ternario> = {};
  for (const clave of clavesDelTipo(tipo)) {
    if (esClaveNumerica(clave)) numeros[clave] = '';
    else booleanos[clave] = 'sinDecidir';
  }
  return { version: '', texto: '', numeros, booleanos };
}

/** Lee un valor del servidor como ternario. Lo que no es booleano, no decide. */
function ternarioDe(valor: unknown): Ternario {
  if (valor === true) return 'si';
  if (valor === false) return 'no';
  return 'sinDecidir';
}

/**
 * El formulario cargado desde una política que ya existe.
 *
 * Lo que la política NO trae sigue vacío: rellenarlo con un valor de partida
 * cambiaría, al guardar, una condición que nadie tocó.
 */
export function formularioDesde(
  tipo: string,
  politica: { version: string; params: Record<string, unknown>; body: string | null },
): Formulario {
  const formulario = formularioVacio(tipo);
  formulario.version = politica.version ?? '';
  formulario.texto = politica.body ?? '';
  for (const clave of clavesDelTipo(tipo)) {
    const valor = politica.params?.[clave];
    if (esClaveNumerica(clave)) {
      formulario.numeros[clave] =
        typeof valor === 'number' && Number.isFinite(valor) ? String(valor) : '';
    } else {
      formulario.booleanos[clave] = ternarioDe(valor);
    }
  }
  return formulario;
}

/**
 * Los `params` que de verdad se mandan. SOLO LO ESCRITO.
 *
 * Un campo vacío no viaja, y un ternario `sinDecidir` tampoco: la ausencia de
 * la clave ES la respuesta «no lo he decidido», y el servidor la entiende así
 * (`clave in params`). Lo que no se puede leer como número se devuelve en
 * `fallos` con el mismo código con el que el servidor lo rechazaría.
 */
export function paramsDesdeFormulario(
  tipo: string,
  formulario: Formulario,
): { params: Record<string, unknown>; fallos: Fallo[] } {
  const params: Record<string, unknown> = {};
  const fallos: Fallo[] = [];
  for (const clave of clavesDelTipo(tipo)) {
    if (esClaveNumerica(clave)) {
      const escrito = (formulario.numeros[clave] ?? '').trim();
      if (escrito === '') continue;
      const valor = Number(escrito.replace(',', '.'));
      if (escrito !== '' && !Number.isFinite(valor)) {
        fallos.push({ campo: clave, codigo: 'event_policy_param_not_a_number' });
        continue;
      }
      params[clave] = valor;
    } else {
      const dicho = formulario.booleanos[clave] ?? 'sinDecidir';
      if (dicho === 'sinDecidir') continue;
      params[clave] = dicho === 'si';
    }
  }
  return { params, fallos: [...fallos, ...validarParametros(params)] };
}

/* -------------------------------------------------------------------------- */
/* Lo que el servidor rechazaría, dicho antes                                  */
/* -------------------------------------------------------------------------- */

/**
 * Un motivo por el que esto no se puede mandar todavía.
 *
 * `codigo` es el del servidor siempre que exista, para que el mismo mensaje
 * sirva en los dos caminos. Los dos que NO son del servidor —le falta la
 * versión, la versión es demasiado larga— los rechaza Pydantic con un 422 sin
 * código, y se marcan aquí para poder decir cuál de los dos es.
 */
export type Fallo = {
  /** La clave del parámetro, o `version`, `texto` o `politica`. */
  campo: string;
  codigo: string;
  min?: number;
  max?: number;
  /** Las claves implicadas en una contradicción, o las esperadas en una vacía. */
  claves?: string[];
};

/** Códigos que NO vienen del servidor: aquí se distinguen, allí son un 422. */
export const CODIGOS_LOCALES = [
  'event_policy_version_missing',
  'event_policy_version_too_long',
] as const;

/**
 * El espejo exacto de `politicas._exigir_parametros_sensatos`.
 *
 * Un booleano NO es un número, igual que allí (`isinstance(valor, bool)` se
 * comprueba primero); y la cota se mira sobre el entero truncado, como hace
 * `int(valor)`. Coincidir importa más que ser estricto: rechazar aquí algo que
 * el servidor acepta sería inventarse una regla.
 */
export function validarParametros(params: Record<string, unknown>): Fallo[] {
  const fallos: Fallo[] = [];
  if (Object.keys(params).length > CLAVES_MAXIMAS) {
    fallos.push({ campo: 'politica', codigo: 'event_policy_params_too_many' });
  }
  for (const clave of Object.keys(COTAS)) {
    if (!Object.prototype.hasOwnProperty.call(params, clave)) continue;
    const cota = COTAS[clave];
    if (cota === undefined) continue;
    const [minimo, maximo] = cota;
    const valor = params[clave];
    if (typeof valor === 'boolean' || typeof valor !== 'number' || !Number.isFinite(valor)) {
      fallos.push({ campo: clave, codigo: 'event_policy_param_not_a_number' });
      continue;
    }
    const entero = Math.trunc(valor);
    if (entero < minimo || entero > maximo) {
      fallos.push({
        campo: clave,
        codigo: 'event_policy_param_out_of_range',
        min: minimo,
        max: maximo,
      });
    }
  }
  return fallos;
}

/**
 * El espejo exacto de `_validar_contradicciones`, y en el mismo orden.
 *
 * No opina sobre el negocio: un plazo corto o un porcentaje bajo los decide
 * quien organiza. Lo que se detecta es lo que no puede significar nada, porque
 * publicado dejaría a quien compra leyendo una promesa que el código no cumple.
 */
export function detectarContradicciones(
  tipo: string,
  params: Record<string, unknown>,
): Fallo[] {
  const fallos: Fallo[] = [];

  // Revocar en la parcial y no en la total: lo menos implicaría lo más.
  if (params.revoke_on_partial_refund === true && params.revoke_on_refund !== true) {
    fallos.push({
      campo: 'revoke_on_partial_refund',
      codigo: 'event_policy_contradictory',
      claves: ['revoke_on_partial_refund', 'revoke_on_refund'],
    });
  }

  // Permitir cancelar sin decir hasta cuándo.
  if (params.allow_buyer_cancellation === true) {
    const ventana = params.window_hours_before_event;
    const plazo = params.days_after_event;
    if ((ventana === undefined || ventana === null) && (plazo === undefined || plazo === null)) {
      fallos.push({
        campo: 'allow_buyer_cancellation',
        codigo: 'event_policy_contradictory',
        claves: ['window_hours_before_event', 'days_after_event'],
      });
    }
  }

  // Y una que no habilita nada pero se publica como si habilitara.
  const conSentido = clavesDelTipo(tipo);
  if (
    conSentido.length > 0 &&
    !conSentido.some((clave) => Object.prototype.hasOwnProperty.call(params, clave))
  ) {
    fallos.push({
      campo: 'politica',
      codigo: 'event_policy_empty',
      claves: [...conSentido],
    });
  }

  return fallos;
}

/** La versión lista para viajar, o `null` si no hay ninguna escrita. */
export function versionUtil(texto: string | null | undefined): string | null {
  const limpio = (texto ?? '').trim();
  return limpio === '' ? null : limpio;
}

/** El texto de la política listo para viajar. Vacío es `null`, como en el servidor. */
export function textoUtil(texto: string | null | undefined): string | null {
  const limpio = (texto ?? '').trim();
  return limpio === '' ? null : limpio;
}

/**
 * Lo que impide GUARDAR el borrador.
 *
 * Un borrador a medias es lo normal mientras se escribe: aquí NO se miran las
 * contradicciones, exactamente igual que en `guardar_borrador`. Sí las cotas,
 * porque un `refund_bps` de nueve millones no es «a medias».
 */
export function validarBorrador(
  tipo: string,
  formulario: Formulario,
  params: Record<string, unknown>,
): Fallo[] {
  const fallos: Fallo[] = [];
  if (!esTipoDelOrganizador(tipo)) {
    fallos.push({ campo: 'politica', codigo: 'event_policy_type_not_allowed' });
  }
  const version = versionUtil(formulario.version);
  if (version === null) {
    fallos.push({ campo: 'version', codigo: 'event_policy_version_missing' });
  } else if (version.length > LARGO_MAXIMO_DE_LA_VERSION) {
    fallos.push({
      campo: 'version',
      codigo: 'event_policy_version_too_long',
      max: LARGO_MAXIMO_DE_LA_VERSION,
    });
  }
  const texto = textoUtil(formulario.texto);
  if (texto !== null && texto.length > LARGO_DEL_TEXTO) {
    fallos.push({ campo: 'texto', codigo: 'event_policy_body_too_long', max: LARGO_DEL_TEXTO });
  }
  return [...fallos, ...validarParametros(params)];
}

/**
 * Lo que impide PUBLICAR, que es cuando alguien va a leerlo.
 *
 * Todo lo del borrador, más las contradicciones y la política que no dice
 * nada: ni parámetros ni texto. `vigente` es la publicada de ese tipo, para
 * adelantar el `event_policy_version_taken` que el servidor da cuando la
 * versión coincide con la que ya está.
 */
export function validarPublicacion(
  tipo: string,
  formulario: Formulario,
  params: Record<string, unknown>,
  vigente?: Politica | null,
): Fallo[] {
  const fallos = [
    ...validarBorrador(tipo, formulario, params),
    ...detectarContradicciones(tipo, params),
  ];
  const texto = textoUtil(formulario.texto);
  const vacia = Object.keys(params).length === 0 && texto === null;
  if (vacia && !fallos.some((f) => f.codigo === 'event_policy_empty')) {
    fallos.push({ campo: 'politica', codigo: 'event_policy_empty' });
  }
  // La misma comprobación del servidor, ni una más: compara con LA VIGENTE.
  const version = versionUtil(formulario.version);
  if (vigente && version !== null && vigente.version === version) {
    fallos.push({ campo: 'version', codigo: 'event_policy_version_taken' });
  }
  return fallos;
}

/** Si con lo que hay escrito se puede publicar. */
export function sePuedePublicar(
  tipo: string,
  formulario: Formulario,
  params: Record<string, unknown>,
  vigente?: Politica | null,
): boolean {
  return validarPublicacion(tipo, formulario, params, vigente).length === 0;
}

/* -------------------------------------------------------------------------- */
/* Qué se puede hacer con cada política                                        */
/* -------------------------------------------------------------------------- */

/** Los cuatro verbos. `editar` es SOLO del borrador. */
export const ACCIONES_DE_POLITICA = [
  'editar',
  'publicar',
  'descartar',
  'nuevaVersion',
] as const;
export type AccionDePolitica = (typeof ACCIONES_DE_POLITICA)[number];

/**
 * Lo que se le ofrece según el estado. UNA PUBLICADA NUNCA SE EDITA.
 *
 * El disparador de la 0069 solo admite el paso a `superseded` sobre una fila
 * publicada; cualquier otro `UPDATE` revienta. Ofrecer «editar» sobre una
 * publicada o una superada sería pintar un botón que no puede funcionar, y
 * además haría creer que lo que ya aceptaron unas compras se puede reescribir.
 * Lo que se ofrece es sacar una VERSIÓN NUEVA a partir de la vigente.
 *
 * El historial (`superseded`) no ofrece nada: se lee.
 */
export function accionesDePolitica(estado: string): AccionDePolitica[] {
  if (estado === 'draft') return ['editar', 'publicar', 'descartar'];
  if (estado === 'published') return ['nuevaVersion'];
  return [];
}

/** Si esa política se puede tocar. Solo el borrador. */
export function sePuedeEditar(estado: string): boolean {
  return accionesDePolitica(estado).includes('editar');
}

/** El texto del botón de cada acción. */
export function claveDeAccion(accion: string): ClaveDeTraduccion {
  return conocido([...ACCIONES_DE_POLITICA], accion, 'politicasEvento.accion');
}

/**
 * El borrador que nace de la vigente, para sacar otra versión.
 *
 * COPIA los parámetros y el texto —es el punto de partida honesto: cambiar una
 * condición no es reescribirlas todas— y DEJA LA VERSIÓN VACÍA, porque el
 * nombre de la versión nueva lo pone quien organiza. Inventar «v2» o «1.1»
 * sería ponerle a su documento un nombre que no eligió, y coincidir con la
 * vigente devuelve `event_policy_version_taken`.
 */
export function borradorDesdeLaVigente(vigente: Politica): Formulario {
  const formulario = formularioDesde(vigente.policy_type, {
    version: '',
    params: { ...(vigente.params ?? {}) },
    body: vigente.body,
  });
  return formulario;
}

/** La vigente de ese tipo dentro de lo que mandó el servidor, o `null`. */
export function vigenteDelTipo(estado: EstadoDeLasPoliticas, tipo: string): Politica | null {
  return estado.vigentes.find((p) => p.policy_type === tipo) ?? null;
}

/** El borrador vivo de ese tipo, o `null`. Uno como mucho. */
export function borradorDelTipo(estado: EstadoDeLasPoliticas, tipo: string): Politica | null {
  return estado.borradores.find((p) => p.policy_type === tipo) ?? null;
}

/** El historial de ese tipo, lo más reciente primero. SE LEE, no se toca. */
export function historialDelTipo(estado: EstadoDeLasPoliticas, tipo: string): Politica[] {
  return estado.historial.filter((p) => p.policy_type === tipo);
}

/** Los tipos que el servidor deja decidir, y solo esos. */
export function tiposOfrecidos(estado: EstadoDeLasPoliticas | null): string[] {
  const dice = estado?.tipos ?? [];
  return dice.filter((tipo) => esTipoDelOrganizador(tipo));
}

/* -------------------------------------------------------------------------- */
/* Cómo se cuenta que no hay nada escrito                                      */
/* -------------------------------------------------------------------------- */

/** Sin condiciones, a medias o con todas. NINGUNA ES «no se devuelve». */
export type EstadoDeConfiguracion = 'sinConfigurar' | 'aMedias' | 'completa';

/** Los tipos que todavía no tienen una publicada. */
export function tiposSinVigente(estado: EstadoDeLasPoliticas): string[] {
  const publicados = new Set(estado.vigentes.map((p) => p.policy_type));
  return tiposOfrecidos(estado).filter((tipo) => !publicados.has(tipo));
}

/** En qué punto está la configuración del evento. */
export function estadoDeConfiguracion(estado: EstadoDeLasPoliticas): EstadoDeConfiguracion {
  if (estado.vigentes.length === 0) return 'sinConfigurar';
  return tiposSinVigente(estado).length === 0 ? 'completa' : 'aMedias';
}

/**
 * El titular del resumen.
 *
 * `sinConfigurar` se dice «todavía no has definido tus condiciones». NUNCA «no
 * se devuelve»: eso sería contestar por quien organiza, y además el servidor
 * cae a la política global para decidir, así que ni siquiera sería cierto.
 */
export function claveDelResumen(punto: EstadoDeConfiguracion): ClaveDeTraduccion {
  return `politicasEvento.resumen.${punto}`;
}

export function claveDelCuerpoDelResumen(punto: EstadoDeConfiguracion): ClaveDeTraduccion {
  return `politicasEvento.resumenCuerpo.${punto}`;
}

/* -------------------------------------------------------------------------- */
/* La previsualización: literal                                                */
/* -------------------------------------------------------------------------- */

/**
 * Los parámetros de una condición, en crudo y ordenados.
 *
 * SE ENSEÑAN COMO SON. Traducir `refund_bps: 5000` a «se devuelve el 50 %»
 * sería reconstruir la promesa con palabras nuestras, y la promesa es la del
 * servidor: lo que `/terms` manda es lo que verá quien compra. El editor sí
 * pone nombres legibles; la previsualización, no.
 */
export function paresDeParametros(params: Record<string, unknown>): Array<[string, string]> {
  return Object.keys(params ?? {})
    .sort()
    .map((clave) => [clave, valorLiteral(params[clave])] as [string, string]);
}

/** Un valor tal como es. Sin interpretarlo. */
export function valorLiteral(valor: unknown): string {
  if (valor === null) return 'null';
  if (valor === undefined) return '';
  if (typeof valor === 'string') return valor;
  if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor);
  try {
    return JSON.stringify(valor);
  } catch {
    return '';
  }
}

/**
 * Si la previsualización tiene algo que enseñar.
 *
 * `configurada: false` con la lista vacía no es un error ni un hueco: es que
 * todavía no hay condiciones escritas, y se dice así.
 */
export function hayCondiciones(condiciones: Condiciones | null): boolean {
  return (condiciones?.condiciones.length ?? 0) > 0;
}

/* -------------------------------------------------------------------------- */
/* Cancelar el evento                                                          */
/* -------------------------------------------------------------------------- */

/** Las tres respuestas posibles de `cancelacion.regla_vigente()`. */
export const REGLAS_DE_CANCELACION = [
  'pending_business_decision',
  'full_refund_required',
  'policy_applies',
] as const;

/** El titular de la regla que se aplicó. */
export function claveDeRegla(regla: string): ClaveDeTraduccion {
  return conocido([...REGLAS_DE_CANCELACION], regla, 'politicasEvento.regla');
}

/** Qué significa esa regla. Sin plazos y sin prometer ningún abono. */
export function claveDelCuerpoDeLaRegla(regla: string): ClaveDeTraduccion {
  return conocido([...REGLAS_DE_CANCELACION], regla, 'politicasEvento.reglaCuerpo');
}

/** El motivo listo para viajar, recortado a lo que el servidor admite. */
export function motivoDeCancelacionUtil(texto: string | null | undefined): string | null {
  const limpio = (texto ?? '').trim();
  if (limpio === '') return null;
  return limpio.slice(0, LARGO_MAXIMO_DEL_MOTIVO);
}

/**
 * Lo que el servidor dice que hizo, contado tal cual.
 *
 * CUATRO CONTADORES Y NINGUNA CONCLUSIÓN. No hay una fila de «devuelto» porque
 * no se devolvió nada: se abrieron expedientes y se retuvo saldo. `sin_saldo`
 * son los pedidos pagados que no tenían nada que retener, y no es un fallo.
 */
export function filasDelResultado(
  resultado: ResultadoDeCancelacion,
): Array<{ clave: ClaveDeTraduccion; valor: number }> {
  return [
    { clave: 'politicasEvento.cancelar.expedientes', valor: resultado.expedientes },
    { clave: 'politicasEvento.cancelar.saldosBloqueados', valor: resultado.saldos_bloqueados },
    { clave: 'politicasEvento.cancelar.sinSaldo', valor: resultado.sin_saldo },
    { clave: 'politicasEvento.cancelar.avisos', valor: resultado.avisos },
  ];
}

/* -------------------------------------------------------------------------- */
/* Cuando algo sale mal                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Los códigos de esta pantalla, traducidos.
 *
 * `null` es «no lo conozco»: entonces se usa el mensaje del servidor, que en
 * español es correcto. Inventar un texto genérico taparía uno mejor.
 */
export function claveDeErrorDePolitica(
  codigo: string | null | undefined,
): ClaveDeTraduccion | null {
  const conocidos: Record<string, string> = {
    event_policy_empty: 'politicasEvento.error.vacia',
    event_policy_contradictory: 'politicasEvento.error.contradictoria',
    event_policy_param_out_of_range: 'politicasEvento.error.fueraDeRango',
    event_policy_param_not_a_number: 'politicasEvento.error.noEsNumero',
    event_policy_params_too_many: 'politicasEvento.error.demasiadosParametros',
    event_policy_params_invalid: 'politicasEvento.error.parametrosInvalidos',
    event_policy_body_too_long: 'politicasEvento.error.textoLargo',
    event_policy_type_not_allowed: 'politicasEvento.error.tipoNoPermitido',
    event_policy_not_editable: 'politicasEvento.error.noEditable',
    event_policy_version_taken: 'politicasEvento.error.versionTomada',
    event_policy_not_found: 'politicasEvento.error.noEncontrada',
    event_policies_not_available: 'politicasEvento.error.noDisponible',
    event_policy_version_missing: 'politicasEvento.error.faltaVersion',
    event_policy_version_too_long: 'politicasEvento.error.versionLarga',
  };
  if (typeof codigo !== 'string') return null;
  return conocidos[codigo] ?? null;
}

/** El mensaje de un fallo local, que es el mismo que el del servidor. */
export function claveDeFallo(fallo: Fallo): ClaveDeTraduccion {
  return claveDeErrorDePolitica(fallo.codigo) ?? 'politicasEvento.error.desconocido';
}

/**
 * Si la función todavía no está desplegada.
 *
 * SON DOS CÓDIGOS, Y NO ES UN DESCUIDO NUESTRO: las rutas de políticas llaman a
 * `exigir_posventa`, que contesta `event_aftersale_not_available`, mientras que
 * `event_policies_not_available` está escrito en `exigir_aceptaciones`. Los dos
 * significan lo mismo para quien mira la pantalla, así que los dos se tratan
 * igual en vez de dejar uno sin mensaje.
 */
export function esPoliticasApagadas(codigo: string | null | undefined): boolean {
  return codigo === 'event_policies_not_available' || codigo === 'event_aftersale_not_available';
}

/** Lo que hay que enseñar según el estado HTTP, cuando no hay código mejor. */
export function claveDeErrorPorEstado(estado: number | null | undefined): ClaveDeTraduccion | null {
  if (estado === 401) return 'politicasEvento.error.sinSesion';
  if (estado === 403) return 'politicasEvento.error.sinPermiso';
  if (estado === 404) return 'politicasEvento.error.noEncontrado';
  if (estado === 409) return 'politicasEvento.error.conflicto';
  return null;
}

/**
 * Si esto se arregla recargando y volviendo a intentarlo.
 *
 * Un 409 aquí es «lo que tenías delante ya no es lo que hay»: otra sesión
 * publicó, o el borrador dejó de serlo. No es un error que mostrar y olvidar:
 * se recarga y se deja decidir otra vez sobre lo que hay ahora.
 */
export function hayQueRecargar(
  estado: number | null | undefined,
  codigo: string | null | undefined,
): boolean {
  return (
    estado === 409 ||
    codigo === 'event_policy_not_editable' ||
    codigo === 'event_policy_version_taken' ||
    codigo === 'event_policy_not_found'
  );
}

/* -------------------------------------------------------------------------- */
/* Formato                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * La versión tal como se enseña: la que se escribió, sin espacios sobrantes.
 *
 * NO LE PONE UNA «v» DELANTE ni la convierte en «1.0». El nombre de la versión
 * es de quien organiza y aparece en el recibo de quien compró; decorarlo haría
 * que la pantalla y el registro dijeran cosas distintas. Vacío devuelve vacío,
 * no «sin versión».
 */
export function etiquetaDeVersion(version: string | null | undefined): string {
  return (version ?? '').trim();
}

/** La fecha, en el idioma del sistema. Vacía si el servidor mandó algo raro. */
export function fechaLegible(iso: string | null | undefined): string {
  if (!iso) return '';
  const momento = new Date(iso);
  if (Number.isNaN(momento.getTime())) return '';
  return momento.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** La fecha y la hora, para el historial. Vacía si no se puede leer. */
export function momentoLegible(iso: string | null | undefined): string {
  if (!iso) return '';
  const momento = new Date(iso);
  if (Number.isNaN(momento.getTime())) return '';
  return `${momento.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })} · ${momento.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

/** Cuándo dejó de regir una política superada. Vacío mientras rige. */
export function vigenciaLegible(politica: Politica): string {
  const desde = fechaLegible(politica.effective_from ?? politica.published_at);
  const hasta = fechaLegible(politica.effective_to);
  if (desde === '' && hasta === '') return '';
  return hasta === '' ? desde : `${desde} — ${hasta}`;
}
