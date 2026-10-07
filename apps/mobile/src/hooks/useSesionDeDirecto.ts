import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { FEATURE_LIVE } from '@/config/features';
import { traduceEnElIdiomaActual, type TranslationKey } from '@/i18n';
import { confirm } from '@/lib/confirm';
import { pedirPermiso } from '@/lib/permisos';
import {
  calidadSinOpciones,
  type EstadoDeCalidad,
  type PreferenciaDeCalidad,
} from '@/live/calidadDeVideo';
import {
  estadoSinEfectos,
  type CapacidadDeEfectos,
  type EfectoDeVideo,
  type EstadoDeEfectos,
} from '@/live/efectosDeVideo';
import { asegurarProveedorDeVideo } from '@/live/registro100ms';
import {
  crearSesionDeDirecto,
  vistaInicialDeDirecto,
  type EstadoDeSesion,
  type SesionDeDirecto,
  type VistaDeDirecto,
} from '@/live/maquinaDeDirecto';
import { esperaAntesDeReintentar } from '@/live/reintentos';
import {
  crearSalaDeVideo,
  sinPistas,
  type CredencialDeVideo,
  type PistasDeSala,
  type SalaDeVideo,
} from '@/live/salaDeVideo';
import { fallo, LiveRepository } from '@/repositories/LiveRepository';
import { useAppStore } from '@/store/useAppStore';

/**
 * El cable entre la maquina de directo y React. Aqui NO se decide nada.
 *
 * Todo lo que tiene reglas —que estado se pinta, cuando se reintenta, a quien
 * se le piden permisos, si hay que confirmar antes de salir— vive en
 * `live/maquinaDeDirecto.ts`, que se ejecuta con `node --test`. Este fichero
 * solo hace las tres cosas que un hook tiene que hacer: construir el entorno
 * con las implementaciones de verdad, guardar la vista en estado de React para
 * que repinte, y desmontar limpiando.
 *
 * Si algo de aqui empieza a parecer una decision, es que esta en el fichero
 * equivocado.
 */

export type OpcionesDeSesion = {
  emisionId: string;
  /** El `status` de la ficha. `null` mientras se esta cargando. */
  estadoDeSesion: EstadoDeSesion | null;
  /** `can_manage` del servidor. */
  esAnfitrion: boolean;
  /** Empieza o termina la emision en el servidor y refresca la ficha. */
  alCambiarLaFicha: (accion: 'empezar' | 'terminar') => Promise<void>;
  /** Banda de error de la pantalla. */
  avisar: (texto: string) => void;
};

export type SesionEnPantalla = {
  vista: VistaDeDirecto;
  /** Los gestos. Es la propia maquina, sin envolver. */
  sesion: SesionDeDirecto;
  /** Las pistas de video que hay en la sala ahora mismo. */
  pistas: PistasDeSala;
  /** Dibuja una pista de ESTA sala, o `null` si la sala no sabe dibujar. */
  VistaDePista: SalaDeVideo['VistaDePista'];
  /** Los efectos de la camara propia: que se puede, que hay puesto, y pedir. */
  efectos: {
    capacidad: CapacidadDeEfectos;
    estado: EstadoDeEfectos;
    aplicar: (efecto: EfectoDeVideo) => void;
  };
  /** La calidad de lo que se recibe: entre que se elige, y elegir. */
  calidad: {
    estado: EstadoDeCalidad;
    elegir: (preferencia: PreferenciaDeCalidad) => void;
  };
};

export function useSesionDeDirecto({
  emisionId,
  estadoDeSesion,
  esAnfitrion,
  alCambiarLaFicha,
  avisar,
}: OpcionesDeSesion): SesionEnPantalla {
  const [vista, setVista] = useState<VistaDeDirecto>(() =>
    vistaInicialDeDirecto(estadoDeSesion),
  );
  const [pistas, setPistas] = useState<PistasDeSala>(sinPistas);
  const [efectos, setEfectos] = useState<EstadoDeEfectos>(estadoSinEfectos);
  const [calidad, setCalidad] = useState<EstadoDeCalidad>(calidadSinOpciones);

  /*
    Lo que cambia en cada render entra por una referencia y NO por las
    dependencias del `useMemo`. Si el entorno se reconstruyera cada vez que
    cambia una de estas funciones, la maquina se destruiria y volveria a nacer a
    mitad de conexion —y con ella la sala—, que es la forma mas rapida de dejar
    dos salas vivas y la camara encendida en la que ya nadie mira.

    `estadoDeSesion` esta aqui por lo mismo: cambia con cada evento de Realtime
    y se le cuenta a la maquina con `cambiaLaSesion`, que sabe soltar la sala
    cuando la emision termina.
  */
  const ultimas = useRef({ alCambiarLaFicha, avisar, estadoDeSesion, esAnfitrion });
  ultimas.current = { alCambiarLaFicha, avisar, estadoDeSesion, esAnfitrion };

  /**
   * La sala y la maquina nacen JUNTAS y mueren juntas.
   *
   * Van en el mismo `useMemo` para que no puedan descasarse: con la sala en una
   * referencia aparte, un render que descartara este resultado —React puede
   * hacerlo— dejaria la referencia apuntando a una sala cuya maquina ya no
   * existe, y nadie la destruiria.
   */
  const motor = useMemo(() => {
    // El SDK se enchufa AQUI, la primera vez que alguien abre una transmision,
    // y no al arrancar la aplicacion: cargar un modulo nativo cuesta memoria y
    // arranque, y la mayoria de las sesiones de Z no ven un directo.
    asegurarProveedorDeVideo();
    const sala: SalaDeVideo = crearSalaDeVideo();

    const maquina = crearSesionDeDirecto({
      esAnfitrion: () => ultimas.current.esAnfitrion,
      banderaEncendida: FEATURE_LIVE,
      estadoInicialDeSesion: ultimas.current.estadoDeSesion,

      pedirCredencial: async ({ publicar }) => {
        const credencial = await LiveRepository.solicitarCredencial(emisionId, { publicar });
        return {
          puedePublicar: credencial.puedePublicar,
          hayVideo: LiveRepository.hayVideo(credencial),
          opaca: credencial,
        };
      },
      clasificarFallo: fallo,
      pedirPermiso: async (tipo) => (await pedirPermiso(tipo)) === 'concedido',

      // La credencial viaja OPACA por la maquina —que no debe saber su forma— y
      // se vuelve a abrir aqui, que es donde el SDK la va a usar.
      unirseALaSala: (credencial, publicar) =>
        sala.unirse(credencial as CredencialDeVideo, {
          publicar,
          // Como aparece para los demas. Se lee al entrar, no al montar: el
          // perfil puede llegar despues que la pantalla.
          nombre: useAppStore.getState().user?.fullName,
        }),
      salirDeLaSala: () => sala.salir(),
      alternarCamaraEnLaSala: async (encendida) => {
        await sala.alternarCamara(encendida);
      },
      alternarMicrofonoEnLaSala: async (encendido) => {
        await sala.alternarMicrofono(encendido);
      },
      cambiarCamaraEnLaSala: async () => {
        await sala.cambiarCamara();
      },
      destruirLaSala: () => sala.destruir(),

      empezarEnElServidor: () => ultimas.current.alCambiarLaFicha('empezar'),
      terminarEnElServidor: () => ultimas.current.alCambiarLaFicha('terminar'),
      confirmarFinal: () =>
        confirm({
          title: traduceEnElIdiomaActual('live.endConfirmTitle'),
          message: traduceEnElIdiomaActual('live.endConfirmBody'),
          confirmLabel: traduceEnElIdiomaActual('live.end'),
          destructive: true,
        }),
      confirmarSalida: () =>
        confirm({
          title: traduceEnElIdiomaActual('live.leaveConfirmTitle'),
          message: traduceEnElIdiomaActual('live.leaveConfirmBody'),
          confirmLabel: traduceEnElIdiomaActual('live.leaveAnyway'),
          destructive: true,
        }),

      esperaAntesDeReintentar,
      programar: (fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },

      alCambiar: setVista,
      // La maquina manda CLAVES, no frases: no puede importar el diccionario
      // sin dejar de ejecutarse con `node --test`.
      avisar: (clave) => ultimas.current.avisar(traduceEnElIdiomaActual(clave as TranslationKey)),
    });

    return { sala, maquina };
    // SOLO `emisionId`. `esAnfitrion` sale de `can_manage`, que llega en la
    // ficha y puede cambiar entre lecturas; tenerlo aqui destruia la maquina
    // —y con ella la sala— a mitad de conexion, que es la forma mas rapida de
    // dejar dos salas vivas y la camara encendida. Se lee por referencia.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emisionId]);

  /* Los eventos de la sala, traducidos a llamadas de la maquina. */
  useEffect(() => {
    const { sala, maquina } = motor;
    const dejarDeEscuchar = sala.alOcurrir((evento) => {
      switch (evento.tipo) {
        case 'conectado':
        case 'reconectado':
          maquina.laSalaConecto();
          break;
        case 'reconectando':
          maquina.laSalaReconecta();
          break;
        case 'calidad':
          maquina.laSalaCambioDeCalidad(evento.buena);
          break;
        case 'medios':
          maquina.laSalaCambioDeMedios(evento.medios);
          break;
        case 'pistas':
          setPistas(evento.pistas);
          maquina.laSalaCambioDePistasAjenas(evento.pistas.hayMediosAjenos);
          break;
        case 'efecto':
          setEfectos(evento.estado);
          // Un efecto que se quita solo se DICE, aunque la hoja este cerrada:
          // quien emitia con el fondo tapado tiene que saber que ya no lo esta.
          if (evento.estado.error === 'se_apago') {
            ultimas.current.avisar(traduceEnElIdiomaActual('live.effectTurnedOff'));
          }
          break;
        case 'capas':
          setCalidad(evento.estado);
          break;
        case 'desconectado':
          // Fuera de la sala no queda ninguna pista que dibujar.
          setPistas(sinPistas());
          maquina.laSalaSeCayo(evento.recuperable);
          break;
      }
    });

    maquina.arrancar();

    return () => {
      dejarDeEscuchar();
      /*
        DESMONTAR ES SOLTARLO TODO. `destruir` corta el reintento programado,
        sale de la sala y destruye el SDK, en ese orden. Sin esto, salir de la
        pantalla a mitad de una reconexion dejaba un `setTimeout` vivo que
        volvia a pedir credencial —y a encender la camara— para nadie.
      */
      maquina.destruir();
    };
  }, [motor]);

  /* Lo que cuenta el servidor sobre la emision. */
  useEffect(() => {
    if (estadoDeSesion === null) return;
    motor.maquina.cambiaLaSesion(estadoDeSesion);
  }, [motor, estadoDeSesion]);

  /*
    Efectos y calidad NO pasan por la maquina: no cambian el estado del directo
    ni tienen reglas que decidir aqui. Sus reglas estan en
    `live/efectosDeVideo.ts` y `live/calidadDeVideo.ts`, y la sala no rechaza
    nunca: lo que no se pudo lo cuenta el evento.
  */
  const aplicarEfecto = useCallback(
    (efecto: EfectoDeVideo) => {
      void motor.sala.aplicarEfecto(efecto).then(setEfectos);
    },
    [motor],
  );
  const elegirCalidad = useCallback(
    (preferencia: PreferenciaDeCalidad) => {
      void motor.sala.elegirCalidad(preferencia).then(setCalidad);
    },
    [motor],
  );

  return {
    vista,
    sesion: motor.maquina,
    pistas,
    VistaDePista: motor.sala.VistaDePista,
    efectos: {
      // Se lee en cada pintado: cambia al entrar en la sala publicando, y de
      // eso ya avisa la maquina con su propio cambio de vista.
      capacidad: motor.sala.efectos(),
      estado: efectos,
      aplicar: aplicarEfecto,
    },
    calidad: { estado: calidad, elegir: elegirCalidad },
  };
}
