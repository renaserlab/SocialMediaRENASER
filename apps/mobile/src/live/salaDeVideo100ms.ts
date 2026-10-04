import { createElement } from 'react';
import { NativeModules, Platform } from 'react-native';
import {
  HMSConfig,
  HMSLayer,
  HMSManagerModule,
  HMSPeerUpdate,
  HMSSDK,
  HMSTrackSettings,
  HMSTrackSettingsInitState,
  HMSTrackUpdate,
  HMSUpdateListenerActions,
  HMSVideoTrackSettings,
  HMSVideoViewMode,
  type HMSLocalAudioTrack,
  type HMSLocalVideoTrack,
  type HMSPeer,
  type HMSTrack,
} from '@100mslive/react-native-hms';
import { HMSVirtualBackgroundPlugin } from '@100mslive/react-native-video-plugin';

import {
  crearGestorDeCalidad,
  crearVigiaDeConexion,
  type CapaDeVideo,
  type DefinicionDeCapa,
  type EstadoDeCalidad,
  type GestorDeCalidad,
  type PreferenciaDeCalidad,
} from '@/live/calidadDeVideo';
import {
  crearGestorDeEfectos,
  type CapacidadDeEfectos,
  type ComplementoDeEfectos,
  type EfectoDeVideo,
  type EstadoDeEfectos,
  type GestorDeEfectos,
  type MotivoSinEfectos,
} from '@/live/efectosDeVideo';
import { IDS_DE_FONDOS, fondoPorId } from '@/live/fondosVirtuales';
import {
  SalaNoDisponible,
  elegirPistaPrincipal,
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
 * ES EL ÚNICO FICHERO DE LA APLICACIÓN QUE IMPORTA EL SDK, y el único que
 * importa su complemento de vídeo (`@100mslive/react-native-video-plugin`). La
 * pantalla, la máquina de estados y la política de reintentos hablan con
 * `SalaDeVideo`, así que cambiar de proveedor es escribir otro fichero como
 * este.
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
 * 3. **Nada queda encendido.** `destruir` quita el efecto, apaga las dos
 *    pistas, se va de la sala y libera la instancia del SDK, en ese orden y
 *    sin depender de que ninguna de las cuatro cosas salga bien.
 * 4. **Se ve algo.** Hasta el 23/09/2026 el adaptador conectaba pero nunca
 *    contaba que pistas habia, asi que la pantalla no tenia nada que dibujar y
 *    quien miraba se quedaba en «esperando al anfitrion». Ahora cada cambio de
 *    pista o de participante recalcula la lista y la manda (`pistas`), y
 *    `VistaDePista` dibuja cualquiera de ellas con `sdk.HmsView`.
 * 5. **Los efectos van en la pista que sale** (04/10/2026). El desenfoque y el
 *    fondo los aplica el SDK a los fotogramas de la cámara antes de
 *    codificarlos: no hay nada dibujado encima de la vista. Las reglas —una
 *    operación a la vez, límite de tiempo, vuelta a «ninguno» si falla— están
 *    en `efectosDeVideo.ts`; aquí solo se traducen sus cuatro verbos.
 * 6. **La calidad sale del SDK** (04/10/2026). `calidad` se emite con la nota
 *    de red y la degradación de pista que da 100ms, y las capas entre las que
 *    se elige son las que devuelve `getLayerDefinition()`. Sin Simulcast en la
 *    plantilla esa lista llega vacía y no se ofrece nada.
 */

/** Cuánto se espera a que el SDK conteste antes de darlo por perdido. */
const ESPERA_DE_ENTRADA_MS = 20_000;

/**
 * El iOS mínimo con el que se ofrecen efectos.
 *
 * El código nativo del SDK instalado los admite desde iOS 15; la guía de 100ms
 * para React Native pide iOS 16. Se toma el más exigente de los dos: los
 * iPhone que se quedaron en iOS 15 son además los que peor moverían el
 * procesado.
 */
const IOS_MINIMO_PARA_EFECTOS = 16;

/**
 * El identificador de instancia del SDK con el que habla el complemento.
 *
 * El complemento de efectos manda SIEMPRE este identificador, escrito a fuego
 * (`react-native-video-plugin/src/HMSVideoPlugin.ts`). El SDK se lo da a la
 * primera instancia que se construye; si al construir otra la anterior sigue
 * viva, la nueva recibe uno al azar y el complemento seguiria hablando con la
 * vieja: en iOS contestaria «hecho» sobre una pista que ya no es la que sale.
 *
 * Por eso `entrar` suelta la instancia anterior antes de construir otra, y si
 * aun asi la nueva no tiene este identificador, no se ofrecen efectos.
 */
const ID_DEL_COMPLEMENTO = '12345';

/** Cuanto se espera antes de volver a preguntar por las capas de una pista. */
const ESPERA_PARA_RELEER_CAPAS_MS = 4_000;

/** Las capas de 100ms, en el idioma del contrato. */
const CAPA_DEL_SDK: Record<CapaDeVideo, HMSLayer> = {
  baja: HMSLayer.LOW,
  media: HMSLayer.MEDIUM,
  alta: HMSLayer.HIGH,
};

function capaDelContrato(capa: unknown): CapaDeVideo | null {
  if (capa === HMSLayer.LOW) return 'baja';
  if (capa === HMSLayer.MEDIUM) return 'media';
  if (capa === HMSLayer.HIGH) return 'alta';
  return null;
}

/**
 * Por qué ESTE aparato no puede aplicar efectos, o `null` si puede.
 *
 * Se mira antes de ofrecer nada: un control que solo falla al pulsarlo es peor
 * que uno que explica por qué no está.
 */
function motivoSinEfectos(): MotivoSinEfectos | null {
  if (Platform.OS === 'android') {
    // El módulo nativo llega con la compilación 1.2.0. Una actualización de
    // JavaScript sobre un binario anterior no lo trae.
    return NativeModules.ReactNativeVideoPlugin ? null : 'sin_modulo';
  }
  if (Platform.OS === 'ios') {
    const mayor = parseInt(String(Platform.Version), 10);
    if (!(mayor >= IOS_MINIMO_PARA_EFECTOS)) return 'sistema_antiguo';
    const modulo = HMSManagerModule as { enableVideoPlugin?: unknown } | null | undefined;
    return typeof modulo?.enableVideoPlugin === 'function' ? null : 'sin_modulo';
  }
  return 'sin_proveedor';
}

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

  /* ----- Efectos de la cámara propia ----- */

  /**
   * El complemento de 100ms. Se crea la primera vez que esta persona entra
   * PUBLICANDO en un aparato que lo admite, y se reutiliza si vuelve a entrar.
   */
  private complemento: HMSVirtualBackgroundPlugin | null = null;
  private efectosDeLaSala: GestorDeEfectos | null = null;
  /** Por qué no hay efectos mientras no haya gestor. */
  private motivoSinEfectos: MotivoSinEfectos = 'no_publica';
  /** Si la instancia del SDK de ahora es la que conoce el complemento. */
  private complementoAlcanzable = true;

  /* ----- Calidad de lo que se recibe ----- */

  /** La pista ajena que se está viendo. Es la única a la que se le pide capa. */
  private pistaVista: string | null = null;
  private readonly vigia = crearVigiaDeConexion((buena) => {
    this.avisar({ tipo: 'calidad', buena });
  });
  private readonly calidadDeLaSala: GestorDeCalidad = crearGestorDeCalidad({
    leerCapas: (pistaId) => this.leerCapas(pistaId),
    fijarCapa: (pistaId, capa) => this.fijarCapa(pistaId, capa),
    alCambiar: (estado) => this.avisar({ tipo: 'capas', estado }),
    programar: (fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    esperaParaReleerMs: ESPERA_PARA_RELEER_CAPAS_MS,
  });

  /**
   * Dibuja una pista con el `HmsView` de ESTA instancia del SDK.
   *
   * Es un campo y no un metodo para que su identidad no cambie entre renders:
   * React desmontaria y volveria a montar la vista de video en cada pintado.
   * Sin SDK (antes de entrar, despues de salir) no pinta nada.
   */
  readonly VistaDePista = ({ pistaId, espejo, estilo, capaAutomatica }: PropsDeVistaDePista) => {
    const HmsView = this.sdk?.HmsView;
    if (!HmsView || !pistaId) return null;
    return createElement(HmsView, {
      trackId: pistaId,
      mirror: espejo,
      scaleType: HMSVideoViewMode.ASPECT_FILL,
      // `autoSimulcast` es la selección automática de capa del propio SDK.
      // Se apaga solo cuando la persona ha fijado una calidad.
      autoSimulcast: capaAutomatica !== false,
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

  /**
   * Prepara los efectos para quien va a publicar. Devuelve lo que hay que
   * pasarle a `HMSSDK.build`, o `undefined` si no hace falta nada.
   *
   * EL COMPLEMENTO SOLO SE PASA AL CONSTRUIR EN iOS, que es donde el SDK lo
   * lee (lo engancha a la pista al crearla y lo deja apagado). En Android el
   * SDK no mira ese ajuste —el complemento se añade a la pista al activarlo—,
   * así que no se le pasan ajustes de pista y los suyos siguen siendo
   * exactamente los de antes.
   *
   * CON UN EFECTO POR REPONER, LA CÁMARA NACE APAGADA (`reponer`). Es la
   * única forma de que quien emitía con el fondo tapado no lo enseñe durante
   * los segundos que tarda el efecto en volver tras una caída. La enciende
   * `reponerEfecto` cuando el efecto ya está puesto.
   */
  private prepararEfectos(publicar: boolean, reponer: boolean): HMSTrackSettings | undefined {
    if (!publicar) {
      this.motivoSinEfectos = 'no_publica';
      return undefined;
    }
    const motivo = motivoSinEfectos();
    if (motivo) {
      this.motivoSinEfectos = motivo;
      return undefined;
    }

    if (!this.complemento) this.complemento = new HMSVirtualBackgroundPlugin();
    const complemento = this.complemento;
    if (!this.efectosDeLaSala) {
      const verbos: ComplementoDeEfectos = {
        activar: () => complemento.enable(),
        desactivar: () => complemento.disable(),
        // En iOS el radio lo fija el SDK al construir y este valor no se usa.
        desenfocar: (radio) => complemento.setBlur(radio),
        ponerFondo: (fondoId) => {
          const fondo = fondoPorId(fondoId);
          // Solo imágenes que trae la aplicación: nunca una dirección remota.
          if (!fondo) return Promise.reject(new Error('Fondo desconocido.'));
          return complemento.setBackground(fondo.imagen);
        },
      };
      this.efectosDeLaSala = crearGestorDeEfectos({
        complemento: verbos,
        fondos: IDS_DE_FONDOS,
        programar: (fn, ms) => {
          const id = setTimeout(fn, ms);
          return () => clearTimeout(id);
        },
        alCambiar: (estado) => this.avisar({ tipo: 'efecto', estado }),
      });
    }

    const apagada = reponer ? { initialState: HMSTrackSettingsInitState.MUTED } : {};
    if (Platform.OS === 'ios') {
      return new HMSTrackSettings({
        video: new HMSVideoTrackSettings({ videoPlugin: complemento, ...apagada }),
      });
    }
    return reponer
      ? new HMSTrackSettings({ video: new HMSVideoTrackSettings(apagada) })
      : undefined;
  }

  /**
   * Vuelve a poner el efecto que había y, solo si se pudo, enciende la cámara.
   *
   * Si NO se pudo, la cámara se queda apagada y el gestor lo cuenta
   * (`se_apago`): encenderla sin el efecto sería decidir por la persona que
   * enseñe lo que había elegido tapar. La enciende ella cuando quiera.
   */
  private async reponerEfecto(gestor: GestorDeEfectos): Promise<void> {
    const estado = await gestor.laPistaEsNueva();
    if (this.destruida || !this.sdk) return;
    if (estado.error !== null || estado.efecto.tipo === 'ninguno') return;
    try {
      await this.alternarCamara(true);
    } catch {
      // La cámara sigue apagada, que es el lado seguro.
    }
  }

  private async entrar(
    credencial: CredencialDeVideo,
    publicar: boolean,
    nombre: string | undefined,
  ): Promise<void> {
    /*
      UNA INSTANCIA ANTERIOR SE SUELTA ANTES DE CONSTRUIR OTRA. La máquina de
      directo reintenta llamando a `unirse` otra vez, sin `salir` antes: tras un
      intento que falló, tras una expulsión, tras una caída. Sin esto la
      instancia vieja se quedaba viva —con cámara y micrófono si su entrada
      terminaba tarde— y la nueva nacía con otro identificador (ver
      `ID_DEL_COMPLEMENTO`). Y `salir` es además quien apunta qué efecto había,
      para reponerlo.
    */
    if (this.sdk) await this.salir();
    if (this.destruida) throw new SalaNoDisponible('La sala ya se cerró.');

    const reponer = publicar && (this.efectosDeLaSala?.hayQueReponer() ?? false);
    const ajustesDePista = this.prepararEfectos(publicar, reponer);
    const sdk = await (ajustesDePista
      ? HMSSDK.build({ trackSettings: ajustesDePista })
      : HMSSDK.build());
    if (this.destruida) {
      // Se desmontó mientras construíamos. Se suelta lo que se acaba de crear
      // en vez de dejarlo vivo sin nadie que lo apague.
      await this.soltar(sdk);
      throw new SalaNoDisponible('La sala se cerró antes de entrar.');
    }
    this.sdk = sdk;
    this.complementoAlcanzable = sdk.id === ID_DEL_COMPLEMENTO;
    this.escuchar(sdk);

    try {
      await this.unirseCon(sdk, credencial, nombre);
    } catch (fallo) {
      // Una entrada que falla no deja la instancia viva: quien reintente
      // construirá otra, y esta no puede quedarse con la cámara.
      await this.salir();
      throw fallo;
    }

    if (this.destruida) {
      await this.salir();
      throw new SalaNoDisponible('La sala se cerró al entrar.');
    }

    this.estado = {
      // Con un efecto por reponer la cámara nació apagada: ver `prepararEfectos`.
      camara: publicar && !reponer,
      microfono: publicar,
      camaraFrontal: true,
      publicando: publicar,
    };
    if (!publicar) {
      // Un espectador entra callado. El token ya no le deja publicar, pero
      // apagarlo aquí también evita que el SDK encienda la cámara un instante.
      await this.silenciar();
    }

    // Sin esto el SDK no manda la nota de red, y «conexión lenta» era un
    // estado definido que nadie emitía.
    try {
      sdk.enableNetworkQualityUpdates();
    } catch {
      // Sin nota de red queda la degradación de pista, que no depende de esto.
    }

    this.avisar({ tipo: 'conectado' });
    this.avisar({ tipo: 'medios', medios: this.medios() });
    // Quien entra cuando la emision ya empezo no recibe un ON_TRACK_UPDATE por
    // lo que ya estaba: hay que preguntar que hay nada mas entrar.
    void this.refrescarPistas();

    // La pista propia es NUEVA en cada entrada: el efecto de antes ya no está.
    if (reponer && this.efectosDeLaSala) {
      if (this.complementoAlcanzable) {
        void this.reponerEfecto(this.efectosDeLaSala);
      } else {
        // No hay forma de reponerlo en esta instancia. La cámara nació apagada
        // y así se queda; se dice igual que si el efecto hubiera fallado.
        this.avisar({
          tipo: 'efecto',
          estado: { efecto: { tipo: 'ninguno' }, aplicando: false, error: 'se_apago' },
        });
      }
    }
  }

  /** La llamada a `join`, con su límite de tiempo. Rechaza si no se entra. */
  private unirseCon(
    sdk: HMSSDK,
    credencial: CredencialDeVideo,
    nombre: string | undefined,
  ): Promise<void> {
    return new Promise<void>((resolver, rechazar) => {
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
    this.seguirLaPistaVista(video);
    if (JSON.stringify(nuevas) === JSON.stringify(this.ultimasPistas)) return;
    this.ultimasPistas = nuevas;
    this.avisar({ tipo: 'pistas', pistas: this.pistas() });
  }

  /**
   * Cuál es la pista ajena que se está viendo, para pedirle capa.
   *
   * Quien publica ve su propia cámara, que no tiene capas: para esa persona no
   * hay pista vista y por tanto no hay nada que elegir.
   */
  private seguirLaPistaVista(video: readonly PistaDeVideo[]): void {
    const principal = this.estado.publicando
      ? null
      : elegirPistaPrincipal(video, { emito: false });
    const nueva = principal?.id ?? null;
    if (nueva === this.pistaVista) return;
    this.pistaVista = nueva;
    // Otra pista: lo que se sabía de la anterior ya no vale.
    this.vigia.pistaDegradada(false);
    void this.calidadDeLaSala.cambioLaPista(nueva);
  }

  private async leerCapas(pistaId: string): Promise<DefinicionDeCapa[]> {
    const sdk = this.sdk;
    if (!sdk) return [];
    const pista = await sdk.getRemoteVideoTrackFromTrackId(pistaId);
    const definiciones = await pista.getLayerDefinition();
    const capas: DefinicionDeCapa[] = [];
    for (const definicion of definiciones ?? []) {
      const capa = capaDelContrato(definicion?.layer);
      if (!capa) continue;
      capas.push({
        capa,
        ancho: definicion.resolution?.width ?? 0,
        alto: definicion.resolution?.height ?? 0,
      });
    }
    return capas;
  }

  private async fijarCapa(pistaId: string, capa: CapaDeVideo): Promise<void> {
    const sdk = this.sdk;
    if (!sdk) throw new Error('No hay sala.');
    const pista = await sdk.getRemoteVideoTrackFromTrackId(pistaId);
    const hecho: unknown = await pista.setLayer(CAPA_DEL_SDK[capa]);
    if (hecho === false) throw new Error('El vídeo no aceptó esa calidad.');
  }

  private escuchar(sdk: HMSSDK): void {
    // Alguien entra o sale, enciende o apaga la camara o el microfono.
    sdk.addEventListener(
      HMSUpdateListenerActions.ON_TRACK_UPDATE,
      (dato: { track?: HMSTrack; type?: unknown } | undefined) => {
        // El servidor ha rebajado o cortado LA imagen que se está viendo
        // porque la red no da. No cambia qué pistas hay.
        const tipo = dato?.type;
        if (tipo === HMSTrackUpdate.TRACK_DEGRADED || tipo === HMSTrackUpdate.TRACK_RESTORED) {
          if (dato?.track?.trackId && dato.track.trackId === this.pistaVista) {
            this.vigia.pistaDegradada(tipo === HMSTrackUpdate.TRACK_DEGRADED);
          }
          return;
        }
        void this.refrescarPistas();
      },
    );
    sdk.addEventListener(
      HMSUpdateListenerActions.ON_PEER_UPDATE,
      (dato: { peer?: HMSPeer; type?: unknown } | undefined) => {
        if (dato?.type === HMSPeerUpdate.NETWORK_QUALITY_UPDATED) {
          // Llega una por participante cada pocos segundos. Solo interesa la
          // PROPIA, y no cambia las pistas: no se recalcula nada.
          if (dato.peer?.isLocal === true) {
            this.vigia.nota(dato.peer.networkQuality?.downlinkQuality);
          }
          return;
        }
        void this.refrescarPistas();
      },
    );
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
    this.pistaVista = null;
    this.vigia.reiniciar();
    void this.calidadDeLaSala.cambioLaPista(null);
    if (!sdk) return;
    await this.soltar(sdk);
  }

  /**
   * Apaga, se va y libera. NUNCA lanza: salir siempre tiene que poder ocurrir.
   *
   * EL ORDEN IMPORTA: primero se apaga la cámara, y solo después se quita el
   * efecto. Al revés (como estuvo hasta la revisión del 04/10/2026), el
   * desenfoque se quitaba con la cámara todavía emitiendo y quien miraba
   * recibía el fondo real hasta que entraba el silencio.
   */
  private async soltar(sdk: HMSSDK): Promise<void> {
    try {
      await this.silenciarEn(sdk);
    } catch {
      // Si no se pudo silenciar, salir libera igual las pistas.
    }
    try {
      // El procesado no puede quedarse enganchado a una pista que se va a
      // destruir. Tiene su propio límite de tiempo.
      await this.efectosDeLaSala?.apagarParaSalir();
    } catch {
      // Salir libera la pista igualmente.
    }
    // La pantalla tiene que dejar de marcar un efecto que ya no está puesto.
    this.avisar({ tipo: 'efecto', estado: this.estadoDeEfectos() });
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

  efectos(): CapacidadDeEfectos {
    if (!this.complementoAlcanzable) {
      return { admitidos: false, motivo: 'sin_proveedor', fondos: [] };
    }
    if (this.efectosDeLaSala && this.estado.publicando) return this.efectosDeLaSala.capacidad();
    return { admitidos: false, motivo: this.motivoSinEfectos, fondos: [] };
  }

  estadoDeEfectos(): EstadoDeEfectos {
    return (
      this.efectosDeLaSala?.estado() ?? { efecto: { tipo: 'ninguno' }, aplicando: false, error: null }
    );
  }

  async aplicarEfecto(efecto: EfectoDeVideo): Promise<EstadoDeEfectos> {
    const gestor = this.efectosDeLaSala;
    // Sin sala, sin publicar o sin complemento no hay pista que procesar. No
    // se finge: se contesta «sin efecto», y si se pidió uno, que no se pudo.
    if (
      this.destruida ||
      !this.sdk ||
      !gestor ||
      !this.estado.publicando ||
      !this.complementoAlcanzable
    ) {
      return {
        efecto: { tipo: 'ninguno' },
        aplicando: false,
        error: efecto.tipo === 'ninguno' ? null : 'no_se_pudo',
      };
    }
    return gestor.aplicar(efecto);
  }

  calidad(): EstadoDeCalidad {
    return this.calidadDeLaSala.estado();
  }

  elegirCalidad(preferencia: PreferenciaDeCalidad): Promise<EstadoDeCalidad> {
    return this.calidadDeLaSala.elegir(preferencia);
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
    this.calidadDeLaSala.destruir();
    // Sin `await`: `destruir` es síncrono porque lo llama la limpieza de un
    // efecto de React, que no espera promesas. Lo que no puede es dejar la
    // cámara encendida, así que se suelta igual y se traga cualquier fallo.
    void this.salir()
      .catch(() => {})
      .finally(() => this.efectosDeLaSala?.destruir());
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
