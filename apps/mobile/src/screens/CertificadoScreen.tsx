import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { Button } from '@/components/Button';
import { notify } from '@/lib/confirm';
import {
  certificadosNoMontados,
  mensajeDeErrorDeCertificado,
} from '@/lib/evaluacionDeCurso';
import {
  CertificateRepository,
  type Certificado,
} from '@/repositories/CertificateRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * El certificado de finalización (captura 21).
 *
 * TODO LO QUE SE PINTA VIENE DEL SERVIDOR, incluida la dirección de
 * verificación: el teléfono no sabe en qué dominio vive, y componerla aquí
 * terminaría con certificados apuntando a sitios distintos.
 *
 * NO DICE «TÍTULO» NI «ACREDITACIÓN». Es un certificado de finalización de un
 * curso, y llamarlo de otra forma sería afirmar un reconocimiento oficial que
 * no existe.
 *
 * UN CERTIFICADO REVOCADO SE ENSEÑA IGUAL, marcado. Hacerlo desaparecer dejaría
 * a quien lo compartió sin ninguna explicación.
 *
 * LO QUE FALTA: la descarga en PDF de la captura. Generarlo pediría una
 * dependencia nueva y, sobre todo, un servicio que lo firme; la verificación
 * pública ya cubre lo que un PDF prometía —que alguien de fuera pueda
 * comprobarlo—, así que se comparte el enlace en vez de un archivo.
 */
export function CertificadoScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [certificado, setCertificado] = useState<Certificado | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<unknown>(null);
  const generacionRef = useRef(0);

  const cargar = useCallback(async () => {
    if (!id) return;
    generacionRef.current += 1;
    const generacion = generacionRef.current;
    setCargando(true);
    setFallo(null);
    try {
      // Se busca entre los propios: esta pantalla es la del dueño. Quien llega
      // con un código ajeno tiene la verificación pública, que enseña menos.
      const mios = await CertificateRepository.mios();
      if (generacionRef.current !== generacion) return;
      const encontrado = mios.find((c) => c.codigo === id) ?? null;
      if (encontrado === null) {
        setFallo({ code: 'certificate_not_found' });
        return;
      }
      setCertificado(encontrado);
    } catch (error) {
      if (generacionRef.current !== generacion) return;
      setFallo(error);
    } finally {
      if (generacionRef.current === generacion) setCargando(false);
    }
  }, [id]);

  useEffect(() => {
    void cargar();
    return () => {
      generacionRef.current += 1;
    };
  }, [cargar]);

  const compartir = async () => {
    if (!certificado) return;
    try {
      // Se comparte el ENLACE de verificación, no una imagen: lo que vale de un
      // certificado es que alguien de fuera pueda comprobarlo.
      await Share.share({ message: certificado.urlDeVerificacion });
    } catch (error) {
      notify(t('common.loadFailed'), mensajeDeErrorDeCertificado(error, t));
    }
  };

  if (cargando) {
    return (
      <AppScreen>
        <AppHeader title={t('certificado.titulo')} onBack={() => router.back()} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null || !certificado) {
    return (
      <AppScreen>
        <AppHeader title={t('certificado.titulo')} onBack={() => router.back()} />
        <StateView
          state="error"
          description={mensajeDeErrorDeCertificado(fallo, t)}
          onRetry={certificadosNoMontados(fallo) ? undefined : () => void cargar()}
        />
      </AppScreen>
    );
  }

  const revocado = certificado.estado === 'revoked';

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={t('certificado.titulo')} onBack={() => router.back()} />

      <View style={[styles.lamina, { borderColor: colors.border }]}>
        <Text variant="display" style={styles.marca}>
          Z
        </Text>
        <Text variant="caption" color={colors.textMuted} style={styles.encabezado}>
          {t('certificado.encabezado').toUpperCase()}
        </Text>

        <Text variant="caption" color={colors.textMuted} style={styles.centrado}>
          {t('certificado.certificaQue')}
        </Text>
        {/* El nombre puede llegar vacío: el servidor no inventa uno. */}
        {certificado.nombre ? (
          <Text variant="title" style={styles.centrado}>
            {certificado.nombre}
          </Text>
        ) : null}

        <Text variant="caption" color={colors.textMuted} style={styles.centrado}>
          {t('certificado.haCompletado')}
        </Text>
        <Text variant="titleMedium" style={styles.centrado}>
          {certificado.cursoTitulo}
        </Text>

        {certificado.autor ? (
          <React.Fragment>
            <Text variant="caption" color={colors.textMuted} style={styles.centrado}>
              {t('certificado.impartidoPor')}
            </Text>
            <Text variant="body" weight="700" style={styles.centrado}>
              {certificado.autor}
            </Text>
          </React.Fragment>
        ) : null}

        <View style={[styles.separador, { backgroundColor: colors.border }]} />

        <View style={styles.datos}>
          <Campo
            etiqueta={t('certificado.fechaDeFinalizacion')}
            valor={fecha(certificado.terminadoEnIso)}
          />
          <Campo etiqueta={t('certificado.credencial')} valor={certificado.codigo} />
          {/* La versión SOLO si consta. */}
          {certificado.versionDelCurso !== null ? (
            <Campo
              etiqueta={t('certificado.version')}
              valor={String(certificado.versionDelCurso)}
            />
          ) : null}
        </View>

        <View style={[styles.verificacion, { backgroundColor: colors.surfaceAlt }]}>
          <Feather
            name={revocado ? 'alert-triangle' : 'shield'}
            size={18}
            color={revocado ? colors.danger : colors.textMuted}
          />
          <View style={styles.textoVerificacion}>
            <Text variant="secondary" weight="700">
              {revocado ? t('certificado.revocado') : t('certificado.verificacion')}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {revocado
                ? t('certificado.revocadoCuerpo')
                : t('certificado.verificacionCuerpo')}
            </Text>
          </View>
        </View>
      </View>

      <Button
        label={t('certificado.compartir')}
        onPress={() => void compartir()}
        style={styles.accion}
      />
      <Text variant="caption" color={colors.textMuted} style={styles.direccion}>
        {certificado.urlDeVerificacion}
      </Text>
    </AppScreen>
  );
}

/** Fecha corta, o nada si el servidor mandara algo que no es una fecha. */
function fecha(iso: string): string {
  const momento = new Date(iso);
  return Number.isNaN(momento.getTime()) ? '' : momento.toLocaleDateString();
}

function Campo({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  const { colors } = useAppTheme();
  return (
    <View style={styles.campo}>
      <Text variant="caption" color={colors.textMuted}>
        {etiqueta}
      </Text>
      <Text variant="secondary" weight="700">
        {valor}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  lamina: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.xl,
    gap: spacing.sm,
    alignItems: 'center',
  },
  marca: { letterSpacing: 2 },
  encabezado: { letterSpacing: 2, marginBottom: spacing.md },
  centrado: { textAlign: 'center' },
  separador: { height: 1, alignSelf: 'stretch', marginVertical: spacing.lg },
  datos: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.lg,
  },
  campo: { gap: 2, minWidth: 120, flexGrow: 1 },
  verificacion: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginTop: spacing.lg,
  },
  textoVerificacion: { flex: 1, gap: 2 },
  accion: { marginTop: spacing.md },
  direccion: { textAlign: 'center' },
});
