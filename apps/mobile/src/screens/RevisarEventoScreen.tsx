import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import {
  CRITERIOS,
  ORDEN_DE_CRITERIOS,
  TOTAL_POSIBLE,
  UMBRAL_APROBACION,
  UMBRAL_CONDICIONAL,
  claveDelEstado,
  decisionPosible,
  dentroDelTope,
  motivoParaNoDecidir,
  motivoParaNoEvaluar,
  puntajesVacios,
  total as sumaDe,
  type Criterio,
  type Puntajes,
} from '@/lib/admisionDeEvento';
import { claveDeCategoria } from '@/lib/eventoDelOrganizador';
import { confirm, notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import {
  EventAdmissionRepository,
  type DecisionDeAdmision,
  type ExpedienteDeEvento,
} from '@/repositories/EventAdmissionRepository';
import { ApiError } from '@/services/api';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * La ficha de revisión: los ocho criterios, la falla crítica y la decisión.
 *
 * PUNTUAR NO ES DECIDIR, y la pantalla está partida así a propósito: arriba se
 * evalúa —que es lo que puede hacer curaduría— y abajo se decide, que solo
 * puede administración. Quien no tenga el permiso ve el botón responder 403; no
 * se oculta, porque una pantalla que esconde lo que no puede hacer enseña menos
 * de lo que pasa.
 *
 * UNA FALLA CRÍTICA MANDA SOBRE EL PUNTAJE. Marcada, la decisión posible baja a
 * «rechazado» aunque el total sean 98. Es la regla que más fácil se pierde.
 *
 * LO QUE NO SE PINTA: nada del organizador que no venga del servidor, ningún
 * historial de riesgo —no existe— y ningún dinero: este incremento no cobra.
 */
export function RevisarEventoScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [expediente, setExpediente] = useState<ExpedienteDeEvento | null>(null);
  const [puntajes, setPuntajes] = useState<Puntajes>(puntajesVacios);
  const [evidencia, setEvidencia] = useState('');
  const [fallaCritica, setFallaCritica] = useState(false);
  const [motivoDeLaFalla, setMotivoDeLaFalla] = useState('');
  const [motivo, setMotivo] = useState('');
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState(false);
  /** `null` = fallo de red. Con valor, lo que el servidor contestó. */
  const [rechazo, setRechazo] = useState<'permiso' | 'noDisponible' | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);

  const aplicar = useCallback((datos: ExpedienteDeEvento) => {
    setExpediente(datos);
    if (datos.evaluacion) {
      const cargados = puntajesVacios();
      ORDEN_DE_CRITERIOS.forEach((c) => {
        cargados[c] = datos.evaluacion![c];
      });
      setPuntajes(cargados);
      setEvidencia(datos.evaluacion.evidencia);
      setFallaCritica(datos.evaluacion.falla_critica);
      setMotivoDeLaFalla(datos.evaluacion.motivo_de_la_falla);
    }
  }, []);

  const cargar = useCallback(async () => {
    if (!id) return;
    setCargando(true);
    setFallo(false);
    setRechazo(null);
    try {
      aplicar(await EventAdmissionRepository.expediente(id));
    } catch (error) {
      // Un `catch` ciego pintaba «no pudimos cargar» con un reintento tanto
      // para un fallo de red como para un permiso denegado o una migración sin
      // aplicar, que son dos cosas que reintentar no arregla.
      if (error instanceof ApiError && error.status === 403) setRechazo('permiso');
      else if (
        error instanceof ApiError &&
        error.code === 'events_workflow_not_available'
      ) {
        setRechazo('noDisponible');
      }
      setFallo(true);
    } finally {
      setCargando(false);
    }
  }, [id, aplicar]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const conError = (error: unknown) =>
    notify(
      t('common.saveFailed'),
      error instanceof Error && error.message.trim() !== ''
        ? error.message
        : t('common.tryAgain'),
    );

  const conCerrojo = async (accion: () => Promise<ExpedienteDeEvento>, aviso: string) => {
    if (ocupadoRef.current || !id) return;
    ocupadoRef.current = true;
    setOcupado(true);
    try {
      aplicar(await accion());
      toast(aviso);
    } catch (error) {
      conError(error);
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  const guardarEvaluacion = async () => {
    const falta = motivoParaNoEvaluar(evidencia, fallaCritica, motivoDeLaFalla);
    if (falta) {
      notify(t('admisionEvento.noSePuedeGuardar'), t(falta as TranslationKey));
      return;
    }
    await conCerrojo(
      () =>
        EventAdmissionRepository.evaluar(id as string, {
          ...puntajes,
          evidencia: evidencia.trim(),
          falla_critica: fallaCritica,
          motivo_de_la_falla: motivoDeLaFalla.trim(),
        }),
      t('admisionEvento.evaluacionGuardada'),
    );
  };

  const decidir = async (decision: DecisionDeAdmision) => {
    // CONTRA LO GUARDADO, no contra lo escrito. Subir los puntajes a 90 sin
    // pulsar «Guardar evaluación» habilitaba «Aprobar», y el servidor —que
    // compara con la evaluación persistida— respondía 409.
    const guardada = expediente?.evaluacion ?? null;
    const falta = motivoParaNoDecidir(
      decision,
      guardada != null,
      guardada
        ? (Object.fromEntries(
            ORDEN_DE_CRITERIOS.map((c) => [c, guardada[c]]),
          ) as Puntajes)
        : null,
      guardada?.falla_critica ?? false,
      motivo,
    );
    if (falta) {
      notify(t('admisionEvento.noSePuedeDecidir'), t(falta as TranslationKey));
      return;
    }
    const aceptado = await confirm({
      title: t(`admisionEvento.confirmar.${decision}` as TranslationKey),
      message: t('admisionEvento.confirmarCuerpo'),
      confirmLabel: t(`admisionEvento.decision.${decision}` as TranslationKey),
      destructive: decision === 'rejected',
    });
    if (!aceptado) return;
    await conCerrojo(
      () => EventAdmissionRepository.decidir(id as string, decision, motivo.trim()),
      t('admisionEvento.decisionGuardada'),
    );
  };

  const pedirCorrecciones = async () => {
    if (motivo.trim() === '') {
      notify(t('admisionEvento.noSePuedeDecidir'), t('admisionEvento.faltaMotivo'));
      return;
    }
    await conCerrojo(
      () => EventAdmissionRepository.pedirCorrecciones(id as string, motivo.trim()),
      t('admisionEvento.devuelto'),
    );
  };

  const publicar = async () => {
    const aceptado = await confirm({
      title: t('admisionEvento.confirmar.publish'),
      message: t('admisionEvento.publicarCuerpo'),
      confirmLabel: t('admisionEvento.publicar'),
    });
    if (!aceptado) return;
    await conCerrojo(
      () => EventAdmissionRepository.publicar(id as string),
      t('admisionEvento.publicado'),
    );
  };

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/admin/eventos' as never);

  if (cargando) {
    return (
      <AppScreen>
        <AppHeader title={t('admisionEvento.ficha')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo || !expediente) {
    return (
      <AppScreen>
        <AppHeader title={t('admisionEvento.ficha')} onBack={volver} />
        {rechazo === null ? (
          <StateView
            state="error"
            description={t('common.loadFailed')}
            onRetry={() => void cargar()}
          />
        ) : (
          <StateView
            state="empty"
            title={
              rechazo === 'permiso'
                ? t('admisionEvento.sinPermiso')
                : t('misEventos.noDisponible')
            }
            description={
              rechazo === 'permiso'
                ? t('admisionEvento.sinPermisoCuerpo')
                : t('misEventos.noDisponibleCuerpo')
            }
          />
        )}
      </AppScreen>
    );
  }

  const suma = sumaDe(puntajes);
  const posible = decisionPosible(puntajes, fallaCritica);
  const bloqueos = expediente.bloqueos_para_publicar;

  return (
    <SinTecladoDelante>
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={t('admisionEvento.ficha')} onBack={volver} />

      <Text variant="title">{expediente.title}</Text>
      <Text variant="caption" color={colors.textMuted}>
        {t(claveDelEstado(expediente.workflow_status) as TranslationKey)}
        {expediente.origin === 'legacy' ? ` · ${t('admisionEvento.heredado')}` : ''}
      </Text>
      {expediente.promise ? (
        <Text variant="secondary">{expediente.promise}</Text>
      ) : null}
      <Text variant="caption" color={colors.textMuted}>
        {t(claveDeCategoria(expediente.category) as TranslationKey)}
      </Text>
      {expediente.description ? (
        <Text variant="body">{expediente.description}</Text>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {/* Evaluación: curaduría                                             */}
      {/* ---------------------------------------------------------------- */}
      <Text variant="secondary" weight="700">
        {t('admisionEvento.evaluacion')}
      </Text>

      {ORDEN_DE_CRITERIOS.map((criterio: Criterio) => (
        <View key={criterio} style={styles.criterio}>
          <View style={styles.crece}>
            <Text variant="secondary">{t(`admisionEvento.criterio.${criterio}` as TranslationKey)}</Text>
            <Text variant="caption" color={colors.textMuted}>
              {t('admisionEvento.deTope', {
                valor: puntajes[criterio],
                tope: CRITERIOS[criterio],
              })}
            </Text>
          </View>
          <Pressable
            disabled={ocupado}
            onPress={() =>
              setPuntajes({
                ...puntajes,
                [criterio]: dentroDelTope(criterio, puntajes[criterio] - 1),
              })
            }
            style={[styles.boton, { borderColor: colors.border }]}
            accessibilityRole="button"
            accessibilityLabel={t('admisionEvento.bajar')}
          >
            <Feather name="minus" size={16} color={colors.text} />
          </Pressable>
          <Pressable
            disabled={ocupado}
            onPress={() =>
              setPuntajes({
                ...puntajes,
                [criterio]: dentroDelTope(criterio, puntajes[criterio] + 1),
              })
            }
            style={[styles.boton, { borderColor: colors.border }]}
            accessibilityRole="button"
            accessibilityLabel={t('admisionEvento.subir')}
          >
            <Feather name="plus" size={16} color={colors.text} />
          </Pressable>
        </View>
      ))}

      <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt }]}>
        <Text variant="secondary" weight="700" style={styles.crece}>
          {t('admisionEvento.total', { suma, tope: TOTAL_POSIBLE })}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {t(`admisionEvento.posible.${posible}` as TranslationKey)}
        </Text>
      </View>
      <Text variant="caption" color={colors.textMuted}>
        {t('admisionEvento.umbrales', {
          aprobar: UMBRAL_APROBACION,
          condicional: UMBRAL_CONDICIONAL,
        })}
      </Text>

      <Pressable
        disabled={ocupado}
        onPress={() => setFallaCritica(!fallaCritica)}
        style={[styles.critica, { borderColor: fallaCritica ? colors.danger : colors.border }]}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: fallaCritica }}
      >
        <Feather
          name={fallaCritica ? 'check-square' : 'square'}
          size={18}
          color={fallaCritica ? colors.danger : colors.textMuted}
        />
        <Text variant="secondary" style={styles.crece}>
          {t('admisionEvento.fallaCritica')}
        </Text>
      </Pressable>
      {fallaCritica ? (
        <Input
          label={t('admisionEvento.motivoDeLaFalla')}
          value={motivoDeLaFalla}
          onChangeText={setMotivoDeLaFalla}
          editable={!ocupado}
          maxLength={500}
        />
      ) : null}

      <Input
        label={t('admisionEvento.evidencia')}
        value={evidencia}
        onChangeText={setEvidencia}
        editable={!ocupado}
        multiline
        numberOfLines={4}
        maxLength={2000}
        style={styles.parrafo}
      />

      <Button
        label={t('admisionEvento.guardarEvaluacion')}
        variant="secondary"
        onPress={() => void guardarEvaluacion()}
        disabled={ocupado}
      />

      {/* ---------------------------------------------------------------- */}
      {/* Decisión: administración                                          */}
      {/* ---------------------------------------------------------------- */}
      <Text variant="secondary" weight="700">
        {t('admisionEvento.decidir')}
      </Text>
      <Input
        label={t('admisionEvento.motivo')}
        value={motivo}
        onChangeText={setMotivo}
        editable={!ocupado}
        multiline
        numberOfLines={3}
        maxLength={1000}
        style={styles.parrafo}
      />

      <Button
        label={t('admisionEvento.decision.changes_requested')}
        variant="secondary"
        onPress={() => void pedirCorrecciones()}
        disabled={ocupado}
      />
      <Button
        label={t('admisionEvento.decision.conditional')}
        variant="secondary"
        onPress={() => void decidir('conditional')}
        disabled={ocupado}
      />
      <Button
        label={t('admisionEvento.decision.rejected')}
        variant="secondary"
        onPress={() => void decidir('rejected')}
        disabled={ocupado}
      />
      <Button
        label={t('admisionEvento.decision.approved')}
        onPress={() => void decidir('approved')}
        disabled={ocupado}
      />

      {/* Publicar: solo cuando el evento está aprobado y sin bloqueos. */}
      {expediente.workflow_status === 'APPROVED' ? (
        <>
          {bloqueos.length > 0 ? (
            <Text variant="caption" color={colors.danger}>
              {t('admisionEvento.bloqueos', { lista: bloqueos.join(', ') })}
            </Text>
          ) : null}
          <Button
            label={t('admisionEvento.publicar')}
            onPress={() => void publicar()}
            disabled={ocupado || bloqueos.length > 0}
          />
        </>
      ) : null}
    </AppScreen>
    </SinTecladoDelante>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  crece: { flex: 1 },
  parrafo: { minHeight: 90, textAlignVertical: 'top' },
  criterio: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  boton: {
    borderWidth: 1,
    borderRadius: radius.lg,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aviso: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  critica: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    minHeight: 44,
  },
});
