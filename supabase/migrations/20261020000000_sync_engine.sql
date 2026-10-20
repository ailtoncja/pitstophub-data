-- Motor de sincronizacao (Edge Functions + pg_cron), substitui o GitHub Actions.
-- Compativel com o que o site e o app Android ja leem: synced_races e
-- synced_standings continuam iguais, so ganham colunas novas.

-- Tabelas que ja existiam (supabase/races_schema.sql e standings_schema.sql):
-- recriadas aqui com "if not exists" para um projeto novo funcionar so com as migrations.
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
  external_id text,
  source text not null default 'thesportsdb',
  updated_at timestamptz not null default now(),
  primary key (category_id, race_id)
);
alter table public.synced_races add column if not exists starts_at timestamptz;
alter table public.synced_races add column if not exists season int;
alter table public.synced_races add column if not exists official boolean not null default true;
alter table public.synced_races add column if not exists source_url text;

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
alter table public.synced_standings add column if not exists season int;

alter table public.synced_races enable row level security;
alter table public.synced_standings enable row level security;
drop policy if exists "synced_races_select_public" on public.synced_races;
create policy "synced_races_select_public" on public.synced_races for select using (true);
drop policy if exists "synced_standings_select_public" on public.synced_standings;
create policy "synced_standings_select_public" on public.synced_standings for select using (true);

-- Classificacoes alem da de pilotos: equipes, fabricantes, classes (WEC/IMSA/GTWC).
create table if not exists public.standings_detail (
  category_id text not null,
  season int not null,
  grp text not null,
  position int not null,
  name text not null,
  team text,
  points numeric not null,
  as_of_round int,
  source text not null,
  updated_at timestamptz not null default now(),
  primary key (category_id, grp, position)
);
alter table public.standings_detail enable row level security;
drop policy if exists "standings_detail_select_public" on public.standings_detail;
create policy "standings_detail_select_public" on public.standings_detail for select using (true);

-- Resultado completo de cada corrida (base do calculo da classificacao).
create table if not exists public.race_results (
  category_id text not null,
  season int not null,
  race_id text not null,
  session text not null,
  official boolean not null default true,
  rows jsonb not null,
  source text not null,
  updated_at timestamptz not null default now(),
  primary key (category_id, season, race_id, session)
);
alter table public.race_results enable row level security;
drop policy if exists "race_results_select_public" on public.race_results;
create policy "race_results_select_public" on public.race_results for select using (true);

-- Historico: temporadas encerradas e linhas antigas nunca sao apagadas, so movidas para ca.
create table if not exists public.synced_races_archive (
  id bigserial primary key,
  category_id text not null,
  season int,
  race jsonb not null,
  reason text not null,
  archived_at timestamptz not null default now()
);
create table if not exists public.standings_archive (
  id bigserial primary key,
  category_id text not null,
  season int,
  grp text not null,
  rows jsonb not null,
  reason text not null,
  archived_at timestamptz not null default now()
);
alter table public.synced_races_archive enable row level security;
alter table public.standings_archive enable row level security;

-- Configuracao por categoria (editavel pelo painel).
create table if not exists public.category_config (
  category_id text primary key,
  mode text not null default 'dry_run' check (mode in ('off', 'dry_run', 'live')),
  season_override int,
  params jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.category_config enable row level security;

-- Regra de pontos por temporada. Sem linha aqui, vale a regra padrao do adaptador.
create table if not exists public.points_rules (
  category_id text not null,
  season int not null,
  rules jsonb not null,
  note text,
  updated_at timestamptz not null default now(),
  primary key (category_id, season)
);
alter table public.points_rules enable row level security;

-- Correcoes manuais feitas no painel. Valem ate a fonte oficial trazer o mesmo dado.
create table if not exists public.manual_overrides (
  id uuid primary key default gen_random_uuid(),
  category_id text not null,
  season int not null,
  race_id text,
  kind text not null check (kind in ('winner', 'race_status', 'race_date', 'standing_points')),
  value jsonb not null,
  note text,
  active boolean not null default true,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.manual_overrides enable row level security;

-- Estado de cada categoria: ultima execucao, ultimo sucesso, problemas, alertas.
create table if not exists public.sync_status (
  category_id text primary key,
  season int,
  mode text,
  source text,
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_change_at timestamptz,
  as_of_round int,
  consecutive_failures int not null default 0,
  last_error text,
  problems jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  last_report jsonb,
  last_alert_key text,
  last_alert_at timestamptz
);
alter table public.sync_status enable row level security;

-- O site pode mostrar "atualizado ate a etapa X" sem expor detalhes internos.
create or replace view public.sync_freshness
with (security_invoker = false) as
  select category_id, season, as_of_round, last_success_at, last_change_at,
         (consecutive_failures > 0) as degraded
  from public.sync_status;
grant select on public.sync_freshness to anon, authenticated;

-- Toda mudanca gravada fica registrada (permite desfazer pelo painel).
create table if not exists public.sync_changes (
  id bigserial primary key,
  run_id uuid not null,
  category_id text not null,
  season int,
  entity text not null,
  entity_key text not null,
  before jsonb,
  after jsonb,
  source text,
  reverted boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists sync_changes_category_idx on public.sync_changes (category_id, created_at desc);
alter table public.sync_changes enable row level security;

-- ---------------------------------------------------------------------------
-- Funcoes de gravacao (transacionais). So a service_role (Edge Functions) chama.

-- Upsert de corridas. Nunca apaga: corrida que sumiu da fonte continua aqui.
create or replace function public.sync_apply_races(p_category text, p_season int, p_source text, p_rows jsonb)
returns void
language plpgsql
as $$
begin
  insert into public.synced_races as t (
    category_id, race_id, round, name, en_name, location, en_location, circuit, date,
    starts_at, status, winner, external_id, source, source_url, official, season, updated_at
  )
  select p_category, r->>'raceId', (r->>'round')::int, r->>'name', r->>'enName', r->>'location',
         r->>'enLocation', r->>'circuit', (r->>'date')::date, nullif(r->>'startsAt', '')::timestamptz,
         r->>'status', r->>'winner', r->>'externalId', p_source, r->>'sourceUrl',
         coalesce((r->>'official')::boolean, true), p_season, now()
  from jsonb_array_elements(p_rows) as r
  on conflict (category_id, race_id) do update set
    round = excluded.round, name = excluded.name, en_name = excluded.en_name,
    location = excluded.location, en_location = excluded.en_location, circuit = excluded.circuit,
    date = excluded.date, starts_at = excluded.starts_at, status = excluded.status,
    winner = coalesce(excluded.winner, t.winner), external_id = excluded.external_id,
    source = excluded.source, source_url = excluded.source_url, official = excluded.official,
    season = excluded.season, updated_at = now();
end;
$$;

-- Troca atomica de uma classificacao ja validada.
create or replace function public.sync_apply_standings(
  p_category text, p_season int, p_group text, p_source text, p_as_of_round int, p_rows jsonb
)
returns void
language plpgsql
as $$
begin
  if jsonb_array_length(p_rows) = 0 then
    raise exception 'classificacao vazia para %/%', p_category, p_group;
  end if;
  if p_group = 'drivers' then
    delete from public.synced_standings where category_id = p_category;
    insert into public.synced_standings (category_id, position, name, team, points, as_of_round, source, season, updated_at)
    select p_category, (r->>'position')::int, r->>'name', r->>'team', (r->>'points')::numeric,
           p_as_of_round, p_source, p_season, now()
    from jsonb_array_elements(p_rows) as r;
  else
    delete from public.standings_detail where category_id = p_category and grp = p_group;
    insert into public.standings_detail (category_id, season, grp, position, name, team, points, as_of_round, source, updated_at)
    select p_category, p_season, p_group, (r->>'position')::int, r->>'name', r->>'team',
           (r->>'points')::numeric, p_as_of_round, p_source, now()
    from jsonb_array_elements(p_rows) as r;
  end if;
end;
$$;

-- Move para o arquivo tudo que nao for da temporada atual (virada de ano) ou
-- que veio do sistema antigo (season null). Nada e apagado sem copia.
create or replace function public.sync_archive_category(p_category text, p_keep_season int, p_reason text)
returns int
language plpgsql
as $$
declare moved int;
begin
  insert into public.synced_races_archive (category_id, season, race, reason)
  select category_id, season, to_jsonb(t), p_reason
  from public.synced_races t
  where category_id = p_category and season is distinct from p_keep_season;
  get diagnostics moved = row_count;

  delete from public.synced_races
  where category_id = p_category and season is distinct from p_keep_season;

  insert into public.standings_archive (category_id, season, grp, rows, reason)
  select category_id, season, 'drivers', jsonb_agg(to_jsonb(s) order by position), p_reason
  from public.synced_standings s
  where category_id = p_category and season is distinct from p_keep_season
  group by category_id, season;
  delete from public.synced_standings where category_id = p_category and season is distinct from p_keep_season;

  insert into public.standings_archive (category_id, season, grp, rows, reason)
  select category_id, season, grp, jsonb_agg(to_jsonb(d) order by position), p_reason
  from public.standings_detail d
  where category_id = p_category and season <> p_keep_season
  group by category_id, season, grp;
  delete from public.standings_detail where category_id = p_category and season <> p_keep_season;

  return moved;
end;
$$;

revoke all on function public.sync_apply_races(text, int, text, jsonb) from public, anon, authenticated;
revoke all on function public.sync_apply_standings(text, int, text, text, int, jsonb) from public, anon, authenticated;
revoke all on function public.sync_archive_category(text, int, text) from public, anon, authenticated;

-- Todas as categorias comecam em modo teste: rodam, geram relatorio, nao gravam.
insert into public.category_config (category_id, mode) values
  ('nascar', 'dry_run'), ('nascar-brasil', 'dry_run'), ('indy', 'dry_run'),
  ('f1-academy', 'dry_run'), ('f2', 'dry_run'), ('f3', 'dry_run'),
  ('wec', 'dry_run'), ('imsa', 'dry_run'), ('dtm', 'dry_run'), ('wrc', 'dry_run'),
  ('porsche-cup', 'dry_run')
on conflict (category_id) do nothing;
-- GTWC e Endurance Brasil continuam nas tabelas proprias (gtwc_*, eb_*) servidas
-- pelo api-motorsports; a migracao delas fica naquele repositorio.
