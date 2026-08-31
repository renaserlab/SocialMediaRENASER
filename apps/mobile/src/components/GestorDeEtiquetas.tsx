import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Text } from '@/components/Text';
import { confirm } from '@/lib/confirm';
import { describeError } from '@/lib/describeError';
import { toast } from '@/lib/toast';
import { useTranslation } from '@/i18n/useTranslation';
import {
  EtiquetasRepository,
  esFuncionNoDisponible,
  MAX_NOMBRE_DE_ETIQUETA,
  type Etiqueta,
} from '@/repositories/EtiquetasRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Las etiquetas de quien mira, tal y como las tiene la pantalla. */
  etiquetas: Etiqueta[];
  /**
   * La conversación sobre la que se pone y se quita.
   *
   * `null` o ausente = sólo se gestiona la LISTA (crear, renombrar, eliminar).
   * Es el modo con el que se abre desde la fila de chips, donde no hay ninguna
   * conversación delante.
   */
  conversationId?: string | null;
  /**
   * Se llama después de CADA cambio que confirma el servidor, para que la
   * pantalla vuelva a pedir las etiquetas y la lista de conversaciones.
   *
   * No se devuelve aquí el estado nuevo a propósito: quien pinta la bandeja es
   * quien sabe qué más hay que recargar —los chips, la lista filtrada, el
   * contador— y adivinarlo desde aquí acabaría dejando media pantalla vieja.
   */
  alCambiar: () => void | Promise<void>;
  /**
   * Aviso de que el servidor dice que la migración 0045 todavía no está.
   * La pantalla debería esconder la función entera: nunca un botón muerto.
   */
  alDejarDeEstarDisponible?: () => void;
};

/**
 * Crear, renombrar, eliminar etiquetas; y ponerlas y quitarlas de un chat.
 *
 * LA GESTIÓN VIVE JUNTO A LOS FILTROS y no en una pantalla de ajustes aparte,
 * por lo mismo que en `CategoriasDePodcast`: uno se da cuenta de que le falta
 * una etiqueta —o de que le sobra— justo cuando está mirando la bandeja, no
 * tres pantallas más adentro.
 *
 * -----------------------------------------------------------------------------
 * LO QUE SE DICE A LA VISTA: QUE SON PRIVADAS
 * -----------------------------------------------------------------------------
 * `label.explain` no está escondido en una ayuda ni en un pie de página. Quien
 * va a etiquetar a una persona con «Interesado» o «Pendiente» tiene que saber,
 * ANTES de escribirlo, que esa persona no se entera. Si no lo sabe, o no lo usa
 * —por miedo a ofender— o lo usa creyendo que es compartido. Las dos cosas son
 * peores que una línea de texto.
 *
 * -----------------------------------------------------------------------------
 * DOS COSAS QUE PARECEN UNA
 * -----------------------------------------------------------------------------
 * Arriba se PONE y se QUITA la etiqueta de esta conversación (sólo si hay una
 * conversación delante). Abajo se gestiona la LISTA. Van en la misma hoja
 * porque el gesto natural —«esta persona es un alumno... espera, no tengo esa
 * etiqueta»— cruza las dos, y obligar a cerrar y abrir otra pantalla en medio
 * es lo que hace que nadie acabe organizando nada.
 *
 * -----------------------------------------------------------------------------
 * ASIGNAR ES OPTIMISTA; CREAR Y BORRAR NO
 * -----------------------------------------------------------------------------
 * Poner o quitar una etiqueta se pinta al instante y se deshace si el servidor
 * dice que no: es un gesto que se repite mucho y esperar a la red en cada toque
 * lo vuelve inservible. Crear, renombrar y borrar sí esperan, porque cambian la
 * lista que se está mirando y porque el servidor puede rechazarlos por un
 * motivo que hay que leer (un nombre repetido, el tope de etiquetas).
 */
export function GestorDeEtiquetas({
  visible,
  onClose,
  etiquetas,
  conversationId = null,
  alCambiar,
  alDejarDeEstarDisponible,
}: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();

  const [nombre, setNombre] = useState('');
  const [editando, setEditando] = useState<Etiqueta | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Los identificadores puestos en esta conversación. `null` = aún cargando. */
  const [asignadas, setAsignadas] = useState<string[] | null>(null);

  /**
   * Un fallo del servidor, traducido a algo que se pueda leer.
   *
   * El 503 de la migración se trata aparte: no es un error de quien está
   * mirando, así que en vez de pintarlo en rojo se cierra la hoja y se avisa
   * hacia arriba para que la función deje de ofrecerse.
   */
  const fallo = useCallback(
    (e: unknown, respaldo: string) => {
      if (esFuncionNoDisponible(e)) {
        alDejarDeEstarDisponible?.();
        onClose();
        return;
      }
      // El backend rechaza los nombres repetidos y el tope con un motivo claro;
      // se pinta tal cual en vez de un «no se pudo» que no dice qué arreglar.
      setError(describeError(e, respaldo));
    },
    [alDejarDeEstarDisponible, onClose],
  );

  // Las etiquetas de ESTA conversación se piden al abrir, y no se heredan por
  // props: la pantalla de la bandeja no las tiene —su listado no las trae— y
  // pedirle que las cargara sólo para pasarlas aquí sería una petición más en
  // cada apertura de la pantalla para algo que casi nunca se abre.
  useEffect(() => {
    if (!visible || !conversationId) {
      setAsignadas(conversationId ? null : []);
      return;
    }
    let vigente = true;
    setAsignadas(null);
    EtiquetasRepository.deLaConversacion(conversationId)
      .then((puestas) => {
        if (vigente) setAsignadas(puestas.map((e) => e.id));
      })
      .catch((e) => {
        if (!vigente) return;
        // Sin esto quedaría girando para siempre. Se muestra la lista sin
        // ninguna marcada, que es peor que la verdad pero mejor que nada: al
        // tocar una, el servidor sigue siendo quien decide.
        setAsignadas([]);
        fallo(e, t('label.assignFailed'));
      });
    return () => {
      vigente = false;
    };
  }, [visible, conversationId, fallo, t]);

  const cerrar = () => {
    setEditando(null);
    setNombre('');
    setError(null);
    onClose();
  };

  const guardar = async () => {
    const limpio = nombre.trim();
    if (!limpio) {
      setError(t('label.needName'));
      return;
    }
    setOcupado(true);
    setError(null);
    try {
      if (editando) {
        await EtiquetasRepository.renombrar(editando.id, limpio);
        toast(t('label.renamed'));
      } else {
        await EtiquetasRepository.crear(limpio);
        toast(t('label.created'));
      }
      setEditando(null);
      setNombre('');
      await alCambiar();
    } catch (e) {
      fallo(e, t('label.saveFailed'));
    } finally {
      setOcupado(false);
    }
  };

  const eliminar = async (etiqueta: Etiqueta) => {
    const seguro = await confirm({
      title: t('label.deleteNamed', { nombre: etiqueta.nombre }),
      // El mensaje dice EXACTAMENTE lo que no pasa. Es lo que más miedo da al
      // pulsarlo —«¿me va a borrar la conversación?»— y la respuesta es que no:
      // se quita la etiqueta y nada más.
      message:
        etiqueta.conversaciones > 0
          ? t('label.deleteKeepsChats', { count: etiqueta.conversaciones })
          : t('label.deleteUnused'),
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!seguro) return;

    setOcupado(true);
    setError(null);
    try {
      await EtiquetasRepository.borrar(etiqueta.id);
      setAsignadas((previas) =>
        previas === null ? previas : previas.filter((id) => id !== etiqueta.id),
      );
      if (editando?.id === etiqueta.id) {
        setEditando(null);
        setNombre('');
      }
      toast(t('label.deleted'));
      await alCambiar();
    } catch (e) {
      fallo(e, t('label.deleteFailed'));
    } finally {
      setOcupado(false);
    }
  };

  const alternar = async (etiqueta: Etiqueta) => {
    if (!conversationId || asignadas === null) return;
    const estaba = asignadas.includes(etiqueta.id);

    // Optimista: el chip cambia en el mismo toque. Ver la cabecera del fichero.
    setAsignadas(
      estaba
        ? asignadas.filter((id) => id !== etiqueta.id)
        : [...asignadas, etiqueta.id],
    );
    setError(null);
    try {
      if (estaba) {
        await EtiquetasRepository.quitar(conversationId, etiqueta.id);
      } else {
        await EtiquetasRepository.asignar(conversationId, etiqueta.id);
      }
      await alCambiar();
    } catch (e) {
      // Se deshace al estado ANTERIOR, no se recarga: recargar tardaría otra
      // vuelta a la red y durante ese rato el chip seguiría mintiendo.
      setAsignadas(asignadas);
      fallo(e, t('label.assignFailed'));
    }
  };

  return (
    <BottomSheet visible={visible} onClose={cerrar}>
      {/* Poner y quitar en ESTA conversación. Sólo si hay una delante. */}
      {conversationId ? (
        <View style={styles.bloque}>
          <Text variant="caption" weight="800" color={colors.text} style={styles.titulo}>
            {t('label.inThisChat')}
          </Text>
          <Text variant="secondary" color={colors.textMuted} style={styles.explicacion}>
            {t('label.onlyYou')}
          </Text>

          {asignadas === null ? (
            <ActivityIndicator color={colors.text} />
          ) : etiquetas.length === 0 ? (
            <Text variant="secondary" color={colors.textMuted}>
              {t('label.none')}
            </Text>
          ) : (
            <View style={styles.chips}>
              {etiquetas.map((etiqueta) => (
                <Chip
                  key={etiqueta.id}
                  label={etiqueta.nombre}
                  selected={asignadas.includes(etiqueta.id)}
                  onPress={() => void alternar(etiqueta)}
                />
              ))}
            </View>
          )}
        </View>
      ) : null}

      {/* La lista: crear, renombrar y eliminar. */}
      <Text variant="caption" weight="800" color={colors.text} style={styles.titulo}>
        {t('label.yours')}
      </Text>
      <Text variant="secondary" color={colors.textMuted} style={styles.explicacion}>
        {t('label.explain')}
      </Text>

      <View
        style={[
          styles.campo,
          { borderColor: colors.border, backgroundColor: colors.surface },
        ]}
      >
        <TextInput
          value={nombre}
          onChangeText={setNombre}
          placeholder={editando ? t('label.newName') : t('label.namePlaceholder')}
          placeholderTextColor={colors.textMuted}
          // El mismo tope que la base (`check` de la 0045) y que el backend. Si
          // aquí se dejara escribir de más, el servidor lo rechazaría después de
          // haber escrito: mejor que el campo no deje pasar de ahí.
          maxLength={MAX_NOMBRE_DE_ETIQUETA}
          style={[styles.entrada, { color: colors.text }]}
          accessibilityLabel={t('label.namePlaceholder')}
          onSubmitEditing={() => void guardar()}
          returnKeyType="done"
        />
        {ocupado ? <ActivityIndicator color={colors.text} /> : null}
      </View>

      {/* La sugerencia sólo cuando no hay ninguna: son EJEMPLOS, no una lista
          cerrada. Las etiquetas son de quien organiza su bandeja, y un
          carpintero no necesita las mismas que un formador. */}
      {etiquetas.length === 0 && !editando ? (
        <Text variant="caption" color={colors.textMuted} style={styles.sugerencias}>
          {t('label.suggestions')}
        </Text>
      ) : null}

      {error ? (
        <Text variant="caption" weight="700" color={colors.danger} style={styles.error}>
          {error}
        </Text>
      ) : null}

      <View style={styles.acciones}>
        <Button
          label={editando ? t('common.save') : t('label.add')}
          onPress={() => void guardar()}
          disabled={ocupado || !nombre.trim()}
          style={styles.accion}
        />
        {editando ? (
          <Button
            label={t('common.cancel')}
            variant="secondary"
            onPress={() => {
              setEditando(null);
              setNombre('');
              setError(null);
            }}
            style={styles.accion}
          />
        ) : null}
      </View>

      {/* La lista se desplaza sola: con el tope del servidor caben muchas más
          de las que entran en una hoja, y sin esto las últimas quedarían fuera
          de la pantalla sin forma de llegar a ellas. */}
      <ScrollView style={styles.lista} keyboardShouldPersistTaps="handled">
        {etiquetas.length === 0 ? (
          <Text variant="secondary" color={colors.textMuted}>
            {t('label.none')}
          </Text>
        ) : (
          etiquetas.map((etiqueta) => (
            <View key={etiqueta.id} style={[styles.linea, { borderColor: colors.border }]}>
              <View style={styles.datos}>
                <Text variant="secondary" weight="700" color={colors.text}>
                  {etiqueta.nombre}
                </Text>
                <Text variant="caption" color={colors.textMuted}>
                  {etiqueta.conversaciones === 1
                    ? t('label.chatsOne')
                    : t('label.chatsMany', { count: etiqueta.conversaciones })}
                </Text>
              </View>
              <Pressable
                onPress={() => {
                  setEditando(etiqueta);
                  setNombre(etiqueta.nombre);
                  setError(null);
                }}
                hitSlop={8}
                style={styles.iconoAccion}
                accessibilityRole="button"
                accessibilityLabel={t('label.renameNamed', { nombre: etiqueta.nombre })}
              >
                <Feather name="edit-2" size={16} color={colors.textMuted} />
              </Pressable>
              <Pressable
                onPress={() => void eliminar(etiqueta)}
                hitSlop={8}
                style={styles.iconoAccion}
                accessibilityRole="button"
                accessibilityLabel={t('label.deleteNamedShort', {
                  nombre: etiqueta.nombre,
                })}
              >
                <Feather name="trash-2" size={16} color={colors.textMuted} />
              </Pressable>
            </View>
          ))
        )}
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  bloque: { marginBottom: spacing.lg },
  titulo: { textTransform: 'uppercase', letterSpacing: 1, marginBottom: spacing.xs },
  explicacion: { marginBottom: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  campo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    minHeight: 48,
  },
  entrada: { flex: 1, fontSize: 15 },
  sugerencias: { marginTop: spacing.sm },
  error: { marginTop: spacing.sm },
  acciones: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  accion: { flex: 1 },
  lista: { marginTop: spacing.lg, maxHeight: 260 },
  linea: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.sm,
  },
  datos: { flex: 1 },
  iconoAccion: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
});
