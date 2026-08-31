import React, { createContext, useContext } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { espacioParaLaBarra } from '@/components/FloatingGlassTabBar';
import { spacing } from '@/theme/tokens';

/**
 * CUANTO ESPACIO HAY QUE DEJAR ABAJO. Una sola respuesta para toda la app.
 *
 * EL FALLO QUE CIERRA. El boton de publicar quedaba tapado —o directamente
 * fuera de alcance— en publicacion, foto, video, historia, reel y curso. Seis
 * pantallas, un solo motivo: nadie sabia cuanto ocupa el borde inferior.
 *
 * Abajo hay dos cosas que se comen pantalla y ninguna es contenido:
 *
 *   - la CAPSULA FLOTANTE de secciones, que se pinta ENCIMA de todo (la
 *     dibuja el navegador como ultimo hijo) y por tanto no solo tapa: tambien
 *     se queda el toque. Un boton debajo de ella no es que se vea mal, es que
 *     al pulsarlo se cambia de seccion.
 *   - la ZONA SEGURA del aparato (el indicador de inicio del iPhone, la barra
 *     de gestos de Android).
 *
 * Cada pantalla lo resolvia con un numero escrito a mano, y todos distintos:
 * `bottom: 44` en los tres modos de creacion, `spacing.xxxl` en el asistente de
 * cursos, `spacing.xl` en otras. Cuarenta y cuatro pixeles cuando la capsula
 * ocupa de 78 a 104 segun el aparato: de ahi que el boton estuviera tapado
 * SIEMPRE, no solo en telefonos concretos. Y no es que faltara el calculo
 * —`espacioParaLaBarra` existe desde el primer dia—, es que habia que acordarse
 * de llamarlo, y solo lo hacia quien ya se habia quemado.
 *
 * Aqui deja de ser algo que recordar. El grupo de pestañas PUBLICA cuanto ocupa
 * su barra y cualquier descendiente lo pide con `useEspacioInferior()`. Fuera de
 * las pestañas no hay barra, asi que la misma llamada devuelve solo la zona
 * segura: quien la usa no tiene que saber donde esta montado, que era
 * precisamente el dato que se equivocaba.
 */

/**
 * Lo que ocupa la barra flotante, publicado por el grupo de pestañas.
 *
 * `null` significa «aqui no hay barra», que no es lo mismo que «la barra mide
 * cero»: fuera de las pestañas hay que devolver la zona segura igualmente.
 */
const EspacioDeLaBarra = createContext<number | null>(null);

/**
 * Publica el hueco de la barra flotante para todo lo que quede debajo.
 *
 * Va en el layout de `(tabs)`, que es el unico sitio donde se sabe con certeza
 * que la capsula existe.
 */
export function ProveedorDeEspacioInferior({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <EspacioDeLaBarra.Provider value={espacioParaLaBarra(insets.bottom)}>
      {children}
    </EspacioDeLaBarra.Provider>
  );
}

/**
 * Cuanto hay que reservar abajo para que un control se pueda ver Y pulsar.
 *
 * Dentro de las pestañas: la capsula flotante entera (que ya incluye la zona
 * segura). Fuera: solo la zona segura, con un minimo para que un boton no quede
 * pegado al canto en un aparato sin muesca.
 */
export function useEspacioInferior(): number {
  const conBarra = useContext(EspacioDeLaBarra);
  const insets = useSafeAreaInsets();
  return conBarra ?? Math.max(insets.bottom, spacing.sm) + spacing.sm;
}
