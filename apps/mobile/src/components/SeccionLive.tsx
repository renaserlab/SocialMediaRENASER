import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { Avatar } from '@/components/Avatar';
import { Text } from '@/components/Text';
import { FEATURE_LIVE } from '@/config/features';
import { useTranslation } from '@/i18n/useTranslation';
import { LiveRepository, type Emision } from '@/repositories/LiveRepository';
import { palette, radius, spacing } from '@/theme/tokens';

const media = palette('dark');

type Props = {
  /** Solo pide datos cuando de verdad se esta viendo. */
  activo: boolean;
  espacioInferior: number;
  alDescubrir: () => void;
};

/**
 * Pestana "Live" del Inicio.
 *
 * Esta escrita contra `LiveRepository`, que habla con el dominio de directos
 * del backend. Antes lo estaba contra `feed/transmisiones.ts`, un contrato de
 * relleno que devolvia siempre la lista vacia porque no existia dominio
 * ninguno; ese archivo ya no hace falta y se ha borrado.
 *
 * Lo que NO cambia es la honestidad: cuando no hay emisiones se dice que no las
 * hay y se ofrece la salida util, que es ir a ver contenido. Y cuando las hay,
 * cada tarjeta avisa de si trae video o solo sala y chat, para que nadie entre
 * esperando una imagen que todavia no existe.
 */
export function SeccionLive({ activo, espacioInferior, alDescubrir }: Props) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const [emisiones, setEmisiones] = useState<Emision[] | null>(null);
  const [fallo, setFallo] = useState(false);

  const cargar = useCallback(() => {
    setFallo(false);
    return LiveRepository.listar();
  }, []);

  useEffect(() => {
    if (!activo || !FEATURE_LIVE) return;
    let vigente = true;
    cargar()
      .then((lista) => {
        if (vigente) setEmisiones(lista);
      })
      .catch(() => {
        /*
          Un fallo de red NO es «no hay transmisiones». Antes se guardaba la
          lista vacia y quedaba el mismo texto en los dos casos, de modo que un
          servidor caido se leia como una plataforma sin directos.
        */
        if (vigente) {
          setEmisiones([]);
          setFallo(true);
        }
      });
    return () => {
      vigente = false;
    };
  }, [activo, cargar]);

  const cargando = FEATURE_LIVE && emisiones === null;

  if (cargando) {
    return (
      <View style={[estilos.raiz, { paddingBottom: espacioInferior }]}>
        <ActivityIndicator color={media.text} />
      </View>
    );
  }

  if (emisiones && emisiones.length > 0) {
    return (
      <ScrollView
        style={estilos.lista}
        contentContainerStyle={[
          estilos.contenido,
          {
            // La cabecera de Inicio flota por encima: sin este hueco, la
            // primera tarjeta nace debajo de las pestanas y no se puede tocar.
            paddingTop: insets.top + 60,
            paddingBottom: espacioInferior,
          },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {emisiones.map((emision) => (
          <TarjetaDeEmision
            key={emision.id}
            emision={emision}
            alAbrir={() => router.push(`/live/${emision.id}` as never)}
          />
        ))}
      </ScrollView>
    );
  }

  return (
    <View style={[estilos.raiz, { paddingBottom: espacioInferior }]}>
      <View style={[estilos.icono, { borderColor: media.border }]}>
        <Feather name={fallo ? 'wifi-off' : 'radio'} size={28} color={media.text} />
      </View>
      <Text variant="title" weight="800" color={media.text} style={estilos.centrado}>
        {fallo ? t('live.checkFailedTitle') : t('live.emptyTitle')}
      </Text>
      <Text variant="body" color={media.textMuted} style={estilos.centrado}>
        {fallo
          ? t('live.checkFailedBody')
          : /* Sin promesas de fecha: se cuenta lo que hay, que es que nadie
               está emitiendo ahora mismo. */
            t('live.emptyBody')}
      </Text>
      <Pressable
        onPress={alDescubrir}
        style={[estilos.boton, { borderColor: media.border }]}
        accessibilityRole="button"
      >
        <Text variant="body" weight="700" color={media.text}>
          {t('live.discover')}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * Una emision en la lista.
 *
 * Dice de que estado esta y si hay video. Lo segundo importa mas de lo que
 * parece: mientras no haya proveedor, entrar es entrar a una sala con chat, y
 * es mejor saberlo desde fuera que descubrirlo dentro.
 */
function TarjetaDeEmision({ emision, alAbrir }: { emision: Emision; alAbrir: () => void }) {
  const { t } = useTranslation();
  const enDirecto = emision.estado === 'live';
  const rotulo =
    emision.estado === 'live'
      ? t('live.badgeLive')
      : emision.estado === 'scheduled'
        ? t('live.badgeScheduled')
        : emision.estado === 'ended'
          ? t('live.badgeEnded')
          : t('live.badgeCancelled');

  return (
    <Pressable
      onPress={alAbrir}
      accessibilityRole="button"
      /* Una sola clave con huecos: partida en trozos («Abrir la emisión» +
         título + «de» + nombre) no se puede recomponer en un idioma que
         ordene las palabras de otra forma. */
      accessibilityLabel={t('live.openBroadcast', {
        titulo: emision.titulo,
        anfitrion: emision.anfitrionNombre,
      })}
      style={[estilos.tarjeta, { borderColor: media.border }]}
    >
      <Avatar size={44} image={emision.anfitrionAvatarUrl} name={emision.anfitrionNombre} />
      <View style={estilos.datos}>
        <View style={estilos.filaDeRotulo}>
          <View
            style={[
              estilos.rotulo,
              enDirecto
                ? { backgroundColor: media.danger }
                : { borderColor: media.border, borderWidth: 1 },
            ]}
          >
            {enDirecto ? <View style={[estilos.punto, { backgroundColor: media.text }]} /> : null}
            <Text variant="caption" weight="900" color={enDirecto ? media.text : media.textMuted}>
              {rotulo}
            </Text>
          </View>
          {!emision.reproduccionDisponible ? (
            <Text variant="caption" color={media.textMuted}>
              {t('live.chatOnly')}
            </Text>
          ) : null}
        </View>
        <Text variant="body" weight="800" color={media.text} numberOfLines={2}>
          {emision.titulo}
        </Text>
        <Text variant="caption" color={media.textMuted} numberOfLines={1}>
          {emision.anfitrionNombre}
        </Text>
      </View>
      <Feather name="chevron-right" size={20} color={media.textMuted} />
    </Pressable>
  );
}

const estilos = StyleSheet.create({
  raiz: {
    flex: 1,
    backgroundColor: media.background,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  lista: { flex: 1, backgroundColor: media.background },
  contenido: { gap: spacing.md, padding: spacing.lg },
  icono: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  centrado: { textAlign: 'center' },
  boton: {
    marginTop: spacing.lg,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    minHeight: 44,
    justifyContent: 'center',
  },
  tarjeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  datos: { flex: 1, gap: 3 },
  filaDeRotulo: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rotulo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  punto: { width: 5, height: 5, borderRadius: 3 },
});
