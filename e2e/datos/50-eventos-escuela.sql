-- Datos del modulo «Eventos + Escuela + Crear + servicios/productos».
-- SOLO para el Supabase LOCAL (zeta-local). Lo ejecuta e2e/scripts/sembrar.sh
-- despues de 00-base.sql, con :ana y :beto ya creados en Auth.
--
-- Idempotente: los ids son fijos y todo va con `on conflict do update`, de modo
-- que cada pasada deja el mismo punto de partida. Las fechas se calculan contra
-- now() en cada pasada para que «proximo» siga siendo proximo; la HORA va fija
-- (23:00 UTC = 18:00 en Lima) para que las capturas no cambien con cada siembra.
--
-- Beto organiza y es autor; Ana es quien reserva y aprende. Asi la ficha de un
-- evento nunca es de quien prueba (el organizador no se reserva a si mismo).

begin;

-- =========================================================================
-- EVENTOS
-- =========================================================================
--   e1  gratuito, presencial, dentro de 3 dias, sello «Seleccionado por Z»
--   e2  con entradas (TICKETED), en linea, dentro de 12 dias, S/ 35.00
--   e3  en vivo, ya pasado (bloque «Eventos anteriores», «Finalizado»)
--   e4  presencial, sin fecha (bloque «Fecha por confirmar»)
-- Sin portada a proposito: la app pinta su imagen local y la captura no
-- depende de Storage.

insert into public.events
  (id, organizer_id, title, description, starts_at, ends_at, location,
   cover_path, whatsapp_url, event_type, status, capacity)
values
  ('e2e50000-0000-4000-8000-0000000000e1', :'beto',
   'Taller E2E de respiración consciente',
   'Dos horas de práctica guiada para soltar la tensión del día. Trae ropa cómoda.',
   date_trunc('day', now()) + interval '3 days 23 hours', date_trunc('day', now()) + interval '4 days 1 hour',
   'Casa Renaser, Miraflores', null, null, 'presential', 'published', 30),
  ('e2e50000-0000-4000-8000-0000000000e2', :'beto',
   'Concierto E2E de cuencos tibetanos',
   'Sesión en línea con entradas. Se conecta desde casa con auriculares.',
   date_trunc('day', now()) + interval '12 days 23 hours', date_trunc('day', now()) + interval '13 days 30 minutes',
   'En línea', null, null, 'online', 'published', 100),
  ('e2e50000-0000-4000-8000-0000000000e3', :'beto',
   'Encuentro E2E en vivo ya celebrado',
   'Transmisión en directo que ya terminó. Sirve para el bloque de anteriores.',
   date_trunc('day', now()) - interval '20 days' + interval '23 hours', date_trunc('day', now()) - interval '19 days' + interval '1 hour',
   'Transmisión en vivo', null, null, 'live', 'published', null),
  ('e2e50000-0000-4000-8000-0000000000e4', :'beto',
   'Retiro E2E con fecha por confirmar',
   'Fin de semana en el valle. La fecha se anuncia pronto.',
   null, null, 'Valle Sagrado, Cusco', null, null, 'presential', 'published', 20)
on conflict (id) do update set
  organizer_id = excluded.organizer_id,
  title        = excluded.title,
  description  = excluded.description,
  starts_at    = excluded.starts_at,
  ends_at      = excluded.ends_at,
  location     = excluded.location,
  cover_path   = excluded.cover_path,
  whatsapp_url = excluded.whatsapp_url,
  event_type   = excluded.event_type,
  status       = excluded.status,
  capacity     = excluded.capacity;

-- Nadie reservado al empezar: el flujo de reserva parte de «Reservar mi cupo».
delete from public.event_registrations
where event_id in ('e2e50000-0000-4000-8000-0000000000e1',
                   'e2e50000-0000-4000-8000-0000000000e2',
                   'e2e50000-0000-4000-8000-0000000000e3',
                   'e2e50000-0000-4000-8000-0000000000e4');

-- e1: ciclo operativo publicado y seleccionado por Z (pinta el sello).
insert into public.event_operations
  (event_id, workflow_status, selection_status, origin, published_at, decided_at)
values
  ('e2e50000-0000-4000-8000-0000000000e1', 'PUBLISHED', 'approved', 'events_v2', now(), now())
on conflict (event_id) do update set
  workflow_status  = excluded.workflow_status,
  selection_status = excluded.selection_status,
  published_at     = excluded.published_at,
  decided_at       = excluded.decided_at;

-- e2: se gestiona con entradas. Un tipo «General» a la venta, S/ 35.00.
insert into public.event_ticketing_settings (event_id, access_mode, currency, max_per_order)
values ('e2e50000-0000-4000-8000-0000000000e2', 'TICKETED', 'PEN', 4)
on conflict (event_id) do update set
  access_mode   = excluded.access_mode,
  currency      = excluded.currency,
  max_per_order = excluded.max_per_order,
  sales_open_at = null,
  sales_close_at = null;

insert into public.event_ticket_types
  (id, event_id, name, description, price_minor, currency, quota,
   min_per_order, max_per_order, status, sort_order)
values
  ('e2e50000-0000-4000-8000-0000000000f1', 'e2e50000-0000-4000-8000-0000000000e2',
   'General', 'Acceso a la sala virtual.', 3500, 'PEN', 100, 1, 4, 'on_sale', 0)
on conflict (id) do update set
  name          = excluded.name,
  description   = excluded.description,
  price_minor   = excluded.price_minor,
  currency      = excluded.currency,
  quota         = excluded.quota,
  min_per_order = excluded.min_per_order,
  max_per_order = excluded.max_per_order,
  status        = excluded.status,
  sort_order    = excluded.sort_order;

-- =========================================================================
-- ESCUELA: un curso gratuito publicado, 1 modulo, 3 lecciones de texto y una
-- evaluacion publicada de 2 preguntas. Autor: Beto.
-- =========================================================================
-- Ojo: con la evaluacion PUBLICADA, terminar las 3 lecciones no basta para
-- «Finalizados» en la biblioteca: hay que aprobarla. Es lo que se quiere probar.

-- Estado de alumno que pudo dejar una pasada anterior: el curso vuelve a
-- «sin empezar» para todos. (La inscripcion gratuita es una fila de purchases
-- con provider='manual'; no hay endpoint para darse de baja.)
delete from public.quiz_attempts      where course_id = 'e2e0c0c0-0000-4000-8000-0000000000c1';
delete from public.course_completions where course_id = 'e2e0c0c0-0000-4000-8000-0000000000c1';
delete from public.purchases          where course_id = 'e2e0c0c0-0000-4000-8000-0000000000c1';
delete from public.course_enrollments where course_id = 'e2e0c0c0-0000-4000-8000-0000000000c1';
delete from public.saved_courses      where course_id = 'e2e0c0c0-0000-4000-8000-0000000000c1';
delete from public.lesson_notes       where course_id = 'e2e0c0c0-0000-4000-8000-0000000000c1';
delete from public.course_reviews     where course_id = 'e2e0c0c0-0000-4000-8000-0000000000c1';
delete from public.lesson_progress
where lesson_id in ('e2e0c0c0-0000-4000-8000-0000000000e1',
                    'e2e0c0c0-0000-4000-8000-0000000000e2',
                    'e2e0c0c0-0000-4000-8000-0000000000e3');

insert into public.courses
  (id, author_id, title, subtitle, description, price_minor, currency, status,
   coming_soon, language, level, highlights, target_audience, prerequisites,
   review_status, cover_path, promo_video_path, created_at)
values
  ('e2e0c0c0-0000-4000-8000-0000000000c1', :'beto',
   'Curso E2E: Respiración consciente', 'Tres prácticas cortas para calmar la mente',
   'Curso gratuito de pruebas E2E: tres lecciones de texto sobre respiración consciente.',
   0, 'PEN', 'published', false, 'es', 'beginner', '{}', '{}', '{}', 'approved',
   null, null, now())
on conflict (id) do update set
  author_id = excluded.author_id, title = excluded.title, subtitle = excluded.subtitle,
  description = excluded.description, price_minor = 0, currency = 'PEN',
  status = 'published', coming_soon = false, language = 'es', level = 'beginner',
  highlights = '{}', target_audience = '{}', prerequisites = '{}',
  review_status = 'approved', rejection_reason = null, cover_path = null,
  promo_video_path = null, created_at = now();

delete from public.course_modules
where course_id = 'e2e0c0c0-0000-4000-8000-0000000000c1'
  and id <> 'e2e0c0c0-0000-4000-8000-0000000000d1';
insert into public.course_modules (id, course_id, title, description, sort_order)
values ('e2e0c0c0-0000-4000-8000-0000000000d1', 'e2e0c0c0-0000-4000-8000-0000000000c1',
        'Fundamentos de la respiración', 'Lo básico antes de practicar.', 0)
on conflict (id) do update set
  course_id = excluded.course_id, title = excluded.title,
  description = excluded.description, sort_order = 0;

delete from public.course_lessons
where module_id = 'e2e0c0c0-0000-4000-8000-0000000000d1'
  and id not in ('e2e0c0c0-0000-4000-8000-0000000000e1',
                 'e2e0c0c0-0000-4000-8000-0000000000e2',
                 'e2e0c0c0-0000-4000-8000-0000000000e3');
insert into public.course_lessons
  (id, module_id, title, body, kind, media_path, duration_seconds, sort_order, is_preview)
values
  ('e2e0c0c0-0000-4000-8000-0000000000e1', 'e2e0c0c0-0000-4000-8000-0000000000d1',
   'Respirar por la nariz', 'Inhala por la nariz durante cuatro tiempos y exhala despacio.',
   'text', null, 300, 0, false),
  ('e2e0c0c0-0000-4000-8000-0000000000e2', 'e2e0c0c0-0000-4000-8000-0000000000d1',
   'La respiración 4-7-8', 'Inhala 4 segundos, sostén 7 y exhala durante 8.',
   'text', null, 420, 1, false),
  ('e2e0c0c0-0000-4000-8000-0000000000e3', 'e2e0c0c0-0000-4000-8000-0000000000d1',
   'Pausa consciente de un minuto', 'Detente un minuto y observa tu respiración sin cambiarla.',
   'text', null, 360, 2, false)
on conflict (id) do update set
  module_id = excluded.module_id, title = excluded.title, body = excluded.body,
  kind = excluded.kind, media_path = null, duration_seconds = excluded.duration_seconds,
  sort_order = excluded.sort_order, is_preview = false;

delete from public.course_quizzes
where course_id = 'e2e0c0c0-0000-4000-8000-0000000000c1'
  and id <> 'e2e0c0c0-0000-4000-8000-0000000000f1';
insert into public.course_quizzes (id, course_id, title, pass_percent, status)
values ('e2e0c0c0-0000-4000-8000-0000000000f1', 'e2e0c0c0-0000-4000-8000-0000000000c1',
        'Evaluación E2E: respiración', 70, 'published')
on conflict (id) do update set
  course_id = excluded.course_id, title = excluded.title,
  pass_percent = excluded.pass_percent, status = excluded.status, updated_at = now();
-- Las preguntas se reponen enteras (el borrado arrastra sus opciones).
delete from public.quiz_questions where quiz_id = 'e2e0c0c0-0000-4000-8000-0000000000f1';
insert into public.quiz_questions (id, quiz_id, prompt, sort_order) values
  ('e2e0c0c0-0000-4000-8000-0000000001a1', 'e2e0c0c0-0000-4000-8000-0000000000f1',
   '¿Por dónde conviene inhalar en la práctica básica?', 0),
  ('e2e0c0c0-0000-4000-8000-0000000001a2', 'e2e0c0c0-0000-4000-8000-0000000000f1',
   '¿Cuántos segundos se sostiene el aire en la técnica 4-7-8?', 1);
insert into public.quiz_options (id, question_id, body, is_correct, sort_order) values
  ('e2e0c0c0-0000-4000-8000-0000000001b1', 'e2e0c0c0-0000-4000-8000-0000000001a1', 'Por la nariz', true, 0),
  ('e2e0c0c0-0000-4000-8000-0000000001b2', 'e2e0c0c0-0000-4000-8000-0000000001a1', 'Por la boca', false, 1),
  ('e2e0c0c0-0000-4000-8000-0000000001b3', 'e2e0c0c0-0000-4000-8000-0000000001a1', 'Da igual', false, 2),
  ('e2e0c0c0-0000-4000-8000-0000000001c1', 'e2e0c0c0-0000-4000-8000-0000000001a2', '4 segundos', false, 0),
  ('e2e0c0c0-0000-4000-8000-0000000001c2', 'e2e0c0c0-0000-4000-8000-0000000001a2', '7 segundos', true, 1),
  ('e2e0c0c0-0000-4000-8000-0000000001c3', 'e2e0c0c0-0000-4000-8000-0000000001a2', '8 segundos', false, 2);

-- =========================================================================
-- PRODUCTOS: Beto vende dos productos publicados (lectura, nunca se compra).
--   p1 «Cuaderno E2E de tapa dura»: precio, 2 variantes, evaluacion aprobada
--      por Ana (sale en «Selección Z», con razones e informe).
--   p2 «Taza E2E sin precio»: sin precio, sin evaluacion ni variantes.
-- Sin fotos a proposito: la ficha dice que no tiene imagenes y la captura no
-- depende de Storage.
-- SERVICIOS no se siembra: la API local corre con feature_services apagada y
-- los datos serian invisibles (los flujos comprueban el estado «no disponible»).
-- =========================================================================
insert into public.product_sellers (id, profile_id, display_name, status, activated_at, activated_by)
values ('e2e60000-0000-4000-8000-000000000001', :'beto', 'Taller de Beto E2E', 'active', now(), :'ana')
on conflict (profile_id) do update set
  display_name = excluded.display_name, status = 'active',
  suspended_at = null, suspension_reason = null;

insert into public.products (id, seller_id, category_id, status, created_by)
select x.id, s.id, c.id, 'draft', :'beto'
from (values ('e2e61000-0000-4000-8000-000000000001'::uuid),
             ('e2e61000-0000-4000-8000-000000000002'::uuid)) as x(id)
join public.product_sellers s on s.profile_id = :'beto'
left join public.product_categories c on c.slug = 'libros-y-cuadernos'
on conflict (id) do nothing;

insert into public.product_versions
  (id, product_id, version, status, name, summary, description, materials,
   origin_country, manufacturer, price_minor, currency, content_sha256,
   created_by, published_at, published_by, effective_from)
values
  ('e2e62000-0000-4000-8000-000000000001', 'e2e61000-0000-4000-8000-000000000001', '1', 'published',
   'Cuaderno E2E de tapa dura', 'Cuaderno cosido a mano de 120 hojas.',
   'Cuaderno cosido a mano, papel de 90 g y tapa dura forrada en tela. Datos de prueba E2E.',
   'Papel de 90 g y tapa forrada en tela de algodón.', 'PE', 'Taller de Beto E2E',
   4500, 'PEN', encode(sha256(convert_to('e2e-producto-1-v1', 'UTF8')), 'hex'),
   :'beto', now() - interval '2 days', :'ana', now() - interval '2 days'),
  ('e2e62000-0000-4000-8000-000000000002', 'e2e61000-0000-4000-8000-000000000002', '1', 'published',
   'Taza E2E sin precio', 'Taza torneada a mano, todavía sin precio.',
   null, null, null, null, null, null,
   encode(sha256(convert_to('e2e-producto-2-v1', 'UTF8')), 'hex'),
   :'beto', now() - interval '1 day', :'ana', now() - interval '1 day')
on conflict (id) do update set
  name = excluded.name, summary = excluded.summary, description = excluded.description,
  materials = excluded.materials, origin_country = excluded.origin_country,
  manufacturer = excluded.manufacturer, price_minor = excluded.price_minor,
  currency = excluded.currency, published_at = excluded.published_at;

update public.products p set
  seller_id = s.id, status = 'published', published_version_id = x.v,
  published_at = x.en, suspended_at = null, suspension_reason = null,
  removed_at = null, updated_at = now()
from (values ('e2e61000-0000-4000-8000-000000000001'::uuid, 'e2e62000-0000-4000-8000-000000000001'::uuid, now() - interval '2 days'),
             ('e2e61000-0000-4000-8000-000000000002'::uuid, 'e2e62000-0000-4000-8000-000000000002'::uuid, now() - interval '1 day'))
     as x(p, v, en),
     public.product_sellers s
where p.id = x.p and s.profile_id = :'beto';

insert into public.product_variants (id, version_id, sku, name, options, price_delta_minor, position)
values
  ('e2e63000-0000-4000-8000-000000000001', 'e2e62000-0000-4000-8000-000000000001',
   'E2E-CUAD-NEG', 'Negro', '{"color":"negro"}', 0, 0),
  ('e2e63000-0000-4000-8000-000000000002', 'e2e62000-0000-4000-8000-000000000001',
   'E2E-CUAD-ARE', 'Arena', '{"color":"arena"}', 500, 1)
on conflict (id) do update set
  sku = excluded.sku, name = excluded.name, options = excluded.options,
  price_delta_minor = excluded.price_delta_minor, position = excluded.position;

-- Evaluacion aprobada del cuaderno. Evalua Ana: nadie evalua lo suyo.
insert into public.product_evaluations
  (id, product_id, version_id, evaluator_id, status, score_total, decision, decided_at)
values ('e2e64000-0000-4000-8000-000000000001', 'e2e61000-0000-4000-8000-000000000001',
        'e2e62000-0000-4000-8000-000000000001', :'ana', 'decided', 9200, 'approved',
        now() - interval '2 days')
on conflict (id) do nothing;
insert into public.product_evaluation_evidence (id, evaluation_id, dimension, kind, summary, created_by) values
  ('e2e65000-0000-4000-8000-000000000001', 'e2e64000-0000-4000-8000-000000000001', 'durability', 'inspection',
   'Inspección de durabilidad sobre la muestra E2E.', :'ana'),
  ('e2e65000-0000-4000-8000-000000000002', 'e2e64000-0000-4000-8000-000000000001', 'origin', 'inspection',
   'Inspección de origen sobre la muestra E2E.', :'ana'),
  ('e2e65000-0000-4000-8000-000000000003', 'e2e64000-0000-4000-8000-000000000001', 'quality', 'inspection',
   'Inspección de calidad sobre la muestra E2E.', :'ana')
on conflict (id) do nothing;
insert into public.product_evaluation_scores (evaluation_id, dimension, score, weight) values
  ('e2e64000-0000-4000-8000-000000000001', 'durability', 92, 40),
  ('e2e64000-0000-4000-8000-000000000001', 'origin', 92, 30),
  ('e2e64000-0000-4000-8000-000000000001', 'quality', 92, 30)
on conflict (evaluation_id, dimension) do nothing;
insert into public.product_approval_reasons (id, version_id, evaluation_id, evidence_id, text, position, created_by) values
  ('e2e66000-0000-4000-8000-000000000001', 'e2e62000-0000-4000-8000-000000000001', 'e2e64000-0000-4000-8000-000000000001',
   'e2e65000-0000-4000-8000-000000000001', 'Materiales de alta duración', 1, :'ana'),
  ('e2e66000-0000-4000-8000-000000000002', 'e2e62000-0000-4000-8000-000000000001', 'e2e64000-0000-4000-8000-000000000001',
   'e2e65000-0000-4000-8000-000000000002', 'Origen y creador verificados', 2, :'ana'),
  ('e2e66000-0000-4000-8000-000000000003', 'e2e62000-0000-4000-8000-000000000001', 'e2e64000-0000-4000-8000-000000000001',
   'e2e65000-0000-4000-8000-000000000003', 'Funciona como promete', 3, :'ana')
on conflict (id) do nothing;

-- Nadie lo tiene guardado ni en la bolsa al empezar.
delete from public.saved_products     where product_id in ('e2e61000-0000-4000-8000-000000000001', 'e2e61000-0000-4000-8000-000000000002');
delete from public.product_cart_items where product_id in ('e2e61000-0000-4000-8000-000000000001', 'e2e61000-0000-4000-8000-000000000002');

commit;

-- Comprobacion.
select 'evento' as que, title as nombre from public.events where id::text like 'e2e50000-%'
union all
select 'curso', c.title || ' (' || count(l.id) || ' lecciones)'
from public.courses c join public.course_modules m on m.course_id = c.id
join public.course_lessons l on l.module_id = m.id
where c.id = 'e2e0c0c0-0000-4000-8000-0000000000c1' group by c.title
union all
select 'producto', v.name from public.products p join public.product_versions v on v.id = p.published_version_id
where p.id::text like 'e2e61000-%';
