import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { Button } from '@/components/Button';
import { Desplegable, FlechaDeDesplegable } from '@/components/Desplegable';
import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import {
  RecommendationRepository,
  type OfferedTopic,
  type RelacionDeOferta,
} from '@/repositories/RecommendationRepository';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * «Lo que puedo aportar»: el lado PUBLICO del perfil en el recomendador.
 *
 * POR QUE SOLO ESTE LADO. El recomendador guarda dos cosas de cada persona: lo
 * que busca (interes, aprender, orientacion) y lo que declara poder dar
 * (ayudar, ensenar, experiencia). Aqui solo cabe lo segundo, y no por gusto
 * estetico: lo que alguien busca es privado —puede ser una enfermedad, un
 * divorcio, una deuda— y ensenarlo en su perfil convertiria una confidencia en
 * un cartel. El backend ni siquiera ofrece endpoint para leer la demanda ajena,
 * asi que esta pantalla no tiene por donde equivocarse.
 *
 * POR QUE EL LENGUAJE ES TAN CUIDADOSO. Estas etiquetas las escribe la propia
 * persona sobre si misma: nadie las ha comprobado. Por eso se dice «Puede
 * ayudar» y «Experiencia declarada», y nunca «experto», «verificado» o
 * «certificado». Escribir eso seria fabricar una confianza que no existe, y
 * quien la creyera lo descubriria en la primera sesion pagada.
 *
 * POR QUE EMPIEZA PLEGADA. Se pintaba entera y de golpe: con tres temas y tres
 * etiquetas en cada uno ocupaba media pantalla en medio del perfil, justo entre
 * la presentacion de la persona y los accesos a su podcast, sus cursos y su
 * agenda. Lo que es un detalle util para quien lo busca se habia convertido en
 * un muro que hay que atravesar para llegar a lo demas. Plegada, la seccion
 * ANUNCIA que existe y ocupa una linea; quien tenga interes la abre.
 */

type Props = {
  /** Perfil del que se lee la oferta. Debe ser un uuid real del backend. */
  perfilId: string;
  /** `true` en el perfil propio: cambia la voz y habilita la invitacion. */
  esPropio: boolean;
};

type Etiqueta = {
  /** Como se lee en el perfil de otra persona. */
  ajena: TranslationKey;
  /** Como se lee en el propio. */
  propia: TranslationKey;
  icono: keyof typeof Feather.glyphMap;
};

/**
 * Traducciones fijas. Ninguna insinua comprobacion: `experienced` es
 * «Experiencia declarada», no «experto», porque lo unico cierto es que la
 * persona lo declaro.
 *
 * Los iconos acompanan al texto porque el sistema visual es blanco y negro: si
 * la distincion dependiera del color, en escala de grises —o para quien no lo
 * distingue— las tres relaciones serian la misma.
 */
// Claves, no textos: el rotulo se resuelve al pintar, que es cuando se sabe
// en que idioma esta la aplicacion.
const ETIQUETAS: Record<RelacionDeOferta, Etiqueta> = {
  can_help: { ajena: 'offer.canHelp', propia: 'offer.canHelpOwn', icono: 'life-buoy' },
  teach: { ajena: 'offer.teaches', propia: 'offer.teachesOwn', icono: 'book-open' },
  experienced: {
    ajena: 'offer.experienced',
    propia: 'offer.experiencedOwn',
    icono: 'clock',
  },
};

/**
 * Orden de lectura, fijo. El servidor devuelve las relaciones en el orden que
 * le sale de la base de datos; sin este orden, el mismo perfil se leeria
 * distinto en cada carga y costaria comparar dos personas de un vistazo.
 */
const ORDEN: RelacionDeOferta[] = ['can_help', 'teach', 'experienced'];

export function OfertaDelPerfil({ perfilId, esPropio }: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const conSesion = useAuthStore((state) => state.status === 'authenticated');

  const [temas, setTemas] = useState<OfferedTopic[]>([]);
  const [estado, setEstado] = useState<'cargando' | 'listo' | 'error'>('cargando');
  /**
   * Plegada al llegar. Es el estado en el que la seccion estorba menos y sigue
   * diciendo que existe.
   */
  const [abierta, setAbierta] = useState(false);

  /*
    POR QUE LA PETICION SIGUE SALIENDO AL MONTAR, Y NO AL ABRIR LA SECCION.

    Parece la optimizacion evidente —la seccion nace cerrada, asi que su
    contenido no se ve— y se ha comprobado antes de descartarla:

    1. NO ESTA EN EL CAMINO CRITICO. `getProfileOffer` sale a la vez que
       `pedirPerfil` y que las publicaciones, en efectos independientes, y esta
       pantalla no espera por ella para nada: mientras no hay respuesta este
       componente devuelve `null` y el perfil se pinta entero igual. Aplazarla
       no adelantaria ni un fotograma; solo moveria la espera al momento de
       abrir, que es justo cuando alguien SI la esta mirando.

    2. Y SOBRE TODO: EL ENCABEZADO DEPENDE DE LA RESPUESTA. La mayoria de los
       perfiles no ha declarado nada, y en ese caso aqui no se pinta nada. Sin
       pedir los datos no hay forma de saber si hay algo dentro, asi que el
       encabezado «Lo que puede aportar» tendria que salir SIEMPRE y abrirse
       sobre un hueco vacio la mayoria de las veces. Eso es un boton muerto, que
       es exactamente lo que no puede haber.

    Si algun dia hiciera falta, la unica forma correcta seria que el perfil
    trajera el numero de temas ofrecidos; con eso el encabezado sabria si tiene
    algo que abrir y la lista si podria esperar. Hoy ese dato no existe.
  */
  useEffect(() => {
    if (!perfilId || !supabaseEnabled || !conSesion) {
      // El endpoint exige sesion. Sin ella no se pide nada: un 401 en la
      // consola no aporta y la seccion se retira igual.
      setEstado('error');
      return;
    }
    // Al cambiar de perfil hay que volver a cargar; el testigo evita que la
    // respuesta del perfil ANTERIOR se pinte encima del nuevo.
    let vigente = true;
    setEstado('cargando');
    RecommendationRepository.getProfileOffer(perfilId)
      .then((lista) => {
        if (!vigente) return;
        setTemas(lista);
        setEstado('listo');
      })
      .catch((error) => {
        if (!vigente) return;
        /*
          Que esto falle NO puede vaciar el perfil: la persona, sus cifras y sus
          publicaciones siguen ahi. La seccion desaparece sola y el fallo queda
          registrado para quien depura, no en la cara de quien mira.
        */
        console.warn('[oferta] no se pudo cargar la oferta del perfil', error);
        setEstado('error');
      });
    return () => {
      vigente = false;
    };
  }, [perfilId, supabaseEnabled, conSesion]);

  /*
    Mientras carga no se pinta ni un esqueleto.

    Un esqueleto promete contenido, y aqui lo mas probable es que no haya
    ninguno: la mayoria de los perfiles todavia no ha declarado nada. Ensenar
    un hueco animado que despues se desvanece deja al perfil dando saltos y
    sugiere que se perdio algo.
  */
  if (estado !== 'listo') return null;

  // Solo cuentan los temas con alguna relacion que sepamos escribir: un tema
  // cuyo unico codigo sea desconocido no tiene nada que decir en pantalla.
  const visibles = temas.filter((tema) => tema.relations.length > 0);

  if (visibles.length === 0) {
    // Perfil ajeno sin oferta: no se pinta nada. Un «no ha declarado nada»
    // solo serviria para dejar en evidencia a quien lo visita.
    if (!esPropio) return null;

    /*
      En el propio si se invita, una vez y sin insistir: quien no declara nada
      no aparece en «Personas para ti» de nadie, y no tiene forma de saberlo.
      Es una linea y un boton, no un aviso que haya que cerrar ni un paso que
      bloquee el perfil.
    */
    return (
      <View
        style={[styles.invitacion, { backgroundColor: colors.surface, borderColor: colors.border }]}
      >
        <Feather name="compass" size={18} color={colors.textMuted} />
        <Text variant="secondary" color={colors.textMuted} style={styles.invitacionTexto}>
          {t('offer.invite')}
        </Text>
        <Button
          label={t('offer.addTopics')}
          variant="secondary"
          onPress={() => router.push('/onboarding?modo=editar' as never)}
          style={styles.invitacionBoton}
        />
      </View>
    );
  }

  const titulo = esPropio ? t('offer.titleOwn') : t('offer.titleOther');

  return (
    <View>
      {/*
        EL ENCABEZADO ES EL INTERRUPTOR, no un titulo con un boton al lado: toda
        la fila responde al toque, que es la unica forma de que se pueda dar sin
        apuntar. `accessibilityState.expanded` es lo que hace que un lector de
        pantalla anuncie «contraido» / «expandido» en vez de leer un titulo y
        dejar a quien escucha sin saber que hay algo debajo.

        La flecha cambia de sentido —abajo cerrada, arriba abierta— y no solo de
        color ni de opacidad: en un sistema visual en blanco y negro, la forma es
        lo unico que se lee siempre.
      */}
      <Pulsable
        onPress={() => setAbierta((previo) => !previo)}
        accessibilityRole="button"
        accessibilityLabel={titulo}
        accessibilityState={{ expanded: abierta }}
        hitSlop={6}
        escala={0.99}
        atenuar={0.7}
        style={styles.cabecera}
      >
        <Text variant="titleMedium" style={styles.tituloDeSeccion}>
          {titulo}
        </Text>
        {/* Gira media vuelta al abrirse: abajo cerrada, arriba abierta. */}
        <FlechaDeDesplegable abierto={abierta} color={colors.text} />
      </Pulsable>

      {/*
        SE ABRE, NO APARECE. La altura crece hasta lo que mide la lista y el
        contenido gana opacidad a la vez; lo que hay debajo baja con ella en
        vez de dar un salto (`Desplegable`).
      */}
      <Desplegable abierto={abierta}>
      <View style={styles.lista}>
        {visibles.map((tema) => {
          const etiquetas = ORDEN.filter((relacion) => tema.relations.includes(relacion));
          return (
            <View
              key={tema.topicId}
              style={[styles.tema, { borderColor: colors.border }]}
              // Se lee de una vez: el tema y en que forma lo aporta. Elemento a
              // elemento, un lector de pantalla recitaria palabras sueltas.
              accessible
              accessibilityLabel={`${tema.name}. ${etiquetas
                .map((relacion) =>
                  esPropio ? t(ETIQUETAS[relacion].propia) : t(ETIQUETAS[relacion].ajena),
                )
                .join('. ')}`}
            >
              <Text variant="body" weight="700">
                {tema.name}
              </Text>
              <View style={styles.relaciones}>
                {etiquetas.map((relacion) => {
                  const etiqueta = ETIQUETAS[relacion];
                  return (
                    <View
                      key={relacion}
                      style={[styles.relacion, { borderColor: colors.border }]}
                      importantForAccessibility="no-hide-descendants"
                    >
                      <Feather name={etiqueta.icono} size={13} color={colors.textMuted} />
                      <Text variant="caption" weight="600" color={colors.textMuted}>
                        {esPropio ? t(etiqueta.propia) : t(etiqueta.ajena)}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </View>
          );
        })}
      </View>
      </Desplegable>
    </View>
  );
}

const styles = StyleSheet.create({
  /*
    Mismos margenes que `SectionTitle`, que es lo que habia aqui antes: la
    seccion tiene que seguir separandose del resto del perfil igual, aunque el
    titulo haya pasado a ser pulsable. Alto minimo de 44 para que sea un blanco
    tactil de verdad y no una linea de texto que hay que acertar.
  */
  cabecera: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    // Mas junto al resto del perfil (25/09/2026); el alto tactil de 44 se queda.
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
  tituloDeSeccion: { flex: 1 },
  lista: { gap: spacing.sm },
  tema: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
  },
  relaciones: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  relacion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  invitacion: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  invitacionTexto: { flex: 1, minWidth: 140 },
  // Mas bajo que un boton normal: es una sugerencia, no la accion principal
  // de la pantalla.
  invitacionBoton: { minHeight: 38, height: 38, paddingHorizontal: spacing.md },
});
