import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { StoriesRow } from '@/components/StoriesRow';
import { apiRequest, API_V1 } from '@/services/api';
import { profileImageUrl } from '@/services/storage';
import { useAppStore } from '@/store/useAppStore';
import type { StoryGroup } from '@/types';

/**
 * Cuántos AUTORES caben en la fila de historias de la bandeja.
 *
 * Cuenta autores, no historias, porque una burbuja es un autor. Veinte es más de
 * lo que nadie recorre de un vistazo y pone un techo al peso de la respuesta:
 * está medido que sin tope, quinientos autores son **534 KB** —a 1 067 B por
 * autor— para enseñar las cinco burbujas que caben en pantalla. Con veinte son
 * unos 21 KB.
 */
const AUTORES_EN_LA_FILA = 20;

/** Un grupo de historias tal y como lo manda `GET /api/v1/stories`. */
type StoryGroupDto = {
  author: {
    id: string;
    full_name: string;
    username: string | null;
    avatar_path: string | null;
  };
  seen?: boolean;
  is_own?: boolean;
};

/**
 * De la respuesta del servidor a una burbuja.
 *
 * `items` SE QUEDA VACÍO A PROPÓSITO. Para pintar una burbuja hacen falta la
 * foto, el nombre y si queda algo por ver; los tramos —y sobre todo sus archivos
 * de vídeo y de imagen— no. Rellenarlos aquí obligaría a firmar las rutas de
 * Storage de todo el mundo para no enseñar ninguna. Quien los necesita es el
 * visor, y los pide él.
 */
function aGrupo(dto: StoryGroupDto): StoryGroup {
  return {
    authorId: dto.author.id,
    author: dto.author.full_name || dto.author.username || 'Alguien',
    username: dto.author.username ?? '',
    avatarPath: dto.author.avatar_path ?? undefined,
    avatarUrl: profileImageUrl(dto.author.avatar_path),
    items: [],
    seen: dto.seen ?? true,
    isOwn: dto.is_own ?? false,
  };
}

/**
 * La fila de historias de arriba de la bandeja, por el camino barato.
 *
 * -----------------------------------------------------------------------------
 * POR QUÉ NO USA `StoryRepository`, QUE ES LO QUE HABÍA
 * -----------------------------------------------------------------------------
 * Está medido (`docs/Z_MEDICION_MENSAJES_EXPLORE.md`, §2.5). `StoryRepository`
 * va directo a Supabase y su secuencia está encadenada: sesión → `stories` →
 * `story_views` míos → `story_views` propios → firmar en lote. Son **cuatro
 * saltos seguidos, ~1,7 s**. `GET /api/v1/stories?feed=following` es **una
 * consulta y un salto (~0,42 s)**, y encima llega ya agrupado por autor, ya sabe
 * si lo has visto, ya ordena (propias primero, luego lo que falta por ver) y ya
 * corta los bloqueos en los dos sentidos — que por eso no se repiten aquí.
 *
 * -----------------------------------------------------------------------------
 * SALE A LA VEZ QUE LA BANDEJA, NUNCA DESPUÉS
 * -----------------------------------------------------------------------------
 * Este `useEffect` se dispara al montar, igual que la carga de conversaciones de
 * la pantalla: las dos peticiones salen en el mismo instante. Ahí está toda la
 * diferencia — encadenarlas serían **dos saltos (~0,84 s)** en lugar de uno.
 * Por eso este componente pide lo suyo y no recibe los datos de la pantalla:
 * para que no haya forma de que uno espere al otro.
 */
export function HistoriasDeLaBandeja() {
  const router = useRouter();
  const [grupos, setGrupos] = useState<StoryGroup[]>([]);
  const [estado, setEstado] = useState<'idle' | 'loading' | 'error'>('loading');
  const [abriendo, setAbriendo] = useState(false);

  const gruposDelAlmacen = useAppStore((state) => state.storyGroups);
  const loadStories = useAppStore((state) => state.loadStories);

  useEffect(() => {
    // `vivo` y no un `AbortController`: lo que hay que impedir es escribir en el
    // estado de un componente ya desmontado —salir de Mensajes mientras la
    // petición vuelve—, no ahorrar la respuesta, que ya viene de camino.
    let vivo = true;
    setEstado('loading');
    apiRequest<StoryGroupDto[]>(
      `${API_V1}/stories?feed=following&limit=${AUTORES_EN_LA_FILA}`,
    )
      .then((dtos) => {
        if (!vivo) return;
        setGrupos(dtos.map(aGrupo));
        setEstado('idle');
      })
      .catch(() => {
        if (!vivo) return;
        // La fila se queda con tu burbuja y el `+`: publicar sigue funcionando
        // aunque hoy no se puedan leer las de los demás. Que no carguen las
        // historias no puede dejar a nadie sin sus mensajes ni sin publicar.
        setEstado('error');
      });
    return () => {
      vivo = false;
    };
  }, []);

  /**
   * Abre el visor de esa persona.
   *
   * EL RODEO TIENE MOTIVO. `StoriesScreen` lee los grupos del ALMACÉN, no de
   * aquí. Si alguien abre la aplicación directamente en Mensajes, ese almacén
   * está vacío y el visor diría «No hay historias que mostrar» sobre una burbuja
   * que se acaba de ver. Así que se rellena JUSTO ANTES de navegar, y solo
   * cuando hace falta: pintar la fila no lo paga nunca, y a partir de la primera
   * vez tampoco, porque el almacén ya tiene contenido.
   */
  const abrir = useCallback(
    (authorId: string) => {
      if (gruposDelAlmacen.length > 0) {
        router.push(`/stories/${authorId}` as never);
        return;
      }
      setAbriendo(true);
      void loadStories().finally(() => {
        setAbriendo(false);
        // Se navega tanto si fue bien como si no: con el almacén vacío el visor
        // ya sabe decir que no hay nada que mostrar, y quedarse sin respuesta al
        // tocar es peor que llegar a una pantalla que lo explica.
        router.push(`/stories/${authorId}` as never);
      });
    },
    [gruposDelAlmacen.length, loadStories, router],
  );

  return (
    // Atenuado y sordo mientras se prepara el visor. Con opacidad y
    // `pointerEvents`, sin nada absoluto encima: una capa posicionada a mano
    // encaja mal en las tres plataformas y se descuadra con la barra de estado.
    <View
      style={{ opacity: abriendo ? 0.5 : 1 }}
      pointerEvents={abriendo ? 'none' : 'auto'}
    >
      <StoriesRow grupos={grupos} estado={estado} alAbrir={abrir} />
    </View>
  );
}
