import { Alert, Platform } from 'react-native';

type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

/** Peticion que resuelve `DialogHost`. */
export type DialogRequest = {
  title: string;
  message?: string;
  confirmLabel: string;
  /** Sin valor, el dialogo tiene un solo boton (aviso, no confirmacion). */
  cancelLabel?: string;
  destructive: boolean;
  resolve: (accepted: boolean) => void;
};

/**
 * Puente con el dialogo de la propia app.
 *
 * `confirm` y `notify` se llaman desde funciones sueltas (repositorios,
 * acciones del store), no solo desde componentes, asi que no pueden apoyarse en
 * un contexto de React. `DialogHost` se registra aqui al montarse y estas
 * funciones le pasan la peticion.
 */
let present: ((request: DialogRequest) => void) | null = null;

export function registerDialogHost(fn: ((request: DialogRequest) => void) | null): void {
  present = fn;
}

/** Ultimo recurso si el dialogo aun no esta montado (arranque, pruebas). */
function fallbackConfirm(o: ConfirmOptions): Promise<boolean> {
  if (Platform.OS === 'web') {
    const text = o.message ? `${o.title}\n\n${o.message}` : o.title;
    return Promise.resolve(typeof window !== 'undefined' ? window.confirm(text) : false);
  }
  return new Promise((resolve) => {
    Alert.alert(o.title, o.message, [
      { text: o.cancelLabel ?? 'Cancelar', style: 'cancel', onPress: () => resolve(false) },
      {
        text: o.confirmLabel ?? 'Aceptar',
        style: o.destructive ? 'destructive' : 'default',
        onPress: () => resolve(true),
      },
    ]);
  });
}

/**
 * Confirmacion con el dialogo de la app: mismo aspecto en movil y en web.
 *
 * Antes usaba `Alert.alert` en movil y `window.confirm` en web. El nativo del
 * navegador anuncia "localhost dice", no se puede estilizar y bloquea el hilo
 * de JavaScript mientras esta abierto.
 */
export function confirm({
  title,
  message,
  confirmLabel = 'Aceptar',
  cancelLabel = 'Cancelar',
  destructive = false,
}: ConfirmOptions): Promise<boolean> {
  if (present) {
    return new Promise((resolve) => {
      present?.({ title, message, confirmLabel, cancelLabel, destructive, resolve });
    });
  }
  return fallbackConfirm({ title, message, confirmLabel, cancelLabel, destructive });
}

/** Aviso de un solo boton. */
export function notify(title: string, message?: string): void {
  if (present) {
    present({
      title,
      message,
      confirmLabel: 'Entendido',
      destructive: false,
      resolve: () => {},
    });
    return;
  }
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') {
      window.alert(message ? `${title}\n\n${message}` : title);
    }
    return;
  }
  Alert.alert(title, message);
}
