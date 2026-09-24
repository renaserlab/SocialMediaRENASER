# Formularios de Google Play — respuestas

Cómo rellenar los formularios obligatorios de Play Console para **Z**
(`com.renaser.zeta`, el `android.package` de `apps/mobile/app.json`: no se
puede cambiar después de la primera subida). Las respuestas salen de revisar el código y la base de datos,
no de suposiciones: se recorrieron las tablas y las dependencias del móvil.

Google contrasta lo que se declara aquí con lo que hace la aplicación. Declarar
de más o de menos es motivo de suspensión, así que conviene no improvisar.

---

## 1. Seguridad de los datos (Data Safety)

### ¿La app recopila o comparte datos de usuario? → **Sí**

### ¿Los datos se cifran en tránsito? → **Sí**
Todo va por HTTPS. No hay tráfico en claro.

### ¿Se puede solicitar la eliminación de datos? → **Sí**
Marcar **las dos** opciones: se pueden borrar desde la app y también solicitarlo
por web. La URL de la página de borrado va aquí (ver `legal/eliminar-cuenta.html`).

### Datos recopilados

Para **todos** los tipos de abajo, las tres respuestas son iguales:

- ¿Se recopilan? → **Sí**
- ¿Se comparten con terceros? → **No**
- ¿Es obligatorio? → **Sí** para correo y nombre; **No** (opcional) para el resto
- Finalidad → **Funciones de la app** (y *Comunicaciones* en los mensajes)
- ¿Están vinculados a la identidad? → **Sí**
- ¿Se usan para seguimiento publicitario? → **No**

| Categoría | Tipo concreto | Qué es |
|---|---|---|
| Información personal | Nombre | Nombre del perfil |
| Información personal | Dirección de correo | Con el que se registra |
| Información personal | Otra información | Nombre de usuario y biografía |
| Fotos y vídeos | Fotos | Publicaciones, avatar, historias |
| Fotos y vídeos | Vídeos | Publicaciones e historias |
| Archivos de audio | Grabaciones de voz u otros audios | Audios y pódcast |
| Mensajes | Otros mensajes | Mensajes privados y adjuntos |
| Actividad en la app | Interacciones | Seguidos, me gusta, guardados |
| Actividad en la app | Otra actividad | Inscripciones, progreso en cursos |
| Información personal | Dirección | Dirección de envío de un pedido de Productos (opcional) |
| Información personal | Número de teléfono | Teléfono de contacto del envío (opcional) |
| Información financiera | Historial de compras | Pedidos de Productos y entradas de eventos |

> **Actualizado el 23/09/2026.** Las tres últimas filas llegaron con Productos
> (tabla de direcciones de envío: destinatario, teléfono, región, ciudad,
> distrito, dirección, referencia y código postal) y con las órdenes de
> eventos. Se declaran aunque los pagos estén apagados: el formulario de envío
> va dentro de la app que se sube.

### NO declarar (verificado que no existen)

Ubicación (una dirección de envío no es ubicación del dispositivo) · Contactos ·
SMS o llamadas · Historial de navegación · Información de pago (la tarjeta la
recoge Stripe, no la app) · Salud · Rendimiento de la app · Identificadores de
publicidad.

### ⚠️ Aviso sobre los mensajes

Los mensajes privados **no van cifrados de extremo a extremo**. La pregunta de
este formulario es sobre cifrado **en tránsito**, que sí se cumple. No declarar
cifrado de extremo a extremo: sería falso.

---

## 2. Clasificación de contenido (IARC)

Categoría: **Red social**.

| Pregunta | Respuesta |
|---|---|
| ¿Los usuarios pueden interactuar o intercambiar contenido? | **Sí** |
| ¿Pueden compartir su ubicación con otros? | **No** |
| ¿Permite comprar bienes digitales? | **No** |
| Violencia, sexo, lenguaje soez, drogas, apuestas | **No** a todo |
| ¿Contenido generado por usuarios? | **Sí** |
| ¿Hay forma de denunciar y bloquear? | **Sí** — ambas implementadas |

---

## 3. Público objetivo y contenido

- Grupos de edad: **18 años o más**.
- ¿Va dirigida a menores? → **No**.

> Declarar 13+ mete la aplicación en la política de Familias, que exige
> requisitos añadidos muy estrictos. Con mensajería privada, contenido de
> usuarios y temática de crecimiento personal, 18+ es lo razonable y simplifica
> la revisión.

---

## 4. Anuncios

¿Contiene anuncios? → **No**.

Verificado: no hay ninguna biblioteca de publicidad entre las dependencias.

---

## 5. Categoría de la tienda

**Estilo de vida.**

> «Salud y bienestar» somete la ficha a un escrutinio mayor sobre afirmaciones
> de salud. La aplicación ofrece crecimiento personal y audios guiados, no
> tratamientos, y las condiciones ya incluyen el descargo de que no es un
> servicio sanitario.

Etiquetas sugeridas: comunidad · crecimiento personal · pódcast · cursos ·
motivación.

---

## 6. Contenido generado por usuarios

Google pregunta cómo se modera. Está resuelto en la aplicación:

- **Denunciar**: en el menú de cada publicación.
- **Bloquear**: desde el perfil y desde la propia publicación. El bloqueo es
  efectivo —el contenido desaparece del muro— y se revierte en
  *Ajustes › Cuentas bloqueadas*.
- **Eliminar cuenta**: *Ajustes › Eliminar cuenta*, y también por web.

Hace falta una persona responsable de revisar las denuncias que lleguen.

---

## 7. Permisos que Play pide declarar

Al subir el primer AAB, Play Console bloquea el envío hasta rellenar estas dos
declaraciones (*Contenido de la aplicación*).

### Fotos y vídeos (`READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO`)

Los pide `expo-media-library` porque la app tiene **galería propia**: la de
historias (`StoryGalleryScreen`) y la miniatura de la última foto en la cámara
de historias (`StoryCaptureScreen`). Ya soporta el acceso parcial de Android 14
(«Seleccionar fotos»).

Texto para la declaración: *Z es una red social cuya función principal es
crear y publicar historias y publicaciones con fotos y vídeos del dispositivo.
La galería integrada muestra el carrete para elegir y combinar varios archivos
al crear una historia, algo que el selector del sistema no permite. La app
respeta el acceso parcial de Android 14.*

> **Si Google la rechaza** —pasa con apps que no son editores ni galerías—, la
> salida es cambiar la galería de historias por el selector del sistema
> (`expo-image-picker`, que no necesita permisos) y añadir
> `READ_MEDIA_IMAGES` y `READ_MEDIA_VIDEO` a `android.blockedPermissions`. Es un
> cambio de código y una build nueva.

### Servicio en primer plano (`FOREGROUND_SERVICE_MEDIA_PLAYBACK`)

Lo pide `expo-audio` con `enableBackgroundPlayback`: los audios y pódcast
siguen sonando con la pantalla apagada. Tipo: **Reproducción multimedia**.
Google pide un **enlace a un vídeo** (YouTube oculto o Drive) de unos 30
segundos: abrir un audio, bloquear el teléfono y que siga sonando con el
control en la notificación.

---

## 8. Antes de enviar a revisión

- [ ] Paquete `com.renaser.zeta` (no se podrá cambiar)
- [ ] Ficha completa: descripción corta (80) y larga (4000)
- [ ] Icono 512×512, gráfico destacado 1024×500, mínimo 2 capturas
- [ ] Política de privacidad publicada y su URL declarada:
      `https://social-media-renaser.vercel.app/politicas.html` (HTML estático;
      **no** `/privacy`, que es la pantalla de la app y llega vacía sin
      JavaScript)
- [ ] **La política cubre Productos.** La publicada es del 03/08/2026 y no
      menciona la dirección de envío, el teléfono, los pedidos ni a Stripe como
      encargado del pago. Google la contrasta con este formulario: se actualiza
      `apps/mobile/public/politicas.html` (y `legal/privacidad.html`) y la
      revisa alguien de derecho **antes** de enviar
- [ ] URL de eliminación de cuenta declarada:
      `https://social-media-renaser.vercel.app/eliminar-cuenta.html`
- [ ] *Acceso a la aplicación*: la app pide iniciar sesión, así que hay que dar
      a Google un correo y contraseña de una cuenta de prueba que funcione
- [ ] Declaraciones de permisos de §7 (fotos y vídeos, servicio en primer plano)
- [ ] Este formulario de Seguridad de los datos
- [ ] Cuestionario IARC
- [ ] Público objetivo y declaración de anuncios
- [ ] Países de distribución
- [ ] **Subir primero a pruebas internas**, nunca directo a producción
