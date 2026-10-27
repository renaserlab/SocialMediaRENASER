import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { mensajeDeErrorDeCertificado } from '@/lib/evaluacionDeCurso';
import {
  CertificateRepository,
  type VerificacionPublica,
} from '@/repositories/CertificateRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * Verificación pública de un certificado.
 *
 * NO PIDE SESIÓN, y ese es el punto: quien recibe un certificado —una empresa,
 * alguien que contrata— no tiene la aplicación ni tiene por qué instalarla.
 *
 * NO SE PUEDE RECORRER. El código son 128 bits de azar; no hay una lista que
 * enumerar y un código que no existe responde igual que uno mal escrito.
 *
 * LO QUE SE ENSEÑA es lo justo para verificar: nombre, curso, autor, fechas y
 * estado. Ni correo, ni identificador de usuario, ni compra, ni importe: eso lo
 * decide el servidor, que no los manda.
 */
export function VerificarCertificadoScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();

  const [codigo, setCodigo] = useState(id ?? '');
  const [resultado, setResultado] = useState<VerificacionPublica | null>(null);
  const [cargando, setCargando] = useState(false);
  const [fallo, setFallo] = useState<unknown>(null);
  const comprobandoRef = useRef(false);

  const comprobar = useCallback(
    async (buscado: string) => {
      const limpio = buscado.trim();
      if (comprobandoRef.current || limpio === '') return;
      comprobandoRef.current = true;
      setCargando(true);
      setFallo(null);
      setResultado(null);
      try {
        setResultado(await CertificateRepository.verificar(limpio));
      } catch (error) {
        setFallo(error);
      } finally {
        comprobandoRef.current = false;
        setCargando(false);
      }
    },
    [],
  );

  useEffect(() => {
    // Con código en la dirección se comprueba solo: es lo que pasa al abrir el
    // enlace que alguien compartió.
    if (id) void comprobar(id);
  }, [id, comprobar]);

  const revocado = resultado?.estado === 'revoked';

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader
        title={t('certificado.verificar')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />

      <Text variant="secondary" color={colors.textMuted}>
        {t('certificado.verificacionCuerpo')}
      </Text>

      <Input
        value={codigo}
        onChangeText={setCodigo}
        placeholder={t('certificado.codigo')}
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={t('certificado.codigo')}
        style={{ color: colors.text }}
      />
      <Button
        label={t('certificado.comprobar')}
        onPress={() => void comprobar(codigo)}
        loading={cargando}
        disabled={cargando || codigo.trim() === ''}
      />

      {cargando ? <StateView state="loading" style={styles.estado} /> : null}

      {fallo !== null ? (
        <StateView
          state="error"
          description={mensajeDeErrorDeCertificado(fallo, t)}
          style={styles.estado}
        />
      ) : null}

      {resultado ? (
        <View style={[styles.ficha, { borderColor: colors.border }]}>
          <View style={styles.estadoDelSello}>
            <Feather
              name={revocado ? 'alert-triangle' : 'check-circle'}
              size={18}
              color={revocado ? colors.danger : colors.success}
            />
            <Text
              variant="secondary"
              weight="700"
              color={revocado ? colors.danger : colors.success}
            >
              {revocado ? t('certificado.revocado') : t('certificado.valido')}
            </Text>
          </View>

          {resultado.nombre ? (
            <Text variant="titleMedium">{resultado.nombre}</Text>
          ) : null}
          <Text variant="body">{resultado.cursoTitulo}</Text>
          {resultado.autor ? (
            <Text variant="secondary" color={colors.textMuted}>
              {t('certificado.impartidoPor')}: {resultado.autor}
            </Text>
          ) : null}
          <Text variant="secondary" color={colors.textMuted}>
            {t('certificado.fechaDeFinalizacion')}: {fecha(resultado.terminadoEnIso)}
          </Text>
          {resultado.versionDelCurso !== null ? (
            <Text variant="secondary" color={colors.textMuted}>
              {t('certificado.version')}: {resultado.versionDelCurso}
            </Text>
          ) : null}
          <Text variant="caption" color={colors.textMuted}>
            {t('certificado.credencial')}: {resultado.codigo}
          </Text>
        </View>
      ) : null}
    </AppScreen>
  );
}

function fecha(iso: string): string {
  const momento = new Date(iso);
  return Number.isNaN(momento.getTime()) ? '' : momento.toLocaleDateString();
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  estado: { minHeight: 120 },
  ficha: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  estadoDelSello: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
