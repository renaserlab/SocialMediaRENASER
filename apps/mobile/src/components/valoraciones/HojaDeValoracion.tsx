import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { SelectorDeEstrellas } from '@/components/valoraciones/SelectorDeEstrellas';
import {
  MAX_COMENTARIO,
  comentarioParaEnviar,
  mensajeDeErrorDeValoracion,
  motivoParaNoEnviar,
} from '@/lib/valoracionesDeCurso';
import {
  CourseReviewRepository,
  type ValoracionDeCurso,
} from '@/repositories/CourseReviewRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

type Props = {
  visible: boolean;
  onClose: () => void;
  cursoId: string;
  /** Si llega, la hoja EDITA esa valoracion (PATCH) en vez de crear otra. */
  existente: ValoracionDeCurso | null;
  /** Se llama con lo que devolvio el servidor. Quien recibe cierra y recarga. */
  onGuardada: (valoracion: ValoracionDeCurso, editada: boolean) => void;
};

/**
 * Poner o cambiar la propia valoracion.
 *
 * CREAR Y EDITAR SON LA MISMA HOJA porque son la misma decision —que nota le
 * pongo a esto y por que—, y porque hay UNA valoracion por persona y curso: si
 * ya existe, la unica operacion posible es cambiarla. La hoja se abre con los
 * valores que ya tenia y guarda con `PATCH`; sin valoracion previa, con
 * `POST`. Ofrecer «escribir otra» seria ofrecer un 409.
 *
 * EL ERROR SE ENSENA DENTRO. En iOS un Modal no se presenta encima de otro, y
 * esta hoja es un Modal: un `notify()` desde aqui no se veria y quien pulsa
 * «Guardar» no sabria que ha fallado (ver `InlineError`).
 *
 * RETIRAR NO ESTA AQUI, y es a proposito: la confirmacion vive en un Modal
 * (`DialogHost`), asi que preguntada desde dentro de esta hoja tampoco se
 * veria. Se pregunta desde la seccion, con la hoja cerrada.
 */
export function HojaDeValoracion({ visible, onClose, cursoId, existente, onGuardada }: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  // 0 = sin elegir. NO es una puntuacion: es la ausencia de una.
  const [puntuacion, setPuntuacion] = useState(0);
  const [comentario, setComentario] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
    CERROJO SINCRONO, igual que `comprandoRef` en el detalle del curso.
    `guardando` es estado: no esta puesto hasta el siguiente render, y entre el
    primer toque y ese render caben mas toques. Con dos se mandan dos `POST` y,
    aunque el indice unico de la base impide la segunda fila, el segundo
    intento vuelve como un 409 encima de una valoracion que SI se creo: quien
    valoro lee que no pudo. Una referencia se actualiza en el acto.
  */
  const enviandoRef = useRef(false);

  // Al abrir se parte de lo que ya hay, no de lo que quedo de la vez anterior.
  useEffect(() => {
    if (!visible) return;
    setPuntuacion(existente?.puntuacion ?? 0);
    setComentario(existente?.comentario ?? '');
    setError(null);
  }, [visible, existente]);

  const enviar = async () => {
    if (enviandoRef.current) return;
    const motivo = motivoParaNoEnviar(puntuacion, comentario, t);
    if (motivo) {
      setError(motivo);
      return;
    }
    // Echado ANTES del primer `await`: es lo unico que para el segundo toque.
    enviandoRef.current = true;
    setGuardando(true);
    setError(null);
    try {
      const datos = { puntuacion, comentario: comentarioParaEnviar(comentario) };
      const guardada = existente
        ? await CourseReviewRepository.editar(cursoId, existente.id, datos)
        : await CourseReviewRepository.crear(cursoId, datos);
      onGuardada(guardada, !!existente);
    } catch (fallo) {
      setError(mensajeDeErrorDeValoracion(fallo, t));
    } finally {
      enviandoRef.current = false;
      setGuardando(false);
    }
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={styles.titulo} color={colors.text}>
        {existente ? t('valoracion.editarTitulo') : t('valoracion.crearTitulo')}
      </Text>

      <SelectorDeEstrellas valor={puntuacion} onChange={setPuntuacion} disabled={guardando} />

      <Text variant="secondary" color={colors.textMuted} style={styles.opcional}>
        {t('valoracion.comentarioOpcional')}
      </Text>
      <Input
        value={comentario}
        onChangeText={setComentario}
        placeholder={t('valoracion.comentarioPlaceholder')}
        placeholderTextColor={colors.textMuted}
        maxLength={MAX_COMENTARIO}
        multiline
        editable={!guardando}
        style={[styles.comentario, { color: colors.text }]}
      />

      <InlineError message={error} />

      <Button
        label={existente ? t('common.saveChanges') : t('valoracion.publicar')}
        onPress={() => void enviar()}
        loading={guardando}
        // La mitad VISIBLE de la proteccion contra dos ordenes; la otra es el
        // cerrojo de arriba. Sin puntuacion no hay nada que guardar.
        disabled={guardando || puntuacion === 0}
        style={styles.enviar}
      />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  titulo: {
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.md,
  },
  opcional: { marginTop: spacing.lg, marginBottom: spacing.xs },
  comentario: { minHeight: 96, textAlignVertical: 'top' },
  enviar: { marginTop: spacing.lg },
});
