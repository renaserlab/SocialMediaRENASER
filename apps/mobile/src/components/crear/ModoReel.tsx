import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { Button } from '@/components/Button';
import { ScrimDeMedio, sobreMedio } from '@/components/CapaDeContraste';
import { useEspacioInferior } from '@/components/espacioInferior';
import { ProgresoDePublicacion } from '@/components/crear/ProgresoDePublicacion';
import { PasoDeCaptura } from '@/components/crear/PasoDeCaptura';
import { SelectorDeTemas } from '@/components/SelectorDeTemas';
import { Text } from '@/components/Text';
import { VideoPlayer } from '@/components/VideoPlayer';
import { usePublicacion, PublicacionCancelada } from '@/hooks/usePublicacion';
import { toast } from '@/lib/toast';
import { type PickedMedia } from '@/services/storage';
import { subirMedioDePublicacion } from '@/services/subidaDeVideoS3EnApp';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';
import { useTranslation } from '@/i18n/useTranslation';

const media = sobreMedio;

/**
 * Tope de un reel.
 *
 * Tres minutos: es lo que ya admite el selector de video (`pickVideo`) y lo que
 * el compresor del dispositivo puede reducir a un tamano subible por datos
 * moviles sin tardar una eternidad.
 */
export const MAX_REEL_MS = 180_000;

const MAX_TEXTO = 700;

type Props = {
  pie?: React.ReactNode;
  alSalir: () => void;
  /** `false` mientras la pantalla no se esta viendo (ver `PasoDeCaptura`). */
  activo?: boolean;
};

/**
 * Crear un reel: grabar o elegir un video → verlo → describirlo → publicar.
 *
 * Un reel es una PUBLICACION con video, no una entidad nueva: sale en el muro,
 * se comenta y se guarda como cualquier otra, y ademas alimenta el feed
 * vertical de Inicio (que pide justamente las publicaciones con video). Crear
 * un segundo tipo de contenido para lo mismo habria significado un segundo
 * backend, un segundo feed y dos sitios donde arreglar cada cosa.
 */
export function ModoReel({ pie, alSalir, activo = true }: Props) {
  const { t } = useTranslation();
  const createPost = useAppStore((state) => state.createPost);
  /*
    El pie se apoya en la barra flotante, no en un numero.

    Estaba en `bottom: 44` y la capsula de secciones ocupa entre 78 y 104 px
    segun el aparato: el boton de publicar quedaba DEBAJO de ella siempre, y
    como la barra se pinta encima y se queda el toque, pulsarlo cambiaba de
    seccion. Ahora la medida sale del mismo sitio que la dibuja.
  */
  const espacioInferior = useEspacioInferior();

  const [elegido, setElegido] = useState<PickedMedia | null>(null);
  const [texto, setTexto] = useState('');
  /** De que trata: ids de la taxonomia comun. Etiquetar es opcional. */
  const [temas, setTemas] = useState<string[]>([]);
  const envio = usePublicacion();

  const publicar = useCallback(() => {
    if (!elegido) return;
    const duracion = elegido.durationMs ?? 0;

    void envio.ejecutar(async ({ avance, cancelado }) => {
      // Se comprueba antes de subir: gastar la conexion de alguien para acabar
      // rechazando el video es la peor forma de decirle que es muy largo.
      if (duracion > MAX_REEL_MS) {
        // Una sola clave con el numero dentro: partida en trozos no se puede
        // recolocar en un idioma que ordene las palabras de otra forma.
        throw new Error(t('create.reelTooLong', { minutos: MAX_REEL_MS / 60_000 }));
      }

      // A S3 si la cuenta tiene la bandera `medios_s3_subida`; si no, a
      // Supabase como siempre (ver `subidaDeVideoS3EnApp.ts`).
      const subido = await subirMedioDePublicacion(elegido, avance);
      if (cancelado()) throw new PublicacionCancelada();

      await createPost(texto.trim(), [subido], temas);
      setElegido(null);
      setTexto('');
      setTemas([]);
      alSalir();
      toast(t('create.reelPublished'));
    });
  }, [elegido, texto, temas, envio, createPost, alSalir]);

  if (!elegido) {
    return (
      <PasoDeCaptura
        soloVideo
        duracionMaximaMs={MAX_REEL_MS}
        pie={pie}
        alElegir={setElegido}
        alCerrar={alSalir}
        activo={activo}
      />
    );
  }

  return (
    <SinTecladoDelante style={styles.raiz}>
      <VideoPlayer
        uri={elegido.uri}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        nativeControls={false}
        autoPlay
        loop
        muted
      />

      <Pressable
        onPress={() => {
          envio.limpiar();
          setElegido(null);
        }}
        hitSlop={12}
        style={styles.volver}
        accessibilityRole="button"
        accessibilityLabel={t('create.chooseAnotherVideo')}
      >
        <Feather name="arrow-left" size={24} color={media.text} />
      </Pressable>

      {/*
        LA FRANJA DEL PIE SE APAGA. El editor, los temas, el aviso de subida y
        el boton van todos encima del medio, que puede ser claro.
      */}
      <ScrimDeMedio alto={420} />

      <View style={[styles.pie, { bottom: espacioInferior }]}>
        <View style={[styles.editor, { borderColor: media.glassBorder }]}>
          <TextInput
            value={texto}
            onChangeText={setTexto}
            placeholder={t('create.reelCaption')}
            placeholderTextColor={media.textMuted}
            multiline
            maxLength={MAX_TEXTO}
            textAlignVertical="top"
            style={[styles.entrada, { color: media.text }]}
            accessibilityLabel={t('create.reelDescription')}
          />
          <Text variant="caption" color={media.textMuted} style={styles.contador}>
            {texto.length}/{MAX_TEXTO}
          </Text>
        </View>

        {/*
          Debajo del editor y no encima: los temas afinan lo que ya se ha
          contado, y asi quedan al alcance del pulgar, pegados a Publicar.
        */}
        <SelectorDeTemas seleccionados={temas} alCambiar={setTemas} variante="sobreMedia" />

        <ProgresoDePublicacion
          fase={envio.fase}
          progreso={envio.progreso}
          error={envio.error}
          puedeReintentar={envio.puedeReintentar}
          alReintentar={envio.reintentar}
          alCancelar={envio.cancelar}
        />

        <Button
          label={t('create.publishReel')}
          variant="secondary"
          icon="send"
          onPress={publicar}
          loading={envio.ocupado}
          disabled={envio.ocupado}
        />
      </View>
    </SinTecladoDelante>
  );
}

const styles = StyleSheet.create({
  raiz: { flex: 1, backgroundColor: media.background },
  volver: {
    position: 'absolute',
    top: 54,
    left: spacing.lg,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    // Velo + borde: la flecha va sobre el medio y sin fondo propio se pierde
    // en cuanto la esquina es clara.
    backgroundColor: media.overlay,
    borderWidth: 1,
    borderColor: media.glassBorder,
  },
  // `bottom` lo pone el componente: depende de cuanto ocupe la barra flotante.
  pie: { position: 'absolute', left: spacing.lg, right: spacing.lg, gap: spacing.sm },
  editor: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    backgroundColor: media.overlay,
    maxHeight: 140,
  },
  entrada: { fontSize: 15, lineHeight: 21, minHeight: 44 },
  contador: { textAlign: 'right', marginTop: spacing.xs },
});
