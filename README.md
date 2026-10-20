# pitstophub-data

Mantém o Supabase do PitStopHub (site e app Android) atualizado com calendário, vencedores e classificação das
categorias, direto das fontes oficiais.

Desde out/2026 isso roda **dentro do Supabase** (Edge Functions + pg_cron), sem depender do GitHub Actions. O script
antigo (`scripts/sync-thesportsdb.mjs`) continua aqui só durante a transição: ele pula toda categoria que já estiver
ativa no motor novo.

## Como funciona

```
pg_cron (a cada 15 min) ──► função "sync" (despachante)
                               │  fim de semana de corrida → a cada 30 min (NASCAR: 15)
                               │  fora disso → 1x por dia
                               ▼
               um adaptador por categoria (supabase/functions/_shared/adapters/)
                               ▼
     travas: formato · dados coerentes · classificação calculada x oficial · nada é apagado
                               ▼
   synced_races · synced_standings · standings_detail · race_results   (o que o site/app leem)
   sync_status · sync_changes (histórico)                               (painel e alertas)
```

| Categoria | Fonte oficial |
|---|---|
| NASCAR Cup | feeds JSON do nascar.com (`cf.nascar.com/cacher`) |
| NASCAR Brasil | classificação da CBA (`cba.org.br`) |
| IndyCar | API de resultados do indycar.com |
| F1 Academy | f1academy.com (dados da página) |
| F2 / F3 | fiaformula2.com / fiaformula3.com |
| WEC / IMSA | cronometragem oficial Al Kamel |
| DTM | `api.dtm.com` |
| WRC | API de resultados do wrc.com |
| Porsche Cup Brasil | planilha oficial de pontos (link no porschecupbrasil.com) + calendário do site |

F1 vem ao vivo da Jolpica e GTWC / Endurance Brasil vêm do repositório `api-motorsports`.

### Travas contra erro

1. **Formato:** se a fonte mudar e vier algo inesperado, nada é gravado e você recebe alerta.
2. **Coerência:** calendário vazio ou "encolhido", datas fora da temporada, classificação fora de ordem ou com soma de
   pontos menor que a anterior: bloqueia e avisa.
3. **Segunda conferência:** a classificação é calculada a partir dos resultados e comparada com a oficial. Se não bater,
   mantém a anterior e avisa ("a regra de pontos mudou ou falta algum resultado?").
4. **Nada é apagado:** corridas e classificações antigas vão para `synced_races_archive` / `standings_archive`.
5. **Histórico:** toda mudança fica em `sync_changes` (dá para desfazer pelo painel).
6. **Modo teste:** cada categoria começa em `dry_run`: roda, gera o relatório do que mudaria, mas não grava.
7. **Resultado provisório:** corridas com resultado provisório ficam marcadas (`official = false`).

### Virada de temporada (2027 em diante)

Nenhum ano ou ID de temporada fica fixo no código: cada adaptador lê da fonte quais temporadas existem. O motor só
muda para a nova quando **a atual terminou** (sem corrida pendente e 3 dias depois da última) **e** a nova já tem
calendário. A temporada encerrada vai para o arquivo e você recebe um aviso. A partir de outubro o relatório de cada
categoria avisa se a fonte ainda não publicou o ano seguinte.

Se a regra de pontos mudar, o motor usa a do ano anterior, compara com a classificação oficial e avisa quando não bater.
Para cadastrar a regra nova: tabela `points_rules` (categoria, temporada, regra em JSON), sem mexer no código.

## Instalação (uma vez)

Pré-requisitos: [Supabase CLI](https://supabase.com/docs/guides/cli) logado (`npx supabase login`) e o ID do projeto.

```bash
npx supabase link --project-ref <ID-DO-PROJETO>
npx supabase db push                                   # cria as tabelas novas (não mexe nos dados atuais)
npx supabase secrets set SYNC_SECRET=<texto-longo-aleatorio> ADMIN_USER_IDS=<seu-id-de-usuario>
npx supabase secrets set TELEGRAM_BOT_TOKEN=<token> TELEGRAM_CHAT_ID=<id>   # alertas (ou ALERT_WEBHOOK_URL)
npx supabase functions deploy sync
npx supabase functions deploy admin
```

Depois rode `supabase/setup_cron.sql` no SQL Editor (troque os dois valores no topo).

`ADMIN_USER_IDS` = o ID da sua conta no site (Supabase → Authentication → Users → sua linha → "User UID").
Só essa conta abre o painel; para mais de uma pessoa, separe os IDs por vírgula. Fica como segredo da função,
fora deste repositório público.

### Alertas no Telegram

1. No Telegram, fale com **@BotFather** → `/newbot` → copie o token.
2. Mande qualquer mensagem para o seu bot e abra `https://api.telegram.org/bot<TOKEN>/getUpdates`: o `chat.id` é o
   `TELEGRAM_CHAT_ID`.
3. Discord: crie um webhook no canal e use `ALERT_WEBHOOK_URL`.

## Migração gradual

1. Tudo começa em **modo teste**. Abra o painel (`/admin` no site) e veja, por categoria, o que o motor gravaria.
2. Quando o relatório de uma categoria estiver certo, mude para **Ativa** no painel. A partir daí o script antigo pula
   essa categoria e o motor novo assume (as linhas antigas dela vão para o arquivo).
3. Com todas ativas e uma semana sem problema, desative o workflow antigo:
   `gh workflow disable sync-categories.yml --repo ailtoncja/pitstophub-data`.

## Painel (`/admin` no site)

Abre só para a sua conta (login normal do site + ID em `ADMIN_USER_IDS`, conferidos no servidor). Por categoria: estado, último sucesso, até qual etapa vai, problemas e avisos, o que mudaria
(em modo teste), botão "Rodar agora", modo (desligada / teste / ativa), **corrigir vencedor** e **desfazer** mudanças.

Uma correção vale até a fonte oficial trazer o mesmo valor; aí ela se resolve sozinha.

## O que fazer quando chegar um alerta

| Alerta | Significa | O que fazer |
|---|---|---|
| ⏱️ corrida sem resultado depois de X h | a fonte ainda não publicou | normalmente nada; se demorar, corrija o vencedor no painel |
| ⚠️ nada foi publicado nesta parte | uma trava barrou dados suspeitos | leia o motivo no painel; se a fonte estiver certa, corrija a regra ou rode de novo |
| ⚠️ classificação calculada não bate com a oficial | regra de pontos mudou ou falta resultado | confira o regulamento; atualize `points_rules` |
| ❌ a fonte falhou N vezes seguidas | site fora do ar ou mudou de formato | se passar de 1 dia, o adaptador daquela categoria precisa de ajuste; as outras seguem normais |
| 🏁 virou para a temporada X | virada automática de ano | nada; confira o calendário novo no site |

Para desligar uma categoria problemática sem afetar as outras: painel → **Desligada**.

## Desenvolvimento

```bash
cd supabase/functions
deno task test                 # testes com respostas reais gravadas (tests/fixtures)
deno task probe nascar         # roda um adaptador contra a fonte real, sem banco
```

Para adicionar uma categoria: criar `_shared/adapters/<id>.ts` (implementa `Adapter` de `_shared/types.ts`),
registrar em `_shared/registry.ts`, testar com `deno task probe <id>` e inserir em `category_config` (modo `dry_run`).

## Banco

`supabase/migrations/` cria tudo num projeto novo. Os scripts antigos em `supabase/*.sql` ficam como referência.
