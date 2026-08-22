"""Publicar sin texto, y de quien son las categorias del podcast.

Dos reglas que solo existen en el servidor y que la interfaz no puede
garantizar:

  1. Una publicacion puede ir sin texto SI lleva un medio (un reel se explica
     solo), pero no puede ir vacia del todo. La base de datos no puede
     comprobarlo: el CHECK de `posts` no ve `post_media`, que se inserta
     despues.

  2. Las categorias del podcast solo las toca su dueno. Que el movil ensene el
     boton unicamente en el perfil propio es comodidad, no seguridad.
"""

import pytest
from pydantic import ValidationError

from app.core.exceptions import ForbiddenError, NotFoundError
from app.modules.content.models import PodcastCategory
from app.modules.content.router import _categoria_propia
from app.modules.content.schemas import (
    PodcastCategoryCreate,
    PostCreate,
    PostMediaInput,
)


# --------------------------------------------------------------------------- #
# Publicar
# --------------------------------------------------------------------------- #
def test_una_publicacion_de_solo_texto_sigue_valiendo():
    assert PostCreate(body="Hoy comprendi algo").body == "Hoy comprendi algo"


def test_un_reel_sin_pie_de_texto_se_admite():
    """Lo que se rompia antes: obligaba a escribir para poder compartir video."""
    payload = PostCreate(
        body="",
        media=[PostMediaInput(storage_path="uid/video.mp4", media_type="video")],
    )
    assert payload.body == ""
    assert payload.media[0].media_type == "video"


def test_una_foto_sin_texto_tambien():
    payload = PostCreate(
        image_paths=["uid/foto.jpg"],
    )
    assert payload.image_paths == ["uid/foto.jpg"]


def test_una_publicacion_vacia_del_todo_no():
    with pytest.raises(ValidationError):
        PostCreate(body="   ")


def test_el_tope_de_tres_mil_caracteres_sigue_puesto():
    with pytest.raises(ValidationError):
        PostCreate(body="a" * 3001)


# --------------------------------------------------------------------------- #
# Categorias del podcast
# --------------------------------------------------------------------------- #
class _BaseDeDatosFalsa:
    """Lo minimo para probar la guarda: devolver (o no) una fila por id."""

    def __init__(self, fila=None):
        self._fila = fila

    async def get(self, _modelo, _id):
        return self._fila


def _categoria(owner_id: str) -> PodcastCategory:
    fila = PodcastCategory()
    fila.id = "11111111-1111-1111-1111-111111111111"
    fila.owner_id = owner_id
    fila.name = "Carpinteria"
    fila.position = 0
    return fila


@pytest.mark.asyncio
async def test_su_dueno_puede_tocar_su_categoria():
    fila = _categoria("ana")
    assert await _categoria_propia(_BaseDeDatosFalsa(fila), fila.id, "ana") is fila


@pytest.mark.asyncio
async def test_nadie_toca_la_categoria_de_otra_persona():
    fila = _categoria("ana")
    with pytest.raises(ForbiddenError):
        await _categoria_propia(_BaseDeDatosFalsa(fila), fila.id, "beto")


@pytest.mark.asyncio
async def test_una_categoria_que_no_existe_es_un_404_y_no_un_500():
    with pytest.raises(NotFoundError):
        await _categoria_propia(
            _BaseDeDatosFalsa(None), "11111111-1111-1111-1111-111111111111", "ana"
        )


@pytest.mark.asyncio
async def test_un_id_con_otro_formato_no_llega_a_la_consulta():
    """Sin esto, el texto viajaria hasta Postgres y reventaria la consulta."""
    with pytest.raises(Exception):
        await _categoria_propia(_BaseDeDatosFalsa(None), "no-es-un-uuid", "ana")


def test_una_categoria_necesita_nombre():
    with pytest.raises(ValidationError):
        PodcastCategoryCreate(name="")


def test_el_nombre_de_una_categoria_tiene_tope():
    with pytest.raises(ValidationError):
        PodcastCategoryCreate(name="x" * 41)
