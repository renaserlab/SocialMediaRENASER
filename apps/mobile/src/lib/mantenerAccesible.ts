import type { AccessibilityActionEvent, AccessibilityActionInfo } from 'react-native';

/**
 * «MANTENER PULSADO» PARA QUIEN USA LECTOR DE PANTALLA (31/10/2026).
 *
 * En el chat, mantener pulsada una burbuja abre el menú del mensaje (responder,
 * reaccionar, agregar a un tema, ponerle nombre, borrar). Con TalkBack o
 * VoiceOver ese gesto no existe tal cual: el lector necesita que el elemento
 * DECLARE la acción. En Android, `longpress` es la acción de «tocar dos veces
 * y mantener»; en iOS sale, con su etiqueta, en el rotor de acciones. Sin
 * esto, un audio o un archivo del chat se podía escuchar o bajar, pero su menú
 * no se podía abrir de ninguna forma.
 *
 * Tocar sigue siendo lo de siempre (escuchar, abrir, descargar): solo se
 * declara `longpress`, y el toque normal del lector no pasa por aquí.
 *
 * Sin `alMantener` no se declara nada: una acción que no hace nada es peor que
 * no tenerla.
 */
export type PropsDeMantenerAccesible = {
  accessibilityHint?: string;
  accessibilityActions?: AccessibilityActionInfo[];
  onAccessibilityAction?: (evento: AccessibilityActionEvent) => void;
};

export function mantenerAccesible(
  alMantener: (() => void) | undefined,
  textos: {
    /**
     * Lo que el lector dice después de la etiqueta («Mantén presionado…»).
     * Sin ella no se añade pista: la franja de la hora ya lo dice en su
     * etiqueta, y repetirlo sería oírlo dos veces.
     */
    pista?: string;
    /** El nombre de la acción en el menú del lector. */
    etiqueta: string;
  },
): PropsDeMantenerAccesible {
  if (!alMantener) return {};
  return {
    ...(textos.pista ? { accessibilityHint: textos.pista } : null),
    accessibilityActions: [{ name: 'longpress', label: textos.etiqueta }],
    onAccessibilityAction: (evento) => {
      if (evento.nativeEvent.actionName === 'longpress') alMantener();
    },
  };
}
