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
import { notify } from '@/lib/confirm';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import {
  ESTRELLAS,
  LARGO_MAXIMO_DE_LA_RESPUESTA,
  POR_PAGINA,
  anchoDeBarra,
  asistenciaVerificada,
  claveDeErrorDeResena,
  claveDelEje,
  cursorDeLaPagina,
  ejesDelResumen,
  elServidorDiceQueOrganiza,
  estaEscondida,
  fusionarPaginas,
  hayValoraciones,
  histogramaOrdenado,
  motivoParaNoResenar,
  porcentajeLegible,
  promedioLegible,
  puedeEscribir,
  puedeOfrecerResponder,
  respuestaParaEnviar,
  esResenasApagadas,
  esRespuestaApagada,
} from '@/lib/resenasDeEventos';
import {
  EventReviewRepository,
  type PermisoParaResenar,
  type ResenaDeEvento,
  type ResumenDeEvento,
} from '@/repositories/EventReviewRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError, haySesion } from '@/services/api';

/** La fecha, en el idioma del sistema. Vacía si el servidor mandó algo raro. */
function fechaLegible(iso: string | null | undefined): string {
  if (!iso) return '';
  const momento = new Date(iso);
  if (Number.isNaN(momento.getTime())) return '';
  return momento.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Las reseñas verificadas de un evento, y su resumen.
 *
 * SIN VALORACIONES NO SE PINTA UNA PUNTUACIÓN. `promedio` llega `null` cuando
 * nadie ha opinado, y `null` no es cero: se escribe que todavía no hay
 * valoraciones y NO se dibujan cinco estrellas vacías, que se leerían como un
 * suspenso que nadie ha puesto. Lo mismo con `recomiendan_bps` —si es `null`,
 * nadie contestó a esa pregunta y no se enseña ningún porcentaje— y con cada
 * eje por separado.
 *
 * EL SELLO LO AFIRMA EL SERVIDOR. «Asistencia verificada» sale de
 * `asistencia_verificada`, que es `true` porque la reseña solo existe si hubo
 * check-in. La aplicación no lo deduce ni añade ningún otro sello.
 *
 * LA CAJA DE RESPONDER SOLO SALE PARA QUIEN ORGANIZA, y quien organiza lo dice
 * el servidor (`can-review` contesta `own_event`). Que responder en público
 * esté habilitado lo decide una política publicada, y eso solo se sabe al
 * intentarlo: si contesta `event_reply_not_configured` se enseña ESE motivo y
 * no un error genérico.
 */
export function ResenasDelEventoScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { eventId } = useLocalSearchParams<{ eventId: string }>();

  const [resumen, setResumen] = useState<ResumenDeEvento | null>(null);
  const [resenas, setResenas] = useState<ResenaDeEvento[]>([]);
  const [mia, setMia] = useState<ResenaDeEvento | null>(null);
  const [permiso, setPermiso] = useState<PermisoParaResenar | null>(null);
  const [conSesion, setConSesion] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [trayendoMas, setTrayendoMas] = useState(false);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'noDisponible' | 'noEncontrado' | null
  >(null);

  const [respondiendoA, setRespondiendoA] = useState<string | null>(null);
  const [borrador, setBorrador] = useState('');
  const [enviando, setEnviando] = useState(false);
  const ocupadoRef = useRef(false);

  const cargar = useCallback(async () => {
    if (!eventId) return;
    setCargando(true);
    setFallo(null);
    try {
      const [elResumen, primeraPagina] = await Promise.all([
        EventReviewRepository.resumen(eventId),
        EventReviewRepository.listar(eventId, POR_PAGINA),
      ]);
      setResumen(elResumen);
      setResenas(primeraPagina);
      setCursor(cursorDeLaPagina(primeraPagina, POR_PAGINA));

      // LO QUE NECESITA SESIÓN VA APARTE Y NO TUMBA LA PANTALLA: quien mira sin
      // cuenta tiene derecho a leer las reseñas igual que lee la ficha.
      const sesion = await haySesion();
      setConSesion(sesion);
      if (sesion) {
        const [laMia, elPermiso] = await Promise.allSettled([
          EventReviewRepository.mia(eventId),
          EventReviewRepository.permiso(eventId),
        ]);
        setMia(laMia.status === 'fulfilled' ? laMia.value : null);
        setPermiso(elPermiso.status === 'fulfilled' ? elPermiso.value : null);
      } else {
        setMia(null);
        setPermiso(null);
      }
    } catch (error) {
      if (error instanceof ApiError && esResenasApagadas(error.code)) {
        setFallo('noDisponible');
      } else if (error instanceof ApiError && error.status === 404) {
        setFallo('noEncontrado');
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

  const traerMas = async () => {
    if (!eventId || cursor === null || trayendoMas) return;
    setTrayendoMas(true);
    try {
      const pagina = await EventReviewRepository.listar(eventId, POR_PAGINA, cursor);
      setResenas((previas) => fusionarPaginas(previas, pagina));
      setCursor(cursorDeLaPagina(pagina, POR_PAGINA));
    } catch (error) {
      // Se deja la lista como está: no borrar lo que ya se pudo leer.
      notify(t('common.loadFailed'), textoDelError(error));
    } finally {
      setTrayendoMas(false);
    }
  };

  const textoDelError = (error: unknown) => {
    const clave = error instanceof ApiError ? claveDeErrorDeResena(error.code) : null;
    if (clave !== null) return t(clave as TranslationKey);
    return error instanceof Error && error.message.trim() !== ''
      ? error.message
      : t('common.tryAgain');
  };

  const enviarRespuesta = (resenaId: string) => {
    // ANTES DEL PRIMER `await`: dos toques rápidos mandarían dos respuestas, y
    // la segunda chocaría con el índice único del servidor.
    if (ocupadoRef.current) return;
    const texto = respuestaParaEnviar(borrador);
    if (texto === null) {
      notify(t('resenas.respuestaNoSePudo'), t('resenas.respuestaVacia'));
      return;
    }
    ocupadoRef.current = true;
    setEnviando(true);
    void (async () => {
      try {
        await EventReviewRepository.responder(resenaId, texto);
        setRespondiendoA(null);
        setBorrador('');
        notify(t('resenas.respuestaEnviada'));
        await cargar();
      } catch (error) {
        // APAGADA NO ES ROTA. Sin la política publicada, responder en público
        // todavía no está habilitado, y eso se dice con su propio texto.
        const codigo = error instanceof ApiError ? error.code : null;
        notify(
          t('resenas.respuestaNoSePudo'),
          esRespuestaApagada(codigo)
            ? t('resenas.error.respuestaNoConfigurada')
            : textoDelError(error),
        );
      } finally {
        ocupadoRef.current = false;
        setEnviando(false);
      }
    })();
  };

  const volver = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(`/eventos/${eventId}` as never);
  };

  if (cargando) {
    return (
      <AppScreen>
        <AppHeader title={t('resenas.titulo')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null) {
    return (
      <AppScreen>
        <AppHeader title={t('resenas.titulo')} onBack={volver} />
        {fallo === 'noDisponible' || fallo === 'noEncontrado' ? (
          <StateView
            state="empty"
            icon={fallo === 'noDisponible' ? 'clock' : 'inbox'}
            title={
              fallo === 'noDisponible'
                ? t('resenas.noDisponible')
                : t('resenas.eventoNoEncontrado')
            }
            description={
              fallo === 'noDisponible' ? t('resenas.noDisponibleCuerpo') : undefined
            }
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

  const conValoraciones = hayValoraciones(resumen);
  const promedio = promedioLegible(resumen);
  const barras = histogramaOrdenado(resumen);
  const porcentaje = porcentajeLegible(resumen?.recomiendan_bps ?? null);
  const ejes = ejesDelResumen(resumen);
  const total = resumen?.total ?? 0;
  const textoDelTotal =
    total === 1 ? t('resenas.una') : t('resenas.varias', { count: total });
  const organiza = elServidorDiceQueOrganiza(permiso);
  const impedimento = motivoParaNoResenar(permiso);

  /** Una fila de estrellas, dibujada Y dicha. El dibujo solo no basta. */
  const estrellas = (valor: number, tamano = 14) => (
    <View
      style={styles.fila}
      accessible
      accessibilityLabel={t('resenas.puntuacionA11y', { n: valor })}
    >
      <View
        style={styles.estrellas}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {ESTRELLAS.map((n) => (
          <MaterialCommunityIcons
            key={n}
            name={n <= valor ? 'star' : 'star-outline'}
            size={tamano}
            color={n <= valor ? colors.text : colors.textMuted}
          />
        ))}
      </View>
    </View>
  );

  const tarjetaDeResena = (resena: ResenaDeEvento, propia: boolean) => {
    const fecha = fechaLegible(resena.created_at);
    const ofreceResponder = puedeOfrecerResponder(resena, organiza);
    const escribiendo = respondiendoA === resena.id;
    return (
      <View
        key={resena.id}
        style={[styles.tarjeta, { borderColor: colors.border }]}
      >
        <View style={styles.cabeceraDeResena}>
          {estrellas(resena.overall)}
          <Text variant="caption" color={colors.textMuted}>
            {t('resenas.puntuacionA11y', { n: resena.overall })}
          </Text>
        </View>

        <Text variant="caption" color={colors.textMuted}>
          {propia ? t('resenas.miResena') : t('resenas.sinNombre')}
        </Text>

        {/*
          EL SELLO SALE DEL SERVIDOR. Si el campo no viene, no hay sello: la
          aplicación no lo deduce del hecho de que la reseña exista.
        */}
        {asistenciaVerificada(resena) ? (
          <View style={styles.sello}>
            <Feather name="check-circle" size={14} color={colors.textMuted} />
            <Text variant="caption" color={colors.textMuted}>
              {t('resenas.asistenciaVerificada')}
            </Text>
          </View>
        ) : null}

        {fecha !== '' ? (
          <Text variant="caption" color={colors.textMuted}>
            {t('resenas.escritaEl', { fecha })}
          </Text>
        ) : null}

        {propia && estaEscondida(resena) ? (
          <Text variant="caption" color={colors.danger}>
            {t('resenas.miResenaEscondida')}
          </Text>
        ) : null}

        {resena.comment && resena.comment.trim() !== '' ? (
          <Text variant="secondary">{resena.comment}</Text>
        ) : (
          <Text variant="caption" color={colors.textMuted}>
            {t('resenas.sinComentario')}
          </Text>
        )}

        {/*
          SIN CONTESTAR NO ES UN «NO». `recommends` llega `null` cuando la
          persona no respondió a esa pregunta, y ahí no se escribe nada.
        */}
        {resena.recommends === true || resena.recommends === false ? (
          <Text variant="caption" color={colors.textMuted}>
            {resena.recommends
              ? t('resenas.autorRecomienda')
              : t('resenas.autorNoRecomienda')}
          </Text>
        ) : null}

        {resena.respuesta ? (
          <View style={[styles.respuesta, { borderColor: colors.border }]}>
            <Text variant="caption" weight="700">
              {t('resenas.respuestaTitulo')}
            </Text>
            <Text variant="secondary">{resena.respuesta.body}</Text>
            {fechaLegible(resena.respuesta.created_at) !== '' ? (
              <Text variant="caption" color={colors.textMuted}>
                {t('resenas.respondidaEl', {
                  fecha: fechaLegible(resena.respuesta.created_at),
                })}
              </Text>
            ) : null}
          </View>
        ) : null}

        {ofreceResponder && !escribiendo ? (
          <Button
            label={t('resenas.responder')}
            variant="secondary"
            onPress={() => {
              setRespondiendoA(resena.id);
              setBorrador('');
            }}
          />
        ) : null}

        {ofreceResponder && escribiendo ? (
          <View style={styles.bloque}>
            <Input
              label={t('resenas.respuestaEtiqueta')}
              placeholder={t('resenas.respuestaEjemplo')}
              value={borrador}
              onChangeText={(texto) =>
                setBorrador(texto.slice(0, LARGO_MAXIMO_DE_LA_RESPUESTA))
              }
              maxLength={LARGO_MAXIMO_DE_LA_RESPUESTA}
              multiline
              numberOfLines={4}
              style={styles.campoLargo}
            />
            <Text variant="caption" color={colors.textMuted}>
              {t('resenas.respuestaContador', {
                n: borrador.length,
                max: LARGO_MAXIMO_DE_LA_RESPUESTA,
              })}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {t('resenas.respuestaUnaSola')}
            </Text>
            <Button
              label={t('resenas.respuestaEnviar')}
              onPress={() => enviarRespuesta(resena.id)}
              loading={enviando}
              disabled={enviando}
            />
            <Button
              label={t('resenas.respuestaCancelar')}
              variant="secondary"
              onPress={() => {
                setRespondiendoA(null);
                setBorrador('');
              }}
              disabled={enviando}
            />
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={t('resenas.titulo')} onBack={volver} />

      {/*
        SIN VALORACIONES NO HAY CIFRA NI ESTRELLAS. `promedio` nulo se escribe
        «todavía no hay valoraciones», que es lo que pasa: cinco estrellas
        vacías dirían que el evento está mal valorado.
      */}
      <View style={[styles.tarjeta, { borderColor: colors.border }]}>
        {conValoraciones && promedio !== null ? (
          <View
            accessible
            accessibilityLabel={t('resenas.promedioA11y', {
              media: promedio,
              total: textoDelTotal,
            })}
          >
            <Text variant="display">{promedio}</Text>
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              {estrellas(Math.round(resumen?.promedio ?? 0), 18)}
            </View>
            <Text variant="caption" color={colors.textMuted}>
              {textoDelTotal}
            </Text>
          </View>
        ) : (
          <View>
            <Text variant="secondary" weight="700">
              {t('resenas.sinValoraciones')}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {t('resenas.sinValoracionesCuerpo')}
            </Text>
          </View>
        )}

        <Text variant="caption" color={colors.textMuted}>
          {t('resenas.generalNoEsMedia')}
        </Text>
      </View>

      {barras.length > 0 ? (
        <View style={styles.bloque}>
          <Text variant="caption" color={colors.textMuted}>
            {t('resenas.histogramaTitulo')}
          </Text>
          {barras.map((barra) => (
            <View
              key={barra.puntuacion}
              style={styles.fila}
              accessible
              accessibilityLabel={t('resenas.distribucionA11y', {
                n: barra.puntuacion,
                total:
                  barra.cuantas === 1
                    ? t('resenas.una')
                    : t('resenas.varias', { count: barra.cuantas }),
              })}
            >
              <Text variant="caption" color={colors.textMuted} style={styles.nota}>
                {barra.puntuacion}
              </Text>
              <View style={[styles.carril, { backgroundColor: colors.surfaceAlt }]}>
                <View
                  style={[
                    styles.relleno,
                    {
                      backgroundColor: colors.text,
                      width: anchoDeBarra(barra.cuantas, total),
                    },
                  ]}
                />
              </View>
              <Text variant="caption" color={colors.textMuted}>
                {barra.cuantas}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {/*
        `recomiendan_bps` nulo = NADIE CONTESTÓ. No se escribe «0 %» ni «X
        personas lo recomiendan»: no hay ninguna cifra que decir.
      */}
      <Text variant="secondary">
        {porcentaje !== null
          ? t('resenas.recomiendan', { porcentaje })
          : t('resenas.recomiendanSinDatos')}
      </Text>

      <View style={styles.bloque}>
        <Text variant="caption" color={colors.textMuted}>
          {t('resenas.ejesTitulo')}
        </Text>
        {ejes.map(({ eje, texto }) => (
          <View key={eje} style={styles.fila}>
            <Text variant="secondary" style={styles.crece}>
              {t(claveDelEje(eje) as TranslationKey)}
            </Text>
            {/* Cada eje es opcional por separado: sin nota no se pinta un cero. */}
            <Text variant="secondary" color={texto === null ? colors.textMuted : undefined}>
              {texto ?? t('resenas.ejeSinValorar')}
            </Text>
          </View>
        ))}
      </View>

      <Text variant="caption" color={colors.textMuted}>
        {t('resenas.asistenciaVerificadaAyuda')}
      </Text>

      {/*
        EL BOTÓN SALE DE `can-review`, no de lo que deduzca la pantalla. Con
        `puede: false` se enseña el motivo traducido y no se deja escribir.
      */}
      {mia !== null ? (
        <Button
          label={t('resenas.editarLaMia')}
          onPress={() => router.push(`/resenas/nueva/${eventId}` as never)}
        />
      ) : puedeEscribir(permiso) ? (
        <Button
          label={t('resenas.tituloNueva')}
          onPress={() => router.push(`/resenas/nueva/${eventId}` as never)}
        />
      ) : permiso !== null ? (
        <View style={styles.bloque}>
          <Button label={t('resenas.tituloNueva')} onPress={() => {}} disabled />
          {impedimento !== null ? (
            <Text variant="caption" color={colors.danger}>
              {t(impedimento as TranslationKey)}
            </Text>
          ) : null}
        </View>
      ) : !conSesion ? (
        <View style={styles.bloque}>
          <Text variant="caption" color={colors.textMuted}>
            {t('resenas.necesitaSesion')}
          </Text>
          <Button
            label={t('resenas.iniciarSesion')}
            variant="secondary"
            onPress={() => router.push('/login' as never)}
          />
        </View>
      ) : null}
      {/*
        CON SESIÓN Y SIN RESPUESTA DE `can-review` NO SE DICE NADA. Enseñar aquí
        «inicia sesión» a quien ya la tiene sería contarle como suyo un fallo que
        fue nuestro, y ofrecerle escribir sería prometerle algo que el servidor
        no ha autorizado.
      */}

      {mia !== null ? tarjetaDeResena(mia, true) : null}

      {resenas.length === 0 ? (
        <StateView
          state="empty"
          title={t('resenas.ninguna')}
          description={t('resenas.ningunaCuerpo')}
        />
      ) : (
        resenas
          .filter((resena) => mia === null || resena.id !== mia.id)
          .map((resena) => tarjetaDeResena(resena, false))
      )}

      {cursor !== null ? (
        <Button
          label={t('common.loadMore')}
          variant="secondary"
          onPress={() => void traerMas()}
          loading={trayendoMas}
          disabled={trayendoMas}
        />
      ) : null}

      <Pressable
        onPress={() => router.push(`/eventos/${eventId}` as never)}
        accessibilityRole="link"
        style={styles.enlace}
      >
        <Feather name="arrow-left" size={16} color={colors.textMuted} />
        <Text variant="caption" color={colors.textMuted}>
          {t('evento.titulo')}
        </Text>
      </Pressable>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  bloque: { gap: spacing.sm },
  crece: { flex: 1 },
  fila: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  estrellas: { flexDirection: 'row', alignItems: 'center' },
  cabeceraDeResena: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  sello: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  tarjeta: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  respuesta: {
    borderLeftWidth: 2,
    paddingLeft: spacing.md,
    gap: 4,
  },
  nota: { minWidth: 14, textAlign: 'center' },
  carril: { flex: 1, height: 8, borderRadius: radius.pill, overflow: 'hidden' },
  relleno: { height: 8, borderRadius: radius.pill },
  enlace: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  campoLargo: {
    minHeight: 90,
    textAlignVertical: 'top',
    paddingTop: spacing.sm,
  },
});
