FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# ffmpeg: extrae el poster (un fotograma) de los videos que suben sin el.
# Lee el archivo remoto por rangos, asi que no descarga el video entero.
# La transcodificacion completa NO corre en este servicio (ver
# content/media_processing.py); ffmpeg aqui solo hace trabajos de un segundo.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
EXPOSE 8000
# Usa el puerto que asigne la plataforma (Render/Railway definen $PORT);
# fallback 8000 para ejecución local con docker.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
