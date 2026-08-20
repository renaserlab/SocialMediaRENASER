FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# AQUI NO SE INSTALA ffmpeg, y es a proposito.
#
# Se intento: `media_processing.py` sabe usarlo para sacar el poster de un
# video que llegue sin el. Pero ffmpeg arrastra ~400 MB de paquetes y el build
# del plan gratuito de Render no lo aguanta: el despliegue quedo en
# `no-deploy`, es decir, sin ninguna version viva.
#
# No se pierde nada, porque el poster ya viene cubierto dos veces:
#   1. lo genera el TELEFONO al subir (services/mediaCompressor.ts), que es
#      donde el video ya esta en local y sacar un fotograma es instantaneo;
#   2. para el contenido antiguo lo genera scripts/procesar_media.py, que
#      corre en una maquina de verdad.
# Y el codigo ya degrada solo: sin ffmpeg en el sistema simplemente se salta
# ese paso (ver `_ffmpeg()`), sin romper nada.
#
# Si algun dia el servicio deja de ser gratuito, basta con reponer aqui el
# apt-get install de ffmpeg para que el respaldo del servidor vuelva a estar.

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
EXPOSE 8000
# Usa el puerto que asigne la plataforma (Render/Railway definen $PORT);
# fallback 8000 para ejecución local con docker.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
