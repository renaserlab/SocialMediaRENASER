import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { TarjetaDeGrupoVista } from '@/components/chat/TarjetaDeGrupoVista';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { type TarjetaDeGrupo } from '@/lib/gruposDeChat';
import { GroupRepository } from '@/repositories/GroupRepository';
import { useAuthStore } from '@/store/useAuthStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  perfilId: string;
  /** Es el perfil de quien mira: cambia el título, no lo que se enseña. */
  esPropio: boolean;
};

/**
 * «Únete a mi grupo»: los grupos que una persona decidió enseñar en su perfil.
 *
 * SI NO HAY NINGUNO, NO SE PINTA NADA. La lista viene vacía cuando la persona
 * no enseña ningún grupo, cuando hay un bloqueo entre las dos, o cuando el
 * servidor todavía no conoce esta función. En los tres casos la sección
 * sencillamente no existe: un título sin nada debajo sería un hueco.
 *
 * En el perfil propio sale lo mismo que ven los demás, para saber qué se está
 * enseñando. Qué grupos aparecen se decide en la ficha de cada grupo.
 */
export function GruposDelPerfil({ perfilId, esPropio }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const [tarjetas, setTarjetas] = useState<TarjetaDeGrupo[]>([]);
  const [vuelta, setVuelta] = useState(0);

  useEffect(() => {
    if (!supabaseEnabled || !perfilId) {
      setTarjetas([]);
      return;
    }
    let montado = true;
    void GroupRepository.tarjetasDe(perfilId).then((lista) => {
      if (montado) setTarjetas(lista);
    });
    return () => {
      montado = false;
    };
  }, [supabaseEnabled, perfilId, vuelta]);

  const releer = useCallback(() => setVuelta((n) => n + 1), []);

  if (tarjetas.length === 0) return null;

  return (
    <View style={styles.seccion}>
      <Text weight="800" style={styles.titulo}>
        {t(esPropio ? 'groupJoin.profileTitleOwn' : 'groupJoin.profileTitle')}
      </Text>
      {esPropio ? (
        <Text color={colors.textMuted} style={styles.ayuda}>
          {t('groupJoin.profileHintOwn')}
        </Text>
      ) : null}
      {tarjetas.map((tarjeta) => (
        <TarjetaDeGrupoVista key={tarjeta.id} tarjeta={tarjeta} alCambiar={releer} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  seccion: { gap: spacing.sm, paddingHorizontal: spacing.md, marginTop: spacing.md },
  titulo: { fontSize: 16 },
  ayuda: { fontSize: 13 },
});
