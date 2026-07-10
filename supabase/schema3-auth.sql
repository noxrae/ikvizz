-- ============================================================================
-- AETHER — Milestone 3: wire Supabase Auth.
-- Upgrades handle_new_user so the profile honors the username chosen at
-- sign-up (it arrives in raw_user_meta_data), and so a username collision
-- can never abort the signup itself — we uniquify with a numeric suffix,
-- exactly like the app server does. Safe to re-run.
-- ============================================================================
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  base text;
  uname text;
  i int := 2;
begin
  -- preferred: the username the user typed at sign-up; fallback: email-derived
  base := nullif(regexp_replace(lower(coalesce(new.raw_user_meta_data->>'username','')), '[^a-z0-9_]', '_', 'g'), '');
  if base is null or length(base) < 3 or length(base) > 24 then
    base := nullif(regexp_replace(split_part(new.email,'@',1), '[^a-z0-9_]', '_', 'g'), '');
  end if;
  if base is null or length(base) < 3 then base := 'user_' || left(new.id::text, 8); end if;
  base := left(base, 22); -- room for a 2-digit suffix within the 24-char check

  uname := base;
  while exists (select 1 from public.profiles where username = uname) loop
    uname := base || i; i := i + 1;
  end loop;

  insert into public.profiles (id, username, display_name, phone, avatar_url)
  values (
    new.id,
    uname,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1), uname),
    nullif(new.raw_user_meta_data->>'phone',''),
    new.raw_user_meta_data->>'avatar_url'
  ) on conflict (id) do nothing;
  insert into public.user_settings (user_id) values (new.id) on conflict do nothing;
  return new;
exception when others then
  -- a profile hiccup (e.g. a raced username or duplicate phone) must never
  -- block account creation — retry with a collision-proof identity
  insert into public.profiles (id, username, display_name)
  values (new.id, 'user_' || left(new.id::text, 8), coalesce(split_part(new.email,'@',1),'traveler'))
  on conflict (id) do nothing;
  insert into public.user_settings (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;

select 'milestone 3 auth trigger installed' as result;
