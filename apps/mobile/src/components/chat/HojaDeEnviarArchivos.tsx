import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { aspectoDeArchivo, pesoLegible } from '@/lib/mediosDeChat';
import { MAX_TITULO_DE_ADJUNTO, limpiarTitulo, nombrePorDefecto } from '@/lib/nombresDeAdjuntos';
import type { AdjuntoElegido } from '@/services/messageMedia';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/** Lo elegido con «Archivo», a la espera de sus nombres. */
export type ArchivosPorEnviar = {
  archivos: AdjuntoElegido[];
  /** Los que se eligieron de más y se quedaron fuera (el tope es diez). */
  sobran: number;
};

type Props = {
  /** `null`: cerrada. */
  eleccion: ArchivosPorEnviar | null;
  onClose: () => void;
  /** Cada archivo ya con su nombre (`title`). Uno por mensaje. */
  alEnviar: (archivos: AdjuntoElegido[]) => void;
};

type Fila = { archivo: AdjuntoElegido; nombre: string };

/**
 * «Enviar archivo» y «Enviar N archivos» (audios y temas, 30/10/2026).
 *
 * UN CAMPO POR ARCHIVO, que empieza con el nombre del fichero sin extensión
 * y con los guiones como espacios, salvo los de cámara (`IMG_…`, `VID_…`,
 * `PXL_…`, `WhatsApp Audio…`), que empiezan vacíos: ese nombre no dice nada.
 * Ver `nombrePorDefecto`. Cada archivo sale después como SU PROPIO mensaje,
 * con su nombre, que se puede cambiar más tarde desde el menú del mensaje.
 *
 * La hoja se abre cuando el selector del sistema ya se cerró, y se cierra
 * antes de enviar: lo que se manda se ve en el chat, con su barra de subida.
 */
export function HojaDeEnviarArchivos({ eleccion, onClose, alEnviar }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [filas, setFilas] = useState<Fila[]>([]);

  useEffect(() => {
    setFilas(
      (eleccion?.archivos ?? []).map((archivo) => ({
        archivo,
        nombre: nombrePorDefecto(archivo.name),
      })),
    );
  }, [eleccion]);

  const cambiar = (indice: number, nombre: string) =>
    setFilas((actuales) => actuales.map((fila, i) => (i === indice ? { ...fila, nombre } : fila)));

  const quitar = (indice: number) => {
    const quedan = filas.filter((_, i) => i !== indice);
    setFilas(quedan);
    // Sin ninguno no hay nada que enviar: la hoja se va.
    if (quedan.length === 0) onClose();
  };

  const enviar = () => {
    if (filas.length === 0) return;
    alEnviar(filas.map(({ archivo, nombre }) => ({ ...archivo, title: limpiarTitulo(nombre) })));
  };

  const uno = filas.length === 1 ? filas[0] : null;

  return (
    <BottomSheet visible={!!eleccion && filas.length > 0} onClose={onClose}>
      <View style={styles.cuerpo}>
        <Text weight="800" style={styles.titulo}>
          {uno ? t('sendFiles.titleOne') : t('sendFiles.titleMany', { n: filas.length })}
        </Text>
        {uno ? null : (
          <Text color={colors.textMuted} style={styles.ayuda}>
            {t('sendFiles.helpMany')}
          </Text>
        )}
        {eleccion && eleccion.sobran > 0 ? (
          <Text color={colors.textMuted} style={styles.ayuda}>
            {t('sendFiles.tooMany', {
              n: eleccion.archivos.length + eleccion.sobran,
              max: eleccion.archivos.length,
            })}
          </Text>
        ) : null}

        {uno ? (
          <>
            <View style={[styles.archivo, { backgroundColor: colors.tarjetaRelleno }]}>
              <Sigla archivo={uno.archivo} grande />
              <View style={styles.textos}>
                <Text weight="600" numberOfLines={1} style={styles.nombreDeArchivo}>
                  {uno.archivo.name || t('chat.file')}
                </Text>
                {uno.archivo.bytes ? (
                  <Text color={colors.textMuted} style={styles.peso}>
                    {pesoLegible(uno.archivo.bytes)}
                  </Text>
                ) : null}
              </View>
            </View>
            <Input
              label={t('sendFiles.nameLabel')}
              value={uno.nombre}
              onChangeText={(texto) => cambiar(0, texto)}
              placeholder={t('sendFiles.namePlaceholder')}
              maxLength={MAX_TITULO_DE_ADJUNTO}
              returnKeyType="send"
              onSubmitEditing={enviar}
            />
            <View style={styles.pie}>
              <Text color={colors.textMuted} style={[styles.ayuda, styles.ayudaDelCampo]}>
                {t('sendFiles.helpOne')}
              </Text>
              <Text color={colors.textMuted} style={styles.cuenta}>
                {`${uno.nombre.length}/${MAX_TITULO_DE_ADJUNTO}`}
              </Text>
            </View>
          </>
        ) : (
          <View>
            {filas.map((fila, indice) => {
              const archivo = fila.archivo.name || t('chat.file');
              return (
                <View
                  // El orden no cambia más que al quitar, y quitar rehace la lista.
                  key={`${fila.archivo.uri}-${indice}`}
                  style={[styles.fila, { borderBottomColor: colors.border }]}
                >
                  <Sigla archivo={fila.archivo} />
                  <View style={styles.textos}>
                    <Input
                      value={fila.nombre}
                      onChangeText={(texto) => cambiar(indice, texto)}
                      placeholder={t('sendFiles.namePlaceholder')}
                      accessibilityLabel={t('sendFiles.nameOf', { archivo })}
                      maxLength={MAX_TITULO_DE_ADJUNTO}
                      containerStyle={styles.campo}
                    />
                    <Text color={colors.textMuted} numberOfLines={1} style={styles.peso}>
                      {[archivo, pesoLegible(fila.archivo.bytes)].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => quitar(indice)}
                    accessibilityRole="button"
                    accessibilityLabel={t('sendFiles.remove', { archivo })}
                    hitSlop={6}
                    style={styles.quitar}
                  >
                    <Feather name="x" size={18} color={colors.textMuted} />
                  </Pressable>
                </View>
              );
            })}
          </View>
        )}

        <Button
          label={uno ? t('common.send') : t('sendFiles.sendMany', { n: filas.length })}
          onPress={enviar}
          icon="send"
        />
        {uno ? <Button label={t('common.cancel')} variant="secondary" onPress={onClose} /> : null}
      </View>
    </BottomSheet>
  );
}

/** El cuadrito del tipo: la sigla del archivo, o la nota musical de un audio. */
function Sigla({ archivo, grande = false }: { archivo: AdjuntoElegido; grande?: boolean }) {
  const { colors } = useAppTheme();
  const aspecto = aspectoDeArchivo(archivo.mimeType, archivo.name);
  const icono = archivo.kind === 'audio' ? 'music' : aspecto.icono;
  return (
    <View
      style={[styles.sigla, grande && styles.siglaGrande, { backgroundColor: colors.text }]}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      {aspecto.sigla && archivo.kind !== 'audio' ? (
        <Text weight="700" numberOfLines={1} color={colors.background} style={styles.siglaTexto}>
          {aspecto.sigla}
        </Text>
      ) : (
        <Feather name={icono ?? 'file'} size={18} color={colors.background} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  cuerpo: { gap: spacing.sm + 4, paddingBottom: spacing.sm },
  titulo: { fontSize: 20, lineHeight: 24 },
  ayuda: { fontSize: 13, lineHeight: 18 },
  ayudaDelCampo: { flex: 1, fontSize: 12, lineHeight: 16 },
  archivo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    padding: spacing.sm + 2,
    borderRadius: radius.md,
  },
  textos: { flex: 1, minWidth: 0, gap: spacing.xs },
  nombreDeArchivo: { fontSize: 14, lineHeight: 18 },
  peso: { fontSize: 12, lineHeight: 16 },
  pie: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm, marginTop: -spacing.xs },
  cuenta: { fontSize: 12, lineHeight: 16 },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: spacing.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  campo: { marginBottom: 0 },
  quitar: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  sigla: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  siglaGrande: { width: 44, height: 44 },
  siglaTexto: { fontSize: 11, lineHeight: 14, letterSpacing: 0.3 },
});
