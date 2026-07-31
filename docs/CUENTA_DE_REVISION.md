# Cuenta de demostración para App Store y Google Play

La app exige inicio de sesión para casi todo. Sin credenciales que funcionen,
quien revisa se queda en la primera pantalla y rechaza por «app incompleta»
(directriz 2.1 de Apple). Google Play pide lo mismo en su ficha.

Este documento explica cómo dejarla lista y qué escribir en la ficha.

---

## 1. La persona usuaria — ya existe

`testgoogle@gmail.com`, creada el 31 de julio de 2026. Se dio de alta para la
prueba cerrada de Google Play y sirve igual para Apple: **una sola cuenta para
las dos tiendas**, así solo hay una contraseña que mantener viva.

Estado comprobado contra la base de datos:

| Campo | Valor | |
|---|---|---|
| `role` | `user` | ✅ ve lo mismo que cualquier miembro |
| `full_name` | `testgoogle` | ⚠️ lo arregla el script |
| `username` | `null` | ⚠️ lo arregla el script |
| `bio` | vacía | ⚠️ lo arregla el script |
| `podcast_started_at` | `null` | ⚠️ **importante**, ver abajo |

Si alguna vez hay que crear otra: **Authentication → Users → Add user**,
marcando **«Auto Confirm User»**. Sin esa casilla la cuenta queda pendiente de
confirmar por correo y no puede iniciar sesión.

### Sobre la contraseña

No está en este repositorio ni debe estarlo. Vive en dos sitios: el panel de
Supabase y la ficha de App Store Connect.

Que sea larga y que **no se reutilice** de ninguna otra cuenta: viaja en texto
plano dentro de un formulario de Apple y la ven varias personas del equipo de
revisión.

No la cambies mientras haya una versión en revisión. Si la contraseña deja de
funcionar a mitad del proceso, el rechazo es inmediato y hay que volver a
enviar.

---

## 2. Ejecutar el script

[`supabase/seed/demo_revisor.sql`](../supabase/seed/demo_revisor.sql), en el
editor SQL de Supabase. Se puede repetir sin miedo: no crea nada dos veces.

Hace tres cosas:

1. **Rellena el perfil** con nombre y usuario reconocibles. Un perfil vacío hace
   pensar que la app no carga los datos.
2. **Deja el rol en `user`.** Es deliberado: quien revisa debe ver exactamente
   lo que ve cualquier miembro. Con permisos de administración vería pantallas
   que el público no tiene y aprobaría una app distinta de la publicada.
3. **Concede acceso a los cursos de pago** mediante una compra `manual` en
   estado `paid`, que es para lo que existe ese proveedor.

   Hoy **no concede ninguna**: los cuatro cursos publicados (Formación, Retiro,
   Consultoría y Certificación) tienen `price_minor = 0`, y la migración
   `0016_course_paywall.sql` deja los gratuitos abiertos a cualquier persona
   autenticada. Queda por si mañana se le pone precio a alguno: ese día, sin
   esta concesión, quien revisa vería la ficha del curso y ningún vídeo se
   reproduciría.
4. **Adelanta el podcast diez días.** Es el punto que de verdad importa hoy.

   Los episodios 2 a 5 se abren a las 8, 16, 24 y 32 horas, contadas desde
   `podcast_started_at`. En esta cuenta ese campo está a `null`, y la API lo
   rellena con la hora actual la primera vez que se abre la sección: quien
   revisa entraría, vería el episodio 1 y los cuatro siguientes con una cuenta
   atrás de hasta 32 horas. Adelantando el origen, los cinco están abiertos
   desde el primer momento.

Al terminar, la comprobación del final debe dar **`sin_acceso = 0`**.

---

## 3. Qué escribir en la ficha

### App Store Connect → App Review Information

Marca **Sign-in required** y rellena usuario y contraseña. En **Notes**:

```
La aplicación es una red social privada para la comunidad RENASER. Todo el
contenido está detrás del inicio de sesión, por lo que es imprescindible usar
la cuenta facilitada.

Esta versión NO incluye compras ni ofrece ningún producto de pago: no hay
precios, ni carrito, ni pasarela. El acceso a la comunidad se gestiona
íntegramente fuera de la aplicación.

Recorrido sugerido:
1. Iniciar sesión con la cuenta facilitada.
2. Muro: publicar un texto, dar me gusta y comentar.
3. Historias: la fila superior del muro. Se pueden crear con la cámara o desde
   la galería, y desaparecen solas a las 24 horas.
4. Cursos: abrir cualquiera y reproducir una lección.
5. Perfil: editar los datos y cambiar la foto.
6. Ajustes: la política de privacidad, los términos y el centro de soporte
   están dentro de la app, además de en la web.

Moderación de contenido (directriz 1.2): en el menú «···» de cada publicación
hay «Reportar publicación» y «Bloquear». Al bloquear a una persona deja de
verse su contenido de forma inmediata.

Eliminación de cuenta: Ajustes → Eliminar cuenta, dentro de la aplicación.

Algunos episodios del podcast aparecen atenuados: son contenido reservado a la
membresía y no ofrecen ninguna compra dentro de la app.

Soporte: https://social-media-renaser.vercel.app/support
```

### Google Play Console → Acceso a la app

Misma cuenta. Marca que se requieren credenciales y añade las mismas
instrucciones.

---

## 4. Antes de cada envío

- [ ] Iniciar sesión con la cuenta **en la build que se envía**, no en la de
      desarrollo. Una contraseña correcta contra un backend equivocado falla
      igual.
- [ ] Comprobar que reproduce un vídeo de curso y un audio del podcast.
- [ ] Volver a ejecutar el script si se han añadido cursos de pago nuevos: el
      acceso se concede curso a curso, no de golpe.
- [ ] Confirmar que la API de Render está despierta. El plan gratuito duerme y
      un arranque en frío se lee como app caída.

---

## 5. Después de publicar

La cuenta se queda. Apple la usa también en las actualizaciones, y borrarla
obliga a repetir todo esto en el siguiente envío.

Lo que sí conviene revisar de vez en cuando: que siga con rol `user` y que no
haya acumulado contenido raro de pruebas anteriores.
