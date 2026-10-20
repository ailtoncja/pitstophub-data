-- Revisao de seguranca (out/2026). Pode rodar mais de uma vez.
--
-- a) search_path fixo ('') nas funcoes do motor e no gatilho de updated_at.
-- b) pg_net: so o postgres (dono dos jobs do pg_cron) chama net.*.
-- c) anon/authenticated sem escrita nas tabelas do public; leitura so onde o
--    site/app leem. As tabelas do usuario ficam so para authenticated (RLS).
-- d) push_subscriptions: politica de UPDATE (upsert do app), formato do
--    endpoint e no maximo 10 inscricoes por usuario.
-- e) user_settings: fuso horario valido e no maximo 200 itens por lista.

-- ---------------------------------------------------------------------------
-- a) search_path. Os corpos ja usam public.<tabela>; o resto (now, jsonb_*,
--    coalesce...) e do pg_catalog, que sempre esta no caminho.

alter function public.sync_apply_races(text, int, text, jsonb) set search_path = '';
alter function public.sync_apply_standings(text, int, text, text, int, jsonb) set search_path = '';
alter function public.sync_archive_category(text, int, text) set search_path = '';
alter function public.set_updated_at() set search_path = '';

-- Funcao de gatilho nao precisa de EXECUTE para disparar; ninguem chama via API.
revoke all on function public.set_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- b) pg_net. As tabelas e funcoes do schema net vem com acesso para PUBLIC
--    (inclui anon/authenticated). Os jobs do pg_cron rodam como postgres e
--    chamam net.http_post (que grava em net.http_request_queue como quem chama),
--    entao o postgres recebe acesso explicito ANTES de tirar o de PUBLIC.
--
--    No Supabase o schema net pertence ao supabase_admin: se o postgres nao
--    puder alterar essas permissoes, o Postgres so avisa (WARNING "no
--    privileges could be revoked") e nada muda. O bloco no fim confere e
--    avisa; e aborta a migration se o postgres tiver perdido o acesso.
--    Projeto novo: o pg_net so e criado no setup_cron.sql (depois das
--    migrations); rode este bloco de novo depois dele.

do $$
declare
  r text;
begin
  if not exists (select 1 from pg_catalog.pg_namespace where nspname = 'net') then
    raise notice 'schema net nao existe (pg_net nao instalado); pulando.';
    return;
  end if;

  foreach r in array array['postgres', 'supabase_functions_admin'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('grant usage on schema net to %I', r);
      execute format('grant select, insert, update, delete on all tables in schema net to %I', r);
      execute format('grant usage, select on all sequences in schema net to %I', r);
      execute format('grant execute on all functions in schema net to %I', r);
    end if;
  end loop;

  revoke all on all tables in schema net from public, anon, authenticated;
  revoke all on all sequences in schema net from public, anon, authenticated;
  revoke execute on all functions in schema net from public, anon, authenticated;
  -- PUBLIC tambem: senao anon/authenticated continuam com USAGE por ele.
  revoke usage on schema net from public, anon, authenticated;

  if not pg_catalog.has_function_privilege('postgres', 'net.http_post(text, jsonb, jsonb, jsonb, integer)', 'execute')
     or not pg_catalog.has_table_privilege('postgres', 'net.http_request_queue', 'insert') then
    raise exception 'postgres perdeu acesso ao pg_net (o cron pararia); migration abortada';
  end if;

  if pg_catalog.has_function_privilege('anon', 'net.http_post(text, jsonb, jsonb, jsonb, integer)', 'execute')
     or pg_catalog.has_table_privilege('anon', 'net.http_request_queue', 'select')
     or pg_catalog.has_schema_privilege('anon', 'net', 'usage') then
    raise warning 'anon ainda tem acesso ao schema net: o dono (supabase_admin) nao deixou o postgres mudar. Rode a parte b) com o dono do schema ou peca ao suporte do Supabase.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- c) Permissoes de anon/authenticated no public. Antes: todas as tabelas com
--    SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES e TRIGGER (padrao do
--    Supabase), barradas so pelo RLS. Agora cada permissao e dada de proposito.
--    service_role e postgres nao mudam (Edge Functions e cron).

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- Leitura publica (site e app), com politica "select using (true)".
grant select on public.synced_races, public.synced_standings, public.standings_detail, public.race_results
  to anon, authenticated;
grant select on public.sync_freshness to anon, authenticated;

-- Dados de cada usuario: so logado, e o RLS limita a propria linha.
grant select, insert, update on public.user_settings to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- ---------------------------------------------------------------------------
-- d) push_subscriptions.

-- O app salva a inscricao com upsert (on conflict endpoint): precisa de UPDATE.
drop policy if exists "push_subscriptions_update_own" on public.push_subscriptions;
create policy "push_subscriptions_update_own"
on public.push_subscriptions
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- So servicos de push conhecidos (o envio faz POST nesse endpoint) e tamanhos
-- razoaveis. Conferido antes: as linhas atuais (FCM e Apple) passam.
alter table public.push_subscriptions drop constraint if exists push_subscriptions_endpoint_check;
alter table public.push_subscriptions add constraint push_subscriptions_endpoint_check check (
  length(endpoint) < 1024
  and endpoint ~ '^https://(fcm\.googleapis\.com|web\.push\.apple\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+(\.[a-z0-9-]+)*\.notify\.windows\.com)/'
) not valid;
alter table public.push_subscriptions validate constraint push_subscriptions_endpoint_check;

alter table public.push_subscriptions drop constraint if exists push_subscriptions_keys_length_check;
alter table public.push_subscriptions add constraint push_subscriptions_keys_length_check check (
  length(p256dh) < 256 and length(auth) < 64
) not valid;
alter table public.push_subscriptions validate constraint push_subscriptions_keys_length_check;

-- No maximo 10 inscricoes (aparelhos/navegadores) por usuario.
create or replace function public.push_subscriptions_limit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Upsert do mesmo endpoint vira UPDATE: nao conta como inscricao nova.
  if exists (select 1 from public.push_subscriptions where endpoint = new.endpoint and user_id = new.user_id) then
    return new;
  end if;
  if (select count(*) from public.push_subscriptions where user_id = new.user_id) >= 10 then
    raise exception 'limite de 10 inscricoes de notificacao por usuario'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function public.push_subscriptions_limit() from public, anon, authenticated;

drop trigger if exists push_subscriptions_limit on public.push_subscriptions;
create trigger push_subscriptions_limit
before insert on public.push_subscriptions
for each row
execute function public.push_subscriptions_limit();

-- ---------------------------------------------------------------------------
-- e) user_settings.

-- Fuso horario precisa existir no Postgres (o app usa para mostrar horarios).
create or replace function public.user_settings_check_timezone()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.timezone is not distinct from old.timezone then
      return new;
    end if;
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'fuso horario invalido: %', left(new.timezone, 64)
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function public.user_settings_check_timezone() from public, anon, authenticated;

drop trigger if exists user_settings_check_timezone on public.user_settings;
create trigger user_settings_check_timezone
before insert or update on public.user_settings
for each row
execute function public.user_settings_check_timezone();

-- Listas de seguidos com no maximo 200 itens (maior lista atual: 19).
alter table public.user_settings drop constraint if exists user_settings_follow_lists_max_check;
alter table public.user_settings add constraint user_settings_follow_lists_max_check check (
  cardinality(followed_category_ids) <= 200
  and cardinality(followed_team_ids) <= 200
  and cardinality(followed_driver_ids) <= 200
  and cardinality(priority_follow_ids) <= 200
) not valid;
alter table public.user_settings validate constraint user_settings_follow_lists_max_check;
