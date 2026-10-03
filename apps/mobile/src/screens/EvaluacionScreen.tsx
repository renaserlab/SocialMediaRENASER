import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { BarraDeProgreso } from '@/components/BarraDeProgreso';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import {
  avance,
  evaluacionNoMontada,
  faltan,
  mensajeDeErrorDeEvaluacion,
  respondidas,
  sePuedeEnviar,
  sinEvaluacion,
  type Elegidas,
} from '@/lib/evaluacionDeCurso';
import {
  QuizRepository,
  type EvaluacionDeCurso,
  type IntentoDeEvaluacion,
} from '@/repositories/QuizRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * La evaluación final de un curso (captura 17).
 *
 * LO QUE ESTA PANTALLA NO HACE, Y NO PUEDE HACER: corregir. El servidor no
 * manda cuál es la respuesta correcta mientras el intento está abierto, así que
 * aquí no hay forma de adelantar el resultado ni de pintar una opción en verde.
 * La nota llega al enviar, calculada allí.
 *
 * NO ES `QuizScreen` NI LA SUSTITUYE: aquella es un test de captación
 * con las preguntas escritas a mano en `mockData.ts`, no está atada a ningún
 * curso y su resultado no sale del teléfono. Son dos cosas distintas y esta es
 * la que evalúa un curso.
 *
 * SE ENVÍA ENTERA. El servidor cuenta las no respondidas como falladas y cierra
 * el intento para siempre, así que dejar enviar a medias por descuido sería
 * regalar una nota más baja.
 */
export function EvaluacionScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { curso } = useLocalSearchParams<{ curso: string }>();

  const [evaluacion, setEvaluacion] = useState<EvaluacionDeCurso | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<unknown>(null);
  const [intento, setIntento] = useState<IntentoDeEvaluacion | null>(null);
  const [elegidas, setElegidas] = useState<Elegidas>({});
  const [indice, setIndice] = useState(0);
  const [enviando, setEnviando] = useState(false);
  /** Abriendo el intento: «Empezar» y «Volver a intentarlo» giran y se apagan. */
  const [empezando, setEmpezando] = useState(false);
  const [resultado, setResultado] = useState<IntentoDeEvaluacion | null>(null);

  /** Cerrojos síncronos: dos toques no abren dos intentos ni envían dos veces. */
  const empezandoRef = useRef(false);
  const enviandoRef = useRef(false);
  const generacionRef = useRef(0);

  const cargar = useCallback(async () => {
    if (!curso) return;
    generacionRef.current += 1;
    const generacion = generacionRef.current;
    setCargando(true);
    setFallo(null);
    try {
      const datos = await QuizRepository.obtener(curso);
      if (generacionRef.current !== generacion) return;
      setEvaluacion(datos);
      setIntento(datos.intentoAbierto);
      setResultado(null);
      setElegidas({});
      setIndice(0);
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

  const empezar = async () => {
    if (empezandoRef.current || !curso) return;
    empezandoRef.current = true;
    // El cerrojo ya impedía el segundo intento, pero el botón no decía nada
    // mientras tanto: parecía que el toque no había llegado.
    setEmpezando(true);
    try {
      setIntento(await QuizRepository.empezar(curso));
      setElegidas({});
      setIndice(0);
      setResultado(null);
    } catch (error) {
      notify(t('common.loadFailed'), mensajeDeErrorDeEvaluacion(error, t));
    } finally {
      empezandoRef.current = false;
      setEmpezando(false);
    }
  };

  const enviar = async () => {
    if (enviandoRef.current || !intento || !evaluacion) return;
    // Echado ANTES del primer `await`, que aquí es el propio diálogo.
    enviandoRef.current = true;
    try {
      const aceptado = await confirm({
        title: t('evaluacion.confirmarTitulo'),
        message: t('evaluacion.confirmarCuerpo'),
        confirmLabel: t('evaluacion.enviar'),
      });
      if (!aceptado) return;
      setEnviando(true);
      const enviado = await QuizRepository.enviar(
        intento.id,
        evaluacion.preguntas.map((p) => ({
          preguntaId: p.id,
          alternativaId: elegidas[p.id] as string,
        })),
      );
      setResultado(enviado);
      setIntento(null);
    } catch (error) {
      // Aquí no se estaba CARGANDO nada: se estaba enviando. Con el título de
      // «no pudimos cargar el contenido» no se sabía si las respuestas habían
      // llegado.
      notify(t('common.saveFailed'), mensajeDeErrorDeEvaluacion(error, t));
    } finally {
      enviandoRef.current = false;
      setEnviando(false);
    }
  };

  const volverAlCurso = () =>
    curso ? router.replace(`/course/${curso}`) : router.back();

  // Ni pantalla ni error: esta instalación no tiene la 0058, o el curso no
  // tiene evaluación. Ninguna de las dos cosas es una avería.
  if (evaluacionNoMontada(fallo) || sinEvaluacion(fallo)) {
    return (
      <AppScreen>
        <AppHeader title={t('evaluacion.titulo')} onBack={volverAlCurso} />
        <View style={styles.centro}>
          <Text variant="secondary" color={colors.textMuted}>
            {t('evaluacion.sinEvaluacion')}
          </Text>
          <Button
            label={t('evaluacion.volverAlCurso')}
            variant="secondary"
            onPress={volverAlCurso}
            style={styles.accion}
          />
        </View>
      </AppScreen>
    );
  }

  if (cargando) {
    return (
      <AppScreen>
        <AppHeader title={t('evaluacion.titulo')} onBack={volverAlCurso} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null || !evaluacion) {
    return (
      <AppScreen>
        <AppHeader title={t('evaluacion.titulo')} onBack={volverAlCurso} />
        <StateView
          state="error"
          description={mensajeDeErrorDeEvaluacion(fallo, t)}
          onRetry={() => void cargar()}
        />
      </AppScreen>
    );
  }

  if (resultado) {
    return (
      <Resultado
        intento={resultado}
        minimo={evaluacion.notaMinima}
        onReintentar={() => void empezar()}
        reintentando={empezando}
        onVolver={volverAlCurso}
      />
    );
  }

  if (evaluacion.preguntas.length === 0) {
    return (
      <AppScreen>
        <AppHeader title={t('evaluacion.titulo')} onBack={volverAlCurso} />
        <View style={styles.centro}>
          <Text variant="secondary" color={colors.textMuted}>
            {t('evaluacion.sinPreguntas')}
          </Text>
        </View>
      </AppScreen>
    );
  }

  // Todavía no ha empezado: se cuenta qué es y se ofrece empezar.
  if (!intento) {
    return (
      <AppScreen>
        <AppHeader title={t('evaluacion.titulo')} onBack={volverAlCurso} />
        <View style={styles.centro}>
          <Text variant="titleMedium">{evaluacion.titulo || t('evaluacion.titulo')}</Text>
          <Text variant="secondary" color={colors.textMuted}>
            {t('evaluacion.notaMinima', { minimo: evaluacion.notaMinima })}
          </Text>
          {/* La mejor nota SOLO si consta: no se inventa un cero. */}
          {evaluacion.mejorIntento?.nota !== null &&
          evaluacion.mejorIntento !== null ? (
            <Text variant="secondary" color={colors.textMuted}>
              {t('evaluacion.mejorNota', { nota: evaluacion.mejorIntento.nota ?? 0 })}
            </Text>
          ) : null}
          <Button
            label={t('evaluacion.empezar')}
            onPress={() => void empezar()}
            loading={empezando}
            disabled={empezando}
            style={styles.accion}
          />
        </View>
      </AppScreen>
    );
  }

  const pregunta = evaluacion.preguntas[indice];
  if (!pregunta) return null;
  const hechas = respondidas(evaluacion.preguntas, elegidas);
  const puedeEnviar = sePuedeEnviar(evaluacion.preguntas, elegidas);
  const pendientes = faltan(evaluacion.preguntas, elegidas);
  const ultima = indice >= evaluacion.preguntas.length - 1;

  return (
    <AppScreen>
      <AppHeader title={t('evaluacion.titulo')} onBack={volverAlCurso} />
      <ScrollView contentContainerStyle={styles.contenido}>
        <View style={styles.cabecera}>
          <Text variant="secondary" color={colors.textMuted}>
            {t('evaluacion.preguntaDe', {
              actual: indice + 1,
              total: evaluacion.preguntas.length,
            })}
          </Text>
          <Text variant="secondary" color={colors.textMuted}>
            {avance(evaluacion.preguntas.length, hechas)}%
          </Text>
        </View>
        <BarraDeProgreso porcentaje={avance(evaluacion.preguntas.length, hechas)} />

        <Text variant="titleMedium" style={styles.enunciado}>
          {pregunta.enunciado}
        </Text>

        <View style={styles.alternativas}>
          {pregunta.alternativas.map((alternativa) => {
            const marcada = elegidas[pregunta.id] === alternativa.id;
            return (
              <Pressable
                key={alternativa.id}
                onPress={() =>
                  setElegidas((previas) => ({
                    ...previas,
                    [pregunta.id]: alternativa.id,
                  }))
                }
                accessibilityRole="radio"
                accessibilityState={{ checked: marcada }}
                accessibilityLabel={alternativa.texto}
                style={[
                  styles.alternativa,
                  {
                    borderColor: marcada ? colors.text : colors.border,
                    backgroundColor: marcada ? colors.surfaceAlt : 'transparent',
                  },
                ]}
              >
                <Feather
                  name={marcada ? 'check-circle' : 'circle'}
                  size={20}
                  color={marcada ? colors.text : colors.textMuted}
                />
                <Text variant="body" style={styles.textoAlternativa}>
                  {alternativa.texto}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Se dice cuántas faltan ANTES de llegar al botón desactivado. */}
        {ultima && !puedeEnviar ? (
          <Text variant="secondary" color={colors.textMuted}>
            {t('evaluacion.faltan', { cuantas: pendientes })}
          </Text>
        ) : null}

        <View style={styles.botones}>
          <Button
            label={t('evaluacion.anterior')}
            variant="secondary"
            disabled={indice === 0}
            onPress={() => setIndice((n) => Math.max(0, n - 1))}
            style={styles.boton}
          />
          {ultima ? (
            <Button
              label={t('evaluacion.enviar')}
              disabled={!puedeEnviar || enviando}
              loading={enviando}
              onPress={() => void enviar()}
              style={styles.boton}
            />
          ) : (
            <Button
              label={t('evaluacion.siguiente')}
              onPress={() =>
                setIndice((n) => Math.min(evaluacion.preguntas.length - 1, n + 1))
              }
              style={styles.boton}
            />
          )}
        </View>
      </ScrollView>
    </AppScreen>
  );
}

/** El resultado de un intento ya enviado. La nota viene del servidor. */
function Resultado({
  intento,
  minimo,
  onReintentar,
  reintentando,
  onVolver,
}: {
  intento: IntentoDeEvaluacion;
  minimo: number;
  onReintentar: () => void;
  /** Se está abriendo el intento nuevo. */
  reintentando: boolean;
  onVolver: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const aprobado = intento.aprobado === true;

  return (
    <AppScreen>
      <AppHeader title={t('evaluacion.titulo')} onBack={onVolver} />
      <View style={styles.centro}>
        <View style={[styles.sello, { backgroundColor: colors.surfaceAlt }]}>
          <Feather
            name={aprobado ? 'check' : 'x'}
            size={32}
            color={aprobado ? colors.success : colors.danger}
          />
        </View>
        <Text variant="secondary" color={colors.textMuted}>
          {t('evaluacion.tuNota')}
        </Text>
        {/* La nota tal cual la puso el servidor. Un 0 es un 0. */}
        <Text variant="display">{intento.nota ?? 0}%</Text>
        <Text
          variant="body"
          weight="700"
          color={aprobado ? colors.success : colors.danger}
        >
          {aprobado ? t('evaluacion.aprobado') : t('evaluacion.desaprobado')}
        </Text>
        <Text variant="secondary" color={colors.textMuted}>
          {t('evaluacion.notaMinima', { minimo })}
        </Text>

        {/* Reintentar SOLO si no aprobó: quien ya aprobó no gana nada, y para
            terminar el curso cuenta su mejor nota de todos modos. */}
        {aprobado ? null : (
          <Button
            label={t('evaluacion.reintentar')}
            onPress={onReintentar}
            loading={reintentando}
            disabled={reintentando}
            style={styles.accion}
          />
        )}
        <Button
          label={t('evaluacion.volverAlCurso')}
          variant="secondary"
          onPress={onVolver}
          style={styles.accion}
        />
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  cabecera: { flexDirection: 'row', justifyContent: 'space-between' },
  enunciado: { marginTop: spacing.md },
  alternativas: { gap: spacing.sm, marginTop: spacing.sm },
  alternativa: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    // 44 pt es el mínimo pulsable.
    minHeight: 56,
  },
  textoAlternativa: { flex: 1 },
  botones: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  boton: { flex: 1 },
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
  accion: { alignSelf: 'stretch', marginTop: spacing.md },
});
