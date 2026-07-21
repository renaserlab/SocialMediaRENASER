import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { quizQuestions } from '@/data/mockData';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { QuizArea } from '@/types';

export function QuizScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const answers = useAppStore((state) => state.quizAnswers);
  const answerQuiz = useAppStore((state) => state.answerQuiz);
  const finishQuiz = useAppStore((state) => state.finishQuiz);
  const [index, setIndex] = useState(0);
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
    setIndex((value) => value + 1);
  };

  const choose = (value: QuizArea) => answerQuiz(question.id, value);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={styles.topBar}>
        <Pressable
          onPress={() => index === 0 ? (router.canGoBack() ? router.back() : router.replace('/')) : setIndex((value) => value - 1)}
          hitSlop={12}
          accessibilityLabel={index === 0 ? 'Cerrar' : 'Pregunta anterior'}
          accessibilityRole="button"
          style={styles.navButton}
        >
          <Feather name={index === 0 ? 'x' : 'chevron-left'} size={24} color={colors.text} />
        </Pressable>
        <Text variant="secondary" weight="700" style={styles.progressText}>{index + 1} / {quizQuestions.length}</Text>
        <View style={styles.navButtonPlaceholder} />
      </View>

      <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
        <View style={[styles.progressFill, { backgroundColor: colors.text, width: `${((index + 1) / quizQuestions.length) * 100}%` }]} />
      </View>

      <AppScreen scroll edges={['top', 'left', 'right']}>
        <View style={styles.content}>
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
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </AppScreen>

      <View style={styles.footer}>
        <Button
          label={isLast ? 'Ver mi resultado' : 'Siguiente'}
          onPress={next}
          disabled={!selected}
        />
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
    lineHeight: 28,
    marginVertical: spacing.xl,
  },
  options: {
    gap: spacing.md,
  },
  option: {
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 52,
  },
  footer: {
    padding: 20,
    paddingBottom: 22,
  },
});
