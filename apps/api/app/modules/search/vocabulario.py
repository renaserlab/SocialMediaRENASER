"""Como se pasa de lo que alguien escribe al tema del que esta hablando.

ESTA ES LA PARTE «INTELIGENTE» DE LA BUSQUEDA, y conviene decir exactamente
cuanto de inteligente es: NO es semantica, no hay modelo, no hay embeddings y
no hay nada que aprenda solo. Es un vocabulario controlado, escrito a mano,
sobre la taxonomia que YA existe (`topics`, migracion 0026). Un diccionario de
sinonimos con veinticinco entradas.

QUE PROBLEMA RESUELVE. «Quiero aprender a fabricar muebles» no contiene la
palabra «carpinteria» por ningun lado. Buscando solo texto, esa consulta no
encuentra al carpintero que se ofrece a ensenar, ni el curso de carpinteria, ni
las publicaciones etiquetadas con ese tema: encuentra cero resultados y la
persona se va creyendo que en Z no hay nadie. Con este fichero, «muebles» lleva
a `carpinteria`, y `carpinteria` es un id que se puede cruzar contra
`user_topic_relations`, `post_topics` y `course_topics`, que es donde el
producto ya guarda de que trata cada cosa.

POR QUE UN VOCABULARIO A MANO Y NO ALGO QUE «ENTIENDA». Porque veinticinco
temas caben en una pantalla, porque cada linea se puede leer, discutir y
corregir sin reentrenar nada, y porque falla de forma predecible: si «muebles»
no aparece aqui, no encuentra carpinteria, y se arregla anadiendo una palabra.
Un modelo que a veces acierta y no se sabe por que no se puede corregir.

LO QUE ESTO NO SABE HACER, dicho sin adornos. No entiende una frase que no use
ninguna de estas palabras («busco a alguien que me ayude con lo de la casa»),
no desambigua («banco» de sentarse frente a «banco» de dinero) y no aprende de
lo que la gente busca. Las tres cosas son ampliaciones honestas de este mismo
fichero —mas alias, alias con contexto, alias sacados de las busquedas reales—
y ninguna necesita cambiar la arquitectura.

LOS ALIAS SE ESCRIBEN YA PLEGADOS: minusculas, sin tildes, con la eñe intacta.
Es lo que devuelve `normalizacion.plegar`, y compararlos sin plegar seria
compararlos con una forma que nunca llega.
"""

from __future__ import annotations

from app.modules.search import normalizacion

#: Palabras que llevan a cada tema, indexadas por el `slug` de `topics`.
#:
#: El nombre y el slug del tema NO hace falta repetirlos aqui: se leen de la
#: base y se anaden solos (ver `detectar`). Asi, un tema nuevo sembrado por una
#: migracion futura se encuentra por su nombre desde el primer dia, aunque
#: nadie haya escrito alias para el.
ALIAS: dict[str, tuple[str, ...]] = {
    "tecnologia": (
        "tecnologia", "tecnologico", "informatica", "computacion", "software",
        "hardware", "ordenador", "computadora", "internet", "digital",
        "ciberseguridad", "redes", "sistemas", "datos", "base de datos",
    ),
    "programacion": (
        "programacion", "programar", "programador", "programadora", "codigo",
        "codear", "desarrollo", "desarrollador", "desarrolladora", "python",
        "javascript", "java", "web", "app", "aplicacion", "backend", "frontend",
        "desarrollo web", "hacer una app", "pagina web",
    ),
    "inteligencia-artificial": (
        "inteligencia artificial", "ia", "ai", "machine learning",
        "aprendizaje automatico", "chatgpt", "modelos", "automatizacion",
        "automatizar", "robotica", "algoritmo",
    ),
    "negocios": (
        "negocio", "negocios", "empresa", "empresas", "comercio", "comercial",
        "administracion", "gestion", "gerencia", "pyme", "bodega",
        "tienda", "facturacion", "proveedor", "proveedores",
    ),
    "emprendimiento": (
        "emprender", "emprendimiento", "emprendedor", "emprendedora",
        "startup", "montar un negocio", "poner un negocio", "abrir un negocio",
        "idea de negocio", "autoempleo", "independizarme",
    ),
    "marketing": (
        "marketing", "publicidad", "anuncios", "marca", "branding",
        "redes sociales", "instagram", "tiktok", "contenido", "seo",
        "community manager", "vender por internet", "clientes",
    ),
    "ventas": (
        "ventas", "vender", "vendedor", "vendedora", "comercializar",
        "negociar", "negociacion", "cierre de ventas", "atencion al cliente",
    ),
    "carpinteria": (
        "carpinteria", "carpintero", "carpintera", "madera", "maderas",
        "mueble", "muebles", "mobiliario", "ebanisteria", "ebanista",
        "fabricar muebles", "hacer muebles", "armar muebles", "melamina",
        "closet", "ropero", "mesa de madera", "barniz", "sierra", "torno",
    ),
    "electricidad": (
        "electricidad", "electrico", "electrica", "electricista",
        "instalacion electrica", "cableado", "cables", "enchufe", "enchufes",
        "tablero electrico", "cortocircuito", "electronica", "circuitos",
    ),
    "mecanica": (
        "mecanica", "mecanico", "motor", "motores", "auto", "autos", "carro",
        "carros", "coche", "moto", "motos", "taller mecanico", "reparar autos",
        "mantenimiento vehicular", "soldadura", "soldar",
    ),
    "construccion": (
        "construccion", "construir", "albanil", "albañil", "albañileria",
        "albanileria",
        "obra", "cemento", "ladrillo", "ladrillos", "gasfiteria", "gasfitero",
        "plomeria", "plomero", "pintura de casas", "acabados", "arquitectura",
        "levantar una casa", "remodelacion", "remodelar",
    ),
    "musica": (
        "musica", "musico", "cantar", "canto", "guitarra", "piano", "cajon",
        "bateria", "instrumento", "instrumentos", "produccion musical",
        "componer", "banda", "tocar guitarra",
    ),
    "arte": (
        "arte", "artista", "dibujo", "dibujar", "pintura", "pintar",
        "diseño", "diseno", "diseñar", "diseño grafico", "diseno grafico",
        "ilustracion", "manualidades",
        "artesania", "escultura", "creatividad",
    ),
    "fotografia": (
        "fotografia", "fotografo", "fotografa", "foto", "fotos", "camara",
        "retrato", "video", "grabar", "edicion de video", "iluminacion",
    ),
    "productividad": (
        "productividad", "organizarme", "organizacion", "gestion del tiempo",
        "tiempo", "enfoque", "concentracion", "procrastinacion",
        "metodo", "planificar", "agenda",
    ),
    "habitos": (
        "habito", "habitos", "rutina", "rutinas", "disciplina", "constancia",
        "motivacion", "cambiar de habitos", "dejar de", "voluntad",
    ),
    "liderazgo": (
        "liderazgo", "lider", "liderar", "equipo", "equipos", "jefe",
        "dirigir", "gestion de personas", "comunicacion", "hablar en publico",
        "oratoria", "delegar",
    ),
    "educacion": (
        "educacion", "docencia", "docente", "profesor", "profesora", "maestro",
        "maestra", "ensenanza", "pedagogia", "clases", "tutoria", "escuela",
        "colegio", "estudiar",
    ),
    "idiomas": (
        "idioma", "idiomas", "ingles", "quechua", "portugues", "frances",
        "aleman", "italiano", "traducir", "traduccion", "conversacion",
        "hablar ingles",
    ),
    "carrera-profesional": (
        "carrera", "profesional", "trabajo", "empleo", "curriculum", "cv",
        "entrevista", "entrevista de trabajo", "linkedin", "ascenso",
        "cambio de carrera", "buscar trabajo", "practicas", "primer empleo",
    ),
    "relaciones-y-familia": (
        "relaciones", "familia", "pareja", "hijos", "hijas", "crianza",
        "padres", "madre", "padre", "amistad", "convivencia", "comunicacion",
    ),
    "bienestar-personal": (
        "bienestar", "salud", "autoestima", "ansiedad", "estres", "descanso",
        "dormir", "meditacion", "ejercicio", "deporte", "alimentacion",
        "nutricion", "equilibrio", "calma",
    ),
    "experiencias-de-vida": (
        "experiencia", "experiencias", "historia", "historias", "testimonio",
        "superacion", "duelo", "migrar", "migracion", "empezar de cero",
        "cambio de vida",
    ),
    "finanzas": (
        "finanzas", "dinero", "ahorro", "ahorrar", "presupuesto", "inversion",
        "invertir", "deuda", "deudas", "credito", "prestamo", "contabilidad",
        "impuestos", "sueldo", "economia", "finanzas personales",
    ),
    "otros": (),
}

#: Los alias de mas de una palabra, aparte. Se buscan dentro de la frase entera
#: y no en la lista de palabras sueltas, porque ahi ya no estan juntos: en
#: «fabricar muebles» la lista tiene «fabricar» y «muebles», nunca la pareja.
_ALIAS_DE_FRASE: dict[str, tuple[str, ...]] = {
    slug: tuple(a for a in alias if " " in a) for slug, alias in ALIAS.items()
}

#: Los de una sola palabra, con sus plurales resueltos, en un indice invertido
#: `palabra -> {slug, ...}`. Se construye una vez al importar el modulo: hacerlo
#: en cada busqueda seria recorrer trescientos alias por pulsacion de tecla.
#:
#: Una palabra puede llevar a DOS temas («comunicacion» es liderazgo y tambien
#: relaciones). No se elige: se devuelven los dos y que el ranking decida. Elegir
#: aqui seria adivinar con menos informacion de la que hay mas abajo.
_INDICE: dict[str, set[str]] = {}
for _slug, _alias in ALIAS.items():
    for _termino in _alias:
        if " " in _termino:
            continue
        for _forma in normalizacion.raices(normalizacion.plegar(_termino)):
            _INDICE.setdefault(_forma, set()).add(_slug)


def slugs_de(consulta: str) -> set[str]:
    """Los temas que menciona esa consulta, por su `slug`. Texto puro.

    No toca la base de datos a proposito: es la parte comprobable de la
    «inteligencia» y tiene que poder probarse escribiendo una frase y leyendo
    una lista, sin levantar nada.
    """
    encontrados: set[str] = set()

    texto = normalizacion.frase(consulta)
    for slug, alias in _ALIAS_DE_FRASE.items():
        if any(a in texto for a in alias):
            encontrados.add(slug)

    for termino in normalizacion.terminos(consulta):
        for forma in normalizacion.raices(termino):
            encontrados.update(_INDICE.get(forma, ()))

    return encontrados
