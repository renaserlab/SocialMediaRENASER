import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { Avatar } from '@/components/Avatar';
import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { SectionTitle } from '@/components/SectionTitle';
import { Skeleton } from '@/components/Skeleton';
import { Text } from '@/components/Text';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { haptics } from '@/lib/haptics';
import { frasePrincipal, frasesDeMotivos } from '@/lib/motivoDeRecomendacion';
import { SinCambioDeSeccion } from '@/navigation/tabSwipe';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import {
  RecommendationRepository,
  type PeopleRecommendations,
  type RecommendedPerson,
} from '@/repositories/RecommendationRepository';
import { profileImageUrl } from '@/services/storage';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * «Personas para ti»: el corazon de Z, hecho pantalla.
 *
 * DONDE VIVE Y POR QUE. Va dentro de Explorar y no en una pantalla nueva.
 * Explorar es donde ya se viene a buscar gente —tiene el buscador de
 * personas— y anadir una ruta mas habria significado un sitio mas al que
 * llegar, cuando lo que hace falta es que esto aparezca donde ya se mira.
 *
 * QUE SE ENSENA Y QUE NO. Cada tarjeta dice POR QUE aparece esa persona, en
 * castellano. Lo que no se ensena nunca es el numero: «0.87» no significa nada
 * para quien lo lee y aparenta una precision que no existe.
 *
 * SI NO HAY NADIE, NO SE RELLENA. Con una sola persona valida se ensena una.
 * Inventar perfiles para que la fila se vea llena seria mentir sobre quien hay
 * al otro lado.
 */

/** Cuantas caben sin convertir la seccion en una pantalla entera. */
const CUANTAS = 8;

export function PersonasParaTi() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const signedIn = useAuthStore((state) => state.status === 'authenticated');
  const requireAuth = useRequireAuth();

  const [datos, setDatos] = useState<PeopleRecommendations | null>(null);
  const [estado, setEstado] = useState<'cargando' | 'error' | 'listo'>('cargando');
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [detalle, setDetalle] = useState<RecommendedPerson | null>(null);

  const cargar = useCallback(() => {
    if (!supabaseEnabled || !signedIn) {
      setEstado('listo');
      setDatos(null);
      return;
    }
    setEstado('cargando');
    RecommendationRepository.listPeople({ limit: CUANTAS })
      .then((respuesta) => {
        setDatos(respuesta);
        setEstado('listo');
      })
      .catch((error) => {
        // Que falle esto NO puede vaciar Explorar: la seccion se retira sola y
        // el resto de la pantalla sigue como si nada.
        console.warn('[personas] no se pudieron cargar las recomendaciones', error);
        setEstado('error');
      });
  }, [supabaseEnabled, signedIn]);

  useEffect(cargar, [cargar]);

  const seguir = async (persona: RecommendedPerson) => {
    let autorizado = false;
    await requireAuth('para seguir a esta persona', () => {
      autorizado = true;
    });
    if (!autorizado) return;

    setOcupado(persona.id);
    const seguiaAntes = persona.isFollowing;
    // Optimista: el boton responde sin esperar a la red.
    setDatos((previo) =>
      previo
        ? {
            ...previo,
            items: previo.items.map((p) =>
              p.id === persona.id ? { ...p, isFollowing: !seguiaAntes } : p,
            ),
          }
        : previo,
    );
    try {
      if (seguiaAntes) await ProfileRepository.unfollow(persona.id);
      else await ProfileRepository.follow(persona.id);
      haptics.light();
    } catch (error) {
      console.warn('[personas] no se pudo cambiar el seguimiento', error);
      setDatos((previo) =>
        previo
          ? {
              ...previo,
              items: previo.items.map((p) =>
                p.id === persona.id ? { ...p, isFollowing: seguiaAntes } : p,
              ),
            }
          : previo,
      );
    } finally {
      setOcupado(null);
    }
  };

  const verPerfil = (persona: RecommendedPerson) => {
    // Abrir un perfil es una senal: dice mas que una impresion y menos que un
    // seguimiento. Se manda y se olvida; si falla, no pasa nada.
    void RecommendationRepository.sendEvents([
      { eventType: 'profile_view', entityType: 'profile', entityId: persona.id },
    ]);
    router.push(`/profile/${persona.id}` as never);
  };

  const noInteresa = async (persona: RecommendedPerson) => {
    setDetalle(null);
    await RecommendationRepository.sendEvents([
      { eventType: 'not_interested', entityType: 'profile', entityId: persona.id },
    ]);
    setDatos((previo) =>
      previo ? { ...previo, items: previo.items.filter((p) => p.id !== persona.id) } : previo,
    );
  };

  // Sin sesion, o con la personalizacion apagada en el servidor, la seccion no
  // existe. No se pinta un hueco vacio ni un mensaje de error.
  if (!supabaseEnabled || !signedIn) return null;
  if (estado === 'error') return null;
  if (estado === 'listo' && (!datos || datos.items.length === 0)) return null;
  if (datos?.strategy === 'disabled') return null;

  return (
    <View>
      <SectionTitle title="Personas para ti" />
      {/*
        Se dice de donde sale la lista cuando todavia no hay con que
        personalizarla. Presentar un respaldo como si fuera una coincidencia
        seria mentir sobre lo que Z sabe de esta persona.
      */}
      {datos?.strategy === 'cold_start' ? (
        <Text variant="secondary" color={colors.textMuted} style={styles.nota}>
          Cuéntanos qué buscas en Ajustes → Tus intereses y afinaremos esto.
        </Text>
      ) : null}

      {/*
        El carrusel es horizontal DENTRO de una pestana, y el carrusel de
        secciones escucha el arrastre horizontal desde arriba. Sin blindarlo,
        deslizar para ver la siguiente tarjeta se llevaria por delante la
        pantalla entera y saltaria a otra seccion.
      */}
      <SinCambioDeSeccion>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.fila}
      >
        {estado === 'cargando'
          ? [0, 1, 2].map((i) => (
              <View
                key={i}
                style={[styles.tarjeta, { borderColor: colors.border, backgroundColor: colors.surface }]}
              >
                <Skeleton width={64} height={64} circle />
                <Skeleton width={110} height={14} />
                <Skeleton width={140} height={12} />
              </View>
            ))
          : (datos?.items ?? []).map((persona) => {
              const motivo = frasePrincipal(persona.reasons);
              return (
                <View
                  key={persona.id}
                  style={[
                    styles.tarjeta,
                    { borderColor: colors.border, backgroundColor: colors.surface },
                  ]}
                >
                  <Pressable
                    onPress={() => verPerfil(persona)}
                    accessibilityRole="button"
                    accessibilityLabel={`Ver perfil de ${persona.fullName}`}
                  >
                    <Avatar
                      size={64}
                      image={profileImageUrl(persona.avatarPath) ?? null}
                      name={persona.fullName}
                    />
                  </Pressable>

                  <Text variant="body" weight="700" numberOfLines={1} style={styles.nombre}>
                    {persona.fullName}
                  </Text>

                  {motivo ? (
                    <Text
                      variant="secondary"
                      color={colors.textMuted}
                      numberOfLines={2}
                      style={styles.motivo}
                    >
                      {motivo}
                    </Text>
                  ) : null}

                  <Button
                    label={persona.isFollowing ? 'Siguiendo' : 'Seguir'}
                    variant={persona.isFollowing ? 'secondary' : 'primary'}
                    loading={ocupado === persona.id}
                    onPress={() => void seguir(persona)}
                    style={styles.accion}
                  />

                  <Pressable
                    onPress={() => setDetalle(persona)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={`Por qué aparece ${persona.fullName}`}
                    style={styles.porQue}
                  >
                    <Feather name="info" size={12} color={colors.textMuted} />
                    <Text variant="secondary" color={colors.textMuted}>
                      Por qué aparece
                    </Text>
                  </Pressable>
                </View>
              );
            })}
      </ScrollView>
      </SinCambioDeSeccion>

      {/*
        «Por que aparece» completo. Que alguien pueda auditar la recomendacion
        es parte del producto, no un extra: un orden que no se puede explicar
        no se puede corregir, y quien lo recibe no tiene forma de saber si le
        conviene.
      */}
      <BottomSheet visible={detalle !== null} onClose={() => setDetalle(null)}>
        {detalle ? (
          <View style={styles.hoja}>
            <Text variant="title" weight="900">
              Por qué te recomendamos a {detalle.fullName.split(' ')[0]}
            </Text>
            <View style={styles.motivos}>
              {frasesDeMotivos(detalle.reasons).map((frase) => (
                <View key={frase} style={styles.motivoFila}>
                  <Feather name="check" size={16} color={colors.text} />
                  <Text variant="body" style={styles.motivoTexto}>
                    {frase}
                  </Text>
                </View>
              ))}
            </View>
            <Button
              label="Ver perfil"
              onPress={() => {
                const persona = detalle;
                setDetalle(null);
                verPerfil(persona);
              }}
            />
            <Button
              label="No me interesa"
              variant="ghost"
              onPress={() => void noInteresa(detalle)}
            />
          </View>
        ) : null}
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  nota: { paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  fila: { gap: spacing.md, paddingBottom: spacing.xl, paddingHorizontal: spacing.lg },
  tarjeta: {
    width: 172,
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  nombre: { textAlign: 'center' },
  motivo: { textAlign: 'center', minHeight: 32 },
  accion: { alignSelf: 'stretch' },
  porQue: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 32 },
  hoja: { gap: spacing.lg, paddingBottom: spacing.md },
  motivos: { gap: spacing.md },
  motivoFila: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  motivoTexto: { flex: 1 },
});
