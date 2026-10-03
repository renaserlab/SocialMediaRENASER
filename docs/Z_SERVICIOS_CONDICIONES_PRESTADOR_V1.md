# Z Servicios · Condiciones del prestador — Piloto gratuito v1

> **Estado (03/10/2026): LISTAS PARA PUBLICAR, TODAVÍA NO PUBLICADAS.** Es
> una **versión operativa provisional del piloto**: lo dice en su primer
> párrafo y no presume de una revisión legal que no ha tenido. La revisión
> legal queda anotada como posterior y no impide el piloto cerrado y gratuito.
>
> No es un dictamen legal. No copia el texto de ninguna otra plataforma, y no
> describe ninguna función que la aplicación no tenga.
>
> **Sin estas condiciones publicadas nadie puede postular** como prestador:
> la postulación no se puede enviar. Por qué no están publicadas todavía y
> cómo se publican: `Z_SERVICIOS_CONDICIONES_PILOTO_V1.md`, apartado 4.

## 1. Qué hay

| Qué | Dónde |
|---|---|
| El texto que se publica, en texto plano | `docs/Z_SERVICIOS_CONDICIONES_PRESTADOR_V1.txt` |
| El guion que lo comprueba y dice su huella (no publica) | `apps/api/scripts/condiciones_del_piloto.py --tipo prestador` |
| El guion que lo publica por las rutas de administración | `apps/api/scripts/publicar_condiciones.py --tipo prestador` |
| Las pruebas del texto y de la publicación | `apps/api/tests/test_servicios_condiciones_prestador.py` |
| El mecanismo (ya existía) | `service_policies`, tipo `provider_terms` (0086; `Z_SERVICIOS_ARQUITECTURA.md` §6) |

- **Título:** `Condiciones del prestador de Z Servicios — Piloto gratuito v1`.
- **País:** `PE`, sin categoría.
- **Tamaño:** 6208 caracteres.
- **Huella del texto que se publica:**
  `6ce1f1cd8be1a346065f30856442fc2e2b221c623c1e033dcd401c076f0d67dd`.
- **Versión:** la pone el servidor. Será la **1** si no hay otra de
  `provider_terms` para `PE`.
- **Parámetros:** ninguno. Eso significa dos cosas, las dos a propósito:
  - en el piloto no se exige más documentación que la mínima ya decidida
    (documento de identidad y, en una empresa, el que acredita la
    representación);
  - **volver a postular tras un rechazo sigue sin decidirse** (S2): quien sea
    rechazado no puede volver a postular hasta que la empresa lo decida y se
    publique una versión con ese parámetro. No se inventó la respuesta.

## 2. Quién las acepta y cuándo

Quien quiere ofrecer servicios las lee en la aplicación y las acepta **de
forma expresa** antes de enviar su postulación. Con cada envío se guardan el
identificador de la versión, su número y su huella
(`service_provider_application_submissions`). Una versión posterior vale
para quien acepte después; no cambia lo que ya se aceptó.

Quien **contrata** acepta otras condiciones, al confirmar cada reserva
(`Z_SERVICIOS_CONDICIONES_PILOTO_V1.md`). Las dos dicen lo mismo donde
coinciden, y una prueba lo compara.

## 3. Qué dice el texto y qué impone el sistema

| Apartado | Lo que dice | Cómo se cumple |
|---|---|---|
| 1. Naturaleza del piloto | Gratuito, cerrado, sujeto a cambios | **Sistema**: lista del piloto (P101); solo lo gratuito se reserva; pagos apagados |
| 2. Quién puede ser prestador | Adulto; persona natural o empresa; información real; una identidad por perfil | Tipos de prestador y un prestador por perfil: **sistema**. La mayoría de edad y la veracidad: **declaración**, con el documento de identidad que revisa una persona |
| 3. Independencia | Por cuenta propia; Z no es empleador ni representante | **Declaración**. Sin cláusulas tributarias: no están confirmadas |
| 4. Exactitud | Lo publicado es verdadero; corregir lo que cambie | La revisión de cada versión antes de publicarla: **sistema**. La veracidad: **declaración** |
| 5. Experiencia y credenciales | Solo las reales; documentos vigentes; una vencida deja de mostrarse | **Sistema**: el vencimiento se calcula al leer y la señal pública se retira |
| 6. Servicios que no se admiten | La lista de lo prohibido y de lo regulado | **Operación**: se aplica al aprobar cada servicio; no hay filtro automático ni categorías sembradas |
| 7. Publicación y moderación | Z aprueba, pide correcciones, suspende, retira; nadie aprueba lo suyo | **Sistema** (también en la base: 0086, 0090) |
| 8. Agenda | Disponibilidad real; cancelar hasta la hora de inicio, con motivo | Los horarios y el motivo obligatorio: **sistema**. No ofrecer lo que no se puede atender: **declaración** |
| 9. La atención | Puntualidad; el código de asistencia; proteger datos | El código y sus intentos: **sistema**. Lo demás: **declaración** |
| 10. Servicios virtuales | Sin sala propia; medio comunicado de forma segura; no grabar sin consentimiento | No existe sala ni grabación: **sistema**. El procedimiento y el consentimiento: **operación** y **declaración** |
| 11. Atención presencial | Lugar seguro; solo la zona es pública; sin domicilio | La zona y la ausencia de «a domicilio»: **sistema** |
| 12. Cancelaciones, inasistencias e incidencias | Las reglas de cada reserva; conservar evidencia; no manipular | Los plazos: **sistema**. Lo demás: **declaración** |
| 13. Contenido e imágenes | Material propio o autorizado; permiso limitado a la plataforma | **Declaración** |
| 14. Datos personales | Solo para prestar el servicio | **Declaración**. La aplicación no entrega al prestador más que lo que la reserva necesita |
| 15. Reseñas | No fabricar ni presionar; una respuesta; moderación | La respuesta única y la moderación previa: **sistema**. Lo demás: **declaración** |
| 16. Suspensión | Las causas | **Sistema**: administración suspende prestadores y servicios, con motivo |
| 17. Baja de la cuenta | Con reservas no se elimina sola; soporte revisa | **Sistema** (F21). La anonimización definitiva: **pendiente de revisión legal** |
| 18. Soporte | El Centro de ayuda y su buzón | **Sistema**: la pantalla de soporte existe |
| 19. Vigencia y cambios | Aceptación expresa; versión y huella; lo nuevo no cambia lo aceptado | **Sistema** |

## 4. Lo comprobado

Con la aplicación real (y sin necesidad de PostgreSQL: la admisión corre en
los dos motores), publicándolas con el guion:

| Qué | Resultado |
|---|---|
| Sin condiciones publicadas no se postula | no se pueden leer (409) y enviar contesta 422 `provider_terms_not_published` |
| Un borrador no se puede aceptar | sigue sin haber condiciones |
| Solo administración publica | moderación y quien postula: el guion se detiene |
| Se enseña lo que se acepta | el texto entero, con su título, su versión y su huella |
| No hay aceptación silenciosa | sin aceptarlas, enviar contesta 422 `provider_terms_not_accepted` |
| No se acepta una versión inventada | otra huella u otro id: 409; la versión escrita a mano o un cuerpo a medias: 422 |
| La aceptación guarda versión y huella | en la postulación y en cada envío |
| Una versión nueva no cambia lo aceptado | la postulación, su envío y el texto anterior, intactos |
| Una sustituida o una retirada no se aceptan | 409 |
| Publicar dos veces | una sola versión |

## 5. Lo que sigue pendiente

- **Publicarlas** en producción.
- El **QA físico** de la lectura y la aceptación en el teléfono.
- La **revisión legal posterior**. No impide el piloto cerrado.
- **S2**: si quien fue rechazado puede volver a postular.
- La matriz de documentos por categoría (S3), cuando se abra una categoría
  regulada: en el piloto no hay ninguna.
