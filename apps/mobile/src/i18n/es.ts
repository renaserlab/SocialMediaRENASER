/**
 * Español: idioma de referencia.
 *
 * Cada clave que se añada aquí queda disponible en `t()` y, mientras no exista
 * su traducción en `en`/`pt`, se muestra este texto.
 */
export const es = {
  // Navegación
  'tabs.home': 'Inicio',
  'tabs.explore': 'Explorar',
  'tabs.create': 'Crear',
  'tabs.messages': 'Mensajes',
  'tabs.profile': 'Perfil',
  // Aviso al pulsar Atras en la raiz de la aplicacion (solo Android).
  'app.pressAgainToExit': 'Presiona otra vez para salir',

  // Inicio
  'home.forYou': 'Para ti',
  'home.following': 'Siguiendo',
  'home.composer': '¿Qué estás aprendiendo hoy?',
  'home.composerNamed': '¿Qué estás aprendiendo hoy, {name}?',
  'home.privateAudio': 'Audio privado',
  'home.privateAudioBody': 'Recomendación de tu quiz',
  'home.yourCircle': 'Tu círculo',
  'home.circleMembers': '{count} personas avanzando',
  'home.joinCommunity': 'Únete a la comunidad',
  'home.events': 'Eventos',
  'home.eventsBody': 'Encuentros y experiencias',
  'home.courses': 'Cursos',
  'home.coursesBody': 'Programas para avanzar',
  'home.addEvent': 'Agregar evento',
  'home.addCourse': 'Agregar curso',
  'home.yourStory': 'Tu historia',
  'home.emptyTitle': 'Aún no hay publicaciones',
  'home.emptyBody': 'Vuelve más tarde o crea la primera.',

  // Perfil
  'profile.title': 'MI PERFIL',
  'profile.titlePublic': 'PERFIL',
  'profile.followers': 'Seguidores',
  'profile.following': 'Siguiendo',
  'profile.posts': 'Publicaciones',
  'profile.editProfile': 'Editar perfil',
  'profile.editCover': 'Editar portada',
  'profile.follow': 'Seguir',
  'profile.unfollow': 'Siguiendo',
  'profile.message': 'Mensaje',
  'profile.saved': 'Guardados',
  'profile.podcast': 'Podcast',
  'profile.events': 'Eventos',
  'profile.courses': 'Cursos',
  'profile.circles': 'Círculos',
  'profile.testimonials': 'Reseñas',
  'profile.bookSession': 'Agenda',
  'profile.noPosts': 'Aún no hay publicaciones.',
  'profile.noEvents': 'Aún no hay eventos publicados.',
  'profile.noCourses': 'Aún no hay cursos publicados.',

  // Ajustes
  'settings.title': 'Ajustes',
  'settings.display': 'Visualización',
  'settings.darkMode': 'Modo Oscuro',
  'settings.currently': 'Actualmente: {value}',
  'settings.dark': 'Oscuro',
  'settings.light': 'Claro',
  'settings.language': 'Idioma de la App',
  'settings.account': 'Cuenta & Membresía',
  'settings.verification': 'Verificación de Cuenta',
  'settings.verificationBody': 'Ver estado de tu membresía',
  'settings.signOut': 'Cerrar Sesión',
  'settings.signOutBody': 'Salir de tu cuenta en este dispositivo',
  'settings.signIn': 'Iniciar Sesión',
  'settings.system': 'Sistema',
  'settings.reset': 'Reiniciar Aplicación',
  'settings.resetBody': 'Restaurar base de datos y reiniciar demo',

  // Idioma
  'language.title': 'Idioma',
  'language.description': 'Elige el idioma de la aplicación',
  'language.continue': 'Continuar',

  // Acciones comunes
  'home.podcast': 'Podcast',
  'home.podcastBody': 'Escucha los episodios',
  'home.seeMore': 'Ver más',
  'home.addAudio': 'Agregar audio',
  'podcast.locked': 'Disponible con tu membresía',
  'podcast.soon': 'Próximamente',
  'podcast.empty': 'Aún no hay episodios publicados.',

  'common.save': 'Guardar',
  'common.cancel': 'Cancelar',
  'common.edit': 'Editar',
  'common.delete': 'Eliminar',
  'common.publish': 'Publicar',
  'common.retry': 'Reintentar',
  'common.loading': 'Cargando…',
} as const;
