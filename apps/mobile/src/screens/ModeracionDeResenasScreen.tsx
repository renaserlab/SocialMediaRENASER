import React, { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import {
  ESTADOS_QUE_SE_FILTRAN,
  LARGO_MAXIMO_DEL_MOTIVO,
  LIMITE_INICIAL,
  abreviarIdentificador,
  accionQueOfrece,
  claveDeAccion,
  claveDeErrorDeModeracion,
  claveDelCuerpoDelFallo,
  claveDelEstadoDeResena,
  claveDelFallo,
  claveDelPaso,
  contarPorEstado,
  esConflictoDeResena,
  falloDeCarga,
  filaTrasModerar,
  filtroDeEvento,
  llegoAlTope,
  motivoObligatorio,
  puntuacionLegible,
  resumenDelComentario,
  revisarMotivo,
  seReintenta,
  siguienteLimite,
  tonoDelEstado,
  type AccionDeModeracion,
  type FalloDeCarga,
} from '@/lib/moderacionDeResenas';
import {
  EventReviewModerationRepository,
  type PasoDeModeracion,
  type ResenaParaModerar,
} from '@/repositories/EventReviewModerationRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/** La fecha y la hora. Vacía si el servidor mandó algo que no es una fecha. */
function momentoLegible(iso: string | null | undefined): string {
  if (!iso) return '';
  const momento = new Date(iso);
  if (Number.isNaN(momento.getTime())) return '';
  return `${momento.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })} · ${momento.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

/**
 * Moderar reseñas de evento. Pantalla INTERNA.
 *
 * OCULTAR NO BORRA, Y ESTÁ ESCRITO ARRIBA DEL TODO. Esconder saca la reseña de
 * la lista pública y deja el texto, la nota y el autor enteros en la base;
 * restaurar los devuelve tal cual. No hay ningún botón de borrado ni nada que
 * lo insinúe, porque esa ruta no existe y prometerla sería prometer algo
 * irreversible que nadie ha decidido.
 *
 * NI EL AUTOR NI LA PUNTUACIÓN SE EDITAN. Se enseñan como lo que son: solo
 * lectura. El único campo que se escribe en toda la pantalla es el motivo de la
 * acción de moderación, que es de quien modera y no de la reseña.
 *
 * EL MOTIVO SE PIDE ANTES DE CONFIRMAR, y ocultar sin motivo se rechaza aquí,
 * sin llamar a nadie: el servidor acepta `reason: null`, así que si el cliente
 * no lo exige nadie lo exige, y quedaría una reseña escondida que nadie puede
 * explicar. Restaurar también confirma, pero su motivo puede ir vacío.
 *
 * SE VEN LAS VISIBLES Y LAS ESCONDIDAS. Sin poder ver lo escondido restaurar
 * sería imposible y nadie podría comprobar qué se escondió ni por qué. El
 * filtro de estado y el de evento sirven para eso, no para esconder la mitad.
 *
 * LA IDENTIDAD PÚBLICA NO ESTÁ DECIDIDA. `author_id` se enseña abreviado como
 * referencia con la que investigar; no se pide ningún perfil, no se inventa
 * ningún nombre y no se enseña nada que el contrato no entregue.
 *
 * QUIÉN PUEDE ABRIRLA LO DECIDE EL SERVIDOR. Aquí no se comprueba ningún rol:
 * quien no modera recibe un 403 y lee su propio aviso. Convertirlo en un «no
 * hay nada» diría algo distinto de lo que pasa.
 */
export function ModeracionDeResenasScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();

  /** `t` no acepta una cadena suelta: las claves salen del módulo de reglas. */
  const f = (clave: string, params?: Record<string, string | number>) =>
    t(clave as TranslationKey, params);

  const [filas, setFilas] = useState<ResenaParaModerar[]>([]);
  const [estado, setEstado] = useState<string | null>(null);
  const [eventoEscrito, setEventoEscrito] = useState('');
  const [eventoFiltrado, setEventoFiltrado] = useState<string | null>(null);
  const [limite, setLimite] = useState<number>(LIMITE_INICIAL);

  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<FalloDeCarga | null>(null);
  const [conflicto, setConflicto] = useState(false);

  const [abierta, setAbierta] = useState<string | null>(null);
  const [historial, setHistorial] = useState<PasoDeModeracion[]>([]);
  const [historialCargando, setHistorialCargando] = useState(false);
  const [historialFallo, setHistorialFallo] = useState(false);

  const [enCurso, setEnCurso] = useState<string | null>(null);
  const [accion, setAccion] = useState<AccionDeModeracion | null>(null);
  const [motivo, setMotivo] = useState('');
  const [errorDelFormulario, setErrorDelFormulario] = useState<string | null>(null);

  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      const lista = await EventReviewModerationRepository.lista({
        estado,
        eventoId: eventoFiltrado,
        limite,
      });
      setFilas(lista);
    } catch (error) {
      setFallo(
        error instanceof ApiError
          ? falloDeCarga(error.status, error.code)
          : falloDeCarga(null, null),
      );
    } finally {
      setCargando(false);
    }
  }, [estado, eventoFiltrado, limite]);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  const textoDelError = (error: unknown) => {
    if (error instanceof ApiError) {
      const clave = claveDeErrorDeModeracion(error.code);
      if (clave !== null) return f(clave);
      if (error.status === 403) return f('moderacionResenas.falloCuerpo.sinPermiso');
      if (error.status === 401) return f('moderacionResenas.falloCuerpo.sinSesion');
      if (error.status === 422) return f('moderacionResenas.falloCuerpo.datosInvalidos');
    }
    return error instanceof Error && error.message.trim() !== ''
      ? error.message
      : t('common.tryAgain');
  };

  /** El cerrojo, ANTES del primer `await` —que aquí es un diálogo—. */
  const conCerrojo = async (trabajo: () => Promise<void>) => {
    if (ocupadoRef.current) return;
    ocupadoRef.current = true;
    setOcupado(true);
    setConflicto(false);
    try {
      await trabajo();
    } catch (error) {
      /*
        ALGUIEN MODERÓ PRIMERO. No es un error que cerrar y olvidar: se avisa, se
        recarga la lista y se puede volver a decidir sobre lo que hay ahora.
      */
      if (error instanceof ApiError && esConflictoDeResena(error.code)) {
        setConflicto(true);
        await cargar();
      } else {
        notify(f('moderacionResenas.noSePudo'), textoDelError(error));
      }
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  const cerrarFormulario = () => {
    setEnCurso(null);
    setAccion(null);
    setMotivo('');
    setErrorDelFormulario(null);
  };

  const abrirFormulario = (resena: ResenaParaModerar, cual: AccionDeModeracion) => {
    setEnCurso(resena.id);
    setAccion(cual);
    setMotivo('');
    setErrorDelFormulario(null);
  };

  const verFicha = (resena: ResenaParaModerar) => {
    if (abierta === resena.id) {
      setAbierta(null);
      return;
    }
    setAbierta(resena.id);
    setHistorial([]);
    setHistorialFallo(false);
    setHistorialCargando(true);
    void EventReviewModerationRepository.historial(resena.id)
      .then((pasos) => setHistorial(pasos))
      .catch(() => setHistorialFallo(true))
      .finally(() => setHistorialCargando(false));
  };

  /**
   * Manda la acción. El motivo se comprueba AQUÍ, antes de llamar a nadie.
   *
   * Ocultar sin motivo ni siquiera sale de la pantalla: se dice qué falta y el
   * texto escrito sigue donde estaba.
   */
  const enviar = (resena: ResenaParaModerar, cual: AccionDeModeracion) => {
    const revisado = revisarMotivo(cual, motivo);
    if (revisado.estado === 'falta') {
      setErrorDelFormulario(f('moderacionResenas.faltaMotivo'));
      return;
    }
    if (revisado.estado === 'largo') {
      setErrorDelFormulario(
        f('moderacionResenas.motivoLargo', { max: revisado.maximo }),
      );
      return;
    }
    setErrorDelFormulario(null);

    void conCerrojo(async () => {
      const aceptado = await confirm({
        title:
          cual === 'ocultar'
            ? f('moderacionResenas.confirmarOcultarTitulo')
            : f('moderacionResenas.confirmarRestaurarTitulo'),
        message:
          cual === 'ocultar'
            ? f('moderacionResenas.confirmarOcultarCuerpo')
            : f('moderacionResenas.confirmarRestaurarCuerpo'),
        confirmLabel: f(claveDeAccion(cual)),
      });
      if (!aceptado) return;

      const actualizada =
        cual === 'ocultar'
          ? await EventReviewModerationRepository.ocultar(
              resena.id,
              revisado.motivo as string,
            )
          : await EventReviewModerationRepository.restaurar(resena.id, revisado.motivo);
      /*
        SE REPINTA LA FILA CON LO QUE CONTESTÓ EL SERVIDOR. El estado sale de la
        respuesta, no de lo que creíamos haber hecho, y lo que la respuesta no
        trae se queda vacío en vez de heredar datos de una moderación anterior.
        Recargar la lista entera movería todo lo demás bajo el dedo de quien
        acaba de decidir.
      */
      setFilas((previas) =>
        previas.map((fila) =>
          fila.id === resena.id
            ? filaTrasModerar(fila, actualizada, revisado.motivo)
            : fila,
        ),
      );
      cerrarFormulario();
      setAbierta(null);
      toast(f('moderacionResenas.hecho'));
    });
  };

  const aplicarEvento = () => {
    setLimite(LIMITE_INICIAL);
    setEventoFiltrado(filtroDeEvento(eventoEscrito));
  };

  const quitarEvento = () => {
    setEventoEscrito('');
    setLimite(LIMITE_INICIAL);
    setEventoFiltrado(null);
  };

  const elegirEstado = (valor: string | null) => {
    setLimite(LIMITE_INICIAL);
    cerrarFormulario();
    setEstado(valor);
  };

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));

  const masArriba = siguienteLimite(limite);
  const tope = llegoAlTope(filas.length, limite);
  const cuentas = contarPorEstado(filas);

  /* OCULTAR NO BORRA. Lo primero que se lee en la pantalla, siempre. */
  const aviso = (
    <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt }]}>
      <Feather name="eye-off" size={16} color={colors.textMuted} />
      <View style={styles.crece}>
        <Text variant="secondary" weight="700">
          {f('moderacionResenas.ocultarNoBorraTitulo')}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('moderacionResenas.ocultarNoBorraCuerpo')}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('moderacionResenas.soloLectura')}
        </Text>
      </View>
    </View>
  );

  const filtros = (
    <View style={styles.filtros}>
      <Text variant="caption" color={colors.textMuted}>
        {f('moderacionResenas.filtroEstado')}
      </Text>
      <View style={styles.chips}>
        <Chip
          label={f('moderacionResenas.filtroTodas')}
          selected={estado === null}
          rol="radio"
          disabled={ocupado}
          onPress={() => elegirEstado(null)}
        />
        {ESTADOS_QUE_SE_FILTRAN.map((valor) => (
          <Chip
            key={valor}
            label={f(claveDelEstadoDeResena(valor))}
            selected={estado === valor}
            rol="radio"
            disabled={ocupado}
            onPress={() => elegirEstado(valor)}
          />
        ))}
      </View>

      <Input
        label={f('moderacionResenas.filtroEvento')}
        placeholder={f('moderacionResenas.filtroEventoAyuda')}
        value={eventoEscrito}
        onChangeText={setEventoEscrito}
        autoCapitalize="none"
        autoCorrect={false}
        disabled={ocupado}
      />
      <View style={styles.chips}>
        <Button
          label={f('moderacionResenas.filtroAplicar')}
          variant="secondary"
          onPress={aplicarEvento}
          disabled={ocupado || filtroDeEvento(eventoEscrito) === eventoFiltrado}
        />
        {eventoFiltrado !== null ? (
          <Button
            label={f('moderacionResenas.filtroQuitar')}
            variant="ghost"
            onPress={quitarEvento}
            disabled={ocupado}
          />
        ) : null}
      </View>
    </View>
  );

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('moderacionResenas.tituloPanel')} onBack={volver} />
        {aviso}
        {filtros}
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('moderacionResenas.tituloPanel')} onBack={volver} />
        {aviso}
        {seReintenta(fallo) ? (
          <StateView
            state={fallo === 'sinConexion' ? 'offline' : 'error'}
            description={fallo === 'sinConexion' ? undefined : t('common.loadFailed')}
            onRetry={() => void cargar()}
          />
        ) : (
          <StateView
            state="empty"
            icon={
              fallo === 'noDisponible'
                ? 'clock'
                : fallo === 'noEncontrada'
                  ? 'inbox'
                  : 'lock'
            }
            title={f(claveDelFallo(fallo))}
            description={f(claveDelCuerpoDelFallo(fallo))}
          />
        )}
      </AppScreen>
    );
  }

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('moderacionResenas.tituloPanel')} onBack={volver} />
      {aviso}
      {filtros}

      {/* ALGUIEN SE ADELANTÓ: se dice, se recargó, y se puede volver a decidir. */}
      {conflicto ? (
        <View style={[styles.recuadro, { borderColor: colors.danger }]}>
          <Text variant="secondary" weight="700" color={colors.danger}>
            {f('moderacionResenas.conflictoTitulo')}
          </Text>
          <Text variant="secondary">{f('moderacionResenas.conflictoCuerpo')}</Text>
          <Button
            label={f('moderacionResenas.conflictoReintentar')}
            variant="secondary"
            onPress={() => {
              setConflicto(false);
              void cargar();
            }}
            disabled={ocupado}
          />
        </View>
      ) : null}

      {filas.length === 0 ? (
        <StateView
          state="empty"
          title={f('moderacionResenas.listaVacia')}
          description={f('moderacionResenas.listaVaciaCuerpo')}
          onRetry={() => void cargar()}
        />
      ) : (
        <>
          <Text variant="caption" color={colors.textMuted}>
            {f('moderacionResenas.resumenEstado', {
              visibles: cuentas.visibles,
              ocultas: cuentas.ocultas,
            })}
          </Text>

          {filas.map((resena) => {
            const ofrece = accionQueOfrece(resena.status);
            const tono = tonoDelEstado(resena.status);
            const colorDelEstado =
              tono === 'oculto'
                ? colors.danger
                : tono === 'visible'
                  ? colors.text
                  : colors.textMuted;
            const nota = puntuacionLegible(resena.overall);
            const autor = abreviarIdentificador(resena.author_id);
            const evento = abreviarIdentificador(resena.event_id);
            const resumen = resumenDelComentario(resena.comment);
            const estaAbierta = abierta === resena.id;
            const formularioAqui = enCurso === resena.id && accion !== null;
            const creada = momentoLegible(resena.created_at);
            const moderada = momentoLegible(resena.moderated_at);
            const porQuien = abreviarIdentificador(resena.moderated_by);

            return (
              <View
                key={resena.id}
                style={[styles.fila, { borderColor: colors.border }]}
              >
                <View style={styles.cabecera}>
                  <View style={styles.crece}>
                    {/* SOLO LECTURA: la nota y el autor se leen, no se editan. */}
                    {nota !== null ? (
                      <Text variant="secondary" weight="700">
                        {f('moderacionResenas.puntuacion', { valor: nota })}
                      </Text>
                    ) : null}
                    <Text variant="caption" color={colorDelEstado}>
                      {f(claveDelEstadoDeResena(resena.status))}
                    </Text>
                  </View>
                  <Feather
                    name={resena.status === 'hidden' ? 'eye-off' : 'eye'}
                    size={18}
                    color={colorDelEstado}
                  />
                </View>

                {resumen !== null ? (
                  <Text variant="secondary">
                    {estaAbierta ? (resena.comment as string) : resumen}
                  </Text>
                ) : (
                  <Text variant="caption" color={colors.textMuted}>
                    {f('moderacionResenas.sinComentario')}
                  </Text>
                )}

                {/* REFERENCIAS INTERNAS, no nombres: la identidad pública no
                    está decidida y el contrato no manda ningún perfil. */}
                {autor !== null ? (
                  <Text variant="caption" color={colors.textMuted}>
                    {f('moderacionResenas.autorRef', { valor: autor })}
                  </Text>
                ) : null}
                {evento !== null ? (
                  <Text variant="caption" color={colors.textMuted}>
                    {f('moderacionResenas.eventoRef', { valor: evento })}
                  </Text>
                ) : null}
                {creada !== '' ? (
                  <Text variant="caption" color={colors.textMuted}>
                    {f('moderacionResenas.creada', { fecha: creada })}
                  </Text>
                ) : null}

                {resena.status === 'hidden' ? (
                  <View style={[styles.recuadro, { borderColor: colors.border }]}>
                    <Text variant="caption" color={colors.textMuted}>
                      {resena.moderation_reason !== null &&
                      resena.moderation_reason.trim() !== ''
                        ? f('moderacionResenas.motivoActual', {
                            motivo: resena.moderation_reason,
                          })
                        : f('moderacionResenas.sinMotivoRegistrado')}
                    </Text>
                    {porQuien !== null ? (
                      <Text variant="caption" color={colors.textMuted}>
                        {f('moderacionResenas.ocultadaPor', { valor: porQuien })}
                      </Text>
                    ) : null}
                    {moderada !== '' ? (
                      <Text variant="caption" color={colors.textMuted}>
                        {f('moderacionResenas.ocultadaEl', { fecha: moderada })}
                      </Text>
                    ) : null}
                  </View>
                ) : null}

                {/* ------------------ Historial, solo lectura ------------------ */}
                <Pressable
                  onPress={() => verFicha(resena)}
                  style={styles.enlace}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: estaAbierta }}
                  accessibilityLabel={
                    estaAbierta
                      ? f('moderacionResenas.cerrarDetalle')
                      : f('moderacionResenas.verDetalle')
                  }
                >
                  <Feather
                    name={estaAbierta ? 'chevron-up' : 'chevron-down'}
                    size={16}
                    color={colors.textMuted}
                  />
                  <Text variant="caption" color={colors.textMuted}>
                    {estaAbierta
                      ? f('moderacionResenas.cerrarDetalle')
                      : f('moderacionResenas.verDetalle')}
                  </Text>
                </Pressable>

                {estaAbierta ? (
                  <View style={styles.bloque}>
                    <Text variant="caption" color={colors.textMuted}>
                      {f('moderacionResenas.historialTitulo')}
                    </Text>
                    {historialCargando ? (
                      <StateView state="loading" />
                    ) : historialFallo ? (
                      <Text variant="caption" color={colors.danger}>
                        {f('moderacionResenas.historialNoSePudo')}
                      </Text>
                    ) : historial.length === 0 ? (
                      <Text variant="caption" color={colors.textMuted}>
                        {f('moderacionResenas.historialVacio')}
                      </Text>
                    ) : (
                      historial.map((paso, indice) => {
                        const cuando = momentoLegible(paso.created_at);
                        const quien = abreviarIdentificador(paso.actor_id);
                        return (
                          <View
                            key={`${paso.created_at}-${paso.to_status}-${indice}`}
                            style={[styles.paso, { borderColor: colors.border }]}
                          >
                            {/* LA ACCIÓN ES EL DESTINO: dónde quedó la reseña. */}
                            <Text variant="secondary" weight="700">
                              {f(claveDelPaso(paso.to_status))}
                            </Text>
                            {paso.from_status !== null ? (
                              <Text variant="caption" color={colors.textMuted}>
                                {f('moderacionResenas.pasoDesde', {
                                  estado: f(claveDelEstadoDeResena(paso.from_status)),
                                })}
                              </Text>
                            ) : null}
                            {cuando !== '' ? (
                              <Text variant="caption" color={colors.textMuted}>
                                {cuando}
                              </Text>
                            ) : null}
                            {quien !== null ? (
                              <Text variant="caption" color={colors.textMuted}>
                                {f('moderacionResenas.pasoPor', { valor: quien })}
                              </Text>
                            ) : null}
                            <Text variant="caption" color={colors.textMuted}>
                              {paso.reason !== null && paso.reason.trim() !== ''
                                ? f('moderacionResenas.pasoMotivo', {
                                    motivo: paso.reason,
                                  })
                                : f('moderacionResenas.pasoSinMotivo')}
                            </Text>
                          </View>
                        );
                      })
                    )}
                  </View>
                ) : null}

                {/* ------------------------- Decidir ------------------------- */}
                {ofrece === null ? (
                  <Text variant="caption" color={colors.textMuted}>
                    {f('moderacionResenas.sinAccion')}
                  </Text>
                ) : formularioAqui ? (
                  <View style={[styles.recuadro, { borderColor: colors.border }]}>
                    <Text variant="secondary" weight="700">
                      {f(claveDeAccion(ofrece))}
                    </Text>
                    <Text variant="caption" color={colors.textMuted}>
                      {ofrece === 'ocultar'
                        ? f('moderacionResenas.ocultarNoBorraCuerpo')
                        : f('moderacionResenas.restaurarCuerpo')}
                    </Text>
                    <Input
                      label={
                        motivoObligatorio(ofrece)
                          ? f('moderacionResenas.motivoObligatorio')
                          : f('moderacionResenas.motivoOpcional')
                      }
                      placeholder={f('moderacionResenas.motivoAyuda')}
                      value={motivo}
                      onChangeText={(texto) => {
                        setMotivo(texto.slice(0, LARGO_MAXIMO_DEL_MOTIVO));
                        if (errorDelFormulario !== null) setErrorDelFormulario(null);
                      }}
                      maxLength={LARGO_MAXIMO_DEL_MOTIVO}
                      multiline
                      numberOfLines={3}
                      style={styles.campoLargo}
                      disabled={ocupado}
                    />
                    <Text variant="caption" color={colors.textMuted}>
                      {f('moderacionResenas.motivoContador', {
                        n: motivo.length,
                        max: LARGO_MAXIMO_DEL_MOTIVO,
                      })}
                    </Text>
                    {errorDelFormulario !== null ? (
                      <Text variant="caption" color={colors.danger}>
                        {errorDelFormulario}
                      </Text>
                    ) : null}
                    <Button
                      label={f('moderacionResenas.mandar')}
                      onPress={() => enviar(resena, ofrece)}
                      loading={ocupado}
                      disabled={ocupado}
                    />
                    <Button
                      label={t('common.cancel')}
                      variant="ghost"
                      onPress={cerrarFormulario}
                      disabled={ocupado}
                    />
                  </View>
                ) : (
                  <Button
                    label={f(claveDeAccion(ofrece))}
                    variant="secondary"
                    onPress={() => abrirFormulario(resena, ofrece)}
                    disabled={ocupado}
                  />
                )}
              </View>
            );
          })}
        </>
      )}

      {/* EL TOPE SE DICE. El servidor no manda cursor: «cincuenta» no es «todas». */}
      {tope ? (
        <Text variant="caption" color={colors.textMuted}>
          {f('moderacionResenas.tope', { n: limite })}
        </Text>
      ) : null}
      {tope && masArriba !== null ? (
        <Button
          label={f('moderacionResenas.verMas', { n: masArriba })}
          variant="secondary"
          onPress={() => setLimite(masArriba)}
          disabled={ocupado}
        />
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  filtros: { gap: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  crece: { flex: 1, gap: 4 },
  bloque: { gap: spacing.sm },
  cabecera: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  aviso: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  fila: {
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  recuadro: {
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  paso: {
    gap: 4,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  enlace: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
  },
  campoLargo: {
    minHeight: 72,
    textAlignVertical: 'top',
    paddingTop: spacing.sm,
  },
});
