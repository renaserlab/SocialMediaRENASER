/**
 * Lo que la ficha de un evento puede afirmar, y lo que no.
 *
 * Vive aquí y no dentro de la pantalla porque es justo lo que hay que poder
 * probar: cuándo se ofrece reservar, cómo se lee una fecha que puede no existir
 * y qué se dice de un aforo que puede no estar puesto.
 *
 * NADA DE ESTO INVENTA UN DATO. Si el servidor no lo manda, la función lo dice
 * con `null` y la pantalla decide; ninguna devuelve un valor por defecto que
 * parezca información.
 */

/** Lo mínimo que estas reglas necesitan saber de un evento. */
export type EventoParaLaFicha = {
  startsAtDate?: Date;
  endsAtDate?: Date | null;
  timeState?: 'upcoming' | 'past' | 'undated';
  type?: 'presencial' | 'webinar' | 'live';
  capacity?: number | null;
  registrationsCount?: number;
};

/**
 * Si se puede ofrecer reservar.
 *
 * Solo con fecha por llegar. Un evento pasado lo rechaza el servidor, y uno sin
 * fecha no se puede reservar porque no se sabe a qué se está apuntando nadie.
 *
 * `undefined` —que es lo que llega del catálogo de demostración— se trata como
 * «no se sabe», y no se ofrece: es la respuesta honesta.
 */
export function sePuedeReservar(evento: EventoParaLaFicha): boolean {
  return evento.timeState === 'upcoming';
}

/**
 * La fecha larga del evento, o `''` si no tiene.
 *
 * Se compone con `toLocaleString` del dispositivo. NO se añade una zona
 * horaria: `starts_at` guarda el instante, no la zona del evento, así que
 * escribir «(hora de Lima)» sería una afirmación que el dato no sostiene.
 *
 * Con fecha de fin el MISMO día se escribe un rango de horas; en días
 * distintos, las dos fechas completas.
 */
export function fechaLargaDelEvento(
  evento: EventoParaLaFicha,
  local = 'es',
): string {
  const inicio = evento.startsAtDate;
  if (!inicio || Number.isNaN(inicio.getTime())) return '';

  const dia: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  };
  const hora: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };

  const desde = `${inicio.toLocaleDateString(local, dia)}, ${inicio.toLocaleTimeString(local, hora)}`;
  const fin = evento.endsAtDate;
  if (!fin || Number.isNaN(fin.getTime())) return desde;

  const mismoDia = inicio.toDateString() === fin.toDateString();
  return mismoDia
    ? `${desde} – ${fin.toLocaleTimeString(local, hora)}`
    : `${desde} – ${fin.toLocaleDateString(local, dia)}, ${fin.toLocaleTimeString(local, hora)}`;
}

/**
 * El aforo, o `null` si el organizador no lo puso.
 *
 * `null` NO es cero: cero sería «no cabe nadie», que es otra cosa. Por eso la
 * pantalla enseña dos frases distintas según haya o no aforo.
 */
export function aforoDelEvento(evento: EventoParaLaFicha): number | null {
  const aforo = evento.capacity;
  if (aforo === null || aforo === undefined) return null;
  return Number.isFinite(aforo) && aforo > 0 ? aforo : null;
}

/** Si ya no quedan sitios según lo que dice el servidor. */
export function aforoCompleto(evento: EventoParaLaFicha): boolean {
  const aforo = aforoDelEvento(evento);
  if (aforo === null) return false;
  return (evento.registrationsCount ?? 0) >= aforo;
}

/** Las cuatro claves posibles de modalidad. Las tres del modelo, y «sin definir». */
export type ClaveDeModalidad =
  | 'evento.modalidad.presencial'
  | 'evento.modalidad.online'
  | 'evento.modalidad.live'
  | 'evento.modalidad.desconocida';

/** La clave de traducción de la modalidad. Las tres del modelo, y nada más. */
export function modalidadDelEvento(evento: EventoParaLaFicha): ClaveDeModalidad {
  switch (evento.type) {
    case 'presencial':
      return 'evento.modalidad.presencial';
    case 'live':
      return 'evento.modalidad.live';
    case 'webinar':
      return 'evento.modalidad.online';
    default:
      // Una modalidad que el modelo no tiene. No se inventa ninguna.
      return 'evento.modalidad.desconocida';
  }
}
