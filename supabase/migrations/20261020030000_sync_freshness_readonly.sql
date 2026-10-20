-- A view sync_freshness e publica so para LEITURA. Por ser uma view simples de
-- uma tabela, o Postgres a trata como gravavel, e o Supabase da INSERT/UPDATE/
-- DELETE para anon/authenticated por padrao: um visitante conseguiria alterar
-- sync_status atraves dela. Fecha a escrita e deixa so o SELECT.

revoke all on public.sync_freshness from public, anon, authenticated;
grant select on public.sync_freshness to anon, authenticated;

-- Novas tabelas, views e funcoes criadas no schema public deixam de receber
-- permissao de escrita/execucao automatica para anon/authenticated: cada
-- permissao passa a ser dada de proposito.
alter default privileges in schema public revoke insert, update, delete, truncate, references, trigger on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
