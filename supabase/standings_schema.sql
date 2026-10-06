-- Execute este script no SQL Editor do Supabase (mesmo projeto dos outros schemas).
-- Guarda a classificacao de pilotos sincronizada pelas categorias sem API propria.
-- E uma "foto" da classificacao mais recente encontrada (nao historico): a cada
-- sincronizacao o job apaga e regrava as linhas da categoria.

create table if not exists public.synced_standings (
  category_id text not null,
  position int not null,
  name text not null,
  team text,
  points numeric not null,
  as_of_round int,
  source text not null default 'thesportsdb',
  updated_at timestamptz not null default now(),
  primary key (category_id, position)
);

create index if not exists synced_standings_category_idx on public.synced_standings (category_id);

alter table public.synced_standings enable row level security;

-- Leitura publica: qualquer visitante do site (mesmo anonimo) pode ler.
drop policy if exists "synced_standings_select_public" on public.synced_standings;
create policy "synced_standings_select_public"
on public.synced_standings
for select
using (true);

-- Sem policy de insert/update/delete: por padrao o RLS bloqueia essas operacoes
-- para os roles "anon" e "authenticated". Apenas a service_role (usada pelo job
-- do GitHub Actions, nunca pelo navegador) ignora RLS e consegue escrever.
