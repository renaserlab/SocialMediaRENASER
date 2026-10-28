import { useEffect, useState } from 'react';

import {
  MessageRepository,
  SIN_FUNCIONES,
  type FuncionesDelChat,
} from '@/repositories/MessageRepository';

/**
 * Lo último que dijo el servidor, para toda la sesión. No depende de quién
 * mira: describe la instalación, no a la persona.
 */
let sabidas: FuncionesDelChat | null = null;

/**
 * Qué funciones del chat tiene HOY el servidor: silenciar, vaciar, reaccionar…
 *
 * NUNCA UN BOTÓN MUERTO. Mientras no se sabe, se da por hecho que ninguna: es
 * preferible no ofrecer algo un instante a ofrecerlo y que falle. Se vuelve a
 * preguntar cada vez que se monta —el servidor puede haberse actualizado—,
 * pero lo ya sabido se enseña sin esperar a la red. El repositorio comparte
 * la respuesta unos minutos (`leerDisponibilidadDelChat`): montar varias
 * pantallas seguidas no son varias peticiones.
 */
export function useFuncionesDelChat(activo: boolean): FuncionesDelChat {
  const [funciones, setFunciones] = useState<FuncionesDelChat>(sabidas ?? SIN_FUNCIONES);

  useEffect(() => {
    if (!activo) return;
    let montado = true;
    void MessageRepository.funciones().then((leidas) => {
      sabidas = leidas;
      if (montado) setFunciones(leidas);
    });
    return () => {
      montado = false;
    };
  }, [activo]);

  return funciones;
}
