# pitstophub-data

Rotina diária que mantém o Supabase do app PitStopHub atualizado. Um GitHub Action (`sync-categories`) roda todo dia
às 06:17 UTC e executa `scripts/sync-thesportsdb.mjs`, que busca na TheSportsDB o calendário, os vencedores e (quando
existe) a classificação das categorias sem API própria e grava em `synced_races` e `synced_standings`. O app Android lê
essas tabelas (F2, F3, F1 Academy, WEC, IMSA, DTM, IndyCar, NASCAR e WRC).

Este repositório nasceu da extração da rotina de dados do antigo PWA do PitStopHub.

## Segredos necessários (Settings > Secrets and variables > Actions)

| Segredo | O que é |
| --- | --- |
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | chave `service_role` (secreta; Project Settings > API) |
| `THESPORTSDB_API_KEY` | chave da TheSportsDB (plano Premium traz a temporada inteira; a gratuita limita a 15 eventos) |

```bash
gh secret set SUPABASE_URL --repo ailtoncja/pitstophub-data
gh secret set SUPABASE_SERVICE_ROLE_KEY --repo ailtoncja/pitstophub-data
gh secret set THESPORTSDB_API_KEY --repo ailtoncja/pitstophub-data
```

Para rodar na hora: `gh workflow run sync-categories.yml --repo ailtoncja/pitstophub-data`.

## Banco

`supabase/*.sql` recria as tabelas (`user_settings`, `synced_races`, `synced_standings`...) caso o projeto Supabase
precise ser refeito. Execute no SQL Editor.

## Limitação conhecida

A TheSportsDB não monta a tabela de classificação de WEC, IMSA, IndyCar, NASCAR e F1 Academy; só calendário e
vencedores. O app mostra a pontuação dessas categorias a partir do catálogo estático dele, que pode estar desatualizado.
