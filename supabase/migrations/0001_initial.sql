-- RENASER Universo - esquema inicial para Supabase/PostgreSQL
-- Ejecutar en un proyecto nuevo desde SQL Editor o Supabase CLI.

create extension if not exists pgcrypto;

create type public.app_role as enum ('user', 'mentor', 'moderator', 'admin');
create type public.content_status as enum ('draft', 'published', 'hidden', 'deleted');
create type public.member_role as enum ('member', 'moderator', 'owner');
create type public.purchase_status as enum ('pending', 'paid', 'refunded', 'cancelled');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text not null default '',
  username text unique,
  bio text not null default '',
  avatar_path text,
  role public.app_role not null default 'user',
  is_private boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  following_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 3000),
  status public.content_status not null default 'published',
  visibility text not null default 'public' check (visibility in ('public', 'followers', 'circle')),
  circle_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.post_media (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  storage_path text not null,
  media_type text not null check (media_type in ('image', 'video', 'audio', 'document')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  parent_id uuid references public.comments(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1200),
  status public.content_status not null default 'published',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.post_likes (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table public.saved_posts (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table public.circles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  description text not null default '',
  cover_path text,
  is_private boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.posts
  add constraint posts_circle_id_fkey foreign key (circle_id) references public.circles(id) on delete cascade;

create table public.circle_members (
  circle_id uuid not null references public.circles(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.member_role not null default 'member',
  joined_at timestamptz not null default now(),
  primary key (circle_id, user_id)
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  organizer_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  description text not null default '',
  starts_at timestamptz not null,
  ends_at timestamptz,
  location text,
  cover_path text,
  event_type text not null default 'online' check (event_type in ('online', 'presential', 'live')),
  status public.content_status not null default 'published',
  capacity integer check (capacity is null or capacity > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.event_registrations (
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'confirmed' check (status in ('confirmed', 'waitlist', 'cancelled')),
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

create table public.audios (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  description text not null default '',
  storage_path text not null,
  cover_path text,
  is_premium boolean not null default false,
  status public.content_status not null default 'published',
  created_at timestamptz not null default now()
);

create table public.courses (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  description text not null default '',
  cover_path text,
  price_minor integer not null default 0 check (price_minor >= 0),
  currency text not null default 'PEN' check (char_length(currency) = 3),
  status public.content_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.course_modules (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  title text not null,
  sort_order integer not null default 0
);

create table public.course_lessons (
  id uuid primary key default gen_random_uuid(),
  module_id uuid not null references public.course_modules(id) on delete cascade,
  title text not null,
  body text not null default '',
  media_path text,
  duration_seconds integer not null default 0,
  sort_order integer not null default 0
);

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete restrict,
  provider text not null check (provider in ('apple', 'google', 'web', 'manual')),
  provider_transaction_id text,
  amount_minor integer not null check (amount_minor >= 0),
  currency text not null check (char_length(currency) = 3),
  status public.purchase_status not null default 'pending',
  purchased_at timestamptz not null default now(),
  unique (provider, provider_transaction_id)
);

create table public.lesson_progress (
  user_id uuid not null references public.profiles(id) on delete cascade,
  lesson_id uuid not null references public.course_lessons(id) on delete cascade,
  completed boolean not null default false,
  progress_seconds integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, lesson_id)
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  title text,
  kind text not null default 'direct' check (kind in ('direct', 'group', 'support')),
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_read_at timestamptz,
  primary key (conversation_id, user_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 5000),
  attachment_path text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  type text not null,
  entity_type text,
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.user_blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reported_user_id uuid references public.profiles(id) on delete set null,
  entity_type text not null check (entity_type in ('user', 'post', 'comment', 'message', 'circle')),
  entity_id uuid,
  reason text not null,
  details text,
  status text not null default 'open' check (status in ('open', 'reviewing', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index posts_author_created_idx on public.posts(author_id, created_at desc);
create index posts_status_created_idx on public.posts(status, created_at desc);
create index comments_post_created_idx on public.comments(post_id, created_at);
create index messages_conversation_created_idx on public.messages(conversation_id, created_at);
create index notifications_user_created_idx on public.notifications(user_id, created_at desc);
create index events_starts_idx on public.events(starts_at);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger posts_set_updated_at before update on public.posts for each row execute function public.set_updated_at();
create trigger comments_set_updated_at before update on public.comments for each row execute function public.set_updated_at();
create trigger circles_set_updated_at before update on public.circles for each row execute function public.set_updated_at();
create trigger events_set_updated_at before update on public.events for each row execute function public.set_updated_at();
create trigger courses_set_updated_at before update on public.courses for each row execute function public.set_updated_at();
create trigger conversations_set_updated_at before update on public.conversations for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, username)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    nullif(new.raw_user_meta_data->>'username', '')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('moderator', 'admin')
  );
$$;

create or replace function public.is_conversation_member(target_conversation uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.conversation_members
    where conversation_id = target_conversation and user_id = auth.uid()
  );
$$;

alter table public.profiles enable row level security;
alter table public.follows enable row level security;
alter table public.posts enable row level security;
alter table public.post_media enable row level security;
alter table public.comments enable row level security;
alter table public.post_likes enable row level security;
alter table public.saved_posts enable row level security;
alter table public.circles enable row level security;
alter table public.circle_members enable row level security;
alter table public.events enable row level security;
alter table public.event_registrations enable row level security;
alter table public.audios enable row level security;
alter table public.courses enable row level security;
alter table public.course_modules enable row level security;
alter table public.course_lessons enable row level security;
alter table public.purchases enable row level security;
alter table public.lesson_progress enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.notifications enable row level security;
alter table public.user_blocks enable row level security;
alter table public.reports enable row level security;

create policy profiles_read on public.profiles for select using (true);
create policy profiles_update_own on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

create policy follows_read on public.follows for select using (true);
create policy follows_insert_own on public.follows for insert with check (follower_id = auth.uid());
create policy follows_delete_own on public.follows for delete using (follower_id = auth.uid());

create policy posts_read on public.posts for select using (
  status = 'published' or author_id = auth.uid() or public.is_admin()
);
create policy posts_insert_own on public.posts for insert with check (author_id = auth.uid());
create policy posts_update_own on public.posts for update using (author_id = auth.uid() or public.is_admin()) with check (author_id = auth.uid() or public.is_admin());
create policy posts_delete_own on public.posts for delete using (author_id = auth.uid() or public.is_admin());

create policy post_media_read on public.post_media for select using (
  exists (select 1 from public.posts p where p.id = post_id and (p.status = 'published' or p.author_id = auth.uid()))
);
create policy post_media_write on public.post_media for all using (
  exists (select 1 from public.posts p where p.id = post_id and p.author_id = auth.uid())
) with check (
  exists (select 1 from public.posts p where p.id = post_id and p.author_id = auth.uid())
);

create policy comments_read on public.comments for select using (status = 'published' or author_id = auth.uid() or public.is_admin());
create policy comments_insert_own on public.comments for insert with check (author_id = auth.uid());
create policy comments_update_own on public.comments for update using (author_id = auth.uid() or public.is_admin());
create policy comments_delete_own on public.comments for delete using (author_id = auth.uid() or public.is_admin());

create policy likes_read on public.post_likes for select using (true);
create policy likes_insert_own on public.post_likes for insert with check (user_id = auth.uid());
create policy likes_delete_own on public.post_likes for delete using (user_id = auth.uid());

create policy saved_posts_own on public.saved_posts for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy circles_read on public.circles for select using (
  not is_private or owner_id = auth.uid() or exists (
    select 1 from public.circle_members cm where cm.circle_id = id and cm.user_id = auth.uid()
  )
);
create policy circles_insert on public.circles for insert with check (owner_id = auth.uid());
create policy circles_update on public.circles for update using (owner_id = auth.uid() or public.is_admin());
create policy circles_delete on public.circles for delete using (owner_id = auth.uid() or public.is_admin());

create policy circle_members_read on public.circle_members for select using (
  user_id = auth.uid() or exists (select 1 from public.circles c where c.id = circle_id and (not c.is_private or c.owner_id = auth.uid()))
);
create policy circle_members_join on public.circle_members for insert with check (user_id = auth.uid());
create policy circle_members_leave on public.circle_members for delete using (user_id = auth.uid() or public.is_admin());

create policy events_read on public.events for select using (status = 'published' or organizer_id = auth.uid() or public.is_admin());
create policy events_write on public.events for all using (organizer_id = auth.uid() or public.is_admin()) with check (organizer_id = auth.uid() or public.is_admin());
create policy registrations_own on public.event_registrations for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy audios_read on public.audios for select using (status = 'published' or author_id = auth.uid() or public.is_admin());
create policy audios_write on public.audios for all using (author_id = auth.uid() or public.is_admin()) with check (author_id = auth.uid() or public.is_admin());

create policy courses_read on public.courses for select using (status = 'published' or author_id = auth.uid() or public.is_admin());
create policy courses_write on public.courses for all using (author_id = auth.uid() or public.is_admin()) with check (author_id = auth.uid() or public.is_admin());
create policy course_modules_read on public.course_modules for select using (
  exists (select 1 from public.courses c where c.id = course_id and (c.status = 'published' or c.author_id = auth.uid()))
);
create policy course_lessons_read on public.course_lessons for select using (
  exists (
    select 1 from public.course_modules m join public.courses c on c.id = m.course_id
    where m.id = module_id and (c.status = 'published' or c.author_id = auth.uid())
  )
);

create policy purchases_read_own on public.purchases for select using (user_id = auth.uid() or public.is_admin());
-- Las inserciones/actualizaciones de compras deben hacerse desde backend con service role.
create policy lesson_progress_own on public.lesson_progress for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy conversations_read on public.conversations for select using (public.is_conversation_member(id) or created_by = auth.uid());
create policy conversations_insert on public.conversations for insert with check (created_by = auth.uid());
create policy conversation_members_read on public.conversation_members for select using (public.is_conversation_member(conversation_id));
create policy conversation_members_insert on public.conversation_members for insert with check (
  user_id = auth.uid() or exists (select 1 from public.conversations c where c.id = conversation_id and c.created_by = auth.uid())
);
create policy messages_read on public.messages for select using (public.is_conversation_member(conversation_id));
create policy messages_insert on public.messages for insert with check (sender_id = auth.uid() and public.is_conversation_member(conversation_id));
create policy messages_delete on public.messages for update using (sender_id = auth.uid() or public.is_admin());

create policy notifications_own on public.notifications for select using (user_id = auth.uid());
create policy notifications_update_own on public.notifications for update using (user_id = auth.uid());
create policy blocks_own on public.user_blocks for all using (blocker_id = auth.uid()) with check (blocker_id = auth.uid());
create policy reports_insert on public.reports for insert with check (reporter_id = auth.uid());
create policy reports_read_own_or_admin on public.reports for select using (reporter_id = auth.uid() or public.is_admin());
create policy reports_admin_update on public.reports for update using (public.is_admin());

insert into storage.buckets (id, name, public)
values
  ('avatars', 'avatars', true),
  ('post-media', 'post-media', false),
  ('course-media', 'course-media', false),
  ('audio-private', 'audio-private', false)
on conflict (id) do nothing;

create policy avatar_public_read on storage.objects for select using (bucket_id = 'avatars');
create policy avatar_owner_write on storage.objects for all using (
  bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]
) with check (
  bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]
);

create policy post_media_authenticated_read on storage.objects for select to authenticated using (bucket_id = 'post-media');
create policy post_media_owner_write on storage.objects for all to authenticated using (
  bucket_id = 'post-media' and auth.uid()::text = (storage.foldername(name))[1]
) with check (
  bucket_id = 'post-media' and auth.uid()::text = (storage.foldername(name))[1]
);
