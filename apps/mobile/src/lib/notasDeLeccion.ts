/**
 * Las reglas de los apuntes que se pueden EJECUTAR sin montar la pantalla.
 *
 * Viven aqui y no dentro del componente porque son justo lo que hay que poder
 * probar de verdad: si una nota vale, como se lee su minuto, y si lo que fallo
 * es un error o es que esta instalacion no tiene la migracion.
 */

// SOLO EL TIPO. Este modulo se EJECUTA en las pruebas con el runner de Node,
// que no entiende el atajo `@/`; un `import type` desaparece al compilar, asi
// que no llega a resolverse. Cualquier import de valor tendria que ser
// relativo y con extension, y eso no lo acepta este `tsconfig`.
import type { Traductor } from '@/lib/valoracionesDeCurso';

/**
 * El codigo de error que mando el servidor, si lo mando.
 *
 * Repetido a proposito y no importado de `valoracionesDeCurso`: ver arriba.
 * Son seis lineas sin estado; compartirlas costaria que este modulo dejara de
 * poder ejecutarse en las pruebas.
 */
function codigoDeFallo(fallo: unknown): string | null {
  if (typeof fallo === 'object' && fallo !== null && 'code' in fallo) {
    const code = (fallo as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim() !== '') return code;
  }
  return null;
}

/** Tope del texto. El mismo que la base y el mismo que el servidor. */
export const LARGO_MAXIMO = 2000;

/** Si este texto se puede guardar. Los espacios no cuentan como contenido. */
export function notaValida(texto: string): boolean {
  const limpio = texto.trim();
  return limpio.length >= 1 && limpio.length <= LARGO_MAXIMO;
}

/**
 * El minuto del video, en `m:ss` o `h:mm:ss`.
 *
 * `null` cuando no hay posicion: la nota se escribio sin que el reproductor
 * diera una, y ensenar «0:00» diria que fue al principio.
 */
export function minutoDeLaNota(segundos: number | null): string | null {
  if (segundos === null || !Number.isFinite(segundos) || segundos < 0) return null;
  const total = Math.floor(segundos);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const dos = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${dos(m)}:${dos(s)}` : `${m}:${dos(s)}`;
}

/**
 * Si lo que fallo es que ESTA FUNCION NO EXISTE todavia aqui (503).
 *
 * No es un error de nadie: la migracion 0057 no esta aplicada. La pestana no
 * se ofrece y no se dice nada.
 */
export function pestanaNoMontada(fallo: unknown): boolean {
  return codigoDeFallo(fallo) === 'lesson_notes_not_available';
}

/**
 * Traduce el fallo del servidor a algo que se pueda leer y hacer.
 *
 * El traductor es obligatorio: un texto por defecto en castellano dentro de
 * esta capa acabaria saliendo en la pantalla de quien tiene la aplicacion en
 * ingles el dia que alguien lo llame sin `t`.
 */
export function mensajeDeErrorDeNota(fallo: unknown, t: Traductor): string {
  switch (codigoDeFallo(fallo)) {
    case 'lesson_notes_access_required':
      return t('nota.necesitaAcceso');
    case 'lesson_note_empty':
      return t('nota.vacia');
    case 'lesson_notes_not_available':
      return t('nota.noDisponible');
    default:
      break;
  }
  if (fallo instanceof Error && fallo.message.trim() !== '') return fallo.message;
  return t('common.tryAgain');
}

/**
 * Una clave de idempotencia para ESTE apunte concreto.
 *
 * Se genera al empezar a escribir y se REUSA en cada reintento del mismo
 * texto; se tira al guardar bien. Sin eso, tocar «Guardar» dos veces —o
 * reintentar despues de un tiempo de espera agotado— crearia dos apuntes
 * identicos, y el segundo toque no tiene forma de saber que el primero llego.
 */
export function nuevaClaveDeGuardado(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
