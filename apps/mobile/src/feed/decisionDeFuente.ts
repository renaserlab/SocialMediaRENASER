/**
 * Cuando el "Para ti" recomendado se rinde y deja paso al orden de siempre.
 *
 * Esto es una CONDICION DE ACEPTACION, no una comodidad: el recomendador puede
 * fallar, estar apagado o no tener todavia con que personalizar, y en ninguno
 * de esos casos puede quedarse el Inicio en negro, con un error o con una rueda
 * girando para siempre. La aplicacion sigue funcionando; lo unico que cambia es
 * el orden de los videos.
 *
 * La decision vive aqui, aparte de la fuente, porque los casos limite no son
 * obvios —una pagina vacia significa cosas distintas segun donde este— y
 * porque asi se pueden comprobar todos sin levantar red ni pantalla.
 */

export type DecisionDeLote =
  /** El lote sirve: se pinta. */
  | 'usar'
  /** Se abandona el recomendador y se pide lo mismo a la fuente cronologica. */
  | 'respaldo'
  /** No hay respaldo que valga: sencillamente se acabo el contenido. */
  | 'fin';

export type LoteRecibido = {
  /** Publicaciones devueltas por el recomendador. */
  recibidas: number;
  /** De esas, cuantas se pueden REPRODUCIR (las demas se descartan). */
  reproducibles: number;
  /** Por donde iba la paginacion. 0 = primera pagina. */
  desplazamiento: number;
};

export function decidirLote({
  recibidas,
  reproducibles,
  desplazamiento,
}: LoteRecibido): DecisionDeLote {
  const esLaPrimera = desplazamiento === 0;

  if (recibidas === 0) {
    /*
      Vacio significa dos cosas distintas segun donde ocurra, y confundirlas
      arruina una de las dos:

      - En la PRIMERA pagina: el recomendador no tiene nada que ofrecer (esta
        apagado, o esta persona no tiene con que personalizar). Caer al orden
        cronologico es lo correcto; dejarlo vacio seria una pantalla negra
        con contenido de sobra al otro lado.

      - Mas adelante: sencillamente se llego al final de lo recomendado.
        Reiniciar aqui con la fuente cronologica volveria a ensenar desde
        arriba los videos que la persona acaba de ver.
    */
    return esLaPrimera ? 'respaldo' : 'fin';
  }

  if (reproducibles === 0) {
    /*
      Vinieron publicaciones pero ninguna se puede reproducir (por ejemplo, si
      fallo el firmado de sus URLs). En la primera pagina eso es, para quien
      mira, exactamente lo mismo que no tener nada: se prueba con la otra
      fuente. Mas adelante no, porque significaria repetir desde el principio.
    */
    return esLaPrimera ? 'respaldo' : 'usar';
  }

  return 'usar';
}
