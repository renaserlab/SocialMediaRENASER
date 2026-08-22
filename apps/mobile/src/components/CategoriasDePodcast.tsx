import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Text } from '@/components/Text';
import { confirm } from '@/lib/confirm';
import { describeError } from '@/lib/describeError';
import { toast } from '@/lib/toast';
import { SinCambioDeSeccion } from '@/navigation/tabSwipe';
import type { CategoriaDePodcast } from '@/repositories/PodcastCategoryRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const MAX_NOMBRE = 40;

type Props = {
  categorias: CategoriaDePodcast[];
  /** `null` = «Todos», sin filtro. */
  seleccionada: string | null;
  alSeleccionar: (id: string | null) => void;
  /** `true` en el perfil propio: ademas de filtrar, se pueden gestionar. */
  puedeGestionar: boolean;
  crear: (nombre: string) => Promise<unknown>;
  renombrar: (id: string, nombre: string) => Promise<void>;
  borrar: (id: string) => Promise<void>;
};

/**
 * Fila de categorias del podcast, con su gestion.
 *
 * Sustituye a las tres etiquetas fijas que estaban escritas en el codigo
 * («Mente y Emociones», «Cuerpo», «Dinero»). Aquellas describian el podcast de
 * una persona concreta; no le sirven de nada al carpintero que quiere ordenar
 * lo suyo en «Mis experiencias», «Carpinteria» e «Historias».
 *
 * La gestion vive AQUI, junto a los filtros, y no en una pantalla de ajustes
 * aparte: se crea, se renombra y se borra en el mismo sitio donde se ven, que
 * es donde uno se da cuenta de que le falta una o de que le sobra.
 */
export function CategoriasDePodcast({
  categorias,
  seleccionada,
  alSeleccionar,
  puedeGestionar,
  crear,
  renombrar,
  borrar,
}: Props) {
  const { colors } = useAppTheme();
  const [gestionando, setGestionando] = useState(false);
  const [nombre, setNombre] = useState('');
  const [editando, setEditando] = useState<CategoriaDePodcast | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cerrar = () => {
    setGestionando(false);
    setEditando(null);
    setNombre('');
    setError(null);
  };

  const guardar = async () => {
    const limpio = nombre.trim();
    if (!limpio) {
      setError('Ponle un nombre a la categoría.');
      return;
    }
    setOcupado(true);
    setError(null);
    try {
      if (editando) {
        await renombrar(editando.id, limpio);
        toast('Categoría renombrada');
      } else {
        await crear(limpio);
        toast('Categoría creada');
      }
      setEditando(null);
      setNombre('');
    } catch (e) {
      // El backend rechaza los nombres repetidos con un motivo claro; se pinta
      // tal cual en vez de un «no se pudo» que no dice que arreglar.
      setError(describeError(e, 'No se pudo guardar la categoría.'));
    } finally {
      setOcupado(false);
    }
  };

  const eliminar = async (categoria: CategoriaDePodcast) => {
    const seguro = await confirm({
      title: `Borrar «${categoria.nombre}»`,
      message:
        categoria.episodios > 0
          ? `Sus ${categoria.episodios} audio(s) NO se borran: se quedan sin categoría y seguirán apareciendo en «Todos».`
          : 'Esta categoría está vacía.',
      confirmLabel: 'Borrar',
      destructive: true,
    });
    if (!seguro) return;
    setOcupado(true);
    try {
      await borrar(categoria.id);
      if (seleccionada === categoria.id) alSeleccionar(null);
      toast('Categoría borrada');
    } catch (e) {
      setError(describeError(e, 'No se pudo borrar la categoría.'));
    } finally {
      setOcupado(false);
    }
  };

  return (
    <View>
      {/*
        Blindado frente al gesto de cambiar de seccion: sin esto, arrastrar la
        fila de categorias se llevaria la pantalla entera (ver tabSwipe.tsx).
      */}
      <SinCambioDeSeccion>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.fila}
        >
          <Chip label="Todos" selected={seleccionada === null} onPress={() => alSeleccionar(null)} />
          {categorias.map((c) => (
            <Chip
              key={c.id}
              label={c.nombre}
              selected={seleccionada === c.id}
              onPress={() => alSeleccionar(c.id)}
            />
          ))}
          {puedeGestionar ? (
            <Pressable
              onPress={() => setGestionando(true)}
              style={[styles.gestionar, { borderColor: colors.border }]}
              accessibilityRole="button"
              accessibilityLabel="Gestionar tus categorías"
            >
              <Feather name="plus" size={14} color={colors.text} />
              <Text variant="caption" weight="700" color={colors.text}>
                {categorias.length === 0 ? 'Crear categoría' : 'Gestionar'}
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </SinCambioDeSeccion>

      <BottomSheet visible={gestionando} onClose={cerrar}>
        <Text variant="caption" weight="800" color={colors.text} style={styles.titulo}>
          TUS CATEGORÍAS
        </Text>
        <Text variant="secondary" color={colors.textMuted} style={styles.explicacion}>
          Agrupa tus audios como quieras: «Mis experiencias», «Carpintería», «Historias»…
        </Text>

        <View style={[styles.campo, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <TextInput
            value={nombre}
            onChangeText={setNombre}
            placeholder={editando ? 'Nuevo nombre' : 'Nombre de la categoría'}
            placeholderTextColor={colors.textMuted}
            maxLength={MAX_NOMBRE}
            style={[styles.entrada, { color: colors.text }]}
            accessibilityLabel="Nombre de la categoría"
            onSubmitEditing={() => void guardar()}
            returnKeyType="done"
          />
          {ocupado ? <ActivityIndicator color={colors.text} /> : null}
        </View>

        {error ? (
          <Text variant="caption" weight="700" color={colors.danger} style={styles.error}>
            {error}
          </Text>
        ) : null}

        <View style={styles.acciones}>
          <Button
            label={editando ? 'Guardar' : 'Añadir'}
            onPress={() => void guardar()}
            disabled={ocupado || !nombre.trim()}
            style={styles.accion}
          />
          {editando ? (
            <Button
              label="Cancelar"
              variant="secondary"
              onPress={() => {
                setEditando(null);
                setNombre('');
              }}
              style={styles.accion}
            />
          ) : null}
        </View>

        <View style={styles.lista}>
          {categorias.length === 0 ? (
            <Text variant="secondary" color={colors.textMuted}>
              Todavía no tienes ninguna. Los audios sin categoría aparecen en «Todos».
            </Text>
          ) : (
            categorias.map((c) => (
              <View key={c.id} style={[styles.linea, { borderColor: colors.border }]}>
                <View style={{ flex: 1 }}>
                  <Text variant="secondary" weight="700" color={colors.text}>
                    {c.nombre}
                  </Text>
                  <Text variant="caption" color={colors.textMuted}>
                    {c.episodios === 1 ? '1 audio' : `${c.episodios} audios`}
                  </Text>
                </View>
                <Pressable
                  onPress={() => {
                    setEditando(c);
                    setNombre(c.nombre);
                    setError(null);
                  }}
                  hitSlop={8}
                  style={styles.iconoAccion}
                  accessibilityRole="button"
                  accessibilityLabel={`Renombrar ${c.nombre}`}
                >
                  <Feather name="edit-2" size={16} color={colors.textMuted} />
                </Pressable>
                <Pressable
                  onPress={() => void eliminar(c)}
                  hitSlop={8}
                  style={styles.iconoAccion}
                  accessibilityRole="button"
                  accessibilityLabel={`Borrar ${c.nombre}`}
                >
                  <Feather name="trash-2" size={16} color={colors.textMuted} />
                </Pressable>
              </View>
            ))
          )}
        </View>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  fila: { flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.sm, alignItems: 'center' },
  gestionar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    minHeight: 34,
  },
  titulo: { textTransform: 'uppercase', letterSpacing: 1, marginBottom: spacing.xs },
  explicacion: { marginBottom: spacing.md },
  campo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    minHeight: 48,
  },
  entrada: { flex: 1, fontSize: 15 },
  error: { marginTop: spacing.sm },
  acciones: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  accion: { flex: 1 },
  lista: { marginTop: spacing.lg, gap: spacing.sm },
  linea: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.sm,
  },
  iconoAccion: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
});
