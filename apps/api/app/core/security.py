"""Autenticacion basada en el JWT que emite Supabase Auth.

Flujo:
    app movil -> Supabase Auth -> JWT
    app movil -> FastAPI con header  Authorization: Bearer <jwt>
    FastAPI valida la firma y extrae la identidad (nunca confia en un
    author_id enviado por el cliente).

Validacion hibrida segun el algoritmo del token:
- ES256/RS256 (llaves asimetricas, sistema nuevo de Supabase): se verifica
  con la clave publica del JWKS del proyecto
  (https://<ref>.supabase.co/auth/v1/.well-known/jwks.json).
- HS256 (secreto compartido, legacy): se verifica con SUPABASE_JWT_SECRET.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

import jwt
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWKClient

from app.core.config import Settings, get_settings
from app.core.exceptions import UnauthorizedError

# auto_error=False: manejamos nosotros el 401 con el formato uniforme.
_bearer = HTTPBearer(auto_error=False)

# Cliente JWKS cacheado (descarga y cachea las claves publicas del proyecto).
_jwks_client: PyJWKClient | None = None


def _get_jwks_client(settings: Settings) -> PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        url = settings.supabase_url.rstrip("/") + "/auth/v1/.well-known/jwks.json"
        _jwks_client = PyJWKClient(url)
    return _jwks_client


@dataclass(frozen=True)
class AuthUser:
    """Identidad autenticada, derivada del token (fuente de verdad)."""

    id: str
    email: str | None = None
    role: str | None = None
    claims: dict[str, Any] = field(default_factory=dict)


def _resolve_key(token: str, alg: str, settings: Settings):
    """Devuelve la clave adecuada para verificar el token segun su algoritmo."""
    if alg.startswith("HS"):
        if not settings.supabase_jwt_secret:
            raise UnauthorizedError(
                "Servidor sin SUPABASE_JWT_SECRET para tokens HS.",
                code="auth_not_configured",
            )
        return settings.supabase_jwt_secret

    # Asimetrico (ES256 / RS256) -> clave publica del JWKS.
    if not settings.supabase_url:
        raise UnauthorizedError(
            "Servidor sin SUPABASE_URL para validar por JWKS.",
            code="auth_not_configured",
        )
    try:
        return _get_jwks_client(settings).get_signing_key_from_jwt(token).key
    except UnauthorizedError:
        raise
    except Exception as exc:  # pragma: no cover - fallo de red/clave ausente
        raise UnauthorizedError(
            "No se pudo obtener la clave de firma del token.",
            code="invalid_token",
        ) from exc


def _decode_token(token: str, settings: Settings) -> dict[str, Any]:
    if not settings.auth_configured:
        raise UnauthorizedError(
            "Autenticacion no configurada en el servidor.",
            code="auth_not_configured",
        )
    try:
        header = jwt.get_unverified_header(token)
    except jwt.InvalidTokenError as exc:
        raise UnauthorizedError("Token invalido.", code="invalid_token") from exc

    alg = header.get("alg", "")
    key = _resolve_key(token, alg, settings)

    # Tolerancia de reloj. Sin ella (PyJWT usa 0 por defecto) un token recien
    # emitido por Supabase puede tener `iat`/`nbf` unos milisegundos por delante
    # del reloj de este servidor y se rechaza con 401: justo despues de iniciar
    # sesion la primera peticion fallaba y el perfil no se cargaba hasta
    # recargar la app.
    decode_kwargs: dict[str, Any] = {
        "algorithms": [alg] if alg else ["ES256", "RS256", "HS256"],
        "leeway": timedelta(seconds=60),
    }
    if settings.supabase_jwt_audience:
        decode_kwargs["audience"] = settings.supabase_jwt_audience
    else:
        decode_kwargs["options"] = {"verify_aud": False}
    if settings.supabase_jwt_issuer:
        decode_kwargs["issuer"] = settings.supabase_jwt_issuer

    try:
        return jwt.decode(token, key, **decode_kwargs)
    except jwt.ExpiredSignatureError as exc:
        raise UnauthorizedError("La sesion expiro.", code="token_expired") from exc
    except jwt.InvalidTokenError as exc:
        raise UnauthorizedError("Token invalido.", code="invalid_token") from exc


def _user_from_claims(claims: dict[str, Any]) -> AuthUser:
    sub = claims.get("sub")
    if not sub:
        raise UnauthorizedError("Token sin sujeto (sub).", code="invalid_token")
    role = claims.get("role")
    # Supabase suele exponer el rol de negocio en app_metadata.
    app_meta = claims.get("app_metadata") or {}
    if isinstance(app_meta, dict) and app_meta.get("role"):
        role = app_meta["role"]
    return AuthUser(
        id=str(sub),
        email=claims.get("email"),
        role=role,
        claims=claims,
    )


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    settings: Settings = Depends(get_settings),
) -> AuthUser:
    """Requiere un JWT valido. Lanza 401 uniforme si falta o es invalido."""
    if credentials is None or not credentials.credentials:
        raise UnauthorizedError("Falta el header Authorization Bearer.")
    claims = _decode_token(credentials.credentials, settings)
    return _user_from_claims(claims)


async def get_optional_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    settings: Settings = Depends(get_settings),
) -> AuthUser | None:
    """Identidad si hay token valido; None si no hay token o no es valido.

    Los endpoints publicos (p. ej. el feed) no deben fallar por un token
    invalido: simplemente se tratan como anonimos.
    """
    if credentials is None or not credentials.credentials:
        return None
    try:
        claims = _decode_token(credentials.credentials, settings)
    except UnauthorizedError:
        return None
    return _user_from_claims(claims)
