import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { BarraDeProgreso } from '@/components/BarraDeProgreso';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import {
  certificadosNoMontados,
  loQueFalta,
  mensajeDeErrorDeCertificado,
} from '@/lib/evaluacionDeCurso';
import {
  CertificateRepository,
  type EstadoDeFinalizacion,
} from '@/repositories/CertificateRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * Curso completado (captura 18).
 *
 * NO SE PINTA EL 100 % MIENTRAS EL SERVIDOR NO LO CONFIRME. La pantalla no
 * calcula nada: pregunta si el curso está terminado y enseña la cifra que le
 * dan. Deducirlo aquí —«he visto todas las lecciones, luego terminé»— sería
 * saltarse la evaluación final, que es justo lo que el servidor comprueba.
 *
 * Y SI NO ESTÁ TERMINADO SE DICE QUÉ FALTA, con el camino para hacerlo. Una
 * pantalla de felicitación que aparece a medias es peor que no aparecer.
 */
export function CursoCompletadoScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { curso } = useLocalSearchParams<{ curso: string }>();

  const [estado, setEstado] = useState<EstadoDeFinalizacion | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<unknown>(null);
  const [emitiendo, setEmitiendo] = useState(false);
  const emitiendoRef = useRef(false);
  const generacionRef = useRef(0);

  const cargar = useCallback(async () => {
    if (!curso) return;
    generacionRef.current += 1;
    const generacion = generacionRef.current;
    setCargando(true);
    setFallo(null);
    try {
      const datos = await CertificateRepository.finalizacion(curso);
      if (generacionRef.current !== generacion) return;
      setEstado(datos);
    } catch (error) {
      if (generacionRef.current !== generacion) return;
      setFallo(error);
    } finally {
      if (generacionRef.current === generacion) setCargando(false);
    }
  }, [curso]);

  useEffect(() => {
    void cargar();
    return () => {
      generacionRef.current += 1;
    };
  }, [cargar]);

  const verCertificado = async () => {
    if (emitiendoRef.current || !curso) return;
    emitiendoRef.current = true;
    setEmitiendo(true);
    try {
      // Ya emitido: se abre. Si no, se emite —el servidor vuelve a comprobar
      // que el curso está terminado y que el acceso sigue vivo— y se abre.
      const codigo =
        estado?.certificadoPublicoId ??
        (await CertificateRepository.emitir(curso)).codigo;
      router.push(`/certificado/${codigo}`);
    } catch (error) {
      notify(t('common.loadFailed'), mensajeDeErrorDeCertificado(error, t));
    } finally {
      emitiendoRef.current = false;
      setEmitiendo(false);
    }
  };

  const volverAlCurso = () =>
    curso ? router.replace(`/course/${curso}`) : router.back();

  if (cargando) {
    return (
      <AppScreen>
        <AppHeader title={t('completado.titulo')} onBack={volverAlCurso} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null || !estado) {
    return (
      <AppScreen>
        <AppHeader title={t('completado.titulo')} onBack={volverAlCurso} />
        <StateView
          state="error"
          description={mensajeDeErrorDeCertificado(fallo, t)}
          onRetry={() => void cargar()}
        />
      </AppScreen>
    );
  }

  const falta = loQueFalta({
    terminado: estado.terminado,
    leccionesTotales: estado.leccionesTotales,
    leccionesHechas: estado.leccionesHechas,
    exigeEvaluacion: estado.exigeEvaluacion,
    evaluacionAprobada: estado.evaluacionAprobada,
  });

  return (
    <AppScreen>
      <AppHeader title={t('completado.titulo')} onBack={volverAlCurso} />
      <View style={styles.centro}>
        <View style={[styles.sello, { backgroundColor: colors.surfaceAlt }]}>
          <Feather
            name={estado.terminado ? 'check' : 'clock'}
            size={32}
            color={estado.terminado ? colors.success : colors.textMuted}
          />
        </View>

        <Text variant="title" style={styles.titulo}>
          {t('completado.titulo')}
        </Text>
        {estado.terminado ? (
          <Text variant="secondary" color={colors.textMuted} style={styles.titulo}>
            {t('completado.subtitulo', { curso: estado.cursoTitulo })}
          </Text>
        ) : null}

        {/* El porcentaje REAL, el que dice el servidor. */}
        <View style={styles.progreso}>
          <BarraDeProgreso porcentaje={estado.porcentaje} style={styles.barra} />
          <Text variant="secondary" color={colors.textMuted}>
            {estado.porcentaje}%
          </Text>
        </View>

        <View style={styles.dato}>
          <Feather name="book-open" size={15} color={colors.textMuted} />
          <Text variant="secondary" color={colors.textMuted}>
            {t('completado.lecciones', {
              hechas: estado.leccionesHechas,
              total: estado.leccionesTotales,
            })}
          </Text>
        </View>

        {/* La nota SOLO si hay evaluación y hay intento: no se inventa un cero. */}
        {estado.exigeEvaluacion && estado.mejorNota !== null ? (
          <View style={styles.dato}>
            <Feather
              name={estado.evaluacionAprobada ? 'check-circle' : 'alert-circle'}
              size={15}
              color={estado.evaluacionAprobada ? colors.success : colors.textMuted}
            />
            <Text variant="secondary" color={colors.textMuted}>
              {t('evaluacion.mejorNota', { nota: estado.mejorNota })}
            </Text>
          </View>
        ) : null}

        {estado.terminado ? (
          <React.Fragment>
            {/* El certificado, solo si esta instalación los tiene montados. */}
            {certificadosNoMontados(fallo) ? null : (
              <Button
                label={
                  estado.certificadoPublicoId
                    ? t('completado.verCertificado')
                    : t('certificado.emitir')
                }
                onPress={() => void verCertificado()}
                loading={emitiendo}
                disabled={emitiendo}
                style={styles.accion}
              />
            )}
            <Button
              label={t('completado.valorar')}
              variant="secondary"
              onPress={volverAlCurso}
              style={styles.accion}
            />
          </React.Fragment>
        ) : (
          <React.Fragment>
            <Text variant="secondary" color={colors.textMuted} style={styles.titulo}>
              {falta === 'evaluacion'
                ? t('completado.faltaEvaluacion')
                : t('completado.faltanLecciones')}
            </Text>
            {falta === 'evaluacion' && curso ? (
              <Button
                label={t('completado.irALaEvaluacion')}
                onPress={() => router.push(`/evaluacion/${curso}`)}
                style={styles.accion}
              />
            ) : null}
          </React.Fragment>
        )}

        <Button
          label={t('completado.revisar')}
          variant="secondary"
          onPress={volverAlCurso}
          style={styles.accion}
        />
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  centro: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  sello: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  titulo: { textAlign: 'center' },
  progreso: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.md,
  },
  barra: { flex: 1 },
  dato: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  accion: { alignSelf: 'stretch', marginTop: spacing.sm },
});
