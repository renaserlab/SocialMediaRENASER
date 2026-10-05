import React from 'react';

import { AppErrorFallback } from '@/components/AppErrorFallback';
import { detalleDelFallo } from '@/lib/dondeFallo';

type Props = {
  /** La pantalla que hay delante: se dice junto al fallo. */
  ruta?: string | null;
  children: React.ReactNode;
};

type Estado = { error: Error | null; detalle: string };

/**
 * La red de seguridad QUE SABE DÓNDE SE CAYÓ.
 *
 * La de expo-router (`ErrorBoundary` en el layout raíz) recibe el error y nada
 * más. React, en cambio, le dice a un límite propio en qué componente ocurrió
 * (`componentDidCatch`), y eso es justo lo que faltaba el 05/10/2026: un
 * «Maximum update depth exceeded» al abrir la aplicación, sin una sola pista
 * de qué pantalla lo provocaba.
 *
 * Va DENTRO del layout raíz, alrededor de la navegación: recoge lo que falle
 * en cualquier pantalla antes que la de expo-router, que sigue estando detrás
 * para lo que falle en el propio layout.
 */
export class LimiteDeErrores extends React.Component<Props, Estado> {
  state: Estado = { error: null, detalle: '' };

  static getDerivedStateFromError(error: Error): Partial<Estado> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.setState({
      detalle: detalleDelFallo({
        pilaDeComponentes: info.componentStack,
        pila: error?.stack,
        ruta: this.props.ruta,
      }),
    });
  }

  reintentar = (): void => {
    this.setState({ error: null, detalle: '' });
  };

  render(): React.ReactNode {
    const { error, detalle } = this.state;
    if (error) return <AppErrorFallback error={error} retry={this.reintentar} detalle={detalle} />;
    return this.props.children;
  }
}
