import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
import { Text } from '@/components/Text';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import {
  accionDeTarjeta,
  claveDelFalloDeGrupo,
  detalleDeTarjeta,
  type TarjetaDeGrupo,
} from '@/lib/gruposDeChat';
import { GroupRepository } from '@/repositories/GroupRepository';
import { ApiError } from '@/services/api';
import { profileImageUrl } from '@/services/storage';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  tarjeta: TarjetaDeGrupo;
  /** El código del enlace, cuando se llegó por él. Sin él, se pide por el perfil. */
  codigo?: string | null;
  /** Se llama tras entrar, pedir entrar o retirar la solicitud, para volver a leer. */
  alCambiar: () => void;
  /**
   * Tras entrar con «Unirme»: abre el grupo, como se abre siendo miembro. Quien
   * la pinta dentro de una hoja lo pasa para cerrarla antes (en iOS nada se
   * abre encima de un Modal); sin él, se abre el chat desde aquí.
   */
  alEntrar?: (tarjeta: TarjetaDeGrupo) => void;
};

/**
 * La tarjeta de un grupo (en pantalla, una comunidad) para quien todavía no
 * está dentro: cómo se entra, qué hay dentro, cuántos son y quién lo
 * administra, con lo que puede hacer.
 *
 * ABIERTO: «Unirme» mete en el acto y abre el grupo. CON SOLICITUD: pedir no
 * es entrar. El botón deja una solicitud y la tarjeta pasa a decir «Solicitud
 * enviada»; quien administra el grupo decide. Por eso ahí el texto del botón
 * es «Pedir unirme» y no «Unirme».
 */
export function TarjetaDeGrupoVista({ tarjeta, codigo, alCambiar, alEntrar }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const [ocupado, setOcupado] = useState(false);
  const [fallo, setFallo] = useState<string | null>(null);
  // El doble toque: el estado tarda un fotograma en llegar al botón.
  const enCurso = useRef(false);

  const hacer = useCallback(
    async (tarea: () => Promise<void>) => {
      if (enCurso.current) return;
      enCurso.current = true;
      setOcupado(true);
      setFallo(null);
      try {
        await tarea();
        alCambiar();
      } catch (error) {
        const codigoDeError = error instanceof ApiError ? error.code : null;
        setFallo(t(claveDelFalloDeGrupo(codigoDeError) as TranslationKey));
        // Lo cerraron mientras se miraba: se vuelve a leer y el botón pasa a
        // «Pedir unirme» solo, junto al texto que explica por qué.
        if (codigoDeError === 'group_requires_request') alCambiar();
      } finally {
        enCurso.current = false;
        setOcupado(false);
      }
    },
    [alCambiar, t],
  );

  const abrir = useCallback(
    (cual: TarjetaDeGrupo) =>
      router.push({ pathname: '/chat/[id]', params: { id: cual.id, name: cual.titulo } }),
    [router],
  );

  const accion = accionDeTarjeta(tarjeta);
  const detalle = detalleDeTarjeta(tarjeta)
    .map(({ clave, n }) => t(clave as TranslationKey, n === undefined ? undefined : { n }))
    .join(' · ');

  return (
    <View style={[styles.tarjeta, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <View style={styles.fila}>
        <Avatar
          size={48}
          image={profileImageUrl(tarjeta.avatarPath) ?? null}
          name={tarjeta.titulo}
        />
        <View style={styles.textos}>
          <Text weight="700" numberOfLines={1}>
            {tarjeta.titulo}
          </Text>
          <Text color={colors.textMuted} style={styles.detalle} numberOfLines={1}>
            {detalle}
          </Text>
          <Text color={colors.textMuted} style={styles.detalle} numberOfLines={1}>
            {t('groups.membersCount', { n: tarjeta.miembros })}
            {tarjeta.administrador.nombre
              ? ` · ${t('groupJoin.managedBy', { nombre: tarjeta.administrador.nombre })}`
              : ''}
          </Text>
        </View>
      </View>

      {fallo ? <InlineError message={fallo} /> : null}

      {accion === 'abrir' ? (
        <Button
          label={t('groupJoin.open')}
          variant="secondary"
          icon="message-circle"
          onPress={() => abrir(tarjeta)}
        />
      ) : accion === 'esperando' ? (
        <>
          <Text color={colors.textMuted} style={styles.detalle}>
            {t('groupJoin.pending')}
          </Text>
          <Button
            label={t('groupJoin.withdraw')}
            variant="secondary"
            onPress={() => void hacer(() => GroupRepository.retirarSolicitud(tarjeta.id))}
            loading={ocupado}
            disabled={ocupado}
          />
        </>
      ) : accion === 'lleno' ? (
        <Text color={colors.textMuted} style={styles.detalle}>
          {t('groups.errorFull')}
        </Text>
      ) : accion === 'unirme' ? (
        <Button
          label={t('groupJoin.join')}
          icon="log-in"
          onPress={() =>
            void hacer(async () => {
              // Un 200 es estar dentro (también si ya se estaba): se abre.
              const dentro = (await GroupRepository.entrar(tarjeta.id, codigo)) ?? tarjeta;
              (alEntrar ?? abrir)(dentro);
            })
          }
          loading={ocupado}
          disabled={ocupado}
        />
      ) : (
        <Button
          label={t('groupJoin.ask')}
          icon="user-plus"
          onPress={() => void hacer(() => GroupRepository.pedirEntrar(tarjeta.id, codigo))}
          loading={ocupado}
          disabled={ocupado}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tarjeta: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  fila: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  textos: { flex: 1, minWidth: 0 },
  detalle: { fontSize: 13 },
});
