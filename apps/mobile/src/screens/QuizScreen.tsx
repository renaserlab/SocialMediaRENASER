import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { quizQuestions } from '@/data/mockData';
import { useAppStore } from '@/store/useAppStore';
import { motion, radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { QuizArea } from '@/types';
import { useTranslation } from '@/i18n/useTranslation';

export function QuizScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const answers = useAppStore((state) => state.quizAnswers);
  const answerQuiz = useAppStore((state) => state.answerQuiz);
  const finishQuiz = useAppStore((state) => state.finishQuiz);
  const [index, setIndex] = useState(0);

  // Sentido del ultimo movimiento: la pregunta entra desde la derecha al
  // avanzar y desde la izquierda al retroceder, para que se lea como una
  // secuencia y no como un salto.
  const direction = useRef(1);
  const goTo = (value: number) => {
    direction.current = value > index ? 1 : -1;
    setIndex(value);
  };

  // Barra de progreso animada: antes saltaba de golpe de un tramo al otro.
  const progress = useRef(new Animated.Value((index + 1) / quizQuestions.length)).current;
  useEffect(() => {
    Animated.timing(progress, {
      toValue: (index + 1) / quizQuestions.length,
      duration: motion.medium,
      easing: Easing.out(Easing.cubic),
      // El ancho no es una propiedad acelerable por el hilo nativo.
      useNativeDriver: false,
    }).start();
  }, [index, progress]);

  // Entrada de cada pregunta (0 → 1 en cada cambio de indice).
  const enter = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    enter.setValue(0);
    Animated.timing(enter, {
      toValue: 1,
      duration: motion.medium,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [index, enter]);

  const question = quizQuestions[index];

  if (!question) return null;
  const selected = answers[question.id];
  const isLast = index === quizQuestions.length - 1;

  const next = () => {
    if (!selected) return;
    if (isLast) {
      finishQuiz();
      router.replace('/result' as any);
      return;
    }
    goTo(index + 1);
  };

  const choose = (value: QuizArea) => answerQuiz(question.id, value);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={styles.topBar}>
        <Pressable
          onPress={() => index === 0 ? (router.canGoBack() ? router.back() : router.replace('/')) : goTo(index - 1)}
          hitSlop={12}
          accessibilityLabel={index === 0 ? 'Cerrar' : 'Pregunta anterior'}
          accessibilityRole="button"
          style={styles.navButton}
        >
          <Feather name={index === 0 ? 'x' : 'chevron-left'} size={24} color={colors.text} />
        </Pressable>
        <Text variant="secondary" weight="700" color={colors.textMuted} style={styles.progressText}>
          Pregunta {index + 1} de {quizQuestions.length}
        </Text>
        <View style={styles.navButtonPlaceholder} />
      </View>

      <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
        <Animated.View
          style={[
            styles.progressFill,
            {
              backgroundColor: colors.text,
              width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
            },
          ]}
        />
      </View>

      <AppScreen scroll edges={['top', 'left', 'right']}>
        <Animated.View
          style={[
            styles.content,
            {
              opacity: enter,
              transform: [
                {
                  translateX: enter.interpolate({
                    inputRange: [0, 1],
                    outputRange: [direction.current * 28, 0],
                  }),
                },
              ],
            },
          ]}
        >
          <Text variant="title" style={styles.question}>
            {question.question}
          </Text>

          <View style={styles.options}>
            {question.options.map((option) => {
              const active = selected === option.value;
              return (
                <Pressable
                  key={option.value}
                  onPress={() => choose(option.value)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: active }}
                  accessibilityLabel={option.label}
                  style={({ pressed }: { pressed: boolean }) => [
                    styles.option,
                    {
                      backgroundColor: active ? colors.primary : colors.backgroundAlt,
                      borderColor: active ? colors.primary : colors.border,
                      opacity: pressed ? 0.85 : 1,
                    },
                  ]}
                >
                  <Text
                    variant="body"
                    weight={active ? '700' : '400'}
                    color={active ? colors.onPrimary : colors.text}
                    style={styles.optionLabel}
                  >
                    {option.label}
                  </Text>
                  {/*
                    El hueco de la derecha estaba vacio: la seleccion solo se
                    distinguia por el fondo. El indicador la hace explicita y no
                    depende unicamente del color.
                  */}
                  <View
                    style={[
                      styles.optionMark,
                      { borderColor: active ? colors.onPrimary : colors.border },
                    ]}
                  >
                    {active ? <Feather name="check" size={14} color={colors.onPrimary} /> : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
        </Animated.View>
      </AppScreen>

      <View style={styles.footer}>
        <Button
          label={isLast ? t('quiz.seeResult') : t('quiz.next')}
          onPress={next}
          disabled={!selected}
        />
        <Text variant="secondary" color={colors.textMuted} style={styles.footerHint}>
          {selected ? t('quiz.canChange') : t('quiz.pickOne')}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: {
    height: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
  },
  navButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  navButtonPlaceholder: {
    width: 44,
  },
  progressText: {
    textAlign: 'center',
  },
  progressTrack: {
    height: 3,
    marginHorizontal: 20,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
  },
  content: {
    padding: 20,
  },
  question: {
    textAlign: 'center',
    lineHeight: 30,
    marginTop: spacing.xxl,
    marginBottom: spacing.xxl,
  },
  options: {
    gap: spacing.md,
  },
  option: {
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    minHeight: 56,
  },
  optionLabel: {
    flex: 1,
    lineHeight: 21,
  },
  optionMark: {
    width: 22,
    height: 22,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: {
    padding: 20,
    paddingBottom: 22,
  },
  footerHint: {
    textAlign: 'center',
    marginTop: spacing.md,
  },
});
