import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import {
  EJES,
  ESTRELLAS,
  LARGO_MAXIMO_DEL_COMENTARIO,
  claveDeErrorDeResena,
  claveDelEje,
  cuerpoDeResena,
  esResenasApagadas,
  estaEscondida,
  largoDelComentario,
  motivoDelRechazo,
  motivoParaNoEnviar,
  motivoParaNoResenar,
  puedeEscribir,
  type Eje,
} from '@/lib/resenasDeEventos';
import {
  EventReviewRepository,
  type PermisoParaResenar,
  type ResenaDeEvento,
} from '@/repositories/EventReviewRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError, haySesion } from '@/services/api';

type NotasDeEjes = Partial<Record<Eje, number | null>>;

/**
 * Escribir —o corregir— la reseña propia de un evento.
 *
 * QUIÉN PUEDE ESCRIBIR LO DICE `can-review`, no esta pantalla. Si contesta
 * `puede: false` se enseña el motivo traducido y el botón queda desactivado a
 * la vista, con la explicación al lado: esconderlo dejaría a la persona
 * buscando algo que no está. La única excepción es `already_reviewed`, que no
 * es una negativa sino un «ya lo hiciste»: entonces se edita lo que hay.
 *
 * LA GENERAL NO SE CALCULA. «¿Entregó lo que anunció?» es una pregunta aparte
 * de los cinco ejes y la contesta la persona; aquí no hay ninguna media que la
 * rellene sola. Y un eje sin puntuar se manda sin puntuar: un cero estaría
 * fuera del rango del servidor y diría algo que nadie ha dicho.
 *
 * SIN CONTESTAR NO ES UN «NO». La recomendación tiene tres estados —sí, no y
 * prefiero no contestar— porque `recommends` admite `null`, y el resumen del
 * evento distingue «nadie contestó» de «nadie lo recomienda».
 */
export function ResenaDelEventoScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { eventId } = useLocalSearchParams<{ eventId: string }>();

  const [permiso, setPermiso] = useState<PermisoParaResenar | null>(null);
  const [mia, setMia] = useState<ResenaDeEvento | null>(null);
  const [overall, setOverall] = useState(0);
  const [notas, setNotas] = useState<NotasDeEjes>({});
  const [recomienda, setRecomienda] = useState<boolean | null>(null);
  const [comentario, setComentario] = useState('');
  const [errorDelFormulario, setErrorDelFormulario] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'noDisponible' | 'sinSesion' | null
  >(null);
  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);

  const cargar = useCallback(async () => {
    if (!eventId) return;
    setCargando(true);
    setFallo(null);
    try {
      if (!(await haySesion())) {
        setFallo('sinSesion');
        return;
      }
      const [elPermiso, laMia] = await Promise.all([
        EventReviewRepository.permiso(eventId),
        EventReviewRepository.mia(eventId),
      ]);
      setPermiso(elPermiso);
      setMia(laMia);
      // El formulario arranca con lo que ya hay escrito, no en blanco: quien
      // edita no tiene que volver a contestarlo todo.
      if (laMia) {
        setOverall(laMia.overall);
        setNotas({
          content: laMia.content,
          organization: laMia.organization,
          venue: laMia.venue,
          safety: laMia.safety,
          value: laMia.value,
        });
        setRecomienda(laMia.recommends);
        setComentario(laMia.comment ?? '');
      }
    } catch (error) {
      if (error instanceof ApiError && esResenasApagadas(error.code)) {
        setFallo('noDisponible');
      } else if (error instanceof ApiError && error.status === 401) {
        setFallo('sinSesion');
      } else if (error instanceof ApiError && esFalloDeRed(error.code)) {
        setFallo('sinConexion');
      } else {
        setFallo('red');
      }
    } finally {
      setCargando(false);
    }
  }, [eventId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const textoDelError = (error: unknown) => {
    if (error instanceof ApiError) {
      // `event_review_not_allowed` viaja con el código concreto dentro: sin
      // mirarlo, quien no hizo check-in y quien llega tarde leen lo mismo.
      const porElDetalle = motivoDelRechazo(error.details);
      if (porElDetalle !== null) return t(porElDetalle as TranslationKey);
      const clave = claveDeErrorDeResena(error.code);
      if (clave !== null) return t(clave as TranslationKey);
    }
    return error instanceof Error && error.message.trim() !== ''
      ? error.message
      : t('common.tryAgain');
  };

  const enviar = () => {
    // ANTES DEL PRIMER `await`, que aquí es el diálogo de confirmación: dos
    // toques rápidos publicarían dos reseñas del mismo evento, y la segunda
    // chocaría con el índice único del servidor.
    if (ocupadoRef.current || !eventId) return;
    const borrador = { overall, ejes: notas, recomienda, comentario };
    const impedimento = motivoParaNoEnviar(borrador);
    if (impedimento !== null) {
      setErrorDelFormulario(
        t(impedimento as TranslationKey, { max: LARGO_MAXIMO_DEL_COMENTARIO }),
      );
      return;
    }
    setErrorDelFormulario(null);
    ocupadoRef.current = true;
    setOcupado(true);
    void (async () => {
      try {
        const cuerpo = cuerpoDeResena(borrador);
        if (mia === null) {
          const aceptado = await confirm({
            title: t('resenas.confirmarTitulo'),
            message: t('resenas.confirmarCuerpo'),
            confirmLabel: t('resenas.confirmarBoton'),
          });
          if (!aceptado) return;
          await EventReviewRepository.crear(eventId, cuerpo);
          notify(t('resenas.publicada'));
        } else {
          await EventReviewRepository.editar(mia.id, cuerpo);
          notify(t('resenas.guardada'));
        }
        router.replace(`/resenas/${eventId}` as never);
      } catch (error) {
        notify(t('resenas.noSePudo'), textoDelError(error));
        // El permiso pudo cambiar mientras tanto (moderación, una reseña que ya
        // existía): se vuelve a preguntar en vez de dejar el formulario
        // ofreciendo algo que el servidor acaba de rechazar.
        void cargar();
      } finally {
        ocupadoRef.current = false;
        setOcupado(false);
      }
    })();
  };

  const volver = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(`/resenas/${eventId}` as never);
  };

  const titulo = mia === null ? t('resenas.tituloNueva') : t('resenas.tituloEditar');

  if (cargando) {
    return (
      <AppScreen>
        <AppHeader title={titulo} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null) {
    return (
      <AppScreen>
        <AppHeader title={titulo} onBack={volver} />
        {fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            icon="clock"
            title={t('resenas.noDisponible')}
            description={t('resenas.noDisponibleCuerpo')}
          />
        ) : fallo === 'sinSesion' ? (
          <StateView
            state="empty"
            icon="user"
            title={t('resenas.necesitaSesion')}
            actionLabel={t('resenas.iniciarSesion')}
            onAction={() => router.push('/login' as never)}
          />
        ) : (
          <StateView
            state={fallo === 'sinConexion' ? 'offline' : 'error'}
            description={fallo === 'sinConexion' ? undefined : t('common.loadFailed')}
            onRetry={() => void cargar()}
          />
        )}
      </AppScreen>
    );
  }

  // EDITAR NO ES ESCRIBIR DE NUEVO. `can-review` contesta `already_reviewed`
  // —un «no»— a quien ya opinó, y eso no puede cerrarle la puerta a corregir lo
  // que escribió: con reseña propia el formulario se abre igual.
  const sePuedeEscribir = mia !== null || puedeEscribir(permiso);
  const impedimento = mia !== null ? null : motivoParaNoResenar(permiso);

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />

      <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt }]}>
        <Feather name="check-circle" size={16} color={colors.textMuted} />
        <Text variant="caption" color={colors.textMuted} style={styles.crece}>
          {t('resenas.asistenciaVerificadaAyuda')}
        </Text>
      </View>

      {mia !== null && estaEscondida(mia) ? (
        <Text variant="caption" color={colors.danger}>
          {t('resenas.miResenaEscondida')}
        </Text>
      ) : null}

      {/*
        LA PREGUNTA GENERAL, CON SU PROPIA PREGUNTA ESCRITA. No es «puntúa el
        evento» ni la media de los ejes: es si entregó lo que anunció.
      */}
      <Text variant="secondary" weight="700">
        {t('resenas.puntuacionGeneral')}
      </Text>
      <View
        style={styles.grupo}
        accessibilityRole="radiogroup"
        accessibilityLabel={t('resenas.puntuacionGeneral')}
      >
        {ESTRELLAS.map((n) => (
          <Pressable
            key={n}
            onPress={() => {
              setOverall(n);
              setErrorDelFormulario(null);
            }}
            disabled={!sePuedeEscribir || ocupado}
            hitSlop={8}
            style={styles.estrella}
            accessibilityRole="radio"
            accessibilityLabel={t('resenas.elegirPuntuacion', { n })}
            accessibilityState={{
              checked: n === overall,
              selected: n === overall,
              disabled: !sePuedeEscribir,
            }}
          >
            <MaterialCommunityIcons
              name={n <= overall ? 'star' : 'star-outline'}
              size={28}
              color={n <= overall ? colors.text : colors.textMuted}
            />
          </Pressable>
        ))}
      </View>
      <Text variant="caption" color={colors.textMuted}>
        {t('resenas.generalNoEsMedia')}
      </Text>

      <Text variant="secondary" weight="700">
        {t('resenas.ejesTitulo')}
      </Text>
      <Text variant="caption" color={colors.textMuted}>
        {t('resenas.ejesAyuda')}
      </Text>
      {EJES.map((eje) => {
        const nota = notas[eje] ?? 0;
        return (
          <View key={eje} style={styles.bloque}>
            <Text variant="secondary">{t(claveDelEje(eje) as TranslationKey)}</Text>
            <View
              style={styles.grupo}
              accessibilityRole="radiogroup"
              accessibilityLabel={t(claveDelEje(eje) as TranslationKey)}
            >
              {ESTRELLAS.map((n) => (
                <Pressable
                  key={n}
                  onPress={() =>
                    // Volver a tocar la misma nota la quita: un eje se puede
                    // dejar sin contestar, y sin esto no habría forma de
                    // deshacer un toque.
                    setNotas((previas) => ({
                      ...previas,
                      [eje]: previas[eje] === n ? null : n,
                    }))
                  }
                  disabled={!sePuedeEscribir || ocupado}
                  hitSlop={8}
                  style={styles.estrella}
                  accessibilityRole="radio"
                  accessibilityLabel={t('resenas.elegirPuntuacion', { n })}
                  accessibilityState={{
                    checked: n === nota,
                    selected: n === nota,
                    disabled: !sePuedeEscribir,
                  }}
                >
                  <MaterialCommunityIcons
                    name={n <= nota ? 'star' : 'star-outline'}
                    size={22}
                    color={n <= nota ? colors.text : colors.textMuted}
                  />
                </Pressable>
              ))}
              <Text variant="caption" color={colors.textMuted}>
                {nota === 0
                  ? t('resenas.ejeSinPuntuar')
                  : t('resenas.puntuacionA11y', { n: nota })}
              </Text>
            </View>
          </View>
        );
      })}

      {/*
        TRES ESTADOS, NO DOS. `recommends` admite `null`, y «prefiero no
        contestar» es distinto de «no lo recomiendo»: el resumen del evento
        cuenta solo a quien contestó.
      */}
      <Text variant="secondary" weight="700">
        {t('resenas.recomiendaPregunta')}
      </Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={t('resenas.recomiendaPregunta')}
        style={styles.bloque}
      >
        {(
          [
            [true, t('resenas.recomiendaSi')],
            [false, t('resenas.recomiendaNo')],
            [null, t('resenas.sinContestar')],
          ] as const
        ).map(([valor, etiqueta]) => {
          const elegido = recomienda === valor;
          return (
            <Pressable
              key={String(valor)}
              onPress={() => setRecomienda(valor)}
              disabled={!sePuedeEscribir || ocupado}
              accessibilityRole="radio"
              accessibilityLabel={etiqueta}
              accessibilityState={{ selected: elegido, disabled: !sePuedeEscribir }}
              style={[
                styles.opcion,
                {
                  borderColor: elegido ? colors.primary : colors.border,
                  opacity: sePuedeEscribir ? 1 : 0.5,
                },
              ]}
            >
              <Feather
                name={elegido ? 'check-circle' : 'circle'}
                size={18}
                color={elegido ? colors.primary : colors.textMuted}
              />
              <Text variant="secondary" style={styles.crece}>
                {etiqueta}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Input
        label={t('resenas.comentario')}
        placeholder={t('resenas.comentarioEjemplo')}
        value={comentario}
        onChangeText={(texto) => {
          setComentario(texto.slice(0, LARGO_MAXIMO_DEL_COMENTARIO));
          if (errorDelFormulario !== null) setErrorDelFormulario(null);
        }}
        maxLength={LARGO_MAXIMO_DEL_COMENTARIO}
        multiline
        numberOfLines={5}
        style={styles.campoLargo}
        disabled={!sePuedeEscribir}
        error={errorDelFormulario ?? undefined}
      />
      <Text variant="caption" color={colors.textMuted}>
        {t('resenas.comentarioContador', {
          n: largoDelComentario(comentario),
          max: LARGO_MAXIMO_DEL_COMENTARIO,
        })}
      </Text>

      {/*
        DESACTIVADO CON LA EXPLICACIÓN DELANTE, no escondido. Quien no puede
        opinar tiene derecho a saber por qué, y el motivo lo da el servidor.
      */}
      <Button
        label={mia === null ? t('resenas.publicar') : t('resenas.guardarCambios')}
        onPress={enviar}
        loading={ocupado}
        disabled={ocupado || !sePuedeEscribir}
      />
      {impedimento !== null ? (
        <Text variant="caption" color={colors.danger}>
          {t(impedimento as TranslationKey)}
        </Text>
      ) : null}

      <Button
        label={t('resenas.verTodas')}
        variant="secondary"
        onPress={() => router.push(`/resenas/${eventId}` as never)}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  bloque: { gap: spacing.sm },
  crece: { flex: 1 },
  aviso: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  grupo: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  // 44x44 es el mínimo pulsable: fallar aquí no es no acertar, es puntuar otra cosa.
  estrella: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  opcion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  campoLargo: {
    minHeight: 110,
    textAlignVertical: 'top',
    paddingTop: spacing.sm,
  },
});
