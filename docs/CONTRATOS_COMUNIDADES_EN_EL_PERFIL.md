# Contratos — Comunidades en el perfil y cambio de nombres

Documento de coordinación de la ronda del **30 de octubre de 2026**. Fija lo que
más de un agente podría decidir por su cuenta y decidir distinto: nombres de
tabla y columna, rutas, formas de las respuestas y quién toca qué fichero.

**Nadie cambia lo que hay aquí sin avisar al coordinador.** Si algo no encaja
al implementarlo, se avisa; no se improvisa otro nombre.

Rama de trabajo: `feature/comunidades-en-el-perfil`, que sale de `main` (`a547e7c`).
La spec completa está en https://claude.ai/artifact/Pet2PUuq7Qo4mSgrG1CM9h y el
lienzo aprobado en https://claude.ai/artifact/Hvh4Wgn8NbmCG2283dZQgi (los dos son privados).

---

## 0. Qué cambia

1. **Cambio de nombres, solo en la interfaz.** Lo que hoy la app llama «grupo»
   (el chat padre, `conversations.kind = 'group'` de primer nivel) pasa a
   llamarse **comunidad**. Lo que hoy llama «comunidad» (los hijos,
   `group_subgroups` / `subgroups`) pasa a llamarse **grupo**. Una comunidad
   contiene grupos y/o temas. En el código, la base y la API los nombres NO
   cambian.
2. **Cómo se entra.** Cada comunidad tiene un ajuste nuevo: **abierta** (se
   entra con un toque) o **con solicitud** (como hoy). Las que ya existen
   quedan con solicitud.
3. **En el perfil.** Las píldoras de hoy (`GruposDelPerfil`) se quedan como
   están. Lo único nuevo es el icono: candado si la comunidad es con
   solicitud. Al tocarla, la hoja permite «Unirme» si es abierta.

### Decisiones cerradas (29 y 30/10/2026)

| # | Decisión |
|---|---|
| 1 | Todo chat de grupo de primer nivel se llama comunidad, tenga o no temas o grupos dentro. |
| 2 | En el perfil salen comunidades (padres), nunca sus grupos. |
| 3 | Por ahora solo puede mostrarla quien la creó. El ajuste se guarda **por persona** para que los co-administradores (spec aparte) no obliguen a rehacerlo. |
| 4 | Abierta: se entra directo desde el perfil y desde el enlace de invitación. Con solicitud: se pide y decide quien la administra. |
| 5 | Desde el perfil se entra solo a la comunidad (General y temas). A los grupos de dentro cada uno entra después, como hoy. |
| 6 | Pasar de abierta a con solicitud no saca a nadie. En el perfil sigue, con candado. |
| 7 | Desaparece del perfil si se elimina la comunidad o si la persona deja de administrarla. |
| 8 | La sección «Comunidades» de Explorar (círculos, `/circles`) no se toca. |
| 9 | Aspecto: las píldoras de hoy, sin foto. Candado en lugar del icono de comunidad si es con solicitud. |
| 10 | Rutas, tipos de push y nombres de código no cambian. |

---

## 1. Base de datos — migración `0112_comunidades_en_el_perfil.sql`

Toma la 0112 porque esta rama se fusiona antes que `perf/rls-lecturas` y
`perf/productos-e-indices`, que también la usaban: esas dos se renumeran
(0113 y 0114) al rebasarlas. `test_secuencia_de_migraciones.py` exige que la
numeración no tenga huecos.

- `group_settings.entrada text not null default 'request'` con
  `check (entrada in ('open', 'request'))`.
- Tabla nueva `public.group_profile_listings`:
  - `conversation_id uuid not null references public.conversations(id) on delete cascade`
  - `user_id uuid not null references auth.users(id) on delete cascade` (o el
    mismo destino que usen las demás tablas para los usuarios; mirar 0104)
  - `created_at timestamptz not null default now()`
  - clave primaria `(conversation_id, user_id)`
  - RLS activada **sin políticas**, como `group_settings` y
    `group_join_requests`: solo la usa la API.
- Relleno: una fila `(id, created_by)` por cada comunidad con
  `listed_on_profile = true`, con `on conflict do nothing`.
- `listed_on_profile` NO se borra en esta migración: la API la sigue
  escribiendo a la vez (ver §2) para que volver a la API anterior no pierda
  nada.
- Como todas: idempotente, `notify pgrst, 'reload schema'`, comprobación final
  con `select`, `set local lock_timeout = '5s'` y la vuelta atrás comentada al
  final.

## 2. API (`apps/api/app/modules/messaging/`)

Compatibilidad: **las versiones de la app que ya están en los teléfonos tienen
que seguir funcionando igual.** Nada de lo que ya existe cambia de forma ni de
significado, salvo lo que se dice aquí.

| Qué | Cambio |
|---|---|
| `TarjetaDeGrupo` | Tres campos nuevos: `entrada: Literal["open", "request"] = "request"`, `groups_count: int = 0` (grupos vivos de dentro), `topics_count: int = 0` (temas vivos). Valen para `GET /conversations/groups/of/{user_id}` y `GET /conversations/groups/invite/{code}`. |
| `GET /conversations/groups/of/{user_id}` | Lee de `group_profile_listings` las filas de ese usuario, solo de comunidades de primer nivel, vivas, y que ese usuario administre (hoy: `created_by`, vía `vistas.administra`). Mismo tope, orden y reglas de bloqueo que hoy. |
| `PATCH /{id}/group/settings` | Acepta `entrada` (solo quien administra, solo primer nivel, como el resto). `listed_on_profile` sigue existiendo con el mismo nombre, pero ahora significa «en MI perfil»: crea o borra la fila de quien llama en `group_profile_listings` y además escribe `group_settings.listed_on_profile` igual que hoy. |
| Lectura de ajustes (la respuesta de ajustes que ya existe) | Añade `entrada`. `listed_on_profile` se calcula para quien pregunta desde `group_profile_listings`. |
| `POST /{id}/join` (nuevo) | Cuerpo opcional `{"code": "…"}`: sin código solo entra si la comunidad sale en algún perfil; con el código del enlace activo, también. Entrada directa. Respuesta 200 con la `TarjetaDeGrupo` actualizada (`my_status = "member"`). Solo si `entrada = 'open'`; si es con solicitud, 409 con `code = "group_requires_request"`. Respeta el tope de miembros, los bloqueos con quien administra y las demás reglas de `join-requests` (reutilizar sus comprobaciones y sus códigos de error). Si ya es miembro, 200 sin repetir nada. Mete solo en la comunidad, nunca en sus grupos ni temas ocultos. Avisa a quien administra con un push nuevo solo si es barato; si no, sin push. |
| `POST /{id}/join-requests` | Si la comunidad es abierta, en vez de dejar la solicitud pendiente mete directamente (como `join`) y responde `status = "approved"`. Así una app antigua, o el enlace de invitación, entra directo en una abierta. |
| Eliminar una comunidad | Borra sus filas de `group_profile_listings` en la misma transacción. |
| Push (`app/modules/notifications/push.py`) | Los textos en español que dicen «grupo» por el padre pasan a «comunidad», y «comunidad» por el hijo pasa a «grupo». Ojo con el género. Los tipos (`group_added`, `group_join_request`, …) no cambian. |
| Errores HTTP | Sus `code` no cambian. Cambiar el texto en español es opcional. |

### Despliegue

La migración se pega antes de desplegar la API. Aun así, la API nueva no
falla si se despliega antes: sin la columna `entrada` todas las comunidades
leen «con solicitud», y sin `group_profile_listings` el perfil y
`listed_on_profile` usan la columna vieja. Las escrituras que necesitan lo
nuevo responden 503 `group_extras_not_available`. La API anterior funciona
igual con la migración aplicada.

## 3. App (`apps/mobile/`)

- `GroupRepository` / tipos: leen `entrada`, `groups_count`, `topics_count` y
  llaman a `POST /{id}/join` y a `PATCH …/group/settings` con `entrada`.
- `GruposDelPerfil`: misma píldora. Icono de comunidad si `entrada = 'open'`,
  candado (Feather `lock`) si `'request'`. Etiqueta de accesibilidad «Ver la
  comunidad X» y «(con solicitud)» cuando toca.
- `TarjetaDeGrupoVista` (hoja del perfil y pantalla `/grupo/[codigo]`):
  «Comunidad abierta · 3 grupos · 4 temas» (o «con solicitud»), miembros y
  quién administra. Botón «Unirme» si es abierta y no es miembro (llama a
  `join`; al terminar, abre la comunidad como hoy se abre al ser miembro).
  «Pedir unirme», «Retirar solicitud» y «llena» como hoy.
- `PuertasDelGrupo` (ajustes): sección «Cómo se entra» con «Abierta» / «Con
  solicitud» (mismo estilo de chips que el resto de la pantalla), con su
  ayuda debajo. El chip «Mostrar en mi perfil» sigue igual (mismo campo).
- **Cambio de nombres** en `src/i18n/es.ts`, `en.ts` y `pt.ts` (81 claves,
  inventario en la spec): `groups.*`, `groupJoin.*`, `groupFilters.*`,
  `groupTopics.*`, `groupCommunities.*`, `share.group*`, `chatMenu.groupInfo`.
  - Inglés: Community / Group. Portugués: Comunidade / Grupo.
  - Donde hoy una clave de `groups.*` sirve para el padre y para el hijo
    (p. ej. `groups.infoTitle`, `GrupoScreen.tsx:199,207,425`), se separa en
    dos y se elige con `info.padre`, como ya hacen salir y eliminar.
  - Concordancia de género en cada texto.
  - `src/lib/enlaces.ts` (`RESPALDOS_ES`) tiene que quedar igual que `es.ts`.
  - NO se tocan: «comunidad» como la plataforma, los «grupo» que no son
    chats, ni `explore.communities` / `home.joinCommunity`.
- Colores: solo tokens (`@/theme/tokens`, `useAppTheme()`), nunca hex.
- No se toca nada de `apps/mobile/app/` (rutas).
- E2E: `e2e/flujos/mensajes/grupo-temas.yaml` y `bandeja.yaml` cambian solo los
  textos que buscan.

## 4. Quién toca qué

| Parte | Ficheros |
|---|---|
| Backend | `supabase/migrations/0112_*.sql`, `apps/api/**` (código y pruebas) |
| App | `apps/mobile/**` salvo `apps/mobile/app/`, `e2e/flujos/**` |
| Coordinador | este documento, los commits y la integración |

Nadie hace commit, push ni `git add -A`: el coordinador hace los commits.
