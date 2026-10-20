// Edge Function "backup": copia semanal das tabelas importantes para o bucket
// privado "backups" do Storage (um JSON compactado por tabela, por data).
// Guarda as 8 copias mais recentes. Protegida por SYNC_SECRET (x-sync-secret).
//
// Restaurar: baixar backups/<data>/<tabela>.json.gz no painel do Supabase
// (Storage), descompactar e reinserir as linhas pelo SQL Editor ou script.

import { createClient } from 'npm:@supabase/supabase-js@2';

const TABLES = [
  'synced_races', 'synced_standings', 'standings_detail', 'race_results',
  'manual_overrides', 'points_rules', 'category_config',
  'user_settings', 'push_subscriptions', 'notified_races', 'notified_race_results', 'notified_race_alerts',
];
const BUCKET = 'backups';
const KEEP = 8;
const PAGE = 1000;

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('SYNC_SECRET');
  if (!secret || req.headers.get('x-sync-secret') !== secret) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  const { data: buckets } = await db.storage.listBuckets();
  if (!buckets?.some((b) => b.name === BUCKET)) {
    const { error } = await db.storage.createBucket(BUCKET, { public: false });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  const day = new Date().toISOString().slice(0, 10);
  const summary: Record<string, number | string> = {};
  for (const table of TABLES) {
    const rows: unknown[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db.from(table).select('*').range(from, from + PAGE - 1);
      if (error) {
        summary[table] = `erro: ${error.message}`;
        break;
      }
      rows.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
    }
    if (typeof summary[table] === 'string') continue;
    const { error } = await db.storage
      .from(BUCKET)
      .upload(`${day}/${table}.json.gz`, await gzip(JSON.stringify(rows)), { contentType: 'application/gzip', upsert: true });
    summary[table] = error ? `erro: ${error.message}` : rows.length;
  }

  // Apaga copias antigas, mantendo as KEEP mais recentes.
  const { data: folders } = await db.storage.from(BUCKET).list('', { limit: 1000, sortBy: { column: 'name', order: 'desc' } });
  const old = (folders ?? []).map((f) => f.name).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse().slice(KEEP);
  for (const folder of old) {
    const { data: files } = await db.storage.from(BUCKET).list(folder);
    if (files?.length) await db.storage.from(BUCKET).remove(files.map((f) => `${folder}/${f.name}`));
  }

  const failed = Object.values(summary).some((v) => typeof v === 'string');
  return new Response(JSON.stringify({ day, summary, removedOld: old }, null, 2), {
    status: failed ? 500 : 200,
    headers: { 'content-type': 'application/json' },
  });
});
