import React, { useEffect, useRef, useState } from 'react';

import { CampoDeBusqueda } from '@/components/CampoDeBusqueda';
import { useTranslation } from '@/i18n/useTranslation';
import {
  ESPERA_DE_TECLEO_MS,
  esBuscable,
  normalizarTermino,
} from '@/lib/busquedaProgresiva';

type Props = {
  /**
   * Se llama con el término YA LISTO para viajar, después del antirrebote.
   *
   * Cadena vacía significa «deja de buscar»: la pantalla vuelve a pedir la lista
   * entera. Nunca se llama con lo que se está tecleando a medias.
   */
  alBuscar: (termino: string) => void;
};

/**
 * La barra de búsqueda de la bandeja. Su estado NO repinta la lista.
 *
 * -----------------------------------------------------------------------------
 * POR QUÉ ES UN COMPONENTE APARTE Y NO UN `TextInput` DENTRO DE LA PANTALLA
 * -----------------------------------------------------------------------------
 * Porque el texto tecleado vivía en el estado de `MessagesScreen`, y ahí cada
 * pulsación volvía a pintar la lista entera: `data` cambiaba de identidad, el
 * `renderItem` era una flecha en línea y la cabecera se reconstruía. Medido en
 * `docs/Z_MEDICION_MENSAJES_EXPLORE.md` §2.4: en una pantalla de 812 px caben
 * 7-8 filas, así que escribir un nombre de ocho letras eran unos **64 renders de
 * fila**, sin `React.memo` en ninguna.
 *
 * Aquí el texto es estado LOCAL. Teclear repinta este componente y nada más; la
 * pantalla solo se entera cuando el término se asienta.
 *
 * -----------------------------------------------------------------------------
 * EL ANTIRREBOTE NO SE INVENTA: SE REUTILIZA
 * -----------------------------------------------------------------------------
 * `ESPERA_DE_TECLEO_MS`, `esBuscable` y `normalizarTermino` salen de
 * `lib/busquedaProgresiva.ts`, que ya usan Explorar y Buscar y que está probado.
 * Sin antirrebote, escribir «martinez» son **ocho peticiones**; con él, una o
 * dos. Y el mínimo de dos caracteres evita pedir la bandeja entera —filtrada por
 * «a»— en cuanto alguien toca el campo.
 *
 * Que una respuesta lenta no pise a una más nueva se decide en la pantalla, con
 * el sello de `lib/bandeja.ts`: aquí no se sabe cuándo vuelve nada.
 */
export const BuscadorDeConversaciones = React.memo(function BuscadorDeConversaciones({
  alBuscar,
}: Props) {
  const { t } = useTranslation();
  const [texto, setTexto] = useState('');
  // Hay un termino tecleado que todavia no se le ha dicho a la pantalla.
  const [pendiente, setPendiente] = useState(false);

  /*
    El último término que se le ha comunicado a la pantalla.

    Sin esto, pasar de «ana » a «ana» —un espacio de sobra que la normalización
    quita— relanzaría la misma búsqueda. Y al montar volvería a pedirse la lista
    sin filtro, que la pantalla ya está pidiendo por su cuenta.
  */
  const ultimoEnviado = useRef('');

  useEffect(() => {
    const termino = esBuscable(texto) ? normalizarTermino(texto) : '';
    if (termino === ultimoEnviado.current) {
      setPendiente(false);
      return;
    }
    setPendiente(true);
    const temporizador = setTimeout(() => {
      ultimoEnviado.current = termino;
      setPendiente(false);
      alBuscar(termino);
    }, ESPERA_DE_TECLEO_MS);
    // Cada tecla cancela el disparo anterior: es lo que convierte ocho
    // peticiones en una.
    return () => clearTimeout(temporizador);
  }, [texto, alBuscar]);

  /*
    EL CAMPO ES EL MISMO QUE EL DE EXPLORAR (`CampoDeBusqueda`): el foco, la X,
    «Cancelar» y el indicador se comportan igual en las dos pantallas. Lo que
    es de la bandeja —el texto local y el antirrebote— sigue aqui arriba.
  */
  return (
    <CampoDeBusqueda
      value={texto}
      onChangeText={setTexto}
      placeholder={t('messages.searchPlaceholder')}
      etiquetaDeLimpiar={t('messages.searchClear')}
      // Mientras el termino aun no se ha asentado, la pregunta esta por salir.
      buscando={pendiente}
      alto={40}
    />
  );
});
