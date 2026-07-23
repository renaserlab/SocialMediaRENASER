# Páginas legales

Documentos que Google Play exige para publicar **Renaser Social Media**:

| Página | Para qué |
|---|---|
| `privacidad.html` | Política de Privacidad. **Obligatoria** para la ficha de Play. |
| `terminos.html` | Condiciones de Uso. |
| `eliminar-cuenta.html` | **Obligatoria** para apps que permiten crear cuenta. Play pide una URL accesible **sin instalar la app**. |
| `index.html` | Índice que enlaza las tres. |

> **Estos textos son borradores técnicos.** Describen con precisión lo que la
> aplicación hace —están escritos a partir del modelo de datos real, no de una
> plantilla—, pero **deben ser revisados por un profesional del derecho** antes
> de publicarse. Los apartados de pagos, responsabilidad y jurisdicción son los
> que más dependen del país y del negocio.

## Cómo publicarlas

### 1. Completar los datos de la empresa

```bash
cp legal/datos.ejemplo.json legal/datos.json
```

Edita `legal/datos.json` con los datos reales (razón social, dirección, correos,
país…). Ese fichero está en `.gitignore`: no se versiona.

### 2. Generar las páginas finales

```bash
node legal/rellenar.mjs
```

Sustituye los marcadores y escribe el resultado en `legal/publicar/`.

**El script falla a propósito si queda algún marcador sin resolver.** Publicar una
política con `[[RAZÓN SOCIAL]]` a la vista sería peor que no publicarla.

Hay dos clases de marcador:

- **Datos** (`RAZÓN SOCIAL`, `EMAIL_SOPORTE`, `PAÍS`…) → se rellenan en `datos.json`.
- **Decisiones editoriales** (textos largos en mayúsculas: qué hacer si no hay
  pagos, qué autoridad de control citar…) → **hay que editarlas a mano en el
  HTML**, porque no son un dato sino una decisión. Son 6 y el script las lista.

### 3. Subir a un alojamiento

El contenido de `legal/publicar/` es HTML estático sin dependencias: sirve
cualquier alojamiento. Opciones habituales, de menor a mayor esfuerzo:

- **GitHub Pages** — gratis. Subir la carpeta a un repositorio y activar Pages.
- **Netlify / Vercel** — gratis, arrastrando la carpeta.
- **El propio dominio de la empresa** — lo preferible, por imagen:
  `https://renaser.com/legal/privacidad.html`.

Lo importante es que las URLs sean **públicas, estables y accesibles sin iniciar
sesión**: Google las revisa automáticamente y también a mano.

### 4. Declararlas en Play Console

| Dónde | Qué URL |
|---|---|
| Ficha principal → Política de privacidad | `.../privacidad.html` |
| Política de la app → Seguridad de los datos → Eliminación de cuenta | `.../eliminar-cuenta.html` |

### 5. Enlazarlas desde la aplicación

Cuando existan las URLs definitivas, ponlas en
`apps/mobile/src/config/legal.ts`. La pantalla de Ajustes muestra los enlaces
automáticamente en cuanto ese fichero deja de estar vacío; mientras tanto no
aparecen, para no llevar a nadie a una página inexistente.

## Mantenimiento

Al cambiar un dato, edita `datos.json` y vuelve a ejecutar el script: los
originales con marcadores no se tocan, así que siempre se pueden regenerar.

Si la aplicación empieza a tratar datos nuevos (analítica, notificaciones push,
ubicación, pagos…), **hay que actualizar la política antes de publicar la
versión** que los incorpore, y revisar el formulario de Seguridad de los datos
en Play Console.
