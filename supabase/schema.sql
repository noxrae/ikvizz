-- ============================================================================
-- AETHER — Complete Supabase schema (Milestone 1 → 2)
-- Paste this WHOLE file into Supabase → SQL Editor → New Query → Run.
-- Order matters; it is safe to re-run (IF NOT EXISTS everywhere).
-- Every table has Row Level Security. Free tier only — nothing here costs money.
-- ============================================================================
create extension if not exists "uuid-ossp";
create extension if not exists vector; -- for AI embeddings (pgvector, free)

-- ========================= PART 1 · AUTHENTICATION ==========================
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  username      text unique not null check (username ~ '^[a-z0-9_]{3,24}$'),
  display_name  text not null default '',
  bio           text default '',
  phone         text unique,
  avatar_url    text,
  cover_url     text,
  avatar_hue    int  not null default 210,
  mood          text,                          -- AETHER mood blob key
  context       text not null default 'available',
  context_note  text default '',
  context_scope text not null default 'all' check (context_scope in ('all','inner','none')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.user_settings (
  user_id        uuid primary key references public.profiles(id) on delete cascade,
  theme          text not null default 'dark',
  accent         text not null default 'violet',
  read_receipts  boolean not null default true,
  show_last_seen boolean not null default true,
  notifications  jsonb not null default '{"mentions":true,"critical":true,"calls":true,"stories":true}'::jsonb,
  updated_at     timestamptz not null default now()
);

create table if not exists public.friend_requests (
  id          uuid primary key default uuid_generate_v4(),
  from_id     uuid not null references public.profiles(id) on delete cascade,
  to_id       uuid not null references public.profiles(id) on delete cascade,
  kind        text not null default 'Friend',
  status      text not null default 'pending' check (status in ('pending','accepted','declined','blocked')),
  created_at  timestamptz not null default now(),
  unique (from_id, to_id)
);

-- Relationship graph (accepted friendships, typed + weighted, per-direction)
create table if not exists public.relationships (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  other_id   uuid not null references public.profiles(id) on delete cascade,
  kind       text not null default 'Friend',
  closeness  int  not null default 2 check (closeness between 1 and 3),
  pinned     boolean not null default false,
  muted      boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, other_id)
);

-- ============================= PART 2 · CHAT ================================
create table if not exists public.chats (
  id          uuid primary key default uuid_generate_v4(),
  kind        text not null default 'dm' check (kind in ('dm','group')),
  name        text,                             -- groups only
  icon        text,
  description text,
  owner_id    uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table if not exists public.chat_members (
  chat_id   uuid not null references public.chats(id) on delete cascade,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  role      text not null default 'member' check (role in ('owner','admin','member')),
  joined_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);

create table if not exists public.messages (
  id         uuid primary key default uuid_generate_v4(),
  chat_id    uuid not null references public.chats(id) on delete cascade,
  sender_id  uuid not null references public.profiles(id) on delete cascade,
  kind       text not null default 'text' check (kind in ('text','sealed','poll','system','call_log')),
  body       text not null default '',
  priority   text not null default 'normal',
  signals    jsonb not null default '[]'::jsonb, -- promises/ideas/mood/mention/effect/silent/capsule/poll options
  reply_to   uuid references public.messages(id) on delete set null,
  unlock_at  timestamptz,                        -- time capsules
  edited_at  timestamptz,
  deleted    boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_messages_chat on public.messages (chat_id, created_at);
create index if not exists idx_messages_body_fts on public.messages using gin (to_tsvector('english', body));

create table if not exists public.message_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null,                      -- AETHER mood keys
  primary key (message_id, user_id, kind)
);

create table if not exists public.attachments (
  id         uuid primary key default uuid_generate_v4(),
  message_id uuid references public.messages(id) on delete cascade,
  bucket     text not null default 'media',      -- storage bucket name
  path       text not null,                      -- object path inside bucket
  name       text not null default '',
  mime       text not null default '',
  size       bigint not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.message_reads (
  chat_id      uuid not null references public.chats(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);

create table if not exists public.poll_votes (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  opt        int not null,
  primary key (message_id, user_id)
);

-- ============================= PART 3 · CALLS ===============================
create table if not exists public.calls (
  id         uuid primary key default uuid_generate_v4(),
  chat_id    uuid references public.chats(id) on delete set null,
  starter_id uuid not null references public.profiles(id) on delete cascade,
  media      text not null default 'audio' check (media in ('audio','video','screen')),
  started_at timestamptz not null default now(),
  ended_at   timestamptz,
  status     text not null default 'ringing' check (status in ('ringing','active','ended','missed','declined'))
);

create table if not exists public.call_participants (
  call_id   uuid not null references public.calls(id) on delete cascade,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz,
  left_at   timestamptz,
  primary key (call_id, user_id)
);

-- ============================ PART 4 · STORIES ==============================
create table if not exists public.stories (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null default 'text' check (kind in ('text','image','video','voice','music')),
  body       text default '',
  bucket     text,
  path       text,
  scope      text not null default 'all' check (scope in ('all','inner')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours'
);
create index if not exists idx_stories_live on public.stories (expires_at);

create table if not exists public.story_views (
  story_id  uuid not null references public.stories(id) on delete cascade,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (story_id, user_id)
);

create table if not exists public.story_reactions (
  story_id uuid not null references public.stories(id) on delete cascade,
  user_id  uuid not null references public.profiles(id) on delete cascade,
  kind     text not null,
  primary key (story_id, user_id)
);

-- ========================= PART 5 · NOTIFICATIONS ===========================
create table if not exists public.notifications (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null,                      -- mention|call|reaction|story|promise|system
  title      text not null,
  body       text default '',
  data       jsonb not null default '{}'::jsonb,
  read       boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_notifications_user on public.notifications (user_id, read, created_at desc);

-- =============================== PART 6 · AI ================================
create table if not exists public.conversation_memory (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  chat_id    uuid references public.chats(id) on delete cascade,
  message_id uuid references public.messages(id) on delete set null,
  body       text not null,
  note       text default '',
  created_at timestamptz not null default now()
);

create table if not exists public.relationship_memory (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  other_id   uuid not null references public.profiles(id) on delete cascade,
  type       text not null,                      -- promise|idea|milestone|memory|first_message
  title      text not null,
  status     text default 'open',
  created_at timestamptz not null default now()
);

create table if not exists public.ai_summaries (
  id         uuid primary key default uuid_generate_v4(),
  chat_id    uuid not null references public.chats(id) on delete cascade,
  engine     text not null default 'heuristic',
  body       text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.knowledge_graph (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  node_type  text not null,                      -- person|idea|project|concept|file|dream
  label      text not null,
  linked_to  uuid references public.knowledge_graph(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.user_vectors (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  ref_kind   text not null,                      -- message|memory|story
  ref_id     uuid not null,
  embedding  vector(384),                        -- BGE-small / MiniLM dimension
  created_at timestamptz not null default now()
);

-- ===================== TRIGGERS: profile on signup, updated_at ==============
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, display_name, avatar_url)
  values (
    new.id,
    coalesce(nullif(regexp_replace(split_part(new.email,'@',1),'[^a-z0-9_]','_','g'),''), 'user_' || left(new.id::text, 8)),
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)),
    new.raw_user_meta_data->>'avatar_url'
  ) on conflict (id) do nothing;
  insert into public.user_settings (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================ ROW LEVEL SECURITY ============================
alter table public.profiles           enable row level security;
alter table public.user_settings      enable row level security;
alter table public.friend_requests    enable row level security;
alter table public.relationships      enable row level security;
alter table public.chats              enable row level security;
alter table public.chat_members       enable row level security;
alter table public.messages           enable row level security;
alter table public.message_reactions  enable row level security;
alter table public.attachments        enable row level security;
alter table public.message_reads      enable row level security;
alter table public.poll_votes         enable row level security;
alter table public.calls              enable row level security;
alter table public.call_participants  enable row level security;
alter table public.stories            enable row level security;
alter table public.story_views        enable row level security;
alter table public.story_reactions    enable row level security;
alter table public.notifications      enable row level security;
alter table public.conversation_memory enable row level security;
alter table public.relationship_memory enable row level security;
alter table public.ai_summaries       enable row level security;
alter table public.knowledge_graph    enable row level security;
alter table public.user_vectors       enable row level security;

-- helper: am I a member of this chat?
create or replace function public.is_chat_member(c uuid) returns boolean
language sql security definer set search_path = public as
$$ select exists (select 1 from chat_members where chat_id = c and user_id = auth.uid()) $$;

-- profiles: readable by any signed-in user; only you edit yours
drop policy if exists p_profiles_read  on public.profiles;
drop policy if exists p_profiles_write on public.profiles;
create policy p_profiles_read  on public.profiles for select to authenticated using (true);
create policy p_profiles_write on public.profiles for update to authenticated using (id = auth.uid());

-- settings / notifications / memories / graph / vectors: strictly your own
do $$ declare t text;
begin
  foreach t in array array['user_settings','notifications','conversation_memory','knowledge_graph','user_vectors'] loop
    execute format('drop policy if exists p_%s_own on public.%s', t, t);
    execute format('create policy p_%s_own on public.%s for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t, t);
  end loop;
end $$;

-- friend requests / relationships: either side may read; sender/owner writes
drop policy if exists p_fr_rw on public.friend_requests;
create policy p_fr_rw on public.friend_requests for all to authenticated
  using (from_id = auth.uid() or to_id = auth.uid()) with check (from_id = auth.uid() or to_id = auth.uid());
drop policy if exists p_rel_rw on public.relationships;
create policy p_rel_rw on public.relationships for all to authenticated
  using (user_id = auth.uid() or other_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists p_relmem_rw on public.relationship_memory;
create policy p_relmem_rw on public.relationship_memory for all to authenticated
  using (user_id = auth.uid() or other_id = auth.uid()) with check (user_id = auth.uid());

-- chats & everything inside them: members only
drop policy if exists p_chats_member on public.chats;
create policy p_chats_member on public.chats for select to authenticated using (public.is_chat_member(id));
drop policy if exists p_chats_insert on public.chats;
create policy p_chats_insert on public.chats for insert to authenticated with check (owner_id = auth.uid() or kind = 'dm');
drop policy if exists p_cm_rw on public.chat_members;
create policy p_cm_rw on public.chat_members for all to authenticated
  using (user_id = auth.uid() or public.is_chat_member(chat_id)) with check (public.is_chat_member(chat_id) or user_id = auth.uid());
drop policy if exists p_msg_read on public.messages;
create policy p_msg_read on public.messages for select to authenticated using (public.is_chat_member(chat_id));
drop policy if exists p_msg_write on public.messages;
create policy p_msg_write on public.messages for insert to authenticated with check (sender_id = auth.uid() and public.is_chat_member(chat_id));
drop policy if exists p_msg_edit on public.messages;
create policy p_msg_edit on public.messages for update to authenticated using (sender_id = auth.uid());
do $$ declare t text;
begin
  foreach t in array array['message_reactions','poll_votes'] loop
    execute format('drop policy if exists p_%s_rw on public.%s', t, t);
    execute format('create policy p_%s_rw on public.%s for all to authenticated using (public.is_chat_member((select chat_id from messages where id = message_id)) or user_id = auth.uid()) with check (user_id = auth.uid())', t, t);
  end loop;
end $$;
drop policy if exists p_reads_rw on public.message_reads;
create policy p_reads_rw on public.message_reads for all to authenticated
  using (public.is_chat_member(chat_id)) with check (user_id = auth.uid());
drop policy if exists p_att_rw on public.attachments;
create policy p_att_rw on public.attachments for all to authenticated
  using (message_id is null or public.is_chat_member((select chat_id from messages where id = message_id)))
  with check (true);
drop policy if exists p_sum_read on public.ai_summaries;
create policy p_sum_read on public.ai_summaries for select to authenticated using (public.is_chat_member(chat_id));

-- calls: participants only
drop policy if exists p_calls_rw on public.calls;
create policy p_calls_rw on public.calls for all to authenticated
  using (starter_id = auth.uid() or exists (select 1 from call_participants where call_id = id and user_id = auth.uid()))
  with check (starter_id = auth.uid());
drop policy if exists p_cp_rw on public.call_participants;
create policy p_cp_rw on public.call_participants for all to authenticated
  using (user_id = auth.uid() or exists (select 1 from calls where id = call_id and starter_id = auth.uid()))
  with check (user_id = auth.uid());

-- stories: owner + relationships, honoring the inner-circle scope
drop policy if exists p_stories_read on public.stories;
create policy p_stories_read on public.stories for select to authenticated using (
  user_id = auth.uid() or (
    expires_at > now() and exists (
      select 1 from relationships r where r.user_id = stories.user_id and r.other_id = auth.uid()
        and (stories.scope = 'all' or r.closeness = 1)
    )
  )
);
drop policy if exists p_stories_write on public.stories;
create policy p_stories_write on public.stories for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
do $$ declare t text;
begin
  foreach t in array array['story_views','story_reactions'] loop
    execute format('drop policy if exists p_%s_rw on public.%s', t, t);
    execute format('create policy p_%s_rw on public.%s for all to authenticated using (user_id = auth.uid() or exists (select 1 from stories s where s.id = story_id and s.user_id = auth.uid())) with check (user_id = auth.uid())', t, t);
  end loop;
end $$;

-- ===================== STORAGE BUCKET POLICY MAPPING ========================
-- Buckets expected: avatars (public read), media (private), stories (private)
-- Run these AFTER creating the buckets in Storage → (names must match):
-- insert into storage.buckets (id, name, public) values ('avatars','avatars', true) on conflict do nothing;
-- insert into storage.buckets (id, name, public) values ('media','media', false) on conflict do nothing;
-- insert into storage.buckets (id, name, public) values ('stories','stories', false) on conflict do nothing;
drop policy if exists "avatars_public_read" on storage.objects;
create policy "avatars_public_read" on storage.objects for select using (bucket_id = 'avatars');
drop policy if exists "own_folder_write" on storage.objects;
create policy "own_folder_write" on storage.objects for insert to authenticated
  with check (bucket_id in ('avatars','media','stories') and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "own_folder_delete" on storage.objects;
create policy "own_folder_delete" on storage.objects for delete to authenticated
  using ((storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "member_media_read" on storage.objects;
create policy "member_media_read" on storage.objects for select to authenticated
  using (bucket_id in ('media','stories'));

select 'AETHER schema installed — ' || count(*) || ' tables live' as result
from information_schema.tables where table_schema = 'public';
