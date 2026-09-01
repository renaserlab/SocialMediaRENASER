# Contratos — Mensajería, CRM ligero, perfil, cursos y eventos

Documento de coordinación de la ronda del **31 de agosto de 2026**. Fija lo que
más de un agente podría decidir por su cuenta y decidir distinto: números de
migración, nombres de tabla y columna, quién toca qué fichero.

**Ningún agente cambia lo que hay aquí sin decírselo al coordinador.** Si algo no
encaja al implementarlo, se avisa; no se improvisa otro nombre.

Rama de trabajo: `Edson`. Base: `aef9167`. `main` está en `38f829c`.

---

## 1. Migraciones — números cerrados

La última migración **aplicada contra producción** es `0043_avisos_sin_duplicar.sql`.

| Fichero | Dueño | Contenido |
|---|---|---|
| `0044_respuestas_a_historias_y_notas_de_voz.sql` | C | Contexto de mensaje para responder una historia, y `audio` como tipo de adjunto |
| `0045_etiquetas_de_conversacion.sql` | D | CRM: definiciones de etiqueta y asignaciones |
| `0046_...` | coordinador | Reservada para los índices que salgan de la medición. **Nadie más la crea.** |

**Ninguna se ejecuta contra producción.** Se dejan preparadas y validadas.

Cada migración es **aditiva**, no borra ni modifica filas existentes, y trae sus
comprobaciones de verificación comentadas al final, como las anteriores.

---

## 2. Reglas que no se negocian

1. **Todo lo nuevo degrada solo.** Antes de consultar una tabla que aún no
   existe se pregunta por ella en `app/modules/recommendations/esquema.py`
   (o el `esquema.py` del módulo). Sin la migración, la función responde vacío
   o «no disponible», **nunca un 500**. Un 500 sin capturar llega al navegador
   disfrazado de error de CORS y manda a mirar al sitio equivocado.

2. **Ninguna columna nueva en `messages`, `posts`, `conversations`, `profiles`
   ni `courses`.** `select(Entidad)` de SQLAlchemy pide TODAS las columnas
   mapeadas: una columna nueva en una tabla muy consultada rompe producción en
   cuanto el modelo se adelanta a la migración. Tabla aparte, siempre.

3. **Filtrar y buscar es cosa del servidor.** Nunca se filtra en React sobre la
   página ya cargada: con doscientas conversaciones, filtrar las veinte que hay
   en memoria es mentirle a quien busca. Todo filtro y toda búsqueda aceptan
   paginación.

4. **La identidad sale del JWT; el nombre y el rol salen de `profiles`.** El
   `role` del token de Supabase es siempre `"authenticated"`. Este fallo ha
   llegado a producción cuatro veces.

5. **`columna_uuid.in_(lista or [""])` está prohibido.** El `''` pasa en SQLite
   y asyncpg lo rechaza; el error acaba convertido en un 404 silencioso.
   Si la lista está vacía, se devuelve pronto.

6. **No se toca**: `package` (`com.renaser.zeta`), bundle id, scheme, AWS,
   pagos, RevenueCat, Stripe, proveedores de vídeo en vivo.

7. **Nada de datos**: ni `reset`, ni `DROP`, ni `TRUNCATE`, ni borrados masivos.

8. **Español en código y comentarios**, y los comentarios explican **el porqué**,
   no el qué. Si cambias un comportamiento, **actualiza o borra el comentario
   que dejó de ser verdad**: hay comentarios en `ProfileScreen` que afirman que
   el audio va antes de la descripción, y ese requisito ya cambió.

9. **Nunca un botón muerto.** Si algo no está disponible, la interfaz lo dice.

10. **No renombrar ni mover ficheros de `apps/mobile/app/`**: ahí la ruta *es* el
    fichero.

---

## 3. Nombres definitivos

### 0044 — responder una historia, y notas de voz

```
message_story_context(
  message_id      uuid primary key references messages(id) on delete cascade,
  story_id        uuid references stories(id) on delete set null,
  story_owner_id  uuid not null references profiles(id) on delete cascade,
  created_at      timestamptz not null default now()
)
```

`story_id` es **anulable y `on delete set null`** a propósito: una historia dura
un día y el mensaje que la responde dura para siempre. Cuando la historia
desaparece, el mensaje sigue existiendo y la burbuja muestra un contexto
degradado —«Historia no disponible»—, que es por lo que se conserva
`story_owner_id`: sin él no se podría ni decir de quién era.

`message_attachments.kind` pasa a admitir `'audio'`. Hoy el `CHECK` de la 0033
dice `('image', 'video', 'document')`. **No se guarda un audio como `document`
para no tocar el `CHECK`**: eso es el parche que el encargo prohíbe. La columna
`duration_s` ya existe en esa tabla y es la que lleva la duración de la nota.

### 0045 — etiquetas de conversación (CRM)

```
conversation_labels(
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references profiles(id) on delete cascade,
  nombre      text not null check (char_length(nombre) between 1 and 40),
  nombre_normalizado text not null,     -- minúsculas y sin espacios de sobra
  created_at  timestamptz not null default now(),
  constraint conversation_labels_unicas unique (owner_id, nombre_normalizado)
)

conversation_label_assignments(
  label_id        uuid not null references conversation_labels(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (label_id, conversation_id)
)
```

La clave primaria compuesta es lo que hace **idempotente** asignar dos veces la
misma etiqueta: no hace falta comprobarlo en código.

Borrar una etiqueta se lleva sus asignaciones por `cascade` y **no toca ninguna
conversación**.

**RLS.** Las dos tablas la llevan activada y las políticas van contra
`owner_id = auth.uid()` (para las asignaciones, mediante la etiqueta). Además,
el backend exige que quien etiqueta **sea miembro de la conversación**: sin eso,
alguien podría etiquetar conversaciones ajenas y averiguar por respuesta cuáles
existen.

**La etiqueta que A le pone a su conversación con B no la ve B jamás.** No
aparece en ningún endpoint que B pueda llamar, ni en el detalle de la
conversación, ni en la lista. Es requisito, no preferencia.

---

## 4. Reparto de ficheros

Los agentes trabajan **en el mismo árbol**, así que dos agentes en el mismo
fichero se pisan. El reparto es estricto.

### Agente A — cursos, eventos y perfil
- `apps/api/app/modules/catalog/**`
- `apps/mobile/src/screens/ProfileScreen.tsx`
- `apps/mobile/src/components/OfertaDelPerfil.tsx`
- `apps/mobile/src/screens/EventsScreen.tsx`
- `apps/mobile/src/screens/ExploreScreen.tsx` (barra de búsqueda y secciones de eventos)
- `apps/mobile/src/screens/CourseScreen.tsx` y editor de contenido de curso
- pruebas nuevas propias

### Agente D — CRM de etiquetas
- `apps/api/app/modules/messaging/etiquetas.py` (**nuevo**)
- `supabase/migrations/0045_etiquetas_de_conversacion.sql` (**nuevo**)
- `apps/mobile/src/repositories/EtiquetasRepository.ts` (**nuevo**)
- `apps/mobile/src/components/GestorDeEtiquetas.tsx` (**nuevo**)
- `apps/mobile/src/components/ChipsDeEtiquetas.tsx` (**nuevo**)
- toca `messaging/router.py` **solo** para incluir su sub-router, y
  `messaging/esquema.py` para añadir su comprobación
- **NO toca `MessagesScreen.tsx`.** Entrega componentes que B monta.

### Agente B — bandeja de mensajes (rediseño, historias, búsqueda, filtros)
- `apps/mobile/src/screens/MessagesScreen.tsx` y componentes nuevos de bandeja
- `apps/api/app/modules/messaging/router.py` (endpoint de lista) y `lectura.py`
- `apps/api/app/modules/messaging/schemas.py`
- monta los componentes de D

### Agente C — chat, respuestas a historias y notas de voz
- `apps/mobile/src/screens/ChatScreen.tsx`
- `apps/api/app/modules/messaging/historias.py` y `audio.py` (**nuevos**)
- `supabase/migrations/0044_...sql` (**nuevo**)
- visor de historias, en la parte de responder

### Agente E — medición
- **Solo lee.** No modifica código.
- Escribe `docs/Z_MEDICION_MENSAJES_EXPLORE.md`

---

## 5. Contrato de la bandeja (lo que B expone y D consume)

`GET /api/v1/conversations` acepta, además de lo que ya acepta:

- `q` — texto de búsqueda. Busca por nombre y por usuario de la otra persona.
  Con paginación; **no** se traen todos los mensajes al teléfono.
- `filtro` — uno de `unread` | `unanswered` | `story_replies`. Son **estados
  derivados**, no etiquetas.
- `label_id` — filtra por etiqueta del CRM. Es una **categoría persistente**.

`filtro` y `label_id` son ejes distintos y se pueden combinar. **No se guarda
«no leído» como una etiqueta manual**: mezclar un estado derivado con una
categoría persistente es lo que convierte un CRM en un cajón de sastre.

Definiciones exactas:

- **No leídos** — la conversación tiene mensajes posteriores a `last_read_at` de
  quien mira.
- **No respondidos** — el último mensaje vigente lo mandó la otra persona y
  quien mira no ha escrito nada después.
- **Respuestas a historias** — la conversación contiene algún mensaje con fila en
  `message_story_context`. Si la 0044 no está aplicada, este filtro **no se
  ofrece** en la interfaz (nunca un botón muerto).

---

## 6. Lo que ya está hecho y no se rehace

Reseñas de perfiles · agenda y no autoagendarse · borrar mensajes propios ·
audio que sonaba fuera de Inicio · formatos de vídeo · republicar (incluida su
mezcla en el muro, `aef9167`) · historias de 30 s y su recorte en el servidor ·
botón Publicar · búsqueda global (`8fffb2e`) · teclado en formularios · idiomas ·
foto de perfil en Android.

Si esta ronda toca algo de eso, primero se lee la implementación y se
**evoluciona**. Si hay una regresión real, se corrige. No se sustituye una
solución que funciona por otra arquitectura por preferencia.

---

## 7. Verificación

Antes de dar nada por terminado, cada agente ejecuta lo que corresponda a su
parte y deja los números en su informe:

```
apps/api/.venv/Scripts/python.exe -m pytest -q          # NUNCA "python -m pytest"
npm --workspace apps/mobile run check
npm --workspace apps/mobile run test
```

`python -m pytest` a secas ha dado salida 0 con «No module named pytest»: un
verde falso. Se usa siempre el intérprete del entorno virtual.

Línea base de esta ronda: **1282** pruebas de backend, **479** de móvil,
**0** errores de TypeScript.

---

## 8. Hallazgos de la auditoría previa (los reparte el coordinador)

### `GET /stories` trae las historias de TODO EL MUNDO

`app/modules/stories/router.py`, `list_stories`. La consulta es literalmente:

```python
select(Story, Profile).join(Profile, ...).where(Story.expires_at > now)
```

Sin filtro de seguidos, **sin filtro de bloqueo** y sin paginación. Tres
consecuencias, la segunda grave:

1. **Escala mal.** Con mil personas publicando, la fila de historias de la
   bandeja se traería las mil. El encargo pide expresamente que abrir Mensajes
   no cueste diez consultas más; traerse el censo entero es peor que eso.
2. **Las historias de alguien a quien bloqueaste se ven.** La API lee con
   identidad de servicio, que **se salta la RLS**, así que la política de la
   tabla no la salva: el corte tiene que estar en la consulta, como en el muro
   (`blocked_either_way`). Esto es un fallo real, no una mejora.
3. No distingue «de quien sigo», que es justo lo que la bandeja necesita.

**Dueño: agente B.** Se le añade `apps/api/app/modules/stories/router.py` a su
reparto. El agente C **no** toca ese fichero: su parte de historias es el visor
del móvil y responder desde él.

El componente `apps/mobile/src/components/StoriesRow.tsx` **ya existe** y el
endpoint **ya agrupa por autor** (`StoryGroupRead`) y **ya sabe si la has
visto** (`viewed_by_me`, `seen`). No se construye un segundo sistema de
historias: se reutiliza este.

---

## 9. Segunda mitad de la ronda — estado y orden (actualizado)

### Dónde estamos

`main` está en `d0f99b5` y ya lleva la primera mitad: cursos, eventos, perfil,
republicaciones en el muro y el CRM. `Edson` está en `d48fdda`.

**Migraciones aplicadas en producción: hasta la 0043, y la 0045.** La 0044 no
existe todavía; es de esta mitad.

Verificación vigente: **1343** pruebas de backend, **519** de móvil, **0**
errores de TypeScript, `expo-doctor` 18/18, la web exporta.

### El orden cambia: C antes que B

Estaba escrito al revés y era un error, por dos razones:

1. **Dependencia real.** El filtro «Respuestas a historias» de la bandeja (B)
   necesita `message_story_context`, que crea C. Sin ella, B tendría que
   inventarse el contrato o dejar el filtro a medias.
2. **El mismo fichero.** Los dos tocan `messaging/router.py`. Trabajan en el
   mismo árbol, así que a la vez se pisan: el segundo en guardar borra al
   primero.

**C primero, B después.** No se solapan en el tiempo.

### `GET /stories` lo arregla el coordinador, no B

Se saca del reparto de B y lo hace el coordinador mientras C trabaja: es un
fallo de seguridad —las historias de alguien a quien bloqueaste se ven— y no
conviene que espere su turno. Ver el apartado 8.

### Dos cosas que pidió el encargo, literales

> «evita arruinar comportamientos internos»

El chat ya tiene paginación de historial, Realtime, deduplicación, adjuntos
privados, interfaz optimista, reintento y borrado con lápida. **El rediseño no
justifica reescribir el motor del chat.** Se cambia la apariencia y se añade lo
nuevo; lo que funciona se conserva. Si algo hay que tocar por dentro, se dice en
el informe con el motivo.

> «evita que posibles nuevas migraciones generen nuevos bugs»

La 0044 tiene un punto delicado y uno solo: **cambiar el `CHECK` de
`message_attachments.kind`**. Hoy es `('image','video','document')` y tiene que
admitir `'audio'`. Reglas para que eso no muerda:

1. Se hace `alter table ... drop constraint if exists` y después `add
   constraint`. Al reponerlo, Postgres **revalida la tabla entera**: es seguro
   porque los valores existentes son los tres de siempre, pero hay que saberlo.
2. El nombre del `CHECK` no se inventa: se busca el que tiene puesto. Un `drop`
   con el nombre equivocado no falla —lleva `if exists`— y deja el `CHECK` viejo
   en su sitio, así que el `add` posterior sí falla, o peor, la restricción vieja
   sigue rechazando los audios en silencio. **Comprobarlo con `pg_constraint`
   antes de escribir la migración es parte del trabajo.**
3. **El código NO puede escribir `'audio'` antes de que la migración esté
   aplicada.** Sería una violación de restricción, o sea un 500, o sea un error
   de CORS en el navegador. Hace falta la comprobación de esquema de siempre, y
   mientras diga que no: la interfaz **no ofrece** grabar (nunca un botón
   muerto), no guarda el audio como `document` para disimular.
4. Nada de columnas nuevas en `messages`. El contexto de la historia va en su
   tabla, por `message_id`.

---

## 10. Lo que el agente B se encuentra ya hecho

### `GET /api/v1/stories` — arreglado y con lo que la bandeja necesita

Ya está en `a09c0e6`. La fila de historias de Mensajes **se pide por aquí**, no
por `StoryRepository`: son 1 consulta y 1 salto de red, contra los **4 saltos
seguidos (~1,7 s)** del camino de Supabase directo. Está medido.

```
GET /api/v1/stories?feed=following&limit=20
```

- `feed` — `all` (por omisión, lo de siempre) o `following`. En `following`
  entran los seguidos **y las propias**: nadie se sigue a sí mismo y la primera
  burbuja de la fila es la tuya.
- `limit` — cuenta **AUTORES**, no historias. Por omisión 50, máximo 200.
  Medido: sin tope, 500 autores son **534 KB**.
- Los bloqueos ya se cortan en los dos sentidos. **No los repitas en el cliente.**
- La respuesta ya viene agrupada por autor (`StoryGroupRead`), ya sabe si la has
  visto (`viewed_by_me`, `seen`) y ya ordena: propias primero, después las que
  faltan por ver.

`apps/mobile/src/components/StoriesRow.tsx` **ya existe**. No construyas un
segundo sistema de historias: reutilízalo.

### Lo que dice la medición sobre la bandeja

`docs/Z_MEDICION_MENSAJES_EXPLORE.md`, apartado 6, tiene doce recomendaciones
con su número. Las que no son opinables:

- **Conserva las 4 consultas.** Son cuatro con 3 conversaciones y con 80. Las
  etiquetas del CRM se resuelven con **una** consulta más y un `IN` sobre los
  ids de la página, igual que ya hacen `otros_participantes` y `no_leidos`. Una
  consulta por conversación serían 24 con 20 filas.
- **Bandeja e historias, en paralelo.** Nunca encadenadas: 1 salto (~0,42 s)
  contra 2.
- **Los filtros derivados, dentro de la consulta que ya se hace.** `no_leidos`
  ya calcula el umbral y `ultimos_mensajes` ya sabe quién escribió el último:
  son **+0 consultas**.
- **Reutiliza `lib/busquedaProgresiva.ts`** para la búsqueda en servidor. Ya
  está escrito y probado. Sin antirrebote, «martinez» son 8 peticiones.
- **`useMemo` en la lista filtrada, `useCallback` en `renderItem`, `React.memo`
  en la fila, y el buscador en su propio componente.** Hoy se repintan ~8 filas
  **por cada tecla**.
- **No bajes el tamaño de página.** 4 consultas con `limit=10` y con `limit=80`.

### Lo que NO se toca sin medir antes

Los carruseles «para ti» reservan alto, enseñan esqueleto y desaparecen si
vienen vacíos. Parece un arreglo obvio y **no lo es**: si suelen traer
contenido, el esqueleto está haciendo su trabajo —reserva el hueco para que al
llegar no empuje la página—, y quitarlo cambiaría un salto por otro en sentido
contrario. La medición **no pudo comprobar** si vienen vacíos en producción
(esos endpoints exigen sesión y devuelven 401). Sin ese dato, no se toca.
