/**
 * Los estados en que puede estar un permiso del dispositivo.
 *
 * Vive aparte de `permisos.ts` —y sin importar nada— por dos motivos: es la
 * unica parte con REGLAS (el resto es llamar al sistema), y asi se puede
 * probar. La traduccion parece trivial y no lo es: confundir «denegado» con
 * «bloqueado» deja un boton que no hace absolutamente nada, porque el sistema
 * ya no vuelve a preguntar.
 */
export type EstadoDePermiso =
  /** Concedido por completo. */
  | 'concedido'
  /** Concedido a medias: solo una seleccion de fotos (iOS). */
  | 'limitado'
  /**
   * Todavia NO se ha preguntado. Nadie ha dicho que no.
   *
   * POR QUE ES UN ESTADO PROPIO Y NO «denegado». Es la diferencia entre abrir
   * la camara y pedir el permiso —lo normal la primera vez— y plantarle a
   * alguien un cartel de «Z necesita la camara» sin haberle preguntado nunca.
   * Mientras los dos casos compartian valor, en un telefono recien instalado la
   * pantalla de Crear abria SIEMPRE en el cartel y la camara no aparecia jamas
   * por si sola: ese es exactamente el fallo que se estaba viendo.
   */
  | 'sinPreguntar'
  /** Rechazado, pero el sistema todavia dejaria volver a preguntar. */
  | 'denegado'
  /** Rechazado para siempre: solo se puede cambiar en los ajustes. */
  | 'bloqueado';

/** Lo que devuelve cualquiera de los modulos de permisos de Expo. */
export type RespuestaDePermiso = {
  granted: boolean;
  canAskAgain?: boolean;
  /**
   * `'granted' | 'undetermined' | 'denied'`. Es el UNICO campo que distingue
   * «no se ha preguntado» de «se dijo que no»: `granted:false` y
   * `canAskAgain:true` valen para los dos.
   */
  status?: string;
  /** Solo iOS: 'all' | 'limited' | 'none'. */
  accessPrivileges?: string;
};

export function interpretarPermiso(respuesta: RespuestaDePermiso): EstadoDePermiso {
  if (respuesta.granted) {
    /*
      Acceso parcial: la persona dio permiso solo a unas fotos concretas. El
      selector abre, pero medio carrete no esta, y sin explicarlo parece que la
      aplicacion haya perdido las fotos. En Android y en la web no existe, y el
      campo llega indefinido: entonces concedido es concedido.
    */
    return respuesta.accessPrivileges === 'limited' ? 'limitado' : 'concedido';
  }
  /*
    `canAskAgain` indefinido se trata como «todavia se puede preguntar»: es la
    suposicion que no deja a nadie encerrado sin salida. Al reves —dar por
    bloqueado lo que no lo esta— mandaria a los ajustes a quien solo tenia que
    tocar «permitir».
  */
  if (respuesta.canAskAgain === false) return 'bloqueado';
  /*
    Se mira DESPUES de «bloqueado» a proposito: si el sistema ya no piensa
    preguntar, da igual como se llegue ahi, la salida son los ajustes.
  */
  return respuesta.status === 'undetermined' ? 'sinPreguntar' : 'denegado';
}
