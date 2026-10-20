// Edge Function "admin": API do painel de correcao (a tela fica no site, em /admin).
// So o dono do site entra: a requisicao precisa vir com a sessao de login do site
// (Authorization: Bearer <access token>) de um usuario listado em ADMIN_USER_IDS
// (IDs do Supabase Auth, separados por virgula; segredo da funcao, fora do
// repositorio publico). Nunca expoe a chave service_role.
//
// CORS: so a origem em ADMIN_ALLOWED_ORIGIN (ex.: https://pitstophub.vercel.app).
// Sem ela configurada, nenhum navegador consegue chamar (falha fechada).
// ADMIN_REQUIRE_MFA=true exige login com segundo fator (claim aal = aal2).
//
// GET  /admin/status                      estado de todas as categorias
// GET  /admin/races?category=x            calendario atual da categoria
// GET  /admin/changes?category=x          ultimas mudancas gravadas
// GET  /admin/overrides?category=x        correcoes ativas
// POST /admin/mode      {category, mode}  off | dry_run | live
// POST /admin/run       {category, dry}   roda agora e devolve o relatorio
// POST /admin/override  {category, season, race_id?, kind, value, note?}
// POST /admin/override/disable {id}
// POST /admin/revert    {changeId}        desfaz uma mudanca de corrida

import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { tokenAal, validateOverride } from '../_shared/admin-validate.ts';
import { runCategory } from '../_shared/engine.ts';
import { liveHttp } from '../_shared/http.ts';
import { CATEGORY_IDS, loadAdapter } from '../_shared/registry.ts';
import { SupabaseStore } from '../_shared/store.ts';

const ALLOWED_ORIGIN = Deno.env.get('ADMIN_ALLOWED_ORIGIN')?.trim();
const CORS: Record<string, string> = {
  ...(ALLOWED_ORIGIN ? { 'access-control-allow-origin': ALLOWED_ORIGIN } : {}),
  'access-control-allow-headers': 'content-type, authorization, apikey, x-client-info',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });
}

const MODES = new Set(['off', 'dry_run', 'live']);
const RACE_COLUMNS: Record<string, string> = {
  round: 'round', name: 'name', date: 'date', startsAt: 'starts_at', status: 'status',
  winner: 'winner', circuit: 'circuit', location: 'location', official: 'official',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  const admins = (Deno.env.get('ADMIN_USER_IDS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (admins.length === 0) return json({ error: 'ADMIN_USER_IDS nao configurado' }, 500);
  const accessToken = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!accessToken) return json({ error: 'entre na sua conta' }, 401);
  // getUser valida o token no servidor de Auth (assinatura, expiracao, sessao revogada).
  const { data: auth, error: authError } = await db.auth.getUser(accessToken);
  if (authError || !auth.user) return json({ error: 'sessao invalida, entre de novo' }, 401);
  if (!admins.includes(auth.user.id)) return json({ error: 'acesso restrito ao dono do site' }, 403);
  // O token ja foi validado por getUser acima; aqui so le o claim aal.
  if (Deno.env.get('ADMIN_REQUIRE_MFA') === 'true' && tokenAal(accessToken) !== 'aal2') {
    return json({ error: 'verificacao em duas etapas necessaria', code: 'mfa_required' }, 403);
  }
  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/admin/, '') || '/';
  const category = url.searchParams.get('category') ?? '';
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  // Detalhe do erro so no log; o navegador recebe mensagem generica.
  const fail = (e: { message: string } | null, message = 'erro interno, veja o log da funcao') => {
    if (!e) return null;
    console.error(`admin ${req.method} ${route}:`, e);
    return json({ error: message }, 500);
  };

  try {
    if (req.method === 'GET' && route === '/status') {
      const [{ data: configs, error: e1 }, { data: statuses, error: e2 }] = await Promise.all([
        db.from('category_config').select('*').order('category_id'),
        db.from('sync_status').select('*'),
      ]);
      if (e1 || e2) return fail(e1 ?? e2)!;
      const byId = new Map((statuses ?? []).map((s) => [s.category_id, s]));
      return json(
        (configs ?? []).map((c) => {
          const s = byId.get(c.category_id) ?? {};
          return {
            category: c.category_id,
            mode: c.mode,
            seasonOverride: c.season_override,
            season: s.season ?? null,
            source: s.source ?? null,
            lastRunAt: s.last_run_at ?? null,
            lastSuccessAt: s.last_success_at ?? null,
            lastChangeAt: s.last_change_at ?? null,
            asOfRound: s.as_of_round ?? null,
            failures: s.consecutive_failures ?? 0,
            lastError: s.last_error ?? null,
            problems: s.problems ?? [],
            warnings: s.warnings ?? [],
            changes: s.last_report?.changes ?? [],
          };
        }),
      );
    }

    if (req.method === 'GET' && route === '/races') {
      const { data, error } = await db.from('synced_races').select('*').eq('category_id', category).order('round');
      return fail(error) ?? json(data);
    }

    if (req.method === 'GET' && route === '/changes') {
      const { data, error } = await db
        .from('sync_changes')
        .select('*')
        .eq('category_id', category)
        .order('created_at', { ascending: false })
        .limit(100);
      return fail(error) ?? json(data);
    }

    if (req.method === 'GET' && route === '/overrides') {
      const { data, error } = await db
        .from('manual_overrides')
        .select('*')
        .eq('category_id', category)
        .order('created_at', { ascending: false })
        .limit(100);
      return fail(error) ?? json(data);
    }

    if (req.method === 'POST' && route === '/mode') {
      if (!CATEGORY_IDS.includes(body.category) || !MODES.has(body.mode)) return json({ error: 'categoria ou modo invalido' }, 400);
      const { error } = await db
        .from('category_config')
        .update({ mode: body.mode, updated_at: new Date().toISOString() })
        .eq('category_id', body.category);
      return fail(error) ?? json({ ok: true });
    }

    if (req.method === 'POST' && route === '/run') {
      const adapter = await loadAdapter(body.category);
      if (!adapter) return json({ error: 'categoria desconhecida' }, 400);
      const report = await runCategory(adapter, SupabaseStore.fromEnv(), { http: liveHttp, forceDryRun: Boolean(body.dry) });
      return json(report);
    }

    if (req.method === 'POST' && route === '/override') {
      const checked = validateOverride(body, CATEGORY_IDS);
      if (!checked.ok) return json({ error: checked.error }, 400);
      const { category: cat, season, race_id, kind, value, note } = checked.value;
      if (race_id) {
        const { data: race, error: e1 } = await db
          .from('synced_races')
          .select('race_id')
          .eq('category_id', cat)
          .eq('race_id', race_id)
          .maybeSingle();
        if (e1) return fail(e1)!;
        if (!race) return json({ error: 'corrida nao encontrada nesta categoria' }, 400);
      }
      const { data, error } = await db
        .from('manual_overrides')
        .insert({ category_id: cat, season, race_id, kind, value, note })
        .select()
        .single();
      if (error) return fail(error)!;
      // Aplica ja no que o site le, sem esperar a proxima execucao.
      if (race_id && kind !== 'standing_points') {
        const patch = kind === 'winner'
          ? { winner: String(value), status: 'completed' }
          : kind === 'race_status' ? { status: String(value) } : { date: String(value) };
        const { error: e2 } = await db
          .from('synced_races')
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq('category_id', cat)
          .eq('race_id', race_id);
        if (e2) return fail(e2, 'correcao gravada, mas nao foi aplicada no site agora; sera aplicada na proxima execucao')!;
      }
      return json(data);
    }

    if (req.method === 'POST' && route === '/override/disable') {
      const { error } = await db.from('manual_overrides').update({ active: false }).eq('id', body.id);
      return fail(error) ?? json({ ok: true });
    }

    if (req.method === 'POST' && route === '/revert') {
      const { data: change, error } = await db.from('sync_changes').select('*').eq('id', body.changeId).single();
      if (error) return fail(error)!;
      if (change.entity !== 'race' || change.reverted) return json({ error: 'so mudancas de corrida ainda nao desfeitas' }, 400);
      if (change.before == null) {
        return json({ error: 'corrida nova: para remover, marque como cancelada com uma correcao' }, 400);
      }
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      for (const [field, value] of Object.entries(change.before as Record<string, unknown>)) {
        if (RACE_COLUMNS[field]) patch[RACE_COLUMNS[field]] = value;
      }
      const { error: e2 } = await db
        .from('synced_races')
        .update(patch)
        .eq('category_id', change.category_id)
        .eq('race_id', change.entity_key);
      if (e2) return fail(e2)!;
      await db.from('sync_changes').update({ reverted: true }).eq('id', change.id);
      return json({
        ok: true,
        note: 'Desfeito no site. Se a fonte continuar mandando o valor novo, ele volta na proxima execucao: ' +
          'para fixar o valor antigo, crie uma correcao.',
      });
    }

    return json({ error: 'rota desconhecida' }, 404);
  } catch (error) {
    console.error(`admin ${req.method} ${route}:`, error);
    return json({ error: 'erro interno, veja o log da funcao' }, 500);
  }
});
