import React from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { ListRow } from '@/components/ListRow';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/** Buzon unico de soporte. Es el mismo que atiende los asuntos legales. */
export const SUPPORT_EMAIL = 'renaserlab@gmail.com';

/** Plazo que nos comprometemos a cumplir. No prometer menos del que se cumple. */
const RESPONSE_TIME = '48 horas hábiles';

/**
 * Asunto ya rellenado.
 *
 * Ahorra una decision a quien escribe y, sobre todo, permite filtrar el buzon:
 * sin asunto fijo, las peticiones de ayuda se mezclan con el resto del correo.
 */
const MAILTO = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Ayuda con la app Z')}`;

type Faq = {
  question: string;
  answer: string[];
};

/**
 * Preguntas frecuentes.
 *
 * Cada una describe el comportamiento REAL de la aplicacion, no el deseado. Una
 * pagina de soporte que explica funciones que no existen es peor que no
 * tenerla: genera el ticket que pretendia evitar, y ante Apple es motivo de
 * rechazo por informacion enganosa.
 */
const FAQS: Faq[] = [
  {
    question: 'Olvidé mi contraseña',
    answer: [
      'En la pantalla de acceso, toca «¿Olvidaste tu contraseña?» y escribe tu correo. Recibirás un enlace para crear una nueva.',
      'Si el correo no llega en unos minutos, revisa la carpeta de spam. Si aun así no aparece, escríbenos y restablecemos el acceso manualmente.',
    ],
  },
  {
    question: 'Cómo elimino mi cuenta y qué se borra',
    answer: [
      'Entra en Ajustes, dentro de la app, y elige «Eliminar cuenta». Se te pedirá confirmación porque la acción no se puede deshacer.',
      'Se borran tu perfil y el contenido asociado: publicaciones, comentarios, historias y archivos subidos. Podemos conservar registros mínimos si una obligación legal o un reporte en curso lo exigen.',
    ],
  },
  {
    question: 'Mi historia desapareció',
    answer: [
      'Las historias se eliminan solas a las 24 horas de publicarse. No es un fallo: funcionan así a propósito, igual que en otras plataformas.',
      'Las publicaciones del muro, en cambio, permanecen hasta que tú las borres.',
    ],
  },
  {
    question: 'No puedo subir una foto o un vídeo',
    answer: [
      'Lo más habitual es el permiso. La app necesita acceso a tus fotos o a la cámara: actívalo en Ajustes del teléfono → Z → Fotos (o Cámara). En iPhone el sistema solo pregunta una vez, así que si lo rechazaste en su día hay que activarlo ahí a mano.',
      'También hay un límite de tamaño. Si el archivo lo supera, la app te dice cuánto pesa y cuánto se admite; con un vídeo largo, recórtalo o comprímelo antes de subirlo.',
      'Las historias admiten vídeos de hasta 15 segundos.',
    ],
  },
  {
    question: 'Cómo reporto una publicación o bloqueo a alguien',
    answer: [
      'Toca el icono «···» de la publicación y elige «Reportar publicación» o «Bloquear». Revisamos todos los reportes.',
      'Al bloquear a una persona dejas de ver su contenido y ella deja de ver el tuyo. Puedes deshacerlo desde su perfil.',
      'Si se trata de una situación grave o urgente, escríbenos directamente al correo de soporte y añade una captura.',
    ],
  },
  {
    question: '¿Hay pagos dentro de la aplicación?',
    answer: [
      'No. Esta versión es una app de miembros: no vende nada ni pide datos de pago en ningún momento.',
      'El acceso al contenido formativo se gestiona fuera de la aplicación. Si tienes dudas sobre tu membresía, escríbenos.',
    ],
  },
  {
    question: 'Qué necesito para usar Z',
    answer: [
      'Un iPhone o un teléfono Android reciente, o cualquier navegador actualizado. Basta con una cuenta creada con tu correo electrónico.',
      'La app funciona en español. Algunas funciones, como subir vídeos, necesitan conexión estable.',
    ],
  },
];

/** Datos que evitan el intercambio de correos de ida y vuelta. */
const WHAT_TO_INCLUDE = [
  'El correo con el que te registraste.',
  'Qué esperabas que pasara y qué pasó en su lugar.',
  'El teléfono o navegador que usas.',
  'Una captura de pantalla, si el problema se ve.',
];

/**
 * Centro de ayuda.
 *
 * Es una pantalla de la app y, a la vez, la pagina publica `/support` que
 * exporta el build de la web: Apple exige una URL de soporte accesible SIN
 * instalar nada, y Google Play pide lo mismo para la ficha. Al ser una ruta
 * propia no depende de configurar ningun dominio externo ni de que un tercero
 * siga en pie.
 */
export function SupportScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();

  const escribir = () => {
    Linking.openURL(MAILTO).catch(() => {
      // Un escritorio sin cliente de correo configurado no abre `mailto:`. Sin
      // esta salida, el boton de una pagina de AYUDA seria justo lo que no
      // funciona: se muestra la direccion para copiarla a mano.
      notify('Escríbenos a', SUPPORT_EMAIL);
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title="Soporte"
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
      <AppScreen contentStyle={styles.content}>
        <Text variant="display" style={styles.title}>
          Centro de ayuda
        </Text>
        <Text variant="body" color={colors.textMuted} style={styles.intro}>
          Aquí encontrarás respuesta a lo que más nos preguntan. Si tu caso no
          está, escríbenos: contestamos a todos los mensajes.
        </Text>

        {/* Contacto arriba del todo: quien entra buscando ayuda no debería
            tener que leer un documento entero para encontrar la dirección. */}
        <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.backgroundAlt }]}>
          <View style={styles.cardHead}>
            <Feather name="mail" size={18} color={colors.text} />
            <Text variant="body" weight="800">
              Contacto directo
            </Text>
          </View>
          <Text variant="body" style={styles.email} selectable>
            {SUPPORT_EMAIL}
          </Text>
          <Text variant="secondary" color={colors.textMuted} style={styles.cardBody}>
            Respondemos en un plazo máximo de {RESPONSE_TIME}. Atendemos en
            español.
          </Text>
          <Button
            label="Escribir a soporte"
            icon="send"
            onPress={escribir}
            style={styles.cta}
          />
        </View>

        <Text variant="titleMedium" style={styles.sectionTitle}>
          Antes de escribir
        </Text>
        <Text variant="secondary" color={colors.textMuted} style={styles.sectionIntro}>
          Con estos datos podemos resolverlo a la primera:
        </Text>
        {WHAT_TO_INCLUDE.map((item) => (
          <View key={item} style={styles.bullet}>
            {/* El icono acompaña al texto en vez de sustituirlo: la lista se
                sigue entendiendo si no se distinguen los colores. */}
            <Feather name="check" size={15} color={colors.textMuted} style={styles.bulletIcon} />
            <Text variant="body" color={colors.textMuted} style={styles.bulletText}>
              {item}
            </Text>
          </View>
        ))}

        <Text variant="titleMedium" style={styles.sectionTitle}>
          Preguntas frecuentes
        </Text>
        {FAQS.map((faq) => (
          <View key={faq.question} style={[styles.faq, { borderColor: colors.border }]}>
            <Text variant="body" weight="800" style={styles.question}>
              {faq.question}
            </Text>
            {faq.answer.map((paragraph, index) => (
              <Text
                key={index}
                variant="body"
                color={colors.textMuted}
                style={styles.answer}
              >
                {paragraph}
              </Text>
            ))}
          </View>
        ))}

        <Text variant="titleMedium" style={styles.sectionTitle}>
          Documentos
        </Text>
        <ListRow
          title="Política de Privacidad"
          subtitle="Qué datos recogemos y cómo los usamos"
          leftIcon="shield"
          rightIcon="chevron-right"
          onPress={() => router.push('/privacy' as never)}
        />
        <ListRow
          title="Términos y Condiciones"
          subtitle="Normas de la comunidad y acuerdo de licencia"
          leftIcon="file-text"
          rightIcon="chevron-right"
          onPress={() => router.push('/terms' as never)}
        />
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  // Mismo ancho maximo que los documentos legales: en un monitor, una linea que
  // cruza la pantalla entera es incomoda de leer.
  content: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxxl,
    maxWidth: 760,
    width: '100%',
    alignSelf: 'center',
  },
  title: { marginTop: spacing.lg },
  intro: { lineHeight: 22, marginTop: spacing.sm },
  card: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginTop: spacing.xl,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  email: { marginTop: spacing.md },
  cardBody: { lineHeight: 20, marginTop: spacing.sm },
  cta: { marginTop: spacing.lg },
  sectionTitle: { marginTop: spacing.xxl },
  sectionIntro: { lineHeight: 20, marginTop: spacing.sm },
  bullet: { flexDirection: 'row', alignItems: 'flex-start', marginTop: spacing.md },
  // Empuja el icono hasta la altura de la primera linea del texto.
  bulletIcon: { marginTop: 3, marginRight: spacing.sm },
  bulletText: { flex: 1, lineHeight: 22 },
  faq: {
    borderTopWidth: 1,
    paddingTop: spacing.lg,
    marginTop: spacing.lg,
  },
  question: { marginBottom: spacing.sm },
  answer: { lineHeight: 22, marginBottom: spacing.sm },
});
