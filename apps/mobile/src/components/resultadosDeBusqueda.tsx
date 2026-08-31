import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';

import { ListRow } from '@/components/ListRow';
import { SectionTitle } from '@/components/SectionTitle';
import { Text } from '@/components/Text';
import { assets } from '@/data/assets';
import { irAlPerfil } from '@/lib/irAlPerfil';
import { resultadoAbierto } from '@/services/senales';
import { profileImageUrl } from '@/services/storage';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { filasDeResultados, type FilaDeBusqueda } from '@/lib/busquedaProgresiva';

/*
  Se reexportan para que las pantallas importen «como se pinta un resultado» de
  un solo sitio. La construccion de las filas vive en `lib/` —sin React ni
  alias— para que se pueda probar con el runner de Node; pintar necesita React y
  por eso vive aqui.
*/
export { filasDeResultados };
export type { FilaDeBusqueda };

/**
 * COMO SE PINTA UN RESULTADO DE BUSQUEDA. Una sola vez, para las dos pantallas
 * que buscan.
 *
 * POR QUE ESTO EXISTE, Y ES EL ARREGLO DE VERDAD DE ESTA TAREA.
 *
 * Habia DOS buscadores en la aplicacion y solo uno de ellos servia:
 *
 *   · `SearchScreen` (`/search`) pregunta a `GET /api/v1/search` y encuentra
 *     personas, etiquetas, publicaciones, CURSOS y eventos, ademas de por tema
 *     («muebles» encuentra carpinteria). Estaba TERMINADA y era INALCANZABLE:
 *     el unico enlace a `/search` en toda la aplicacion estaba en `app/dev.tsx`,
 *     la galeria de pantallas para revisar vistas. Ninguna persona la ha
 *     abierto nunca.
 *   · El buscador de Explorar, que es el que TODO EL MUNDO usa —esta fijo
 *     arriba, en la pestaña a la que se entra a buscar— preguntaba a
 *     `/profiles/search` y solo encontraba PERSONAS. Su estado vacio decia
 *     «No encontramos personas con ese nombre.»
 *
 * Eso es exactamente lo que se ve en la captura de la queja: alguien publico un
 * curso, otra persona escribio palabras del tema en el unico buscador que
 * podia encontrar, y la aplicacion le contesto que no habia NADIE con ese
 * nombre. El curso estaba publicado, etiquetado y era encontrable: el backend
 * lo devolvia sin problema. Nadie se lo pregunto.
 *
 * Asi que el buscador de Explorar pasa a ser el mismo buscador global, y para
 * que no haya dos formas de pintar un resultado —que es como vuelven a
 * separarse— las filas se construyen y se pintan AQUI.
 */

/** El dia y el mes de un evento, o nada si la fecha no vino o no se entiende. */
function fechaCorta(iso: string | null): string {
  if (!iso) return '';
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return '';
  return fecha.toLocaleDateString('es-PE', { day: 'numeric', month: 'short' });
}

type PropsDeFila = {
  fila: FilaDeBusqueda;
  /**
   * Se llama justo antes de navegar. Existe para guardar la busqueda reciente,
   * que solo tiene sentido en la pantalla que las muestra.
   */
  alAbrir?: () => void;
};

/**
 * Una fila ya pintada.
 *
 * ABRIR UN RESULTADO SE REGISTRA como senal, y se guarda QUE se abrio, NUNCA lo
 * que se escribio: un termino de busqueda puede contener cualquier cosa y no
 * hace falta para ordenar nada. Antes solo lo hacia el buscador de Explorar, de
 * modo que la mitad de esa medicion se perdia segun por donde se buscara.
 */
export function FilaDeResultado({ fila, alAbrir }: PropsDeFila) {
  const { colors } = useAppTheme();
  const router = useRouter();

  switch (fila.kind) {
    case 'section':
      return (
        <SectionTitle title={fila.title} action={fila.action} onActionPress={fila.onAction} />
      );

    case 'temas':
      return (
        <Text variant="secondary" color={colors.textMuted} style={styles.temas}>
          {fila.texto}
        </Text>
      );

    case 'person': {
      const avatar = profileImageUrl(fila.persona.avatar_path);
      /*
        El subtitulo es el @usuario y, si no lo tiene, lo que declara PODER
        APORTAR. Nunca lo que quiere aprender: el contrato del backend ni
        siquiera trae ese dato.
      */
      const subtitulo = fila.persona.username
        ? `@${fila.persona.username}`
        : fila.persona.offer_topics.join(' · ') || fila.persona.bio;
      return (
        <ListRow
          title={fila.persona.full_name}
          subtitle={subtitulo || undefined}
          leftComponent={
            <ExpoImage
              source={avatar ? { uri: avatar } : assets.avatar}
              style={styles.avatar}
              contentFit="cover"
              cachePolicy="memory-disk"
            />
          }
          rightIcon="chevron-right"
          onPress={() => {
            alAbrir?.();
            resultadoAbierto('profile', fila.persona.id);
            irAlPerfil(router, fila.persona.id);
          }}
        />
      );
    }

    case 'hashtag':
      return (
        <ListRow
          title={`#${fila.etiqueta.display_tag}`}
          // La cuenta la da el servidor y es la REAL (solo publicado). El plural
          // se escribe entero: «1 publicaciones» se lee mal.
          subtitle={
            fila.etiqueta.posts_count === 1
              ? '1 publicación'
              : `${fila.etiqueta.posts_count} publicaciones`
          }
          leftIcon="hash"
          rightIcon="chevron-right"
          onPress={() => {
            alAbrir?.();
            // Se navega con la forma NORMALIZADA (`tag`), que es la que de
            // verdad existe: `display_tag` es solo para pintar.
            router.push(`/hashtag/${encodeURIComponent(fila.etiqueta.tag)}` as never);
          }}
        />
      );

    case 'post':
      return (
        <Pressable
          onPress={() => {
            alAbrir?.();
            resultadoAbierto('post', fila.publicacion.id);
            router.push(`/post/${fila.publicacion.id}` as never);
          }}
          style={({ pressed }) => [
            styles.postRow,
            { borderBottomColor: colors.border, opacity: pressed ? 0.75 : 1 },
          ]}
          accessibilityRole="button"
          accessibilityLabel={`Ver publicación de ${fila.publicacion.author_name}`}
        >
          <Text variant="secondary" weight="700">
            {fila.publicacion.author_name}
          </Text>
          <Text variant="body" color={colors.textMuted} numberOfLines={2}>
            {fila.publicacion.body}
          </Text>
        </Pressable>
      );

    case 'course':
      return (
        <ListRow
          title={fila.curso.title}
          subtitle={
            fila.curso.coming_soon
              ? 'Próximamente'
              : fila.curso.subtitle || fila.curso.author_name || 'Programa'
          }
          leftIcon="book"
          rightIcon="chevron-right"
          onPress={() => {
            alAbrir?.();
            router.push(`/course/${fila.curso.id}` as never);
          }}
        />
      );

    case 'event': {
      const cuando = fechaCorta(fila.evento.starts_at);
      const donde = fila.evento.location ?? '';
      return (
        <ListRow
          title={fila.evento.title}
          subtitle={[cuando, donde].filter(Boolean).join(' · ') || undefined}
          leftIcon="calendar"
          rightIcon="chevron-right"
          onPress={() => {
            alAbrir?.();
            router.push('/events' as never);
          }}
        />
      );
    }
  }
}

const styles = StyleSheet.create({
  avatar: { width: 40, height: 40, borderRadius: 20 },
  postRow: { paddingVertical: spacing.md, borderBottomWidth: 1, gap: 4 },
  temas: { marginBottom: spacing.sm },
});
