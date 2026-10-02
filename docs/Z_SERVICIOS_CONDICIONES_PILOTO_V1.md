# Z Servicios · Condiciones piloto v1

> **Estado (02/10/2026): PREPARADAS, NO PUBLICADAS.** El texto es un borrador
> técnico y operativo. **Requiere revisión y aprobación empresarial y legal**
> antes de publicarse. No es un dictamen legal, y ninguna de sus reglas se
> presenta como una obligación legal: son las políticas provisionales de la
> primera versión (`Z_REQUISITOS_Y_DECISIONES.md`).
>
> En Supabase **no hay ninguna condición de contratación publicada**, y este
> bloque no publicó nada. Sin una publicada para el país del prestador no se
> confirma ninguna reserva.

## 1. Qué hay

| Qué | Dónde |
|---|---|
| El texto que se publicará, en texto plano | `docs/Z_SERVICIOS_CONDICIONES_PILOTO_V1.txt` |
| El guion que lo comprueba y dice su huella (no publica) | `apps/api/scripts/condiciones_del_piloto.py` |
| Las pruebas del texto y de la publicación | `apps/api/tests/test_servicios_condiciones_piloto.py` |
| El mecanismo (ya existía) | `service_policies`, tipo `booking_terms` (`Z_SERVICIOS_ARQUITECTURA.md` §67) |

- **Título:** `Condiciones del piloto de Z Servicios`.
- **País:** `PE`. Sin categoría: las condiciones que rigen una reserva son las
  generales del país del prestador.
- **Tamaño del borrador:** 6183 caracteres (el límite de una política es
  100 000).
- **Huella del borrador, con sus dos marcadores:**
  `89ee4e70ef2f1ce29ed3b5fcbb942899dddada14bbd6f393bf9d2d47d18ffbbe`.
  **No será la de lo publicado:** al aprobar el texto se retiran los
  marcadores y la huella cambia. La definitiva la dice el guion (apartado 4).

No se creó ninguna tabla, ningún sistema de documentos ni ninguna migración.

## 2. Lo que falta antes de publicar

El texto lleva **dos marcadores a la vista**, entre corchetes. Mientras quede
uno, el guion se niega a preparar la publicación.

1. `[BORRADOR PENDIENTE DE REVISIÓN Y APROBACIÓN EMPRESARIAL Y LEGAL…]`, la
   primera línea. Se retira cuando la empresa y su asesoría legal aprueban el
   texto.
2. `[CANAL DE SOPORTE PENDIENTE DE COMPLETAR ANTES DE PUBLICAR]`, en el
   apartado 16. **No se inventó ningún correo, teléfono ni dirección**: lo
   tiene que dar la empresa.

Y tres cosas que el texto da por hechas y que decide la empresa:

- **El procedimiento para comunicar el medio de una atención virtual**
  (apartado 14). El texto dice que el prestador lo comunica «de forma segura,
  siguiendo el procedimiento que el equipo del piloto indique». Ese
  procedimiento no existe todavía: Z no ofrece sala ni guarda un enlace (G17).
- **Quién atiende soporte**, incluidas las bajas de cuentas con reservas
  (F21, apartado 13).
- **Una segunda persona en administración** si se quieren apelaciones
  (apartado 11): con una sola, el servidor no las ofrece.

## 3. Qué dice el texto y qué impone el sistema

Cada regla del texto casa con lo que el servidor hace hoy. Lo que es solo una
declaración o una regla de operación está marcado: el sistema no lo impone.

| Apartado | Lo que dice | Cómo se cumple |
|---|---|---|
| 1. Naturaleza del piloto | Acceso limitado a cuentas autorizadas | **Sistema**: `SERVICES_PILOT_PROFILE_IDS` (P101); con la lista vacía no entra nadie |
| 2. Participantes | Mayores de edad, información verdadera, cuenta personal | **Declaración**. No hay verificación de edad: el piloto es una lista cerrada que elige la empresa, y el prestador presenta su documento de identidad, que revisa una persona |
| 3. El papel de Z | Z facilita; el prestador ejecuta; Z modera | **Sistema**: nadie publica sin admisión y sin revisión de su ficha; administración suspende y retira |
| 4. Alcance | Perú; virtual o presencial; sin domicilio; sin categorías reguladas | Modalidades: **sistema** (`SERVICES_CATALOG_MODALITIES=virtual,in_person`). Perú: **operación** (solo se publican condiciones para `PE`, y sin ellas ni se postula ni se confirma). Categorías: **operación** (solo administración las crea; no se siembra ninguna) |
| 5. Dinero | Sin pagos; solo lo gratuito se reserva; «a consultar» es informativo | **Sistema**: solo `free` se confirma; la base no deja guardar un pedido con importe; `FEATURE_SERVICE_PAYMENTS=false`, `SERVICE_PAYMENTS_PROVIDER=none`; de fábrica solo se publican fichas gratuitas o «a consultar» |
| 6. La reserva | Horario apartado unos minutos; se guarda lo aceptado | **Sistema**: retención de 10 minutos; aceptación con versión y huella |
| 7. Cancelación | Hasta antes del inicio; sin penalidad; el prestador da el motivo | **Sistema** |
| 8. Cambio de horario | Una vez, con 24 horas | **Sistema**, con los valores congelados en cada reserva (0095) |
| 9. La atención | Código desde 15 minutos antes; cierre a las 24 horas; inasistencia a los 15 minutos | **Sistema**. El cierre automático lo ejecuta hoy una persona de administración (no hay planificador) |
| 10. Incidencias | 48 horas; seguridad, sin plazo; evidencia verdadera y lícita | Plazos: **sistema**. La veracidad y la licitud: **declaración**, y moderación del equipo |
| 11. Apelación | Una, en 5 días, por otra persona; si no la hay, no se ofrece | **Sistema** |
| 12. Reseñas | Solo quien contrató, una, hasta 30 días, con revisión previa | **Sistema** (`SERVICES_REVIEWS_PREMODERATION=true`) |
| 13. Datos personales | Documentos y evidencias privados, enlaces temporales; la cuenta con reservas no se elimina sola | **Sistema**: depósitos privados y enlaces firmados; F21. El plazo de conservación: **pendiente** (F20) |
| 14. Servicios virtuales | Sin sala propia, sin grabaciones | **Sistema**: no existe sala ni grabación (100ms, posterior). El procedimiento para comunicar el medio: **pendiente** |
| 15. Suspensión | Por seguridad, fraude, incumplimiento o riesgo | **Sistema**: administración suspende prestadores y servicios |
| 16. Soporte | El canal | **Pendiente**: marcador |
| 17. Vigencia | Versión y huella con cada reserva; una versión nueva no cambia lo aceptado | **Sistema** |

Los plazos del texto son los valores de fábrica de la configuración, y una
prueba los compara: si alguien cambia un plazo sin publicar unas condiciones
nuevas, se pone en rojo.

## 4. Cómo se publican

Con las **rutas de administración que ya existen**. Dejan cada paso en la
auditoría (`service_policy.draft_created`, `service_policy.published`), cosa
que una inserción directa en la base no haría: **no se publican con SQL**.

**Antes de empezar:**

- El texto está aprobado y sus dos marcadores, resueltos. El cambio queda en
  un commit: lo publicado tiene que poder compararse con el repositorio.
- En ese servidor `FEATURE_SERVICES` está encendida (con ella apagada, las
  rutas de administración contestan 503). **No hace falta** encender la
  contratación (`FEATURE_SERVICE_BOOKING`): las condiciones se publican antes
  de abrirla.
- Quien lo hace tiene el rol `admin`. Un moderador puede leer, no publicar.

**Paso 1. Comprobar el texto y obtener su huella.** Desde `apps/api`:

```bash
python scripts/condiciones_del_piloto.py --salida ../../../condiciones_piloto_v1.json
```

Si queda un marcador, se niega. Si no, dice el título, el tamaño y la
**huella**, y escribe el cuerpo de la petición. El fichero de salida va fuera
del repositorio.

**Paso 2. Ver qué hay publicado.** `$API` es la dirección de la API y `$TOKEN`
el de la sesión de administración (no se escribe en ningún fichero del
repositorio ni se pega en un chat).

```bash
curl -sS "$API/api/v1/admin/services/policies?kind=booking_terms&country=PE" -H "Authorization: Bearer $TOKEN"
```

La primera vez no hay ninguna: la que se publique será la **versión 1**. Si
hubiera un borrador, el paso 3 lo devuelve tal como está, sin tocarlo.

**Paso 3. Crear el borrador.**

```bash
curl -sS -X POST "$API/api/v1/admin/services/policies/booking-terms/draft" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data-binary @../../../condiciones_piloto_v1.json
```

Contesta 201 con el `id` del borrador (200 si ya existía uno: entonces hay
que corregirlo con `PATCH …/policies/{id}` y los campos `title` y `body`).

**Paso 4. Comprobar la huella ANTES de publicar.**

```bash
curl -sS "$API/api/v1/admin/services/policies/ID_DEL_BORRADOR/preview" -H "Authorization: Bearer $TOKEN"
```

El campo `sha256` tiene que ser **exactamente** la huella del paso 1. Si no
lo es, el texto cambió por el camino: **no se publica**; se corrige el
borrador y se vuelve a comprobar.

**Paso 5. Publicar.** No tiene vuelta atrás por la API: una condición
publicada no se edita ni se retira; solo se sustituye publicando otra versión.

```bash
curl -sS -X POST "$API/api/v1/admin/services/policies/ID_DEL_BORRADOR/publish" -H "Authorization: Bearer $TOKEN"
```

Contesta `status: published`, su `version` y su `body_sha256`.

**Paso 6. Dejar constancia.** En este documento: la versión, la huella, la
fecha y quién la publicó. Y repetir el paso 2: tiene que haber **una** sola
publicada.

**Con la aplicación**, en vez de `curl`: Panel de administración → Servicios
→ Condiciones de contratación. Crea, edita, previsualiza y publica con las
mismas rutas, y enseña la huella abreviada (los ocho primeros caracteres y
los cuatro últimos), que se compara con la del paso 1. Pegar un texto largo
en el teléfono puede cambiarlo; por eso la comprobación de la huella no se
salta.

## 5. Qué pasa al publicar una versión nueva

- La anterior pasa a `superseded` en la misma transacción. Su texto y su
  huella no cambian (una publicada es inmutable en la base).
- Las reservas ya confirmadas **siguen apuntando a la versión que
  aceptaron**: su aceptación (`service_booking_acceptances`) no se reescribe.
- Quien tenga el resumen abierto con la versión anterior recibe un 409 al
  confirmar y la aplicación le enseña la nueva, con la casilla sin marcar.
- Cambiar un plazo de la configuración **no** cambia el texto: hay que
  publicar unas condiciones nuevas que lo digan.

## 6. Lo comprobado

Con PostgreSQL 17 y por la API real, con el texto que saldría del guion:

| Qué | Resultado |
|---|---|
| Sin condiciones publicadas no se reserva | el resumen dice `terms_unavailable` y confirmar contesta 409 `service_booking_terms_unavailable` |
| Un borrador no se puede aceptar | con su id y su huella, sigue sin haber condiciones |
| La reserva guarda versión y huella | las del servidor; el cuerpo no las lleva |
| El cuerpo no inventa la versión ni la huella | otra huella u otro id: 409 `service_booking_terms_changed`; un campo de versión escrito a mano: 422 |
| No hay aceptación silenciosa | sin `terms_policy_id` o sin `terms_sha256`: 422, y no queda nada escrito |
| Una versión posterior no altera una reserva anterior | la aceptación y el texto aceptado, intactos |
| Una sustituida o una retirada no se aceptan | 409 |
| Un reintento idempotente no crea dos aceptaciones | una fila |
| Publicar dos veces a la vez | una sola vigente |
| Publicar mientras alguien confirma | o aceptó la que leyó, o se le pide leer la nueva; nunca una mezcla |
| La presentación enseña lo que se acepta | el resumen trae el título, el texto entero, la versión y la huella |

En la aplicación, la casilla «Leí y acepto las condiciones de contratación de
Z» nace sin marcar y guarda la versión y la huella que se veían al marcarla;
sin ella, «Confirmar» está deshabilitado. Comprobarlo en un teléfono es parte
del QA físico pendiente.

## 7. Lo que sigue pendiente

- **La aprobación empresarial y legal del texto.**
- El canal de soporte y el procedimiento de los servicios virtuales.
- Publicarlas, cuando se decida abrir el piloto.
- El QA físico de la lectura y la aceptación en el teléfono.
- Los plazos de conservación de los datos (F20) y la anonimización de la
  historia contractual (F21): el texto solo avisa de que «puede conservarse».
- Las reglas financieras (comisión, comprobantes, devoluciones,
  contracargos): **no aplican al piloto gratuito** y quedan para una versión
  con pagos, que necesitará otras condiciones.
