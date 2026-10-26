# Contratos — Temas y Comunidades de un grupo

Documento de coordinación de la ronda del **26 de octubre de 2026**. Fija lo que
más de un agente podría decidir por su cuenta y decidir distinto: nombres de
tabla y columna, rutas, formas de las respuestas y quién toca qué fichero.

**Nadie cambia lo que hay aquí sin avisar al coordinador.** Si algo no encaja
al implementarlo, se avisa; no se improvisa otro nombre.

Rama de trabajo: `feature/temas-y-comunidades`, que sale de `main` (`dee0c47`).
El prototipo aprobado (la «Opción B» del lienzo) está en
https://claude.ai/artifact/Rptzja2P6AcfTZXjHuh9Gx. Es privado: hay que pedir acceso.

---

## 0. Qué es cada cosa

Un **grupo** de Zeta (`conversations.kind = 'group'`) puede organizarse como en
Telegram. Al abrirlo se ve una lista con estas filas:

- **General**: el chat del propio grupo. Es el que ya existe y no cambia.
- **Temas**: los ven todos los miembros del grupo, sin unirse. En un tema solo
  hay dos cosas:
  - **referencias** a mensajes de General que la administración eligió (el
    mismo mensaje, no una copia);
  - **mensajes propios del tema**, que escribe solo la administración y que
    NO salen en General.

  Los miembros leen los temas pero no escriben en ellos.
- **Comunidades** (en el código, `subgroups`): grupos hijos, cada uno con su
  chat, su historial y sus miembros. Estar en el grupo no te mete en ninguna:
  cada persona entra en las que quiere.

En el código las comunidades se llaman `subgroups` porque ya existe el módulo
`communities`, que son los círculos de Explorar. En la interfaz se llaman
«Comunidades», y al padre se le llama «grupo».

### Decisiones cerradas (26/10/2026)

| # | Decisión |
|---|---|
| D1 | Quien entra en una comunidad ve todo su historial. |
| D2 | Cada comunidad elige cómo se entra: `open` (un toque) o `request` (pide y decide la administración). |
| D3 | Vaciar General NO vacía los temas para esa persona: la lectura de un tema no aplica el `cleared_at` de General. |
| D4 | **Quien administra un grupo puede borrar mensajes de otros** en ese grupo, en sus comunidades y en sus temas (borrado suave, como hoy). |
| D5 | **Se puede eliminar una comunidad** (por si se creó por error). Es un borrado suave: se marca `deleted_at` y se quitan todos sus miembros. Los mensajes se quedan en la base, inaccesibles. |
| D6 | Un solo administrador: quien creó el grupo (`vistas.administra`). No hay roles. |
| D7 | «Fotos, archivos y enlaces» (vistas 0102) se mantiene tal cual. |
| D9 | Añadir una referencia a un tema NO manda push. |
| D10 | Quien sale del grupo, o a quien sacan de él, sale también de todas sus comunidades y de los chats de sus temas, en la misma transacción. |
| D11 | La administración escribe directamente en un tema, y eso NO sale en General. |
| D12 | Las comunidades no salen sueltas en la bandeja de la app nueva: viven dentro del grupo, como en Telegram (ver § 4.3 sobre las versiones antiguas). |
| D14 | Lo que la administración escribe en un tema manda push a todo el grupo, salvo a quien tenga el GRUPO silenciado. |
| D15 | Eliminar un tema borra también (borrado suave) lo escrito solo en él. |
| D16 | Se puede reaccionar a lo que hay en un tema, con las reacciones de la 0106 tal cual. |

---

## 1. Cómo se guarda lo escrito en un tema (y por qué)

Cada tema tiene un **chat propio** (`conversation_topics.chat_id`): una fila
normal de `conversations` con `kind = 'group'`, título igual al nombre del tema
y `created_by` igual a quien administra el grupo. **Sus miembros son los mismos
que los del grupo**, y se mantienen sincronizados en la misma transacción que
cualquier cambio de miembros del grupo (§ 3).

Así, todo lo que ya existe funciona sin tocarlo: adjuntos, almacenamiento, RLS,
tiempo real, push, lecturas y reacciones. Y lo escrito en un tema nunca llega a
General.

**Se descartó guardarlo en General con una marca.** `ChatScreen` pinta al
instante la fila que llega por Realtime (`subscribeToConversation`), antes de
preguntar a la API. El anuncio aparecería en General, y en las versiones de la
app ya instaladas se quedaría ahí.

El chat de un tema:

- **NO** sale nunca en `GET /conversations` (§ 4.3).
- **Solo acepta mensajes de quien administra el grupo.** Los demás reciben
  403 `topic_admin_only` en `POST /conversations/{chat_id}/messages`.
- **No puede tener temas, comunidades, filtros ni solicitudes de entrada.**

---

## 2. Migraciones — números cerrados

La última en `main` es `0107_preferencias_de_conversacion.sql`.

| Fichero | Dueño | Contenido |
|---|---|---|
| `0108_temas_de_grupo.sql` | Agente T | `conversation_topics`, `conversation_topic_items`, `conversation_topic_views` |
| `0109_comunidades_de_grupo.sql` | Agente C | `group_subgroups` |

Las dos son **aditivas e idempotentes**, siguiendo las reglas de las demás:

- `create table if not exists`;
- RLS activada y **sin políticas** (solo la API lee y escribe, como en la 0098 a la 0107);
- terminan con `notify pgrst, 'reload schema'` y un `select` de comprobación;
- llevan comentarios de verificación y de vuelta atrás al final.

**Ninguna se ejecuta contra producción.** Se dejan preparadas y probadas.

### 0108

```sql
conversation_topics(
  id                 uuid primary key default gen_random_uuid(),
  conversation_id    uuid not null references conversations(id) on delete cascade, -- el grupo
  chat_id            uuid not null unique references conversations(id) on delete cascade, -- el chat propio del tema
  nombre             text not null check (char_length(nombre) between 1 and 40),
  nombre_normalizado text not null,
  icono              text not null default 'folder',
  posicion           int  not null default 0,
  created_by         uuid references profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  check (chat_id <> conversation_id)
)
-- único parcial: (conversation_id, nombre_normalizado) where deleted_at is null
-- índice: (conversation_id) where deleted_at is null

conversation_topic_items(            -- referencias a mensajes de General
  topic_id        uuid not null references conversation_topics(id) on delete cascade,
  message_id      uuid not null references messages(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade, -- el grupo, repetido
  added_by        uuid references profiles(id) on delete set null,
  added_at        timestamptz not null default now(),
  primary key (topic_id, message_id)
)
-- índices: (topic_id, added_at) y (message_id)

conversation_topic_views(            -- hasta cuándo vio cada persona las referencias de un tema
  topic_id    uuid not null references conversation_topics(id) on delete cascade,
  user_id     uuid not null references profiles(id) on delete cascade,
  visto_hasta timestamptz not null,
  primary key (topic_id, user_id)
)
```

### 0109

```sql
group_subgroups(
  conversation_id uuid primary key references conversations(id) on delete cascade, -- la comunidad
  parent_id       uuid not null references conversations(id) on delete cascade,     -- el grupo
  descripcion     text not null default '' check (char_length(descripcion) <= 200),
  entrada         text not null default 'open' check (entrada in ('open', 'request')),
  posicion        int  not null default 0,
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  check (conversation_id <> parent_id)
)
-- índice: (parent_id) where deleted_at is null
```

`esquema.hay_temas()` y `esquema.hay_comunidades()` **ya existen**: los dejó el
coordinador. Sin la migración, las lecturas responden vacío y las escrituras
503 (`topics_unavailable` / `subgroups_unavailable`). **Nunca un 500.**

---

## 3. Reglas que no se negocian

Son las mismas de `CONTRATOS_MENSAJERIA_Y_CRM.md` § 2:

1. **Todo lo nuevo degrada solo.** Se pregunta por la tabla en `esquema.py`
   antes de consultarla.
2. **Ninguna columna nueva en `messages`, `conversations`,
   `conversation_members`, `profiles`.** Siempre en tabla aparte.
3. **Filtrar y buscar es cosa del servidor**, siempre con paginación.
4. **La identidad sale del JWT, y el rol, de `profiles`** (`is_admin`), nunca
   del token.
5. **`columna.in_(lista or [""])` está prohibido.** Si la lista está vacía, se
   devuelve pronto.
6. **No se toca:** `package`, bundle id, scheme, AWS, pagos, RevenueCat, Stripe
   ni los proveedores de vídeo.
7. **Nada de datos:** ni `reset`, ni `DROP`, ni `TRUNCATE`, ni borrados masivos.
   Nada se ejecuta contra Supabase.
8. **Español en código y comentarios**, y los comentarios explican el porqué.
9. **Nunca un botón muerto.**
10. **No renombrar ni mover ficheros de `apps/mobile/app/`.** Añadir rutas
    nuevas sí está permitido (§ 6).
11. **No hacer `git commit`, `git push` ni cambiar de rama.** El coordinador
    integra.

**Bloqueos.** Se aplican las mismas reglas que en los grupos
(`grupos.exigir_que_se_puedan_anadir`, `entrada_a_grupos._hay_bloqueo`): a quien
tiene un bloqueo con quien administra, la comunidad no le «existe». La
respuesta es la misma 404 que si no existiera.

**Un solo nivel.** No hay temas ni comunidades dentro de una comunidad ni dentro
del chat de un tema. Intentarlo responde 409 `not_a_top_level_group`.

---

## 4. API

Todo cuelga de `/api/v1/conversations`. `{group_id}` es siempre el grupo padre.

### 4.1 Temas — `messaging/temas.py` (Agente T)

Forma de un tema en las respuestas (`TemaLeido`):

```json
{
  "id": "uuid",
  "name": "Anuncios",
  "icon": "bell",
  "position": 0,
  "chat_id": "uuid",
  "references": 3,
  "own": 1,
  "unseen": 2,
  "contains": null,
  "last": { "sender_name": "Ana Torres", "excerpt": "Recuerden…", "kind": "text", "at": "2026-10-26T10:25:00Z", "own": true }
}
```

- `icon` sale de una lista cerrada: `folder`, `bell`, `video`, `mic`, `link`,
  `image`, `file-text`, `star`, `book`, `calendar`. Un icono desconocido se
  guarda como `folder`.
- `references` y `own` cuentan solo mensajes vivos (`deleted_at is null`).
- `unseen` es lo que la persona que pregunta no ha visto, sumando dos cosas:
  - las referencias que añadió OTRA persona después de su `visto_hasta`;
  - los mensajes propios del tema de OTRA persona posteriores a su
    `last_read_at` en el chat del tema.

  Si nunca abrió el tema, cuenta lo añadido después de que entró al grupo
  (`conversation_members.joined_at`): quien llega nuevo empieza en cero.
- `last` es lo último del tema por orden de llegada: `added_at` en una
  referencia y `created_at` en un mensaje propio. Vale `null` si el tema está
  vacío. `kind` toma el tipo del primer adjunto, `link` si el texto lleva una
  URL o `text` en otro caso.

| Método | Ruta | Quién | Respuesta / qué hace |
|---|---|---|---|
| GET | `/{group_id}/topics[?message_id=]` | miembros del grupo | `{"available": bool, "can_manage": bool, "topics": [TemaLeido]}`, ordenados por `position` y después `created_at`. Con `message_id`, cada tema trae `contains: true/false`. |
| POST | `/{group_id}/topics` | admin | Cuerpo `{"name", "icon"?}` → `TemaLeido` (201). En una transacción crea el chat propio y mete en él a todos los miembros actuales del grupo. Responde 409 `topic_name_taken` y 409 `topics_limit` (20 por grupo). |
| PATCH | `/{group_id}/topics/{topic_id}` | admin | Cuerpo `{"name"?, "icon"?, "position"?}` → `TemaLeido`. Renombrar cambia también el `title` del chat propio. |
| DELETE | `/{group_id}/topics/{topic_id}` | admin | 204 (D15). Marca `deleted_at`, borra en suave los mensajes de su chat y quita a todos los miembros de ese chat. Las referencias no tocan General. |
| GET | `/{group_id}/topics/{topic_id}/messages?before=&limit=` | miembros del grupo | `{"items": [TemaMensaje], "has_more": bool}`. `limit` vale 30 por omisión y como mucho 60. Devuelve los `limit` más recientes con `order_at < before`, ordenados de antiguo a reciente. Ni los borrados ni el `cleared_at` de General (D3). |
| POST | `/{group_id}/topics/{topic_id}/seen` | miembros del grupo | 204. Hace un upsert de `visto_hasta = now()` y pone `last_read_at = now()` en el chat del tema. |
| PUT | `/{group_id}/topics/{topic_id}/items/{message_id}` | admin | 204, idempotente. El mensaje tiene que ser de General y estar vivo; si no, 404 `message_not_in_group`. Sin push (D9). |
| DELETE | `/{group_id}/topics/{topic_id}/items/{message_id}` | admin | 204. Se quita la referencia y el mensaje sigue en General. |

`TemaMensaje` es `MessageRead`, con sus adjuntos, reacciones y cita, más estos
campos:
`own: bool`, `added_by: AuthorSummary | null`, `added_at: datetime | null`,
`order_at: datetime`. **El `conversation_id` de cada mensaje es el de verdad**:
General si es una referencia y `chat_id` si es propio. Es el que la app usa
para reaccionar y para borrar.

**Lo que `temas.py` ofrece a los demás módulos** (firmas cerradas: el Agente C
las llama):

```python
async def tema_de_chat(db, conversation_id: str) -> tuple[str, str] | None
    """(group_id, topic_id) si es el chat de un tema vivo; si no, None. Sin la 0108, None."""

async def chats_de_temas(db, group_id: str) -> list[str]
    """chat_id de los temas vivos del grupo. Sin la 0108, []."""

def condicion_no_es_chat_de_tema(columna) -> ColumnElement[bool]
    """NOT EXISTS sobre conversation_topics.chat_id. Quien la usa comprueba antes hay_temas()."""

async def sincronizar_miembros(db, group_id: str, user_ids: list[str], dentro: bool) -> None
    """Mete o saca a esas personas de los chats de TODOS los temas vivos del grupo.
    Sin commit: lo hace quien llama, en su transacción. Sin la 0108, no hace nada."""

async def no_leidos_de_temas(db, group_id: str, uid: str) -> int
    """Mensajes propios de temas, de otras personas, posteriores a su last_read_at. Sin la 0108, 0."""
```

### 4.2 Comunidades — `messaging/subgrupos.py` (Agente C)

Forma de una comunidad (`ComunidadLeida`):

```json
{
  "id": "uuid",
  "title": "Valorant",
  "avatar_path": null,
  "description": "",
  "entry": "open",
  "position": 0,
  "members_count": 3,
  "is_member": true,
  "request_pending": false,
  "pending_requests": 0,
  "unread_count": 1,
  "last": { "sender_name": "Bruno Díaz", "excerpt": "Hoy a las 9…", "kind": "text", "at": "…" }
}
```

`pending_requests` solo se rellena para el admin (si no, 0). `unread_count` y
`last` solo se rellenan si `is_member`: quien no está dentro no ve mensajes.

| Método | Ruta | Quién | Respuesta / qué hace |
|---|---|---|---|
| GET | `/{group_id}/subgroups` | miembros del grupo | `{"available": bool, "can_manage": bool, "subgroups": [ComunidadLeida]}`. Solo las vivas. |
| POST | `/{group_id}/subgroups` | admin | Cuerpo `{"title" (1–60), "description"? (≤200), "entry"?}` → `ComunidadLeida` (201). Crea el grupo (`created_by` = admin, que queda como único miembro) y la fila de `group_subgroups`. Usa los topes de `grupos.py`. |
| PATCH | `/{group_id}/subgroups/{sub_id}` | admin | Cuerpo `{"title"?, "description"?, "entry"?, "position"?}` → `ComunidadLeida`. |
| DELETE | `/{group_id}/subgroups/{sub_id}` | admin | 204 (D5). Marca `deleted_at` y quita a todos sus miembros. |
| POST | `/{group_id}/subgroups/{sub_id}/join` | miembros del grupo | 204 si es `open`; responde 409 `subgroup_requires_request` si es `request`. A quien no es del grupo, o tiene un bloqueo con el admin, se le responde 404. |

El resto **reutiliza rutas que ya existen**, con estos cambios:

- **`POST /{sub_id}/join-requests`**: ser miembro del grupo padre cuenta como
  forma de llegar a la comunidad, sin enlace ni perfil.
- **`DELETE /{sub_id}/members/{uid}`**: salir de la comunidad o que te saquen.
  Sin cambios.
- **`POST /{sub_id}/members`** (añadir): cada persona añadida tiene que ser ya
  miembro del grupo padre. Si no lo es, se usa el mismo error genérico de hoy.

### 4.3 Cambios en rutas que ya existen (Agente C)

- **`GET /conversations`**:
  - Los chats de temas NO salen nunca.
  - Con `?grouped=true` (lo manda la app nueva) tampoco salen las comunidades
    (D12), y cada grupo trae `topics_count`, `subgroups_count` y
    `total_unread`.
  - `total_unread` suma tres cosas: los no leídos de General, los de las
    comunidades donde estás y `temas.no_leidos_de_temas`.
  - Sin `grouped` (las versiones ya instaladas), las comunidades salen como
    grupos normales, para que nadie pierda el acceso, y `total_unread` es igual
    a `unread_count`.
  - Campos nuevos de `ConversationRead`, todos con valor por omisión:
    `parent_id: str | None`, `topics_count: int = 0`,
    `subgroups_count: int = 0` y `total_unread: int = 0`.
- **`GET /{id}/info`** (`InfoDeConversacion`) añade:
  - `parent: {id, title} | null`, si es una comunidad;
  - `topic: {group_id, topic_id, name} | null`, si es el chat de un tema (sirve
    para que un push abra el tema y no un chat suelto).
- **`GET /availability`** añade `topics: bool` y `subgroups: bool`.
- **`POST /{id}/messages`**: en el chat de un tema solo escribe quien
  administra el grupo; a los demás, 403 `topic_admin_only`.
- **`DELETE /{id}/messages/{mid}`** (D4): además del autor y de moderación,
  puede borrar quien administra la conversación (`vistas.administra`).
- **Miembros (D10)**:
  - **Salir del grupo o que te saquen** (`grupos.quitar_miembro` sobre un grupo
    padre) saca también de todas sus comunidades y llama a
    `temas.sincronizar_miembros(..., dentro=False)`.
  - **Entrar al grupo** (`anadir_miembros` y `aceptar_solicitud` sobre un grupo
    padre) llama a `temas.sincronizar_miembros(..., dentro=True)`.
  - Todo va en la misma transacción.
- **Avisos (D14)**: un mensaje en el chat de un tema avisa a sus miembros
  (los del grupo), quitando a quien tenga silenciado el GRUPO, además de a
  quien tenga silenciado el propio chat.
- **No anidar**: crear grupos, temas o comunidades, filtros (0102) o
  solicitudes de entrada sobre una comunidad o sobre el chat de un tema
  responde 409 `not_a_top_level_group`, donde aplique.

### 4.4 Tiempo real (app)

- **Lo escrito en un tema**: se escucha `subscribeToConversation(chat_id)`, que
  ya existe.
- **Referencias**: no se escucha nada nuevo. Quien añade o quita una referencia
  manda un aviso sin contenido por difusión en `chat-temas:{group_id}`
  (evento `temas`), igual que `avisosDeReacciones`. Quien tiene abierta la
  lista o un tema vuelve a preguntar.

---

## 5. Reparto de ficheros

Los agentes trabajan **en el mismo árbol**, así que el reparto es estricto. Un
fichero que no es tuyo no se toca. Si necesitas un cambio en él, lo pides en tu
informe final.

### Agente T — temas (servidor)
- `supabase/migrations/0108_temas_de_grupo.sql` (**nuevo**)
- `apps/api/app/modules/messaging/temas.py` (ya existe como esqueleto: los
  modelos de SQLAlchemy de sus tres tablas van DENTRO de este fichero)
- `apps/api/tests/test_temas_de_grupo.py` y
  `apps/api/tests/test_temas_sin_migracion_0108.py` (**nuevos**)

### Agente C — comunidades e integración (servidor)
- `supabase/migrations/0109_comunidades_de_grupo.sql` (**nuevo**)
- `apps/api/app/modules/messaging/subgrupos.py` (ya existe como esqueleto: el
  modelo de `group_subgroups` va DENTRO de este fichero)
- `messaging/router.py`, `schemas.py`, `lectura.py`, `grupos.py`,
  `entrada_a_grupos.py`, `avisos.py`, `vistas.py` (lo justo para no anidar)
- `apps/api/tests/test_comunidades_de_grupo.py`,
  `apps/api/tests/test_comunidades_sin_migracion_0109.py` y
  `apps/api/tests/test_admin_borra_mensajes.py` (**nuevos**)
- **No toca `temas.py`**: llama a sus funciones del § 4.1.

### Agente M — aplicación
- Todo lo de `apps/mobile/`. Nada del servidor.
- Rutas nuevas (añadidas, ninguna se mueve):
  - `apps/mobile/app/chat/lista/[id].tsx`: la lista del grupo;
  - `apps/mobile/app/chat/tema/[id].tsx`: un tema, con `id` = grupo y el
    parámetro `tema` = topic_id.

### Coordinador
- `esquema.py` (ya hecho), la inclusión de los dos sub-routers en `router.py`
  (ya hecha), este documento, la integración final y la documentación.

---

## 6. Validación de cada agente antes de entregar

- **Servidor**: `cd apps/api && .venv/bin/python -m pytest -q` sobre los tests
  propios y los de mensajería relacionados (`tests/test_grupos*`,
  `test_entrada_a_grupos.py`, `test_reacciones*`, `test_bloqueo_y_borrado_de_mensajes.py`,
  `test_vistas_de_conversacion.py`, `test_bandeja_*`, `test_aviso_de_mensaje.py`,
  `test_preferencias_de_conversacion.py`). Las pruebas que dependen del otro
  agente pueden fallar mientras él no termine: dilo en el informe y no las
  borres.
- **App**: `cd apps/mobile && npx tsc --noEmit` sin errores, más
  `node --test` sobre las pruebas `.mts` nuevas y las de `src/i18n`
  (`diccionariosSincronizados`, `castellanoDelPeru`, `clavesUsadasExisten`).

---

## 7. Cómo quedó (integración del 26/10/2026)

Implementado en la rama `feature/temas-y-comunidades`. Lo que cambió o se
precisó respecto a lo de arriba:

- **RLS de `messages_insert` (0108).** La política de la 0001 dejaba a
  cualquier miembro insertar con la clave del cliente y saltarse el 403
  `topic_admin_only`. La 0108 la rehace igual, más una condición: en el chat de
  un tema solo inserta quien lo creó. Su vuelta atrás está en los comentarios
  de la migración.
- **Códigos que el contrato no fijaba.** Gestionar temas sin administrar da 403
  `topic_admin_only`; un tema que no existe o es de otro grupo da 404
  `topic_not_found`. `DELETE` de un tema ya eliminado responde 204.
- **`GET /topics`** sobre un directo, una comunidad o el chat de un tema
  responde `available: false` con la lista vacía, en vez de un error.
- **`total_unread`** se calcula por lotes en `lectura.temas_de_la_pagina`, con
  la misma regla que `temas.no_leidos_de_temas`. Una prueba comprueba que las
  dos cifras coinciden.
- **Las solicitudes a una comunidad** se guardan con `source = 'profile'`,
  porque el `CHECK` de la 0104 no admite otro valor. La app las rotula «Lo pidió
  desde el grupo».
- **Salir del grupo** también cancela las solicitudes pendientes a sus
  comunidades.
- **Los chats de temas no cuentan** para el tope `GRUPOS_POR_HORA`.
- **App.**
  - Los textos dicen «Agregar a un tema»: la prueba de castellano del Perú no
    admite «añadir».
  - El admin tiene «Temas y comunidades» en el menú del chat, para crear el
    primero.
  - Escribir en un tema es solo texto en esta versión, sin adjuntos ni notas de
    voz.
  - Todos los temas llevan el icono de carpeta: todavía no se elige.
  - En una comunidad, «Editar» no ofrece enlace, perfil ni filtros.
- **Pendiente conocido.** Una reacción hecha desde un tema no llega en directo a
  quien tiene General abierto, ni al revés: se ve al refrescar. El filtro
  «No leídos» de la bandeja agrupada solo mira General.
