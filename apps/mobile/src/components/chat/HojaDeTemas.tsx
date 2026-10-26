import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { claveDelFalloDeGrupo } from '@/lib/gruposDeChat';
import {
  MAX_NOMBRE_DE_TEMA,
  MAX_TEMAS_POR_GRUPO,
  claveDelFalloDeTemas,
  juzgarNombreDeTema,
  limpiarNombre,
  type TemaDeGrupo,
} from '@/lib/temasDeGrupo';
import { TemasRepository } from '@/repositories/TemasRepository';
import { ApiError } from '@/services/api';
import { avisosDeTemas } from '@/services/realtime';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  /** El grupo: General es su chat. */
  grupoId: string;
  /** El mensaje de General que se agrega o se quita. Sin él, la hoja está cerrada. */
  mensajeId: string | null;
  onClose: () => void;
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
export function HojaDeTemas({ grupoId, mensajeId, onClose }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const visible = !!mensajeId;

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
    } catch (error) {
      setFallo(textoDelFallo(error));
    } finally {
      setOcupado(null);
    }
  };

  const caben = (temas?.length ?? 0) < MAX_TEMAS_POR_GRUPO;

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View style={styles.cuerpo}>
        <Text weight="800" style={styles.titulo}>
          {t('groupTopics.addToTopic')}
        </Text>
        <Text color={colors.textMuted} style={styles.ayuda}>
          {t('groupTopics.addToTopicHelp')}
        </Text>

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
                  style={[styles.fila, { borderBottomColor: colors.border }]}
                >
                  <Feather name={tema.icono} size={18} color={colors.text} />
                  <Text numberOfLines={1} style={styles.nombre}>
                    {tema.nombre}
                  </Text>
                  {ocupado === tema.id ? (
                    <ActivityIndicator size="small" color={colors.textMuted} />
                  ) : (
                    // La casilla se dice con su forma, no solo con el color.
                    <Feather
                      name={marcado ? 'check-square' : 'square'}
                      size={20}
                      color={marcado ? colors.text : colors.textMuted}
                    />
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

        <Button label={t('groupTopics.done')} onPress={onClose} disabled={ocupado === 'crear'} />
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
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  nombre: { flex: 1, fontSize: 15 },
  nuevo: { gap: spacing.sm, marginTop: spacing.xs },
});
