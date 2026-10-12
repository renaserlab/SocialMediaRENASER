import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { BottomSheet } from '@/components/BottomSheet';
import { IconoDeGrupos } from '@/components/chat/IconoDeGrupos';
import { TarjetaDeGrupoVista } from '@/components/chat/TarjetaDeGrupoVista';
import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { accionDeTarjeta, type TarjetaDeGrupo } from '@/lib/gruposDeChat';
import { SinCambioDeSeccion } from '@/navigation/tabSwipe';
import { GroupRepository } from '@/repositories/GroupRepository';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  perfilId: string;
  /** Es el perfil de quien mira: cambia cómo se anuncia el botón, no lo que se enseña. */
  esPropio: boolean;
};

/** Lo que puede medir un botón: un nombre largo se corta, no empuja a los demás. */
const ANCHO_MAXIMO = 220;

/**
 * Los grupos que una persona decidió enseñar en su perfil, como una fila de
 * botones pequeños debajo de la descripción: un icono y el nombre del grupo.
 *
 * UNA SOLA LÍNEA, HAYA LOS GRUPOS QUE HAYA (12/10/2026). Antes cada grupo era
 * una tarjeta con su foto, sus cifras y su botón, bajo un título y una ayuda:
 * con un grupo ya se llevaba media pantalla, y quien administra muchos tenía
 * que deslizar un buen rato para llegar a sus propias publicaciones. Ahora la
 * fila se desplaza de lado y el perfil mide lo mismo con uno que con cien.
 *
 * QUÉ PASA AL TOCAR UNO. Quien ya está dentro abre el grupo, sin paso
 * intermedio. Quien no, ve la tarjeta de siempre en una hoja —foto, cuántos
 * son, quién administra— y desde ahí pide entrar o retira su solicitud. Pedir
 * sigue sin meter a nadie en el grupo: decide quien lo administra.
 *
 * SI NO HAY NINGUNO, NO SE PINTA NADA. La lista viene vacía cuando la persona
 * no enseña ningún grupo, cuando hay un bloqueo entre las dos, o cuando el
 * servidor todavía no conoce esta función.
 *
 * Qué grupos aparecen se decide en los ajustes de cada grupo.
 */
export function GruposDelPerfil({ perfilId, esPropio }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const [tarjetas, setTarjetas] = useState<TarjetaDeGrupo[]>([]);
  const [vuelta, setVuelta] = useState(0);
  // El grupo de la hoja se recuerda aunque la hoja se cierre: así no se vacía
  // por dentro mientras baja.
  const [elegidaId, setElegidaId] = useState<string | null>(null);
  const [hojaAbierta, setHojaAbierta] = useState(false);

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
  const cerrarHoja = useCallback(() => setHojaAbierta(false), []);

  const alTocar = useCallback(
    (tarjeta: TarjetaDeGrupo) => {
      if (accionDeTarjeta(tarjeta) === 'abrir') {
        router.push({ pathname: '/chat/[id]', params: { id: tarjeta.id, name: tarjeta.titulo } });
        return;
      }
      setElegidaId(tarjeta.id);
      setHojaAbierta(true);
    },
    [router],
  );

  if (tarjetas.length === 0) return null;

  // En la hoja solo cabe quien todavía no está dentro. Si mientras estaba
  // abierta aceptaron la solicitud, la hoja se cierra sola: abrir el grupo
  // desde una hoja la dejaría encima del chat.
  const elegida = tarjetas.find((tarjeta) => tarjeta.id === elegidaId) ?? null;
  const enLaHoja = elegida && accionDeTarjeta(elegida) !== 'abrir' ? elegida : null;

  return (
    <View style={styles.seccion}>
      {/*
        Blindado frente al gesto de cambiar de sección: sin esto, arrastrar la
        fila se llevaría la pantalla entera a la pestaña de al lado.
      */}
      <SinCambioDeSeccion>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.fila}
          keyboardShouldPersistTaps="handled"
        >
          {tarjetas.map((tarjeta) => (
            <Pulsable
              key={tarjeta.id}
              onPress={() => alTocar(tarjeta)}
              hitSlop={HOLGURA}
              style={[styles.boton, { borderColor: colors.border }]}
              accessibilityRole="button"
              accessibilityLabel={t(
                accionDeTarjeta(tarjeta) === 'abrir' ? 'groupJoin.chipOpen' : 'groupJoin.chipSee',
                { grupo: tarjeta.titulo },
              )}
              // Lo que antes decía un rótulo encima de las tarjetas, ahora solo
              // a quien lo necesita oír: que así se ve desde fuera y dónde se cambia.
              accessibilityHint={esPropio ? t('groupJoin.profileHintOwn') : undefined}
            >
              <IconoDeGrupos size={16} color={colors.text} />
              <Text weight="700" numberOfLines={1} style={styles.nombre}>
                {tarjeta.titulo}
              </Text>
            </Pulsable>
          ))}
        </ScrollView>
      </SinCambioDeSeccion>

      <BottomSheet visible={hojaAbierta && enLaHoja !== null} onClose={cerrarHoja}>
        {enLaHoja ? (
          <View style={styles.hoja}>
            <Text color={colors.textMuted} style={styles.ayuda}>
              {t('groupJoin.explain')}
            </Text>
            <TarjetaDeGrupoVista tarjeta={enLaHoja} alCambiar={releer} />
          </View>
        ) : null}
      </BottomSheet>
    </View>
  );
}

// El botón mide 34 de alto, como el de las etiquetas de la bandeja; con esto
// el dedo dispone de los 44 de siempre.
const HOLGURA = { top: 5, bottom: 5 } as const;

const styles = StyleSheet.create({
  seccion: { alignSelf: 'stretch', marginTop: spacing.xs },
  // `flexGrow` y el centrado: con uno o dos grupos la fila queda centrada bajo
  // la descripción, que también lo está; cuando no caben, empieza por la
  // izquierda y se desplaza.
  fila: {
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  boton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: ANCHO_MAXIMO,
    minHeight: 34,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderRadius: radius.pill,
  },
  // `flexShrink`: es el nombre el que cede y se corta con puntos suspensivos;
  // el icono no se encoge.
  nombre: { flexShrink: 1, fontSize: 13, lineHeight: 18 },
  hoja: { gap: spacing.md },
  ayuda: { fontSize: 13, lineHeight: 18 },
});
