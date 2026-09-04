"""Cuanto puede escribir y reaccionar una persona por unidad de tiempo.

POR QUE HACE FALTA. Un chat en directo es el sitio de Z donde mas barato sale
hacer ruido: no hay que seguir a nadie, ni esperar aprobacion, y lo que se
escribe lo ven todos a la vez. Sin un limite, una sola persona con un bucle de
tres lineas llena la pantalla de cien espectadores y la emision se acaba.

DONDE ESTA EL LIMITE Y DONDE NO. Aqui, en el servidor. En el cliente tambien
habra uno —para no dejar pulsar el boton— pero eso es comodidad, no proteccion:
quien quiera saltarselo llama al endpoint directamente.

LO QUE ESTA MEMORIA NO ES, dicho antes de que alguien se confie: vive en el
PROCESO. Con dos trabajadores de uvicorn, el limite efectivo es el doble; con
cuatro, el cuadruple. Es una decision consciente y no un descuido:

  * Lo que protege es contra el ruido accidental y el bucle tonto, que es el
    99 % de los casos y se resuelve con esto.
  * La proteccion que NO se puede saltar de ninguna forma sigue estando en la
    base: 300 caracteres por mensaje y solo en salas `live` (migracion 0029).
  * Un limitador compartido de verdad exige Redis, que hoy no existe en el
    proyecto. Meterlo por esto seria pagar una infraestructura entera por un
    problema que todavia no se tiene.

Cuando haya varios trabajadores Y volumen real, esto se cambia por un contador
en Redis y no cambia nada mas: el resto del codigo solo llama a `permitido()`.
"""

from __future__ import annotations

from collections import deque
from datetime import datetime, timedelta, timezone

#: Cuantas credenciales de sala puede pedir una persona en su ventana.
#:
#: PORQUE FIRMAR CUESTA Y ENTRAR NO DEBERIA REPETIRSE. Una reconexion legitima
#: pide una credencial nueva, y eso hay que dejarlo pasar: perder la cobertura
#: en el metro y volver es normal. Lo que no es normal es pedir veinte en un
#: minuto, que es lo que hace un bucle o alguien probando.
#:
#: Diez en cinco minutos deja sitio a varias reconexiones seguidas y corta el
#: bucle. La ventana es larga a proposito: una corta se rellena sola y no
#: protege de nada.
CREDENCIALES_POR_VENTANA = 10
VENTANA_DE_CREDENCIALES = timedelta(minutes=5)

#: Cuantos mensajes puede mandar una persona en la ventana.
#:
#: Doce en treinta segundos es mas rapido de lo que nadie escribe conversando
#: —uno cada dos segundos y medio, sostenido— y muy por debajo de lo que hace
#: falta para tapar a los demas.
MENSAJES_POR_VENTANA = 12
VENTANA_DE_CHAT = timedelta(seconds=30)

#: Cuantas reacciones admite UN envio.
#:
#: El cliente acumula y manda cada pocos segundos, asi que un numero alto es
#: normal: pulsar el corazon como un poseso durante cinco segundos son unas
#: cincuenta. Doscientas deja sitio de sobra y sigue impidiendo que alguien
#: mande «he pulsado nueve millones de veces» y convierta el contador en un
#: numero que no significa nada.
LIMITE_POR_ENVIO = 200

#: Cuantos envios de reacciones se aceptan por ventana.
ENVIOS_POR_VENTANA = 10
VENTANA_DE_REACCIONES = timedelta(seconds=30)

#: Cuantas personas se recuerdan como mucho, para que esto no crezca sin fin.
#: Al pasarse se olvida a la mas antigua: perder el limite de alguien que lleva
#: media hora sin escribir no tiene ninguna consecuencia.
MAXIMO_DE_RECORDADOS = 5_000


class VentanaDeslizante:
    """Cuenta cuantas veces ha hecho algo cada persona en los ultimos segundos.

    Deslizante y no por bloques: con bloques de treinta segundos se pueden
    mandar doce mensajes en el segundo 29 y otros doce en el 31, que son
    veinticuatro seguidos —justo la rafaga que se quiere evitar—.
    """

    def __init__(self, maximo: int, ventana: timedelta) -> None:
        self._maximo = maximo
        self._ventana = ventana
        self._marcas: dict[str, deque[datetime]] = {}

    def permitido(self, clave: str, ahora: datetime | None = None) -> bool:
        """Si esta accion cabe. Si cabe, la ANOTA."""
        ahora = ahora or datetime.now(timezone.utc)
        marcas = self._marcas.get(clave)
        if marcas is None:
            if len(self._marcas) >= MAXIMO_DE_RECORDADOS:
                self._marcas.pop(next(iter(self._marcas)), None)
            marcas = deque()
            self._marcas[clave] = marcas

        limite = ahora - self._ventana
        while marcas and marcas[0] < limite:
            marcas.popleft()

        if len(marcas) >= self._maximo:
            return False
        marcas.append(ahora)
        return True

    def vaciar(self) -> None:
        """Solo para los tests: que uno no herede el ritmo del anterior."""
        self._marcas.clear()


chat = VentanaDeslizante(MENSAJES_POR_VENTANA, VENTANA_DE_CHAT)
reacciones = VentanaDeslizante(ENVIOS_POR_VENTANA, VENTANA_DE_REACCIONES)
credenciales = VentanaDeslizante(CREDENCIALES_POR_VENTANA, VENTANA_DE_CREDENCIALES)


def vaciar() -> None:
    chat.vaciar()
    reacciones.vaciar()
    credenciales.vaciar()


def acotar_envio(counts: dict[str, int]) -> dict[str, int]:
    """Recorta un envio de reacciones a lo que se admite.

    Se RECORTA en vez de rechazarse entero: quien pulso ciento noventa veces y
    manda doscientas diez no esta atacando nada, y perderle las doscientas por
    diez de mas seria castigar el entusiasmo. Lo que no se acepta es el numero
    inventado.
    """
    salida: dict[str, int] = {}
    restante = LIMITE_POR_ENVIO
    for tipo, cuantas in counts.items():
        if cuantas <= 0 or restante <= 0:
            continue
        cabe = min(int(cuantas), restante)
        salida[tipo] = cabe
        restante -= cabe
    return salida
