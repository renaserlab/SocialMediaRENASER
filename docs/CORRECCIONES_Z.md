# Correcciones de Z — encargo del 25 de julio de 2026

Transcripción de lo pedido en el documento «Correcciones de Z.docx», para
tenerlo por escrito y poder verificarlo punto por punto.

La aplicación pasa a llamarse **Z**. El cambio de nombre y el icono llegaron por
la rama de Andy; aquí se recogen las correcciones que faltan.

---

## 1. Logo

El logo es una **Z con textura** (letra blanca en relieve sobre fondo negro
mate), no una letra «Z» escrita en texto plano.

- El archivo ya está en el proyecto: `apps/mobile/assets/icon.png`.
- Debe usarse **esa imagen** en la interfaz, no la letra suelta.
- En la **vista de Idioma** va arriba y centrado, y debajo el contenido
  habitual de la pantalla.
- En el **encabezado de Inicio** hay que sustituir la «Z» de texto por la
  imagen.

## 2. Quitar el quiz

La pantalla **«¿Qué está bloqueando realmente tu crecimiento?»** se elimina: no
debe aparecer más en ningún punto del flujo.

## 3. Entrar sin cuenta (como TikTok)

Hoy la aplicación pide iniciar sesión antes de dejar ver nada. Debe poder
**navegarse libremente sin cuenta**.

El registro o inicio de sesión se pide **solo** al intentar:

- publicar,
- comentar,
- reaccionar o dar «me gusta»,
- guardar contenido.

Antes de eso, ninguna pantalla de acceso.

## 4. Inicio

- Quitar de Inicio las tarjetas de **Eventos** y **Cursos**.
- Que sea un muro para explorar contenido y ver el de los perfiles seguidos,
  al estilo de TikTok.
- Corregir ahí el logo (ver punto 1).

## 5. Fotos recortadas

Las fotos se cortan al publicarlas. Dos caminos posibles:

- que la persona **recorte** y decida el encuadre, o
- mantener **formato vertical tipo historias** de Instagram o TikTok para que
  la foto se vea entera.

En publicaciones, centrar el encuadre para no perder lo importante.

## 6. Perfil

Rehacer la cabecera del perfil al estilo de Instagram:

- **quitar la foto de portada**,
- **seguidores y siguiendo al costado** de la foto de perfil,
- **debajo**, la descripción de la persona.

## 7. Foto de perfil en las búsquedas

Al buscar a alguien que **sí tiene** foto de perfil (por ejemplo Darren),
aparece el avatar por defecto. Es un fallo: debe salir su foto. Aplica a todas
las búsquedas.

## 8. Vídeos oscuros en el muro

En iPhone y Android los vídeos se ven **negros en el muro**; solo se ven al
reproducirlos. Mostrar una **portada** (como hacen TikTok e Instagram).

## 9. Lentitud al entrar

El inicio de sesión y la creación de cuenta **se quedan cargando mucho tiempo**
antes de avanzar. Hay que acelerarlo.

## 10. Cursos, reseñas y citas para todos

Hoy solo Darren puede crear. Debe poder hacerlo **cualquier usuario**:

- arriba, la opción de **rellenar sus propios cursos y reseñas**;
- más abajo, el acceso a **«Ver cursos / reseñas de Z»**;
- incluye el apartado de **agregar cita**, que ya funciona contra la base de
  datos.

---

## Condiciones que impuso el encargo

> «Ante todo evita romper comportamientos internos y evita borrar información
> valiosa de la base de datos (pues hay usuarios reales que ya están probando la
> aplicación); realiza todo lo requerido de manera correcta siguiendo buenas
> prácticas de Desarrollo de Software.»

En claro:

- **No se borra nada** de la base de datos. Hay personas usando la aplicación.
- Los cambios de permisos **amplían** lo que se puede hacer; no retiran nada a
  quien ya lo tenía.
- Quitar el quiz y la portada afecta a la interfaz: las columnas y tablas se
  conservan por si el contenido vuelve a hacer falta.
