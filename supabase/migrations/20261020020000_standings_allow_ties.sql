-- Empates de posicao sao normais (ex.: WEC, os 3 pilotos do mesmo carro dividem
-- a posicao; Porsche Cup com pontos iguais). A chave passa a incluir o nome.

alter table public.synced_standings drop constraint if exists synced_standings_pkey;
alter table public.synced_standings add primary key (category_id, position, name);

alter table public.standings_detail drop constraint if exists standings_detail_pkey;
alter table public.standings_detail add primary key (category_id, grp, position, name);
