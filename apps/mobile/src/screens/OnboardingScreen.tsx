import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppScreen } from '@/components/AppScreen';
import { AppHeader } from '@/components/AppHeader';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { InlineError } from '@/components/InlineError';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { haptics } from '@/lib/haptics';
import { postAuthRoute } from '@/lib/postAuthRoute';
import { toast } from '@/lib/toast';
import {
  RecommendationRepository,
  type OnboardingCatalog,
  type OptionDto,
  type TopicDto,
} from '@/repositories/RecommendationRepository';
import { usePreferenciasStore } from '@/store/usePreferenciasStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * El cuestionario con el que Z entiende que necesita cada persona.
 *
 * QUE SUSTITUYE. Aqui habia tres diapositivas de bienvenida y ocho «intereses»
 * escritos a mano en este mismo fichero. Lo que la persona marcaba se guardaba
 * en el telefono y en ningun sitio mas: cambiar de dispositivo lo borraba, el
 * servidor no llegaba a enterarse nunca y no alimentaba absolutamente nada.
 *
 * Ahora las preguntas construyen un PERFIL DE RECOMENDACION que vive en el
 * servidor. Los temas y las opciones tampoco estan escritos aqui: los sirve el
 * backend, asi que anadir «Panaderia» es una fila en la base de datos y no una
 * version de la aplicacion esperando aprobacion en dos tiendas.
 *
 * DOS MINUTOS COMO MUCHO. Cinco pantallas, superficies grandes, retroceso que
 * no pierde nada, y saltar disponible desde la primera. Solo la pregunta de los
 * temas es obligatoria: sin al menos un tema no hay nada que recomendar, y
 * fingir lo contrario seria peor que preguntarlo.
 */

/** Cuantos temas se pueden marcar. Con mas de siete, ninguno significa nada. */
const MAX_TEMAS = 7;
const MIN_TEMAS = 1;

type Paso = {
  clave: string;
  titulo: TranslationKey;
  /** La clave de la ayuda; `temas` la compone con los topes. */
  ayuda: TranslationKey;
  /** false = se puede continuar sin responder. */
  obligatorio: boolean;
};

// Titulo y ayuda se guardan como CLAVE: el texto se resuelve al pintar, que
// es cuando se sabe en que idioma esta la aplicacion.
const PASOS: Paso[] = [
  {
    clave: 'objetivos',
    titulo: 'onboarding.goalsTitle',
    ayuda: 'onboarding.chooseSeveral',
    obligatorio: false,
  },
  {
    clave: 'temas',
    titulo: 'onboarding.topicsTitle',
    ayuda: 'onboarding.topicsHelp',
    obligatorio: true,
  },
  {
    clave: 'conexion',
    titulo: 'onboarding.connectionTitle',
    ayuda: 'onboarding.connectionHelp',
    obligatorio: false,
  },
  {
    clave: 'formatos',
    titulo: 'onboarding.formatsTitle',
    ayuda: 'onboarding.chooseSeveral',
    obligatorio: false,
  },
  {
    clave: 'oferta',
    titulo: 'onboarding.offerTitle',
    ayuda: 'onboarding.offerHelp',
    obligatorio: false,
  },
];

export function OnboardingScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { modo } = useLocalSearchParams<{ modo?: string }>();
  const editando = modo === 'editar';
  const marcarVisto = usePreferenciasStore((state) => state.marcarVisto);

  const [catalogo, setCatalogo] = useState<OnboardingCatalog | null>(null);
  const [carga, setCarga] = useState<'cargando' | 'error' | 'listo'>('cargando');
  const [paso, setPaso] = useState(0);
  const [guardando, setGuardando] = useState(false);
  const [errorAlGuardar, setErrorAlGuardar] = useState<string | null>(null);

  /*
    Las respuestas viven en UN estado, no una por pantalla. Es lo que hace que
    retroceder no pierda nada: cambiar de paso solo cambia un numero.
  */
  const [objetivos, setObjetivos] = useState<string[]>([]);
  const [temas, setTemas] = useState<string[]>([]);
  const [conexiones, setConexiones] = useState<string[]>([]);
  const [formatos, setFormatos] = useState<string[]>([]);
  const [modosDeOferta, setModosDeOferta] = useState<string[]>([]);
  const [temasQueOfrezco, setTemasQueOfrezco] = useState<string[]>([]);

  const cargar = useCallback(() => {
    setCarga('cargando');
    Promise.all([
      RecommendationRepository.getCatalog(),
      // Al editar se parte de lo ya guardado; en el primer acceso no hay nada
      // que pedir, pero fallar aqui tampoco puede impedir contestar.
      editando
        ? RecommendationRepository.getPreferences().catch(() => null)
        : Promise.resolve(null),
    ])
      .then(([catalogoNuevo, previas]) => {
        setCatalogo(catalogoNuevo);
        if (previas) {
          setObjetivos(previas.goals);
          setTemas(previas.learningTopicIds);
          setConexiones(previas.connectionTypes);
          setFormatos(previas.contentFormats);
          setModosDeOferta(previas.offerModes);
          setTemasQueOfrezco(previas.offerTopicIds);
        }
        setCarga('listo');
      })
      .catch((error) => {
        console.warn('[cuestionario] no se pudo cargar', error);
        setCarga('error');
      });
  }, [editando]);

  useEffect(cargar, [cargar]);

  const alternar = (valores: string[], valor: string, maximo?: number): string[] => {
    if (valores.includes(valor)) return valores.filter((v) => v !== valor);
    if (maximo && valores.length >= maximo) return valores;
    return [...valores, valor];
  };

  /** Temas agrupados como vienen del servidor, conservando su orden. */
  const grupos = useMemo(() => {
    const salida: Array<{ nombre: string; temas: TopicDto[] }> = [];
    for (const tema of catalogo?.topics ?? []) {
      const ultimo = salida[salida.length - 1];
      if (ultimo && ultimo.nombre === tema.group) ultimo.temas.push(tema);
      else salida.push({ nombre: tema.group, temas: [tema] });
    }
    return salida;
  }, [catalogo]);

  const pasoActual = PASOS[paso]!;
  const esUltimo = paso === PASOS.length - 1;

  /**
   * Continuar solo se apaga cuando falta algo DE VERDAD. Un boton deshabilitado
   * sin explicacion es una pared: por eso el unico paso obligatorio es el de
   * los temas, y dice cuantos faltan.
   */
  const puedeContinuar = !pasoActual.obligatorio || temas.length >= MIN_TEMAS;

  const salir = useCallback(() => {
    marcarVisto();
    if (editando) {
      // Se llego desde Ajustes con `push`: se VUELVE. Reemplazar por
      // `/settings` dejaba Ajustes dos veces en la pila y «atras» lo repetia.
      if (router.canGoBack()) router.back();
      else router.replace('/settings' as never);
      return;
    }
    router.replace(postAuthRoute() as never);
  }, [editando, marcarVisto, router]);

  const guardar = async (saltado: boolean) => {
    setGuardando(true);
    setErrorAlGuardar(null);
    try {
      await RecommendationRepository.savePreferences({
        goals: objetivos,
        learningTopicIds: temas,
        connectionTypes: conexiones,
        contentFormats: formatos,
        offerModes: modosDeOferta,
        offerTopicIds: temasQueOfrezco,
        skipped: saltado,
      });
      haptics.light();
      // Al editar se vuelve a Ajustes sin mas señal: se dice que se guardo.
      if (editando) toast(t('common.changesSaved'));
      /*
        Se entra INMEDIATAMENTE. Las recomendaciones se calculan cuando la
        pantalla siguiente las pida; quedarse aqui girando una rueda mientras
        tanto convertiria un cuestionario de dos minutos en uno de tres.
      */
      salir();
    } catch (error) {
      console.warn('[cuestionario] no se pudo guardar', error);
      setErrorAlGuardar(
        error instanceof Error
          ? error.message
          : t('onboarding.saveFailed'),
      );
      setGuardando(false);
    }
  };

  const saltar = () => {
    /*
      Saltar NO es no responder: se guarda igualmente que esta persona paso por
      esta version del cuestionario, para no volver a preguntarselo en cada
      arranque. Puede configurarlo mas tarde desde Ajustes.
    */
    void guardar(true);
  };

  const atras = () => {
    if (paso > 0) {
      setPaso(paso - 1);
      return;
    }
    if (editando) router.back();
    else salir();
  };

  if (carga !== 'listo') {
    return (
      <AppScreen scroll={false}>
        <AppHeader title="Z" onBack={editando ? () => router.back() : salir} />
        <View style={styles.centro}>
          <StateView
            state={carga === 'error' ? 'error' : 'loading'}
            icon="wifi-off"
            title={carga === 'error' ? t('onboarding.loadFailed') : undefined}
            description={carga === 'error' ? t('common.checkConnection') : undefined}
            onRetry={carga === 'error' ? cargar : undefined}
            actionLabel={carga === 'error' ? t('onboarding.continueWithout') : undefined}
            onAction={carga === 'error' ? salir : undefined}
          />
        </View>
      </AppScreen>
    );
  }

  return (
    <AppScreen scroll={false}>
      <AppHeader title={editando ? t('onboarding.yourPreferences') : 'Z'} onBack={atras} />

      {/* Progreso: cuantas preguntas quedan, sin tener que contarlas. */}
      <View style={styles.progreso}>
        <View style={styles.barra}>
          {PASOS.map((p, indice) => (
            <View
              key={p.clave}
              style={[
                styles.segmento,
                { backgroundColor: indice <= paso ? colors.primary : colors.border },
              ]}
            />
          ))}
        </View>
        <Text variant="secondary" color={colors.textMuted} style={styles.contador}>
          {paso + 1} de {PASOS.length}
        </Text>
      </View>

      <ScrollView
        style={styles.lleno}
        contentContainerStyle={styles.contenido}
        keyboardShouldPersistTaps="handled"
      >
        <Text variant="title" weight="900" style={styles.titulo}>
          {t(pasoActual.titulo)}
        </Text>
        <Text variant="body" color={colors.textMuted} style={styles.ayuda}>
          {/* Solo el paso de temas lleva los topes dentro de la frase. */}
          {pasoActual.clave === 'temas'
            ? t(pasoActual.ayuda, { min: MIN_TEMAS, max: MAX_TEMAS })
            : t(pasoActual.ayuda)}
        </Text>

        {pasoActual.clave === 'objetivos' && (
          <Opciones
            opciones={catalogo!.goals}
            seleccion={objetivos}
            onToggle={(clave) => setObjetivos((v) => alternar(v, clave))}
          />
        )}

        {pasoActual.clave === 'temas' && (
          <View>
            {grupos.map((grupo) => (
              <View key={grupo.nombre} style={styles.grupo}>
                <Text variant="secondary" weight="700" color={colors.textMuted}>
                  {grupo.nombre.toUpperCase()}
                </Text>
                <View style={styles.chips}>
                  {grupo.temas.map((tema) => (
                    <Chip
                      key={tema.id}
                      label={tema.name}
                      selected={temas.includes(tema.id)}
                      onPress={() => setTemas((v) => alternar(v, tema.id, MAX_TEMAS))}
                    />
                  ))}
                </View>
              </View>
            ))}
            {temas.length >= MAX_TEMAS ? (
              <Text variant="secondary" color={colors.textMuted} style={styles.aviso}>
                Has llegado al máximo de {MAX_TEMAS}. Quita uno para elegir otro.
              </Text>
            ) : null}
          </View>
        )}

        {pasoActual.clave === 'conexion' && (
          <Opciones
            opciones={catalogo!.connectionTypes}
            seleccion={conexiones}
            onToggle={(clave) => setConexiones((v) => alternar(v, clave))}
          />
        )}

        {pasoActual.clave === 'formatos' && (
          <Opciones
            opciones={catalogo!.contentFormats}
            seleccion={formatos}
            onToggle={(clave) => setFormatos((v) => alternar(v, clave))}
          />
        )}

        {pasoActual.clave === 'oferta' && (
          <View>
            <Opciones
              opciones={catalogo!.offerModes}
              seleccion={modosDeOferta}
              onToggle={(clave) => setModosDeOferta((v) => alternar(v, clave))}
            />
            {/*
              Los temas que se ofrecen solo se preguntan si ya dijo que puede
              aportar algo. Preguntarlos antes seria pedir un dato para el que
              todavia no hay contexto.
            */}
            {modosDeOferta.length > 0 ? (
              <View style={styles.grupo}>
                <Text variant="body" weight="700" style={styles.subtitulo}>
                  {t('onboarding.whichTopics')}
                </Text>
                <View style={styles.chips}>
                  {(catalogo!.topics ?? []).map((tema) => (
                    <Chip
                      key={tema.id}
                      label={tema.name}
                      selected={temasQueOfrezco.includes(tema.id)}
                      onPress={() =>
                        setTemasQueOfrezco((v) => alternar(v, tema.id, MAX_TEMAS))
                      }
                    />
                  ))}
                </View>
                {/*
                  Decir «tengo experiencia» no es «experto verificado», y se
                  dice aqui para no prometer lo que el sistema no comprueba. La
                  reputacion comprobable llegara de las sesiones y las resenas.
                */}
                <Text variant="secondary" color={colors.textMuted} style={styles.aviso}>
                  {t('onboarding.selfDeclared')}
                </Text>
              </View>
            ) : null}
          </View>
        )}
      </ScrollView>

      <View style={[styles.pie, { borderTopColor: colors.border }]}>
        {errorAlGuardar ? <InlineError message={errorAlGuardar} /> : null}
        <Button
          label={
            esUltimo
              ? editando
                ? t('common.save')
                : t('onboarding.start')
              : t('language.continue')
          }
          onPress={() => (esUltimo ? void guardar(false) : setPaso(paso + 1))}
          disabled={!puedeContinuar}
          loading={guardando}
        />
        {!editando ? (
          <Pressable
            onPress={saltar}
            disabled={guardando}
            accessibilityRole="button"
            accessibilityLabel={t('onboarding.skip')}
            hitSlop={8}
            style={styles.saltar}
          >
            <Text variant="secondary" color={colors.textMuted}>
              {t('onboarding.skip')}
            </Text>
            <Feather name="chevron-right" size={14} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>
    </AppScreen>
  );
}

function Opciones({
  opciones,
  seleccion,
  onToggle,
}: {
  opciones: OptionDto[];
  seleccion: string[];
  onToggle: (clave: string) => void;
}) {
  const { colors } = useAppTheme();
  return (
    <View style={styles.lista}>
      {opciones.map((opcion) => {
        const marcada = seleccion.includes(opcion.key);
        return (
          <Pressable
            key={opcion.key}
            onPress={() => onToggle(opcion.key)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: marcada }}
            accessibilityLabel={opcion.label}
            style={({ pressed }) => [
              styles.opcion,
              {
                borderColor: marcada ? colors.primary : colors.border,
                backgroundColor: marcada ? colors.surface : colors.background,
                opacity: pressed ? 0.85 : 1,
              },
            ]}
          >
            <View style={styles.textoOpcion}>
              <Text variant="body" weight={marcada ? '700' : '500'}>
                {opcion.label}
              </Text>
              {opcion.help ? (
                <Text variant="secondary" color={colors.textMuted}>
                  {opcion.help}
                </Text>
              ) : null}
            </View>
            {/*
              La marca es un icono, no solo un color: el sistema visual es
              blanco y negro y el color nunca puede ser el unico portador de
              informacion.
            */}
            <View
              style={[
                styles.marca,
                {
                  borderColor: marcada ? colors.primary : colors.border,
                  backgroundColor: marcada ? colors.primary : 'transparent',
                },
              ]}
            >
              {marcada ? <Feather name="check" size={14} color={colors.onPrimary} /> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  lleno: { flex: 1 },
  centro: { flex: 1, justifyContent: 'center', paddingHorizontal: spacing.lg },
  progreso: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  barra: { flexDirection: 'row', gap: spacing.xs },
  segmento: { flex: 1, height: 3, borderRadius: radius.pill },
  contador: { marginTop: spacing.sm },
  contenido: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },
  titulo: { marginTop: spacing.lg },
  subtitulo: { marginBottom: spacing.md },
  ayuda: { marginTop: spacing.sm, marginBottom: spacing.xl },
  lista: { gap: spacing.sm },
  opcion: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  textoOpcion: { flex: 1, gap: 2 },
  marca: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grupo: { marginBottom: spacing.xl, gap: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  aviso: { marginTop: spacing.sm },
  pie: {
    borderTopWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    gap: spacing.md,
  },
  saltar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    minHeight: 44,
  },
});
