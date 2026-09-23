import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import {
  LARGO_DEL_ENUNCIADO,
  LARGO_DE_LA_ALTERNATIVA,
  MAXIMO_DE_ALTERNATIVAS,
  conAlternativaNueva,
  hayCambiosSinGuardar,
  marcarCorrecta,
  motivoParaNoGuardar,
  motivoParaNoPublicar,
  moverPregunta,
  paraGuardar,
  notaMinimaValida,
  preguntaNueva,
  sinAlternativa,
  type PreguntaEditable,
} from '@/lib/editorDeEvaluacion';
import {
  evaluacionNoMontada,
  mensajeDeErrorDeEvaluacion,
  sinEvaluacion,
} from '@/lib/evaluacionDeCurso';
import { toast } from '@/lib/toast';
import {
  QuizAutorRepository,
  type BorradorDeEvaluacion,
} from '@/repositories/QuizAutorRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

type Borrador = {
  titulo: string;
  notaMinima: number;
  preguntas: PreguntaEditable[];
};

const vacio = (): Borrador => ({ titulo: '', notaMinima: 70, preguntas: [] });

const aBorrador = (datos: BorradorDeEvaluacion): Borrador => ({
  titulo: datos.titulo,
  notaMinima: datos.notaMinima,
  preguntas: datos.preguntas.map((p) => ({
    enunciado: p.enunciado,
    alternativas: p.alternativas.map((a) => ({
      texto: a.texto,
      esCorrecta: a.esCorrecta,
    })),
  })),
});

/**
 * El editor de la evaluación final, para quien administra el curso.
 *
 * LA ÚNICA PANTALLA DE LA APLICACIÓN QUE VE `is_correct`. El servidor solo lo
 * entrega en `/quiz/draft`, y solo al autor o a administración con poder real
 * —moderación no—; el contrato del alumno ni siquiera declara el campo.
 *
 * SE GUARDA ENTERA. Es lo que hace el servidor, y partirlo en «guardar esta
 * pregunta» habría pedido una máquina de estados para reconciliar borradores
 * parciales que nadie ha pedido.
 *
 * LA CORRECTA ES UNA. Marcar una apaga las demás: una pregunta con dos
 * correctas la rechaza la base, así que la interfaz se comporta como un grupo
 * de opción única y no como casillas. Y al borrar la correcta NO se pasa la
 * marca a la vecina: elegir por su cuenta la respuesta buena de un examen es
 * justo lo que una interfaz no puede hacer.
 */
export function EditarEvaluacionScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id: cursoId } = useLocalSearchParams<{ id: string }>();

  const [borrador, setBorrador] = useState<Borrador>(vacio);
  /** Lo último confirmado por el servidor: con esto se sabe qué está sin guardar. */
  const [guardado, setGuardado] = useState<Borrador>(vacio);
  const [estado, setEstado] = useState<'draft' | 'published'>('draft');
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<unknown>(null);
  const [guardando, setGuardando] = useState(false);
  const [publicando, setPublicando] = useState(false);
  /*
    MIENTRAS VIAJA EL PUT NO SE ESCRIBE. Al volver, la respuesta del servidor
    reemplaza el borrador; si se pudiera seguir tecleando, lo escrito durante
    esos segundos desaparecía y además `sinGuardar` quedaba en falso, así que al
    salir tampoco avisaba. Bloquear los campos es la única forma honesta: la
    alternativa —fusionar el eco con lo tecleado— es adivinar.
  */
  const ocupado = guardando || publicando;

  /** Cerrojos síncronos: dos toques no guardan ni publican dos veces. */
  const guardandoRef = useRef(false);
  const publicandoRef = useRef(false);
  const generacionRef = useRef(0);

  const cargar = useCallback(async () => {
    if (!cursoId) return;
    generacionRef.current += 1;
    const generacion = generacionRef.current;
    setCargando(true);
    setFallo(null);
    try {
      const datos = await QuizAutorRepository.borrador(cursoId);
      if (generacionRef.current !== generacion) return;
      const leido = aBorrador(datos);
      setBorrador(leido);
      setGuardado(leido);
      setEstado(datos.estado);
    } catch (error) {
      if (generacionRef.current !== generacion) return;
      // 404 `course_quiz_not_found` NO es un error: es un curso que todavía no
      // tiene evaluación, y esta pantalla existe justo para crearla.
      if (sinEvaluacion(error)) {
        setBorrador(vacio());
        setGuardado(vacio());
        setEstado('draft');
        return;
      }
      setFallo(error);
    } finally {
      if (generacionRef.current === generacion) setCargando(false);
    }
  }, [cursoId]);

  useEffect(() => {
    void cargar();
    return () => {
      generacionRef.current += 1;
    };
  }, [cargar]);

  const sinGuardar = useMemo(
    () => hayCambiosSinGuardar(borrador, guardado),
    [borrador, guardado],
  );
  const bloqueo = useMemo(
    () => motivoParaNoPublicar(borrador.preguntas),
    [borrador.preguntas],
  );

  const guardar = async (): Promise<boolean> => {
    if (guardandoRef.current || !cursoId) return false;
    // Se comprueba AQUÍ lo que la base va a rechazar de todos modos, para
    // poder decir qué falta en vez de recibir un 422 genérico.
    const impedimento = motivoParaNoGuardar(borrador.preguntas, borrador.notaMinima);
    if (impedimento !== null) {
      notify(
        t('common.saveFailed'),
        impedimento === 'quiz_pass_percent_invalid'
          ? t('editorEvaluacion.notaInvalida')
          : t(`editorEvaluacion.bloqueo.${impedimento}` as 'editorEvaluacion.bloqueo.quiz_option_empty'),
      );
      return false;
    }
    guardandoRef.current = true;
    setGuardando(true);
    const estabaPublicada = estado === 'published';
    try {
      const datos = await QuizAutorRepository.guardar(cursoId, {
        ...borrador,
        // Las preguntas en blanco no se mandan: la base exige texto y una fila
        // recién añadida hacía fallar el guardado entero.
        preguntas: paraGuardar(borrador.preguntas),
      });
      const leido = aBorrador(datos);
      setBorrador(leido);
      setGuardado(leido);
      setEstado(datos.estado);
      if (estabaPublicada && datos.estado === 'draft') {
        // El servidor la devolvió a borrador porque lo guardado ya no se puede
        // aprobar. Sus alumnos han dejado de poder hacerla: no puede pasar bajo
        // un toast verde que dice «guardada».
        notify(
          t('editorEvaluacion.despublicadaTitulo'),
          t('editorEvaluacion.despublicadaCuerpo'),
        );
      } else {
        toast(t('editorEvaluacion.guardada'));
      }
      return true;
    } catch (error) {
      // El borrador NO se limpia: perder lo escrito por un corte de red es
      // cambiar un contratiempo por un borrado.
      notify(t('common.saveFailed'), mensajeDeErrorDeEvaluacion(error, t));
      return false;
    } finally {
      guardandoRef.current = false;
      setGuardando(false);
    }
  };

  const publicar = async () => {
    if (publicandoRef.current || !cursoId) return;
    // Echado ANTES del primer `await`, que aquí es el propio diálogo.
    publicandoRef.current = true;
    try {
      const aceptado = await confirm({
        title: t('editorEvaluacion.publicarTitulo'),
        message: t('editorEvaluacion.publicarCuerpo'),
        confirmLabel: t('editorEvaluacion.publicar'),
      });
      if (!aceptado) return;
      setPublicando(true);
      // Se guarda ANTES de publicar: publicar lo que está en el servidor
      // mientras la pantalla enseña otra cosa es publicar a ciegas.
      if (sinGuardar && !(await guardar())) return;
      const datos = await QuizAutorRepository.publicar(cursoId);
      const leido = aBorrador(datos);
      setBorrador(leido);
      setGuardado(leido);
      setEstado(datos.estado);
      toast(t('editorEvaluacion.publicada'));
    } catch (error) {
      notify(t('common.saveFailed'), mensajeDeErrorDeEvaluacion(error, t));
    } finally {
      publicandoRef.current = false;
      setPublicando(false);
    }
  };

  const salir = async () => {
    if (sinGuardar) {
      const aceptado = await confirm({
        title: t('editorEvaluacion.salirTitulo'),
        message: t('editorEvaluacion.salirCuerpo'),
        confirmLabel: t('editorEvaluacion.salirConfirmar'),
        destructive: true,
      });
      if (!aceptado) return;
    }
    if (router.canGoBack()) router.back();
    else router.replace(`/gestionar-curso/${cursoId}` as never);
  };

  const cambiarPregunta = (indice: number, cambio: Partial<PreguntaEditable>) =>
    setBorrador((b) => ({
      ...b,
      preguntas: b.preguntas.map((p, i) => (i === indice ? { ...p, ...cambio } : p)),
    }));

  // La función no está montada en esta instalación: ni pantalla, ni error.
  if (evaluacionNoMontada(fallo)) {
    return (
      <AppScreen>
        <AppHeader title={t('editorEvaluacion.titulo')} onBack={() => void salir()} />
        <View style={styles.centro}>
          <Text variant="secondary" color={colors.textMuted}>
            {t('evaluacion.noDisponible')}
          </Text>
        </View>
      </AppScreen>
    );
  }

  if (cargando) {
    return (
      <AppScreen>
        <AppHeader title={t('editorEvaluacion.titulo')} onBack={() => void salir()} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null) {
    return (
      <AppScreen>
        <AppHeader title={t('editorEvaluacion.titulo')} onBack={() => void salir()} />
        <StateView
          state="error"
          description={mensajeDeErrorDeEvaluacion(fallo, t)}
          onRetry={() => void cargar()}
        />
      </AppScreen>
    );
  }

  return (
    <AppScreen
      contentStyle={styles.contenido}
      scrollProps={{ keyboardShouldPersistTaps: 'handled' }}
    >
      <AppHeader title={t('editorEvaluacion.titulo')} onBack={() => void salir()} />

      <View style={[styles.estado, { backgroundColor: colors.surfaceAlt }]}>
        <Feather
          name={estado === 'published' ? 'check-circle' : 'edit-3'}
          size={16}
          color={colors.textMuted}
        />
        <Text variant="secondary" color={colors.textMuted} style={styles.crece}>
          {estado === 'published'
            ? t('editorEvaluacion.estadoPublicada')
            : t('editorEvaluacion.estadoBorrador')}
        </Text>
        {sinGuardar ? (
          <Text variant="caption" weight="700" color={colors.danger}>
            {t('editorEvaluacion.sinGuardar')}
          </Text>
        ) : null}
      </View>

      <Text variant="secondary" weight="700">
        {t('editorEvaluacion.tituloDeLaEvaluacion')}
      </Text>
      <Input
        value={borrador.titulo}
        onChangeText={(titulo) => setBorrador((b) => ({ ...b, titulo }))}
        placeholder={t('editorEvaluacion.tituloMarcador')}
        placeholderTextColor={colors.textMuted}
        maxLength={200}
        editable={!ocupado}
        accessibilityLabel={t('editorEvaluacion.tituloDeLaEvaluacion')}
        style={{ color: colors.text }}
      />

      <Text variant="secondary" weight="700">
        {t('editorEvaluacion.notaMinima')}
      </Text>
      <Input
        value={String(borrador.notaMinima)}
        onChangeText={(texto) => {
          // Solo dígitos: el teclado numérico de Android deja escribir de todo.
          const limpio = texto.replace(/[^0-9]/g, '').slice(0, 3);
          setBorrador((b) => ({ ...b, notaMinima: limpio === '' ? 0 : Number(limpio) }));
        }}
        keyboardType="number-pad"
        maxLength={3}
        editable={!ocupado}
        accessibilityLabel={t('editorEvaluacion.notaMinima')}
        style={{ color: colors.text }}
      />
      {notaMinimaValida(borrador.notaMinima) ? null : (
        <Text variant="caption" color={colors.danger}>
          {t('editorEvaluacion.notaInvalida')}
        </Text>
      )}

      {borrador.preguntas.length === 0 ? (
        <Text variant="secondary" color={colors.textMuted} style={styles.vacio}>
          {t('editorEvaluacion.sinPreguntas')}
        </Text>
      ) : (
        borrador.preguntas.map((pregunta, indice) => (
          <View
            key={indice}
            style={[styles.pregunta, { borderColor: colors.border }]}
          >
            <View style={styles.cabeceraDePregunta}>
              <Text variant="secondary" weight="700" style={styles.crece}>
                {t('editorEvaluacion.pregunta', { numero: indice + 1 })}
              </Text>
              <IconoDeAccion
                icono="arrow-up"
                etiqueta={t('editorEvaluacion.subir')}
                desactivado={indice === 0}
                onPress={() =>
                  setBorrador((b) => ({
                    ...b,
                    preguntas: moverPregunta(b.preguntas, indice, indice - 1),
                  }))
                }
              />
              <IconoDeAccion
                icono="arrow-down"
                etiqueta={t('editorEvaluacion.bajar')}
                desactivado={indice === borrador.preguntas.length - 1}
                onPress={() =>
                  setBorrador((b) => ({
                    ...b,
                    preguntas: moverPregunta(b.preguntas, indice, indice + 1),
                  }))
                }
              />
              <IconoDeAccion
                icono="trash-2"
                etiqueta={t('editorEvaluacion.quitarPregunta')}
                onPress={() =>
                  setBorrador((b) => ({
                    ...b,
                    preguntas: b.preguntas.filter((_, i) => i !== indice),
                  }))
                }
              />
            </View>

            <Input
              value={pregunta.enunciado}
              onChangeText={(enunciado) => cambiarPregunta(indice, { enunciado })}
              placeholder={t('editorEvaluacion.enunciadoMarcador')}
              placeholderTextColor={colors.textMuted}
              multiline
              maxLength={LARGO_DEL_ENUNCIADO}
              textAlignVertical="top"
              editable={!ocupado}
              accessibilityLabel={t('editorEvaluacion.pregunta', { numero: indice + 1 })}
              style={{ color: colors.text, minHeight: 64 }}
            />

            {pregunta.alternativas.map((alternativa, j) => (
              <View key={j} style={styles.alternativa}>
                <Pressable
                  onPress={() =>
                    cambiarPregunta(indice, {
                      alternativas: marcarCorrecta(pregunta.alternativas, j),
                    })
                  }
                  hitSlop={8}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: alternativa.esCorrecta }}
                  accessibilityLabel={`${t('editorEvaluacion.marcarCorrecta')} ${j + 1}`}
                  style={styles.marca}
                >
                  <Feather
                    name={alternativa.esCorrecta ? 'check-circle' : 'circle'}
                    size={20}
                    color={alternativa.esCorrecta ? colors.success : colors.textMuted}
                  />
                </Pressable>
                <Input
                  value={alternativa.texto}
                  onChangeText={(texto) =>
                    cambiarPregunta(indice, {
                      alternativas: pregunta.alternativas.map((a, k) =>
                        k === j ? { ...a, texto } : a,
                      ),
                    })
                  }
                  placeholder={t('editorEvaluacion.alternativaMarcador')}
                  placeholderTextColor={colors.textMuted}
                  maxLength={LARGO_DE_LA_ALTERNATIVA}
                  editable={!ocupado}
                  accessibilityLabel={t('editorEvaluacion.alternativa', { numero: j + 1 })}
                  style={[styles.crece, { color: colors.text }]}
                />
                <IconoDeAccion
                  icono="x"
                  etiqueta={t('editorEvaluacion.quitarAlternativa')}
                  desactivado={pregunta.alternativas.length <= 2}
                  onPress={() =>
                    cambiarPregunta(indice, {
                      alternativas: sinAlternativa(pregunta.alternativas, j),
                    })
                  }
                />
              </View>
            ))}

            {pregunta.alternativas.length < MAXIMO_DE_ALTERNATIVAS ? (
              <Button
                label={t('editorEvaluacion.anadirAlternativa')}
                variant="ghost"
                onPress={() =>
                  cambiarPregunta(indice, {
                    alternativas: conAlternativaNueva(pregunta.alternativas),
                  })
                }
              />
            ) : null}
          </View>
        ))
      )}

      <Button
        label={t('editorEvaluacion.anadirPregunta')}
        variant="secondary"
        onPress={() =>
          setBorrador((b) => ({ ...b, preguntas: [...b.preguntas, preguntaNueva()] }))
        }
      />

      {/* Se dice QUÉ falta antes de llegar al botón desactivado. */}
      {bloqueo ? (
        <Text variant="secondary" color={colors.textMuted}>
          {t(`editorEvaluacion.bloqueo.${bloqueo}` as 'editorEvaluacion.bloqueo.quiz_without_questions')}
        </Text>
      ) : null}

      <Button
        label={t('common.save')}
        onPress={() => void guardar()}
        loading={guardando}
        disabled={ocupado}
      />
      <Button
        label={t('editorEvaluacion.publicar')}
        variant="secondary"
        onPress={() => void publicar()}
        loading={publicando}
        disabled={bloqueo !== null || !notaMinimaValida(borrador.notaMinima) || ocupado}
      />
    </AppScreen>
  );
}

function IconoDeAccion({
  icono,
  etiqueta,
  onPress,
  desactivado = false,
}: {
  icono: keyof typeof Feather.glyphMap;
  etiqueta: string;
  onPress: () => void;
  desactivado?: boolean;
}) {
  const { colors } = useAppTheme();
  return (
    <Pressable
      onPress={desactivado ? undefined : onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={etiqueta}
      accessibilityState={{ disabled: desactivado }}
      style={styles.icono}
    >
      <Feather
        name={icono}
        size={16}
        color={desactivado ? colors.border : colors.textMuted}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  estado: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  crece: { flex: 1 },
  vacio: { marginVertical: spacing.md },
  pregunta: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  cabeceraDePregunta: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  alternativa: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  marca: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  // 44 pt es el mínimo pulsable.
  icono: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
