import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { claveDelFalloDeGrupo } from '@/lib/gruposDeChat';
import {
  MAX_TITULO_DE_ADJUNTO,
  claveDelFalloDeNombre,
  limpiarTitulo,
} from '@/lib/nombresDeAdjuntos';
import {
  MAX_NOMBRE_DE_TEMA,
  MAX_TEMAS_POR_GRUPO,
  claveDelFalloDeTemas,
  juzgarNombreDeTema,
  limpiarNombre,
  type TemaDeGrupo,
} from '@/lib/temasDeGrupo';
import { MessageRepository } from '@/repositories/MessageRepository';
import { TemasRepository } from '@/repositories/TemasRepository';
import { ApiError } from '@/services/api';
import { avisosDeTemas } from '@/services/realtime';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { MessageAttachment } from '@/types';

type Props = {
  /** El grupo: General es su chat. */
  grupoId: string;
  /** El mensaje de General que se agrega o se quita. Sin él, la hoja está cerrada. */
  mensajeId: string | null;
  onClose: () => void;
  /**
   * El audio, documento o video del mensaje que todavía NO tiene nombre. Con
   * él, la hoja ofrece arriba «Nombre (opcional)», que se guarda con «Listo»
   * (lienzo, «1 · Al agregar a un tema, si aún no tiene nombre»).
   */
  adjuntoSinNombre?: MessageAttachment | null;
  /** Se guardó el nombre: para pintarlo ya en el chat. */
  alNombrar?: (adjuntoId: string, titulo: string | null) => void;
  /**
   * Se agregó o se quitó de un tema. El aviso `chat-temas` no le llega a
   * quien lo manda (`self: false`): el chat de debajo refresca su etiqueta
   * con esto.
   */
  alCambiarTemas?: () => void;
};

/**
 * «Agregar a un tema», desde un mensaje de General. Solo para quien administra.
 *
 * UNA CASILLA POR TEMA, marcada si el mensaje ya está en él. Marcar guarda una
 * REFERENCIA —el mismo mensaje, no una copia: sigue en General, con sus
 * reacciones—; desmarcar la quita. Y un campo para crear un tema nuevo con el
 * mensaje ya dentro, que es como se empieza el primero.
 *
 * SE PINTA EN EL ACTO y se corrige si el servidor dice que no. Los errores van
 * DENTRO de la hoja (`InlineError`): un diálogo encima de un `Modal` no se ve
 * en iOS.
 *
 * TRAS CADA CAMBIO SE AVISA por `chat-temas:{grupo}`, sin contenido: quien
 * tenga abierta la lista o ese tema vuelve a preguntar. Agregar no manda push
 * a nadie (D9).
 */
export function HojaDeTemas({
  grupoId,
  mensajeId,
  onClose,
  adjuntoSinNombre = null,
  alNombrar,
  alCambiarTemas,
}: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const visible = !!mensajeId;
  /** «Nombre (opcional)»: solo si el adjunto todavía no tiene. */
  const [titulo, setTitulo] = useState('');
  const [guardandoTitulo, setGuardandoTitulo] = useState(false);

  /** `null` mientras se pregunta. */
  const [temas, setTemas] = useState<TemaDeGrupo[] | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);
  /** El tema que se está cambiando ahora, o `crear`. */
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [nombre, setNombre] = useState('');

  const textoDelFallo = useCallback(
    (error: unknown): string => {
      const codigo = error instanceof ApiError ? error.code : null;
      return t((claveDelFalloDeTemas(codigo) ?? claveDelFalloDeGrupo(codigo)) as TranslationKey);
    },
    [t],
  );

  /*
    EL CANAL SE ABRE AL ABRIR LA HOJA, no al primer cambio: así, cuando se
    marca una casilla, ya está unido y el aviso sale en el acto. Si aún no lo
    estuviera, el aviso espera a que lo esté (ver `avisosDeTemas`).
  */
  const canal = useRef<{ avisar: () => void; cerrar: () => void } | null>(null);
  useEffect(() => {
    if (!visible || !grupoId) return undefined;
    const abierto = avisosDeTemas(grupoId, () => {});
    canal.current = abierto;
    return () => {
      canal.current = null;
      abierto.cerrar();
    };
  }, [visible, grupoId]);

  useEffect(() => {
    if (!mensajeId || !grupoId) return undefined;
    let vigente = true;
    setTemas(null);
    setFallo(null);
    setNombre('');
    setTitulo('');
    TemasRepository.listar(grupoId, { mensajeId })
      .then((leidos) => {
        if (vigente) setTemas(leidos.temas);
      })
      .catch((error) => {
        if (!vigente) return;
        setTemas([]);
        setFallo(textoDelFallo(error));
      });
    return () => {
      vigente = false;
    };
  }, [grupoId, mensajeId, textoDelFallo]);

  const marcar = (temaId: string, contiene: boolean) =>
    setTemas((actuales) =>
      actuales ? actuales.map((tema) => (tema.id === temaId ? { ...tema, contiene } : tema)) : actuales,
    );

  const alternar = async (tema: TemaDeGrupo) => {
    if (!mensajeId || ocupado) return;
    const estaba = tema.contiene === true;
    setOcupado(tema.id);
    setFallo(null);
    marcar(tema.id, !estaba);
    try {
      if (estaba) await TemasRepository.quitar(grupoId, tema.id, mensajeId);
      else await TemasRepository.agregar(grupoId, tema.id, mensajeId);
      canal.current?.avisar();
      alCambiarTemas?.();
    } catch (error) {
      // Lo que se pintó no se guardó: vuelve a como estaba, y se dice.
      marcar(tema.id, estaba);
      setFallo(textoDelFallo(error));
    } finally {
      setOcupado(null);
    }
  };

  /** Un tema nuevo, con el mensaje ya dentro. */
  const crear = async () => {
    if (!mensajeId || ocupado) return;
    const juicio = juzgarNombreDeTema(
      nombre,
      (temas ?? []).map((tema) => tema.nombre),
    );
    if (juicio !== 'vale') {
      setFallo(
        t(
          juicio === 'vacio'
            ? 'groupTopics.errorNameEmpty'
            : juicio === 'largo'
              ? 'groupTopics.errorNameLong'
              : 'groupTopics.errorNameTaken',
        ),
      );
      return;
    }
    setOcupado('crear');
    setFallo(null);
    try {
      const creado = await TemasRepository.crear(grupoId, limpiarNombre(nombre));
      if (creado) {
        setTemas((actuales) => [...(actuales ?? []), { ...creado, contiene: false }]);
        setNombre('');
        await TemasRepository.agregar(grupoId, creado.id, mensajeId);
        marcar(creado.id, true);
      }
      canal.current?.avisar();
      alCambiarTemas?.();
    } catch (error) {
      setFallo(textoDelFallo(error));
    } finally {
      setOcupado(null);
    }
  };

  const caben = (temas?.length ?? 0) < MAX_TEMAS_POR_GRUPO;

  /**
   * «Listo»: si se escribió un nombre, se guarda antes de cerrar (por el
   * `PATCH`, General es el chat del grupo). Si no se puede, se dice aquí
   * dentro y la hoja se queda abierta con lo escrito.
   */
  const listo = async () => {
    const nuevo = limpiarTitulo(titulo);
    if (!adjuntoSinNombre || !mensajeId || !nuevo) {
      onClose();
      return;
    }
    setGuardandoTitulo(true);
    setFallo(null);
    try {
      const guardado = await MessageRepository.nombrarAdjunto(
        grupoId,
        mensajeId,
        adjuntoSinNombre.id,
        nuevo,
      );
      alNombrar?.(adjuntoSinNombre.id, guardado ? guardado.title ?? null : nuevo);
      onClose();
    } catch (error) {
      setFallo(
        t(claveDelFalloDeNombre(error instanceof ApiError ? error.code : null) as TranslationKey),
      );
    } finally {
      setGuardandoTitulo(false);
    }
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View style={styles.cuerpo}>
        <Text weight="800" style={styles.titulo}>
          {t('groupTopics.addToTopic')}
        </Text>
        <Text color={colors.textMuted} style={styles.ayuda}>
          {t('groupTopics.addToTopicHelp')}
        </Text>

        {adjuntoSinNombre ? (
          <View style={styles.campoDeNombre}>
            <Input
              label={t('attachmentName.optionalLabel')}
              value={titulo}
              onChangeText={(texto) => {
                setTitulo(texto);
                setFallo(null);
              }}
              maxLength={MAX_TITULO_DE_ADJUNTO}
              returnKeyType="done"
            />
            <View style={styles.pieDelNombre}>
              <Text color={colors.textMuted} style={styles.ayudaDelNombre}>
                {t('attachmentName.optionalHelp')}
              </Text>
              <Text color={colors.textMuted} style={styles.cuenta}>
                {`${titulo.length}/${MAX_TITULO_DE_ADJUNTO}`}
              </Text>
            </View>
          </View>
        ) : null}

        {temas === null ? (
          <View style={styles.cargando}>
            <ActivityIndicator size="small" color={colors.textMuted} />
          </View>
        ) : temas.length === 0 ? (
          <Text color={colors.textMuted} style={styles.ayuda}>
            {t('groupTopics.addToTopicNone')}
          </Text>
        ) : (
          <View>
            {temas.map((tema) => {
              const marcado = tema.contiene === true;
              return (
                <Pressable
                  key={tema.id}
                  onPress={() => void alternar(tema)}
                  disabled={!!ocupado}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: marcado, disabled: !!ocupado }}
                  accessibilityLabel={tema.nombre}
                  // Lo que hace tocarla, dicho: quien no ve el ✓ sabe que la quita.
                  accessibilityHint={marcado ? t('groupTopics.alreadyHere') : undefined}
                  style={[styles.fila, { borderBottomColor: colors.border }]}
                >
                  <View style={[styles.icono, { borderColor: colors.border }]}>
                    <Feather name={tema.icono} size={18} color={colors.text} />
                  </View>
                  <View style={styles.textos}>
                    <Text weight="600" numberOfLines={1} style={styles.nombre}>
                      {tema.nombre}
                    </Text>
                    {marcado ? (
                      <Text color={colors.textMuted} numberOfLines={1} style={styles.yaEsta}>
                        {t('groupTopics.alreadyHere')}
                      </Text>
                    ) : null}
                  </View>
                  {ocupado === tema.id ? (
                    <ActivityIndicator size="small" color={colors.textMuted} />
                  ) : marcado ? (
                    // La casilla se dice con su forma, no solo con el color:
                    // un círculo lleno con el ✓, o uno vacío.
                    <View style={[styles.marca, { backgroundColor: colors.primary }]}>
                      <Feather name="check" size={14} color={colors.onPrimary} />
                    </View>
                  ) : (
                    <View style={[styles.marca, styles.marcaLibre, { borderColor: colors.border }]} />
                  )}
                </Pressable>
              );
            })}
          </View>
        )}

        <InlineError message={fallo} />

        {temas !== null && caben ? (
          <View style={styles.nuevo}>
            <Input
              label={t('groupTopics.newTopic')}
              value={nombre}
              onChangeText={(texto) => {
                setNombre(texto);
                setFallo(null);
              }}
              placeholder={t('groupTopics.namePlaceholder')}
              maxLength={MAX_NOMBRE_DE_TEMA}
              returnKeyType="done"
              onSubmitEditing={() => void crear()}
            />
            {limpiarNombre(nombre) ? (
              <Button
                label={t('groupTopics.createAndAdd')}
                variant="secondary"
                icon="folder-plus"
                onPress={() => void crear()}
                loading={ocupado === 'crear'}
                disabled={!!ocupado}
              />
            ) : null}
          </View>
        ) : null}

        <Button
          label={t('groupTopics.done')}
          onPress={() => void listo()}
          loading={guardandoTitulo}
          disabled={ocupado === 'crear' || guardandoTitulo}
        />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  cuerpo: { gap: spacing.sm, paddingBottom: spacing.sm },
  titulo: { fontSize: 20, lineHeight: 24 },
  ayuda: { fontSize: 13, lineHeight: 18 },
  cargando: { paddingVertical: spacing.lg, alignItems: 'center' },
  fila: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  icono: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textos: { flex: 1, minWidth: 0 },
  nombre: { fontSize: 15 },
  yaEsta: { fontSize: 12, lineHeight: 16 },
  marca: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  marcaLibre: { borderWidth: 2 },
  nuevo: { gap: spacing.sm, marginTop: spacing.xs },
  campoDeNombre: { gap: spacing.xs },
  pieDelNombre: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  ayudaDelNombre: { flex: 1, fontSize: 12, lineHeight: 16 },
  cuenta: { fontSize: 12, lineHeight: 16 },
});
