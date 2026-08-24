import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';

import { Chip } from '@/components/Chip';
import { Text } from '@/components/Text';
import { SinCambioDeSeccion } from '@/navigation/tabSwipe';
import { RecommendationRepository, type TopicDto } from '@/repositories/RecommendationRepository';
import { palette, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/** Paleta fija de lo que se pinta ENCIMA del video, como en `ModoPublicacion`. */
const sobreVideo = palette('dark');

const MAXIMO_POR_DEFECTO = 3;

/*
  La taxonomia es la misma durante toda la sesion y este selector se monta cada
  vez que alguien entra a Crear o a Editar. Sin cache, la misma lista se pedia
  una y otra vez. Se guarda a nivel de modulo, y ademas se comparte la peticion
  en curso para que dos montajes casi simultaneos no la dupliquen.
*/
let temasCacheados: TopicDto[] | null = null;
let peticionEnCurso: Promise<TopicDto[]> | null = null;

function pedirTemas(): Promise<TopicDto[]> {
  if (temasCacheados) return Promise.resolve(temasCacheados);
  if (!peticionEnCurso) {
    peticionEnCurso = RecommendationRepository.listTopics()
      .then((lista) => {
        temasCacheados = lista;
        return lista;
      })
      .finally(() => {
        // El fallo NO se cachea: quien lo intente despues vuelve a pedirlo.
        peticionEnCurso = null;
      });
  }
  return peticionEnCurso;
}

type Props = {
  seleccionados: string[];
  alCambiar: (ids: string[]) => void;
  /** Paleta de superficie sobre vídeo (Crear) vs. pantalla normal (Editar). */
  variante?: 'clara' | 'sobreMedia';
  maximo?: number;
};

/**
 * De que trata lo que se publica: hasta `maximo` temas de la taxonomia comun.
 *
 * Es la MISMA lista que responden las personas en el cuestionario, no una
 * paralela: el recomendador solo puede cruzar contenido con gente si los dos
 * lados hablan del mismo vocabulario.
 *
 * ETIQUETAR ES OPCIONAL, y eso manda sobre todo lo demas. Si la taxonomia no
 * llega —red caida, backend antiguo— el selector no se pinta y publicar sigue
 * funcionando exactamente igual. Un fallo en algo accesorio no puede dejar a
 * nadie sin poder compartir lo suyo.
 */
export function SelectorDeTemas({
  seleccionados,
  alCambiar,
  variante = 'clara',
  maximo = MAXIMO_POR_DEFECTO,
}: Props) {
  const { colors } = useAppTheme();
  // Si ya se pidio antes, se pinta en el primer fotograma y no hay parpadeo.
  const [temas, setTemas] = useState<TopicDto[]>(temasCacheados ?? []);

  useEffect(() => {
    let vivo = true;
    pedirTemas()
      .then((lista) => {
        if (vivo) setTemas(lista);
      })
      .catch((error) => {
        console.warn('[temas] no se pudo cargar la taxonomía', error);
      });
    return () => {
      vivo = false;
    };
  }, []);

  /** Grupos en el orden que decide el servidor; aqui no se reordena nada. */
  const grupos = useMemo(() => {
    const salida: Array<{ nombre: string; temas: TopicDto[] }> = [];
    for (const tema of temas) {
      const ultimo = salida[salida.length - 1];
      if (ultimo && ultimo.nombre === tema.group) ultimo.temas.push(tema);
      else salida.push({ nombre: tema.group, temas: [tema] });
    }
    return salida;
  }, [temas]);

  // Mientras carga tampoco se pinta: en Crear este bloque vive sobre el pie de
  // la pantalla, y un hueco que aparece de golpe movería el botón de publicar
  // justo cuando alguien va a pulsarlo.
  if (temas.length === 0) return null;

  const superficie = variante === 'sobreMedia' ? sobreVideo : colors;
  const alTope = seleccionados.length >= maximo;

  const alternar = (id: string) => {
    if (seleccionados.includes(id)) {
      alCambiar(seleccionados.filter((elegido) => elegido !== id));
      return;
    }
    if (alTope) return;
    alCambiar([...seleccionados, id]);
  };

  /*
    `Chip` tiñe su texto con el tema de la aplicación y eso no se puede cambiar
    desde fuera, pero tampoco hace falta: la píldora es opaca y sus dos estados
    (relleno claro con texto oscuro, o al revés) se leen bien encima de un
    vídeo. Lo único que se refuerza en `sobreMedia` es el borde, porque el
    borde sutil del tema claro desaparece sobre una imagen clara.
  */
  const estiloDeChip = (): ViewStyle | undefined =>
    variante === 'sobreMedia' ? { borderColor: sobreVideo.textMuted } : undefined;

  return (
    <View style={styles.raiz}>
      <View style={styles.cabecera}>
        <Text variant="secondary" weight="700" color={superficie.text} accessibilityRole="header">
          ¿De qué trata?
        </Text>
        {/*
          El aviso del tope ocupa el sitio de la ayuda en vez de añadirse debajo:
          así la fila no cambia de alto al elegir el último tema.
        */}
        <Text variant="caption" color={superficie.textMuted}>
          {alTope
            ? `Máximo ${maximo}. Quita uno para elegir otro.`
            : `Elige hasta ${maximo} temas`}
        </Text>
      </View>

      {/*
        Blindado frente al gesto de cambiar de sección: sin esto, arrastrar la
        fila de temas se llevaría la pantalla entera (ver tabSwipe.tsx).
      */}
      <SinCambioDeSeccion>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.fila}
          /*
            En Crear se etiqueta con el teclado abierto (se viene de escribir la
            descripción). Sin esto, la primera pulsación solo cerraría el
            teclado y parecería que el chip no responde.
          */
          keyboardShouldPersistTaps="handled"
        >
          {/*
            Todos los grupos van en UNA sola fila, con su nombre delante de sus
            temas. Una fila por grupo se leería mejor, pero en Crear este bloque
            comparte el pie con el editor y el botón de publicar: convertirlo en
            una lista alta es justamente lo que no puede pasar.
          */}
          {grupos.map((grupo) => (
            <View key={grupo.nombre} style={styles.grupo}>
              <Text
                variant="caption"
                weight="800"
                color={superficie.textMuted}
                style={styles.nombreDeGrupo}
              >
                {grupo.nombre.toUpperCase()}
              </Text>
              {grupo.temas.map((tema) => {
                const elegido = seleccionados.includes(tema.id);
                // Al llegar al tope los demás se atenúan en vez de desaparecer:
                // que la lista se encoja sola desorienta más que un chip apagado.
                const apagado = !elegido && alTope;
                return (
                  <Chip
                    key={tema.id}
                    label={tema.name}
                    selected={elegido}
                    onPress={() => alternar(tema.id)}
                    disabled={apagado}
                    style={estiloDeChip()}
                  />
                );
              })}
            </View>
          ))}
        </ScrollView>
      </SinCambioDeSeccion>
    </View>
  );
}

const styles = StyleSheet.create({
  raiz: { gap: spacing.xs },
  cabecera: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, flexWrap: 'wrap' },
  fila: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, paddingVertical: spacing.xs },
  grupo: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  nombreDeGrupo: { letterSpacing: 1 },
});
