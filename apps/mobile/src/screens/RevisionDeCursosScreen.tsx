import React, { useCallback, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm } from '@/lib/confirm';
import { describeError } from '@/lib/describeError';
import { toast } from '@/lib/toast';
import { LearningRepository } from '@/repositories/LearningRepository';
import { ApiError } from '@/services/api';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Course } from '@/types';
import { useTranslation } from '@/i18n/useTranslation';

/** Lo mismo que exige el servidor para rechazar (`review_course`). */
export const MINIMO_DEL_MOTIVO = 10;

/** Si el motivo escrito basta para rechazar. */
export function motivoValido(motivo: string): boolean {
  return motivo.trim().length >= MINIMO_DEL_MOTIVO;
}

/**
 * La bandeja de cursos enviados a revisión.
 *
 * POR QUÉ EXISTE. El servidor tenía la cola y la decisión
 * (`/catalog/courses/review-queue` y `/review`), y el repositorio los métodos,
 * pero ninguna pantalla los usaba: con la revisión obligatoria, NINGÚN curso
 * nuevo podía llegar al catálogo desde la app. Había que llamar a la API a mano.
 *
 * APROBAR NO PUBLICA: lo dice la confirmación. Quien creó el curso decide
 * cuándo sale, desde el paso «Revisar y enviar» de su asistente.
 *
 * QUIÉN PUEDE lo decide el servidor: 403 aquí es «no eres administración», y
 * un 403 al decidir sobre el propio curso tiene su propio aviso.
 */
export function RevisionDeCursosScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();

  const [cola, setCola] = useState<Course[]>([]);
  const [estado, setEstado] = useState<'loading' | 'content' | 'error' | 'empty'>('loading');
  const [sinPermiso, setSinPermiso] = useState(false);
  /** El curso que se está rechazando (muestra el campo del motivo). */
  const [rechazando, setRechazando] = useState<string | null>(null);
  const [motivo, setMotivo] = useState('');
  /** El curso con una decisión en vuelo: sus botones se deshabilitan. */
  const [decidiendo, setDecidiendo] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setEstado('loading');
    setSinPermiso(false);
    try {
      const cursos = await LearningRepository.reviewQueue();
      setCola(cursos);
      setEstado(cursos.length === 0 ? 'empty' : 'content');
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setSinPermiso(true);
        setEstado('empty');
        return;
      }
      setEstado('error');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  const decidir = async (curso: Course, decision: 'approve' | 'reject') => {
    if (decidiendo) return;
    if (decision === 'approve') {
      const seguro = await confirm({
        title: t('revisionCursos.confirmarAprobarTitulo'),
        message: t('revisionCursos.confirmarAprobarCuerpo'),
        confirmLabel: t('revisionCursos.aprobar'),
      });
      if (!seguro) return;
    } else if (!motivoValido(motivo)) {
      return;
    }
    setDecidiendo(curso.id);
    try {
      await LearningRepository.review(
        curso.id,
        decision,
        decision === 'reject' ? motivo.trim() : undefined,
      );
      // Sale de la bandeja: ya no espera a nadie. Se calcula aquí y no dentro
      // de un actualizador de estado: `decidiendo` impide dos decisiones a la
      // vez, así que `cola` no puede estar desfasada.
      const quedan = cola.filter((otro) => otro.id !== curso.id);
      setCola(quedan);
      if (quedan.length === 0) setEstado('empty');
      setRechazando(null);
      setMotivo('');
      toast(t(decision === 'approve' ? 'revisionCursos.aprobado' : 'revisionCursos.rechazado'));
    } catch (error) {
      if (error instanceof ApiError && error.code === 'course_self_review_not_allowed') {
        toast(t('revisionCursos.propio'), 'alert-circle');
      } else {
        toast(describeError(error, t('revisionCursos.fallo')), 'alert-circle');
      }
    } finally {
      setDecidiendo(null);
    }
  };

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={t('panelAdmin.cursos')} onBack={volver} />

      {estado === 'loading' ? <StateView state="loading" /> : null}
      {estado === 'error' ? (
        <StateView state="error" description={t('common.loadFailed')} onRetry={() => void cargar()} />
      ) : null}
      {estado === 'empty' ? (
        <StateView
          state="empty"
          icon="book"
          title={sinPermiso ? t('revisionCursos.sinPermiso') : t('revisionCursos.vacio')}
          description={sinPermiso ? undefined : t('revisionCursos.vacioCuerpo')}
        />
      ) : null}

      {estado === 'content'
        ? cola.map((curso) => {
            const ocupado = decidiendo === curso.id;
            const abiertoElRechazo = rechazando === curso.id;
            return (
              <View key={curso.id} style={[styles.tarjeta, { borderColor: colors.border }]}>
                <Text variant="secondary" weight="700">
                  {curso.title}
                </Text>
                {curso.authorName ? (
                  <Text variant="caption" color={colors.textMuted}>
                    {t('revisionCursos.de', { autor: curso.authorName })}
                  </Text>
                ) : null}

                <Button
                  label={t('revisionCursos.verCurso')}
                  variant="ghost"
                  icon="external-link"
                  onPress={() => router.push(`/course/${curso.id}` as never)}
                />

                {abiertoElRechazo ? (
                  <View style={styles.rechazo}>
                    <Text variant="caption" weight="700">
                      {t('revisionCursos.motivo')}
                    </Text>
                    <TextInput
                      value={motivo}
                      onChangeText={setMotivo}
                      multiline
                      maxLength={1000}
                      placeholder={t('revisionCursos.motivoAyuda')}
                      placeholderTextColor={colors.textMuted}
                      accessibilityLabel={t('revisionCursos.motivo')}
                      style={[styles.motivo, { borderColor: colors.border, color: colors.text }]}
                    />
                    <View style={styles.fila}>
                      <Button
                        label={t('common.cancel')}
                        variant="secondary"
                        disabled={ocupado}
                        onPress={() => {
                          setRechazando(null);
                          setMotivo('');
                        }}
                      />
                      <Button
                        label={t('revisionCursos.enviarRechazo')}
                        disabled={!motivoValido(motivo) || ocupado}
                        loading={ocupado}
                        onPress={() => void decidir(curso, 'reject')}
                      />
                    </View>
                  </View>
                ) : (
                  <View style={styles.fila}>
                    <Button
                      label={t('revisionCursos.rechazar')}
                      variant="secondary"
                      disabled={ocupado}
                      onPress={() => {
                        setRechazando(curso.id);
                        setMotivo('');
                      }}
                    />
                    <Button
                      label={t('revisionCursos.aprobar')}
                      disabled={ocupado}
                      loading={ocupado}
                      onPress={() => void decidir(curso, 'approve')}
                    />
                  </View>
                )}
              </View>
            );
          })
        : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  tarjeta: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  fila: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'flex-end', flexWrap: 'wrap' },
  rechazo: { gap: spacing.sm },
  motivo: {
    borderWidth: 1,
    borderRadius: radius.sm,
    minHeight: 80,
    padding: spacing.sm,
    textAlignVertical: 'top',
  },
});
