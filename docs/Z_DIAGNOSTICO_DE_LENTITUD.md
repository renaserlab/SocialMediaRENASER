# Por qué Z va lenta: lo que dicen las mediciones
>
> **Seguimiento, 27 de agosto de 2026.** El diagnostico de este documento era
> correcto, pero la solucion solo habia llegado a la WEB: las builds del movil
> seguian apuntando a Render (21,5 s medidos con la instancia dormida). Ya
> apuntan a AWS. Ademas se encontro una causa mayor que ninguna de las tres de
> aqui —las imagenes se servian a tamano original: 24,7 MB en una pantalla—.
> Todo medido en [`Z_AUDITORIA_RENDIMIENTO_2026-08.md`](Z_AUDITORIA_RENDIMIENTO_2026-08.md).


Medido contra producción el **25 de agosto de 2026**, antes de tocar nada. Este
documento existe porque el diagnóstico escrito en el documento de correcciones
—«probablemente sea por Render»— acierta a medias, y la mitad que falta es la
que más cuesta arreglar si se descubre tarde.

## Resumen

Hay **tres** causas, no una. Las tres suman, y solo la primera es culpa de
Render.

| # | Causa | Coste medido | Se arregla con |
|---|---|---|---|
| 1 | El plan gratuito duerme | **21,77 s** en la primera petición | Mover a AWS (o pagar plan de pago) |
| 2 | La API está en Oregón y la base en Virginia | **~0,35 s por petición**, haya datos o no | Mover a AWS **us-east-1** |
| 3 | 0,1 CPU | ~0,15 s de proceso en cada respuesta | Cualquier instancia real |

## Cómo se midió

Peticiones repetidas al servicio en producción, midiendo tiempo total y TTFB:

```
/health                 21,771 s   <- primera, con el servicio dormido
/health                  0,296 s
/health                  0,305 s
/api/v1/catalog/courses  0,704 s   (4 filas)
/api/v1/live/sessions    0,599 s   (CERO filas)
```

## 1. El arranque en frío es real: 21,77 segundos

Confirmado. `render.yaml` lo dice y la medición lo demuestra: el plan `free`
duerme tras un rato sin tráfico, y despertar cuesta **casi 22 segundos**.

Quien abre Z después de una pausa se encuentra la aplicación cargando durante
veintidós segundos. No hay optimización de cliente que salve eso, y explica por
sí solo la queja de «la app está lentísima» de quien la abre una vez al día.

## 2. La causa que nadie había medido: la base está al otro lado del país

Este es el hallazgo importante.

```
Base de datos:  aws-0-us-east-1.pooler.supabase.com   -> Virginia
API (Render):   Oregon (US West)                      -> Oregón
```

**Cada consulta cruza Estados Unidos entero.** Ida y vuelta: unos 70 ms. Una
pantalla que encadene seis consultas paga casi medio segundo solo en viajes,
sin contar el trabajo real.

La prueba de que esto NO es un problema de consultas mal escritas:

> `/api/v1/live/sessions` tarda **0,599 s en devolver una lista vacía**.

Cero filas. No hay N+1 posible —no hay filas que multiplicar— ni datos que
serializar. Ese tiempo es coste fijo de hablar con una base que está lejos.

### Por qué importa para la decisión de AWS

El documento de correcciones pide **us-east-1 (Virginia)**. Esa elección no es
un detalle de configuración: es **la mitad del arreglo**. Poner la API en la
misma región que la base convierte esos ~70 ms en ~1 ms.

Mover el backend a AWS pero a otra región resolvería el arranque en frío y
dejaría intacto el segundo problema.

## 3. Décima de CPU

`/health` no toca la base —devuelve un diccionario fijo— y aun así tarda
**0,30 s**, de los cuales unos 0,08 s son red hasta Render. El resto es el
plan `free`: **0,1 CPU y 512 MB**. Python y SQLAlchemy sobre una décima de
núcleo cuestan lo que cuestan.

## Lo que ya se corrigió a raíz de esto

**El pool de conexiones pagaba viajes de más.** El motor se creaba así:

```python
create_async_engine(settings.database_url, echo=False, pool_pre_ping=True)
```

Sin tamaño de pool y sin reciclado. Dos consecuencias:

- `pool_pre_ping` manda un `SELECT 1` **antes de entregar cada conexión**. En
  la misma región es ~1 ms y no se nota; a través del país son ~70 ms **en cada
  petición**. Se mantiene a propósito —perder peticiones es peor que tardar— y
  su coste desaparece solo al mover la API a us-east-1.
- Sin `pool_recycle`, el pooler de Supabase corta las conexiones por su cuenta
  y el fallo aparece como un error. Reciclarlas antes lo convierte en una
  reconexión silenciosa.

## Lo que esto NO explica

Conviene decirlo para que nadie cierre la investigación antes de tiempo:

- **Las zonas negras al abrir un perfil.** La latencia de red las agrava, pero
  una imagen que tarda en aparecer suele ser un problema de la cadena de
  pósters o de claves de caché inestables, no del servidor.
- **La pantalla de Mensajes.** Si hace una consulta por conversación, los 70 ms
  se multiplican por el número de conversaciones. Ahí la latencia es el
  multiplicador, pero el N+1 es el multiplicando: hay que quitar los dos.

En una red lenta, **reducir el NÚMERO de peticiones rinde más que optimizar
cada una**.

## Qué esperar después de mover a us-east-1

Estimación, no promesa, a partir de los números de arriba:

| | Hoy | Tras el cambio |
|---|---|---|
| Primera petición tras inactividad | 21,77 s | sin arranque en frío |
| Consulta a la base (ida y vuelta) | ~70 ms | ~1 ms |
| `/live/sessions` (lista vacía) | 0,599 s | decenas de ms |

Lo que queda fuera de esa mejora es todo lo que dependa del número de
peticiones que hace cada pantalla. Eso se arregla en el código, no en la
infraestructura.
