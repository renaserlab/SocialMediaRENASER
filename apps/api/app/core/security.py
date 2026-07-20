"""Autenticacion basada en el JWT que emite Supabase Auth.

Flujo:
    app movil -> Supabase Auth -> JWT
    app movil -> FastAPI con header  Authorization: Bearer <jwt>
    FastAPI valida la firma y extrae la identidad (nunca confia en un
    author_id enviado por el cliente).

En Fase 1 se soporta HS256 con el "JWT secret" del proyecto Supabase.
La verificacion asimetrica por JWKS se puede anadir despues sin cambiar
las dependencias (get_current_user / get_optional_user).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import jwt
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import Settings, get_settings
from app.core.exceptions import UnauthorizedError

# auto_error=False: manejamos nosotros el 401 con el formato uniforme.
_bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class AuthUser:
    """Identidad autenticada, derivada del token (fuente de verdad)."""

    id: str
    email: str | None = None
    role: str | None = None
    claims: dict[str, Any] = field(default_factory=dict)


def _decode_token(token: str, settings: Settings) -> dict[str, Any]:
    if not settings.auth_configured:
        # Config incompleta: no podemos validar => tratamos como no autorizado
        # (y dejamos rastro claro en el mensaje para el desarrollador).
        raise UnauthorizedError(
            "Autenticacion no configurada en el servidor (falta SUPABASE_JWT_SECRET).",
            code="auth_not_configured",
        )
    options = {"verify_aud": bool(settings.supabase_jwt_audience)}
    kwargs: dict[str, Any] = {
        "algorithms": [settings.supabase_jwt_algorithm],
        "options": options,
    }
    if settings.supabase_jwt_audience:
        kwargs["audience"] = settings.supabase_jwt_audience
    if settings.supabase_jwt_issuer:
        kwargs["issuer"] = settings.supabase_jwt_issuer
    try:
        return jwt.decode(token, settings.supabase_jwt_secret, **kwargs)
    except jwt.ExpiredSignatureError as exc:
        raise UnauthorizedError("La sesion expiro.", code="token_expired") from exc
    except jwt.InvalidTokenError as exc:
        raise UnauthorizedError("Token invalido.", code="invalid_token") from exc


def _user_from_claims(claims: dict[str, Any]) -> AuthUser:
    sub = claims.get("sub")
    if not sub:
        raise UnauthorizedError("Token sin sujeto (sub).", code="invalid_token")
    role = claims.get("role")
    # Supabase suele exponer el rol de negocio en user_metadata / app_metadata.
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
    """Identidad si hay token valido; None si no hay token. Util para
    endpoints publicos que personalizan la respuesta si hay sesion."""
    if credentials is None or not credentials.credentials:
        return None
    claims = _decode_token(credentials.credentials, settings)
    return _user_from_claims(claims)
