import React, { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { useEspacioInferior } from '@/components/espacioInferior';
import { Text } from '@/components/Text';
import { FEATURE_LIVE } from '@/config/features';
import { describeError } from '@/lib/describeError';
import { LiveRepository } from '@/repositories/LiveRepository';
import { palette, radius, spacing } from '@/theme/tokens';
import { useTranslation } from '@/i18n/useTranslation';

const media = palette('dark');

type Props = {
  pie?: React.ReactNode;
  /** Salida util: lo mas parecido que SI se puede hacer hoy. */
  alGrabarReel: () => void;
};

/**
 * Modo "Vivo" de Crear.
 *
 * CON `FEATURE_LIVE` APAGADO —que es como esta hoy— no emite nada, y lo dice.
 * El backend ya tiene sala, chat y reacciones, pero sigue sin haber proveedor
 * de video: dar un boton de «emitir» que abre una sala sin imagen es prometer
 * una cosa y entregar otra. El detalle del bloqueo esta junto a `FEATURE_LIVE`
 * en `config/features.ts`.
 *
 * Con el encendido, el camino que se activa es el de abajo: se crea la emision
 * —sin `scheduled_for`, o sea que nace ya en directo— y se abre su sala.
 */
export function ModoVivo({ pie, alGrabarReel }: Props) {
  const { t } = useTranslation();
  const espacioInferior = useEspacioInferior();
  if (!FEATURE_LIVE) {
    return (
      <View style={[styles.raiz, { paddingBottom: espacioInferior }]}>
        <View style={styles.centro}>
          <View style={[styles.icono, { borderColor: media.border }]}>
            <Feather name="radio" size={26} color={media.text} />
          </View>
          <Text variant="title" weight="800" color={media.text} style={styles.centrado}>
            {t('create.liveUnavailableTitle')}
          </Text>
          <Text variant="body" color={media.textMuted} style={styles.centrado}>
            {t('create.liveUnavailableBody')}
          </Text>

          <Pressable
            onPress={alGrabarReel}
            style={[styles.boton, { backgroundColor: media.text }]}
            accessibilityRole="button"
          >
            <Text variant="body" weight="700" color={media.background}>
              {t('create.recordReel')}
            </Text>
          </Pressable>
        </View>

        {pie ? <View style={styles.pie}>{pie}</View> : null}
      </View>
    );
  }

  return <CrearEmision pie={pie} />;
}

/**
 * Abrir una emision.
 *
 * Solo pide el titulo. Es lo unico obligatorio del endpoint y lo unico que se
 * puede rellenar de verdad antes de empezar: la descripcion se edita luego con
 * `PATCH`, y programarla para mas tarde es otro flujo, no un campo mas en el
 * boton de «empezar ahora».
 */
function CrearEmision({ pie }: { pie?: React.ReactNode }) {
  const { t } = useTranslation();
  const espacioInferior = useEspacioInferior();
  const router = useRouter();
  const [titulo, setTitulo] = useState('');
  const [creando, setCreando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listo = titulo.trim().length > 0 && !creando;

  const empezar = async () => {
    const nombre = titulo.trim();
    if (!nombre || creando) return;
    setCreando(true);
    setError(null);
    try {
      // Sin `programadaParaIso` la emision nace EN DIRECTO: es justo lo que
      // significa este boton.
      const emision = await LiveRepository.crear({ titulo: nombre });
      // `replace` y no `push`: al salir de la sala no se vuelve al formulario
      // que acaba de crearla, porque volver ahi invitaria a crear otra.
      router.replace(`/live/${emision.id}` as never);
    } catch (fallo) {
      setError(describeError(fallo, t('create.liveOpenFailed')));
    } finally {
      setCreando(false);
    }
  };

  return (
    // El titulo se escribe aqui mismo: sin el patron compartido, en un telefono
    // corto el teclado se comia el campo y el boton de empezar.
    <SinTecladoDelante style={[styles.raiz, { paddingBottom: espacioInferior }]}>
      <View style={styles.centro}>
        <View style={[styles.icono, { borderColor: media.border }]}>
          <Feather name="radio" size={26} color={media.text} />
        </View>
        <Text variant="title" weight="800" color={media.text} style={styles.centrado}>
          {t('create.liveStartTitle')}
        </Text>
        <Text variant="body" color={media.textMuted} style={styles.centrado}>
          {t('create.liveStartBody')}
        </Text>

        <TextInput
          value={titulo}
          onChangeText={setTitulo}
          onSubmitEditing={() => void empezar()}
          returnKeyType="go"
          placeholder={t('create.livePlaceholder')}
          placeholderTextColor={media.textMuted}
          accessibilityLabel={t('create.liveTitleLabel')}
          style={[styles.campo, { borderColor: media.border, color: media.text }]}
        />

        {error ? (
          <Text variant="caption" weight="700" color={media.danger} style={styles.centrado}>
            {error}
          </Text>
        ) : null}

        <Pressable
          onPress={() => void empezar()}
          disabled={!listo}
          style={[styles.boton, { backgroundColor: media.text, opacity: listo ? 1 : 0.45 }]}
          accessibilityRole="button"
          accessibilityState={{ disabled: !listo }}
        >
          <Text variant="body" weight="700" color={media.background}>
            {creando ? t('create.opening') : t('create.startNow')}
          </Text>
        </Pressable>
      </View>

      {pie ? <View style={styles.pie}>{pie}</View> : null}
    </SinTecladoDelante>
  );
}

const styles = StyleSheet.create({
  raiz: { flex: 1, backgroundColor: media.background },
  centro: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  icono: {
    width: 58,
    height: 58,
    borderRadius: 29,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  centrado: { textAlign: 'center' },
  campo: {
    alignSelf: 'stretch',
    minHeight: 48,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.sm,
    fontSize: 14,
  },
  boton: {
    marginTop: spacing.lg,
    borderRadius: radius.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    minHeight: 44,
    justifyContent: 'center',
  },
  pie: { paddingBottom: spacing.xl },
});
