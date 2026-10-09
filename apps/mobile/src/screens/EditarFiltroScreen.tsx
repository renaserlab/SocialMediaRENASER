import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { InlineError } from '@/components/InlineError';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { useInfoDeConversacion } from '@/hooks/useInfoDeConversacion';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { claveDelFalloDeGrupo } from '@/lib/gruposDeChat';
import { toast } from '@/lib/toast';
import {
  BORRADOR_VACIO,
  MAX_DESCRIPCION_DE_FILTRO,
  MAX_NOMBRE_DE_FILTRO,
  MAX_PALABRAS_DE_FILTRO,
  TIPOS_DE_CONTENIDO,
  alternar,
  borradorDe,
  juzgarFiltro,
  palabrasDe,
  type BorradorDeFiltro,
  type CriteriosDeFiltro,
  type JuicioDeFiltro,
} from '@/lib/vistasDeChat';
import { GroupRepository } from '@/repositories/GroupRepository';
import { MessageRepository } from '@/repositories/MessageRepository';
import { NOMBRE_DE_TIPO } from '@/screens/FiltrosDeGrupoScreen';
import { ApiError } from '@/services/api';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const MOTIVO: Record<Exclude<JuicioDeFiltro, 'vale'>, TranslationKey> = {
  sin_nombre: 'groupFilters.needName',
  nombre_largo: 'groupFilters.nameTooLong',
  descripcion_larga: 'groupFilters.descriptionTooLong',
  sin_criterios: 'groupFilters.needCriteria',
  palabra_corta: 'groupFilters.wordTooShort',
  palabra_larga: 'groupFilters.wordTooLong',
  muchas_palabras: 'groupFilters.tooManyWords',
  muchos_autores: 'groupFilters.tooManyAuthors',
};

/** Si el servidor no manda su lista de iconos (es antiguo), con qué se elige. */
const ICONOS_DE_RESPALDO = ['filter', 'star', 'bookmark', 'flag', 'bell', 'calendar'];

function iconoSeguro(nombre: string): keyof typeof Feather.glyphMap {
  return nombre in Feather.glyphMap ? (nombre as keyof typeof Feather.glyphMap) : 'filter';
}

/**
 * Crear o editar un filtro de un grupo.
 *
 * TRES PREGUNTAS, Y UN MENSAJE TIENE QUE CUMPLIR LAS QUE SE CONTESTEN: de qué
 * tipo es, qué dice y quién lo escribió. Dejar una en blanco es «da igual».
 * No hay más a propósito: con esto se escriben «los PDF de la profesora» y
 * «lo que diga examen o parcial»; un constructor de consultas completo sería
 * más difícil de usar que el problema que resuelve.
 *
 * LO QUE AQUÍ SE AVISA ES LO QUE EL SERVIDOR RECHAZARÍA, dicho antes de
 * enviar. La validación de verdad es la suya.
 */
export function EditarFiltroScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; filtro?: string }>();
  const conversationId = typeof params.id === 'string' ? params.id : '';
  const filtroId = typeof params.filtro === 'string' && params.filtro ? params.filtro : null;
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const currentUserId = useAppStore((state) => state.user?.id ?? null);

  // Los miembros, para elegir autores.
  const { info } = useInfoDeConversacion(
    conversationId,
    currentUserId,
    supabaseEnabled && !!conversationId,
  );

  const [borrador, setBorrador] = useState<BorradorDeFiltro>(BORRADOR_VACIO);
  /** Lo que se escribe en el campo de palabras, tal cual. */
  const [palabrasEscritas, setPalabrasEscritas] = useState('');
  const [iconos, setIconos] = useState<string[]>(ICONOS_DE_RESPALDO);
  const [estado, setEstado] = useState<'cargando' | 'listo' | 'no_esta'>(
    filtroId ? 'cargando' : 'listo',
  );
  const [guardando, setGuardando] = useState(false);
  const [intentado, setIntentado] = useState(false);
  const [fallo, setFallo] = useState<string | null>(null);
  const enCurso = useRef(false);

  // Al editar, se parte de lo que el filtro tiene AHORA en el servidor.
  useEffect(() => {
    if (!conversationId) return;
    let montado = true;
    void MessageRepository.vistas(conversationId).then((vistas) => {
      if (!montado) return;
      if (vistas.iconos.length > 0) setIconos(vistas.iconos);
      if (!filtroId) return;
      const filtro = vistas.filtros.find((f) => f.id === filtroId);
      if (!filtro) {
        setEstado('no_esta');
        return;
      }
      setBorrador(borradorDe(filtro));
      setPalabrasEscritas(filtro.criterios.palabras.join(', '));
      setEstado('listo');
    });
    return () => {
      montado = false;
    };
  }, [conversationId, filtroId]);

  const cambiarCriterios = useCallback((cambio: Partial<CriteriosDeFiltro>) => {
    setBorrador((previo) => ({ ...previo, criterios: { ...previo.criterios, ...cambio } }));
  }, []);

  const alEscribirPalabras = useCallback(
    (texto: string) => {
      setPalabrasEscritas(texto);
      cambiarCriterios({ palabras: palabrasDe(texto) });
    },
    [cambiarCriterios],
  );

  const juicio = juzgarFiltro(borrador);

  const guardar = useCallback(async () => {
    setIntentado(true);
    if (juicio !== 'vale' || enCurso.current) return;
    enCurso.current = true;
    setGuardando(true);
    setFallo(null);
    try {
      if (filtroId) await GroupRepository.cambiarFiltro(conversationId, filtroId, borrador);
      else await GroupRepository.crearFiltro(conversationId, borrador);
      toast(t(filtroId ? 'groupFilters.saved' : 'groupFilters.created'));
      if (router.canGoBack()) router.back();
      else router.replace('/');
    } catch (error) {
      const codigo = error instanceof ApiError ? error.code : null;
      setFallo(t(claveDelFalloDeGrupo(codigo) as TranslationKey));
      enCurso.current = false;
      setGuardando(false);
    }
  }, [juicio, filtroId, conversationId, borrador, router, t]);

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const titulo = t(filtroId ? 'groupFilters.editTitle' : 'groupFilters.newTitle');

  if (estado === 'cargando') {
    return (
      <AppScreen scroll={false}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }
  if (estado === 'no_esta') {
    return (
      <AppScreen scroll={false}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView state="empty" title={t('groupFilters.errorGone')} />
      </AppScreen>
    );
  }

  const { tipos, palabras, modo, autores } = borrador.criterios;
  const miembros = info?.miembros ?? [];

  return (
    <AppScreen>
      <AppHeader title={titulo} onBack={volver} />
      <View style={styles.cuerpo}>
        <Input
          label={t('groupFilters.nameLabel')}
          value={borrador.nombre}
          onChangeText={(nombre) => setBorrador((previo) => ({ ...previo, nombre }))}
          placeholder={t('groupFilters.namePlaceholder')}
          maxLength={MAX_NOMBRE_DE_FILTRO}
        />
        <Input
          label={t('groupFilters.descriptionLabel')}
          value={borrador.descripcion}
          onChangeText={(descripcion) => setBorrador((previo) => ({ ...previo, descripcion }))}
          placeholder={t('groupFilters.descriptionPlaceholder')}
          maxLength={MAX_DESCRIPCION_DE_FILTRO}
          multiline
        />

        <View style={styles.seccion}>
          <Text weight="700">{t('groupFilters.iconLabel')}</Text>
          <View style={styles.envuelve}>
            {iconos.map((icono) => {
              const elegido = borrador.icono === icono;
              return (
                <Pressable
                  key={icono}
                  onPress={() => setBorrador((previo) => ({ ...previo, icono }))}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: elegido }}
                  accessibilityLabel={icono}
                  style={[
                    styles.icono,
                    {
                      borderColor: elegido ? colors.primary : colors.border,
                      backgroundColor: elegido ? colors.primary : 'transparent',
                    },
                  ]}
                >
                  <Feather
                    name={iconoSeguro(icono)}
                    size={18}
                    color={elegido ? colors.onPrimary : colors.text}
                  />
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={[styles.bloque, { borderColor: colors.border }]}>
          <Text weight="800">{t('groupFilters.criteriaTitle')}</Text>
          <Text color={colors.textMuted} style={styles.ayuda}>
            {t('groupFilters.criteriaHint')}
          </Text>

          <View style={styles.seccion}>
            <Text weight="700">{t('groupFilters.typesLabel')}</Text>
            <View style={styles.envuelve}>
              {TIPOS_DE_CONTENIDO.map((tipo) => (
                <Chip
                  key={tipo}
                  rol="checkbox"
                  selected={tipos.includes(tipo)}
                  label={t(NOMBRE_DE_TIPO[tipo])}
                  onPress={() => cambiarCriterios({ tipos: alternar(tipos, tipo) })}
                />
              ))}
            </View>
          </View>

          <View style={styles.seccion}>
            <Input
              label={t('groupFilters.wordsLabel')}
              value={palabrasEscritas}
              onChangeText={alEscribirPalabras}
              placeholder={t('groupFilters.wordsPlaceholder')}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text color={colors.textMuted} style={styles.ayuda}>
              {t('groupFilters.wordsHint', { n: MAX_PALABRAS_DE_FILTRO })}
            </Text>
            {palabras.length > 1 ? (
              <View style={styles.envuelve}>
                <Chip
                  rol="radio"
                  selected={modo === 'any'}
                  label={t('groupFilters.modeAny')}
                  onPress={() => cambiarCriterios({ modo: 'any' })}
                />
                <Chip
                  rol="radio"
                  selected={modo === 'all'}
                  label={t('groupFilters.modeAll')}
                  onPress={() => cambiarCriterios({ modo: 'all' })}
                />
              </View>
            ) : null}
          </View>

          {miembros.length > 0 ? (
            <View style={styles.seccion}>
              <Text weight="700">{t('groupFilters.authorsLabel')}</Text>
              <Text color={colors.textMuted} style={styles.ayuda}>
                {t('groupFilters.authorsHint')}
              </Text>
              <View style={styles.envuelve}>
                {miembros.map((miembro) => (
                  <Chip
                    key={miembro.id}
                    rol="checkbox"
                    selected={autores.includes(miembro.id)}
                    label={miembro.nombre || t('groups.someone')}
                    onPress={() => cambiarCriterios({ autores: alternar(autores, miembro.id) })}
                  />
                ))}
              </View>
            </View>
          ) : null}
        </View>

        <View style={styles.seccion}>
          <Chip
            rol="checkbox"
            selected={borrador.activo}
            icon={borrador.activo ? 'eye' : 'eye-off'}
            label={borrador.activo ? t('groupFilters.visibleOn') : t('groupFilters.visibleOff')}
            onPress={() => setBorrador((previo) => ({ ...previo, activo: !previo.activo }))}
          />
        </View>

        {intentado && juicio !== 'vale' ? <InlineError message={t(MOTIVO[juicio])} /> : null}
        {fallo ? <InlineError message={fallo} /> : null}

        <Button
          label={t(filtroId ? 'groupFilters.save' : 'groupFilters.create')}
          onPress={() => void guardar()}
          loading={guardando}
          disabled={guardando}
        />
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  cuerpo: { padding: spacing.md, gap: spacing.md },
  seccion: { gap: spacing.xs },
  bloque: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.md,
  },
  ayuda: { fontSize: 13, lineHeight: 18 },
  envuelve: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  icono: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
