"""Quien puede editar los cursos, eventos y resenas de cada cual.

Crear se abrio a toda la comunidad, pero editar y borrar siguen siendo de quien
publico. Sin estas pruebas, abrir la creacion podria acabar dejando que
cualquiera retocase el contenido de los demas, que es justo lo que no debe
pasar.
"""

import pytest

from app.core.exceptions import ForbiddenError
from app.core.security import AuthUser
from app.shared import permissions


def _usuario(uid: str) -> AuthUser:
    return AuthUser(id=uid, email=f"{uid}@ejemplo.com", role="authenticated")


@pytest.fixture
def sin_privilegios(monkeypatch):
    """Nadie administra: solo cuenta ser el autor."""

    async def _no(_db, _uid):
        return False

    monkeypatch.setattr(permissions, "is_admin", _no)


@pytest.fixture
def todos_administran(monkeypatch):
    async def _si(_db, _uid):
        return True

    monkeypatch.setattr(permissions, "is_admin", _si)


@pytest.mark.asyncio
async def test_el_autor_puede_editar_lo_suyo(sin_privilegios):
    await permissions.require_owner_or_admin(None, "ana", _usuario("ana"))


@pytest.mark.asyncio
async def test_nadie_edita_lo_ajeno(sin_privilegios):
    with pytest.raises(ForbiddenError):
        await permissions.require_owner_or_admin(None, "ana", _usuario("beto"))


@pytest.mark.asyncio
async def test_la_administracion_puede_moderar(todos_administran):
    """Hace falta para retirar contenido que incumpla las normas."""
    await permissions.require_owner_or_admin(None, "ana", _usuario("moderador"))


@pytest.mark.asyncio
async def test_sin_autor_conocido_no_se_deja_pasar(sin_privilegios):
    """Un contenido sin dueno no es de todos: se deniega salvo administracion."""
    with pytest.raises(ForbiddenError):
        await permissions.require_owner_or_admin(None, None, _usuario("ana"))


@pytest.mark.asyncio
async def test_el_mensaje_de_error_se_puede_ajustar(sin_privilegios):
    with pytest.raises(ForbiddenError) as fallo:
        await permissions.require_owner_or_admin(
            None, "ana", _usuario("beto"), "No puedes editar este curso."
        )
    assert "curso" in str(fallo.value)
