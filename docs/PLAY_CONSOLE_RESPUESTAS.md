# Formularios de Google Play — respuestas

Cómo rellenar los formularios obligatorios de Play Console para **Z**
(`com.renaser.z`). Las respuestas salen de revisar el código y la base de datos,
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

### NO declarar (verificado que no existen)

Ubicación · Contactos · SMS o llamadas · Historial de navegación · Información
financiera · Salud · Rendimiento de la app · Identificadores de publicidad.

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

## 7. Antes de enviar a revisión

- [ ] Ficha completa: descripción corta (80) y larga (4000)
- [ ] Icono 512×512, gráfico destacado 1024×500, mínimo 2 capturas
- [ ] Política de privacidad publicada y su URL declarada
- [ ] URL de eliminación de cuenta declarada
- [ ] Este formulario de Seguridad de los datos
- [ ] Cuestionario IARC
- [ ] Público objetivo y declaración de anuncios
- [ ] Países de distribución
- [ ] **Subir primero a pruebas internas**, nunca directo a producción
