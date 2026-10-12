# Ficha de App Store — textos listos para copiar

Los campos de Apple **no son los mismos que los de Google Play**, aunque el
producto sea idéntico. Lo que más cambia:

- El **subtítulo** son 30 caracteres, no los 80 de la descripción corta de Play.
- Hay un campo de **palabras clave** de 100 caracteres. Play no lo tiene: allí
  el posicionamiento sale de la descripción.
- El **texto promocional** se puede cambiar sin pasar por revisión. Todo lo
  demás obliga a enviar una versión nueva.

Los textos describen lo que la app hace de verdad. Apple compara la ficha con
el comportamiento real y prometer de más es motivo de rechazo.

Para Google Play, ver [`FICHA_PLAY_STORE.md`](FICHA_PLAY_STORE.md).

---

## Nombre (máx. 30)

```
Z
```

---

## Subtítulo (máx. 30)

Aparece bajo el nombre, en resultados y en la ficha. Recomendado el primero:

```
Crece con una comunidad real
```
*(28 caracteres)*

Alternativas:

```
Comunidad, pódcast y cursos
```
*(27 caracteres)*

```
Tu espacio para crecer
```
*(22 caracteres)*

El subtítulo **también se indexa** para las búsquedas, igual que el nombre. Por
eso lleva «comunidad», que es la palabra que mejor describe el producto, y por
eso esa palabra no se repite luego en las palabras clave: repetirla no suma.

---

## Palabras clave (máx. 100 caracteres, separadas por comas)

```
crecimiento,personal,podcast,cursos,eventos,motivacion,bienestar,mentoria,habitos,proposito
```
*(91 caracteres)*

Reglas que se han seguido, porque cada una cuesta caracteres o un rechazo:

- **Sin espacios tras las comas.** Cada espacio gasta un carácter del límite.
- **Nada que ya esté en el nombre o el subtítulo.** Apple indexa esos campos
  aparte, así que repetir «comunidad» o «Z» sería tirar caracteres.
- **Sin plurales de lo que ya está en singular** ni al revés: Apple los asocia.
- **Sin marcas ajenas.** Poner nombres de otras apps para colarse en sus
  búsquedas es rechazo directo.
- **Sin acentos.** Las búsquedas llegan escritas de las dos formas y sin tilde
  ocupa lo mismo pero casa con más consultas.
- **Sin la categoría.** «Estilo de vida» ya se declara en su propio campo.

---

## Texto promocional (máx. 170, opcional)

Va sobre la descripción y **se puede cambiar sin enviar una versión nueva**:
es el sitio para anunciar un evento o un curso que empieza.

```
Nuevos episodios y encuentros cada semana. Entra, mira lo que se está
compartiendo y quédate si te resuena.
```
*(107 caracteres)*

---

## Descripción (máx. 4000)

```
Z es una comunidad de crecimiento personal donde cada día encuentras algo que
te mueve: una idea, una conversación o alguien que ya pasó por donde tú estás.

QUÉ VAS A ENCONTRAR

• Un muro con publicaciones de la comunidad: reflexiones, aprendizajes y
preguntas de personas que están en el mismo camino.

• Historias que duran 24 horas, para lo del día a día.

• Pódcast. Episodios para escuchar cuando quieras, también con la pantalla
apagada.

• Cursos y programas para trabajar en lo tuyo a tu ritmo, con módulos,
lecciones y material descargable.

• Eventos y encuentros, presenciales y en línea, con toda la información y el
acceso al grupo de cada uno.

• Reseñas y testimonios de la comunidad, en foto y video.

• Sesiones 1:1. Propón fecha y hora a quien quieras y acordad los detalles por
mensaje.

MIRA ANTES DE DECIDIR

No hace falta cuenta para empezar. Entra, recorre el muro, mira los perfiles y
los cursos. La cuenta se pide cuando quieras publicar, comentar, reaccionar,
guardar algo o escuchar el pódcast, porque esas cosas quedan a tu nombre.

TUYO, Y BAJO TU CONTROL

• Tu contenido es tuyo. Publicas y borras cuando quieras.
• Puedes bloquear a quien no quieras ver y denunciar lo que no corresponda.
• Puedes eliminar tu cuenta desde la propia aplicación, con todo tu contenido.
• Sin publicidad. Sin seguimiento con fines publicitarios.
• No pedimos tu ubicación ni acceso a tus contactos.

Z es un espacio para crecer acompañado. Te esperamos dentro.

Soporte: https://social-media-renaser.vercel.app/support
Privacidad: https://social-media-renaser.vercel.app/privacy
Condiciones: https://social-media-renaser.vercel.app/terms
```

*(~1.550 caracteres, muy por debajo del límite)*

### Por qué está escrita así

**Los primeros dos renglones son lo único que se ve** sin tocar «más». Por eso
no empiezan con la marca ni con una lista de funciones, sino con el motivo para
entrar.

**Sin viñetas decorativas ni mayúsculas gritadas.** Apple no las prohíbe, pero
una ficha que parece un anuncio envejece mal y no aporta nada a la búsqueda: la
descripción **no se indexa** en el App Store. Solo cuenta para convencer a quien
ya ha llegado.

**Nada sobre salud.** El texto habla de crecimiento personal y acompañamiento,
nunca de tratar, curar ni mejorar una condición médica. Cruzar esa línea activa
un escrutinio muy distinto, en las dos tiendas.

**Se dice que se puede entrar sin cuenta** porque es cierto y porque es un
argumento: quien duda se lo encuentra escrito antes de descargar.

> **Cuidado si algún día se activan las compras.** Mientras `FEATURE_PURCHASES`
> siga en `false` la app no vende nada, y la descripción no menciona precios ni
> pagos. En cuanto se encienda, esta ficha se queda corta y hay que declarar la
> compra integrada.

---

## Categoría

- **Principal:** Estilo de vida
- **Secundaria:** Salud y forma física — *no recomendada*. Encaja con el tema,
  pero pone la app en el radar de las normas de salud de Apple sin ganar nada a
  cambio. Mejor dejarla vacía o usar Educación.

---

## Clasificación por edad

**17+**, coherente con los términos, que declaran la plataforma para mayores de
18 años. En el cuestionario, lo que de verdad la determina es admitir que hay
**contenido generado por usuarios sin moderación previa**: eso por sí solo ya
sube la clasificación, y ocultarlo sería falsear el formulario.

---

## URLs de la ficha

| Campo | Valor |
|---|---|
| URL de soporte (obligatoria) | `https://social-media-renaser.vercel.app/support` |
| URL de política de privacidad | `https://social-media-renaser.vercel.app/privacy` |
| URL de marketing | *(opcional; dejar vacía hasta tener dominio propio)* |

Cuando haya dominio propio habrá que cambiarlas en los dos sitios: aquí y en
[`FICHA_PLAY_STORE.md`](FICHA_PLAY_STORE.md), que todavía apunta a
`renaser.pe`, un dominio que aún no existe.
