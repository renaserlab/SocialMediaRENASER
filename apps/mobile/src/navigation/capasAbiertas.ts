/**
 * Que hay montado ENCIMA de la pantalla ahora mismo.
 *
 * QUE ES UNA CAPA. Cualquier cosa que tape la pantalla sin ser una pantalla:
 * un dialogo de confirmacion, una hoja inferior, un visor de imagen, el
 * recorte de una foto de perfil. Todas comparten una regla: el boton Atras las
 * cierra a ELLAS, nunca a la pantalla que tienen debajo.
 *
 * POR QUE NO BASTA CON `<Modal>`. En Android, el `Modal` de React Native se
 * pinta en un `Dialog` nativo y ese dialogo se queda la tecla Atras antes de
 * que el evento llegue a JavaScript: llama a su `onRequestClose` y ahi acaba
 * todo. Por eso `DialogHost`, `BottomSheet` e `ImageViewer` ya se comportan
 * bien sin tocar nada, y NO deben registrarse aqui: lo harian dos veces.
 *
 * Lo que si necesita este registro son las capas que NO son `Modal` sino una
 * vista a pantalla completa dentro del arbol —`ConfirmarRecorte` es la que hay
 * hoy—. Cada una resolvia el Atras con su propio `BackHandler`, y con eso quien
 * se lleva el evento lo decide el ORDEN DE MONTAJE, no la intencion. Aqui hay
 * una sola respuesta a «¿hay algo abierto?» y un solo sitio donde cerrarlo.
 *
 * NO ES UN HISTORIAL. No guarda rutas ni compite con la navegacion: guarda
 * funciones de cerrar, y se vacia solo cuando la capa se desmonta.
 */

type Cerrar = () => void;

/**
 * Pila, no conjunto: si se apilan dos capas (una hoja que abre un dialogo) se
 * cierra la de arriba, que es la que la persona esta mirando.
 */
const capas: Cerrar[] = [];

/**
 * Anuncia una capa abierta y devuelve como retirarla.
 *
 * El valor devuelto se usa tal cual como limpieza de un `useEffect`. Retirar
 * dos veces no hace nada, y retirar una capa que ya no esta arriba tampoco
 * descoloca a las demas: se quita por identidad, no por posicion.
 */
export function registrarCapaAbierta(cerrar: Cerrar): () => void {
  capas.push(cerrar);
  let retirada = false;
  return () => {
    if (retirada) return;
    retirada = true;
    const posicion = capas.lastIndexOf(cerrar);
    if (posicion !== -1) capas.splice(posicion, 1);
  };
}

/**
 * Anuncia que ESTA PANTALLA se queda el Atras, y devuelve como retirarlo.
 *
 * NO ES UNA CAPA, y por eso tiene su propio nombre aunque comparta la pila.
 * Una capa tapa la pantalla; esto es una pantalla que necesita despedirse antes
 * de irse: el asistente de curso tiene que preguntar si se guarda lo escrito, y
 * el detalle de la bandeja de administracion tiene que volver a la lista en vez
 * de salir de la pantalla entera.
 *
 * EL FALLO QUE CIERRA. Las dos resolvian su salida con el boton Atras de la
 * cabecera y nada mas. La tecla FISICA de Android no pasaba por ahi: llamaba a
 * `volver()` directamente, y el asistente perdia lo escrito en el paso actual
 * sin preguntar nada.
 *
 * COMPARTE LA PILA A PROPOSITO. La pregunta que responde el Atras es una sola
 * —«¿hay alguien que se quede este evento?»— y tener dos registros obligaria a
 * decidir cual manda cuando los dos contestan que si. Con una pila, manda el
 * ultimo que se monto, que es lo que la persona esta mirando.
 *
 * QUIEN SE REGISTRA AQUI DEBE NAVEGAR EL MISMO. El `salir` que se pasa se
 * encarga de volver; la maquina de `atras.ts` se limita a llamarlo y a dar el
 * evento por atendido.
 */
export function registrarSalidaPropia(salir: Cerrar): () => void {
  return registrarCapaAbierta(salir);
}

/** ¿Tiene el Atras algo que cerrar antes de tocar la navegacion? */
export function hayCapaAbierta(): boolean {
  return capas.length > 0;
}

/**
 * Cierra la capa de mas arriba. Devuelve si habia alguna.
 *
 * No se saca de la pila aqui: quien cierra es el componente, y al desmontarse
 * ejecuta su propia retirada. Sacarla ademas desde aqui dejaria la pila y el
 * arbol contando cosas distintas si el cierre resulta ser una animacion.
 */
export function cerrarCapaSuperior(): boolean {
  const superior = capas[capas.length - 1];
  if (!superior) return false;
  superior();
  return true;
}

/**
 * Solo para las pruebas: deja el registro como recien arrancado.
 *
 * Existe porque el modulo es estado compartido de proceso y una prueba que
 * deje una capa puesta contaminaria a la siguiente.
 */
export function olvidarCapasAbiertas(): void {
  capas.length = 0;
}
