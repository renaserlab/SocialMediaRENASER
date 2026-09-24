# Publicación flexible (versión de pruebas)

24/09/2026, rama `Edson`. Pedido: que quien prueba la app pueda crear un
evento, un curso o un producto **sin esperar a que alguien lo apruebe**, y que
la app no parezca estricta.

## Qué es

Una bandera del servidor, `PUBLICACION_FLEXIBLE`, **apagada de fábrica**. Con
ella encendida, administración pasa de **revisar antes** a **moderar
después**: todo sale publicado al momento y se puede suspender o retirar
luego.

| | Con revisión (apagada) | Flexible (encendida) |
|---|---|---|
| Evento | Enviar → curaduría puntúa → administración aprueba y publica | Enviar **publica** |
| Curso | Enviar → administración aprueba → el autor publica | Enviar **aprueba y publica**; «Publicar» no exige revisión |
| Postulación de proveedor | Administración la acepta | Se **acepta al enviarla** |
| Fotos de producto | Nacen pendientes, las revisa curaduría | Nacen **aprobadas** |
| Producto | Evaluación, tres razones y administración lo publica | Enviar **publica** (con al menos una foto) |
| Producto publicado | No se edita | Se **edita** y se publican los cambios |
| Descripción mínima | Eventos 40, cursos 30 | **10** caracteres |
| Promesa del evento, resultados del curso | Obligatorios | Opcionales |

Lo que **no** cambia en ningún modo:

- Lo publicado así **no** recibe el sello «Seleccionado por Z» ni entra en la
  «Selección Z» de productos: exigen una evaluación de verdad.
- Queda en la auditoría, con el sistema como actor y `modo:
  publicacion_flexible`, para saber después qué se publicó así.
- Administración sigue pudiendo suspender eventos y productos y retirar
  cursos.

## Lo que se hizo, además de la bandera

- **Avisos al creador** (siempre, en los dos modos): aprobado, rechazado (con
  el motivo), correcciones, publicado, suspendido, postulación aceptada o
  rechazada, foto rechazada. En la bandeja y como notificación push. Antes
  nadie se enteraba de nada.
- **Categorías de producto**: la 0084 siembra diez iniciales y el formulario
  deja elegir una (y cambiarla al editar).
- **Precio con decimales y ejemplo**: se escribe «49.90» o «49,90», no
  «4990». La moneda se elige con un toque.
- **Documentos de la postulación**: se suben (PDF o foto, opcionales). La 0085
  crea el depósito privado `seller-documents` y administración los abre con
  un enlace firmado de diez minutos.
- **Revisión de cursos** en el panel de administración, y **nadie aprueba su
  propio curso** (en modo con revisión).

## Cómo se enciende

1. Aplicar en Supabase, en orden: `0084_categorias_iniciales_de_productos.sql`
   y `0085_documentos_de_postulacion.sql`. Las dos son idempotentes y traen su
   vuelta atrás en la cabecera.
2. Añadir al fichero de secretos (`C:\Users\Edwincito\zexcelencia-secretos.json`):

   ```json
   "PUBLICACION_FLEXIBLE": "true"
   ```

3. Cargar el secreto y renovar las máquinas (las lee solo al arrancar):

   ```powershell
   .\infra\aws\deploy-renaserlab.ps1 -Accion Secretos -ArchivoDeSecretos C:\Users\Edwincito\zexcelencia-secretos.json
   .\infra\aws\deploy-renaserlab.ps1 -Accion Renovar
   ```

4. Comprobar: `GET /api/v1/platform/config` → `{"publicacion_flexible": true}`.

La app lo pregunta sola al abrir cada pantalla: no hace falta otra build para
encender o apagar el modo. Sí hace falta **una build nueva** para que existan
las pantallas nuevas (precio con decimales, subir documentos, avisos): la
1.1.0, la misma que piden los directos.

## Cómo se apaga

Quitar la variable (o ponerla en `false`), `-Accion Secretos` y `-Accion
Renovar`. Lo ya publicado sigue publicado; lo nuevo vuelve a pasar por
revisión.
