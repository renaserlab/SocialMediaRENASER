FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# ffmpeg SI se instala, desde el 27 de agosto de 2026.
#
# Antes no estaba, y el motivo escrito aqui era este: «ffmpeg arrastra ~400 MB
# de paquetes y el build del plan gratuito de Render no lo aguanta». Era cierto
# y era la decision correcta entonces. Ya no: el backend corre en AWS sobre una
# t3.small (2 vCPU, 2 GiB) y el build no tiene ese limite.
#
# QUE ARREGLA. Sin ffmpeg, un video subido DESDE LA WEB se quedaba tal cual:
# sin poster (un rectangulo negro hasta darle al play) y sin version ligera.
# El respaldo que justificaba su ausencia solo cubria la app movil, porque la
# libreria de compresion no existe en navegador: `compressionAvailable` es
# false alli. O sea que el agujero era exactamente «publicar un video desde la
# web», y no se veia porque casi todo se sube desde el movil.
#
# `--no-install-recommends` deja la imagen en lo justo, y se limpia el indice
# de apt para no arrastrarlo en la capa final.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
EXPOSE 8000
# Usa el puerto que asigne la plataforma (Render/Railway definen $PORT);
# fallback 8000 para ejecución local con docker.
#
# `--timeout-keep-alive 75`: el balanceador de AWS reutiliza cada conexión con
# la API hasta 60 s sin tráfico, y uvicorn la cerraba a los 5 s (su valor de
# fábrica). Si el balanceador mandaba una petición justo cuando uvicorn
# cerraba, la conexión moría a medias y la app recibía un 502 suelto que no
# se reproducía nunca. La regla es que quien está DETRÁS espere más que quien
# está delante: 75 s > 60 s.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --timeout-keep-alive 75"]
