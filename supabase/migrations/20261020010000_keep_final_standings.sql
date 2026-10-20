-- Entre uma temporada e outra o site mostra o calendario novo e a classificacao
-- FINAL da temporada que acabou. Por isso a virada so arquiva as corridas; a
-- classificacao antiga so vai para o arquivo quando a nova for gravada.

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

  return moved;
end;
$$;

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
    -- Classificacao de outra temporada (ou do sistema antigo) vai para o arquivo antes.
    insert into public.standings_archive (category_id, season, grp, rows, reason)
    select category_id, season, 'drivers', jsonb_agg(to_jsonb(s) order by position), 'substituida pela temporada ' || p_season
    from public.synced_standings s
    where category_id = p_category and season is distinct from p_season
    group by category_id, season;

    delete from public.synced_standings where category_id = p_category;
    insert into public.synced_standings (category_id, position, name, team, points, as_of_round, source, season, updated_at)
    select p_category, (r->>'position')::int, r->>'name', r->>'team', (r->>'points')::numeric,
           p_as_of_round, p_source, p_season, now()
    from jsonb_array_elements(p_rows) as r;
  else
    insert into public.standings_archive (category_id, season, grp, rows, reason)
    select category_id, season, grp, jsonb_agg(to_jsonb(d) order by position), 'substituida pela temporada ' || p_season
    from public.standings_detail d
    where category_id = p_category and grp = p_group and season <> p_season
    group by category_id, season, grp;

    delete from public.standings_detail where category_id = p_category and grp = p_group;
    insert into public.standings_detail (category_id, season, grp, position, name, team, points, as_of_round, source, updated_at)
    select p_category, p_season, p_group, (r->>'position')::int, r->>'name', r->>'team',
           (r->>'points')::numeric, p_as_of_round, p_source, now()
    from jsonb_array_elements(p_rows) as r;
  end if;
end;
$$;

revoke all on function public.sync_apply_standings(text, int, text, text, int, jsonb) from public, anon, authenticated;
revoke all on function public.sync_archive_category(text, int, text) from public, anon, authenticated;
