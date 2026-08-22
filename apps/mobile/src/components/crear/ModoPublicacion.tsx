import React, { useCallback, useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { ProgresoDePublicacion } from '@/components/crear/ProgresoDePublicacion';
import { Text } from '@/components/Text';
import { VideoPlayer } from '@/components/VideoPlayer';
import { useKeyboardOffset } from '@/hooks/useKeyboardOffset';
import { usePublicacion, PublicacionCancelada } from '@/hooks/usePublicacion';
import { toast } from '@/lib/toast';
import {
  pickAudio,
  pickImage,
  pickVideo,
  PermisoDenegadoError,
  uploadPostMedia,
  type PickedMedia,
} from '@/services/storage';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const SUGERENCIAS = ['Un aprendizaje', 'Una pregunta', 'Una victoria', 'Una reflexión'];
const MAX_TEXTO = 700;

type Props = {
  /** Selector de modo; se pinta al final del formulario. */
  pie?: React.ReactNode;
  alSalir: () => void;
  /** Hueco reservado abajo para que la barra flotante no tape el boton. */
  espacioInferior: number;
};

/**
 * Publicacion de siempre: texto, con foto, video o audio si se quiere.
 *
 * Conserva el editor que ya existia —es lo que la gente conoce y funciona— y
 * le anade lo que le faltaba: adjuntar puede fallar por permisos y ahora se
 * dice cual y como arreglarlo; publicar puede tardar, fallar y reintentarse
 * sin volver a escribirlo todo; y una segunda pulsacion mientras sube ya no
 * crea una publicacion repetida.
 */
export function ModoPublicacion({ pie, alSalir, espacioInferior }: Props) {
  const { colors } = useAppTheme();
  const keyboardOffset = useKeyboardOffset();
  const createPost = useAppStore((state) => state.createPost);
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);

  const [texto, setTexto] = useState('');
  const [sugerencia, setSugerencia] = useState(SUGERENCIAS[0]!);
  const [adjunto, setAdjunto] = useState<PickedMedia | null>(null);
  const [avisoAdjunto, setAvisoAdjunto] = useState<string | null>(null);
  const envio = usePublicacion();

  const elegir = useCallback(
    async (tipo: 'image' | 'video' | 'audio') => {
      if (!supabaseEnabled) {
        setAvisoAdjunto('Conecta Supabase para adjuntar imágenes, vídeos o audios.');
        return;
      }
      try {
        setAvisoAdjunto(null);
        const elegido =
          tipo === 'image'
            ? await pickImage()
            : tipo === 'video'
            ? await pickVideo()
            : await pickAudio();
        if (elegido) setAdjunto(elegido);
      } catch (e) {
        /*
          Un permiso denegado NO es "no se pudo abrir el selector": el mensaje
          de `PermisoDenegadoError` ya dice cual falta y donde activarlo, y
          taparlo con un texto generico deja a la persona sin saber que hacer.
        */
        setAvisoAdjunto(
          e instanceof PermisoDenegadoError
            ? e.message
            : 'No se pudo abrir el selector. Inténtalo de nuevo.',
        );
      }
    },
    [supabaseEnabled],
  );

  const publicar = useCallback(() => {
    const cuerpo = texto.trim();
    if (!cuerpo && !adjunto) return;

    void envio.ejecutar(async ({ avance, cancelado }) => {
      const subidos = adjunto && supabaseEnabled ? [await uploadPostMedia(adjunto, avance)] : [];
      if (cancelado()) throw new PublicacionCancelada();

      await createPost(cuerpo, subidos);
      setTexto('');
      setAdjunto(null);
      alSalir();
      toast('Publicado');
    });
  }, [texto, adjunto, supabaseEnabled, envio, createPost, alSalir]);

  const puedePublicar = texto.trim().length > 0 || adjunto !== null;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.select({ ios: 'padding', android: 'height' })}
      keyboardVerticalOffset={keyboardOffset}
    >
      <AppScreen contentStyle={{ paddingBottom: espacioInferior }}>
        <View style={styles.contenedor}>
          <Text variant="title" weight="900" color={colors.text} style={styles.titulo}>
            Comparte algo que pueda transformar a alguien.
          </Text>

          <View style={styles.chips}>
            {SUGERENCIAS.map((item) => (
              <Chip
                key={item}
                label={item}
                selected={sugerencia === item}
                onPress={() => setSugerencia(item)}
              />
            ))}
          </View>

          <View style={[styles.editor, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text variant="caption" weight="800" color={colors.textMuted} style={styles.sugerencia}>
              {sugerencia}
            </Text>
            <TextInput
              value={texto}
              onChangeText={setTexto}
              placeholder="Hoy comprendí que..."
              placeholderTextColor={colors.textMuted}
              multiline
              maxLength={MAX_TEXTO}
              textAlignVertical="top"
              style={[styles.entrada, { color: colors.text }]}
              accessibilityLabel="Escribe tu publicación"
            />
            <View style={styles.pieEditor}>
              <View style={styles.filaMedios}>
                <Pressable
                  onPress={() => void elegir('image')}
                  accessibilityRole="button"
                  accessibilityLabel="Adjuntar imagen"
                  hitSlop={8}
                >
                  <Feather
                    name="image"
                    size={20}
                    color={adjunto?.kind === 'image' ? colors.primary : colors.textMuted}
                  />
                </Pressable>
                <Pressable
                  onPress={() => void elegir('video')}
                  accessibilityRole="button"
                  accessibilityLabel="Adjuntar vídeo"
                  hitSlop={8}
                >
                  <Feather
                    name="video"
                    size={20}
                    color={adjunto?.kind === 'video' ? colors.primary : colors.textMuted}
                  />
                </Pressable>
                <Pressable
                  onPress={() => void elegir('audio')}
                  accessibilityRole="button"
                  accessibilityLabel="Adjuntar audio"
                  hitSlop={8}
                >
                  <Feather
                    name="mic"
                    size={20}
                    color={adjunto?.kind === 'audio' ? colors.primary : colors.textMuted}
                  />
                </Pressable>
              </View>
              <Text variant="caption" color={colors.textMuted}>
                {texto.length}/{MAX_TEXTO}
              </Text>
            </View>
          </View>

          {adjunto ? (
            <View style={styles.vistaPrevia}>
              {adjunto.kind === 'image' ? (
                <Image source={{ uri: adjunto.uri }} style={styles.previa} resizeMode="cover" />
              ) : adjunto.kind === 'video' ? (
                <VideoPlayer uri={adjunto.uri} style={styles.previa} nativeControls muted />
              ) : (
                <View
                  style={[
                    styles.previaAudio,
                    { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
                  ]}
                >
                  <Feather name="music" size={22} color={colors.text} />
                  <Text variant="secondary" weight="600" color={colors.text} numberOfLines={1}>
                    {adjunto.name ?? 'Audio seleccionado'}
                  </Text>
                </View>
              )}
              <Pressable
                onPress={() => setAdjunto(null)}
                style={styles.quitar}
                accessibilityRole="button"
                accessibilityLabel="Quitar adjunto"
                hitSlop={8}
              >
                <Feather name="x" size={16} color="#FFFFFF" />
              </Pressable>
            </View>
          ) : null}

          {avisoAdjunto ? (
            <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt, borderColor: colors.danger }]}>
              <Feather name="alert-triangle" size={18} color={colors.danger} />
              <Text variant="secondary" color={colors.danger} style={{ flex: 1 }}>
                {avisoAdjunto}
              </Text>
            </View>
          ) : null}

          <ProgresoDePublicacion
            fase={envio.fase}
            progreso={envio.progreso}
            error={envio.error}
            puedeReintentar={envio.puedeReintentar}
            alReintentar={envio.reintentar}
            alCancelar={envio.cancelar}
            sobreOscuro={false}
            colores={{
              texto: colors.text,
              suave: colors.textMuted,
              borde: colors.border,
              peligro: colors.danger,
            }}
          />

          <Button
            label="Publicar"
            onPress={publicar}
            loading={envio.ocupado}
            disabled={!puedePublicar || envio.ocupado}
          />

          {pie ? <View style={styles.selector}>{pie}</View> : null}
        </View>
      </AppScreen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  contenedor: { padding: spacing.lg },
  titulo: { marginBottom: spacing.xl },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.lg },
  editor: {
    minHeight: 240,
    borderWidth: 1,
    borderRadius: radius.xl,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  sugerencia: { textTransform: 'uppercase', letterSpacing: 1 },
  entrada: { flex: 1, fontSize: 16, lineHeight: 24, marginTop: spacing.md, minHeight: 120 },
  pieEditor: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
  },
  filaMedios: { flexDirection: 'row', gap: spacing.lg },
  vistaPrevia: { position: 'relative', marginBottom: spacing.lg },
  previa: { width: '100%', height: 200, borderRadius: radius.lg, overflow: 'hidden' },
  previaAudio: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    minHeight: 72,
  },
  quitar: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  aviso: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  selector: { marginTop: spacing.xl },
});
