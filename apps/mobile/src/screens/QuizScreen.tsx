import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '@/components/AppScreen';
import { PrimaryButton } from '@/components/PrimaryButton';
import { quizQuestions } from '@/data/mockData';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { QuizArea } from '@/types';

export function QuizScreen() {
  const { colors } = useAppTheme();
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
      router.replace('/result');
      return;
    }
    setIndex((value) => value + 1);
  };

  const choose = (value: QuizArea) => answerQuiz(question.id, value);

  return (
    <AppScreen contentStyle={styles.container}>
      <View style={styles.topBar}>
        <Pressable onPress={() => index === 0 ? router.back() : setIndex((value) => value - 1)} hitSlop={12}>
          <Ionicons name={index === 0 ? 'close' : 'chevron-back'} size={23} color={colors.text} />
        </Pressable>
        <Text style={[styles.progressText, { color: colors.text }]}>{index + 1}/{quizQuestions.length}</Text>
        <View style={{ width: 23 }} />
      </View>
      <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
        <View style={[styles.progressFill, { backgroundColor: colors.text, width: `${((index + 1) / quizQuestions.length) * 100}%` }]} />
      </View>

      <Text style={[styles.question, { color: colors.text }]}>{question.question}</Text>
      <View style={styles.options}>
        {question.options.map((option) => {
          const active = selected === option.value;
          return (
            <Pressable
              key={option.value}
              onPress={() => choose(option.value)}
              style={({ pressed }: { pressed: boolean }) => [
                styles.option,
                {
                  backgroundColor: active ? colors.primary : colors.surface,
                  borderColor: active ? colors.primary : colors.border,
                  opacity: pressed ? 0.8 : 1,
                },
              ]}
            >
              <Text style={[styles.optionText, { color: active ? colors.onPrimary : colors.text }]}>{option.label}</Text>
              {active ? <Ionicons name="checkmark-circle" size={20} color={colors.onPrimary} /> : null}
            </Pressable>
          );
        })}
      </View>

      <View style={{ flex: 1 }} />
      <PrimaryButton label={isLast ? 'Ver mi resultado' : 'Siguiente'} onPress={next} disabled={!selected} icon="→" />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.xl, minHeight: '100%' },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  progressText: { fontSize: 13, fontWeight: '700' },
  progressTrack: { height: 3, borderRadius: radius.pill, marginTop: spacing.md, overflow: 'hidden' },
  progressFill: { height: '100%' },
  question: { fontSize: 28, lineHeight: 34, fontWeight: '800', textAlign: 'center', marginVertical: spacing.xxxl },
  options: { gap: spacing.md },
  option: { minHeight: 56, borderRadius: radius.md, borderWidth: 1, paddingHorizontal: spacing.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  optionText: { fontSize: 15, fontWeight: '600' },
});
