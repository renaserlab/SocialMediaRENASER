/**
 * LAS BURBUJAS: que reacciones se PINTAN, y cuando.
 *
 * No es lo mismo que cuantas se han puesto. En un directo con audiencia llegan
 * mas reacciones por segundo de las que una pantalla puede animar sin perder
 * fotogramas, y de las que nadie puede ver. Lo que se pinta es una MUESTRA; el
 * contador, que va aparte, lleva la cuenta entera.
 *
 * LAS TRES REGLAS:
 *
 * 1. **La propia, ya.** Quien pulsa ve su burbuja en el mismo gesto, aunque la
 *    pista este llena: se le hace sitio quitando la mas vieja.
 * 2. **Las ajenas, por turnos.** Entran unas pocas por tic y solo si hay sitio.
 *    Las que no caben esperan en una cola CORTA; si la cola se llena, se cae
 *    la mas antigua. Una animacion de hace dos segundos ya no cuenta nada.
 * 3. **Un repintado por tic, no uno por reaccion.** Lo que llega se junta y se
 *    le entrega a React de una vez: burbujas por un lado, sumas por otro.
 *
 * NO IMPORTA NADA: se ejecuta con `node --test`. El tipo de reaccion es un
 * texto cualquiera; quien valida que sea una de las cinco es
 * `reaccionesEnVivo.leerReaccionRemota`, antes de llegar aqui.
 */

/**
 * Cuantas burbujas pueden estar volando a la vez.
 *
 * Otras tantas vistas animadas simultaneas tiran los fotogramas al suelo. Nadie
 * cuenta las burbujas, y una emision a trompicones si se nota.
 */
export const MAXIMO_DE_BURBUJAS = 24;

/** Cada cuanto se deja entrar a las ajenas y se entregan las sumas. */
export const TIC_DE_BURBUJAS_MS = 90;

/** Cuantas ajenas entran por tic, como mucho. */
export const BURBUJAS_POR_TIC = 3;

/** Cuantas ajenas pueden esperar su turno. */
export const TOPE_DE_ESPERA = 36;

/**
 * Cuantas burbujas pinta, como mucho, UN mensaje ajeno por cada tipo.
 *
 * Un mensaje trae cantidades («siete corazones»). Pintar los siete no añade
 * nada a pintar tres: se ve que alguien esta pulsando mucho, que es lo que
 * habia que ver. El contador si suma los siete.
 */
export const MUESTRA_POR_MENSAJE = 3;

/**
 * Los carriles por los que suben.
 *
 * Todas por la misma columna, una rafaga se ve como un solo simbolo
 * parpadeando. Con carriles fijos y repartidos, dos que nacen a la vez no se
 * tapan.
 */
export const CARRILES = 5;

export type Burbuja<Tipo extends string = string> = {
  /** Unica mientras dure la pantalla. Es la `key` de React. */
  clave: number;
  tipo: Tipo;
  /** De 0 a `CARRILES - 1`. */
  carril: number;
};

export type DiagnosticoDeBurbujas = {
  /** Burbujas que llegaron a pintarse. */
  pintadas: number;
  /** Ajenas que se cayeron de la cola sin pintarse. */
  descartadas: number;
  /** Las que estan en pantalla ahora. Nunca pasa de `MAXIMO_DE_BURBUJAS`. */
  enPantalla: number;
  /** El maximo que llego a haber en pantalla. */
  picoEnPantalla: number;
  /** Las que esperan ahora. Vuelve a cero. */
  enEspera: number;
  /** El maximo que llego a haber esperando. */
  picoDeEspera: number;
};

export type EntornoDeBurbujas<Tipo extends string> = {
  /** Programa algo. Devuelve como cancelarlo. */
  programar: (fn: () => void, ms: number) => () => void;
  /** La lista que hay que pintar. Siempre una lista NUEVA. */
  alCambiar: (burbujas: readonly Burbuja<Tipo>[]) => void;
  /** Lo que hay que sumar al contador, ya agrupado. Una vez por tic. */
  alSumar: (conteos: Partial<Record<Tipo, number>>) => void;
};

export type PistaDeBurbujas<Tipo extends string> = {
  /** Una reaccion de quien tiene el telefono en la mano. Se pinta ya. */
  soltarPropia: (tipo: Tipo) => void;
  /** Un lote ajeno: se suma entero y se pinta una muestra, por turnos. */
  recibir: (conteos: Partial<Record<Tipo, number>>) => void;
  /** La burbuja termino de subir. */
  quitar: (clave: number) => void;
  /** Suelta el tic y vacia todo. Idempotente. Despues no avisa de nada. */
  destruir: () => void;
  diagnostico: () => DiagnosticoDeBurbujas;
};

export function crearPistaDeBurbujas<Tipo extends string>(
  entorno: EntornoDeBurbujas<Tipo>,
): PistaDeBurbujas<Tipo> {
  let visibles: Burbuja<Tipo>[] = [];
  /** Las ajenas que esperan turno, de la mas antigua a la mas nueva. */
  let espera: Tipo[] = [];
  /** Lo ajeno que aun no se le ha contado al contador. */
  let porSumar: Partial<Record<Tipo, number>> = {};
  let haySumas = false;
  let cancelarTic: (() => void) | null = null;
  let destruida = false;
  let siguienteClave = 0;
  let siguienteCarril = 0;

  const cuenta = { pintadas: 0, descartadas: 0, picoEnPantalla: 0, picoDeEspera: 0 };

  function nueva(tipo: Tipo): Burbuja<Tipo> {
    siguienteClave += 1;
    const carril = siguienteCarril;
    // De dos en dos: con cinco carriles los recorre todos (0, 2, 4, 1, 3) y
    // dos burbujas seguidas nunca salen pegadas.
    siguienteCarril = (siguienteCarril + 2) % CARRILES;
    cuenta.pintadas += 1;
    return { clave: siguienteClave, tipo, carril };
  }

  function publicar(lista: Burbuja<Tipo>[]): void {
    visibles = lista;
    if (lista.length > cuenta.picoEnPantalla) cuenta.picoEnPantalla = lista.length;
    entorno.alCambiar(lista);
  }

  function tic(): void {
    cancelarTic = null;
    if (destruida) return;

    if (haySumas) {
      const lote = porSumar;
      porSumar = {};
      haySumas = false;
      entorno.alSumar(lote);
    }

    const libres = MAXIMO_DE_BURBUJAS - visibles.length;
    const entran = Math.min(BURBUJAS_POR_TIC, libres, espera.length);
    if (entran > 0) {
      const tipos = espera.slice(0, entran);
      espera = espera.slice(entran);
      publicar([...visibles, ...tipos.map(nueva)]);
    }

    // El tic solo sigue mientras quede algo por hacer: no hay un reloj
    // corriendo en una emision en la que nadie reacciona.
    if (espera.length > 0) programarTic();
  }

  function programarTic(): void {
    if (cancelarTic || destruida) return;
    cancelarTic = entorno.programar(tic, TIC_DE_BURBUJAS_MS);
  }

  return {
    soltarPropia(tipo) {
      if (destruida) return;
      // Con la pista llena se va la mas vieja: la respuesta al toque no espera.
      const sitio =
        visibles.length >= MAXIMO_DE_BURBUJAS
          ? visibles.slice(visibles.length - MAXIMO_DE_BURBUJAS + 1)
          : visibles;
      publicar([...sitio, nueva(tipo)]);
    },

    recibir(conteos) {
      if (destruida) return;
      for (const tipo of Object.keys(conteos) as Tipo[]) {
        const cuantas = conteos[tipo];
        if (typeof cuantas !== 'number' || !(cuantas > 0)) continue;
        porSumar[tipo] = (porSumar[tipo] ?? 0) + cuantas;
        haySumas = true;
        const muestra = Math.min(Math.floor(cuantas), MUESTRA_POR_MENSAJE);
        for (let i = 0; i < muestra; i += 1) espera.push(tipo);
      }
      if (espera.length > TOPE_DE_ESPERA) {
        // Se caen las mas ANTIGUAS: las que llevan mas rato esperando son las
        // que menos dicen de lo que pasa ahora.
        const sobran = espera.length - TOPE_DE_ESPERA;
        espera = espera.slice(sobran);
        cuenta.descartadas += sobran;
      }
      if (espera.length > cuenta.picoDeEspera) cuenta.picoDeEspera = espera.length;
      if (haySumas || espera.length > 0) programarTic();
    },

    quitar(clave) {
      if (destruida) return;
      const resto = visibles.filter((burbuja) => burbuja.clave !== clave);
      if (resto.length === visibles.length) return;
      publicar(resto);
      // Se ha hecho sitio: si alguien esperaba, que entre en el proximo tic.
      if (espera.length > 0) programarTic();
    },

    destruir() {
      if (destruida) return;
      destruida = true;
      if (cancelarTic) {
        cancelarTic();
        cancelarTic = null;
      }
      visibles = [];
      espera = [];
      porSumar = {};
      haySumas = false;
    },

    diagnostico() {
      return {
        ...cuenta,
        enPantalla: visibles.length,
        enEspera: espera.length,
      };
    },
  };
}
