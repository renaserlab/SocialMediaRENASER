/**
 * CUÁNTA GENTE ESTÁ VIENDO UN DIRECTO, AHORA.
 *
 * Reglas puras: sin React, sin Supabase. Se ejecutan en las pruebas tal cual.
 *
 * DE DÓNDE SALE EL NÚMERO. Hasta el 07/10/2026 no salía de ningún sitio: la
 * cabecera enseñaba el «pico», que es un dato del servidor que nadie informaba
 * (`LiveRepository.reportarEspectadores` existía y no lo llamaba nadie, y su
 * comentario explica por qué: un teléfono solo sabe de sí mismo).
 *
 * Sale de la PRESENCIA de Supabase: cada teléfono que tiene la sala abierta se
 * apunta en un canal con su identificador, y el canal le dice a todos quiénes
 * están apuntados. Nadie cuenta: se mira la lista.
 *
 *   · Una persona con dos teléfonos cuenta UNA vez: la clave es la persona.
 *   · Quien emite NO cuenta: «personas viendo» son las demás.
 *   · Quien mira sin cuenta también cuenta, con una clave propia de su teléfono.
 *
 * NO ES UNA CIFRA AUDITADA. El canal es público, igual que el de las
 * reacciones: cualquiera con la clave pública de la aplicación puede apuntarse.
 * Sirve para lo que se enseña en pantalla; no para facturar ni para decidir
 * nada. Por eso al servidor solo se le informa el PICO, y solo lo hace quien
 * emite.
 */

/** El canal de presencia de una emisión. EL MISMO en todos los teléfonos. */
export function topicoDeAudiencia(emisionId: string): string {
  return `live-audiencia:${emisionId}`;
}

/** La clave con la que se apunta alguien que mira sin haber entrado con su cuenta. */
export function claveDeInvitado(aleatorio: () => number = Math.random): string {
  return `invitado-${Math.floor(aleatorio() * 1e9).toString(36)}`;
}

/**
 * Personas viendo, a partir de lo que entrega `presenceState()`: un objeto con
 * una entrada por clave. Lo que haya dentro de cada entrada no importa.
 */
export function contarAudiencia(
  presencia: Record<string, unknown> | null | undefined,
  anfitrionId: string | null,
): number {
  if (!presencia) return 0;
  let total = 0;
  for (const clave of Object.keys(presencia)) {
    if (clave !== anfitrionId) total += 1;
  }
  return total;
}

/**
 * El número como se enseña junto al ojo: entero hasta 999 y abreviado después
 * («1,2 mil», «3,4 M»), para que no cambie el ancho de la cabecera con cada
 * persona que entra.
 */
export function audienciaLegible(cuantos: number): string {
  const n = Math.max(0, Math.floor(Number.isFinite(cuantos) ? cuantos : 0));
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${recortar(n / 1000)} mil`;
  return `${recortar(n / 1_000_000)} M`;
}

/** Un decimal como mucho, con coma, y sin «,0». */
function recortar(valor: number): string {
  const conUnDecimal = Math.floor(valor * 10) / 10;
  return String(conUnDecimal).replace('.', ',');
}

/** Cada cuánto, como mucho, informa del pico quien emite. */
export const ESPERA_ENTRE_INFORMES_MS = 10_000;

/**
 * Si quien emite tiene que informar ahora del pico al servidor.
 *
 * Solo cuando SUBE respecto a lo último informado —el servidor guarda el
 * máximo, así que una bajada no le dice nada—, y dejando pasar un rato entre
 * informes: en una sala que se llena, cada persona que entra sería una
 * petición.
 */
export function tocaInformarDelPico(caso: {
  viendo: number;
  ultimoInformado: number;
  ahora: number;
  ultimoInformeEn: number | null;
}): boolean {
  if (caso.viendo <= caso.ultimoInformado) return false;
  if (caso.ultimoInformeEn === null) return true;
  return caso.ahora - caso.ultimoInformeEn >= ESPERA_ENTRE_INFORMES_MS;
}
