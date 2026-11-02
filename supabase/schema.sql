-- Ni'ma — Supabase schema for encrypted sync + push reminders.
-- Run once in the Supabase dashboard: SQL Editor → New query → paste → Run.
--
-- Nothing stored here can be read without the user's password or recovery key:
-- `vaults.blob` is the app data encrypted on the device, `vaults.keys` is the
-- data key locked by the password and by the recovery key. `push_subs.days`
-- holds only the dates a bill falls due (no amounts, names or categories).

create table if not exists public.vaults (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  version    integer not null default 1,
  keys       jsonb not null,
  blob       text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.push_subs (
  endpoint   text primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  tz         text not null default 'UTC',
  days       text[] not null default '{}',
  last_sent  text,
  created_at timestamptz not null default now()
);
create index if not exists push_subs_user_idx on public.push_subs (user_id);

-- Row-level security: a signed-in user can only ever see or change their own rows.
alter table public.vaults    enable row level security;
alter table public.push_subs enable row level security;

drop policy if exists "own vault" on public.vaults;
create policy "own vault" on public.vaults
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own push subs" on public.push_subs;
create policy "own push subs" on public.push_subs
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

revoke all on public.vaults, public.push_subs from anon;
grant select, insert, update, delete on public.vaults, public.push_subs to authenticated;
grant all on public.vaults, public.push_subs to service_role;
