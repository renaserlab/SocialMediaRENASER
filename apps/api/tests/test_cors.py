"""Regla de CORS: en produccion no se sirve el comodin.

Un `*` dejaria que cualquier web llamase a la API desde el navegador de una
persona con la sesion abierta. Como el valor por defecto es `*` (comodo en
desarrollo), sin esta prueba bastaria con desplegar sin configurar
CORS_ORIGINS para quedar expuesto, que es justo lo que pasaba.

La app movil no depende de esto: CORS lo aplican los navegadores.
"""

from app.core.config import Settings


def test_desarrollo_permite_comodin() -> None:
    """En local se mantiene el comodin para no estorbar."""
    settings = Settings(environment="development", cors_origins="*")
    assert settings.cors_origin_list == ["*"]


def test_produccion_sin_configurar_deniega_todo() -> None:
    """Sin dominios declarados se cierra, en vez de abrirse a cualquiera."""
    settings = Settings(environment="production", cors_origins="*")
    assert settings.cors_origin_list == []


def test_produccion_respeta_los_dominios_declarados() -> None:
    settings = Settings(
        environment="production",
        cors_origins="https://renaser.com, https://www.renaser.com",
    )
    assert settings.cors_origin_list == [
        "https://renaser.com",
        "https://www.renaser.com",
    ]


def test_produccion_nunca_devuelve_comodin() -> None:
    """Ni siquiera mezclando el comodin con dominios reales."""
    settings = Settings(environment="production", cors_origins="*, https://renaser.com")
    assert "*" not in settings.cors_origin_list
