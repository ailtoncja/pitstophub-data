-- Execute este script no SQL Editor do Supabase (mesmo projeto do schema.sql).
-- Guarda o calendario sincronizado pelas categorias sem API propria (via TheSportsDB).

create table if not exists public.synced_races (
  category_id text not null,
  race_id text not null,
  round int,
  name text not null,
  en_name text,
  location text,
  en_location text,
  circuit text,
  date date not null,
  starts_at timestamptz,
  status text not null check (status in ('upcoming', 'completed', 'cancelled')),
  winner text,
  external_id text, -- idEvent na TheSportsDB, usado pra buscar o resultado completo (ver results_schema.sql)
  source text not null default 'thesportsdb',
  updated_at timestamptz not null default now(),
  primary key (category_id, race_id)
);

create index if not exists synced_races_category_idx on public.synced_races (category_id);

alter table public.synced_races enable row level security;

-- Leitura publica: qualquer visitante do site (mesmo anonimo) pode ler.
drop policy if exists "synced_races_select_public" on public.synced_races;
create policy "synced_races_select_public"
on public.synced_races
for select
using (true);

-- Sem policy de insert/update/delete: por padrao o RLS bloqueia essas operacoes
-- para os roles "anon" e "authenticated". Apenas a service_role (usada pelo job
-- do GitHub Actions, nunca pelo navegador) ignora RLS e consegue escrever.
