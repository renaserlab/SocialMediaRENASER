import { createElement } from 'react';
import {
  HMSConfig,
  HMSSDK,
  HMSUpdateListenerActions,
  HMSVideoViewMode,
  type HMSLocalAudioTrack,
  type HMSLocalVideoTrack,
  type HMSPeer,
} from '@100mslive/react-native-hms';

import {
  SalaNoDisponible,
  mediosApagados,
  sinPistas,
  type CredencialDeVideo,
  type EstadoDeMedios,
  type EventoDeSala,
  type PistaDeVideo,
  type PistasDeSala,
  type PropsDeVistaDePista,
  type SalaDeVideo,
} from '@/live/salaDeVideo';

/**
 * La sala de vídeo servida por 100ms.
 *
 * ES EL ÚNICO FICHERO DE LA APLICACIÓN QUE IMPORTA EL SDK. La pantalla, la
 * máquina de estados y la política de reintentos hablan con `SalaDeVideo`, así
 * que cambiar de proveedor es escribir otro fichero como este.
 *
 * NO SE IMPORTA DESDE ARRIBA. Quien lo enchufa es `registrarSalaDe100ms()`, y
 * solo en un aparato: en el navegador y en las pruebas el módulo nativo no
 * existe, y cargarlo tumbaría la exportación web entera.
 *
 * LO QUE ESTE ADAPTADOR GARANTIZA, y cada uno costó pensarlo:
 *
 * 1. **Salir siempre se puede.** Ningún método lanza sobre una sala ya
 *    destruida: la pantalla se desmonta cuando el teléfono suena o alguien
 *    pulsa Atrás a mitad de la conexión, y una promesa que se resuelve después
 *    no puede acabar en una excepción sin capturar.
 * 2. **Un espectador no publica.** `unirse` con `publicar: false` silencia
 *    cámara y micrófono nada más entrar, además de que el token que firmó el
 *    servidor ya no le da permiso.
 * 3. **Nada queda encendido.** `destruir` apaga las dos pistas, se va de la
 *    sala y libera la instancia del SDK, en ese orden y sin depender de que
 *    ninguna de las tres cosas salga bien.
 * 4. **Se ve algo.** Hasta el 23/09/2026 el adaptador conectaba pero nunca
 *    contaba que pistas habia, asi que la pantalla no tenia nada que dibujar y
 *    quien miraba se quedaba en «esperando al anfitrion». Ahora cada cambio de
 *    pista o de participante recalcula la lista y la manda (`pistas`), y
 *    `VistaDePista` dibuja cualquiera de ellas con `sdk.HmsView`.
 */

/** Cuánto se espera a que el SDK conteste antes de darlo por perdido. */
const ESPERA_DE_ENTRADA_MS = 20_000;

class SalaDe100ms implements SalaDeVideo {
  readonly proveedor = '100ms';

  private sdk: HMSSDK | null = null;
  private estado: EstadoDeMedios = mediosApagados();
  private oyentes = new Set<(evento: EventoDeSala) => void>();
  private destruida = false;
  private entrando: Promise<void> | null = null;
  private ultimasPistas: PistasDeSala = sinPistas();
  /**
   * Cada recalculo de pistas lleva un numero. `getRemotePeers` es asincrono y
   * dos cambios seguidos pueden contestar en desorden: sin esto, una lista
   * vieja que llega tarde pisaria a la nueva y se veria a alguien que ya se fue.
   */
  private generacionDePistas = 0;

  /**
   * Dibuja una pista con el `HmsView` de ESTA instancia del SDK.
   *
   * Es un campo y no un metodo para que su identidad no cambie entre renders:
   * React desmontaria y volveria a montar la vista de video en cada pintado.
   * Sin SDK (antes de entrar, despues de salir) no pinta nada.
   */
  readonly VistaDePista = ({ pistaId, espejo, estilo }: PropsDeVistaDePista) => {
    const HmsView = this.sdk?.HmsView;
    if (!HmsView || !pistaId) return null;
    return createElement(HmsView, {
      trackId: pistaId,
      mirror: espejo,
      scaleType: HMSVideoViewMode.ASPECT_FILL,
      style: estilo as never,
    });
  };

  async unirse(
    credencial: CredencialDeVideo,
    opciones: { publicar: boolean; nombre?: string },
  ): Promise<void> {
    if (this.destruida) throw new SalaNoDisponible('La sala ya se cerró.');
    // UNA SOLA ENTRADA. Dos pulsaciones seguidas, o un reintento que se cruza
    // con el primer intento, entrarian dos veces en la misma sala y dejarian
    // una conexion huerfana consumiendo camara y datos.
    if (this.entrando) return this.entrando;

    this.entrando = this.entrar(credencial, opciones.publicar, opciones.nombre).finally(() => {
      this.entrando = null;
    });
    return this.entrando;
  }

  private async entrar(
    credencial: CredencialDeVideo,
    publicar: boolean,
    nombre: string | undefined,
  ): Promise<void> {
    const sdk = await HMSSDK.build();
    if (this.destruida) {
      // Se desmontó mientras construíamos. Se suelta lo que se acaba de crear
      // en vez de dejarlo vivo sin nadie que lo apague.
      await this.soltar(sdk);
      throw new SalaNoDisponible('La sala se cerró antes de entrar.');
    }
    this.sdk = sdk;
    this.escuchar(sdk);

    await new Promise<void>((resolver, rechazar) => {
      const reloj = setTimeout(() => {
        rechazar(new Error('El vídeo no respondió a tiempo.'));
      }, ESPERA_DE_ENTRADA_MS);

      sdk.addEventListener(HMSUpdateListenerActions.ON_JOIN, () => {
        clearTimeout(reloj);
        resolver();
      });
      sdk.addEventListener(HMSUpdateListenerActions.ON_ERROR, (error: unknown) => {
        clearTimeout(reloj);
        rechazar(error instanceof Error ? error : new Error('Error del vídeo.'));
      });

      sdk
        .join(
          new HMSConfig({
            authToken: credencial.token,
            // El nombre de la persona. Antes era el id de la sala para todos,
            // asi que en el panel de 100ms nadie se distinguia de nadie.
            username: nombre?.trim() || 'Z',
          }),
        )
        .catch((error: unknown) => {
          clearTimeout(reloj);
          rechazar(error instanceof Error ? error : new Error('Error del vídeo.'));
        });
    });

    if (this.destruida) {
      await this.salir();
      throw new SalaNoDisponible('La sala se cerró al entrar.');
    }

    this.estado = {
      camara: publicar,
      microfono: publicar,
      camaraFrontal: true,
      publicando: publicar,
    };
    if (!publicar) {
      // Un espectador entra callado. El token ya no le deja publicar, pero
      // apagarlo aquí también evita que el SDK encienda la cámara un instante.
      await this.silenciar();
    }
    this.avisar({ tipo: 'conectado' });
    this.avisar({ tipo: 'medios', medios: this.medios() });
    // Quien entra cuando la emision ya empezo no recibe un ON_TRACK_UPDATE por
    // lo que ya estaba: hay que preguntar que hay nada mas entrar.
    void this.refrescarPistas();
  }

  /**
   * Recalcula las pistas desde el SDK y avisa si cambiaron.
   *
   * SE RECALCULA ENTERA en cada cambio en vez de aplicar el diff del evento:
   * con dos o tres participantes cuesta nada y no hay forma de que un evento
   * perdido deje la lista descuadrada para el resto de la emision.
   */
  private async refrescarPistas(): Promise<void> {
    const sdk = this.sdk;
    if (this.destruida || !sdk) return;
    const generacion = ++this.generacionDePistas;
    let pares: HMSPeer[];
    try {
      const [local, remotos] = await Promise.all([sdk.getLocalPeer(), sdk.getRemotePeers()]);
      pares = [...(local ? [local] : []), ...(remotos ?? [])];
    } catch {
      // Una lectura fallida no borra lo que ya se veia: llegara otro evento.
      return;
    }
    if (this.destruida || generacion !== this.generacionDePistas) return;

    const video: PistaDeVideo[] = [];
    let hayMediosAjenos = false;
    for (const par of pares) {
      const local = par.isLocal === true;
      const pista = par.videoTrack;
      const videoApagado = !pista || silenciada(pista);
      if (pista?.trackId) {
        video.push({
          id: pista.trackId,
          local,
          papel: par.role?.name ?? '',
          silenciada: videoApagado,
        });
      }
      const audio = par.audioTrack;
      const audioApagado = !audio || silenciada(audio);
      if (!local && (!videoApagado || !audioApagado)) hayMediosAjenos = true;
    }

    const nuevas: PistasDeSala = { video, hayMediosAjenos };
    if (JSON.stringify(nuevas) === JSON.stringify(this.ultimasPistas)) return;
    this.ultimasPistas = nuevas;
    this.avisar({ tipo: 'pistas', pistas: this.pistas() });
  }

  private escuchar(sdk: HMSSDK): void {
    // Alguien entra o sale, enciende o apaga la camara o el microfono.
    sdk.addEventListener(HMSUpdateListenerActions.ON_TRACK_UPDATE, () => {
      void this.refrescarPistas();
    });
    sdk.addEventListener(HMSUpdateListenerActions.ON_PEER_UPDATE, () => {
      void this.refrescarPistas();
    });
    sdk.addEventListener(HMSUpdateListenerActions.RECONNECTING, () => {
      this.avisar({ tipo: 'reconectando' });
    });
    sdk.addEventListener(HMSUpdateListenerActions.RECONNECTED, () => {
      this.avisar({ tipo: 'reconectado' });
    });
    sdk.addEventListener(HMSUpdateListenerActions.ON_REMOVED_FROM_ROOM, () => {
      // Expulsado o sala cerrada: NO es recuperable. Reintentar sería volver a
      // llamar a una puerta que acaban de cerrar.
      this.avisar({ tipo: 'desconectado', recuperable: false, motivo: 'fuera_de_la_sala' });
    });
  }

  async salir(): Promise<void> {
    const sdk = this.sdk;
    this.sdk = null;
    this.estado = mediosApagados();
    this.ultimasPistas = sinPistas();
    // Invalida cualquier recalculo en vuelo: su respuesta ya no es de nadie.
    this.generacionDePistas += 1;
    if (!sdk) return;
    await this.soltar(sdk);
  }

  /** Apaga, se va y libera. NUNCA lanza: salir siempre tiene que poder ocurrir. */
  private async soltar(sdk: HMSSDK): Promise<void> {
    try {
      await this.silenciarEn(sdk);
    } catch {
      // Si no se pudo silenciar, salir libera igual las pistas.
    }
    try {
      await sdk.leave();
    } catch {
      // Puede que ya no estuviéramos dentro.
    }
    try {
      sdk.removeAllListeners();
      await sdk.destroy();
    } catch {
      // Liberar dos veces no es un error.
    }
  }

  async alternarCamara(encendida: boolean): Promise<EstadoDeMedios> {
    await this.conPistaDeVideo((pista) => pista.setMute(!encendida));
    this.estado = { ...this.estado, camara: encendida };
    this.avisar({ tipo: 'medios', medios: this.medios() });
    return this.medios();
  }

  async alternarMicrofono(encendido: boolean): Promise<EstadoDeMedios> {
    await this.conPistaDeAudio((pista) => pista.setMute(!encendido));
    this.estado = { ...this.estado, microfono: encendido };
    this.avisar({ tipo: 'medios', medios: this.medios() });
    return this.medios();
  }

  async cambiarCamara(): Promise<EstadoDeMedios> {
    await this.conPistaDeVideo((pista) => pista.switchCamera());
    this.estado = { ...this.estado, camaraFrontal: !this.estado.camaraFrontal };
    this.avisar({ tipo: 'medios', medios: this.medios() });
    return this.medios();
  }

  medios(): EstadoDeMedios {
    // Copia: quien la reciba no puede cambiar el estado de la sala escribiendo
    // en el objeto que le dieron.
    return { ...this.estado };
  }

  pistas(): PistasDeSala {
    return {
      video: this.ultimasPistas.video.map((pista) => ({ ...pista })),
      hayMediosAjenos: this.ultimasPistas.hayMediosAjenos,
    };
  }

  alOcurrir(oyente: (evento: EventoDeSala) => void): () => void {
    this.oyentes.add(oyente);
    return () => {
      this.oyentes.delete(oyente);
    };
  }

  destruir(): void {
    if (this.destruida) return;
    this.destruida = true;
    this.oyentes.clear();
    // Sin `await`: `destruir` es síncrono porque lo llama la limpieza de un
    // efecto de React, que no espera promesas. Lo que no puede es dejar la
    // cámara encendida, así que se suelta igual y se traga cualquier fallo.
    void this.salir().catch(() => {});
  }

  // ------------------------------------------------------------------ //

  private async silenciar(): Promise<void> {
    if (this.sdk) await this.silenciarEn(this.sdk);
  }

  private async silenciarEn(sdk: HMSSDK): Promise<void> {
    // `localVideoTrack()` y no `videoTrack`: la segunda es la pista generica
    // del par, que no se puede silenciar. Solo la LOCAL tiene `setMute`.
    const local = await sdk.getLocalPeer();
    local?.localVideoTrack()?.setMute(true);
    local?.localAudioTrack()?.setMute(true);
  }

  private async conPistaDeVideo(
    hacer: (pista: HMSLocalVideoTrack) => void,
  ): Promise<void> {
    if (this.destruida || !this.sdk) return;
    const local = await this.sdk.getLocalPeer();
    const pista = local?.localVideoTrack();
    if (pista) hacer(pista);
  }

  private async conPistaDeAudio(
    hacer: (pista: HMSLocalAudioTrack) => void,
  ): Promise<void> {
    if (this.destruida || !this.sdk) return;
    const local = await this.sdk.getLocalPeer();
    const pista = local?.localAudioTrack();
    if (pista) hacer(pista);
  }

  private avisar(evento: EventoDeSala): void {
    if (this.destruida) return;
    for (const oyente of [...this.oyentes]) {
      try {
        oyente(evento);
      } catch {
        // Un oyente que revienta no puede llevarse por delante a los demás.
      }
    }
  }
}

/**
 * Si una pista esta silenciada. `isMute()` es lo que documenta el SDK; `mute`
 * es el valor que trae el objeto cuando la pista llega serializada del puente
 * nativo. Ante la duda, NO silenciada: mejor un panel que intenta pintar que
 * uno negro sobre alguien que si esta emitiendo.
 */
function silenciada(pista: { isMute?: () => boolean | undefined; mute?: boolean }): boolean {
  try {
    const valor = typeof pista.isMute === 'function' ? pista.isMute() : undefined;
    return (valor ?? pista.mute) === true;
  } catch {
    return pista.mute === true;
  }
}

/** Una sala nueva. Cada emisión usa la suya. */
export function crearSalaDe100ms(): SalaDeVideo {
  return new SalaDe100ms();
}
