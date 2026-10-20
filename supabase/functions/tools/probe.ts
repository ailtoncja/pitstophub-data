// Testa um adaptador contra a fonte real, sem banco:
//   deno task probe <categoria> [temporada]
// Mostra temporadas publicadas, calendario, vencedores, classificacao oficial
// e a calculada, e se as duas batem.

import { pickDefaultRules } from '../_shared/engine.ts';
import { liveHttp } from '../_shared/http.ts';
import { compareStandings, computeStandings } from '../_shared/points.ts';
import { CATEGORY_IDS, loadAdapter } from '../_shared/registry.ts';
import { validateRaces } from '../_shared/validate.ts';

const [id, seasonArg] = Deno.args;
const adapter = id ? await loadAdapter(id) : null;
if (!adapter) {
  console.error(`Uso: deno task probe <categoria>. Disponiveis: ${CATEGORY_IDS.join(', ')}`);
  Deno.exit(1);
}

const ctx = { http: liveHttp, now: new Date(), params: {} as Record<string, unknown> };
const t0 = Date.now();
const seasons = await adapter.listSeasons(ctx);
console.log(`Temporadas publicadas: ${seasons.join(', ')}`);
const season = seasonArg ? Number(seasonArg) : Math.max(...seasons.filter((s) => s <= ctx.now.getUTCFullYear()));
const snap = await adapter.fetchSnapshot(ctx, season);
console.log(`\n${id} ${season}: ${snap.races.length} corridas, ${snap.results.length} resultados, ${Date.now() - t0} ms`);
for (const r of snap.races) {
  console.log(`  R${String(r.round).padStart(2)} ${r.date} ${r.status.padEnd(9)} ${r.name} | ${r.enName ?? ''} | ${r.winner ?? '-'}${r.official === false ? ' (provisorio)' : ''}`);
}
if (snap.notes?.length) console.log(`\nNotas: ${snap.notes.join(' | ')}`);

const check = validateRaces(snap, { races: [], standings: [] });
console.log(`\nValidacao: ${check.problems.length} problema(s), ${check.warnings.length} aviso(s)`);
[...check.problems, ...check.warnings].forEach((m) => console.log(`  - ${m}`));

for (const set of snap.officialStandings) {
  console.log(`\nOficial [${set.group}] apos rodada ${set.asOfRound ?? '?'}: ` + set.rows.slice(0, 5).map((r) => `${r.position}. ${r.name} ${r.points}`).join(' | '));
}
const { rules, assumed } = pickDefaultRules(adapter!, season);
if (rules && snap.results.length) {
  const computed = computeStandings(rules, snap.races, snap.results);
  for (const set of computed) {
    console.log(`Calculada [${set.group}]${assumed ? ' (regra assumida)' : ''}: ` + set.rows.slice(0, 5).map((r) => `${r.position}. ${r.name} ${r.points}`).join(' | '));
    const off = snap.officialStandings.find((s) => s.group === set.group);
    if (off) {
      const cmp = compareStandings(set.rows, off.rows);
      console.log(`  Confere com a oficial: ${cmp.matches ? 'SIM' : 'NAO'}${cmp.matches ? '' : ` -> ${cmp.differences.slice(0, 5).join('; ')}`}`);
    }
  }
}
