import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { SalirDeCrear } from '@/components/crear/SalirDeCrear';
import { useEspacioInferior } from '@/components/espacioInferior';
import { Text } from '@/components/Text';
import { FEATURE_LIVE } from '@/config/features';
import { describeError } from '@/lib/describeError';
import { asegurarProveedorDeVideo } from '@/live/registro100ms';
import { hayProveedorDeVideo } from '@/live/salaDeVideo';
import { LiveRepository } from '@/repositories/LiveRepository';
import { palette, radius, spacing } from '@/theme/tokens';
import { useTranslation } from '@/i18n/useTranslation';

const media = palette('dark');

type Props = {
  pie?: React.ReactNode;
  /**
   * Salir de Crear. Este modo no tiene camara ni carrete que traigan su `X`, y
   * en Crear ya no esta la barra de secciones para irse por ella.
   */
  alSalir: () => void;
  /** Salida util: lo mas parecido que SI se puede hacer hoy. */
  alGrabarReel: () => void;
};

/**
 * Si se puede emitir con imagen: `null` mientras se pregunta.
 *
 * Hacen falta LAS DOS COSAS: que el servidor tenga proveedor
 * (`/live/availability`) y que este telefono tenga el SDK cargado. Una sin la
 * otra es un boton de «emitir» que abre una sala sin imagen, que es prometer
 * una cosa y entregar otra.
 */
function useDirectoDisponible(): boolean | null {
  const [disponible, setDisponible] = useState<boolean | null>(FEATURE_LIVE ? null : false);
  useEffect(() => {
    if (!FEATURE_LIVE) return;
    let vigente = true;
    // Se carga aqui, al abrir «Vivo», y no al arrancar la app: quien abre este
    // modo va a emitir, y la mayoria de las sesiones de Z no emiten nunca.
    asegurarProveedorDeVideo();
    void LiveRepository.disponibilidad().then((hayServidor) => {
      if (vigente) setDisponible(hayServidor && hayProveedorDeVideo());
    });
    return () => {
      vigente = false;
    };
  }, []);
  return disponible;
}

/**
 * Modo "Vivo" de Crear.
 *
 * SIN DIRECTOS DISPONIBLES no emite nada, y lo dice: build sin
 * `EXPO_PUBLIC_FEATURE_LIVE=on`, servidor sin 100ms configurado, o un telefono
 * que no carga el SDK (ver `config/features.ts`).
 *
 * Con ellos, se crea la emision —sin `scheduled_for`, o sea que nace ya en
 * directo— y se abre su sala.
 */
export function ModoVivo({ pie, alSalir, alGrabarReel }: Props) {
  const { t } = useTranslation();
  const espacioInferior = useEspacioInferior();
  const disponible = useDirectoDisponible();
  if (disponible === null) {
    return (
      <View style={[styles.raiz, { paddingBottom: espacioInferior }]}>
        <SalirDeCrear alSalir={alSalir} />
        <View style={styles.centro}>
          <ActivityIndicator color={media.text} />
        </View>
        {pie}
      </View>
    );
  }
  if (!disponible) {
    return (
      <View style={[styles.raiz, { paddingBottom: espacioInferior }]}>
        <SalirDeCrear alSalir={alSalir} />
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

        {pie}
      </View>
    );
  }

  return <CrearEmision pie={pie} alSalir={alSalir} />;
}

/**
 * Abrir una emision.
 *
 * Solo pide el titulo. Es lo unico obligatorio del endpoint y lo unico que se
 * puede rellenar de verdad antes de empezar: la descripcion se edita luego con
 * `PATCH`, y programarla para mas tarde es otro flujo, no un campo mas en el
 * boton de «empezar ahora».
 */
function CrearEmision({ pie, alSalir }: { pie?: React.ReactNode; alSalir: () => void }) {
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
      <SalirDeCrear alSalir={alSalir} />
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

        {/*
          SE DICE ANTES DE ABRIR LA SALA, no dentro. Con la bandera encendida y
          sin SDK de video instalado —que es como esta hoy— la emision es real
          pero solo tiene chat y reacciones. Quien pulsa «empezar» creyendo que
          va a salir en imagen y se encuentra una sala muda ya ha anunciado su
          directo: enterarse un segundo antes es la diferencia entre elegir y
          descubrir. El aviso desaparece solo el dia que se registre la sala de
          verdad (`live/salaDeVideo.ts`).
        */}
        {hayProveedorDeVideo() ? null : (
          <Text variant="caption" weight="700" color={media.textMuted} style={styles.centrado}>
            {t('live.noProvider')}
          </Text>
        )}

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

      {/*
        La barra de tipos de publicacion, sin aire de mas por debajo: tiene que
        caer a la misma altura que en la camara y en el carrete, o daria un
        salto al pasar de «Reel» a «Vivo».
      */}
      {pie}
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
});
