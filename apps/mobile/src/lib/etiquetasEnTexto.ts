/**
 * Encontrar las etiquetas dentro de un texto, PARA PINTARLAS.
 *
 * Vive aparte del componente por dos motivos. El primero es que se pueda
 * probar: `TextoDePublicacion.tsx` lleva JSX y el corredor de pruebas del
 * proyecto (`node --experimental-strip-types`) no lo carga. El segundo es que
 * esto es texto, no interfaz, y mezclarlo con la vista invita a que la
 * siguiente pantalla que necesite lo mismo lo escriba otra vez.
 *
 * ESTO NO DECIDE QUE ES UNA ETIQUETA. Eso lo decide el servidor
 * (`app/modules/content/hashtags.py`), que es quien las extrae y las guarda.
 * Aqui solo se reconoce lo mismo para poder colorearlo, y por eso al tocar
 * «#MiNegocio» se navega con el texto TAL CUAL: normalizarlo tambien aqui
 * seria tener la regla en dos sitios, y el dia que dejaran de coincidir la
 * pantalla llevaria a una etiqueta que no existe.
 */

/**
 * NI `\w` NI LOOKBEHIND, y las dos cosas por un motivo concreto.
 *
 * `\w` EN JAVASCRIPT ES SOLO ASCII: `[A-Za-z0-9_]`, y ni siquiera la bandera
 * `u` lo cambia. El `\w` de Python, en cambio, SI incluye las letras
 * acentuadas. Escrito con `\w`, «#Programación» se pintaba como «#Programaci»
 * y —lo grave— al tocarlo se navegaba a la etiqueta «Programaci», que no es la
 * que el servidor guardo. Dos reglas que se creen iguales y no lo son: el peor
 * tipo de fallo, porque parece funcionar. Con `\p{L}` y `\p{N}` (que exigen la
 * bandera `u`) el conjunto es el mismo a los dos lados.
 *
 * `(?<!...)` no esta disponible en todas las versiones de Hermes, y una
 * expresion regular que revienta al cargar el modulo se lleva por delante el
 * muro entero. En su lugar se captura el caracter de delante en el grupo 1 y se
 * vuelve a escribir en la salida: hace lo mismo sin depender del motor.
 *
 * La almohadilla se excluye del caracter previo para que «##ia» no produzca una
 * etiqueta a mitad, igual que en el servidor.
 */
const ETIQUETA = /(^|[^\p{L}\p{N}_#])#([\p{L}\p{N}_]{1,50})/gu;

export type TrozoDeTexto =
  | { tipo: 'texto'; valor: string }
  | { tipo: 'etiqueta'; valor: string };

/**
 * Parte el texto en trozos normales y trozos que son etiqueta.
 *
 * Devuelve SIEMPRE el texto completo repartido entre los trozos: concatenar
 * los valores (poniendo la almohadilla delante de las etiquetas) reconstruye el
 * original. Eso es lo que garantiza que pintar no cambie lo que alguien
 * escribio, que seria el peor fallo posible en un componente como este.
 */
export function partirEnEtiquetas(cuerpo: string): TrozoDeTexto[] {
  const trozos: TrozoDeTexto[] = [];
  const texto = cuerpo ?? '';
  let ultimo = 0;
  // La expresion es de modulo y `lastIndex` sobrevive entre llamadas: sin
  // reiniciarlo, la segunda publicacion empezaria a buscar por donde se quedo
  // la primera y se dejaria etiquetas sin pintar.
  ETIQUETA.lastIndex = 0;

  let encontrado = ETIQUETA.exec(texto);
  while (encontrado !== null) {
    const completo = encontrado[0];
    // Los dos grupos existen siempre que haya coincidencia, pero TypeScript no
    // puede saberlo. `?? ''` es exacto para el grupo 1 —que casa la cadena
    // vacia al principio del texto— e inocuo para el 2.
    const antes = encontrado[1] ?? '';
    const etiqueta = encontrado[2] ?? '';
    // Lo que hubiera antes, mas el caracter que la expresion se llevo consigo.
    const previo = texto.slice(ultimo, encontrado.index) + antes;
    if (previo) trozos.push({ tipo: 'texto', valor: previo });
    if (etiqueta) trozos.push({ tipo: 'etiqueta', valor: etiqueta });
    ultimo = encontrado.index + completo.length;
    encontrado = ETIQUETA.exec(texto);
  }

  const resto = texto.slice(ultimo);
  if (resto) trozos.push({ tipo: 'texto', valor: resto });
  return trozos;
}
