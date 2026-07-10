-- AETHER-specific tables the base plan didn't cover (Milestones 5, 11, 12)
create table if not exists public.personas (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null, icon text not null default 'smile', bio text default '',
  created_at timestamptz not null default now()
);
alter table public.relationships add column if not exists persona_id uuid references public.personas(id) on delete set null;

create table if not exists public.promises (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  to_id uuid references public.profiles(id) on delete set null,
  message_id uuid references public.messages(id) on delete set null,
  body text not null, due_hint text default '',
  status text not null default 'open' check (status in ('open','kept','dropped')),
  created_at timestamptz not null default now()
);

create table if not exists public.reminders (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  other_id uuid not null references public.profiles(id) on delete cascade,
  body text not null, status text not null default 'open',
  created_at timestamptz not null default now()
);

-- Student mode (Phase 11)
create table if not exists public.concepts (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null, icon text default 'cpu', notes text default '',
  mastery real not null default 10, last_studied timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create table if not exists public.concept_links (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  from_id uuid not null references public.concepts(id) on delete cascade,
  to_id uuid not null references public.concepts(id) on delete cascade,
  unique (from_id, to_id)
);
create table if not exists public.study_log (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  concept_id uuid not null references public.concepts(id) on delete cascade,
  quality int not null check (quality between 1 and 3),
  created_at timestamptz not null default now()
);

-- Life mode (Phase 12)
create table if not exists public.life_items (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  room text not null, title text not null, body text default '',
  due_at timestamptz, status text not null default 'open',
  created_at timestamptz not null default now()
);
create table if not exists public.habits (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null, streak int not null default 0, last_done timestamptz,
  created_at timestamptz not null default now()
);

-- RLS: all of these are strictly the owner's
do $$ declare t text;
begin
  foreach t in array array['personas','reminders','concepts','concept_links','study_log','life_items','habits'] loop
    execute format('alter table public.%s enable row level security', t);
    execute format('drop policy if exists p_%s_own on public.%s', t, t);
    execute format('create policy p_%s_own on public.%s for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t, t);
  end loop;
end $$;
alter table public.promises enable row level security;
drop policy if exists p_promises_rw on public.promises;
create policy p_promises_rw on public.promises for all to authenticated
  using (user_id = auth.uid() or to_id = auth.uid()) with check (user_id = auth.uid());

select table_name from information_schema.tables where table_schema='public' order by table_name;
