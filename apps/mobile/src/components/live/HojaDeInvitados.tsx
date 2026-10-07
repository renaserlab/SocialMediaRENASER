import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { BottomSheet } from '@/components/BottomSheet';
import { Input } from '@/components/Input';
import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import type { EscenarioEnPantalla } from '@/hooks/useEscenarioDeDirecto';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ocupaPlaza, plazasLibres, type EstadoDeInvitacion, type Invitado } from '@/live/escenario';
import type { ProfileSummary } from '@/mappers/profileMapper';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import { profileImageUrl } from '@/services/storage';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/** A partir de cuántas letras se busca. Con una sale media aplicación. */
const MINIMO_PARA_BUSCAR = 2;
/** Lo que se espera a que la persona deje de teclear. */
const ESPERA_AL_TECLEAR_MS = 300;
/** Cuántos resultados se enseñan: es una hoja, no un buscador. */
const RESULTADOS_A_LA_VISTA = 6;

/** Qué se dice de cada persona invitada. Quien se fue o fue retirada no sale. */
const ESTADO: Partial<Record<EstadoDeInvitacion, TranslationKey>> = {
  invited: 'live.stageStatusInvited',
  accepted: 'live.stageStatusOnScreen',
  declined: 'live.stageStatusDeclined',
};

type Props = {
  visible: boolean;
  alCerrar: () => void;
  escena: EscenarioEnPantalla;
  /** Quien emite: no se le puede invitar a su propio directo. */
  anfitrionId: string;
};

/**
 * Invitar a personas al directo, y ver a quién se ha invitado.
 *
 * QUIÉN LA VE. Solo quien gestiona la emisión, y solo si el servidor admite
 * invitados. Arriba, a quién se invitó y qué contestó; abajo, el buscador.
 *
 * NO HAY SELECCIÓN MÚLTIPLE. Cada invitación hace sonar un teléfono y pone a
 * alguien en pantalla si acepta: se manda de una en una y se ve qué pasó con
 * cada una antes de mandar la siguiente.
 */
export function HojaDeInvitados({ visible, alCerrar, escena, anfitrionId }: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const { escenario, ocupado } = escena;

  const [termino, setTermino] = useState('');
  const [resultados, setResultados] = useState<ProfileSummary[]>([]);
  const [buscando, setBuscando] = useState(false);

  // Al abrir se vuelve a preguntar: alguien pudo contestar con la hoja cerrada.
  const { recargar } = escena;
  useEffect(() => {
    if (visible) recargar();
    else setTermino('');
    // `recargar` cambia en cada render; lo que dispara esto es abrir y cerrar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    const limpio = termino.trim();
    if (limpio.length < MINIMO_PARA_BUSCAR) {
      setResultados([]);
      setBuscando(false);
      return;
    }
    let vivo = true;
    setBuscando(true);
    const temporizador = setTimeout(() => {
      ProfileRepository.search(limpio)
        .then((lista) => {
          if (vivo) setResultados(lista);
        })
        .catch(() => {
          if (vivo) setResultados([]);
        })
        .finally(() => {
          if (vivo) setBuscando(false);
        });
    }, ESPERA_AL_TECLEAR_MS);
    return () => {
      vivo = false;
      clearTimeout(temporizador);
    };
  }, [termino]);

  const libres = plazasLibres(escenario);
  const yaInvitada = (id: string) =>
    escenario.invitados.some((invitado) => invitado.usuarioId === id && ocupaPlaza(invitado.estado));
  const candidatos = resultados
    .filter((persona) => persona.id !== anfitrionId)
    .slice(0, RESULTADOS_A_LA_VISTA);

  const filaDeInvitado = (invitado: Invitado) => {
    const clave = ESTADO[invitado.estado];
    if (!clave) return null;
    const arriba = invitado.estado === 'accepted';
    const rechazo = invitado.estado === 'declined';
    return (
      <View key={invitado.usuarioId} style={[styles.fila, { borderColor: colors.border }]}>
        <Avatar size={36} image={profileImageUrl(invitado.avatarPath)} name={invitado.nombre} />
        <View style={styles.textos}>
          <Text variant="body" weight="700" numberOfLines={1}>
            {invitado.nombre || t('live.stageSomeone')}
          </Text>
          <Text variant="caption" color={colors.textMuted}>
            {t(clave)}
          </Text>
        </View>
        <BotonDeFila
          texto={
            rechazo
              ? t('live.stageInviteAgain')
              : arriba
                ? t('live.stageRemove')
                : t('live.stageWithdraw')
          }
          // Volver a invitar gasta una plaza; quitar o retirar la devuelve.
          desactivado={ocupado || (rechazo && libres <= 0)}
          peligro={arriba}
          alPulsar={() =>
            void (rechazo ? escena.invitar(invitado.usuarioId) : escena.quitar(invitado.usuarioId))
          }
        />
      </View>
    );
  };

  return (
    <BottomSheet visible={visible} onClose={alCerrar}>
      <Text variant="titleMedium" weight="800" accessibilityRole="header">
        {t('live.stageTitle')}
      </Text>
      <Text variant="secondary" color={colors.textMuted}>
        {t('live.stageBody')}
      </Text>

      {escenario.invitados.length > 0 ? (
        <View style={styles.lista}>{escenario.invitados.map(filaDeInvitado)}</View>
      ) : null}

      <Text variant="caption" weight="700" color={colors.textMuted} accessibilityLiveRegion="polite">
        {libres > 0
          ? libres === 1
            ? t('live.stageRoomOne')
            : t('live.stageRoom', { n: libres })
          : t('live.stageNoRoom')}
      </Text>

      <Input
        value={termino}
        onChangeText={setTermino}
        placeholder={t('live.stageSearch')}
        accessibilityLabel={t('live.stageSearch')}
        icono="search"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
      />

      {buscando ? (
        <View style={styles.linea}>
          <ActivityIndicator size="small" color={colors.text} />
        </View>
      ) : termino.trim().length >= MINIMO_PARA_BUSCAR && candidatos.length === 0 ? (
        <Text variant="secondary" color={colors.textMuted}>
          {t('live.stageNoResults')}
        </Text>
      ) : (
        <View style={styles.lista}>
          {candidatos.map((persona) => {
            const invitada = yaInvitada(persona.id);
            return (
              <View key={persona.id} style={[styles.fila, { borderColor: colors.border }]}>
                <Avatar size={36} image={profileImageUrl(persona.avatarPath)} name={persona.fullName} />
                <View style={styles.textos}>
                  <Text variant="body" weight="700" numberOfLines={1}>
                    {persona.fullName}
                  </Text>
                  <Text variant="caption" color={colors.textMuted} numberOfLines={1}>
                    {persona.username}
                  </Text>
                </View>
                <BotonDeFila
                  texto={invitada ? t('live.stageInvitedShort') : t('live.stageInvite')}
                  desactivado={ocupado || invitada || libres <= 0}
                  alPulsar={() => void escena.invitar(persona.id)}
                />
              </View>
            );
          })}
        </View>
      )}
    </BottomSheet>
  );
}

function BotonDeFila({
  texto,
  desactivado,
  peligro = false,
  alPulsar,
}: {
  texto: string;
  desactivado: boolean;
  peligro?: boolean;
  alPulsar: () => void;
}) {
  const { colors } = useAppTheme();
  return (
    <Pulsable
      onPress={alPulsar}
      disabled={desactivado}
      opacidad={desactivado ? 0.45 : 1}
      accessibilityRole="button"
      accessibilityState={{ disabled: desactivado }}
      style={[styles.boton, { borderColor: peligro ? colors.danger : colors.text }]}
    >
      <Text variant="caption" weight="800" color={peligro ? colors.danger : colors.text}>
        {texto}
      </Text>
    </Pulsable>
  );
}

const styles = StyleSheet.create({
  lista: { gap: spacing.sm },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 56,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  textos: { flex: 1, minWidth: 0, gap: 2 },
  linea: { alignItems: 'center', paddingVertical: spacing.md },
  boton: {
    minHeight: 36,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
