import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import {
  LARGO_MAXIMO,
  mensajeDeErrorDeNota,
  minutoDeLaNota,
  notaValida,
  nuevaClaveDeGuardado,
  pestanaNoMontada,
} from '@/lib/notasDeLeccion';
import { toast } from '@/lib/toast';
import {
  LessonNoteRepository,
  type NotaDeLeccion,
} from '@/repositories/LessonNoteRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

type Props = {
  leccionId: string;
  /** El segundo en el que va el vídeo AHORA, o `null` si no se sabe. */
  posicionActual: number | null;
};

/**
 * Mis apuntes de esta lección.
 *
 * SON PRIVADOS Y NO HAY MATIZ. No los ve el autor del curso, ni moderación, ni
 * otro alumno; el servidor no tiene ninguna ruta que los devuelva a nadie más.
 * Aquí no hay «compartir» ni «publicar» a propósito.
 *
 * TRES ESTADOS QUE NO SON EL MISMO: cargando, vacío («todavía no has escrito
 * nada») y error («no se pudo leer», con reintento). Callar el tercero lo
 * convertiría en el segundo, que es una afirmación falsa sobre lo que alguien
 * escribió.
 *
 * Y UNO MÁS QUE NO SE PINTA: con 503 `lesson_notes_not_available` la pestaña
 * entera desaparece. No es una avería: es que la 0057 no está aplicada aquí.
 */
export function NotasDeLaLeccion({ leccionId, posicionActual }: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();

  const [lista, setLista] = useState<NotaDeLeccion[]>([]);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<unknown>(null);
  const [borrador, setBorrador] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [editando, setEditando] = useState<NotaDeLeccion | null>(null);

  /** La posición congelada al empezar a escribir: si se sigue reproduciendo,
   * guardar apuntaría a un minuto que no es el que se estaba comentando. */
  const posicionDelBorrador = useRef<number | null>(null);
  /** Clave de idempotencia del apunte en curso. Se reusa en el reintento. */
  const claveRef = useRef<string | null>(null);
  /** Cerrojos síncronos: dos toques no guardan dos veces ni borran dos veces. */
  const guardandoRef = useRef(false);
  const borrandoRef = useRef(false);
  /** Qué carga es la buena: la respuesta de otra lección no pisa esta lista. */
  const generacionRef = useRef(0);

  const cargar = useCallback(async () => {
    generacionRef.current += 1;
    const generacion = generacionRef.current;
    setCargando(true);
    setFallo(null);
    try {
      const notas = await LessonNoteRepository.listar(leccionId);
      if (generacionRef.current !== generacion) return;
      setLista(notas);
    } catch (error) {
      if (generacionRef.current !== generacion) return;
      setFallo(error);
    } finally {
      if (generacionRef.current === generacion) setCargando(false);
    }
  }, [leccionId]);

  useEffect(() => {
    void cargar();
    return () => {
      generacionRef.current += 1;
    };
  }, [cargar]);

  const alEscribir = (texto: string) => {
    if (borrador.trim() === '' && texto.trim() !== '') {
      // Empieza un apunte nuevo: se congela el minuto y se estrena la clave.
      posicionDelBorrador.current = posicionActual;
      claveRef.current = nuevaClaveDeGuardado();
    }
    setBorrador(texto);
  };

  const guardar = async () => {
    if (guardandoRef.current || !notaValida(borrador)) return;
    guardandoRef.current = true;
    setGuardando(true);
    try {
      if (editando) {
        await LessonNoteRepository.editar(editando.id, borrador.trim());
        toast(t('nota.actualizada'));
      } else {
        await LessonNoteRepository.crear(leccionId, {
          texto: borrador.trim(),
          posicionSegundos: posicionDelBorrador.current,
          clave: claveRef.current ?? nuevaClaveDeGuardado(),
        });
        toast(t('nota.guardada'));
      }
      setBorrador('');
      setEditando(null);
      claveRef.current = null;
      posicionDelBorrador.current = null;
      await cargar();
    } catch (error) {
      // El borrador NO se limpia: perder lo que alguien acaba de escribir por
      // un fallo de red es cambiar un contratiempo por un borrado.
      notify(t('common.saveFailed'), mensajeDeErrorDeNota(error, t));
    } finally {
      guardandoRef.current = false;
      setGuardando(false);
    }
  };

  const retirar = async (nota: NotaDeLeccion) => {
    if (borrandoRef.current) return;
    // Echado ANTES del primer `await`, que aquí es el propio diálogo.
    borrandoRef.current = true;
    try {
      const aceptado = await confirm({
        title: t('nota.borrarTitulo'),
        message: t('nota.borrarCuerpo'),
        confirmLabel: t('common.delete'),
        destructive: true,
      });
      if (!aceptado) return;
      await LessonNoteRepository.retirar(nota.id);
      if (editando?.id === nota.id) {
        setEditando(null);
        setBorrador('');
      }
      toast(t('nota.borrada'));
      await cargar();
    } catch (error) {
      notify(t('common.deleteFailed'), mensajeDeErrorDeNota(error, t));
    } finally {
      borrandoRef.current = false;
    }
  };

  // La función no está montada en esta instalación: ni pestaña, ni error.
  if (pestanaNoMontada(fallo)) return null;

  const minutoNuevo = minutoDeLaNota(
    borrador.trim() === '' ? posicionActual : posicionDelBorrador.current,
  );

  return (
    <View style={styles.seccion}>
      <View style={[styles.compositor, { backgroundColor: colors.surfaceAlt }]}>
        <Text variant="secondary" weight="700">
          {editando
            ? t('nota.editandoTitulo')
            : minutoNuevo
              ? t('nota.escribirEn', { minuto: minutoNuevo })
              : t('nota.escribir')}
        </Text>
        <Input
          value={borrador}
          onChangeText={alEscribir}
          placeholder={t('nota.marcador')}
          placeholderTextColor={colors.textMuted}
          multiline
          numberOfLines={4}
          maxLength={LARGO_MAXIMO}
          textAlignVertical="top"
          accessibilityLabel={t('nota.marcador')}
          style={{ color: colors.text, minHeight: 88 }}
        />
        <View style={styles.acciones}>
          {editando ? (
            <Button
              label={t('common.cancel')}
              variant="ghost"
              onPress={() => {
                setEditando(null);
                setBorrador('');
              }}
              style={styles.boton}
            />
          ) : null}
          <Button
            label={editando ? t('common.save') : t('nota.guardar')}
            onPress={() => void guardar()}
            loading={guardando}
            disabled={guardando || !notaValida(borrador)}
            style={styles.boton}
          />
        </View>
      </View>

      {cargando ? (
        <StateView state="loading" style={styles.estado} />
      ) : fallo !== null ? (
        <StateView
          state="error"
          description={mensajeDeErrorDeNota(fallo, t)}
          onRetry={() => void cargar()}
          style={styles.estado}
        />
      ) : lista.length === 0 ? (
        <Text variant="secondary" color={colors.textMuted} style={styles.vacio}>
          {t('nota.vacio')}
        </Text>
      ) : (
        <View style={styles.lista}>
          <Text variant="secondary" weight="700">
            {t('nota.guardadas')}
          </Text>
          {lista.map((nota) => (
            <Fila
              key={nota.id}
              nota={nota}
              onEditar={() => {
                setEditando(nota);
                setBorrador(nota.texto);
              }}
              onBorrar={() => void retirar(nota)}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function Fila({
  nota,
  onEditar,
  onBorrar,
}: {
  nota: NotaDeLeccion;
  onEditar: () => void;
  onBorrar: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const minuto = minutoDeLaNota(nota.posicionSegundos);

  return (
    <View style={[styles.fila, { borderColor: colors.border }]}>
      <View style={styles.cabecera}>
        {/* El minuto SOLO si consta. «0:00» diría que fue al principio. */}
        {minuto ? (
          <View style={[styles.minuto, { backgroundColor: colors.surfaceAlt }]}>
            <Text variant="caption" color={colors.textMuted}>
              {minuto}
            </Text>
          </View>
        ) : null}
        <View style={styles.iconos}>
          <Pressable
            onPress={onEditar}
            hitSlop={10}
            style={styles.icono}
            accessibilityRole="button"
            accessibilityLabel={t('nota.editar')}
          >
            <Feather name="edit-2" size={15} color={colors.textMuted} />
          </Pressable>
          <Pressable
            onPress={onBorrar}
            hitSlop={10}
            style={styles.icono}
            accessibilityRole="button"
            accessibilityLabel={t('nota.borrarTitulo')}
          >
            <Feather name="trash-2" size={15} color={colors.textMuted} />
          </Pressable>
        </View>
      </View>
      <Text variant="body">{nota.texto}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  seccion: { gap: spacing.md },
  compositor: { borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm },
  acciones: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'flex-end' },
  boton: { flexShrink: 1 },
  estado: { minHeight: 100 },
  vacio: { marginTop: spacing.sm },
  lista: { gap: spacing.sm },
  fila: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  cabecera: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    // Sin altura mínima la fila se queda sin cabecera cuando no hay minuto.
    minHeight: 30,
  },
  minuto: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  iconos: { flexDirection: 'row', gap: spacing.xs, marginLeft: 'auto' },
  // 44 pt es el mínimo pulsable.
  icono: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
