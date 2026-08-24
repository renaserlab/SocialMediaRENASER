import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { Button } from '@/components/Button';
import { SectionTitle } from '@/components/SectionTitle';
import { Text } from '@/components/Text';
import {
  RecommendationRepository,
  type OfferedTopic,
  type RelacionDeOferta,
} from '@/repositories/RecommendationRepository';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

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
 */

type Props = {
  /** Perfil del que se lee la oferta. Debe ser un uuid real del backend. */
  perfilId: string;
  /** `true` en el perfil propio: cambia la voz y habilita la invitacion. */
  esPropio: boolean;
};

type Etiqueta = {
  /** Como se lee en el perfil de otra persona. */
  ajena: string;
  /** Como se lee en el propio. */
  propia: string;
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
const ETIQUETAS: Record<RelacionDeOferta, Etiqueta> = {
  can_help: { ajena: 'Puede ayudar', propia: 'Puedo ayudar', icono: 'life-buoy' },
  teach: { ajena: 'Enseña', propia: 'Enseño', icono: 'book-open' },
  experienced: {
    ajena: 'Experiencia declarada',
    propia: 'Tengo experiencia',
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
  const { colors } = useAppTheme();
  const router = useRouter();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const conSesion = useAuthStore((state) => state.status === 'authenticated');

  const [temas, setTemas] = useState<OfferedTopic[]>([]);
  const [estado, setEstado] = useState<'cargando' | 'listo' | 'error'>('cargando');

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
          Cuéntanos en qué puedes ayudar a otras personas
        </Text>
        <Button
          label="Añadir temas"
          variant="secondary"
          onPress={() => router.push('/onboarding?modo=editar' as never)}
          style={styles.invitacionBoton}
        />
      </View>
    );
  }

  return (
    <View>
      <SectionTitle title={esPropio ? 'Lo que puedo aportar' : 'Lo que puede aportar'} />
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
                  esPropio ? ETIQUETAS[relacion].propia : ETIQUETAS[relacion].ajena,
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
                        {esPropio ? etiqueta.propia : etiqueta.ajena}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
