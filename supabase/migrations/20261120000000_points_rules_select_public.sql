-- Permite leitura publica de points_rules (regras de pontos e secoes "Como funciona" por temporada)
-- para que a api-motorsports e o site possam adaptar a pagina de regras automaticamente.
-- Escrita continua restrita ao service_role / painel admin.

drop policy if exists "points_rules_select_public" on public.points_rules;
create policy "points_rules_select_public" on public.points_rules for select using (true);
grant select on public.points_rules to anon, authenticated;
