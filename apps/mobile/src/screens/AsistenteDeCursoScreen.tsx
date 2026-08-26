import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
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
import { SinCambioDeSeccion } from '@/navigation/tabSwipe';
import { LearningRepository, type RequisitosDeCurso } from '@/repositories/LearningRepository';
import { pickImage, signMediaUrls, uploadPostMedia, type PickedMedia } from '@/services/storage';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const NIVELES = ['beginner', 'intermediate', 'advanced'] as const;
const NOMBRES_DE_NIVEL = ['Inicial', 'Intermedio', 'Avanzado'];
const IDIOMAS = ['es', 'en', 'pt'] as const;
const NOMBRES_DE_IDIOMA = ['Español', 'Inglés', 'Português'];

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
  const { colors } = useAppTheme();
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
      setFallo('Curso no encontrado.');
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
        setFallo('No puedes editar este curso.');
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
      setFallo(e instanceof Error ? e.message : 'No se pudo cargar el curso.');
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
    const leido = aCentavos(borrador.precio);
    return leido.ok ? leido.centavos : null;
  }, [borrador.dePago, borrador.precio]);

  const cambiar = (cambios: Partial<BorradorDeCurso>) =>
    setBorrador((anterior) => ({ ...anterior, ...cambios }));

  const elegirPortada = async () => {
    try {
      const elegida = await pickImage({ allowsEditing: false });
      if (elegida) setPortadaNueva(elegida);
    } catch {
      setError('No se pudo abrir la galería.');
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
      const leido = aCentavos(borrador.precio);
      if (!leido.ok) {
        setError(leido.motivo);
        setPaso('precio');
        return false;
      }
      if (leido.centavos === 0) {
        setError('Un curso de pago necesita un precio mayor que cero.');
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
      if (!silencioso) toast('Cambios guardados');
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar.');
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
      setError(e instanceof Error ? e.message : 'No se pudieron comprobar los requisitos.');
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
        toast('Enviado a revisión');
        await cargar();
      } else {
        setRequisitos((anterior) =>
          anterior
            ? { ...anterior, ready: false, missing: respuesta.missing }
            : anterior,
        );
        notify('Todavía no se puede enviar', respuesta.missing.join('\n'));
      }
    } catch (e) {
      notify('No se pudo enviar', e instanceof Error ? e.message : 'Inténtalo de nuevo.');
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
        toast('Curso publicado');
        router.replace(`/course/${id}` as never);
      } else {
        setRequisitos((anterior) =>
          anterior ? { ...anterior, ready: false, missing: resultado.missing } : anterior,
        );
        notify('Todavía no se puede publicar', resultado.missing.join('\n'));
      }
    } catch (e) {
      notify('No se pudo publicar', e instanceof Error ? e.message : 'Inténtalo de nuevo.');
    } finally {
      setGuardando(false);
    }
  };

  /** Salir sin perder lo escrito: se pregunta y se guarda si se quiere. */
  const salir = async () => {
    const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));
    if (guardando) return;
    const aceptado = await confirm({
      title: 'Guardar antes de salir',
      message: 'Tus cambios se guardan en el borrador del curso.',
      confirmLabel: 'Guardar y salir',
      cancelLabel: 'Salir sin guardar',
    });
    if (aceptado) {
      if (!(await guardar(true))) return;
    }
    volver();
  };

  if (cargando) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="Editar curso" />
        <StateView state="loading" />
      </View>
    );
  }

  if (fallo) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="Editar curso" />
        <StateView state="error" description={fallo} onRetry={() => void cargar()} />
      </View>
    );
  }

  const indice = Math.max(0, PASOS.findIndex((p) => p.id === paso));
  const anterior = PASOS[indice - 1];
  const siguiente = PASOS[indice + 1];
  const aviso = avisoDeRevision(reviewStatus, motivoDeRechazo);
  const accion = accionFinal(requisitos?.reviewAvailable ?? false, reviewStatus);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="Editar curso" onBack={() => void salir()} />

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
                accessibilityLabel={`Paso ${i + 1}: ${p.titulo}${completo ? ', completo' : ''}`}
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
                  {i + 1}. {p.titulo}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </SinCambioDeSeccion>

      <AppScreen contentStyle={styles.contenido}>
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
              accessibilityLabel="Elegir portada del curso"
              style={[styles.portada, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}
            >
              <Feather name="image" size={20} color={colors.textMuted} />
              <Text variant="secondary" color={colors.textMuted} numberOfLines={1}>
                {portadaNueva?.name ?? (coverUrl ? 'Cambiar la portada' : 'Elegir portada (16:9)')}
              </Text>
            </Pressable>

            <Input
              label="Nombre del curso"
              value={borrador.title}
              onChangeText={(title) => cambiar({ title })}
              placeholder="Liderazgo consciente"
              placeholderTextColor={colors.textMuted}
              style={{ color: colors.text }}
            />
            <Input
              label="Una línea que lo resuma (opcional)"
              value={borrador.subtitle}
              onChangeText={(subtitle) => cambiar({ subtitle })}
              placeholder="Dirigir sin apagarte"
              placeholderTextColor={colors.textMuted}
              style={{ color: colors.text }}
            />
            <Input
              label="Descripción"
              value={borrador.description}
              onChangeText={(description) => cambiar({ description })}
              placeholder="De qué trata y por qué merece la pena"
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
              NIVEL
            </Text>
            <SegmentedControl
              options={[...NOMBRES_DE_NIVEL]}
              selectedIndex={NIVELES.indexOf((borrador.level ?? '') as (typeof NIVELES)[number])}
              onChange={(i) => cambiar({ level: NIVELES[i] })}
            />

            <Text variant="caption" weight="800" color={colors.textMuted} style={styles.etiqueta}>
              IDIOMA
            </Text>
            <SegmentedControl
              options={[...NOMBRES_DE_IDIOMA]}
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
              etiqueta="Lo que aprenderás"
              ayuda="Qué sabrá hacer alguien al terminarlo. Es lo que más se lee de la ficha."
              valores={borrador.highlights}
              alCambiar={(highlights) => cambiar({ highlights })}
              marcador="Tomar decisiones difíciles sin quemarte"
            />
            <EditorDeFrases
              etiqueta="Para quién es"
              ayuda="A quién le sirve. Decirlo evita que lo empiece quien no debería."
              valores={borrador.targetAudience}
              alCambiar={(targetAudience) => cambiar({ targetAudience })}
              marcador="Quien acaba de empezar a liderar un equipo"
            />
            <EditorDeFrases
              etiqueta="Qué necesitas antes"
              ayuda="Qué hace falta saber o tener. Si no hace falta nada, déjalo vacío."
              valores={borrador.prerequisites}
              alCambiar={(prerequisites) => cambiar({ prerequisites })}
              marcador="Ninguno"
            />
          </View>
        ) : null}

        {paso === 'contenido' && id ? (
          <View>
            <Text variant="secondary" color={colors.textMuted} style={styles.ayuda}>
              Los módulos son los bloques del curso y dentro van las lecciones.
              Puedes reordenarlos en cualquier momento.
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
              Duración total: {duracionLegible(duracionTotal(modulos))}
            </Text>
          </View>
        ) : null}

        {paso === 'precio' ? (
          <View>
            <Text variant="caption" weight="800" color={colors.textMuted} style={styles.etiqueta}>
              TIPO DE ACCESO
            </Text>
            <SegmentedControl
              options={['Gratuito', 'De pago']}
              selectedIndex={borrador.dePago ? 1 : 0}
              onChange={(i) => cambiar({ dePago: i === 1 })}
            />
            {borrador.dePago ? (
              <>
                <Input
                  label={`Precio (${currency})`}
                  value={borrador.precio}
                  onChangeText={(precio) => cambiar({ precio })}
                  placeholder="49.90"
                  keyboardType="decimal-pad"
                  placeholderTextColor={colors.textMuted}
                  style={{ color: colors.text }}
                />
                <Text variant="caption" color={colors.textMuted} style={styles.ayuda}>
                  Marca al menos una lección como muestra gratuita para que se
                  pueda probar antes de comprar, y deja el resto cerrado: una
                  compra tiene que desbloquear algo real.
                </Text>
                {!FEATURE_PURCHASES ? (
                  <Text variant="caption" color={colors.textMuted} style={styles.ayuda}>
                    El precio queda configurado. Las ventas todavía no están
                    habilitadas, así que nadie podrá comprarlo aún.
                  </Text>
                ) : null}
              </>
            ) : (
              <Text variant="caption" color={colors.textMuted} style={styles.ayuda}>
                Cualquiera con cuenta podrá empezarlo. En un curso gratuito no
                tiene sentido marcar lecciones como muestra: ya se abren todas.
              </Text>
            )}
          </View>
        ) : null}

        {paso === 'revisar' ? (
          <View>
            <Text variant="secondary" color={colors.textMuted} style={styles.ayuda}>
              Así se verá tu curso. Repásalo antes de enviarlo.
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
                  Antes de enviarlo
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
                    No falta nada. {accion === 'enviar'
                      ? 'Puedes enviarlo a revisión.'
                      : accion === 'publicar'
                      ? 'Puedes publicarlo.'
                      : 'Está en manos del equipo.'}
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
              label="Atrás"
              variant="secondary"
              onPress={() => setPaso(anterior.id)}
              style={styles.mitad}
            />
          ) : null}

          {paso === 'revisar' ? (
            accion === 'esperar' ? (
              <Button
                label="En revisión"
                variant="secondary"
                disabled
                onPress={() => {}}
                style={styles.mitad}
              />
            ) : (
              <Button
                label={accion === 'publicar' ? 'Publicar curso' : 'Enviar a revisión'}
                loading={guardando}
                onPress={() => void (accion === 'publicar' ? publicar() : enviarARevision())}
                style={styles.mitad}
              />
            )
          ) : siguiente ? (
            <Button
              label="Guardar y continuar"
              loading={guardando}
              onPress={() =>
                void (siguiente.id === 'revisar'
                  ? irARevisar()
                  : guardar().then((bien) => {
                      if (bien) setPaso(siguiente.id);
                    }))
              }
              style={styles.mitad}
            />
          ) : null}
        </View>
      </AppScreen>
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
  contenido: { padding: spacing.lg, paddingBottom: spacing.xxxl },
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
