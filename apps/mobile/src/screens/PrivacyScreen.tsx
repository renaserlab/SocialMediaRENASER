import React from 'react';

import { LegalDocument, type LegalSection } from '@/components/LegalDocument';

/** Contacto unico para asuntos legales y de privacidad. */
export const PRIVACY_CONTACT = 'renaserlab@gmail.com';

const SECTIONS: LegalSection[] = [
  {
    heading: '1. Quién trata tus datos',
    paragraphs: [
      'RENASER es el responsable del tratamiento de los datos personales que se recogen a través de la aplicación móvil y del sitio web. Para cualquier consulta sobre privacidad puedes escribir a ' +
        PRIVACY_CONTACT +
        '.',
    ],
  },
  {
    heading: '2. Qué datos recogemos',
    paragraphs: [
      'Datos de la cuenta: nombre, nombre de usuario y correo electrónico. La contraseña se almacena cifrada y en ningún caso es accesible para nosotros.',
      'Contenido que publicas: publicaciones, comentarios, historias, mensajes, testimonios, fotos y videos que decidas subir, junto con la foto de perfil y la de portada.',
      'Datos de uso: elementos guardados, cursos a los que accedes, historias vistas, reservas de eventos y respuestas del cuestionario inicial.',
      'Datos técnicos imprescindibles para el servicio: identificador de la sesión y registros de error. No utilizamos herramientas de publicidad ni de seguimiento entre aplicaciones de terceros.',
    ],
  },
  {
    heading: '3. Para qué los usamos',
    paragraphs: [
      'Para crear y mantener tu cuenta, mostrarte el contenido de la comunidad, permitirte publicar e interactuar, darte acceso a cursos y eventos, atender reportes de contenido y mantener la seguridad de la plataforma.',
      'La base legal es la ejecución del contrato que aceptas al registrarte y, cuando corresponde, tu consentimiento (por ejemplo, al conceder acceso a la cámara o a la galería). Puedes retirar esos permisos en los ajustes de tu dispositivo en cualquier momento.',
    ],
  },
  {
    heading: '4. Dónde se guardan',
    paragraphs: [
      'La información se aloja en Supabase, que presta servicios de base de datos y almacenamiento sobre infraestructura ubicada fuera de Perú. Esto implica una transferencia internacional de datos, realizada con las garantías contractuales que ofrece dicho proveedor.',
      'Los archivos que subes se guardan en almacenamiento privado: solo se sirven mediante enlaces temporales firmados, no son públicos ni indexables.',
    ],
  },
  {
    heading: '5. Con quién los compartimos',
    paragraphs: [
      'No vendemos datos personales ni los cedemos con fines publicitarios.',
      'Solo accedemos a proveedores necesarios para operar el servicio (alojamiento y almacenamiento). Podremos comunicar información cuando lo exija una autoridad competente o una obligación legal.',
      'El contenido que publiques será visible para el resto de personas miembros de la plataforma. Ten en cuenta esto antes de compartir información sensible.',
    ],
  },
  {
    heading: '6. Cuánto tiempo los conservamos',
    paragraphs: [
      'Mantenemos tus datos mientras tu cuenta esté activa. Las historias se eliminan automáticamente a las 24 horas.',
      'Si eliminas tu cuenta desde Configuración, se borran tu perfil y el contenido asociado. Podemos conservar registros mínimos durante el tiempo necesario para cumplir obligaciones legales o resolver reportes en curso.',
    ],
  },
  {
    heading: '7. Tus derechos',
    paragraphs: [
      'Puedes acceder a tus datos, rectificarlos, eliminarlos, oponerte a su tratamiento y solicitar una copia. La forma más rápida de ejercer el borrado es la opción «Eliminar cuenta», disponible dentro de Configuración en la propia aplicación.',
      'Para el resto de solicitudes escríbenos a ' +
        PRIVACY_CONTACT +
        '. Responderemos en un plazo máximo de 30 días. Si resides en Perú, puedes además presentar una reclamación ante la Autoridad Nacional de Protección de Datos Personales.',
    ],
  },
  {
    heading: '8. Menores de edad',
    paragraphs: [
      'La plataforma está dirigida a personas mayores de 18 años. No recogemos de forma consciente datos de menores. Si detectamos una cuenta de una persona menor de esa edad, la eliminaremos.',
    ],
  },
  {
    heading: '9. Seguridad',
    paragraphs: [
      'El acceso a la información está restringido mediante políticas de seguridad aplicadas en el propio servidor de base de datos, de modo que cada persona solo puede leer y modificar lo que le corresponde. Las comunicaciones viajan cifradas mediante HTTPS.',
      'Ningún sistema es infalible. Si se produjera una brecha que afecte a tus datos, te informaríamos y notificaríamos a la autoridad competente conforme a la normativa aplicable.',
    ],
  },
  {
    heading: '10. Cambios en esta política',
    paragraphs: [
      'Si modificamos esta política actualizaremos la fecha del encabezado y, cuando el cambio sea relevante, te avisaremos dentro de la aplicación.',
    ],
  },
];

export function PrivacyScreen() {
  return (
    <LegalDocument
      title="Política de Privacidad"
      updatedAt="23 de julio de 2026"
      intro="Esta política explica qué datos personales recoge RENASER, con qué finalidad, dónde se guardan y cómo puedes controlarlos. Está redactada en lenguaje claro y a propósito: queremos que se entienda sin ser abogado."
      sections={SECTIONS}
    />
  );
}
