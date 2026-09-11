import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import { toast } from '@/lib/toast';
import {
  LARGO_DEL_TEXTO,
  LARGO_MAXIMO_DEL_MOTIVO,
  LARGO_MAXIMO_DE_LA_VERSION,
  accionesDePolitica,
  borradorDelTipo,
  borradorDesdeLaVigente,
  claveDeAyudaDelParametro,
  claveDeErrorDePolitica,
  claveDeErrorPorEstado,
  claveDeFallo,
  claveDeRegla,
  claveDelCuerpoDeLaRegla,
  claveDelCuerpoDelResumen,
  claveDelCuerpoDelTipo,
  claveDelEstado,
  claveDelParametro,
  claveDelResumen,
  claveDelTipo,
  cotaDe,
  esPoliticasApagadas,
  estadoDeConfiguracion,
  etiquetaDeVersion,
  filasDelResultado,
  formularioDesde,
  formularioVacio,
  hayCondiciones,
  hayQueRecargar,
  historialDelTipo,
  momentoLegible,
  motivoDeCancelacionUtil,
  paramsDesdeFormulario,
  paresDeParametros,
  textoUtil,
  tiposOfrecidos,
  validarBorrador,
  validarPublicacion,
  versionUtil,
  vigenciaLegible,
  vigenteDelTipo,
  type Condiciones,
  type EstadoDeLasPoliticas,
  type Fallo,
  type Formulario,
  type Politica,
  type ResultadoDeCancelacion,
  type Ternario,
} from '@/lib/politicasDeEvento';
import { EventPolicyRepository } from '@/repositories/EventPolicyRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/** Los tres valores del sí/no, en el orden en que se ofrecen. */
const TERNARIOS: Ternario[] = ['si', 'no', 'sinDecidir'];

/**
 * Las condiciones de cambios y devoluciones de un evento, escritas por quien lo
 * organiza; y la cancelación del evento entero.
 *
 * LO PUBLICADO NO SE EDITA, Y LA PANTALLA NO FINGE QUE SÍ. Solo el borrador
 * tiene campos. La vigente ofrece «sacar una versión nueva», que copia sus
 * parámetros y su texto a un borrador al que hay que ponerle otro nombre de
 * versión. El historial se lee: es lo que aceptaron las compras de su momento y
 * reescribirlo sería reescribir un contrato firmado.
 *
 * SIN CONDICIONES NO ES «NO SE DEVUELVE». Mientras no hay ninguna publicada,
 * esta pantalla dice que todavía no están definidas. Contarlo como una negativa
 * sería tomar por quien organiza la decisión que más perjudica a quien compró,
 * y encima sería falso: para decidir, el servidor cae a la política global.

 * NINGÚN CAMPO TRAE UN VALOR. Los números empiezan en blanco y los sí/no
 * empiezan en «todavía no lo he decidido», que es un tercer valor de verdad y
 * no un «no» disimulado. Lo que nadie ha contestado no viaja, y la clave
 * ausente es exactamente lo que el servidor entiende por «sin decidir».
 *
 * PUBLICAR PIDE CONFIRMACIÓN Y AVISA DE QUE NO ES RETROACTIVO. Las compras
 * anteriores conservan la versión que aceptaron; decirlo después de publicar no
 * sirve de nada.
 *
 * LA PREVISUALIZACIÓN ES LA DEL SERVIDOR. Se pide `/policies/terms`, que es
 * literalmente la ruta que lee quien compra, y se enseña tal cual: el texto sin
 * retocar y los parámetros en crudo. Reescribir «refund_bps: 5000» como «se
 * devuelve la mitad» sería enseñar una promesa distinta de la que se vende.
 *
 * CANCELAR ES LO MÁS GRAVE DE AQUÍ, y se cuenta entero antes: el evento deja de
 * venderse, se abre un caso por cada compra y el importe queda RETENIDO y en
 * revisión. NO SE DEVUELVE DINERO AUTOMÁTICAMENTE y no hay ningún plazo que
 * prometer; la empresa no ha decidido todavía si Z exige devolución total.
 * Después se enseña lo que el servidor dijo que hizo, sin conclusiones.
 */
export function PoliticasDelEventoScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { eventId } = useLocalSearchParams<{ eventId: string }>();

  /*
    Las claves de esta pantalla se están escribiendo en las tablas de idiomas en
    paralelo. El molde es el mismo `t`: cuando lleguen, esto no cambia.
  */
  const f = useCallback(
    (clave: string, params?: Record<string, string | number>) =>
      t(clave as TranslationKey, params),
    [t],
  );

  const [estado, setEstado] = useState<EstadoDeLasPoliticas | null>(null);
  const [tipoActivo, setTipoActivo] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'sinPermiso' | 'sinSesion' | 'noEncontrado' | 'noDisponible' | null
  >(null);

  const [formulario, setFormulario] = useState<Formulario | null>(null);
  const [tipoEnEdicion, setTipoEnEdicion] = useState<string | null>(null);
  const [fallos, setFallos] = useState<Fallo[]>([]);

  const [condiciones, setCondiciones] = useState<Condiciones | null>(null);
  const [verPrevisualizacion, setVerPrevisualizacion] = useState(false);

  const [motivo, setMotivo] = useState('');
  const [errorDelMotivo, setErrorDelMotivo] = useState<string | null>(null);
  const [cancelacion, setCancelacion] = useState<ResultadoDeCancelacion | null>(null);

  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);

  const leerFallo = (error: unknown) => {
    if (error instanceof ApiError && esPoliticasApagadas(error.code)) {
      return 'noDisponible' as const;
    }
    if (error instanceof ApiError && error.status === 401) return 'sinSesion' as const;
    if (error instanceof ApiError && error.status === 403) return 'sinPermiso' as const;
    if (error instanceof ApiError && error.status === 404) return 'noEncontrado' as const;
    if (error instanceof ApiError && esFalloDeRed(error.code)) return 'sinConexion' as const;
    return 'red' as const;
  };

  const cargar = useCallback(async () => {
    if (!eventId) return;
    setCargando(true);
    setFallo(null);
    try {
      const leido = await EventPolicyRepository.estado(eventId);
      setEstado(leido);
      setTipoActivo((actual) => {
        const ofrecidos = tiposOfrecidos(leido);
        if (actual !== null && ofrecidos.includes(actual)) return actual;
        return ofrecidos[0] ?? null;
      });
    } catch (error) {
      setFallo(leerFallo(error));
    } finally {
      setCargando(false);
    }
  }, [eventId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  /** El texto de un error del servidor, con su código cuando lo conocemos. */
  const textoDelError = (error: unknown) => {
    if (error instanceof ApiError) {
      const porCodigo = claveDeErrorDePolitica(error.code);
      if (porCodigo !== null) return f(porCodigo);
      const porEstado = claveDeErrorPorEstado(error.status);
      if (porEstado !== null) return f(porEstado);
    }
    return error instanceof Error && error.message.trim() !== ''
      ? error.message
      : t('common.tryAgain');
  };

  /**
   * El cerrojo. SE CIERRA ANTES DEL PRIMER `await`, que aquí puede ser el
   * propio diálogo: dos toques seguidos publicarían dos veces, y la segunda
   * llegaría con el borrador ya publicado (409) o, peor, publicaría una versión
   * que nadie quiso.
   */
  const conCerrojo = async (trabajo: () => Promise<void>) => {
    if (ocupadoRef.current) return;
    ocupadoRef.current = true;
    setOcupado(true);
    try {
      await trabajo();
    } catch (error) {
      notify(f('politicasEvento.noSePudo'), textoDelError(error));
      // UN 409 NO SE MUESTRA Y SE OLVIDA: lo que había delante ya no es lo que
      // hay, así que se recarga y se deja decidir otra vez sobre lo de ahora.
      if (
        error instanceof ApiError &&
        hayQueRecargar(error.status, error.code)
      ) {
        cerrarEditor();
        await cargar();
      }
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  const cerrarEditor = () => {
    setFormulario(null);
    setTipoEnEdicion(null);
    setFallos([]);
  };

  const escribirDesdeCero = (tipo: string) => {
    const borrador = estado ? borradorDelTipo(estado, tipo) : null;
    // Un borrador que ya existe se abre como está; lo que no hay, nace vacío.
    setFormulario(
      borrador !== null
        ? formularioDesde(tipo, {
            version: borrador.version,
            params: borrador.params,
            body: borrador.body,
          })
        : formularioVacio(tipo),
    );
    setTipoEnEdicion(tipo);
    setFallos([]);
  };

  /** La versión nueva parte de la vigente, CON LA VERSIÓN EN BLANCO. */
  const sacarVersionNueva = (vigente: Politica) => {
    setFormulario(borradorDesdeLaVigente(vigente));
    setTipoEnEdicion(vigente.policy_type);
    setFallos([]);
  };

  const guardar = () => {
    if (!eventId || formulario === null || tipoEnEdicion === null) return;
    const tipo = tipoEnEdicion;
    const actual = formulario;
    const { params, fallos: deLosParams } = paramsDesdeFormulario(tipo, actual);
    const encontrados = [
      ...validarBorrador(tipo, actual, params),
      ...deLosParams.filter((x) => x.codigo === 'event_policy_param_not_a_number'),
    ];
    if (encontrados.length > 0) {
      setFallos(encontrados);
      return;
    }
    setFallos([]);
    void conCerrojo(async () => {
      const version = versionUtil(actual.version);
      if (version === null) return;
      await EventPolicyRepository.guardarBorrador(eventId, {
        tipo,
        version,
        params,
        texto: textoUtil(actual.texto),
      });
      cerrarEditor();
      toast(f('politicasEvento.borradorGuardado'));
      await cargar();
    });
  };

  /**
   * Publicar, con confirmación y con el aviso de que NO ES RETROACTIVO.
   *
   * Se valida sobre lo que el servidor tiene guardado —no sobre el formulario
   * abierto—, porque es exactamente eso lo que se va a publicar.
   */
  const publicar = (borrador: Politica) => {
    const comoFormulario = formularioDesde(borrador.policy_type, {
      version: borrador.version,
      params: borrador.params,
      body: borrador.body,
    });
    const vigente = estado ? vigenteDelTipo(estado, borrador.policy_type) : null;
    const encontrados = validarPublicacion(
      borrador.policy_type,
      comoFormulario,
      borrador.params ?? {},
      vigente,
    );
    if (encontrados.length > 0) {
      setFallos(encontrados);
      notify(f('politicasEvento.noSePudo'), f(claveDeFallo(encontrados[0] as Fallo)));
      return;
    }
    setFallos([]);
    void conCerrojo(async () => {
      const aceptado = await confirm({
        title: f('politicasEvento.publicarTitulo'),
        // EL AVISO VA ANTES. Decir después que lo vendido no cambia no sirve.
        message: f('politicasEvento.publicarAviso', {
          version: etiquetaDeVersion(borrador.version),
        }),
        confirmLabel: f('politicasEvento.publicarBoton'),
      });
      if (!aceptado) return;
      await EventPolicyRepository.publicar(borrador.id);
      toast(f('politicasEvento.publicada'));
      setCondiciones(null);
      await cargar();
    });
  };

  const descartar = (borrador: Politica) =>
    void conCerrojo(async () => {
      const aceptado = await confirm({
        title: f('politicasEvento.descartarTitulo'),
        message: f('politicasEvento.descartarAviso'),
        confirmLabel: f('politicasEvento.descartarBoton'),
        destructive: true,
      });
      if (!aceptado) return;
      await EventPolicyRepository.descartarBorrador(borrador.id);
      cerrarEditor();
      toast(f('politicasEvento.borradorDescartado'));
      await cargar();
    });

  const previsualizar = () =>
    void conCerrojo(async () => {
      if (!eventId) return;
      setCondiciones(await EventPolicyRepository.condiciones(eventId));
      setVerPrevisualizacion(true);
    });

  /**
   * Cancelar el evento entero.
   *
   * EXIGE MOTIVO ESCRITO y una confirmación que diga lo que de verdad pasa. No
   * se promete ninguna devolución ni ningún plazo: no los hay.
   */
  const cancelarEvento = () => {
    if (!eventId) return;
    const razon = motivoDeCancelacionUtil(motivo);
    if (razon === null) {
      setErrorDelMotivo(f('politicasEvento.cancelar.faltaMotivo'));
      return;
    }
    setErrorDelMotivo(null);
    void conCerrojo(async () => {
      const aceptado = await confirm({
        title: f('politicasEvento.cancelar.titulo'),
        message: f('politicasEvento.cancelar.aviso'),
        confirmLabel: f('politicasEvento.cancelar.boton'),
        destructive: true,
      });
      if (!aceptado) return;
      const resultado = await EventPolicyRepository.cancelarEvento(eventId, razon);
      setCancelacion(resultado);
      setMotivo('');
      await cargar();
    });
  };

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));

  /* ------------------------------------------------------------------ */
  /* Estados completos antes de pintar nada                              */
  /* ------------------------------------------------------------------ */

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('politicasEvento.titulo')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null || estado === null) {
    const blando =
      fallo === 'noDisponible' ||
      fallo === 'sinPermiso' ||
      fallo === 'sinSesion' ||
      fallo === 'noEncontrado';
    const titulo =
      fallo === 'noDisponible'
        ? f('politicasEvento.noDisponible')
        : fallo === 'sinSesion'
          ? f('politicasEvento.error.sinSesion')
          : fallo === 'sinPermiso'
            ? f('politicasEvento.error.sinPermiso')
            : f('politicasEvento.error.noEncontrado');
    const cuerpo =
      fallo === 'noDisponible'
        ? f('politicasEvento.noDisponibleCuerpo')
        : fallo === 'sinSesion'
          ? f('politicasEvento.error.sinSesionCuerpo')
          : fallo === 'sinPermiso'
            ? f('politicasEvento.error.sinPermisoCuerpo')
            : f('politicasEvento.error.noEncontradoCuerpo');
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('politicasEvento.titulo')} onBack={volver} />
        {blando ? (
          <StateView
            state="empty"
            icon={fallo === 'noDisponible' ? 'clock' : 'lock'}
            title={titulo}
            description={cuerpo}
          />
        ) : (
          <StateView
            state={fallo === 'sinConexion' ? 'offline' : 'error'}
            description={fallo === 'sinConexion' ? undefined : t('common.loadFailed')}
            onRetry={() => void cargar()}
          />
        )}
      </AppScreen>
    );
  }

  const ofrecidos = tiposOfrecidos(estado);
  const punto = estadoDeConfiguracion(estado);
  const vigente = tipoActivo !== null ? vigenteDelTipo(estado, tipoActivo) : null;
  const borrador = tipoActivo !== null ? borradorDelTipo(estado, tipoActivo) : null;
  const historial = tipoActivo !== null ? historialDelTipo(estado, tipoActivo) : [];
  const editando = formulario !== null && tipoEnEdicion === tipoActivo;

  /* ------------------------------------------------------------------ */
  /* El editor. SOLO SOBRE EL BORRADOR.                                  */
  /* ------------------------------------------------------------------ */

  const editor = () => {
    if (formulario === null || tipoEnEdicion === null) return null;
    const tipo = tipoEnEdicion;
    const { params } = paramsDesdeFormulario(tipo, formulario);
    const falloDe = (campo: string) => fallos.find((x) => x.campo === campo) ?? null;
    const mensajeDe = (campo: string) => {
      const encontrado = falloDe(campo);
      if (encontrado === null) return undefined;
      const cota = cotaDe(campo);
      return f(claveDeFallo(encontrado), {
        min: encontrado.min ?? cota?.[0] ?? 0,
        max: encontrado.max ?? cota?.[1] ?? 0,
      });
    };

    return (
      <View style={[styles.tarjeta, { borderColor: colors.border }]}>
        <Text variant="secondary" weight="700">
          {f('politicasEvento.editorTitulo')}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('politicasEvento.editorCuerpo')}
        </Text>

        <Input
          label={f('politicasEvento.versionEtiqueta')}
          placeholder={f('politicasEvento.versionAyuda')}
          value={formulario.version}
          onChangeText={(texto) =>
            setFormulario({ ...formulario, version: texto })
          }
          error={mensajeDe('version')}
          maxLength={LARGO_MAXIMO_DE_LA_VERSION}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!ocupado}
        />

        {/* LOS CAMPOS NACEN VACÍOS. Ni un cero ni un plazo de partida: un valor
            escrito aquí sería una condición de venta decidida por nosotros. */}
        {Object.keys(formulario.numeros).map((clave) => {
          const cota = cotaDe(clave);
          return (
            <View key={clave} style={styles.campo}>
              <Input
                label={f(claveDelParametro(clave))}
                placeholder={f('politicasEvento.sinDefinir')}
                value={formulario.numeros[clave] ?? ''}
                onChangeText={(texto) =>
                  setFormulario({
                    ...formulario,
                    numeros: { ...formulario.numeros, [clave]: texto },
                  })
                }
                error={mensajeDe(clave)}
                keyboardType="number-pad"
                editable={!ocupado}
                accessibilityLabel={f(claveDelParametro(clave))}
              />
              <Text variant="caption" color={colors.textMuted}>
                {f(claveDeAyudaDelParametro(clave))}
                {cota !== null
                  ? ` ${f('politicasEvento.rango', { min: cota[0], max: cota[1] })}`
                  : ''}
              </Text>
            </View>
          );
        })}

        {/* TRES RESPUESTAS, NO DOS. «Todavía no lo he decidido» no es «no». */}
        {Object.keys(formulario.booleanos).map((clave) => (
          <View key={clave} style={styles.campo}>
            <Text variant="secondary">{f(claveDelParametro(clave))}</Text>
            <Text variant="caption" color={colors.textMuted}>
              {f(claveDeAyudaDelParametro(clave))}
            </Text>
            <View style={styles.chips}>
              {TERNARIOS.map((valor) => (
                <Chip
                  key={valor}
                  label={f(`politicasEvento.ternario.${valor}`)}
                  rol="radio"
                  selected={(formulario.booleanos[clave] ?? 'sinDecidir') === valor}
                  disabled={ocupado}
                  onPress={() =>
                    setFormulario({
                      ...formulario,
                      booleanos: { ...formulario.booleanos, [clave]: valor },
                    })
                  }
                />
              ))}
            </View>
            {falloDe(clave) !== null ? (
              <Text variant="caption" color={colors.danger}>
                {mensajeDe(clave)}
              </Text>
            ) : null}
          </View>
        ))}

        <Input
          label={f('politicasEvento.textoEtiqueta')}
          placeholder={f('politicasEvento.textoAyuda')}
          value={formulario.texto}
          onChangeText={(texto) => setFormulario({ ...formulario, texto })}
          error={mensajeDe('texto')}
          multiline
          numberOfLines={6}
          maxLength={LARGO_DEL_TEXTO}
          editable={!ocupado}
        />

        {/* Lo que se contradice se dice AQUÍ, no al recibir el rechazo. */}
        {fallos
          .filter((x) => x.campo === 'politica')
          .map((x, indice) => (
            <Text key={`${x.codigo}-${indice}`} variant="caption" color={colors.danger}>
              {f(claveDeFallo(x))}
            </Text>
          ))}

        <Text variant="caption" color={colors.textMuted}>
          {f('politicasEvento.avisoSinDecidir')}
        </Text>

        <Button
          label={f('politicasEvento.guardarBorrador')}
          onPress={guardar}
          loading={ocupado}
          disabled={ocupado}
        />
        <Button
          label={t('common.cancel')}
          variant="ghost"
          onPress={cerrarEditor}
          disabled={ocupado}
        />
        {/* Publicar no está aquí: se publica lo GUARDADO, no lo que se escribe. */}
        <Text variant="caption" color={colors.textMuted}>
          {f('politicasEvento.sePublicaLoGuardado')}
          {Object.keys(params).length === 0 ? ` ${f('politicasEvento.nadaEscrito')}` : ''}
        </Text>
      </View>
    );
  };

  /** Una política, para leerla. Solo el borrador trae acciones. */
  const tarjeta = (politica: Politica, deLectura = false) => {
    const acciones = deLectura ? [] : accionesDePolitica(politica.status);
    const version = etiquetaDeVersion(politica.version);
    const vigencia = vigenciaLegible(politica);
    return (
      <View
        key={politica.id}
        style={[styles.tarjeta, { borderColor: colors.border }]}
        accessibilityLabel={f('politicasEvento.tarjeta', {
          estado: f(claveDelEstado(politica.status)),
          version,
        })}
      >
        <View style={styles.linea}>
          <Text variant="secondary" weight="700">
            {f(claveDelEstado(politica.status))}
          </Text>
          {version !== '' ? (
            <Text variant="caption" color={colors.textMuted}>
              {f('politicasEvento.version', { version })}
            </Text>
          ) : null}
        </View>

        {vigencia !== '' ? (
          <Text variant="caption" color={colors.textMuted}>
            {vigencia}
          </Text>
        ) : null}

        {/* Los parámetros, en crudo: son lo que se publicó, con su huella. */}
        {paresDeParametros(politica.params ?? {}).map(([clave, valor]) => (
          <Text key={clave} variant="caption" color={colors.textMuted}>
            {`${clave}: ${valor}`}
          </Text>
        ))}
        {paresDeParametros(politica.params ?? {}).length === 0 ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('politicasEvento.sinParametros')}
          </Text>
        ) : null}

        {politica.body !== null && politica.body.trim() !== '' ? (
          <Text variant="caption">{politica.body}</Text>
        ) : (
          <Text variant="caption" color={colors.textMuted}>
            {f('politicasEvento.sinTexto')}
          </Text>
        )}

        {politica.published_at !== null ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('politicasEvento.publicadaEl', {
              momento: momentoLegible(politica.published_at),
            })}
          </Text>
        ) : null}

        {acciones.includes('editar') ? (
          <Button
            label={f('politicasEvento.accion.editar')}
            variant="secondary"
            icon="edit-2"
            onPress={() => escribirDesdeCero(politica.policy_type)}
            disabled={ocupado}
          />
        ) : null}
        {acciones.includes('publicar') ? (
          <Button
            label={f('politicasEvento.accion.publicar')}
            onPress={() => publicar(politica)}
            disabled={ocupado}
          />
        ) : null}
        {acciones.includes('descartar') ? (
          <Button
            label={f('politicasEvento.accion.descartar')}
            variant="ghost"
            onPress={() => descartar(politica)}
            disabled={ocupado}
          />
        ) : null}
        {acciones.includes('nuevaVersion') ? (
          <Button
            label={f('politicasEvento.accion.nuevaVersion')}
            variant="secondary"
            icon="copy"
            onPress={() => sacarVersionNueva(politica)}
            disabled={ocupado || borrador !== null}
          />
        ) : null}
        {acciones.includes('nuevaVersion') && borrador !== null ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('politicasEvento.yaHayBorrador')}
          </Text>
        ) : null}
      </View>
    );
  };

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('politicasEvento.titulo')} onBack={volver} />

      {/* SIN CONDICIONES NO ES «NO SE DEVUELVE». */}
      <View style={[styles.tarjeta, { borderColor: colors.border }]}>
        <Text variant="secondary" weight="700">
          {f(claveDelResumen(punto))}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f(claveDelCuerpoDelResumen(punto))}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('politicasEvento.noRetroactivo')}
        </Text>
      </View>

      {ofrecidos.length === 0 ? (
        <StateView
          state="empty"
          icon="clock"
          title={f('politicasEvento.sinTipos')}
          description={f('politicasEvento.sinTiposCuerpo')}
          onRetry={() => void cargar()}
        />
      ) : (
        <>
          <Text variant="caption" color={colors.textMuted}>
            {f('politicasEvento.elegirTipo')}
          </Text>
          <View style={styles.chips}>
            {ofrecidos.map((tipo) => (
              <Chip
                key={tipo}
                label={f(claveDelTipo(tipo))}
                rol="radio"
                selected={tipoActivo === tipo}
                disabled={ocupado}
                onPress={() => {
                  cerrarEditor();
                  setTipoActivo(tipo);
                }}
              />
            ))}
          </View>

          {tipoActivo !== null ? (
            <Text variant="caption" color={colors.textMuted}>
              {f(claveDelCuerpoDelTipo(tipoActivo))}
            </Text>
          ) : null}

          {/* La vigente. NO SE EDITA: se saca otra versión. */}
          {vigente !== null ? (
            tarjeta(vigente)
          ) : (
            <View style={[styles.tarjeta, { borderColor: colors.border }]}>
              <Text variant="secondary" weight="700">
                {f('politicasEvento.tipoSinPublicar')}
              </Text>
              <Text variant="caption" color={colors.textMuted}>
                {f('politicasEvento.tipoSinPublicarCuerpo')}
              </Text>
            </View>
          )}

          {/* El borrador, que es lo único con campos. */}
          {borrador !== null ? tarjeta(borrador) : null}

          {borrador === null && !editando && tipoActivo !== null ? (
            <Button
              label={f('politicasEvento.escribir')}
              variant="secondary"
              icon="edit-3"
              onPress={() => escribirDesdeCero(tipoActivo)}
              disabled={ocupado}
            />
          ) : null}

          {editando ? editor() : null}

          {/* El historial SE LEE. Es lo que aceptaron las compras de su momento. */}
          {historial.length > 0 ? (
            <>
              <Text variant="secondary" weight="700">
                {f('politicasEvento.historial')}
              </Text>
              <Text variant="caption" color={colors.textMuted}>
                {f('politicasEvento.historialCuerpo')}
              </Text>
              {historial.map((p) => tarjeta(p, true))}
            </>
          ) : null}
        </>
      )}

      {/* La previsualización es LA DEL SERVIDOR, tal cual. */}
      <View style={[styles.tarjeta, { borderColor: colors.border }]}>
        <Text variant="secondary" weight="700">
          {f('politicasEvento.previsualizar')}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('politicasEvento.previsualizarCuerpo')}
        </Text>
        <Button
          label={f('politicasEvento.previsualizarBoton')}
          variant="secondary"
          icon="eye"
          onPress={previsualizar}
          disabled={ocupado}
        />
        {verPrevisualizacion && condiciones !== null ? (
          hayCondiciones(condiciones) ? (
            condiciones.condiciones.map((condicion) => (
              <View
                key={`${condicion.policy_type}-${condicion.version}`}
                style={[styles.tarjeta, { borderColor: colors.border }]}
              >
                <Text variant="caption" color={colors.textMuted}>
                  {`${condicion.policy_type} · ${etiquetaDeVersion(condicion.version)}`}
                </Text>
                {condicion.body !== null && condicion.body.trim() !== '' ? (
                  <Text variant="caption">{condicion.body}</Text>
                ) : (
                  <Text variant="caption" color={colors.textMuted}>
                    {f('politicasEvento.sinTexto')}
                  </Text>
                )}
                {paresDeParametros(condicion.params ?? {}).map(([clave, valor]) => (
                  <Text key={clave} variant="caption" color={colors.textMuted}>
                    {`${clave}: ${valor}`}
                  </Text>
                ))}
              </View>
            ))
          ) : (
            <Text variant="caption" color={colors.textMuted}>
              {f('politicasEvento.previsualizarSinConfigurar')}
            </Text>
          )
        ) : null}
      </View>

      {/* ------------------------------------------------------------ */}
      {/* Cancelar el evento. LO MÁS GRAVE DE ESTA PANTALLA.            */}
      {/* ------------------------------------------------------------ */}
      <View style={[styles.tarjeta, { borderColor: colors.danger }]}>
        <Text variant="secondary" weight="700" color={colors.danger}>
          {f('politicasEvento.cancelar.titulo')}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('politicasEvento.cancelar.cuerpo')}
        </Text>
        {/* NO SE DEVUELVE DINERO AUTOMÁTICAMENTE, y se dice antes de tocar nada. */}
        <Text variant="caption" color={colors.textMuted}>
          {f('politicasEvento.cancelar.sinDevolucionAutomatica')}
        </Text>

        <Input
          label={f('politicasEvento.cancelar.motivoEtiqueta')}
          placeholder={f('politicasEvento.cancelar.motivoAyuda')}
          value={motivo}
          onChangeText={setMotivo}
          error={errorDelMotivo ?? undefined}
          multiline
          numberOfLines={3}
          maxLength={LARGO_MAXIMO_DEL_MOTIVO}
          editable={!ocupado}
        />
        <Button
          label={f('politicasEvento.cancelar.boton')}
          variant="secondary"
          icon="x-octagon"
          onPress={cancelarEvento}
          disabled={ocupado}
        />

        {/* Después: lo que el servidor dice que hizo. Sin conclusiones. */}
        {cancelacion !== null ? (
          <View style={[styles.tarjeta, { borderColor: colors.border }]}>
            <Text variant="secondary" weight="700">
              {f(claveDeRegla(cancelacion.regla))}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {f(claveDelCuerpoDeLaRegla(cancelacion.regla))}
            </Text>
            {filasDelResultado(cancelacion).map((fila) => (
              <Text key={fila.clave} variant="caption" color={colors.textMuted}>
                {f(fila.clave, { n: fila.valor })}
              </Text>
            ))}
          </View>
        ) : null}
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  campo: { gap: spacing.xs },
  linea: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    minHeight: 44,
  },
  tarjeta: {
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
});
