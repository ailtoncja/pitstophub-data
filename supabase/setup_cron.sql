-- Agenda o motor de sincronizacao. Rode UMA vez no SQL Editor, depois de:
--   1) aplicar as migrations (supabase db push)
--   2) publicar as funcoes (supabase functions deploy sync / admin)
--   3) definir SYNC_SECRET nas secrets das funcoes
--
-- Troque os dois valores abaixo antes de rodar. Eles ficam guardados no Vault
-- (criptografados), nao em texto no job.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('https://SEU-PROJETO.supabase.co', 'project_url');
select vault.create_secret('MESMO-VALOR-DO-SYNC_SECRET', 'sync_secret');

-- A cada 15 min o despachante decide o que rodar (fim de semana de corrida:
-- a cada 30 min, NASCAR a cada 15; fora disso: 1x por dia por categoria).
select cron.unschedule('pitstophub-sync') where exists (select 1 from cron.job where jobname = 'pitstophub-sync');
select cron.schedule(
  'pitstophub-sync',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/sync',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
  $$
);

-- Conferir: select * from cron.job; select * from cron.job_run_details order by start_time desc limit 20;
-- Pausar tudo: select cron.unschedule('pitstophub-sync');

-- Copia de seguranca semanal (domingo 06:00 UTC = 03:00 em Brasilia) para o
-- bucket privado "backups" (funcao backup; guarda as 8 ultimas).
select cron.unschedule('pitstophub-backup') where exists (select 1 from cron.job where jobname = 'pitstophub-backup');
select cron.schedule(
  'pitstophub-backup',
  '0 6 * * 0',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/backup',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
  $$
);
