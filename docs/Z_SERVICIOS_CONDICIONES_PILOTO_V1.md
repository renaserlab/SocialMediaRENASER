# Z Servicios · Condiciones piloto v1

> **Estado (05/10/2026): PUBLICADAS.** Versión 1, con la huella de este
> documento (`a35cd55d…375e`), publicada en producción el 05/10/2026 hacia las
> 15:15 UTC con la cuenta de administración de Z (`ADMIN`), mediante
> `publicar_condiciones.py`: el ensayo previo dio la misma huella. Las del
> prestador se publicaron en el mismo acto. Una condición publicada no se
> edita ni se retira: se sustituye publicando otra versión.
>
> El texto no lleva marcadores. Es una **versión operativa provisional del
> piloto**: lo dice en su primer párrafo y no presume de una revisión legal
> que no ha tenido. La revisión legal queda anotada como posterior y no
> impide el piloto cerrado y gratuito.
>
> No es un dictamen legal, y ninguna de sus reglas se presenta como una
> obligación legal: son las políticas provisionales de la primera versión
> (`Z_REQUISITOS_Y_DECISIONES.md`).
>
> **Cómo se publicaron:** con las rutas de administración de la API, con
> `FEATURE_SERVICES` encendida y una sesión de administración (apartado 4).
> Hasta el 05/10/2026 no había una cuenta de Z con ese rol a la que se pudiera
> entrar.

Este documento es de las condiciones que acepta **quien contrata**. Las que
acepta **quien presta** están en `Z_SERVICIOS_CONDICIONES_PRESTADOR_V1.md`.
El procedimiento de publicación del apartado 4 vale para las dos.

## 1. Qué hay

| Qué | Dónde |
|---|---|
| El texto que se publica, en texto plano | `docs/Z_SERVICIOS_CONDICIONES_PILOTO_V1.txt` |
| El guion que lo comprueba y dice su huella (no publica) | `apps/api/scripts/condiciones_del_piloto.py` |
| El guion que lo publica por las rutas de administración | `apps/api/scripts/publicar_condiciones.py` |
| Las pruebas del texto y de la publicación | `apps/api/tests/test_servicios_condiciones_piloto.py` |
| El mecanismo (ya existía) | `service_policies`, tipo `booking_terms` (`Z_SERVICIOS_ARQUITECTURA.md` §67) |

- **Título:** `Condiciones del piloto de Z Servicios`.
- **País:** `PE`. Sin categoría: las condiciones que rigen una reserva son las
  generales del país del prestador.
- **Tamaño:** 7112 caracteres (el límite de una política es 100 000).
- **Huella del texto que se publica:**
  `a35cd55d8ea58306a876421623b4537aa5fb72f73c3fa6e7500c942b3c7d375e`.
  Es el SHA-256 del texto exacto. Si alguien cambia una coma, cambia; una
  prueba compara esta línea con el fichero.
- **Versión:** la pone el servidor al crear el borrador. Será la **1** si no
  hay otra de `booking_terms` para `PE`.

No se creó ninguna tabla, ningún sistema de documentos ni ninguna migración.

## 2. Qué se cerró en el texto y qué decide todavía la empresa

Los dos marcadores que llevaba el borrador ya no están:

- **La línea de «borrador pendiente de aprobación»** se sustituyó por una
  declaración que se queda en el texto publicado: es la versión operativa
  provisional del piloto y todavía no ha tenido una revisión legal.
- **El canal de soporte** es el que la aplicación ya tiene: el Centro de
  ayuda (Ajustes → «Soporte y preguntas frecuentes») y su buzón único. **No
  se inventó ningún contacto**; una prueba lee el correo de la pantalla de
  soporte de la aplicación y exige que sea el único del texto.

**Este texto lo acepta quien contrata, no quien presta.** Varias de sus
reglas obligan al prestador (ejecutar el servicio como dice su ficha, dar el
motivo al cancelar, comunicar el medio de una atención virtual). Él las
acepta en **sus** condiciones, que ya tienen texto y dicen lo mismo donde
coinciden (una prueba lo compara).

**Un texto con marcadores también se podría publicar** si alguien lo pegara a
mano en el panel: el freno está en los guiones, no en el servidor. Por eso
se publica con el guion.

Lo que el texto da por hecho y **decide la empresa**, sin que impida empezar:

- **Los plazos de conservación** (apartado 13; F20, IV-19). El texto dice la
  verdad de hoy —la información se conserva mientras exista la cuenta, y los
  plazos están por definir— y no promete un plazo que nada cumple.
- **El procedimiento para comunicar el medio de una atención virtual**
  (apartado 14): Z no ofrece sala ni guarda un enlace (G17).
- **Quién atiende soporte**, incluidas las bajas de cuentas con reservas.
- **Una segunda persona en administración** si se quieren apelaciones: con
  una sola, el servidor no las ofrece.

## 3. Qué dice el texto y qué impone el sistema

Cada regla del texto casa con lo que el servidor hace hoy. Lo que es solo una
declaración o una regla de operación está marcado: el sistema no lo impone.

| Apartado | Lo que dice | Cómo se cumple |
|---|---|---|
| 1. Naturaleza del piloto | Acceso limitado a cuentas autorizadas | **Sistema**: `SERVICES_PILOT_PROFILE_IDS` (P101); con la lista vacía no entra nadie |
| 2. Participantes | Mayores de edad, información verdadera, cuenta personal | **Declaración**. No hay verificación de edad: el piloto es una lista cerrada que elige la empresa, y el prestador presenta su documento de identidad, que revisa una persona |
| 3. El papel de Z | Z facilita; el prestador ejecuta; Z modera | **Sistema**: nadie publica sin admisión y sin revisión de su ficha; administración suspende y retira |
| 4. Alcance | Perú; virtual o presencial; sin domicilio; sin categorías reguladas (médicos, legales, financieros, emergencias, sin autorización comprobada, menores); la lista de lo prohibido (P8) | Modalidades: **sistema** (`SERVICES_CATALOG_MODALITIES=virtual,in_person`). Perú: **operación** (solo se publican condiciones para `PE`, y sin ellas ni se postula ni se confirma). Categorías y actividades prohibidas: **operación** (solo administración crea categorías, no se siembra ninguna y cada servicio se aprueba a mano; no hay filtro automático) |
| 5. Dinero | Sin pagos en Z Servicios; solo lo gratuito se reserva; «a consultar» es informativo | **Sistema**: solo `free` se confirma; la base no deja guardar un pedido con importe; `FEATURE_SERVICE_PAYMENTS=false`, `SERVICE_PAYMENTS_PROVIDER=none`; una ficha con importe no se puede guardar ni enviar, y la aplicación no lo ofrece |
| 6. La reserva | Horario apartado unos minutos; se guarda lo aceptado | **Sistema**: retención de 10 minutos; aceptación con versión y huella |
| 7. Cancelación | Hasta antes del inicio; sin penalidad; el prestador da el motivo | **Sistema** |
| 8. Cambio de horario | Una vez, con 24 horas, si el servicio sigue publicado y su ficha no cambió | **Sistema**, con los valores congelados en cada reserva (0095) |
| 9. La atención | Código desde 15 minutos antes; cierre a las 24 horas; inasistencia a los 15 minutos | **Sistema**. El cierre automático lo lanza el planificador (`Z_SERVICIOS_ARQUITECTURA.md`, §151); la plantilla de AWS no deja encender la contratación sin él |
| 10. Incidencias | En una reserva confirmada, desde el inicio y hasta 48 horas después; por seguridad no corre ese plazo; una incidencia a la vez y ninguna tras la decisión; evidencia verdadera y lícita | Plazos y unicidad: **sistema**. La veracidad y la licitud: **declaración**, y moderación del equipo |
| 11. Apelación | Una, en 5 días, por otra persona; si no la hay, no se ofrece | **Sistema** |
| 12. Reseñas | Solo quien contrató, una, hasta 30 días, con revisión previa; lo que no se admite | **Sistema** (`SERVICES_REVIEWS_PREMODERATION=true`). Lo que no se admite lo aplica una persona al moderar |
| 13. Datos personales | Documentos y evidencias privados, enlaces temporales; se conserva mientras exista la cuenta; la cuenta con reservas no se elimina sola | **Sistema**: depósitos privados y enlaces firmados; nada se borra a un plazo; F21. El plazo de conservación: **pendiente** (F20, IV-19) |
| 14. Servicios virtuales | Sin sala propia, sin grabaciones | **Sistema**: no existe sala ni grabación (100ms, posterior). El procedimiento para comunicar el medio: **operación** |
| 15. Suspensión | Suspender a un prestador o un servicio y retirar una cuenta del piloto | **Sistema**: administración suspende prestadores y servicios; una cuenta sale del piloto quitándola de la lista (P101) |
| 16. Soporte | El Centro de ayuda de la aplicación y su buzón | **Sistema**: la pantalla de soporte existe (`/support`) |
| 17. Vigencia | Versión y huella con cada reserva; una versión nueva no cambia lo aceptado | **Sistema** |

Los plazos del texto son los valores de fábrica de la configuración, y una
prueba los compara: si alguien cambia un plazo sin publicar unas condiciones
nuevas, se pone en rojo. **La prueba mira los valores de fábrica, no los de
cada entorno:** el despliegue no sobreescribe ninguno de esos plazos (no hay
parámetro para ellos en la plantilla de AWS), y así tiene que seguir.

## 4. Cómo se publican (las dos)

Con las **rutas de administración que ya existen**. Dejan cada paso en la
auditoría (`service_policy.draft_created`, `service_policy.published`), cosa
que una inserción directa en la base no haría: **no se publican con SQL**.

**Lo que hace falta, y en este orden:**

1. **El código desplegado.** La API de producción tiene que tener Servicios.
2. **`FEATURE_SERVICES` encendida en ese servidor.** Con ella apagada las
   rutas de administración contestan 503. Encenderla **no abre Servicios a
   nadie**: con la lista del piloto vacía y la apertura general apagada, solo
   administración entra, por su rol (P101). Las condiciones se publican
   así, antes de cargar la lista del piloto y de encender la contratación.
3. **Una sesión de una cuenta con el rol `admin`.** Un moderador puede leer,
   no publicar.

**Con el guion** (lo recomendado). Desde `apps/api`, con el token de la
sesión de administración en la variable de entorno `Z_ADMIN_TOKEN` (no se
escribe en ningún fichero ni se pega en un chat; el guion no lo imprime):

```bash
python scripts/publicar_condiciones.py --tipo prestador --api "$API"
```

```bash
python scripts/publicar_condiciones.py --tipo contratacion --api "$API"
```

Sin `--publicar` crea (o corrige) el borrador, pide su vista previa y
compara la huella del servidor con la del texto local. **No publica.** Si
todo coincide, se repite cada orden añadiendo `--publicar`:

```bash
python scripts/publicar_condiciones.py --tipo prestador --api "$API" --publicar
```

```bash
python scripts/publicar_condiciones.py --tipo contratacion --api "$API" --publicar
```

- Se niega si el texto lleva un marcador, si la huella del borrador no es la
  del texto local, o si el servidor contesta algo inesperado.
- Repetirlo es seguro: si ya están publicadas, lo dice y no toca nada.
- Imprime el tipo, el tamaño, la huella y la versión. Nada más.
- **Publicar no tiene vuelta atrás por la API**: una condición publicada no
  se edita ni se retira; solo se sustituye publicando otra versión.

**Con la aplicación**, en vez del guion: Panel de administración → Servicios
→ Condiciones del prestador / Condiciones de contratación. Crea, edita,
previsualiza y publica con las mismas rutas, y enseña la huella abreviada
(los ocho primeros caracteres y los cuatro últimos), que se compara con la de
`condiciones_del_piloto.py`. Pegar un texto largo en el teléfono puede
cambiarlo; por eso la comprobación de la huella no se salta.

**Después de publicar**, dejar constancia aquí y en el documento del
prestador: la versión, la huella, la fecha y quién publicó.

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

Con PostgreSQL 17 y por la API real, con el texto del fichero y publicándolo
con el guion:

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
| El guion | no publica sin `--publicar`; corrige un borrador con otro texto; se detiene si quien lo lanza no es administración; repetido, no toca nada |

En la aplicación, la casilla «Leí y acepto las condiciones de contratación de
Z» nace sin marcar y guarda la versión y la huella que se veían al marcarla;
sin ella, «Confirmar» está deshabilitado. Comprobarlo en un teléfono es parte
del QA físico pendiente.

## 7. Lo que sigue pendiente

- **Publicarlas** en producción (apartado 4).
- El **QA físico** de la lectura y la aceptación en el teléfono.
- La **revisión legal posterior** del texto. No impide el piloto cerrado.
- Los plazos de conservación de los datos (F20) y la anonimización de la
  historia contractual (F21): el texto solo avisa de que «puede conservarse».
- Las reglas financieras (comisión, comprobantes, devoluciones,
  contracargos): **no aplican al piloto gratuito** y quedan para una versión
  con pagos, que necesitará otras condiciones.
