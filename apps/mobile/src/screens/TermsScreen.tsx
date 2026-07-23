import React from 'react';

import { LegalDocument, type LegalSection } from '@/components/LegalDocument';
import { PRIVACY_CONTACT } from '@/screens/PrivacyScreen';

const SECTIONS: LegalSection[] = [
  {
    heading: '1. Aceptación',
    paragraphs: [
      'Al crear una cuenta y utilizar RENASER aceptas estos Términos, que constituyen un contrato entre tú y RENASER. Si no estás de acuerdo con ellos, no uses la plataforma.',
      'Debes tener al menos 18 años para registrarte.',
    ],
  },
  {
    heading: '2. Qué es RENASER',
    paragraphs: [
      'RENASER es una comunidad privada de desarrollo personal. Ofrece publicaciones, historias, mensajería, eventos, audios y cursos formativos accesibles para las personas miembros.',
      'El contenido formativo tiene una finalidad educativa y de acompañamiento. No sustituye asesoramiento médico, psicológico, legal ni financiero profesional.',
    ],
  },
  {
    heading: '3. Tu cuenta',
    paragraphs: [
      'Eres responsable de la confidencialidad de tus credenciales y de toda la actividad realizada desde tu cuenta. Avísanos de inmediato si detectas un uso no autorizado.',
      'Puedes eliminar tu cuenta en cualquier momento desde Ajustes, dentro de la propia aplicación.',
    ],
  },
  {
    heading: '4. Tolerancia cero con el contenido objetable',
    paragraphs: [
      'No se permite publicar contenido que sea ilegal, sexualmente explícito, violento o gráfico, que incite al odio o a la violencia, que acose, amenace, intimide o suplante a otra persona, que promueva autolesiones o trastornos alimentarios, que infrinja derechos de propiedad intelectual, que constituya spam o fraude, o que difunda datos personales de terceros sin su consentimiento.',
      'Tampoco se admite ninguna forma de abuso hacia menores. Este tipo de contenido se elimina y se denuncia a las autoridades competentes.',
      'La política es de tolerancia cero: no hay avisos previos para las infracciones graves.',
    ],
  },
  {
    heading: '5. Reportes y moderación',
    paragraphs: [
      'Cualquier persona puede reportar una publicación o bloquear a otra usuaria desde el menú de la propia publicación o del perfil. El bloqueo es inmediato y oculta el contenido de esa persona.',
      'Nos comprometemos a revisar todo reporte y a actuar sobre el contenido objetable en un plazo máximo de 24 horas, retirándolo cuando proceda.',
      'Frente a una infracción podemos retirar el contenido, suspender la cuenta responsable o expulsarla de forma permanente, según la gravedad y la reincidencia. Las decisiones se toman de forma razonada y pueden apelarse escribiendo a ' +
        PRIVACY_CONTACT +
        '.',
    ],
  },
  {
    heading: '6. Contenido que publicas',
    paragraphs: [
      'Conservas la titularidad de todo lo que publicas. Al subirlo nos concedes una licencia no exclusiva y gratuita para alojarlo y mostrarlo dentro de la plataforma, con el único fin de prestar el servicio. Esa licencia termina cuando eliminas el contenido o tu cuenta.',
      'Declaras que tienes los derechos necesarios sobre lo que compartes y que no vulnera derechos de terceros.',
    ],
  },
  {
    heading: '7. Contenido de RENASER',
    paragraphs: [
      'Los cursos, videos, documentos y materiales publicados por RENASER están protegidos por derechos de autor. Se ofrecen para tu uso personal dentro de la plataforma.',
      'No está permitido descargarlos para redistribuirlos, revenderlos, publicarlos fuera de la plataforma ni compartir tus credenciales para dar acceso a terceros.',
    ],
  },
  {
    heading: '8. Acceso al contenido formativo',
    paragraphs: [
      'En esta versión los cursos forman parte del acceso de miembro y no se realizan pagos dentro de la aplicación.',
      'Si en el futuro se incorporan modalidades de pago, se informará con claridad de los precios y condiciones antes de cualquier cobro, y se aplicarán los mecanismos de pago exigidos por la tienda de aplicaciones correspondiente.',
    ],
  },
  {
    heading: '9. Uso aceptable',
    paragraphs: [
      'No intentes acceder a cuentas ajenas, alterar el funcionamiento del servicio, extraer datos de forma automatizada, ni utilizar la plataforma para enviar publicidad no solicitada.',
    ],
  },
  {
    heading: '10. Disponibilidad y responsabilidad',
    paragraphs: [
      'Trabajamos para mantener el servicio disponible, pero puede haber interrupciones por mantenimiento o causas ajenas. El servicio se presta «tal cual», sin garantía de disponibilidad ininterrumpida.',
      'En la medida permitida por la ley, RENASER no responde por daños indirectos derivados del uso de la plataforma ni por el contenido publicado por otras personas usuarias.',
    ],
  },
  {
    heading: '11. Suspensión del servicio',
    paragraphs: [
      'Podemos suspender o cancelar el acceso de una cuenta que incumpla estos Términos. También podemos discontinuar el servicio avisando con antelación razonable.',
    ],
  },
  {
    heading: '12. Ley aplicable',
    paragraphs: [
      'Estos Términos se rigen por la legislación peruana. Cualquier controversia se someterá a los juzgados competentes de Lima, Perú, sin perjuicio de los derechos que la normativa de consumo reconozca a la persona usuaria en su lugar de residencia.',
    ],
  },
  {
    heading: '13. Contacto',
    paragraphs: [
      'Para dudas sobre estos Términos, reportes o apelaciones: ' + PRIVACY_CONTACT + '.',
    ],
  },
];

export function TermsScreen() {
  return (
    <LegalDocument
      title="Términos y Condiciones"
      updatedAt="23 de julio de 2026"
      intro="Estos Términos regulan el uso de RENASER e incluyen el acuerdo de licencia de la aplicación. Presta especial atención al apartado 4: la plataforma aplica tolerancia cero con el contenido objetable y con el acoso."
      sections={SECTIONS}
    />
  );
}
