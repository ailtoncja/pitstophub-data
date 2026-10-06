-- Execute este script no SQL Editor do Supabase (mesmo projeto do schema.sql).
-- Adiciona a tela de favoritos com prioridade: um flag de onboarding (se a
-- pessoa ja passou pela tela de escolher favoritos, ou pulou) e a ordem de
-- prioridade entre os times/pilotos seguidos.

alter table public.user_settings
  add column if not exists favorites_onboarded boolean not null default false;

alter table public.user_settings
  add column if not exists priority_follow_ids text[] not null default '{}';
