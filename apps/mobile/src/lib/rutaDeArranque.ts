/**
 * A donde va la aplicacion al abrirse. La PRECEDENCIA, sin dibujar nada.
 *
 * Vive fuera de la pantalla por dos motivos:
 *
 *  1. El orden de estas comprobaciones es una regla de producto con
 *     consecuencias reales. Que la recuperacion de contrasena vaya ANTES que
 *     cualquier otra cosa no es un detalle: al pulsar el enlace del correo,
 *     Supabase ABRE SESION, asi que cualquier comprobacion que mire «¿hay
 *     sesion?» antes que esta se lleva al usuario al feed con la contrasena
 *     vieja intacta y sin haberla podido cambiar. Ya paso una vez.
 *
 *  2. Asi se puede comprobar en una prueba, que es lo unico que impide que el
 *     dia de manana alguien anada una condicion mas arriba sin darse cuenta.
 */

export type EstadoDeArranque = {
  /** El store local ya se leyo del disco. */
  hidratado: boolean;
  /** Hay backend. En modo demo no hay sesion que resolver ni que preguntar. */
  conBackend: boolean;
  /** Sesion: todavia resolviendose, con cuenta, o sin ella. */
  sesion: 'resolviendo' | 'conCuenta' | 'sinCuenta';
  /** Se llego desde el enlace del correo y falta fijar la contrasena nueva. */
  recuperandoContrasena: boolean;
  /**
   * Si toca el cuestionario de recomendacion. 'desconocido' significa que
   * todavia no se sabe; el store garantiza que sale de ahi en un tiempo
   * acotado (ver `usePreferenciasStore`).
   */
  cuestionario: 'desconocido' | 'pendiente' | 'visto' | 'noDisponible';
  /** Ya eligio idioma. Condiciona todo lo que se lee despues.  */
  idiomaElegido: boolean;
};

/** `null` = todavia no se puede decidir; hay que esperar mostrando la carga. */
export function rutaDeArranque(estado: EstadoDeArranque): string | null {
  if (!estado.hidratado) return null;
  if (estado.conBackend && estado.sesion === 'resolviendo') return null;

  /*
    PRIMERO la recuperacion de contrasena, antes que la sesion y antes que el
    cuestionario. Una sesion temporal abierta por el enlace del correo existe
    para una sola cosa: cambiar la contrasena. Mandarla a contestar preguntas
    —o al feed— la deja sin hacer lo unico que venia a hacer.
  */
  if (estado.recuperandoContrasena) return '/reset-password';

  if (estado.sesion === 'conCuenta') {
    // Con sesion, se espera a saber si toca el cuestionario. Poco: el store
    // tiene su propio reloj y siempre acaba respondiendo algo.
    if (estado.conBackend && estado.cuestionario === 'desconocido') return null;
    // Solo cuando esta pendiente. 'noDisponible' —no se pudo preguntar, o la
    // personalizacion esta apagada— NO es «hay que ensenarlo»: ante la duda,
    // no se interrumpe a nadie.
    if (estado.cuestionario === 'pendiente') return '/onboarding';
    return '/(tabs)/home';
  }

  /*
    Sin sesion se entra igualmente al muro. La cuenta se pide cuando hace falta
    de verdad —publicar, comentar, reaccionar—, no para poder mirar.

    El idioma se sigue preguntando primero: condiciona todo lo que se lee
    despues y no cuesta nada responderlo.
  */
  if (!estado.idiomaElegido) return '/language';
  return '/(tabs)/home';
}
