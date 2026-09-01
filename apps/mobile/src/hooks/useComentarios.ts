import { useCallback, useEffect, useState } from 'react';

import {
  anadirPagina,
  enviarComentario,
  estadoInicial,
  primeraPagina,
  type EstadoDeComentarios,
} from '@/lib/comentarios';
import { notify } from '@/lib/confirm';
import { invalidar } from '@/lib/sincronizacion';
import { PostRepository, type ComentarioConAvatar } from '@/repositories/PostRepository';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { useTranslation } from '@/i18n/useTranslation';

/** Cuántos comentarios se piden por página. */
export const COMENTARIOS_POR_PAGINA = 20;

/** A quién se está respondiendo, mientras se escribe. */
export type Respondiendo = { id: string; author: string } | null;

/** Modo demostración, sin backend: no hay a quién preguntar. */
const comentariosDeMuestra: ComentarioConAvatar[] = [
  { id: '1', author: 'Sophia V.', text: 'Esto cambia completamente mi perspectiva.', createdAt: 'Hace 2 h' },
  { id: '2', author: 'Daniel M.', text: '¡Excelente lección! Totalmente recomendado.', createdAt: 'Hace 5 h' },
  { id: '3', author: 'Esteban R.', text: 'Aplicando esto desde hoy mismo.', createdAt: 'Hace 1 d' },
];

/**
 * Cargar, paginar y escribir comentarios de una publicación.
 *
 * Lo usan la PANTALLA (`/comments/[id]`, que es a donde llevan los avisos y los
 * enlaces) y la HOJA que se abre desde una publicación. Las dos necesitan lo
 * mismo; lo que cambia es el marco.
 */
export function useComentarios(postId: string | undefined | null) {
  const { t } = useTranslation();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const currentUser = useAppStore((state) => state.user);
  const requireAuth = useRequireAuth();
  const setPosts = useAppStore((state) => state.setPosts);

  const contadorDelMuro = useAppStore(
    (state) => state.posts.find((post) => post.id === postId)?.commentsCount,
  );

  const [estado, setEstado] = useState<EstadoDeComentarios<ComentarioConAvatar>>(() =>
    estadoInicial(),
  );
  const [status, setStatus] = useState<'loading' | 'idle' | 'error'>('loading');
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [respondiendo, setRespondiendo] = useState<Respondiendo>(null);

  const load = useCallback(async () => {
    if (!postId) return;
    if (!supabaseEnabled) {
      setEstado(primeraPagina(comentariosDeMuestra, null));
      setStatus('idle');
      return;
    }
    setStatus('loading');
    try {
      const pagina = await PostRepository.listCommentsPage(postId, {
        limit: COMENTARIOS_POR_PAGINA,
      });
      setEstado(primeraPagina(pagina.items, pagina.siguiente, contadorDelMuro));
      setStatus('idle');
    } catch {
      setStatus('error');
    }
    // `contadorDelMuro` fuera a propósito: cambia al publicar, y recargar la
    // lista entera por eso tiraría el scroll de quien está leyendo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postId, supabaseEnabled]);

  useEffect(() => {
    void load();
  }, [load]);

  const cargarMas = useCallback(async () => {
    if (!postId || !supabaseEnabled || cargandoMas || !estado.cursor) return;
    setCargandoMas(true);
    try {
      const pagina = await PostRepository.listCommentsPage(postId, {
        limit: COMENTARIOS_POR_PAGINA,
        before: estado.cursor,
      });
      // Descarta por id lo que ya está: si alguien comenta mientras se lee, el
      // lote siguiente puede solaparse con el anterior.
      setEstado((previo) => anadirPagina(previo, pagina.items, pagina.siguiente));
    } catch {
      // Sin ruido: lo cargado sigue en pantalla y se reintenta bajando.
    } finally {
      setCargandoMas(false);
    }
  }, [cargandoMas, estado.cursor, postId, supabaseEnabled]);

  /**
   * Deja el contador cuadrado con lo que acaba de pasar.
   *
   * En el almacen, para la tarjeta que se esta viendo; y `invalidar` para
   * Inicio y Perfil, que llevan su propia lista y no se enteran de esto.
   */
  const sumarAlContadorDelMuro = useCallback(
    (delta: number) => {
      if (delta === 0 || !postId) return;
      invalidar('comentarios');
      const { posts } = useAppStore.getState();
      if (!posts.some((post) => post.id === postId)) return;
      setPosts(
        posts.map((post) =>
          post.id === postId
            ? {
                ...post,
                commentsCount: (post.commentsCount ?? post.comments.length) + delta,
              }
            : post,
        ),
      );
    },
    [postId, setPosts],
  );

  const enviar = useCallback(async () => {
    if (!postId) return;
    const padre = respondiendo?.id ?? null;
    setSending(true);
    try {
      const resultado = await enviarComentario<ComentarioConAvatar>({
        estado,
        texto: inputText,
        // Se resuelve ANTES de vaciar el campo: si dice que no, el texto sigue
        // ahí y no se ha pintado nada que nadie llegó a publicar.
        autorizar: async () => {
          let autorizado = false;
          await requireAuth('auth.reasonComment', () => {
            autorizado = true;
          });
          return autorizado;
        },
        crear: async (texto) => {
          if (!supabaseEnabled) {
            return {
              id: `local-${Date.now()}`,
              author: currentUser?.fullName ?? t('common.you'),
              text: texto,
              createdAt: t('time.now'),
              authorId: currentUser?.id,
              parentId: padre,
            };
          }
          return PostRepository.addComment(postId, texto, padre);
        },
        optimista: (texto, idProvisional) => ({
          id: idProvisional,
          author: currentUser?.fullName ?? t('common.you'),
          text: texto,
          createdAt: t('time.now'),
          authorId: currentUser?.id,
          parentId: padre,
        }),
      });

      setEstado(resultado.estado);
      setInputText(resultado.texto);
      sumarAlContadorDelMuro(resultado.delta);
      // Se deja de responder solo cuando el envío salió: si falló, el destino
      // sigue puesto y se puede reintentar sin volver a elegirlo.
      if (resultado.delta > 0) setRespondiendo(null);
      if (resultado.fallo === 'servidor') {
        notify(t('post.commentFailed'), t('common.checkConnection'));
      }
    } finally {
      setSending(false);
    }
  }, [
    currentUser,
    estado,
    inputText,
    postId,
    requireAuth,
    respondiendo,
    sumarAlContadorDelMuro,
    supabaseEnabled,
    t,
  ]);

  const uiState =
    status === 'loading'
      ? 'loading'
      : status === 'error'
        ? 'error'
        : estado.lista.length === 0
          ? 'empty'
          : 'content';

  return {
    estado,
    uiState,
    cargandoMas,
    inputText,
    setInputText,
    sending,
    load,
    cargarMas,
    enviar,
    respondiendo,
    setRespondiendo,
  } as const;
}
