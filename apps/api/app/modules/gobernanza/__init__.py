"""Lo que es de TODOS los dominios: políticas versionadas, consentimientos y auditoría.

POR QUÉ UN MÓDULO APARTE Y NO DENTRO DE `refunds`. Porque lo que hay en
`refunds` es de devoluciones: `refund_policy_acceptances` guarda la aceptación
de una recompra concreta, con una unicidad `(usuario, curso, orden)` que es de
ese dominio y no generaliza. Cursos, eventos, servicios y productos van a
necesitar aceptar textos que no son ese, y auditar operaciones que no son un
reembolso.

QUÉ NO HACE. No sustituye nada de lo que ya existe:

  * `refund_policy_acceptances` sigue siendo la que usa el circuito de recompra.
    No se migran sus filas: mover un historial legal «de paso» es la clase de
    cambio que se hace mal.
  * `refund_request_events` sigue siendo la máquina de estados del expediente,
    con sus claves foráneas y sus consultas de negocio encima. La auditoría es
    un rastro transversal ADEMÁS de aquello, no en lugar de aquello.
"""
