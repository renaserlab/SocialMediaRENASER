"""Las banderas de los medios en S3 y lo que sabe el cliente.

Todo de fábrica en «apagado»: `medios_s3_subida = nadie`,
`medios_s3_lectura = false`. Con eso, desplegar esto no cambia nada para
nadie (ver `docs/Z_MEDIOS_S3_CLOUDFRONT.md`).
"""

from __future__ import annotations

from contextvars import ContextVar

from app.core.config import get_settings

#: La cabecera con la que la app nueva dice «sé reproducir videos de S3»
#: (spec §7, «Compatibilidad»). Una app vieja no la manda y no puede recibir
#: publicaciones con videos en S3: firmaría su ruta en Supabase y fallaría.
CABECERA_CLIENTE = "x-zeta-medios"

#: Lo que trajo la petición en curso. Lo fija un middleware (`main.py`) para
#: no tener que pasarlo por cada endpoint que devuelve publicaciones.
_cliente_entiende_s3: ContextVar[bool] = ContextVar("cliente_entiende_s3", default=False)


def fijar_cliente(valor_de_cabecera: str | None):
    """Devuelve el testigo para restaurar el valor al terminar la petición."""
    valores = {v.strip().lower() for v in (valor_de_cabecera or "").split(",")}
    return _cliente_entiende_s3.set("s3" in valores)


def restaurar_cliente(testigo) -> None:
    _cliente_entiende_s3.reset(testigo)


def cliente_entiende_s3() -> bool:
    return _cliente_entiende_s3.get()


def s3_configurado() -> bool:
    """Hay bucket: se puede hablar con S3 (con el rol de la instancia)."""
    return bool(get_settings().medios_s3_bucket.strip())


def lectura_activa() -> bool:
    """La API firma y entrega las filas `s3`."""
    return bool(get_settings().medios_s3_lectura)


def puede_recibir_s3() -> bool:
    """Quien pregunta puede recibir publicaciones con videos en S3.

    Las dos cosas a la vez: la lectura encendida (el interruptor de
    emergencia) y un cliente que entiende las URLs de CloudFront.
    """
    return lectura_activa() and cliente_entiende_s3()


def cuentas_de_la_lista() -> set[str]:
    crudo = get_settings().medios_s3_subida_cuentas or ""
    return {c.strip().lower() for c in crudo.split(",") if c.strip()}


def puede_subir(uid: str | None) -> bool:
    """Si ESTA cuenta sube a S3 los videos de sus publicaciones."""
    if not uid or not s3_configurado():
        return False
    modo = get_settings().medios_s3_subida
    if modo == "todos":
        return True
    if modo == "lista":
        return uid.lower() in cuentas_de_la_lista()
    return False


def visibilidad_estricta() -> bool:
    return get_settings().publicaciones_visibilidad == "estricta"
