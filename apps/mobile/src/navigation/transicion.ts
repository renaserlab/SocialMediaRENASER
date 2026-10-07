/**
 * Lo que dura el paso de una pantalla a otra en la pila raíz.
 *
 * UN SOLO NÚMERO PARA DOS SITIOS. Lo usa el `<Stack>` de `app/_layout.tsx` para
 * animar, y lo usa el anfitrión de los avisos para saber cuándo la pantalla ha
 * dejado de moverse (`lib/avisoTrasNavegar`). Escritos por separado, cambiar la
 * animación dejaría al aviso esperando un tiempo que ya no es el suyo.
 */
export const DURACION_DE_LA_TRANSICION_MS = 220;
