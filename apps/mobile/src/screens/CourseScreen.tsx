import React, { useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { CoachMark } from '@/components/CoachMark';
import { CourseContentEditor } from '@/components/CourseContentEditor';
import { CondicionesDeCompra } from '@/components/CondicionesDeCompra';
import { CourseHighlights } from '@/components/CourseHighlights';
import { FichaDelCurso } from '@/components/FichaDelCurso';
import { StateView } from '@/components/StateView';
import { TarjetaDeGarantia } from '@/components/TarjetaDeGarantia';
import { ValoracionesDelCurso } from '@/components/valoraciones/ValoracionesDelCurso';
import { esMovil, explicar, ofertaPara, comprarEnTienda, restaurarCompras } from '@/services/compras';
import type { OfertaDeCompra } from '@/services/compras';
import { CommerceRepository, DevolucionesRepository } from '@/repositories/PaymentRepository';
import type { AvisoDeRecompra } from '@/repositories/PaymentRepository';
import { confirm, notify } from '@/lib/confirm';
import * as WebBrowser from 'expo-web-browser';
import { etiquetaDePrecio } from '@/lib/dinero';
import { irAlPerfil } from '@/lib/irAlPerfil';
import { toast } from '@/lib/toast';
import { LearningRepository } from '@/repositories/LearningRepository';
import type { AccesoDeBeta } from '@/repositories/LearningRepository';
import { assets } from '@/data/assets';
import { useCourse } from '@/hooks/useCourse';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

export function CourseScreen() {
  const { t } = useTranslation();
  // Claves todavia fuera del diccionario (ver `hooks/useGarantia.ts`).
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const {
    course,
    lessons,
    canManage,
    hasAccess,
    progressPercent,
    durationSecondsTotal,
    loading,
    error,
    reload,
  } = useCourse(id);
  // Primera leccion sin completar; si estan todas, la primera del curso.
  const siguiente = lessons.find((l) => !l.completed) ?? lessons[0];
  const firstLessonId = siguiente?.id;
  const empezado = lessons.some((l) => l.completed || l.progressSeconds > 0);
  // Un conjunto y no un `find` por fila: el temario lo consulta una vez por
  // leccion y con una lista larga eso es cuadratico.
  const completadas = React.useMemo(
    () => new Set(lessons.filter((l) => l.completed).map((l) => l.id)),
    [lessons],
  );
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
  /**
   * Si este curso se puede pedir GRATIS durante la Beta. Lo decide el servidor
   * y por eso se pregunta: el interruptor vive alli, asi que apagarlo tiene que
   * hacer desaparecer el boton sin publicar una version nueva de la aplicacion.
   * `null` mientras se averigua, por lo mismo que la oferta de compra.
   */
  const [beta, setBeta] = useState<AccesoDeBeta | null>(null);
  const [pidiendoBeta, setPidiendoBeta] = useState(false);
  /**
   * RECOMPRA SIN GARANTIA.
   *
   * Quien ya uso la garantia de este curso vuelve a poder comprarlo, pero
   * tiene que saber ANTES de pagar que esta compra no admite otra devolucion.
   * El texto y la fecha vienen del SERVIDOR: escritos aqui cambiarian con cada
   * despliegue y las aceptaciones antiguas apuntarian a una redaccion que ya
   * no existe, con lo que «lo acepto» no significaria nada.
   *
   * `null` mientras se averigua, igual que la oferta: no se pinta ningun boton
   * de compra hasta saber si hay una puerta delante.
   */
  const [avisoDeRecompra, setAvisoDeRecompra] = useState<AvisoDeRecompra | null>(null);
  const [aceptaLaRecompra, setAceptaLaRecompra] = useState(false);
  /**
   * No se pudo preguntar si esta compra necesita aceptacion.
   *
   * ES UN TERCER ESTADO, y hace falta: `avisoDeRecompra === null` significaba a
   * la vez «no hace falta aceptar nada» y «no se ha podido averiguar». El
   * `catch` devolvia `null` y la ficha caia en el boton de comprar de siempre,
   * sin casilla y sin aviso, justo en el caso en el que no sabemos si hace
   * falta. El servidor sigue rechazando la compra —la proteccion de verdad esta
   * ahi—, pero la persona se llevaba un error sin explicacion despues de pulsar.
   */
  const [falloDelAviso, setFalloDelAviso] = useState(false);
  /** Sube al reintentar: es lo que vuelve a lanzar la consulta. */
  const [intentoDelAviso, setIntentoDelAviso] = useState(0);
  const [aceptando, setAceptando] = useState(false);
  /** Cerrojo sincrono: dos toques rapidos no pueden abrir dos pagos. */
  const aceptandoRef = useRef(false);
  /*
    CERROJO SINCRONO PARA COBRAR Y PARA RESTAURAR. `comprando` es estado: no
    esta puesto hasta el siguiente render, y entre el primer toque y ese render
    caben mas toques. Con dos, se abren dos checkouts de Stripe o se lanzan dos
    compras a la tienda sobre el mismo curso. Una referencia se actualiza en el
    acto, asi que el segundo toque encuentra la puerta cerrada.
  */
  const comprandoRef = useRef(false);
  /** La hoja de condiciones se enseña antes de ir al pago. */
  const [viendoCondiciones, setViendoCondiciones] = useState(false);
  /** Version publicada y horas de garantia, las dos del SERVIDOR. */
  const [versionDeLaOferta, setVersionDeLaOferta] = useState<number | null>(null);
  const [horasDeGarantia, setHorasDeGarantia] = useState<number | null>(null);

  const esDePago = (course?.priceMinor ?? 0) > 0;
  const borrador = course?.status === 'draft';
  const retirado = course?.status === 'hidden';

  /*
    «PRÓXIMAMENTE» TIENE QUE SIGNIFICAR ALGO.

    `courses.coming_soon` (migración 0014) existe para anunciar un curso cuyo
    contenido todavía no está disponible. El estado se guardaba y se pintaba,
    pero NO GOBERNABA NADA: el temario seguía llegando entero desde el detalle
    del curso, así que esta pantalla enseñaba a la vez «2 módulos · 1 lecciones
    · Próximamente», el globo «Toca aquí: abre la primera lección del temario» y
    un botón «Empezar curso» que abría esa lección — encima del recuadro que
    acababa de decir que el contenido no estaba preparado. El curso anunciaba
    contenido y negaba tenerlo en la misma pantalla.

    A partir de aquí, para quien NO gestiona el curso, «Próximamente» apaga todo
    lo que ofrece contenido. Quien lo gestiona sigue viéndolo todo: es
    exactamente lo que está preparando.
  */
  const contenidoNoDisponible = !!course?.comingSoon && !canManage;

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
   * Y si hay Beta gratuita para este curso. Se pregunta en las mismas
   * condiciones que la oferta —de pago y sin acceso— porque en cualquier otro
   * caso no hay nada que conceder.
   */
  React.useEffect(() => {
    let vigente = true;
    if (!course || !esDePago || hasAccess) return;
    void LearningRepository.publishedVersion(course.id)
      .then((v) => vigente && setVersionDeLaOferta(v?.version ?? null))
      .catch(() => null);
    void DevolucionesRepository.garantia(course.id)
      .then((e) => vigente && setHorasDeGarantia(e.horasDeGarantia))
      .catch(() => null);
    return () => {
      vigente = false;
    };
  }, [course, esDePago, hasAccess]);

  React.useEffect(() => {
    let vigente = true;
    if (!course || !esDePago || hasAccess) {
      setBeta(null);
      return;
    }
    LearningRepository.betaAccess(course.id)
      // Que falle preguntando no puede romper la ficha del curso: sin respuesta
      // no hay boton, que es el lado seguro.
      .catch(() => null)
      .then((resultado) => {
        if (vigente) setBeta(resultado);
      });
    return () => {
      vigente = false;
    };
  }, [course, esDePago, hasAccess]);

  /**
   * Y si esta compra necesita aceptar antes que no tendra garantia. Se
   * pregunta en las mismas condiciones —de pago y sin acceso— porque en
   * cualquier otro caso no hay recompra que avisar.
   */
  React.useEffect(() => {
    let vigente = true;
    if (!course || !esDePago || hasAccess) {
      setAvisoDeRecompra(null);
      setAceptaLaRecompra(false);
      setFalloDelAviso(false);
      return;
    }
    DevolucionesRepository.avisoDeRecompra(course.id)
      .then((resultado) => {
        if (!vigente) return;
        setAvisoDeRecompra(resultado);
        setFalloDelAviso(false);
      })
      // Que falle preguntando no rompe la ficha del curso, pero SI bloquea la
      // compra: sin respuesta no se sabe si esta persona tiene que aceptar
      // antes que su recompra no llevara garantia, y ofrecerle el boton normal
      // seria enviarla a un rechazo del servidor sin decirle por que.
      .catch(() => {
        if (!vigente) return;
        setAvisoDeRecompra(null);
        setFalloDelAviso(true);
      });
    return () => {
      vigente = false;
    };
  }, [course, esDePago, hasAccess, intentoDelAviso]);

  /**
   * Aceptar la recompra sin garantia y seguir al pago, en ese orden.
   *
   * UNA SOLA ORDEN. La aceptacion se guarda primero y el checkout se abre
   * DESPUES, una vez: no se lanza un pago «por si acaso» ni se repite si la
   * aceptacion falla. El cerrojo sincrono existe porque `aceptando` no esta
   * puesto hasta el siguiente render, y entre el primer toque y ese render
   * caben mas toques.
   */
  const aceptarYComprar = async () => {
    if (!course || aceptandoRef.current) return;
    // La casilla es obligatoria: sin marcar, no se acepta ni se cobra nada.
    if (!aceptaLaRecompra) return;
    aceptandoRef.current = true;
    setAceptando(true);
    try {
      /*
        SE MANDA DE DONDE VIENE LA COMPRA cuando es de tienda. En la web la
        orden identifica la firma; en Google y Apple la orden no existe hasta
        despues del cobro, asi que sin esto la aceptacion no se puede atar a
        la compra concreta que la consumio.
      */
      const proveedor =
        oferta?.plataforma === 'ios'
          ? ('apple' as const)
          : oferta?.plataforma === 'android'
            ? ('google' as const)
            : null;
      await DevolucionesRepository.aceptarRecompra(
        course.id,
        proveedor && oferta?.productoDeTienda
          ? { proveedor, productoDeTienda: oferta.productoDeTienda }
          : undefined,
      );
      // Aceptado y guardado: la puerta desaparece y se pasa al pago.
      setAvisoDeRecompra((previo) =>
        previo ? { ...previo, requiereAceptacion: false } : previo,
      );
      await comprar();
    } catch (e) {
      notify(
        t('recompra.falloTitulo'),
        e instanceof Error ? e.message : t('common.tryAgain'),
      );
    } finally {
      aceptandoRef.current = false;
      setAceptando(false);
    }
  };

  /**
   * Pedir el acceso gratuito de la Beta. NO ES UNA COMPRA y no se le dice a
   * nadie que lo sea: no hay cobro, no hay recibo y el precio del curso no
   * cambia. Quien concede es el servidor, de forma idempotente.
   */
  const pedirAccesoDeBeta = async () => {
    if (!course) return;
    setPidiendoBeta(true);
    try {
      await LearningRepository.grantBetaAccess(course.id);
      toast(t('course.accessGranted'));
      reload();
    } catch (e) {
      notify(
        t('course.accessFailed'),
        e instanceof Error ? e.message : t('common.tryAgain'),
      );
    } finally {
      setPidiendoBeta(false);
    }
  };

  /**
   * Comprar. En movil lo cobra la tienda; en web, Stripe Checkout alojado.
   *
   * Cancelar NO ensena ningun error: que alguien abra el dialogo de la tienda
   * y se lo piense es una decision normal, no un fallo.
   */
  const comprar = async () => {
    if (!course || !oferta?.sePuedeComprar || comprandoRef.current) return;
    comprandoRef.current = true;
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
        notify(t('course.purchaseFailed'), resultado.mensaje);
        return;
      }
      if (resultado.estado === 'pendiente_de_sincronizar') {
        // La compra NO se ha perdido: esta en la tienda. Decirle a quien acaba
        // de pagar que «no se ha podido comprar» seria mentira y ademas un
        // susto.
        notify(
          t('course.purchaseReceived'),
          t('course.purchaseReceivedBody'),
        );
        reload();
        return;
      }
      toast(t('course.purchased'));
      reload();
    } catch (e) {
      notify(
        t('course.purchaseFailed'),
        e instanceof Error ? e.message : t('common.tryAgain'),
      );
    } finally {
      comprandoRef.current = false;
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
    if (comprandoRef.current) return;
    comprandoRef.current = true;
    setComprando(true);
    try {
      const resultado = await restaurarCompras();
      if (resultado.estado === 'comprada' && resultado.accesos > 0) {
        toast(t('course.purchasesRestored'));
        reload();
      } else if (resultado.estado === 'comprada') {
        // PREGUNTAR NO ES RESTAURAR. El servidor contestó y esta cuenta no
        // tiene ningún acceso: decir «restauradas» sería mentir, y además deja
        // sin diagnóstico a quien está en la cuenta de tienda equivocada, que
        // es la causa más común de que esto se pulse una y otra vez.
        //
        // Se recarga igual: el servidor acaba de decir la verdad sobre esta
        // cuenta y la pantalla tiene que reflejarla, tenga compras o no.
        notify(t('course.noPurchasesFound'), t('course.noPurchasesFoundBody'));
        reload();
      } else if (resultado.estado === 'error') {
        notify(t('course.restoreFailed'), resultado.mensaje);
      } else {
        notify(t('course.almost'), t('course.checkingPurchases'));
      }
    } finally {
      comprandoRef.current = false;
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
        toast(t('course.published'));
        reload();
      } else {
        notify(t('course.cannotPublishYet'), resultado.missing.join('\n'));
      }
    } catch (e) {
      notify(t('create.publishFailed'), e instanceof Error ? e.message : t('common.tryAgain'));
    } finally {
      setPublicando(false);
    }
  };

  const retirar = async () => {
    if (!course) return;
    const aceptado = await confirm({
      title: t('course.unpublishTitle'),
      message: t('course.unpublishBody'),
      confirmLabel: t('course.unpublishConfirm'),
    });
    if (!aceptado) return;
    try {
      await LearningRepository.unpublish(course.id);
      toast(t('course.unpublished'));
      reload();
    } catch (e) {
      notify(t('course.unpublishFailed'), e instanceof Error ? e.message : t('common.tryAgain'));
    }
  };

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title={t('course.headerTitle')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <StateView state="loading" />
      </View>
    );
  }

  if (error || !course) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title={t('course.headerTitle')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <StateView state="error" description={error ?? undefined} onRetry={reload} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title={t('course.headerTitle')}
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
        {/*
          Portada real del curso; el asset local solo mientras no tenga.

          DECORATIVA. El titulo del curso va justo debajo, en texto, asi que
          etiquetar la imagen con el mismo titulo lo haria sonar dos veces al
          lector de pantalla. Sin marcar, en cambio, se anunciaba como una
          imagen sin nombre: ruido en medio de la ficha.
        */}
        <Image
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no"
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
                {borrador ? t('course.draft') : t('course.withdrawn')}
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
          {/*
            LA BETA GRATUITA VA PRIMERO. Mientras el servidor la tenga
            encendida, lo cierto es que este curso se puede tener gratis, y
            enseñar «las compras no están disponibles» seria contar la mitad.
            El precio de arriba NO desaparece: el curso sigue costando lo que
            cuesta, y lo que se dice es que durante la beta no se cobra.
          */}
          {esDePago && !hasAccess && beta?.available ? (
            <Text style={[styles.notaDeAcceso, { color: colors.text }]}>
              {t('course.betaFreeNote')}
            </Text>
          ) : esDePago && !hasAccess && oferta ? (
            oferta.sePuedeComprar ? (
              <Text style={[styles.notaDeAcceso, { color: colors.text }]}>
                {t('course.price', { precio: oferta.precio ?? '' })}
              </Text>
            ) : (
              <Text style={[styles.notaDeAcceso, { color: colors.textMuted }]}>
                {explicar(oferta.motivo)}
              </Text>
            )
          ) : null}

          <Text style={[styles.description, { color: colors.textMuted }]}>{course.description}</Text>

          {course.authorName ? (
            <Pressable
              style={styles.autor}
              onPress={() => irAlPerfil(router, course.authorId)}
              accessibilityRole="button"
              accessibilityLabel={t('curso.verPerfilDe').replace('{nombre}', course.authorName)}
            >
              <Feather name="user" size={15} color={colors.textMuted} />
              <Text style={[styles.textoDeAutor, { color: colors.textMuted }]}>
                {t('curso.por').replace('{nombre}', course.authorName)}
              </Text>
              <Feather name="chevron-right" size={15} color={colors.textMuted} />
            </Pressable>
          ) : null}

          <FichaDelCurso course={course} duracionSegundos={durationSecondsTotal} />

          <CondicionesDeCompra
            visible={viendoCondiciones}
            onClose={() => setViendoCondiciones(false)}
            onConfirmar={() => {
              setViendoCondiciones(false);
              void comprar();
            }}
            titulo={course.title}
            precio={oferta?.precio ?? etiquetaDePrecio(course.priceMinor, course.currency)}
            version={versionDeLaOferta}
            horasDeGarantia={horasDeGarantia}
            confirmando={comprando}
          />

          {/*
            Solo hechos que salen de la base de datos. Antes aqui ponia
            «Plantillas y ejercicios» y «Comunidad privada» para todos los
            cursos, existieran o no.
          */}
          <View style={[styles.info, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            {/*
              LOS CONTADORES SOLO SI SE PUEDEN ABRIR. «2 módulos · 1 lecciones»
              al lado de «Próximamente» es la contradicción de la captura
              escrita en una sola línea: se anuncia contenido que la propia
              pantalla dice que no está. Quien gestiona el curso sí los ve, que
              es como sabe lo que lleva preparado.
            */}
            {contenidoNoDisponible ? null : (
              <React.Fragment>
                <Info icon="book" label={t('course.modules', { count: course.modules })} />
                <Info icon="play-circle" label={t('course.lessons', { count: course.lessons })} />
              </React.Fragment>
            )}
            {course.comingSoon ? <Info icon="clock" label={t('common.comingSoon')} /> : null}
          </View>

          <CourseHighlights courseId={course.id} canEdit={canManage} />

          {/*
            Guia hacia el temario. Para quien lo gestiona sobra: ese bloque es
            su editor y ya lo conoce.
          */}
          <CoachMark
            id="curso-temario"
            arrow="down"
            // Y NUNCA con el contenido sin publicar: «Toca aquí: abre la
            // primera lección del temario» señalando a un recuadro que dice que
            // el temario todavía no está es lo que hacía la captura.
            visible={!canManage && !!firstLessonId && !contenidoNoDisponible}
            text={t('course.firstLessonHint')}
            onPress={() => firstLessonId && router.push(`/lesson/${firstLessonId}` as never)}
          />

          <View style={styles.contentBlock}>
            <CourseContentEditor
              courseId={course.id}
              canEdit={canManage}
              // Del detalle del curso, que es de donde sale todo lo demás de
              // esta pantalla: una sola fuente para un solo dato.
              comingSoon={!!course.comingSoon}
              // Que hay hecho y cuanto se lleva: del detalle del curso, que es
              // de donde sale todo lo demas de esta pantalla. El temario no lo
              // calcula ni lo vuelve a pedir.
              completadas={completadas}
              progresoDelCurso={progressPercent}
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
          {/*
            Y CON EL CONTENIDO SIN PUBLICAR, NINGUNA.

            No es un botón desactivado: es que no hay nada que empezar todavía.
            El recuadro «Próximamente» de justo encima ya dice por qué, así que
            no queda un hueco sin explicación —que es lo único que convertiría
            esto en un botón muerto—.

            El bloque de COMPRA no entra aquí: `coming_soon` significa
            «anunciado», y reservar plaza en algo anunciado es una decisión del
            producto, no una incoherencia. Lo que no puede pasar es ofrecer
            ABRIR un contenido que la pantalla acaba de decir que no está.
          */}
          {esDePago && !hasAccess ? (
            beta?.available ? (
              <Button
                label={pidiendoBeta ? t('course.activating') : t('course.betaFree')}
                disabled={pidiendoBeta}
                loading={pidiendoBeta}
                onPress={() => void pedirAccesoDeBeta()}
                style={{ marginTop: spacing.xl }}
              />
            ) : oferta?.sePuedeComprar ? (
              /*
                LA PUERTA DE LA RECOMPRA VA DELANTE DEL PAGO.

                Si el servidor dice que hace falta aceptar, el boton de comprar
                NO existe todavia: en su lugar esta el aviso, con la fecha de la
                devolucion anterior y una casilla que hay que marcar. Dejar los
                dos a la vez —o el aviso al lado de un boton que ya cobra— seria
                cobrar antes de que nadie haya aceptado nada.
              */
              falloDelAviso ? (
                /*
                  NO SE PUDO PREGUNTAR SI HACE FALTA ACEPTAR, asi que no se
                  ofrece comprar. Antes se caia al boton normal y la persona
                  descubria el problema despues de pulsar, con un error del
                  servidor que no explica nada. Aqui se dice y se ofrece
                  reintentar.
                */
                <StateView
                  state="error"
                  description={t('recompra.noSePudoComprobar')}
                  onRetry={() => setIntentoDelAviso((n) => n + 1)}
                />
              ) : avisoDeRecompra?.requiereAceptacion ? (
                <View
                  style={[styles.recompra, { borderColor: colors.border }]}
                  accessibilityRole="alert"
                >
                  {/* El texto es EL DEL SERVIDOR, tal cual: es lo que se firma. */}
                  <Text style={[styles.recompraTexto, { color: colors.text }]}>
                    {avisoDeRecompra.aviso}
                  </Text>
                  <Pressable
                    onPress={() => setAceptaLaRecompra((v) => !v)}
                    disabled={aceptando || comprando}
                    accessible
                    focusable
                    accessibilityRole="checkbox"
                    accessibilityLabel={avisoDeRecompra.etiquetaDeCasilla}
                    accessibilityState={{ checked: aceptaLaRecompra }}
                    style={styles.casilla}
                  >
                    <Feather
                      name={aceptaLaRecompra ? 'check-square' : 'square'}
                      size={20}
                      color={aceptaLaRecompra ? colors.primary : colors.textMuted}
                    />
                    <Text style={[styles.casillaTexto, { color: colors.text }]}>
                      {avisoDeRecompra.etiquetaDeCasilla}
                    </Text>
                  </Pressable>
                  <Button
                    label={
                      aceptando || comprando ? t('course.processing') : t('course.buy')
                    }
                    // Sin marcar la casilla no se continua. Y apagado mientras
                    // se envia: es la mitad visible de la proteccion contra dos
                    // ordenes.
                    disabled={!aceptaLaRecompra || aceptando || comprando}
                    loading={aceptando || comprando}
                    onPress={() => void aceptarYComprar()}
                    style={{ marginTop: spacing.md }}
                  />
                </View>
              ) : (
                <Button
                  label={comprando ? t('course.processing') : t('course.buy')}
                  disabled={comprando}
                  loading={comprando}
                  onPress={() => setViendoCondiciones(true)}
                  style={{ marginTop: spacing.xl }}
                />
              )
            ) : null
          ) : contenidoNoDisponible ? null : (
            <Button
              label={
                enrolling
                  ? t('create.opening')
                  : esDePago || empezado
                    ? t('course.continue')
                    : t('course.start')
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
            LA EVALUACION Y EL FINAL DEL CURSO, para quien lo tiene.

            Son dos destinos y no uno: la evaluacion se puede hacer con el
            curso a medias, y la pantalla de finalizacion sirve tanto para
            celebrarla como para decir que falta. Las dos preguntan al servidor
            al abrirse, asi que desde aqui no se afirma nada: si esta
            instalacion no tiene la 0058 o la 0059, cada una lo dice al llegar.
          */}
          {hasAccess && !canManage ? (
            <View style={styles.accionesDeAprendizaje}>
              <Button
                label={t('evaluacion.titulo')}
                variant="secondary"
                onPress={() => router.push(`/evaluacion/${course.id}`)}
                style={styles.accionDeAprendizaje}
              />
              <Button
                label={t('completado.titulo')}
                variant="secondary"
                onPress={() => router.push(`/completado/${course.id}`)}
                style={styles.accionDeAprendizaje}
              />
            </View>
          ) : null}

          {/*
            LA GARANTIA DE DEVOLUCION, para quien compro este curso.

            Se pinta solo cuando hay compra de pago con acceso; quien lo
            gestiona no compro nada, y para un curso gratis o para quien llego
            por la beta no hay garantia que contar. La propia tarjeta se calla
            si el servidor dice que no hay compra detras, asi que ninguno de
            esos casos deja un recuadro vacio.
          */}
          {esDePago && hasAccess && !canManage ? (
            <TarjetaDeGarantia courseId={course.id} hayCompraPagada />
          ) : null}

          {/*
            LAS VALORACIONES.

            `puedeValorar` es solo para no ensenar un boton imposible: valorar
            pide HABER PAGADO el curso, no poder entrar. En uno gratis nadie
            compro, asi que el boton contestaba siempre 422
            `review_purchase_required`; y quien lo publico tampoco valora
            —valorar lo propio no es una opinion, es publicidad—. Quien DECIDE
            sigue siendo el servidor, que vuelve a mirar la compra y la
            devolucion en cada escritura; por eso sus rechazos estan traducidos
            y se leen dentro de la hoja.

            La seccion se calla entera si esta instalacion no tiene la
            migracion 0056 (503 `course_reviews_not_available`).
          */}
          <ValoracionesDelCurso
            cursoId={course.id}
            puedeValorar={esDePago && hasAccess && !canManage}
          />

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
              accessibilityLabel={t('course.restorePurchases')}
            >
              <Feather name="refresh-cw" size={14} color={colors.textMuted} />
              <Text style={{ color: colors.textMuted, fontSize: 13, fontWeight: '700' }}>
                {t('course.restorePurchases')}
              </Text>
            </Pressable>
          ) : null}

          {/* Publicar y retirar, solo para quien gestiona el curso. */}
          {canManage ? (
            borrador || retirado ? (
              <Button
                label={t('course.publish')}
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
                accessibilityLabel={t('course.unpublishTitle')}
              >
                <Feather name="eye-off" size={14} color={colors.textMuted} />
                <Text style={{ color: colors.textMuted, fontSize: 13, fontWeight: '700' }}>
                  {t('course.unpublishTitle')}
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
  accionesDeAprendizaje: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  accionDeAprendizaje: { flex: 1 },
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
  // La puerta de la recompra sin garantia.
  recompra: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginTop: spacing.xl,
    gap: spacing.sm,
  },
  recompraTexto: { fontSize: 13, lineHeight: 19 },
  casilla: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    // 44 pt es el minimo que se puede pulsar con fiabilidad; con el relleno
    // solo se quedaba por debajo.
    minHeight: 44,
  },
  casillaTexto: { fontSize: 13, lineHeight: 19, flex: 1 },
  autor: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  textoDeAutor: { flex: 1, fontSize: 14 },
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
