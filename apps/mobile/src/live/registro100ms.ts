/**
 * En el navegador no hay proveedor de vídeo. No se registra ninguno.
 *
 * POR QUÉ ESTE FICHERO EXISTE. `registro100ms.native.ts` hace `require` del SDK
 * dentro de una función y detrás de una comprobación de plataforma, y aun así
 * Metro lo sigue: el empaquetador resuelve las rutas de forma estática y no
 * elimina código por una condición que solo se conoce al ejecutar. El resultado
 * era que un módulo nativo entraba en el paquete de web y la exportación
 * fallaba entera.
 *
 * La forma que sí entiende el empaquetador es la extensión. Este fichero, sin
 * sufijo, es el que se usa en el navegador y el que resuelve TypeScript; en un
 * teléfono, Metro prefiere `registro100ms.native.ts`, que sí carga el SDK. Quien
 * importa `@/live/registro100ms` recibe el que corresponda y no se entera.
 *
 * NO ES UN HUECO FUNCIONAL: sin proveedor registrado, `crearSalaDeVideo()`
 * devuelve la sala falsa y la pantalla dice que el vídeo no está disponible, que
 * es la verdad en un navegador.
 */
export function asegurarProveedorDeVideo(): void {
  // Nada que registrar.
}
