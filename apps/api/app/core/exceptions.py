"""Errores de dominio y respuestas de error uniformes.

Todas las respuestas de error del API tienen la misma forma:

    {"error": {"code": "not_found", "message": "...", "details": null}}

Asi la app movil puede manejar errores de forma consistente.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.encoders import jsonable_encoder
from sqlalchemy.exc import DBAPIError
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


class AppError(Exception):
    """Error base de la aplicacion. Cada modulo puede lanzarlo."""

    status_code: int = status.HTTP_400_BAD_REQUEST
    code: str = "bad_request"
    message: str = "Solicitud invalida."

    def __init__(
        self,
        message: str | None = None,
        *,
        code: str | None = None,
        details: Any = None,
    ) -> None:
        self.message = message or self.message
        self.code = code or self.code
        self.details = details
        super().__init__(self.message)


class NotFoundError(AppError):
    status_code = status.HTTP_404_NOT_FOUND
    code = "not_found"
    message = "Recurso no encontrado."


class ConflictError(AppError):
    status_code = status.HTTP_409_CONFLICT
    code = "conflict"
    message = "El recurso ya existe o esta en conflicto."


class UnauthorizedError(AppError):
    status_code = status.HTTP_401_UNAUTHORIZED
    code = "unauthorized"
    message = "No autenticado."


class ForbiddenError(AppError):
    status_code = status.HTTP_403_FORBIDDEN
    code = "forbidden"
    message = "No tienes permiso para esta accion."


class ValidationAppError(AppError):
    status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
    code = "validation_error"
    message = "Datos invalidos."


def _error_body(code: str, message: str, details: Any = None) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "details": details}}


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error_handler(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=_error_body(exc.code, exc.message, exc.details),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error_handler(
        _: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=_error_body("http_error", str(exc.detail)),
        )

    @app.exception_handler(DBAPIError)
    async def _dbapi_error_handler(_: Request, exc: DBAPIError) -> JSONResponse:
        """Red de seguridad para ids con formato invalido.

        Las columnas de id son UUID. Si llega otra cosa por la URL (un slug de
        una pantalla antigua, o basura), el string viaja hasta el driver y
        asyncpg falla con `invalid input for query argument`. Eso salia como un
        500, cuando en realidad es un error del cliente: el recurso no existe.

        `ensure_uuid` sigue siendo la via preferente porque valida ANTES de
        tocar la base de datos; esto solo evita que un endpoint sin esa
        comprobacion acabe en un 500.
        """
        text = str(getattr(exc, "orig", exc))
        if "invalid input for query argument" in text or "invalid UUID" in text:
            return JSONResponse(
                status_code=status.HTTP_404_NOT_FOUND,
                content=_error_body("not_found", "Recurso no encontrado."),
            )
        raise exc

    @app.exception_handler(RequestValidationError)
    async def _validation_error_handler(
        _: Request, exc: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content=_error_body(
                "validation_error",
                "Los datos enviados no son validos.",
                jsonable_encoder(exc.errors()),
            ),
        )
