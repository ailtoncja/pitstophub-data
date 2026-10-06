-- Execute este script no SQL Editor do Supabase.

create extension if not exists "pgcrypto";

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  theme text not null default 'dark' check (theme in ('dark', 'light')),
  language text not null default 'pt' check (language in ('pt', 'en')),
  favorite_category_id text not null default 'f1',
  followed_category_ids text[] not null default '{}',
  followed_team_ids text[] not null default '{}',
  followed_driver_ids text[] not null default '{}',
  notify_race_day boolean not null default true,
  notify_t60 boolean not null default true,
  notify_start boolean not null default true,
  notify_results boolean not null default true,
  timezone text not null default 'America/Sao_Paulo',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_settings_set_updated_at on public.user_settings;
create trigger user_settings_set_updated_at
before update on public.user_settings
for each row
execute function public.set_updated_at();

alter table public.user_settings enable row level security;

-- Um usuario autenticado pode ler apenas as proprias configuracoes.
drop policy if exists "user_settings_select_own" on public.user_settings;
create policy "user_settings_select_own"
on public.user_settings
for select
using (auth.uid() = user_id);

-- Um usuario autenticado pode inserir apenas a propria linha.
drop policy if exists "user_settings_insert_own" on public.user_settings;
create policy "user_settings_insert_own"
on public.user_settings
for insert
with check (auth.uid() = user_id);

-- Um usuario autenticado pode atualizar apenas a propria linha.
drop policy if exists "user_settings_update_own" on public.user_settings;
create policy "user_settings_update_own"
on public.user_settings
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
