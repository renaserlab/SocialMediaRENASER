import React, { useCallback, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
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
  LARGO_MAXIMO_DEL_MOTIVO,
  LARGO_MAXIMO_DE_LAS_NOTAS,
  LIMITE_INICIAL,
  POSTULACIONES_QUE_SE_FILTRAN,
  abreviarIdentificador,
  claveDeErrorDeProductos,
  claveDelCuerpoDelFallo,
  claveDelDocumento,
  claveDelEstadoDePostulacion,
  claveDelFallo,
  decisionExigeMotivo,
  esConflicto,
  falloDeCarga,
  llegoAlTope,
  revisarDecisionDePostulacion,
  sePuedeDecidirPostulacion,
  sePuedeTomar,
  seReintenta,
  siguienteLimite,
  type FalloDeCarga,
  type PostulacionRead,
} from '@/lib/evaluacionDeProductos';
import { ProductAdmissionRepository } from '@/repositories/ProductAdmissionRepository';
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

/** Lo que se está decidiendo ahora mismo sobre una postulación. */
type Decidiendo = { id: string; aceptar: boolean };

/** Lo que cabe de una propuesta en la fila. El texto entero está al abrirla. */
const RESUMEN = 180;

/** La propuesta recortada para la fila, sin fingir que es el texto completo. */
function resumenDeLaPropuesta(propuesta: string): string {
  const limpia = propuesta.replace(/\s+/g, ' ').trim();
  if (limpia.length <= RESUMEN) return limpia;
  return `${limpia.slice(0, RESUMEN).trimEnd()}…`;
}

/**
 * La bandeja de POSTULACIONES de proveedor. Pantalla INTERNA.
 *
 * UN RECHAZO EXIGE MOTIVO, y se comprueba aquí antes de llamar a nadie. El servidor lo
 * exige y un CHECK de la base detrás, pero descubrirlo después de pulsar es trabajo
 * tirado, y —más importante— un «no» sin motivo no se le puede enseñar a la persona que
 * escribió la postulación. Aceptar no lo exige: ahí el motivo es una nota opcional.
 *
 * LAS NOTAS INTERNAS NO SE LEEN AQUÍ. El contrato no las manda a propósito: lo que se ve
 * es el motivo que se le ENSEÑA a quien postuló. Este formulario puede escribir unas
 * notas nuevas, y eso es distinto de leer las de otra persona.
 *
 * NINGÚN PERMISO FINANCIERO. Aceptar una postulación crea la capacidad comercial; no
 * abre una cuenta, no mueve un saldo y no hay ni un botón que lo insinúe. Que entre los
 * documentos haya uno de tipo «cuenta bancaria» no cambia eso: aquí se lee que se
 * presentó, nunca su contenido.
 *
 * NADIE DECIDE SU PROPIA POSTULACIÓN. El servidor contesta
 * `seller_application_self_review_forbidden` y se enseña con su propio texto, no como un
 * 403 genérico.
 *
 * QUIÉN PUEDE ABRIRLA LO DECIDE EL SERVIDOR. Aquí no se comprueba ningún rol: quien no
 * es curaduría recibe un 403 y lee su propio aviso. Convertirlo en un «no hay nada»
 * diría algo distinto de lo que pasa.
 */
export function AdmisionDeProductosScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();

  /** `t` no acepta una cadena suelta: las claves salen del módulo de reglas. */
  const f = (clave: string, params?: Record<string, string | number>) =>
    t(clave as TranslationKey, params);

  const [filas, setFilas] = useState<PostulacionRead[]>([]);
  const [estado, setEstado] = useState<string | null>(null);
  const [limite, setLimite] = useState<number>(LIMITE_INICIAL);

  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<FalloDeCarga | null>(null);
  const [conflicto, setConflicto] = useState(false);

  const [abierta, setAbierta] = useState<string | null>(null);
  const [decidiendo, setDecidiendo] = useState<Decidiendo | null>(null);
  const [motivo, setMotivo] = useState('');
  const [notas, setNotas] = useState('');
  const [errorDelFormulario, setErrorDelFormulario] = useState<string | null>(null);

  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      const lista = await ProductAdmissionRepository.postulaciones({ estado, limite });
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
  }, [estado, limite]);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  const textoDelError = (error: unknown) => {
    if (error instanceof ApiError) {
      const clave = claveDeErrorDeProductos(error.code);
      if (clave !== null) return f(clave);
      if (error.status === 403) return f('productosAdmin.falloCuerpo.sinPermiso');
      if (error.status === 401) return f('productosAdmin.falloCuerpo.sinSesion');
      if (error.status === 422) return f('productosAdmin.falloCuerpo.datosInvalidos');
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
        ALGUIEN SE ADELANTÓ. No es un error que cerrar y olvidar: se avisa, se recarga
        la bandeja y se puede volver a decidir sobre lo que hay ahora.
      */
      if (error instanceof ApiError && esConflicto(error.code)) {
        setConflicto(true);
        await cargar();
      } else {
        notify(f('productosAdmin.noSePudo'), textoDelError(error));
      }
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  const cerrarFormulario = () => {
    setDecidiendo(null);
    setMotivo('');
    setNotas('');
    setErrorDelFormulario(null);
  };

  const abrirFormulario = (postulacion: PostulacionRead, aceptar: boolean) => {
    setDecidiendo({ id: postulacion.id, aceptar });
    setMotivo('');
    setNotas('');
    setErrorDelFormulario(null);
  };

  const elegirEstado = (valor: string | null) => {
    setLimite(LIMITE_INICIAL);
    cerrarFormulario();
    setEstado(valor);
  };

  /** La reemplaza con lo que contestó el servidor, sin mover el resto de la lista. */
  const repintar = (actualizada: PostulacionRead) => {
    setFilas((previas) =>
      previas.map((fila) => (fila.id === actualizada.id ? actualizada : fila)),
    );
  };

  const tomar = (postulacion: PostulacionRead) => {
    void conCerrojo(async () => {
      const aceptado = await confirm({
        title: f('productosAdmin.confirmarTomarTitulo'),
        message: f('productosAdmin.confirmarTomarCuerpo'),
        confirmLabel: f('productosAdmin.tomar'),
      });
      if (!aceptado) return;
      repintar(await ProductAdmissionRepository.tomarPostulacion(postulacion.id));
      toast(f('productosAdmin.tomada'));
    });
  };

  /**
   * Manda la decisión. EL MOTIVO SE COMPRUEBA AQUÍ, antes de llamar a nadie.
   *
   * Un rechazo sin motivo ni siquiera sale de la pantalla: se dice qué falta y lo
   * escrito sigue donde estaba.
   */
  const decidir = (postulacion: PostulacionRead, aceptar: boolean) => {
    const revisada = revisarDecisionDePostulacion(aceptar, motivo, notas);
    if (revisada.estado === 'faltaMotivo') {
      setErrorDelFormulario(f('productosAdmin.faltaMotivo'));
      return;
    }
    if (revisada.estado === 'motivoLargo') {
      setErrorDelFormulario(
        f('productosAdmin.motivoLargo', { max: revisada.maximo }),
      );
      return;
    }
    if (revisada.estado === 'notasLargas') {
      setErrorDelFormulario(
        f('productosAdmin.notasLargas', { max: revisada.maximo }),
      );
      return;
    }
    setErrorDelFormulario(null);

    void conCerrojo(async () => {
      const aceptado = await confirm({
        title: aceptar
          ? f('productosAdmin.confirmarAceptarTitulo')
          : f('productosAdmin.confirmarRechazarTitulo'),
        message: aceptar
          ? f('productosAdmin.confirmarAceptarCuerpo')
          : f('productosAdmin.confirmarRechazarCuerpo'),
        confirmLabel: aceptar
          ? f('productosAdmin.aceptar')
          : f('productosAdmin.rechazar'),
        destructive: !aceptar,
      });
      if (!aceptado) return;
      repintar(
        await ProductAdmissionRepository.decidirPostulacion(
          postulacion.id,
          revisada.cuerpo,
        ),
      );
      cerrarFormulario();
      setAbierta(null);
      toast(f('productosAdmin.hecho'));
    });
  };

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));

  const masArriba = siguienteLimite(limite);
  const tope = llegoAlTope(filas.length, limite);

  /* LO PRIMERO QUE SE LEE: un rechazo lleva motivo, y aquí no se mueve dinero. */
  const aviso = (
    <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt }]}>
      <Feather name="inbox" size={16} color={colors.textMuted} />
      <View style={styles.crece}>
        <Text variant="secondary" weight="700">
          {f('productosAdmin.avisoAdmisionTitulo')}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('productosAdmin.avisoAdmisionCuerpo')}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('productosAdmin.sinDinero')}
        </Text>
      </View>
    </View>
  );

  const filtros = (
    <View style={styles.filtros}>
      <Text variant="caption" color={colors.textMuted}>
        {f('productosAdmin.filtroEstado')}
      </Text>
      <View style={styles.chips}>
        <Chip
          label={f('productosAdmin.filtroPendientes')}
          selected={estado === null}
          rol="radio"
          disabled={ocupado}
          onPress={() => elegirEstado(null)}
        />
        {POSTULACIONES_QUE_SE_FILTRAN.map((valor) => (
          <Chip
            key={valor}
            label={f(claveDelEstadoDePostulacion(valor))}
            selected={estado === valor}
            rol="radio"
            disabled={ocupado}
            onPress={() => elegirEstado(valor)}
          />
        ))}
      </View>
    </View>
  );

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('productosAdmin.tituloAdmision')} onBack={volver} />
        {aviso}
        {filtros}
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('productosAdmin.tituloAdmision')} onBack={volver} />
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
      <AppHeader title={f('productosAdmin.tituloAdmision')} onBack={volver} />
      {aviso}
      {filtros}

      {/* ALGUIEN SE ADELANTÓ: se dice, se recargó, y se puede volver a decidir. */}
      {conflicto ? (
        <View style={[styles.recuadro, { borderColor: colors.danger }]}>
          <Text variant="secondary" weight="700" color={colors.danger}>
            {f('productosAdmin.conflictoTitulo')}
          </Text>
          <Text variant="secondary">{f('productosAdmin.conflictoCuerpo')}</Text>
          <Button
            label={f('productosAdmin.conflictoReintentar')}
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
          title={f('productosAdmin.admisionVacia')}
          description={f('productosAdmin.admisionVaciaCuerpo')}
          onRetry={() => void cargar()}
        />
      ) : (
        filas.map((postulacion) => {
          const estaAbierta = abierta === postulacion.id;
          /* Un `const` y no un booleano: así TypeScript sabe que no es nulo dentro. */
          const formularioAqui =
            decidiendo !== null && decidiendo.id === postulacion.id ? decidiendo : null;
          const enviada = momentoLegible(postulacion.submitted_at);
          const decidida = momentoLegible(postulacion.decided_at);
          const referencia = abreviarIdentificador(postulacion.id);
          const puedeTomar = sePuedeTomar(postulacion.status);
          const puedeDecidir = sePuedeDecidirPostulacion(postulacion.status);

          return (
            <View
              key={postulacion.id}
              style={[styles.fila, { borderColor: colors.border }]}
            >
              <View style={styles.cabecera}>
                <View style={styles.crece}>
                  <Text variant="secondary" weight="700">
                    {postulacion.display_name}
                  </Text>
                  <Text variant="caption" color={colors.textMuted}>
                    {f(claveDelEstadoDePostulacion(postulacion.status))}
                  </Text>
                </View>
                <Feather name="user-check" size={18} color={colors.textMuted} />
              </View>

              {/* LA PROPUESTA, que es lo que se evalúa de una postulación. */}
              <Text variant="secondary">
                {estaAbierta
                  ? postulacion.proposal
                  : resumenDeLaPropuesta(postulacion.proposal)}
              </Text>

              {referencia !== null ? (
                <Text variant="caption" color={colors.textMuted}>
                  {f('productosAdmin.referencia', { valor: referencia })}
                </Text>
              ) : null}
              {enviada !== '' ? (
                <Text variant="caption" color={colors.textMuted}>
                  {f('productosAdmin.enviada', { fecha: enviada })}
                </Text>
              ) : null}
              {decidida !== '' ? (
                <Text variant="caption" color={colors.textMuted}>
                  {f('productosAdmin.decidida', { fecha: decidida })}
                </Text>
              ) : null}
              {postulacion.decision_reason !== null &&
              postulacion.decision_reason.trim() !== '' ? (
                <Text variant="caption" color={colors.textMuted}>
                  {f('productosAdmin.motivoDecision', {
                    motivo: postulacion.decision_reason,
                  })}
                </Text>
              ) : null}

              <Pressable
                onPress={() => setAbierta(estaAbierta ? null : postulacion.id)}
                style={styles.enlace}
                accessibilityRole="button"
                accessibilityState={{ expanded: estaAbierta }}
                accessibilityLabel={
                  estaAbierta
                    ? f('productosAdmin.cerrarDetalle')
                    : f('productosAdmin.verDetalle')
                }
              >
                <Feather
                  name={estaAbierta ? 'chevron-up' : 'chevron-down'}
                  size={16}
                  color={colors.textMuted}
                />
                <Text variant="caption" color={colors.textMuted}>
                  {estaAbierta
                    ? f('productosAdmin.cerrarDetalle')
                    : f('productosAdmin.verDetalle')}
                </Text>
              </Pressable>

              {/* --------- LOS DOCUMENTOS PRESENTADOS, solo lectura --------- */}
              {estaAbierta ? (
                <View style={styles.bloque}>
                  <Text variant="caption" color={colors.textMuted}>
                    {f('productosAdmin.documentosTitulo')}
                  </Text>
                  {postulacion.documents.length === 0 ? (
                    <Text variant="caption" color={colors.textMuted}>
                      {f('productosAdmin.sinDocumentos')}
                    </Text>
                  ) : (
                    postulacion.documents.map((documento) => (
                      <View
                        key={documento.id}
                        style={[styles.paso, { borderColor: colors.border }]}
                      >
                        <Text variant="secondary" weight="700">
                          {f(claveDelDocumento(documento.kind))}
                        </Text>
                        {/* SE DICE QUE SE PRESENTÓ, no se abre: el contenido de un
                            documento no se lee desde una lista. */}
                        <Text variant="caption" color={colors.textMuted}>
                          {documento.storage_path !== null &&
                          documento.storage_path.trim() !== ''
                            ? f('productosAdmin.documentoPresentado')
                            : f('productosAdmin.documentoSoloNota')}
                        </Text>
                        {documento.note !== null && documento.note.trim() !== '' ? (
                          <Text variant="caption" color={colors.textMuted}>
                            {f('productosAdmin.documentoNota', {
                              nota: documento.note,
                            })}
                          </Text>
                        ) : null}
                        {/* Desde la 0085 el archivo se sube de verdad y el
                            servidor manda un enlace firmado de diez minutos:
                            quien revisa lo abre, no se lo imagina. */}
                        {documento.url ? (
                          <Button
                            label={f('productosAdmin.abrirDocumento')}
                            variant="ghost"
                            icon="external-link"
                            onPress={() => void Linking.openURL(documento.url as string)}
                          />
                        ) : null}
                      </View>
                    ))
                  )}
                </View>
              ) : null}

              {/* ------------------------- Decidir ------------------------- */}
              {puedeTomar ? (
                <Button
                  label={f('productosAdmin.tomar')}
                  variant="secondary"
                  onPress={() => tomar(postulacion)}
                  disabled={ocupado}
                />
              ) : null}

              {!puedeDecidir ? (
                <Text variant="caption" color={colors.textMuted}>
                  {f('productosAdmin.sinAccion')}
                </Text>
              ) : formularioAqui !== null ? (
                <View style={[styles.recuadro, { borderColor: colors.border }]}>
                  <Text variant="secondary" weight="700">
                    {formularioAqui.aceptar
                      ? f('productosAdmin.aceptar')
                      : f('productosAdmin.rechazar')}
                  </Text>
                  <Text variant="caption" color={colors.textMuted}>
                    {formularioAqui.aceptar
                      ? f('productosAdmin.aceptarCuerpo')
                      : f('productosAdmin.rechazarCuerpo')}
                  </Text>
                  <Input
                    label={
                      decisionExigeMotivo(formularioAqui.aceptar)
                        ? f('productosAdmin.motivoObligatorio')
                        : f('productosAdmin.motivoOpcional')
                    }
                    placeholder={f('productosAdmin.motivoAyuda')}
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
                    {f('productosAdmin.motivoContador', {
                      n: motivo.length,
                      max: LARGO_MAXIMO_DEL_MOTIVO,
                    })}
                  </Text>
                  {/* LAS NOTAS SON INTERNAS y no se le enseñan a quien postuló. */}
                  <Input
                    label={f('productosAdmin.notasEtiqueta')}
                    placeholder={f('productosAdmin.notasAyuda')}
                    value={notas}
                    onChangeText={(texto) => {
                      setNotas(texto.slice(0, LARGO_MAXIMO_DE_LAS_NOTAS));
                      if (errorDelFormulario !== null) setErrorDelFormulario(null);
                    }}
                    maxLength={LARGO_MAXIMO_DE_LAS_NOTAS}
                    multiline
                    numberOfLines={2}
                    style={styles.campoLargo}
                    disabled={ocupado}
                  />
                  {errorDelFormulario !== null ? (
                    <Text variant="caption" color={colors.danger}>
                      {errorDelFormulario}
                    </Text>
                  ) : null}
                  <Button
                    label={f('productosAdmin.mandar')}
                    onPress={() => decidir(postulacion, formularioAqui.aceptar)}
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
                <View style={styles.chips}>
                  <Button
                    label={f('productosAdmin.aceptar')}
                    variant="secondary"
                    onPress={() => abrirFormulario(postulacion, true)}
                    disabled={ocupado}
                  />
                  <Button
                    label={f('productosAdmin.rechazar')}
                    variant="ghost"
                    onPress={() => abrirFormulario(postulacion, false)}
                    disabled={ocupado}
                  />
                </View>
              )}
            </View>
          );
        })
      )}

      {/* EL TOPE SE DICE. El servidor no manda cursor: «cincuenta» no es «todas». */}
      {tope ? (
        <Text variant="caption" color={colors.textMuted}>
          {f('productosAdmin.tope', { n: limite })}
        </Text>
      ) : null}
      {tope && masArriba !== null ? (
        <Button
          label={f('productosAdmin.verMas', { n: masArriba })}
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
