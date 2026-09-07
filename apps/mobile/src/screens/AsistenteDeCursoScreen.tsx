import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { useEspacioInferior } from '@/components/espacioInferior';
import { Input } from '@/components/Input';
import { SegmentedControl } from '@/components/SegmentedControl';
import { SelectorDeTemas } from '@/components/SelectorDeTemas';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { EditorDeContenido } from '@/components/curso/EditorDeContenido';
import { EditorDeFrases } from '@/components/curso/EditorDeFrases';
import { SelectorDeCategoriaPrincipal } from '@/components/curso/SelectorDeCategoriaPrincipal';
import { VistaPreviaDeCurso } from '@/components/curso/VistaPreviaDeCurso';
import { FEATURE_PURCHASES } from '@/config/features';
import {
  PASOS,
  accionFinal,
  avisoDeRevision,
  duracionLegible,
  duracionTotal,
  maximoDeTemas,
  pasoCompleto,
  temasAlElegirCategoria,
  type BorradorDeCurso,
  type PasoId,
  type ResumenDeModulo,
} from '@/lib/asistenteDeCurso';
import { confirm, notify } from '@/lib/confirm';
import { aCentavos, aTextoEditable } from '@/lib/dinero';
import { toast } from '@/lib/toast';
import { registrarSalidaPropia } from '@/navigation/capasAbiertas';
import { SinCambioDeSeccion } from '@/navigation/tabSwipe';
import { LearningRepository, type RequisitosDeCurso } from '@/repositories/LearningRepository';
import { pickImage, signMediaUrls, uploadPostMedia, type PickedMedia } from '@/services/storage';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

const NIVELES = ['beginner', 'intermediate', 'advanced'] as const;
const CLAVES_DE_NIVEL = ['wizard.levelBeginner', 'wizard.levelIntermediate', 'wizard.levelAdvanced'] as const;
const IDIOMAS = ['es', 'en', 'pt'] as const;
// El nombre del idioma del CURSO se lee en el idioma de quien mira: es un dato
// de la ficha, no el selector de idioma de la aplicación.
const CLAVES_DE_IDIOMA = ['lang.spanish', 'lang.english', 'lang.portuguese'] as const;

const VACIO: BorradorDeCurso = {
  title: '',
  subtitle: '',
  description: '',
  primaryTopicId: null,
  topicIds: [],
  level: null,
  language: 'es',
  highlights: [],
  targetAudience: [],
  prerequisites: [],
  dePago: false,
  precio: '',
};

/**
 * El asistente para montar un curso, paso a paso y GUARDABLE.
 *
 * POR QUÉ UN ASISTENTE Y NO UN FORMULARIO. Un curso tiene cuatro cosas
 * distintas que decidir —qué es, qué ofrece, qué contiene y cuánto cuesta— y
 * meterlas en una sola hoja hacía que se rellenara la primera mitad y se
 * abandonara la segunda. Aquí cada paso es una pregunta a la vez.
 *
 * GUARDABLE quiere decir que se puede salir en cualquier punto y volver: lo
 * escrito se guarda en el curso, que ya existe como borrador desde el primer
 * momento. Un asistente que solo guarda al final es un asistente que pierde el
 * trabajo de quien se queda sin batería.
 *
 * NAVEGAR NO EXIGE COMPLETAR. Se puede ir al paso cuatro con el uno a medias:
 * el indicador dice qué falta, pero no cierra la puerta. Lo que sí valida —y de
 * verdad— es el SERVIDOR, en el último paso y otra vez al publicar.
 */
export function AsistenteDeCursoScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  /* Cuanto hay que dejar abajo para que el boton de publicar se pueda pulsar. */
  const espacioInferior = useEspacioInferior();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [paso, setPaso] = useState<PasoId>('basico');
  const [borrador, setBorrador] = useState<BorradorDeCurso>(VACIO);
  const [modulos, setModulos] = useState<ResumenDeModulo[]>([]);
  const [currency, setCurrency] = useState('PEN');
  const [reviewStatus, setReviewStatus] = useState<string>('draft');
  const [motivoDeRechazo, setMotivoDeRechazo] = useState<string | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | undefined>(undefined);
  const [portadaNueva, setPortadaNueva] = useState<PickedMedia | null>(null);
  const [requisitos, setRequisitos] = useState<RequisitosDeCurso | null>(null);

  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    if (!id) {
      setFallo(t('wizard.courseNotFound'));
      setCargando(false);
      return;
    }
    setCargando(true);
    try {
      const detalle = await LearningRepository.getCourseDetail(id);
      if (!detalle.canManage) {
        // Esconder la pantalla no es el permiso —el servidor rechaza cada
        // escritura igualmente— pero enseñar un editor que no guarda nada sí
        // sería mentir.
        setFallo(t('wizard.cannotEdit'));
        return;
      }
      const curso = detalle.course;
      setBorrador({
        title: curso.title ?? '',
        subtitle: curso.subtitle ?? '',
        description: curso.description ?? '',
        primaryTopicId: curso.primaryTopicId ?? null,
        // La categoría principal viaja TAMBIÉN dentro de `topicIds` (el
        // servidor la pone la primera), pero aquí se edita en su propio
        // selector: si apareciera además en la fila de temas, quitarla de ahí
        // parecería quitarla del curso y no lo haría.
        topicIds: (curso.topicIds ?? []).filter((t) => t !== curso.primaryTopicId),
        level: curso.level ?? null,
        language: curso.language ?? 'es',
        highlights: curso.highlights ?? [],
        targetAudience: curso.targetAudience ?? [],
        prerequisites: curso.prerequisites ?? [],
        dePago: (curso.priceMinor ?? 0) > 0,
        precio: aTextoEditable(curso.priceMinor ?? 0),
      });
      setCurrency(curso.currency ?? 'PEN');
      setReviewStatus(curso.reviewStatus ?? 'draft');
      setMotivoDeRechazo(curso.rejectionReason ?? null);
      setCoverUrl(curso.coverUrl);
      setFallo(null);
    } catch (e) {
      setFallo(e instanceof Error ? e.message : t('wizard.loadFailed'));
    } finally {
      setCargando(false);
    }
  }, [id]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  /** El precio en centavos, o `null` si lo escrito no es un importe válido. */
  const precioEnCentavos = useMemo(() => {
    if (!borrador.dePago) return 0;
    const leido = aCentavos(borrador.precio, t);
    return leido.ok ? leido.centavos : null;
  }, [borrador.dePago, borrador.precio]);

  const cambiar = (cambios: Partial<BorradorDeCurso>) =>
    setBorrador((anterior) => ({ ...anterior, ...cambios }));

  const elegirPortada = async () => {
    try {
      const elegida = await pickImage({ allowsEditing: false });
      if (elegida) setPortadaNueva(elegida);
    } catch {
      setError(t('catalog.galleryFailed'));
    }
  };

  /**
   * Cerrojo SÍNCRONO de las acciones que escriben. `guardando` es estado, y el
   * estado no está puesto hasta el siguiente render: entre el primer toque y
   * ese render caben más toques, y cada uno subía otra vez la portada y volvía
   * a guardar el curso. En «publicar» el resultado era pedir dos publicaciones
   * del mismo curso.
   *
   * Envuelve solo los puntos de entrada que salen de un botón. `guardar` queda
   * fuera a propósito: la llaman desde dentro `publicar`, `irARevisar`,
   * `enviarARevision` y `salir`, y si tomara el cerrojo se bloquearía a sí
   * misma.
   */
  const ocupadoRef = useRef(false);
  /** El `salir` del render actual, para que el Atras fisico use el vigente. */
  const ultimoSalir = useRef<() => Promise<void>>(async () => {});

  const enSerie = async (accion: () => Promise<unknown>): Promise<void> => {
    if (ocupadoRef.current) return;
    ocupadoRef.current = true;
    try {
      await accion();
    } finally {
      ocupadoRef.current = false;
    }
  };

  /**
   * Guarda lo escrito en el curso. Devuelve si salió bien.
   *
   * Se manda TODO el borrador y no solo el paso actual: el servidor distingue
   * «no enviado» de «enviado vacío», así que mandar la ficha entera es lo que
   * permite borrar un campo. Y así salir en cualquier punto guarda lo de todos
   * los pasos, no solo lo del último que se tocó.
   */
  const guardar = async (silencioso = false): Promise<boolean> => {
    if (!id) return false;
    if (borrador.dePago) {
      // El importe se lee UNA vez y en un sitio (`lib/dinero.ts`): repartir el
      // cálculo por los componentes acaba en dos precios para el mismo curso.
      const leido = aCentavos(borrador.precio, t);
      if (!leido.ok) {
        setError(leido.motivo);
        setPaso('precio');
        return false;
      }
      if (leido.centavos === 0) {
        setError(t('catalog.priceAboveZero'));
        setPaso('precio');
        return false;
      }
    }
    setGuardando(true);
    setError(null);
    try {
      const coverPath = portadaNueva ? (await uploadPostMedia(portadaNueva)).storagePath : undefined;
      await LearningRepository.updateCourse(id, {
        title: borrador.title.trim(),
        description: borrador.description.trim(),
        subtitle: borrador.subtitle.trim() || null,
        primaryTopicId: borrador.primaryTopicId,
        topicIds: borrador.topicIds,
        level: borrador.level,
        language: borrador.language,
        highlights: borrador.highlights,
        targetAudience: borrador.targetAudience,
        prerequisites: borrador.prerequisites,
        priceMinor: precioEnCentavos ?? 0,
        ...(coverPath ? { coverPath } : {}),
      });
      if (coverPath) {
        const urls = await signMediaUrls([coverPath]);
        setCoverUrl(urls[coverPath]);
        setPortadaNueva(null);
      }
      if (!silencioso) toast(t('common.changesSaved'));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : t('editPost.saveFailed'));
      return false;
    } finally {
      setGuardando(false);
    }
  };

  /** Al llegar al último paso se guarda y se le pregunta al servidor qué falta. */
  const irARevisar = async () => {
    if (!id) return;
    if (!(await guardar(true))) return;
    setPaso('revisar');
    try {
      const respuesta = await LearningRepository.requirements(id);
      setRequisitos(respuesta);
      setReviewStatus(respuesta.reviewStatus);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('wizard.requirementsFailed'));
    }
  };

  const enviarARevision = async () => {
    if (!id) return;
    if (!(await guardar(true))) return;
    setGuardando(true);
    try {
      const respuesta = await LearningRepository.submitForReview(id);
      setReviewStatus(respuesta.reviewStatus);
      if (respuesta.submitted) {
        toast(t('wizard.sentForReview'));
        await cargar();
      } else {
        setRequisitos((anterior) =>
          anterior
            ? { ...anterior, ready: false, missing: respuesta.missing }
            : anterior,
        );
        notify(t('wizard.cannotSendYet'), respuesta.missing.join('\n'));
      }
    } catch (e) {
      notify(t('post.sendFailed'), e instanceof Error ? e.message : t('common.tryAgain'));
    } finally {
      setGuardando(false);
    }
  };

  const publicar = async () => {
    if (!id) return;
    if (!(await guardar(true))) return;
    setGuardando(true);
    try {
      const resultado = await LearningRepository.publish(id);
      if (resultado.published) {
        toast(t('course.published'));
        router.replace(`/course/${id}` as never);
      } else {
        setRequisitos((anterior) =>
          anterior ? { ...anterior, ready: false, missing: resultado.missing } : anterior,
        );
        notify(t('course.cannotPublishYet'), resultado.missing.join('\n'));
      }
    } catch (e) {
      notify(
        t('create.publishFailed'),
        e instanceof Error ? e.message : t('common.tryAgain'),
      );
    } finally {
      setGuardando(false);
    }
  };

  /**
   * Salir sin perder lo escrito: se pregunta y se guarda si se quiere.
   *
   * VA POR `enSerie` COMO LAS DEMAS. `guardando` es estado y no esta puesto
   * hasta el siguiente render, y esta es justo la funcion que ahora dispara la
   * tecla Atras: dos pulsaciones rapidas apilaban dos dialogos y, aceptando los
   * dos, subian la portada dos veces y guardaban el curso dos veces.
   */
  const salir = () =>
    enSerie(async () => {
      const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));
      const aceptado = await confirm({
        title: t('wizard.saveBeforeLeaving'),
        message: t('wizard.saveBeforeLeavingBody'),
        confirmLabel: t('wizard.saveAndLeave'),
        cancelLabel: t('wizard.leaveWithoutSaving'),
      });
      if (aceptado) {
        if (!(await guardar(true))) return;
      }
      volver();
    });

  /*
    EL ATRAS FISICO DE ANDROID TAMBIEN PASA POR `salir()`.

    Hasta ahora la pregunta de «¿guardo antes de salir?» colgaba solo del boton
    Atras de la cabecera. La tecla del telefono no pasa por ahi: la atendia la
    maquina de `navigation/atras.ts`, que veia una ruta anterior y volvia sin
    mas, y lo escrito en el paso actual se perdia sin avisar. Es la forma mas
    comun de salir de una pantalla en Android.

    `salir` se redefine en cada render —cierra sobre el borrador—, asi que se
    guarda en una referencia y el registro se hace UNA vez: el registro es una
    pila, y volver a montarlo en cada render lo subiria a la cima constantemente.
  */
  ultimoSalir.current = salir;
  useFocusEffect(
    // AL FOCO Y NO AL MONTAJE. Una pantalla de pila sigue MONTADA cuando se
    // navega por encima de ella, y el registro es una pila que no sabe quien
    // tiene el foco: `cerrarCapaSuperior` llama al ultimo registrado, se este
    // mirando o no. Atado al montaje, el Atras de otra pantalla acababa
    // ejecutando la despedida de este asistente, que ni siquiera se ve.
    useCallback(() => registrarSalidaPropia(() => void ultimoSalir.current()), []),
  );

  if (cargando) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title={t('catalog.editCourse')} />
        <StateView state="loading" />
      </View>
    );
  }

  if (fallo) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title={t('catalog.editCourse')} />
        <StateView state="error" description={fallo} onRetry={() => void cargar()} />
      </View>
    );
  }

  const indice = Math.max(0, PASOS.findIndex((p) => p.id === paso));
  const anterior = PASOS[indice - 1];
  const siguiente = PASOS[indice + 1];
  const aviso = avisoDeRevision(reviewStatus, motivoDeRechazo, t);
  const accion = accionFinal(requisitos?.reviewAvailable ?? false, reviewStatus);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title={t('catalog.editCourse')} onBack={() => void salir()} />

      {/*
        El indicador de pasos se desplaza en horizontal, así que va blindado:
        sin `SinCambioDeSeccion` el carrusel de secciones le robaría el gesto.
      */}
      <SinCambioDeSeccion>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.pasos}
          keyboardShouldPersistTaps="handled"
        >
          {PASOS.map((p, i) => {
            const activo = p.id === paso;
            const completo = pasoCompleto(p.id, borrador, modulos);
            return (
              <Pressable
                key={p.id}
                onPress={() => setPaso(p.id)}
                accessibilityRole="tab"
                accessibilityState={{ selected: activo }}
                accessibilityLabel={
                  completo
                    ? t('wizard.stepDoneA11y', { numero: i + 1, titulo: t(p.titulo) })
                    : t('wizard.stepA11y', { numero: i + 1, titulo: t(p.titulo) })
                }
                style={({ pressed }) => [
                  styles.paso,
                  {
                    borderColor: activo ? colors.primary : colors.border,
                    backgroundColor: activo ? colors.primary : 'transparent',
                    opacity: pressed ? 0.7 : 1,
                  },
                ]}
              >
                {/*
                  El estado NO va solo por color: el punto lleno o vacío y el
                  icono lo dicen igual para quien no distingue los tonos.
                */}
                <Feather
                  name={completo ? 'check-circle' : 'circle'}
                  size={14}
                  color={activo ? colors.onPrimary : colors.textMuted}
                />
                <Text
                  variant="caption"
                  weight="800"
                  color={activo ? colors.onPrimary : colors.text}
                >
                  {i + 1}. {t(p.titulo)}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </SinCambioDeSeccion>

      {/*
        El pie del asistente —«Publicar curso» y «Guardar y continuar»— es lo
        ultimo del contenido desplazable, asi que al escribir en cualquier campo
        el teclado se le ponia encima y no habia forma de llegar a el: aqui no
        habia nada que apartara el contenido. Es el mismo motivo por el que los
        botones de publicar quedaban tapados en los otros cinco flujos, solo que
        el estorbo aqui es el teclado y alli la barra flotante.

        `paddingBottom` sale de `useEspacioInferior`: fuera de las pestañas no
        hay capsula, pero si zona segura, y el boton no puede quedar pegado al
        indicador de inicio.
      */}
      <SinTecladoDelante>
      <AppScreen contentStyle={[styles.contenido, { paddingBottom: espacioInferior + spacing.xxxl }]}>
        {reviewStatus !== 'draft' ? (
          <View style={[styles.aviso, { borderColor: colors.border }]}>
            <Feather name={aviso.icono} size={16} color={colors.text} />
            <View style={styles.textoDeAviso}>
              <Text variant="secondary" weight="800">
                {aviso.titulo}
              </Text>
              <Text variant="caption" color={colors.textMuted}>
                {aviso.detalle}
              </Text>
            </View>
          </View>
        ) : null}

        {paso === 'basico' ? (
          <View>
            <Pressable
              onPress={() => void elegirPortada()}
              accessibilityRole="button"
              accessibilityLabel={t('wizard.pickCover')}
              style={[styles.portada, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}
            >
              <Feather name="image" size={20} color={colors.textMuted} />
              <Text variant="secondary" color={colors.textMuted} numberOfLines={1}>
                {portadaNueva?.name ??
                  (coverUrl ? t('wizard.changeCover') : t('wizard.pickCoverRatio'))}
              </Text>
            </Pressable>

            <Input
              label={t('catalog.courseName')}
              value={borrador.title}
              onChangeText={(title) => cambiar({ title })}
              placeholder={t('catalog.courseNameExample')}
              placeholderTextColor={colors.textMuted}
              style={{ color: colors.text }}
            />
            <Input
              label={t('wizard.subtitle')}
              value={borrador.subtitle}
              onChangeText={(subtitle) => cambiar({ subtitle })}
              placeholder={t('wizard.subtitleExample')}
              placeholderTextColor={colors.textMuted}
              style={{ color: colors.text }}
            />
            <Input
              label={t('lesson.description')}
              value={borrador.description}
              onChangeText={(description) => cambiar({ description })}
              placeholder={t('wizard.descriptionPlaceholder')}
              placeholderTextColor={colors.textMuted}
              multiline
              style={{ color: colors.text }}
            />

            <View style={styles.separador} />
            <SelectorDeCategoriaPrincipal
              valor={borrador.primaryTopicId}
              alCambiar={(primaryTopicId) =>
                cambiar({
                  primaryTopicId,
                  topicIds: temasAlElegirCategoria(borrador.topicIds, primaryTopicId),
                })
              }
            />

            <Text variant="caption" weight="800" color={colors.textMuted} style={styles.etiqueta}>
              {t('wizard.level')}
            </Text>
            <SegmentedControl
              options={CLAVES_DE_NIVEL.map((clave) => t(clave))}
              selectedIndex={NIVELES.indexOf((borrador.level ?? '') as (typeof NIVELES)[number])}
              onChange={(i) => cambiar({ level: NIVELES[i] })}
            />

            <Text variant="caption" weight="800" color={colors.textMuted} style={styles.etiqueta}>
              {t('wizard.language')}
            </Text>
            <SegmentedControl
              options={CLAVES_DE_IDIOMA.map((clave) => t(clave))}
              selectedIndex={Math.max(0, IDIOMAS.indexOf(borrador.language as (typeof IDIOMAS)[number]))}
              onChange={(i) => cambiar({ language: IDIOMAS[i] })}
            />

            <View style={styles.separador} />
            <SelectorDeTemas
              seleccionados={borrador.topicIds}
              alCambiar={(topicIds) => cambiar({ topicIds })}
              para="curso"
              // Cinco SIEMPRE: la categoría principal va aparte y no descuenta.
              maximo={maximoDeTemas(borrador.primaryTopicId)}
            />
          </View>
        ) : null}

        {paso === 'oferta' ? (
          <View>
            <EditorDeFrases
              etiqueta={t('preview.whatYouLearn')}
              ayuda={t('wizard.highlightsHelp')}
              valores={borrador.highlights}
              alCambiar={(highlights) => cambiar({ highlights })}
              marcador={t('wizard.highlightsExample')}
            />
            <EditorDeFrases
              etiqueta={t('preview.whoFor')}
              ayuda={t('wizard.audienceHelp')}
              valores={borrador.targetAudience}
              alCambiar={(targetAudience) => cambiar({ targetAudience })}
              marcador={t('wizard.audienceExample')}
            />
            <EditorDeFrases
              etiqueta={t('preview.prerequisites')}
              ayuda={t('wizard.prerequisitesHelp')}
              valores={borrador.prerequisites}
              alCambiar={(prerequisites) => cambiar({ prerequisites })}
              marcador={t('review.none')}
            />
          </View>
        ) : null}

        {paso === 'contenido' && id ? (
          <View>
            <Text variant="secondary" color={colors.textMuted} style={styles.ayuda}>
              {t('wizard.contentHelp')}
            </Text>
            <EditorDeContenido
              courseId={id}
              alCambiar={(contenido) =>
                setModulos(
                  contenido.map((m) => ({
                    id: m.id,
                    lessons: m.lessons.map((l) => ({
                      id: l.id,
                      durationSeconds: l.durationSeconds,
                    })),
                  })),
                )
              }
            />
            <Text variant="caption" color={colors.textMuted} style={styles.ayuda}>
              {t('wizard.totalLength', { duracion: duracionLegible(duracionTotal(modulos), t) })}
            </Text>
          </View>
        ) : null}

        {paso === 'precio' ? (
          <View>
            <Text variant="caption" weight="800" color={colors.textMuted} style={styles.etiqueta}>
              {t('wizard.accessType')}
            </Text>
            <SegmentedControl
              options={[t('catalog.free'), t('catalog.paid')]}
              selectedIndex={borrador.dePago ? 1 : 0}
              onChange={(i) => cambiar({ dePago: i === 1 })}
            />
            {borrador.dePago ? (
              <>
                <Input
                  label={t('wizard.priceIn', { moneda: currency })}
                  value={borrador.precio}
                  onChangeText={(precio) => cambiar({ precio })}
                  placeholder="49.90"
                  keyboardType="decimal-pad"
                  placeholderTextColor={colors.textMuted}
                  style={{ color: colors.text }}
                />
                <Text variant="caption" color={colors.textMuted} style={styles.ayuda}>
                  {t('wizard.markFreeSample')}
                </Text>
                {!FEATURE_PURCHASES ? (
                  <Text variant="caption" color={colors.textMuted} style={styles.ayuda}>
                    {t('catalog.salesDisabled')}
                  </Text>
                ) : null}
              </>
            ) : (
              <Text variant="caption" color={colors.textMuted} style={styles.ayuda}>
                {t('wizard.freeCourseNote')}
              </Text>
            )}
          </View>
        ) : null}

        {paso === 'revisar' ? (
          <View>
            <Text variant="secondary" color={colors.textMuted} style={styles.ayuda}>
              {t('wizard.previewHelp')}
            </Text>
            <VistaPreviaDeCurso
              borrador={borrador}
              modulos={modulos}
              coverUrl={coverUrl}
              currency={currency}
              precioEnCentavos={precioEnCentavos ?? 0}
            />

            {requisitos && !requisitos.ready ? (
              <View style={[styles.pendientes, { borderColor: colors.border }]}>
                <Text variant="secondary" weight="800">
                  {t('wizard.beforeSending')}
                </Text>
                {/*
                  Estas frases las escribe el SERVIDOR: son las mismas reglas que
                  aplica al publicar. Reescribirlas aquí sería tener dos listas
                  que un día dicen cosas distintas.
                */}
                {requisitos.missing.map((frase) => (
                  <View key={frase} style={styles.pendiente}>
                    <Feather name="alert-circle" size={14} color={colors.text} />
                    <Text variant="caption" style={styles.textoPendiente}>
                      {frase}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}

            {requisitos?.ready ? (
              <View style={[styles.pendientes, { borderColor: colors.border }]}>
                <View style={styles.pendiente}>
                  <Feather name="check-circle" size={14} color={colors.text} />
                  <Text variant="caption" style={styles.textoPendiente}>
                    {accion === 'enviar'
                      ? t('wizard.readyToSend')
                      : accion === 'publicar'
                      ? t('wizard.readyToPublish')
                      : t('wizard.readyWaiting')}
                  </Text>
                </View>
              </View>
            ) : null}
          </View>
        ) : null}

        <InlineError message={error} />

        <View style={styles.pie}>
          {anterior ? (
            <Button
              label={t('wizard.back')}
              variant="secondary"
              onPress={() => setPaso(anterior.id)}
              style={styles.mitad}
            />
          ) : null}

          {paso === 'revisar' ? (
            accion === 'esperar' ? (
              <Button
                label={t('wizard.reviewPending')}
                variant="secondary"
                disabled
                onPress={() => {}}
                style={styles.mitad}
              />
            ) : (
              <Button
                label={accion === 'publicar' ? t('course.publish') : t('wizard.sendForReview')}
                loading={guardando}
                onPress={() =>
                  void enSerie(accion === 'publicar' ? publicar : enviarARevision)
                }
                style={styles.mitad}
              />
            )
          ) : siguiente ? (
            <Button
              label={t('wizard.saveAndContinue')}
              loading={guardando}
              onPress={() =>
                void enSerie(() =>
                  siguiente.id === 'revisar'
                    ? irARevisar()
                    : guardar().then((bien) => {
                        if (bien) setPaso(siguiente.id);
                      }),
                )
              }
              style={styles.mitad}
            />
          ) : null}
        </View>
      </AppScreen>
      </SinTecladoDelante>
    </View>
  );
}

const styles = StyleSheet.create({
  pasos: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  paso: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 40,
  },
  // `paddingBottom` lo completa la pantalla: depende de la zona segura.
  contenido: { padding: spacing.lg },
  aviso: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  textoDeAviso: { flex: 1, gap: 2 },
  portada: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  separador: { height: spacing.lg },
  etiqueta: { letterSpacing: 1, marginTop: spacing.lg, marginBottom: spacing.sm },
  ayuda: { marginTop: spacing.md, lineHeight: 18 },
  pendientes: {
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginTop: spacing.lg,
  },
  pendiente: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  textoPendiente: { flex: 1, lineHeight: 18 },
  pie: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.xl },
  mitad: { flex: 1 },
});
