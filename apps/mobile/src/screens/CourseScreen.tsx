import React, { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { CoachMark } from '@/components/CoachMark';
import { CourseContentEditor } from '@/components/CourseContentEditor';
import { CourseHighlights } from '@/components/CourseHighlights';
import { StateView } from '@/components/StateView';
import { esMovil, explicar, ofertaPara, comprarEnTienda, restaurarCompras } from '@/services/compras';
import type { OfertaDeCompra } from '@/services/compras';
import { CommerceRepository } from '@/repositories/PaymentRepository';
import { confirm, notify } from '@/lib/confirm';
import * as WebBrowser from 'expo-web-browser';
import { etiquetaDePrecio } from '@/lib/dinero';
import { toast } from '@/lib/toast';
import { LearningRepository } from '@/repositories/LearningRepository';
import { assets } from '@/data/assets';
import { useCourse } from '@/hooks/useCourse';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function CourseScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const { course, lessons, canManage, hasAccess, loading, error, reload } = useCourse(id);
  // Primera leccion sin completar; si estan todas, la primera del curso.
  const siguiente = lessons.find((l) => !l.completed) ?? lessons[0];
  const firstLessonId = siguiente?.id;
  const empezado = lessons.some((l) => l.completed || l.progressSeconds > 0);
  const [enrolling, setEnrolling] = useState(false);
  const [publicando, setPublicando] = useState(false);
  /**
   * Que se puede comprar aqui, segun el SERVIDOR y la TIENDA. `null` mientras
   * se averigua: hasta saberlo no se pinta ningun boton de compra, porque un
   * boton que aparece y luego resulta imposible es peor que esperar medio
   * segundo.
   */
  const [oferta, setOferta] = useState<OfertaDeCompra | null>(null);
  const [comprando, setComprando] = useState(false);

  const esDePago = (course?.priceMinor ?? 0) > 0;
  const borrador = course?.status === 'draft';
  const retirado = course?.status === 'hidden';

  /**
   * Se pregunta que hay a la venta solo cuando hace falta: curso de pago y sin
   * acceso todavia. Para un curso gratis, o para quien ya lo tiene, no hay
   * nada que consultar y se ahorra la llamada.
   */
  React.useEffect(() => {
    let vigente = true;
    if (!course || !esDePago || hasAccess) {
      setOferta(null);
      return;
    }
    void ofertaPara(course.id).then((resultado) => {
      if (vigente) setOferta(resultado);
    });
    return () => {
      vigente = false;
    };
  }, [course, esDePago, hasAccess]);

  /**
   * Comprar. En movil lo cobra la tienda; en web, Stripe Checkout alojado.
   *
   * Cancelar NO ensena ningun error: que alguien abra el dialogo de la tienda
   * y se lo piense es una decision normal, no un fallo.
   */
  const comprar = async () => {
    if (!course || !oferta?.sePuedeComprar) return;
    setComprando(true);
    try {
      if (oferta.plataforma === 'web') {
        const { checkoutUrl } = await CommerceRepository.stripeCheckout(course.id);
        await WebBrowser.openBrowserAsync(checkoutUrl);
        // Al volver del navegador no se sabe nada: quien concede es el webhook
        // de Stripe. Se recarga para leer el acceso que el servidor ya tenga.
        reload();
        return;
      }
      if (!oferta.productoDeTienda) return;
      const resultado = await comprarEnTienda(oferta.productoDeTienda);
      if (resultado.estado === 'cancelada') return;
      if (resultado.estado === 'error') {
        notify('No se pudo completar la compra', resultado.mensaje);
        return;
      }
      if (resultado.estado === 'pendiente_de_sincronizar') {
        // La compra NO se ha perdido: esta en la tienda. Decirle a quien acaba
        // de pagar que «no se ha podido comprar» seria mentira y ademas un
        // susto.
        notify(
          'Compra recibida',
          'Estamos activando tu acceso. Si no aparece en un momento, usa ' +
            '«Restaurar compras».',
        );
        reload();
        return;
      }
      toast('Curso comprado');
      reload();
    } catch (e) {
      notify('No se pudo completar la compra', e instanceof Error ? e.message : 'Inténtalo de nuevo.');
    } finally {
      setComprando(false);
    }
  };

  /**
   * Restaurar compras. OBLIGATORIO en movil.
   *
   * Sin esto, quien reinstale o cambie de telefono no puede recuperar lo que
   * pago, y las tiendas lo exigen.
   */
  const restaurar = async () => {
    setComprando(true);
    try {
      const resultado = await restaurarCompras();
      if (resultado.estado === 'comprada') {
        toast('Compras restauradas');
        reload();
      } else if (resultado.estado === 'error') {
        notify('No se pudieron restaurar', resultado.mensaje);
      } else {
        notify('Casi', 'Estamos comprobando tus compras. Inténtalo de nuevo en un momento.');
      }
    } finally {
      setComprando(false);
    }
  };

  /**
   * Inscribe y abre la leccion por la que iba.
   *
   * La inscripcion se registra en el servidor: sin ella el progreso no se
   * guarda y se pierde al reinstalar. Un curso de PAGO no se puede inscribir
   * —el servidor lo rechaza, y hace bien— asi que ahi solo se abre.
   */
  const startCourse = async () => {
    if (!firstLessonId || !course) return;
    setEnrolling(true);
    try {
      if (!esDePago) await LearningRepository.enroll(course.id);
    } catch {
      // Se reintenta al avanzar por las lecciones.
    } finally {
      setEnrolling(false);
    }
    router.push(`/lesson/${firstLessonId}` as never);
  };

  /**
   * Publicar. La validacion la hace el SERVIDOR y aqui solo se ensena lo que
   * dijo que falta: repetir las reglas en la pantalla garantiza que un dia
   * digan cosas distintas.
   */
  const publicar = async () => {
    if (!course) return;
    setPublicando(true);
    try {
      const resultado = await LearningRepository.publish(course.id);
      if (resultado.published) {
        toast('Curso publicado');
        reload();
      } else {
        notify('Todavía no se puede publicar', resultado.missing.join('\n'));
      }
    } catch (e) {
      notify('No se pudo publicar', e instanceof Error ? e.message : 'Inténtalo de nuevo.');
    } finally {
      setPublicando(false);
    }
  };

  const retirar = async () => {
    if (!course) return;
    const aceptado = await confirm({
      title: 'Retirar del catálogo',
      message:
        'Dejará de aparecer para los demás. No se borra nada: sus módulos, ' +
        'lecciones y el progreso de quien lo empezó siguen ahí.',
      confirmLabel: 'Retirar',
    });
    if (!aceptado) return;
    try {
      await LearningRepository.unpublish(course.id);
      toast('Curso retirado');
      reload();
    } catch (e) {
      notify('No se pudo retirar', e instanceof Error ? e.message : 'Inténtalo de nuevo.');
    }
  };

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="Programa" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <StateView state="loading" />
      </View>
    );
  }

  if (error || !course) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="Programa" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <StateView state="error" description={error ?? undefined} onRetry={reload} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title="Programa"
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        /*
          Editar abre el ASISTENTE, no una hoja.

          La ficha de un curso dejo de caber en un BottomSheet: son cuatro
          decisiones distintas —que es, que ofrece, que contiene y cuanto
          cuesta— mas la vista previa y el envio a revision. En una hoja de 460
          puntos de alto eso se rellenaba a medias y se abandonaba.
        */
        rightIcon={canManage ? 'edit-2' : undefined}
        onRightPress={canManage ? () => router.push(`/editar-curso/${course?.id}` as never) : undefined}
      />
      <AppScreen contentStyle={{ paddingBottom: spacing.xl }}>
        {/* Portada real del curso; el asset local solo mientras no tenga. */}
        <Image
          source={course.coverUrl ? { uri: course.coverUrl } : assets.course}
          style={[styles.hero, { borderColor: colors.border }]}
        />
        <View style={styles.container}>
          {/*
            El estado, y solo para quien puede cambiarlo. Un borrador no lo ve
            nadie mas, asi que anunciarlo al alumno seria hablarle de algo que
            no existe para el.
          */}
          {canManage && (borrador || retirado) ? (
            <View style={[styles.estado, { borderColor: colors.border }]}>
              <Feather name={borrador ? 'edit-3' : 'eye-off'} size={12} color={colors.textMuted} />
              <Text style={[styles.estadoTexto, { color: colors.textMuted }]}>
                {borrador ? 'Borrador — solo lo ves tú' : 'Retirado del catálogo'}
              </Text>
            </View>
          ) : null}

          <Text style={[styles.title, { color: colors.text }]}>{course.title}</Text>

          {/*
            EL PRECIO DICE LA VERDAD. Antes ponia «Incluido en tu membresía»
            para todo el mundo, y no existe ninguna membresia en el backend: ni
            tabla, ni suscripcion, ni derecho de acceso que se llame asi. Un
            curso gratis pone «Gratis» y uno de pago pone lo que cuesta.
          */}
          <View style={[styles.acceso, { borderColor: colors.border }]}>
            <Feather name={esDePago ? 'tag' : 'unlock'} size={14} color={colors.text} />
            <Text style={[styles.accesoTexto, { color: colors.text }]}>
              {etiquetaDePrecio(course.priceMinor, course.currency)}
            </Text>
          </View>
          {/*
            EL BLOQUE DE COMPRA. La regla es que SIEMPRE diga algo: o se puede
            comprar y se ensena el precio, o no se puede y se explica por que.
            Un boton desactivado sin explicacion es lo mismo que un boton
            muerto, y un boton muerto es motivo de rechazo (directriz 2.1)
            ademas de una promesa falsa.

            El precio que se ensena en movil es el de la TIENDA —localizado,
            con la moneda y los impuestos del pais de la cuenta—, no
            `price_minor`: ese es referencia de catalogo y precio web, y
            mostrarlo aqui ensenaria un numero distinto del que se va a cobrar.
          */}
          {esDePago && !hasAccess && oferta ? (
            oferta.sePuedeComprar ? (
              <Text style={[styles.notaDeAcceso, { color: colors.text }]}>
                {`Precio: ${oferta.precio}`}
              </Text>
            ) : (
              <Text style={[styles.notaDeAcceso, { color: colors.textMuted }]}>
                {explicar(oferta.motivo)}
              </Text>
            )
          ) : null}

          <Text style={[styles.description, { color: colors.textMuted }]}>{course.description}</Text>

          {/*
            Solo hechos que salen de la base de datos. Antes aqui ponia
            «Plantillas y ejercicios» y «Comunidad privada» para todos los
            cursos, existieran o no.
          */}
          <View style={[styles.info, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Info icon="book" label={`${course.modules} módulos`} />
            <Info icon="play-circle" label={`${course.lessons} lecciones`} />
            {course.comingSoon ? <Info icon="clock" label="Próximamente" /> : null}
          </View>

          <CourseHighlights courseId={course.id} canEdit={canManage} />

          {/*
            Guia hacia el temario. Para quien lo gestiona sobra: ese bloque es
            su editor y ya lo conoce.
          */}
          <CoachMark
            id="curso-temario"
            arrow="down"
            visible={!canManage && !!firstLessonId}
            text="Abre la primera lección del temario."
            onPress={() => firstLessonId && router.push(`/lesson/${firstLessonId}` as never)}
          />

          <View style={styles.contentBlock}>
            <CourseContentEditor
              courseId={course.id}
              canEdit={canManage}
              onOpenLesson={(lessonId) => router.push(`/lesson/${lessonId}` as never)}
              // Los contadores de arriba ("X modulos, Y lecciones") vienen del
              // detalle del curso, que se pide una sola vez al montar. Sin esto
              // seguian en 0 despues de anadir contenido.
              onChanged={reload}
            />
          </View>

          {/*
            La llamada a la accion, en sus tres estados:
              - gratis            -> «Empezar curso»
              - de pago con acceso -> «Continuar curso»
              - de pago sin acceso -> «Comprar curso», y solo si de verdad se
                puede comprar. Si no, no hay boton: hay la explicacion de
                arriba.
          */}
          {esDePago && !hasAccess ? (
            oferta?.sePuedeComprar ? (
              <Button
                label={comprando ? 'Procesando…' : 'Comprar curso'}
                disabled={comprando}
                loading={comprando}
                onPress={() => void comprar()}
                style={{ marginTop: spacing.xl }}
              />
            ) : null
          ) : (
            <Button
              label={
                enrolling
                  ? 'Abriendo…'
                  : esDePago || empezado
                    ? 'Continuar curso'
                    : 'Empezar curso'
              }
              // Antes abria siempre '/lesson/1', un id de demo: con datos reales
              // llevaba a una leccion inexistente. Ahora va a la que toca.
              disabled={!firstLessonId || enrolling}
              loading={enrolling}
              onPress={() => void startCourse()}
              style={{ marginTop: spacing.xl }}
            />
          )}

          {/*
            Restaurar compras. Obligatorio en movil y visible cuando hace
            falta: quien reinstala o cambia de telefono llega justo aqui, a un
            curso que pago y que no puede abrir.
          */}
          {esDePago && !hasAccess && esMovil() ? (
            <Pressable
              onPress={() => void restaurar()}
              disabled={comprando}
              style={styles.retirar}
              accessibilityRole="button"
              accessibilityLabel="Restaurar compras"
            >
              <Feather name="refresh-cw" size={14} color={colors.textMuted} />
              <Text style={{ color: colors.textMuted, fontSize: 13, fontWeight: '700' }}>
                Restaurar compras
              </Text>
            </Pressable>
          ) : null}

          {/* Publicar y retirar, solo para quien gestiona el curso. */}
          {canManage ? (
            borrador || retirado ? (
              <Button
                label="Publicar curso"
                variant="secondary"
                loading={publicando}
                onPress={() => void publicar()}
                style={{ marginTop: spacing.md }}
              />
            ) : (
              <Pressable
                onPress={() => void retirar()}
                style={styles.retirar}
                accessibilityRole="button"
                accessibilityLabel="Retirar del catálogo"
              >
                <Feather name="eye-off" size={14} color={colors.textMuted} />
                <Text style={{ color: colors.textMuted, fontSize: 13, fontWeight: '700' }}>
                  Retirar del catálogo
                </Text>
              </Pressable>
            )
          ) : null}
        </View>
      </AppScreen>

    </View>
  );
}

function Info({ icon, label }: { icon: keyof typeof Feather.glyphMap; label: string }) {
  const { colors } = useAppTheme();
  return (
    <View style={styles.infoRow}>
      <Feather name={icon} size={20} color={colors.text} />
      <Text style={{ color: colors.textMuted, fontSize: 13 }}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // 16:9 en vez de 1.1: una portada panoramica se recortaba de forma agresiva
  // en un lienzo casi cuadrado. Este ratio respeta mejor la imagen que se sube.
  hero: { width: '100%', aspectRatio: 16 / 9, resizeMode: 'cover' },
  container: { padding: spacing.xl },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '900' },
  estado: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    marginBottom: spacing.md,
  },
  estadoTexto: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  acceso: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    marginTop: spacing.md,
  },
  accesoTexto: { fontSize: 13, fontWeight: '800' },
  notaDeAcceso: { fontSize: 12, lineHeight: 17, marginTop: spacing.sm },
  description: { fontSize: 14, lineHeight: 21, marginTop: spacing.md },
  info: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.lg, gap: spacing.md, marginVertical: spacing.xl },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  contentBlock: { marginTop: spacing.xl },
  retirar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.lg,
    marginTop: spacing.sm,
  },
});
