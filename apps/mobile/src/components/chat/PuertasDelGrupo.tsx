import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, Share, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { InlineError } from '@/components/InlineError';
import { Text } from '@/components/Text';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { confirm } from '@/lib/confirm';
import { compartirGrupo, enlaceDeGrupo } from '@/lib/enlaces';
import {
  claveDelFalloDeGrupo,
  type InfoDeConversacion,
  type SolicitudDeGrupo,
} from '@/lib/gruposDeChat';
import { toast } from '@/lib/toast';
import { GroupRepository } from '@/repositories/GroupRepository';
import { ApiError } from '@/services/api';
import { profileImageUrl } from '@/services/storage';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  info: InfoDeConversacion;
  /** Se llama tras cada cambio, para que la ficha vuelva a leer el grupo. */
  alCambiar: () => void;
};

/**
 * Lo que quien administra decide sobre CÓMO SE ENTRA a su grupo: si se enseña
 * en su perfil, el enlace, y las solicitudes que esperan respuesta. La foto
 * se cambia tocándola, en lo alto de la ficha (`FotoDelGrupo`).
 *
 * SOLO SE PINTA PARA QUIEN ADMINISTRA, y solo si el servidor conoce estas
 * funciones (`info.hayExtras`). Es comodidad: cada cambio se comprueba otra
 * vez en el servidor.
 *
 * NADIE ENTRA SOLO. Ni el perfil ni el enlace meten a nadie: dejan una
 * solicitud que se responde aquí.
 */
export function PuertasDelGrupo({ info, alCambiar }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);
  const [solicitudes, setSolicitudes] = useState<SolicitudDeGrupo[]>([]);

  const grupoId = info.id;
  const ajustes = info.ajustes;
  const pendientes = info.pendientes;
  // Una comunidad no tiene perfil ni enlace propios: se entra desde su grupo
  // (el servidor responde 409 a esos dos). Aquí solo le quedan sus solicitudes.
  const esComunidad = info.padre !== null;

  // Las solicitudes se leen al entrar y cada vez que cambia cuántas hay.
  useEffect(() => {
    let montado = true;
    GroupRepository.solicitudes(grupoId)
      .then((lista) => {
        if (montado) setSolicitudes(lista);
      })
      .catch(() => {
        // Sin la lista se queda la que hubiera; la ficha sigue sirviendo.
      });
    return () => {
      montado = false;
    };
  }, [grupoId, pendientes]);

  const hacer = useCallback(
    async (clave: string, tarea: () => Promise<unknown>): Promise<boolean> => {
      if (ocupado) return false;
      setOcupado(clave);
      setFallo(null);
      try {
        await tarea();
        alCambiar();
        return true;
      } catch (error) {
        const codigo = error instanceof ApiError ? error.code : null;
        setFallo(t(claveDelFalloDeGrupo(codigo) as TranslationKey));
        return false;
      } finally {
        setOcupado(null);
      }
    },
    [ocupado, alCambiar, t],
  );

  const compartir = useCallback(() => {
    const { message, url } = compartirGrupo({
      codigo: ajustes?.codigo,
      grupo: info.titulo,
      traducir: t,
    });
    if (!url) return;
    Share.share({ message }).catch(() => {
      // Cerrar la hoja de compartir sin elegir nada no es un fallo.
    });
  }, [ajustes?.codigo, info.titulo, t]);

  const cambiarEnlace = useCallback(async () => {
    const seguro = await confirm({
      title: t('groupJoin.rotateTitle'),
      message: t('groupJoin.rotateBody'),
      confirmLabel: t('groupJoin.rotate'),
      destructive: true,
    });
    if (!seguro) return;
    if (await hacer('enlace', () => GroupRepository.cambiarEnlace(grupoId))) {
      toast(t('groupJoin.rotated'));
    }
  }, [hacer, grupoId, t]);

  const responder = useCallback(
    async (solicitud: SolicitudDeGrupo, aceptar: boolean) => {
      const hecho = await hacer(`solicitud:${solicitud.id}`, () =>
        GroupRepository.responderSolicitud(grupoId, solicitud.id, aceptar),
      );
      if (hecho) {
        setSolicitudes((previas) => previas.filter((s) => s.id !== solicitud.id));
        if (aceptar) toast(t('groupJoin.accepted', { nombre: solicitud.persona.nombre }));
      }
    },
    [hacer, grupoId, t],
  );

  if (!info.puedoAdministrar || !info.hayExtras || !ajustes) return null;

  const enlace = ajustes.enlaceActivo ? enlaceDeGrupo(ajustes.codigo) : null;

  return (
    <View style={styles.raiz}>
      {fallo ? <InlineError message={fallo} /> : null}

      {/* ---------- Solicitudes ---------- */}
      {solicitudes.length > 0 ? (
        <View style={styles.seccion}>
          <Text weight="700">{t('groupJoin.requestsTitle', { n: solicitudes.length })}</Text>
          {solicitudes.map((solicitud) => (
            <View key={solicitud.id} style={[styles.solicitud, { borderColor: colors.border }]}>
              <View style={styles.persona}>
                <Avatar
                  size={40}
                  image={profileImageUrl(solicitud.persona.avatarPath) ?? null}
                  name={solicitud.persona.nombre}
                />
                <View style={styles.textos}>
                  <Text weight="600" numberOfLines={1}>
                    {solicitud.persona.nombre}
                  </Text>
                  <Text color={colors.textMuted} style={styles.detalle} numberOfLines={1}>
                    {t(
                      esComunidad
                        ? 'groupJoin.viaParentGroup'
                        : solicitud.origen === 'enlace'
                          ? 'groupJoin.viaLink'
                          : 'groupJoin.viaProfile',
                    )}
                  </Text>
                </View>
              </View>
              <View style={styles.botones}>
                <Button
                  label={t('groupJoin.accept')}
                  onPress={() => void responder(solicitud, true)}
                  loading={ocupado === `solicitud:${solicitud.id}`}
                  disabled={!!ocupado}
                  style={styles.boton}
                />
                <Button
                  label={t('groupJoin.reject')}
                  variant="secondary"
                  onPress={() => void responder(solicitud, false)}
                  disabled={!!ocupado}
                  style={styles.boton}
                />
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {/* ---------- Cómo se entra (una comunidad no tiene perfil ni enlace) ---------- */}
      {esComunidad ? null : (
      <View style={styles.seccion}>
        <Text weight="700">{t('groupJoin.doorsTitle')}</Text>
        <Text color={colors.textMuted} style={styles.detalle}>
          {t('groupJoin.doorsHint')}
        </Text>
        <View style={styles.envuelve}>
          <Chip
            rol="checkbox"
            selected={ajustes.enMiPerfil}
            icon={ajustes.enMiPerfil ? 'eye' : 'eye-off'}
            label={t('groupJoin.onProfile')}
            disabled={!!ocupado}
            onPress={() =>
              void hacer('perfil', () =>
                GroupRepository.cambiarAjustes(grupoId, { enMiPerfil: !ajustes.enMiPerfil }),
              )
            }
          />
          <Chip
            rol="checkbox"
            selected={ajustes.enlaceActivo}
            icon="link"
            label={t('groupJoin.linkEnabled')}
            disabled={!!ocupado}
            onPress={() =>
              void hacer('enlace', () =>
                GroupRepository.cambiarAjustes(grupoId, { enlaceActivo: !ajustes.enlaceActivo }),
              )
            }
          />
        </View>

        {ajustes.enlaceActivo ? (
          enlace ? (
            <View style={[styles.enlace, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}>
              <Text selectable numberOfLines={2} style={styles.textoDelEnlace}>
                {enlace}
              </Text>
              <View style={styles.botones}>
                <Button
                  label={t('groupJoin.shareLink')}
                  icon="share-2"
                  onPress={compartir}
                  disabled={!!ocupado}
                  style={styles.boton}
                />
                <Pressable
                  onPress={() => void cambiarEnlace()}
                  disabled={!!ocupado}
                  accessibilityRole="button"
                  accessibilityLabel={t('groupJoin.rotate')}
                  hitSlop={8}
                  style={styles.icono}
                >
                  <Feather name="refresh-cw" size={18} color={colors.text} />
                </Pressable>
              </View>
            </View>
          ) : (
            <Text color={colors.textMuted} style={styles.detalle}>
              {t('groupJoin.linkUnavailable')}
            </Text>
          )
        ) : null}
      </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  raiz: { gap: spacing.lg },
  seccion: { gap: spacing.sm },
  detalle: { fontSize: 13, lineHeight: 18 },
  solicitud: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.sm,
    gap: spacing.sm,
  },
  persona: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  textos: { flex: 1, minWidth: 0 },
  botones: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  boton: { flex: 1 },
  envuelve: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  enlace: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.sm,
    gap: spacing.sm,
  },
  textoDelEnlace: { fontSize: 13 },
  icono: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
