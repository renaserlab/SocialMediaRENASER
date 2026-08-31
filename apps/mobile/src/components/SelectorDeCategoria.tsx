import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Chip } from '@/components/Chip';
import { Text } from '@/components/Text';
import { categoryLabel } from '@/data/categories';
import { useCategoriasDePodcast } from '@/hooks/useCategoriasDePodcast';
import { describeError } from '@/lib/describeError';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

const MAX_NOMBRE = 40;

type Props = {
  /** De quien son las categorias: el autor del audio, no quien lo edita. */
  ownerId: string | null | undefined;
  valor: string | null;
  alCambiar: (categoria: string | null) => void;
};

/**
 * Elegir la categoria de un audio, y crearla ahi mismo si no existe.
 *
 * Crear la categoria SIN salir de la pantalla es deliberado: el momento en que
 * uno se da cuenta de que le falta «Carpinteria» es justo cuando esta subiendo
 * un audio de carpinteria. Obligar a guardar, ir al perfil, crearla y volver
 * es como se pierde a la gente por el camino.
 */
export function SelectorDeCategoria({ ownerId, valor, alCambiar }: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const { categorias, cargando, crear } = useCategoriasDePodcast(ownerId);

  const [creando, setCreando] = useState(false);
  const [nombre, setNombre] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const anadir = async () => {
    const limpio = nombre.trim();
    if (!limpio) return;
    setOcupado(true);
    setError(null);
    try {
      const creada = await crear(limpio);
      // Se deja elegida: es lo que se venia a hacer.
      alCambiar(creada.id);
      setNombre('');
      setCreando(false);
    } catch (e) {
      setError(describeError(e, t('category.createFailed')));
    } finally {
      setOcupado(false);
    }
  };

  /*
    Etiqueta antigua ('mente', 'cuerpo', 'dinero') que este audio arrastra. Se
    ensena como una opcion mas para que siga viendose y se pueda quitar; no se
    ofrece a nadie que no la tuviera ya.
  */
  const etiquetaAntigua = valor && !categorias.some((c) => c.id === valor) ? valor : null;

  return (
    <View style={styles.raiz}>
      <Text variant="secondary" color={colors.textMuted}>
        {t('category.label')}
      </Text>

      {cargando ? (
        <ActivityIndicator color={colors.text} />
      ) : (
        <View style={styles.chips}>
          {categorias.map((c) => (
            <Chip
              key={c.id}
              label={c.nombre}
              selected={valor === c.id}
              onPress={() => alCambiar(valor === c.id ? null : c.id)}
            />
          ))}

          {etiquetaAntigua ? (
            <Chip
              label={categoryLabel(etiquetaAntigua) || etiquetaAntigua}
              selected
              onPress={() => alCambiar(null)}
            />
          ) : null}

          {!creando ? (
            <Pressable
              onPress={() => setCreando(true)}
              style={[styles.nueva, { borderColor: colors.border }]}
              accessibilityRole="button"
              accessibilityLabel={t('category.create')}
            >
              <Feather name="plus" size={14} color={colors.text} />
              <Text variant="caption" weight="700" color={colors.text}>
                {t('category.new')}
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}

      {creando ? (
        <View style={[styles.campo, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <TextInput
            value={nombre}
            onChangeText={setNombre}
            placeholder={t('category.namePlaceholder')}
            placeholderTextColor={colors.textMuted}
            maxLength={MAX_NOMBRE}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={() => void anadir()}
            style={[styles.entrada, { color: colors.text }]}
            accessibilityLabel={t('category.newNameLabel')}
          />
          {ocupado ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <Pressable
              onPress={() => void anadir()}
              hitSlop={8}
              disabled={!nombre.trim()}
              accessibilityRole="button"
              accessibilityLabel={t('category.add')}
              style={styles.icono}
            >
              <Feather name="check" size={18} color={colors.text} />
            </Pressable>
          )}
          <Pressable
            onPress={() => {
              setCreando(false);
              setNombre('');
              setError(null);
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('common.cancel')}
            style={styles.icono}
          >
            <Feather name="x" size={18} color={colors.textMuted} />
          </Pressable>
        </View>
      ) : null}

      {error ? (
        <Text variant="caption" weight="700" color={colors.danger}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  raiz: { gap: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
  nueva: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    minHeight: 34,
  },
  campo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    minHeight: 46,
  },
  entrada: { flex: 1, fontSize: 15 },
  icono: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
});
