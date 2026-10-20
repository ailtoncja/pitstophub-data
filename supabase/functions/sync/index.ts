// Edge Function "sync".
//
// Sem parametro: e o despachante chamado pelo pg_cron a cada 15 min. Decide
// quais categorias estao "na hora" (fim de semana de corrida = a cada 30 min;
// fora disso = 1x por dia) e dispara uma execucao separada para cada uma, para
// nenhuma estourar o limite de tempo de outra.
//
// Com ?category=<id>: roda so aquela categoria. ?dry=1 forca modo teste.
//
// Protegida por SYNC_SECRET (header x-sync-secret).

import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { runCategory } from '../_shared/engine.ts';
import { liveHttp } from '../_shared/http.ts';
import { CATEGORY_IDS, intervalFor, loadAdapter } from '../_shared/registry.ts';
import { secretEquals } from '../_shared/secret.ts';
import { SupabaseStore } from '../_shared/store.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json' } });
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('SYNC_SECRET');
  if (!secret || !(await secretEquals(req.headers.get('x-sync-secret'), secret))) return json({ error: 'unauthorized' }, 401);

  const url = new URL(req.url);
  const category = url.searchParams.get('category');
  const store = SupabaseStore.fromEnv();

  if (category) {
    const adapter = await loadAdapter(category);
    if (!adapter) return json({ error: `categoria desconhecida: ${category}` }, 404);
    const report = await runCategory(adapter, store, { http: liveHttp, forceDryRun: url.searchParams.get('dry') === '1' });
    return json(report, report.ok ? 200 : 207);
  }

  // Despachante.
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  const now = new Date();
  const [{ data: configs }, { data: statuses }, { data: nearRaces }] = await Promise.all([
    db.from('category_config').select('category_id, mode').neq('mode', 'off'),
    db.from('sync_status').select('category_id, last_run_at'),
    db
      .from('synced_races')
      .select('category_id')
      .gte('date', new Date(now.getTime() - 2 * 86400_000).toISOString().slice(0, 10))
      .lte('date', new Date(now.getTime() + 1 * 86400_000).toISOString().slice(0, 10)),
  ]);
  const lastRun = new Map((statuses ?? []).map((s) => [s.category_id, s.last_run_at as string | null]));
  const weekend = new Set((nearRaces ?? []).map((r) => r.category_id));

  const due: string[] = [];
  for (const { category_id } of configs ?? []) {
    if (!CATEGORY_IDS.includes(category_id)) continue;
    const last = lastRun.get(category_id);
    const minutes = intervalFor(category_id, weekend.has(category_id));
    // 2 min de folga para o cron de 15 min nao "pular" uma janela.
    if (!last || now.getTime() - new Date(last).getTime() >= (minutes - 2) * 60_000) due.push(category_id);
  }

  const self = `${Deno.env.get('SUPABASE_URL')}/functions/v1/sync`;
  const calls = due.map((id) =>
    fetch(`${self}?category=${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: {
        'x-sync-secret': secret,
        authorization: `Bearer ${Deno.env.get('SUPABASE_ANON_KEY') ?? ''}`,
      },
    })
      .then((r) => r.body?.cancel())
      .catch((e) => console.error(`Falha ao disparar ${id}:`, e)),
  );
  const all = Promise.allSettled(calls);
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(all);
  else await all;

  return json({ dispatched: due, raceWeekend: [...weekend] });
});
