# QA manual — ronda «nuevos bugs Z»

Lo que las pruebas automáticas **no pueden ver**. Todas las de esta ronda miran
el código fuente o ejecutan lógica pura: **no montan la interfaz**, así que nada
de lo de abajo está comprobado por ellas.

Cada punto dice **qué mirar** y **qué significa si falla**.

> **No inventé validación física.** No ejecuté nada de esta lista en un
> dispositivo: no tengo uno delante. Es exactamente lo que queda por hacer.

---

## 1. Audio — el bloque con más riesgo

Con un vídeo de Inicio **sonando** (no en silencio), ir a cada sección:

| Recorrido | Qué mirar | Si falla |
|---|---|---|
| Inicio → **Explorar** | el audio para | Es el que ya funcionaba: si se rompió, la regresión está en el arreglo. |
| Inicio → **Crear** | el audio para | Éste fallaba. Distancia 2. |
| Inicio → **Mensajes** | el audio para | Éste fallaba. Distancia 3. |
| Inicio → **Perfil** | el audio para | Éste fallaba. Distancia 4, el caso del reporte. |
| Inicio → perfil ajeno / detalle | el audio para | Ruta que no es sección: se pinta encima. |
| Inicio → **app al fondo** | el audio para | Lo lleva `AppState` en `useSeccionActiva`. |
| Web: Inicio → **otra pestaña del navegador** | el audio para | Lo lleva `visibilitychange`. |

**Y lo que NO debe apagarse** (es la mitad que se rompe al arreglar esto):

- Una **lección** reproduciéndose mientras se navega dentro del curso.
- Una **nota de voz** en un chat.
- El **podcast**.
- Una **historia** abierta.

Si alguno de éstos se calla, el apagado dejó de ser por reproductor y se volvió
global — que es justo lo que no se quería.

**Rendimiento, que es lo que se arriesgaba:** volver a una pestaña lejana debe
seguir siendo instantáneo y conservar el scroll. Si al volver a Inicio se ve un
parpadeo o se pierde la posición, el retraso del congelado se pasó de largo.

## 2. Mi perfil → Cursos

- **Sin cursos:** se lee «Todavía no has publicado ningún curso» y está
  «+ Agregar curso». **No** aparece «Ver cursos de Z».
- **Con cursos:** se listan los tuyos y sigue «+ Agregar curso».
- **Agregar un curso** funciona igual que antes.
- **Podcast y Eventos** de tu propio perfil **sí** conservan su acceso al
  catálogo. Si desaparecieron, la separación se llevó de más.
- **Perfil ajeno sin cursos:** «*Nombre* aún no tiene cursos publicados», sin
  botón al catálogo.

## 3. Reacciones

- Pulsar el **número** de una publicación con reacciones → sube una **hoja**.
- **La barra inferior sigue visible.** Era el síntoma.
- Se ve la publicación por encima de la hoja.
- Dentro: scroll de la lista, **seguir** a alguien, avatares correctos.
- Cerrar: **arrastrando**, **tocando fuera** y con **atrás de Android**. Los tres.
- Al cerrar se vuelve exactamente a la publicación, sin perder el scroll del feed.
- Una publicación con **0 reacciones**: el número no abre nada.
- **Con muchas reacciones (>50):** el scroll debe reciclar. Si va a tirones o la
  memoria sube, la lista virtualizada perdió su altura.
- **La ruta directa sigue viva:** abrir `/reacciones/{id}` a mano. Debe salir la
  pantalla con cabecera y flecha de volver.

## 4. Guardar

- Tocar el marcador → se pone del **color primario**, claramente distinto.
- Sale el aviso «Publicación guardada» con **«Ver lista»**.
- Pulsar «Ver lista» → lleva a Guardados **y el aviso desaparece**.
- Si no se pulsa, el aviso se va solo.
- Tocar otra vez → icono normal + «Publicación eliminada de Guardados», **sin**
  «Ver lista».
- **Comprobar en claro y en oscuro.** El color sale del tema; si en uno de los
  dos no se distingue, el token elegido no sirve.
- **Con el avión puesto:** guardar → el icono vuelve solo a su sitio **y sale un
  error**. Antes volvía en silencio.
- **Persistencia:** guardar, cerrar la app del todo, abrir → sigue guardada.

## 5. Republicar

- Republicar → aviso «Publicación republicada» **al momento**, sin recargar.
- El icono queda en estado activo y el contador sube.
- **Salir de la app y volver** → sigue republicada. Era la única forma de
  comprobarlo antes.
- Deshacer → «Republicación eliminada».
- **Con el avión puesto:** rollback + error, y **ningún** aviso de éxito.

## 6. Nombres bajo los botones

- Se leen: **Me gusta · Comentar · Republicar · Compartir · Guardar**.
- **En un teléfono estrecho** (360 dp o menos): no se montan unos sobre otros,
  no parten en dos líneas, la tarjeta no crece a lo alto.
- En **inglés** y **portugués**.
- Los toques siguen siendo cómodos: probar con el dedo, no con el ratón.
- El **número de «me gusta»** sigue abriendo la hoja de reacciones — es un
  destino distinto del corazón.

## 7. Sincronización

Todo esto **sin cerrar ni recargar la aplicación**:

| Acción | Dónde mirar | Si falla |
|---|---|---|
| Publicar un **vídeo** | vuelve a Inicio → está arriba | Era el caso del reporte. |
| Publicar cualquier cosa | Perfil → galería → está | Segunda superficie con lista propia. |
| Publicar | Explorar → está | Ya funcionaba (lee del almacén). |
| **Comentar** | el contador sube en Inicio y en Perfil | |
| Publicar una **historia** | la fila de arriba la muestra | |
| Publicar/**publicar un borrador** de curso | tu perfil lo lista | |

**Y lo que NO debe pasar** — esto es lo que hay que vigilar de verdad:

- **Cambiar de pestaña sin haber publicado nada NO debe pedir datos.** Con las
  herramientas de red abiertas: ir Inicio → Perfil → Inicio → Perfil cinco veces
  sin publicar nada tiene que dar **cero** peticiones de feed. Si hay una por
  cambio, el mecanismo degeneró en «refrescar al enfocar».
- **Comentar no debe duplicar el comentario.** Aparece **una** vez.
- Publicar **no** debe hacer parpadear ni recargar la pantalla entera.

## 8. Que la mensajería siga intacta

No se tocó, pero es lo que más costaría perder:

- Chat en **tiempo real** entre dos cuentas.
- **Notas de voz**: grabar, enviar, escuchar.
- **Responder a una historia** desde el visor.
- Bandeja: **buscar**, **etiquetas**, **filtros**.

## 9. Dos cuentas (Nivel C — todavía NO implementado)

Con dos dispositivos: **A publica → B NO lo ve** hasta volver a entrar en la
superficie. **Eso es lo esperado hoy**, no un fallo.

El Nivel C —cambios de otra persona en vivo— no está hecho. La migración `0047`
queda preparada y **sin aplicar**; en su cabecera está lo que falta en el
cliente antes de aplicarla.

Lo que **sí** debe cumplirse ya: al volver B a la superficie, ve lo de A. Eso lo
da la carga normal, no Realtime.
