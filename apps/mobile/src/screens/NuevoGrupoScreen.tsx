import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
import { Input } from '@/components/Input';
import { SelectorDePersonas } from '@/components/SelectorDePersonas';
import { Text } from '@/components/Text';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import {
  MAX_PERSONAS_POR_TANDA,
  MAX_TITULO_DE_GRUPO,
  claveDelFalloDeGrupo,
  juzgarGrupoNuevo,
  limpiarTitulo,
  type JuicioDeGrupoNuevo,
} from '@/lib/gruposDeChat';
import { GroupRepository } from '@/repositories/GroupRepository';
import { ApiError } from '@/services/api';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { PersonaEtiquetada } from '@/types';

const MOTIVO: Record<Exclude<JuicioDeGrupoNuevo, 'vale'>, TranslationKey> = {
  vacio: 'groups.needTitle',
  largo: 'groups.titleTooLong',
  sin_personas: 'groups.needPeople',
  demasiadas: 'groups.tooManyPeople',
};

/**
 * Crear un grupo: un nombre y las personas.
 *
 * A QUIÉN SE PUEDE AÑADIR lo decide el servidor. La lista de búsqueda ya viene
 * sin las personas con las que hay un bloqueo —es la misma que se usa para
 * etiquetar—, así que lo normal es que nadie llegue a ver un rechazo; si aun
 * así ocurre, el servidor no dice por qué y aquí tampoco se adivina.
 *
 * Quien crea el grupo lo administra.
 */
export function NuevoGrupoScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();

  const [titulo, setTitulo] = useState('');
  const [personas, setPersonas] = useState<PersonaEtiquetada[]>([]);
  const [creando, setCreando] = useState(false);
  const [fallo, setFallo] = useState<string | null>(null);
  /** Se intentó crear: a partir de aquí se dice lo que falta. */
  const [intentado, setIntentado] = useState(false);
  // El doble toque: el estado tarda un fotograma en llegar al botón.
  const enCurso = useRef(false);

  const juicio = juzgarGrupoNuevo(titulo, personas.length);

  const crear = useCallback(async () => {
    setIntentado(true);
    if (juicio !== 'vale' || enCurso.current) return;
    enCurso.current = true;
    setCreando(true);
    setFallo(null);
    try {
      const grupo = await GroupRepository.crear(
        limpiarTitulo(titulo),
        personas.map((persona) => persona.id),
      );
      // `replace`: al volver atrás desde el grupo se llega a la bandeja, no a
      // este formulario ya enviado.
      router.replace({ pathname: '/chat/[id]', params: { id: grupo.id, name: grupo.name } });
    } catch (error) {
      const codigo = error instanceof ApiError ? error.code : null;
      setFallo(t(claveDelFalloDeGrupo(codigo) as TranslationKey));
      enCurso.current = false;
      setCreando(false);
    }
  }, [juicio, titulo, personas, router, t]);

  return (
    <AppScreen>
      <AppHeader
        title={t('groups.newTitle')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
      <View style={styles.cuerpo}>
        <Input
          label={t('groups.titleLabel')}
          value={titulo}
          onChangeText={setTitulo}
          placeholder={t('groups.titlePlaceholder')}
          maxLength={MAX_TITULO_DE_GRUPO}
          returnKeyType="done"
        />

        <View style={styles.seccion}>
          <SelectorDePersonas
            seleccionadas={personas}
            alCambiar={setPersonas}
            maximo={MAX_PERSONAS_POR_TANDA}
            titulo={t('groups.peopleLabel')}
            ayuda={t('groups.peopleHint')}
          />
        </View>

        {intentado && juicio !== 'vale' ? <InlineError message={t(MOTIVO[juicio])} /> : null}
        {fallo ? <InlineError message={fallo} /> : null}

        <Button
          label={t('groups.create')}
          icon="users"
          onPress={() => void crear()}
          loading={creando}
          disabled={creando}
        />
        <Text color={colors.textMuted} style={styles.ayuda}>
          {t('groups.adminNote')}
        </Text>
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  cuerpo: { padding: spacing.md, gap: spacing.md },
  seccion: { gap: spacing.xs },
  ayuda: { fontSize: 13, lineHeight: 18 },
});
