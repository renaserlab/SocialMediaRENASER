import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { Avatar } from '@/components/Avatar';
import { sobreMedio } from '@/components/CapaDeContraste';
import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { haptics } from '@/lib/haptics';
import { audienciaLegible } from '@/live/audiencia';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import type { Emision } from '@/repositories/LiveRepository';
import { useAppStore } from '@/store/useAppStore';
import { radius, spacing } from '@/theme/tokens';

/**
 * LA CABECERA DE UN DIRECTO: quién emite, cuánta gente mira y en qué estado está.
 *
 * Hasta el 07/10/2026 arriba iba el TÍTULO y, debajo y en pequeño, el nombre.
 * El título pasa abajo, junto al chat (`TemaDeDirecto`), y arriba queda lo que
 * identifica la sala de un vistazo: la foto y el nombre de quien emite.
 *
 * Quien MIRA tiene además, debajo del nombre, el botón de seguir —si todavía
 * no sigue a esa persona—. Quien emite no: no se sigue a uno mismo.
 *
 * LAS REGLAS NO ESTÁN AQUÍ: cuánta gente hay lo dice `useAudienciaDeDirecto`, y
 * cómo se escribe el número, `live/audiencia.ts`.
 */

/** El velo de lo que va encima de la imagen. El mismo que usa la pantalla. */
const VELO = 'rgba(0,0,0,0.45)';

type Props = {
  emision: Emision;
  /** Personas viendo ahora, o `null` si no se sabe: entonces no se pinta. */
  viendo: number | null;
  /** Hay imagen detrás: los botones llevan su velo para leerse sobre ella. */
  sobreImagen: boolean;
  alSalir: () => void;
  /** Avisa de un fallo con las palabras de la pantalla. */
  alFallar: (texto: string) => void;
  /** La insignia de estado («EN VIVO», «TERMINÓ»…), que pinta la pantalla. */
  insignia: React.ReactNode;
};

export function CabeceraDeDirecto({ emision, viendo, sobreImagen, alSalir, alFallar, insignia }: Props) {
  const { t } = useTranslation();
  const enDirecto = emision.estado === 'live';

  return (
    <View style={estilos.cabecera}>
      <Pulsable
        onPress={alSalir}
        accessibilityLabel={t('live.leave')}
        accessibilityRole="button"
        style={[estilos.botonRedondo, sobreImagen ? estilos.sobreImagen : null]}
      >
        <Feather name="arrow-left" size={22} color={sobreMedio.text} />
      </Pulsable>

      <View style={estilos.anfitrion}>
        <Avatar size={36} image={emision.anfitrionAvatarUrl} name={emision.anfitrionNombre} />
        <View style={estilos.nombres}>
          <Text variant="body" weight="800" color={sobreMedio.text} numberOfLines={1}>
            {emision.anfitrionNombre}
          </Text>
          <SeguirAlAnfitrion emision={emision} alFallar={alFallar} />
        </View>
      </View>

      {enDirecto && viendo !== null ? (
        <View
          style={estilos.audiencia}
          accessible
          accessibilityRole="text"
          accessibilityLabel={viendo === 1 ? t('live.viewersOne') : t('live.viewers', { n: viendo })}
        >
          <Feather name="eye" size={14} color={sobreMedio.text} />
          <Text variant="caption" weight="800" color={sobreMedio.text}>
            {audienciaLegible(viendo)}
          </Text>
        </View>
      ) : null}

      {insignia}
    </View>
  );
}

/**
 * «Seguir», debajo del nombre, para quien mira y todavía no sigue a quien emite.
 *
 * SI NO SE SABE, NO SE PINTA. Mientras no llega la respuesta —o si falla— no
 * hay botón: ofrecer «Seguir» a quien ya sigue es peor que no ofrecerlo, y el
 * perfil sigue estando a un toque fuera de la sala.
 *
 * Responde al dedo: se da por seguido en el momento y se deshace si el
 * servidor dice que no. Una vez seguido, el botón desaparece: ya no hay nada
 * que hacer con él, y el sitio es para el nombre.
 */
export function SeguirAlAnfitrion({
  emision,
  alFallar,
}: {
  emision: Pick<Emision, 'anfitrionId' | 'anfitrionNombre'>;
  alFallar: (texto: string) => void;
}) {
  const { t } = useTranslation();
  const requireAuth = useRequireAuth();
  const miId = useAppStore((estado) => estado.user?.id ?? null);
  const esMio = miId !== null && miId === emision.anfitrionId;

  /** `null` = todavía no se sabe. */
  const [loSigue, setLoSigue] = useState<boolean | null>(null);
  const siguiendo = useRef(false);

  useEffect(() => {
    setLoSigue(null);
    if (esMio || !emision.anfitrionId) return;
    let vigente = true;
    ProfileRepository.getById(emision.anfitrionId)
      .then((perfil) => {
        if (vigente) setLoSigue(perfil.isFollowing ?? false);
      })
      .catch(() => {
        // Sin respuesta no hay botón (ver arriba).
      });
    return () => {
      vigente = false;
    };
  }, [emision.anfitrionId, esMio, miId]);

  const seguir = useCallback(() => {
    void requireAuth('auth.reasonFollow', async () => {
      if (siguiendo.current) return;
      siguiendo.current = true;
      setLoSigue(true);
      haptics.success();
      try {
        await ProfileRepository.follow(emision.anfitrionId);
      } catch {
        setLoSigue(false);
        alFallar(t('live.followFailed'));
      } finally {
        siguiendo.current = false;
      }
    });
  }, [requireAuth, emision.anfitrionId, alFallar, t]);

  if (esMio || loSigue !== false) return null;

  return (
    <Pulsable
      onPress={seguir}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={t('live.followHost', { nombre: emision.anfitrionNombre })}
      style={estilos.seguir}
    >
      <Feather name="plus" size={12} color={sobreMedio.background} />
      <Text variant="caption" weight="800" color={sobreMedio.background}>
        {t('profile.follow')}
      </Text>
    </Pulsable>
  );
}

const estilos = StyleSheet.create({
  cabecera: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  botonRedondo: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sobreImagen: { backgroundColor: VELO },
  // `minWidth: 0` deja que el nombre se recorte con puntos suspensivos en vez
  // de empujar fuera de la pantalla el contador y la insignia.
  anfitrion: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  nombres: { flex: 1, minWidth: 0, alignItems: 'flex-start', gap: 3 },
  seguir: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    minHeight: 22,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    backgroundColor: sobreMedio.text,
  },
  audiencia: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 26,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    backgroundColor: VELO,
  },
});
