# pitstophub-data

Mantém o Supabase do PitStopHub (site e app Android) atualizado com calendário, vencedores e classificação das
categorias, direto das fontes oficiais.

Desde out/2026 isso roda **dentro do Supabase** (Edge Functions + pg_cron). O GitHub Actions e o script antigo
(TheSportsDB) não são mais usados e foram removidos do repositório.

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
npx supabase secrets set ADMIN_ALLOWED_ORIGIN=https://pitstophub.vercel.app   # origem do site que abre o painel
npx supabase secrets set TELEGRAM_BOT_TOKEN=<token> TELEGRAM_CHAT_ID=<id>   # alertas (ou ALERT_WEBHOOK_URL)
npx supabase functions deploy sync
npx supabase functions deploy admin
npx supabase functions deploy backup
```

Depois rode `supabase/setup_cron.sql` no SQL Editor (troque os dois valores no topo).

`ADMIN_ALLOWED_ORIGIN` é obrigatório para o painel: sem ele a função `admin` não manda cabeçalho CORS e nenhum
navegador consegue chamá-la. Opcional: `ADMIN_REQUIRE_MFA=true` exige login com verificação em duas etapas (o painel
recebe `403 mfa_required` quando a sessão não passou pelo segundo fator).

`ADMIN_USER_IDS` = o ID da sua conta no site (Supabase → Authentication → Users → sua linha → "User UID").
Só essa conta abre o painel; para mais de uma pessoa, separe os IDs por vírgula. Fica como segredo da função,
fora deste repositório público.

### Alertas no Telegram

1. No Telegram, fale com **@BotFather** → `/newbot` → copie o token.
2. Mande qualquer mensagem para o seu bot e abra `https://api.telegram.org/bot<TOKEN>/getUpdates`: o `chat.id` é o
   `TELEGRAM_CHAT_ID`.
3. Discord: crie um webhook no canal e use `ALERT_WEBHOOK_URL`.

## Modos de cada categoria

Categoria nova começa em **modo teste**: no painel (`/admin` no site) dá para ver o que o motor gravaria. Quando o
relatório estiver certo, mude para **Ativa**; as linhas antigas dela vão para o arquivo.

## Painel (`/admin` no site)

Abre só para a sua conta (login normal do site + ID em `ADMIN_USER_IDS`, conferidos no servidor; com
`ADMIN_REQUIRE_MFA=true`, também o segundo fator). Por categoria: estado, último sucesso, até qual etapa vai, problemas e avisos, o que mudaria
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

Permissões: visitantes (`anon`) e usuários logados (`authenticated`) só **leem** `synced_races`, `synced_standings`,
`standings_detail`, `race_results` e a view `sync_freshness`. Usuário logado grava apenas as próprias linhas de
`user_settings` e `push_subscriptions` (RLS). Todo o resto é só das Edge Functions (`service_role`).
